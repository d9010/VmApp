'use strict';
// Host processes for the host-capability broker (SPEC 8.2, GOVERNANCE INV-H4): the only place besides session.js that
// uses child_process. Four kinds of process, all started WITHOUT a shell, with a clean environment:
//   HostCtl      the native helper `vmapp-hostctl` (screen and input), one per loader, JSON lines on stdin/stdout
//   startProcess a user-registered tool (tools.json): arguments are passed as an argv array, output is size-limited,
//                the whole process group is killed on timeout / stop / panic
//   McpServer    a user-registered MCP server (mcp.json): stdio, newline-delimited JSON-RPC 2.0
//   GpuServer    the loader's own bundled llama.cpp RPC server (SPEC 8.6, INV-H7), always inside `sandbox-exec` with the
//                bundled profile, one per app run, on a loopback port the loader picked
// Nothing here knows about apps or grants; capabilities.js and gpu.js decide who may use what.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

const MAX_LINE = 16 * 1024 * 1024;
const CLEAN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The environment tools and MCP servers get: nothing of the loader's own, only PATH and HOME (+ what the user set). */
function cleanEnv(extra) {
  return Object.assign({ PATH: CLEAN_PATH, HOME: os.homedir() }, extra || {});
}

/** True in a packaged loader. Development switches (VMAPP_HOSTCTL, VMAPP_HOSTCTL_DRYRUN) are ignored then. */
function isPackaged() {
  return !!process.versions.electron && !process.defaultApp;
}

/** Command (array) that starts vmapp-hostctl. `bundled` is the loader's own copy; VMAPP_HOSTCTL only when not packaged. */
function resolveHostCtlCommand({ packaged = isPackaged(), bundled, env = process.env } = {}) {
  let cmd = null;
  if (!packaged && env.VMAPP_HOSTCTL) {
    const v = String(env.VMAPP_HOSTCTL);
    if (v.trim().startsWith('[')) {
      try {
        cmd = JSON.parse(v);
      } catch {
        throw new Error('VMAPP_HOSTCTL is not valid JSON');
      }
      if (!Array.isArray(cmd) || !cmd.length || cmd.some((x) => typeof x !== 'string')) throw new Error('VMAPP_HOSTCTL must be a path or a JSON array of strings');
    } else cmd = [v];
  } else if (bundled) cmd = [bundled];
  else if (!packaged) cmd = [path.resolve(__dirname, '..', 'out', 'vmapp-hostctl')];
  if (!cmd) throw new Error('vmapp-hostctl is not available');
  if (!path.isAbsolute(cmd[0])) throw new Error(`vmapp-hostctl command must be an absolute path (got ${cmd[0]})`);
  return cmd;
}

/** Tests may ask hostctl for dry-run input (events are built, never posted). Never honoured in a packaged loader. */
function hostDryRun({ packaged = isPackaged(), env = process.env } = {}) {
  return !packaged && env.VMAPP_HOSTCTL_DRYRUN === '1';
}

/** Kills a detached child and everything in its process group. */
function killTree(child, signal = 'SIGKILL') {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------------------------------------ HostCtl

class HostCtlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostCtlError';
    this.code = code;
  }
}

/**
 * Client of vmapp-hostctl (host/hostctl/README.md). Starts the helper lazily on the first request, matches replies to
 * requests by id, restarts it on the next request after it exits.
 *
 * request(op, args, {timeoutMs}) -> Promise<result>; rejects with HostCtlError {code, message} for the helper's
 * error codes (permission, not-found, unavailable, ...) and 'timeout' / 'exited' / 'spawn' for transport problems.
 * Events: 'panic' (the helper reported the panic hotkey), 'exit' ({code, signal}), 'warning' (message).
 */
