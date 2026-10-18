'use strict';
// "Browse registry…": hostlib/updates.js browseRegistry (the one module with network code) and the loader's IPC around it
// (loader/src/library.js, `lib:registryBrowse`, loaded with a stand-in for `electron`). The answers come from a REAL local registry
// (registry/lib/registry.js on port 0, data under $VMAPP_WORK, started as tests/registry/helpers.js does) with real packages
// published to it, and from small stand-in servers for the things a real registry never sends: hostile text, answers that are too big
// or too slow, redirects, errors. The loader's CDP run L drives the same thing through the real UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');
const { Store } = require('../../hostlib/store');
const { Updates, UpdateError, browseParams, cleanBrowseList, BROWSE_SORTS } = require('../../hostlib/updates');
const reg = require('../registry/helpers');

// ------------------------------------------------------------------------------------------------ fixtures

const ITEM_KEYS = ['description', 'downloads', 'id', 'latestVersion', 'name', 'permissionsSummary', 'publisher', 'runtime', 'sizeBytes'];
// invisible and direction-changing characters, made from numbers so that the source shows none
const [RLO, ZWSP, LRI, BOM, NUL, BEL] = [0x202e, 0x200b, 0x2066, 0xfeff, 0x00, 0x07].map((n) => String.fromCodePoint(n)); // right-to-left override, zero-width space, left-to-right isolate, byte order mark
const HOSTILE_NAME ='<img src=x onerror=alert(1)>Evil';
const HOSTILE_DESC = '<script>alert(document.cookie)</script> "quoted" \'single\' & <b>bold</b>' + RLO + ' reversed text\nsecond line';

/** A registry with a few real apps (Notes, Hasher, Zebra Viewer, and a hostile one), published a minute apart so "new" has an order. */
async function startFixtureRegistry(t) {
  const r = await reg.startRegistry();
  t.after(async () => {
    await r.close();
    reg.rmrf(r.dir);
  });
  const work = reg.tmpdir('browse-pkgs-');
  t.after(() => reg.rmrf(work));
  const apps = [
    ['com.example.notes', { name: 'Notes', description: 'Plain notes that stay on your Mac.' }],
    ['com.example.hasher', { name: 'Hasher', description: 'Checks the SHA-256 of a file you drop on it.' }],
    ['com.example.zebra', { name: 'Zebra Viewer', description: 'Looks at striped pictures.', version: '2.1.0' }],
    ['com.example.hostile', { name: HOSTILE_NAME, description: HOSTILE_DESC }],
  ];
  for (const [id, over] of apps) {
    const p = reg.buildPackage(work, id.split('.').pop(), Object.assign({ id, version: '1.0.0' }, over));
    const res = await reg.publish(r.url, p.file);
    assert.equal(res.status, 201, res.text);
    r.clock.advance(60 * 1000);
  }
  return r;
}

