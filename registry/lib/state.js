'use strict';
// The event types and what each one does to the state (the reducers). State = replay(events): apply() over the events
// in sequence order gives exactly what the registry serves. Both the running server and `admin.js verify` use this
// file, so there is only one definition of what an event means.
//
// An event is { seq, ts, type, actor, data }:
//   seq    1, 2, 3, ... without gaps (allocated by the single server process)
//   ts     ISO-8601 UTC, never earlier than the previous event's
//   actor  who caused it: a publisher id ("pub-..."), "system" (the server itself) or "admin" (admin.js). Never a token.
//   data   see TYPES below
//
// | type                | data                                                                                              |
// | publisher.created   | { id, tokenHash, name, company, email, url }   tokenHash = SHA-256 of the owner token              |
// | publisher.updated   | { id, name, company, email, url }              a changed email drops its verification               |
// | publisher.verified  | { id, kind: "email", email } or { id, kind: "domain", name, method: "file"|"dns"|"operator" }        |
//                         ("operator": the registry's operator vouched for the domain; the actor is "admin")
// | app.published       | { id, version, sha256, size, packageId, publisherId, meta: { manifest, files } }                    |
// | version.withdrawn   | { id, version, reason }                        a mark: the version stays published and downloadable |
// | version.restored    | { id, version }                                                                                     |
// | app.hidden          | { id, reason }                                 a tombstone: the app disappears, its data stays      |
// | app.unhidden        | { id }                                         lifts the tombstone                                  |
// | counters.downloads  | { items: [{ id, version, hour: "2026-10-16T09", n }] }   aggregated, appended every few minutes       |
// | admin.gc            | { deleted: [key, ...], ... }                   audit record of `admin.js gc --confirm`               |
// Events written by `admin.js migrate` carry an extra data.migrated = { from: "<sha256 of the old db.json>", index }.

const { ID_RE, SEMVER_RE } = require('../../hostlib/manifest');
const { hasOwn } = require('./db');

const TYPES = [
  'publisher.created', 'publisher.updated', 'publisher.verified', 'app.published', 'version.withdrawn', 'version.restored',
  'app.hidden', 'app.unhidden', 'counters.downloads', 'admin.gc',
];
const HEX64 = /^[0-9a-f]{64}$/;
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

class EventError extends Error {}