class HostCtl extends EventEmitter {
  /**
   * @param {object} o
   * @param {string|string[]} o.command executable (absolute) or [executable, ...args]
   * @param {boolean} [o.panicHotkey=false] register the panic hotkey right after each start
   * @param {number} [o.requestTimeoutMs=30000]
   */
  constructor(o) {
    super();
    const cmd = Array.isArray(o.command) ? o.command : [o.command];
    if (!cmd.length || typeof cmd[0] !== 'string' || !path.isAbsolute(cmd[0])) throw new Error('HostCtl: command must be an absolute path');
    this.command = cmd;
    this.panicHotkey = !!o.panicHotkey;
    this.requestTimeoutMs = o.requestTimeoutMs || 30000;
    this.child = null;
    this._nextId = 1;
    this._pending = new Map();
    this._buf = [];
    this._bufBytes = 0;
    this._closed = false;
  }

  get running() {
    return !!this.child;
  }

  _start() {
    if (this._closed) throw new HostCtlError('exited', 'vmapp-hostctl client is closed');
    const child = cp.spawn(this.command[0], this.command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (c) => this._onData(child, c));
    child.on('error', (e) => {
      if (this.child === child) this.child = null;
      this._failAll(new HostCtlError('spawn', `cannot start vmapp-hostctl: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this._failAll(new HostCtlError('exited', `vmapp-hostctl exited (${signal || 'code ' + code})`));
      this.emit('exit', { code, signal });
    });
    if (this.panicHotkey) {
      this._send(child, 'panic-hotkey', { enable: true }, 10000).catch((e) => this.emit('warning', `panic hotkey not registered: ${e.message}`));
    }
    return child;
  }

  _onData(child, chunk) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      this._buf.push(chunk.subarray(start, nl));
      const line = this._buf.length === 1 ? this._buf[0] : Buffer.concat(this._buf);
      this._buf = [];
      this._bufBytes = 0;
      start = nl + 1;
      if (line.length) this._onLine(line.toString('utf8'));
    }
    if (start < chunk.length) {
      this._buf.push(chunk.subarray(start));
      this._bufBytes += chunk.length - start;
      if (this._bufBytes > 4 * MAX_LINE) {
        this.emit('warning', 'vmapp-hostctl sent an oversized line; stopping it');
        killTree(child);
      }
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === 'panic') {
      this.emit('panic');
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result === undefined ? {} : msg.result);
    else p.reject(new HostCtlError((msg.error && msg.error.code) || 'failed', (msg.error && msg.error.message) || 'vmapp-hostctl request failed'));
  }

  _failAll(err) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this._pending.delete(id);
    }
  }

  _send(child, op, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new HostCtlError('timeout', `vmapp-hostctl did not answer "${op}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify(Object.assign({}, args, { id, op })) + '\n';
      child.stdin.write(line, (e) => {
        if (e && this._pending.has(id)) {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(new HostCtlError('exited', `vmapp-hostctl is not accepting requests: ${e.message}`));
        }
      });
    });
  }

  request(op, args, { timeoutMs } = {}) {
    try {
      const child = this.child || this._start();
      return this._send(child, op, args || {}, timeoutMs || this.requestTimeoutMs);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Stops the helper (it exits on stdin EOF); resolves when it is gone. */
  close() {
    this._closed = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => killTree(child), 1500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        killTree(child);
      }
    });
  }
}

// ------------------------------------------------------------------------------------------------ tools

/**
 * Starts a program with an argv array and no shell. Returns { pid, kill(reason), done }.
 * `done` resolves (never rejects, except for a spawn failure) with
 *   { exitCode, signal, stdout, stderr, truncated, timedOut, killedBy }
 * stdout + stderr share one byte budget `maxOutputBytes`; once it is used up the rest is dropped (truncated:true).
 * The process runs in its own process group, so timeouts, stop and panic kill its children as well.
 */
function startProcess(file, args, { cwd, env, stdin, timeoutMs = 30000, maxOutputBytes = 1048576 } = {}) {
  const child = cp.spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true, windowsHide: true });
  const out = [];
  const err = [];
  let total = 0;
  let truncated = false;
  let timedOut = false;
  let killedBy = null;
  let settled = false;
  let exitTimer = null;
  const take = (chunks) => (d) => {
    const room = maxOutputBytes - total;
    if (room <= 0) {
      truncated = true;
      return;
    }
    if (d.length > room) {
      chunks.push(d.subarray(0, room));
      total = maxOutputBytes;
      truncated = true;
    } else {
      chunks.push(d);
      total += d.length;
    }
  };
  child.stdout.on('data', take(out));
  child.stderr.on('data', take(err));
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const done = new Promise((resolve, reject) => {
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        signal: signal || null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        killedBy,
      });
    };
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', finish);
    // a grandchild that left the process group can keep the pipes open: do not wait for it
    child.on('exit', (code, signal) => {
      exitTimer = setTimeout(() => finish(code, signal), 250);
    });
  });
  if (stdin !== undefined && stdin !== null) child.stdin.end(Buffer.from(String(stdin), 'utf8'));
  else child.stdin.end();
  return {
    pid: child.pid,
    kill(reason) {
      if (!killedBy) killedBy = reason || 'killed';
      killTree(child);
    },
    done,
  };
}