/** A stand-in registry: `handler(req, res)`; records every request in `seen` ({url, headers}). */
async function standIn(t, handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    handler(req, res, seen);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** An address on this computer where nothing listens (a port that was just free). */
async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

function newUpdates(t, over = {}) {
  const d = reg.tmpdir('browse-home-');
  t.after(() => reg.rmrf(d));
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  return { store, updates: new Updates(store, over), dir: d };
}

const item = (over = {}) => Object.assign({ id: 'com.example.ok', name: 'Ok', publisher: { level: 'unverified', label: 'Unverified publisher' }, description: 'd', latestVersion: '1.0.0', runtime: 'node22', downloads: 3, sizeBytes: 100, permissionsSummary: 'none' }, over);

// ------------------------------------------------------------------------------------------------ what a request asks for

test('browseParams: defaults, clamps, a cleaned search text; a text or sort the registry would refuse is refused here', () => {
  assert.deepEqual(browseParams({}), { q: '', sort: 'new', offset: 0, limit: 20 }, 'the default is the newest apps first');
  assert.deepEqual(browseParams(), { q: '', sort: 'new', offset: 0, limit: 20 });
  assert.deepEqual(browseParams({ q: `  hello \t\n world${NUL}${RLO} `, sort: 'popular', offset: 40, limit: 999 }),{ q: 'hello world', sort: 'popular', offset: 40, limit: 50 });
  assert.deepEqual(BROWSE_SORTS, ['new', 'popular', 'updated', 'name']);
  for (const s of BROWSE_SORTS) assert.equal(browseParams({ sort: s }).sort, s);
  for (const bad of [-1, 1.5, NaN, '5', null, Infinity, 1e300]) assert.equal(browseParams({ offset: bad }).offset, 0, `offset ${bad}`);
  assert.equal(browseParams({ offset: 5e9 }).offset, 1000000, 'an offset is capped');
  assert.equal(browseParams({ limit: 0 }).limit, 20);
  assert.equal(browseParams({ limit: 3 }).limit, 3);
  assert.equal(browseParams({ q: 'x'.repeat(100) }).q.length, 100);
  assert.throws(() => browseParams({ q: 'x'.repeat(101) }), (e) => e instanceof UpdateError && /at most 100 characters/.test(e.message));
  assert.equal(browseParams({ sort: '' }).sort, 'new', 'an empty sort means the default');
  for (const bad of ['popularity', 'POPULAR', '../x', 7, {}, []]) {
    assert.throws(() => browseParams({ sort: bad }), (e) => e instanceof UpdateError && /sort order/.test(e.message), `sort ${JSON.stringify(bad)}`);
  }
});

test('the request carries the search text, the sort and the page: nothing else (no app id, no cookie, no identifier)', async (t) => {
  const s = await standIn(t, (req, res) => json(res, { total: 0, items: [] }));
  const { updates } = newUpdates(t);
  await updates.browseRegistry(s.url, { q: 'my notes & more', sort: 'updated', offset: 40, limit: 10 });
  await updates.browseRegistry(`${s.url}/`, {});
  assert.equal(s.seen.length, 2);
  const u = new URL(s.seen[0].url, s.url);
  assert.equal(u.pathname, '/api/apps');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['limit', 'offset', 'q', 'sort']);
  assert.equal(u.searchParams.get('q'), 'my notes & more');
  assert.equal(u.searchParams.get('sort'), 'updated');
  assert.equal(u.searchParams.get('offset'), '40');
  assert.equal(u.searchParams.get('limit'), '10');
  const u2 = new URL(s.seen[1].url, s.url);
  assert.deepEqual([...u2.searchParams.keys()].sort(), ['limit', 'offset', 'sort'], 'no q when nothing was typed');
  for (const r of s.seen) {
    assert.equal(r.method, 'GET');
    assert.deepEqual(Object.keys(r.headers).sort(), ['accept', 'connection', 'host'], 'no cookie, no authorization, no user agent, no custom header');
  }
});

// ------------------------------------------------------------------------------------------------ a real registry

test('a real registry: results come back as plain, cut-down data with the publisher label as the registry presents it', async (t) => {
  const r = await startFixtureRegistry(t);
  const { updates } = newUpdates(t);
  const res = await updates.browseRegistry(r.url, {});
  assert.equal(res.registry, r.url);
  assert.equal(res.total, 4);
  assert.equal(res.next, null);
  assert.equal(res.sort, 'new');
  assert.equal(res.items.length, 4);
  for (const it of res.items) {
    assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS, 'only the fixed fields survive');
    assert.deepEqual(it.publisher, { level: 'unverified', label: 'Unverified publisher' }, 'the registry shows an unverified publisher as that, and the claimed name never appears');
    assert.equal(it.runtime, 'node22');
    assert.equal(it.downloads, 0);
    assert.ok(Number.isSafeInteger(it.sizeBytes) && it.sizeBytes > 1000);
    assert.match(it.permissionsSummary, /folder "docs"/, 'the registry words it');
  }
  const zebra = res.items.find((x) => x.id === 'com.example.zebra');
  assert.equal(zebra.name, 'Zebra Viewer');
  assert.equal(zebra.latestVersion, '2.1.0');
  assert.equal(zebra.description, 'Looks at striped pictures.');
  // the same list straight from the registry has more in it than the loader keeps
  const direct = await reg.call(r.url, '/api/apps');
  assert.ok(Object.keys(direct.json.items[0]).includes('createdAt') && Object.keys(direct.json.items[0]).includes('downloads30d'));
});

