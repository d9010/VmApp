'use strict';
// AppSession: runs one installed app (SPEC sections 5, 6, 8). Spawns vmapp-vm, connects the bridge, routes
// invoke/send/emit/request traffic, enforces the manifest permissions and the stop sequence.
//
// The renderer side is injected:
//   windowManager: { create(params)->Promise<winId>, close(win), setTitle(win,title), focus(win),
//                    emit(win,channel,args) }
//   dialogs:       { open({win,title,directory,multiple,app})->hostPaths|null,
//                    save({win,title,defaultName,app})->hostPath|null,
//                    message({win,type,message,detail,buttons,app})->index,
//                    confirmExternal(url,app)->bool, openExternal?(url)->void }
// and the host calls back into the session: invoke(win,channel,args), send(win,channel,args),
// windowEvent(win,event,data). See hostlib/README.md.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const readline = require('readline');
const { EventEmitter } = require('events');
const { BridgeClient } = require('./bridge');
const { Store, deviceAllowed } = require('./store');
const { resolveNetwork, ruleArg, portsWithin, portsArg } = require('./network');
const { resolveResources, hostLimits, describeSize } = require('./resources');
const gpuLib = require('./gpu');
const { validateMenuTemplate, MenuError } = require('./menus');

const ACCESS_FLAG = { read: 'ro', readwrite: 'rw', writeonly: 'wo' };
// A grant may be narrower than the request (SPEC 8: readwrite can be downgraded), never wider.
const ALLOWED_ACCESS = { readwrite: ['readwrite', 'read', 'writeonly'], read: ['read'], writeonly: ['writeonly'] };
const MESSAGE_TYPES = ['info', 'warning', 'error', 'question'];
const MAX_WINDOWS = 32;
const CLIPBOARD_MAX = 1024 * 1024; // characters, each way

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defer() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

/** Resolves true if `p` settles first, false on timeout. */
function settledWithin(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve(true);
      },
      () => {
        clearTimeout(t);
        resolve(true);
      },
    );
  });
}

/**
 * Computes the folder shares from the manifest request and the user's grants.
 * Returns { shares: [{name:'f-<n>', access:'ro|rw|wo', path}], folders: {<n>: '/host/f-<n>' | null}, notes: [string] }.
 */
function resolveFolders(manifest, grants) {
  const shares = [];
  const folders = {};
  const notes = [];
  const g = (grants && grants.folders) || {};
  for (const req of manifest.permissions.folders) {
    folders[req.name] = null;
    const grant = g[req.name];
    if (!grant) continue;
    if (!ALLOWED_ACCESS[req.access].includes(grant.access)) {
      notes.push(`folder "${req.name}": granted access "${grant.access}" is wider than requested "${req.access}"; ignored`);
      continue;
    }
    let st;
    try {
      st = fs.statSync(grant.path);
    } catch {
      notes.push(`folder "${req.name}": ${grant.path} does not exist; not shared`);
      continue;
    }
    if (!st.isDirectory()) {
      notes.push(`folder "${req.name}": ${grant.path} is not a directory; not shared`);
      continue;
    }
    shares.push({ name: `f-${req.name}`, access: ACCESS_FLAG[grant.access], path: grant.path });
    folders[req.name] = `/host/f-${req.name}`;
  }
  return { shares, folders, notes };
}

/**
 * Maps a VM path under a share that is CURRENTLY granted to this run (`/host/f-<n>`, `/host/pick-N`, `/host/save-N`)
 * to the real host path (SPEC 8.2 mapPath). `shares` is the session's table name -> {access:'ro'|'rw'|'wo', path,
 * kind:'dir'|'file'}. Refuses anything else: other names, `.` / `..` / empty components, a save share's other
 * file names, and any path whose symlinks lead out of the shared folder. Returns {path, access, name}.
 */
function resolveShare(shares, vmPath) {
  if (typeof vmPath !== 'string' || vmPath.length > 4096 || vmPath.includes('\0') || vmPath.includes('\\')) throw new Error('not a valid /host path');
  const parts = vmPath.split('/');
  if (parts.length < 3 || parts[0] !== '' || parts[1] !== 'host' || !parts[2]) throw new Error(`${vmPath} is not under /host/<share>`);
  const name = parts[2];
  const rest = parts.slice(3);
  if (rest.some((c) => c === '' || c === '.' || c === '..')) throw new Error(`${vmPath} is not a plain path inside a share`);
  const sh = shares.get(name);
  if (!sh) throw new Error(`${vmPath}: "${name}" is not a folder or file granted to this app`);
  if (sh.kind === 'file') {
    // a save share is one file: /host/save-N/<its name>
    if (rest.length !== 1 || rest[0] !== path.basename(sh.path)) throw new Error(`${vmPath}: only ${'/host/' + name + '/' + path.basename(sh.path)} is granted`);
    return { path: sh.path, access: sh.access, name };
  }
  let root;
  try {
    root = fs.realpathSync(sh.path);
  } catch {
    throw new Error(`${vmPath}: the shared folder no longer exists`);
  }
  let probe = path.join(root, ...rest);
  const tail = [];
  let real;
  for (;;) {
    try {
      real = fs.realpathSync(probe);
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Error(`${vmPath}: ${e.code || e.message}`);
      let dangling = false;
      try {
        fs.lstatSync(probe);
        dangling = true;
      } catch {
        /* really absent */
      }
      if (dangling) throw new Error(`${vmPath}: refusing a dangling symlink`);
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`${vmPath}: cannot be resolved`);
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
  const resolved = tail.length ? path.join(real, ...tail) : real;
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`${vmPath}: leads outside the shared folder`);
  return { path: resolved, access: sh.access, name };
}

/** Builds the `vmapp-vm run ...` argument list (SPEC 5). */
function buildVmArgs(o) {
  const a = ['run', '--kernel', o.kernel, '--initramfs', o.initramfs, '--runtime', o.runtime, '--core', o.core, '--appdata', o.appdata];
  for (const s of o.shares || []) a.push('--share', `${s.name}:${s.access}:${s.path}`);
  a.push('--start', JSON.stringify(o.start), '--socket', o.socket);
  // network (SPEC 8.3): one rule per allowed host, `host[:port,port]`; none means no network channel at all
  for (const r of o.net || []) a.push('--net', r);
  // host services (SPEC 8.6, INV-H7): `gpu=127.0.0.1:PORT`, the endpoint of the loader's own sandboxed server. Only the GPU broker
  // below produces one; nothing from a manifest or an app reaches this list.
  for (const s of o.services || []) a.push('--service', s);
  // tests only (INV-N3): the loader never sets devNet
  if (o.devNet) {
    if (o.devNet.allowLoopback) a.push('--dev-allow-loopback');
    for (const [name, ip] of Object.entries(o.devNet.resolve || {})) a.push('--dev-resolve', `${name}=${ip}`);
  }
  // the experimental Vulkan backend (SPEC 8.7, vmapp-vm-krun): the size of the window of GPU memory, and nothing else of its own
  if (o.gpuWindowMiB) a.push('--gpu-window', String(o.gpuWindowMiB));
  if (o.memory) a.push('--memory', String(o.memory));
  if (o.cpus) a.push('--cpus', String(o.cpus));
  if (o.console) a.push('--console', o.console);
  if (o.id) a.push('--id', o.id);
  return a;
}

function startPayload(core, extraEnv) {
  // `extraEnv` is the loader's own (VMAPP_GPU_RPC, SPEC 8.6); a manifest cannot set VMAPP_* variables (manifest.js), and the
  // loader's value comes last so it wins anyway
  return {
    command: core.command,
    workdir: core.workdir,
    env: Object.entries(Object.assign({}, core.env || {}, extraEnv || {})).map(([k, v]) => `${k}=${v}`),
  };
}

function validEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > 255) return false;
  if (entry.startsWith('/') || entry.includes('\\') || entry.includes('\0')) return false;
  return entry.split('/').every((c) => c !== '' && c !== '.' && c !== '..');
}

function sanitizeName(name) {
  let n = typeof name === 'string' ? path.basename(name.replace(/\\/g, '/')) : '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n || n === '.' || n === '..') n = 'untitled';
  return n.slice(0, 200);
}

function defaultOpenExternal(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  cp.spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** Instant APFS clone where supported; a plain copy otherwise. */
function cloneFile(src, dst) {
  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    fs.copyFileSync(src, dst);
  }
}

/** An app link (SPEC 8.9) as the Inspector shows it: scheme, app and path; never the query or fragment (a sign-in code, a token). */
function linkPreview(url) {
  try {
    const u = new URL(String(url));
    return `open-url vmapp://${u.hostname}${u.pathname}${u.search || u.hash ? ' (+ parameters, not shown)' : ''}`;
  } catch {
    return 'open-url (not a link)';
  }
}

