// Particles: checks the GPU half in a REAL app window of the VMApp Loader, driven over the Chrome DevTools Protocol.
//
//   node apps/gpu-demo/test/webgpu-cdp.mjs
//
// What it does (in order):
//   1. starts the loader from source (loader/, Electron 44) with its own fresh VMAPP_HOME, "Run project folder..." on apps/gpu-demo
//      (a developer build: the same pack and install as `vmapp pack`), launches it and waits for the app window;
//   2. in that window (sandboxed renderer, strict CSP, no network) checks that navigator.gpu exists, that an adapter and a device
//      were obtained, and prints the GPUAdapterInfo (vendor, architecture, ...). The pass condition is that the app reports
//      "webgpu" as its active API; if it falls back to WebGL2 the script says why and fails (REQUIRE_WEBGPU=0 downgrades it);
//   3. checks that the scene stream from the core (in the VM) reaches the window and is interpolated (about 30 snapshots/s);
//   4. measures the frame rate with its own requestAnimationFrame counter over FPS_SECONDS (default 5) at each count in COUNTS
//      (default 1000000,2000000), and the uncapped GPU throughput (the app's own benchmark, no vsync);
//   5. takes a screenshot with Page.captureScreenshot at 1M particles ($VMAPP_WORK/shots/particles.png);
//   6. forces the WebGL2 fallback from the page, measures it and takes a second screenshot (particles-webgl2.png), then goes back to Auto;
//   7. runs the CPU benchmark in the VM through the bridge; checks the sandbox is intact (no Node, CSP blocks fetch);
//   8. stops the loader (only the one it started) and checks that its VM is gone. Writes $VMAPP_WORK/particles-cdp/report.json.
//
// Needs: vmapp/out (vmapp-vm, Image, initramfs.cpio, runtimes/node22.img) and loader/node_modules (Electron). It opens real windows
// on the desktop for about a minute (and brings them to the front: a covered window would not render). Environment:
//   VMAPP_WORK  absolute scratch folder (default vmapp/out/work); everything lives under $VMAPP_WORK/particles-cdp, shots in $VMAPP_WORK/shots
//   CDP_PORT    remote-debugging port of the loader (default 9301)
//   COUNTS      comma separated particle counts to measure (default 1000000,2000000); the first 1000000 is also the screenshot
//   FPS_SECONDS seconds per frame-rate measurement (default 5)
//   REQUIRE_WEBGPU=0  do not fail when only WebGL2 is available
//   PRESET_SHOTS=1    also take one screenshot per built-in preset (panels hidden) into $VMAPP_WORK/shots/preset-<name>.png

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const VMAPP = path.resolve(APP_DIR, '..', '..');
const LOADER = path.join(VMAPP, 'loader');
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(VMAPP, 'out', 'work'));
const ROOT = path.join(WORK, 'particles-cdp');
const SHOTS = path.join(WORK, 'shots');
const HOME = path.join(ROOT, 'home');
const PORT = Number(process.env.CDP_PORT) || 9301;
const COUNTS = (process.env.COUNTS || '1000000,2000000').split(',').map(Number).filter(Number.isFinite);
const FPS_SECONDS = Number(process.env.FPS_SECONDS) || 5;
const REQUIRE_WEBGPU = process.env.REQUIRE_WEBGPU !== '0';
const ID = 'dev.vmapp.particles';
const FAKE_HOSTCTL = path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-hostctl.js');
const electronBin = require(path.join(LOADER, 'node_modules', 'electron'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);
const report = { when: new Date().toISOString(), counts: {}, checks: [] };
const check = (message) => {
  report.checks.push(message);
  console.log(`  ok: ${message}`);
};

async function waitFor(fn, { timeout = 20000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------------------------------------ CDP
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
        else p.resolve(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluates an expression in the page (awaiting promises) and returns its value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value : r.exceptionDetails.text}`);
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    step(`screenshot ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KiB)`);
    return file;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
async function connectTo(match, what, timeout = 30000) {
  const t = await waitFor(async () => (await targets()).find((x) => match(x.url)), { timeout, what });
  return Cdp.connect(t.webSocketDebuggerUrl);
}

// ------------------------------------------------------------------------------------------------ page-side measurements
/** Counts requestAnimationFrame callbacks for `seconds` in the page itself, independent of the app's own counter. */
const rafProbe = (seconds) => `new Promise((resolve) => {
  const start = performance.now();
  let last = start;
  const gaps = [];
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    if (now - start >= ${seconds * 1000}) {
      const s = gaps.slice(1).sort((a, b) => a - b);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      resolve({ frames: s.length, ms: now - start, fps: (s.length * 1000) / (now - start), p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: s[s.length - 1],
                visibility: document.visibilityState, focused: document.hasFocus() });
    } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

const state = (c) => c.eval('window.__particles.state');

async function measure(c, count, seconds, label) {
  await c.eval(`window.__particles.setCount(${count})`);
  await sleep(2500); // let the pipeline, the driver's shader cache and the display settle
  const before = await state(c);
  const probe = await c.eval(rafProbe(seconds));
  const after = await state(c);
  assert.equal(after.count, count);
  const r = { api: after.api, count, seconds, fps: probe.fps, frames: probe.frames, p50ms: probe.p50, p95ms: probe.p95, p99ms: probe.p99, worstMs: probe.worst, visibility: probe.visibility, focused: probe.focused, appFps: after.fps, gpuMs: after.gpuMs, errors: after.errors };
  step(`${label}: ${count.toLocaleString('en-US')} particles on ${after.api}: ${probe.fps.toFixed(1)} fps (p50 ${probe.p50.toFixed(1)} ms, p95 ${probe.p95.toFixed(1)} ms, worst ${probe.worst.toFixed(0)} ms); page ${probe.visibility}${after.gpuMs ? `; GPU ${(after.gpuMs.compute + after.gpuMs.render).toFixed(2)} ms/frame (sim ${after.gpuMs.compute.toFixed(2)} + draw ${after.gpuMs.render.toFixed(2)})` : ''}`);
  assert.equal(probe.visibility, 'visible', 'the window must be visible, otherwise Chromium does not render it');
  assert.ok(probe.frames > 5, 'the window rendered frames');
  assert.ok(after.frames > before.frames, 'the app rendered frames');
  return r;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  assert.equal(path.basename(ROOT), 'particles-cdp');
  assert.ok(ROOT.startsWith(WORK + path.sep), 'the scratch folder is inside VMAPP_WORK');
  for (const f of ['vmapp-vm', 'Image', 'initramfs.cpio']) assert.ok(fs.existsSync(path.join(VMAPP, 'out', f)), `vmapp/out/${f} is missing (run tools/build.sh)`);
  assert.ok(fs.existsSync(path.join(VMAPP, 'out', 'runtimes', 'node22.img')), 'vmapp/out/runtimes/node22.img is missing');
  assert.ok(fs.existsSync(FAKE_HOSTCTL), 'the fake host helper of the loader tests exists');
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  step(`starting the loader from source (CDP port ${PORT}, VMAPP_HOME ${HOME})`);
  const env = {
    ...process.env,
    VMAPP_HOME: HOME,
    // a dev/test loader: no real desktop control (the fake helper), and "Run project folder..." is answered with this app's folder
    VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_HOSTCTL]),
    VMAPP_HOSTCTL_DRYRUN: '1',
    VMAPP_TEST_DIALOGS: JSON.stringify({ open: [APP_DIR], message: 0 }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(ROOT, 'loader.log'), 'w');
  // The two --disable-* switches keep Chromium from throttling a window that another window covers (a covered window would not render
  // at all, and the frame-rate measurement would be meaningless). They are for this dev-mode test; a packaged loader refuses debugging switches.
  const loader = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { cwd: LOADER, env, stdio: ['ignore', log, log] });
  loader.exited = new Promise((r) => loader.once('exit', (code, sig) => r({ code, sig })));
  const conns = [];
  try {
    const lib = await connectTo((u) => u.startsWith('vmapp-loader://ui/library.html'), 'the loader library window');
    conns.push(lib);
    await waitFor(() => lib.eval(`!!document.querySelector('[data-action="run-folder"]')`), { what: 'the Run project folder button' });
    step('Run project folder...: the loader packs apps/gpu-demo and installs it as a developer build');
    await lib.eval(`document.querySelector('[data-action="run-folder"]').click()`);
    // a permission sheet appears only if the app asks for something; Particles asks for nothing, so the launch should go straight through
    const sheet = await waitFor(
      async () => {
        if (await lib.eval(`!!document.querySelector('[data-action="sheet-launch"]')`)) return 'sheet';
        if ((await targets()).some((t) => t.url.startsWith(`vmapp-ui://${ID}/`))) return 'window';
        return false;
      },
      { timeout: 90000, what: 'the app window (or its permission sheet)' },
    );
    if (sheet === 'sheet') {
      step('the permission sheet appeared; launching');
      await lib.eval(`document.querySelector('[data-action="sheet-launch"]').click()`);
    }
    const win = await connectTo((u) => u.startsWith(`vmapp-ui://${ID}/`), 'the Particles window', 90000);
    conns.push(win);
    step('the app window is open (UI served from vmapp-ui://, core running in the VM)');
    // everything the page logs at warning level or above, uncaught exceptions and CSP violations, from here on
    const problems = [];
    win.on((m) => {
      if (m.method === 'Log.entryAdded' && ['warning', 'error'].includes(m.params.entry.level)) problems.push(`${m.params.entry.source}/${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
      else if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.text} ${(m.params.exceptionDetails.exception || {}).description || ''}`);
      else if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error', 'assert'].includes(m.params.type)) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value || a.description).join(' ')}`);
    });
    await win.send('Log.enable');
    await win.send('Runtime.enable');
    await win.send('Page.bringToFront');
    await win.send('Page.enable');

    // ---- the sandbox is intact -------------------------------------------------------------------------------
    assert.equal(await win.eval('typeof window.require + typeof window.process + typeof window.Buffer'), 'undefinedundefinedundefined');
    assert.match(await win.eval(`fetch('https://example.com/').then(() => 'fetched', (e) => 'rejected: ' + e.message)`), /^rejected/);
    assert.deepEqual(await win.eval('Object.keys(window.vmapp).sort()'), ['app', 'invoke', 'ipcRenderer', 'on', 'send']);
    check('the window is sandboxed as always: no Node, fetch to the internet rejected by the CSP, window.vmapp is the loader\'s bridge');
    problems.length = 0; // the console error of that deliberate fetch is expected; what follows is the app's own behaviour

    // ---- WebGPU in the sandboxed window -----------------------------------------------------------------------
    await waitFor(() => win.eval('!!(window.__particles && window.__particles.state.api) || !!(window.__particles && window.__particles.state.failed)'), { timeout: 60000, what: 'the renderer to start' });
    const hasGpu = await win.eval(`'gpu' in navigator && !!navigator.gpu`);
    const s0 = await state(win);
    report.navigatorGpu = hasGpu;
    report.api = s0.api;
    report.adapter = s0.adapter;
    report.fallbackReason = s0.reason || null;
    step(`navigator.gpu present: ${hasGpu}; active API: ${s0.api}${s0.reason ? ` (reason: ${s0.reason})` : ''}`);
    if (s0.adapter) step(`adapter: ${JSON.stringify({ vendor: s0.adapter.vendor, architecture: s0.adapter.architecture, device: s0.adapter.device, description: s0.adapter.description, isFallback: s0.adapter.isFallback, features: (s0.adapter.features || []).length })}`);
    if (REQUIRE_WEBGPU) {
      assert.ok(hasGpu, `navigator.gpu is missing in the app window. See ${path.join(ROOT, 'loader.log')}; the loader would need the GPU process / WebGPU enabled for app windows`);
      assert.equal(s0.api, 'webgpu', `WebGPU was not used: ${s0.reason}`);
      assert.ok(s0.adapter && s0.adapter.limits.maxStorageBufferBindingSize >= 64e6, 'the adapter allows the 64 MB particle buffer');
      check(`navigator.gpu exists in the sandboxed window; adapter "${s0.adapter.vendor} ${s0.adapter.architecture}" (${s0.adapter.description || s0.adapter.device || 'no description'}); the app runs on WebGPU`);
    }
    assert.deepEqual(s0.errors.filter((e) => !/WebGPU is not used/.test(e)), [], 'no errors logged by the app');

    // ---- the stream from the core reaches the GPU page --------------------------------------------------------
    await waitFor(async () => (await state(win)).snapshots > 30, { what: 'scene snapshots from the core', timeout: 30000 });
    const a = await state(win);
    await sleep(2000);
    const b = await state(win);
    const rate = (b.snapshots - a.snapshots) / 2;
    report.stream = { snapshotsPerSecond: rate, interpolatedFrames: b.interpolatedFrames, rttMs: b.rttMs, core: b.coreInfo, lastTick: b.last && b.last.tick, lastHash: b.last && b.last.hash };
    step(`scene stream: ${rate.toFixed(1)} snapshots/s from the core; round trip ${b.rttMs === null ? 'n/a' : b.rttMs.toFixed(2) + ' ms'}; core: ${JSON.stringify(b.coreInfo)}`);
    assert.ok(rate > 22 && rate < 40, `about 30 snapshots per second, got ${rate}`);
    assert.ok(b.interpolatedFrames > 0, 'the render loop interpolates between snapshots');
    assert.equal(b.coreInfo.platform, 'linux', 'the core runs in the Linux VM');
    assert.ok(b.last.tick > a.last.tick && b.last.hash !== a.last.hash, 'the simulation in the VM advances');
    // a parameter changed through the bridge comes back in the stream and reaches the shader's uniforms
    await win.eval(`window.vmapp.invoke('scene:set', { hue: 0.123 })`);
    await waitFor(async () => (await state(win)).last.params.hue === 0.123, { what: 'the changed parameter in the stream' });
    await win.eval(`window.vmapp.invoke('scene:set', { hue: 0.58 })`);
    check(`the core in the VM streams the scene at ${rate.toFixed(1)} Hz (interpolated in the window); a parameter change round-trips through the VM`);

    // ---- the mouse attractor: input in the window -> core in the VM -> stream -> shader -----------------------
    const { w, h } = await win.eval('({ w: innerWidth, h: innerHeight })');
    const mouse = (type, modifiers = 0) => win.send('Input.dispatchMouseEvent', { type, x: w / 2, y: h / 2, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers });
    await mouse('mouseMoved');
    await mouse('mousePressed');
    const pulled = await waitFor(async () => {
      const s = await state(win);
      return s.last && s.last.ptr && s.last;
    }, { what: 'the mouse attractor in the stream', timeout: 10000 });
    assert.ok(pulled.ptr[3] > 0, 'a plain press attracts');
    assert.ok(pulled.ptr.slice(0, 3).every((v) => Math.abs(v) < 0.1), `a press at the window's centre maps to the scene's origin, got ${pulled.ptr}`);
    await mouse('mouseReleased');
    await waitFor(async () => (await state(win)).last.ptr === null, { what: 'the mouse attractor to switch off', timeout: 10000 });
    await mouse('mousePressed', 8); // Shift
    const pushed = await waitFor(async () => {
      const s = await state(win);
      return s.last && s.last.ptr && s.last;
    }, { what: 'the repelling mouse attractor', timeout: 10000 });
    assert.ok(pushed.ptr[3] < 0, 'Shift-press repels');
    await mouse('mouseReleased');
    await waitFor(async () => (await state(win)).last.ptr === null, { what: 'the mouse attractor to switch off again', timeout: 10000 });
    check('mouse input in the window reaches the core in the VM and comes back as an attractor (press attracts, Shift-press repels, release switches it off)');

    // ---- the controls (DOM events on the real UI; the core in the VM answers every one) -----------------------
    const quoted = (s) => JSON.stringify(s);
    const click = (sel) => win.eval(`document.querySelector(${quoted(sel)}).click()`);
    const setValue = (sel, v) => win.eval(`(() => { const e = document.querySelector(${quoted(sel)}); e.value = ${quoted(String(v))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const text = (sel) => win.eval(`document.querySelector(${quoted(sel)}).textContent`);
    const lastOf = async () => (await state(win)).last;
    await setValue('#preset', 'Galaxy');
    await waitFor(async () => (await lastOf()).name === 'Galaxy', { what: 'the Galaxy preset from the core' });
    await waitFor(async () => (await win.eval(`document.getElementById('p-hue').value`)) === '0.08', { what: 'the sliders to follow the preset' });
    await setValue('#p-G', 2);
    await waitFor(async () => (await lastOf()).params.G === 2, { what: 'the gravity slider to reach the core and come back' });
    await waitFor(() => win.eval(`document.getElementById('modified').hidden === false`), { what: 'the "modified" mark after a slider change' });
    await setValue('#preset-name', 'UI Test');
    await click('#preset-save');
    await waitFor(async () => /Saved "UI Test"/.test(await text('#preset-msg')), { what: 'the save confirmation' });
    assert.equal(await win.eval(`document.getElementById('preset').value`), 'UI Test');
    assert.deepEqual(await win.eval(`[...document.querySelectorAll('#preset optgroup')].map((g) => g.label + ':' + [...g.children].map((o) => o.value).join('|'))`), ['Built-in:Orbit|Galaxy|Swarm|Fountain|Nebula', 'Saved:UI Test']);
    await waitFor(() => win.eval(`document.getElementById('modified').hidden === true`), { what: 'the "modified" mark to clear after Save' });
    await click('#pause');
    await waitFor(async () => (await lastOf()).paused === true, { what: 'the core to pause' });
    await waitFor(async () => (await text('#pause')) === 'Resume', { what: 'the Pause button to say Resume' });
    await click('#pause');
    await waitFor(async () => (await lastOf()).paused === false, { what: 'the core to resume' });
    await setValue('#hz', 10);
    await sleep(3000);
    const slow = (await state(win)).streamHz;
    assert.ok(slow > 6 && slow < 14, `the stream slows to 10 Hz, got ${slow.toFixed(1)}`);
    await setValue('#hz', 30);
    await sleep(3000);
    assert.ok((await state(win)).streamHz > 25, 'and back to 30 Hz');
    const epoch0 = (await lastOf()).epoch;
    await click('#reseed');
    await waitFor(async () => (await lastOf()).epoch > epoch0, { what: 'a new orbit (epoch bump)' });
    await click('#reset');
    await waitFor(async () => (await lastOf()).tick < 100, { what: 'a restart (tick back near 0)' });
    await click('[data-count="500000"]');
    assert.equal((await state(win)).count, 500000);
    await click('[data-count="1000000"]');
    await click('#preset-delete'); // the first click only arms it
    assert.equal(await text('#preset-delete'), 'Sure?');
    await click('#preset-delete');
    await waitFor(async () => (await lastOf()).name === 'Orbit', { what: 'the deleted preset to fall back to Orbit' });
    assert.equal(await win.eval(`document.querySelectorAll('#preset optgroup').length`), 1, 'no saved presets are left in the menu');
    assert.deepEqual(await win.eval(`window.vmapp.invoke('preset:list').then((l) => l.presets.filter((p) => !p.builtin))`), []);
    await setValue('#preset', 'Orbit');
    await waitFor(async () => (await lastOf()).name === 'Orbit', { what: 'the Orbit preset' });
    check('the controls work against the core in the VM: preset menu, sliders (marked modified), Save as, Pause/Resume, stream rate 10/30 Hz, New orbit, Restart, particle count buttons, Delete');

    // ---- frame rate -------------------------------------------------------------------------------------------
    report.fps = [];
    let shot = null;
    for (const count of COUNTS) {
      const r = await measure(win, count, FPS_SECONDS, 'rAF over ' + FPS_SECONDS + ' s');
      const bench = await win.eval('window.__particles.gpuBench()');
      r.uncapped = bench;
      if (bench) step(`uncapped GPU benchmark at ${count.toLocaleString('en-US')}: ${bench.fps.toFixed(0)} fps without vsync (${bench.mUpdatesPerSec.toFixed(0)} M particle updates/s, ${bench.ms.toFixed(0)} ms for ${bench.frames} frames)`);
      report.fps.push(r);
      if (!shot && count === 1000000) {
        await sleep(500);
        shot = await win.shot(path.join(SHOTS, 'particles.png'));
        report.screenshot = shot;
      }
      assert.ok(r.fps > 10, `at least 10 fps at ${count} particles (got ${r.fps.toFixed(1)})`);
    }
    if (!shot) report.screenshot = await win.shot(path.join(SHOTS, 'particles.png'));
    check(`frame rate measured with requestAnimationFrame over ${FPS_SECONDS} s: ${report.fps.map((r) => `${r.count.toLocaleString('en-US')} particles = ${r.fps.toFixed(1)} fps`).join('; ')}`);

    // ---- optional: one screenshot per built-in preset (PRESET_SHOTS=1), panels hidden -------------------------
    if (process.env.PRESET_SHOTS === '1') {
      await win.eval(`document.body.classList.add('hide-panels')`);
      for (const name of ['Orbit', 'Galaxy', 'Swarm', 'Fountain', 'Nebula']) {
        await win.eval(`window.vmapp.invoke('preset:load', ${JSON.stringify(name)})`);
        await sleep(5000);
        await win.shot(path.join(SHOTS, `preset-${name.toLowerCase()}.png`));
      }
      await win.eval(`window.vmapp.invoke('preset:load', 'Orbit')`);
      await win.eval(`document.body.classList.remove('hide-panels')`);
    }

    // ---- the WebGL2 fallback ---------------------------------------------------------------------------------
    step('forcing the WebGL2 fallback from the page');
    await win.eval(`window.__particles.setApi('webgl2')`);
    const g = await waitFor(async () => {
      const s = await state(win);
      return s.api === 'webgl2' && s.frames > 0 && s;
    }, { what: 'the WebGL2 renderer', timeout: 30000 });
    assert.match(String(g.adapter.renderer), /\S/);
    const glBadge = await win.eval(`document.getElementById('api-badge').textContent`);
    assert.match(glBadge, /WebGL2/);
    const gl = await measure(win, 1000000, Math.min(FPS_SECONDS, 4), 'WebGL2 fallback');
    const glBench = await win.eval('window.__particles.gpuBench()');
    gl.uncapped = glBench;
    report.webgl2 = { adapter: g.adapter, ...gl };
    await win.shot(path.join(SHOTS, 'particles-webgl2.png'));
    assert.deepEqual((await state(win)).errors.filter((e) => !/WebGPU is not used|WebGL2 was selected/.test(e)), []);
    check(`WebGL2 fallback works: renderer "${g.adapter.renderer}", ${gl.fps.toFixed(1)} fps at 1M particles${glBench ? `, ${glBench.fps.toFixed(0)} fps uncapped` : ''}`);
    await win.eval(`window.__particles.setApi('auto')`);
    const back = await waitFor(async () => {
      const s = await state(win);
      return s.api && s.frames > 0 && s;
    }, { what: 'the renderer to restart on Auto', timeout: 30000 });
    if (REQUIRE_WEBGPU) assert.equal(back.api, 'webgpu', 'Auto goes back to WebGPU');
    check(`the API selector works: Auto returns to ${back.api}`);

    assert.deepEqual(problems, [], 'the page logged no warning, error, exception or CSP violation while running on WebGPU and WebGL2');
    check('no console warning or error, no uncaught exception and no CSP violation in the window (WebGPU and WebGL2 runs)');

    // ---- WebGPU missing altogether: the automatic fallback -------------------------------------------------------
    step('hiding navigator.gpu (before the page runs) and reloading: the app must fall back to WebGL2 on its own and say why');
    const hide = await win.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.gpu;' });
    await win.send('Page.reload');
    const fb = await waitFor(async () => {
      const s = await state(win).catch(() => null);
      return s && s.api && s.frames > 0 && s;
    }, { what: 'the app to restart without navigator.gpu', timeout: 30000 });
    assert.equal(await win.eval(`'gpu' in navigator`), false, 'navigator.gpu is gone in this page');
    assert.equal(fb.api, 'webgl2');
    assert.match(fb.reason, /navigator\.gpu is not available/);
    assert.match(await win.eval(`document.getElementById('api-badge').textContent`), /WebGL2 fallback/);
    assert.match(await win.eval(`document.getElementById('fallback-reason').textContent`), /navigator\.gpu is not available/);
    assert.equal(await win.eval(`document.getElementById('fallback-reason').hidden`), false);
    await sleep(1500);
    assert.ok((await state(win)).snapshots > 5, 'the scene stream still arrives after the reload');
    check(`without navigator.gpu the app starts on WebGL2 by itself and shows why ("${fb.reason}")`);
    await win.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hide.identifier });
    await win.send('Page.reload');
    const again = await waitFor(async () => {
      const s = await state(win).catch(() => null);
      return s && s.api && s.frames > 0 && s;
    }, { what: 'the app to restart with navigator.gpu again', timeout: 30000 });
    if (REQUIRE_WEBGPU) assert.equal(again.api, 'webgpu');
    const unexpected = problems.filter((p) => !/WebGPU is not used: navigator\.gpu is not available/.test(p));
    assert.deepEqual(unexpected, [], 'only the expected "WebGPU is not used" warning was logged during the fallback test');

    // ---- the CPU half runs in the VM ---------------------------------------------------------------------------
    const cpu = await win.eval(`window.__particles.cpuBench()`);
    report.cpuBench = cpu;
    step(`CPU benchmark in the VM: ${cpu.bodies} bodies x ${cpu.steps} steps = ${cpu.minteractionsPerSec.toFixed(0)} M interactions/s (${cpu.gflops.toFixed(1)} GFLOP/s)`);
    assert.ok(cpu.minteractionsPerSec > 1);
    check('the CPU benchmark ran in the VM through the bridge');

    fs.writeFileSync(path.join(ROOT, 'report.json'), JSON.stringify(report, null, 2));
    step(`report: ${path.join(ROOT, 'report.json')}`);
  } finally {
    for (const c of conns) c.close();
    // stop only the loader this script started: it stops its own VM
    if (loader.exitCode === null && !loader.signalCode) loader.kill('SIGTERM');
    const r = await Promise.race([loader.exited, sleep(25000).then(() => ({ code: 'timeout' }))]);
    if (r.code === 'timeout') loader.kill('SIGKILL');
  }
  const left = spawnSync('ps', ['-axo', 'command=']).stdout.toString().split('\n').filter((l) => l.includes('/vmapp-vm') && l.includes(`--appdata ${path.join(HOME, 'data')}`));
  assert.equal(left.length, 0, 'the VM of this test is gone');
  check('the loader stopped and took its VM with it');
  step('ALL PASSED');
}

main().catch((e) => {
  console.error(`\nFAILED: ${e && e.stack ? e.stack : e}`);
  try {
    fs.writeFileSync(path.join(ROOT, 'report.json'), JSON.stringify({ ...report, failed: String(e && e.message ? e.message : e) }, null, 2));
  } catch {
    /* no scratch folder yet */
  }
  process.exit(1);
});
