'use strict';
/**
 * Ollama (Desktop), core (runtime node22-gpu): Ollama's own desktop app, its real Go backend and its real React window, in a VM.
 *
 *   window (ui/, Ollama's React app, built from the pinned source)                  VM
 *     fetch('/api/v1/chat/…') ──vmapp-fetch.js──► bridge ──► http-bridge.js ──► 127.0.0.1:11501  vmapp-ui   (app/ui, app/store, app/server)
 *     (streamed answers, aborts)                                                                      │  supervises
 *                                                                                                      ▼
 *                                                                              127.0.0.1:11434  `ollama serve`  (Ollama v0.35.0 from source)
 *                                                                                                      │  models: registry.ollama.ai via the proxy
 *
 * This file does only what the desktop shell (app/cmd/app, the webview and the tray) did for the Go backend, and nothing the backend does
 * itself: it starts `vmapp-ui` (apps/ollama-desktop/backend/vmapp-ui: the desktop app's own ui.Server, store and server supervisor without
 * the webview) with the environment the desktop app would give it, opens the window, carries the window's HTTP requests to the backend
 * (sdk/node/http-bridge.js), and answers the three things the window asks of its host:
 *
 *   ollama:open-external {url}      -> {opened}   a link (sign in at ollama.com, a link in a message): https only, the platform asks the user
 *   ollama:pick-directory {title}   -> {path|null} the "Model location" folder: a native dialog; the folder is shared read-write
 *   ollama:diag                     -> {...}      what runs, the backend's port, the tail of the server log (read-only; for tests and bug reports)
 *   ollama:cli {args:[...]}         -> {code, stdout, stderr}   the `ollama` command line, against the same server (a fixed list of subcommands)
 *
 * Environment handed to vmapp-ui (and, through app/server, to `ollama serve`):
 *   HOME=/data                      the app's private storage: ~/.ollama holds the models, the server log, the key pair and app/db.sqlite (chats)
 *   PATH=/app/bin:…                 app/server finds `ollama` with exec.LookPath; a shell started by the core finds it too
 *   OLLAMA_HOST=127.0.0.1:11434     loopback only; the settings page's "Expose Ollama to the network" is moot in a VM without a network device
 *   OLLAMA_VULKAN=1|0, OLLAMA_IGPU_ENABLE=1, GGML_VK_DISABLE_ASYNC=1     the experimental GPU, only where a Vulkan device and the backend library exist
 *   SSL_CERT_FILE                   a CA bundle written from Node's root store (the runtime has no /etc/ssl/certs, and Go needs one)
 *   HTTPS_PROXY & co                inherited: the platform's allowlist proxy is the only way out, and Ollama (patched, patches/go/0001) honours it
 *   OLLAMA_NO_CLOUD is NOT set: the "Cloud" switch of the settings page works (it needs ollama.com to be allowed)
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('vmapp');
const httpBridge = require('./http-bridge');

const APP = __dirname;
const BIN = path.join(APP, 'bin');
const LIB_DIR = path.join(APP, 'lib', 'ollama');
const DATA = process.env.VMAPP_DATA || '/data';
const UI_PORT = 11501;
const OLLAMA_PORT = 11434;
const CA_FILE = '/tmp/vmapp-ca-bundle.pem';
const RENDER_NODE = '/dev/dri/renderD128'; // the Venus GPU's render node: present only on the experimental Vulkan backend
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];
const TOKEN = crypto.randomBytes(24).toString('hex'); // the "token" cookie of the backend (ui.Server.Token): only this core knows it

let win = null;
let child = null;
let uiPort = 0; // set when vmapp-ui reports that it listens
let quitting = false;
let restarts = 0;
let lastStart = 0;

const log = (msg) => console.log(`[ollama-desktop] ${msg}`);

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Is there a Vulkan device and Ollama's Vulkan backend library? (The GPU is used automatically where both exist, as Ollama does.) */
function gpuSupport() {
  const device = exists(RENDER_NODE);
  const backend = exists(path.join(LIB_DIR, 'vulkan', 'libggml-vulkan.so'));
  return { device, backend, eligible: device && backend };
}

function writeCaBundle() {
  const roots = tls.rootCertificates;
  if (!Array.isArray(roots) || roots.length < 20) throw new Error('Node has no root certificates to give Ollama');
  const tmp = `${CA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${roots.join('\n')}\n`, { mode: 0o644 });
  fs.renameSync(tmp, CA_FILE);
  return roots.length;
}

