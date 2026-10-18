'use strict';
// Fixture of the vmapp-ui protocol handler.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function respond(status, body, type, csp) {
  return new Response(body, { status, headers: { 'content-type': type, 'content-security-policy': csp } });
}

function cleanRelPath(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.includes('\\') || rel.includes('\0')) return null;
  if (rel.split('/').some((c) => c === '' || c === '.' || c === '..')) return null;
  return rel;
}

function createAppUiHandler(contexts) {
  return async function handleAppUi(request) {
    const notFound = () => respond(404, 'Not found', 'text/plain', APP_CSP);
    const u = new URL(request.url);
    const ctx = contexts.get(u.hostname);
    if (!ctx) return notFound();
    const rel = cleanRelPath(u.pathname);
    if (!rel) return notFound();
    const m = ctx.app.manifest;
    const key = `${m.ui.root}/${rel}`;
    const want = Object.prototype.hasOwnProperty.call(m.files, key) ? m.files[key] : null;
    if (!want) return notFound();
    const file = path.join(ctx.app.dir, ...key.split('/'));
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) return notFound();
      const data = await fs.promises.readFile(file);
      const got = crypto.createHash('sha256').update(data).digest('hex');
      if (got !== want) return notFound();
      return respond(200, data, 'text/html', APP_CSP);
    } catch {
      return notFound();
    }
  };
}

module.exports = { APP_CSP, createAppUiHandler, cleanRelPath };
