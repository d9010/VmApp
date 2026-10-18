'use strict';
// The vmapp app registry: HTTP API, upload verification, download counting and the web UI (static files, plus the
// home page, app pages, sitemap and robots.txt rendered by lib/pages.js).
// One process. Storage is an append-only event log plus content-addressed package blobs, in a local directory or an
// S3-compatible bucket (lib/store.js, lib/s3.js, lib/eventlog.js, lib/state.js). See registry/README.md, "Storage".

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const pkg = require('../../hostlib/package');
const { ID_RE, SEMVER_RE, compareVersions } = require('../../hostlib/manifest');
const { Db, dayKey, DAY_MS, hasOwn } = require('./db');
const { blobKey, stagingKey, LEASE_KEY } = require('./store');
const { openStore, normaliseBase } = require('./storage');
const { EventLog, StorageFault } = require('./eventlog');
const { EventError } = require('./state');
const { S3Lease } = require('./lease');
const { acquireLock } = require('./lock');
const { RateLimiter } = require('./ratelimit');
const present = require('./present');
const versionsLib = require('./versions');
const { SORTS, queryApps } = require('./listing');
const { createPages } = require('./pages');
const { loadStatic } = require('./static');
const {
  ProfileError, parseProfile, parseProfileHeader, normalizeDomain, emailDomain, publicView, devMailer, checkDomain, WELL_KNOWN,
} = require('./publisher');

const EMAIL_CODE_MS = 15 * 60 * 1000;

// Default data folder: $VMAPP_WORK/registry-data (VMAPP_WORK defaults to vmapp/out/work, git-ignored). A real
// deployment passes --data or sets $REGISTRY_DATA.
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(__dirname, '..', '..', 'out', 'work'));
const DEFAULT_DATA = path.join(WORK, 'registry-data');
const DEFAULT_PUBLIC = path.resolve(__dirname, '..', 'public');

const UPLOAD_TTL_MS = 15 * 60 * 1000; // a presigned upload URL (and its uploadId) lives this long
const MAX_PENDING_UPLOADS = 5000;

const DEFAULTS = {
  maxPackageBytes: pkg.MAX_PACKAGE, // SPEC 2: 2047 MiB
  snapshotEvery: 500, // events between snapshots
  counterFlushMs: 5 * 60 * 1000, // download counters are appended to the log at most this often
  leaseTtlMs: 60 * 1000, // s3: the writer lease expires this long after its last renewal
  leaseRenewMs: 15 * 1000,
  publishPerHour: 10,
  apiPerMinute: 300,
  headersTimeoutMs: 15 * 1000,
  requestTimeoutMs: 15 * 60 * 1000, // the whole request, so a large upload on a slow link still fits (2 GiB at ~2.3 MiB/s)
  idleTimeoutMs: 60 * 1000, // a connection that sends or receives nothing for this long is dropped
  domainTimeoutMs: 5000, // the domain check: well-known file fetch and DNS lookup
  devAllowHttpVerify: false, // tests only: verify domains over plain http, with a port, without the public-address check
};

// The server-rendered pages (home, app pages, sitemap.xml, robots.txt) are public and identical for everybody; a CDN in front
// may keep them this long. Everything else (the API, the other pages) is "no-cache".
const PAGE_CACHE = 'public, max-age=60';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** Does an If-None-Match header (one tag, a list, or W/-prefixed) name this ETag? */
const etagMatches = (header, etag) => typeof header === 'string' && header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);

function validId(s) {
  return typeof s === 'string' && s.length >= 3 && s.length <= 100 && ID_RE.test(s);
}
function validVersion(s) {
  return typeof s === 'string' && s.length <= 64 && SEMVER_RE.test(s);
}

/**
 * Creates a registry instance (nothing listens until start()).
 * @param {object} [opts] dataDir, host, port, trustProxy, now, log, publicDir, maxPackageBytes, publishPerHour,
 *   apiPerMinute, headersTimeoutMs, requestTimeoutMs, idleTimeoutMs, and the storage options:
 *   storage ({type: 'local', dir?} | {type: 's3', bucket, accessKeyId, secretAccessKey, endpoint?, region?, pathStyle?} | a
 *   store object; default: local, in <dataDir>/store), publicDownloadBase (downloads redirect there), snapshotEvery,
 *   counterFlushMs, leaseTtlMs, leaseRenewMs, onFault (called once if the event log can no longer be written)
 */
