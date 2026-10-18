'use strict';
// AWS Signature Version 4, written from the public specification (docs.aws.amazon.com, "Signature Version 4 signing
// process") with Node built-ins only. Two ways to sign:
//   signRequest(...)  the Authorization header form, for requests this server sends to the object store
//   presign(...)      the query-string form, for URLs handed to a client (a presigned PUT)
// tests/registry/sigv4.test.js checks both against the examples AWS publishes (S3 documentation, IAM documentation,
// the SigV4 test suite).
//
// S3 differs from the other AWS services in two ways, both handled by `s3: true`: the path is URI-encoded once (not
// twice) and is not normalised, and requests carry an x-amz-content-sha256 header.

const crypto = require('crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** RFC 3986 percent-encoding as SigV4 wants it: only A-Z a-z 0-9 - _ . ~ stay; "/" stays when keepSlash. */
function uriEncode(str, keepSlash = false) {
  let out = '';
  for (const b of Buffer.from(String(str), 'utf8')) {
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e) {
      out += String.fromCharCode(b);
    } else if (b === 0x2f && keepSlash) {
      out += '/';
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "20130524T000000Z" for a Date, epoch milliseconds, or a string that already has that form. */
function amzDate(date) {
  if (typeof date === 'string' && /^\d{8}T\d{6}Z$/.test(date)) return date;
  return new Date(date).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** The canonical URI. S3: every segment decoded and encoded once. Others: dot segments removed, the path as sent encoded again. */
function canonicalUri(pathname, s3) {
  if (!pathname) return '/';
  if (s3) return pathname.split('/').map((s) => uriEncode(safeDecode(s))).join('/') || '/';
  const parts = pathname.split('/');
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const p = parts[i];
    if (p === '' && !last) continue;
    if (p === '.') {
      if (last) out.push('');
      continue;
    }
    if (p === '..') {
      out.pop();
      if (last) out.push('');
      continue;
    }
    out.push(p);
  }
  return '/' + out.map((p) => uriEncode(p)).join('/');
}

/** Query parameters sorted by encoded name, then encoded value. `pairs` is an array of [name, value]. */
function canonicalQuery(pairs) {
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** {name: value|[values]} -> sorted [[lowercase name, trimmed value]]; repeated names are joined with ",". */
function normaliseHeaders(headers) {
  const map = new Map();
  for (const [name, raw] of Object.entries(headers || {})) {
    if (raw === undefined || raw === null) continue;
    const vals = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).trim().replace(/\s+/g, ' '));
    const k = name.toLowerCase();
    map.set(k, map.has(k) ? map.get(k) + ',' + vals.join(',') : vals.join(','));
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function canonicalRequest({ method, canonicalPath, canonicalQueryString, headerList, payloadHash }) {
  const canonicalHeaders = headerList.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerList.map(([k]) => k).join(';');
  return {
    text: [method.toUpperCase(), canonicalPath, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n'),
    signedHeaders,
  };
}

function stringToSign(amz, scope, canonicalRequestText) {
  return [ALGORITHM, amz, scope, sha256Hex(canonicalRequestText)].join('\n');
}

function checkCredentials(c) {
  if (!c || !c.accessKeyId || !c.secretAccessKey) throw new Error('sigv4: accessKeyId and secretAccessKey are required');
  if (!c.region || !c.service) throw new Error('sigv4: region and service are required');
}

/**
 * Signs a request. Returns { headers, authorization, signature, signedHeaders, canonicalRequest, stringToSign }.
 * `headers` is everything the request must carry (the headers passed in, plus x-amz-date, Authorization and, for S3,
 * x-amz-content-sha256 and x-amz-security-token); "host" is signed but not returned: the HTTP client sets it from the
 * URL, the same way.
 *
 * @param {object} o
 * @param {string} o.method
 * @param {string|URL} o.url
 * @param {object} [o.headers] headers to send and sign (Content-Type, Range, x-amz-copy-source, ...)
 * @param {string} [o.payloadHash] hex SHA-256 of the body, or "UNSIGNED-PAYLOAD" (default: the hash of an empty body)
 * @param {boolean} [o.s3] S3 rules (default: service === "s3")
 */
function signRequest(o) {
  checkCredentials(o);
  const s3 = o.s3 === undefined ? o.service === 's3' : o.s3;
  const url = typeof o.url === 'string' ? new URL(o.url) : o.url;
  const payloadHash = o.payloadHash || EMPTY_SHA256;
  const send = Object.assign({}, o.headers);
  const nameOf = (n) => Object.keys(send).find((k) => k.toLowerCase() === n);
  // the request's own x-amz-date (if the caller set one) is the signing date
  const given = nameOf('x-amz-date');
  const amz = given ? String(send[given]).trim() : amzDate(o.date === undefined ? Date.now() : o.date);
  if (!/^\d{8}T\d{6}Z$/.test(amz)) throw new Error('sigv4: x-amz-date must look like 20130524T000000Z');
  const dateStamp = amz.slice(0, 8);
  if (!given) send['x-amz-date'] = amz;
  if (s3 && !nameOf('x-amz-content-sha256')) send['x-amz-content-sha256'] = payloadHash;
  if (o.sessionToken && !nameOf('x-amz-security-token')) send['x-amz-security-token'] = o.sessionToken;
  const toSign = Object.assign({}, send);
  if (!Object.keys(toSign).some((k) => k.toLowerCase() === 'host')) toSign.host = url.host;
  const headerList = normaliseHeaders(toSign);
  const cr = canonicalRequest({
    method: o.method,
    canonicalPath: canonicalUri(url.pathname, s3),
    canonicalQueryString: canonicalQuery([...url.searchParams]),
    headerList,
    payloadHash,
  });
  const scope = `${dateStamp}/${o.region}/${o.service}/aws4_request`;
  const sts = stringToSign(amz, scope, cr.text);
  const signature = hmac(signingKey(o.secretAccessKey, dateStamp, o.region, o.service), sts).toString('hex');
  const authorization = `${ALGORITHM} Credential=${o.accessKeyId}/${scope},SignedHeaders=${cr.signedHeaders},Signature=${signature}`;
  send.Authorization = authorization;
  return { headers: send, authorization, signature, signedHeaders: cr.signedHeaders, canonicalRequest: cr.text, stringToSign: sts };
}

/**
 * A presigned URL (query-string authentication). `headers` are extra headers the client MUST send exactly as given,
 * for example {"content-length": "1234"}: they are part of the signature, so the object store refuses a request that
 * differs. Returns { url, signature, expiresAt (epoch ms), canonicalRequest, stringToSign }.
 */
function presign(o) {
  checkCredentials(o);
  const s3 = o.s3 === undefined ? o.service === 's3' : o.s3;
  const expires = o.expiresSec === undefined ? 900 : o.expiresSec;
  if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_SECONDS) throw new Error('sigv4: expiresSec must be 1..604800');
  const url = new URL(typeof o.url === 'string' ? o.url : o.url.href);
  const amz = amzDate(o.date === undefined ? Date.now() : o.date);
  const dateStamp = amz.slice(0, 8);
  const scope = `${dateStamp}/${o.region}/${o.service}/aws4_request`;
  const toSign = Object.assign({}, o.headers);
  if (!Object.keys(toSign).some((k) => k.toLowerCase() === 'host')) toSign.host = url.host;
  const headerList = normaliseHeaders(toSign);
  const signedHeaders = headerList.map(([k]) => k).join(';');
  const pairs = [...url.searchParams];
  pairs.push(['X-Amz-Algorithm', ALGORITHM], ['X-Amz-Credential', `${o.accessKeyId}/${scope}`], ['X-Amz-Date', amz], ['X-Amz-Expires', String(expires)], ['X-Amz-SignedHeaders', signedHeaders]);
  if (o.sessionToken) pairs.push(['X-Amz-Security-Token', o.sessionToken]);
  const cq = canonicalQuery(pairs);
  const cr = canonicalRequest({ method: o.method, canonicalPath: canonicalUri(url.pathname, s3), canonicalQueryString: cq, headerList, payloadHash: o.payloadHash || UNSIGNED_PAYLOAD });
  const sts = stringToSign(amz, scope, cr.text);
  const signature = hmac(signingKey(o.secretAccessKey, dateStamp, o.region, o.service), sts).toString('hex');
  const base = `${url.protocol}//${url.host}${url.pathname}`;
  return {
    url: `${base}?${cq}&X-Amz-Signature=${signature}`,
    signature,
    expiresAt: Date.parse(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`) + expires * 1000,
    canonicalRequest: cr.text,
    stringToSign: sts,
  };
}

module.exports = { ALGORITHM, EMPTY_SHA256, UNSIGNED_PAYLOAD, MAX_PRESIGN_SECONDS, uriEncode, amzDate, signingKey, canonicalUri, canonicalQuery, sha256Hex, signRequest, presign };
