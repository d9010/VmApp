'use strict';
// A small in-memory S3-compatible server for the tests, so that the whole s3 code path (signing, conditional writes,
// listing with pages, server-side copy, presigned PUT, retries) runs in the normal test suite without Docker. It checks
// every signature (header and query form) with registry/lib/sigv4.js; the vectors in sigv4.test.js and the MinIO run
// (s3-minio.test.js) are what show that the signing itself is right. Behaviour copied from S3: If-None-Match: * ->
// 412, x-amz-copy-source-if-match -> 412, payload hash mismatch -> 400, expired presigned URL -> 403.

const http = require('http');
const crypto = require('crypto');
const sigv4 = require('../../registry/lib/sigv4');

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

class FakeS3 {
  constructor(o = {}) {
    this.bucket = o.bucket || 'vmapp-test';
    this.accessKeyId = o.accessKeyId || 'AKIAFAKEACCESSKEY1234';
    this.secretAccessKey = o.secretAccessKey || crypto.randomBytes(20).toString('hex');
    this.region = o.region || 'us-east-1';
    this.pageSize = o.pageSize || 1000;
    this.broken = o.broken || {}; // { ifNoneMatch: true } ignores If-None-Match; { copyIfMatch: true } ignores x-amz-copy-source-if-match
    this.objects = new Map(); // key -> { body, etag, mtimeMs }
    this.requests = []; // { method, key, query }
    this.injected = []; // { match, status, code, times }
    this.server = null;
    this.endpoint = '';
  }