test('a real registry: the search text filters (name, description, id; every word must match; case does not matter)', async (t) => {
  const r = await startFixtureRegistry(t);
  const { updates } = newUpdates(t);
  const ids = async (q) => (await updates.browseRegistry(r.url, { q })).items.map((x) => x.id).sort();
  assert.deepEqual(await ids('notes'), ['com.example.notes']);
  assert.deepEqual(await ids('NOTES'), ['com.example.notes']);
  assert.deepEqual(await ids('sha-256'), ['com.example.hasher'], 'the description is searched');
  assert.deepEqual(await ids('zebra viewer'), ['com.example.zebra']);
  assert.deepEqual(await ids('zebra notes'), [], 'every word must match');
  assert.deepEqual(await ids('example.hasher'), ['com.example.hasher'], 'the id is searched');
  assert.deepEqual(await ids('no such app anywhere'), []);
  const none = await updates.browseRegistry(r.url, { q: 'no such app anywhere' });
  assert.deepEqual([none.total, none.next, none.items.length, none.q], [0, null, 0, 'no such app anywhere']);
  assert.equal((await updates.browseRegistry(r.url, { q: '' })).total, 4);
  assert.equal((await updates.browseRegistry(r.url, { q: '   ' })).total, 4, 'blank is no search');
});

test('a real registry: sort orders and paging (next is the offset to continue from)', async (t) => {
  const r = await startFixtureRegistry(t);
  const { updates } = newUpdates(t);
  const names = async (o) => (await updates.browseRegistry(r.url, o)).items.map((x) => x.id.split('.').pop());
  const byName = (await updates.browseRegistry(r.url, { sort: 'name' })).items.map((x) => x.name.toLowerCase());
  assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b)), 'A to Z');
  assert.deepEqual(await names({ sort: 'new' }), ['hostile', 'zebra', 'hasher', 'notes'], 'newest first');
  assert.deepEqual(await names({ sort: 'updated' }), ['hostile', 'zebra', 'hasher', 'notes']);
  // paging by two
  const p1 = await updates.browseRegistry(r.url, { sort: 'new', limit: 2 });
  assert.deepEqual([p1.items.length, p1.total, p1.next, p1.offset, p1.limit], [2, 4, 2, 0, 2]);
  const p2 = await updates.browseRegistry(r.url, { sort: 'new', limit: 2, offset: p1.next });
  assert.deepEqual([p2.items.length, p2.total, p2.next, p2.offset], [2, 4, null, 2]);
  assert.deepEqual([...p1.items, ...p2.items].map((x) => x.id.split('.').pop()), ['hostile', 'zebra', 'hasher', 'notes'], 'the pages join up with no repeat and no gap');
  const past = await updates.browseRegistry(r.url, { limit: 2, offset: 10 });
  assert.deepEqual([past.items.length, past.next, past.total], [0, null, 4], 'past the end is an empty page, not an error');
});

test('a real registry: hostile names and descriptions stay text (markup characters kept, direction overrides and control characters removed)', async (t) => {
  const r = await startFixtureRegistry(t);
  const { updates } = newUpdates(t);
  const res = await updates.browseRegistry(r.url, { q: 'evil' });
  assert.equal(res.items.length, 1);
  const h = res.items[0];
  assert.equal(h.name, HOSTILE_NAME, 'the name is returned as the text it is');
  assert.equal(h.description, '<script>alert(document.cookie)</script> "quoted" \'single\' & <b>bold</b> reversed text second line');
  assert.ok(!h.description.includes(RLO) && !/[\u0000-\u001f]/.test(h.description));
});

// ------------------------------------------------------------------------------------------------ answers a real registry would never send

