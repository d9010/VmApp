'use strict';
// Per-app versions and updates from a registry (SPEC 8.1). THE ONE MODULE with network code on the loader side.
//
// INV-G3 (no telemetry, user-initiated network only): nothing in this file runs by itself. Its functions are reached
// only from paths the user chose:
//   - "Browse registry…" (File menu or library button) and its search box: one page of the app list of the launcher's
//     registry (browseRegistry() below), asked for when the user opens the sheet, presses Search, changes the sort or
//     presses "Show more"; never by itself, never at start-up, never ahead of time. Installing from a card downloads
//     that app from the same registry (the user pressed Install),
//   - "Check for updates" and "Versions…" -> "Show versions from the registry" (the user clicked),
//   - Launch of an app whose update choice the user set to "Latest compatible" or "Always latest",
//   - "Publish…" on an app's card, after the user filled in the sheet and pressed Publish (publish() below),
//   - the CLI commands `vmapp versions --registry`, `vmapp update` (the user ran them).
// Requests carry the app id, the installed version (`from=`) and the update choice: nothing else. (Browsing: the search
// text, the sort order and the page, nothing else.) No identifiers, no
// list of other apps, no cookies, no custom user agent. Redirects are not followed, with ONE exception: a package
// download. A registry whose packages live in object storage answers `.../download` with a 302 to the package on its
// public storage address (registry/README.md, "Storage"); that single hop is followed (never from https to http, never
// again) and what arrives is checked against the registry's own headers exactly as a direct download is. Node built-ins
// only (http / https), which is why check-invariants has nothing to flag in loader/: the loader requires this file but
// has no network API of its own.
//
// Verification (INV-F1): a download goes to $VMAPP_HOME/tmp, its sha256 must equal X-Vmapp-Sha256, the package must
// pass hostlib/package.js, its package id must equal X-Vmapp-Package-Id, and its id and version must be the ones asked
// for. The storage the redirect points at is never trusted: both headers come from the registry's response, not from
// the storage's. Only then is it handed on (and installed by Store.install, which verifies again). Whether to install is
// always decided by the caller (loader UI or CLI), never here (INV-B5, INV-D3): this module never grants anything.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('./package');
const { ID_RE, SEMVER_RE, RUNTIMES, compareVersions } = require('./manifest');
const { normalizeRegistryUrl } = require('./store');
const { netDiff } = require('./network');

/** The app registry of a packaged launcher: the one "Browse registry…" lists and installs from. Not a setting in the UI. */
const PUBLIC_REGISTRY = 'https://api.vmapp.dev';
/** The registry of a development launcher (`npm start`): a registry running on this Mac. */
const DEFAULT_DEV_REGISTRY = 'http://127.0.0.1:8790';
const CHECK_TIMEOUT_MS = 5000;
const TMP_PREFIX = 'vmapp-dl-';
const MAX_JSON = 4 * 1024 * 1024;
const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The address a registry redirected a package download (or told an upload) to. Absolute http(s), no credentials in it,
 * and never plain http when the registry itself is https. Throws UpdateError.
 */
