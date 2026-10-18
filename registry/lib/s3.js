'use strict';
// The `s3` storage backend: any S3-compatible object store (AWS S3, Cloudflare R2, MinIO) over plain HTTP(S), signed
// with lib/sigv4.js. Node built-ins only. Same keys and the same interface as the local backend (lib/store.js).
//
// Credentials come from the caller (the server reads them from the environment) and are used only to sign. They are
// never logged and never put in an error message.

const fs = require('fs');
const http = require('http');
const https = require('https');
const sigv4 = require('./sigv4');
const { checkKey, checkDeletable } = require('./store');

const MAX_BUFFER = 64 * 1024 * 1024; // the largest object read into memory (events and snapshots are small)

class S3Error extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function xmlUnescape(s) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
      default: return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

const xmlTag = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlUnescape(m[1]) : null;
};

function errorFrom(status, body, fallback) {
  const text = body ? body.toString('utf8') : '';
  const code = xmlTag(text, 'Code') || fallback || `HTTP${status}`;
  const msg = xmlTag(text, 'Message') || fallback || `the object store answered HTTP ${status}`;
  return new S3Error(status, code, `${msg} (${code}, HTTP ${status})`);
}

const RETRY_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'UND_ERR_SOCKET']);

class S3Client {
  /**
   * @param {object} c
   * @param {string} c.bucket
   * @param {string} c.accessKeyId
   * @param {string} c.secretAccessKey
   * @param {string} [c.sessionToken]
   * @param {string} [c.endpoint]   e.g. https://<account>.r2.cloudflarestorage.com or http://127.0.0.1:9000 (default: AWS S3 for the region)
   * @param {string} [c.region]     "auto" for R2 (default us-east-1)
   * @param {boolean} [c.pathStyle] bucket in the path instead of the host name (default: true when an endpoint is given)
   * @param {boolean} [c.conditionalPut] send If-None-Match: * on writes so that nothing is ever replaced (default true)
   */
  constructor(c) {
    if (!c || !c.bucket) throw new Error('s3: a bucket name is required');
    if (!c.accessKeyId || !c.secretAccessKey) throw new Error('s3: an access key id and secret are required');
    this.bucket = c.bucket;
    this.region = c.region || 'us-east-1';
    this.endpoint = String(c.endpoint || `https://s3.${this.region}.amazonaws.com`).replace(/\/+$/, '');
    const u = new URL(this.endpoint);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('s3: the endpoint must start with https:// or http://');
    this.pathStyle = c.pathStyle === undefined ? !!c.endpoint : !!c.pathStyle;
    this.conditionalPut = c.conditionalPut === undefined ? true : !!c.conditionalPut;
    this.timeoutMs = c.timeoutMs || 60000;
    this.retries = c.retries === undefined ? 3 : c.retries;
    this.retryDelayMs = c.retryDelayMs === undefined ? 250 : c.retryDelayMs;
    this.now = c.now || Date.now;
    // the secret lives only in this non-enumerable field: JSON.stringify, console.log and error messages never show it
    Object.defineProperty(this, '_cred', { value: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken || undefined }, enumerable: false });
    Object.defineProperty(this, '_agents', {
      value: { 'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }) },
      enumerable: false,
    });
  }

  /** Closes idle connections (the process can then exit). */
  close() {
    for (const a of Object.values(this._agents)) a.destroy();
  }

  toJSON() {
    return { endpoint: this.endpoint, bucket: this.bucket, region: this.region, pathStyle: this.pathStyle };
  }

  /** The URL of `key` (or of the bucket when key is empty), with `query` ([[name, value]]) appended. */
  urlFor(key = '', query = []) {
    const ep = new URL(this.endpoint);
    const enc = key ? key.split('/').map((s) => sigv4.uriEncode(s)).join('/') : '';
    let host = ep.host;
    let pathname;
    if (this.pathStyle) {
      pathname = `${ep.pathname.replace(/\/+$/, '')}/${this.bucket}${key ? '/' + enc : ''}`;
    } else {
      host = `${this.bucket}.${ep.host}`;
      pathname = `/${enc}`;
    }
    const qs = query.length ? '?' + query.map(([k, v]) => `${sigv4.uriEncode(k)}=${sigv4.uriEncode(v)}`).join('&') : '';
    return `${ep.protocol}//${host}${pathname}${qs}`;
  }

