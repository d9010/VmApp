'use strict';
// The GPU capability (SPEC 8.6, GOVERNANCE INV-H7): an app in the VM runs llama.cpp (or Ollama) and its heavy maths run on the
// Mac's GPU. How: llama.cpp's own RPC backend. The loader starts one sandboxed `rpc-server` (Metal) per app run, on a loopback
// port it picks, and hands that endpoint to `vmapp-vm` as `--service gpu=127.0.0.1:PORT`. Inside the VM, 127.0.0.1:50052 is
// tunnelled to it by name (host/src/net.rs, guest/src/netproxy.rs) and the core finds it in $VMAPP_GPU_RPC.
//
// This file holds the decisions and the bookkeeping; the process itself is started by hostproc.js (the only place besides
// session.js that spawns), and nothing here is reachable by an app:
//   - the capability is `gpu` in the manifest's permissions.host AND the user's grant (mode `session`, "Allow while the app runs");
//   - the binary and the sandbox profile are the loader's own bundled files (loader/src/config.js), never a manifest field;
//   - one server per app run, stopped when the app stops, when the grant is taken away, on panic and when the loader quits.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');
const hostproc = require('./hostproc');

/** The name of the host service (vmapp-vm --service NAME=...; the guest's fixed port for it is 50052). */
const SERVICE = 'gpu';
/** Where the core finds the GPU: this address inside its VM. SPEC 8.6: part of the contract, never changes. */
const GUEST_ADDR = '127.0.0.1:50052';
/** The environment variable that tells the core. Set only while the GPU is granted and its server is running. */
const ENV_NAME = 'VMAPP_GPU_RPC';
/** How long the grant of a running app is looked at (a revoke from the CLI reaches the running app this way). */
const WATCH_MS = 1000;

/** The manifest's `{cap:'gpu', purpose}` or `{cap:'gpu', api:'vulkan', purpose}` entry, or null. */
function gpuRequest(manifest) {
  const list = (manifest && manifest.permissions && manifest.permissions.host) || [];
  return list.find((h) => h && h.cap === 'gpu') || null;
}

/** The API the `gpu` entry asks for: 'vulkan' (SPEC 8.7, experimental), or null for the llama.cpp RPC service (SPEC 8.6). */
function gpuApi(manifest) {
  const r = gpuRequest(manifest);
  return (r && r.api) || null;
}

/**
 * The decision for the llama.cpp RPC service (SPEC 8.6; INV-D3, INV-H2): the manifest asks for the plain `gpu` AND the user's
 * saved grant says "Allow while the app runs". An entry with an `api` is another capability (see vulkanAllowed) and never
 * starts the RPC server.
 */
function gpuAllowed(manifest, hostGrants) {
  const g = hostGrants && hostGrants.gpu;
  const r = gpuRequest(manifest);
  return !!r && !r.api && !!g && g.mode === 'session' && !g.api;
}

/**
 * The decision for the experimental Vulkan GPU (SPEC 8.7): the manifest asks for `{cap:'gpu', api:'vulkan'}` AND the user's
 * saved grant is "Allow while the app runs" for exactly that API (the grant records which API the user agreed to, so a
 * version that changes the API starts on "Don't allow").
 */
function vulkanAllowed(manifest, hostGrants) {
  const g = hostGrants && hostGrants.gpu;
  const r = gpuRequest(manifest);
  return !!r && r.api === 'vulkan' && !!g && g.mode === 'session' && g.api === 'vulkan';
}

/**
 * Which launcher runs an app (SPEC 8.7): 'krun' (vmapp-vm-krun, the experimental Vulkan backend) only when the app asks for
 * the Vulkan GPU AND the user granted it AND the loader setting "Experimental GPU (Vulkan)" is on AND the backend is installed;
 * otherwise 'vz' (vmapp-vm, the normal backend). `why` says what was missing, for the app's log.
 * @param {object} o {manifest, hostGrants, enabled: boolean, installed: boolean}
 * @returns {{backend: 'krun'|'vz', why: string|null}}
 */
function chooseBackend(o) {
  const r = gpuRequest(o.manifest);
  if (!r || r.api !== 'vulkan') return { backend: 'vz', why: null };
  if (!vulkanAllowed(o.manifest, o.hostGrants)) return { backend: 'vz', why: 'the Vulkan GPU is not allowed for this app' };
  if (!o.enabled) return { backend: 'vz', why: 'the loader setting "Experimental GPU (Vulkan)" is off' };
  if (!o.installed) return { backend: 'vz', why: 'the experimental GPU backend is not installed (build it with gpu/krun/build.sh)' };
  return { backend: 'krun', why: null };
}

