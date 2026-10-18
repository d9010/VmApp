'use strict';
/*
 * Particles: the core ("main process") of the vmapp graphics showcase. It runs inside the sandboxed VM.
 *
 * What lives HERE (in the VM): the scene, i.e. the attractor bodies and their physics (scene.js: deterministic, fixed time
 * step), the particle parameters, the presets and their persistence in /data, and a CPU benchmark (nbody.js). The core ticks the
 * scene on its own clock and streams a snapshot to the window at 30 Hz (`scene:state`, about 0.5 KB each).
 *
 * What lives in the WINDOW (on the host): everything that touches pixels. The UI interpolates the snapshots and draws up to
 * two million particles with WebGPU (or WebGL2) on the Mac's GPU, at the GPU's full speed. No pixel ever crosses the bridge.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('vmapp');
const { Scene, TICK_HZ, BUILTIN, sanitizeParams, sanitizeOrbit } = require('./scene');
const { nbody } = require('./nbody');

const MAX_USER_PRESETS = 32;
const MAX_NAME = 40;
const TICK_MS = 1000 / TICK_HZ;
const presetsFile = () => path.join(app.getPath('userData'), 'presets.json');
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------------- presets

/** user presets: [{name, orbit, params}] in the order they were first saved */
let userPresets = [];
let lastPreset = BUILTIN[0].name;

const isBuiltin = (name) => BUILTIN.some((p) => p.name === name);
const findPreset = (name) => BUILTIN.find((p) => p.name === name) || userPresets.find((p) => p.name === name) || null;

/** A valid preset name: 1 to 40 characters, no control characters. Throws a message the window can show. */
function checkName(name) {
  const n = String(name === undefined || name === null ? '' : name).trim();
  if (!n) throw new Error('Give the preset a name');
  if (n.length > MAX_NAME) throw new Error(`Preset names are at most ${MAX_NAME} characters`);
  if (/[\u0000-\u001f\u007f]/.test(n)) throw new Error('Preset names cannot contain control characters');
  return n;
}

function loadPresets() {
  try {
    const raw = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    if (raw && Array.isArray(raw.presets)) {
      const seen = new Set();
      for (const p of raw.presets) {
        let name;
        try {
          name = checkName(p && p.name);
        } catch {
          continue;
        }
        if (isBuiltin(name) || seen.has(name) || userPresets.length >= MAX_USER_PRESETS) continue;
        seen.add(name);
        userPresets.push({ name, orbit: sanitizeOrbit(p.orbit), params: sanitizeParams(p.params) });
      }
      if (typeof raw.last === 'string' && findPreset(raw.last)) lastPreset = raw.last;
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error(`could not read presets.json (starting with the built-in presets): ${e.message}`);
  }
}

/** Atomic: write a temporary file, then rename it over the real one. */
function savePresets() {
  const file = presetsFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, last: lastPreset, presets: userPresets }, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------- the live scene

let current = { name: BUILTIN[0].name, orbit: clone(BUILTIN[0].orbit), params: clone(BUILTIN[0].params) };
let scene = null;
let epoch = 0; // bumps whenever the attractors jump (load, reset, reseed): the window must not interpolate across it
let paused = false;
let seq = 0;
let streamHz = 30;
let pointer = { x: 0, y: 0, z: 0, mode: 0 };
const t0 = performance.now();

function applyPreset(p) {
  current = { name: p.name, orbit: clone(p.orbit), params: clone(p.params) };
  current.params = sanitizeParams(current.params);
  current.orbit = sanitizeOrbit(current.orbit);
  scene = new Scene(current.orbit);
  epoch++;
}

function sceneInfo() {
  return {
    name: current.name,
    builtin: isBuiltin(current.name),
    orbit: current.orbit,
    params: current.params,
    hz: streamHz,
    paused,
    epoch,
    tick: scene.tick,
    hash: scene.hash(),
    tickHz: TICK_HZ,
  };
}

function snapshot() {
  const attractors = scene.attractors().map((a) => a.map(round5));
  const strength = pointer.mode * current.params.pointer;
  return {
    seq: ++seq,
    t: round5(performance.now() - t0), // the core's clock in ms: the window uses it to schedule interpolation
    epoch,
    tick: scene.tick,
    hash: scene.hash(),
    paused,
    name: current.name,
    hz: streamHz,
    a: attractors,
    ptr: strength === 0 ? null : [round5(pointer.x), round5(pointer.y), round5(pointer.z), round5(strength)],
    params: current.params,
  };
}

// ---------------------------------------------------------------------------------------------------- the stream

let timer = null;
let lastWall = performance.now();
let nextDue = lastWall;
let accMs = 0;

function pump() {
  timer = null;
  const now = performance.now();
  const wall = Math.min(now - lastWall, 250); // after a stall, don't race to catch up
  lastWall = now;
  if (!paused) {
    accMs += wall;
    const ticks = Math.floor(accMs / TICK_MS);
    if (ticks > 0) {
      accMs -= ticks * TICK_MS;
      scene.step(ticks);
    }
  }
  const wins = BrowserWindow.getAllWindows();
  if (wins.length) {
    const snap = snapshot();
    for (const w of wins) w.webContents.send('scene:state', snap);
  }
  nextDue += 1000 / streamHz;
  if (nextDue < now - 1000 / streamHz) nextDue = now; // far behind: re-anchor instead of bursting
  timer = setTimeout(pump, Math.max(0, nextDue - performance.now()));
}

function startStream() {
  if (timer) return;
  lastWall = performance.now();
  nextDue = lastWall;
  pump();
}

// ---------------------------------------------------------------------------------------------------- IPC

const clampHz = (v) => Math.min(60, Math.max(5, Math.round(Number(v) || 30)));

ipcMain.handle('core:info', () => ({
  platform: process.platform, // 'linux': this code runs in the VM
  arch: process.arch,
  kernel: os.release(),
  node: process.version,
  vcpus: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  memoryMiB: Math.round(os.totalmem() / 1048576),
  uptimeS: Math.round(process.uptime() * 10) / 10,
  app: { name: app.getName(), version: app.getVersion() },
}));

ipcMain.handle('core:ping', () => round5(performance.now() - t0));

ipcMain.handle('scene:get', () => sceneInfo());

ipcMain.handle('scene:set', (_e, patch) => {
  current.params = sanitizeParams(patch, current.params);
  return sceneInfo();
});

ipcMain.handle('scene:pause', (_e, value) => {
  paused = value === undefined ? !paused : !!value;
  return sceneInfo();
});

ipcMain.handle('scene:reset', () => {
  scene = new Scene(current.orbit);
  accMs = 0;
  epoch++;
  return sceneInfo();
});

/** A new random orbit: the seed is chosen here and kept in the orbit configuration, so saving a preset keeps it. */
ipcMain.handle('scene:reseed', (_e, seed) => {
  const s = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 2147483647);
  current.orbit = sanitizeOrbit({ ...current.orbit, seed: s });
  scene = new Scene(current.orbit);
  accMs = 0;
  epoch++;
  return sceneInfo();
});