function fail(ev, msg) {
  throw new EventError(`invalid ${ev && ev.type} event${ev && ev.seq ? ` #${ev.seq}` : ''}: ${msg}`);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Throws EventError unless `ev` is a well-formed event. Used before an event is written and again when it is replayed. */
function validate(ev) {
  if (!isObj(ev)) throw new EventError('an event must be a JSON object');
  if (!Number.isSafeInteger(ev.seq) || ev.seq < 1) fail(ev, 'seq must be a positive integer');
  if (typeof ev.ts !== 'string' || !Number.isFinite(Date.parse(ev.ts)) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ev.ts)) fail(ev, 'ts must be an ISO-8601 UTC time');
  if (!TYPES.includes(ev.type)) fail(ev, `unknown type "${ev.type}"`);
  if (typeof ev.actor !== 'string' || !ev.actor || ev.actor.length > 100) fail(ev, 'actor must be a short string');
  if (!isObj(ev.data)) fail(ev, 'data must be an object');
  const d = ev.data;
  const str = (k, max = 400, allowEmpty = true) => {
    if (typeof d[k] !== 'string' || d[k].length > max || (!allowEmpty && !d[k])) fail(ev, `${k} must be a string${allowEmpty ? '' : ' (not empty)'} of at most ${max} characters`);
  };
  const appId = () => {
    if (typeof d.id !== 'string' || d.id.length < 3 || d.id.length > 100 || !ID_RE.test(d.id)) fail(ev, 'id must be an app id');
  };
  const version = () => {
    if (typeof d.version !== 'string' || d.version.length > 64 || !SEMVER_RE.test(d.version)) fail(ev, 'version must be semver');
  };
  const pubId = (k = 'id') => {
    if (typeof d[k] !== 'string' || !/^pub-[0-9a-f]{16}$/.test(d[k])) fail(ev, `${k} must be a publisher id`);
  };
  switch (ev.type) {
    case 'publisher.created':
      pubId();
      if (typeof d.tokenHash !== 'string' || !HEX64.test(d.tokenHash)) fail(ev, 'tokenHash must be a SHA-256 in hex');
      for (const k of ['name', 'company', 'email', 'url']) str(k, 200);
      break;
    case 'publisher.updated':
      pubId();
      for (const k of ['name', 'company', 'email', 'url']) str(k, 200);
      break;
    case 'publisher.verified':
      pubId();
      if (d.kind === 'email') str('email', 200, false);
      else if (d.kind === 'domain') {
        str('name', 253, false);
        if (d.method !== 'file' && d.method !== 'dns' && d.method !== 'operator') fail(ev, 'method must be file, dns or operator');
        if (d.method === 'operator' && ev.actor !== 'admin') fail(ev, 'only the registry operator (actor admin) can vouch for a domain');
      } else fail(ev, 'kind must be email or domain');
      break;
    case 'app.published':
      appId();
      version();
      pubId('publisherId');
      if (typeof d.sha256 !== 'string' || !HEX64.test(d.sha256)) fail(ev, 'sha256 must be a SHA-256 in hex');
      if (typeof d.packageId !== 'string' || !HEX64.test(d.packageId)) fail(ev, 'packageId must be a SHA-256 in hex');
      if (!Number.isSafeInteger(d.size) || d.size < 1) fail(ev, 'size must be a positive integer');
      if (!isObj(d.meta) || !isObj(d.meta.manifest) || !isObj(d.meta.files)) fail(ev, 'meta must have manifest and files');
      break;
    case 'version.withdrawn':
      appId();
      version();
      str('reason', 400, false);
      break;
    case 'version.restored':
      appId();
      version();
      break;
    case 'app.hidden':
      appId();
      str('reason', 400, false);
      break;
    case 'app.unhidden':
      appId();
      break;
    case 'counters.downloads':
      if (!Array.isArray(d.items) || d.items.length < 1) fail(ev, 'items must be a non-empty list');
      for (const it of d.items) {
        if (!isObj(it) || typeof it.id !== 'string' || typeof it.version !== 'string' || typeof it.hour !== 'string' || !HOUR_RE.test(it.hour)
          || !Number.isSafeInteger(it.n) || it.n < 1) fail(ev, 'every item needs id, version, hour (2026-10-16T09) and n >= 1');
      }
      break;
    case 'admin.gc':
      if (!Array.isArray(d.deleted)) fail(ev, 'deleted must be a list');
      break;
    default:
      break;
  }
  return ev;
}

function need(ev, what, v) {
  if (!v) throw new EventError(`event #${ev.seq} (${ev.type}) refers to ${what}, which does not exist`);
  return v;
}

/**
 * Checks that the validated event `ev` fits the state `db` is in and returns a function that applies it. Nothing is
 * changed until that function runs, and it cannot throw. The registry calls plan() BEFORE it writes the event, so an
 * event that the replay would reject is never written (it would stop the next start); replay calls apply().
 */
function plan(db, ev) {
  const d = ev.data;
  const at = Date.parse(ev.ts);
  const apps = db.data.apps;
  const versionRec = () => need(ev, `${d.id} ${d.version}`, hasOwn(apps, d.id) && hasOwn(apps[d.id].versions, d.version) ? apps[d.id].versions[d.version] : null);
  switch (ev.type) {
    case 'publisher.created':
      if (db.getPublisher(d.id)) throw new EventError(`event #${ev.seq}: publisher ${d.id} already exists`);
      if (db.publisherByTokenHash(d.tokenHash)) throw new EventError(`event #${ev.seq}: that owner token already belongs to a publisher`);
      return () => db.putPublisher({
        id: d.id, tokenHash: d.tokenHash, name: d.name, company: d.company, email: d.email, url: d.url,
        createdAt: at, emailVerified: null, domain: null, pending: {},
      });
    case 'publisher.updated': {
      const p = need(ev, `publisher ${d.id}`, db.getPublisher(d.id));
      return () => {
        if (d.email !== p.email) {
          p.emailVerified = null; // the verified address is no longer the one on file
          if (p.pending) delete p.pending.email;
        }
        Object.assign(p, { name: d.name, company: d.company, email: d.email, url: d.url });
      };
    }
    case 'publisher.verified': {
      const p = need(ev, `publisher ${d.id}`, db.getPublisher(d.id));
      return () => {
        if (d.kind === 'email') p.emailVerified = { email: d.email, at };
        else p.domain = { name: d.name, at, method: d.method };
      };
    }
    case 'app.published': {
      need(ev, `publisher ${d.publisherId}`, db.getPublisher(d.publisherId));
      const app = hasOwn(apps, d.id) ? apps[d.id] : null;
      if (app) {
        if (app.publisherId !== d.publisherId) throw new EventError(`event #${ev.seq}: ${d.id} belongs to another publisher`);
        if (hasOwn(app.versions, d.version)) throw new EventError(`event #${ev.seq}: ${d.id} ${d.version} is already published`);
      }
      return () => {
        let a = app;
        if (!a) {
          a = { id: d.id, publisherId: d.publisherId, createdAt: at, updatedAt: at, latest: d.version, downloads: 0, daily: {}, versions: {} };
          apps[d.id] = a;
        } else {
          a.latest = d.version;
          a.updatedAt = at;
        }
        a.versions[d.version] = { version: d.version, packageId: d.packageId, sha256: d.sha256, size: d.size, publishedAt: at, downloads: 0, meta: d.meta };
      };
    }
    case 'version.withdrawn': {
      const rec = versionRec();
      return () => {
        rec.withdrawn = { reason: d.reason, at };
      };
    }
    case 'version.restored': {
      const rec = versionRec();
      return () => {
        delete rec.withdrawn;
      };
    }
    case 'app.hidden': {
      const app = need(ev, `app ${d.id}`, hasOwn(apps, d.id) ? apps[d.id] : null);
      return () => {
        app.hidden = { reason: d.reason, at };
      };
    }
    case 'app.unhidden': {
      const app = need(ev, `app ${d.id}`, hasOwn(apps, d.id) ? apps[d.id] : null);
      return () => {
        delete app.hidden;
      };
    }
    case 'counters.downloads':
      return () => {
        for (const it of d.items) {
          const app = hasOwn(apps, it.id) ? apps[it.id] : null;
          if (!app) {
            db.warnings.push(`event #${ev.seq}: counters for unknown app ${it.id} ignored`);
            continue;
          }
          app.downloads = (app.downloads || 0) + it.n;
          if (hasOwn(app.versions, it.version)) app.versions[it.version].downloads = (app.versions[it.version].downloads || 0) + it.n;
          const day = it.hour.slice(0, 10);
          app.daily[day] = (app.daily[day] || 0) + it.n;
        }
      };
    case 'admin.gc':
      return () => {};
    default:
      throw new EventError(`event #${ev.seq}: unknown type ${ev.type}`);
  }
}

/** Applies one validated event to `db` (replay). Throws EventError if it contradicts the state: the log is damaged. */
function apply(db, ev) {
  plan(db, ev)();
}

module.exports = { TYPES, EventError, validate, plan, apply };
