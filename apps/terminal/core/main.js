'use strict';
/**
 * Terminal core (runtime node22): bridges the window's terminal emulator (xterm.js) to programs running on pseudo-terminals
 * inside the VM, through `ptyd` (bin/ptyd).
 *
 * Window -> core:
 *   invoke terminal:init                       -> {profiles:[...], workspace:{granted, path}, last}
 *   invoke terminal:start {profile, rows, cols} -> {id, profile, cwd, inWorkspace}
 *   invoke terminal:stop {id}                  -> {}
 *   invoke terminal:secret-set {env, value}    -> {set:true}      (a profile's key, stored in /data/settings.json, mode 0600)
 *   invoke terminal:secret-clear {env}         -> {set:false}
 *   invoke terminal:open-help {env}            -> {opened}        (opens the key's help page; fixed URLs, the user confirms)
 *   send   terminal:input {id, data, binary?}  keystrokes and pastes (a string; binary: one character per raw byte)
 *   send   terminal:resize {id, rows, cols}
 *   send   terminal:ack {id, bytes}            the window has drawn this many bytes (flow control)
 * Core -> window:
 *   emit   terminal:data {id, b64}             output, batched about every 16 ms
 *   emit   terminal:exit {id, code}
 *
 * A secret's value goes from settings.json into the environment of the one process that needs it, and nowhere else: not to
 * the window, not to the log, not to the terminal.
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, folders } = require('vmapp');
const settings = require('./settings');
const profiles = require('./profiles');
const { PtySession } = require('./ptysession');

const PTYD = path.join(__dirname, 'bin', 'ptyd');
const DATA = process.env.VMAPP_DATA || '/data';

const BATCH_MS = 16; // output is sent to the window at most this often...
const BATCH_MAX = 64 * 1024; // ...or as soon as this much is waiting
const HIGH_WATER = 1024 * 1024; // pause the program when the window is this far behind
const LOW_WATER = 256 * 1024; // and let it go on once the window has caught up to this
const MAX_INPUT = 1024 * 1024;

/** @type {Map<number, {session: PtySession, flush: Function, ack: Function, profile: string}>} */
const sessions = new Map();
let nextId = 1;
let win = null;

function log(msg) {
  console.log(`[terminal] ${msg}`);
}

function toSize(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`${name} must be a whole number from 1 to 1000`);
  return n;
}

function workspaceInfo() {
  const p = folders.workspace;
  return p && fs.existsSync(p) ? { granted: true, path: p } : { granted: false, path: DATA };
}

