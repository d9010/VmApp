// The registry as a Durable Object: one instance holds the event log (SQLite) and the state, and serves the whole API.
// It is the Worker port of registry/lib/registry.js: the same endpoints, status codes and error codes, and the same state
// rules (registry/lib/state.js, db.js, versions.js, listing.js, present.js are used unchanged). What differs is only where
// things live (events in SQLite, packages in R2) and that a package is verified as a stream (src/verify.js) because a Worker
// has 128 MB of memory and packages go up to 512 MiB.
//
// Not ported yet (they answer 501): email and domain verification of publishers (they need a mailer and DNS lookups).

import { DurableObject } from 'cloudflare:workers';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ID_RE, SEMVER_RE, compareVersions, ManifestError } from '../../hostlib/manifest.js';
import { Db, DAY_MS, hasOwn } from '../../registry/lib/db.js';
import { EventError } from '../../registry/lib/state.js';
import { RateLimiter } from '../../registry/lib/ratelimit.js';
import * as present from '../../registry/lib/present.js';
import * as versionsLib from '../../registry/lib/versions.js';
import { SORTS, queryApps } from '../../registry/lib/listing.js';
import { ProfileError, parseProfile, parseProfileHeader, publicView } from '../../registry/lib/publisher.js';
import { SqlStore } from './events.js';
import { HttpError, json, errorResponse, bearer, unauthorized, checkMethod, readJson, headersFor } from './http.js';
import { verifyPackageStream, VerifyError } from './verify.js';

