'use strict';
// Shared helpers for the registry tests. Scratch space is under $VMAPP_WORK/scratch/registry (VMAPP_WORK defaults to
// vmapp/out/work, git-ignored); never the system temp dir.
const fs = require('fs');
const path = require('path');
const { createRegistry } = require('../../registry/lib/registry');
const { encodeProfileHeader } = require('../../registry/lib/publisher');
const pkg = require('../../hostlib/package');

const ROOT = path.resolve(__dirname, '..', '..'); // .../vmapp
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(ROOT, 'out', 'work'));
const SCRATCH = path.join(WORK, 'scratch', 'registry');
const FIXTURE = path.join(__dirname, 'fixtures', 'basic');

function tmpdir(prefix = 't-') {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, prefix));
}

function rmrf(dir) {
  if (dir && dir.startsWith(SCRATCH + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

function makeClock(start = Date.parse('2026-03-01T12:00:00Z')) {
  let t = start;
  const f = () => t;
  f.advance = (ms) => {
    t += ms;
  };
  return f;
}

/** Copies the fixture project to <workDir>/<name>, merges `manifest` into its vmapp.json, packs it. */
function buildPackage(workDir, name, manifest = {}) {
  const proj = path.join(workDir, name);
  fs.cpSync(FIXTURE, proj, { recursive: true });
  const mf = path.join(proj, 'vmapp.json');
  const m = Object.assign(JSON.parse(fs.readFileSync(mf, 'utf8')), manifest);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  const file = path.join(workDir, `${name}.vmapp`);
  const r = pkg.pack(proj, file);
  return { file, packageId: r.packageId, manifest: r.manifest, size: r.size };
}

/** Starts a registry on an ephemeral port in a fresh scratch data dir (local storage unless opts.storage says otherwise). */
async function startRegistry(opts = {}) {
  const dir = opts.dataDir ? null : tmpdir('reg-'); // with an explicit dataDir the caller owns the cleanup
  const dataDir = opts.dataDir || path.join(dir, 'data');
  const clock = opts.now || makeClock();
  const reg = createRegistry(Object.assign({
    dataDir, port: 0, trustProxy: true, publishPerHour: 1000, apiPerMinute: 100000,
  }, opts, { now: clock }));
  const info = await reg.start();
  return { reg, url: info.url, dataDir, storeDir: path.join(dataDir, 'store'), dir, clock, close: () => reg.close() };
}

/** Every file below `root` (a directory), as sorted relative paths; the store's .tmp folder is skipped. */
function listFiles(root) {
  const out = [];
  (function walk(rel) {
    const abs = path.join(root, rel);
    for (const n of fs.readdirSync(abs).sort()) {
      if (n === '.tmp') continue;
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(path.join(abs, n)).isDirectory()) walk(r);
      else out.push(r);
    }
  })('');
  return out;
}

/** The text of all events and snapshots in a local store: what is on disk about people, for "is X stored?" checks. */
function storeText(storeDir) {
  let s = '';
  for (const f of listFiles(storeDir)) if (f.startsWith('events/') || f.startsWith('snapshots/')) s += fs.readFileSync(path.join(storeDir, f), 'utf8');
  return s;
}

/** fetch wrapper: { status, headers, text, json }. */
async function call(url, p, { method = 'GET', headers = {}, body, json, token, ip } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = `Bearer ${token}`;
  if (ip) h['X-Forwarded-For'] = ip;
  let b = body;
  if (json !== undefined) {
    b = JSON.stringify(json);
    h['Content-Type'] = 'application/json';
  }
  const res = await fetch(url + p, { method, headers: h, body: b });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json: parsed };
}

function publish(url, file, { token, profile, ip, headers = {} } = {}) {
  const h = Object.assign({ 'Content-Type': 'application/octet-stream' }, headers);
  if (profile) h['X-Vmapp-Publisher'] = encodeProfileHeader(profile);
  return call(url, '/api/publish', { method: 'POST', headers: h, body: fs.readFileSync(file), token, ip });
}

module.exports = { ROOT, WORK, SCRATCH, FIXTURE, tmpdir, rmrf, makeClock, buildPackage, startRegistry, listFiles, storeText, call, publish };