test('hostile and broken answers: only the fixed fields survive, text is capped and cleaned, numbers are whole, bad items are dropped', async (t) => {
  const evil = [
    item({ id: 'com.example.long', name: 'N'.repeat(100000), description: 'D'.repeat(1000000), permissionsSummary: 'P'.repeat(50000), publisher: { level: 'domain', label: 'L'.repeat(9000) } }),
    item({ id: 'com.example.types', name: { toString: 'x' }, description: ['a'], latestVersion: '2.0.0', downloads: -1, sizeBytes: 1.5, runtime: 'perl', publisher: { level: 'admin', label: 'Verified: apple.com' } }),
    item({ id: 'com.example.strings', downloads: '5', sizeBytes: '10', publisher: 'Verified', name: `a${NUL}b${BEL}c${RLO}d${ZWSP}e${LRI}f${BOM}g`, description: '  many   spaces\t\tand\r\nlines  ' }),
    item({ id: '../../etc/passwd' }),
    item({ id: 'UPPER.case' }),
    item({ id: 'x' }),
    item({ id: 'com.example.noversion', latestVersion: '' }),
    item({ id: 'com.example.badversion', latestVersion: '1.0' }),
    item({ id: 'com.example.hugeversion', latestVersion: `1.0.0-${'a'.repeat(100)}` }),
    item({ id: 'com.example.extra', icon: 'data:image/png;base64,AAAA', url: 'javascript:alert(1)', onclick: 'x', claimedPublisher: 'Apple Inc.', manifest: { a: 1 }, download: 'http://evil.example/x' }),
    item({ id: 'com.example.dup' }),
    item({ id: 'com.example.dup', name: 'second copy' }),
    null,
    'a string',
    7,
    [1, 2],
  ];
  const s = await standIn(t, (req, res) => json(res, `{"total":"many","items":${JSON.stringify(evil)},"__proto__":{"polluted":true}}`));
  const { updates } = newUpdates(t);
  const r = await updates.browseRegistry(s.url, { limit: 50 });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(r.items.map((x) => x.id), ['com.example.long', 'com.example.types', 'com.example.strings', 'com.example.extra', 'com.example.dup']);
  for (const it of r.items) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS);
  const [long, types, strings, extra, dup] = r.items;
  assert.equal(long.name.length, 100);
  assert.ok(long.name.endsWith('…'));
  assert.equal(long.description.length, 600);
  assert.equal(long.permissionsSummary.length, 1000);
  assert.deepEqual(long.publisher, { level: 'domain', label: `${'L'.repeat(199)}…` }, 'the level is kept; the label is capped');
  assert.equal(types.name, 'com.example.types', 'a name that is not text falls back to the id');
  assert.equal(types.description, '');
  assert.deepEqual([types.downloads, types.sizeBytes, types.runtime], [null, null, ''], 'negative, fractional and unknown values are dropped');
  assert.deepEqual(types.publisher, { level: 'unknown', label: 'Verified: apple.com' }, 'an unknown level is not one of the registry’s: shown as given, styled as nothing');
  assert.deepEqual([strings.downloads, strings.sizeBytes], [null, null], 'numbers must be numbers');
  assert.deepEqual(strings.publisher, { level: 'unknown', label: '' });
  assert.equal(strings.name, 'a b c d e f g');
  assert.equal(strings.description, 'many spaces and lines');
  assert.deepEqual(extra, item({ id: 'com.example.extra' }), 'icons, links, handlers and claims the registry added are gone');
  assert.equal(dup.name, 'Ok', 'the first of two items with one id wins');
  assert.equal(r.total, evil.length, 'a total that is not a number falls back to what was received');
  assert.equal(r.next, null);
});