  /** One HTTP exchange; resolves with { status, headers, res } (res is the unread IncomingMessage). */
  _exchange(method, url, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proto = new URL(url).protocol;
      const lib = proto === 'https:' ? https : http;
      const req = lib.request(url, { method, headers, agent: this._agents[proto], timeout: timeoutMs }, (res) => resolve({ status: res.statusCode, headers: res.headers, res }));
      req.on('timeout', () => req.destroy(Object.assign(new Error('the object store did not answer in time'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (body && body.file) {
        const input = fs.createReadStream(body.file);
        input.on('error', (e) => req.destroy(e));
        input.pipe(req);
      } else {
        req.end(body || undefined);
      }
    });
  }

  /**
   * Signs and sends a request, retrying transient failures. Resolves with { status, headers, body (Buffer) }, or with
   * { status, headers, stream } when `stream` is true and the status is 2xx.
   * @param {object} o method, key, query, headers, body (Buffer | {file, size}), payloadHash, stream, okStatuses
   */
  async request(o) {
    const method = o.method;
    const url = this.urlFor(o.key || '', o.query || []);
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      let payloadHash = o.payloadHash;
      if (!payloadHash) payloadHash = Buffer.isBuffer(o.body) ? sigv4.sha256Hex(o.body) : sigv4.EMPTY_SHA256;
      const headers = Object.assign({}, o.headers);
      if (Buffer.isBuffer(o.body)) headers['Content-Length'] = String(o.body.length);
      else if (o.body && o.body.file) headers['Content-Length'] = String(o.body.size);
      else if (method === 'PUT' || method === 'POST') headers['Content-Length'] = '0';
      const signed = sigv4.signRequest({
        method, url, headers, payloadHash, date: this.now(), region: this.region, service: 's3', ...this._cred,
      });
      let ex;
      try {
        ex = await this._exchange(method, url, signed.headers, o.body, this.timeoutMs);
      } catch (e) {
        lastErr = new S3Error(0, e.code || 'NetworkError', `cannot reach the object store at ${new URL(this.endpoint).origin}: ${e.code || e.message}`);
        if (RETRY_CODES.has(e.code) || /socket hang up|aborted/.test(e.message)) continue;
        throw lastErr;
      }
      const ok = o.okStatuses ? o.okStatuses.includes(ex.status) : ex.status >= 200 && ex.status < 300;
      if (ok && o.stream) return { status: ex.status, headers: ex.headers, stream: ex.res };
      const chunks = [];
      let n = 0;
      try {
        for await (const c of ex.res) {
          n += c.length;
          if (n > MAX_BUFFER) throw new S3Error(ex.status, 'TooLarge', 'the object store sent an unexpectedly large answer');
          chunks.push(c);
        }
      } catch (e) {
        if (e instanceof S3Error) throw e;
        lastErr = new S3Error(ex.status, 'NetworkError', `the connection to the object store broke: ${e.code || e.message}`);
        continue;
      }
      const buf = Buffer.concat(chunks);
      if (ok) return { status: ex.status, headers: ex.headers, body: buf };
      const err = errorFrom(ex.status, buf);
      const retryable = ex.status >= 500 || ex.status === 429 || err.code === 'SlowDown' || err.code === 'RequestTimeout' || (ex.status === 409 && err.code === 'ConditionalRequestConflict');
      if (retryable && attempt < this.retries) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    throw lastErr || new S3Error(0, 'NetworkError', 'the object store could not be reached');
  }

  // ------------------------------------------------------------------------------------------ operations
  /** Throws unless the bucket can be listed with these credentials (used at start: fail early and clearly). */
  async checkAccess() {
    await this.request({ method: 'GET', query: [['list-type', '2'], ['max-keys', '1']] });
  }

  /** Creates the bucket (the tests do this for a throw-away MinIO; for AWS and R2 the bucket is made in the console). */
  async createBucket() {
    try {
      await this.request({ method: 'PUT' });
    } catch (e) {
      if (!(e instanceof S3Error) || !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(e.code)) throw e;
    }
  }

  /** { created } : writes the object unless it exists (If-None-Match: *). */
  async putObject(key, body, { contentType = 'application/octet-stream', payloadHash } = {}) {
    checkKey(key);
    const headers = { 'Content-Type': contentType };
    if (this.conditionalPut) headers['If-None-Match'] = '*';
    else if (await this.headObject(key)) return { created: false };
    try {
      await this.request({ method: 'PUT', key, headers, body, payloadHash });
      return { created: true };
    } catch (e) {
      if (e instanceof S3Error && e.status === 412) return { created: false };
      throw e;
    }
  }

  /** Overwrites an object. Only the writer lease uses this; nothing else is ever replaced. */
  async putMutable(key, body) {
    if (!key.startsWith('lease/')) throw new Error(`refusing to overwrite ${key}: only lease/ objects are mutable`);
    await this.request({ method: 'PUT', key: checkKey(key), headers: { 'Content-Type': 'application/json' }, body });
  }

  /** { size, etag, lastModified } or null. */
  async headObject(key) {
    try {
      const r = await this.request({ method: 'HEAD', key: checkKey(key) });
      return { size: Number(r.headers['content-length']), etag: r.headers.etag || null, mtimeMs: Date.parse(r.headers['last-modified'] || '') || 0 };
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return null;
      throw e;
    }
  }

  async getObject(key) {
    try {
      const r = await this.request({ method: 'GET', key: checkKey(key) });
      return r.body;
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return null;
      throw e;
    }
  }

  /** { stream, size, etag } or null. The caller must consume or destroy the stream. */
  async getObjectStream(key) {
    try {
      const r = await this.request({ method: 'GET', key: checkKey(key), stream: true });
      return { stream: r.stream, size: Number(r.headers['content-length']), etag: r.headers.etag || null };
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Server-side copy of src to dst. With `ifMatch` the copy happens only if the source still has that ETag (so a
   * client that overwrites a staged upload after it was verified cannot get the new bytes into a blob).
   * Throws S3Error 412 when the source changed.
   */
  async copyObject(src, dst, { ifMatch } = {}) {
    checkKey(src);
    checkKey(dst);
    const headers = { 'x-amz-copy-source': `/${this.bucket}/${src.split('/').map((s) => sigv4.uriEncode(s)).join('/')}` };
    if (ifMatch) headers['x-amz-copy-source-if-match'] = ifMatch;
    const r = await this.request({ method: 'PUT', key: dst, headers });
    // S3 can answer 200 and still carry an <Error> in the body
    if (/<Error>/.test(r.body.toString('utf8'))) throw errorFrom(500, r.body, 'CopyFailed');
    return { created: true };
  }

  async deleteObject(key) {
    checkDeletable(key);
    await this.request({ method: 'DELETE', key, okStatuses: [200, 204] });
    return true;
  }

  /** Yields { key, size, mtimeMs, etag } for every key with `prefix` that sorts after `startAfter`. */
  async *listObjects(prefix = '', { startAfter = '' } = {}) {
    let token = null;
    for (;;) {
      const q = [['list-type', '2'], ['max-keys', '1000']];
      if (prefix) q.push(['prefix', prefix]);
      if (startAfter) q.push(['start-after', startAfter]);
      if (token) q.push(['continuation-token', token]);
      const r = await this.request({ method: 'GET', query: q });
      const xml = r.body.toString('utf8');
      const re = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m;
      while ((m = re.exec(xml))) {
        yield {
          key: xmlTag(m[1], 'Key'), size: Number(xmlTag(m[1], 'Size')), mtimeMs: Date.parse(xmlTag(m[1], 'LastModified') || '') || 0, etag: xmlTag(m[1], 'ETag'),
        };
      }
      if (xmlTag(xml, 'IsTruncated') !== 'true') return;
      token = xmlTag(xml, 'NextContinuationToken');
      if (!token) return;
    }
  }

  /**
   * A presigned PUT URL for `key` that expires in `expiresSec` and accepts exactly `size` bytes (Content-Length is part of
   * the signature). The client sends the request with no other credentials.
   */
  presignPut(key, { size, expiresSec = 900 }) {
    checkKey(key);
    if (!Number.isInteger(size) || size < 1) throw new Error('presignPut needs the exact size');
    const date = this.now();
    const p = sigv4.presign({
      method: 'PUT', url: this.urlFor(key), headers: { 'content-length': String(size) }, expiresSec, date, region: this.region, service: 's3', ...this._cred,
    });
    return { url: p.url, method: 'PUT', headers: { 'Content-Length': String(size) }, expiresAt: p.expiresAt };
  }
}

/** The store interface (lib/store.js) on top of an S3Client. */
class S3Store {
  constructor(client, { log } = {}) {
    this.kind = 's3';
    this.client = client;
    this.supportsPresign = true;
    this.log = log || (() => {});
  }

  async init() {
    await this.client.checkAccess();
  }

  close() {
    this.client.close();
  }

  async put(key, data) {
    return this.client.putObject(key, data);
  }

  /** Streams the file with its SHA-256 (hex) known in advance, so the request is signed over the real payload hash. */
  async putFile(key, file, { sha256, size } = {}) {
    if (!sha256 || !size) throw new Error('S3Store.putFile needs sha256 and size');
    return this.client.putObject(key, { file, size }, { payloadHash: sha256 });
  }

  async get(key) {
    return this.client.getObject(key);
  }

  async head(key) {
    return this.client.headObject(key);
  }

  async getStream(key) {
    return this.client.getObjectStream(key);
  }

  list(prefix, opts) {
    return this.client.listObjects(prefix, opts);
  }

  async copy(src, dst, opts) {
    return this.client.copyObject(src, dst, opts);
  }

  async delete(key) {
    return this.client.deleteObject(key);
  }

  async putMutable(key, data) {
    return this.client.putMutable(key, data);
  }

  presignPut(key, opts) {
    return this.client.presignPut(key, opts);
  }

  describe() {
    return `bucket ${this.client.bucket} at ${this.client.endpoint}`;
  }
}

module.exports = { S3Client, S3Store, S3Error, xmlUnescape, xmlTag };