function storageTarget(registryUrl, location) {
  let u;
  try {
    u = new URL(String(location || ''), registryUrl);
  } catch {
    throw new UpdateError('Refused: the registry pointed to a storage address that is not valid.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UpdateError('Refused: the registry pointed to a storage address that is neither https nor http.');
  if (u.username || u.password) throw new UpdateError('Refused: the registry pointed to a storage address with a password in it.');
  if (u.protocol === 'http:' && new URL(registryUrl).protocol === 'https:') throw new UpdateError('Refused: the registry sent a secure (https) download to a plain http address.');
  return u.href;
}

class UpdateError extends Error {
  /** @param {{offline?: boolean, status?: number, code?: string}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'UpdateError';
    this.offline = !!info.offline;
    this.status = info.status || null;
    this.code = info.code || null;
  }
}

// ------------------------------------------------------------------------------------------------ pure helpers

const isPrerelease = (v) => v.includes('-');

/** Same "line" as `from`: the same major; for 0.x the same minor too (SPEC 8.1 "compatible"). */
function sameLine(from, v) {
  const a = SEMVER_RE.exec(from);
  const b = SEMVER_RE.exec(v);
  if (!a || !b) return false;
  if (a[1] !== b[1]) return false;
  return a[1] !== '0' || a[2] === b[2];
}

/**
 * The version an update choice picks from a registry's version list, never lower than or equal to `from`, never a
 * withdrawn one, a pre-release only if `from` is one. `choice` is 'compatible' | 'latest'; anything else gives null.
 */
function pickCandidate(versions, choice, from) {
  if (choice !== 'compatible' && choice !== 'latest') return null;
  let best = null;
  for (const v of versions) {
    if (v.withdrawn) continue;
    if (isPrerelease(v.version) && !isPrerelease(from)) continue;
    if (compareVersions(v.version, from) <= 0) continue;
    if (choice === 'compatible' && !sameLine(from, v.version)) continue;
    if (!best || compareVersions(v.version, best) > 0) best = v.version;
  }
  return best;
}

/** The newest version a user can install without being told it was withdrawn (stable ones first), or null. */
function newestInstallable(versions) {
  const ok = versions.filter((v) => !v.withdrawn);
  const stable = ok.filter((v) => !isPrerelease(v.version));
  let best = null;
  for (const v of stable.length ? stable : ok) if (!best || compareVersions(v.version, best) > 0) best = v.version;
  return best;
}

/**
 * Host capabilities (SPEC 8.1 / 8.2) the new manifest requests that the old one did not: `screen`, `input`, `tool:<id>`,
 * `tool:*`, `mcp:<id>`, `mcp:*`. A narrower request is not news: `tool:echo` is covered by an old `tool:*` (and
 * `mcp:<id>` by `mcp:*`); the other way round (`tool:echo` -> `tool:*`) is added. `control` is INV-H6's "requests
 * control of your computer" (input, tool:*, mcp:*). `removed` lists the caps the new version no longer asks for.
 * @returns {{added: {cap: string, purpose: string, control: boolean}[], removed: string[]}}
 */
function hostDiff(oldManifest, newManifest) {
  const list = (m) => ((m && m.permissions && m.permissions.host) || []).filter((h) => h && typeof h.cap === 'string');
  const oldList = list(oldManifest);
  const newList = list(newManifest);
  // SPEC 8.7: `gpu` with an `api` (the experimental Vulkan GPU) is another capability than the plain `gpu` (llama.cpp RPC).
  const keyOf = (h) => (h.cap === 'gpu' && h.api ? `gpu:${h.api}` : h.cap);
  const oldCaps = new Set(oldList.map(keyOf));
  const newCaps = new Set(newList.map(keyOf));
  const covered = (cap, caps) => {
    if (caps.has(cap)) return true;
    const m = /^(tool|mcp):(?!\*$)/.exec(cap);
    return !!m && caps.has(`${m[1]}:*`);
  };
  const added = newList
    .filter((h) => !covered(keyOf(h), oldCaps))
    .map((h) => ({ cap: h.cap, ...(h.api ? { api: h.api } : {}), purpose: h.purpose || '', control: h.cap === 'input' || h.cap.endsWith(':*') }));
  const removed = oldList.filter((h) => !covered(keyOf(h), newCaps)).map(keyOf);
  return { added, removed };
}

/**
 * Devices (SPEC 2.2 permissions.devices, SPEC 7) the new manifest requests that the old one did not: a newly requested
 * microphone always stops and asks (SPEC 8.1). It is never granted by the update: it stays off until the user allows
 * it in the permission sheet. `removed` lists the devices the new version no longer asks for (informational).
 * @returns {{added: {device: string, purpose: string}[], removed: string[]}}
 */
function deviceDiff(oldManifest, newManifest) {
  const list = (m) => ((m && m.permissions && m.permissions.devices) || []).filter((d) => d && typeof d.device === 'string');
  const oldNames = new Set(list(oldManifest).map((d) => d.device));
  const newNames = new Set(list(newManifest).map((d) => d.device));
  const added = list(newManifest).filter((d) => !oldNames.has(d.device)).map((d) => ({ device: d.device, purpose: d.purpose || '' }));
  const removed = [...oldNames].filter((n) => !newNames.has(n));
  return { added, removed };
}

/**
 * What a new version asks for beyond the old one (SPEC 8.1): added folder requests, raised access
 * (read -> readwrite, writeonly -> readwrite; also read -> writeonly, which gains the ability to write),
 * dialogs / external turned on, and added host capabilities (`hostAdded`, see hostDiff). `any` is true when the user
 * must be asked. `removed` and `hostRemoved` are informational only. A newly requested device (the microphone) is
 * `devicesAdded` (see deviceDiff) and also forces the question. So does added network reach (`netAdded`: a new host, a
 * wider wildcard or more ports on a host, SPEC 8.3, see network.netDiff); `netRemoved` is informational.
 * @returns {{added: object[], raised: object[], removed: string[], dialogs: boolean, external: boolean,
 *   hostAdded: object[], hostRemoved: string[], devicesAdded: object[], devicesRemoved: string[], any: boolean}}
 */
function permissionDiff(oldManifest, newManifest) {
  const oldF = new Map(((oldManifest && oldManifest.permissions && oldManifest.permissions.folders) || []).map((f) => [f.name, f]));
  const newF = (newManifest.permissions && newManifest.permissions.folders) || [];
  const added = [];
  const raised = [];
  for (const f of newF) {
    const o = oldF.get(f.name);
    if (!o) {
      added.push({ name: f.name, access: f.access, purpose: f.purpose || '' });
      continue;
    }
    const gainsWrite = f.access !== o.access && (f.access === 'readwrite' || (f.access === 'writeonly' && o.access === 'read'));
    if (gainsWrite) raised.push({ name: f.name, from: o.access, to: f.access, purpose: f.purpose || '' });
  }
  const newNames = new Set(newF.map((f) => f.name));
  const removed = [...oldF.keys()].filter((n) => !newNames.has(n));
  const op = (oldManifest && oldManifest.permissions) || {};
  const np = newManifest.permissions || {};
  const dialogs = !!np.dialogs && !op.dialogs;
  const external = !!np.external && !op.external;
  const host = hostDiff(oldManifest, newManifest);
  const devs = deviceDiff(oldManifest, newManifest);
  const net = netDiff(oldManifest, newManifest);
  return {
    added,
    raised,
    removed,
    dialogs,
    external,
    hostAdded: host.added,
    hostRemoved: host.removed,
    devicesAdded: devs.added,
    devicesRemoved: devs.removed,
    // network reach (SPEC 8.3): a new host, a wider wildcard or more ports; also forces the question
    netAdded: net.added,
    netRemoved: net.removed,
    any: added.length > 0 || raised.length > 0 || dialogs || external || host.added.length > 0 || devs.added.length > 0 || net.added.length > 0,
  };
}

/**
 * Turns what the user typed into { registry, id }. Accepts a bare app id (the registry then comes from
 * `defaultRegistry`) or the address of an app's page on a registry: <registry>/apps/<id> (or /app/<id>).
 * Throws UpdateError with a plain message otherwise. The id is validated against the manifest id pattern.
 */
function parseAppRef(input, defaultRegistry) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) throw new UpdateError('Enter an app id (like com.example.notes) or the address of its page in the registry.');
  const checkId = (id) => {
    if (id.length < 3 || id.length > 100 || !ID_RE.test(id)) throw new UpdateError(`“${id.slice(0, 60)}” is not a valid app id.`);
    return id;
  };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const registry = normalizeRegistryUrl(defaultRegistry || '');
    if (!registry) throw new UpdateError('Enter the registry address first.');
    return { registry, id: checkId(s) };
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new UpdateError('That address is not valid.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UpdateError('Only http:// and https:// addresses are supported.');
  if (u.username || u.password) throw new UpdateError('Addresses with a user name or password are not supported.');
  const parts = u.pathname.split('/');
  let at = -1;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'apps' || parts[i] === 'app') {
      at = i;
      break;
    }
  }
  if (at < 0 || !parts[at + 1]) throw new UpdateError('That address does not look like an app page (expected …/apps/<app id>).');
  let id;
  try {
    id = decodeURIComponent(parts[at + 1]);
  } catch {
    throw new UpdateError('That address is not valid.');
  }
  const registry = normalizeRegistryUrl(u.origin + parts.slice(0, at).join('/'));
  if (!registry) throw new UpdateError('That address is not valid.');
  return { registry, id: checkId(id) };
}

