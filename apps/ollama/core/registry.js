'use strict';
/**
 * Pulling a model from registry.ollama.ai into Ollama's model store (/data/ollama/models), done by the core with Node's fetch
 * through the allowlist proxy. Ollama then serves what is in the store; `ollama serve` itself never downloads anything.
 *
 * Why the core pulls instead of Ollama's own POST /api/pull (found by running it in the VM, Ollama 0.35.0):
 *   the manifest request works through HTTPS_PROXY, but the model files do not. The registry answers a blob request with a redirect
 *   to its storage host, and Ollama (transfer/redirect.go) then (1) resolves that host with a local DNS lookup to check that it is a
 *   public address, and (2) downloads from it with its own http.Transport, which has a custom dialer and no Proxy setting, i.e. it
 *   dials the address directly. The VM has no DNS and no route (SPEC 8.3), so step (1) fails ("redirect target not allowed:
 *   resolving …: lookup … connection refused") and step (2) could not work either. Faking DNS would not help.
 *
 * What this module does is what Ollama's pull does, on Ollama's own on-disk layout (a content-addressed store):
 *   GET /v2/<namespace>/<model>/manifests/<tag>   the manifest (Docker registry API v2, schema 2), kept byte for byte
 *   GET /v2/<namespace>/<model>/blobs/<digest>    every layer and the config; the registry redirects to its storage host, which is
 *                                                 followed by hand, so a host that is not allowed is named in the error
 *   blobs/sha256-<hex>                            written only after the size and the SHA-256 match the manifest
 *   manifests/registry.ollama.ai/<namespace>/<model>/<tag>   written last, so a model appears in Ollama's list only when complete
 * Partial downloads live in /data/ollama/downloads/*.partial (outside the store, so Ollama's start-up clean-up never touches them),
 * are resumed with Range requests, and are hashed again from disk when resumed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DATA = process.env.VMAPP_DATA || '/data';
const STORE = path.join(DATA, 'ollama', 'models');
const BLOBS = path.join(STORE, 'blobs');
const MANIFESTS = path.join(STORE, 'manifests');
const DOWNLOADS = path.join(DATA, 'ollama', 'downloads');
const REGISTRY = 'registry.ollama.ai';
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';
const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LAYERS = 100;
const MAX_BLOB_BYTES = 2 ** 40;
const ATTEMPTS = 5;
const PROGRESS_MS = 250;
const MiB = 1024 * 1024;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PART_RE = /^(?:([a-z0-9][a-z0-9._-]{0,63})\/)?([a-z0-9][a-z0-9._-]{0,63}):([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;

/** "qwen2.5:0.5b" -> {ns: 'library', model: 'qwen2.5', tag: '0.5b'}. The name must already have a tag (main.js adds :latest). */
function parseName(name) {
  const m = PART_RE.exec(String(name));
  if (!m) throw new Error('Bad model name');
  return { ns: m[1] || 'library', model: m[2], tag: m[3] };
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function hashFile(file, hash, signal) {
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * MiB, signal })) hash.update(chunk);
}

/** GET following redirects by hand, https only. A host the proxy refuses is named in the error. */
async function get(url, headers, signal) {
  let u = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (u.protocol !== 'https:') throw new Error(`Refusing a non-https address (${u.protocol}//${u.host})`);
    let res;
    try {
      res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'vmapp-ollama', ...headers }, signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      const cause = e && e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
      console.log(`[registry] fetch ${u.host} failed: ${e && e.message}${cause}`);
      const err = new Error(`Could not connect to ${u.host}. This app can only reach the hosts you allowed: check "Network…" on its card in the library.`);
      err.network = true;
      throw err;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      u = new URL(res.headers.get('location'), u);
      continue;
    }
    return { res, host: u.host };
  }
  throw new Error('Too many redirects');
}

/** Reads and checks a manifest. Returns {bytes, blobs:[{digest, size, mediaType}]} (the config first; duplicates removed). */
async function fetchManifest(p, signal) {
  const url = `https://${REGISTRY}/v2/${p.ns}/${p.model}/manifests/${p.tag}`;
  const { res } = await get(url, { Accept: MANIFEST_ACCEPT }, signal);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`There is no model "${p.ns === 'library' ? '' : `${p.ns}/`}${p.model}:${p.tag}" on registry.ollama.ai.`);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`The registry answered HTTP ${res.status} for the model's manifest.`);
  }
  const chunks = [];
  let n = 0;
  for await (const c of Readable.fromWeb(res.body)) {
    n += c.length;
    if (n > MAX_MANIFEST_BYTES) throw new Error('The manifest is unreasonably large');
    chunks.push(c);
  }
  const bytes = Buffer.concat(chunks);
  let m;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('The registry sent a manifest that is not JSON');
  }
  if (!m || m.schemaVersion !== 2 || !m.config || !Array.isArray(m.layers) || m.layers.length > MAX_LAYERS) throw new Error('The manifest has an unexpected shape');
  const seen = new Set();
  const blobs = [];
  for (const b of [m.config, ...m.layers]) {
    if (!b || typeof b.digest !== 'string' || !DIGEST_RE.test(b.digest)) throw new Error('The manifest lists a layer with a bad digest');
    if (!Number.isInteger(b.size) || b.size < 0 || b.size > MAX_BLOB_BYTES) throw new Error('The manifest lists a layer with a bad size');
    if (seen.has(b.digest)) continue;
    seen.add(b.digest);
    blobs.push({ digest: b.digest, size: b.size, mediaType: String(b.mediaType || '') });
  }
  return { bytes, blobs };
}

