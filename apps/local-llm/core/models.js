'use strict';
/**
 * Model files for the Local LLM core: the curated catalog (models.json), what is on disk in /data/models, downloads and imports.
 *
 *   downloads  go through the network proxy (fetch honours HTTPS_PROXY in the node22 runtime), follow Hugging Face's redirect to
 *              its CDN by hand (so a refused host is named in the error), resume from a `.partial` file, and are stored only if
 *              the size and the SHA-256 match the catalog.
 *   imports    copy a file the user picked in the open dialog (a private clone under /host/pick-N) into /data/models, after
 *              checking that it starts with the GGUF magic number.
 *
 * One transfer at a time. Progress goes to `emit({kind, id|name, phase, received, total, bps, ...})`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DATA = process.env.VMAPP_DATA || '/data';
const DIR = path.join(DATA, 'models');
const CATALOG = require('./models.json').models;

const MiB = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+() -]{0,150}\.gguf$/;
const MAX_REDIRECTS = 5;
const PROGRESS_MS = 250;

/** The state of the one running transfer, or null. */
let active = null; // {kind, key, ctl, phase, received, total, bps}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
}

function freeBytes() {
  try {
    ensureDir();
    const s = fs.statfsSync(DIR);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** A file name that is safe to create in /data/models: letters, digits and . _ + ( ) - space, ending in .gguf. */
function safeName(base) {
  let n = String(base).replace(/[^A-Za-z0-9._+() -]/g, '_');
  n = n.replace(/\.gguf$/i, '');
  if (!/^[A-Za-z0-9]/.test(n)) n = `model-${n}`;
  n = n.slice(0, 140).trim() || 'model';
  return `${n}.gguf`;
}

function catalogEntry(id) {
  return CATALOG.find((m) => m.id === id) || null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The models on disk: [{name, bytes, catalogId}] (catalogId when the name and the size are those of a catalog entry). */
function listLocal() {
  ensureDir();
  const out = [];
  for (const name of fs.readdirSync(DIR).sort()) {
    if (!NAME_RE.test(name)) continue; // also skips `*.partial`
    let st;
    try {
      st = fs.statSync(path.join(DIR, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const c = CATALOG.find((m) => m.file === name && m.bytes === st.size);
    out.push({ name, bytes: st.size, catalogId: c ? c.id : null });
  }
  return out;
}

/** What the window needs: the catalog with its local state, the imported files, the free space, the running transfer. */
function state() {
  const local = listLocal();
  return {
    dir: DIR,
    freeBytes: freeBytes(),
    catalog: CATALOG.map((m) => ({
      id: m.id,
      name: m.name,
      quant: m.quant,
      file: m.file,
      bytes: m.bytes,
      sha256: m.sha256,
      host: hostOf(m.url),
      license: m.license,
      note: m.note,
      downloaded: local.some((l) => l.name === m.file && l.bytes === m.bytes),
      partialBytes: sizeOf(path.join(DIR, `${m.file}.partial`)),
    })),
    local, // every .gguf in the folder, downloaded or imported
    transfer: transferInfo(),
  };
}

function transferInfo() {
  if (!active) return null;
  const { kind, key, phase, received, total, bps } = active;
  return { kind, key, phase, received, total, bps };
}

// ------------------------------------------------------------------------------------------------ transfers

/** Calls `update(received)` as bytes pass, and reports progress at most every PROGRESS_MS. */
function meter(hash, emit, base) {
  let last = 0;
  let lastBytes = base.received;
  let lastAt = Date.now();
  let bps = 0;
  return new Transform({
    transform(chunk, enc, cb) {
      if (hash) hash.update(chunk);
      active.received += chunk.length;
      const now = Date.now();
      if (now - last >= PROGRESS_MS) {
        const dt = (now - lastAt) / 1000;
        if (dt > 0) {
          const inst = (active.received - lastBytes) / dt;
          bps = bps ? bps * 0.6 + inst * 0.4 : inst;
        }
        lastBytes = active.received;
        lastAt = now;
        last = now;
        active.bps = bps;
        emit({ ...base.event, phase: active.phase, received: active.received, total: active.total, bps });
      }
      cb(null, chunk);
    },
  });
}

async function hashFile(file, hash, signal) {
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * MiB, signal })) hash.update(chunk);
}

/** GET url following redirects by hand. A host that cannot be reached (the proxy refuses it) is named in the error. */
async function get(url, from, signal) {
  let u = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (u.protocol !== 'https:') throw new Error(`Refusing a non-https address (${u.protocol}//${u.host})`);
    const headers = { 'User-Agent': 'vmapp-local-llm' };
    if (from > 0) headers.Range = `bytes=${from}-`;
    let res;
    try {
      res = await fetch(u, { redirect: 'manual', headers, signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      const cause = e && e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
      console.log(`[models] fetch ${u.host} failed: ${e && e.message}${cause}`);
      throw new Error(
        `Could not connect to ${u.host}. This app can only reach the hosts you allowed: check "Network…" on its card in the library.`,
      );
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

function begin(kind, key, total) {
  if (active) throw new Error('Another download or import is still running. Wait for it or cancel it.');
  const ctl = new AbortController();
  active = { kind, key, ctl, phase: 'starting', received: 0, total, bps: 0 };
  return ctl;
}

function finish() {
  active = null;
}

/** Starts a download of a catalog model. Returns at once; progress and the end come through `emit`. */
function download(id, emit) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error('Unknown model');
  const ctl = begin('download', entry.id, entry.bytes);
  const base = { event: { kind: 'download', id: entry.id } };
  const ev = (extra) => emit({ ...base.event, received: active ? active.received : 0, total: entry.bytes, bps: 0, ...extra });
  (async () => {
    try {
      await runDownload(entry, ctl, base, ev, emit);
      ev({ phase: 'done', received: entry.bytes });
    } catch (e) {
      if (e && (e.name === 'AbortError' || ctl.signal.aborted)) ev({ phase: 'cancelled' });
      else {
        console.log(`[models] download ${entry.id} failed: ${e && e.message}`);
        ev({ phase: 'error', error: String((e && e.message) || e) });
      }
    } finally {
      finish();
    }
  })();
  return { started: true, id: entry.id };
}

async function runDownload(entry, ctl, base, ev, emit) {
  ensureDir();
  const final = path.join(DIR, entry.file);
  const part = `${final}.partial`;
  if (sizeOf(final) === entry.bytes) {
    active.received = entry.bytes;
    return;
  }
  let have = sizeOf(part);
  if (have > entry.bytes) {
    fs.unlinkSync(part);
    have = 0;
  }
  const free = freeBytes();
  if (free !== null && entry.bytes - have + 64 * MiB > free) {
    throw new Error(
      `Not enough free space for ${entry.name}: it needs ${Math.ceil((entry.bytes - have) / MiB)} MiB more and ${Math.floor(free / MiB)} MiB are free on the disk that holds this app's data.`,
    );
  }

  let hash = crypto.createHash('sha256');
  if (have > 0) {
    active.phase = 'resuming';
    ev({ phase: 'resuming', received: have });
    await hashFile(part, hash, ctl.signal);
  }
  active.received = have;

  if (have < entry.bytes) {
    active.phase = 'download';
    ev({ phase: 'download', received: have });
    let { res } = await get(entry.url, have, ctl.signal);
    let start = have;
    if (have > 0 && res.status === 200) {
      // the server ignored the range: start again from the beginning
      start = 0;
      have = 0;
      hash = crypto.createHash('sha256');
      active.received = 0;
    } else if (res.status === 206) {
      const cr = res.headers.get('content-range') || '';
      if (!cr.startsWith(`bytes ${have}-`)) throw new Error('The server answered a different range than asked for');
    } else if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Hugging Face answered HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('The server sent no data');
    const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w', mode: 0o644 });
    await pipeline(Readable.fromWeb(res.body), meter(hash, emit, { received: start, event: base.event }), out, { signal: ctl.signal });
  }

  if (active.received !== entry.bytes) {
    throw new Error(`The download ended early (${active.received} of ${entry.bytes} bytes). Press Download to resume it.`);
  }
  active.phase = 'verify';
  ev({ phase: 'verify', received: entry.bytes });
  const digest = hash.digest('hex');
  if (digest !== entry.sha256) {
    fs.unlinkSync(part);
    throw new Error('The downloaded file does not match its published SHA-256, so it was not saved. Try again.');
  }
  fs.renameSync(part, final);
}

/** Copies a picked file into /data/models. Returns at once; progress and the end come through `emit`. */
function importFile(srcPath, emit) {
  const st = fs.statSync(srcPath);
  if (!st.isFile()) throw new Error('That is not a file');
  const fd = fs.openSync(srcPath, 'r');
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    if (magic.toString('latin1') !== 'GGUF') throw new Error('That file is not a GGUF model (it does not start with "GGUF").');
  } finally {
    fs.closeSync(fd);
  }
  ensureDir();
  const name = safeName(path.basename(srcPath));
  const free = freeBytes();
  if (free !== null && st.size + 64 * MiB > free) {
    throw new Error(`Not enough free space: the file is ${Math.ceil(st.size / MiB)} MiB and ${Math.floor(free / MiB)} MiB are free.`);
  }
  const ctl = begin('import', name, st.size);
  const base = { event: { kind: 'import', name } };
  const ev = (extra) => emit({ ...base.event, received: active ? active.received : 0, total: st.size, bps: 0, ...extra });
  (async () => {
    const final = path.join(DIR, name);
    const part = `${final}.partial`;
    try {
      active.phase = 'copy';
      ev({ phase: 'copy', received: 0 });
      await pipeline(
        fs.createReadStream(srcPath, { highWaterMark: 4 * MiB }),
        meter(null, emit, { received: 0, event: base.event }),
        fs.createWriteStream(part, { flags: 'w', mode: 0o644 }),
        { signal: ctl.signal },
      );
      fs.renameSync(part, final);
      ev({ phase: 'done', received: st.size });
    } catch (e) {
      try {
        fs.unlinkSync(part);
      } catch {
        /* nothing to remove */
      }
      if (e && (e.name === 'AbortError' || ctl.signal.aborted)) ev({ phase: 'cancelled' });
      else {
        console.log(`[models] import ${name} failed: ${e && e.message}`);
        ev({ phase: 'error', error: String((e && e.message) || e) });
      }
    } finally {
      finish();
    }
  })();
  return { started: true, name, bytes: st.size };
}

/** Stops the running transfer. A download keeps its `.partial` file, so it can be resumed. */
function cancel() {
  if (active) active.ctl.abort();
  return { cancelled: !!active };
}

/** Deletes a model file (and its partial). `name` must be a file listed by listLocal() or a catalog partial. */
function remove(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('Unknown model file');
  if (active && (active.key === name || (active.kind === 'download' && catalogEntry(active.key)?.file === name))) {
    throw new Error('That file is being transferred; cancel the transfer first.');
  }
  let removed = false;
  for (const f of [path.join(DIR, name), path.join(DIR, `${name}.partial`)]) {
    try {
      fs.unlinkSync(f);
      removed = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { removed };
}

/** The absolute path of a model in /data/models, or throws. */
function pathOf(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('Unknown model file');
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) throw new Error('That model file is not in the models folder (any more)');
  return p;
}

module.exports = { DIR, CATALOG, state, download, importFile, cancel, remove, pathOf, listLocal, safeName, transferInfo };