// ------------------------------------------------------------------------------------------------ MCP

const MCP_PROTOCOL_VERSION = '2025-06-18';

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/**
 * One MCP server process (stdio transport: one JSON-RPC 2.0 message per line, SPEC of MCP "stdio"). Started on the
 * first request, initialised automatically (initialize + notifications/initialized), restarted on the next request if
 * it died. request(method, params) resolves with the JSON-RPC `result`, rejects with McpError (code of a JSON-RPC
 * error, or undefined for transport problems).
 */
class McpServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string[]} o.command [absolute executable, ...args]
   * @param {object} [o.env] user-defined variables (on top of the clean environment)
   * @param {number} [o.requestTimeoutMs=60000]
   */
  constructor(o) {
    super();
    if (!Array.isArray(o.command) || !o.command.length || !path.isAbsolute(o.command[0])) throw new Error('McpServer: command[0] must be an absolute path');
    this.command = o.command;
    this.env = o.env || {};
    this.requestTimeoutMs = o.requestTimeoutMs || 60000;
    this.child = null;
    this.info = null; // the server's initialize result
    this.stderrTail = '';
    this._nextId = 1;
    this._pending = new Map();
    this._ready = null;
    this._buf = [];
    this._bufBytes = 0;
    this._stopping = false;
  }

  get alive() {
    return !!this.child;
  }
  get pid() {
    return this.child ? this.child.pid : null;
  }

  _spawn() {
    const child = cp.spawn(this.command[0], this.command.slice(1), {
      cwd: os.homedir(),
      env: cleanEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
      windowsHide: true,
    });
    this.child = child;
    this._stopping = false;
    this._buf = [];
    this._bufBytes = 0;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (c) => this._onData(child, c));
    child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-4096);
    });
    child.on('error', (e) => {
      if (this.child === child) this.child = null;
      this._ready = null;
      this._failAll(new McpError(`cannot start MCP server: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this._ready = null;
      this._failAll(new McpError(`MCP server exited (${signal || 'code ' + code})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ''}`));
      this.emit('exit', { code, signal });
    });
    return child;
  }

  _failAll(err) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this._pending.delete(id);
    }
  }

  _onData(child, chunk) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      this._buf.push(chunk.subarray(start, nl));
      const line = this._buf.length === 1 ? this._buf[0] : Buffer.concat(this._buf);
      this._buf = [];
      this._bufBytes = 0;
      start = nl + 1;
      if (line.length) this._onLine(child, line.toString('utf8'));
    }
    if (start < chunk.length) {
      this._buf.push(chunk.subarray(start));
      this._bufBytes += chunk.length - start;
      if (this._bufBytes > MAX_LINE) {
        this.emit('warning', 'MCP server sent a line over 16 MiB; stopping it');
        killTree(child);
      }
    }
  }

  _onLine(child, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a server must not log to stdout; anything that is not JSON is ignored
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.method !== undefined) {
      // a request or notification from the server: this client offers nothing (no roots, no sampling)
      if (msg.id !== undefined && msg.id !== null) {
        const reply = msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
        this._write(child, reply);
      }
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new McpError(`MCP error ${msg.error.code}: ${msg.error.message}`, msg.error.code));
    else p.resolve(msg.result === undefined ? null : msg.result);
  }

  _write(child, obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _rpc(child, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new McpError(`MCP server did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._write(child, params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new McpError(`cannot write to the MCP server: ${e.message}`));
      }
    });
  }

  /** Starts and initialises the server if needed. */
  ensure() {
    if (this._ready) return this._ready;
    const child = this._spawn();
    this._ready = (async () => {
      try {
        this.info = await this._rpc(child, 'initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'vmapp', version: '1' },
        }, this.requestTimeoutMs);
        this._write(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
      } catch (e) {
        killTree(child);
        if (this.child === child) this.child = null;
        this._ready = null;
        throw e;
      }
      return child;
    })();
    this._ready.catch(() => {});
    return this._ready;
  }

  async request(method, params, { timeoutMs } = {}) {
    const child = await this.ensure();
    return this._rpc(child, method, params, timeoutMs || this.requestTimeoutMs);
  }

  /** Stops the server: closes its stdin (the stdio shutdown), then SIGTERM, then SIGKILL. `force` kills at once. */
  kill({ force = false } = {}) {
    const child = this.child;
    this._stopping = true;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      let t1;
      let t2;
      const finish = () => {
        clearTimeout(t1);
        clearTimeout(t2);
        resolve();
      };
      child.once('exit', finish);
      if (force) return killTree(child, 'SIGKILL');
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      t1 = setTimeout(() => killTree(child, 'SIGTERM'), 300);
      t2 = setTimeout(() => killTree(child, 'SIGKILL'), 1500);
    });
  }
}