/** Plain http to anything but this computer: the download and its checksum travel together, unprotected. */
function isInsecureRemote(registry) {
  try {
    const u = new URL(registry);
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ HTTP

function netError(e, url) {
  const code = e && e.code;
  const where = new URL(url).origin;
  if (e instanceof UpdateError) return e;
  if (code && OFFLINE_CODES.has(code)) return new UpdateError(`Cannot reach the registry at ${where} (${code}).`, { offline: true, code });
  return new UpdateError(`Network error talking to ${where}: ${(e && e.message) || e}`, { offline: true, code });
}

function lib(url) {
  return new URL(url).protocol === 'https:' ? https : http;
}

function describeHttpError(status, body) {
  try {
    const j = JSON.parse(body);
    if (j && j.error && j.error.message) return `${j.error.message} (HTTP ${status})`;
  } catch {
    /* not JSON */
  }
  return `the registry answered HTTP ${status}`;
}

/**
 * GET a URL and return { status, headers, body (Buffer) } within `deadlineMs` in total. Redirects are not followed.
 * Rejects with UpdateError (offline: true for connection problems and timeouts).
 */
function getBuffer(url, deadlineMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = lib(url).get(url, { agent: false, headers: { Accept: 'application/json', Connection: 'close' } }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_JSON) {
          req.destroy();
          done(reject, new UpdateError('The registry sent an unexpectedly large answer.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => done(reject, netError(e, url)));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new UpdateError(`The registry at ${new URL(url).origin} did not answer in time.`, { offline: true, code: 'ETIMEDOUT' }));
    }, Math.max(1, deadlineMs));
    req.on('error', (e) => done(reject, netError(e, url)));
  });
}

async function getJson(url, deadlineMs) {
  const r = await getBuffer(url, deadlineMs);
  const text = r.body.toString('utf8');
  if (r.status !== 200) throw new UpdateError(describeHttpError(r.status, text), { status: r.status });
  try {
    return JSON.parse(text);
  } catch {
    throw new UpdateError('The registry sent an answer that is not valid JSON.');
  }
}

// ------------------------------------------------------------------------------------------------ browsing
// "Browse registry…": GET /api/apps?sort=&q=&limit=&offset= (registry/README.md, "API"). What comes back is written by publishers
// (names, descriptions) and by the registry (the publisher's label and level), none of it checked by this loader, so it is cut down
// to a fixed set of fields here: text with its control, invisible and direction-changing characters removed and a length cap,
// numbers that are whole and not negative, an app id and a version that match the manifest patterns, a runtime from the known list.
// Anything else the registry sent is dropped. The loader's UI inserts these as text nodes only.

/** The sort orders of GET /api/apps. */
const BROWSE_SORTS = ['new', 'popular', 'updated', 'name']; // the first is the default: the newest apps
const BROWSE_PAGE = 20;
const BROWSE_MAX_PAGE = 50;
const BROWSE_MAX_Q = 100; // the registry refuses a longer search text itself (400)
const BROWSE_MAX_OFFSET = 1000000;
// What the registry presents about a publisher (registry/lib/publisher.js publicView): only these levels exist.
const PUBLISHER_LEVELS = ['unverified', 'email', 'domain'];
// What is removed from a registry's text: C0 and C1 controls (0-1F, 7F-9F), the soft hyphen (AD), zero-width characters and direction
// marks (200B-200F), line and paragraph separators and the bidirectional overrides and embeddings (2028-202E), the word joiner,
// invisible operators and the bidirectional isolates (2060-206F) and the byte order mark (FEFF). Built from numbers, so that no
// invisible character has to sit in this source file.
const UNSAFE_TEXT_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const hex4 = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
const UNSAFE_TEXT_RE = new RegExp(`[${UNSAFE_TEXT_RANGES.map(([a, b]) => `${hex4(a)}-${hex4(b)}`).join('')}]`, 'g');

/** `v` as one line of plain text of at most `max` characters (a longer one ends in …), or '' when it is not a string. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let t = s.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1); // not half of a surrogate pair
  return `${t.trimEnd()}…`;
}

const wholeNumber = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);

/** One list item of the registry, cut down to what the Browse sheet shows; null when it cannot be installed (no usable id or version). */
function browseItem(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const id = typeof x.id === 'string' ? x.id : '';
  if (id.length < 3 || id.length > 100 || !ID_RE.test(id)) return null;
  const latestVersion = typeof x.latestVersion === 'string' && x.latestVersion.length <= 64 && SEMVER_RE.test(x.latestVersion) ? x.latestVersion : null;
  if (!latestVersion) return null;
  const pub = x.publisher && typeof x.publisher === 'object' && !Array.isArray(x.publisher) ? x.publisher : {};
  return {
    id,
    name: cleanText(x.name, 100) || id,
    // exactly what the registry presents (its "display only verified facts" rule is the registry's); the level only picks the style
    publisher: { level: PUBLISHER_LEVELS.includes(pub.level) ? pub.level : 'unknown', label: cleanText(pub.label, 200) },
    description: cleanText(x.description, 600),
    latestVersion,
    runtime: RUNTIMES.includes(x.runtime) ? x.runtime : '',
    downloads: wholeNumber(x.downloads),
    sizeBytes: wholeNumber(x.sizeBytes),
    permissionsSummary: cleanText(x.permissionsSummary, 1000),
  };
}

/**
 * What a Browse request asks for, checked: { q, sort, offset, limit }. Throws UpdateError for a search text the registry would
 * refuse or a sort it does not know. `o` = { q?, sort?, offset?, limit? } (anything else is ignored).
 */
function browseParams(o = {}) {
  const q = typeof o.q === 'string' ? o.q.replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim() : '';
  if (q.length > BROWSE_MAX_Q) throw new UpdateError(`The search text can have at most ${BROWSE_MAX_Q} characters.`);
  const sort = o.sort === undefined || o.sort === null || o.sort === '' ? 'new' : o.sort;
  if (!BROWSE_SORTS.includes(sort)) throw new UpdateError('That sort order is not one the registry offers.');
  const offset = Number.isSafeInteger(o.offset) && o.offset > 0 ? Math.min(o.offset, BROWSE_MAX_OFFSET) : 0;
  const limit = Number.isSafeInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, BROWSE_MAX_PAGE) : BROWSE_PAGE;
  return { q, sort, offset, limit };
}

/**
 * The registry's answer to GET /api/apps as the Browse sheet gets it. `ask` = browseParams(...) of the request (the answer's own
 * echo of q / sort / offset is ignored). `next` is the offset to ask for to continue, or null when there is nothing more.
 * Throws UpdateError for an answer that is not a list.
 * @returns {{registry: string, q: string, sort: string, offset: number, limit: number, total: number, next: number|null, items: object[]}}
 */
function cleanBrowseList(j, registry, ask) {
  const raw = j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.items) ? j.items : null;
  if (!raw) throw new UpdateError('The registry sent an app list in a format this loader does not know.');
  const taken = Math.min(raw.length, ask.limit); // an answer longer than the page asked for is cut, not shown
  const seen = new Set();
  const items = [];
  for (const x of raw.slice(0, taken)) {
    const it = browseItem(x);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  const total = Math.max(wholeNumber(j.total) || 0, taken ? ask.offset + taken : 0); // never fewer than what was received
  const next = taken > 0 && ask.offset + taken < total ? ask.offset + taken : null;
  return { registry, q: ask.q, sort: ask.sort, offset: ask.offset, limit: ask.limit, total, next, items };
}

