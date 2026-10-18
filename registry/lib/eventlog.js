'use strict';
// The event log: the registry's source of truth. Every change is one new, immutable file in the store (see
// lib/state.js for what the events mean and lib/store.js for where they live). The state is replay(events); to start
// fast the server loads the newest snapshot and replays only what came after it.
//
// Single writer: sequence numbers are allocated here, by the one server process (the PID lock for a local store, the
// lease in the bucket for s3; lib/lease.js). If a write to the store fails for good, this process stops writing
// ("faulted"): its memory may no longer match the log, so the only safe way on is a restart, which rebuilds from the log.

const crypto = require('crypto');
const { eventKey, snapshotKey, parseEventKey, parseSnapshotKey } = require('./store');
const { validate, plan, apply, EventError } = require('./state');

const FORMAT = 1;
const LOAD_CONCURRENCY = 16;
const DAY_MS = 24 * 3600 * 1000;

class EventLogError extends Error {}
class StorageFault extends Error {
  constructor(message) {
    super(message);
    this.code = 'storage_fault';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Runs fn over items with at most n in flight; results keep the order of items. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

class EventLog {
  /**
   * @param {object} o
   * @param {object} o.store    lib/store.js or lib/s3.js store
   * @param {Db} o.db           the state this log feeds
   * @param {() => number} [o.now]
   * @param {Function} [o.log]
   * @param {number} [o.snapshotEvery] write a snapshot after this many events (default 500)
   * @param {() => void} [o.guard]     throws when this process may no longer write (lost lease)
   * @param {(err: Error) => void} [o.onFault]
   * @param {number} [o.writeRetries]  attempts per event write (default 2)
   */
  constructor(o) {
    this.store = o.store;
    this.db = o.db;
    this.now = o.now || Date.now;
    this.log = o.log || (() => {});
    this.snapshotEvery = o.snapshotEvery === undefined ? 500 : o.snapshotEvery;
    this.guard = o.guard || (() => {});
    this.onFault = o.onFault || (() => {});
    this.writeRetries = o.writeRetries || 2;
    this.seq = 0;
    this.lastTsMs = 0;
    this.snapshotSeq = 0;
    this.faulted = null;
    this.chain = Promise.resolve();
    this.snapshotting = null;
  }

  // ------------------------------------------------------------------------------------------ loading
  /** Rebuilds the state: newest usable snapshot, then every later event. Throws EventLogError if the log is damaged. */
  async load() {
    this.db.reset();
    this.seq = 0;
    this.lastTsMs = 0;
    this.snapshotSeq = 0;
    let base = null;
    const snaps = [];
    for await (const o of this.store.list('snapshots/')) {
      const p = parseSnapshotKey(o.key);
      if (p) snaps.push(p.seq);
    }
    snaps.sort((a, b) => b - a);
    for (const seq of snaps) {
      try {
        const buf = await this.store.get(snapshotKey(seq));
        if (!buf) continue;
        const s = JSON.parse(buf.toString('utf8'));
        if (s.format !== FORMAT || s.seq !== seq) throw new Error('unexpected format');
        if (sha256(JSON.stringify(s.state)) !== s.stateSha256) throw new Error('its checksum does not match');
        this.db.loadState(s.state);
        base = { seq, tsMs: Date.parse(s.ts) };
        break;
      } catch (e) {
        this.log(`snapshot ${seq} is not usable (${e.message}); trying an older one`);
        this.db.reset();
      }
    }
    if (base) {
      this.seq = base.seq;
      this.snapshotSeq = base.seq;
      this.lastTsMs = base.tsMs;
    }

    // events after the snapshot. Event time never goes backwards, so a day of margin before the snapshot's time is enough.
    const startAfter = base ? `events/${new Date(base.tsMs - DAY_MS).toISOString().slice(0, 10).replace(/-/g, '/')}/` : '';
    const found = [];
    for await (const o of this.store.list('events/', { startAfter })) {
      const p = parseEventKey(o.key);
      if (!p) {
        this.log(`ignoring unexpected object ${o.key}`);
        continue;
      }
      if (p.seq > this.seq) found.push({ key: o.key, seq: p.seq });
    }
    found.sort((a, b) => a.seq - b.seq || (a.key < b.key ? -1 : 1));
    const events = await mapLimit(found, LOAD_CONCURRENCY, async (f) => {
      const buf = await this.store.get(f.key);
      if (!buf) throw new EventLogError(`${f.key} was listed but cannot be read`);
      let ev;
      try {
        ev = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        throw new EventLogError(`${f.key} is not valid JSON (${e.message})`);
      }
      try {
        validate(ev);
      } catch (e) {
        throw new EventLogError(`${f.key}: ${e.message}`);
      }
      if (ev.seq !== f.seq) throw new EventLogError(`${f.key} holds event #${ev.seq}, but its name says #${f.seq}`);
      return ev;
    });
    let expect = this.seq + 1;
    for (const ev of events) {
      if (ev.seq < expect) throw new EventLogError(`two events with sequence number ${ev.seq} (${found.filter((f) => f.seq === ev.seq).map((f) => f.key).join(', ')}): another process wrote to this registry, or a write was repeated. Resolve it by hand before starting.`);
      if (ev.seq > expect) throw new EventLogError(`events #${expect} to #${ev.seq - 1} are missing from the log; refusing to start with a gap. Restore them from a backup.`);
      try {
        apply(this.db, ev);
      } catch (e) {
        throw new EventLogError(`${e.message}. The log is inconsistent; refusing to start.`);
      }
      this.seq = ev.seq;
      this.lastTsMs = Math.max(this.lastTsMs, Date.parse(ev.ts));
      expect++;
    }
    return { seq: this.seq, snapshotSeq: this.snapshotSeq, replayed: events.length };
  }

  // ------------------------------------------------------------------------------------------ appending
  /**
   * Appends one event and applies it to the state, one at a time. The event is checked against the state first
   * (nothing is written if it would be rejected on replay), then written durably, then applied.
   * @param {string} type
   * @param {string} actor publisher id, "system" or "admin"
   * @param {object} data
   * @param {{after?: (ev: object) => void, tsMs?: number}} [opts] after: runs synchronously right after the event is
   *   applied; tsMs: the event's time instead of now (the migration keeps the original times; never earlier than the last event)
   * @returns {Promise<object>} the event
   */
  append(type, actor, data, opts = {}) {
    const run = this.chain.then(() => this._append(type, actor, data, opts));
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async _append(type, actor, data, opts) {
    if (this.faulted) throw this.faulted;
    try {
      this.guard();
    } catch (e) {
      throw this.fault(e.message);
    }
    const seq = this.seq + 1;
    const tsMs = Math.max(opts.tsMs === undefined ? this.now() : opts.tsMs, this.lastTsMs); // time never goes backwards
    const ev = { seq, ts: new Date(tsMs).toISOString(), type, actor, data };
    validate(ev);
    const commit = plan(this.db, ev); // throws EventError (before anything is written) if the event does not fit
    const key = eventKey(seq, tsMs, crypto.randomBytes(6).toString('hex'));
    const body = Buffer.from(JSON.stringify(ev) + '\n');
    await this._writeDurably(key, body);
    this.seq = seq;
    this.lastTsMs = tsMs;
    commit();
    if (opts.after) opts.after(ev);
    if (this.snapshotEvery > 0 && this.seq - this.snapshotSeq >= this.snapshotEvery) this._snapshotSoon();
    return ev;
  }

  async _writeDurably(key, body) {
    let last = null;
    for (let attempt = 0; attempt < this.writeRetries; attempt++) {
      if (attempt > 0) await sleep(150 * attempt);
      try {
        const r = await this.store.put(key, body);
        if (r.created) return;
        // it exists already: an earlier attempt of ours may have landed although it reported an error
        const back = await this.store.get(key);
        if (back && Buffer.compare(back, body) === 0) return;
        throw new Error(`${key} already exists with different content`);
      } catch (e) {
        last = e;
      }
    }
    throw this.fault(`cannot write ${key} to the store: ${last && last.message}`);
  }

  /** Stops this process from writing (once): its memory may no longer match the log. Returns the StorageFault. */
  fault(message) {
    if (!this.faulted) {
      this.faulted = new StorageFault(`the event log cannot be written (${message}); this process stops accepting changes and must be restarted`);
      this.log(`FATAL: ${this.faulted.message}`);
      try {
        this.onFault(this.faulted);
      } catch {
        /* the callback must not break the request that found the fault */
      }
    }
    return this.faulted;
  }

  // ------------------------------------------------------------------------------------------ snapshots
  /**
   * Writes snapshots/<seq>.json for the current state, unless one for this sequence number exists. Always a new file;
   * existing snapshots are never touched. Returns the sequence number written, or null.
   */
  async snapshot() {
    if (this.seq === 0 || this.seq === this.snapshotSeq) return null;
    // everything below runs in one tick before the first await: the state and the sequence number belong together
    const seq = this.seq;
    const ts = new Date(this.lastTsMs).toISOString();
    const stateJson = JSON.stringify(this.db.toState());
    const text = `{"format":${FORMAT},"seq":${seq},"ts":${JSON.stringify(ts)},"createdAt":${JSON.stringify(new Date(this.now()).toISOString())},"stateSha256":"${sha256(stateJson)}","state":${stateJson}}\n`;
    await this.store.put(snapshotKey(seq), Buffer.from(text));
    this.snapshotSeq = Math.max(this.snapshotSeq, seq);
    this.log(`snapshot ${seq} written`);
    return seq;
  }

  _snapshotSoon() {
    if (this.snapshotting) return;
    this.snapshotting = this.snapshot().catch((e) => this.log(`snapshot failed (will retry): ${e.message}`)).finally(() => {
      this.snapshotting = null;
    });
  }

  /** Waits for appends in flight and a snapshot in progress. */
  async idle() {
    await this.chain;
    if (this.snapshotting) await this.snapshotting;
  }
}

module.exports = { EventLog, EventLogError, StorageFault, EventError, mapLimit, FORMAT };
