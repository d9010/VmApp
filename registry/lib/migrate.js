'use strict';
// `admin.js migrate --from-db DIR`: converts the registry's previous storage (DIR/db.json plus DIR/packages/<id>/<version>.vmapp)
// into the event log and blobs. It only reads DIR and never deletes or changes anything there.
//
// The old database becomes this event list, in time order (the original times are kept as event times):
//   publisher.created, publisher.verified (email, domain), app.published (one per version), version.withdrawn,
//   and one counters.downloads per app (totals and the last-40-days table).
// Every migrated event carries data.migrated = { from: <SHA-256 of db.json> }.
//
// Idempotent: the same events are always planned from the same db.json. If the target already starts with exactly those
// events, nothing is appended; if only a prefix of them is there (an interrupted run), the rest is appended. A target that
// holds anything else is refused. Blobs are write-once, so writing one that exists is a no-op.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../../hostlib/package');
const { compareVersions } = require('../../hostlib/manifest');
const { blobKey, parseEventKey } = require('./store');
const { validate } = require('./state');

class MigrationError extends Error {}

const RANK = { 'publisher.created': 0, 'publisher.verified': 1, 'app.published': 2, 'version.withdrawn': 3, 'counters.downloads': 4 };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const validWithdrawn = (w) => !!(w && typeof w === 'object' && typeof w.reason === 'string' && w.reason.trim() && w.reason.length <= 400 && Number.isFinite(w.at));
const str = (v) => (typeof v === 'string' ? v : '');

/** Reads the old database. Returns { db, dbSha256 }. */
function readOld(fromDir) {
  const file = path.join(fromDir, 'db.json');
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    throw new MigrationError(`cannot read ${file}: ${e.message}`);
  }
  let db;
  try {
    db = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new MigrationError(`${file} is not valid JSON (${e.message})`);
  }
  if (!db || db.schema !== 1 || typeof db.apps !== 'object' || db.apps === null) throw new MigrationError(`${file} is not a registry database (schema 1)`);
  return { db, dbSha256: sha256(raw) };
}

/** The counters of one app as counters.downloads items: version totals plus the daily table, spread so that both add up. */
function counterItems(app, versionsAsc) {
  const items = [];
  const remaining = new Map(versionsAsc.map((v) => [v.version, Math.max(0, Math.floor(v.downloads || 0))]));
  const latest = versionsAsc.length ? versionsAsc[versionsAsc.length - 1].version : null;
  if (!latest) return items;
  const desc = [...versionsAsc].reverse();
  for (const [day, nRaw] of Object.entries(app.daily || {}).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    let left = Math.max(0, Math.floor(nRaw));
    for (const v of desc) {
      if (left <= 0) break;
      const have = remaining.get(v.version);
      const take = Math.min(left, have);
      if (take > 0) {
        items.push({ id: app.id, version: v.version, hour: `${day}T00`, n: take });
        remaining.set(v.version, have - take);
        left -= take;
      }
    }
    if (left > 0) items.push({ id: app.id, version: latest, hour: `${day}T00`, n: left }); // the table says more than the version totals
  }
  // what is left of each version's total happened before the table starts (the table keeps 40 days): the epoch bucket
  for (const v of versionsAsc) {
    const rest = remaining.get(v.version);
    if (rest > 0) items.push({ id: app.id, version: v.version, hour: '1970-01-01T00', n: rest });
  }
  const sum = items.reduce((a, b) => a + b.n, 0);
  const total = Math.max(0, Math.floor(app.downloads || 0));
  if (total > sum) items.push({ id: app.id, version: latest, hour: '1970-01-01T00', n: total - sum });
  return items;
}

/**
 * What the old data turns into, without touching any store.
 * @returns {{events: object[], blobs: object[], dbSha256: string, problems: string[], notes: string[]}}
 */
