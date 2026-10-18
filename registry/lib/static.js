'use strict';
// The web UI's static files, read once at start. Only files that exist in registry/public/ at start can be served,
// and a request's path is only ever used as a key into this table (never joined to a directory).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Returns a Map of file name -> { body, type, etag }. */
function loadStatic(dir) {
  const files = new Map();
  for (const name of fs.readdirSync(dir)) {
    const type = TYPES[path.extname(name).toLowerCase()];
    const full = path.join(dir, name);
    if (!type || !fs.statSync(full).isFile()) continue;
    const body = fs.readFileSync(full);
    files.set(name, { body, type, etag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 20)}"` });
  }
  if (!files.has('index.html') || !files.has('app.html') || !files.has('publish.html')) {
    throw new Error(`${dir} must contain index.html, app.html and publish.html`);
  }
  return files;
}

module.exports = { loadStatic };