// ------------------------------------------------------------------------------------------------ Updates

class Updates {
  /**
   * @param {Store} store
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] total time for the version checks (default 5000)
   * @param {number} [opts.downloadIdleMs] how long a download may stall (default 15000)
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.timeoutMs = opts.timeoutMs || CHECK_TIMEOUT_MS;
    this.downloadIdleMs = opts.downloadIdleMs || 15000;
  }

  get tmpDir() {
    return path.join(this.store.home, 'tmp');
  }

  /** Removes leftover downloads (a crashed run). Only files this module creates. */
  cleanTmp() {
    try {
      for (const n of fs.readdirSync(this.tmpDir)) if (n.startsWith(TMP_PREFIX)) fs.rmSync(path.join(this.tmpDir, n), { force: true });
    } catch {
      /* no tmp dir */
    }
  }

  /** Deletes a downloaded file returned by fetchAndVerify (only inside our tmp folder). */
  discard(file) {
    if (typeof file !== 'string') return;
    const rel = path.relative(this.tmpDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(file).startsWith(TMP_PREFIX)) return;
    fs.rmSync(file, { force: true });
  }

  _registryOf(id, registry) {
    const r = registry ? normalizeRegistryUrl(registry) : (this.store.getSource(id) || {}).registry;
    if (!r) throw new UpdateError(registry ? `invalid registry address ${JSON.stringify(registry)}` : `${id} was not installed from a registry`);
    return r;
  }

  /**
   * The registry's version list for an app: [{version, packageId, sha256, size, publishedAt, withdrawn:{reason,at}|null}],
   * oldest first. Entries that are not well formed are dropped.
   */
  async listRegistryVersions(id, { registry, deadlineMs } = {}) {
    const reg = this._registryOf(id, registry);
    const j = await getJson(`${reg}/api/apps/${id}/versions`, deadlineMs || this.timeoutMs);
    const list = Array.isArray(j) ? j : j && Array.isArray(j.versions) ? j.versions : null;
    if (!list) throw new UpdateError('The registry sent a version list in a format this loader does not know.');
    const out = [];
    for (const v of list) {
      if (!v || typeof v.version !== 'string' || !SEMVER_RE.test(v.version)) continue;
      const w = v.withdrawn && typeof v.withdrawn === 'object' ? { reason: String(v.withdrawn.reason || '').slice(0, 500), at: v.withdrawn.at || null } : null;
      out.push({ version: v.version, packageId: v.packageId || null, sha256: v.sha256 || null, size: v.size || null, publishedAt: v.publishedAt || null, withdrawn: w });
    }
    return out.sort((a, b) => compareVersions(a.version, b.version));
  }

  /**
   * One page of the app list of a registry (GET /api/apps), for the "Browse registry…" sheet. `registry` is the address the user
   * named. opts: { q (at most 100 characters), sort ('new' (default) | 'popular' | 'updated' | 'name'), offset, limit (1-50, default 20),
   * deadlineMs }. The request carries the search text, the sort and the page: nothing else (INV-G3). The answer is cut down to
   * plain data (see cleanBrowseList), at most 4 MiB of it, within the deadline; redirects are not followed.
   * @returns {Promise<{registry, q, sort, offset, limit, total, next: number|null, items: {id, name, publisher: {level, label},
   *   description, latestVersion, runtime, downloads, sizeBytes, permissionsSummary}[]}>}
   */
  async browseRegistry(registry, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const reg = normalizeRegistryUrl(typeof registry === 'string' ? registry : '');
    if (!reg) throw new UpdateError('Enter the registry address (an http or https address).');
    const ask = browseParams(o);
    const query = new URLSearchParams({ sort: ask.sort, limit: String(ask.limit), offset: String(ask.offset) });
    if (ask.q) query.set('q', ask.q);
    try {
      return cleanBrowseList(await getJson(`${reg}/api/apps?${query}`, o.deadlineMs || this.timeoutMs), reg, ask);
    } catch (e) {
      // the registry's own error text is shown to the user: keep an absurdly long one short
      if (e instanceof UpdateError && e.message.length > 400) e.message = `${e.message.slice(0, 399)}…`;
      throw e;
    }
  }

  /**
   * Asks the registry which version the update choice picks for this app. Never returns a version that is not
   * higher than the installed one, is withdrawn, or breaks the choice (the answer is checked here too).
   * opts.choice overrides the stored policy; 'manual' counts as 'compatible' (an explicit "Check for updates").
   * opts.download: also download and verify the candidate and fill permissionDiff (needs the package).
   * Never throws for network problems: they come back as { offline: true } or { error }.
   * @returns {Promise<{id, current, candidate: string|null, latest: string|null, choice, policy, registry, permissionDiff: object|null,
   *   withdrawnCurrent: {reason, at}|null, offline: boolean, error: string|null, noSource?: boolean, prepared?: object}>}
   */
  async check(id, opts = {}) {
    const store = this.store;
    const current = store.currentVersion(id);
    if (!current) throw new UpdateError(`${id} is not installed`);
    const source = store.getSource(id);
    const policy = store.getPolicy(id);
    const choice = opts.choice || policy;
    const res = { id, current, candidate: null, latest: null, choice, policy, registry: source ? source.registry : null, permissionDiff: null, withdrawnCurrent: null, offline: false, error: null };
    if (!source) {
      res.noSource = true;
      return res;
    }
    const effective = choice === 'latest' ? 'latest' : 'compatible';
    const deadline = Date.now() + this.timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let versions;
    try {
      versions = await this.listRegistryVersions(id, { registry: source.registry, deadlineMs: left() });
    } catch (e) {
      res.offline = !!e.offline;
      res.error = e.message;
      return res;
    }
    const cur = versions.find((v) => v.version === current);
    if (cur && cur.withdrawn) res.withdrawnCurrent = cur.withdrawn;
    res.latest = pickCandidate(versions, 'latest', current);

    let cand = null;
    try {
      const j = await getJson(`${source.registry}/api/apps/${id}/resolve?choice=${effective}&from=${encodeURIComponent(current)}`, left());
      cand = j && typeof j.version === 'string' ? j.version : null;
    } catch (e) {
      if (e.offline) {
        res.offline = true;
        res.error = e.message;
        return res;
      }
      // an older registry without /resolve (404): work it out from the version list
      cand = pickCandidate(versions, effective, current);
    }
    // never trust the answer blindly: it must be a listed, non-withdrawn version that is newer and within the choice
    if (cand !== null) {
      const listed = versions.find((v) => v.version === cand);
      const ok = listed && !listed.withdrawn && SEMVER_RE.test(cand) && compareVersions(cand, current) > 0 && (effective === 'latest' || sameLine(current, cand)) && (!isPrerelease(cand) || isPrerelease(current));
      if (!ok) cand = pickCandidate(versions, effective, current);
    }
    res.candidate = cand;

    if (cand && opts.download) {
      try {
        const oldManifest = store.getVersionManifest(id, current);
        if (store.listVersions(id).includes(cand)) {
          res.prepared = { installed: true, version: cand, manifest: store.getVersionManifest(id, cand) };
        } else {
          const p = await this.fetchAndVerify(id, cand, { registry: source.registry });
          res.prepared = Object.assign({ installed: false }, p);
        }
        res.permissionDiff = permissionDiff(oldManifest, res.prepared.manifest);
      } catch (e) {
        res.offline = !!e.offline;
        res.error = e.message;
      }
    }
    return res;
  }

