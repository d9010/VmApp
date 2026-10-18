'use strict';
// The storage design (registry/README.md, "Storage") on the local backend: append-only files, replay == live state,
// snapshots, tombstones, gc, export, migration from the old db.json format, and what happens when storage fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Db } = require('../../registry/lib/db');
const { LocalStore, parseEventKey, blobKey } = require('../../registry/lib/store');
const { EventLog, EventLogError } = require('../../registry/lib/eventlog');
const { apply } = require('../../registry/lib/state');
const { readTar } = require('../../registry/lib/tar');
const { canonical } = require('../../registry/lib/migrate');
const admin = require('../../registry/lib/admin');
const adminCli = require('../../registry/admin');
const pkg = require('../../hostlib/package');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish, listFiles, storeText } = require('./helpers');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DAY = 24 * 3600 * 1000;

function fixture(t, prefix) {
  const dir = tmpdir(prefix);
  t.after(() => rmrf(dir));
  return dir;
}

async function server(t, opts) {
  const s = await startRegistry(opts);
  t.after(async () => {
    await s.close().catch(() => {});
    rmrf(s.dir);
  });
  return s;
}

/** rel path -> { ino, mtimeMs, size, mode, sha } for every file in a store directory. */
function fileMap(root) {
  const m = new Map();
  for (const rel of listFiles(root)) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    m.set(rel, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode, sha: sha256(fs.readFileSync(abs)) });
  }
  return m;
}

/** Fails if any file that was in `before` is gone, was replaced (another inode), or changed (time, size, content). */
function assertOnlyAdded(before, after, label) {
  for (const [rel, b] of before) {
    const a = after.get(rel);
    assert.ok(a, `${label}: ${rel} disappeared`);
    assert.equal(a.ino, b.ino, `${label}: ${rel} was replaced (new inode)`);
    assert.equal(a.mtimeMs, b.mtimeMs, `${label}: ${rel} was modified (mtime)`);
    assert.equal(a.size, b.size, `${label}: ${rel} changed size`);
    assert.equal(a.sha, b.sha, `${label}: ${rel} changed content`);
  }
  return [...after.keys()].filter((k) => !before.has(k));
}

/** The state that replaying every event from #1 gives (snapshots are ignored), canonical JSON. */
async function fullReplay(storeDir) {
  const store = new LocalStore(storeDir);
  const db = new Db();
  const files = [];
  for await (const o of store.list('events/')) files.push(o.key);
  const evs = [];
  for (const k of files) evs.push(JSON.parse(fs.readFileSync(store.pathOf(k), 'utf8')));
  evs.sort((a, b) => a.seq - b.seq);
  evs.forEach((ev, i) => assert.equal(ev.seq, i + 1, 'sequence numbers have no gaps'));
  for (const ev of evs) apply(db, ev);
  return { state: canonical(db.toState()), count: evs.length };
}

