'use strict';
// VMAPP_HOME layout (SPEC section 1) and the install / list / uninstall lifecycle (SPEC section 8).
//
//   $VMAPP_HOME/runtimes/<name>.img   $VMAPP_HOME/apps/<id>/<version>/   $VMAPP_HOME/apps/<id>/current
//   $VMAPP_HOME/data/<id>/            $VMAPP_HOME/grants/<id>.json       $VMAPP_HOME/logs/<id>.console.log
//   $VMAPP_HOME/apps/<id>/source.json (installed from a registry)   $VMAPP_HOME/apps/<id>/policy.json (SPEC 8.1)
//   $VMAPP_HOME/apps/<id>/pkg/<version>.vmapp (the installed package file, kept for Publish)
//   $VMAPP_HOME/apps/<id>/dev.json (developer build: the project folder it was built from)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('./package');
const { ID_RE, SEMVER_RE, CAP_ID_RE, FOLDER_ACCESS, RUNTIMES, HOST_APIS, DEVICE_NAMES, parseManifest, compareVersions, parseHostCap } = require('./manifest');

const netperm = require('./network'); // network grants (SPEC 8.3)
const resperm = require('./resources'); // the user's choice of VM size (SPEC 2.2, 8)

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

/**
 * Default data root: $VMAPP_HOME, else `vmapp-home` inside the scratch folder: $VMAPP_WORK, else <vmapp>/out/work
 * (git-ignored). Everything stays inside the repository unless the user points these variables elsewhere.
 */
function defaultHome() {
  if (process.env.VMAPP_HOME) return path.resolve(process.env.VMAPP_HOME);
  const work = process.env.VMAPP_WORK ? path.resolve(process.env.VMAPP_WORK) : path.resolve(__dirname, '..', 'out', 'work');
  return path.join(work, 'vmapp-home');
}