  /**
   * Downloads id@version ('latest' accepted) from the registry into $VMAPP_HOME/tmp and verifies it: the file's
   * sha256 against X-Vmapp-Sha256, the package (hostlib/package.js), its package id against X-Vmapp-Package-Id,
   * and that its id and version are the ones asked for. On any failure the file is deleted and an UpdateError thrown.
   * @returns {Promise<{file, registry, id, version, manifest, packageId, sha256, size}>}
   */
  async fetchAndVerify(id, version, opts = {}) {
    if (typeof id !== 'string' || id.length < 3 || id.length > 100 || !ID_RE.test(id)) throw new UpdateError(`invalid app id ${JSON.stringify(id)}`);
    if (version !== 'latest' && !SEMVER_RE.test(version)) throw new UpdateError(`invalid version ${JSON.stringify(version)}`);
    const registry = this._registryOf(id, opts.registry);
    const url = `${registry}/api/apps/${id}/${version}/download`;
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const file = path.join(this.tmpDir, `${TMP_PREFIX}${crypto.randomBytes(6).toString('hex')}.vmapp`);
    try {
      const { sha256, packageId: claimedPkgId, size } = await this._download(url, file);
      let p;
      try {
        p = pkg.read(file);
      } catch (e) {
        throw new UpdateError(`The downloaded file is not a valid package: ${e.message}`);
      }
      if (p.packageId !== claimedPkgId) {
        throw new UpdateError(`The package id of the downloaded file (${p.packageId}) does not match what the registry announced (${claimedPkgId}).`);
      }
      if (p.manifest.id !== id) throw new UpdateError(`Asked for ${id} but the package is ${p.manifest.id}.`);
      if (version !== 'latest' && p.manifest.version !== version) throw new UpdateError(`Asked for version ${version} but the package is ${p.manifest.version}.`);
      return { file, registry, id, version: p.manifest.version, manifest: p.manifest, packageId: p.packageId, sha256, size, insecure: isInsecureRemote(registry) };
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
  }

  _download(url, file) {
    const idleMs = this.downloadIdleMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      let out = null;
      let req = null;
      let headerTimer = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(headerTimer);
        try {
          req.destroy();
        } catch {
          /* gone */
        }
        if (out) out.destroy();
        reject(netError(err, url));
      };
      const claimsOf = (headers) => {
        const sha = String(headers['x-vmapp-sha256'] || '').toLowerCase();
        const pkgId = String(headers['x-vmapp-package-id'] || '').toLowerCase();
        return /^[0-9a-f]{64}$/.test(sha) && /^[0-9a-f]{64}$/.test(pkgId) ? { sha, pkgId } : null;
      };
      // hop 0 asks the registry; a 302 (a registry that keeps packages in object storage) sends us to the storage for hop 1.
      // Both checksums always come from the registry's answer (hop 0), never from the storage.
      const get = (target, hop, claims) => {
        req = lib(target).get(target, { agent: false, headers: { Connection: 'close' }, timeout: idleMs }, (res) => {
          clearTimeout(headerTimer);
          if (hop === 0 && REDIRECT_STATUSES.has(res.statusCode)) {
            res.resume();
            const c = claimsOf(res.headers);
            if (!c) return fail(new UpdateError('Refused: the registry did not send X-Vmapp-Sha256 and X-Vmapp-Package-Id.'));
            let next;
            try {
              next = storageTarget(url, res.headers.location);
            } catch (e) {
              return fail(e);
            }
            return get(next, 1, c);
          }
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.length < 64 && chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
              if (hop === 1) return fail(new UpdateError(`The registry's package storage at ${new URL(target).origin} answered HTTP ${res.statusCode}.`, { status: res.statusCode }));
              fail(new UpdateError(describeHttpError(res.statusCode, text), { status: res.statusCode }));
            });
            return undefined;
          }
          const c = claims || claimsOf(res.headers);
          if (!c) return fail(new UpdateError('Refused: the registry did not send X-Vmapp-Sha256 and X-Vmapp-Package-Id.'));
          const claimedSha = c.sha;
          const claimedPkg = c.pkgId;
          const len = Number(res.headers['content-length']);
          if (Number.isFinite(len) && len > pkg.MAX_PACKAGE) return fail(new UpdateError(`Refused: the download is larger than the ${pkg.mib(pkg.MAX_PACKAGE)} package limit.`));
          const hash = crypto.createHash('sha256');
          let size = 0;
          out = fs.createWriteStream(file, { mode: 0o600 });
          out.on('error', fail);
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > pkg.MAX_PACKAGE) return fail(new UpdateError(`Refused: the download is larger than the ${pkg.mib(pkg.MAX_PACKAGE)} package limit.`));
            hash.update(chunk);
            out.write(chunk);
            return undefined;
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new UpdateError('The download was interrupted.', { offline: true })));
          res.on('end', () => {
            out.end(() => {
              if (settled) return;
              const sha256 = hash.digest('hex');
              if (sha256 !== claimedSha) {
                return fail(new UpdateError(`Refused: the downloaded file's SHA-256 (${sha256}) does not match what the registry announced (${claimedSha}). The file was damaged or changed on the way.`));
              }
              settled = true;
              return resolve({ sha256, packageId: claimedPkg, size });
            });
          });
          return undefined;
        });
        headerTimer = setTimeout(() => fail(new UpdateError(`The ${hop ? "registry's package storage" : 'registry'} at ${new URL(target).origin} did not answer in time.`, { offline: true, code: 'ETIMEDOUT' })), 10000);
        req.on('timeout', () => fail(new UpdateError('The download stalled.', { offline: true, code: 'ETIMEDOUT' })));
        req.on('error', fail);
      };
      get(url, 0, null);
    });
  }

  /**
   * Installs a version and makes it current. Pass `prepared` (from fetchAndVerify, or check({download:true}).prepared) to
   * install what the user just reviewed; without it, a version that is already installed is switched to
   * (no network), and any other is downloaded first. The caller decides whether the user must be asked (permissionDiff).
   * opts.force allows installing an older version than the current one (an explicit user action only).
   * The downloaded file is deleted afterwards. Returns { id, version, previous, installed: boolean }.
   */
  async apply(id, version, opts = {}) {
    const store = this.store;
    const prepared = opts.prepared && !opts.prepared.installed ? opts.prepared : null;
    if (!prepared && store.listVersions(id).includes(version)) {
      const r = store.useVersion(id, version);
      return { id, version, previous: r.previous, installed: false };
    }
    const p = prepared || (await this.fetchAndVerify(id, version, { registry: opts.registry }));
    if (p.id !== id || (version !== 'latest' && p.version !== version)) {
      this.discard(p.file);
      throw new UpdateError('The prepared download is not the one asked for.');
    }
    try {
      const r = store.install(p.file, { force: !!opts.force, source: { registry: p.registry } });
      return { id, version: r.version, previous: r.previous, installed: true };
    } finally {
      this.discard(p.file);
    }
  }
}

