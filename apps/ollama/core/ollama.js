'use strict';
/**
 * Ollama's server for the Ollama core: `ollama serve` on the VM's loopback (127.0.0.1:11434), and a small HTTP client for its API.
 *
 * The server is the unmodified release binary (build.sh). It is bound to the VM's loopback and nothing else reaches it: the window
 * talks only to the core, and the core sends fixed, validated requests (never an arbitrary path or body).
 *
 * Environment handed to `ollama serve` (everything else of the core's environment stays behind):
 *   HOME=/data                        the app's private storage (Ollama keeps its key pair in $HOME/.ollama)
 *   OLLAMA_HOST=127.0.0.1:11434       loopback only
 *   OLLAMA_MODELS=/data/ollama/models the model store (blobs and manifests), persistent across runs
 *   OLLAMA_NOHISTORY=1                no prompt history file
 *   OLLAMA_NO_CLOUD=1                 no ollama.com cloud features (the manifest allows only the model registry)
 *   OLLAMA_VULKAN=1|0                 1 only when the user switched the GPU on AND a Vulkan device and backend exist (see gpuSupport())
 *   OLLAMA_IGPU_ENABLE=1              only with OLLAMA_VULKAN=1: the paravirtual GPU is an integrated one, which Ollama drops otherwise
 *   GGML_VK_DISABLE_ASYNC=1           only with OLLAMA_VULKAN=1: the async path of ggml-vulkan computes wrong results on the Venus device
 *   GGML_VK_*, OLLAMA_FLASH_ATTENTION, OLLAMA_KV_CACHE_TYPE, OLLAMA_DEBUG   passed through from the core's own environment (manifest core.env)
 *   HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY (and lower case)   inherited: Go's net/http honours them; the proxy is the only way out
 *   SSL_CERT_FILE                     a CA bundle written from Node's root store (the node22 runtime has no /etc/ssl/certs, and Go needs one)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');

const APP = __dirname;
const EXE = path.join(APP, 'bin', 'ollama');
const LIB_DIR = path.join(APP, 'lib', 'ollama');
const HOST = '127.0.0.1';
const PORT = 11434;
const DATA = process.env.VMAPP_DATA || '/data';
const MODELS_DIR = path.join(DATA, 'ollama', 'models');
const CA_FILE = '/tmp/vmapp-ca-bundle.pem';
const RENDER_NODE = '/dev/dri/renderD128'; // the Vulkan (Venus) GPU's render node, present only in a VM that has the experimental GPU backend
const LOG_LINES = 1500;
const READY_TIMEOUT_MS = 90 * 1000;
const MiB = 1024 * 1024;

const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];

function totalMemMiB() {
  return Math.round(os.totalmem() / MiB);
}

function availMemMiB() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {
    /* fall through */
  }
  return Math.round(os.freemem() / MiB);
}