  /** Makes the next `times` requests that `match(req info)` accepts fail with this status / code. */
  inject(match, status, code, times = 1) {
    this.injected.push({ match, status, code, times });
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      try {
        this.send(res, 500, 'InternalError', `fake s3 crashed: ${e.stack}`);
      } catch {
        /* response already started */
      }
    }));
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
      resolve(this);
    }));
  }

  stop() {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  /** The settings to give createRegistry / S3Client. */
  config(extra = {}) {
    return Object.assign({ type: 's3', bucket: this.bucket, endpoint: this.endpoint, region: this.region, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, pathStyle: true }, extra);
  }

  keys(prefix = '') {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  send(res, status, code, message) {
    const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><RequestId>fake</RequestId></Error>`);
    res.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': body.length });
    res.end(body);
  }

  /** null if the request is signed correctly, else { status, code, message }. */
  authenticate(req, url, body) {
    const h = req.headers;
    const q = url.searchParams;
    const fail = (status, code, message) => ({ status, code, message });
    let creds;
    let signature;
    let signedNames;
    let amz;
    let payloadHash = 'UNSIGNED-PAYLOAD';
    let expires = null;
    if (q.get('X-Amz-Algorithm')) {
      creds = q.get('X-Amz-Credential') || '';
      signature = q.get('X-Amz-Signature') || '';
      signedNames = (q.get('X-Amz-SignedHeaders') || '').split(';');
      amz = q.get('X-Amz-Date') || '';
      expires = Number(q.get('X-Amz-Expires'));
    } else {
      const m = /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(h.authorization || '');
      if (!m) return fail(403, 'AccessDenied', 'missing or malformed Authorization');
      [, creds, , signature] = m;
      signedNames = m[2].split(';');
      amz = h['x-amz-date'] || '';
      payloadHash = h['x-amz-content-sha256'] || '';
      if (!payloadHash) return fail(400, 'InvalidRequest', 'missing x-amz-content-sha256');
    }
    const [akid, , region, service] = creds.split('/');
    if (akid !== this.accessKeyId) return fail(403, 'InvalidAccessKeyId', 'unknown access key');
    if (region !== this.region || service !== 's3') return fail(403, 'AuthorizationHeaderMalformed', 'wrong region or service in the credential scope');
    const t = Date.parse(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
    if (!Number.isFinite(t)) return fail(403, 'AccessDenied', 'bad x-amz-date');
    const headers = {};
    for (const n of signedNames) {
      if (h[n] === undefined) return fail(403, 'SignatureDoesNotMatch', `signed header ${n} is not in the request`);
      headers[n] = h[n];
    }
    const full = `http://${h.host}${req.url}`;
    let calc;
    if (expires !== null) {
      if (Date.now() > t + expires * 1000) return fail(403, 'AccessDenied', 'Request has expired');
      const u = new URL(full);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('X-Amz-')) u.searchParams.delete(k);
      calc = sigv4.presign({ method: req.method, url: u, headers, date: amz, expiresSec: expires, region, service, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }).signature;
    } else {
      if (Math.abs(Date.now() - t) > 15 * 60 * 1000) return fail(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.');
      calc = sigv4.signRequest({ method: req.method, url: full, headers, payloadHash, region, service, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }).signature;
      if (/^[0-9a-f]{64}$/.test(payloadHash) && sigv4.sha256Hex(body) !== payloadHash) return fail(400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.');
    }
    if (calc !== signature) return fail(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
    return null;
  }

  async handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/');
    const bucket = parts[1];
    const key = parts.slice(2).map((s) => decodeURIComponent(s)).join('/');
    const info = { method: req.method, key, query: Object.fromEntries(url.searchParams) };
    this.requests.push(info);
    for (const inj of this.injected) {
      if (inj.times > 0 && inj.match(info)) {
        inj.times--;
        return this.send(res, inj.status, inj.code, 'injected failure');
      }
    }
    const bad = this.authenticate(req, url, body);
    if (bad) return this.send(res, bad.status, bad.code, bad.message);
    if (bucket !== this.bucket) return this.send(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');

    if (!key) {
      if (req.method === 'PUT') {
        res.writeHead(200, { 'Content-Length': 0 });
        return res.end();
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') return this.list(res, url);
      return this.send(res, 405, 'MethodNotAllowed', 'not supported by the fake');
    }
    const now = Date.now();
    switch (req.method) {
      case 'PUT': {
        const src = req.headers['x-amz-copy-source'];
        let data = body;
        if (src) {
          const m = /^\/([^/]+)\/(.+)$/.exec(src);
          const skey = m ? m[2].split('/').map((s) => decodeURIComponent(s)).join('/') : '';
          const obj = this.objects.get(skey);
          if (!obj) return this.send(res, 404, 'NoSuchKey', 'The specified key does not exist.');
          const ifm = req.headers['x-amz-copy-source-if-match'];
          if (ifm && ifm !== obj.etag && !this.broken.copyIfMatch) return this.send(res, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
          data = obj.body;
        }
        if (req.headers['if-none-match'] === '*' && this.objects.has(key) && !this.broken.ifNoneMatch) return this.send(res, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
        const etag = `"${md5(data)}"`;
        this.objects.set(key, { body: Buffer.from(data), etag, mtimeMs: now });
        if (src) {
          const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${new Date(now).toISOString()}</LastModified><ETag>${etag}</ETag></CopyObjectResult>`);
          res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': xml.length });
          return res.end(xml);
        }
        res.writeHead(200, { ETag: etag, 'Content-Length': 0 });
        return res.end();
      }
      case 'GET':
      case 'HEAD': {
        const obj = this.objects.get(key);
        if (!obj) {
          if (req.method === 'HEAD') {
            res.writeHead(404);
            return res.end();
          }
          return this.send(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        }
        res.writeHead(200, { 'Content-Length': obj.body.length, ETag: obj.etag, 'Last-Modified': new Date(obj.mtimeMs).toUTCString(), 'Content-Type': 'application/octet-stream' });
        return res.end(req.method === 'HEAD' ? undefined : obj.body);
      }
      case 'DELETE':
        this.objects.delete(key);
        res.writeHead(204);
        return res.end();
      default:
        return this.send(res, 405, 'MethodNotAllowed', 'not supported by the fake');
    }
  }

  list(res, url) {
    const prefix = url.searchParams.get('prefix') || '';
    const startAfter = url.searchParams.get('start-after') || '';
    const token = url.searchParams.get('continuation-token');
    const max = Math.min(Number(url.searchParams.get('max-keys')) || 1000, this.pageSize);
    const after = token ? Buffer.from(token, 'base64url').toString('utf8') : startAfter;
    const all = this.keys(prefix).filter((k) => k > after);
    const page = all.slice(0, max);
    const truncated = all.length > page.length;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
      truncated ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]).toString('base64url')}</NextContinuationToken>` : ''
    }${page.map((k) => {
      const o = this.objects.get(k);
      return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${new Date(o.mtimeMs).toISOString()}</LastModified><ETag>${o.etag}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    }).join('')}</ListBucketResult>`;
    const buf = Buffer.from(xml);
    res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': buf.length });
    res.end(buf);
  }
}

module.exports = { FakeS3 };