function createRegistry(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const dataDir = path.resolve(o.dataDir || process.env.REGISTRY_DATA || DEFAULT_DATA);
  const host = o.host || '127.0.0.1';
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const tmpDir = path.join(dataDir, 'tmp'); // uploads in flight; with the s3 backend this is all the local disk is used for
  const publicBase = normaliseBase(o.publicDownloadBase);

  const db = new Db({ now });
  let store = null;
  let events = null;
  let lease = null;
  let counterTimer = null;
  const uploads = new Map(); // uploadId -> { size, sha256, key, expiresAt, completes } (memory only; a restart voids them)
  const apiLimiter = new RateLimiter(o.apiPerMinute, 60 * 1000, now);
  const publishLimiter = new RateLimiter(o.publishPerHour, 3600 * 1000, now);
  const emailLimiter = new RateLimiter(5, 3600 * 1000, now); // verification emails per publisher per hour
  const domainLimiter = new RateLimiter(20, 3600 * 1000, now); // domain checks per publisher per hour
  const mailer = o.mailer || devMailer(dataDir, log);
  let listenUrl = '';
  const baseUrl = () => String(o.publicUrl || listenUrl).replace(/\/+$/, '');
  const ipSalt =crypto.randomBytes(16); // only in memory: hashed IPs cannot be reversed or correlated across restarts
  const seen = new Map(); // download dedupe: "<ip hash>|<id>|<version>" -> time of the last counted download
  let statics = null;
  let pages = null;
  let server = null;
  let releaseLock = null;
  let pruneTimer = null;
  let chain = Promise.resolve();

  // Serialises the "check, store, save" step of publishing.
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  function clientKey(req) {
    let ip = req.socket.remoteAddress || '';
    if (o.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.trim()) ip = xff.split(',').pop().trim();
    }
    return crypto.createHash('sha256').update(ipSalt).update(ip).digest('hex').slice(0, 24);
  }

  // ---------------------------------------------------------------------------------------- responses
  function baseHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }

  function sendJson(res, status, obj, headers) {
    if (res.headersSent || res.destroyed) return;
    const body = Buffer.from(JSON.stringify(obj) + '\n');
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' }, headers));
    res.end(body);
  }

  function sendError(res, status, code, message, headers) {
    sendJson(res, status, { error: { code, message } }, headers);
  }

  // ---------------------------------------------------------------------------------------- API
  function checkMethod(req, allowed) {
    if (!allowed.includes(req.method)) throw new HttpError(405, 'method_not_allowed', `use ${allowed.join(' or ')} for this URL`, { Allow: allowed.join(', ') });
  }

  function parseId(s) {
    if (!validId(s)) throw new HttpError(400, 'bad_request', 'invalid app id (reverse-DNS such as com.example.app)');
    return s;
  }

  function parseVersion(s) {
    if (s !== 'latest' && !validVersion(s)) throw new HttpError(400, 'bad_request', 'invalid version (semver such as 1.2.3, or "latest")');
    return s;
  }

  function intParam(url, name, def, min, max) {
    const v = url.searchParams.get(name);
    if (v === null || v === '') return def;
    if (!/^\d{1,9}$/.test(v)) throw new HttpError(400, 'bad_request', `${name} must be a non-negative integer`);
    return Math.min(max, Math.max(min, Number(v)));
  }

  function listApps(url) {
    const sort = url.searchParams.get('sort') || 'popular';
    if (!SORTS.includes(sort)) throw new HttpError(400, 'bad_request', `sort must be one of ${SORTS.join(', ')}`);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length > 100) throw new HttpError(400, 'bad_request', 'q is too long (100 characters at most)');
    const limit = intParam(url, 'limit', 50, 1, 100);
    const offset = intParam(url, 'offset', 0, 0, 1e9);
    const { total, items } = queryApps(db, { sort, q, limit, offset });
    return { total, limit, offset, sort, q, items };
  }

  function stats() {
    let versions = 0;
    let downloads = 0;
    const apps = db.apps();
    for (const a of apps) {
      versions += Object.keys(a.versions).length;
      downloads += db.appDownloads(a);
    }
    return { apps: apps.length, versions, downloads };
  }

  function countDownload(app, version, key) {
    const k = `${key}|${app.id}|${version}`;
    const t = now();
    const last = seen.get(k);
    if (last !== undefined && t - last < DAY_MS) return false;
    if (seen.size >= 2000000) pruneSeen();
    if (seen.size >= 2000000) return false;
    seen.set(k, t);
    db.addDownload(app, version);
    return true;
  }

  function pruneSeen() {
    const t = now();
    for (const [k, v] of seen) if (t - v >= DAY_MS) seen.delete(k);
  }

  /** Where a package lives in the store, for the local backend (null for s3). Tests and the admin tools use it. */
  function blobPath(sha256) {
    return store && store.kind === 'local' ? store.pathOf(blobKey(sha256)) : null;
  }

  /**
   * GET /api/apps/:id/:version/download. With PUBLIC_DOWNLOAD_BASE the answer is a 302 to the package on the object
   * store's public address, carrying the same X-Vmapp-* headers a direct download carries: the client verifies the bytes
   * it gets from there against these headers (it never trusts the bucket). Without it the registry streams the blob.
   */
  async function download(req, res, id, versionParam, key) {
    const app = db.getApp(id);
    if (!app) throw new HttpError(404, 'not_found', `no app "${id}"`);
    // "latest" skips withdrawn versions; a withdrawn version is still served when asked for by its exact number
    const version = versionParam === 'latest' ? versionsLib.newestAvailable(app) : versionParam;
    if (version === null) throw new HttpError(404, 'all_withdrawn', `every version of ${id} is withdrawn; ask for one by its exact version`);
    if (!hasOwn(app.versions, version)) throw new HttpError(404, 'not_found', `${id} has no version ${version}`);
    const v = app.versions[version];
    const bkey = blobKey(v.sha256);
    const etag = `"${v.sha256}"`;
    const headers = {
      'X-Vmapp-Package-Id': v.packageId,
      'X-Vmapp-Sha256': v.sha256,
      'X-Vmapp-Version': version,
      ETag: etag,
      'Cache-Control': 'no-cache',
    };
    // a withdrawn version stays downloadable; tell the client why it was withdrawn (percent-encoded: headers are ASCII)
    if (versionsLib.isWithdrawn(v)) headers['X-Vmapp-Withdrawn'] = encodeURIComponent(v.withdrawn.reason);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    if (publicBase) {
      if (req.method === 'GET') countDownload(app, version, key);
      res.writeHead(302, Object.assign({ Location: `${publicBase}/${bkey}`, 'Content-Length': 0 }, headers));
      res.end();
      return;
    }
    let obj;
    try {
      obj = await store.getStream(bkey);
    } catch (e) {
      log(`storage: cannot read ${bkey}: ${e.message}`);
      throw new HttpError(502, 'storage_error', 'the package cannot be read from storage right now');
    }
    if (!obj) {
      log(`storage: missing ${bkey}`);
      throw new HttpError(500, 'storage_error', 'the package file is missing on the server');
    }
    Object.assign(headers, {
      'Content-Type': 'application/x-vmapp',
      'Content-Disposition': `attachment; filename="${id}-${version}.vmapp"`,
      'Content-Length': obj.size,
    });
    if (req.method === 'GET') countDownload(app, version, key);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      obj.stream.destroy();
      res.end();
      return;
    }
    await pipeline(obj.stream, res).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------- publishing
  function bearer(req) {
    const h = req.headers.authorization;
    if (!h) return null;
    const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(h.trim());
    return m ? m[1].toLowerCase() : false;
  }

  const unauthorized = (message) => new HttpError(401, 'unauthorized', message, { 'WWW-Authenticate': 'Bearer realm="vmapp-registry"' });

  /** The publisher that owns this token. 401 without a (well-formed) token, 403 for an unknown one. */
  function publisherOf(token) {
    if (!token) throw unauthorized('send your owner token as "Authorization: Bearer <owner token>"');
    const pub = db.publisherByTokenHash(sha256hex(token));
    if (!pub) throw new HttpError(403, 'forbidden', 'unknown owner token');
    return pub;
  }

  function authorize(app, token, doing = 'publish a new version') {
    if (!token) throw unauthorized(`${app.id} already exists: ${doing} with "Authorization: Bearer <owner token>"`);
    const pub = db.publisherByTokenHash(sha256hex(token));
    if (!pub || pub.id !== app.publisherId) throw new HttpError(403, 'forbidden', `that token does not own ${app.id}`);
    return pub;
  }

  async function receive(req, file, max) {
    let size = 0;
    const hash = crypto.createHash('sha256');
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new HttpError(413, 'too_large', `package is larger than the limit of ${max} bytes`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'upload_aborted', `upload failed: ${e.message}`);
    }
    const fd = fs.openSync(file, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { size, sha256: hash.digest('hex') };
  }

  async function publish(req, res, key) {
    const lim = publishLimiter.hit(key);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', `too many publishes from this address; try again in ${lim.retryAfterSec} s`, { 'Retry-After': String(lim.retryAfterSec) });
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream' && ct !== 'application/x-vmapp') {
      throw new HttpError(415, 'unsupported_media_type', 'send the raw .vmapp bytes with Content-Type: application/octet-stream');
    }
    const cl = req.headers['content-length'];
    if (cl !== undefined) {
      if (!/^\d{1,15}$/.test(cl)) throw new HttpError(400, 'bad_request', 'invalid Content-Length');
      if (Number(cl) > o.maxPackageBytes) throw new HttpError(413, 'too_large', `package is larger than the limit of ${o.maxPackageBytes} bytes`);
      if (Number(cl) === 0) throw new HttpError(400, 'bad_request', 'empty upload');
    }
    const token = bearer(req);
    let profile;
    try {
      profile = parseProfileHeader(req.headers['x-vmapp-publisher']);
    } catch (e) {
      throw new HttpError(400, 'bad_request', e.message);
    }

    const tmp = path.join(tmpDir, `${crypto.randomBytes(12).toString('hex')}.part`);
    try {
      const up = await receive(req, tmp, o.maxPackageBytes);
      if (up.size === 0) throw new HttpError(400, 'bad_request', 'empty upload');
      sendJson(res, 201, await finishPublish({ tmp, up, token, profile, staged: null }));
    } finally {
      rmQuiet(tmp);
    }
  }

  /** Deletes a temp file of ours; a file that is already gone is fine. */
  function rmQuiet(file) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* never created, or already gone */
    }
  }

  /**
   * The rest of a publish, shared by the direct upload and the presigned one: `tmp` is the package on local disk with
   * its SHA-256 and size in `up`. Verifies it (hostlib: the same strict check the loader uses), then, one publish at a
   * time: checks ownership and the version, stores the blob (never replacing one), and appends the events.
   * @param {{tmp: string, up: {size: number, sha256: string}, token: string|null, profile: object|null, staged: {key: string, etag: string|null}|null}} a
   * @returns {Promise<object>} the 201 body
   */
  async function finishPublish({ tmp, up, token, profile, staged }) {
    let info;
    try {
      info = pkg.verify(tmp);
    } catch (e) {
      throw new HttpError(400, 'invalid_package', e.message);
    }
    const m = info.manifest;
    const result = await exclusive(async () => {
      // a process that can no longer write must not leave packages behind either
      if (events.faulted) throw new HttpError(503, 'storage_unavailable', 'the registry cannot write to its storage right now; try again later');
      const app = db.getAppAny(m.id);
      let ownerToken = null;
      let publisher;
      let newPublisher = null;
      const created = !app;
      if (app && app.hidden) throw new HttpError(409, 'app_hidden', `${m.id} was taken down by the registry operator and cannot be published to`);
      if (created) {
        if (token) {
          publisher = publisherOf(token); // a new app id under the publisher that owns this token
        } else {
          // a new publisher: the first publish creates the record and the owner token (shown once)
          ownerToken = crypto.randomBytes(32).toString('hex');
          const p = profile || parseProfile();
          newPublisher = { id: 'pub-' + crypto.randomBytes(8).toString('hex'), tokenHash: sha256hex(ownerToken), name: p.name, company: p.company, email: p.email, url: p.url };
          publisher = newPublisher;
        }
      } else {
        publisher = authorize(app, token);
        if (hasOwn(app.versions, m.version)) throw new HttpError(409, 'version_exists', `${m.id} ${m.version} is already published; versions are immutable, publish a higher version`);
        if (compareVersions(m.version, app.latest) <= 0) {
          throw new HttpError(409, 'version_not_newer', `${m.version} is not newer than the latest published version ${app.latest}`);
        }
      }
      await storeBlob(up, tmp, staged);
      if (newPublisher) {
        await appendEvent('publisher.created', newPublisher.id, newPublisher);
      }
      const stripped = Object.assign({}, info.manifest);
      delete stripped.files;
      await appendEvent('app.published', publisher.id, {
        id: m.id, version: m.version, sha256: up.sha256, size: up.size, packageId: info.packageId, publisherId: publisher.id,
        meta: { manifest: stripped, files: { count: Object.keys(info.manifest.files).length, uiBytes: info.uiBytes, coreBytes: info.coreBytes, hasIcon: info.hasIcon } },
      });
      return { created, ownerToken, publisher: db.getPublisher(publisher.id) };
    });
    log(`published ${m.id} ${m.version}${result.created ? ' (new app)' : ''}`);
    const body = {
      id: m.id, version: m.version, packageId: info.packageId, sha256: up.sha256, size: up.size,
      created: result.created, url: `/apps/${m.id}`, publisher: publicView(result.publisher),
    };
    if (result.ownerToken) body.ownerToken = result.ownerToken;
    return body;
  }

  /**
   * Puts the package into blobs/sha256/<hh>/<sha256>.vmapp, unless it is already there (then nothing is written: blobs are
   * write-once and the name is the hash). From a staged upload the object store copies it server-side, and only if the
   * staged object is still the one that was verified (its ETag).
   */
  async function storeBlob(up, tmp, staged) {
    const bkey = blobKey(up.sha256);
    try {
      const have = await store.head(bkey);
      if (have) {
        if (have.size !== up.size) throw new HttpError(500, 'storage_error', `a different object already holds the name of this package (${bkey}); the operator must look at it`);
        return;
      }
      if (staged) {
        try {
          await store.copy(staged.key, bkey, { ifMatch: staged.etag || undefined });
        } catch (e) {
          if (e && e.status === 412) throw new HttpError(409, 'upload_changed', 'the uploaded object changed after it was verified; upload it again');
          throw e;
        }
      } else {
        await store.putFile(bkey, tmp, { sha256: up.sha256, size: up.size });
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      log(`storage: cannot store ${bkey}: ${e.message}`);
      throw new HttpError(502, 'storage_error', 'the package could not be stored; nothing was published, try again');
    }
  }

  /** Appends an event to the log; storage trouble becomes a 5xx, a contradiction a 409. */
  async function appendEvent(type, actor, data, opts) {
    try {
      return await events.append(type, actor, data, opts);
    } catch (e) {
      if (e instanceof StorageFault) throw new HttpError(503, 'storage_unavailable', 'the registry cannot write to its storage right now; the operator has been alerted by the log');
      if (e instanceof EventError) throw new HttpError(409, 'conflict', e.message);
      throw e;
    }
  }

  // ---- presigned uploads: the package goes to the object store directly, not through this server ----
  function pruneUploads() {
    const t = now();
    for (const [id, u] of uploads) if (t > u.expiresAt) uploads.delete(id);
  }

  /** POST /api/publish/init {size, sha256} -> a presigned PUT URL for staging/<uploadId>.vmapp (s3 backend only). */
  async function publishInit(req, res, key) {
    if (!store.supportsPresign) throw new HttpError(501, 'not_supported', 'this registry stores packages on its own disk: send the package to POST /api/publish');
    const lim = publishLimiter.hit(key);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', `too many publishes from this address; try again in ${lim.retryAfterSec} s`, { 'Retry-After': String(lim.retryAfterSec) });
    const token = bearer(req);
    if (token) publisherOf(token); // a token that no publisher has is refused now, not after the upload
    else if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    const body = await readJson(req);
    const size = body.size;
    const sha256 = typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : '';
    if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'bad_request', 'size must be the package size in bytes');
    if (size > o.maxPackageBytes) throw new HttpError(413, 'too_large', `package is larger than the limit of ${o.maxPackageBytes} bytes`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, 'bad_request', 'sha256 must be the SHA-256 of the package in hex');
    pruneUploads();
    if (uploads.size >= MAX_PENDING_UPLOADS) throw new HttpError(429, 'rate_limited', 'too many uploads are waiting; try again later', { 'Retry-After': '60' });
    const uploadId = crypto.randomUUID();
    const skey = stagingKey(uploadId);
    let put;
    try {
      put = store.presignPut(skey, { size, expiresSec: Math.round(UPLOAD_TTL_MS / 1000) });
    } catch (e) {
      log(`presign failed: ${e.message}`);
      throw new HttpError(500, 'storage_error', 'could not prepare the upload');
    }
    uploads.set(uploadId, { size, sha256, key: skey, expiresAt: now() + UPLOAD_TTL_MS, completes: 0 });
    return { uploadId, method: put.method, url: put.url, headers: put.headers, expiresAt: new Date(put.expiresAt).toISOString(), size };
  }

  /** POST /api/publish/complete {uploadId}: fetch what was uploaded, verify it strictly, then publish it like a direct upload. */
  async function publishComplete(req, res) {
    if (!store.supportsPresign) throw new HttpError(501, 'not_supported', 'this registry stores packages on its own disk: send the package to POST /api/publish');
    const token = bearer(req);
    if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    let profile;
    try {
      profile = parseProfileHeader(req.headers['x-vmapp-publisher']);
    } catch (e) {
      throw new HttpError(400, 'bad_request', e.message);
    }
    const body = await readJson(req);
    pruneUploads();
    const up0 = typeof body.uploadId === 'string' ? uploads.get(body.uploadId) : undefined;
    if (!up0) throw new HttpError(404, 'unknown_upload', 'that upload is unknown or has expired (15 minutes); start again with POST /api/publish/init');
    if (++up0.completes > 5) throw new HttpError(429, 'rate_limited', 'this upload was checked too many times; start again with POST /api/publish/init');
    let head;
    try {
      head = await store.head(up0.key);
    } catch (e) {
      log(`storage: cannot look at ${up0.key}: ${e.message}`);
      throw new HttpError(502, 'storage_error', 'the object store cannot be reached right now; try again');
    }
    if (!head) throw new HttpError(400, 'upload_missing', 'nothing has been uploaded for this upload id: PUT the package to the URL first');
    if (head.size !== up0.size || head.size > o.maxPackageBytes) throw new HttpError(400, 'upload_mismatch', `the uploaded object is ${head.size} bytes, not the ${up0.size} announced`);

    // stream the staged object to local disk, hashing as it goes; the bucket is not trusted
    const tmp = path.join(tmpDir, `${crypto.randomBytes(12).toString('hex')}.part`);
    try {
      let obj;
      try {
        obj = await store.getStream(up0.key);
      } catch (e) {
        log(`storage: cannot read ${up0.key}: ${e.message}`);
        throw new HttpError(502, 'storage_error', 'the object store cannot be reached right now; try again');
      }
      if (!obj) throw new HttpError(400, 'upload_missing', 'the uploaded object disappeared; upload again');
      const upl = await receive(obj.stream, tmp, o.maxPackageBytes).catch((e) => {
        obj.stream.destroy();
        if (e instanceof HttpError && e.code === 'upload_aborted') throw new HttpError(502, 'storage_error', 'reading the uploaded object failed; try again');
        throw e;
      });
      if (upl.size !== up0.size || upl.sha256 !== up0.sha256) {
        throw new HttpError(400, 'upload_mismatch', 'the uploaded bytes are not the size and SHA-256 announced in init');
      }
      const result = await finishPublish({ tmp, up: upl, token, profile, staged: { key: up0.key, etag: obj.etag } });
      uploads.delete(body.uploadId);
      return result;
    } finally {
      rmQuiet(tmp);
    }
  }

  /** GET /api/info: what a client may use. `publishModes` lists the ways to publish. */
  function info() {
    return {
      name: 'vmapp-registry',
      publishModes: store && store.supportsPresign ? ['direct', 'presigned'] : ['direct'],
      downloads: publicBase ? 'redirect' : 'direct',
      maxPackageBytes: o.maxPackageBytes,
    };
  }

  // ---------------------------------------------------------------------------------------- publisher identity
  async function readJson(req, max = 8192) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new HttpError(413, 'too_large', `the request body is larger than ${max} bytes`);
      chunks.push(c);
    }
    if (!size) return {};
    let v;
    try {
      v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad_request', 'the body must be JSON');
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_request', 'the body must be a JSON object');
    return v;
  }

  function rateGuard(limiter, k, what) {
    const r = limiter.hit(k);
    if (!r.ok) throw new HttpError(429, 'rate_limited', `too many ${what}; try again in ${r.retryAfterSec} s`, { 'Retry-After': String(r.retryAfterSec) });
  }

  const domainHolder = (name, exceptId) => db.publishers().find((p) => p.id !== exceptId && p.domain && p.domain.name === name) || null;

  async function publisherApi(req, res, seg) {
    const action = seg[1];
    if (seg.length !== 2) throw new HttpError(404, 'not_found', 'no such API endpoint');
    const t = now();

    if (action === 'confirm-email') {
      checkMethod(req, ['POST']);
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
      const bad = new HttpError(400, 'invalid_code', 'that code is wrong, expired or already used');
      if (!/^[0-9a-f]{32}$/.test(code)) throw bad;
      const h = sha256hex(code);
      const pub = db.publishers().find((p) => p.pending && p.pending.email && p.pending.email.hash === h);
      if (!pub) throw bad;
      const pend = pub.pending.email;
      delete pub.pending.email; // single use, whatever happens next
      if (t > pend.expiresAt || pend.email !== pub.email) throw bad;
      await exclusive(() => appendEvent('publisher.verified', pub.id, { id: pub.id, kind: 'email', email: pend.email }));
      log('publisher email verified');
      return sendJson(res, 200, { verified: true, publisher: publicView(pub) });
    }

    const pub = publisherOf(bearer(req));
    const mine = () => ({
      publisher: publicView(pub),
      profile: { name: pub.name, company: pub.company, email: pub.email, url: pub.url }, // the owner's own claims
      emailVerified: !!pub.emailVerified,
      domainVerified: !!pub.domain,
      pendingEmail: !!(pub.pending.email && pub.pending.email.expiresAt > t),
      pendingDomain: pub.pending.domain ? domainInstructions(pub.pending.domain) : null,
      apps: db.apps().filter((a) => a.publisherId === pub.id).map((a) => a.id),
    });

    switch (action) {
      case 'me':
        checkMethod(req, ['GET', 'HEAD']);
        return sendJson(res, 200, mine());
      case 'profile': {
        checkMethod(req, ['POST']);
        const p = parseProfile(await readJson(req));
        if (p.name !== pub.name || p.company !== pub.company || p.email !== pub.email || p.url !== pub.url) {
          // a changed email loses its verification and any code that was sent (state.js does both when it applies the event)
          await exclusive(() => appendEvent('publisher.updated', pub.id, { id: pub.id, name: p.name, company: p.company, email: p.email, url: p.url }));
        }
        return sendJson(res, 200, mine());
      }
      case 'verify-email': {
        checkMethod(req, ['POST']);
        if (!pub.email) throw new HttpError(400, 'bad_request', 'no email address on file: set one with POST /api/publisher/profile');
        rateGuard(emailLimiter, pub.id, 'verification emails');
        const code = crypto.randomBytes(16).toString('hex');
        pub.pending.email = { hash: sha256hex(code), expiresAt: t + EMAIL_CODE_MS, email: pub.email }; // memory only: a restart voids it
        const link = `${baseUrl()}/verify?code=${code}`;
        try {
          await mailer.send({
            to: pub.email,
            subject: 'Confirm your email for the D9010 VmApp registry',
            text: `Someone (hopefully you) asked to verify this email address as a publisher on the D9010 VmApp registry.\n\n` +
              `Open this link and press the button within 15 minutes:\n${link}\n\nOr enter this code: ${code}\n\n` +
              `If you did not ask for this, ignore this message.\n`,
          });
        } catch (e) {
          delete pub.pending.email;
          log(`mail failed: ${e.message}`);
          throw new HttpError(502, 'mail_failed', 'the verification email could not be sent');
        }
        return sendJson(res, 200, { sent: true, emailDomain: emailDomain(pub.email), expiresInMinutes: EMAIL_CODE_MS / 60000 });
      }
      case 'verify-domain': {
        checkMethod(req, ['POST']);
        const body = await readJson(req);
        const domain = normalizeDomain(body.domain, o.devAllowHttpVerify);
        const holder = domainHolder(domain, pub.id);
        if (holder) throw new HttpError(409, 'domain_taken', `${domain} is already verified by another publisher`);
        pub.pending.domain = { domain, token: crypto.randomBytes(24).toString('hex'), createdAt: t }; // memory only
        return sendJson(res, 200, domainInstructions(pub.pending.domain));
      }
      case 'check-domain': {
        checkMethod(req, ['POST']);
        const pend = pub.pending.domain;
        if (!pend) throw new HttpError(400, 'bad_request', 'no domain verification is pending: start one with POST /api/publisher/verify-domain');
        rateGuard(domainLimiter, pub.id, 'domain checks');
        const r = await checkDomain(pend.domain, pend.token, { dev: !!o.devAllowHttpVerify, timeoutMs: o.domainTimeoutMs, maxBytes: 4096, resolveTxt: o.resolveTxt });
        if (!r.ok) throw new HttpError(422, 'domain_check_failed', `could not verify ${pend.domain}: ${r.reason}`);
        await exclusive(async () => {
          if (domainHolder(pend.domain, pub.id)) throw new HttpError(409, 'domain_taken', `${pend.domain} is already verified by another publisher`);
          await appendEvent('publisher.verified', pub.id, { id: pub.id, kind: 'domain', name: pend.domain, method: r.method });
        });
        delete pub.pending.domain;
        log(`publisher domain verified: ${pub.domain.name} (${r.method})`);
        return sendJson(res, 200, { verified: true, method: r.method, publisher: publicView(pub) });
      }
      default:
        throw new HttpError(404, 'not_found', 'no such API endpoint');
    }
  }

  function domainInstructions(d) {
    const line = `vmapp-publisher=${d.token}`;
    return {
      domain: d.domain,
      token: d.token,
      file: { url: `${o.devAllowHttpVerify ? 'http' : 'https'}://${d.domain}${WELL_KNOWN}`, content: line },
      dns: { name: `_vmapp.${d.domain.replace(/:\d+$/, '')}`, type: 'TXT', value: line },
    };
  }

  // ---------------------------------------------------------------------------------------- versions (SPEC 8.1)
  function appOr404(id) {
    const app = db.getApp(id);
    if (!app) throw new HttpError(404, 'not_found', `no app "${id}"`);
    return app;
  }

  /** GET /api/apps/:id/resolve?choice=compatible|latest&from=<semver> -> {version} | {version: null} */
  function resolveApi(url, id) {
    const app = appOr404(id);
    const choice = url.searchParams.get('choice');
    if (!versionsLib.CHOICES.includes(choice)) throw new HttpError(400, 'bad_request', `choice must be one of ${versionsLib.CHOICES.join(', ')}`);
    const from = url.searchParams.get('from');
    if (from === null || from === '') {
      if (choice === 'compatible') throw new HttpError(400, 'bad_request', 'from is required for choice=compatible (the version you have, such as 1.2.3)');
    } else if (!validVersion(from)) {
      throw new HttpError(400, 'bad_request', 'invalid from (semver such as 1.2.3)');
    }
    return { version: versionsLib.resolve(app, choice, from || null) };
  }

  /** POST /api/apps/:id/:version/withdraw {reason} and .../restore (owner token). Both are idempotent. */
  async function setWithdrawn(req, id, version, restore) {
    if (!validVersion(version)) throw new HttpError(400, 'bad_request', 'invalid version (semver such as 1.2.3)');
    const app = appOr404(id);
    const pub = authorize(app, bearer(req), restore ? 'restore a version' : 'withdraw a version');
    const rec = hasOwn(app.versions, version) ? app.versions[version] : null;
    if (!rec) throw new HttpError(404, 'not_found', `${id} has no version ${version}`);
    const body = await readJson(req);
    let reason = null;
    if (!restore) {
      try {
        reason = versionsLib.checkReason(body.reason);
      } catch (e) {
        throw new HttpError(400, 'bad_request', e.message);
      }
    }
    // a withdrawal is a mark, an event in the log; the version, its package and its history stay as they are
    await exclusive(async () => {
      if (restore) {
        if (versionsLib.isWithdrawn(rec)) await appendEvent('version.restored', pub.id, { id, version }); // restoring a version that is not withdrawn is a no-op
      } else {
        await appendEvent('version.withdrawn', pub.id, { id, version, reason });
      }
    });
    log(`${restore ? 'restored' : 'withdrew'} ${id} ${version}`);
    return { id, version, withdrawn: present.withdrawnView(rec) };
  }

  // ---------------------------------------------------------------------------------------- routing
  /** Counts a request against the per-address API budget; 429 when it is used up. */
  function apiGuard(key) {
    const lim = apiLimiter.hit(key);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', `too many requests; try again in ${lim.retryAfterSec} s`, { 'Retry-After': String(lim.retryAfterSec) });
  }

  async function api(req, res, url, key) {
    apiGuard(key);
    const seg = url.pathname.split('/').slice(2); // after "", "api"
    if (seg[0] === 'publish' && seg.length === 1) {
      checkMethod(req, ['POST']);
      return publish(req, res, key);
    }
    if (seg[0] === 'publish' && seg.length === 2 && (seg[1] === 'init' || seg[1] === 'complete')) {
      checkMethod(req, ['POST']);
      if (seg[1] === 'init') return sendJson(res, 200, await publishInit(req, res, key));
      return sendJson(res, 201, await publishComplete(req, res));
    }
    if (seg[0] === 'info' && seg.length === 1) {
      checkMethod(req, ['GET', 'HEAD']);
      return sendJson(res, 200, info());
    }
    if (seg[0] === 'publisher') return publisherApi(req, res, seg);
    if (seg[0] === 'stats' && seg.length === 1) {
      checkMethod(req, ['GET', 'HEAD']);
      return sendJson(res, 200, stats());
    }
    if (seg[0] === 'apps') {
      if (seg.length === 1) {
        checkMethod(req, ['GET', 'HEAD']);
        return sendJson(res, 200, listApps(url));
      }
      if (seg.length === 2) {
        checkMethod(req, ['GET', 'HEAD']);
        const id = parseId(seg[1]);
        const app = db.getApp(id);
        if (!app) throw new HttpError(404, 'not_found', `no app "${id}"`);
        return sendJson(res, 200, present.details(db, app));
      }
      if (seg.length === 3 && (seg[2] === 'versions' || seg[2] === 'resolve')) {
        checkMethod(req, ['GET', 'HEAD']);
        const id = parseId(seg[1]);
        if (seg[2] === 'resolve') return sendJson(res, 200, resolveApi(url, id));
        return sendJson(res, 200, versionsLib.sortedDesc(appOr404(id)).map(present.versionEntry));
      }
      if (seg.length === 4 && (seg[3] === 'withdraw' || seg[3] === 'restore')) {
        checkMethod(req, ['POST']);
        const id = parseId(seg[1]);
        return sendJson(res, 200, await setWithdrawn(req, id, seg[2], seg[3] === 'restore'));
      }
      if (seg.length === 4 && seg[3] === 'download') {
        checkMethod(req, ['GET', 'HEAD']);
        const id = parseId(seg[1]);
        const version = parseVersion(seg[2]);
        return download(req, res, id, version, key);
      }
    }
    throw new HttpError(404, 'not_found', 'no such API endpoint');
  }

  /**
   * The pages a search engine or a link preview reads, rendered by the server (lib/pages.js): the home page, an app's
   * page, /sitemap.xml and /robots.txt. They are the same for every visitor (nothing here depends on a cookie, a token or
   * the Host header), so a CDN may keep them for a minute. Returns false for any other path.
   */
  function siteRoute(req, res, url) {
    const p = url.pathname;
    let render;
    if (p === '/') render = () => pages.home(url.searchParams);
    else if (p === '/sitemap.xml') render = () => pages.sitemap();
    else if (p === '/robots.txt') render = () => pages.robots();
    else if (p.startsWith('/apps/') && validId(p.slice(6))) render = () => pages.app(p.slice(6));
    else return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'use GET', { Allow: 'GET, HEAD' });
    if (p !== '/robots.txt') apiGuard(clientKey(req)); // building a page walks the app list: the same budget as the API
    const page = render();
    const body = Buffer.from(page.body);
    const etag = `"${sha256hex(body).slice(0, 20)}"`;
    const cache = page.cache === 'public' ? PAGE_CACHE : 'no-cache';
    if (page.status === 200 && etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
      res.end();
      return true;
    }
    res.writeHead(page.status, { 'Content-Type': page.type, 'Content-Length': body.length, ETag: etag, 'Cache-Control': cache });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  function staticRoute(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'use GET', { Allow: 'GET, HEAD' });
    let name = null;
    if (pathname === '/publish') name = 'publish.html';
    else if (pathname === '/publisher') name = 'publisher.html';
    else if (pathname === '/verify') name = 'verify.html';
    else if (pathname.length > 1 && !pathname.slice(1).includes('/') && !pathname.endsWith('.html')) name = pathname.slice(1);
    const file = name && statics.get(name);
    if (!file) throw new HttpError(404, 'not_found', 'not found');
    const headers = { 'Content-Type': file.type, 'Content-Length': file.body.length, ETag: file.etag, 'Cache-Control': 'no-cache' };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, { ETag: file.etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  async function onRequest(req, res) {
    const t0 = Date.now();
    baseHeaders(res);
    let pathname = '-';
    res.on('finish', () => log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - t0}ms`));
    let isApi = false;
    let bodyUnread = false;
    try {
      if (typeof req.url !== 'string' || !req.url.startsWith('/')) throw new HttpError(400, 'bad_request', 'malformed request target');
      let url;
      try {
        url = new URL(req.url, 'http://registry.invalid');
      } catch {
        throw new HttpError(400, 'bad_request', 'malformed URL');
      }
      pathname = url.pathname.length > 200 ? url.pathname.slice(0, 200) + '...' : url.pathname;
      isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      bodyUnread = req.method === 'POST';
      if (isApi) await api(req, res, url, clientKey(req));
      else if (!siteRoute(req, res, url)) staticRoute(req, res, url.pathname);
    } catch (e) {
      if (e instanceof ProfileError) e = new HttpError(400, 'bad_request', e.message);
      if (e instanceof HttpError) {
        const h = Object.assign({}, e.headers);
        if (bodyUnread && !req.readableEnded) {
          // an upload we refuse: do not keep the connection waiting for a body we will not read
          h.Connection = 'close';
          req.resume();
        }
        if (isApi || e.status !== 404) sendError(res, e.status, e.code, e.message, h);
        else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found\n');
        }
      } else {
        log(`internal error: ${e && e.stack}`);
        sendError(res, 500, 'internal', 'internal server error');
      }
    }
  }

  // ---------------------------------------------------------------------------------------- lifecycle
  /** Appends the download counters collected so far as one counters.downloads event (no event if there are none). */
  async function flushCounters() {
    if (!events || events.faulted) return;
    const items = db.pendingItems();
    if (!items.length) return;
    try {
      await events.append('counters.downloads', 'system', { items }, { after: () => db.settle(items) });
    } catch (e) {
      log(`counters: not written this time (${e.message}); they stay in memory and are retried`);
    }
  }

  /**
   * With a public download address configured, the bucket must still not be readable beyond blobs/. The writer lease
   * object is a convenient probe: if it can be fetched from the public address, so can the event log (publisher e-mail
   * addresses, token hashes). Warn loudly; nothing else is done about it.
   */
  function probePublicExposure() {
    if (!publicBase || !store || store.kind !== 's3') return;
    const u = `${publicBase}/${LEASE_KEY}`;
    const lib = u.startsWith('https:') ? https : http;
    const req = lib.get(u, { timeout: 4000, agent: false }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        log(`WARNING: ${u} is publicly readable. PUBLIC_DOWNLOAD_BASE exposes more than blobs/: the event log (publisher e-mail addresses and token hashes) is public too. Restrict the public address to /blobs/ (registry/deploy/HOSTING.md, step 5).`);
      }
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  }

  async function start() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    releaseLock = acquireLock(dataDir);
    try {
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      for (const f of fs.readdirSync(tmpDir)) {
        if (f.endsWith('.part')) fs.unlinkSync(path.join(tmpDir, f)); // leftovers of an interrupted upload
      }
      store = await openStore(o.storage, { dataDir, log, cleanTmp: true });
      log(`storage: ${store.describe()}`);
      if (store.kind === 's3') {
        lease = new S3Lease(store, {
          ttlMs: o.leaseTtlMs, renewMs: o.leaseRenewMs, settleMs: o.leaseSettleMs, log,
          onLost: (err) => events && events.fault(err.message),
        });
        await lease.acquire();
      }
      events = new EventLog({
        store, db, now, log, snapshotEvery: o.snapshotEvery, guard: lease ? () => lease.check() : undefined, onFault: o.onFault,
      });
      const loaded = await events.load();
      for (const w of db.warnings) log(w);
      log(`loaded ${loaded.seq} events (snapshot ${loaded.snapshotSeq}, ${loaded.replayed} replayed)`);
      statics = loadStatic(o.publicDir || DEFAULT_PUBLIC);
      // canonical and other absolute URLs come from the configured public URL only (not from the listen address, not from a request)
      pages = createPages({
        db, stats, publicUrl: o.publicUrl,
        shells: { home: statics.get('index.html').body.toString('utf8'), app: statics.get('app.html').body.toString('utf8') },
      });
      server = http.createServer(onRequest);
      server.headersTimeout = o.headersTimeoutMs;
      server.requestTimeout = o.requestTimeoutMs;
      server.keepAliveTimeout = 5000;
      server.setTimeout(o.idleTimeoutMs);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port === undefined ? 8790 : o.port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      if (server) {
        server.close();
        server = null;
      }
      try {
        if (lease) await lease.release();
      } finally {
        lease = null;
        if (store && store.close) store.close();
        store = null;
        events = null;
        releaseLock();
        releaseLock = null;
      }
      throw e;
    }
    pruneTimer = setInterval(() => {
      pruneSeen();
      pruneUploads();
      apiLimiter.prune();
      publishLimiter.prune();
    }, 10 * 60 * 1000);
    pruneTimer.unref();
    if (o.counterFlushMs > 0) {
      counterTimer = setInterval(() => flushCounters(), o.counterFlushMs);
      counterTimer.unref();
    }
    probePublicExposure();
    const addr = server.address();
    const hostForUrl = host.includes(':') ? `[${host}]` : host;
    listenUrl = `http://${hostForUrl}:${addr.port}`;
    return { host, port: addr.port, url: listenUrl };
  }

  async function close() {
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = null;
    if (counterTimer) clearInterval(counterTimer);
    counterTimer = null;
    if (server) {
      const s = server;
      server = null;
      const done = new Promise((resolve) => s.close(() => resolve()));
      s.closeIdleConnections();
      const force = setTimeout(() => s.closeAllConnections(), 2000);
      force.unref();
      await done;
      clearTimeout(force);
    }
    try {
      // counters first, then one last snapshot, so that the next start replays nothing
      await flushCounters();
      if (events) {
        await events.idle();
        if (!events.faulted) await events.snapshot().catch((e) => log(`final snapshot failed: ${e.message}`));
      }
    } finally {
      try {
        if (lease) await lease.release();
      } finally {
        lease = null;
        if (store && store.close) store.close();
        if (releaseLock) releaseLock();
        releaseLock = null;
      }
    }
  }

  return {
    start,
    close,
    flush: flushCounters,
    snapshot: () => events.snapshot(),
    db,
    dataDir,
    stats,
    blobPath,
    get store() { return store; },
    get events() { return events; },
    today: () => dayKey(now()),
  };
}

module.exports = { createRegistry, HttpError, DEFAULT_DATA, DEFAULTS, CSP };