/** What the build contains (BUILD-INFO.txt, written by build.sh) and the CPU feature flags the guest kernel reports. */
function binaryInfo() {
  let version = '';
  let backends = '';
  try {
    const info = fs.readFileSync(path.join(APP, 'bin', 'BUILD-INFO.txt'), 'utf8');
    const m = /^ollama (\S+)/m.exec(info);
    if (m) version = m[1];
    const b = /^backends in the release asset: (.*)$/m.exec(info);
    if (b) backends = b[1];
  } catch {
    /* the file is informational */
  }
  let cpuVariants = [];
  try {
    cpuVariants = fs
      .readdirSync(LIB_DIR)
      .map((f) => /^libggml-cpu-(.*)\.so$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch {
    /* not built */
  }
  return { present: fs.existsSync(EXE), version, backends, cpuVariants };
}

/**
 * Can this VM run Ollama on a GPU? Two things must exist: a Vulkan device (the render node of the experimental GPU backend) and
 * Ollama's Vulkan backend library (lib/ollama/vulkan/libggml-vulkan.so, which the linux-arm64 release of 0.35.0 does not ship).
 * `rpcGranted` is the platform's llama.cpp RPC GPU capability: Ollama has no RPC backend, so it cannot use it.
 */
function gpuSupport() {
  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const device = exists(RENDER_NODE);
  const backend = exists(path.join(LIB_DIR, 'vulkan', 'libggml-vulkan.so')) || exists(path.join(LIB_DIR, 'libggml-vulkan.so'));
  return { device, backend, eligible: device && backend, rpcGranted: /^127\.0\.0\.1:\d{1,5}$/.test(process.env.VMAPP_GPU_RPC || '') };
}

/** Writes the CA bundle Go will read (SSL_CERT_FILE) from the root certificates built into Node. Returns how many it holds. */
function writeCaBundle() {
  const roots = tls.rootCertificates;
  if (!Array.isArray(roots) || roots.length < 20) throw new Error('Node has no root certificates to give Ollama');
  const tmp = `${CA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${roots.join('\n')}\n`, { mode: 0o644 });
  fs.renameSync(tmp, CA_FILE);
  return roots.length;
}

/** key=value pairs of a Go slog text line: id=cpu library=cpu total="31.3 GiB". */
function parseKv(line) {
  const out = {};
  for (const m of line.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g)) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

class OllamaServer extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.logs = []; // the last LOG_LINES lines of the server's output (it includes llama-server's, which can show prompt text: kept in memory only)
    this.generation = 0; // bumped on every start/stop, so a late event from an old process is ignored
    this.devices = []; // the "inference compute" lines: [{id, library, name, description, total, available}]
    this.threads = null; // n_threads that llama-server printed when it loaded a model
    this.info = { state: 'stopped' };
  }

  status() {
    return { ...this.info, devices: this.devices.slice(), threads: this.threads };
  }

  setInfo(patch) {
    this.info = { ...this.info, ...patch };
    this.emit('status', this.status());
  }

  pushLog(line) {
    if (!line) return;
    this.logs.push(line);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    // The console log gets Ollama's own lines (time=… level=…, [GIN] …) but not the llama-server lines, which can contain prompt text.
    if (/^(time=|\[GIN\])/.test(line)) console.log(`[ollama] ${line.slice(0, 400)}`);
    if (line.includes('msg="inference compute"')) {
      const kv = parseKv(line);
      this.devices.push({ id: kv.id, library: kv.library, name: kv.name, description: kv.description, total: kv.total, available: kv.available });
      this.emit('status', this.status());
    }
    const t = /system_info: n_threads = (\d+)/.exec(line);
    if (t) {
      this.threads = Number(t[1]);
      this.emit('status', this.status());
    }
  }

  recentLog(n = 300) {
    return this.logs.slice(-n);
  }

  /**
   * Starts `ollama serve` and resolves when it answers /api/version. `opts.gpu`: the user wants the GPU (honoured only when gpuSupport()
   * says there is one). Rejects, and leaves the state 'error', when the server exits first or does not answer in time.
   */
  async start(opts = {}) {
    // the state says "starting" at once, also while an earlier server is still being stopped (a restart)
    this.info = { state: 'starting', message: this.child ? 'Restarting Ollama…' : 'Starting Ollama…', startedAt: Date.now(), readyMs: null, version: '', gpuRequested: !!opts.gpu, vulkan: false };
    this.emit('status', this.status());
    await this.kill();
    const gen = ++this.generation;
    if (!fs.existsSync(EXE)) throw new Error('Ollama is not bundled in this build of the app (run apps/ollama/build.sh and pack again)');
    const support = gpuSupport();
    const useVulkan = !!opts.gpu && support.eligible;
    const caCerts = writeCaBundle();
    fs.mkdirSync(MODELS_DIR, { recursive: true, mode: 0o755 });

    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: DATA,
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      OLLAMA_HOST: `${HOST}:${PORT}`,
      OLLAMA_MODELS: MODELS_DIR,
      OLLAMA_NOHISTORY: '1',
      OLLAMA_NO_CLOUD: '1',
      OLLAMA_NUM_PARALLEL: '1', // one conversation at a time: the VM's memory is for the model and its context
      OLLAMA_MAX_LOADED_MODELS: '1',
      OLLAMA_KEEP_ALIVE: '30m', // the model stays loaded between questions; the window has an Unload button
      OLLAMA_CONTEXT_LENGTH: '4096', // the default; the window sends num_ctx with every request
      OLLAMA_VULKAN: useVulkan ? '1' : '0', // this release turns Vulkan on by default when its library exists: say it explicitly
      SSL_CERT_FILE: CA_FILE,
    };
    // The Venus device is an integrated (UMA) GPU, like the Mac's own (ggml-vulkan prints "uma: 1"), and Ollama 0.35's device discovery
    // drops integrated GPUs on Linux unless OLLAMA_IGPU_ENABLE is set (discover/runner.go, filterIntegratedGPUs): without this the
    // Vulkan backend loads and its only device is thrown away, silently leaving the model on the CPU.
    if (useVulkan) env.OLLAMA_IGPU_ENABLE = '1';
    // ggml-vulkan's asynchronous path (a transfer queue and graph-optimised submissions overlapping compute) gives WRONG RESULTS on the
    // Venus device: measured with Ollama 0.35.0 (llama.cpp b11081) on the experimental backend, llama3.2:1b (Q8_0) and qwen2.5:7b
    // (Q4_K_M) answered with garbage ("?Tags?", "BusinessException0.1...") while qwen2.5:0.5b was right; with GGML_VK_DISABLE_ASYNC=1 all of
    // them answer correctly at full speed (llama3.2:1b 230 tokens/s), with only GGML_VK_SERIALIZE_SUBMISSIONS=1 on top they are
    // also right but slower. The manifest's core.env can still override this (the pass-through below).
    if (useVulkan) env.GGML_VK_DISABLE_ASYNC = '1';
    for (const k of PROXY_VARS) if (process.env[k]) env[k] = process.env[k];
    // Backend tuning knobs, passed through from the core's own environment (the manifest's core.env, i.e. the app author's choice, never
    // the window's): ggml's Vulkan switches (GGML_VK_*), Ollama's flash attention and KV cache type, and debug logging.
    for (const k of Object.keys(process.env)) if (/^(GGML_VK_[A-Z0-9_]+|OLLAMA_FLASH_ATTENTION|OLLAMA_KV_CACHE_TYPE|OLLAMA_DEBUG)$/.test(k)) env[k] = process.env[k];

    this.logs = [];
    this.devices = [];
    this.threads = null;
    this.pushLog(`start: ${EXE} serve (OLLAMA_VULKAN=${env.OLLAMA_VULKAN}, ${caCerts} CA certificates in ${CA_FILE})`);
    this.info = { state: 'starting', message: 'Starting Ollama…', startedAt: Date.now(), readyMs: null, version: '', gpuRequested: !!opts.gpu, vulkan: useVulkan };
    this.emit('status', this.status());

    const child = spawn(EXE, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
    this.child = child;
    let exited = null;
    const lineReader = (stream) => {
      let carry = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        carry += d;
        let i;
        while ((i = carry.indexOf('\n')) >= 0) {
          this.pushLog(carry.slice(0, i).replace(/\r$/, ''));
          carry = carry.slice(i + 1);
        }
        if (carry.length > 8192) {
          this.pushLog(carry);
          carry = '';
        }
      });
    };
    lineReader(child.stdout);
    lineReader(child.stderr);
    child.on('error', (e) => {
      exited = { error: e.message };
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (this.child === child) this.child = null;
      if (gen !== this.generation) return;
      this.setInfo({
        state: 'error',
        message: this.info.state === 'starting' ? this.failureMessage(code, signal) : `Ollama stopped (${signal || `exit code ${code}`}). Restart it.`,
      });
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let version = '';
    for (;;) {
      if (gen !== this.generation) throw new Error('Stopped');
      if (exited) {
        const msg = this.failureMessage(exited.code, exited.signal || exited.error);
        if (this.info.state === 'starting') this.setInfo({ state: 'error', message: msg });
        throw new Error(msg);
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('Ollama did not answer within 90 seconds');
      }
      try {
        const r = await this.request('GET', '/api/version', null, { timeoutMs: 2000 });
        if (r.status === 200 && r.json && r.json.version) {
          version = String(r.json.version);
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // device discovery runs right after the server starts listening; give it a moment (Vulkan initialisation can take longer)
    const discoveryUntil = Date.now() + (useVulkan ? 15000 : 2500);
    while (!this.devices.length && Date.now() < discoveryUntil && gen === this.generation && !exited) await new Promise((r) => setTimeout(r, 100));
    if (gen !== this.generation) throw new Error('Stopped');
    const readyMs = Date.now() - this.info.startedAt;
    this.pushLog(`ready after ${readyMs} ms (version ${version})`);
    this.setInfo({ state: 'ready', message: '', readyMs, version });
    return this.status();
  }

  failureMessage(code, signal) {
    const tail = this.recentLog(40).filter((l) => /^time=/.test(l) || /error|failed|cannot|panic/i.test(l));
    const reason = [...tail].reverse().find((l) => /level=(ERROR|WARN)|error|failed|panic/i.test(l)) || tail[tail.length - 1] || '';
    const what = signal ? `signal ${signal}` : `exit code ${code}`;
    return `Ollama stopped while starting (${what})${reason ? `: ${reason.replace(/^time=\S+ level=\S+ source=\S+ /, '')}` : ''}`.slice(0, 400);
  }

  /** Stops the server (SIGTERM, then SIGKILL after `graceMs`) and waits until it is gone. */
  async stop(graceMs = 4000) {
    await this.kill(graceMs);
    if (this.info.state !== 'stopped') this.setInfo({ state: 'stopped', message: '', readyMs: null });
  }

  /** Ends the running process (if any) without touching the reported state. */
  async kill(graceMs = 4000) {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
  }

  /** One JSON request. Resolves {status, json, text} for any HTTP status (the caller decides); rejects when it cannot connect. */
  request(method, p, body, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === null || body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (data !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const r = http.request({ host: HOST, port: PORT, path: p, method, agent: false, headers, timeout: timeoutMs }, (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
        res.on('error', reject);
      });
      r.on('timeout', () => r.destroy(new Error(`Ollama did not answer ${method} ${p} in ${Math.round(timeoutMs / 1000)} s`)));
      r.on('error', reject);
      r.end(data);
    });
  }

  /** A JSON request that must succeed: returns the parsed body, or throws with Ollama's own error message. */
  async call(method, p, body, opts) {
    const r = await this.request(method, p, body, opts);
    if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.error) || `Ollama answered HTTP ${r.status}`);
    return r.json;
  }

  /**
   * POST that answers with newline-delimited JSON (/api/pull, /api/chat). `onObj` gets each parsed object; it may throw to end the
   * stream with that error. Resolves when the stream ends or `signal` aborts (the connection is closed, which stops the work in Ollama),
   * rejects on a connection error or an HTTP error status.
   */
  stream(p, body, onObj, signal) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      let done = false;
      const end = (err) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve();
      };
      const r = http.request(
        { host: HOST, port: PORT, path: p, method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          res.setEncoding('utf8');
          if (res.statusCode !== 200) {
            let text = '';
            res.on('data', (d) => (text += d));
            res.on('end', () => {
              let msg = `Ollama answered HTTP ${res.statusCode}`;
              try {
                const j = JSON.parse(text);
                if (j && j.error) msg = j.error;
              } catch {
                /* keep the generic message */
              }
              end(new Error(msg));
            });
            return;
          }
          let buf = '';
          const handle = (line) => {
            let o;
            try {
              o = JSON.parse(line);
            } catch {
              return;
            }
            try {
              onObj(o);
            } catch (e) {
              r.destroy();
              end(e);
            }
          };
          res.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (line && !done) handle(line);
            }
          });
          res.on('end', () => {
            if (buf.trim() && !done) handle(buf.trim());
            end();
          });
          res.on('error', (e) => end(signal && signal.aborted ? null : e));
        },
      );
      r.on('error', (e) => end(signal && signal.aborted ? null : e));
      if (signal) {
        const onAbort = () => {
          r.destroy();
          end();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      r.end(data);
    });
  }
}

module.exports = { OllamaServer, binaryInfo, gpuSupport, totalMemMiB, availMemMiB, HOST, PORT, MODELS_DIR, DATA };
