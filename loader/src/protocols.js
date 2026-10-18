'use strict';
// The two custom protocols (registered as privileged schemes once, before app ready; see main.js):
//   vmapp-ui://<app id>/<path>   the UI files of an installed app (SPEC 7), served per app partition
//   vmapp-loader://ui/<file>     the loader's own UI;  vmapp-loader://icon/<app id>  an app's icon

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SPEC 7: the CSP on every response of vmapp-ui. The renderer has no network of its own.
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// SPEC 7: the window features an app may declare (manifest ui.features, SPEC 2.2). Each one adds exactly these sources to APP_CSP for
// that app's pages; a directive whose value is 'none' is replaced, a missing one is added. Only "network" adds network sources, and
// only for data (https: and, for connections, wss:): never for scripts, workers, frames or objects. What it names still leaves only
// through the app's window endpoint, under the app's network grants (window-net.js, SPEC 8.3 "The app's windows").
const UI_FEATURE_CSP = Object.freeze({
  workers: Object.freeze({ 'worker-src': Object.freeze(["'self'", 'blob:']) }),
  wasm: Object.freeze({ 'script-src': Object.freeze(["'wasm-unsafe-eval'"]) }),
  'self-fetch': Object.freeze({ 'connect-src': Object.freeze(["'self'"]) }),
  frames: Object.freeze({ 'frame-src': Object.freeze(['vmapp-frame:']) }),
  network: Object.freeze({
    'connect-src': Object.freeze(['https:', 'wss:']),
    'img-src': Object.freeze(['https:']),
    'media-src': Object.freeze(['https:']),
    'font-src': Object.freeze(['https:']),
    'style-src': Object.freeze(['https:']),
  }),
});

// SPEC 7: the CSP of every vmapp-frame:// response (isolated frames, ui.features "frames"). A frame is its own origin, gets no
// window.vmapp and no permission; inside it, web content may run inline scripts, eval, WebAssembly, workers and service workers.
// The `https:` sources let content name https URLs that the frame's own service worker answers (web content refers to its resources
// that way: VS Code's webviews use https://*.vscode-resource.vscode-cdn.net). They are not network: the partition's request filter
// (window-manager.js allowedSchemes) cancels every http(s)/ws(s) request that leaves the frame, so only what the service worker
// answers itself ever arrives, except, for an app that declares the window feature "network", https DATA requests (images, media,
// fonts, style sheets, fetch) that the filter lets out to the app's window endpoint (window-net.js): never a script, a frame or a
// worker from the network. `base-uri https:` for the same reason: such content sets <base href="https://…"> to resolve its relative
// links (VS Code's Markdown preview does); a base URL only changes how URLs are spelled, not where requests may go.
const FRAME_CSP =
  "default-src 'self' vmapp-frame: blob: data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: https:; " +
  "style-src 'self' 'unsafe-inline' blob: data: https:; img-src 'self' blob: data: https:; media-src 'self' blob: data: https:; " +
  "font-src 'self' blob: data: https:; connect-src 'self' blob: data: https:; worker-src 'self' blob:; frame-src 'self' blob: data:; " +
  "object-src 'none'; base-uri 'self' https:; form-action 'none'";

/** The CSP of an app's vmapp-ui pages: APP_CSP plus exactly the sources of the features the manifest declares (SPEC 7). */
function appCsp(features) {
  const list = Array.isArray(features) ? features : [];
  if (!list.length) return APP_CSP;
  const dirs = APP_CSP.split(';').map((p) => p.trim().split(/\s+/)).filter((t) => t[0]);
  const byName = new Map(dirs.map((t) => [t[0], t]));
  for (const f of list) {
    const add = UI_FEATURE_CSP[f];
    if (!add) continue; // the manifest validation refuses unknown features; an unknown one adds nothing here
    for (const [name, srcs] of Object.entries(add)) {
      let d = byName.get(name);
      if (!d) {
        d = [name];
        dirs.push(d);
        byName.set(name, d);
      }
      if (d.length === 2 && d[1] === "'none'") d.length = 1;
      for (const s of srcs) if (!d.includes(s)) d.push(s);
    }
  }
  return dirs.map((t) => t.join(' ')).join('; ');
}