// ------------------------------------------------------------------------------------------------ publishing
// Reached only from the loader's "Publish…" sheet (the user filled it in and pressed Publish). It sends one package and,
// for a later version, the owner token the user holds; nothing else (no app list, no identifiers). INV-G3.

const PUBLISH_IDLE_MS = 60 * 1000;
const PUBLISH_MAX_RESPONSE = 1024 * 1024;
const PUBLISHER_FIELDS = ['name', 'company', 'email', 'url'];

/** Owner tokens: $VMAPP_HOME/publish-tokens.json = { "<registry url>": { "<app id>": "<token>" } }, mode 0600 (same file as `vmapp publish`). */
function publishTokensFile(home) {
  return path.join(home, 'publish-tokens.json');
}

function loadPublishTokens(home) {
  try {
    const j = JSON.parse(fs.readFileSync(publishTokensFile(home), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new UpdateError(`${publishTokensFile(home)} cannot be read (${e.message}). Fix or remove it, or paste the token by hand.`);
  }
}

/** The saved owner token for this app at this registry, or null. */
function getPublishToken(home, registry, id) {
  const reg = normalizeRegistryUrl(registry || '');
  if (!reg) return null;
  const t = (loadPublishTokens(home)[reg] || {})[id];
  return typeof t === 'string' && t ? t : null;
}

/** The registries where this Mac holds an owner token for this app, in file order. */
function publishRegistriesFor(home, id) {
  const all = loadPublishTokens(home);
  return Object.keys(all).filter((r) => all[r] && typeof all[r] === 'object' && typeof all[r][id] === 'string' && all[r][id]);
}

/** Saves (or replaces) the token with mode 0600 and returns the file's path. */
function savePublishToken(home, registry, id, token) {
  const reg = normalizeRegistryUrl(registry || '');
  if (!reg) throw new UpdateError(`invalid registry address ${JSON.stringify(registry)}`);
  const all = loadPublishTokens(home);
  if (!all[reg] || typeof all[reg] !== 'object') all[reg] = {};
  all[reg][id] = token;
  const file = publishTokensFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

/** What a publish answer means in plain words (docs/PUBLISHING.md section 3.4). `message` is the registry's own text. */
function publishErrorText(status, { message = '', hadToken = false } = {}) {
  const why = String(message || '').replace(/\s+/g, ' ').trim();
  switch (status) {
    case 400:
      return `The registry says this package is not valid: ${why || 'no reason given'}. Rebuild it and check it with \`vmapp verify\`.`;
    case 401:
      return hadToken
        ? 'The registry did not accept the owner token. Paste the token you got from the first publish of this app.'
        : 'This app id is already published and no owner token was sent. Enter the owner token from the first publish (a Mac that published it saved the token automatically).';
    case 403:
      return 'That owner token does not own this app id. It is the wrong token, or someone else claimed the id. Do not change the app id to get around this.';
    case 409:
      return 'This version already exists, or it is not higher than the newest published version. Raise the version in vmapp.json, rebuild, and publish again.';
    case 413:
      return `The package is too large for this registry (a package may have up to ${pkg.mib(pkg.MAX_PACKAGE)}; a registry may set a lower limit).`;
    case 415:
      return 'The registry refused the content type (it must be application/octet-stream).';
    case 429:
      return 'The registry is rate limiting publishes (10 per hour per address by default). Wait a while, then try again.';
    default:
      return status >= 500 ? `The registry had a problem (HTTP ${status})${why ? `: ${why}` : ''}. Try again later.` : `The registry refused the publish (HTTP ${status})${why ? `: ${why}` : ''}.`;
  }
}

function publisherHeader(publisher) {
  const out = {};
  for (const k of PUBLISHER_FIELDS) {
    const v = publisher && typeof publisher[k] === 'string' ? publisher[k].trim() : '';
    if (v) out[k] = v.slice(0, 200);
  }
  if (!Object.keys(out).length) return null;
  // header values are ASCII: escape everything else as JSON \u escapes
  return JSON.stringify(out).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Checks what a publish needs before any request is made. Returns { registry, p (the package), token }; throws UpdateError. */
function preparePublish(file, opts) {
  const registry = normalizeRegistryUrl(opts.registry || '');
  if (!registry) throw new UpdateError('Enter the registry address, starting with http:// or https://.');
  let p;
  try {
    p = pkg.read(file);
  } catch (e) {
    throw new UpdateError(`This package cannot be published: ${e.message}`);
  }
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  if (token && !/^[\x21-\x7e]{1,512}$/.test(token)) throw new UpdateError('The owner token has characters that cannot be right. Paste it again.');
  return { registry, p, token };
}

/** One HTTP request with a small body (JSON) or a file streamed from disk. Resolves { status, headers, text }. */
function httpExchange(url, { method, headers, body, file, idleMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let input = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (input) input.destroy();
      fn(v);
    };
    const req = lib(url).request(url, { method, agent: false, headers: Object.assign({ Connection: 'close' }, headers), timeout: idleMs || PUBLISH_IDLE_MS }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n <= PUBLISH_MAX_RESPONSE) chunks.push(c);
      });
      res.on('error', (e) => done(reject, netError(e, url)));
      res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy();
      done(reject, new UpdateError(`${new URL(url).origin} stopped answering.`, { offline: true, code: 'ETIMEDOUT' }));
    });
    req.on('error', (e) => done(reject, netError(e, url)));
    if (file) {
      input = fs.createReadStream(file);
      input.on('error', (e) => {
        req.destroy();
        done(reject, new UpdateError(`Cannot read the package: ${e.message}`));
      });
      input.pipe(req);
    } else {
      req.end(body);
    }
  });
}