function assertId(id) {
  if (typeof id !== 'string' || id.length < 3 || id.length > 100 || !ID_RE.test(id)) {
    throw new StoreError(`invalid app id: ${JSON.stringify(id)}`);
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const UPDATE_CHOICES = ['manual', 'compatible', 'latest'];

/** "https://host:port/prefix" (no credentials, query or fragment, no trailing slash) or null. http(s) only. */
function normalizeRegistryUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  let p;
  try {
    p = new URL(u.trim());
  } catch {
    return null;
  }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  if (p.username || p.password || !p.hostname) return null;
  return (p.origin + p.pathname).replace(/\/+$/, '');
}

const HOST_GRANT_MODES = ['ask', 'session', 'always'];
const HOST_GRANT_KEYS = ['mode', 'tools', 'servers', 'api'];

/**
 * Host-capability grants (SPEC 8.2): { "<cap>": { mode: 'ask'|'session'|'always', tools?: [ids] (tool:* only),
 * servers?: [ids] (mcp:* only) } }. Structural checks only; whether a tool is a shell tool (never `always`) is
 * the catalog's business (capabilities.js setHostGrant).
 */
function validateHostGrants(h) {
  if (h === null || typeof h !== 'object' || Array.isArray(h)) throw new StoreError('grants.host must be an object');
  const out = {};
  for (const [cap, v] of Object.entries(h)) {
    const pc = parseHostCap(cap);
    if (!pc) throw new StoreError(`grants.host: invalid capability "${cap}"`);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new StoreError(`grants.host.${cap} must be an object {mode}`);
    for (const k of Object.keys(v)) if (!HOST_GRANT_KEYS.includes(k)) throw new StoreError(`grants.host.${cap}.${k} is not a known key`);
    if (!HOST_GRANT_MODES.includes(v.mode)) throw new StoreError(`grants.host.${cap}.mode must be one of ${HOST_GRANT_MODES.join(', ')}`);
    if (v.mode === 'always' && pc.kind === 'input') throw new StoreError('grants.host.input: "always" is not allowed for input control');
    // The GPU (SPEC 8.6) is a stream of requests, not a call you can be asked about: it is "Allow while the app runs" (`session`)
    // or off. There is no per-call `ask`, and no `always`.
    if (pc.kind === 'gpu' && v.mode !== 'session') throw new StoreError('grants.host.gpu: the only mode is "session" (allow while the app runs); remove the grant to turn it off');
    const g = { mode: v.mode };
    // SPEC 8.7: a `gpu` grant for the experimental Vulkan GPU records the API the user agreed to; the plain (llama.cpp RPC) grant has none.
    if (v.api !== undefined) {
      if (pc.kind !== 'gpu') throw new StoreError(`grants.host.${cap}.api is only valid for gpu`);
      if (!HOST_APIS.includes(v.api)) throw new StoreError(`grants.host.gpu.api must be one of ${HOST_APIS.join(', ')}`);
      g.api = v.api;
    }
    for (const [key, allowedFor] of [['tools', 'tool'], ['servers', 'mcp']]) {
      if (v[key] === undefined) continue;
      if (!pc.wildcard || pc.kind !== allowedFor) throw new StoreError(`grants.host.${cap}.${key} is only valid for ${allowedFor}:*`);
      if (!Array.isArray(v[key]) || v[key].length > 64) throw new StoreError(`grants.host.${cap}.${key} must be an array of at most 64 ids`);
      const seen = new Set();
      for (const id of v[key]) {
        if (typeof id !== 'string' || !CAP_ID_RE.test(id)) throw new StoreError(`grants.host.${cap}.${key}: invalid id ${JSON.stringify(id)}`);
        seen.add(id);
      }
      g[key] = [...seen];
    }
    out[cap] = g;
  }
  return out;
}

// ---- Device grants (SPEC 2.2 permissions.devices, SPEC 7): { "microphone": { mode: "allow" } } ----
// "allow" is the sheet's "Allow while the app runs": no further question, it applies on every run until the user changes it.
// A missing entry is "Don't allow" (the default). Only devices SPEC defines are accepted; "camera" is reserved and refused.
const DEVICE_GRANT_MODES = ['allow'];

function validateDeviceGrants(d) {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new StoreError('grants.devices must be an object');
  const out = {};
  for (const [name, v] of Object.entries(d)) {
    if (!DEVICE_NAMES.includes(name)) throw new StoreError(`grants.devices: "${name}" is not a device that can be granted`);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new StoreError(`grants.devices.${name} must be an object {mode}`);
    for (const k of Object.keys(v)) if (k !== 'mode') throw new StoreError(`grants.devices.${name}.${k} is not a known key`);
    if (!DEVICE_GRANT_MODES.includes(v.mode)) throw new StoreError(`grants.devices.${name}.mode must be one of ${DEVICE_GRANT_MODES.join(', ')}`);
    out[name] = { mode: v.mode };
  }
  return out;
}

/**
 * The one decision about a device (INV-B3, INV-D3): the manifest REQUESTS it (`permissions.devices`) AND the user's saved
 * grant allows it. `grants` is what loadGrants() returned (or null). Anything else, including an unknown device, is false.
 */
function deviceAllowed(manifest, grants, device) {
  const asked = ((manifest && manifest.permissions && manifest.permissions.devices) || []).some((d) => d && d.device === device);
  const g = grants && grants.devices && grants.devices[device];
  return asked && !!g && DEVICE_GRANT_MODES.includes(g.mode);
}

function validateGrants(g) {
  const out = { folders: {}, askEveryTime: false };
  if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new StoreError('grants must be an object');
  if (g.askEveryTime !== undefined) {
    if (typeof g.askEveryTime !== 'boolean') throw new StoreError('grants.askEveryTime must be a boolean');
    out.askEveryTime = g.askEveryTime;
  }
  if (g.folders !== undefined) {
    if (g.folders === null || typeof g.folders !== 'object' || Array.isArray(g.folders)) throw new StoreError('grants.folders must be an object');
    for (const [name, v] of Object.entries(g.folders)) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new StoreError(`grants.folders: invalid folder name "${name}"`);
      if (v === null) {
        out.folders[name] = null;
        continue;
      }
      if (typeof v !== 'object' || Array.isArray(v)) throw new StoreError(`grants.folders.${name} must be null or {path, access}`);
      if (typeof v.path !== 'string' || !path.isAbsolute(v.path)) throw new StoreError(`grants.folders.${name}.path must be an absolute path`);
      if (!FOLDER_ACCESS.includes(v.access)) throw new StoreError(`grants.folders.${name}.access must be one of ${FOLDER_ACCESS.join(', ')}`);
      out.folders[name] = { path: v.path, access: v.access };
    }
  }
  // present only when the user granted something, so files and results without host grants keep their old shape
  if (g.host !== undefined) {
    const h = validateHostGrants(g.host);
    if (Object.keys(h).length) out.host = h;
  }
  // likewise for devices (SPEC 7): present only when the user allowed one
  if (g.devices !== undefined) {
    const d = validateDeviceGrants(g.devices);
    if (Object.keys(d).length) out.devices = d;
  }
  // and for network (SPEC 8.3): present only when the user allowed or declined a host
  if (g.network !== undefined) {
    const n = netperm.validateNetworkGrants(g.network, (m) => new StoreError(m));
    if (Object.keys(n).length) out.network = n;
  }
  // and for the VM size the user chose (SPEC 2.2, 8): present only when they chose something
  if (g.resources !== undefined && g.resources !== null) {
    const r = resperm.validateStoredResources(g.resources, (m) => new StoreError(m));
    if (r) out.resources = r;
  }
  return out;
}