/** The environment every profile starts from: the core's own (proxy settings, certificates...) minus the bridge's. */
function baseEnv() {
  const env = { ...process.env };
  delete env.VMAPP_SOCKET;
  delete env.VMAPP_ID;
  return Object.assign(env, {
    HOME: DATA,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'C.UTF-8',
    SHELL: '/bin/bash',
    // NODE_USE_ENV_PROXY (SPEC 8.3) makes Node print a one-line "experimental" notice per process; keep it out of the terminal.
    NODE_OPTIONS: '--disable-warning=UNDICI-EHPA',
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startSession({ profile: profileId, rows, cols }) {
  const profile = profiles.find(String(profileId));
  if (!profile) throw new Error(`unknown profile "${profileId}"`);
  if (profile.unavailable) {
    const why = profile.unavailable();
    if (why) throw new Error(why);
  }
  rows = toSize(rows === undefined ? 24 : rows, 'rows');
  cols = toSize(cols === undefined ? 80 : cols, 'cols');
  // One terminal at a time: starting another one ends the old one.
  for (const [id] of sessions) stopSession(id);

  const ws = workspaceInfo();
  const env = Object.assign(baseEnv(), profile.env || {});
  let hasSecret = false;
  if (profile.secret) {
    // Only this profile's process gets its secret, and it is removed from every other one's environment.
    const value = settings.secretFor(profile.secret.env);
    if (value !== undefined) {
      env[profile.secret.env] = value;
      hasSecret = true;
    }
  }
  for (const other of profiles.PROFILES) {
    if (other.secret && other !== profile) delete env[other.secret.env];
  }
  if (profile.prepare) {
    try {
      profile.prepare({ hasSecret });
    } catch (e) {
      log(`profile ${profile.id}: prepare failed: ${e.message}`);
    }
  }

  const id = nextId++;
  const session = new PtySession({ ptyd: PTYD, command: profile.command(), cwd: ws.path, env, rows, cols });

  // Output to the window: batched, with a simple window-based flow control (the window acks what it has drawn).
  let chunks = [];
  let size = 0;
  let timer = null;
  let unacked = 0;
  let paused = false;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!size) return;
    const buf = Buffer.concat(chunks, size);
    chunks = [];
    size = 0;
    unacked += buf.length;
    send('terminal:data', { id, b64: buf.toString('base64') });
    if (!paused && unacked > HIGH_WATER) {
      paused = true;
      session.pause();
    }
  };
  const ack = (bytes) => {
    unacked = Math.max(0, unacked - bytes);
    if (paused && unacked < LOW_WATER) {
      paused = false;
      session.resume();
    }
  };
  session.on('data', (buf) => {
    chunks.push(buf);
    size += buf.length;
    if (size >= BATCH_MAX) flush();
    else if (!timer) timer = setTimeout(flush, BATCH_MS);
  });
  session.on('message', (text) => {
    flush();
    send('terminal:data', { id, b64: Buffer.from(`\r\n\x1b[31m[terminal] ${text.replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`).toString('base64') });
  });
  session.on('exit', (code) => {
    flush();
    sessions.delete(id);
    log(`session ${id} (${profile.id}) ended with code ${code}`);
    send('terminal:exit', { id, code });
  });
  sessions.set(id, { session, flush, ack, profile: profile.id });
  session.start();
  log(`session ${id}: ${profile.id} in ${ws.path} (${cols}x${rows})`);
  return { id, profile: profile.id, cwd: ws.path, inWorkspace: ws.granted };
}

function stopSession(id) {
  const s = sessions.get(id);
  if (s) s.session.stop();
}

function get(id) {
  const s = sessions.get(Number(id));
  return s || null;
}

// ------------------------------------------------------------------------------------------------ IPC

ipcMain.handle('terminal:init', () => ({
  profiles: profiles.PROFILES.map((p) => profiles.describe(p, settings.hasSecret)),
  workspace: workspaceInfo(),
}));

ipcMain.handle('terminal:start', (event, req) => startSession(req || {}));

ipcMain.handle('terminal:stop', (event, req) => {
  stopSession(Number(req && req.id));
  return {};
});

function secretProfile(env) {
  const p = profiles.bySecretEnv(String(env));
  if (!p) throw new Error('unknown setting');
  return p;
}

ipcMain.handle('terminal:secret-set', (event, req) => {
  const p = secretProfile(req && req.env);
  settings.setSecret(p.secret.env, req.value);
  log(`${p.secret.env} saved`); // the name only
  return { set: true };
});

ipcMain.handle('terminal:secret-clear', (event, req) => {
  const p = secretProfile(req && req.env);
  settings.clearSecret(p.secret.env);
  log(`${p.secret.env} removed`);
  return { set: false };
});

ipcMain.handle('terminal:open-help', async (event, req) => {
  const p = secretProfile(req && req.env);
  if (!p.secret.helpUrl) return { opened: false };
  return { opened: await shell.openExternal(p.secret.helpUrl) };
});

ipcMain.on('terminal:input', (event, req) => {
  const s = req && get(req.id);
  if (!s || typeof req.data !== 'string' || req.data.length > MAX_INPUT) return;
  // `binary`: xterm.js hands over some mouse reports as a string of raw bytes (one character per byte).
  s.session.write(req.binary === true ? Buffer.from(req.data, 'latin1') : req.data);
});

ipcMain.on('terminal:resize', (event, req) => {
  const s = req && get(req.id);
  if (!s) return;
  try {
    s.session.resize(toSize(req.rows, 'rows'), toSize(req.cols, 'cols'));
  } catch {
    /* a nonsense size from the window is ignored */
  }
});

ipcMain.on('terminal:ack', (event, req) => {
  const s = req && get(req.id);
  if (s && Number.isFinite(req.bytes) && req.bytes > 0) s.ack(req.bytes);
});

// ------------------------------------------------------------------------------------------------ app

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1000, height: 680, minWidth: 480, minHeight: 320, title: 'Terminal' });
  await win.loadFile('index.html');
});

// Hang every program up before the VM stops (the SDK waits for this for at most 2 s).
app.on('before-quit', () => {
  const live = [...sessions.values()].map((s) => s.session);
  if (!live.length) return undefined;
  for (const s of live) s.stop();
  return Promise.race([
    Promise.all(live.map((s) => new Promise((resolve) => (s.exited ? resolve() : s.once('exit', resolve))))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
});