/** Turns the registry's answer to a publish (direct, or the "complete" step) into the result or an UpdateError. */
function publishResult(res, { registry, p, token }) {
  let j = null;
  try {
    j = JSON.parse(res.text);
  } catch {
    /* not JSON */
  }
  if (res.status !== 201) {
    const detail = j && j.error && j.error.message ? String(j.error.message) : '';
    const err = new UpdateError(publishErrorText(res.status, { message: detail, hadToken: !!token }), { status: res.status, code: j && j.error && j.error.code });
    err.detail = detail;
    throw err;
  }
  if (!j || typeof j.id !== 'string' || typeof j.version !== 'string') throw new UpdateError('The registry accepted the package but sent an answer this loader does not understand.', { status: 201 });
  return { id: j.id, version: j.version, packageId: j.packageId || p.packageId, url: typeof j.url === 'string' ? j.url : `/apps/${j.id}`, ownerToken: typeof j.ownerToken === 'string' && j.ownerToken ? j.ownerToken : null, publisher: j.publisher || null, registry };
}

/** SHA-256 and size of a file, streamed. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    const s = fs.createReadStream(file);
    s.on('data', (c) => {
      h.update(c);
      size += c.length;
    });
    s.on('error', (e) => reject(new UpdateError(`Cannot read the package: ${e.message}`)));
    s.on('end', () => resolve({ sha256: h.digest('hex'), size }));
  });
}

/**
 * Uploads a .vmapp file to a registry.
 *   opts.registry   address of the registry (required)
 *   opts.token      the owner token for an id that exists (or to add a new id to your publisher); omitted on a first publish
 *   opts.publisher  { name, company, email, url }: only sent on a first publish (no token), where it describes the new publisher
 *   opts.direct     true: always send the package to the registry itself (POST /api/publish)
 * A registry that keeps packages in object storage says so (GET /api/info -> publishModes includes "presigned"); the package
 * then goes straight to the storage with a short-lived upload address from POST /api/publish/init, and the registry fetches
 * and verifies it on POST /api/publish/complete. Any other registry (or an older one) gets the direct upload. The file is
 * streamed from disk either way, never read whole into memory.
 * Resolves with { id, version, packageId, url (path of the app page on the registry), ownerToken?, publisher?, registry }.
 * Rejects with UpdateError: `status` is the HTTP status (null for network problems, `offline` then true), `code` the
 * registry's error code, `message` plain words (see publishErrorText), `detail` the registry's own message.
 */
async function publish(file, opts = {}) {
  const ctx = preparePublish(file, opts); // refuses a bad address, package or token before any request
  if (!opts.direct) {
    let info = null;
    try {
      info = await getJson(`${ctx.registry}/api/info`, opts.infoMs || 5000);
    } catch {
      /* an older registry has no /api/info, or it is offline: the direct upload below says which */
    }
    if (info && Array.isArray(info.publishModes) && info.publishModes.includes('presigned')) return publishPresigned(file, ctx, opts);
  }
  return publishDirect(file, ctx, opts);
}

/** init -> PUT to the storage -> complete (see publish()). */
async function publishPresigned(file, ctx, opts) {
  const { registry, token } = ctx;
  const { sha256, size } = await hashFile(file);
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const json = (o) => Buffer.from(JSON.stringify(o));
  const initBody = json({ size, sha256 });
  const init = await httpExchange(`${registry}/api/publish/init`, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': String(initBody.length), Accept: 'application/json' }, auth), body: initBody, idleMs: opts.idleMs,
  });
  let ij = null;
  try {
    ij = JSON.parse(init.text);
  } catch {
    /* not JSON */
  }
  if (init.status !== 200) {
    const detail = ij && ij.error && ij.error.message ? String(ij.error.message) : '';
    const err = new UpdateError(publishErrorText(init.status, { message: detail, hadToken: !!token }), { status: init.status, code: ij && ij.error && ij.error.code });
    err.detail = detail;
    throw err;
  }
  if (!ij || typeof ij.uploadId !== 'string' || typeof ij.url !== 'string') throw new UpdateError('The registry sent an upload address this loader does not understand.', { status: 200 });
  const target = storageTarget(registry, ij.url);
  const put = await httpExchange(target, { method: 'PUT', headers: { 'Content-Length': String(size) }, file, idleMs: opts.idleMs });
  if (put.status < 200 || put.status >= 300) {
    throw new UpdateError(`The package could not be uploaded to the registry's storage (HTTP ${put.status}). Try again; if it keeps failing, tell the registry's operator.`, { status: put.status, code: 'upload_failed' });
  }
  const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, auth);
  if (!token) {
    const ph = publisherHeader(opts.publisher);
    if (ph) headers['X-Vmapp-Publisher'] = ph;
  }
  const doneBody = json({ uploadId: ij.uploadId });
  headers['Content-Length'] = String(doneBody.length);
  const done = await httpExchange(`${registry}/api/publish/complete`, { method: 'POST', headers, body: doneBody, idleMs: opts.idleMs });
  return publishResult(done, ctx);
}

/** The direct upload: POST /api/publish with the package as the body. */
function publishDirect(file, ctx, opts) {
  return new Promise((resolve, reject) => {
    const { registry, p, token } = ctx;
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(file).size), Connection: 'close', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    else {
      const ph = publisherHeader(opts.publisher);
      if (ph) headers['X-Vmapp-Publisher'] = ph;
    }
    const url = `${registry}/api/publish`;
    let settled = false;
    let input = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (input) input.destroy();
      fn(v);
    };
    const req = lib(url).request(url, { method: 'POST', agent: false, headers, timeout: opts.idleMs || PUBLISH_IDLE_MS }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n <= PUBLISH_MAX_RESPONSE) chunks.push(c);
      });
      res.on('error', (e) => done(reject, netError(e, url)));
      res.on('end', () => {
        try {
          done(resolve, publishResult({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }, { registry, p, token }));
        } catch (e) {
          done(reject, e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      done(reject, new UpdateError(`The registry at ${new URL(url).origin} stopped answering.`, { offline: true, code: 'ETIMEDOUT' }));
    });
    req.on('error', (e) => done(reject, netError(e, url)));
    input = fs.createReadStream(file);
    input.on('error', (e) => {
      req.destroy();
      done(reject, new UpdateError(`Cannot read the package: ${e.message}`));
    });
    input.pipe(req);
  });
}

// ------------------------------------------------------------------------------------------------ the launcher's own updates
// SPEC 8.10, INV-U1 (and INV-G3: "signed updates the user can turn off"). The launcher asks ONE fixed address for a small JSON
// file that names the newest launcher: a plain GET, no identifier, no installed version, no list of apps, no cookie, no custom
// user agent. Whether that is newer than the running launcher is decided here and in the loader, never by the server. The file
// is also the feed of Electron's updater (Squirrel.Mac), which downloads the zip itself and installs it only if the new app is
// signed by the same Developer ID as the running one; so a feed that lies can at worst point at a zip that is then refused.
// Everything the feed says is cut down to a fixed set of fields (cleanLauncherFeed) before the loader shows or uses any of it.