// What the Inspector shows of a bridge message. A developer reads it to watch their window talk to their core, so it keeps the
// message's shape and values; but it appears on shared screens and in recordings, so a value that looks like a secret is hidden.
// The payloads are the app's own and the platform cannot know which are secret: this hides by field name, by channel name and by
// the shape of well-known keys and tokens, a best effort (docs/SECURITY.md). It reads a bounded part of the message (a fixed
// number of values, long strings cut), so a crafted message cannot make it slow.
const SECRET_NAME = /api[-_ ]?keys?|secret|passw(?:or)?d|passphrase|tokens?|authorization|credentials?|private[-_ ]?key|bearer|cookie|session[-_ ]?id/i;
const SECRET_CHANNEL = new RegExp(`${SECRET_NAME.source}|(?:^|[^a-z])auth(?:[^a-z]|$)`, 'i');
const SECRET_SHAPE = /\b(?:sk|pk|rk|fw)[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PAYLOAD_KEYS = ['args', 'result', 'params', 'data'];

function inspectorView(v, budget, depth) {
  if (--budget.n < 0) return '…';
  if (typeof v === 'string') return (v.length > 200 ? v.slice(0, 200) : v).replace(SECRET_SHAPE, '[hidden]');
  if (v === null || typeof v !== 'object') return v;
  if (depth > 8) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => inspectorView(x, budget, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, 50)) {
    const x = v[k];
    out[k] = SECRET_NAME.test(k) && x !== null && typeof x !== 'number' && typeof x !== 'boolean' ? '[hidden]' : inspectorView(x, budget, depth + 1);
  }
  return out;
}

/** The Inspector's preview of a bridge message: the first 200 characters of its JSON, with what looks like a secret hidden.
 * `name` is the message's channel and op: on a channel whose name suggests a secret ("api-keys:set"), the whole payload is hidden. */
function bridgePreview(msg, name) {
  const m = SECRET_CHANNEL.test(name || '') ? Object.assign({}, msg, ...PAYLOAD_KEYS.filter((k) => msg[k] !== undefined).map((k) => ({ [k]: '[hidden]' }))) : msg;
  return (JSON.stringify(inspectorView(m, { n: 300 }, 0)) || '').slice(0, 200);
}