test('cleanBrowseList: a registry cannot make the page longer than asked, and "next" counts what was received, not what was kept', () => {
  const ask = browseParams({ limit: 3, offset: 6 });
  const raw = [item({ id: 'com.example.a' }), { id: 'bad' }, item({ id: 'com.example.c' }), item({ id: 'com.example.d' }), item({ id: 'com.example.e' })];
  const r = cleanBrowseList({ total: 100, items: raw, offset: 999, sort: 'name', q: 'ignored' }, 'http://r.example', ask);
  assert.deepEqual(r.items.map((x) => x.id), ['com.example.a', 'com.example.c'], 'cut to the 3 asked for, the malformed one dropped');
  assert.deepEqual([r.offset, r.limit, r.sort, r.q, r.total, r.next], [6, 3, 'new', '', 100, 9], 'the answer’s own echo is ignored');
  assert.equal(cleanBrowseList({ total: 4, items: raw.slice(0, 3) }, 'http://r.example', browseParams({ limit: 3, offset: 1 })).next, null, 'the end');
  assert.equal(cleanBrowseList({ total: 50, items: [] }, 'http://r.example', browseParams({})).next, null, 'an empty page never says there is more');
  for (const bad of [null, [], 'items', { items: 'x' }, { items: { 0: 1 } }, { total: 1 }]) {
    assert.throws(() => cleanBrowseList(bad, 'http://r.example', browseParams({})), (e) => e instanceof UpdateError && /format this loader does not know/.test(e.message), JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------------------------------------ limits, errors, bad addresses

test('an answer larger than 4 MiB is refused, and the connection is dropped', async (t) => {
  let dropped = false;
  const s = await standIn(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed || sent > 256 * 1024 * 1024) return clearInterval(timer);
      sent += chunk.length;
      return res.write(chunk);
    }, 5);
    res.on('close', () => {
      dropped = true;
      clearInterval(timer);
    });
    res.write('{"total":1,"items":[');
  });
  const { updates } = newUpdates(t);
  await assert.rejects(updates.browseRegistry(s.url, {}), (e) => e instanceof UpdateError && /unexpectedly large answer/.test(e.message));
  const end = Date.now() + 3000;
  while (!dropped && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(dropped, true, 'the loader hung up instead of reading on');
});

test('a registry that does not answer is given up on at the deadline; so is one that answers a byte at a time', async (t) => {
  const s = await standIn(t, (req, res) => {
    if (req.url.startsWith('/api/apps')) return undefined; // never answers
    return res.end();
  });
  const { updates } = newUpdates(t);
  let t0 = Date.now();
  await assert.rejects(updates.browseRegistry(s.url, { deadlineMs: 300 }), (e) => e instanceof UpdateError && e.offline === true && e.code === 'ETIMEDOUT' && /did not answer in time/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, 'it did not wait for ever');

  const drip = await standIn(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"total":0,"items":[');
    const timer = setInterval(() => res.write(' '), 50);
    res.on('close', () => clearInterval(timer));
  });
  t0 = Date.now();
  await assert.rejects(updates.browseRegistry(drip.url, { deadlineMs: 400 }), (e) => e instanceof UpdateError && /did not answer in time/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, 'the deadline is for the whole answer, not for each byte');
});

test('errors are plain words: unreachable, HTTP errors (the registry’s own message), not JSON, a redirect that is not followed', async (t) => {
  const { updates } = newUpdates(t);
  const gone = await deadUrl();
  const s = await standIn(t, (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/e500/api/apps') return json(res, { error: { code: 'boom', message: 'storage is down' } }, 500);
    if (p === '/e429/api/apps') return json(res, { error: { code: 'rate_limited', message: 'too many requests; try again in 12 s' } }, 429);
    if (p === '/e400/api/apps') return json(res, { error: { code: 'bad_request', message: 'M'.repeat(5000) } }, 400);
    if (p === '/e404/api/apps') return json(res, 'not found', 404);
    if (p === '/html/api/apps') return json(res, '<html>hello</html>');
    if (p === '/redirect/api/apps') {
      res.writeHead(302, { Location: '/elsewhere' });
      return res.end();
    }
    return json(res, { total: 0, items: [] });
  });
  await assert.rejects(updates.browseRegistry(`${s.url}/e500`, {}), (e) => e instanceof UpdateError && e.status === 500 && e.message === 'storage is down (HTTP 500)');
  await assert.rejects(updates.browseRegistry(`${s.url}/e429`, {}), (e) => e.status === 429 && /try again in 12 s/.test(e.message));
  await assert.rejects(updates.browseRegistry(`${s.url}/e400`, {}), (e) => e.status === 400 && e.message.length <= 400 && e.message.endsWith('…'), 'an absurdly long message is shortened');
  await assert.rejects(updates.browseRegistry(`${s.url}/e404`, {}), (e) => e.status === 404 && /answered HTTP 404/.test(e.message));
  await assert.rejects(updates.browseRegistry(`${s.url}/html`, {}), (e) => /not valid JSON/.test(e.message));
  await assert.rejects(updates.browseRegistry(`${s.url}/redirect`, {}), (e) => e.status === 302 && /answered HTTP 302/.test(e.message));
  assert.ok(!s.seen.some((x) => x.url === '/elsewhere'), 'a redirect is not followed');
  await assert.rejects(updates.browseRegistry(gone, {}), (e) => e instanceof UpdateError && e.offline === true && /Cannot reach the registry at http:\/\/127\.0\.0\.1:\d+ \((ECONNREFUSED|ECONNRESET)\)/.test(e.message));
});

test('a bad registry address is refused in plain words before any request is made', async (t) => {
  const { updates } = newUpdates(t);
  const calls = [];
  const orig = http.get;
  http.get = (...a) => {
    calls.push(a[0]);
    return orig(...a);
  };
  t.after(() => {
    http.get = orig;
  });
  for (const bad of ['', '   ', 'not a url', 'localhost:8790', 'ftp://registry.example.org', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:secret@registry.example.org', 'http://', 'https://' + 'a'.repeat(3000) + '.example', null, undefined, 42, {}]) {
    await assert.rejects(updates.browseRegistry(bad, {}), (e) => e instanceof UpdateError && /Enter the registry address/.test(e.message), JSON.stringify(bad));
  }
  assert.deepEqual(calls, [], 'nothing was sent');
});

// ------------------------------------------------------------------------------------------------ the loader's IPC

function loadLibrary() {
  const handlers = {};
  const fake = {
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) },
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : orig.call(this, request, ...rest);
  };
  try {
    for (const f of ['library', 'window-manager']) delete require.cache[require.resolve(`../../loader/src/${f}`)];
    return { Library: require('../../loader/src/library').Library, handlers };
  } finally {
    Module._load = orig;
  }
}

