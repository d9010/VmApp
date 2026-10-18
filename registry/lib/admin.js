'use strict';
// What `registry/admin.js` does: status, snapshot, verify, gc, export, migrate, hide / unhide. The command-line wrapper
// is registry/admin.js; everything is here so that the tests can call it directly.
//
// Read-only commands (status, snapshot, verify, export, gc without --confirm) are safe next to a running server: they
// only read, and a snapshot is a new write-once file. Commands that append events or delete objects (gc --confirm,
// migrate, hide, unhide) take the writer lock first, so they refuse to run while the server is up.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Db } = require('./db');
const { openStore } = require('./storage');
const { EventLog, EventLogError, mapLimit } = require('./eventlog');
const { validate, apply } = require('./state');
const { S3Lease } = require('./lease');
const { acquireLock } = require('./lock');
const { blobKey, parseEventKey, parseSnapshotKey, snapshotKey } = require('./store');
const { TarWriter } = require('./tar');
const { migrate } = require('./migrate');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const HOUR_MS = 3600 * 1000;

class AdminError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

/**
 * Opens the store and loads the state. With `write`, first takes the single-writer lock (the PID lock of the data
 * directory for a local store, the lease in the bucket for s3): that fails while the server runs.
 * @returns {Promise<{store, db, events, loaded, close: () => Promise<void>}>}
 */
