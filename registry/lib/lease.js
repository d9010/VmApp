'use strict';
// The single-writer lease for the s3 backend: one small object, lease/writer.json, that the running server rewrites
// every few seconds. It is the ONLY object in the store that is ever overwritten, and it holds no data (just who is
// writing). A second server on the same bucket sees it being renewed and refuses to start.
//
//   start:   no lease, a released one, or one nobody has renewed for `ttlMs` -> take it. A lease that is being renewed
//            -> another writer is alive: refuse (waiting at most ttlMs, which covers a crashed predecessor on restart).
//   running: renew every `renewMs`; if the lease now names someone else, or renewals keep failing for more than 60% of the
//            ttl, this process stops writing (EventLog.guard throws, the registry exits).
//   stop:    write a released marker so that a restart does not have to wait.
//
// The lease detects an accidental second writer. It is not a fencing token: if two processes pass the start check in the
// same instant, the later write wins and the loser notices within `renewMs`, and the event log itself detects two
// events with one sequence number when it is replayed. Run one server per bucket.
// (The local backend uses the PID lock file in the data directory instead; see registry.js.)

const os = require('os');
const crypto = require('crypto');
const { LEASE_KEY } = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LeaseError extends Error {}

class S3Lease {
  /**
   * @param {object} store s3 store (get / putMutable)
   * @param {{ttlMs?: number, renewMs?: number, settleMs?: number, log?: Function, onLost?: (e: Error) => void, host?: string}} [o]
   */
  constructor(store, o = {}) {
    this.store = store;
    this.ttlMs = o.ttlMs || 60000;
    this.renewMs = o.renewMs || 15000;
    this.settleMs = o.settleMs === undefined ? Math.min(1000, this.renewMs) : o.settleMs;
    this.log = o.log || (() => {});
    this.onLost = o.onLost || (() => {});
    this.id = crypto.randomUUID();
    this.host = o.host || os.hostname();
    this.timer = null;
    this.held = false;
    this.lastRenewOk = 0;
    this.startedAt = null;
  }

  _record(extra) {
    return Buffer.from(JSON.stringify(Object.assign({
      id: this.id, host: this.host, pid: process.pid, startedAt: this.startedAt, renewedAt: new Date().toISOString(), ttlMs: this.ttlMs,
    }, extra)) + '\n');
  }

  async _read() {
    const buf = await this.store.get(LEASE_KEY);
    if (!buf) return null;
    try {
      const j = JSON.parse(buf.toString('utf8'));
      return j && typeof j === 'object' ? j : null;
    } catch {
      return null; // unreadable: as good as expired
    }
  }

  /** Takes the lease or throws LeaseError. */
  async acquire() {
    const begin = Date.now();
    let seen = null; // what we observed of a lease that looks alive: { renewedAt, since }
    for (;;) {
      const cur = await this._read();
      if (!cur || cur.releasedAt || cur.id === this.id) break;
      const ttl = Number(cur.ttlMs) > 0 ? Number(cur.ttlMs) : this.ttlMs;
      if (!seen || seen.renewedAt !== cur.renewedAt) {
        if (seen) throw new LeaseError(`another registry process is writing to this bucket (lease held by ${cur.host || 'unknown host'}, pid ${cur.pid}, since ${cur.startedAt}); a registry runs as one process only`);
        seen = { renewedAt: cur.renewedAt, since: Date.now() };
      } else if (Date.now() - seen.since > ttl) {
        this.log(`lease of ${cur.host} (pid ${cur.pid}) was not renewed for ${ttl} ms; taking it over`);
        break;
      }
      if (Date.now() - begin > ttl * 2 + 5000) throw new LeaseError('could not settle who holds the writer lease; try again');
      await sleep(Math.min(250, Math.max(20, this.renewMs / 2)));
    }
    this.startedAt = new Date().toISOString();
    await this.store.putMutable(LEASE_KEY, this._record());
    await sleep(this.settleMs);
    const after = await this._read();
    if (!after || after.id !== this.id) throw new LeaseError('another registry process took the writer lease at the same moment; a registry runs as one process only');
    this.held = true;
    this.lastRenewOk = Date.now();
    this.timer = setInterval(() => this._renew().catch(() => {}), this.renewMs);
    this.timer.unref();
  }

  async _renew() {
    if (!this.held) return;
    try {
      const cur = await this._read();
      if (cur && cur.id !== this.id) return this._lost(new LeaseError(`the writer lease now belongs to ${cur.host} (pid ${cur.pid}): another registry process is writing to this bucket`));
      await this.store.putMutable(LEASE_KEY, this._record());
      this.lastRenewOk = Date.now();
    } catch (e) {
      this.log(`lease renewal failed: ${e.message}`);
      if (Date.now() - this.lastRenewOk > this.ttlMs * 0.6) this._lost(new LeaseError(`the writer lease could not be renewed for ${Date.now() - this.lastRenewOk} ms`));
    }
  }

  _lost(err) {
    if (!this.held) return;
    this.held = false;
    clearInterval(this.timer);
    this.timer = null;
    this.log(`FATAL: ${err.message}`);
    this.onLost(err);
  }

  /** Throws unless this process may still write. Cheap: no network. */
  check() {
    if (!this.held) throw new LeaseError('this process no longer holds the writer lease');
    if (Date.now() - this.lastRenewOk > this.ttlMs * 0.8) throw new LeaseError('the writer lease has not been renewed in time; refusing to write');
  }

  /** Stops renewing and marks the lease released, so that a restart can take it at once. */
  async release() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    try {
      await this.store.putMutable(LEASE_KEY, this._record({ releasedAt: new Date().toISOString() }));
    } catch (e) {
      this.log(`could not mark the lease released (${e.message}); a restart will wait up to ${this.ttlMs} ms`);
    }
  }
}

module.exports = { S3Lease, LeaseError };