const MIB = 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000; // an upload id lives this long
const MAX_PENDING_UPLOADS = 5000;
const WORKER_UPLOAD_MAX = 95 * MIB; // Cloudflare's proxy accepts request bodies of at most 100 MB on the Free and Pro plans
const COUNTER_FLUSH_MS = 5 * 60 * 1000; // download counters are folded into the log at most this often
const STAGING_MAX_AGE_MS = 2 * DAY_MS;

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const validId = (s) => typeof s === 'string' && s.length >= 3 && s.length <= 100 && ID_RE.test(s);
const validVersion = (s) => typeof s === 'string' && s.length <= 64 && SEMVER_RE.test(s);
const blobKey = (sha) => `blobs/sha256/${sha.slice(0, 2)}/${sha}.vmapp`;
const stagingKey = (uploadId) => `staging/${uploadId}.vmapp`;

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.maxPackageBytes = Math.floor((Number(env.MAX_PACKAGE_MIB) || 512) * MIB);
    this.db = new Db();
    this.store = new SqlStore(ctx.storage.sql, this.db);
    this.salt = randomBytes(16); // only in memory: hashed addresses cannot be correlated across restarts
    this.seen = new Map(); // download de-duplication: "<address hash>|<id>|<version>" -> time of the last counted download
    this.apiLimiter = new RateLimiter(Number(env.API_PER_MINUTE) || 300, 60 * 1000);
    this.publishLimiter = new RateLimiter(Number(env.PUBLISH_PER_HOUR) || 10, 3600 * 1000);
    this.chain = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => {
      this.store.load();
    });
  }

  /** Serialises the "check, store, save" step of publishing (awaits inside it could otherwise interleave two publishes). */
  exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  clientKey(request) {
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    return createHash('sha256').update(this.salt).update(ip).digest('hex').slice(0, 24);
  }

  // ------------------------------------------------------------------------------------------------ entry
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headersFor(request) });
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await this.api(request, url, this.clientKey(request));
      if (url.pathname === '/robots.txt') {
        return new Response('User-agent: *\nDisallow: /\n', { headers: headersFor(request, { 'Content-Type': 'text/plain; charset=utf-8' }) });
      }
      if (url.pathname === '/') return Response.redirect(this.env.SITE_URL || 'https://vmapp.dev/', 302);
      throw new HttpError(404, 'not_found', 'not found');
    } catch (e) {
      if (e instanceof ProfileError) e = new HttpError(400, 'bad_request', e.message);
      else if (e instanceof EventError) e = new HttpError(409, 'conflict', e.message);
      if (e instanceof HttpError) return errorResponse(request, e);
      console.error(`internal error: ${e && e.stack}`);
      return errorResponse(request, new HttpError(500, 'internal', 'internal server error'));
    }
  }

  // ------------------------------------------------------------------------------------------------ routing
  apiGuard(key) {
    const lim = this.apiLimiter.hit(key);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', `too many requests; try again in ${lim.retryAfterSec} s`, { 'Retry-After': String(lim.retryAfterSec) });
  }

  async api(request, url, key) {
    this.apiGuard(key);
    const seg = url.pathname.split('/').slice(2); // after "", "api"
    const R = (status, obj, extra) => json(request, status, obj, extra);

    if (seg[0] === 'info' && seg.length === 1) {
      checkMethod(request, ['GET', 'HEAD']);
      return R(200, this.info());
    }
    if (seg[0] === 'stats' && seg.length === 1) {
      checkMethod(request, ['GET', 'HEAD']);
      return R(200, this.stats());
    }
    if (seg[0] === 'publish' && seg.length === 1) {
      checkMethod(request, ['POST']);
      return R(201, await this.publishDirect(request, key));
    }
    if (seg[0] === 'publish' && seg.length === 2 && (seg[1] === 'init' || seg[1] === 'complete')) {
      checkMethod(request, ['POST']);
      if (seg[1] === 'init') return R(200, await this.publishInit(request, key));
      return R(201, await this.publishComplete(request));
    }
    if (seg[0] === 'uploads' && seg.length === 2) {
      checkMethod(request, ['PUT']);
      return R(200, await this.receiveUpload(request, seg[1]));
    }
    if (seg[0] === 'publisher') return this.publisherApi(request, seg);
    if (seg[0] === 'admin') return this.adminApi(request, seg);
    if (seg[0] === 'apps') {
      if (seg.length === 1) {
        checkMethod(request, ['GET', 'HEAD']);
        return R(200, this.listApps(url));
      }
      const id = this.parseId(seg[1]);
      if (seg.length === 2) {
        checkMethod(request, ['GET', 'HEAD']);
        return R(200, present.details(this.db, this.appOr404(id)));
      }
      if (seg.length === 3 && seg[2] === 'versions') {
        checkMethod(request, ['GET', 'HEAD']);
        return R(200, versionsLib.sortedDesc(this.appOr404(id)).map(present.versionEntry));
      }
      if (seg.length === 3 && seg[2] === 'resolve') {
        checkMethod(request, ['GET', 'HEAD']);
        return R(200, this.resolveApi(url, id));
      }
      if (seg.length === 4 && (seg[3] === 'withdraw' || seg[3] === 'restore')) {
        checkMethod(request, ['POST']);
        return R(200, await this.setWithdrawn(request, id, seg[2], seg[3] === 'restore'));
      }
      if (seg.length === 4 && seg[3] === 'download') {
        checkMethod(request, ['GET', 'HEAD']);
        return this.download(request, id, this.parseVersion(seg[2]), key);
      }
    }
    throw new HttpError(404, 'not_found', 'no such API endpoint');
  }

  parseId(s) {
    if (!validId(s)) throw new HttpError(400, 'bad_request', 'invalid app id (reverse-DNS such as com.example.app)');
    return s;
  }

  parseVersion(s) {
    if (s !== 'latest' && !validVersion(s)) throw new HttpError(400, 'bad_request', 'invalid version (semver such as 1.2.3, or "latest")');
    return s;
  }

  appOr404(id) {
    const app = this.db.getApp(id);
    if (!app) throw new HttpError(404, 'not_found', `no app "${id}"`);
    return app;
  }

  // ------------------------------------------------------------------------------------------------ reading
  info() {
    return { name: 'vmapp-registry', publishModes: ['direct', 'presigned'], downloads: 'direct', maxPackageBytes: this.maxPackageBytes };
  }

  stats() {
    let versions = 0;
    let downloads = 0;
    const apps = this.db.apps();
    for (const a of apps) {
      versions += Object.keys(a.versions).length;
      downloads += this.db.appDownloads(a);
    }
    return { apps: apps.length, versions, downloads };
  }

  listApps(url) {
    const intParam = (name, def, min, max) => {
      const v = url.searchParams.get(name);
      if (v === null || v === '') return def;
      if (!/^\d{1,9}$/.test(v)) throw new HttpError(400, 'bad_request', `${name} must be a non-negative integer`);
      return Math.min(max, Math.max(min, Number(v)));
    };
    const sort = url.searchParams.get('sort') || 'popular';
    if (!SORTS.includes(sort)) throw new HttpError(400, 'bad_request', `sort must be one of ${SORTS.join(', ')}`);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length > 100) throw new HttpError(400, 'bad_request', 'q is too long (100 characters at most)');
    const limit = intParam('limit', 50, 1, 100);
    const offset = intParam('offset', 0, 0, 1e9);
    const { total, items } = queryApps(this.db, { sort, q, limit, offset });
    return { total, limit, offset, sort, q, items };
  }

  /** GET /api/apps/:id/resolve?choice=compatible|latest&from=<semver> -> {version} | {version: null} */
  resolveApi(url, id) {
    const app = this.appOr404(id);
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

  // ------------------------------------------------------------------------------------------------ downloads
  /** GET /api/apps/:id/:version/download: the package streamed from R2 (the bucket is private; this is the only way to a package). */
  async download(request, id, versionParam, key) {
    const app = this.db.getApp(id);
    if (!app) throw new HttpError(404, 'not_found', `no app "${id}"`);
    const version = versionParam === 'latest' ? versionsLib.newestAvailable(app) : versionParam;
    if (version === null) throw new HttpError(404, 'all_withdrawn', `every version of ${id} is withdrawn; ask for one by its exact version`);
    if (!hasOwn(app.versions, version)) throw new HttpError(404, 'not_found', `${id} has no version ${version}`);
    const v = app.versions[version];
    const etag = `"${v.sha256}"`;
    const headers = {
      'X-Vmapp-Package-Id': v.packageId,
      'X-Vmapp-Sha256': v.sha256,
      'X-Vmapp-Version': version,
      ETag: etag,
    };
    if (versionsLib.isWithdrawn(v)) headers['X-Vmapp-Withdrawn'] = encodeURIComponent(v.withdrawn.reason);
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: headersFor(request, headers) });
    const head = request.method === 'HEAD';
    let obj;
    try {
      obj = head ? await this.env.PACKAGES.head(blobKey(v.sha256)) : await this.env.PACKAGES.get(blobKey(v.sha256));
    } catch (e) {
      console.error(`storage: cannot read ${blobKey(v.sha256)}: ${e.message}`);
      throw new HttpError(502, 'storage_error', 'the package cannot be read from storage right now');
    }
    if (!obj) {
      console.error(`storage: missing ${blobKey(v.sha256)}`);
      throw new HttpError(500, 'storage_error', 'the package file is missing on the server');
    }
    Object.assign(headers, {
      'Content-Type': 'application/x-vmapp',
      'Content-Disposition': `attachment; filename="${id}-${version}.vmapp"`,
      'Content-Length': String(obj.size),
    });
    if (!head) await this.countDownload(app, version, key);
    return new Response(head ? null : obj.body, { status: 200, headers: headersFor(request, headers) });
  }

  async countDownload(app, version, key) {
    const k = `${key}|${app.id}|${version}`;
    const t = Date.now();
    const last = this.seen.get(k);
    if (last !== undefined && t - last < DAY_MS) return;
    if (this.seen.size >= 200000) for (const [kk, vv] of this.seen) if (t - vv >= DAY_MS) this.seen.delete(kk);
    if (this.seen.size >= 200000) return;
    this.seen.set(k, t);
    this.store.addDownload(app, version);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(t + COUNTER_FLUSH_MS);
  }

  /** Folds the download counters into the log, and clears out expired and abandoned uploads. */
  async alarm() {
    this.store.flushCounters((fn) => this.ctx.storage.transactionSync(fn));
    const expired = this.store.expireUploads(Date.now());
    for (const k of expired) await this.env.PACKAGES.delete(k).catch(() => {});
    // staging objects nobody completed (a client that never came back), older than two days
    let listed = await this.env.PACKAGES.list({ prefix: 'staging/', limit: 200 });
    for (const o of listed.objects) {
      if (Date.now() - o.uploaded.getTime() > STAGING_MAX_AGE_MS && !this.store.getUpload(o.key.slice('staging/'.length, -'.vmapp'.length))) {
        await this.env.PACKAGES.delete(o.key).catch(() => {});
      }
    }
    void listed;
    if (this.db.pendingItems().length) await this.ctx.storage.setAlarm(Date.now() + COUNTER_FLUSH_MS);
  }

  // ------------------------------------------------------------------------------------------------ publishing
  publisherOf(token) {
    if (!token) throw unauthorized('send your owner token as "Authorization: Bearer <owner token>"');
    const pub = this.db.publisherByTokenHash(sha256hex(token));
    if (!pub) throw new HttpError(403, 'forbidden', 'unknown owner token');
    return pub;
  }

  authorize(app, token, doing = 'publish a new version') {
    if (!token) throw unauthorized(`${app.id} already exists: ${doing} with "Authorization: Bearer <owner token>"`);
    const pub = this.db.publisherByTokenHash(sha256hex(token));
    if (!pub || pub.id !== app.publisherId) throw new HttpError(403, 'forbidden', `that token does not own ${app.id}`);
    return pub;
  }

  publishGuard(key) {
    const lim = this.publishLimiter.hit(key);
    if (!lim.ok) throw new HttpError(429, 'rate_limited', `too many publishes from this address; try again in ${lim.retryAfterSec} s`, { 'Retry-After': String(lim.retryAfterSec) });
  }

  profileOf(request) {
    try {
      const h = request.headers.get('x-vmapp-publisher');
      return parseProfileHeader(h === null ? undefined : h);
    } catch (e) {
      throw new HttpError(400, 'bad_request', e.message);
    }
  }

  /** Stores the request body in R2 under `skey`, exactly `size` bytes (a different length is refused). */
  async putStaged(request, skey, size) {
    const { readable, writable } = new FixedLengthStream(size);
    const pump = request.body.pipeTo(writable);
    try {
      await Promise.all([this.env.PACKAGES.put(skey, readable), pump]);
    } catch (e) {
      await pump.catch(() => {});
      await this.env.PACKAGES.delete(skey).catch(() => {});
      throw new HttpError(400, 'upload_aborted', `upload failed: ${e.message}`);
    }
  }

  /** POST /api/publish {raw package}: for packages that fit through the proxy; the same steps as init, PUT and complete in one call. */
  async publishDirect(request, key) {
    this.publishGuard(key);
    const ct = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream' && ct !== 'application/x-vmapp') {
      throw new HttpError(415, 'unsupported_media_type', 'send the raw .vmapp bytes with Content-Type: application/octet-stream');
    }
    const cl = request.headers.get('content-length');
    if (cl === null || !/^\d{1,15}$/.test(cl)) throw new HttpError(411, 'length_required', 'send a Content-Length header with the package size');
    const size = Number(cl);
    if (size === 0) throw new HttpError(400, 'bad_request', 'empty upload');
    if (size > this.maxPackageBytes) throw new HttpError(413, 'too_large', `package is larger than the limit of ${this.maxPackageBytes} bytes`);
    if (size > WORKER_UPLOAD_MAX) throw new HttpError(413, 'too_large', `a direct upload can be at most ${WORKER_UPLOAD_MAX} bytes; use POST /api/publish/init for larger packages`);
    const token = bearer(request);
    if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    const profile = this.profileOf(request);
    const skey = stagingKey(crypto.randomUUID());
    await this.putStaged(request, skey, size);
    try {
      return await this.finishFromStaging({ skey, announced: null, token, profile });
    } finally {
      await this.env.PACKAGES.delete(skey).catch(() => {});
    }
  }

  /** POST /api/publish/init {size, sha256} -> where to PUT the package. */
  async publishInit(request, key) {
    this.publishGuard(key);
    const token = bearer(request);
    if (token) this.publisherOf(token); // a token that no publisher has is refused now, not after the upload
    else if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    const body = await readJson(request);
    const size = body.size;
    const sha256 = typeof body.sha256 === 'string' ? body.sha256.toLowerCase() : '';
    if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'bad_request', 'size must be the package size in bytes');
    if (size > this.maxPackageBytes) throw new HttpError(413, 'too_large', `package is larger than the limit of ${this.maxPackageBytes} bytes`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, 'bad_request', 'sha256 must be the SHA-256 of the package in hex');
    if (size > WORKER_UPLOAD_MAX) {
      throw new HttpError(413, 'too_large_for_proxy', `this registry accepts uploads of at most ${Math.floor(WORKER_UPLOAD_MAX / MIB)} MiB for now; larger packages need direct-to-storage uploads, which are not enabled yet`);
    }
    for (const k of this.store.expireUploads(Date.now())) await this.env.PACKAGES.delete(k).catch(() => {});
    if (this.store.countUploads() >= MAX_PENDING_UPLOADS) throw new HttpError(429, 'rate_limited', 'too many uploads are waiting; try again later', { 'Retry-After': '60' });
    const uploadId = crypto.randomUUID();
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    this.store.putUpload({ id: uploadId, size, sha256, key: stagingKey(uploadId), expiresAt });
    const origin = new URL(request.url).origin;
    return { uploadId, method: 'PUT', url: `${origin}/api/uploads/${uploadId}`, headers: {}, expiresAt: new Date(expiresAt).toISOString(), size };
  }

  /** PUT /api/uploads/:uploadId: the package bytes. The upload id (a random UUID) is the capability. */
  async receiveUpload(request, uploadId) {
    const row = /^[0-9a-f-]{36}$/.test(uploadId) ? this.store.getUpload(uploadId) : null;
    if (!row || Date.now() > row.expiresAt) throw new HttpError(404, 'unknown_upload', 'that upload is unknown or has expired (15 minutes); start again with POST /api/publish/init');
    const cl = request.headers.get('content-length');
    if (cl === null || Number(cl) !== row.size) throw new HttpError(400, 'upload_mismatch', `send exactly the ${row.size} bytes announced in init (with a Content-Length header)`);
    await this.putStaged(request, row.key, row.size);
    this.store.markUploaded(row.id);
    return { uploaded: true, size: row.size };
  }

  /** POST /api/publish/complete {uploadId}: verify what was uploaded, then publish it. */
  async publishComplete(request) {
    const token = bearer(request);
    if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    const profile = this.profileOf(request);
    const body = await readJson(request);
    const row = typeof body.uploadId === 'string' && /^[0-9a-f-]{36}$/.test(body.uploadId) ? this.store.getUpload(body.uploadId) : null;
    if (!row || Date.now() > row.expiresAt) throw new HttpError(404, 'unknown_upload', 'that upload is unknown or has expired (15 minutes); start again with POST /api/publish/init');
    if (row.completes >= 5) throw new HttpError(429, 'rate_limited', 'this upload was checked too many times; start again with POST /api/publish/init');
    this.store.bumpCompletes(row.id);
    if (!row.uploaded) throw new HttpError(400, 'upload_missing', 'nothing has been uploaded for this upload id: PUT the package to the URL first');
    const result = await this.finishFromStaging({ skey: row.key, announced: { size: row.size, sha256: row.sha256 }, token, profile });
    this.store.deleteUpload(row.id);
    await this.env.PACKAGES.delete(row.key).catch(() => {});
    return result;
  }

  /** Verifies the staged package as a stream, then publishes it (see finishPublish). */
  async finishFromStaging({ skey, announced, token, profile }) {
    const staged = await this.env.PACKAGES.get(skey);
    if (!staged) throw new HttpError(400, 'upload_missing', 'the uploaded object is missing; upload again');
    if (announced && staged.size !== announced.size) throw new HttpError(400, 'upload_mismatch', `the uploaded object is ${staged.size} bytes, not the ${announced.size} announced`);
    if (staged.size > this.maxPackageBytes) throw new HttpError(413, 'too_large', `package is larger than the limit of ${this.maxPackageBytes} bytes`);
    let info;
    try {
      info = await verifyPackageStream(staged.body, { maxBytes: this.maxPackageBytes });
    } catch (e) {
      if (e instanceof VerifyError || e instanceof ManifestError) throw new HttpError(400, 'invalid_package', e.message);
      console.error(`verification failed unexpectedly: ${e && e.stack}`);
      throw new HttpError(502, 'storage_error', 'reading the uploaded package failed; try again');
    }
    if (announced && (info.size !== announced.size || info.sha256 !== announced.sha256)) {
      throw new HttpError(400, 'upload_mismatch', 'the uploaded bytes are not the size and SHA-256 announced in init');
    }
    return this.finishPublish({ skey, etag: staged.etag, info, token, profile });
  }

  /** Ownership and version checks, the blob, then the events. One publish at a time. */
  finishPublish({ skey, etag, info, token, profile }) {
    const m = info.manifest;
    return this.exclusive(async () => {
      const app = this.db.getAppAny(m.id);
      let ownerToken = null;
      let publisher;
      let newPublisher = null;
      const created = !app;
      if (app && app.hidden) throw new HttpError(409, 'app_hidden', `${m.id} was taken down by the registry operator and cannot be published to`);
      if (created) {
        if (token) {
          publisher = this.publisherOf(token); // a new app id under the publisher that owns this token
        } else {
          // a new publisher: the first publish creates the record and the owner token (shown once)
          ownerToken = randomBytes(32).toString('hex');
          const p = profile || parseProfile();
          newPublisher = { id: 'pub-' + randomBytes(8).toString('hex'), tokenHash: sha256hex(ownerToken), name: p.name, company: p.company, email: p.email, url: p.url };
          publisher = newPublisher;
        }
      } else {
        publisher = this.authorize(app, token);
        if (hasOwn(app.versions, m.version)) throw new HttpError(409, 'version_exists', `${m.id} ${m.version} is already published; versions are immutable, publish a higher version`);
        if (compareVersions(m.version, app.latest) <= 0) {
          throw new HttpError(409, 'version_not_newer', `${m.version} is not newer than the latest published version ${app.latest}`);
        }
      }
      await this.storeBlob(skey, etag, info);
      this.ctx.storage.transactionSync(() => {
        if (newPublisher) this.store.append('publisher.created', newPublisher.id, newPublisher);
        const stripped = Object.assign({}, info.manifest);
        delete stripped.files;
        this.store.append('app.published', publisher.id, {
          id: m.id, version: m.version, sha256: info.sha256, size: info.size, packageId: info.packageId, publisherId: publisher.id,
          meta: { manifest: stripped, files: { count: Object.keys(info.manifest.files).length, uiBytes: info.uiBytes, coreBytes: info.coreBytes, hasIcon: info.hasIcon } },
        });
      });
      console.log(`published ${m.id} ${m.version}${created ? ' (new app)' : ''}`);
      const body = {
        id: m.id, version: m.version, packageId: info.packageId, sha256: info.sha256, size: info.size,
        created, url: `/apps/${m.id}`, publisher: publicView(this.db.getPublisher(publisher.id)),
      };
      if (ownerToken) body.ownerToken = ownerToken;
      return body;
    });
  }

  /**
   * Puts the package at blobs/sha256/<hh>/<sha256>.vmapp unless it is already there (blobs are written once and the name is
   * the hash). R2 itself checks that the bytes written have the SHA-256 in the name, and the staged object must still be the
   * one that was verified (its ETag).
   */
  async storeBlob(skey, etag, info) {
    const bkey = blobKey(info.sha256);
    try {
      const have = await this.env.PACKAGES.head(bkey);
      if (have) {
        if (have.size !== info.size) throw new HttpError(500, 'storage_error', `a different object already holds the name of this package (${bkey}); the operator must look at it`);
        return;
      }
      const src = await this.env.PACKAGES.get(skey);
      if (!src) throw new HttpError(409, 'upload_changed', 'the uploaded object disappeared after it was verified; upload it again');
      if (src.etag !== etag) {
        await src.body.cancel();
        throw new HttpError(409, 'upload_changed', 'the uploaded object changed after it was verified; upload it again');
      }
      const { readable, writable } = new FixedLengthStream(info.size);
      const pump = src.body.pipeTo(writable);
      await Promise.all([this.env.PACKAGES.put(bkey, readable, { sha256: info.sha256 }), pump]);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error(`storage: cannot store ${bkey}: ${e.message}`);
      throw new HttpError(502, 'storage_error', 'the package could not be stored; nothing was published, try again');
    }
  }

  /** POST /api/apps/:id/:version/withdraw {reason} and .../restore (owner token). Both are idempotent. */
  async setWithdrawn(request, id, version, restore) {
    if (!validVersion(version)) throw new HttpError(400, 'bad_request', 'invalid version (semver such as 1.2.3)');
    const app = this.appOr404(id);
    const token = bearer(request);
    if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    const pub = this.authorize(app, token, restore ? 'restore a version' : 'withdraw a version');
    const rec = hasOwn(app.versions, version) ? app.versions[version] : null;
    if (!rec) throw new HttpError(404, 'not_found', `${id} has no version ${version}`);
    const body = await readJson(request);
    let reason = null;
    if (!restore) {
      try {
        reason = versionsLib.checkReason(body.reason);
      } catch (e) {
        throw new HttpError(400, 'bad_request', e.message);
      }
    }
    await this.exclusive(async () => {
      if (restore) {
        if (versionsLib.isWithdrawn(rec)) this.store.append('version.restored', pub.id, { id, version }); // restoring a version that is not withdrawn is a no-op
      } else {
        this.store.append('version.withdrawn', pub.id, { id, version, reason });
      }
    });
    return { id, version, withdrawn: present.withdrawnView(rec) };
  }

  // ------------------------------------------------------------------------------------------------ publisher identity
  async publisherApi(request, seg) {
    if (seg.length !== 2) throw new HttpError(404, 'not_found', 'no such API endpoint');
    const action = seg[1];
    const notYet = () => new HttpError(501, 'not_supported', 'email and domain verification are not available on this registry yet');
    if (action === 'confirm-email') throw notYet();
    const token = bearer(request);
    if (token === false) throw unauthorized('the Authorization header must be "Bearer <owner token>"');
    const pub = this.publisherOf(token);
    const mine = () => ({
      publisher: publicView(pub),
      profile: { name: pub.name, company: pub.company, email: pub.email, url: pub.url }, // the owner's own claims
      emailVerified: !!pub.emailVerified,
      domainVerified: !!pub.domain,
      pendingEmail: false,
      pendingDomain: null,
      apps: this.db.apps().filter((a) => a.publisherId === pub.id).map((a) => a.id),
    });
    switch (action) {
      case 'me':
        checkMethod(request, ['GET', 'HEAD']);
        return json(request, 200, mine());
      case 'profile': {
        checkMethod(request, ['POST']);
        const p = parseProfile(await readJson(request));
        if (p.name !== pub.name || p.company !== pub.company || p.email !== pub.email || p.url !== pub.url) {
          await this.exclusive(async () => {
            this.store.append('publisher.updated', pub.id, { id: pub.id, name: p.name, company: p.company, email: p.email, url: p.url });
          });
        }
        return json(request, 200, mine());
      }
      case 'verify-email':
      case 'verify-domain':
      case 'check-domain':
        throw notYet();
      default:
        throw new HttpError(404, 'not_found', 'no such API endpoint');
    }
  }

  // ------------------------------------------------------------------------------------------------ operator
  /** POST /api/admin/apps/:id/hide {reason} and .../unhide, with the ADMIN_TOKEN secret: take an app down without deleting anything. */
  async adminApi(request, seg) {
    const secret = this.env.ADMIN_TOKEN;
    const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(String(secret || '')).digest();
    if (!secret || !timingSafeEqual(a, b)) throw new HttpError(secret ? 403 : 404, secret ? 'forbidden' : 'not_found', secret ? 'not allowed' : 'no such API endpoint');
    if (seg.length === 4 && seg[1] === 'apps' && (seg[3] === 'hide' || seg[3] === 'unhide')) {
      checkMethod(request, ['POST']);
      const id = this.parseId(seg[2]);
      const app = this.db.getAppAny(id);
      if (!app) throw new HttpError(404, 'not_found', `no app "${id}"`);
      const body = await readJson(request);
      await this.exclusive(async () => {
        if (seg[3] === 'hide') {
          const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 400) : '';
          if (!reason) throw new HttpError(400, 'bad_request', 'a reason is required');
          if (!app.hidden) this.store.append('app.hidden', 'admin', { id, reason });
        } else if (app.hidden) {
          this.store.append('app.unhidden', 'admin', { id });
        }
      });
      return json(request, 200, { id, hidden: !!this.db.getAppAny(id).hidden });
    }
    throw new HttpError(404, 'not_found', 'no such API endpoint');
  }
}