// ------------------------------------------------------------------------------------------------ GPU server

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const GPU_TAIL_BYTES = 4096;

/**
 * The real path of the folder the user's Metal programs cache compiled shaders in (`confstr(_CS_DARWIN_USER_CACHE_DIR)`,
 * the `C` folder next to the temporary folder `T`), or null when it is not there. Only returned when its `com.apple.metal`
 * folder exists: the sandbox profile (gpu/rpc-server.sb, METAL_CACHE) lets the GPU server write only inside that folder.
 */
function metalCacheRoot() {
  try {
    const root = path.join(path.dirname(fs.realpathSync(os.tmpdir())), 'C');
    return fs.statSync(path.join(root, 'com.apple.metal')).isDirectory() ? fs.realpathSync(root) : null;
  } catch {
    return null;
  }
}

/**
 * The GPU server (SPEC 8.6, GOVERNANCE INV-H7): llama.cpp's RPC server with the Metal backend, run inside macOS's sandbox:
 *
 *   /usr/bin/sandbox-exec -f <profile> -D BIN=<binary> -D BINDIR=<its folder> -D PORT=<port> [-D METAL_CACHE=<folder>]
 *       <binary> --host 127.0.0.1 --port <port> --device MTL0
 *
 * Both paths are the loader's own bundled files (the loader's config resolves them; nothing from an app or a manifest is
 * ever a path or an argument here). The server listens on 127.0.0.1 only, on the port the loader picked, and the profile
 * lets it bind that one port and nothing else. One server per app run; `vmapp-vm` is the only party that connects to it.
 *
 * Events: 'exit' ({code, signal, requested, reason}) when the process ends, whoever ended it.
 */
class GpuServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.binary absolute path of the bundled rpc-server
   * @param {string} o.profile absolute path of the bundled sandbox profile
   * @param {number} o.port TCP port on 127.0.0.1, 1024 to 65535
   * @param {string} [o.device='MTL0'] the ggml device to serve (the Metal GPU)
   * @param {string|null} [o.metalCache] real path of the user's cache folder (see metalCacheRoot), or none
   * @param {number} [o.graceMs=600] how long start() watches for an immediate failure (a broken profile, a missing file)
   */
  constructor(o) {
    super();
    for (const k of ['binary', 'profile']) {
      if (typeof o[k] !== 'string' || !path.isAbsolute(o[k]) || o[k].includes('\0')) throw new Error(`GpuServer: ${k} must be an absolute path`);
    }
    if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw new Error('GpuServer: port must be 1024 to 65535');
    const device = o.device === undefined ? 'MTL0' : o.device;
    if (typeof device !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(device)) throw new Error('GpuServer: invalid device name');
    if (o.metalCache && (typeof o.metalCache !== 'string' || !path.isAbsolute(o.metalCache) || o.metalCache.includes('\0'))) throw new Error('GpuServer: metalCache must be an absolute path');
    this.binary = o.binary;
    this.profile = o.profile;
    this.port = o.port;
    this.device = device;
    this.metalCache = o.metalCache || null;
    this.graceMs = o.graceMs === undefined ? 600 : o.graceMs;
    this.child = null;
    this.tail = '';
    this.exitInfo = null;
    this._stopReason = null;
  }

  get pid() {
    return this.child ? this.child.pid : null;
  }
  get running() {
    return !!this.child;
  }

  /** The sandbox-exec argument vector (exposed for tests and the Inspector's detail). */
  argv() {
    const a = ['-f', this.profile, '-D', `BIN=${this.binary}`, '-D', `BINDIR=${path.dirname(this.binary)}`, '-D', `PORT=${this.port}`];
    if (this.metalCache) a.push('-D', `METAL_CACHE=${this.metalCache}`);
    a.push(this.binary, '--host', '127.0.0.1', '--port', String(this.port), '--device', this.device);
    return a;
  }

  /**
   * Starts the server. Resolves `{pid}` when it has been running for `graceMs` (it then needs a moment more to compile its
   * shaders; `vmapp-vm` waits for it), rejects if it ends sooner or cannot be started.
   */
  start() {
    if (this.child || this.exitInfo) return Promise.reject(new Error('GpuServer: already started'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      const child = cp.spawn('/usr/bin/sandbox-exec', this.argv(), {
        cwd: path.dirname(this.binary),
        env: cleanEnv({ GGML_RPC_NO_RDMA: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
        windowsHide: true,
      });
      this.child = child;
      const take = (d) => {
        this.tail = (this.tail + d.toString('utf8')).slice(-GPU_TAIL_BYTES); // drained, so the server never blocks on a full pipe
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (e) => {
        if (this.child === child) this.child = null;
        settle(reject, new Error(`cannot start the GPU server: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        this.exitInfo = { code, signal };
        const last = this.tail.trim().split('\n').slice(-3).join(' | ').slice(-300);
        settle(reject, new Error(`the GPU server exited at once (${signal || 'code ' + code})${last ? `: ${last}` : ''}`));
        this.emit('exit', { code, signal, requested: this._stopReason !== null, reason: this._stopReason || 'exited' });
      });
      const timer = setTimeout(() => settle(resolve, { pid: child.pid }), this.graceMs);
    });
  }

  /** Stops the server (SIGTERM, then SIGKILL after 1.5 s) and its process group. Resolves when it is gone. Idempotent. */
  stop(reason) {
    const child = this.child;
    if (!child) return Promise.resolve(this.exitInfo);
    if (this._stopReason === null) this._stopReason = reason || 'stopped';
    return new Promise((resolve) => {
      const t = setTimeout(() => killTree(child, 'SIGKILL'), 1500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve(this.exitInfo);
      });
      killTree(child, 'SIGTERM');
    });
  }
}

/** The command line of a process, or null if it does not exist (used to be sure a stale pid is still our server). */
function processCommand(pid) {
  return new Promise((resolve) => {
    cp.execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

module.exports = {
  HostCtl,
  HostCtlError,
  McpServer,
  McpError,
  GpuServer,
  metalCacheRoot,
  processCommand,
  SANDBOX_EXEC,
  startProcess,
  killTree,
  cleanEnv,
  isPackaged,
  resolveHostCtlCommand,
  hostDryRun,
  MAX_LINE,
  CLEAN_PATH,
};