/** A fresh registry-less load: newest snapshot plus later events, as a starting server does it. */
async function loadLikeServer(storeDir) {
  const store = new LocalStore(storeDir);
  const db = new Db();
  const events = new EventLog({ store, db, snapshotEvery: 0 });
  const info = await events.load();
  return { state: canonical(db.toState()), info, db };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------------------------------------ append-only
test('append-only: no file is ever rewritten, replaced or removed; every change adds files', async (t) => {
  const dir = fixture(t, 'ao-');
  const dataDir = path.join(dir, 'data');
  const w = path.join(dir, 'pkgs');
  fs.mkdirSync(w);
  const mails = [];
  const open = () => startRegistry({ dataDir, snapshotEvery: 5, mailer: { send: async (m) => void mails.push(m) } });
  let s = await open();
  t.after(() => s.close().catch(() => {}));
  const storeDir = s.storeDir;
  let prev = fileMap(storeDir);
  const step = async (label, fn, { expectNew = true } = {}) => {
    await fn();
    await s.reg.events.idle();
    const cur = fileMap(storeDir);
    const added = assertOnlyAdded(prev, cur, label);
    if (expectNew) assert.ok(added.length > 0, `${label}: nothing was added`);
    prev = cur;
    return added;
  };

  const v1 = buildPackage(w, 'v1', { id: 'com.example.ao', name: 'Ao', version: '1.0.0' });
  const v2 = buildPackage(w, 'v2', { id: 'com.example.ao', name: 'Ao', version: '1.1.0' });
  const v3 = buildPackage(w, 'v3', { id: 'com.example.ao', name: 'Ao', version: '1.2.0' });
  let token;
  let added = await step('first publish', async () => {
    const r = await publish(s.url, v1.file, { profile: { name: 'Zed', email: 'zed@acme.test' } });
    assert.equal(r.status, 201, r.text);
    token = r.json.ownerToken;
  });
  assert.equal(added.filter((f) => f.startsWith('events/')).length, 2, 'publisher.created and app.published');
  assert.equal(added.filter((f) => f.startsWith('blobs/')).length, 1);
  await step('second version', async () => assert.equal((await publish(s.url, v2.file, { token })).status, 201));
  await step('downloads then a counters flush', async () => {
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) assert.equal((await call(s.url, '/api/apps/com.example.ao/latest/download', { ip })).status, 200);
    await s.reg.flush();
  });
  await step('downloads that are not flushed yet add nothing', async () => {
    await call(s.url, '/api/apps/com.example.ao/1.0.0/download', { ip: '10.0.0.9' });
  }, { expectNew: false });
  await step('withdraw', async () => assert.equal((await call(s.url, '/api/apps/com.example.ao/1.1.0/withdraw', { method: 'POST', token, json: { reason: 'first reason' } })).status, 200));
  await step('withdraw again replaces the reason by a new event', async () => assert.equal((await call(s.url, '/api/apps/com.example.ao/1.1.0/withdraw', { method: 'POST', token, json: { reason: 'second reason' } })).status, 200));
  await step('restore', async () => assert.equal((await call(s.url, '/api/apps/com.example.ao/1.1.0/restore', { method: 'POST', token })).status, 200));
  await step('profile change', async () => assert.equal((await call(s.url, '/api/publisher/profile', { method: 'POST', token, json: { name: 'Zed', email: 'zed@acme.test', company: 'Acme' } })).status, 200));
  await step('email verification', async () => {
    assert.equal((await call(s.url, '/api/publisher/verify-email', { method: 'POST', token })).status, 200);
    const code = /code: ([0-9a-f]{32})/.exec(mails[0].text)[1];
    assert.equal((await call(s.url, '/api/publisher/confirm-email', { method: 'POST', json: { code } })).status, 200);
  });
  await step('snapshot command', async () => {
    await s.reg.snapshot();
  }, { expectNew: false });
  await s.close(); // closing flushes the pending download and writes a final snapshot: only additions
  let afterClose = fileMap(storeDir);
  assert.ok(assertOnlyAdded(prev, afterClose, 'close').length > 0);
  prev = afterClose;
  s = await open();
  await step('restart without changes', async () => {}, { expectNew: false });
  await step('publish after a restart', async () => assert.equal((await publish(s.url, v3.file, { token })).status, 201));
  await s.close();
  afterClose = fileMap(storeDir);
  assertOnlyAdded(prev, afterClose, 'second close');
  prev = afterClose;

  // an administrator's change is an event too
  const env = { REGISTRY_DATA: dataDir };
  assert.equal(await adminCli.run(['hide', 'com.example.ao', '--reason', 'testing'], env, () => {}), 0);
  assert.equal(await adminCli.run(['unhide', 'com.example.ao'], env, () => {}), 0);
  const fin = fileMap(storeDir);
  assert.equal(assertOnlyAdded(prev, fin, 'hide and unhide').filter((f) => f.startsWith('events/')).length, 2);

  // the store itself refuses to replace or remove what it holds
  const store = new LocalStore(storeDir);
  const evKey = [...fin.keys()].find((k) => k.startsWith('events/'));
  assert.deepEqual(await store.put(evKey, Buffer.from('something else')), { created: false });
  const blob = [...fin.keys()].find((k) => k.startsWith('blobs/'));
  assert.deepEqual(await store.putFile(blob, v1.file), { created: false });
  await assert.rejects(store.delete(evKey), /only blobs\/ and staging\//);
  await assert.rejects(store.delete('snapshots/000000000001.json'), /only blobs\/ and staging\//);
  assertOnlyAdded(fin, fileMap(storeDir), 'attempts to replace or delete');
});

test('event files: names, content and what they never contain', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.fmt', name: 'Fmt' });
  const r = await publish(s.url, a.file, { profile: { name: 'Zed', email: 'zed@acme.test' } });
  const token = r.json.ownerToken;
  await call(s.url, `/api/apps/com.example.fmt/1.0.0/withdraw`, { method: 'POST', token, json: { reason: 'because' } });
  await s.close();
  const files = listFiles(s.storeDir).filter((f) => f.startsWith('events/'));
  assert.equal(files.length, 3);
  const seqs = [];
  for (const f of files) {
    assert.match(f, /^events\/\d{4}\/\d{2}\/\d{2}\/\d{12}-[0-9a-f]{12}\.json$/);
    const ev = JSON.parse(fs.readFileSync(path.join(s.storeDir, f), 'utf8'));
    assert.deepEqual(Object.keys(ev), ['seq', 'ts', 'type', 'actor', 'data']);
    assert.equal(parseEventKey(f).seq, ev.seq);
    assert.equal(f.slice(7, 17), ev.ts.slice(0, 10).replace(/-/g, '/'), 'the folder is the UTC date of the event');
    assert.match(ev.actor, /^pub-[0-9a-f]{16}$/);
    seqs.push(ev.seq);
    assert.equal(fs.statSync(path.join(s.storeDir, f)).mode & 0o777, 0o600, 'events are private');
  }
  assert.deepEqual(seqs, [1, 2, 3]);
  const all = storeText(s.storeDir);
  assert.ok(!all.includes(token), 'no token');
  assert.ok(all.includes(sha256(token)), 'only its hash');
  assert.deepEqual(files.map((f) => JSON.parse(fs.readFileSync(path.join(s.storeDir, f), 'utf8')).type), ['publisher.created', 'app.published', 'version.withdrawn']);
  const blob = listFiles(s.storeDir).find((f) => f.startsWith('blobs/'));
  assert.equal(blob, `blobs/sha256/${sha256(fs.readFileSync(a.file)).slice(0, 2)}/${sha256(fs.readFileSync(a.file))}.vmapp`);
  assert.equal(fs.statSync(path.join(s.storeDir, blob)).mode & 0o777, 0o644, 'packages are public data');
});

test('event time never goes backwards, even if the clock does', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.clk', name: 'Clk', version: '1.0.0' });
  const b = buildPackage(w, 'b', { id: 'com.example.clk', name: 'Clk', version: '1.1.0' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  s.clock.advance(-5 * DAY);
  assert.equal((await publish(s.url, b.file, { token })).status, 201);
  const evs = listFiles(s.storeDir).filter((f) => f.startsWith('events/')).map((f) => JSON.parse(fs.readFileSync(path.join(s.storeDir, f), 'utf8')));
  assert.equal(evs.length, 3);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].ts >= evs[i - 1].ts, 'ts is monotonic');
  assert.equal((await call(s.url, '/api/apps/com.example.clk')).status, 200);
});

