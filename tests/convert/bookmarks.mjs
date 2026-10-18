// Bookmarks (examples/convert-webapp), run twice by run.sh in REAL VMs (PHASE=1, then PHASE=2). The Express server
// runs unchanged inside the VM; the "renderer" here is this script, calling ipcMain 'http' the way
// ui/bridge-fetch.js does, and once through the real bridge-fetch.js itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadBridgeFetch } from './lib.mjs';

const phase = process.env.PHASE || '1';
let n = 0;
const ok = (msg) => console.log(`  ok ${++n}: ${msg}`);

export default async function ({ session, wm, store }) {
  const dataFile = path.join(store.dataDir(session.appId), 'bookmarks.json');
  const http = (method, p, body, headers) =>
    wm.invoke(1, 'http', { method, path: p, headers: headers || (body === undefined ? {} : { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });

  await wm.waitForWindows(1, 30000);
  assert.equal(wm.windows.get(1).params.entry, 'index.html');
  assert.equal(wm.windows.get(1).params.title, 'Bookmarks');
  ok('window created (after the core started its server and it answered): index.html, title "Bookmarks"');

  if (phase === '1') {
    // empty list
    let r = await http('GET', '/api/bookmarks');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(Object.keys(r.headers), ['content-type']);
    assert.deepEqual(JSON.parse(r.body), []);
    ok('GET /api/bookmarks -> 200 [] (only content-type is returned as a header)');

    // create
    r = await http('POST', '/api/bookmarks', { title: ' Example ', url: 'https://example.com/a' });
    assert.equal(r.status, 201);
    const created = JSON.parse(r.body);
    assert.equal(created.title, 'Example');
    assert.equal(created.url, 'https://example.com/a');
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    ok(`POST /api/bookmarks -> 201 ${created.id}`);

    // list = 1, and the file is in the app's data folder on the HOST (server's DATA_DIR=/data)
    r = await http('GET', '/api/bookmarks');
    assert.deepEqual(JSON.parse(r.body).map((b) => b.id), [created.id]);
    ok('GET -> 1 bookmark');
    const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(onDisk.map((b) => b.id), [created.id]);
    ok(`bookmarks.json is in the app data dir on the host: ${dataFile}`);

    // validation errors come through with their status and JSON body
    r = await http('POST', '/api/bookmarks', { title: '', url: 'https://x.org' });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, 'title is required');
    r = await http('POST', '/api/bookmarks', { title: 'x', url: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
    ok('invalid POSTs -> 400 with the server\'s JSON error');

    // delete
    r = await http('DELETE', '/api/bookmarks/' + created.id);
    assert.equal(r.status, 204);
    assert.equal(r.body, '');
    r = await http('DELETE', '/api/bookmarks/' + created.id);
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse((await http('GET', '/api/bookmarks')).body), []);
    ok('DELETE -> 204, again -> 404, list is empty');

    // public/ is not part of the core: the original static route finds nothing (the UI is served by the host)
    r = await http('GET', '/');
    assert.equal(r.status, 404);
    ok('GET / on the server -> 404 (public/ is not shipped in core/; ui/ is served by the host)');

    // the bridge refuses what it should
    await assert.rejects(http('TRACE', '/api/bookmarks'), /method not allowed/);
    await assert.rejects(http('GET', '//evil.example/x'), /path must start/);
    await assert.rejects(http('GET', 'http://evil.example/'), /path must start/);
    ok("the 'http' handler rejects unknown methods and non-path targets");

    // the real ui/bridge-fetch.js on top of the real VM: app.js-style calls
    const win = loadBridgeFetch((channel, ...args) => wm.invoke(1, channel, ...args));
    let res = await win.fetch('/api/bookmarks');
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), []);
    res = await win.fetch('/api/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'via fetch', url: 'https://example.org/f' }) });
    assert.equal(res.status, 201);
    const viaFetch = await res.json();
    res = await win.fetch('/api/bookmarks/' + encodeURIComponent(viaFetch.id), { method: 'DELETE' });
    assert.equal(res.status, 204);
    res = await win.fetch('/api/bookmarks/' + viaFetch.id, { method: 'DELETE' });
    assert.equal(res.ok, false);
    assert.equal((await res.json()).error, 'not found');
    ok('ui/bridge-fetch.js against the real server: GET, POST (201), DELETE (204), repeat DELETE (404, json error)');

    // leave one bookmark behind for the second run
    r = await http('POST', '/api/bookmarks', { title: 'persist-me', url: 'https://example.com/persist' });
    assert.equal(r.status, 201);
    ok('left one bookmark ("persist-me") for run 2');
  } else {
    const r = await http('GET', '/api/bookmarks');
    const list = JSON.parse(r.body);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'persist-me');
    ok('second run (a new VM, a new server process) sees the persisted bookmark');
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8'))[0].title, 'persist-me');
    ok('and it is the same file on the host');
  }
  console.log(`BOOKMARKS-OK phase ${phase}`);
}
