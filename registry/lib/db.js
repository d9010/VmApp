'use strict';
// The registry's state in memory: apps, versions, publishers and download counters. It is NOT a store: nothing here is
// written anywhere. The state is always replay(event log) (lib/state.js applies the events, lib/eventlog.js loads
// and appends them), plus the downloads that have not been written to the log yet (`pending`, see addDownload).
//
// It never holds IP addresses or owner tokens (only the SHA-256 of a token).

const DAY_MS = 24 * 3600 * 1000;
const SCHEMA = 1;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** UTC day key such as "2026-10-15". */
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC hour key such as "2026-10-15T09" (the bucket of a counters.downloads event). */
function hourKey(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

class Db {
  /** @param {{now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.reset();
  }

  reset() {
    this.data = { schema: SCHEMA, apps: {}, publishers: {} };
    this.tokenIndex = new Map();
    this.pendingMap = new Map(); // "<id>|<version>|<hour>" -> { id, version, hour, n }: counted, not yet in the log
    this.pendingByApp = new Map(); // id -> { total, byVersion: Map, byDay: Map }
    this.warnings = [];
  }

  /** Replaces the state with a snapshot's state (the shape toState() returns). */
  loadState(state) {
    if (!state || typeof state !== 'object' || state.schema !== SCHEMA || typeof state.apps !== 'object' || typeof state.publishers !== 'object') {
      throw new Error('unknown state format');
    }
    this.reset();
    this.data = state;
    for (const p of Object.values(this.data.publishers)) {
      p.pending = {}; // verification codes live in memory only
      this.tokenIndex.set(p.tokenHash, p.id);
    }
  }

  /** The persistent state, as written to snapshots: no pending counters, no verification codes. */
  toState() {
    return JSON.parse(JSON.stringify(this.data, (k, v) => (k === 'pending' ? undefined : v)));
  }

  // ---- publishers: one record per owner token; a publisher may own several app ids ----
  getPublisher(id) {
    return id && hasOwn(this.data.publishers, id) ? this.data.publishers[id] : null;
  }

  putPublisher(p) {
    this.data.publishers[p.id] = p;
    this.tokenIndex.set(p.tokenHash, p.id);
  }

  /** The publisher whose owner token has this SHA-256, or null. */
  publisherByTokenHash(hash) {
    return this.getPublisher(this.tokenIndex.get(hash));
  }

  publishers() {
    return Object.values(this.data.publishers);
  }

  // ---- apps. A hidden app (an admin tombstone) keeps all its data but is invisible: getApp/apps skip it ----
  /** The app, or null when it does not exist or is hidden. */
  getApp(id) {
    const a = this.getAppAny(id);
    return a && !a.hidden ? a : null;
  }

  /** The app including hidden ones (publishing must know that an id is taken). */
  getAppAny(id) {
    return hasOwn(this.data.apps, id) ? this.data.apps[id] : null;
  }

  putApp(app) {
    this.data.apps[app.id] = app;
  }

  /** Visible apps. */
  apps() {
    return Object.values(this.data.apps).filter((a) => !a.hidden);
  }

  allApps() {
    return Object.values(this.data.apps);
  }

  // ---- downloads: what the log says, plus what is still waiting to be written ----
  appDownloads(app) {
    const p = this.pendingByApp.get(app.id);
    return (app.downloads || 0) + (p ? p.total : 0);
  }

  versionDownloads(app, version) {
    const p = this.pendingByApp.get(app.id);
    const rec = hasOwn(app.versions, version) ? app.versions[version] : null;
    return ((rec && rec.downloads) || 0) + (p ? p.byVersion.get(version) || 0 : 0);
  }

  /** Downloads in the last 30 UTC days (today included). */
  downloads30d(app) {
    const from = dayKey(this.now() - 29 * DAY_MS);
    let n = 0;
    for (const [k, v] of Object.entries(app.daily || {})) if (k >= from) n += v;
    const p = this.pendingByApp.get(app.id);
    if (p) for (const [k, v] of p.byDay) if (k >= from) n += v;
    return n;
  }

  /** Counts one download. It is written to the log later, aggregated per app, version and hour (counters.downloads). */
  addDownload(app, version) {
    const hour = hourKey(this.now());
    const key = `${app.id}|${version}|${hour}`;
    const it = this.pendingMap.get(key) || { id: app.id, version, hour, n: 0 };
    it.n++;
    this.pendingMap.set(key, it);
    this._bump(it, 1);
  }

  _bump(it, delta) {
    let p = this.pendingByApp.get(it.id);
    if (!p) {
      p = { total: 0, byVersion: new Map(), byDay: new Map() };
      this.pendingByApp.set(it.id, p);
    }
    p.total += delta;
    p.byVersion.set(it.version, (p.byVersion.get(it.version) || 0) + delta);
    const day = it.hour.slice(0, 10);
    p.byDay.set(day, (p.byDay.get(day) || 0) + delta);
    if (p.total <= 0) this.pendingByApp.delete(it.id);
  }

  /** The counters waiting to be written: [{id, version, hour, n}]. */
  pendingItems() {
    return [...this.pendingMap.values()].map((x) => Object.assign({}, x));
  }

  /** Forgets counters that were just appended to the log (their count moved into the state). Others stay pending. */
  settle(items) {
    for (const it of items) {
      const key = `${it.id}|${it.version}|${it.hour}`;
      const cur = this.pendingMap.get(key);
      if (!cur) continue;
      const take = Math.min(cur.n, it.n);
      cur.n -= take;
      if (cur.n <= 0) this.pendingMap.delete(key);
      this._bump(it, -take);
    }
  }
}

module.exports = { Db, dayKey, hourKey, DAY_MS, hasOwn, SCHEMA };