function planMigration(fromDir) {
  const { db, dbSha256 } = readOld(fromDir);
  const problems = [];
  const notes = [];
  const timeline = []; // { tsMs, rank, order, type, actor, data }
  const blobs = [];
  const mark = { from: dbSha256 };
  let order = 0;
  let maxMs = 0;
  const push = (tsMs, type, actor, data) => {
    maxMs = Math.max(maxMs, tsMs);
    timeline.push({ tsMs, rank: RANK[type], order: order++, type, actor, data: Object.assign({}, data, { migrated: mark }) });
  };

  for (const p of Object.values(db.publishers || {}).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    push(p.createdAt, 'publisher.created', p.id, { id: p.id, tokenHash: p.tokenHash, name: str(p.name), company: str(p.company), email: str(p.email), url: str(p.url) });
    if (p.emailVerified && typeof p.emailVerified.email === 'string' && Number.isFinite(p.emailVerified.at)) {
      push(p.emailVerified.at, 'publisher.verified', p.id, { id: p.id, kind: 'email', email: p.emailVerified.email });
    }
    if (p.domain && typeof p.domain.name === 'string' && Number.isFinite(p.domain.at)) {
      push(p.domain.at, 'publisher.verified', p.id, { id: p.id, kind: 'domain', name: p.domain.name, method: p.domain.method === 'dns' ? 'dns' : 'file' });
    }
  }
  for (const app of Object.values(db.apps).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const versions = Object.values(app.versions || {}).sort((a, b) => compareVersions(a.version, b.version));
    for (const v of versions) {
      const file = path.join(fromDir, 'packages', app.id, `${v.version}.vmapp`);
      let meta = v.meta;
      if (!fs.existsSync(file)) {
        problems.push(`${app.id} ${v.version}: the package file is missing (${file})`);
        continue;
      }
      let info = null;
      try {
        const bytes = fs.readFileSync(file);
        if (bytes.length !== v.size) problems.push(`${app.id} ${v.version}: the file is ${bytes.length} bytes, the database says ${v.size}`);
        if (sha256(bytes) !== v.sha256) problems.push(`${app.id} ${v.version}: the file's SHA-256 differs from the database's`);
        info = pkg.verify(file);
        if (info.packageId !== v.packageId) problems.push(`${app.id} ${v.version}: the package id of the file differs from the database's`);
        if (info.manifest.id !== app.id || info.manifest.version !== v.version) problems.push(`${app.id} ${v.version}: the file is ${info.manifest.id} ${info.manifest.version}`);
      } catch (e) {
        problems.push(`${app.id} ${v.version}: the package does not verify (${e.message})`);
        continue;
      }
      if (!meta || !meta.manifest || !meta.files) {
        const stripped = Object.assign({}, info.manifest);
        delete stripped.files;
        meta = { manifest: stripped, files: { count: Object.keys(info.manifest.files).length, uiBytes: info.uiBytes, coreBytes: info.coreBytes, hasIcon: info.hasIcon } };
        notes.push(`${app.id} ${v.version}: summary rebuilt from the package`);
      }
      blobs.push({ id: app.id, version: v.version, file, sha256: v.sha256, size: v.size });
      push(v.publishedAt, 'app.published', app.publisherId, {
        id: app.id, version: v.version, sha256: v.sha256, size: v.size, packageId: v.packageId, publisherId: app.publisherId, meta,
      });
      if (v.withdrawn !== undefined) {
        if (validWithdrawn(v.withdrawn)) push(v.withdrawn.at, 'version.withdrawn', app.publisherId, { id: app.id, version: v.version, reason: v.withdrawn.reason });
        else notes.push(`${app.id} ${v.version}: a malformed withdrawn mark was dropped (as the old server did)`);
      }
    }
  }
  const countersMs = maxMs + 1;
  for (const app of Object.values(db.apps).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const versions = Object.values(app.versions || {}).sort((a, b) => compareVersions(a.version, b.version));
    const items = counterItems(app, versions);
    if (items.length) push(countersMs, 'counters.downloads', 'system', { items });
  }

  timeline.sort((a, b) => a.tsMs - b.tsMs || a.rank - b.rank || a.order - b.order);
  const events = timeline.map((t) => ({ tsMs: t.tsMs, type: t.type, actor: t.actor, data: t.data }));
  events.forEach((e, i) => {
    try {
      validate({ seq: i + 1, ts: new Date(e.tsMs).toISOString(), type: e.type, actor: e.actor, data: e.data });
    } catch (err) {
      problems.push(err.message);
    }
  });
  return { events, blobs, dbSha256, problems, notes, old: db };
}

/** The first `n` events of the target store, oldest first: [{seq, ts, type, actor, data}]. */
async function readFirstEvents(store, n) {
  const found = [];
  for await (const o of store.list('events/')) {
    const p = parseEventKey(o.key);
    if (p) found.push({ key: o.key, seq: p.seq });
  }
  found.sort((a, b) => a.seq - b.seq);
  const out = [];
  for (const f of found.slice(0, n)) out.push(JSON.parse((await store.get(f.key)).toString('utf8')));
  return out;
}