/** The one address the launcher asks. */
const LAUNCHER_FEED_URL = 'https://vmapp.dev/updates/mac-arm64/latest.json';
/** Where the feed, the changelog page and the downloads page may be. */
const LAUNCHER_PAGE_HOSTS = ['vmapp.dev'];
/** Where the update's zip may be (a GitHub release asset: GitHub redirects it on to its own storage, which Squirrel follows). */
const LAUNCHER_DOWNLOAD_HOSTS = ['github.com', 'vmapp.dev'];
const LAUNCHER_FEED_MAX = 256 * 1024;
const LAUNCHER_FEED_TIMEOUT_MS = 10000;

const isLocalDev = (u) => u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');

/** An https address on one of `hosts` (no credentials, no port). `dev` also allows plain http to this Mac, for tests only. Returns the href or ''. */
function launcherUrl(v, hosts, { dev = false, ext = '' } = {}) {
  if (typeof v !== 'string' || v.length > 600) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    return '';
  }
  if (u.username || u.password || u.hash) return '';
  const secure = u.protocol === 'https:' && hosts.includes(u.hostname) && !u.port;
  if (!secure && !(dev && isLocalDev(u))) return '';
  if (ext && !u.pathname.toLowerCase().endsWith(ext)) return '';
  return u.href;
}

/**
 * The newest launcher, from the feed's JSON, in a fixed shape; throws UpdateError when it is not usable. `dev` (unpackaged builds,
 * tests) also accepts addresses on this Mac.
 * Fields (all required unless marked): version (semver), url (the zip), sha256 and size (of the zip: shown, and checked by the
 * release tooling), name, notes (plain text, Squirrel's own field), changes (up to 12 short lines for the card),
 * pub_date, tag, commit, changelogUrl, pageUrl, minimumOS (each optional).
 */
function cleanLauncherFeed(j, { dev = false } = {}) {
  const bad = (why) => new UpdateError(`The launcher update information cannot be used (${why}).`);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw bad('not an object');
  const version = typeof j.version === 'string' && j.version.length <= 64 && SEMVER_RE.test(j.version) ? j.version : '';
  if (!version) throw bad('no valid version');
  const url = launcherUrl(j.url, LAUNCHER_DOWNLOAD_HOSTS, { dev, ext: '.zip' });
  if (!url) throw bad('the download address is not an https address of a known host');
  if (typeof j.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(j.sha256)) throw bad('no checksum');
  if (!Number.isSafeInteger(j.size) || j.size < 1 || j.size > 4 * 1024 * 1024 * 1024) throw bad('no valid size');
  const changes = (Array.isArray(j.changes) ? j.changes : []).slice(0, 12).map((c) => cleanText(c, 240)).filter(Boolean);
  const pub = typeof j.pub_date === 'string' ? Date.parse(j.pub_date) : NaN;
  return {
    version,
    url,
    sha256: j.sha256,
    size: j.size,
    name: cleanText(j.name, 80) || `Version ${version}`,
    notes: cleanText(j.notes, 1500),
    changes,
    pubDate: Number.isFinite(pub) ? new Date(pub).toISOString() : '',
    tag: typeof j.tag === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(j.tag) ? j.tag : '',
    commit: typeof j.commit === 'string' && /^[0-9a-f]{7,40}$/.test(j.commit) ? j.commit : '',
    changelogUrl: launcherUrl(j.changelogUrl, LAUNCHER_PAGE_HOSTS, { dev }),
    pageUrl: launcherUrl(j.pageUrl, LAUNCHER_PAGE_HOSTS, { dev }),
    minimumOS: typeof j.minimumOS === 'string' && /^\d+(\.\d+){0,2}$/.test(j.minimumOS) ? j.minimumOS : '',
  };
}

/** GET the launcher feed and return the cleaned record. Only the fixed address (or, with `dev`, one on this Mac) is ever asked. */
async function fetchLauncherFeed(url = LAUNCHER_FEED_URL, { deadlineMs = LAUNCHER_FEED_TIMEOUT_MS, dev = false } = {}) {
  const target = launcherUrl(url, LAUNCHER_PAGE_HOSTS, { dev });
  if (!target) throw new UpdateError('The launcher update address is not one this launcher may ask.');
  let r;
  try {
    r = await getBuffer(target, deadlineMs);
  } catch (e) {
    if (e instanceof UpdateError) throw new UpdateError(e.message.replace('The registry', 'The update server'), { offline: e.offline, code: e.code });
    throw e;
  }
  if (r.status !== 200) throw new UpdateError(`The update server answered HTTP ${r.status}.`, { status: r.status });
  if (r.body.length > LAUNCHER_FEED_MAX) throw new UpdateError('The update server sent an unexpectedly large answer.');
  let j;
  try {
    j = JSON.parse(r.body.toString('utf8'));
  } catch {
    throw new UpdateError('The update server sent an answer that is not valid JSON.');
  }
  return cleanLauncherFeed(j, { dev });
}

/**
 * Is the feed's launcher newer than the running one, and has the user not skipped it? 'newer', 'skipped', 'same' (nothing newer) or
 * 'ahead' (this launcher is newer than the feed: a development build). The server never decides this.
 */
function launcherUpdateState(currentVersion, feed, skipped = '') {
  if (typeof currentVersion !== 'string' || !SEMVER_RE.test(currentVersion)) return 'same';
  const c = compareVersions(feed.version, currentVersion);
  if (c < 0) return 'ahead';
  if (c === 0) return 'same';
  return skipped && skipped === feed.version ? 'skipped' : 'newer';
}

module.exports = {
  Updates,
  UpdateError,
  LAUNCHER_FEED_URL,
  LAUNCHER_PAGE_HOSTS,
  LAUNCHER_DOWNLOAD_HOSTS,
  cleanLauncherFeed,
  fetchLauncherFeed,
  launcherUpdateState,
  publish,
  publishErrorText,
  publishTokensFile,
  getPublishToken,
  publishRegistriesFor,
  savePublishToken,
  permissionDiff,
  hostDiff,
  deviceDiff,
  pickCandidate,
  newestInstallable,
  sameLine,
  parseAppRef,
  isInsecureRemote,
  storageTarget,
  browseParams,
  cleanBrowseList,
  BROWSE_SORTS,
  BROWSE_PAGE,
  PUBLIC_REGISTRY,
  DEFAULT_DEV_REGISTRY,
  CHECK_TIMEOUT_MS,
};
