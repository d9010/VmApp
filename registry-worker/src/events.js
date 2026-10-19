// The registry's durable state: the append-only event log and the pending download counters, in the Durable Object's SQLite.
// The state itself (apps, versions, publishers) is always replay(events) through registry/lib/state.js, exactly as in the
// Node registry: this file only replaces where the events are kept (a SQL table instead of one file per event in a bucket).
//
// A Durable Object runs one request at a time per object and its SQL writes are atomic, so there is no writer lease and no
// two writers: that is what the Node registry needed S3 conditional writes and a lease file for.

import { validate, plan, apply } from '../../registry/lib/state.js';
import { hourKey } from '../../registry/lib/db.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY,
     ts TEXT NOT NULL,
     type TEXT NOT NULL,
     actor TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  // download counts not yet folded into a counters.downloads event: kept here so an evicted object loses none
  `CREATE TABLE IF NOT EXISTS counters (
     app TEXT NOT NULL,
     version TEXT NOT NULL,
     hour TEXT NOT NULL,
     n INTEGER NOT NULL,
     PRIMARY KEY (app, version, hour)
   )`,
  // uploads waiting for POST /api/publish/complete
  `CREATE TABLE IF NOT EXISTS uploads (
     id TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     key TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     completes INTEGER NOT NULL DEFAULT 0,
     uploaded INTEGER NOT NULL DEFAULT 0
   )`,
  // an upload larger than one request can carry goes to R2 as a multipart upload: the client sends it in parts (PUT ...?part=N)
  // and `complete` assembles them. `mp_id` is R2's id of the multipart upload; the parts are kept here as {number, etag}.
  `CREATE TABLE IF NOT EXISTS multiparts (
     upload_id TEXT PRIMARY KEY,
     mp_id TEXT NOT NULL,
     part_size INTEGER NOT NULL,
     count INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS mp_parts (
     upload_id TEXT NOT NULL,
     n INTEGER NOT NULL,
     etag TEXT NOT NULL,
     PRIMARY KEY (upload_id, n)
   )`,
];

export class SqlStore {
  /** @param {SqlStorage} sql  @param {import('../../registry/lib/db.js').Db} db  @param {() => number} now */
  constructor(sql, db, now = Date.now) {
    this.sql = sql;
    this.db = db;
    this.now = now;
    this.seq = 0;
    this.lastTsMs = 0;
  }

  /** Creates the tables, replays the log into `db`, and restores the pending download counters. Throws if the log is damaged. */
  load() {
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    for (const row of this.sql.exec('SELECT seq, ts, type, actor, data FROM events ORDER BY seq')) {
      if (row.seq !== this.seq + 1) throw new Error(`the event log has a gap: #${row.seq} follows #${this.seq}`);
      const ev = { seq: row.seq, ts: row.ts, type: row.type, actor: row.actor, data: JSON.parse(row.data) };
      validate(ev);
      apply(this.db, ev);
      this.seq = ev.seq;
      this.lastTsMs = Date.parse(ev.ts);
    }
    for (const row of this.sql.exec('SELECT app, version, hour, n FROM counters')) {
      const it = { id: row.app, version: row.version, hour: row.hour, n: row.n };
      this.db.pendingMap.set(`${it.id}|${it.version}|${it.hour}`, it);
      this.db._bump(it, it.n);
    }
  }

  /** Appends one event: validated and checked against the state BEFORE it is written, so a log that cannot be replayed is never made. */
  append(type, actor, data, opts = {}) {
    const seq = this.seq + 1;
    const tsMs = Math.max(opts.tsMs === undefined ? this.now() : opts.tsMs, this.lastTsMs); // time never goes backwards
    const ev = { seq, ts: new Date(tsMs).toISOString(), type, actor, data };
    validate(ev);
    const commit = plan(this.db, ev); // throws EventError when the event does not fit the state
    this.sql.exec('INSERT INTO events (seq, ts, type, actor, data) VALUES (?, ?, ?, ?, ?)', seq, ev.ts, type, actor, JSON.stringify(data));
    this.seq = seq;
    this.lastTsMs = tsMs;
    commit();
    return ev;
  }