/** `vmapp-vm --service` argument for a server on this port. */
function serviceArg(port) {
  return `${SERVICE}=127.0.0.1:${port}`;
}

/** A free TCP port on 127.0.0.1 (the OS picks it; it is released again before the server binds it). */
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class GpuError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GpuError';
  }
}

/**
 * Starts and stops the sandboxed GPU servers of the apps that are running (one per run, keyed by the session's instance id).
 *
 * Events:
 *   'started' ({key, appId, appName, port, pid})
 *   'stopped' ({key, appId, appName, reason, code, signal}) reason: what stop() was given ('app-stopped', 'revoked', 'panic',
 *             'loader-quit', ...) or 'crashed' when the server ended by itself
 *   'active-changed'
 */
class GpuBroker extends EventEmitter {
  /**
   * @param {object} [o]
   * @param {string} [o.binary] absolute path of the bundled rpc-server
   * @param {string} [o.profile] absolute path of the bundled sandbox profile (gpu/rpc-server.sb)
   * @param {string} [o.home] the loader's data folder: pid files of running servers go to <home>/gpu/servers, so a server
   *   that outlived a crashed loader is stopped at the next start (reapStale)
   * @param {string} [o.device='MTL0']
   * @param {string|false|null} [o.metalCache] the user's cache folder for the profile's METAL_CACHE (default: found by
   *   hostproc.metalCacheRoot); false: none, every start compiles the shaders again
   * @param {Function} [o.serverFactory] (opts) => a GpuServer-like object (tests)
   * @param {Function} [o.pickPort] () => Promise<number> (tests)
   * @param {boolean} [o.skipPlatformCheck] tests
   */
  constructor(o = {}) {
    super();
    this.binary = o.binary || null;
    this.profile = o.profile || null;
    this.home = o.home || null;
    this.device = o.device || 'MTL0';
    this.metalCache = o.metalCache === undefined ? null : o.metalCache;
    this._factory = o.serverFactory || ((opts) => new hostproc.GpuServer(opts));
    this._pickPort = o.pickPort || pickPort;
    this._skipPlatform = !!o.skipPlatformCheck;
    this._servers = new Map(); // key -> { key, appId, appName, server, port, pid, since, started, stopped }
  }

  /** `{ok:true}` or `{ok:false, reason}`: can this loader start a GPU server at all? */
  availability() {
    if (!this._skipPlatform && (process.platform !== 'darwin' || process.arch !== 'arm64')) return { ok: false, reason: 'the GPU is available on Apple-silicon Macs only' };
    if (!this.binary || !this.profile) return { ok: false, reason: 'this loader has no GPU server' };
    for (const f of [this.binary, this.profile]) {
      try {
        fs.accessSync(f, f === this.binary ? fs.constants.X_OK : fs.constants.R_OK);
      } catch {
        return { ok: false, reason: `the GPU server is not installed (${path.basename(f)} is missing; build it with gpu/build.sh)` };
      }
    }
    return { ok: true };
  }

  _cache() {
    if (this.metalCache === false) return null;
    return typeof this.metalCache === 'string' ? this.metalCache : hostproc.metalCacheRoot();
  }

  /**
   * Starts the server of one app run. Resolves `{key, endpoint:'127.0.0.1:PORT', port, pid}` when it is running; it still needs
   * a few seconds to compile its shaders on a cold start, which `vmapp-vm` waits for when the app connects. Rejects (GpuError)
   * when it cannot be started. Calling it again for the same key returns the running server.
   */
  async start(key, info = {}) {
    const have = this._servers.get(key);
    if (have && have.started && !have.stopped) return this._handle(have);
    const a = this.availability();
    if (!a.ok) throw new GpuError(a.reason);
    // The server binds its port only after it has compiled its shaders (seconds on a cold start), so the port is "free" for a
    // while: never hand the same one to two runs that start together.
    let port = await this._pickPort();
    for (let i = 0; i < 8 && [...this._servers.values()].some((r) => r.port === port); i++) port = await this._pickPort();
    if ([...this._servers.values()].some((r) => r.port === port)) throw new GpuError('no free port for the GPU server');
    let server;
    try {
      server = this._factory({ binary: this.binary, profile: this.profile, port, device: this.device, metalCache: this._cache() });
    } catch (e) {
      throw new GpuError(e.message);
    }
    const rec = { key, appId: info.appId || '', appName: info.appName || '', server, port, pid: null, since: Date.now(), started: false, stopped: false, reason: null };
    this._servers.set(key, rec);
    server.on('exit', (e) => this._onExit(rec, e));
    try {
      const r = await server.start();
      rec.pid = r && r.pid ? r.pid : null;
    } catch (e) {
      this._servers.delete(key);
      throw new GpuError(e.message);
    }
    rec.started = true;
    if (rec.stopped) throw new GpuError('the GPU server stopped while it was starting');
    this._writePid(rec);
    this.emit('started', { key, appId: rec.appId, appName: rec.appName, port, pid: rec.pid });
    this.emit('active-changed');
    return this._handle(rec);
  }