class Store {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] data root (default: $VMAPP_HOME or $VMAPP_WORK/vmapp-home, see defaultHome)
   * @param {boolean} [opts.skipRuntimeCheck] do not require runtimes/<name>.img on install (tests)
   */
  constructor(opts = {}) {
    this.home = path.resolve(opts.home || defaultHome());
    this.skipRuntimeCheck = !!opts.skipRuntimeCheck;
  }

  // ---- paths ----
  runtimePath(name) {
    if (!RUNTIMES.includes(name)) throw new StoreError(`unknown runtime "${name}"`);
    return path.join(this.home, 'runtimes', `${name}.img`);
  }
  appRoot(id) {
    assertId(id);
    return path.join(this.home, 'apps', id);
  }
  appDir(id, version) {
    if (!SEMVER_RE.test(version)) throw new StoreError(`invalid version ${JSON.stringify(version)}`);
    return path.join(this.appRoot(id), version);
  }
  /** apps/<id>/pkg/<version>.vmapp: the package file exactly as it was installed (kept for "Publish…"). */
  packagePath(id, version) {
    if (!SEMVER_RE.test(version)) throw new StoreError(`invalid version ${JSON.stringify(version)}`);
    return path.join(this.appRoot(id), 'pkg', `${version}.vmapp`);
  }
  /** The kept .vmapp of an installed version (default: the current one), or null (installed before packages were kept). */
  getPackageFile(id, version) {
    const v = version || this.currentVersion(id);
    if (!v) return null;
    const f = this.packagePath(id, v);
    return fs.existsSync(f) ? f : null;
  }
  dataDir(id) {
    assertId(id);
    return path.join(this.home, 'data', id);
  }
  grantsPath(id) {
    assertId(id);
    return path.join(this.home, 'grants', `${id}.json`);
  }
  consoleLogPath(id) {
    assertId(id);
    return path.join(this.home, 'logs', `${id}.console.log`);
  }
  /** Cloned files of the app's file picks (dialog.open): picks/<id>/pick-N/. Only exists while the app runs. */
  picksDir(id) {
    assertId(id);
    return path.join(this.home, 'picks', id);
  }

  /**
   * Reset (SPEC 2.2 Future): empties data/<id>/ (the folder itself stays), forgets grants/<id>.json and clears
   * picks/<id>/. The package, the user's own granted folders and the console log are not touched.
   * The caller must make sure the app is not running.
   */
  resetApp(id) {
    assertId(id);
    const data = this.dataDir(id);
    if (fs.existsSync(data)) {
      for (const name of fs.readdirSync(data)) fs.rmSync(path.join(data, name), { recursive: true, force: true });
    } else {
      fs.mkdirSync(data, { recursive: true });
    }
    fs.rmSync(this.grantsPath(id), { force: true });
    fs.rmSync(this.picksDir(id), { recursive: true, force: true });
    return { id, reset: true };
  }

  // ---- runtimes ----
  hasRuntime(name) {
    return fs.existsSync(this.runtimePath(name));
  }
  installRuntime(name, imgFile) {
    const dest = this.runtimePath(name);
    if (!fs.statSync(imgFile).isFile()) throw new StoreError(`${imgFile} is not a file`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      fs.copyFileSync(imgFile, tmp, fs.constants.COPYFILE_FICLONE); // instant APFS clone where possible
    } catch {
      fs.copyFileSync(imgFile, tmp);
    }
    fs.renameSync(tmp, dest);
    return dest;
  }
  listRuntimes() {
    return RUNTIMES.filter((n) => this.hasRuntime(n));
  }

  // ---- install ----
  currentVersion(id) {
    const f = path.join(this.appRoot(id), 'current');
    if (!fs.existsSync(f)) return null;
    const v = fs.readFileSync(f, 'utf8').trim();
    return SEMVER_RE.test(v) ? v : null;
  }

  /**
   * Installs a .vmapp file: verifies it, checks the runtime and the version rule, extracts to
   * apps/<id>/<version>/ and writes `current`. Returns { id, version, packageId, previous, dir }.
   * opts.force allows a downgrade; opts.skipRuntimeCheck overrides the store setting.
   */
  install(file, opts = {}) {
    // read the bytes once: what is verified is exactly what is installed and what is kept (apps/<id>/pkg/<version>.vmapp)
    const st = fs.statSync(file);
    if (!st.isFile()) throw new pkg.PackageError(`${file}: not a file`);
    if (st.size > pkg.MAX_PACKAGE) throw new pkg.PackageError(`${file} is ${st.size} bytes, larger than the limit of ${pkg.MAX_PACKAGE}`);
    const raw = fs.readFileSync(file);
    const p = pkg.load(raw, path.basename(file));
    const m = p.manifest;
    const skip = opts.skipRuntimeCheck !== undefined ? opts.skipRuntimeCheck : this.skipRuntimeCheck;
    if (!skip && !this.hasRuntime(m.runtime)) {
      throw new StoreError(`runtime "${m.runtime}" is not installed (expected ${this.runtimePath(m.runtime)})`);
    }
    const prev = this.currentVersion(m.id);
    if (prev && compareVersions(m.version, prev) < 0 && !opts.force) {
      throw new StoreError(`${m.id} ${prev} is installed; refusing to downgrade to ${m.version} (use --force)`);
    }
    const prevManifest = this._manifestOrNull(m.id, prev); // read before the files of a reinstall are replaced
    const appRoot = this.appRoot(m.id);
    const dest = this.appDir(m.id, m.version);
    fs.mkdirSync(appRoot, { recursive: true });
    const tmp = path.join(appRoot, `.install-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(tmp);
    try {
      for (const e of p.entries) {
        const target = path.join(tmp, ...e.path.split('/'));
        const rel = path.relative(tmp, target);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new StoreError(`refusing to extract "${e.path}" outside the app folder`);
        if (e.type === 'dir') fs.mkdirSync(target, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, e.data, { mode: 0o644 });
        }
      }
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    // keep the original .vmapp next to the extracted files, so "Publish…" can send exactly what was installed
    try {
      const keep = this.packagePath(m.id, m.version);
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      const keepTmp = `${keep}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(keepTmp, raw, { mode: 0o644 });
      fs.renameSync(keepTmp, keep);
    } catch (err) {
      throw new StoreError(`cannot keep a copy of the package: ${err.message}`);
    }
    writeAtomic(path.join(appRoot, 'current'), m.version + '\n');
    this.pruneNetGrants(m.id, m, prevManifest); // network grants of hosts this version no longer lists do not outlive it (SPEC 8.3)
    this.pruneDeviceGrants(m.id, m); // likewise a device (the microphone) this version no longer asks for (SPEC 8.4)
    this.pruneGpuGrant(m.id, m); // and the GPU (SPEC 8.6)
    fs.mkdirSync(this.dataDir(m.id), { recursive: true });
    if (opts.source) this.setSource(m.id, { registry: opts.source.registry, installedFrom: m.version });
    // a developer build is marked by the folder it came from; any other install of this id ends that
    if (opts.dev) this.setDevSource(m.id, { path: opts.dev.path });
    else this.clearDevSource(m.id);
    const pruned = this.prune(m.id);
    return { id: m.id, version: m.version, packageId: p.packageId, previous: prev, dir: dest, pruned };
  }

  // ---- versions, source and update policy (SPEC 8.1) ----
  /** Installed versions of an app, oldest first. Only complete installs (a vmapp.json inside) count. */
  listVersions(id) {
    const root = this.appRoot(id);
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const name of fs.readdirSync(root)) {
      if (!SEMVER_RE.test(name)) continue;
      if (!fs.existsSync(path.join(root, name, 'vmapp.json'))) continue;
      out.push(name);
    }
    return out.sort(compareVersions);
  }

  /** The manifest of one installed version (parsed and checked), or null if that version is not installed. */
  getVersionManifest(id, version) {
    const f = path.join(this.appDir(id, version), 'vmapp.json');
    if (!fs.existsSync(f)) return null;
    return parseManifest(fs.readFileSync(f), { files: 'required' });
  }

  /** The manifest of an installed version, or null (no such version, or unreadable): used where a missing one only means "nothing to compare". */
  _manifestOrNull(id, version) {
    if (!version) return null;
    try {
      return this.getVersionManifest(id, version);
    } catch {
      return null;
    }
  }

  /**
   * Makes an installed version the current one ("Use version X"). The version must be installed and its files must
   * still match its manifest; whether the app is running is the caller's business (the loader refuses while it runs).
   * Prunes old versions after the switch. Returns { id, version, previous, pruned }.
   */
  useVersion(id, version) {
    assertId(id);
    if (!this.listVersions(id).includes(version)) throw new StoreError(`${id} ${version} is not installed`);
    const dir = this.appDir(id, version);
    const manifest = this.getVersionManifest(id, version);
    if (manifest.id !== id || manifest.version !== version) throw new StoreError(`${id} ${version}: the installed manifest says ${manifest.id} ${manifest.version}`);
    for (const [rel, want] of Object.entries(manifest.files)) {
      const f = path.join(dir, ...rel.split('/'));
      if (!fs.existsSync(f)) throw new StoreError(`${id} ${version}: installed file missing: ${rel}`);
      if (pkg.sha256(fs.readFileSync(f)) !== want) throw new StoreError(`${id} ${version}: installed file modified: ${rel}`);
    }
    const prev = this.currentVersion(id);
    const prevManifest = this._manifestOrNull(id, prev);
    writeAtomic(path.join(this.appRoot(id), 'current'), version + '\n');
    this.pruneNetGrants(id, manifest, prevManifest);
    this.pruneDeviceGrants(id, manifest);
    this.pruneGpuGrant(id, manifest);
    const now = new Date();
    fs.utimesSync(dir, now, now); // "last made current": prune() keeps the most recent ones
    const pruned = this.prune(id);
    return { id, version, previous: prev, pruned };
  }

  /**
   * Keeps the current version plus the 2 versions that were current most recently before it (by the folder's
   * modification time, which install and useVersion set); removes the rest. Returns the removed versions.
   */
  prune(id, keepPrevious = 2) {
    const current = this.currentVersion(id);
    if (!current) return [];
    const root = this.appRoot(id);
    const others = this.listVersions(id)
      .filter((v) => v !== current)
      .map((v) => ({ v, t: fs.statSync(path.join(root, v)).mtimeMs }))
      .sort((a, b) => b.t - a.t || compareVersions(b.v, a.v));
    const removed = [];
    for (const o of others.slice(keepPrevious)) {
      fs.rmSync(path.join(root, o.v), { recursive: true, force: true });
      fs.rmSync(this.packagePath(id, o.v), { force: true });
      removed.push(o.v);
    }
    return removed;
  }

  /** apps/<id>/source.json: { registry, id, installedFrom } or null (not from a registry, or unreadable). */
  getSource(id) {
    const f = path.join(this.appRoot(id), 'source.json');
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j || typeof j !== 'object' || typeof j.registry !== 'string') return null;
      const registry = normalizeRegistryUrl(j.registry);
      if (!registry) return null;
      return { registry, id, installedFrom: typeof j.installedFrom === 'string' && SEMVER_RE.test(j.installedFrom) ? j.installedFrom : null };
    } catch {
      return null;
    }
  }

  /** Records which registry the app came from. `installedFrom` stays the first version when the registry is unchanged. */
  setSource(id, { registry, installedFrom }) {
    const reg = normalizeRegistryUrl(registry);
    if (!reg) throw new StoreError(`invalid registry address ${JSON.stringify(registry)} (expected http:// or https://)`);
    if (!SEMVER_RE.test(installedFrom)) throw new StoreError(`invalid version ${JSON.stringify(installedFrom)}`);
    const old = this.getSource(id);
    const first = old && old.registry === reg && old.installedFrom ? old.installedFrom : installedFrom;
    writeAtomic(path.join(this.appRoot(id), 'source.json'), JSON.stringify({ registry: reg, id, installedFrom: first }, null, 2) + '\n');
    return { registry: reg, id, installedFrom: first };
  }

  /**
   * apps/<id>/dev.json: { path } when the current install is a developer build made from a project folder (the loader's
   * "Run project folder…"), else null. Such an app never checks a registry for updates by itself.
   */
  getDevSource(id) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.appRoot(id), 'dev.json'), 'utf8'));
      return j && typeof j.path === 'string' && path.isAbsolute(j.path) ? { path: j.path } : null;
    } catch {
      return null;
    }
  }

  setDevSource(id, { path: folder }) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new StoreError('a developer build needs the absolute path of its project folder');
    writeAtomic(path.join(this.appRoot(id), 'dev.json'), JSON.stringify({ path: folder }) + '\n');
    return { path: folder };
  }

  clearDevSource(id) {
    fs.rmSync(path.join(this.appRoot(id), 'dev.json'), { force: true });
  }

  /** 'manual' | 'compatible' | 'latest' (default and fallback for an unreadable file: manual). */
  getPolicy(id) {
    const f = path.join(this.appRoot(id), 'policy.json');
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return j && UPDATE_CHOICES.includes(j.update) ? j.update : 'manual';
    } catch {
      return 'manual';
    }
  }

  setPolicy(id, choice) {
    if (!UPDATE_CHOICES.includes(choice)) throw new StoreError(`update choice must be one of ${UPDATE_CHOICES.join(', ')}`);
    if (!this.currentVersion(id)) throw new StoreError(`${id} is not installed`);
    writeAtomic(path.join(this.appRoot(id), 'policy.json'), JSON.stringify({ update: choice }) + '\n');
    return choice;
  }

  // ---- query ----
  /** Returns the installed (current) app info or null. */
  get(id) {
    const version = this.currentVersion(id);
    if (!version) return null;
    const dir = this.appDir(id, version);
    const mf = path.join(dir, 'vmapp.json');
    if (!fs.existsSync(mf)) return null;
    const bytes = fs.readFileSync(mf);
    const manifest = parseManifest(bytes, { files: 'required' });
    const icon = path.join(dir, 'icon.png');
    return {
      id,
      version,
      dir,
      manifest,
      packageId: crypto.createHash('sha256').update(bytes).digest('hex'),
      uiDir: path.join(dir, manifest.ui.root),
      coreFile: path.join(dir, pkg.coreEntryName(manifest)), // core.cpio or core.erofs (SPEC 2.1): the VM's /dev/vdb
      iconPath: fs.existsSync(icon) ? icon : null,
      dataDir: this.dataDir(id),
    };
  }

  /** Lists installed apps (entries that fail to load are returned as { id, error }). */
  list() {
    const root = path.join(this.home, 'apps');
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const id of fs.readdirSync(root).sort()) {
      if (!ID_RE.test(id)) continue;
      try {
        const a = this.get(id);
        if (a) out.push(a);
      } catch (e) {
        out.push({ id, error: e.message });
      }
    }
    return out;
  }

  /** Re-hashes the installed files against the manifest. Throws on mismatch. */
  verifyInstalled(id) {
    const a = this.get(id);
    if (!a) throw new StoreError(`${id} is not installed`);
    for (const [rel, want] of Object.entries(a.manifest.files)) {
      const f = path.join(a.dir, ...rel.split('/'));
      if (!fs.existsSync(f)) throw new StoreError(`installed file missing: ${rel}`);
      const got = pkg.sha256(fs.readFileSync(f));
      if (got !== want) throw new StoreError(`installed file modified: ${rel}`);
    }
    return true;
  }

  uninstall(id, opts = {}) {
    assertId(id);
    const root = this.appRoot(id);
    const had = fs.existsSync(root);
    if (!had) throw new StoreError(`${id} is not installed`);
    fs.rmSync(root, { recursive: true, force: true });
    if (opts.purge) {
      fs.rmSync(this.dataDir(id), { recursive: true, force: true });
      fs.rmSync(this.grantsPath(id), { force: true });
      fs.rmSync(this.consoleLogPath(id), { force: true });
    }
    return { id, purged: !!opts.purge };
  }

  // ---- grants ----
  loadGrants(id) {
    const f = this.grantsPath(id);
    if (!fs.existsSync(f)) return { folders: {}, askEveryTime: false };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      throw new StoreError(`${f}: not valid JSON (${e.message})`);
    }
    return validateGrants(raw);
  }
  /**
   * Saves folder grants. Host grants (SPEC 8.2) are kept as they are on disk when `grants.host` is not given, so the
   * folder-permission UI cannot wipe them by saving only {folders, askEveryTime}; pass `host: {}` to clear them.
   */
  saveGrants(id, grants) {
    const v = validateGrants(grants);
    if (grants && grants.host === undefined) {
      const old = this.loadHostGrants(id);
      if (Object.keys(old).length) v.host = old;
    }
    // network grants (SPEC 8.3) likewise: saving only folders never wipes them; pass `network: {}` to clear
    if (grants && grants.network === undefined) {
      const old = this.loadNetGrants(id);
      if (Object.keys(old).length) v.network = old;
    }
    // device grants (SPEC 7) are kept the same way: saving only folders never wipes them; pass `devices: {}` to clear
    if (grants && grants.devices === undefined) {
      const old = this.loadDeviceGrants(id);
      if (Object.keys(old).length) v.devices = old;
    }
    // the VM size the user chose is kept the same way; pass `resources: null` to forget it
    if (grants && grants.resources === undefined) {
      const old = this.loadResources(id);
      if (old) v.resources = old;
    }
    writeAtomic(this.grantsPath(id), JSON.stringify(v, null, 2) + '\n');
    return v;
  }

  /**
   * Has the user decided anything yet (the permission sheet saved, or a CLI grant)? A grants file that holds only the VM size
   * (chosen on the card before the first launch) is NOT a decision: the first launch still shows the permission sheet.
   */
  hasDecided(id) {
    const f = this.grantsPath(id);
    if (!fs.existsSync(f)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      return !!raw && typeof raw === 'object' && Object.keys(raw).some((k) => k !== 'resources');
    } catch {
      return true; // unreadable: not "never decided"; loadGrants reports the problem where it matters
    }
  }

  // ---- the VM size the user chose (SPEC 2.2, 8): grants/<id>.json `resources` = {cpus?, memoryMiB?} ----
  /** {cpus?, memoryMiB?} or null (the defaults apply). */
  loadResources(id) {
    return this.loadGrants(id).resources || null;
  }
  /**
   * Replaces the user's VM-size choice (validated structurally; the host's limits are `resources.checkResources`' business, which
   * the loader and the CLI call first). `null` or {} forgets it. Folder, host, device and network grants are kept. A file that
   * holds only this choice is written without the other keys, so hasDecided() stays false until the user decides something else.
   */
  saveResources(id, resources) {
    const clean = resources ? resperm.validateStoredResources(resources, (m) => new StoreError(m)) : null;
    const f = this.grantsPath(id);
    if (!this.hasDecided(id)) {
      if (!clean) fs.rmSync(f, { force: true });
      else writeAtomic(f, JSON.stringify({ resources: clean }, null, 2) + '\n');
      return clean;
    }
    const g = this.loadGrants(id);
    if (clean) g.resources = clean;
    else delete g.resources;
    writeAtomic(f, JSON.stringify(validateGrants(g), null, 2) + '\n');
    return clean;
  }

  // ---- device grants (SPEC 2.2 permissions.devices, SPEC 7) ----
  /** { "microphone": {mode:'allow'} } ({} when none). */
  loadDeviceGrants(id) {
    return this.loadGrants(id).devices || {};
  }
  /** Replaces all device grants of an app (validated); folder and host grants are kept. */
  saveDeviceGrants(id, devices) {
    const g = this.loadGrants(id);
    const clean = validateDeviceGrants(devices);
    if (Object.keys(clean).length) g.devices = clean;
    else delete g.devices;
    writeAtomic(this.grantsPath(id), JSON.stringify(validateGrants(g), null, 2) + '\n');
    return clean;
  }
  /** Sets (or, with `grant === null`, removes) one device grant. Returns the app's device grants. */
  setDeviceGrant(id, device, grant) {
    const devices = Object.assign({}, this.loadDeviceGrants(id));
    if (grant === null) delete devices[device];
    else devices[device] = grant;
    return this.saveDeviceGrants(id, devices);
  }
  /**
   * A device grant does not outlive the request: when the version that becomes current no longer asks for a device, its
   * grant is dropped, so a later version that asks again starts on "Don't allow" (an update never grants anything, SPEC 8.1).
   * Returns the devices that were dropped. Unreadable grants are left to loadGrants to report.
   */
  pruneDeviceGrants(id, manifest) {
    try {
      const all = this.loadDeviceGrants(id);
      const asked = new Set((((manifest && manifest.permissions) || {}).devices || []).map((d) => d.device));
      const dropped = Object.keys(all).filter((d) => !asked.has(d));
      if (dropped.length) {
        for (const d of dropped) delete all[d];
        this.saveDeviceGrants(id, all);
      }
      return dropped;
    } catch {
      return [];
    }
  }

  // ---- host-capability grants (SPEC 8.2) ----
  /** { "<cap>": {mode, tools?, servers?} } ({} when none). */
  loadHostGrants(id) {
    return this.loadGrants(id).host || {};
  }
  /** Replaces all host grants of an app (validated); folder grants are kept. */
  saveHostGrants(id, host) {
    const g = this.loadGrants(id);
    const clean = validateHostGrants(host);
    if (Object.keys(clean).length) g.host = clean;
    else delete g.host;
    writeAtomic(this.grantsPath(id), JSON.stringify(validateGrants(g), null, 2) + '\n');
    return clean;
  }
  /** Sets (or, with `grant === null`, removes) one host grant. Returns the app's host grants. */
  setHostGrant(id, cap, grant) {
    const host = Object.assign({}, this.loadHostGrants(id));
    if (grant === null) delete host[cap];
    else host[cap] = grant;
    return this.saveHostGrants(id, host);
  }
  /**
   * The GPU grant (SPEC 8.6) is "Allow while the app runs" on every run, so, like a device grant, it does not outlive the
   * request: when the version that becomes current no longer asks for `gpu`, the grant is dropped, and a later version that
   * asks again starts on "Don't allow" (an update never grants anything, SPEC 8.1). The same when it asks for another API (the
   * llama.cpp RPC service and the experimental Vulkan GPU, SPEC 8.7, are different things to allow). Returns true when a grant
   * was dropped.
   */
  pruneGpuGrant(id, manifest) {
    try {
      const entry = ((manifest && manifest.permissions && manifest.permissions.host) || []).find((h) => h.cap === 'gpu');
      const all = this.loadHostGrants(id);
      if (!all.gpu) return false;
      if (entry && (entry.api || null) === (all.gpu.api || null)) return false;
      delete all.gpu;
      this.saveHostGrants(id, all);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * `session` grants are valid for one run (SPEC 8.2: "allowed until the app stops"); when the app stops they go back
   * to `ask`. Returns the capabilities that were reset. The one exception is `gpu` (SPEC 8.6): it has no `ask`, and its
   * `session` is the sheet's "Allow while the app runs" in the same sense as the microphone's: a decision about this app
   * that holds on every run until the user changes it.
   */
  expireSessionHostGrants(id) {
    const host = this.loadHostGrants(id);
    const reset = [];
    for (const [cap, g] of Object.entries(host)) {
      if (g.mode === 'session' && cap !== 'gpu') {
        host[cap] = Object.assign({}, g, { mode: 'ask' });
        reset.push(cap);
      }
    }
    if (reset.length) this.saveHostGrants(id, host);
    return reset;
  }
}

// ---- network grants (SPEC 8.3): grants/<id>.json `network` = { "<host pattern>": { allow, ports? } } ----
// A separate block: the folder, host and device grants above are untouched by these. Default is deny: no entry, no network.

/** { "<host pattern>": {allow, ports?} } ({} when none). */
Store.prototype.loadNetGrants = function loadNetGrants(id) {
  return this.loadGrants(id).network || {};
};

/** Replaces all network grants of an app (validated); folder, host and device grants are kept. */
Store.prototype.saveNetGrants = function saveNetGrants(id, network) {
  const g = this.loadGrants(id);
  const clean = netperm.validateNetworkGrants(network, (m) => new StoreError(m));
  if (Object.keys(clean).length) g.network = clean;
  else delete g.network;
  writeAtomic(this.grantsPath(id), JSON.stringify(validateGrants(g), null, 2) + '\n');
  return clean;
};

/**
 * Sets (or, with `grant === null`, removes) the grant of one host entry: { allow: true|false, ports? }. Returns the app's
 * network grants. Whether the manifest lists the host is `network.checkNetGrant`'s business (the CLI and the loader call it).
 */
Store.prototype.setNetGrant = function setNetGrant(id, host, grant) {
  const all = Object.assign({}, this.loadNetGrants(id));
  if (grant === null) delete all[host];
  else all[host] = grant;
  return this.saveNetGrants(id, all);
};

/**
 * Drops the grants that do not belong to `manifest`: hosts it does not list and ports it no longer requests. Called when a
 * version becomes current, so a grant never comes back to life when a later version lists the host again.
 *
 * `previousManifest` (the version that was current until now) closes a hole: an allowed host WITHOUT explicit `ports` means
 * "all the ports the manifest requests", so a new version that asks for more ports would be granted them without the user
 * saying so (SPEC 8.1, INV-N2: an update never grants anything). Such a grant is pinned to the ports the previous version
 * asked for (those the new version still asks for) before the new version starts using it.
 * Returns the hosts whose grants were dropped.
 */
Store.prototype.pruneNetGrants = function pruneNetGrants(id, manifest, previousManifest) {
  try {
    const all = this.loadNetGrants(id);
    const listed = (m) => new Map((((m && m.permissions) || {}).network || []).map((e) => [e.host, e]));
    const entries = listed(manifest);
    const before = listed(previousManifest);
    let changed = false;
    const dropped = [];
    for (const h of Object.keys(all)) {
      const e = entries.get(h);
      if (!e || (all[h].ports && !netperm.portsWithin(all[h].ports, e.ports))) {
        dropped.push(h);
        delete all[h];
        changed = true;
        continue;
      }
      const old = before.get(h);
      // "all requested" may only keep meaning what the user saw: if the new version asks for ports the old did not (a list, or
      // "*"), the grant is pinned to the old ones it still asks for
      if (all[h].allow === true && !all[h].ports && old && !netperm.portsWithin(e.ports, old.ports)) {
        const kept = e.ports === '*' ? old.ports.slice() : old.ports.filter((p) => e.ports.includes(p));
        if (!kept.length) {
          dropped.push(h);
          delete all[h];
        } else all[h] = Object.assign({}, all[h], { ports: kept });
        changed = true;
      }
    }
    if (changed) this.saveNetGrants(id, all);
    return dropped;
  } catch {
    return []; // unreadable grants: there is nothing to prune (loadGrants reports it where it matters)
  }
};

module.exports = { Store, StoreError, defaultHome, validateGrants, validateHostGrants, validateDeviceGrants, deviceAllowed, normalizeRegistryUrl, UPDATE_CHOICES, HOST_GRANT_MODES, DEVICE_GRANT_MODES };