/**
 * Pulls `name` (already normalised, with a tag). `report({phase, status, received, total, bps})` is called as it goes; `signal`
 * cancels (the partial files stay). Resolves when the manifest is written. Throws on any failure.
 */
async function pull(name, report, signal) {
  const p = parseName(name);
  fs.mkdirSync(BLOBS, { recursive: true, mode: 0o755 });
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 });

  const st = { phase: 'starting', status: 'pulling manifest', received: 0, total: 0, bps: 0 };
  let last = 0;
  let lastBytes = 0;
  let lastAt = Date.now();
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - last < PROGRESS_MS) return;
    if (now - lastAt >= 500) {
      const inst = ((st.received - lastBytes) / (now - lastAt)) * 1000;
      st.bps = st.bps ? st.bps * 0.6 + inst * 0.4 : inst;
      lastBytes = st.received;
      lastAt = now;
    }
    last = now;
    report({ ...st });
  };
  emit(true);

  const { bytes: manifestBytes, blobs } = await fetchManifest(p, signal);
  st.total = blobs.reduce((s, b) => s + b.size, 0);

  // what is already there counts as received; check the space for the rest
  let missing = 0;
  for (const b of blobs) {
    const hex = b.digest.slice(7);
    if (sizeOf(path.join(BLOBS, `sha256-${hex}`)) === b.size) st.received += b.size;
    else missing += b.size - Math.min(sizeOf(path.join(DOWNLOADS, `sha256-${hex}.partial`)), b.size);
  }
  const free = freeBytes(BLOBS);
  if (free !== null && missing + 64 * MiB > free) {
    throw new Error(`Not enough free space: the model needs ${Math.ceil(missing / MiB)} MiB more and ${Math.floor(free / MiB)} MiB are free on the disk that holds this app's data.`);
  }
  st.phase = 'download';
  emit(true);

  for (const b of blobs) {
    const hex = b.digest.slice(7);
    const final = path.join(BLOBS, `sha256-${hex}`);
    if (sizeOf(final) === b.size) continue;
    st.status = `pulling ${hex.slice(0, 12)}`;
    emit(true);
    await downloadBlob(p, b, hex, final, st, emit, signal);
  }

  st.phase = 'verify';
  st.status = 'writing manifest';
  emit(true);
  const dir = path.join(MANIFESTS, REGISTRY, p.ns, p.model);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, p.tag);
  fs.writeFileSync(`${file}.tmp`, manifestBytes, { mode: 0o644 });
  fs.renameSync(`${file}.tmp`, file);
  st.status = 'success';
  st.received = st.total;
  emit(true);
}

async function downloadBlob(p, blob, hex, final, st, emit, signal) {
  const part = path.join(DOWNLOADS, `sha256-${hex}.partial`);
  const url = `https://${REGISTRY}/v2/${p.ns}/${p.model}/blobs/${blob.digest}`;
  const base = st.received; // everything received before this blob's own bytes (a partial file of this blob is not counted yet)
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    try {
      let have = sizeOf(part);
      if (have > blob.size) {
        fs.unlinkSync(part);
        have = 0;
      }
      let hash = crypto.createHash('sha256');
      if (have > 0) await hashFile(part, hash, signal);
      st.received = base + have;
      emit(true);

      if (have < blob.size) {
        const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
        const { res } = await get(url, headers, signal);
        let start = have;
        if (have > 0 && res.status === 200) {
          // the server ignored the range: start again from the beginning
          start = 0;
          hash = crypto.createHash('sha256');
        } else if (res.status === 206) {
          const cr = res.headers.get('content-range') || '';
          if (!cr.startsWith(`bytes ${have}-`)) throw Object.assign(new Error('The server answered a different range than asked for'), { fatal: true });
        } else if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`The storage host answered HTTP ${res.status} for a model file.`), { fatal: res.status === 403 || res.status === 404 });
        }
        if (!res.body) throw new Error('The server sent no data');
        st.received = base + start;
        const meter = new Transform({
          transform(chunk, enc, cb) {
            hash.update(chunk);
            st.received += chunk.length;
            emit(false);
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w', mode: 0o644 }), { signal });
      }

      const got = sizeOf(part);
      if (got !== blob.size) throw new Error(`The download ended early (${got} of ${blob.size} bytes).`);
      st.phase = 'verify';
      st.status = 'verifying sha256 digest';
      emit(true);
      if (`sha256:${hash.digest('hex')}` !== blob.digest) {
        fs.unlinkSync(part);
        throw Object.assign(new Error('A downloaded file does not match its published SHA-256, so it was not saved. Try again.'), { fatal: true });
      }
      fs.renameSync(part, final);
      st.received = base + blob.size;
      st.phase = 'download';
      return;
    } catch (e) {
      if (signal.aborted || (e && e.name === 'AbortError')) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      lastErr = e;
      if (e.fatal || e.network || attempt === ATTEMPTS) break;
      console.log(`[registry] ${blob.digest.slice(0, 19)} attempt ${attempt} failed: ${e.message}; retrying`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

module.exports = { pull, parseName, STORE, BLOBS, MANIFESTS, DOWNLOADS, REGISTRY };