function tailOf(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

class AppSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.appId installed app id
   * @param {string} [o.home] VMAPP_HOME (default: store default)
   * @param {Store}  [o.store] use this store instead of creating one from `home`
   * @param {string|string[]} o.vmappVmPath path of vmapp-vm, or [command, ...prefixArgs] (tests use [node, fake.js])
   * @param {string} o.kernel
   * @param {string} o.initramfs
   * @param {object} [o.grants] {folders:{name:{path,access}|null}, askEveryTime, host?} (default: store.loadGrants).
   *   Host-capability grants are read live from the store unless `grants` is given (then from `grants.host`). The VM's size comes
   *   from `grants.resources` (the user's choice; hostlib/resources.js), else one vCPU and the manifest's recommended memory.
   * @param {{cpus:number, memoryMiB:number}} [o.hostLimits] what this Mac allows (tests); default: its logical cores, half its RAM
   * @param {object} o.windowManager
   * @param {object} [o.dialogs]
   * @param {object} [o.clipboard] {readText(), writeText(text)}: answers clipboard.* for an app allowed the device "clipboard"
   * @param {object} [o.capabilities] HostCapabilities (hostlib/capabilities.js): answers the `host.*` ops. Without it
   *   they are refused.
   * @param {object} [o.gpu] GpuBroker (hostlib/gpu.js): starts the sandboxed GPU server when the app asks for `gpu` and the user
   *   allowed it (SPEC 8.6). Without it an app never gets a GPU.
   * @param {object} [o.krun] the experimental Vulkan backend (SPEC 8.7): {path: vmapp-vm-krun (or [command, ...prefixArgs]),
   *   kernel: the gpu kernel flavour, enabled: boolean | () => boolean (the loader setting "Experimental GPU (Vulkan)"),
   *   gpuWindowMiB?: number}. Used for a run only when the app asks for `{cap:"gpu", api:"vulkan"}` AND the user granted it AND
   *   `enabled`; otherwise the normal backend runs the app.
   * @param {(entry:{level,source,message})=>void} [o.onLog]
   * @param {object} [o.timeouts] {ready:20000, coreReady:30000, beforeQuit:3000, stop:10000, grant:10000}
   *
   * Events: 'ready' (core ready), 'exported' ({share,files}), 'stopped' (the parsed stopped line), 'log'.
   */
  constructor(o) {
    super();
    if (!o || !o.appId) throw new Error('AppSession: appId is required');
    this.appId = o.appId;
    this.store = o.store || new Store({ home: o.home });
    this.home = this.store.home;
    this.vmappVm = o.vmappVmPath;
    this.kernel = o.kernel;
    this.initramfs = o.initramfs;
    this.grants = o.grants || null;
    this._grantsGiven = !!o.grants;
    this.devNet = o.devNet || null; // {allowLoopback, resolve:{name: ip}}: for tests and developer tools only (SPEC 8.3, INV-N3)
    this.hostLimits = o.hostLimits || null; // {cpus, memoryMiB}: what this Mac allows (tests pass a fixed one; default: the real host)
    this.vmSize = null; // {cpus, memoryMiB, recommended, custom}: the size this run's VM was started with
    this._netApplied = new Map(); // host pattern -> rule argument of the rules the running VM has
    this._netChain = Promise.resolve();
    this._netWaiter = null;
    // {host, port, username, password} of this run's window endpoint (SPEC 8.3 "The app's windows"), while the VM runs
    this.windowProxy = null;
    this._windowProxyWaiter = null;
    // port forwarding (SPEC 8.8): VM port -> this Mac's port, while forwarded
    this._forwards = new Map();
    this._portChain = Promise.resolve();
    this._portWaiter = null;
    this._portTimer = null;
    this.wm = o.windowManager;
    this.dialogs = o.dialogs || null;
    // {readText(), writeText(text)}: the Mac's clipboard (the loader passes Electron's; headless runs a FakeClipboard)
    this.clipboard = o.clipboard || null;
    this.capabilities = o.capabilities || null;
    this.krun = o.krun || null; // the experimental Vulkan backend (SPEC 8.7)
    this.backend = 'vz'; // 'vz' (vmapp-vm) or 'krun' (vmapp-vm-krun): decided in _start
    this.gpu = o.gpu || null; // the GpuBroker (SPEC 8.6)
    this._gpu = null; // {endpoint, port, pid} of this run's GPU server, while it runs and the service is not revoked
    this._gpuTimer = null;
    this._gpuOnStopped = null;
    this._shares = new Map(); // granted shares of this run: name -> {access:'ro'|'rw'|'wo', path, kind:'dir'|'file'}
    this.onLog = o.onLog || null;
    this.openExternal = o.openExternal || null;
    this.timeouts = Object.assign({ ready: 20000, coreReady: 30000, beforeQuit: 3000, stop: 10000, grant: 10000 }, o.timeouts);
    this.state = 'new'; // new -> starting -> running -> stopping -> stopped
    this.windows = new Set();
    this.bridge = null;
    this.child = null;
    this.app = null;
    this.stoppedInfo = null;
    this.instanceId = crypto.randomBytes(4).toString('hex');
    this._pick = 0;
    this._save = 0;
    this._grantChain = Promise.resolve();
    this._grantWaiter = null;
    this._stderrTail = [];
    this._stoppedLine = null;
    this._exited = false;
    this._exitedD = defer();
    this._abortD = defer();
    this._abortD.promise.catch(() => {});
    this._stopP = null;
    this._vmReadyD = defer();
    this._vmReadyD.promise.catch(() => {});
  }

  log(level, source, message) {
    const entry = { level, source, message: String(message) };
    this.emit('log', entry);
    if (this.onLog) {
      try {
        this.onLog(entry);
      } catch {
        /* ignore */
      }
    }
  }

  get manifest() {
    return this.app && this.app.manifest;
  }

  // ---------------------------------------------------------------------------------------------------- start

  async start() {
    if (this.state !== 'new') throw new Error(`session is already ${this.state}`);
    this.state = 'starting';
    try {
      await this._start();
    } catch (e) {
      await this.stop({ skipBeforeQuit: true }).catch(() => {});
      const tail = tailOf(this.consoleLog || '', 15);
      if (tail.length) e.message += `\n--- console log tail (${this.consoleLog}) ---\n${tail.join('\n')}`;
      throw e;
    }
    this.state = 'running';
    this.emit('ready');
    return this;
  }

  async _start() {
    const app = this.store.get(this.appId);
    if (!app) throw new Error(`app ${this.appId} is not installed`);
    this.app = app;
    const m = app.manifest;
    for (const [k, v] of [['vmappVmPath', this.vmappVm], ['kernel', this.kernel], ['initramfs', this.initramfs], ['windowManager', this.wm]]) {
      if (!v) throw new Error(`AppSession: ${k} is required`);
    }
    // The experimental Vulkan backend (SPEC 8.7) runs this app only when the app asks for it AND the user granted it AND the
    // loader setting is on AND it is installed; in every other case the normal backend runs it (and, if the app asked for
    // Vulkan, the log says why it has no GPU).
    const pick = gpuLib.chooseBackend({
      manifest: m,
      hostGrants: this._grantsGiven ? (this.grants && this.grants.host) || {} : this.store.loadHostGrants(m.id),
      enabled: !!this.krun && (typeof this.krun.enabled === 'function' ? this.krun.enabled() : !!this.krun.enabled),
      installed: !!this.krun && !!this.krun.path && !!this.krun.kernel && [this.krun.path, this.krun.kernel].every((p) => (Array.isArray(p) ? true : fs.existsSync(p))),
    });
    if (pick.why) this.log('warn', 'host', `the app asks for the Vulkan GPU, but it runs without one: ${pick.why}`);
    this.backend = pick.backend;
    const vmBin = this.backend === 'krun' ? this.krun.path : this.vmappVm;
    const kernelImg = this.backend === 'krun' ? this.krun.kernel : this.kernel;
    const cmd = Array.isArray(vmBin) ? vmBin[0] : vmBin;
    const prefix = Array.isArray(vmBin) ? vmBin.slice(1) : [];
    if (cmd.includes('/') && !fs.existsSync(cmd)) throw new Error(`${this.backend === 'krun' ? 'vmapp-vm-krun' : 'vmapp-vm'} not found: ${cmd}`);
    if (!fs.existsSync(kernelImg)) throw new Error(`kernel not found: ${kernelImg}`);
    if (!fs.existsSync(this.initramfs)) throw new Error(`initramfs not found: ${this.initramfs}`);
    const runtimeImg = this.store.runtimePath(m.runtime);
    if (!fs.existsSync(runtimeImg)) throw new Error(`runtime "${m.runtime}" is not installed (${runtimeImg})`);
    if (!this.grants) this.grants = this.store.loadGrants(this.appId);
    const { shares, folders, notes } = resolveFolders(m, this.grants);
    for (const n of notes) this.log('warn', 'host', n);
    const net = resolveNetwork(m, this.grants);
    for (const n of net.notes) this.log('warn', 'host', n);
    for (const r of net.rules) this._netApplied.set(r.host, r.arg);
    if ((m.permissions.network || []).length) {
      this.log('info', 'host', net.rules.length ? `network allowed: ${net.args.join(', ')}` : 'network requested but not granted: the app has no network');
    }
    // The VM's size is the USER's choice (grants.resources, SPEC 2.2/8); the manifest only recommends. Defaults: one vCPU and the
    // recommended memory; never more than this Mac's cores and half of its memory.
    const size = resolveResources(m, this.grants, this.hostLimits || hostLimits());
    for (const n of size.notes) this.log('warn', 'host', n);
    this.vmSize = { cpus: size.cpus, memoryMiB: size.memoryMiB, recommended: size.recommended, custom: size.custom };
    this.log('info', 'host', `VM size: ${describeSize(size, 'MiB')}${size.custom ? ' (your choice)' : ' (default)'}; the app recommends ${describeSize(size.recommended, 'MiB')}`);
    this.folders = folders;
    for (const s of shares) this._shares.set(s.name, { access: s.access, path: s.path, kind: 'dir' });
    this._cleanupPicks(); // leftovers of a crashed earlier run

    const appdata = this.store.dataDir(this.appId);
    fs.mkdirSync(appdata, { recursive: true });
    this.consoleLog = this.store.consoleLogPath(this.appId);
    fs.mkdirSync(path.dirname(this.consoleLog), { recursive: true });
    this.sockDir = fs.mkdtempSync('/tmp/vmapp-');
    this.socketPath = path.join(this.sockDir, 'b.sock');

    // GPU (SPEC 8.6): only if the manifest asks AND the user allowed it. The server starts first, so that it can compile its
    // shaders while the VM boots; the core is told where it is only when it is really there.
    const gpu = await this._startGpu(m);

    if (this.backend === 'krun') {
      this.log('info', 'host', 'EXPERIMENTAL: the app runs on the Vulkan GPU backend (vmapp-vm-krun): no runtime folder grants; the VMM runs in a sandbox');
      this._gpuRow('start', { backend: 'krun', api: 'vulkan' });
    }

    const args = buildVmArgs({
      kernel: kernelImg,
      initramfs: this.initramfs,
      runtime: runtimeImg,
      core: app.coreFile,
      appdata,
      shares,
      start: startPayload(m.core, gpu ? { [gpuLib.ENV_NAME]: gpuLib.GUEST_ADDR } : null),
      net: net.args,
      services: gpu ? [gpuLib.serviceArg(gpu.port)] : [],
      devNet: this.devNet,
      socket: this.socketPath,
      memory: size.memoryMiB,
      cpus: size.cpus,
      gpuWindowMiB: this.backend === 'krun' ? this.krun.gpuWindowMiB : undefined,
      console: this.consoleLog,
      id: this.instanceId,
    });
    this.vmArgs = [...prefix, ...args];
    this.log('debug', 'host', `spawn ${cmd} ${this.vmArgs.join(' ')}`);
    const child = cp.spawn(cmd, this.vmArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      this.log('error', 'host', `vmapp-vm: ${e.message}`);
      this._abortD.reject(new Error(`cannot run vmapp-vm: ${e.message}`));
      if (!child.pid) this._onChildClose(-1, null); // spawn failed: no 'close' will follow
    });
    readline.createInterface({ input: child.stdout }).on('line', (l) => this._onVmLine(l));
    readline.createInterface({ input: child.stderr }).on('line', (l) => {
      this._stderrTail.push(l);
      if (this._stderrTail.length > 20) this._stderrTail.shift();
      this.log('warn', 'vmapp-vm', l);
    });
    child.on('close', (code, signal) => this._onChildClose(code, signal));

    const ready = await this._guard(this._vmReadyD.promise, this.timeouts.ready, 'the vmapp-vm ready line');
    this.log('info', 'host', `VM ready (pid ${ready.pid})`);
    // The windows' network (SPEC 8.3 "The app's windows"): before the core starts, so before any window exists.
    if ((m.ui.features || []).includes('network')) await this._startWindowProxy();

    const bridge = new BridgeClient({ socketPath: ready.socket || this.socketPath, onRequest: (op, params) => this._request(op, params) });
    this.bridge = bridge;
    this._traceBridge(bridge);
    bridge.on('emit', (msg) => this._onCoreEmit(msg));
    bridge.on('log', (l) => this.log(l.level, 'core', l.message));
    bridge.on('close', () => this._onBridgeClose());
    await this._guard(bridge.connect(this.timeouts.ready), this.timeouts.ready + 1000, 'the bridge connection');
    bridge.init({
      app: { id: m.id, name: m.name, version: m.version },
      platform: { os: 'linux', arch: 'arm64' },
      folders,
      data: '/data',
    });
    await this._guard(bridge.waitReady(this.timeouts.coreReady), this.timeouts.coreReady + 1000, 'the core ready message');
    this.log('info', 'host', 'core ready');
  }

  /** Races `p` against the child exiting and a timeout. */
  _guard(p, ms, what) {
    let timer;
    const t = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what} (${ms} ms)`)), ms);
    });
    return Promise.race([p, this._abortD.promise, t]).finally(() => clearTimeout(timer));
  }

  _onVmLine(line) {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      this.log('debug', 'vmapp-vm', line);
      return;
    }
    // the stopped line also carries an "exported" key, so test it first
    if (obj.stopped) this._stoppedLine = obj;
    else if (obj.ready) this._vmReadyD.resolve(obj);
    else if (obj.exported) this.emit('exported', obj.exported);
    else if (obj.granted) this._grantDone('granted', obj.granted.name, null);
    else if (obj.revoked) this._grantDone('revoked', obj.revoked.name, null);
    else if (obj.net) this._onNetEvent(obj.net);
    else if (obj.service) this._onServiceEvent(obj.service);
    else if (obj['service-revoked']) this.log('debug', 'vmapp-vm', line);
    else if (obj['net-allowed']) this._netDone('net-allowed', obj['net-allowed'], null);
    else if (obj['net-revoked']) this._netDone('net-revoked', obj['net-revoked'], null);
    else if (obj['window-proxy']) this._windowProxyDone(obj['window-proxy'], null);
    else if (obj.forward) this._onForwardEvent(obj.forward);
    else if (obj['port-forwarded']) this._portDone('port-forwarded', obj['port-forwarded'], null);
    else if (obj['port-closed']) this._portDone('port-closed', obj['port-closed'], null);
    else if (obj.error) {
      this.log('error', 'vmapp-vm', `${obj.error.op || ''}: ${obj.error.message}`);
      if (obj.error.op === 'window-proxy') this._windowProxyDone(null, new Error(obj.error.message));
      if (obj.error.op === 'port-forward' || obj.error.op === 'port-close') this._portDone(null, null, new Error(obj.error.message), obj.error.op);
      if (obj.error.op === 'net-allow' || obj.error.op === 'net-revoke') this._netDone(null, null, new Error(obj.error.message));
      if (obj.error.op === 'grant' || obj.error.op === 'revoke') this._grantDone(null, null, new Error(obj.error.message));
    } else this.log('debug', 'vmapp-vm', line);
  }

  async _onChildClose(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.stoppedInfo =
      this._stoppedLine || { stopped: true, reason: signal ? 'signal' : 'process-exit', exitCode: code, exported: {}, synthetic: true };
    this.state = 'stopped';
    // SPEC 8.7: the Vulkan backend's own verdicts. `gpu-hang`: the guest stopped answering and the launcher killed the VMM
    // (watchdog); `vmm-crashed`: the VMM died by itself. Said in the app's log and the Inspector, not only in the stopped line.
    const why = this.stoppedInfo && this.stoppedInfo.reason;
    if (why === 'gpu-hang' || why === 'vmm-crashed') {
      this.log('warn', 'host', `the Vulkan GPU backend stopped this app (${why}${this.stoppedInfo.detail ? `: ${this.stoppedInfo.detail}` : ''})`);
      this._gpuRow('stop', { backend: 'krun', reason: why, error: true });
    }
    const err = new Error(
      `vmapp-vm exited (${signal || 'code ' + code})` + (this._stderrTail.length ? `: ${this._stderrTail.slice(-5).join(' | ')}` : ''),
    );
    this._abortD.reject(err);
    this._vmReadyD.reject(err);
    this.windowProxy = null; // the endpoint went with the VM
    this._windowProxyDone(null, err);
    this._forwards.clear(); // and so did every forward
    if (this._portWaiter) this._portWaiter.d.reject(err);
    this._stopHostUse('app-stopped');
    await this._stopGpu('app-stopped');
    if (this._grantWaiter) this._grantDone(null, null, err);
    if (this._netWaiter) this._netDone(null, null, err);
    if (this.bridge) this.bridge.close();
    const open = [...this.windows];
    this.windows.clear();
    for (const w of open) {
      try {
        await this.wm.close(w);
      } catch (e) {
        this.log('warn', 'host', `closing window ${w}: ${e.message}`);
      }
    }
    if (this.sockDir) fs.rmSync(this.sockDir, { recursive: true, force: true });
    this._cleanupPicks();
    this.log('info', 'host', `stopped: ${JSON.stringify(this.stoppedInfo)}`);
    this.emit('stopped', this.stoppedInfo);
    this._exitedD.resolve(this.stoppedInfo);
  }

  /**
   * Emits a 'traffic' event for every bridge message in both directions (the loader's bridge inspector):
   *   { ts, dir:'to-core'|'from-core', t, id?, win?, channel?, op?, event?, bytes, durationMs?, preview }
   * `durationMs` is set on `result` (matched to its `invoke`) and on `reply` (matched to its `request`); those
   * also carry the matched channel / op. `preview` is the first 200 characters of the message JSON with values that look like
   * secrets replaced by "[hidden]" (bridgePreview); host.* and clipboard.* payloads are not shown at all.
   */
  _traceBridge(bridge) {
    const invokes = new Map(); // invoke id -> {t0, channel}
    const requests = new Map(); // request id -> {t0, op}
    const trace = (dir, msg) => {
      if (this.listenerCount('traffic') === 0 || !msg || typeof msg !== 'object') return;
      let json;
      try {
        json = JSON.stringify(msg);
      } catch {
        return;
      }
      const now = Date.now();
      const ev = { ts: now, dir, t: msg.t };
      if (msg.id !== undefined) ev.id = msg.id;
      if (msg.win !== undefined) ev.win = msg.win;
      if (typeof msg.channel === 'string') ev.channel = msg.channel;
      if (typeof msg.op === 'string') ev.op = msg.op;
      if (msg.t === 'window' && typeof msg.event === 'string') ev.event = msg.event;
      if (msg.t === 'log' && typeof msg.level === 'string') ev.event = msg.level;
      if (dir === 'to-core' && msg.t === 'invoke') invokes.set(msg.id, { t0: now, channel: msg.channel });
      else if (dir === 'from-core' && msg.t === 'result') {
        const m = invokes.get(msg.id);
        if (m) {
          invokes.delete(msg.id);
          ev.durationMs = now - m.t0;
          ev.channel = m.channel;
        }
        if (msg.error) ev.error = true;
      } else if (dir === 'from-core' && msg.t === 'request') requests.set(msg.id, { t0: now, op: msg.op });
      else if (dir === 'to-core' && msg.t === 'reply') {
        const m = requests.get(msg.id);
        if (m) {
          requests.delete(msg.id);
          ev.durationMs = now - m.t0;
          ev.op = m.op;
        }
        if (msg.error) ev.error = true;
      }
      ev.bytes = Buffer.byteLength(json) + 1;
      // host.* payloads can carry screenshots, typed text or tool input: the Inspector gets a separate, redacted
      // {kind:'host'} event from the broker instead of a preview here
      // clipboard.* carries the clipboard's text, which may be a password: shown as its size only
      ev.preview = typeof ev.op === 'string' && (ev.op.startsWith('host.') || ev.op.startsWith('clipboard.')) ? `[${ev.op}: payload not shown]` : bridgePreview(msg, `${ev.channel || ''} ${ev.op || ''}`);
      // an app link (SPEC 8.9) can carry a sign-in code or token in its query: shown without its parameters
      if (msg.t === 'open-url') ev.preview = linkPreview(msg.url);
      this.emit('traffic', ev);
    };
    const origSend = bridge.send.bind(bridge);
    bridge.send = (obj) => {
      const ok = origSend(obj);
      if (ok) trace('to-core', obj);
      return ok;
    };
    bridge.on('message', (msg) => trace('from-core', msg));
  }

  _onBridgeClose() {
    if (this.state === 'running') {
      this.log('info', 'host', 'core disconnected; stopping');
      this.stop({ skipBeforeQuit: true }).catch(() => {});
    }
  }

  // ----------------------------------------------------------------------------------------- vmapp-vm commands

  _writeStdin(obj) {
    if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _grantDone(kind, name, err) {
    const w = this._grantWaiter;
    if (!w) return;
    if (err) return w.d.reject(err);
    if (kind === w.kind && name === w.name) w.d.resolve();
  }

  /** Sends one stdin command and waits for the matching `granted` / `revoked` line (serialised). */
  _vmCommand(op, name, access, p) {
    const run = async () => {
      const d = defer();
      const kind = op === 'grant' ? 'granted' : 'revoked';
      this._grantWaiter = { d, kind, name };
      const timer = setTimeout(() => d.reject(new Error(`vmapp-vm did not answer ${op} ${name} within ${this.timeouts.grant} ms`)), this.timeouts.grant);
      try {
        if (!this.child || this._exited) throw new Error('VM is not running');
        this._writeStdin(op === 'grant' ? { op, name, access, path: p } : { op, name });
        await d.promise;
      } finally {
        clearTimeout(timer);
        this._grantWaiter = null;
      }
    };
    const next = this._grantChain.then(run, run);
    this._grantChain = next.catch(() => {});
    return next;
  }

  /** Adds a share to the running VM. access: 'ro' | 'rw' | 'wo'. */
  grant(name, access, hostPath) {
    return this._vmCommand('grant', name, access, hostPath);
  }
  revoke(name) {
    this._shares.delete(name); // from now on a tool can no longer be pointed at it either
    return this._vmCommand('revoke', name);
  }

  // ---------------------------------------------------------------------------------------- network (SPEC 8.3)

  /**
   * One `vmapp-vm` network command (`net-allow` / `net-revoke`), serialised, answered by the matching `net-allowed` /
   * `net-revoked` line. Resolves with that line's object (`{rule}` / `{rule, closed}`).
   */
  _netCommand(op, rule, host) {
    const run = async () => {
      const d = defer();
      const kind = op === 'net-allow' ? 'net-allowed' : 'net-revoked';
      this._netWaiter = { d, kind, host };
      const timer = setTimeout(() => d.reject(new Error(`vmapp-vm did not answer ${op} ${rule} within ${this.timeouts.grant} ms`)), this.timeouts.grant);
      try {
        if (!this.child || this._exited) throw new Error('VM is not running');
        this._writeStdin({ op, rule });
        return await d.promise;
      } finally {
        clearTimeout(timer);
        this._netWaiter = null;
      }
    };
    const next = this._netChain.then(run, run);
    this._netChain = next.catch(() => {});
    return next;
  }

  _netDone(kind, info, err) {
    const w = this._netWaiter;
    if (!w) return;
    if (err) return w.d.reject(err);
    const host = String((info && info.rule) || '').split(':')[0];
    if (kind === w.kind && host === w.host) w.d.resolve(info);
  }

  /**
   * The window endpoint (SPEC 8.3 "The app's windows", DEV-APPS C3) for an app that declares the window feature "network":
   * `vmapp-vm` opens a loopback CONNECT proxy under the app's network rules, and only a client that sends this run's secret
   * may use it. The secret is made here, given on stdin and kept in memory (never in a log, a file or a command line); the
   * window manager reads `windowProxy` to point the app's partition at the endpoint and to answer its proxy authentication.
   * Without a grant the endpoint refuses everything (each refusal is a `net` row). If it cannot start, the windows have no
   * network and the app runs anyway.
   */
  async _startWindowProxy() {
    const secret = crypto.randomBytes(32).toString('hex');
    const d = defer();
    this._windowProxyWaiter = d;
    try {
      this._writeStdin({ op: 'window-proxy', secret });
      const r = await this._guard(d.promise, this.timeouts.grant, 'the window endpoint');
      const port = Number(r && r.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`vmapp-vm gave an invalid port for the window endpoint: ${JSON.stringify(r)}`);
      this.windowProxy = Object.freeze({ host: '127.0.0.1', port, username: 'vmapp', password: secret });
      this.log('info', 'host', `window network: through the app's proxy on 127.0.0.1:${port}, with the app's network permissions`);
    } catch (e) {
      if (this._exited) throw e;
      this.windowProxy = null;
      this.log('error', 'host', `the window endpoint did not start, so the app's windows have no network: ${e.message}`);
    } finally {
      this._windowProxyWaiter = null;
    }
  }

  _windowProxyDone(info, err) {
    const d = this._windowProxyWaiter;
    if (!d) return;
    if (err) d.reject(err);
    else d.resolve(info);
  }

  /**
   * Lets the RUNNING VM reach `host` (one of the manifest's entries) on `ports` (default: the requested ones). This is the
   * effect of a grant the user already made; the loader and the CLI call it (or `syncNetwork`) after saving one. Never
   * wider than the manifest asks (INV-N2). Resolves when `vmapp-vm` has applied it.
   */
  netAllow(host, ports) {
    const entry = ((this.manifest.permissions.network || []).find((e) => e.host === host));
    if (!entry) return Promise.reject(new Error(`the app does not request network access to "${host}"`));
    const want = ports === undefined ? entry.ports : ports;
    if (!(want === '*' || (Array.isArray(want) && want.length)) || !portsWithin(want, entry.ports)) {
      return Promise.reject(new Error(`ports ${JSON.stringify(want)} are not within the requested ${portsArg(entry.ports)}`));
    }
    const arg = ruleArg(host, want);
    return this._netCommand('net-allow', arg, host).then((r) => {
      this._netApplied.set(host, arg);
      return r;
    });
  }

  /** Takes `host` away from the running VM and closes its open connections at once. Resolves `{rule, closed}`. */
  netRevoke(host) {
    return this._netCommand('net-revoke', host, host).then((r) => {
      this._netApplied.delete(host);
      return r;
    });
  }

  /**
   * Makes the running VM match the app's current network grants (stored ones, or `session.grants` when the session was
   * given grants): hosts newly allowed are added, ports changed are replaced, hosts no longer allowed are revoked (their open
   * connections close). The loader calls it after the user changes a grant. Resolves `{allowed: [host], revoked: [host]}`.
   */
  async syncNetwork() {
    const grants = this._grantsGiven ? this.grants : this.store.loadGrants(this.appId);
    const want = new Map(resolveNetwork(this.manifest, grants).rules.map((r) => [r.host, r]));
    const out = { allowed: [], revoked: [] };
    for (const host of [...this._netApplied.keys()]) {
      if (!want.has(host)) {
        await this.netRevoke(host);
        out.revoked.push(host);
      }
    }
    for (const [host, r] of want) {
      if (this._netApplied.get(host) !== r.arg) {
        await this.netAllow(host, r.ports);
        out.allowed.push(host);
      }
    }
    return out;
  }

  /**
   * A `{"net":{...}}` line of vmapp-vm: one proxied connection that closed or was refused. Becomes a 'traffic' event for
   * the Inspector: {ts, dir:'from-core', t:'net', kind:'net', appId, id, host, port, allowed, bytesUp, bytesDown, durationMs,
   * reason?, bytes, preview}. Host names and byte counts only; contents never reach the host (TLS is end to end).
   */
  _onNetEvent(n) {
    if (!n || typeof n !== 'object') return;
    const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const ev = {
      ts: Date.now(),
      dir: 'from-core',
      t: 'net',
      kind: 'net',
      appId: this.appId,
      id: num(n.id),
      host: String(n.host === undefined ? '' : n.host).slice(0, 253),
      port: num(n.port),
      allowed: n.allowed === true,
      bytesUp: num(n.bytesUp),
      bytesDown: num(n.bytesDown),
      durationMs: num(n.durationMs),
    };
    if (typeof n.reason === 'string' && n.reason) ev.reason = n.reason.slice(0, 300);
    // from one of the app's windows, through the window endpoint (SPEC 8.3 "The app's windows"), not from the VM
    if (n.window === true) ev.window = true;
    ev.bytes = ev.bytesUp + ev.bytesDown;
    ev.preview = `${ev.allowed ? 'allowed' : 'DENIED'} ${ev.window ? 'window ' : ''}${ev.host}:${ev.port} up ${ev.bytesUp} down ${ev.bytesDown}${ev.reason ? ` (${ev.reason})` : ''}`;
    this.emit('traffic', ev);
  }

  /**
   * Maps a VM path (`/host/f-<n>/...`, `/host/pick-N/...`, `/host/save-N/<name>`) to the real host path, but only
   * for shares currently granted to this run. Throws for anything else. Returns {path, access:'ro'|'rw'|'wo', name}.
   * The host-capability broker uses it for tool arguments marked mapPath (SPEC 8.2).
   */
  resolveHostPath(vmPath) {
    return resolveShare(this._shares, vmPath);
  }

  // ----------------------------------------------------------------------------------------- core -> host

  _onCoreEmit(msg) {
    try {
      const r = this.wm.emit(msg.win, msg.channel, Array.isArray(msg.args) ? msg.args : []);
      if (r && typeof r.catch === 'function') r.catch((e) => this.log('warn', 'host', `emit to window ${msg.win}: ${e.message}`));
    } catch (e) {
      this.log('warn', 'host', `emit to window ${msg.win}: ${e.message}`);
    }
  }

  _requireDialogs() {
    if (!this.manifest.permissions.dialogs) throw new Error('permission denied: dialogs');
    if (!this.dialogs) throw new Error('no dialog provider available');
  }

  _requireClipboard() {
    const grants = this._grantsGiven ? this.grants : this.store.loadGrants(this.appId);
    if (!deviceAllowed(this.manifest, grants, 'clipboard')) throw new Error('permission denied: clipboard (the manifest asks for it and the user allows it)');
    if (!this.clipboard) throw new Error('no clipboard available');
  }

  _portsAllowed() {
    const grants = this._grantsGiven ? this.grants : this.store.loadGrants(this.appId);
    return deviceAllowed(this.manifest, grants, 'ports');
  }

  // ------------------------------------------------------------------------------------- port forwarding (SPEC 8.8)

  /** One `vmapp-vm` port command (`port-forward` / `port-close`), serialised, answered by the matching line. */
  _portCommand(op, port) {
    const run = async () => {
      const d = defer();
      this._portWaiter = { d, kind: op === 'port-forward' ? 'port-forwarded' : 'port-closed', op, port };
      const timer = setTimeout(() => d.reject(new Error(`vmapp-vm did not answer ${op} ${port} within ${this.timeouts.grant} ms`)), this.timeouts.grant);
      try {
        if (!this.child || this._exited) throw new Error('VM is not running');
        this._writeStdin({ op, port });
        return await d.promise;
      } finally {
        clearTimeout(timer);
        this._portWaiter = null;
      }
    };
    const next = this._portChain.then(run, run);
    this._portChain = next.catch(() => {});
    return next;
  }

  _portDone(kind, info, err, op) {
    const w = this._portWaiter;
    if (!w) return;
    if (err) {
      if (op === w.op) w.d.reject(err);
      return;
    }
    if (kind === w.kind && info && info.port === w.port) w.d.resolve(info);
  }

  /** Forwards the VM's `port` to this Mac's 127.0.0.1 (the device "ports", asked AND allowed). Resolves {port, hostPort, url}. */
  async forwardPort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port.forward: port must be an integer from 1 to 65535');
    if (!this._portsAllowed()) throw new Error('permission denied: ports (the manifest asks for it and the user allows it)');
    if (this.state === 'stopping' || this.state === 'stopped') throw new Error('permission denied: the app is stopping');
    const r = await this._portCommand('port-forward', port);
    const hostPort = Number(r.hostPort);
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error(`vmapp-vm gave an invalid port: ${JSON.stringify(r)}`);
    this._forwards.set(port, hostPort);
    // the grant can change while the app runs (the CLI): looked at once a second while a forward is open
    if (!this._portTimer) {
      this._portTimer = setInterval(() => {
        if (!this._forwards.size || this._exited) {
          clearInterval(this._portTimer);
          this._portTimer = null;
          return;
        }
        this.syncPorts().catch(() => {});
      }, 1000);
      this._portTimer.unref();
    }
    return { port, hostPort, url: `http://localhost:${hostPort}/` };
  }

  /** Stops forwarding `port` (allowed without the grant: closing never needs permission). Resolves {closed}. */
  async closePort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port.close: port must be an integer from 1 to 65535');
    if (!this._forwards.has(port)) return { closed: 0 };
    this._forwards.delete(port); // from now on openExternal no longer accepts it
    const r = await this._portCommand('port-close', port);
    return { closed: Number(r.closed) || 0 };
  }

  /** The ports forwarded now: [{port, hostPort}]. */
  listPorts() {
    return [...this._forwards].map(([port, hostPort]) => ({ port, hostPort })).sort((a, b) => a.port - b.port);
  }

  /** Is `u` (a parsed URL) http(s) on this Mac's loopback, on a port this app forwards now? */
  _isForwardedUrl(u) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
    const port = Number(u.port || (u.protocol === 'http:' ? 80 : 443));
    return [...this._forwards.values()].includes(port);
  }

  /**
   * Makes the running VM match the user's choice for the device "ports": when it is no longer allowed, every forward is closed at
   * once. The loader calls it after the user changes the app's devices. Resolves {closed: [port]}.
   */
  async syncPorts() {
    const closed = [];
    if (this._portsAllowed() || !this._forwards.size) return { closed };
    for (const port of [...this._forwards.keys()]) {
      await this.closePort(port).catch((e) => this.log('warn', 'host', `closing forwarded port ${port}: ${e.message}`));
      closed.push(port);
    }
    if (closed.length) this.log('info', 'host', `port forwarding was taken away: closed ${closed.join(', ')}`);
    return { closed };
  }

  // ------------------------------------------------------------------------------------------ app links (SPEC 8.9)

  /**
   * Delivers a link opened on the Mac to the running core: `vmapp://<this app's id>/…`, only for an app whose manifest has
   * `permissions.links`. The core gets it as Electron's `app.on('open-url', (event, url))`. Throws when it may not be delivered.
   */
  openUrl(url) {
    if (!this.manifest || !this.manifest.permissions.links) throw new Error('permission denied: links (the manifest does not ask for vmapp:// links)');
    if (this.state !== 'running' || !this.bridge) throw new Error('the app is not running');
    let u;
    try {
      if (typeof url !== 'string' || url.length > 4096) throw new Error('bad');
      u = new URL(url);
    } catch {
      throw new Error('open-url: invalid link');
    }
    if (u.protocol !== 'vmapp:' || u.hostname !== this.appId || u.username || u.password || u.port) throw new Error(`open-url: not a link for ${this.appId}`);
    this.bridge.openUrl(u.href); // its Inspector row is the bridge trace's, shown without the link's parameters (linkPreview)
    return true;
  }

  /** A `forward` line of vmapp-vm as a traffic row for the Inspector: ports and byte counts only. */
  _onForwardEvent(n) {
    if (!n || typeof n !== 'object') return;
    const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const phase = ['listen', 'conn', 'stop'].includes(n.phase) ? n.phase : 'conn';
    const ev = {
      ts: Date.now(),
      dir: 'from-core',
      t: 'port',
      kind: 'port',
      appId: this.appId,
      id: num(n.id),
      port: num(n.port),
      hostPort: num(n.hostPort),
      phase,
      bytesUp: num(n.bytesUp),
      bytesDown: num(n.bytesDown),
      durationMs: num(n.durationMs),
    };
    if (typeof n.reason === 'string' && n.reason) ev.reason = n.reason.slice(0, 300);
    ev.bytes = ev.bytesUp + ev.bytesDown;
    const what = phase === 'listen' ? 'forwarding' : phase === 'stop' ? 'stopped forwarding' : 'connection to';
    ev.preview = `${what} VM port ${ev.port} on localhost:${ev.hostPort}${phase === 'conn' ? ` up ${ev.bytesUp} down ${ev.bytesDown}` : ''}${ev.reason ? ` (${ev.reason})` : ''}`;
    if (phase === 'stop') this._forwards.delete(ev.port);
    this.emit('traffic', ev);
  }

  _ownWindow(win) {
    if (!Number.isInteger(win) || !this.windows.has(win)) throw new Error(`unknown window ${JSON.stringify(win)}`);
    return win;
  }

  _optWindow(win) {
    return Number.isInteger(win) && this.windows.has(win) ? win : undefined;
  }

  get _appInfo() {
    return { id: this.app.manifest.id, name: this.app.manifest.name };
  }

  async _request(op, params) {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    switch (op) {
      case 'window.create': {
        if (!validEntry(p.entry)) throw new Error('invalid window entry (must be a relative path inside the UI folder)');
        if (this.windows.size >= MAX_WINDOWS) throw new Error(`too many windows (limit ${MAX_WINDOWS})`);
        const num = (v, def, min, max) => {
          if (v === undefined || v === null) return def;
          if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('invalid window size');
          return Math.min(max, Math.max(min, Math.round(v)));
        };
        const create = {
          entry: p.entry,
          width: num(p.width, 800, 100, 16384),
          height: num(p.height, 600, 100, 16384),
        };
        if (p.minWidth !== undefined) create.minWidth = num(p.minWidth, undefined, 0, 16384);
        if (p.minHeight !== undefined) create.minHeight = num(p.minHeight, undefined, 0, 16384);
        if (p.title !== undefined) create.title = String(p.title).slice(0, 200);
        if (p.resizable !== undefined) create.resizable = !!p.resizable;
        // DevTools for this window (SPEC 7, INV-B1): only a boolean true from the core turns them on; anything else is off.
        if (p.devTools !== undefined) create.devTools = p.devTools === true;
        const r = await this.wm.create(create);
        const win = r && typeof r === 'object' ? (r.win !== undefined ? r.win : r.id) : r;
        if (!Number.isInteger(win)) throw new Error('window manager returned an invalid window id');
        this.windows.add(win);
        return { win };
      }
      case 'window.close':
        await this.wm.close(this._ownWindow(p.win));
        return {};
      case 'window.setTitle':
        await this.wm.setTitle(this._ownWindow(p.win), String(p.title === undefined ? '' : p.title).slice(0, 200));
        return {};
      case 'window.focus':
        await this.wm.focus(this._ownWindow(p.win));
        return {};
      // The app's menus in the Mac menu bar (SPEC 6, 7 "Menus"): data only, validated here; a click comes back to the core as the
      // window event 'menu' {id}. A window's own page may set its own menus instead (they win while that window is focused).
      case 'menu.set': {
        let v;
        try {
          v = p.template === null ? null : validateMenuTemplate(p.template);
        } catch (e) {
          if (e instanceof MenuError) throw new Error(`menu.set: ${e.message}`);
          throw e;
        }
        if (typeof this.wm.setMenu === 'function') await this.wm.setMenu(v ? v.menus : null);
        return { items: v ? v.items : 0, dropped: v ? v.dropped : [] };
      }
      case 'dialog.open':
        return this._dialogOpen(p);
      case 'dialog.save':
        return this._dialogSave(p);
      case 'dialog.message': {
        if (!this.dialogs) throw new Error('no dialog provider available');
        if (typeof p.message !== 'string') throw new Error('dialog.message: message must be a string');
        const buttons = Array.isArray(p.buttons) && p.buttons.length ? p.buttons.slice(0, 8).map(String) : ['OK'];
        const idx = await this.dialogs.message({
          win: this._optWindow(p.win),
          type: MESSAGE_TYPES.includes(p.type) ? p.type : 'info',
          message: p.message.slice(0, 2000),
          detail: typeof p.detail === 'string' ? p.detail.slice(0, 4000) : undefined,
          buttons,
          app: this._appInfo,
        });
        return { response: Number.isInteger(idx) && idx >= 0 && idx < buttons.length ? idx : 0 };
      }
      case 'shell.openExternal': {
        if (!this.manifest.permissions.external) throw new Error('permission denied: external');
        if (!this.dialogs) throw new Error('no dialog provider available');
        let u;
        try {
          if (typeof p.url !== 'string' || p.url.length > 2048) throw new Error('bad');
          u = new URL(p.url);
        } catch {
          throw new Error('shell.openExternal: invalid url');
        }
        // https:, or a link to one of this app's forwarded ports on this Mac's loopback (SPEC 8.8: a dev server's page)
        if (u.protocol !== 'https:' && !this._isForwardedUrl(u)) throw new Error('shell.openExternal: only https: URLs (and http://localhost:<a forwarded port>) are allowed');
        const ok = await this.dialogs.confirmExternal(u.href, this._appInfo);
        if (!ok) return { opened: false };
        const opener = this.openExternal || (typeof this.dialogs.openExternal === 'function' ? (x) => this.dialogs.openExternal(x) : defaultOpenExternal);
        await opener(u.href);
        return { opened: true };
      }
      case 'app.quit':
        setImmediate(() => this.stop({ skipBeforeQuit: true }).catch(() => {}));
        return {};
      // The clipboard (SPEC 6, 8.4; DEV-APPS C5): the manifest asks for the device "clipboard" AND the user allowed it, checked
      // at every call (a revoke applies at once). Plain text only, at most 1 MiB each way.
      case 'clipboard.readText': {
        this._requireClipboard();
        const text = String((await this.clipboard.readText()) || '');
        return { text: text.length > CLIPBOARD_MAX ? text.slice(0, CLIPBOARD_MAX) : text, truncated: text.length > CLIPBOARD_MAX };
      }
      case 'clipboard.writeText': {
        this._requireClipboard();
        if (typeof p.text !== 'string') throw new Error('clipboard.writeText: text must be a string');
        if (p.text.length > CLIPBOARD_MAX) throw new Error(`clipboard.writeText: text is longer than ${CLIPBOARD_MAX} characters`);
        await this.clipboard.writeText(p.text);
        return {};
      }
      // Port forwarding (SPEC 6, 8.8; DEV-APPS C4): the device "ports", asked AND allowed, checked at every forward.
      case 'port.forward':
        return this.forwardPort(p.port);
      case 'port.close':
        return this.closePort(p.port);
      case 'port.list':
        return { ports: this.listPorts() };
      // Host capabilities (SPEC 8.2): permissions.host in the manifest AND the user's grant, both checked by the broker.
      case 'host.screen.windows':
      case 'host.screen.capture':
      case 'host.input.start':
      case 'host.input.mouse':
      case 'host.input.keys':
      case 'host.input.stop':
      case 'host.tool.list':
      case 'host.tool.run':
      case 'host.mcp.list':
      case 'host.mcp.call':
        return this._host(op, p);
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  /** `host.*` ops: refused unless the manifest asks for host capabilities and the loader provides a broker. */
  _host(op, p) {
    if (!(this.manifest.permissions.host || []).length) throw new Error('permission denied: host');
    if (this.state === 'stopping' || this.state === 'stopped') throw new Error('permission denied: the app is stopping');
    if (!this.capabilities) throw new Error('permission denied: this loader does not provide host capabilities');
    return this.capabilities.requestOp(op, p, this._hostCtx());
  }

  /** What the broker knows about this app (built once per run). */
  _hostCtx() {
    if (!this._hostContext) {
      const m = this.app.manifest;
      this._hostContext = {
        key: this.instanceId,
        appId: m.id,
        appName: m.name,
        manifest: m,
        // live from disk, so a revoked or changed grant applies to the very next call
        grants: () => (this._grantsGiven ? (this.grants && this.grants.host) || {} : this.store.loadHostGrants(m.id)),
        resolvePath: (vmPath) => this.resolveHostPath(vmPath),
        traffic: (ev) => this.emit('traffic', ev),
      };
    }
    return this._hostContext;
  }

  /** Ends the app's host-capability use (input control, tools, MCP servers). Idempotent. */
  _stopHostUse(reason) {
    if (this.capabilities && this._hostContext) {
      try {
        this.capabilities.stopApp(this._hostContext.key, reason);
      } catch (e) {
        this.log('warn', 'host', `stopping host capabilities: ${e.message}`);
      }
    }
  }

  // ----------------------------------------------------------------------------------------- GPU (SPEC 8.6, INV-H7)

  /** A loader-made Inspector row about the GPU server itself: {kind:'gpu', phase:'server', op:'start'|'stop', ...}. */
  _gpuRow(op, extra = {}) {
    const ev = Object.assign({ ts: Date.now(), dir: 'host', t: 'gpu', kind: 'gpu', appId: this.appId, phase: 'server', op, allowed: true, bytes: 0 }, extra);
    ev.preview = `GPU server ${op}${ev.reason ? ` (${ev.reason})` : ''}${ev.message ? `: ${ev.message}` : ''}${ev.port ? ` on 127.0.0.1:${ev.port}` : ''}`.slice(0, 200);
    this.emit('traffic', ev);
  }

  /**
   * Starts this run's GPU server when the manifest asks for `gpu` AND the user allowed it ("Allow while the app runs"). Returns
   * the server ({endpoint, port, pid}) or null: an app that was not allowed, or whose server could not start, simply has no GPU
   * (no environment variable, no service, connections to 127.0.0.1:50052 refused), and the log and the Inspector say why.
   */
  async _startGpu(m) {
    if (!gpuLib.gpuRequest(m)) return null;
    if (gpuLib.gpuApi(m)) return null; // the experimental Vulkan GPU (SPEC 8.7) is the VM backend's business, not the RPC server's
    const host = this._grantsGiven ? (this.grants && this.grants.host) || {} : this.store.loadHostGrants(m.id);
    if (!gpuLib.gpuAllowed(m, host)) {
      this.log('info', 'host', 'GPU requested but not allowed: the app runs without a GPU');
      return null;
    }
    if (!this.gpu) {
      this.log('warn', 'host', 'GPU allowed, but this loader has no GPU server: the app runs without a GPU');
      return null;
    }
    let srv;
    try {
      srv = await this.gpu.start(this.instanceId, { appId: m.id, appName: m.name });
    } catch (e) {
      this.log('warn', 'host', `GPU allowed, but its server could not start (${e.message}): the app runs without a GPU`);
      this._gpuRow('start', { error: true, message: e.message.slice(0, 200) });
      return null;
    }
    this._gpu = srv;
    this._gpuRevokeSent = false;
    this._gpuOnStopped = (info) => {
      if (info && info.key === this.instanceId) this._onGpuStopped(info);
    };
    this.gpu.on('stopped', this._gpuOnStopped);
    this._gpuTimer = setInterval(() => this._checkGpuGrant(), gpuLib.WATCH_MS);
    if (this._gpuTimer.unref) this._gpuTimer.unref();
    this.log('info', 'host', `GPU allowed: sandboxed server on 127.0.0.1:${srv.port} (pid ${srv.pid}); the core finds it at ${gpuLib.GUEST_ADDR} ($${gpuLib.ENV_NAME})`);
    this._gpuRow('start', { port: srv.port, pid: srv.pid });
    return srv;
  }

  /** The server ended (revoked, panic, crash, the app stopping): the service goes with it, so open tunnels close at once. */
  _onGpuStopped(info) {
    const ours = this._gpu;
    this._gpu = null;
    if (this._gpuTimer) clearInterval(this._gpuTimer);
    this._gpuTimer = null;
    if (this._gpuOnStopped && this.gpu) this.gpu.off('stopped', this._gpuOnStopped);
    this._gpuOnStopped = null;
    this._revokeGpuService();
    if (ours) {
      this.log(info.reason === 'crashed' ? 'warn' : 'info', 'host', `GPU server stopped (${info.reason}${info.reason === 'crashed' ? `: ${info.signal || 'code ' + info.code}` : ''})`);
      this._gpuRow('stop', { reason: info.reason, port: ours.port });
    }
  }

  /** Tells vmapp-vm to take the service away (open tunnels close, the guest port closes). Once per run. */
  _revokeGpuService() {
    if (this._gpuRevokeSent) return;
    this._gpuRevokeSent = true;
    if (this.child && !this._exited) this._writeStdin({ op: 'service-revoke', name: gpuLib.SERVICE });
  }

  /** The user took the GPU away (the sheet, the CLI) while the app runs: look at the grant of the running app. */
  _checkGpuGrant() {
    if (!this._gpu || !this.app) return;
    let host = {};
    try {
      host = this._grantsGiven ? (this.grants && this.grants.host) || {} : this.store.loadHostGrants(this.appId);
    } catch (e) {
      this.log('warn', 'host', `cannot read the grants (${e.message}); the GPU is switched off to be safe`);
    }
    if (!gpuLib.gpuAllowed(this.manifest, host)) {
      this.log('info', 'host', 'the GPU grant was taken away: stopping the GPU server');
      this.revokeGpu('revoked').catch(() => {});
    }
  }

  /**
   * Switches the GPU off for this run: the service is revoked (open tunnels close at once, new ones are refused, the guest port
   * closes) and the server is stopped. The app keeps running. Resolves true if there was a GPU. `reason` is 'revoked' (the
   * user), 'panic' (the shortcut) ...
   */
  async revokeGpu(reason = 'revoked') {
    if (!this._gpu || !this.gpu) return false;
    this._revokeGpuService();
    await this.gpu.stop(this.instanceId, reason);
    return true;
  }

  /** Ends this run's GPU server and the grant watch. Never throws. */
  async _stopGpu(reason) {
    if (this._gpuTimer) clearInterval(this._gpuTimer);
    this._gpuTimer = null;
    const had = !!this._gpu;
    try {
      if (had && this.gpu) await this.gpu.stop(this.instanceId, reason);
    } catch (e) {
      this.log('warn', 'host', `stopping the GPU server: ${e.message}`);
    }
    if (this._gpuOnStopped && this.gpu) this.gpu.off('stopped', this._gpuOnStopped);
    this._gpuOnStopped = null;
    this._gpu = null;
  }

  /**
   * A `{"service":{...}}` line of vmapp-vm: one step of a tunnel to the GPU server. Becomes a 'traffic' event for the Inspector:
   * {ts, dir:'from-core', t:'gpu', kind:'gpu', appId, id, phase:'connect'|'traffic'|'disconnect', allowed, bytesUp, bytesDown,
   * durationMs, reason?, bytes, preview}. Byte counts only: what the app sends the GPU is never read here.
   */
  _onServiceEvent(n) {
    if (!n || typeof n !== 'object' || n.name !== gpuLib.SERVICE) return;
    const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const phase = n.phase === 'open' ? 'connect' : n.phase === 'close' ? 'disconnect' : 'traffic';
    const ev = {
      ts: Date.now(),
      dir: 'from-core',
      t: 'gpu',
      kind: 'gpu',
      appId: this.appId,
      id: num(n.id),
      phase,
      allowed: n.allowed === true,
      bytesUp: num(n.bytesUp),
      bytesDown: num(n.bytesDown),
      durationMs: num(n.durationMs),
    };
    if (typeof n.reason === 'string' && n.reason) ev.reason = n.reason.slice(0, 300);
    ev.bytes = ev.bytesUp + ev.bytesDown;
    ev.preview = `${phase} gpu #${ev.id}${ev.allowed ? '' : ' DENIED'} up ${ev.bytesUp} down ${ev.bytesDown}${ev.reason ? ` (${ev.reason})` : ''}`;
    this.emit('traffic', ev);
  }

  /** $VMAPP_HOME/picks/<app id>: the cloned files of this run's file picks; removed when the session stops. */
  get picksDir() {
    return this.store.picksDir(this.appId);
  }

  _cleanupPicks() {
    try {
      fs.rmSync(this.picksDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Runtime grants (dialog picks and saves) need the slot devices of the normal backend; the experimental GPU backend has none (SPEC 8.7). */
  _requireRuntimeGrants() {
    if (this.backend === 'krun') throw new Error('not supported on the gpu backend');
  }

  async _dialogOpen(p) {
    this._requireDialogs();
    this._requireRuntimeGrants();
    const directory = !!p.directory;
    const multiple = !!p.multiple;
    if (p.access !== undefined && p.access !== 'read' && p.access !== 'readwrite') {
      throw new Error('dialog.open: access must be "read" or "readwrite"');
    }
    const access = p.access === 'readwrite' ? 'readwrite' : 'read';
    const picked = await this.dialogs.open({
      win: this._optWindow(p.win),
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : undefined,
      directory,
      multiple,
      // only directory picks can be writable; file picks are always read-only clones
      access: directory ? access : 'read',
      app: this._appInfo,
    });
    const list = picked === null || picked === undefined ? [] : Array.isArray(picked) ? picked : [picked];
    if (list.length === 0) return { canceled: true };
    const chosen = multiple ? list : list.slice(0, 1);
    const sharedDirs = new Map(); // real directory -> pick name (directory picks only)
    const created = []; // clone folders made by this call, removed again on failure
    const paths = [];
    try {
      for (const hp of chosen) {
        if (typeof hp !== 'string' || !path.isAbsolute(hp)) throw new Error('dialog returned an invalid path');
        let real;
        let st;
        try {
          real = fs.realpathSync(hp);
          st = fs.statSync(real);
        } catch {
          throw new Error(`selected path does not exist: ${hp}`);
        }
        if (directory) {
          if (!st.isDirectory()) throw new Error(`selected path is not a folder: ${hp}`);
          let name = sharedDirs.get(real);
          if (!name) {
            name = `pick-${this._pick++}`;
            await this.grant(name, ACCESS_FLAG[access], real);
            this._shares.set(name, { access: ACCESS_FLAG[access], path: real, kind: 'dir' });
            this.emit('grant', { name, access: ACCESS_FLAG[access], path: real });
            sharedDirs.set(real, name);
          }
          paths.push(`/host/${name}`);
        } else {
          if (!st.isFile()) throw new Error(`selected path is not a file: ${hp}`);
          // Never share the parent folder: an instant APFS clone (or a copy) of the file goes into a fresh folder.
          const name = `pick-${this._pick++}`;
          const folder = path.join(this.picksDir, name);
          const fileName = sanitizeName(path.basename(hp));
          fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
          created.push(folder);
          cloneFile(real, path.join(folder, fileName));
          await this.grant(name, 'ro', folder);
          this._shares.set(name, { access: 'ro', path: folder, kind: 'dir' });
          this.emit('grant', { name, access: 'ro', path: folder });
          paths.push(`/host/${name}/${fileName}`);
        }
      }
    } catch (e) {
      for (const f of created) fs.rmSync(f, { recursive: true, force: true });
      throw e;
    }
    return { canceled: false, paths };
  }

  async _dialogSave(p) {
    this._requireDialogs();
    this._requireRuntimeGrants();
    const chosen = await this.dialogs.save({
      win: this._optWindow(p.win),
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : undefined,
      defaultName: sanitizeName(p.defaultName),
      app: this._appInfo,
    });
    if (!chosen) return { canceled: true };
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) throw new Error('dialog returned an invalid path');
    let ok = false;
    try {
      ok = fs.statSync(path.dirname(chosen)).isDirectory();
    } catch {
      /* handled below */
    }
    if (!ok) throw new Error(`the folder for ${chosen} does not exist`);
    const name = `save-${this._save++}`;
    await this.grant(name, 'wo', chosen);
    this._shares.set(name, { access: 'wo', path: chosen, kind: 'file' });
    this.emit('grant', { name, access: 'wo', path: chosen });
    return { canceled: false, path: `/host/${name}/${path.basename(chosen)}` };
  }

  // ----------------------------------------------------------------------------------------- host -> core

  _needBridge() {
    if (!this.bridge || !this.bridge.connected) throw new Error('app is not running');
    return this.bridge;
  }

  /** The renderer called vmapp.invoke(channel, ...args): resolves with the core handler's result. */
  invoke(win, channel, args) {
    try {
      return this._needBridge().invoke(win, channel, args);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  /** The renderer called vmapp.send(channel, ...args). */
  send(win, channel, args) {
    return this._needBridge().sendToCore(win, channel, args);
  }
  /** Window events from the window manager: 'closed' | 'focus' | 'blur' | 'resize'. */
  windowEvent(win, event, data) {
    if (event === 'closed') this.windows.delete(win);
    if (this.bridge && this.bridge.connected) this.bridge.windowEvent(win, event, data);
  }

  // ----------------------------------------------------------------------------------------- stop

  /**
   * Graceful stop: before-quit (core gets up to 3 s), then {"op":"shutdown"} on stdin, wait up to 10 s for the
   * stopped line / process exit, else SIGKILL. Resolves with the stopped line. Idempotent.
   */
  stop(opts = {}) {
    if (!this._stopP) this._stopP = this._doStop(opts);
    return this._stopP;
  }

  async _doStop(opts) {
    if (!this.child) {
      this.state = 'stopped';
      await this._stopGpu('app-stopped'); // the VM never started (or failed to), the GPU server may have
      return null;
    }
    this._stopHostUse('app-stopping'); // input control and tools end as soon as the stop begins, not when the VM is gone
    if (!this._exited) {
      if (this.state !== 'stopped') this.state = 'stopping';
      if (!opts.skipBeforeQuit && this.bridge && this.bridge.connected) {
        this.bridge.beforeQuit();
        await settledWithin(this._exitedD.promise, this.timeouts.beforeQuit);
      }
      if (!this._exited) {
        this._writeStdin({ op: 'shutdown' });
        if (!(await settledWithin(this._exitedD.promise, this.timeouts.stop))) {
          this.log('warn', 'host', 'vmapp-vm did not stop in time; sending SIGKILL');
          this.child.kill('SIGKILL');
          await settledWithin(this._exitedD.promise, 3000);
        }
      }
    }
    await this._exitedD.promise.catch(() => {});
    return this.stoppedInfo;
  }

  whenStopped() {
    return this._exitedD.promise;
  }
}

module.exports = { AppSession, BridgeClient, resolveFolders, resolveShare, buildVmArgs, startPayload, sanitizeName, sleep, bridgePreview };