  _handle(rec) {
    return { key: rec.key, endpoint: `127.0.0.1:${rec.port}`, port: rec.port, pid: rec.pid };
  }

  _onExit(rec, e) {
    rec.stopped = true;
    rec.reason = e && e.requested ? e.reason : 'crashed';
    if (this._servers.get(rec.key) === rec) this._servers.delete(rec.key);
    this._removePid(rec);
    if (!rec.started) return; // it never counted as started: start() reports the failure
    this.emit('stopped', { key: rec.key, appId: rec.appId, appName: rec.appName, reason: rec.reason, code: e ? e.code : null, signal: e ? e.signal : null });
    this.emit('active-changed');
  }

  /** Stops the server of one run. Resolves when it is gone. Nothing happens for an unknown key. */
  async stop(key, reason = 'stopped') {
    const rec = this._servers.get(key);
    if (!rec) return;
    await rec.server.stop(reason);
  }

  /** Stops every server (panic, the loader quitting). */
  async stopAll(reason = 'stopped') {
    await Promise.all([...this._servers.keys()].map((k) => this.stop(k, reason)));
  }

  /** The servers running now: [{key, appId, appName, port, pid, since}]. */
  active() {
    return [...this._servers.values()].filter((r) => r.started && !r.stopped).map((r) => ({ key: r.key, appId: r.appId, appName: r.appName, port: r.port, pid: r.pid, since: r.since }));
  }

  isRunning(key) {
    const r = this._servers.get(key);
    return !!r && r.started && !r.stopped;
  }

  // ---------------------------------------------------------------------------------------------- stale servers

  get _pidDir() {
    return this.home ? path.join(this.home, 'gpu', 'servers') : null;
  }

  _writePid(rec) {
    const dir = this._pidDir;
    if (!dir || !rec.pid) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify({ pid: rec.pid, port: rec.port, binary: this.binary, loader: process.pid, since: rec.since }) + '\n', { mode: 0o600 });
    } catch {
      /* best effort: without the file a crashed loader's server is not found at the next start */
    }
  }

  _removePid(rec) {
    const dir = this._pidDir;
    if (!dir || !rec.pid) return;
    try {
      fs.rmSync(path.join(dir, `${rec.pid}.json`), { force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * A loader that crashed or was killed cannot stop its servers. At the next start the loader looks at the pid files of its data
   * folder and stops every server that is still there: only if its process is alive, its command line still names this
   * server's binary and port, and the loader that started it is gone. Returns the pids it stopped.
   */
  async reapStale() {
    const dir = this._pidDir;
    if (!dir) return [];
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      return [];
    }
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    };
    const stopped = [];
    for (const n of names) {
      const file = path.join(dir, n);
      let rec = null;
      try {
        rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: treated as stale below */
      }
      const drop = () => fs.rmSync(file, { force: true });
      if (!rec || !Number.isInteger(rec.pid) || rec.pid < 2 || !Number.isInteger(rec.port)) {
        drop();
        continue;
      }
      if (rec.loader !== process.pid && Number.isInteger(rec.loader) && alive(rec.loader)) continue; // another loader owns it
      if (rec.loader === process.pid) continue; // one of ours
      const cmd = alive(rec.pid) ? await hostproc.processCommand(rec.pid) : null;
      if (cmd && cmd.includes(String(rec.binary || this.binary)) && cmd.includes(`--port ${rec.port}`)) {
        hostproc.killTree({ pid: rec.pid, exitCode: null, signalCode: null, kill() {} }, 'SIGKILL');
        stopped.push(rec.pid);
      }
      drop();
    }
    return stopped;
  }
}

module.exports = {
  SERVICE,
  GUEST_ADDR,
  ENV_NAME,
  WATCH_MS,
  gpuRequest,
  gpuApi,
  gpuAllowed,
  vulkanAllowed,
  chooseBackend,
  serviceArg,
  pickPort,
  GpuBroker,
  GpuError,
};