/**
 * Runs the migration into an open, writable event log.
 * @param {{fromDir: string, store: object, events: import('./eventlog').EventLog, dryRun?: boolean, log?: Function}} o
 */
async function migrate({ fromDir, store, events, dryRun = false, log = () => {} }) {
  const plan = planMigration(path.resolve(fromDir));
  for (const n of plan.notes) log(`note: ${n}`);
  if (plan.problems.length) throw new MigrationError(`the old data has problems; nothing was written:\n  - ${plan.problems.join('\n  - ')}`);
  const exp = plan.events;
  const same = (a, b) => a.type === b.type && a.actor === b.actor && Date.parse(a.ts) === b.tsMs && canonical(a.data) === canonical(b.data);

  // what is in the target must be a prefix of the plan
  const have = await readFirstEvents(store, exp.length);
  for (let i = 0; i < have.length; i++) {
    if (!same(have[i], exp[i])) {
      throw new MigrationError(`the target already holds events that are not this migration (event #${i + 1} differs). Migrate into an empty store; nothing was written.`);
    }
  }
  const result = { events: exp.length, alreadyThere: have.length, appended: 0, blobsWritten: 0, blobsPresent: 0, dryRun };
  if (dryRun) return result;

  for (const b of plan.blobs) {
    const r = await store.putFile(blobKey(b.sha256), b.file, { sha256: b.sha256, size: b.size });
    if (r.created) result.blobsWritten++;
    else result.blobsPresent++;
  }
  for (let i = have.length; i < exp.length; i++) {
    await events.append(exp[i].type, exp[i].actor, exp[i].data, { tsMs: exp[i].tsMs });
    result.appended++;
  }
  // the new state must say what the old database said (checked right after writing; later activity would show as differences)
  if (result.appended > 0) {
    const problems = compareWithOld(events.db, plan.old);
    if (problems.length) throw new MigrationError(`the migrated state differs from the old database:\n  - ${problems.join('\n  - ')}`);
  }
  return result;
}

/** Differences between a migrated Db and the old database JSON: publishers, versions, withdrawals and download counters. */
function compareWithOld(db, old) {
  const out = [];
  for (const p of Object.values(old.publishers || {})) {
    const n = db.getPublisher(p.id);
    if (!n) out.push(`publisher ${p.id} is missing`);
    else if (n.tokenHash !== p.tokenHash || n.createdAt !== p.createdAt) out.push(`publisher ${p.id} differs`);
  }
  for (const a of Object.values(old.apps)) {
    const n = db.getAppAny(a.id);
    if (!n) {
      out.push(`app ${a.id} is missing`);
      continue;
    }
    if (n.publisherId !== a.publisherId || n.createdAt !== a.createdAt || n.updatedAt !== a.updatedAt || n.latest !== a.latest) out.push(`app ${a.id} differs`);
    if ((n.downloads || 0) !== (a.downloads || 0)) out.push(`app ${a.id}: downloads ${n.downloads} instead of ${a.downloads}`);
    for (const [day, c] of Object.entries(a.daily || {})) if ((n.daily[day] || 0) !== c) out.push(`app ${a.id}: ${day} has ${n.daily[day] || 0} downloads instead of ${c}`);
    for (const v of Object.values(a.versions)) {
      const m = n.versions[v.version];
      if (!m) out.push(`${a.id} ${v.version} is missing`);
      else if (m.sha256 !== v.sha256 || m.size !== v.size || m.packageId !== v.packageId || m.publishedAt !== v.publishedAt) out.push(`${a.id} ${v.version} differs`);
      else {
        if ((m.downloads || 0) !== (v.downloads || 0)) out.push(`${a.id} ${v.version}: downloads ${m.downloads} instead of ${v.downloads}`);
        const wasW = validWithdrawn(v.withdrawn);
        if (wasW !== !!m.withdrawn || (wasW && (m.withdrawn.reason !== v.withdrawn.reason || m.withdrawn.at !== v.withdrawn.at))) out.push(`${a.id} ${v.version}: the withdrawn mark differs`);
      }
    }
  }
  return out;
}

module.exports = { migrate, planMigration, compareWithOld, MigrationError, canonical };