/** Replays the current orbit configuration from tick 0 on a fresh Scene: the same (config, ticks) always gives the same hash. */
ipcMain.handle('scene:replay', (_e, ticks) => {
  const n = Number.isInteger(ticks) ? Math.min(240000, Math.max(0, ticks)) : 0;
  const s = new Scene(current.orbit);
  s.step(n);
  return { tick: s.tick, hash: s.hash(), attractors: s.attractors().map((a) => a.map(round5)) };
});

ipcMain.handle('stream:set', (_e, hz) => {
  streamHz = clampHz(hz);
  return { hz: streamHz };
});

ipcMain.handle('preset:list', () => ({
  current: current.name,
  presets: [...BUILTIN.map((p) => ({ name: p.name, builtin: true })), ...userPresets.map((p) => ({ name: p.name, builtin: false }))],
}));

ipcMain.handle('preset:load', (_e, name) => {
  const p = findPreset(String(name));
  if (!p) throw new Error(`No preset named "${name}"`);
  applyPreset(p);
  accMs = 0;
  lastPreset = p.name;
  savePresets();
  return sceneInfo();
});

/** Saves the live parameters and orbit under `name` (a built-in name is refused; an existing user preset is replaced). */
ipcMain.handle('preset:save', (_e, name) => {
  const n = checkName(name);
  if (isBuiltin(n)) throw new Error(`"${n}" is a built-in preset: choose another name`);
  const entry = { name: n, orbit: clone(current.orbit), params: clone(current.params) };
  const i = userPresets.findIndex((p) => p.name === n);
  if (i >= 0) userPresets[i] = entry;
  else {
    if (userPresets.length >= MAX_USER_PRESETS) throw new Error(`At most ${MAX_USER_PRESETS} presets: delete one first`);
    userPresets.push(entry);
  }
  current.name = n;
  lastPreset = n;
  savePresets();
  return sceneInfo();
});

ipcMain.handle('preset:delete', (_e, name) => {
  const n = String(name);
  if (isBuiltin(n)) throw new Error('Built-in presets cannot be deleted');
  const i = userPresets.findIndex((p) => p.name === n);
  if (i < 0) throw new Error(`No preset named "${n}"`);
  userPresets.splice(i, 1);
  if (lastPreset === n) lastPreset = BUILTIN[0].name;
  savePresets();
  if (current.name === n) {
    applyPreset(findPreset(lastPreset));
    accMs = 0;
  }
  return sceneInfo();
});

// the mouse attractor: the window sends a world-space position, the core owns the strength and streams it back
ipcMain.on('scene:pointer', (_e, p) => {
  if (!p || typeof p !== 'object') return;
  const f = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(4, Math.max(-4, v)) : 0);
  pointer = { x: f(p.x), y: f(p.y), z: f(p.z), mode: p.mode === 1 || p.mode === -1 ? p.mode : 0 };
});

let benchRunning = false;
ipcMain.handle('bench:nbody', async (_e, options) => {
  if (benchRunning) throw new Error('A benchmark is already running');
  benchRunning = true;
  try {
    return await nbody(options);
  } finally {
    benchRunning = false;
  }
});

// ---------------------------------------------------------------------------------------------------- start

app.whenReady().then(() => {
  loadPresets();
  applyPreset(findPreset(lastPreset) || BUILTIN[0]);
  console.log(`particles core: ${process.platform}/${process.arch} node ${process.version}; preset "${current.name}"; ${userPresets.length} saved preset(s)`);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    title: 'Particles',
    // DevTools only on request (PARTICLES_DEBUG=1 in the core's environment); production windows have none
    webPreferences: { devTools: process.env.PARTICLES_DEBUG === '1' },
  });
  win.loadFile('index.html');
  startStream();
});

app.on('before-quit', () => {
  if (timer) clearTimeout(timer);
  timer = null;
});
