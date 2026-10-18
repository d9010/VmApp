// Small HTTP helpers for the registry Worker: errors, JSON responses, headers. Same wire format as registry/lib/registry.js:
// errors are {"error": {"code", "message"}} with a fitting status.

export class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

// What every response carries. The API is read by the launcher and the CLI (no CORS needed); the public read endpoints also
// allow any web page to read them (the website may list apps), which is safe: they carry no cookie and no secret.
const BASE = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-cache',
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'X-Vmapp-Package-Id, X-Vmapp-Sha256, X-Vmapp-Version, X-Vmapp-Withdrawn, ETag',
};

export function headersFor(request, extra) {
  const h = Object.assign({}, BASE, extra);
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') Object.assign(h, CORS);
  return h;
}

/** A JSON response; a HEAD request gets the headers only. */
export function json(request, status, obj, extra) {
  const body = JSON.stringify(obj) + '\n';
  const h = headersFor(request, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra));
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: h });
}

export function errorResponse(request, e) {
  return json(request, e.status, { error: { code: e.code, message: e.message } }, e.headers);
}

/** The owner token of an Authorization header: null when absent, false when present but not "Bearer <64 hex>". */
export function bearer(request) {
  const h = request.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(h.trim());
  return m ? m[1].toLowerCase() : false;
}

export const unauthorized = (message) => new HttpError(401, 'unauthorized', message, { 'WWW-Authenticate': 'Bearer realm="vmapp-registry"' });

export function checkMethod(request, allowed) {
  if (!allowed.includes(request.method)) throw new HttpError(405, 'method_not_allowed', `use ${allowed.join(' or ')} for this URL`, { Allow: allowed.join(', ') });
}

/** The JSON body of a request, at most `max` bytes. {} for an empty body. */
export async function readJson(request, max = 8192) {
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > max) throw new HttpError(413, 'too_large', `the request body is larger than ${max} bytes`);
  if (!buf.length) return {};
  let v;
  try {
    v = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'bad_request', 'the body must be JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_request', 'the body must be a JSON object');
  return v;
}
