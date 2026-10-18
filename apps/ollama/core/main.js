'use strict';
/**
 * Ollama core (runtime node22): runs the real `ollama serve` inside the VM (127.0.0.1:11434) and bridges a chat window to its API.
 * Models are pulled from registry.ollama.ai (through the allowlist proxy) into /data/ollama/models by registry.js, which does what
 * Ollama's pull does on Ollama's own store layout: Ollama's downloader cannot work in a VM without DNS or a route (see registry.js).
 *
 * Window -> core (invoke unless noted; long operations return at once and report through events):
 *   ollama:init                          -> the whole state (see snapshot())
 *   ollama:pull {name}                   -> {started, name}        progress: ollama:pull
 *   ollama:cancel                        -> {cancelled}            stops the running pull (the partial files stay and the next pull resumes)
 *   ollama:delete {name}                 -> {removed}              (/api/delete)
 *   ollama:unload {name?}                -> {}                     frees the model's memory now (keep_alive 0)
 *   ollama:chat {model, messages, temperature?, maxTokens?} -> {id}   tokens: ollama:token, end: ollama:done | ollama:chat-error
 *   send ollama:stop {id}                stops the reply that is being generated
 *   ollama:settings {..}                 -> the saved settings (system prompt, temperature, max tokens, context size, GPU choice)
 *   ollama:restart                       -> {started}              restarts `ollama serve` (also after a crash)
 *   ollama:ps                            -> {models, compute}      what is loaded and where (CPU or GPU), from /api/ps
 *   ollama:logs                          -> the last lines of Ollama's log
 * Core -> window (emit):
 *   ollama:status {state, message, version, devices, threads, ...}   ollama:models {dir, freeBytes, local, catalog, pull}
 *   ollama:pull {name, phase, status, received, total, bps, error?}  ollama:loaded {models, compute}
 *   ollama:token {id, text, kind, n}   ollama:done {id, stats}   ollama:chat-error {id, error}
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('vmapp');
const { OllamaServer, binaryInfo, gpuSupport, totalMemMiB, availMemMiB, MODELS_DIR, DATA } = require('./ollama');
const registry = require('./registry');
const CATALOG = require('./models.json').models;

const SETTINGS_FILE = path.join(DATA, 'settings.json');
const MiB = 1024 * 1024;
const CTX_CHOICES = [2048, 4096, 8192, 16384];
const DEFAULTS = {
  lastModel: '',
  useGpu: false,
  ctx: 4096,
  systemPrompt: 'You are a helpful assistant. Answer briefly and clearly.',
  temperature: 0.7,
  maxTokens: 1024,
};

const server = new OllamaServer();
let win = null;
let chat = null; // {id, ctl}
let nextChat = 1;
let pull = null; // {name, ctl, ...}: the one running pull
let restarting = false;
let loaded = []; // /api/ps models

function log(msg) {
  console.log(`[ollama-app] ${msg}`);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------------------------------------------------ settings

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    /* first run, or unreadable: defaults */
  }
  // The GPU is on by default exactly where it can be used (a VM on the experimental Vulkan backend that has Ollama's Vulkan library,
  // i.e. the Ollama (GPU) app, whose user allowed the GPU for it); everywhere else it is off. A choice the user saved wins.
  return sanitize({ ...DEFAULTS, useGpu: gpuSupport().eligible, ...(s && typeof s === 'object' ? s : {}) });
}

function sanitize(s) {
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    lastModel: typeof s.lastModel === 'string' && s.lastModel.length < 200 ? s.lastModel : '',
    useGpu: s.useGpu === true,
    ctx: CTX_CHOICES.includes(Number(s.ctx)) ? Number(s.ctx) : DEFAULTS.ctx,
    systemPrompt: typeof s.systemPrompt === 'string' ? s.systemPrompt.slice(0, 4000) : DEFAULTS.systemPrompt,
    temperature: num(s.temperature, 0, 2, DEFAULTS.temperature),
    maxTokens: Math.round(num(s.maxTokens, 16, 4096, DEFAULTS.maxTokens)),
  };
}