  /** Counts one download: in memory (for the ranking) and in the table (so it survives an eviction). */
  addDownload(app, version) {
    this.db.addDownload(app, version);
    this.sql.exec(
      'INSERT INTO counters (app, version, hour, n) VALUES (?, ?, ?, 1) ON CONFLICT (app, version, hour) DO UPDATE SET n = n + 1',
      app.id, version, hourKey(this.now()),
    );
  }

  /** Folds the pending counters into one counters.downloads event. Returns the event, or null when there was nothing to write. */
  flushCounters(tx) {
    const items = this.db.pendingItems();
    if (!items.length) return null;
    let ev;
    tx(() => {
      ev = this.append('counters.downloads', 'system', { items });
      this.db.settle(items);
      for (const it of items) {
        this.sql.exec('UPDATE counters SET n = n - ? WHERE app = ? AND version = ? AND hour = ?', it.n, it.id, it.version, it.hour);
      }
      this.sql.exec('DELETE FROM counters WHERE n <= 0');
    });
    return ev;
  }

  // ---- uploads ----
  putUpload(u) {
    this.sql.exec('INSERT INTO uploads (id, size, sha256, key, expires_at) VALUES (?, ?, ?, ?, ?)', u.id, u.size, u.sha256, u.key, u.expiresAt);
  }

  getUpload(id) {
    const rows = [...this.sql.exec('SELECT id, size, sha256, key, expires_at AS expiresAt, completes, uploaded FROM uploads WHERE id = ?', id)];
    return rows[0] || null;
  }

  markUploaded(id) {
    this.sql.exec('UPDATE uploads SET uploaded = 1 WHERE id = ?', id);
  }

  bumpCompletes(id) {
    this.sql.exec('UPDATE uploads SET completes = completes + 1 WHERE id = ?', id);
  }

  deleteUpload(id) {
    this.sql.exec('DELETE FROM uploads WHERE id = ?', id);
    this.sql.exec('DELETE FROM multiparts WHERE upload_id = ?', id);
    this.sql.exec('DELETE FROM mp_parts WHERE upload_id = ?', id);
  }

  countUploads() {
    return [...this.sql.exec('SELECT COUNT(*) AS n FROM uploads')][0].n;
  }

  /**
   * Removes the rows of expired uploads and returns what the caller must clean up in R2: `{key, mpId}` for each, the staging
   * object's key and, for a multipart upload, R2's id of it (null otherwise).
   */
  expireUploads(nowMs) {
    const rows = [...this.sql.exec('SELECT u.id AS id, u.key AS key, m.mp_id AS mpId FROM uploads u LEFT JOIN multiparts m ON m.upload_id = u.id WHERE u.expires_at < ?', nowMs)];
    for (const r of rows) this.deleteUpload(r.id);
    return rows.map((r) => ({ key: r.key, mpId: r.mpId || null }));
  }

  // ---- multipart uploads ----
  putMultipart(uploadId, mpId, partSize, count) {
    this.sql.exec('INSERT INTO multiparts (upload_id, mp_id, part_size, count) VALUES (?, ?, ?, ?)', uploadId, mpId, partSize, count);
  }

  /** {mpId, partSize, count} of a multipart upload, or null for a single-request upload. */
  getMultipart(uploadId) {
    const rows = [...this.sql.exec('SELECT mp_id AS mpId, part_size AS partSize, count FROM multiparts WHERE upload_id = ?', uploadId)];
    return rows[0] || null;
  }

  /** Remembers a part (a part sent again replaces the earlier one). */
  putPart(uploadId, n, etag) {
    this.sql.exec('INSERT OR REPLACE INTO mp_parts (upload_id, n, etag) VALUES (?, ?, ?)', uploadId, n, etag);
  }

  /** The parts received so far, in order, as R2 wants them for `complete`: [{partNumber, etag}]. */
  getParts(uploadId) {
    return [...this.sql.exec('SELECT n AS partNumber, etag FROM mp_parts WHERE upload_id = ? ORDER BY n', uploadId)];
  }
}