// The loader's own pages: no inline script, no inline style, no network.
const LOADER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; " +
  "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function respond(status, body, type, csp) {
  return new Response(body, {
    status,
    headers: {
      'content-type': type,
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

/** Validates a URL path ("/a/b.js") into a clean relative path or null. */
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

/**
 * Handler for vmapp-ui. `contexts` maps app id -> { app (Store.get result), verified: Map(key -> {size, mtimeMs}) }.
 * Only files listed in the manifest's `files` are served, and only when their SHA-256 matches; the verified
 * (size, mtime) is cached per session so a file is hashed once until it changes on disk.
 */
function createAppUiHandler(contexts, log = () => {}) {
  return async function handleAppUi(request) {
    const notFound = () => respond(404, 'Not found', 'text/plain; charset=utf-8', APP_CSP);
    if (request.method !== 'GET' && request.method !== 'HEAD') return respond(405, 'Method not allowed', 'text/plain; charset=utf-8', APP_CSP);
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return notFound();
    }
    const ctx = contexts.get(u.hostname);
    if (!ctx) return notFound();
    return serveVerified(ctx, u, request, appCsp(ctx.app.manifest.ui.features), log);
  };
}

/**
 * Handler for vmapp-frame (SPEC 7, isolated frames) in the partition of app `appId`: vmapp-frame://<label>/<path> serves the same
 * verified files as vmapp-ui://<appId>/<path>, with FRAME_CSP, and only for an app whose manifest declares the feature "frames".
 * The label only makes the origin: every label is its own origin, so a frame can never read the app's page or another frame.
 */
function createAppFrameHandler(contexts, appId, log = () => {}) {
  return async function handleAppFrame(request) {
    const notFound = () => respond(404, 'Not found', 'text/plain; charset=utf-8', FRAME_CSP);
    if (request.method !== 'GET' && request.method !== 'HEAD') return respond(405, 'Method not allowed', 'text/plain; charset=utf-8', FRAME_CSP);
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return notFound();
    }
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(u.hostname)) return notFound();
    const ctx = contexts.get(appId);
    if (!ctx || !(ctx.app.manifest.ui.features || []).includes('frames')) return notFound();
    return serveVerified(ctx, u, request, FRAME_CSP, log);
  };
}

/** Serves one package file of `ctx` for URL `u`: listed in the manifest, SHA-256 checked (INV-B4), with `csp`. */
async function serveVerified(ctx, u, request, csp, log) {
  const notFound = () => respond(404, 'Not found', 'text/plain; charset=utf-8', csp);
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
    const seen = ctx.verified.get(key);
    if (!(seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs && data.length === st.size)) {
      const got = crypto.createHash('sha256').update(data).digest('hex');
      if (got !== want) {
        log(`vmapp-ui: ${key} does not match the manifest hash; refusing to serve it`);
        return notFound();
      }
      ctx.verified.set(key, { size: st.size, mtimeMs: st.mtimeMs });
    }
    return respond(200, request.method === 'HEAD' ? null : data, mimeOf(file), csp);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`vmapp-ui: ${key}: ${e.message}`);
    return notFound();
  }
}

/** Handler for vmapp-loader: ui/<file> from the loader's ui folder, icon/<app id> from the installed package. */
function createLoaderHandler({ uiDir, getIconPath }) {
  return async function handleLoader(request) {
    const notFound = () => respond(404, 'Not found', 'text/plain; charset=utf-8', LOADER_CSP);
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return notFound();
    }
    const rel = cleanRelPath(u.pathname);
    if (!rel) return notFound();
    try {
      if (u.hostname === 'ui') {
        if (!/^[A-Za-z0-9_.-]+$/.test(rel) || !MIME[path.extname(rel).toLowerCase()]) return notFound();
        const data = await fs.promises.readFile(path.join(uiDir, rel));
        return respond(200, data, mimeOf(rel), LOADER_CSP);
      }
      if (u.hostname === 'icon') {
        const p = getIconPath(rel);
        if (!p) return notFound();
        return respond(200, await fs.promises.readFile(p), 'image/png', LOADER_CSP);
      }
    } catch {
      /* fall through */
    }
    return notFound();
  };
}

module.exports = { APP_CSP, FRAME_CSP, UI_FEATURE_CSP, LOADER_CSP, appCsp, createAppUiHandler, createAppFrameHandler, createLoaderHandler, cleanRelPath, mimeOf };
