'use strict';
// The launcher's own updates (SPEC 8.10, INV-U1): hostlib/updates.js cleanLauncherFeed, fetchLauncherFeed and launcherUpdateState.
// The feed is a small JSON file on one fixed address; what it says is cut down to a fixed set of fields, only https addresses of known
// hosts survive, and the request carries nothing about the user. The answers here come from a stand-in server on this Mac (the
// `dev` option, which unpackaged builds and tests use).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { UpdateError, LAUNCHER_FEED_URL, cleanLauncherFeed, fetchLauncherFeed, launcherUpdateState } = require('../../hostlib/updates');

const ZIP = 'https://github.com/d9010/VmApp/releases/download/v0.2.0/D9010-VmApp-Launcher-0.2.0-mac-arm64.zip';
const SHA = 'a'.repeat(64);

const feed = (over = {}) => Object.assign({
  version: '0.2.0',
  url: ZIP,
  sha256: SHA,
  size: 548000000,
  name: 'D9010 VmApp 0.2.0',
  notes: 'A new card tells you when an update is ready.',
  changes: ['The launcher can update itself.', 'Faster start.'],
  pub_date: '2026-10-20T10:00:00Z',
  tag: 'v0.2.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  changelogUrl: 'https://vmapp.dev/docs/changelog',
  pageUrl: 'https://vmapp.dev/download',
  minimumOS: '13.0',
}, over);

test('the default address is one https address on vmapp.dev', () => {
  const u = new URL(LAUNCHER_FEED_URL);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.hostname, 'vmapp.dev');
  assert.equal(u.search, '');
});