// ------------------------------------------------------------------------------------------------ replay
test('replay == live state, and snapshot + later events == full replay', async (t) => {
  const dir = fixture(t, 'rp-');
  const dataDir = path.join(dir, 'data');
  const w = path.join(dir, 'pkgs');
  fs.mkdirSync(w);
  const s = await startRegistry({ dataDir, snapshotEvery: 4, mailer: { send: async () => {} } });
  t.after(() => s.close().catch(() => {}));
  let token = null;
  for (const [i, v] of ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0', '2.2.0'].entries()) {
    const p = buildPackage(w, `p${i}`, { id: 'com.example.rp', name: 'Rp', version: v });
    const r = await publish(s.url, p.file, { token, profile: token ? undefined : { name: 'Q', email: 'q@acme.test' } });
    assert.equal(r.status, 201, r.text);
    token = token || r.json.ownerToken;
    await call(s.url, `/api/apps/com.example.rp/${v}/download`, { ip: `10.0.0.${i + 1}` });
    s.clock.advance(7 * 3600 * 1000); // downloads fall into different hours and days
  }
  const other = buildPackage(w, 'o', { id: 'com.example.rp2', name: 'Rp2' });
  assert.equal((await publish(s.url, other.file, { token })).status, 201);
  await call(s.url, '/api/apps/com.example.rp/1.1.0/withdraw', { method: 'POST', token, json: { reason: 'r' } });
  await call(s.url, '/api/publisher/profile', { method: 'POST', token, json: { name: 'Q2', email: 'other@acme.test' } });
  await s.reg.flush();
  await s.reg.events.idle();

  // 1. replay of the whole log == the live state
  const live = canonical(s.reg.db.toState());
  const full = await fullReplay(s.storeDir);
  assert.equal(full.state, live);
  assert.equal(JSON.parse(live).apps['com.example.rp'].downloads, 6);

  // 2. several snapshots exist; a starting server loads the newest and replays only what came after it
  const snaps = listFiles(s.storeDir).filter((f) => f.startsWith('snapshots/'));
  assert.ok(snaps.length >= 2, `snapshots: ${snaps}`);
  const viaSnap = await loadLikeServer(s.storeDir);
  assert.ok(viaSnap.info.snapshotSeq > 0, 'a snapshot was used');
  assert.ok(viaSnap.info.replayed < full.count, 'and only the later events were replayed');
  assert.equal(viaSnap.state, full.state);
  assert.equal(viaSnap.info.seq, full.count);
  for (const f of snaps) {
    const sn = JSON.parse(fs.readFileSync(path.join(s.storeDir, f), 'utf8'));
    assert.equal(f, `snapshots/${String(sn.seq).padStart(12, '0')}.json`);
    assert.equal(sn.format, 1);
    assert.equal(sha256(JSON.stringify(sn.state)), sn.stateSha256);
  }

  // 3. a damaged newest snapshot is skipped, the next older one is used
  const newest = snaps.sort().pop();
  const copy = path.join(dir, 'copy');
  fs.cpSync(s.storeDir, copy, { recursive: true });
  const bad = JSON.parse(fs.readFileSync(path.join(copy, newest), 'utf8'));
  bad.state.apps['com.example.rp'].downloads += 1; // content changed, checksum not
  fs.chmodSync(path.join(copy, newest), 0o600);
  fs.writeFileSync(path.join(copy, newest), JSON.stringify(bad));
  const logs = [];
  const st = new LocalStore(copy);
  const db2 = new Db();
  const ev2 = new EventLog({ store: st, db: db2, log: (m) => logs.push(m), snapshotEvery: 0 });
  const info2 = await ev2.load();
  assert.ok(logs.some((l) => /not usable/.test(l)));
  assert.ok(info2.snapshotSeq < Number(newest.match(/(\d+)\.json/)[1]));
  assert.equal(canonical(db2.toState()), full.state);

  // 4. closing the server writes a final snapshot, so the next start replays nothing
  await s.close();
  const afterClose = await loadLikeServer(s.storeDir);
  assert.equal(afterClose.info.replayed, 0);
  assert.equal(afterClose.state, full.state);
});

test('a log with a gap or two events with one sequence number is refused, not repaired', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const token = (await publish(s.url, buildPackage(w, 'a', { id: 'com.example.gap', name: 'Gap', version: '1.0.0' }).file)).json.ownerToken;
  assert.equal((await publish(s.url, buildPackage(w, 'b', { id: 'com.example.gap', name: 'Gap', version: '1.1.0' }).file, { token })).status, 201);
  assert.equal((await publish(s.url, buildPackage(w, 'c', { id: 'com.example.gap', name: 'Gap', version: '1.2.0' }).file, { token })).status, 201);
  await s.close();
  const evFiles = listFiles(s.storeDir).filter((f) => f.startsWith('events/')).sort();
  assert.equal(evFiles.length, 4);

  // a missing event (and no snapshot to hide it)
  const c1 = path.join(s.dir, 'gap');
  fs.cpSync(s.storeDir, c1, { recursive: true });
  for (const f of listFiles(c1).filter((x) => x.startsWith('snapshots/'))) fs.rmSync(path.join(c1, f));
  fs.rmSync(path.join(c1, evFiles[1]));
  await assert.rejects(new EventLog({ store: new LocalStore(c1), db: new Db(), snapshotEvery: 0 }).load(), (e) => e instanceof EventLogError && /#2 .*missing/.test(e.message));

  // two events with the same sequence number (a second writer, or a repeated write)
  const c2 = path.join(s.dir, 'dup');
  fs.cpSync(s.storeDir, c2, { recursive: true });
  for (const f of listFiles(c2).filter((x) => x.startsWith('snapshots/'))) fs.rmSync(path.join(c2, f));
  const src = path.join(c2, evFiles[2]);
  fs.copyFileSync(src, src.replace(/-[0-9a-f]{12}\.json$/, '-ffffffffffff.json'));
  await assert.rejects(new EventLog({ store: new LocalStore(c2), db: new Db(), snapshotEvery: 0 }).load(), (e) => e instanceof EventLogError && /two events with sequence number 3/.test(e.message));

  // and the server does not start on it
  const { createRegistry } = require('../../registry/lib/registry');
  await assert.rejects(createRegistry({ dataDir: path.join(s.dir, 'data'), storage: { type: 'local', dir: c2 }, port: 0 }).start(), /two events with sequence number 3/);
});

test('an event that does not fit the state is not written, and the sequence stays gap-free', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  assert.equal((await publish(s.url, buildPackage(w, 'a', { id: 'com.example.val', name: 'Val' }).file)).status, 201);
  const before = listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length;
  await assert.rejects(s.reg.events.append('version.withdrawn', 'admin', { id: 'com.example.val', version: '9.9.9', reason: 'x' }), /does not exist/);
  await assert.rejects(s.reg.events.append('version.withdrawn', 'admin', { id: 'com.example.val', version: '1.0.0', reason: '' }), /reason/);
  await assert.rejects(s.reg.events.append('no.such.type', 'admin', {}), /unknown type/);
  assert.equal(listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length, before);
  const ev = await s.reg.events.append('app.hidden', 'admin', { id: 'com.example.val', reason: 'ok' });
  assert.equal(ev.seq, before + 1);
});