let settings = loadSettings();

function saveSettings(patch) {
  settings = sanitize({ ...settings, ...patch });
  try {
    fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  } catch (e) {
    log(`could not save settings: ${e.message}`);
  }
  return settings;
}

// ------------------------------------------------------------------------------------------------ model names

// [namespace/]model[:tag] on registry.ollama.ai. At most one slash, so there is never a registry host in the name; the tag may have
// capitals (7B-instruct-q4_K_M). A missing tag means :latest, as in Ollama.
const NAME_RE = /^(?:[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$/;

function checkName(input) {
  if (typeof input !== 'string') throw new Error('Missing model name');
  let n = input.trim();
  if (n.startsWith('library/')) n = n.slice('library/'.length);
  if (!NAME_RE.test(n)) throw new Error('That is not a model name. Use the form name:tag, for example qwen2.5:0.5b (models of registry.ollama.ai only).');
  return n.includes(':') ? n : `${n}:latest`;
}

// ------------------------------------------------------------------------------------------------ models

function freeBytes() {
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    const s = fs.statfsSync(MODELS_DIR);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function listLocal() {
  if (server.status().state !== 'ready') return [];
  const r = await server.call('GET', '/api/tags', null, { timeoutMs: 10000 });
  return (r.models || [])
    .map((m) => ({
      name: String(m.name || m.model),
      bytes: Number(m.size) || 0,
      digest: String(m.digest || '').slice(0, 12),
      modifiedAt: m.modified_at || null,
      params: (m.details && m.details.parameter_size) || '',
      quant: (m.details && m.details.quantization_level) || '',
      family: (m.details && m.details.family) || '',
      contextLength: (m.details && m.details.context_length) || null,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function modelState() {
  let local = [];
  try {
    local = await listLocal();
  } catch (e) {
    log(`could not list models: ${e.message}`);
  }
  return {
    dir: MODELS_DIR,
    freeBytes: freeBytes(),
    local,
    catalog: CATALOG.map((c) => ({ ...c, installed: local.some((l) => l.name === c.name) })),
    pull: pullInfo(),
  };
}

async function emitModels() {
  send('ollama:models', await modelState());
}

// ------------------------------------------------------------------------------------------------ compute (CPU or GPU)

/** Where the loaded models run, from /api/ps (`size_vram` is the part of the model in video memory) and the server's device list. */
function computeInfo() {
  const sup = gpuSupport();
  const st = server.status();
  const gpuDevices = (st.devices || []).filter((d) => d.library && d.library !== 'cpu');
  return {
    support: sup,
    requested: settings.useGpu,
    vulkanOn: !!st.vulkan,
    devices: st.devices || [],
    gpuDevices,
    threads: st.threads,
    models: loaded.map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      vramBytes: m.size_vram || 0,
      where: (m.size_vram || 0) > 0 ? 'gpu' : 'cpu',
      percentGpu: m.size ? Math.round(((m.size_vram || 0) / m.size) * 100) : 0,
      contextLength: m.context_length || null,
      expiresAt: m.expires_at || null,
    })),
  };
}

async function refreshLoaded() {
  if (server.status().state !== 'ready') {
    loaded = [];
  } else {
    try {
      const r = await server.call('GET', '/api/ps', null, { timeoutMs: 10000 });
      loaded = Array.isArray(r.models) ? r.models : [];
    } catch (e) {
      log(`could not read /api/ps: ${e.message}`);
    }
  }
  const out = { models: loaded.map((m) => m.name), compute: computeInfo() };
  send('ollama:loaded', out);
  return out;
}

// ------------------------------------------------------------------------------------------------ state

function vmInfo() {
  return { cpus: os.availableParallelism(), memMiB: totalMemMiB(), memAvailMiB: availMemMiB() };
}

async function snapshot() {
  return {
    app: { name: 'Ollama' },
    vm: vmInfo(),
    binary: binaryInfo(),
    gpu: gpuSupport(),
    ctxChoices: CTX_CHOICES,
    settings,
    server: server.status(),
    models: await modelState(),
    compute: computeInfo(),
    chatActive: !!chat,
  };
}

server.on('status', (st) => {
  send('ollama:status', st);
  if (st.state === 'ready') {
    emitModels().catch(() => {});
    refreshLoaded().catch(() => {});
  }
});

async function startServer() {
  try {
    const st = await server.start({ gpu: settings.useGpu });
    log(`ollama ${st.version} ready in ${st.readyMs} ms; devices: ${st.devices.map((d) => `${d.library}:${d.name}`).join(', ') || 'none seen'}`);
  } catch (e) {
    if (e.message !== 'Stopped') {
      log(`Ollama did not start: ${e.message}`);
      if (server.status().state !== 'error') server.setInfo({ state: 'error', message: e.message });
    }
  }
}

ipcMain.handle('ollama:init', () => snapshot());

ipcMain.handle('ollama:restart', () => {
  if (restarting) throw new Error('Ollama is already restarting.');
  if (chat) throw new Error('Stop the reply that is being generated first.');
  restarting = true;
  loaded = [];
  startServer().finally(() => {
    restarting = false;
  });
  return { started: true };
});

// ------------------------------------------------------------------------------------------------ pull

function pullInfo() {
  if (!pull) return null;
  const { name, phase, status, received, total, bps } = pull;
  return { name, phase, status, received, total, bps };
}

// The core pulls the model itself (registry.js explains why Ollama's own /api/pull cannot work in the VM) and Ollama serves what ends up
// in /data/ollama/models. The events are the same shape Ollama's pull stream would give: a phase, a status line, bytes and speed.
function startPull(name) {
  const ctl = new AbortController();
  pull = { name, ctl, phase: 'starting', status: 'pulling manifest', received: 0, total: 0, bps: 0 };
  const p = pull;
  const event = (extra) => ({ name, phase: p.phase, status: p.status, received: p.received, total: p.total, bps: p.bps, ...extra });
  send('ollama:pull', event());

  registry
    .pull(name, (s) => {
      Object.assign(p, s);
      send('ollama:pull', event());
    }, ctl.signal)
    .then(() => {
      p.phase = 'done';
      p.received = p.total;
      send('ollama:pull', event());
    })
    .catch((e) => {
      const aborted = ctl.signal.aborted || (e && e.name === 'AbortError');
      p.phase = aborted ? 'cancelled' : 'error';
      if (!aborted) log(`pull ${name} failed: ${e && e.message}`);
      send('ollama:pull', event(aborted ? {} : { error: String((e && e.message) || e) }));
    })
    .finally(() => {
      log(`pull ${name}: ${p.phase}`);
      if (pull === p) pull = null;
      emitModels().catch(() => {});
    });
}

ipcMain.handle('ollama:pull', (event, req) => {
  const name = checkName(req && req.name);
  if (server.status().state !== 'ready') throw new Error('Ollama is not running yet.');
  if (pull) throw new Error('Another download is still running. Wait for it or cancel it.');
  const entry = CATALOG.find((c) => c.name === name);
  const free = freeBytes();
  if (entry && free !== null && entry.bytes + 64 * MiB > free) {
    throw new Error(`Not enough free space for ${entry.title}: it needs about ${Math.ceil(entry.bytes / MiB)} MiB and ${Math.floor(free / MiB)} MiB are free on the disk that holds this app's data.`);
  }
  log(`pull ${name} started`);
  startPull(name);
  return { started: true, name };
});

ipcMain.handle('ollama:cancel', () => {
  if (!pull) return { cancelled: false };
  pull.ctl.abort();
  return { cancelled: true };
});

ipcMain.handle('ollama:delete', async (event, req) => {
  const name = checkName(req && req.name);
  if (pull && pull.name === name) throw new Error('This model is being downloaded. Cancel the download first.');
  if (chat) throw new Error('Wait for the reply that is being generated.');
  const local = await listLocal();
  if (!local.some((l) => l.name === name)) throw new Error('That model is not installed.');
  // free its memory first, so that the blobs are not in use
  await server.request('POST', '/api/generate', { model: name, keep_alive: 0 }, { timeoutMs: 20000 }).catch(() => {});
  await server.call('DELETE', '/api/delete', { model: name }, { timeoutMs: 30000 });
  log(`deleted ${name}`);
  await emitModels();
  await refreshLoaded();
  return { removed: true };
});

ipcMain.handle('ollama:unload', async (event, req) => {
  const names = req && typeof req.name === 'string' ? [checkName(req.name)] : loaded.map((m) => m.name);
  if (chat) throw new Error('Wait for the reply that is being generated.');
  for (const name of names) await server.request('POST', '/api/generate', { model: name, keep_alive: 0 }, { timeoutMs: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await refreshLoaded();
  return {};
});

ipcMain.handle('ollama:ps', () => refreshLoaded());
ipcMain.handle('ollama:logs', () => ({ lines: server.recentLog(600) }));

ipcMain.handle('ollama:settings', async (event, patch) => {
  const before = settings.useGpu;
  if (patch && typeof patch === 'object') saveSettings(patch);
  if (settings.useGpu !== before) {
    // OLLAMA_VULKAN is read when the server starts: apply the choice by restarting it (this unloads the model)
    if (chat) {
      saveSettings({ useGpu: before });
      throw new Error('Stop the reply that is being generated first.');
    }
    if (!restarting && server.status().state !== 'stopped') {
      restarting = true;
      loaded = [];
      log(`GPU choice changed to ${settings.useGpu}: restarting Ollama`);
      startServer().finally(() => {
        restarting = false;
      });
    }
  }
  return settings;
});

// ------------------------------------------------------------------------------------------------ chat

const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGES = 400;
const MAX_CHARS = 600000;

function checkMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) throw new Error('No messages to send');
  let chars = 0;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role) || typeof m.content !== 'string') throw new Error('Bad message');
    chars += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  if (chars > MAX_CHARS) throw new Error('The conversation is too long');
  return out;
}

const nsToMs = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : null);
const perSecond = (count, ns) => (Number.isFinite(count) && Number.isFinite(ns) && ns > 0 ? count / (ns / 1e9) : null);

ipcMain.handle('ollama:chat', async (event, req) => {
  req = req || {};
  if (server.status().state !== 'ready') throw new Error('Ollama is not running yet.');
  if (chat) throw new Error('A reply is still being generated.');
  const model = checkName(req.model);
  const local = await listLocal();
  if (!local.some((l) => l.name === model)) throw new Error('That model is not installed: pull it first.');
  if (chat) throw new Error('A reply is still being generated.');
  const messages = checkMessages(req.messages);
  const temperature = Math.min(2, Math.max(0, Number.isFinite(Number(req.temperature)) ? Number(req.temperature) : settings.temperature));
  const maxTokens = Math.round(Math.min(4096, Math.max(1, Number.isFinite(Number(req.maxTokens)) ? Number(req.maxTokens) : settings.maxTokens)));
  const id = nextChat++;
  const ctl = new AbortController();
  chat = { id, ctl };
  saveSettings({ lastModel: model });

  // tokens are sent to the window in small batches
  let pending = { content: '', reasoning: '', n: 0 }; // n: how many pieces (about one token each) the batch holds
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending.reasoning) send('ollama:token', { id, text: pending.reasoning, kind: 'reasoning', n: pending.content ? 0 : pending.n });
    if (pending.content) send('ollama:token', { id, text: pending.content, kind: 'content', n: pending.n });
    pending = { content: '', reasoning: '', n: 0 };
  };
  const onDelta = (text, kind) => {
    pending[kind === 'reasoning' ? 'reasoning' : 'content'] += text;
    pending.n++;
    if (!timer) timer = setTimeout(flush, 30);
  };

  const t0 = Date.now();
  let firstAt = 0;
  let lastAt = 0;
  let pieces = 0;
  let final = null;
  let stopped = false;
  log(`chat ${id} with ${model}: ${messages.length} messages, context ${settings.ctx}`);

  server
    .stream(
      '/api/chat',
      { model, messages, stream: true, keep_alive: '30m', options: { temperature, num_predict: maxTokens, num_ctx: settings.ctx } },
      (o) => {
        if (o.error) throw new Error(o.error);
        const msg = o.message || {};
        const reasoning = typeof msg.thinking === 'string' ? msg.thinking : '';
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (reasoning || text) {
          const now = Date.now();
          if (!firstAt) firstAt = now;
          lastAt = now;
          pieces++;
          onDelta(reasoning || text, reasoning ? 'reasoning' : 'content');
        }
        if (o.done) final = o;
      },
      ctl.signal,
    )
    .then(async () => {
      flush();
      stopped = ctl.signal.aborted;
      const f = final || {};
      await refreshLoaded();
      const mine = loaded.find((m) => m.name === model);
      const genTokens = Number.isFinite(f.eval_count) ? f.eval_count : pieces;
      const stats = {
        promptTokens: Number.isFinite(f.prompt_eval_count) ? f.prompt_eval_count : null,
        promptCachedTokens: Number.isFinite(f.prompt_eval_cached_count) ? f.prompt_eval_cached_count : null,
        promptTps: perSecond(f.prompt_eval_count, f.prompt_eval_duration),
        genTokens,
        genTps: perSecond(f.eval_count, f.eval_duration) ?? (pieces > 1 && lastAt > firstAt ? ((pieces - 1) / (lastAt - firstAt)) * 1000 : null),
        loadMs: nsToMs(f.load_duration),
        firstTokenMs: firstAt ? firstAt - t0 : null,
        totalMs: Date.now() - t0,
        finish: stopped ? 'stopped' : f.done_reason || (final ? 'stop' : 'unknown'),
        gpu: !!(mine && (mine.size_vram || 0) > 0),
        where: mine ? ((mine.size_vram || 0) > 0 ? 'gpu' : 'cpu') : null,
        model,
      };
      if (!final && !stopped) throw new Error('Ollama ended the reply without finishing it.');
      log(`reply ${id}: ${genTokens} tokens, ${stats.genTps ? stats.genTps.toFixed(1) : '?'} tok/s generation, ${stats.promptTps ? stats.promptTps.toFixed(1) : '?'} tok/s prompt, ${stats.where || '?'} (${stats.finish})`);
      send('ollama:done', { id, stats });
    })
    .catch((e) => {
      flush();
      log(`reply ${id} failed: ${e.message}`);
      send('ollama:chat-error', { id, error: String(e.message || e) });
    })
    .finally(() => {
      if (chat && chat.id === id) chat = null;
    });
  return { id };
});

ipcMain.on('ollama:stop', (event, req) => {
  if (chat && (!req || req.id === undefined || Number(req.id) === chat.id)) chat.ctl.abort();
});

// ------------------------------------------------------------------------------------------------ app

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1120, height: 740, minWidth: 760, minHeight: 480, title: 'Ollama' });
  await win.loadFile('index.html');
  const g = gpuSupport();
  log(`started: ${os.availableParallelism()} vCPUs, ${totalMemMiB()} MiB; Vulkan device ${g.device ? 'present' : 'absent'}, backend ${g.backend ? 'present' : 'absent'}`);
  startServer();
});

// Stop Ollama before the VM goes down (the SDK waits for this for at most 2 s).
app.on('before-quit', async () => {
  if (chat) chat.ctl.abort();
  if (pull) pull.ctl.abort(); // the partial files stay in /data and the next pull resumes them
  await server.stop(1200);
});