function backendEnv() {
  const gpu = gpuSupport();
  const env = {
    PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`,
    HOME: DATA,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
    OLLAMA_VULKAN: gpu.eligible ? '1' : '0', // this Ollama turns Vulkan on by itself when its library exists: say it explicitly
    SSL_CERT_FILE: CA_FILE,
    VMAPP_OLLAMA_UI_ADDR: `127.0.0.1:${UI_PORT}`,
    VMAPP_OLLAMA_UI_TOKEN: TOKEN,
    VMAPP_OLLAMA_DB: path.join(DATA, '.ollama', 'app', 'db.sqlite'),
  };
  // The Venus device is an integrated (UMA) GPU, which Ollama's discovery drops on Linux unless OLLAMA_IGPU_ENABLE is set; and
  // ggml-vulkan's asynchronous path computes wrong results on it (apps/ollama/README.md, "The async path computes wrong results on Venus").
  if (gpu.eligible) {
    env.OLLAMA_IGPU_ENABLE = '1';
    env.GGML_VK_DISABLE_ASYNC = '1';
  }
  for (const k of PROXY_VARS) if (process.env[k]) env[k] = process.env[k];
  // tuning and debugging switches the app author sets in the manifest's core.env (never the window's choice)
  for (const k of Object.keys(process.env)) {
    if (/^(GGML_VK_[A-Z0-9_]+|OLLAMA_FLASH_ATTENTION|OLLAMA_KV_CACHE_TYPE|OLLAMA_DEBUG|OLLAMA_CONTEXT_LENGTH|OLLAMA_KEEP_ALIVE|OLLAMA_NUM_PARALLEL|OLLAMA_MAX_LOADED_MODELS)$/.test(k)) env[k] = process.env[k];
  }
  return env;
}

// ------------------------------------------------------------------------------------------------ the backend process

function prepareDirs() {
  for (const d of [path.join(DATA, '.ollama', 'app'), path.join(DATA, '.ollama', 'logs'), path.join(DATA, 'Library', 'Application Support', 'Ollama')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
  }
}

function startBackend() {
  const exe = path.join(BIN, 'vmapp-ui');
  if (!exists(exe) || !exists(path.join(BIN, 'ollama'))) throw new Error('Ollama is not bundled in this build of the app (run apps/ollama-desktop/build.sh and pack again)');
  const certs = writeCaBundle();
  prepareDirs();
  lastStart = Date.now();
  const p = spawn(exe, [], { env: backendEnv(), stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
  child = p;
  const g = gpuSupport();
  log(`started vmapp-ui (pid ${p.pid}); ${certs} CA certificates; Vulkan device ${g.device ? 'present' : 'absent'}, backend ${g.backend ? 'present' : 'absent'}`);
  const lines = (stream, fn) => {
    let carry = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      carry += d;
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        fn(carry.slice(0, i).replace(/\r$/, ''));
        carry = carry.slice(i + 1);
      }
      if (carry.length > 16384) carry = '';
    });
  };
  lines(p.stdout, (line) => {
    const m = /^VMAPP-UI listening 127\.0\.0\.1:(\d+)$/.exec(line);
    if (m) {
      uiPort = Number(m[1]);
      log(`the backend listens on 127.0.0.1:${uiPort}`);
    } else if (line) {
      log(`[ui] ${line.slice(0, 400)}`);
    }
  });
  lines(p.stderr, (line) => {
    // the backend logs every request at info level: keep the failures and the rest, drop the 2xx lines
    if (/msg=site\.serveHTTP/.test(line) && / http\.status=2\d\d /.test(line)) return;
    if (line) log(`[ui] ${line.slice(0, 400)}`);
  });
  p.on('error', (e) => log(`could not start vmapp-ui: ${e.message}`));
  p.on('exit', (code, signal) => {
    if (child === p) child = null;
    uiPort = 0;
    if (quitting) return;
    log(`vmapp-ui exited (${signal || `code ${code}`})`);
    // a backend that dies right after it started is not restarted in a loop
    restarts = Date.now() - lastStart > 30000 ? 0 : restarts + 1;
    if (restarts > 4) {
      log('vmapp-ui keeps failing: not restarting it again');
      return;
    }
    setTimeout(() => {
      if (!quitting) {
        try {
          startBackend();
        } catch (e) {
          log(e.message);
        }
      }
    }, Math.min(1000 * 2 ** restarts, 10000));
  });
}

function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (uiPort) return resolve(uiPort);
      if (!child) return reject(new Error('the Ollama backend did not start'));
      if (Date.now() > deadline) return reject(new Error('the Ollama backend did not start in time'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ------------------------------------------------------------------------------------------------ the window's HTTP requests

const bridge = httpBridge.attach(ipcMain, {
  port: () => uiPort,
  prefixes: ['/api/'], // everything the React app asks of its backend; the page itself is served by the platform, not by the backend
  headers: () => ({ cookie: `token=${TOKEN}` }),
  window: 256 * 1024,
});

// Ollama's own API, unchanged, at /ollama/ on the window's origin: `fetch('/ollama/api/pull', …)` is `POST /api/pull` on the real server
// (127.0.0.1:11434), streamed progress and all, and `/ollama/v1/…` is its OpenAI-compatible API. The React app does not use it (it talks
// to the backend above, which proxies a few of these endpoints itself); it is for other windows, scripts and tests of this app, and so
// that a program that speaks Ollama's API can use it exactly as it would a local Ollama. Only the endpoints a client uses to run models:
// nothing that creates, pushes or uploads a model, no blobs.
const RAW_API = [
  ['GET', /^\/api\/(tags|ps|version)$/],
  ['HEAD', /^\/api\/version$/],
  ['POST', /^\/api\/(show|pull|chat|generate|embed|embeddings|copy)$/],
  ['DELETE', /^\/api\/delete$/],
  ['GET', /^\/v1\/models(\/[^/]+)?$/],
  ['POST', /^\/v1\/(chat\/completions|completions|embeddings)$/],
];
const rawBridge = httpBridge.attach(ipcMain, {
  channel: 'raw',
  port: OLLAMA_PORT,
  strip: '/ollama',
  prefixes: ['/api/', '/v1/'],
  allow: (method, p) => RAW_API.some(([m, re]) => m === method && re.test(p)),
  window: 256 * 1024,
});

// ------------------------------------------------------------------------------------------------ what the window asks of its host

ipcMain.handle('ollama:open-external', async (event, req) => {
  let u;
  try {
    u = new URL(String(req && req.url));
  } catch {
    throw new Error('That is not a link I can open.');
  }
  if (u.protocol !== 'https:') throw new Error('Only https links can be opened.');
  return { opened: await shell.openExternal(u.href) };
});

ipcMain.handle('ollama:pick-directory', async (event, req) => {
  const title = req && typeof req.title === 'string' ? req.title.slice(0, 100) : 'Select a folder';
  // A folder shared read-write: Ollama writes the models there. (Not available on the experimental GPU backend: the host answers so.)
  const r = await dialog.showOpenDialog(win || undefined, { title, properties: ['openDirectory', 'createDirectory'], access: 'readwrite' });
  return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] };
});

function tailFile(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

ipcMain.handle('ollama:diag', () => ({
  backendPort: uiPort,
  inFlight: bridge.size + rawBridge.size,
  gpu: gpuSupport(),
  vm: { cpus: os.availableParallelism(), memMiB: Math.round(os.totalmem() / 1048576) },
  paths: { home: DATA, models: path.join(DATA, '.ollama', 'models'), db: path.join(DATA, '.ollama', 'app', 'db.sqlite') },
  serverLog: tailFile(path.join(DATA, '.ollama', 'logs', 'server.log'), 200),
}));

// The `ollama` command line against the same server, for scripts and tests, and the documented way to use the CLI from this app
// (docs/CONVERSION.md: "The CLI"). A fixed list of subcommands, no shell, a timeout, bounded output.
const CLI_COMMANDS = new Set(['--version', 'version', 'list', 'ls', 'ps', 'show', 'pull', 'rm', 'cp', 'stop', 'run']);
let cliBusy = 0;
ipcMain.handle('ollama:cli', (event, req) => {
  const args = req && Array.isArray(req.args) ? req.args.map(String) : [];
  if (!args.length || !CLI_COMMANDS.has(args[0])) throw new Error(`ollama ${args[0] || ''}: not available here (${[...CLI_COMMANDS].join(', ')})`);
  if (args.some((a) => a.length > 8192 || a.includes('\0'))) throw new Error('bad argument');
  if (cliBusy >= 4) throw new Error('too many ollama commands at once');
  cliBusy++;
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let size = 0;
    const cap = (arr) => (c) => {
      size += c.length;
      if (size <= 1024 * 1024) arr.push(c);
    };
    const env = backendEnv();
    for (const k of Object.keys(env)) if (k.startsWith('VMAPP_')) delete env[k]; // the backend's token and paths are not the CLI's business
    const p = spawn(path.join(BIN, 'ollama'), args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
    const timer = setTimeout(() => p.kill('SIGKILL'), 20 * 60 * 1000);
    p.stdout.on('data', cap(out));
    p.stderr.on('data', cap(err));
    p.on('error', (e) => {
      clearTimeout(timer);
      cliBusy--;
      resolve({ code: -1, stdout: '', stderr: String(e.message) });
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      cliBusy--;
      resolve({ code: code === null ? -1 : code, signal: signal || null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
});

// ------------------------------------------------------------------------------------------------ app

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend(30000);
  } catch (e) {
    log(`startup: ${e.message}`);
  }
  // 1360x960 is the desktop app's default and 900x660 its minimum (app/cmd/app/webview.go); the platform clamps to the screen
  win = new BrowserWindow({ width: 1360, height: 960, minWidth: 900, minHeight: 660, title: 'Ollama' });
  await win.loadFile('index.html');
});

// Stop the backend (it stops `ollama serve`) before the VM goes down; the SDK waits for this for at most 2 s.
app.on('before-quit', async () => {
  quitting = true;
  bridge.close();
  rawBridge.close();
  const p = child;
  if (p && p.exitCode === null) {
    await new Promise((resolve) => {
      const kill = setTimeout(() => p.kill('SIGKILL'), 1500);
      p.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      p.kill('SIGTERM');
    });
  }
});
