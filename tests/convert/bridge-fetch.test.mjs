// Unit checks for examples/convert-webapp/converted/ui/bridge-fetch.js, no VM: a fake window.vmapp.invoke plays the
// core. Run with: node tests/convert/bridge-fetch.test.mjs  (run.sh does). Prints PASS/FAIL per check.
import assert from 'node:assert/strict';
import { loadBridgeFetch } from './lib.mjs';

let failures = 0;
// bridge-fetch.js runs in a vm context, so its errors come from another realm: compare names, not classes
const isError = (name) => (e) => e && e.name === name;
// ... and objects it creates have the other realm's prototypes: compare them as JSON (undefined members vanish)
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS: bridge-fetch ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: bridge-fetch ${name}\n    ${String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join('\n    ')}`);
  }
}

// a fake core: records the invoke arguments, answers with `reply` (an object or a function of the request)
function fakeCore(reply) {
  const calls = [];
  const invoke = async (channel, ...args) => {
    calls.push({ channel, args });
    const r = typeof reply === 'function' ? reply(args[0]) : reply;
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, invoke };
}

const json = (status, obj) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) });

for (const withResponse of [true, false]) {
  const kind = withResponse ? 'native Response' : 'MiniResponse fallback';

  await check(`[${kind}] GET: status, ok, headers.get, json(), text()`, async () => {
    const core = fakeCore(json(200, [{ id: 'a' }]));
    const w = loadBridgeFetch(core.invoke, { withResponse });
    const res = await w.fetch('/api/bookmarks');
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8'); // case-insensitive
    assert.equal(res.headers.get('x-missing'), null);
    const clone = res.clone();
    same(await res.json(), [{ id: 'a' }]);
    assert.equal(await clone.text(), '[{"id":"a"}]');
    assert.deepEqual(core.calls.length, 1);
    assert.equal(core.calls[0].channel, 'http');
    same(core.calls[0].args[0], { method: 'GET', path: '/api/bookmarks', headers: {} }); // no body key
  });

  await check(`[${kind}] POST: method, lowercased headers and string body are forwarded; 201 is ok`, async () => {
    const core = fakeCore(json(201, { id: 'n' }));
    const w = loadBridgeFetch(core.invoke, { withResponse });
    const res = await w.fetch('/api/bookmarks', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', url: 'https://e.org' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.ok, true);
    same(core.calls[0].args[0], {
      method: 'POST',
      path: '/api/bookmarks',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"t","url":"https://e.org"}',
    });
  });

  await check(`[${kind}] 204 (DELETE) has an empty body and is ok`, async () => {
    const core = fakeCore({ status: 204, headers: {}, body: '' });
    const w = loadBridgeFetch(core.invoke, { withResponse });
    const res = await w.fetch('/api/bookmarks/x', { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal(res.ok, true);
    assert.equal(await res.text(), '');
    assert.equal(core.calls[0].args[0].method, 'DELETE');
  });

  await check(`[${kind}] error statuses: not ok, the JSON error body is readable`, async () => {
    const core = fakeCore(json(400, { error: 'title is required' }));
    const w = loadBridgeFetch(core.invoke, { withResponse });
    const res = await w.fetch('/api/bookmarks', { method: 'POST', body: '{}' });
    assert.equal(res.status, 400);
    assert.equal(res.ok, false);
    assert.equal((await res.json()).error, 'title is required');
  });

  await check(`[${kind}] json() on a non-JSON body rejects like fetch`, async () => {
    const core = fakeCore({ status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>Not found</h1>' });
    const w = loadBridgeFetch(core.invoke, { withResponse });
    const res = await w.fetch('/nope');
    assert.equal(res.ok, false);
    await assert.rejects(res.json(), isError('SyntaxError'));
  });
}

await check('URL forms: relative, query string, URL object, own origin, Request object', async () => {
  const core = fakeCore(json(200, []));
  const w = loadBridgeFetch(core.invoke);
  await w.fetch('api/bookmarks?x=1&y=2'); // relative to /index.html -> /api/bookmarks
  await w.fetch(new URL('/api/b?z=3#frag', 'vmapp-ui://dev.vmapp.convert.bookmarks/'));
  await w.fetch('vmapp-ui://dev.vmapp.convert.bookmarks/api/own-origin');
  await w.fetch(new Request('vmapp-ui://dev.vmapp.convert.bookmarks/api/req', { method: 'POST', body: 'hi', headers: { 'X-A': '1' } }));
  assert.deepEqual(core.calls.map((c) => c.args[0].path), ['/api/bookmarks?x=1&y=2', '/api/b?z=3', '/api/own-origin', '/api/req']);
  assert.equal(core.calls[3].args[0].method, 'POST');
  assert.equal(core.calls[3].args[0].body, 'hi');
  assert.equal(core.calls[3].args[0].headers['x-a'], '1');
  assert.equal(w.realFetchCalls.length, 0);
});

await check('Headers instance, header array and URLSearchParams body', async () => {
  const core = fakeCore(json(200, {}));
  const w = loadBridgeFetch(core.invoke);
  await w.fetch('/a', { method: 'POST', headers: new Headers({ 'X-One': '1' }), body: 'b' });
  await w.fetch('/b', { method: 'POST', headers: [['X-Two', '2']], body: 'b' });
  await w.fetch('/c', { method: 'POST', body: new URLSearchParams({ q: 'v w' }) });
  assert.equal(core.calls[0].args[0].headers['x-one'], '1');
  assert.equal(core.calls[1].args[0].headers['x-two'], '2');
  assert.equal(core.calls[2].args[0].body, 'q=v+w');
  assert.match(core.calls[2].args[0].headers['content-type'], /^application\/x-www-form-urlencoded/);
});

await check('other origins fall through to the real fetch (which the CSP blocks)', async () => {
  const core = fakeCore(json(200, {}));
  const w = loadBridgeFetch(core.invoke);
  await assert.rejects(w.fetch('https://example.com/x'), isError('TypeError'));
  await assert.rejects(w.fetch('//example.com/x'), isError('TypeError'));
  assert.equal(core.calls.length, 0, 'nothing reached the core');
  assert.deepEqual(w.realFetchCalls, ['https://example.com/x', '//example.com/x']);
});

await check('a core error becomes a TypeError (a network failure), a bad body type is a TypeError', async () => {
  const core = fakeCore(new Error('the server did not answer in time'));
  const w = loadBridgeFetch(core.invoke);
  await assert.rejects(w.fetch('/api/bookmarks'), (e) => e.name === 'TypeError' && /did not answer/.test(e.message));
  await assert.rejects(w.fetch('/x', { method: 'POST', body: new Blob(['x']) }), isError('TypeError'));
});

await check('an already aborted signal rejects with AbortError and sends nothing', async () => {
  const core = fakeCore(json(200, {}));
  const w = loadBridgeFetch(core.invoke);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(w.fetch('/api/bookmarks', { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(core.calls.length, 0);
});

await check('throws a clear error when window.vmapp.invoke is missing', async () => {
  assert.throws(() => loadBridgeFetch(undefined), /window\.vmapp is not available|invoke/);
});

console.log(failures ? `bridge-fetch: ${failures} check(s) FAILED` : 'bridge-fetch: all checks passed');
process.exit(failures ? 1 : 0);