test('a good feed becomes a record with exactly the known fields', () => {
  const r = cleanLauncherFeed(Object.assign(feed(), { evil: '<script>', extra: { a: 1 } }));
  assert.deepEqual(Object.keys(r).sort(), ['changelogUrl', 'changes', 'commit', 'minimumOS', 'name', 'notes', 'pageUrl', 'pubDate', 'sha256', 'size', 'tag', 'url', 'version']);
  assert.equal(r.version, '0.2.0');
  assert.equal(r.url, ZIP);
  assert.equal(r.pubDate, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(r.changes, ['The launcher can update itself.', 'Faster start.']);
});

test('the optional fields may be missing', () => {
  const r = cleanLauncherFeed({ version: '1.0.0', url: ZIP, sha256: SHA, size: 5 });
  assert.equal(r.name, 'Version 1.0.0');
  assert.deepEqual(r.changes, []);
  assert.equal(r.changelogUrl, '');
  assert.equal(r.commit, '');
  assert.equal(r.pubDate, '');
});

test('text is cleaned: no controls, no direction overrides, a length cap, at most 12 changes', () => {
  const rlo = String.fromCodePoint(0x202e);
  const r = cleanLauncherFeed(feed({
    name: `Hello${rlo} world\u0007`,
    notes: 'x'.repeat(5000),
    changes: Array.from({ length: 30 }, (_, i) => `change ${i}${rlo}`).concat([5, null, '']),
  }));
  assert.ok(!/[‮\u0007]/.test(r.name));
  assert.ok(r.notes.length <= 1500);
  assert.equal(r.changes.length, 12);
  assert.ok(r.changes.every((c) => !c.includes(rlo)));
});

test('an unusable feed is refused', () => {
  const refuse = (j, dev) => assert.throws(() => cleanLauncherFeed(j, { dev }), UpdateError);
  refuse(null);
  refuse([]);
  refuse('x');
  refuse(feed({ version: undefined }));
  refuse(feed({ version: 'latest' }));
  refuse(feed({ version: '1.2' }));
  refuse(feed({ sha256: 'zz' }));
  refuse(feed({ sha256: undefined }));
  refuse(feed({ size: 0 }));
  refuse(feed({ size: -5 }));
  refuse(feed({ size: 1.5 }));
  refuse(feed({ size: 5 * 1024 * 1024 * 1024 }));
});

test('only an https zip on a known host is accepted as the download', () => {
  const refuse = (url) => assert.throws(() => cleanLauncherFeed(feed({ url })), UpdateError, url);
  refuse(undefined);
  refuse(ZIP.replace('https:', 'http:'));
  refuse('https://evil.example.com/D9010.zip');
  refuse('https://github.com.evil.example.com/a.zip');
  refuse('https://user:pw@github.com/d9010/VmApp/releases/download/v1/a.zip');
  refuse('https://github.com:8443/d9010/VmApp/releases/download/v1/a.zip');
  refuse('https://github.com/d9010/VmApp/releases/download/v1/a.dmg');
  refuse('https://github.com/d9010/VmApp/releases/download/v1/a.zip#frag');
  refuse('ftp://github.com/a.zip');
  refuse('file:///tmp/a.zip');
  refuse('javascript:alert(1)');
  refuse(`https://github.com/${'a'.repeat(700)}.zip`);
  assert.equal(cleanLauncherFeed(feed({ url: 'https://vmapp.dev/downloads/a.zip' })).url, 'https://vmapp.dev/downloads/a.zip');
});

test('this-Mac addresses are accepted only in dev mode', () => {
  const local = 'http://127.0.0.1:8123/launcher.zip';
  assert.throws(() => cleanLauncherFeed(feed({ url: local })), UpdateError);
  assert.equal(cleanLauncherFeed(feed({ url: local }), { dev: true }).url, local);
  assert.throws(() => cleanLauncherFeed(feed({ url: 'http://192.168.1.5/launcher.zip' }), { dev: true }), UpdateError);
});

test('the page links must be on vmapp.dev, or they are dropped', () => {
  const r = cleanLauncherFeed(feed({ changelogUrl: 'https://evil.example.com/changelog', pageUrl: 'http://vmapp.dev/download' }));
  assert.equal(r.changelogUrl, '');
  assert.equal(r.pageUrl, '');
  assert.equal(cleanLauncherFeed(feed({ changelogUrl: 'https://vmapp.dev/docs/changelog#v0-2-0' })).changelogUrl, '', 'no fragment either');
});

test('odd tag, commit and minimumOS values are dropped, not passed on', () => {
  const r = cleanLauncherFeed(feed({ tag: 'v1 <b>', commit: 'not hex', minimumOS: 'thirteen', pub_date: 'someday' }));
  assert.equal(r.tag, '');
  assert.equal(r.commit, '');
  assert.equal(r.minimumOS, '');
  assert.equal(r.pubDate, '');
});

test('launcherUpdateState: newer, same, ahead, skipped, prereleases', () => {
  const f = (version) => cleanLauncherFeed(feed({ version }));
  assert.equal(launcherUpdateState('0.1.0', f('0.2.0')), 'newer');
  assert.equal(launcherUpdateState('0.1.9', f('0.2.0')), 'newer');
  assert.equal(launcherUpdateState('0.2.0', f('0.2.0')), 'same');
  assert.equal(launcherUpdateState('0.3.0', f('0.2.0')), 'ahead');
  assert.equal(launcherUpdateState('0.1.0', f('0.2.0'), '0.2.0'), 'skipped');
  assert.equal(launcherUpdateState('0.1.0', f('0.2.0'), '0.1.5'), 'newer', 'skipping an older version does not hide a newer one');
  assert.equal(launcherUpdateState('0.2.0-beta.1', f('0.2.0')), 'newer');
  assert.equal(launcherUpdateState('0.2.0', f('0.2.0-beta.1')), 'ahead');
  assert.equal(launcherUpdateState('1.0.0', f('0.9.9'), '0.9.9'), 'ahead', 'a skipped version that is older changes nothing');
  assert.equal(launcherUpdateState('not-a-version', f('0.2.0')), 'same');
});

// ------------------------------------------------------------------------------------------------ the request

async function serve(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}/updates/mac-arm64/latest.json`, seen };
}

const sendJson = (obj, status = 200) => (req, res) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
};

test('fetching: one plain GET with no identifier, and the answer comes back cleaned', async (t) => {
  const s = await serve(t, sendJson(feed({ url: 'http://127.0.0.1:1/a.zip' })));
  const r = await fetchLauncherFeed(s.url, { dev: true });
  assert.equal(r.version, '0.2.0');
  assert.equal(s.seen.length, 1);
  const q = s.seen[0];
  assert.equal(q.method, 'GET');
  assert.equal(q.url, '/updates/mac-arm64/latest.json', 'no query string: not even the running version is sent');
  for (const h of ['user-agent', 'cookie', 'authorization', 'referer', 'x-forwarded-for', 'origin']) assert.equal(q.headers[h], undefined, `${h} must not be sent`);
  assert.deepEqual(Object.keys(q.headers).sort(), ['accept', 'connection', 'host']);
});

test('fetching: only the fixed address (or this Mac, in dev mode) is ever asked', async () => {
  await assert.rejects(fetchLauncherFeed('https://evil.example.com/updates/mac-arm64/latest.json'), /not one this launcher may ask/);
  await assert.rejects(fetchLauncherFeed('http://vmapp.dev/updates/mac-arm64/latest.json'), /not one this launcher may ask/);
  await assert.rejects(fetchLauncherFeed('http://127.0.0.1:9/latest.json'), /not one this launcher may ask/, 'this Mac is refused unless dev');
  await assert.rejects(fetchLauncherFeed('https://vmapp.dev.evil.example.com/latest.json'), /not one this launcher may ask/);
});

test('fetching: errors are plain words and carry the status', async (t) => {
  const a = await serve(t, sendJson({ error: 'nope' }, 404));
  await assert.rejects(fetchLauncherFeed(a.url, { dev: true }), (e) => e instanceof UpdateError && e.status === 404 && /HTTP 404/.test(e.message));
  const b = await serve(t, sendJson('<html>not json</html>'));
  await assert.rejects(fetchLauncherFeed(b.url, { dev: true }), /not valid JSON/);
  const c = await serve(t, sendJson({ version: 'banana' }));
  await assert.rejects(fetchLauncherFeed(c.url, { dev: true }), /cannot be used/);
  const d = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(feed({ notes: 'x'.repeat(300 * 1024) })));
  });
  await assert.rejects(fetchLauncherFeed(d.url, { dev: true }), /unexpectedly large/);
});

test('fetching: a redirect is not followed', async (t) => {
  const target = await serve(t, sendJson(feed({ url: 'http://127.0.0.1:1/a.zip' })));
  const s = await serve(t, (req, res) => {
    res.writeHead(302, { Location: target.url });
    res.end();
  });
  await assert.rejects(fetchLauncherFeed(s.url, { dev: true }), (e) => e instanceof UpdateError && e.status === 302);
  assert.equal(target.seen.length, 0);
});

test('fetching: a server that does not answer in time is "offline", not a crash', async (t) => {
  const s = await serve(t, () => {});
  await assert.rejects(fetchLauncherFeed(s.url, { dev: true, deadlineMs: 200 }), (e) => e instanceof UpdateError && e.offline === true);
});

test('fetching: nothing listening is "offline"', async () => {
  await assert.rejects(fetchLauncherFeed('http://127.0.0.1:9/updates/mac-arm64/latest.json', { dev: true }), (e) => e instanceof UpdateError && e.offline === true);
});
