'use strict';
/**
 * llama-server for the Local LLM core: picks the right binary for this CPU, starts it on 127.0.0.1:8080 inside the VM with the
 * model the user chose (and, with the user's consent, the Mac's GPU through ggml RPC), waits until it is ready, and streams chat
 * completions from its OpenAI-compatible API.
 *
 * llama-server is bound to the VM's loopback and nothing else reaches it: the window talks only to the core, and the core
 * forwards a fixed, validated chat request (never an arbitrary path or body).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const BIN_DIR = path.join(__dirname, 'bin');
const HOST = '127.0.0.1';
const PORT = 8080;
const LOG_LINES = 600;
const LOAD_LINES = 2000;
const READY_TIMEOUT_MS = 15 * 60 * 1000;
const MiB = 1024 * 1024;

// One build: -march=armv8.2-a+fp16+dotprod (apps/local-llm/build.sh). The guest kernel must report those instructions.
const EXE = path.join(BIN_DIR, 'llama-server');
const REQUIRED_FEATURES = [['asimddp'], ['asimdhp', 'fphp']]; // dot product; half-precision vector arithmetic (either flag)
const BUILD_LABEL = 'NEON, dot product, fp16';

/** The CPU feature flags the guest kernel reports (arm64: the `Features` line of /proc/cpuinfo). */
function cpuFeatures() {
  try {
    const text = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m = /^Features\s*:\s*(.*)$/m.exec(text);
    return new Set(m ? m[1].trim().split(/\s+/) : []);
  } catch {
    return new Set();
  }
}

/** Is llama-server bundled, and does this CPU have the instructions it was built for? */
function binaries() {
  const feat = cpuFeatures();
  const present = fs.existsSync(EXE);
  const missing = REQUIRED_FEATURES.filter((any) => !any.some((f) => feat.has(f))).map((any) => any[0]);
  return { present, supported: missing.length === 0, missing, label: BUILD_LABEL, features: [...feat] };
}

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