function newLibrary(t, { updates, registryDefault = '' } = {}) {
  const { store, updates: realUpdates } = newUpdates(t);
  const { Library, handlers } = loadLibrary();
  const lib = new Library({
    store,
    runner: { on() {}, state: () => 'stopped', isActive: () => false, sessionOf: () => null, error: () => null, note: () => null },
    inspector: {},
    nativeDialogs: {},
    senders: new Map([[1, 'library'], [2, 'inspector']]),
    updates: updates || realUpdates,
    catalog: null,
    capabilities: null,
    hostLimits: () => ({ cpus: 8, memoryMiB: 4096 }),
    registryDefault,
    log: () => {},
  });
  const ipc = (channel, ...args) => handlers[channel]({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'f' }, ...args);
  return { lib, ipc, handlers, store };
}

test('lib:registryBrowse: only the library window may ask; the launcher’s registry is used (normalized); results come back; installing a card is the verified install path', async (t) => {
  const r = await startFixtureRegistry(t);
  const { lib, ipc, handlers, store } = newLibrary(t, { registryDefault: `  ${r.url}/  ` });
  // another loader window is refused
  const denied = await handlers['lib:registryBrowse']({ sender: { id: 2, mainFrame: 'f' }, senderFrame: 'f' }, {});
  assert.deepEqual(denied, { ok: false, error: 'denied' });
  const frame = await handlers['lib:registryBrowse']({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'other' }, {});
  assert.deepEqual(frame, { ok: false, error: 'denied' });

  const out = await ipc('lib:registryBrowse', { q: 'notes', sort: 'name', offset: 0 });
  assert.equal(out.ok, true, out.error);
  const res = out.result;
  assert.deepEqual(Object.keys(res).sort(), ['insecure', 'items', 'next', 'offset', 'q', 'registry', 'sort', 'total']);
  assert.deepEqual([res.registry, res.insecure, res.q, res.sort, res.offset, res.total, res.next], [r.url, false, 'notes', 'name', 0, 1, null]);
  assert.deepEqual(res.items.map((x) => [x.id, x.name, x.latestVersion]), [['com.example.notes', 'Notes', '1.0.0']]);

  // a hostile page cannot make the main process do anything else: it cannot name another registry, and odd options are ignored or refused
  const odd = await ipc('lib:registryBrowse', { q: 'a', sort: 'popular', offset: 'x', registry: 'http://evil.example', limit: 1000000, deadlineMs: 1e9 });
  assert.equal(odd.ok, true);
  assert.equal(odd.result.registry, r.url);
  assert.equal(odd.result.limit, undefined);
  assert.equal((await ipc('lib:registryBrowse', 'http://evil.example', {})).result.registry, r.url, 'an address passed instead of the options is not used either');
  assert.equal((await ipc('lib:registryBrowse', { sort: 'drop table' })).ok, false);
  assert.equal((await ipc('lib:registryBrowse', { q: 'x'.repeat(500) })).error, 'The search text can have at most 100 characters.');
  assert.equal((await ipc('lib:registryBrowse', null)).ok, true, 'no options is fine: the newest apps');
  assert.equal((await ipc('lib:registryBrowse', null)).result.sort, 'new');

  // install from a card = lib:registryFetch with the id from the list and the registry of the list: the same review as ever
  const fetched = await ipc('lib:registryFetch', res.registry, res.items[0].id);
  assert.equal(fetched.ok, true, fetched.error);
  assert.equal(fetched.result.review.manifest.id, 'com.example.notes');
  assert.deepEqual(fetched.result.review.source, { registry: r.url, insecure: false });
  assert.equal(fetched.result.review.kind, 'new');
  assert.equal(store.get('com.example.notes'), null, 'browsing and fetching install nothing: only the review’s Install does');
  assert.equal((await ipc('lib:cancelInstall')).ok, true);
  assert.equal(lib.installs.size, 0);
});

