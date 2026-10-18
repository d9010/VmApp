'use strict';
/**
 * Local LLM core (runtime node22): manages model files in /data/models, runs llama.cpp's llama-server inside the VM
 * (127.0.0.1:8080), and bridges a chat window to its OpenAI-compatible API. With the `gpu` host capability granted
 * ($VMAPP_GPU_RPC set) the user can offload the model to the Mac's GPU through ggml RPC.
 *
 * Window -> core (invoke unless noted; the long operations return at once and report through events):
 *   llm:init                          -> the whole state (see snapshot())
 *   llm:download {id}                 -> {started}            progress: llm:transfer
 *   llm:import                        -> {canceled} | {started, name}   (native open dialog; the file is copied into /data/models)
 *   llm:cancel                        -> {cancelled}          stops the running download or import (a download keeps its partial file)
 *   llm:delete {name}                 -> {removed}
 *   llm:load {name, useGpu?, ctx?}    -> {started}            progress: llm:status
 *   llm:unload                        -> {}
 *   llm:chat {messages, temperature?, maxTokens?} -> {id}     tokens: llm:token, end: llm:done | llm:chat-error
 *   send llm:stop {id}                stops the reply that is being generated
 *   llm:settings {..}                 -> the saved settings (system prompt, temperature, max tokens, context size, GPU choice)
 *   llm:logs                          -> the last lines of llama-server's log
 * Core -> window (emit):
 *   llm:status {state, model, gpu, ...}      llm:transfer {kind, id|name, phase, received, total, bps, error?}
 *   llm:token {id, text, kind}               llm:done {id, stats}               llm:chat-error {id, error}
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('vmapp');
const models = require('./models');
const { LlamaServer, binaries, totalMemMiB, availMemMiB } = require('./llama');

const DATA = process.env.VMAPP_DATA || '/data';
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const MiB = 1024 * 1024;

// The gpu host capability: the guest sets this only when the user granted it (a loopback ggml RPC endpoint that the host forwards
// to its Metal-backed rpc-server). Anything else in the variable is ignored.
const GPU_RPC = /^127\.0\.0\.1:\d{1,5}$/.test(process.env.VMAPP_GPU_RPC || '') ? process.env.VMAPP_GPU_RPC : '';

const CTX_CHOICES = [2048, 4096, 8192, 16384];
const DEFAULTS = {
  lastModel: '',
  useGpu: false,
  ctx: 4096,
  systemPrompt: 'You are a helpful assistant. Answer briefly and clearly.',
  temperature: 0.7,
  maxTokens: 1024,
};

const llama = new LlamaServer();
let win = null;
let chat = null; // {id, ctl}
let nextChat = 1;
let loadedModel = ''; // the file name llama-server was started with
let loadSeq = 0;

function log(msg) {
  console.log(`[local-llm] ${msg}`);
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
  return sanitize({ ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) });
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

// ------------------------------------------------------------------------------------------------ state

function vmInfo() {
  return { cpus: os.availableParallelism(), memMiB: totalMemMiB(), memAvailMiB: availMemMiB() };
}

function snapshot() {
  const b = binaries();
  return {
    app: { name: 'Local LLM' },
    vm: vmInfo(),
    gpu: { granted: !!GPU_RPC },
    binary: { present: b.present, supported: b.supported, missing: b.missing, label: b.label, features: b.features },
    ctxChoices: CTX_CHOICES,
    settings,
    models: models.state(),
    server: llama.status(),
    chatActive: !!chat,
  };
}

llama.on('status', (st) => send('llm:status', st));

// ------------------------------------------------------------------------------------------------ models

function emitTransfer(ev) {
  send('llm:transfer', ev);
  if (ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'cancelled') send('llm:models', models.state());
}

ipcMain.handle('llm:init', () => snapshot());

ipcMain.handle('llm:download', (event, req) => {
  const id = req && req.id;
  if (typeof id !== 'string') throw new Error('Missing model id');
  const r = models.download(id, emitTransfer);
  log(`download ${id} started`);
  return r;
});

ipcMain.handle('llm:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import a model file (.gguf)', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const out = models.importFile(r.filePaths[0], emitTransfer);
  log(`import ${out.name} (${out.bytes} bytes) started`);
  return { canceled: false, ...out };
});

ipcMain.handle('llm:cancel', () => models.cancel());

ipcMain.handle('llm:delete', async (event, req) => {
  const name = req && req.name;
  if (name && name === loadedModel && llama.status().state !== 'stopped') throw new Error('Unload the model before deleting it.');
  const r = models.remove(name);
  send('llm:models', models.state());
  return r;
});

// ------------------------------------------------------------------------------------------------ the server

ipcMain.handle('llm:load', (event, req) => {
  req = req || {};
  const name = req.name;
  const modelPath = models.pathOf(name);
  const bytes = fs.statSync(modelPath).size;
  const ctx = CTX_CHOICES.includes(Number(req.ctx)) ? Number(req.ctx) : settings.ctx;
  const wantGpu = req.useGpu === true && !!GPU_RPC;
  const threads = Math.max(1, os.availableParallelism());
  if (chat) throw new Error('Stop the reply that is being generated first.');
  saveSettings({ lastModel: name, useGpu: req.useGpu === true, ctx });
  const seq = ++loadSeq;
  loadedModel = name;
  log(`load ${name} (${Math.round(bytes / MiB)} MiB): ${threads} threads, ctx ${ctx}, ${wantGpu ? `GPU via ${GPU_RPC}` : 'CPU only'}`);
  llama
    .start({ modelPath, modelName: name, modelBytes: bytes, threads, ctx, rpc: wantGpu ? GPU_RPC : '' })
    .then((st) => {
      if (seq === loadSeq) log(`ready: ${st.readyMs} ms, gpu ${JSON.stringify(st.gpu)}`);
    })
    .catch((e) => {
      if (seq === loadSeq) log(`load failed: ${e.message}`);
      // llama.start already put the error in the status; make sure the window hears about a failure that happened before the spawn
      if (seq === loadSeq && llama.status().state !== 'error' && e.message !== 'Stopped') llama.setInfo({ state: 'error', message: e.message });
    });
  return { started: true };
});

ipcMain.handle('llm:unload', async () => {
  loadSeq++;
  if (chat) chat.ctl.abort();
  await llama.stop();
  loadedModel = '';
  return {};
});

ipcMain.handle('llm:logs', () => ({ lines: llama.recentLog(600) }));

ipcMain.handle('llm:settings', (event, patch) => {
  if (patch && typeof patch === 'object') saveSettings(patch);
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

ipcMain.handle('llm:chat', (event, req) => {
  req = req || {};
  if (llama.status().state !== 'ready') throw new Error('Load a model first.');
  if (chat) throw new Error('A reply is still being generated.');
  const messages = checkMessages(req.messages);
  const temperature = Math.min(2, Math.max(0, Number.isFinite(Number(req.temperature)) ? Number(req.temperature) : settings.temperature));
  const maxTokens = Math.round(Math.min(4096, Math.max(1, Number.isFinite(Number(req.maxTokens)) ? Number(req.maxTokens) : settings.maxTokens)));
  const id = nextChat++;
  const ctl = new AbortController();
  chat = { id, ctl };

  // tokens are sent to the window in small batches
  let pending = { content: '', reasoning: '', n: 0 }; // n: how many pieces (about one token each) the batch holds
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending.reasoning) send('llm:token', { id, text: pending.reasoning, kind: 'reasoning', n: pending.content ? 0 : pending.n });
    if (pending.content) send('llm:token', { id, text: pending.content, kind: 'content', n: pending.n });
    pending = { content: '', reasoning: '', n: 0 };
  };
  const onDelta = (text, kind) => {
    pending[kind === 'reasoning' ? 'reasoning' : 'content'] += text;
    pending.n++;
    if (!timer) timer = setTimeout(flush, 30);
  };

  llama
    .chat({ messages, temperature, maxTokens }, onDelta, ctl.signal)
    .then((r) => {
      flush();
      const t = r.timings || {};
      const u = r.usage || {};
      const genTokens = t.predicted_n ?? u.completion_tokens ?? r.tokens;
      const clientTps = r.genMs > 0 && r.tokens > 1 ? (r.tokens - 1) / (r.genMs / 1000) : null;
      const stats = {
        promptTokens: t.prompt_n ?? u.prompt_tokens ?? null,
        promptTps: t.prompt_per_second ?? null,
        genTokens,
        genTps: t.predicted_per_second ?? clientTps,
        clientTps,
        firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs,
        finish: r.finish,
        gpu: !!(llama.status().gpu && llama.status().gpu.active),
      };
      log(`reply ${id}: ${genTokens} tokens, ${stats.genTps ? stats.genTps.toFixed(1) : '?'} tok/s generation, ${stats.promptTps ? stats.promptTps.toFixed(1) : '?'} tok/s prompt (${stats.finish})`);
      send('llm:done', { id, stats });
    })
    .catch((e) => {
      flush();
      log(`reply ${id} failed: ${e.message}`);
      send('llm:chat-error', { id, error: String(e.message || e) });
    })
    .finally(() => {
      if (chat && chat.id === id) chat = null;
    });
  return { id };
});

ipcMain.on('llm:stop', (event, req) => {
  if (chat && (!req || req.id === undefined || Number(req.id) === chat.id)) chat.ctl.abort();
});

// ------------------------------------------------------------------------------------------------ app

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1120, height: 740, minWidth: 760, minHeight: 480, title: 'Local LLM' });
  await win.loadFile('index.html');
  log(`started: ${os.availableParallelism()} vCPUs, ${totalMemMiB()} MiB, GPU endpoint ${GPU_RPC || 'not granted'}`);
});

// Stop llama-server before the VM goes down (the SDK waits for this for at most 2 s).
app.on('before-quit', async () => {
  if (chat) chat.ctl.abort();
  models.cancel(); // a download keeps its partial file and resumes next time
  await llama.stop();
});
