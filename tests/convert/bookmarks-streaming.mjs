// Bookmarks on the STREAMED bridge (examples/convert-webapp/build.sh --streaming), in a REAL VM: the same Express server, unchanged, now
// reached through sdk/node/http-bridge.js in the core and sdk/web/vmapp-fetch.js in the page. The "page" here is this script: it builds the
// very fetch the window uses (createFetch) on the fake window manager's invoke/send/emit, and calls the app's REST API the way ui/app.js
// does. The 'http' channel of the default variant is still there and still answers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFetch } = require('../../sdk/web/vmapp-fetch.js');
const ID = 'dev.vmapp.convert.bookmarks';
let n = 0;
const ok = (msg) => console.log(`  ok ${++n}: ${msg}`);

export default async function ({ wm }) {
  await wm.waitForWindows(1, 30000);
  const win = 1;
  const listeners = new Map();
  wm.events.on('emit', (w, channel, args) => {
    if (w !== win) return;
    for (const fn of listeners.get(channel) || []) fn(...args);
  });
  const vmapp = {
    invoke: (channel, ...args) => wm.invoke(win, channel, ...args),
    send: (channel, ...args) => wm.send(win, channel, ...args),
    on: (channel, fn) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
      return () => {};
    },
  };
  const page = createFetch({ vmapp, location: { href: `vmapp-ui://${ID}/index.html`, protocol: 'vmapp-ui:', host: ID }, prefixes: ['/api/'] });
  const f = page.fetch;

  let r = await f('/api/bookmarks');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await r.json(), []);
  ok('GET /api/bookmarks through vmapp-fetch.js -> 200 [] (a real Response)');

  r = await f('/api/bookmarks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ' Streamed ', url: 'https://example.com/s' }) });
  assert.equal(r.status, 201);
  const created = await r.json();
  assert.equal(created.title, 'Streamed');
  ok(`POST -> 201 ${created.id}`);

  assert.deepEqual((await (await f('/api/bookmarks')).json()).map((b) => b.id), [created.id]);
  r = await f('/api/bookmarks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '', url: 'https://x.org' }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'title is required');
  ok('GET lists it; an invalid POST -> 400 with the server\'s JSON error');

  r = await f('/api/bookmarks/' + created.id, { method: 'DELETE' });
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
  assert.deepEqual(await (await f('/api/bookmarks')).json(), []);
  ok('DELETE -> 204 with an empty body; the list is empty again');

  // a body that is not a string (URLSearchParams and a Blob) and a HEAD request cross the bridge too
  r = await f('/api/bookmarks', { method: 'POST', body: new URLSearchParams({ title: 'x', url: 'https://x.org' }) });
  assert.ok(r.status >= 400 && r.status < 500, `Express's JSON parser refuses a form body with ${r.status}`);
  assert.equal((await f('/api/bookmarks', { method: 'HEAD' })).body, null);
  ok('a URLSearchParams body and a HEAD request are carried (the server answers them as it would a browser)');

  // an aborted request is cancelled, not left hanging
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(f('/api/bookmarks', { signal: ac.signal }), (e) => e.name === 'AbortError');
  ok('an already aborted signal rejects with AbortError');

  // the request the page cannot make
  await assert.rejects(vmapp.invoke('fetch:open', { id: 'x1', method: 'GET', path: '/other' }), /path not allowed/);
  await assert.rejects(vmapp.invoke('fetch:open', { id: 'x2', method: 'TRACE', path: '/api/bookmarks' }), /method not allowed/);
  ok('the core refuses a path outside /api/ and a method outside the list');

  // the default variant's channel is untouched
  const legacy = await wm.invoke(win, 'http', { method: 'GET', path: '/api/bookmarks', headers: {} });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body, '[]');
  ok("the 'http' channel of the default variant still answers");
}