test('lib:registryBrowse: no or a bad launcher registry says so; an unreachable registry says so', async (t) => {
  for (const bad of ['', 'nonsense', 'ftp://x.example', 'localhost:8790']) {
    const { ipc } = newLibrary(t, { registryDefault: bad });
    const r = await ipc('lib:registryBrowse', {});
    assert.deepEqual(r, { ok: false, error: 'This launcher has no registry to browse.' }, JSON.stringify(bad));
  }
  const gone = await deadUrl();
  const { ipc } = newLibrary(t, { registryDefault: gone });
  const dead = await ipc('lib:registryBrowse', {});
  assert.equal(dead.ok, false);
  assert.ok(dead.error.startsWith(`Cannot reach the registry at ${gone} (`), dead.error);
});

test('lib:registryBrowse: plain http to another computer is marked insecure (loopback and https are not)', async (t) => {
  const asked = [];
  const stub = { browseRegistry: async (registry, o) => { asked.push([registry, o]); return { registry, q: '', sort: 'new', offset: 0, limit: 20, total: 0, next: null, items: [] }; } };
  const flag = async (u) => (await newLibrary(t, { updates: stub, registryDefault: u }).ipc('lib:registryBrowse', {})).result.insecure;
  assert.equal(await flag('http://registry.example.org'), true);
  assert.equal(await flag('http://192.168.1.20:8790'), true);
  assert.equal(await flag('https://registry.example.org'), false);
  assert.equal(await flag('http://127.0.0.1:8790'), false);
  assert.equal(await flag('http://localhost:8790/prefix/'), false);
  assert.equal(asked[4][0], 'http://localhost:8790/prefix', 'the address is normalized before it is used');
  assert.equal(asked[0][1].deadlineMs, 10000, 'the main process sets the deadline, not the page');
});

test('nothing asks any registry by itself: building the library and answering its other requests make no connection (INV-G3)', async (t) => {
  const r = await startFixtureRegistry(t);
  const calls = [];
  const orig = { get: http.get, request: http.request };
  http.get = (...a) => (calls.push(['get', String(a[0])]), orig.get(...a));
  http.request = (...a) => (calls.push(['request', String(a[0])]), orig.request(...a));
  t.after(() => Object.assign(http, orig));
  const { ipc } = newLibrary(t, { registryDefault: r.url });
  for (const ch of ['lib:list', 'lib:registryDefault', 'lib:examplesInfo', 'lib:activity', 'lib:control']) await ipc(ch);
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(calls.filter((c) => c[1].startsWith(r.url)), [], 'no request to the registry before the user asks');
  assert.equal((await ipc('lib:registryDefault')).result.registry, r.url, 'the default is only a value the page may show');
  const out = await ipc('lib:registryBrowse', {});
  assert.equal(out.ok, true);
  assert.equal(calls.filter((c) => c[1].startsWith(r.url)).length, 1, 'exactly one request for one browse');
  assert.ok(calls[0][1].startsWith(`${r.url}/api/apps?`));
});

test('the library page inserts registry text as text only: no HTML strings, no eval, no network API, no inline style', () => {
  const ui = path.join(__dirname, '..', '..', 'loader', 'ui');
  for (const f of ['library.js', 'dom.js']) {
    const js = fs.readFileSync(path.join(ui, f), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|eval\(|new Function|setAttribute\(\s*['"]on|\.style\b|srcdoc/.test(js), `${f}: text is inserted as text`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|require\(/.test(js), `${f}: the page has no network and no Node`);
  }
  const html = fs.readFileSync(path.join(ui, 'library.html'), 'utf8');
  assert.ok(!/\sstyle=|<script>(?!\s*<)|\son\w+=/.test(html), 'library.html: no inline style, script or handler');
});

test('the library page is the only place that may use browsing: the preload exposes it to library.html and nowhere else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'loader', 'preload-loader.js'), 'utf8');
  const lib = src.slice(src.indexOf("if (page === 'library.html')"), src.indexOf("} else if (page === 'settings.html')"));
  assert.match(lib, /registryBrowse: \(opts\) => call\('lib:registryBrowse'/);
  assert.doesNotMatch(lib, /registryBrowse: \(registry/, 'the page cannot name the registry it browses');
  assert.equal(src.split('lib:registryBrowse').length - 1, 1, 'named once in the whole preload');
});