async function openSession({ dataDir, storage, write = false, allowMissing = false, log = () => {}, now = Date.now, leaseTtlMs, leaseRenewMs }) {
  // allowMissing: a local store that does not exist yet reads as an empty one (a migration dry run), and nothing is created
  const readOnly = !write && (!storage || storage.type === 'local');
  const store = await openStore(storage, { dataDir, log, readOnly, allowMissing });
  let release = async () => {};
  try {
    if (write) {
      if (store.kind === 'local') {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        let unlock;
        try {
          unlock = acquireLock(dataDir);
        } catch (e) {
          throw new AdminError(`${e.message}. Stop the server first: this command changes the log.`, 2);
        }
        release = async () => unlock();
      } else {
        const lease = new S3Lease(store, { ttlMs: leaseTtlMs, renewMs: leaseRenewMs, log });
        try {
          await lease.acquire();
        } catch (e) {
          throw new AdminError(`${e.message}. Stop the server first: this command changes the log.`, 2);
        }
        release = () => lease.release();
      }
    }
    const db = new Db({ now });
    const events = new EventLog({ store, db, now, log, snapshotEvery: 0 });
    const loaded = await events.load();
    return {
      store, db, events, loaded,
      async close() {
        await release();
        if (store.close) store.close();
      },
    };
  } catch (e) {
    await release();
    if (store.close) store.close();
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ listing helpers
async function listKeys(store, prefix) {
  const out = [];
  for await (const o of store.list(prefix)) out.push(o);
  return out;
}

/** The objects under events/ with the sequence number in their name (null for a name that does not fit), in sequence order. */
async function readAllEvents(store) {
  const found = [];
  for await (const o of store.list('events/')) {
    const p = parseEventKey(o.key);
    if (p) found.push({ key: o.key, seq: p.seq, date: p.date });
    else found.push({ key: o.key, seq: null });
  }
  found.sort((a, b) => (a.seq || 0) - (b.seq || 0) || (a.key < b.key ? -1 : 1));
  return found;
}

// ------------------------------------------------------------------------------------------------ commands
async function status(session, out) {
  const { store, db, events } = session;
  const apps = db.allApps();
  const blobs = await listKeys(store, 'blobs/');
  const snaps = (await listKeys(store, 'snapshots/')).map((o) => parseSnapshotKey(o.key)).filter(Boolean).map((s) => s.seq).sort((a, b) => a - b);
  out(`storage:    ${store.describe()}`);
  out(`events:     ${events.seq} (last at ${events.lastTsMs ? new Date(events.lastTsMs).toISOString() : '-'})`);
  out(`snapshots:  ${snaps.length}${snaps.length ? `, newest at event ${snaps[snaps.length - 1]}` : ''}`);
  out(`apps:       ${apps.filter((a) => !a.hidden).length} (${apps.filter((a) => a.hidden).length} hidden)`);
  out(`versions:   ${apps.reduce((n, a) => n + Object.keys(a.versions).length, 0)}`);
  out(`publishers: ${db.publishers().length}`);
  out(`blobs:      ${blobs.length}, ${blobs.reduce((n, o) => n + o.size, 0)} bytes`);
  return 0;
}

async function snapshot(session, out) {
  const seq = await session.events.snapshot();
  out(seq ? `wrote ${snapshotKey(seq)}` : `no snapshot written: ${session.events.seq === 0 ? 'the log is empty' : `one for event ${session.events.seq} exists already`}`);
  return 0;
}

/**
 * Re-checks everything: every event file (well formed, contiguous from #1, replays cleanly), every snapshot (checksum, and
 * equal to the replay at its sequence number), every package blob an event refers to (present, and re-hashed unless
 * checkBlobs is false). Returns { ok, errors, warnings, stats }.
 */
async function verify({ store, checkBlobs = true, concurrency = 4, log = () => {} }) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const keys = await readAllEvents(store);
  const stats = { events: 0, snapshots: 0, blobsChecked: 0, blobBytes: 0, referencedBlobs: 0, unreferencedBlobs: 0, stagingObjects: 0 };

  // ---- the events
  const named = keys.filter((k) => k.seq !== null);
  for (const k of keys) if (k.seq === null) warnings.push(`unexpected object in events/: ${k.key}`);
  const loaded = await mapLimit(named, 16, async (k) => {
    try {
      const buf = await store.get(k.key);
      if (!buf) return { k, error: 'listed but cannot be read' };
      const ev = JSON.parse(buf.toString('utf8'));
      validate(ev);
      if (ev.seq !== k.seq) return { k, error: `holds event #${ev.seq}, but is named #${k.seq}` };
      if (ev.ts.slice(0, 10) !== k.date) warnings.push(`${k.key}: the folder date ${k.date} is not the event's date ${ev.ts.slice(0, 10)}`);
      return { k, ev };
    } catch (e) {
      return { k, error: e.message };
    }
  });
  const evs = [];
  for (const r of loaded) {
    if (r.error) err(`${r.k.key}: ${r.error}`);
    else evs.push(r.ev);
  }
  evs.sort((a, b) => a.seq - b.seq);
  stats.events = evs.length;

  // ---- snapshots, read first so the replay can compare as it passes each one
  const snapKeys = (await listKeys(store, 'snapshots/')).map((o) => ({ o, p: parseSnapshotKey(o.key) }));
  const snaps = new Map();
  for (const { o, p } of snapKeys) {
    if (!p) {
      warnings.push(`unexpected object in snapshots/: ${o.key}`);
      continue;
    }
    stats.snapshots++;
    try {
      const s = JSON.parse((await store.get(o.key)).toString('utf8'));
      if (s.seq !== p.seq) throw new Error(`holds seq ${s.seq}`);
      if (sha256(JSON.stringify(s.state)) !== s.stateSha256) throw new Error('its checksum does not match its state');
      snaps.set(p.seq, s);
    } catch (e) {
      err(`${o.key}: ${e.message}`);
    }
  }

  // ---- replay from nothing
  const db = new Db();
  const published = [];
  let expect = 1;
  let replayOk = true;
  for (const ev of evs) {
    if (ev.seq < expect) {
      err(`two events with sequence number ${ev.seq}`);
      replayOk = false;
      continue;
    }
    if (ev.seq > expect) {
      err(`events #${expect} to #${ev.seq - 1} are missing`);
      replayOk = false;
      break;
    }
    try {
      apply(db, ev);
    } catch (e) {
      err(`${e.message}`);
      replayOk = false;
      break;
    }
    if (ev.type === 'app.published') published.push(ev.data);
    const snap = snaps.get(ev.seq);
    if (snap && canonical(db.toState()) !== canonical(snap.state)) err(`snapshot ${ev.seq} differs from the state the events give`);
    expect++;
  }
  if (replayOk) for (const seq of snaps.keys()) if (seq > evs.length) err(`snapshot ${seq} is ahead of the last event (#${evs.length})`);
  for (const w of db.warnings) warnings.push(w);
  let lastTs = '';
  for (const ev of evs) {
    if (ev.ts < lastTs) warnings.push(`event #${ev.seq} is dated before the event before it`);
    lastTs = ev.ts;
  }

  // ---- blobs the log refers to
  const refs = new Map();
  for (const d of published) refs.set(d.sha256, d);
  stats.referencedBlobs = refs.size;
  const blobList = new Map((await listKeys(store, 'blobs/')).map((o) => [o.key, o]));
  const check = [...refs.values()];
  await mapLimit(check, concurrency, async (d) => {
    const key = blobKey(d.sha256);
    const have = blobList.get(key);
    if (!have) return err(`${d.id} ${d.version}: the package ${key} is missing`);
    if (have.size !== d.size) return err(`${d.id} ${d.version}: ${key} is ${have.size} bytes, the event says ${d.size}`);
    if (!checkBlobs) return undefined;
    const obj = await store.getStream(key);
    if (!obj) return err(`${key}: cannot be read`);
    const h = crypto.createHash('sha256');
    let n = 0;
    try {
      for await (const c of obj.stream) {
        h.update(c);
        n += c.length;
      }
    } catch (e) {
      return err(`${key}: reading failed (${e.message})`);
    }
    stats.blobsChecked++;
    stats.blobBytes += n;
    if (h.digest('hex') !== d.sha256) err(`${key}: its content does not hash to its name (damaged or replaced)`);
    return undefined;
  });
  stats.unreferencedBlobs = [...blobList.keys()].filter((k) => !refs.has(path.basename(k, '.vmapp'))).length;
  stats.stagingObjects = (await listKeys(store, 'staging/')).length;
  if (stats.unreferencedBlobs) warnings.push(`${stats.unreferencedBlobs} blob(s) are not referenced by any event (a publish that did not finish); admin.js gc lists them`);
  log('verify finished');
  return { ok: errors.length === 0, errors, warnings, stats };
}

/**
 * Lists the objects gc may delete: staging objects, and blobs no app.published event refers to, both at least
 * `minAgeHours` old. With `confirm` it deletes them (the writer lock is already held: the session is a writer) and
 * appends an admin.gc event per batch. Events and snapshots are never candidates, and referenced blobs never are, however
 * old, hidden or withdrawn the app.
 */
async function gc({ session, confirm = false, minAgeHours = 24, now = Date.now, out = () => {} }) {
  const { store, events } = session;
  const refs = new Set();
  for (const a of session.db.allApps()) for (const v of Object.values(a.versions)) refs.add(blobKey(v.sha256));
  const cutoff = now() - minAgeHours * HOUR_MS;
  const candidates = [];
  for (const o of await listKeys(store, 'blobs/')) if (!refs.has(o.key) && o.mtimeMs <= cutoff) candidates.push({ key: o.key, size: o.size, kind: 'blob' });
  for (const o of await listKeys(store, 'staging/')) if (o.mtimeMs <= cutoff) candidates.push({ key: o.key, size: o.size, kind: 'staging' });
  const bytes = candidates.reduce((n, c) => n + c.size, 0);
  out(`${candidates.length} object(s) can be deleted (${bytes} bytes): ${candidates.filter((c) => c.kind === 'blob').length} unreferenced blob(s), ${candidates.filter((c) => c.kind === 'staging').length} staging object(s), each at least ${minAgeHours} h old`);
  for (const c of candidates) out(`  ${c.kind === 'blob' ? 'unreferenced blob' : 'staging object   '} ${c.key} (${c.size} bytes)`);
  if (!confirm) {
    out('nothing was deleted: gc deletes only with --confirm');
    return { candidates, deleted: [], refused: true };
  }
  const deleted = [];
  for (let i = 0; i < candidates.length; i += 200) {
    const batch = candidates.slice(i, i + 200);
    const done = [];
    for (const c of batch) {
      if (await store.delete(c.key)) done.push(c.key);
    }
    deleted.push(...done);
    if (done.length) {
      await events.append('admin.gc', 'admin', { deleted: done, minAgeHours, kinds: [...new Set(batch.map((c) => c.kind))] });
      out(`deleted ${done.length} object(s); audit event #${events.seq} written`);
    }
  }
  if (!candidates.length) out('nothing to delete');
  return { candidates, deleted, refused: false };
}

/** Writes a tar of every event and snapshot (not the blobs) to `outFile`, which must not exist. */
async function exportTar({ store, outFile, out = () => {}, now = Date.now }) {
  const file = path.resolve(outFile);
  if (fs.existsSync(file)) throw new AdminError(`${file} exists already; export never overwrites a file`, 2);
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.closeSync(fd);
  const stream = fs.createWriteStream(file, { flags: 'w', mode: 0o600 });
  const tar = new TarWriter(stream);
  let n = 0;
  let last = 0;
  try {
    for (const prefix of ['events/', 'snapshots/']) {
      for (const o of await listKeys(store, prefix)) {
        const buf = await store.get(o.key);
        if (!buf) throw new AdminError(`${o.key} was listed but cannot be read`);
        await tar.add(o.key, buf, o.mtimeMs || now());
        n++;
        const p = parseEventKey(o.key);
        if (p) last = Math.max(last, p.seq);
      }
    }
    await tar.add('EXPORT.json', Buffer.from(JSON.stringify({ format: 1, createdAt: new Date(now()).toISOString(), files: n, lastSeq: last, note: 'events and snapshots of a D9010 VmApp registry; package blobs are not included (they are in the bucket)' }, null, 2) + '\n'), now());
    await tar.finish();
  } catch (e) {
    stream.destroy();
    throw e;
  }
  out(`wrote ${file}: ${n} files, last event #${last}. It contains publisher e-mail addresses: keep it private.`);
  return { file, files: n, lastSeq: last };
}

/**
 * Checks, against the real object store, the behaviours the registry's guarantees rest on: a second PUT of a key must not
 * replace the object, a server-side copy must refuse when the source changed, a presigned PUT must be bound to its size.
 * (Run it once on a new bucket, for example Cloudflare R2.) It leaves three tiny objects named staging/probe-*, which the
 * lifecycle rule or `gc` removes. Safe while the server runs. Returns { ok, results }.
 */
async function checkStorage({ store, out = () => {} }) {
  if (store.kind !== 's3') {
    out('the local store has nothing to probe: its writes are hard links, which fail if the name exists');
    return { ok: true, results: [] };
  }
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      out(`PASS  ${name}`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      out(`FAIL  ${name}: ${e.message}`);
    }
  };
  const id = crypto.randomUUID();
  const k1 = `staging/probe-${id}.vmapp`;
  const k2 = `staging/probe-${id}-copy.vmapp`;
  const k3 = `staging/probe-${id}-presigned.vmapp`;
  await check('an object that exists is not replaced by a second PUT (If-None-Match: *)', async () => {
    if (!(await store.put(k1, Buffer.from('one'))).created) throw new Error('the first PUT did not create the object');
    const second = await store.put(k1, Buffer.from('two'));
    const now = ((await store.get(k1)) || Buffer.alloc(0)).toString();
    if (second.created || now !== 'one') throw new Error('the object store REPLACED an existing object, so it ignores If-None-Match. Set S3_CONDITIONAL_PUT=0 (the registry then checks first) or use another store');
  });
  await check('the object can be read back, and found by a listing', async () => {
    const h = await store.head(k1);
    if (!h || h.size !== 3) throw new Error('head did not return the object');
    let found = false;
    for await (const o of store.list('staging/', { startAfter: 'staging/probe-' })) if (o.key === k1) found = true;
    if (!found) throw new Error('the listing (prefix + start-after) did not contain the object');
  });
  await check('a server-side copy is refused if the source is no longer the checked one (x-amz-copy-source-if-match)', async () => {
    const etag = (await store.head(k1)).etag;
    let refused = false;
    try {
      await store.copy(k1, k2, { ifMatch: '"00000000000000000000000000000000"' });
    } catch (e) {
      refused = e && e.status === 412;
      if (!refused) throw e;
    }
    if (!refused || (await store.head(k2))) throw new Error('the copy went through with a wrong ETag: a client could swap a verified upload for other bytes. Do not use this store for presigned publishing');
    await store.copy(k1, k2, { ifMatch: etag });
    if (((await store.get(k2)) || Buffer.alloc(0)).toString() !== 'one') throw new Error('the copy with the right ETag did not produce the object');
  });
  await check('a presigned PUT accepts exactly the announced size and no other', async () => {
    const p = store.presignPut(k3, { size: 5 });
    const wrong = await fetch(p.url, { method: 'PUT', body: Buffer.from('123456') });
    if (wrong.ok || (await store.head(k3))) throw new Error(`a body of the wrong size was accepted (HTTP ${wrong.status})`);
    const right = await fetch(p.url, { method: 'PUT', body: Buffer.from('12345') });
    if (!right.ok) throw new Error(`the right body was refused (HTTP ${right.status})`);
    const h = await store.head(k3);
    if (!h || h.size !== 5) throw new Error('the uploaded object is not there');
  });
  const ok = results.every((r) => r.ok);
  out(ok ? 'OK: the object store behaves as the registry needs (3 small objects named staging/probe-* remain; the lifecycle rule or gc removes them)' : 'NOT OK: see the failures above');
  return { ok, results };
}

async function hide(session, id, reason, out) {
  const app = session.db.getAppAny(id);
  if (!app) throw new AdminError(`there is no app ${id}`);
  if (app.hidden) throw new AdminError(`${id} is hidden already`);
  if (!reason) throw new AdminError('--reason is required', 2);
  const ev = await session.events.append('app.hidden', 'admin', { id, reason });
  out(`hid ${id} (event #${ev.seq}). Its versions and packages are untouched; \`admin.js unhide ${id}\` lifts it.`);
}

async function unhide(session, id, out) {
  const app = session.db.getAppAny(id);
  if (!app) throw new AdminError(`there is no app ${id}`);
  if (!app.hidden) throw new AdminError(`${id} is not hidden`);
  const ev = await session.events.append('app.unhidden', 'admin', { id });
  out(`${id} is visible again (event #${ev.seq})`);
}

module.exports = { openSession, status, snapshot, verify, gc, exportTar, checkStorage, hide, unhide, migrate, AdminError, EventLogError, canonical };