// ------------------------------------------------------------------------------------------------ downloads
test('download counters are aggregated per app, version and hour, appended every few minutes, never one event per download', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.cnt', name: 'Cnt', version: '1.0.0' });
  const b = buildPackage(w, 'b', { id: 'com.example.cnt', name: 'Cnt', version: '1.1.0' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  await publish(s.url, b.file, { token });
  const countersEvents = () => listFiles(s.storeDir).filter((f) => f.startsWith('events/')).map((f) => JSON.parse(fs.readFileSync(path.join(s.storeDir, f), 'utf8'))).filter((e) => e.type === 'counters.downloads');
  for (let i = 1; i <= 5; i++) await call(s.url, '/api/apps/com.example.cnt/1.0.0/download', { ip: `10.1.0.${i}` });
  await call(s.url, '/api/apps/com.example.cnt/1.1.0/download', { ip: '10.1.0.1' });
  s.clock.advance(3 * 3600 * 1000);
  await call(s.url, '/api/apps/com.example.cnt/1.1.0/download', { ip: '10.1.0.2' });
  // visible at once, though nothing is in the log yet
  assert.equal((await call(s.url, '/api/apps/com.example.cnt')).json.downloads, 7);
  assert.equal(countersEvents().length, 0);
  await s.reg.flush();
  const evs = countersEvents();
  assert.equal(evs.length, 1, 'seven downloads, one event');
  assert.equal(evs[0].actor, 'system');
  assert.deepEqual(evs[0].data.items.sort((x, y) => (x.version + x.hour < y.version + y.hour ? -1 : 1)), [
    { id: 'com.example.cnt', version: '1.0.0', hour: '2026-03-01T12', n: 5 },
    { id: 'com.example.cnt', version: '1.1.0', hour: '2026-03-01T12', n: 1 },
    { id: 'com.example.cnt', version: '1.1.0', hour: '2026-03-01T15', n: 1 },
  ]);
  await s.reg.flush();
  assert.equal(countersEvents().length, 1, 'nothing new to write');
  assert.equal((await call(s.url, '/api/apps/com.example.cnt')).json.downloads, 7, 'and the count did not change when it moved into the log');
  assert.deepEqual((await call(s.url, '/api/apps/com.example.cnt')).json.versions.map((v) => v.downloads), [2, 5]);
});

test('counters are appended by a timer too, not only on shutdown', async (t) => {
  const s = await server(t, { counterFlushMs: 150 });
  const w = fixture(t, 'pkg-');
  await publish(s.url, buildPackage(w, 'a', { id: 'com.example.tmr', name: 'Tmr' }).file);
  await call(s.url, '/api/apps/com.example.tmr/latest/download', { ip: '10.2.0.1' });
  for (let i = 0; i < 40 && !storeText(s.storeDir).includes('counters.downloads'); i++) await sleep(50);
  assert.ok(storeText(s.storeDir).includes('counters.downloads'));
});

test('with a public download address a download is a 302 that carries the verification headers', async (t) => {
  const s = await server(t, { publicDownloadBase: 'https://dl.example.test/' });
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.red', name: 'Red', version: '1.0.0' });
  const b = buildPackage(w, 'b', { id: 'com.example.red', name: 'Red', version: '1.1.0' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  await publish(s.url, b.file, { token });
  await call(s.url, '/api/apps/com.example.red/1.1.0/withdraw', { method: 'POST', token, json: { reason: 'bad one' } });
  const sha = sha256(fs.readFileSync(a.file));
  const get = (p, o) => fetch(s.url + p, Object.assign({ redirect: 'manual' }, o));
  let r = await get('/api/apps/com.example.red/1.0.0/download', { headers: { 'X-Forwarded-For': '10.3.0.1' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `https://dl.example.test/blobs/sha256/${sha.slice(0, 2)}/${sha}.vmapp`);
  assert.equal(r.headers.get('x-vmapp-sha256'), sha);
  assert.equal(r.headers.get('x-vmapp-package-id'), a.packageId);
  assert.equal(r.headers.get('x-vmapp-version'), '1.0.0');
  assert.equal(r.headers.get('x-vmapp-withdrawn'), null);
  assert.equal(r.headers.get('content-length'), '0');
  assert.equal((await r.arrayBuffer()).byteLength, 0);
  // latest = 1.0.0 (1.1.0 is withdrawn); a withdrawn version asked for by number is redirected with its reason
  r = await get('/api/apps/com.example.red/latest/download', { headers: { 'X-Forwarded-For': '10.3.0.2' } });
  assert.equal(r.headers.get('x-vmapp-version'), '1.0.0');
  r = await get('/api/apps/com.example.red/1.1.0/download', { headers: { 'X-Forwarded-For': '10.3.0.3' } });
  assert.equal(r.status, 302);
  assert.equal(decodeURIComponent(r.headers.get('x-vmapp-withdrawn')), 'bad one');
  assert.equal(r.headers.get('x-vmapp-sha256'), sha256(fs.readFileSync(b.file)));
  // HEAD and a matching If-None-Match are not downloads
  await get('/api/apps/com.example.red/1.0.0/download', { method: 'HEAD', headers: { 'X-Forwarded-For': '10.3.0.4' } });
  r = await get('/api/apps/com.example.red/1.0.0/download', { headers: { 'If-None-Match': `"${sha}"`, 'X-Forwarded-For': '10.3.0.5' } });
  assert.equal(r.status, 304);
  assert.equal((await call(s.url, '/api/apps/com.example.red')).json.downloads, 3);
  assert.equal((await call(s.url, '/api/info')).json.downloads, 'redirect');
  assert.deepEqual((await call(s.url, '/api/info')).json.publishModes, ['direct']);
  // the local backend has no presigned upload
  r = await call(s.url, '/api/publish/init', { method: 'POST', json: { size: 10, sha256: 'a'.repeat(64) } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'not_supported');
});

// ------------------------------------------------------------------------------------------------ tombstones
test('hiding an app is a tombstone: it disappears, nothing is deleted, publishing to the id is refused, unhide brings it back', async (t) => {
  const dir = fixture(t, 'tomb-');
  const dataDir = path.join(dir, 'data');
  const w = path.join(dir, 'pkgs');
  fs.mkdirSync(w);
  let s = await startRegistry({ dataDir });
  t.after(() => s.close().catch(() => {}));
  const a = buildPackage(w, 'a', { id: 'com.example.tomb', name: 'Tomb', version: '1.0.0' });
  const a2 = buildPackage(w, 'a2', { id: 'com.example.tomb', name: 'Tomb', version: '1.1.0' });
  const keep = buildPackage(w, 'k', { id: 'com.example.keep', name: 'Keep' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  await publish(s.url, keep.file, { token });
  await call(s.url, '/api/apps/com.example.tomb/latest/download', { ip: '10.4.0.1' });

  // the admin command needs the server stopped
  const env = { REGISTRY_DATA: dataDir };
  const out = [];
  assert.equal(await adminCli.run(['hide', 'com.example.tomb', '--reason', 'abuse report'], env, (l) => out.push(l)), 2);
  await s.close();
  assert.equal(await adminCli.run(['hide', 'com.example.tomb'], env, () => {}), 2, 'a reason is required');
  const files0 = fileMap(s.storeDir);
  assert.equal(await adminCli.run(['hide', 'com.example.tomb', '--reason', 'abuse report'], env, (l) => out.push(l)), 0);
  assert.equal(await adminCli.run(['hide', 'com.example.tomb', '--reason', 'again'], env, () => {}), 1, 'hiding twice is an error');
  assert.equal(await adminCli.run(['hide', 'com.example.nope', '--reason', 'x'], env, () => {}), 1);

  s = await startRegistry({ dataDir });
  assert.equal((await call(s.url, '/api/apps/com.example.tomb')).status, 404);
  assert.equal((await call(s.url, '/api/apps/com.example.tomb/versions')).status, 404);
  assert.equal((await call(s.url, '/api/apps/com.example.tomb/1.0.0/download')).status, 404);
  assert.equal((await call(s.url, '/api/apps/com.example.tomb/latest/download')).status, 404);
  assert.equal((await call(s.url, '/api/apps/com.example.tomb/resolve?choice=latest')).status, 404);
  assert.deepEqual((await call(s.url, '/api/apps')).json.items.map((i) => i.id), ['com.example.keep']);
  assert.equal((await call(s.url, '/api/apps?q=tomb')).json.total, 0);
  assert.equal((await call(s.url, '/api/stats')).json.apps, 1);
  assert.deepEqual((await call(s.url, '/api/publisher/me', { token })).json.apps, ['com.example.keep']);
  let r = await publish(s.url, a2.file, { token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'app_hidden');
  // the data is all still there: the package, the old events and the new tombstone
  const files1 = fileMap(s.storeDir);
  for (const k of files0.keys()) assert.ok(files1.has(k), `${k} is still there`);
  assert.ok(files1.has(`blobs/sha256/${sha256(fs.readFileSync(a.file)).slice(0, 2)}/${sha256(fs.readFileSync(a.file))}.vmapp`));
  assert.ok(storeText(s.storeDir).includes('"type":"app.hidden"'));
  await s.close();

  assert.equal(await adminCli.run(['unhide', 'com.example.tomb'], env, () => {}), 0);
  s = await startRegistry({ dataDir });
  r = await call(s.url, '/api/apps/com.example.tomb');
  assert.equal(r.status, 200);
  assert.equal(r.json.downloads, 1, 'its download count survived');
  assert.equal((await call(s.url, '/api/apps/com.example.tomb/1.0.0/download')).status, 200);
  assert.equal((await publish(s.url, a2.file, { token })).status, 201, 'and the owner can publish again');
});

// ------------------------------------------------------------------------------------------------ admin: gc, verify, export, snapshot
async function adminWorld(t) {
  const dir = fixture(t, 'adm-');
  const dataDir = path.join(dir, 'data');
  const w = path.join(dir, 'pkgs');
  fs.mkdirSync(w);
  const s = await startRegistry({ dataDir });
  const a = buildPackage(w, 'a', { id: 'com.example.adm', name: 'Adm', version: '1.0.0' });
  const b = buildPackage(w, 'b', { id: 'com.example.adm', name: 'Adm', version: '1.1.0' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  await publish(s.url, b.file, { token });
  await call(s.url, '/api/apps/com.example.adm/1.0.0/withdraw', { method: 'POST', token, json: { reason: 'old' } });
  await s.close();
  return { dir, dataDir, storeDir: s.storeDir, env: { REGISTRY_DATA: dataDir }, a, b };
}

const runAdmin = async (args, env) => {
  const out = [];
  const code = await adminCli.run(args, env, (l) => out.push(l));
  return { code, out: out.join('\n') };
};

test('gc: lists unreferenced packages and staging objects; refuses to delete without --confirm; with it deletes only those and writes an audit event', async (t) => {
  const { dataDir, storeDir, env, a } = await adminWorld(t);
  const old = Date.now() - 3 * DAY;
  const mk = (key, bytes, mtime) => {
    const f = path.join(storeDir, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes);
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
    return f;
  };
  const orphanSha = sha256('orphan');
  const orphan = mk(`blobs/sha256/${orphanSha.slice(0, 2)}/${orphanSha}.vmapp`, 'orphan', old);
  const freshSha = sha256('fresh');
  const fresh = mk(`blobs/sha256/${freshSha.slice(0, 2)}/${freshSha}.vmapp`, 'fresh', Date.now());
  const staged = mk('staging/11111111-1111-1111-1111-111111111111.vmapp', 'staged', old);
  const before = fileMap(storeDir);
  const events = [...before.keys()].filter((k) => k.startsWith('events/')).length;

  let r = await runAdmin(['gc'], env);
  assert.equal(r.code, 2, 'without --confirm gc refuses');
  assert.match(r.out, /2 object\(s\) can be deleted/);
  assert.ok(r.out.includes(orphanSha) && r.out.includes('11111111-1111-1111-1111-111111111111'));
  assert.ok(!r.out.includes(freshSha), 'a young object is not a candidate');
  assert.match(r.out, /deletes only with --confirm/);
  assert.deepEqual([...fileMap(storeDir).keys()], [...before.keys()], 'nothing was deleted');

  r = await runAdmin(['gc', '--confirm'], env);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(orphan) && !fs.existsSync(staged), 'the two old objects are gone');
  assert.ok(fs.existsSync(fresh), 'the young one stays');
  const after = fileMap(storeDir);
  const gone = [...before.keys()].filter((k) => !after.has(k));
  assert.equal(gone.length, 2);
  assert.ok(gone.every((k) => k.startsWith('blobs/') || k.startsWith('staging/')));
  for (const [k, v] of before) if (after.has(k)) assert.equal(after.get(k).sha, v.sha, `${k} untouched`);
  assert.ok(fs.existsSync(path.join(storeDir, `blobs/sha256/${sha256(fs.readFileSync(a.file)).slice(0, 2)}/${sha256(fs.readFileSync(a.file))}.vmapp`)), 'referenced packages stay, even of withdrawn versions');
  const evs = [...after.keys()].filter((k) => k.startsWith('events/')).sort();
  assert.equal(evs.length, events + 1, 'one audit event');
  const audit = JSON.parse(fs.readFileSync(path.join(storeDir, evs[evs.length - 1]), 'utf8'));
  assert.equal(audit.type, 'admin.gc');
  assert.equal(audit.actor, 'admin');
  assert.deepEqual(audit.data.deleted.sort(), [`blobs/sha256/${orphanSha.slice(0, 2)}/${orphanSha}.vmapp`, 'staging/11111111-1111-1111-1111-111111111111.vmapp'].sort());

  r = await runAdmin(['gc', '--confirm'], env);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to delete/);
  assert.equal((await runAdmin(['verify'], env)).code, 0);
  void dataDir;
});

test('gc --confirm cannot run while the server is up (it would delete in-flight uploads)', async (t) => {
  const s = await server(t);
  const r = await runAdmin(['gc', '--confirm', '--data', s.dataDir], {});
  assert.equal(r.code, 2);
  assert.equal(await adminCli.run(['gc', '--confirm', '--data', s.dataDir], {}, () => {}), 2);
});

test('verify: a consistent registry passes; a damaged package, a missing event or a forged snapshot is found', async (t) => {
  const { dir, storeDir, env } = await adminWorld(t);
  let r = await runAdmin(['verify'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK: the registry is consistent/);
  assert.match(r.out, /2 packages referenced \(2 re-hashed/);

  // a package whose bytes changed (same size)
  const c1 = path.join(dir, 'c1');
  fs.cpSync(storeDir, c1, { recursive: true });
  const blob = listFiles(c1).find((f) => f.startsWith('blobs/'));
  const bytes = fs.readFileSync(path.join(c1, blob));
  bytes[bytes.length - 1] ^= 1;
  fs.chmodSync(path.join(c1, blob), 0o600);
  fs.writeFileSync(path.join(c1, blob), bytes);
  r = await runAdmin(['verify', '--local-dir', c1], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: .*does not hash to its name/);
  assert.equal((await runAdmin(['verify', '--no-blobs', '--local-dir', c1], env)).code, 0, 'sizes match, so only re-hashing finds it');

  // a missing package
  const c2 = path.join(dir, 'c2');
  fs.cpSync(storeDir, c2, { recursive: true });
  fs.rmSync(path.join(c2, listFiles(c2).find((f) => f.startsWith('blobs/'))));
  r = await runAdmin(['verify', '--local-dir', c2], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: .*is missing/);

  // a missing event
  const c3 = path.join(dir, 'c3');
  fs.cpSync(storeDir, c3, { recursive: true });
  const evs = listFiles(c3).filter((f) => f.startsWith('events/')).sort();
  fs.rmSync(path.join(c3, evs[1]));
  r = await runAdmin(['verify', '--local-dir', c3], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: events #2 to #2 are missing/);

  // a snapshot that does not match its events (checksum recomputed by the forger)
  const c4 = path.join(dir, 'c4');
  fs.cpSync(storeDir, c4, { recursive: true });
  const sf = listFiles(c4).find((f) => f.startsWith('snapshots/'));
  assert.ok(sf, 'closing the server wrote a snapshot');
  const sn = JSON.parse(fs.readFileSync(path.join(c4, sf), 'utf8'));
  sn.state.apps['com.example.adm'].downloads = 999;
  sn.stateSha256 = sha256(JSON.stringify(sn.state));
  fs.chmodSync(path.join(c4, sf), 0o600);
  fs.writeFileSync(path.join(c4, sf), JSON.stringify(sn));
  r = await runAdmin(['verify', '--local-dir', c4], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /snapshot \d+ differs from the state the events give/);
});

test('export: a tar of every event and snapshot, never over an existing file', async (t) => {
  const { dir, storeDir, env } = await adminWorld(t);
  const out = path.join(dir, 'backup.tar');
  let r = await runAdmin(['export', '--out', out], env);
  assert.equal(r.code, 0, r.out);
  const entries = readTar(fs.readFileSync(out));
  const want = listFiles(storeDir).filter((f) => f.startsWith('events/') || f.startsWith('snapshots/'));
  assert.deepEqual(entries.map((e) => e.path).filter((p) => p !== 'EXPORT.json').sort(), want.sort());
  for (const e of entries) if (e.path !== 'EXPORT.json') assert.deepEqual(e.data, fs.readFileSync(path.join(storeDir, e.path)));
  const info = JSON.parse(entries.find((e) => e.path === 'EXPORT.json').data.toString());
  assert.equal(info.files, want.length);
  assert.equal(info.lastSeq, want.filter((f) => f.startsWith('events/')).length);
  assert.ok(!entries.some((e) => e.path.startsWith('blobs/')), 'packages are not in it');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  r = await runAdmin(['export', '--out', out], env);
  assert.equal(r.code, 2, 'never overwrites');
  assert.equal(readTar(fs.readFileSync(out)).length, entries.length);
  // the archive restores to a working registry: unpack events and snapshots into a fresh store, add the blobs, start
  const restored = path.join(dir, 'restored');
  for (const e of entries) {
    if (e.path === 'EXPORT.json') continue;
    fs.mkdirSync(path.dirname(path.join(restored, e.path)), { recursive: true });
    fs.writeFileSync(path.join(restored, e.path), e.data);
  }
  fs.cpSync(path.join(storeDir, 'blobs'), path.join(restored, 'blobs'), { recursive: true });
  assert.equal((await runAdmin(['verify', '--local-dir', restored], env)).code, 0);
  const s = await startRegistry({ dataDir: path.join(dir, 'data2'), storage: { type: 'local', dir: restored } });
  t.after(() => s.close());
  assert.equal((await call(s.url, '/api/apps/com.example.adm')).json.latestVersion, '1.1.0');
});

test('snapshot command writes a new snapshot file next to a running server, once per sequence number', async (t) => {
  const s = await server(t, { snapshotEvery: 0 });
  const w = fixture(t, 'pkg-');
  await publish(s.url, buildPackage(w, 'a', { id: 'com.example.snp', name: 'Snp' }).file);
  const env = { REGISTRY_DATA: s.dataDir };
  const before = fileMap(s.storeDir);
  let r = await runAdmin(['snapshot'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /wrote snapshots\/000000000002\.json/);
  const added = assertOnlyAdded(before, fileMap(s.storeDir), 'snapshot');
  assert.deepEqual(added, ['snapshots/000000000002.json']);
  r = await runAdmin(['snapshot'], env);
  assert.match(r.out, /exists already/);
  assert.equal((await runAdmin(['status'], env)).code, 0);
});

// ------------------------------------------------------------------------------------------------ migration
function makeOldData(dir) {
  const old = path.join(dir, 'old');
  const w = path.join(dir, 'oldpkgs');
  fs.mkdirSync(w, { recursive: true });
  const t0 = Date.parse('2026-02-01T10:00:00Z');
  const tokenA = crypto.randomBytes(32).toString('hex');
  const tokenB = crypto.randomBytes(32).toString('hex');
  const pubs = {
    'pub-00000000000000a1': { id: 'pub-00000000000000a1', tokenHash: sha256(tokenA), name: 'Ann', company: 'Acme', email: 'ann@acme.test', url: 'https://acme.test', createdAt: t0, emailVerified: { email: 'ann@acme.test', at: t0 + 5000 }, domain: null, pending: { email: { hash: 'x' } } },
    'pub-00000000000000b2': { id: 'pub-00000000000000b2', tokenHash: sha256(tokenB), name: 'Bob', company: 'Example Org', email: '', url: 'https://example.org', createdAt: t0 + 1000, emailVerified: null, domain: { name: 'example.org', at: t0 + 9000, method: 'dns' }, pending: {} },
  };
  const apps = {};
  const mk = (id, name, version, extra = {}) => buildPackage(w, `${id}-${version}`, Object.assign({ id, name, version }, extra));
  const addVersions = (id, publisherId, list, appExtra) => {
    const app = Object.assign({ id, publisherId, createdAt: list[0].at, updatedAt: list[list.length - 1].at, latest: list[list.length - 1].version, downloads: 0, daily: {}, versions: {} }, appExtra);
    for (const v of list) {
      const b = mk(id, v.name || id, v.version);
      const info = pkg.verify(b.file);
      const stripped = Object.assign({}, info.manifest);
      delete stripped.files;
      const dest = path.join(old, 'packages', id, `${v.version}.vmapp`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(b.file, dest);
      const bytes = fs.readFileSync(b.file);
      const rec = { version: v.version, packageId: info.packageId, sha256: sha256(bytes), size: bytes.length, publishedAt: v.at, downloads: v.downloads || 0, meta: { manifest: stripped, files: { count: Object.keys(info.manifest.files).length, uiBytes: info.uiBytes, coreBytes: info.coreBytes, hasIcon: info.hasIcon } } };
      if (v.withdrawn) rec.withdrawn = v.withdrawn;
      app.versions[v.version] = rec;
      app.downloads += rec.downloads;
    }
    apps[id] = app;
  };
  addVersions('com.example.alpha', 'pub-00000000000000a1', [
    { version: '1.0.0', at: t0 + 60000, downloads: 4, withdrawn: { reason: 'Corrupts notes', at: t0 + 3 * DAY } },
    { version: '1.1.0', at: t0 + 2 * DAY, downloads: 3 },
    { version: '1.2.0', at: t0 + 4 * DAY, downloads: 8 },
  ], { daily: { '2026-02-25': 3, '2026-02-28': 5 } });
  addVersions('com.example.beta', 'pub-00000000000000b2', [{ version: '0.1.0', at: t0 + 3 * DAY, downloads: 2 }], { daily: { '2026-02-27': 2 } });
  fs.writeFileSync(path.join(old, 'db.json'), JSON.stringify({ schema: 1, apps, publishers: pubs }) + '\n');
  fs.writeFileSync(path.join(old, 'server.pid'), '99999\n');
  return { old, tokenA, tokenB, w };
}

function treeHash(root) {
  const h = crypto.createHash('sha256');
  (function walk(rel) {
    for (const n of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(path.join(root, r)).isDirectory()) walk(r);
      else h.update(r).update(fs.readFileSync(path.join(root, r)));
    }
  })('');
  return h.digest('hex');
}

test('migrate: the old db.json + packages/ become events + blobs; the old folder is only read; running it again changes nothing', async (t) => {
  const dir = fixture(t, 'mig-');
  const { old, tokenA, tokenB } = makeOldData(dir);
  const oldBefore = treeHash(old);
  const dataDir = path.join(dir, 'new');
  const env = { REGISTRY_DATA: dataDir };

  let r = await runAdmin(['migrate', '--from-db', old, '--dry-run'], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry run: \d+ events would be written/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'store', 'events')), 'a dry run writes nothing');

  r = await runAdmin(['migrate', '--from-db', old], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrated: \d+ event\(s\) appended \(0 were already there\), 4 package\(s\) written/);
  assert.equal(treeHash(old), oldBefore, 'the old directory is untouched');
  const storeDir = path.join(dataDir, 'store');
  const filesAfter = fileMap(storeDir);

  // idempotent
  r = await runAdmin(['migrate', '--from-db', old], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrated: 0 event\(s\) appended/);
  assert.match(r.out, /0 package\(s\) written, 4 already present/);
  assertOnlyAdded(filesAfter, fileMap(storeDir), 'second migrate');
  assert.equal(fileMap(storeDir).size, filesAfter.size);
  assert.equal((await runAdmin(['verify'], env)).code, 0);

  // what the registry then serves
  const s = await startRegistry({ dataDir });
  t.after(() => s.close());
  const alpha = (await call(s.url, '/api/apps/com.example.alpha')).json;
  assert.equal(alpha.latestVersion, '1.2.0');
  assert.deepEqual(alpha.versions.map((v) => [v.version, v.downloads, v.withdrawn && v.withdrawn.reason]), [['1.2.0', 8, null], ['1.1.0', 3, null], ['1.0.0', 4, 'Corrupts notes']]);
  assert.equal(alpha.versions[2].withdrawn.at, '2026-02-04T10:00:00.000Z');
  assert.equal(alpha.versions[2].publishedAt, '2026-02-01T10:01:00.000Z', 'original times are kept');
  assert.equal(alpha.downloads, 15);
  assert.equal(alpha.downloads30d, 8, 'the daily table moved over (the clock is 2026-03-01)');
  assert.deepEqual(alpha.publisher, { level: 'email', label: 'Verified email @acme.test', emailDomain: 'acme.test' });
  const beta = (await call(s.url, '/api/apps/com.example.beta')).json;
  assert.equal(beta.publisher.label, 'Verified: example.org');
  assert.equal(beta.downloads, 2);
  const dl = await call(s.url, '/api/apps/com.example.alpha/1.2.0/download');
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-vmapp-sha256'), JSON.parse(fs.readFileSync(path.join(old, 'db.json'), 'utf8')).apps['com.example.alpha'].versions['1.2.0'].sha256);
  // the owner tokens from the old registry still work
  const w2 = fixture(t, 'pkg-');
  const next = buildPackage(w2, 'n', { id: 'com.example.alpha', name: 'com.example.alpha', version: '1.3.0' });
  assert.equal((await publish(s.url, next.file, { token: tokenB })).status, 403);
  assert.equal((await publish(s.url, next.file, { token: tokenA })).status, 201);
  assert.equal((await call(s.url, '/api/publisher/me', { token: tokenA })).json.apps.length, 1);
  await s.close();

  // after the registry has written events of its own, the migration is still recognised as done
  r = await runAdmin(['migrate', '--from-db', old], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrated: 0 event\(s\) appended/);
});

test('migrate: an interrupted run is completed by the next one and gives the same state as an uninterrupted one', async (t) => {
  const dir = fixture(t, 'mig2-');
  const { old } = makeOldData(dir);
  const full = path.join(dir, 'full');
  assert.equal((await runAdmin(['migrate', '--from-db', old], { REGISTRY_DATA: full })).code, 0);
  const expected = (await fullReplay(path.join(full, 'store'))).state;

  const part = path.join(dir, 'part');
  const store = new LocalStore(path.join(part, 'store'));
  await store.init();
  const db = new Db();
  const real = new EventLog({ store, db, snapshotEvery: 0 });
  await real.load();
  let n = 0;
  const flaky = { seq: 0, db, append: async (...a) => { if (++n > 5) throw new Error('simulated crash'); return real.append(...a); } };
  Object.defineProperty(flaky, 'seq', { get: () => real.seq });
  await assert.rejects(admin.migrate({ fromDir: old, store, events: flaky }), /simulated crash/);
  assert.equal(real.seq, 5);
  const r = await runAdmin(['migrate', '--from-db', old], { REGISTRY_DATA: part });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\(5 were already there\)/);
  assert.equal((await fullReplay(path.join(part, 'store'))).state, expected);
});

test('migrate: refuses a target that holds other events, and old data with problems, writing nothing', async (t) => {
  const dir = fixture(t, 'mig3-');
  const { old, w } = makeOldData(dir);

  // a registry that already has its own history
  const dataDir = path.join(dir, 'busy');
  const s = await startRegistry({ dataDir });
  assert.equal((await publish(s.url, buildPackage(w, 'x', { id: 'com.example.other', name: 'Other' }).file)).status, 201);
  await s.close();
  const before = fileMap(s.storeDir);
  let r = await runAdmin(['migrate', '--from-db', old], { REGISTRY_DATA: dataDir });
  assert.equal(r.code, 1);
  assert.equal(fileMap(s.storeDir).size, before.size, 'nothing was written');

  // a package file missing, another one damaged
  const bad = path.join(dir, 'bad');
  fs.cpSync(old, bad, { recursive: true });
  fs.rmSync(path.join(bad, 'packages', 'com.example.alpha', '1.1.0.vmapp'));
  const f2 = path.join(bad, 'packages', 'com.example.alpha', '1.2.0.vmapp');
  const bytes = fs.readFileSync(f2);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(f2, bytes);
  const fresh = path.join(dir, 'fresh');
  const errs = [];
  const code = await adminCli.run(['migrate', '--from-db', bad], { REGISTRY_DATA: fresh }, () => {});
  void errs;
  assert.equal(code, 1);
  assert.ok(!fs.existsSync(path.join(fresh, 'store', 'events')) || fs.readdirSync(path.join(fresh, 'store', 'events')).length === 0, 'no events');
  assert.equal(listFiles(path.join(fresh, 'store')).length, 0, 'no blobs either');
  assert.equal((await runAdmin(['migrate'], { REGISTRY_DATA: fresh })).code, 2, 'needs --from-db');
  assert.equal((await runAdmin(['migrate', '--from-db', path.join(dir, 'nothing-here')], { REGISTRY_DATA: fresh })).code, 1);
});

// ------------------------------------------------------------------------------------------------ failing storage
test('if the log cannot be written the server stops accepting changes (503), keeps serving reads, and restarts cleanly', async (t) => {
  const dir = fixture(t, 'fail-');
  const dataDir = path.join(dir, 'data');
  const w = path.join(dir, 'pkgs');
  fs.mkdirSync(w);
  class Flaky extends LocalStore {
    constructor(root) {
      super(root);
      this.broken = false;
    }

    async put(key, data) {
      if (this.broken && key.startsWith('events/')) throw new Error('disk on fire');
      return super.put(key, data);
    }
  }
  const store = new Flaky(path.join(dataDir, 'store'));
  const faults = [];
  const logs = [];
  let s = await startRegistry({ dataDir, storage: store, onFault: (e) => faults.push(e.message), log: (m) => logs.push(m) });
  t.after(() => s.close().catch(() => {}));
  const a = buildPackage(w, 'a', { id: 'com.example.flk', name: 'Flk', version: '1.0.0' });
  const b = buildPackage(w, 'b', { id: 'com.example.flk', name: 'Flk', version: '1.1.0' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  const eventsBefore = listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length;

  store.broken = true;
  let r = await publish(s.url, b.file, { token });
  assert.equal(r.status, 503, r.text);
  assert.equal(r.json.error.code, 'storage_unavailable');
  assert.equal(faults.length, 1);
  assert.match(faults[0], /disk on fire/);
  store.broken = false; // even if the disk comes back, this process does not trust its memory any more
  r = await call(s.url, '/api/apps/com.example.flk/1.0.0/withdraw', { method: 'POST', token, json: { reason: 'x' } });
  assert.equal(r.status, 503);
  assert.equal(faults.length, 1, 'reported once');
  assert.equal((await call(s.url, '/api/apps/com.example.flk')).status, 200, 'reads still work');
  assert.equal((await call(s.url, '/api/apps/com.example.flk/1.0.0/download')).status, 200);
  assert.equal(listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length, eventsBefore, 'no half-written event');
  assert.ok(logs.some((l) => /FATAL/.test(l)));
  await s.close();

  // a restart rebuilds from the log: the failed publish never happened; the (unreferenced) blob is only garbage
  s = await startRegistry({ dataDir });
  assert.deepEqual((await call(s.url, '/api/apps/com.example.flk/versions')).json.map((v) => v.version), ['1.0.0']);
  assert.equal((await publish(s.url, b.file, { token })).status, 201, 'and publishing works again');
});

test('the shape of the store: layout, write-once blobs, content addressing', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.lay', name: 'Lay' });
  assert.equal((await publish(s.url, a.file)).status, 201);
  const sha = sha256(fs.readFileSync(a.file));
  assert.equal(blobKey(sha), `blobs/sha256/${sha.slice(0, 2)}/${sha}.vmapp`);
  assert.ok(fs.existsSync(s.reg.blobPath(sha)));
  assert.throws(() => blobKey('nope'), /not a sha256/);
  const store = s.reg.store;
  assert.throws(() => store.pathOf('../etc/passwd'), /invalid storage key/);
  assert.throws(() => store.pathOf('/etc/passwd'), /invalid storage key/);
  assert.throws(() => store.pathOf('events/../x'), /invalid storage key/);
  assert.deepEqual((await store.head('blobs/sha256/00/none.vmapp')), null);
  // no databases, no legacy folders
  const top = fs.readdirSync(s.storeDir).sort();
  assert.deepEqual(top.filter((n) => !n.startsWith('.')), ['blobs', 'events']);
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'db.json')) && !fs.existsSync(path.join(s.dataDir, 'packages')));
});