class LlamaServer extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.logs = []; // the last LOG_LINES lines of llama-server's output
    this.loadLines = []; // everything it printed while loading (what parseGpu reads)
    this.generation = 0; // bumped on every start/stop, so a late event from an old process is ignored
    this.info = { state: 'stopped' };
  }

  status() {
    return { ...this.info };
  }

  setInfo(patch) {
    this.info = { ...this.info, ...patch };
    this.emit('status', this.status());
  }

  pushLog(line) {
    if (!line) return;
    this.logs.push(line);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    if (this.info.state === 'starting' && this.loadLines.length < LOAD_LINES) this.loadLines.push(line);
    console.log(`[llama] ${line}`);
  }

  recentLog(n = 200) {
    return this.logs.slice(-n);
  }

  /**
   * Starts llama-server with `opts` = {modelPath, modelName, threads, ctx, rpc?} and resolves when it answers /health.
   * Rejects (and leaves the state 'error') when it exits first or does not become ready.
   */
  async start(opts) {
    await this.stop();
    const gen = ++this.generation;
    const b = binaries();
    if (!b.present) throw new Error('llama-server is not bundled in this build of the app (run apps/local-llm/build.sh and pack again)');
    if (!b.supported) throw new Error(`This CPU lacks instructions that llama-server needs (${b.missing.join(', ')}).`);
    const exe = EXE;

    const args = [
      '-m', opts.modelPath,
      '--host', HOST,
      '--port', String(PORT),
      '--threads', String(opts.threads),
      '-c', String(opts.ctx),
      '-np', '1', // one conversation: the whole context window is for it
      '--cache-ram', '256', // keep the prompt cache small: the VM's memory is mostly the model's
      '--no-webui', // the app has its own UI
      '--no-slots',
      '-lv', '4', // this llama.cpp prints the devices and buffers (the proof of where the model runs) only at verbosity 4
    ];
    const gpuRequested = !!opts.rpc;
    if (gpuRequested) args.push('--rpc', opts.rpc, '-ngl', '99');

    this.logs = [];
    this.loadLines = [];
    this.info = { ...this.info, state: 'starting' }; // so that the first lines count as loading lines
    this.pushLog(`start: ${path.basename(exe)} ${args.join(' ')}`);
    this.setInfo({
      state: 'starting',
      model: opts.modelName,
      modelBytes: opts.modelBytes,
      threads: opts.threads,
      ctx: opts.ctx,
      gpu: { requested: gpuRequested, active: false },
      message: gpuRequested ? "Loading the model onto the Mac's GPU…" : 'Loading the model…',
      startedAt: Date.now(),
      readyMs: null,
    });

    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/data', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
    const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
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
      const wasStarting = this.info.state === 'starting';
      this.setInfo({
        state: 'error',
        message: wasStarting ? this.failureMessage(gpuRequested, code, signal) : `llama-server stopped (${signal || `exit code ${code}`}). Load the model again.`,
      });
    });

    // wait until /health says 200 (503 while the model loads)
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (gen !== this.generation) throw new Error('Stopped');
      if (exited) {
        const msg = this.failureMessage(gpuRequested, exited.code, exited.signal || exited.error);
        if (this.info.state === 'starting') this.setInfo({ state: 'error', message: msg });
        throw new Error(msg);
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('The model did not become ready in 15 minutes');
      }
      if (await this.healthy()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const readyMs = Date.now() - this.info.startedAt;
    this.pushLog(`ready after ${readyMs} ms`);
    this.setInfo({ state: 'ready', message: '', readyMs, gpu: { requested: gpuRequested, ...this.parseGpu(gpuRequested) } });
    return this.status();
  }

  failureMessage(gpuRequested, code, signal) {
    const tail = this.recentLog(40).map((l) => l.replace(/^\d+\.\d+\.\d+\.\d+ [A-Z] /, ''));
    const reason = [...tail].reverse().find((l) => /error|failed|unable|cannot|abort|exception|invalid/i.test(l)) || tail[tail.length - 1] || '';
    const what = signal ? `signal ${signal}` : `exit code ${code}`;
    if (gpuRequested && /rpc|connect/i.test(tail.join('\n'))) {
      return `llama-server could not use the Mac's GPU (${what}): ${reason}`.slice(0, 400);
    }
    return `llama-server stopped while loading (${what})${reason ? `: ${reason}` : ''}`.slice(0, 400);
  }

  healthy() {
    return new Promise((resolve) => {
      const req = http.request({ host: HOST, port: PORT, path: '/health', method: 'GET', agent: false, timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  /**
   * What the load log says about where the layers went. llama-server is started with `-lv 4`: at its default verbosity this
   * llama.cpp version prints nothing about devices and buffers. The lines look like
   *   using device RPC0 (127.0.0.1:50052) (unknown id) - 98303 MiB free
   *   offloaded 25/25 layers to GPU
   *   load_tensors: RPC0[127.0.0.1:50052] model buffer size =   373.71 MiB      (CPU_Mapped model buffer size = 89.26 MiB)
   */
  parseGpu(requested) {
    const text = this.loadLines.join('\n');
    const out = { active: false };
    const off = /offloaded (\d+)\/(\d+) layers to GPU/i.exec(text);
    if (off) {
      out.layers = Number(off[1]);
      out.totalLayers = Number(off[2]);
    }
    const rpcBuf = [...text.matchAll(/\bRPC\d*(?:\[[^\]]*\])?\s+model buffer size\s*=\s*([\d.]+)\s*MiB/gi)];
    if (rpcBuf.length) out.rpcMiB = Math.round(rpcBuf.reduce((s, m) => s + Number(m[1]), 0));
    const cpuBuf = [...text.matchAll(/\bCPU(?:_Mapped)?\s+model buffer size\s*=\s*([\d.]+)\s*MiB/gi)];
    if (cpuBuf.length) out.hostMiB = Math.round(cpuBuf.reduce((s, m) => s + Number(m[1]), 0));
    const dev = /using device (RPC\d+)\b[^\n]*?(?:-\s*(\d+)\s*MiB free)?(?:\n|$)/i.exec(text);
    if (dev) {
      out.device = dev[1];
      if (dev[2]) out.deviceFreeMiB = Number(dev[2]);
    }
    // "offloaded N/N layers to GPU" also appears for a CPU-only build (the CPU is then the device): the proof that the model is on
    // the Mac is a model buffer on an RPC device.
    out.active = !!requested && (out.rpcMiB || 0) > 0;
    if (!out.active) {
      delete out.layers;
      delete out.totalLayers;
    }
    return out;
  }

  /** Stops llama-server (SIGTERM, then SIGKILL after 3 s) and waits until it is gone. */
  async stop() {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    if (this.info.state !== 'stopped') this.setInfo({ state: 'stopped', message: '', gpu: undefined, readyMs: null });
  }

  /**
   * Streams one chat completion. `req` = {messages, temperature, maxTokens}; callbacks: onDelta(text, kind), and the promise
   * resolves with {finish, timings, usage, tokens, firstTokenMs, totalMs}. `signal` aborts (the connection is closed, which stops
   * the generation in llama-server).
   */
  chat(req, onDelta, signal) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'local',
        messages: req.messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        cache_prompt: true,
      });
      const t0 = Date.now();
      let firstAt = 0;
      let lastAt = 0;
      let tokens = 0;
      let finish = null;
      let timings = null;
      let usage = null;
      let buf = '';
      let done = false;
      const end = (err) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve({ finish, timings, usage, tokens, firstTokenMs: firstAt ? firstAt - t0 : null, genMs: firstAt ? lastAt - firstAt : 0, totalMs: Date.now() - t0 });
      };
      const r = http.request(
        {
          host: HOST,
          port: PORT,
          path: '/v1/chat/completions',
          method: 'POST',
          agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf8');
          if (res.statusCode !== 200) {
            let text = '';
            res.on('data', (d) => (text += d));
            res.on('end', () => {
              let msg = `llama-server answered HTTP ${res.statusCode}`;
              try {
                const j = JSON.parse(text);
                if (j && j.error && j.error.message) msg = j.error.message;
              } catch {
                /* keep the generic message */
              }
              end(new Error(msg));
            });
            return;
          }
          const handle = (data) => {
            if (data === '[DONE]') return;
            let j;
            try {
              j = JSON.parse(data);
            } catch {
              return;
            }
            if (j.error) {
              end(new Error(j.error.message || 'llama-server reported an error'));
              return;
            }
            if (j.timings) timings = j.timings;
            if (j.usage) usage = j.usage;
            const c = j.choices && j.choices[0];
            if (!c) return;
            if (c.finish_reason) finish = c.finish_reason;
            const d = c.delta || {};
            const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : '';
            const text = typeof d.content === 'string' ? d.content : '';
            if (reasoning || text) {
              const now = Date.now();
              if (!firstAt) firstAt = now;
              lastAt = now;
              tokens++;
              onDelta(reasoning || text, reasoning ? 'reasoning' : 'content');
            }
          };
          res.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              for (const line of block.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
            }
          });
          res.on('end', () => {
            for (const line of buf.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
            end();
          });
          res.on('error', (e) => end(e));
        },
      );
      r.on('error', (e) => end(signal && signal.aborted ? null : e));
      if (signal) {
        const onAbort = () => {
          finish = finish || 'stopped';
          r.destroy();
          end();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      r.end(body);
    });
  }
}

module.exports = { LlamaServer, binaries, totalMemMiB, availMemMiB, HOST, PORT };
