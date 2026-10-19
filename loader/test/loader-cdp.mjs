// End-to-end test of the VMApp Loader with REAL VMs, driven over the Chrome DevTools Protocol.
//
//   node test/loader-cdp.mjs          (from vmapp/loader; or: npm test)
//
// Needs: vmapp/out (vmapp-vm, Image, initramfs.cpio, runtimes/node22.img), the Electron 44.4.5 in node_modules.
// Works under $VMAPP_WORK/loader-test/ (default vmapp/out/work/loader-test/; fresh VMAPP_HOME each run, screenshots in shots/).
// Run A (no VMAPP_TEST_GRANTS): install via the library UI, permission sheet, launch, renderer/CSP/bridge/dialog
//   assertions, inspector, stop, reset, app-initiated quit.
// Run B (VMAPP_TEST_GRANTS, no sheet): launch, then `kill -9` the loader and check the VM is gone.
// Run C: versions and updates against the real registry. Run D: Run project folder…, Rebuild & run and Publish….
// Run E: host capabilities (SPEC 8.2): the Host Capabilities window, the permission sheet's "Control of your computer"
//   section, the confirmation modal, the control badge, panic, the Inspector's Host rows, the install review label and the
//   update "asks for more" sheet. NEVER touches the real desktop: the loader's helper is tests/unit/fixtures/fake-hostctl.js
//   (VMAPP_HOSTCTL, dev only), input is dry-run (VMAPP_HOSTCTL_DRYRUN=1), and every confirmation is answered through
//   VMAPP_TEST_DIALOGS. All runs use the fake helper, so no run registers the real panic shortcut either.
// Run F: DevTools per window (SPEC 6 / 7, INV-B1): the app's core decides (SDK webPreferences.devTools, default false). A window
//   created with false never gets DevTools (isDevToolsOpened stays false after a direct openDevTools); one created with true can
//   open them from the View menu path; the loader's own windows never keep them (the dev-only VMAPP_TEST_DEVTOOLS_LOG probe).
// Run G: the user picks what a screenshot contains, and the virtual-input overlay (SPEC 8.2, INV-H3). The loader-owned picker
//   (a modal sheet on the app's window) lists the displays (with thumbnails the loader captured), the windows and "Select a
//   region…"; choosing display 2 gives the app display 2 whatever it suggested; a region comes through the dev hook
//   (VMAPP_TEST_DIALOGS.region); Deny and Esc give "permission denied"; "Allow while the app runs" remembers the permission
//   but not the target. While an input session is active one overlay window per display is click-through, not focusable,
//   always on top and content-protected; it follows the mouse and shows the keys; it goes away on Stop and on panic. Typed text is
//   MASKED by default ("typing… (50 characters)"; ⌘S and Return are still shown); the Host Capabilities window's "Show typed text
//   in the overlay" switch (off by default, saved in loader-prefs.json) shows the first 28 characters and masks again at once when
//   turned off. Every capture asks the helper to exclude the loader's own windows. Fake helper only (two displays, three
//   windows), dry-run input.
// Run H: the microphone (SPEC 2.2 permissions.devices, SPEC 7, INV-B3) and the live monitor. An app without a grant cannot open
//   the microphone, video and screen sharing stay rejected, a hand-written grant does not help an app that did not ask; with the
//   user's grant the audio track is live, the "Using the microphone now" chip and the monitor pill show it, and revoking applies
//   at once. The menu-bar popover (opened pinned with --monitor) lists the running apps with pills for folders, screen, input,
//   tools, MCP and the microphone, pulses on use, and Stop / Inspect / "Show app data in Finder" work. Chromium's FAKE microphone
//   (--use-fake-device-for-media-stream, dev only): no real audio is ever opened. (--use-fake-ui-for-media-stream is NOT used: it
//   makes Chromium accept every request itself and so skips the permission handler under test.)
// Run I: the network permission UI (SPEC 8.3) and the VM's size (SPEC 2.2, 8) with a REAL VM (fixture-net). The install review
//   lists the hosts (wildcards and port 80 marked) and the loader's own "could read the folder and send it out" banner; the
//   permission sheet has a Network section (every host on Don't allow, ports can be narrowed), a live risk banner ("can" once a
//   readable folder AND a host are allowed) and a Resources section; the card has a Resources row (vCPUs stepper, memory menu,
//   "Use recommended", a warning below the recommendation; saved at once, locked while the app runs; never above the Mac's cores
//   or half of its memory), an amber chip, the monitor pill and the warning; "Network…" changes a grant of the RUNNING app at
//   once (syncNetwork); the Inspector lists every connection as a `net` row (host, port, allowed or denied, bytes up and down,
//   duration, reason) with a Network filter; an update that asks for more ports or a new host stops at the "asks for more" sheet
//   and the earlier grant does not widen. The VM really has the size the user chose. No internet is needed (a refused host never
//   gets a lookup; a granted example.com host fails or does not resolve, which is still a row).
// Run J: the GPU capability's UI (SPEC 8.6) with a REAL VM (fixture-gpu) and a STAND-IN for the sandboxed rpc-server
//   (test/fake-gpu-server/fake-rpc-server.js, started through the dev-only VMAPP_GPU_SERVER / VMAPP_GPU_PROFILE overrides that a
//   packaged loader ignores; the real Metal server is never started here). The install review and the permission sheet list the GPU
//   (Don't allow / Allow while the app runs, no "Ask every time"); without the grant the app has no $VMAPP_GPU_RPC and no server starts;
//   a server that cannot start is a `failed` Inspector row and the app runs without a GPU; with the grant the card has the amber
//   "Can use your GPU" chip (not the red "Can control your computer"), the monitor and Activity pills show "GPU", bytes flow through
//   127.0.0.1:50052 to the stand-in and the Inspector lists the server and each tunnel as `gpu` rows (up and down bytes), with a GPU
//   filter; "GPU…" taking it away while the app runs stops the server and closes the tunnels at once; allowing it again for a running
//   app starts at the next launch; stopping the app stops the server.
// Run K: "Load examples" (no VM is started; nothing is launched or allowed) and long text. Fixture apps are packed into a folder named by the
//   dev-only VMAPP_EXAMPLES_DIR. An empty library offers "Load examples" (primary) and "Install from file…"; with no examples a dev loader
//   says to run tools/pack-examples; the sheet lists each package as it describes itself (name, description, version, size, badges for
//   network hosts, GPU, control of the computer, microphone, and the README's "What to allow" or one derived from the manifest); Install
//   selected verifies and installs one by one through the normal install path, a tampered package fails with the verification message
//   while the others install, an installed version is skipped with a note, a newer one updates, an older one is skipped, and no grants
//   file exists afterwards; File → Load examples… and File → Install from file… work (the dev-only VMAPP_TEST_MENU_DIR hook clicks the menu).
//   The same run installs an app full of long unbroken text (a 400-character folder, ids, hosts, versions) and checks that nothing runs
//   out of its box in the cards, every sheet, the Host Capabilities window, the monitor popover and the Inspector's detail pane (ui/wrap.css);
//   with wrap.css switched off the same check finds the overflow (screenshots 2x-wrap-*-before / -after).
// Run L: "Browse registry…" against a REAL local registry started by this run (registry/lib/registry.js on port 0, 25 real packages, one
//   publisher with a verified email, one app already installed, one with markup and one with 480 unbroken characters in its text). No VM
//   is started; nothing is launched. The loader asks the registry NOTHING until the sheet is opened (the registry's own request log
//   proves it), then exactly one list request per user action (open, Search, sort, Show more; the reopened sheet shows what it had,
//   with none). The cards show the publisher label as the registry presents it, the version, size, downloads and the registry's
//   permission summary; markup in a name or description stays text (no element, nothing runs); long text stays inside its box (with
//   wrap.css off the same check finds the overflow); an installed app says so and has no Install button. Install goes through the
//   verified path: download, then the ordinary install review (nothing installed, no grant, until its Install is pressed; Cancel
//   leaves nothing behind), and then the card says Installed. A dead registry and a bad address give plain errors. The library page
//   itself cannot reach the network (fetch is blocked by the CSP) and has no Node. File → Browse registry… opens the sheet.
// Run W: the window network (SPEC 8.3 "The app's windows") with a REAL VM and the real internet (fixture-winnet): without a grant the
//   page's https fetch reaches only the app's window endpoint, which refuses it (a `window` row in the Inspector); allowed in
//   Network… it reaches example.com while the app runs; a host not allowed, an IP address and localhost stay refused (the last two
//   never even reach the endpoint); a script from the network never loads; a revoke applies at once; the endpoint answers nothing
//   without the run's secret; after the stop the window's network is gone. Without internet the allowed fetch is skipped (said so).
// Run U: "Leave this page?" (SPEC 7) with a REAL VM (fixture-unload): a page that vetoes its unload (beforeunload) gets the
//   loader's own question (the page's text never shown, answered through VMAPP_TEST_DIALOGS.leave); Stay keeps the page (no reload),
//   a second veto within a second stays without asking, Leave reloads it, and a vetoed window close is asked too.
// CDP_ONLY=D, E, F, G, H, I, J, K, L, M, W or U runs just that run, for quick iteration. CDP_PORT=<port> and VMAPP_WORK=<absolute dir> let a second
// run of the whole file coexist with this one.
// Windows are opened for real and closed (the loader is killed) at the end.

import { spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LOADER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VMAPP = path.resolve(LOADER, '..');
// Scratch space: $VMAPP_WORK/loader-test (VMAPP_WORK defaults to <vmapp>/out/work, which is git-ignored)
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(VMAPP, 'out', 'work'));
const ROOT = path.join(WORK, 'loader-test');
const SHOTS = path.join(ROOT, 'shots');
const PORT = Number(process.env.CDP_PORT) || 9250; // CDP_PORT lets two test runs of different workers coexist (with VMAPP_WORK for their scratch space)
const ID = 'com.vmapp.loadertest';
const hostlib = require(path.join(VMAPP, 'hostlib'));
const { createAppUiHandler, createLoaderHandler, APP_CSP, LOADER_CSP } = require(path.join(LOADER, 'src', 'protocols.js'));
const electronBin = require(path.join(LOADER, 'node_modules', 'electron'));

const SPEC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

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
  on(fn) {
    this.listeners.push(fn);
  }
  /** Evaluates an expression in the page (awaiting promises) and returns its value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value : r.exceptionDetails.text}`);
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    step(`screenshot ${path.relative(VMAPP, f)}`);
    return f;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

const conns = new Map();
async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter((t) => t.type === 'page');
}
async function waitTarget(match, what, timeout = 20000) {
  const t = await waitFor(async () => (await targets()).find((x) => match(x.url)), { timeout, what });
  if (!conns.has(t.id)) conns.set(t.id, await Cdp.connect(t.webSocketDebuggerUrl));
  return conns.get(t.id);
}
const isLibrary = (u) => u.startsWith('vmapp-loader://ui/library.html');
const isInspector = (u) => u.startsWith('vmapp-loader://ui/inspector.html');
const isApp = (u) => u.startsWith(`vmapp-ui://${ID}/`);
function dropConns() {
  for (const c of conns.values()) c.close();
  conns.clear();
}

// ------------------------------------------------------------------------------------------------ processes
function ps() {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,command=']).stdout.toString();
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}
/** vmapp-vm processes of THIS test (their --appdata lives under our home), so other VMs on the machine don't matter. */
const testVms = (home) => ps().filter((p) => p.cmd.includes('/vmapp-vm') && p.cmd.includes(`--appdata ${path.join(home, 'data')}`));
function vmCount() {
  const r = spawnSync('pgrep', ['-f', 'com.apple.Virtualization.VirtualMachine']);
  return r.stdout.toString().split('\n').filter(Boolean).length;
}

const spawned = [];
// Every loader of this test talks to the FAKE host helper and dry-runs input: nothing here can post a real mouse or
// keyboard event, take a real screenshot, or register the owner's real panic shortcut.
const FAKE_HOSTCTL = path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-hostctl.js');
function startLoader({ home, env, name, args = [] }) {
  assert.ok(fs.existsSync(FAKE_HOSTCTL), 'the fake hostctl exists');
  const e = Object.assign({}, process.env, { VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_HOSTCTL]), VMAPP_HOSTCTL_DRYRUN: '1' }, env, { VMAPP_HOME: home });
  delete e.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(ROOT, `${name}.log`), 'w');
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, ...args], { cwd: LOADER, env: e, stdio: ['ignore', log, log] });
  spawned.push(child);
  child.exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  return child;
}
async function killLoader(child, signal = 'SIGTERM', timeout = 25000) {
  if (child.exitCode !== null || child.signalCode) return child.exited;
  child.kill(signal);
  return Promise.race([child.exited, sleep(timeout).then(() => ({ code: 'timeout' }))]);
}

// ------------------------------------------------------------------------------------------------ library helpers
const q = (sel) => JSON.stringify(sel);
const click = (c, sel) => c.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('no element ${sel.replace(/'/g, '')}'); if (e.disabled) throw new Error('disabled: ${sel.replace(/'/g, '')}'); e.click(); return true; })()`);
const exists = (c, sel) => c.eval(`!!document.querySelector(${q(sel)})`);
const text = (c, sel) => c.eval(`(document.querySelector(${q(sel)}) || {}).textContent || null`);
const cardSel = (a) => `[data-app="${ID}"] ${a}`;
const waitSel = (c, sel, what, timeout) => waitFor(() => exists(c, sel), { what: what || sel, timeout });
const cardState = (c) => c.eval(`(document.querySelector('[data-app="${ID}"]') || {dataset:{}}).dataset.state || null`);
const appBtn = (action) => cardSel(`[data-action="${action}"]`);

// ------------------------------------------------------------------------------------------------ main
async function protocolChecks(pkgFile) {
  step('protocol: vmapp-ui serving, CSP, 404s, hash check');
  const home = path.join(ROOT, 'proto-home');
  const store = new hostlib.Store({ home, skipRuntimeCheck: true });
  store.install(pkgFile);
  const app = store.get(ID);
  const contexts = new Map([[ID, { app, verified: new Map() }]]);
  const handle = createAppUiHandler(contexts);
  const get = (u, method = 'GET') => handle(new Request(u, { method }));

  assert.equal(APP_CSP, SPEC_CSP, 'APP_CSP is exactly the SPEC 7 header');
  const idx = await get(`vmapp-ui://${ID}/index.html`);
  assert.equal(idx.status, 200);
  assert.equal(idx.headers.get('content-security-policy'), SPEC_CSP);
  assert.match(idx.headers.get('content-type'), /^text\/html/);
  assert.match(await idx.text(), /Loader Test/);
  const js = await get(`vmapp-ui://${ID}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  for (const bad of ['nope.js', 'sub/../x.js', '%2e%2e/vmapp.json', '%2e%2e%2fvmapp.json', 'core.cpio', '', 'index.html/', 'a%00b', '..%5Cvmapp.json']) {
    const r = await get(`vmapp-ui://${ID}/${bad}`);
    assert.equal(r.status, 404, `/${bad} must be 404`);
    assert.equal(r.headers.get('content-security-policy'), SPEC_CSP, '404 carries the CSP too');
  }
  assert.equal((await get('vmapp-ui://com.other.app/index.html')).status, 404, 'unknown app host');
  assert.equal((await get(`vmapp-ui://${ID}/index.html`, 'POST')).status, 405);

  // tampering with an installed file: 404 (the hash no longer matches the manifest)
  const jsFile = path.join(app.uiDir, 'app.js');
  const orig = fs.readFileSync(jsFile);
  fs.writeFileSync(jsFile, Buffer.concat([orig, Buffer.from('\n// tampered\n')]));
  assert.equal((await get(`vmapp-ui://${ID}/app.js`)).status, 404, 'modified file is refused');
  fs.writeFileSync(jsFile, orig);
  assert.equal((await get(`vmapp-ui://${ID}/app.js`)).status, 200, 'restored file is served again');

  // loader scheme: only the loader's own pages, with the loader CSP
  const lh = createLoaderHandler({ uiDir: path.join(LOADER, 'ui'), getIconPath: () => null });
  const lib = await lh(new Request('vmapp-loader://ui/library.html'));
  assert.equal(lib.status, 200);
  assert.equal(lib.headers.get('content-security-policy'), LOADER_CSP);
  assert.equal((await lh(new Request('vmapp-loader://ui/..%2fmain.js'))).status, 404);
  assert.equal((await lh(new Request('vmapp-loader://ui/nothing.js'))).status, 404);
  assert.equal((await lh(new Request('vmapp-loader://other/library.html'))).status, 404);
  step('protocol checks passed');
}

// Pure-function checks of the production hardening helpers (no Electron needed).
function hardeningChecks() {
  step('hardening: folder guard and forbidden switches');
  const { classifyFolder } = require(path.join(LOADER, 'src', 'folder-guard.js'));
  const { forbiddenSwitches } = require(path.join(LOADER, 'src', 'hardening.js'));
  const dataDir = path.join(ROOT, 'guard-home');
  fs.mkdirSync(path.join(dataDir, 'apps'), { recursive: true });
  const userHome = os.homedir();
  const lv = (p) => classifyFolder(p, { dataDir }).level;
  assert.equal(lv('/'), 'refuse', 'the disk root is refused');
  assert.equal(lv(dataDir), 'refuse', 'the loader data dir is refused');
  assert.equal(lv(path.join(dataDir, 'apps')), 'refuse', 'inside the loader data dir is refused');
  assert.equal(lv(userHome), 'warn', 'the home folder is a warning');
  for (const p of ['/Users', '/Volumes', '/System', '/Library', path.join(userHome, 'Library'), path.dirname(dataDir), path.dirname(path.dirname(dataDir))]) {
    assert.equal(lv(p), 'warn', `${p} is a warning`);
  }
  const vols = fs.readdirSync('/Volumes');
  assert.ok(vols.length > 0);
  for (const v of vols) assert.notEqual(lv(path.join('/Volumes', v)), 'ok', `/Volumes/${v} (a disk root) is never plain ok`);
  assert.equal(classifyFolder(path.join(userHome, 'Library'), { dataDir: path.join(userHome, 'Library', 'Application Support', 'VMApp Loader') }).level, 'warn');
  assert.equal(classifyFolder(path.join(userHome, 'Library', 'Application Support', 'VMApp Loader', 'data'), { dataDir: path.join(userHome, 'Library', 'Application Support', 'VMApp Loader') }).level, 'refuse');
  assert.equal(lv(path.join(ROOT, 'user', 'work')), 'ok', 'an ordinary folder is fine');
  assert.equal(lv(path.join(userHome, 'Documents', 'some-project')), 'ok');
  // a symlink to / is still the root, a symlink into the data dir is still the data dir
  const linkRoot = path.join(ROOT, 'link-to-root');
  const linkData = path.join(ROOT, 'link-to-data');
  fs.rmSync(linkRoot, { force: true });
  fs.rmSync(linkData, { force: true });
  fs.symlinkSync('/', linkRoot);
  fs.symlinkSync(path.join(dataDir, 'apps'), linkData);
  assert.equal(lv(linkRoot), 'refuse');
  assert.equal(lv(linkData), 'refuse');

  assert.deepEqual(forbiddenSwitches(['/x/electron', '.', '--remote-debugging-port=9333', '--inspector']), ['--remote-debugging-port=9333']);
  assert.deepEqual(forbiddenSwitches(['--inspect', '--inspect-brk=9229', '--REMOTE-DEBUGGING-PIPE', '--no-sandbox', '--js-flags=--expose-gc']).length, 5);
  assert.deepEqual(forbiddenSwitches(['--inspector', '--enable-logging', 'remote-debugging-port']), [], 'the loader’s own --inspector flag is fine');
  step('hardening checks passed');
}

async function main() {
  // ---- scratch ----
  assert.equal(path.basename(ROOT), 'loader-test', 'the scratch folder deleted below is always <VMAPP_WORK>/loader-test');
  assert.ok(ROOT.startsWith(WORK + path.sep));
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of ['vmapp-vm', 'Image', 'initramfs.cpio']) assert.ok(fs.existsSync(path.join(VMAPP, 'out', f)), `vmapp/out/${f} is missing (run tools/build.sh)`);
  assert.ok(fs.existsSync(path.join(VMAPP, 'out', 'runtimes', 'node22.img')), 'vmapp/out/runtimes/node22.img is missing');

  // CDP_ONLY=D: only run D (developer and publishing features), for quick iteration
  if (process.env.CDP_ONLY === 'D') {
    await runD(vmCount());
    step('ALL PASSED (run D only)');
    return;
  }
  if (process.env.CDP_ONLY === 'E') {
    await runE(vmCount());
    step('ALL PASSED (run E only)');
    return;
  }
  if (process.env.CDP_ONLY === 'F') {
    await runF(vmCount());
    step('ALL PASSED (run F only)');
    return;
  }
  if (process.env.CDP_ONLY === 'G') {
    await runG(vmCount());
    step('ALL PASSED (run G only)');
    return;
  }
  if (process.env.CDP_ONLY === 'H') {
    await runH(vmCount());
    step('ALL PASSED (run H only)');
    return;
  }
  if (process.env.CDP_ONLY === 'I') {
    await runI();
    step('ALL PASSED (run I only)');
    return;
  }
  if (process.env.CDP_ONLY === 'J') {
    await runJ();
    step('ALL PASSED (run J only)');
    return;
  }
  if (process.env.CDP_ONLY === 'K') {
    await runK();
    step('ALL PASSED (run K only)');
    return;
  }
  if (process.env.CDP_ONLY === 'KR') {
    await runKR();
    step('ALL PASSED (run KR only)');
    return;
  }
  if (process.env.CDP_ONLY === 'L') {
    await runL();
    step('ALL PASSED (run L only)');
    return;
  }
  if (process.env.CDP_ONLY === 'M') {
    await runM();
    step('ALL PASSED (run M only)');
    return;
  }
  if (process.env.CDP_ONLY === 'W') {
    await runW();
    step('ALL PASSED (run W only)');
    return;
  }
  if (process.env.CDP_ONLY === 'U') {
    await runU();
    step('ALL PASSED (run U only)');
    return;
  }
  if (process.env.CDP_ONLY === 'Y') {
    await runY();
    step('ALL PASSED (run Y only)');
    return;
  }

  // ---- fixtures ----
  const pkgFile = path.join(ROOT, 'loadertest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-app'), pkgFile);
  const workDir = path.join(ROOT, 'user', 'work');
  const pickDir = path.join(ROOT, 'user', 'pick-ro');
  const pickDir2 = path.join(ROOT, 'user', 'pick-rw');
  const fileDir = path.join(ROOT, 'user', 'files');
  const saveDir = path.join(ROOT, 'user', 'saved');
  for (const d of [workDir, pickDir, pickDir2, fileDir, saveDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'seed.txt'), 'seed');
  fs.writeFileSync(path.join(pickDir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(pickDir, 'b.txt'), 'b');
  fs.writeFileSync(path.join(pickDir2, 'c.txt'), 'c');
  fs.writeFileSync(path.join(fileDir, 'doc.txt'), 'document content');
  fs.writeFileSync(path.join(fileDir, 'secret.txt'), 'must never be visible to the app');
  const saveTarget = path.join(saveDir, 'result.txt');
  const home = path.join(ROOT, 'home');
  const dialogLog = path.join(ROOT, 'dialogs.jsonl');
  const readDialogLog = () => (fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  await protocolChecks(pkgFile);
  hardeningChecks();

  const baseline = vmCount();
  step(`baseline: ${baseline} Virtualization VM process(es) on this machine`);

  // =========================================================================================== run A
  step('run A: loader without VMAPP_TEST_GRANTS (the permission sheet is shown)');
  const dialogsEnv = {
    // the last four are for the too-broad-folder checks: home (declined), home (confirmed), / (refused), the data dir (refused)
    open: [pkgFile, workDir, pickDir, pickDir2, path.join(fileDir, 'doc.txt'), workDir, os.homedir(), os.homedir(), '/', home],
    broad: [false, true],
    save: saveTarget,
    message: 1,
    external: true,
  };
  const A = startLoader({ home, name: 'loader-A', env: { VMAPP_TEST_DIALOGS: JSON.stringify(dialogsEnv), VMAPP_TEST_DIALOG_LOG: dialogLog } });
  const lib = await waitTarget(isLibrary, 'library window');
  await waitSel(lib, '[data-role="empty"]', 'empty library');
  assert.ok(fs.existsSync(path.join(home, 'runtimes', 'node22.img')), 'node22 runtime was installed from vmapp/out/runtimes');
  await lib.shot('01-library-empty');

  // ---- install through the UI ----
  step('install: pick package, review sheet, confirm');
  await click(lib, '[data-action="install"]');
  await waitSel(lib, '[data-role="review"]', 'install review');
  const review = await text(lib, '[data-role="review"]');
  assert.match(review, /Loader Test 1\.0\.0/);
  assert.match(review, /D9010 VmApp tests/);
  assert.match(review, /[0-9a-f]{64}/, 'full package id is shown');
  assert.match(review, /node22/);
  const reviewSheet = await lib.eval(`document.querySelector('.sheet').textContent`);
  assert.match(reviewSheet, /Where the test app lists and writes its files/, 'purpose shown');
  assert.match(reviewSheet, /no reason given/, 'missing purpose shown as "no reason given"');
  await lib.shot('02-install-review');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${ID}"]`, 'app card');
  const card = await text(lib, `[data-app="${ID}"]`);
  assert.match(card, /Loader Test/);
  assert.match(card, /Sandboxed VM/);
  assert.match(card, /runtime node22/);
  assert.match(card, /package [0-9a-f]{8}/);
  assert.match(card, /work \(read & write\), extra \(read only\)/);
  assert.equal(await cardState(lib), 'stopped');
  await lib.shot('03-library');

  // ---- permission sheet ----
  step('launch: permission sheet');
  await click(lib, appBtn('launch'));
  await waitSel(lib, '[data-role="folders"] [data-folder="work"]', 'permission sheet');
  assert.match(await text(lib, '[data-folder="work"] [data-role="purpose"]'), /Where the test app lists and writes its files/);
  assert.equal(await text(lib, '[data-folder="extra"] [data-role="purpose"]'), 'no reason given');
  assert.match(await text(lib, '[data-folder="work"] [data-role="requested"]'), /asks for read & write/);
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-folder="work"] select option')].map(o => o.value)`), ['readwrite', 'read'], 'readwrite can be downgraded');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-folder="extra"] select option')].map(o => o.value)`), ['read']);
  assert.equal(await lib.eval(`document.querySelector('[data-folder="extra"] select').disabled`), true);
  await click(lib, '[data-folder="work"] [data-action="choose"]');
  await waitFor(async () => (await text(lib, '[data-folder="work"] [data-role="path"]')) === workDir, { what: 'chosen folder shown' });
  await click(lib, '[data-folder="extra"] [data-action="skip"]');
  assert.match(await text(lib, '[data-folder="extra"] [data-role="path"]'), /Skipped/);
  await lib.shot('04-permission-sheet');
  const chooseLog = readDialogLog().find((d) => d.detail.descr === 'grant:work');
  assert.ok(chooseLog && /Loader Test/.test(chooseLog.detail.message) && /change files in this folder/.test(chooseLog.detail.message), 'folder chooser wording is loader-owned');
  await click(lib, '[data-action="sheet-launch"]');
  await waitFor(() => {
    const g = path.join(home, 'grants', `${ID}.json`);
    return fs.existsSync(g) && JSON.parse(fs.readFileSync(g, 'utf8'));
  }, { what: 'grants saved' }).then((g) => {
    assert.deepEqual(g, { folders: { work: { path: workDir, access: 'readwrite' }, extra: null }, askEveryTime: false });
  });

  // ---- the app window ----
  step('app window: waiting for the VM to boot and the window to appear');
  const appWin = await waitTarget(isApp, 'app window', 90000);
  await waitFor(() => appWin.eval('window.__hello !== null && window.__hello !== undefined'), { what: 'hello emit from the core', timeout: 30000 });
  assert.equal(await cardState(lib), 'running');

  step('renderer: sandbox, window.vmapp surface, CSP, navigation');
  assert.deepEqual(await appWin.eval('Object.keys(window.vmapp).sort()'), ['app', 'invoke', 'ipcRenderer', 'menu', 'on', 'send', 'serve', 'served']);
  assert.deepEqual(await appWin.eval('Object.keys(window.vmapp.ipcRenderer).sort()'), ['addListener', 'eventNames', 'invoke', 'listenerCount', 'off', 'on', 'once', 'removeAllListeners', 'removeListener', 'send', 'sendSync']);
  // "these paths are my server's" (SPEC 7 "Files the app's server serves"): validated by the launcher, scoped to this app, and only a boolean comes back
  assert.equal(await appWin.eval('window.vmapp.served()'), false, 'nothing announced yet');
  for (const bad of [[], [{ prefix: '/', channel: 'fetch' }], [{ prefix: '/a/../b', channel: 'fetch' }], [{ prefix: '/ok/', channel: 'x y' }], 'x', null]) {
    assert.equal(await appWin.eval(`window.vmapp.serve(${JSON.stringify(bad)})`), false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(await appWin.eval(`window.vmapp.serve([{ prefix: '/served-by-the-core/', channel: 'fetch' }])`), true, 'a good route is accepted by this launcher');
  assert.equal(await appWin.eval('window.vmapp.served()'), true);
  assert.equal(await appWin.eval('typeof window.vmapp.serve.call'), 'function');
  assert.match(await appWin.eval(`(() => { try { window.vmapp.serve(() => 1); return 'accepted'; } catch (e) { return e.message; } })()`), /routes must be JSON-serialisable/, 'something that is not data is refused in the page, with a clear message');
  assert.deepEqual(await appWin.eval('Object.keys(window.vmapp.menu).sort()'), ['onClick', 'set']);
  assert.deepEqual(await appWin.eval('window.vmapp.app'), { id: ID, name: 'Loader Test', version: '1.0.0' });
  assert.equal(await appWin.eval('typeof window.require'), 'undefined');
  assert.equal(await appWin.eval('typeof window.process'), 'undefined');
  assert.equal(await appWin.eval('typeof window.module'), 'undefined');
  assert.equal(await appWin.eval('typeof window.Buffer'), 'undefined');
  assert.equal(await appWin.eval('typeof window.electron + typeof window.ipcRenderer'), 'undefinedundefined');
  const fetched = await appWin.eval(`fetch('https://example.com/').then(() => 'fetched', (e) => 'rejected: ' + e.message)`);
  assert.match(fetched, /^rejected/, 'fetch to the internet is rejected by the CSP');
  assert.match(await appWin.eval(`fetch('vmapp-ui://${ID}/app.js').then(() => 'fetched', () => 'rejected')`), /rejected/, 'even same-origin fetch is blocked (connect-src none)');
  assert.match(await appWin.eval(`new Promise((res) => { const x = new XMLHttpRequest(); x.onerror = () => res('rejected'); x.onload = () => res('loaded'); try { x.open('GET', 'https://example.com/'); x.send(); } catch (e) { res('rejected'); } })`), /rejected/);
  assert.match(
    await appWin.eval(`new Promise((res) => {
      document.addEventListener('securitypolicyviolation', (e) => res(e.violatedDirective), { once: true });
      const s = document.createElement('script'); s.textContent = 'window.__injected = 1'; document.head.appendChild(s);
      setTimeout(() => res('none'), 1500);
    })`),
    /^script-src/,
    'inline script is blocked (script-src self)',
  );
  assert.equal(await appWin.eval('window.__injected'), undefined);
  assert.equal(await appWin.eval(`window.open('https://example.com/') === null`), true, 'window.open is denied');
  await appWin.eval(`location.href = 'https://example.com/'`).catch(() => {});
  await sleep(700);
  assert.ok((await appWin.eval('location.href')).startsWith(`vmapp-ui://${ID}/`), 'navigation outside vmapp-ui is blocked');
  assert.equal(await appWin.eval(`navigator.permissions.query({name: 'geolocation'}).then((r) => r.state)`), 'denied');
  assert.equal(await appWin.eval(`new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), () => res('denied')))`), 'denied');
  assert.equal(await appWin.eval(`Notification.permission`), 'denied');
  // the page's own localStorage works and is per app origin
  assert.equal(await appWin.eval(`(localStorage.setItem('k', 'v'), localStorage.getItem('k'))`), 'v');

  step('renderer: response headers carry the SPEC 7 CSP');
  const heads = [];
  await appWin.send('Network.enable');
  appWin.on((m) => {
    if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(`vmapp-ui://${ID}/`)) heads.push(m.params.response);
  });
  await appWin.send('Page.reload');
  await waitFor(() => heads.length > 0, { what: 'network response events' });
  for (const r of heads) {
    const csp = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-security-policy');
    assert.ok(csp && csp[1] === SPEC_CSP, `${r.url} has the SPEC 7 CSP`);
  }
  await appWin.send('Network.disable');
  await waitFor(() => appWin.eval(`typeof window.vmapp === 'object' && document.readyState === 'complete'`), { what: 'page reloaded' });

  step('bridge: invoke round trip, rejection, alias, send/emit, core-supplied folders');
  assert.deepEqual(await appWin.eval(`window.vmapp.invoke('echo', 1, 'two', {a: [3, null]})`), [1, 'two', { a: [3, null] }]);
  assert.deepEqual(await appWin.eval(`window.vmapp.ipcRenderer.invoke('echo', 5)`), [5]);
  assert.equal(await appWin.eval(`window.vmapp.invoke('fail').then(() => 'resolved', (e) => e.message)`), "Error invoking remote method 'fail': Error: boom from the core", "a handler's error arrives as Electron words it");
  assert.match(await appWin.eval(`window.vmapp.invoke('nope').then(() => 'resolved', (e) => e.message)`), /No handler registered for 'nope'/);
  assert.deepEqual(await appWin.eval('window.__hello').catch(() => null), null, 'a reloaded page starts without the old emit');
  assert.deepEqual(await appWin.eval(`window.vmapp.invoke('folders')`), { work: '/host/f-work', extra: null });
  await appWin.eval(`window.vmapp.send('tick-me', 7)`);
  await waitFor(() => appWin.eval(`window.__ticks.some((t) => t.n === 7 && t.from === 'core')`), { what: 'emit from the core' });
  // alias listener gets (event, ...args)
  assert.equal(await appWin.eval(`new Promise((res) => { const off = window.vmapp.ipcRenderer.on('tick', (ev, t) => { off(); res([typeof ev, t.n]); }); window.vmapp.send('tick-me', 8); }).then((r) => r.join(':'))`), 'object:8');

  step("ipcRenderer / ipcMain: Electron's contract (error text, structured clone, event.reply, once, removeAllListeners)");
  // spec/api-ipc-spec.ts "invoke": errors reach the renderer as `Error invoking remote method '<channel>': <error.toString()>`
  assert.equal(await appWin.eval(`window.vmapp.invoke('throw-type').then(() => 'resolved', (e) => e.message)`), "Error invoking remote method 'throw-type': TypeError: bad type from the core");
  assert.equal(await appWin.eval(`window.vmapp.invoke('nope').then(() => 'resolved', (e) => e.message)`), "Error invoking remote method 'nope': Error: No handler registered for 'nope'");
  assert.equal(await appWin.eval(`window.vmapp.invoke('nope').then(() => 'resolved', (e) => e instanceof Error)`), true);
  // spec/api-ipc-renderer-spec.ts: Date, Buffer/typed arrays, shared references, cycles; the other direction too (core -> page)
  assert.deepEqual(
    await appWin.eval(`window.vmapp.invoke('typed').then((r) => ({
      u8: r[0] instanceof Uint8Array && [...r[0]].join(),
      date: r[1] instanceof Date && r[1].getTime(),
      map: r[2] instanceof Map && r[2].get('k') instanceof Set && [...r[2].get('k')].join(),
      undef: r[3] === undefined && r.length === 8,
      big: typeof r[4] === 'bigint' && String(r[4]),
      nan: Number.isNaN(r[5]),
      negZero: Object.is(r[6], -0),
      err: r[7] instanceof Error && r[7].message,
    }))`),
    { u8: '1,2,3', date: 86400000, map: '1,2', undef: true, big: '12345678901234567890', nan: true, negZero: true, err: 'inner' },
    'the core returns typed arrays, Date, Map, Set, undefined, BigInt, NaN, -0 and Error, as Electron would',
  );
  // (a cycle cannot cross the context bridge between the page and the preload, in either direction: Electron's own limit, "recursion depth
  // exceeded". Between the launcher and the core cycles and shared references work: tests/unit/bridge.test.js, tests/unit/ipc-codec.test.js)
  assert.match(await appWin.eval(`window.vmapp.invoke('typed-cycle').then(() => 'resolved', (e) => e.message)`), /recursion depth exceeded/);
  assert.match(await appWin.eval(`(() => { const c = [5]; c.push(c); try { return window.vmapp.invoke('echo', c).then(() => 'resolved', (e) => e.message); } catch (e) { return e.message; } })()`), /recursion depth exceeded/);
  assert.deepEqual(
    await appWin.eval(`(async () => {
      const child = { hello: 'world' };
      const foo = { name: 'foo', child };
      const bar = { name: 'bar', child };
      const r = await window.vmapp.invoke('echo', new Uint8Array([9, 8]), new Date(5), new Map([[1, { a: 2 }]]), undefined, 7n, -0, [foo, bar]);
      return { u8: r[0] instanceof Uint8Array && [...r[0]].join(), date: r[1].getTime(), map: r[2].get(1).a, undef: r[3] === undefined, big: r[4] === 7n, negZero: Object.is(r[5], -0), shared: r[6][0].child.hello + r[6][1].child.hello };
    })().catch((e) => String(e))`),
    { u8: '9,8', date: 5, map: 2, undef: true, big: true, negZero: true, shared: 'worldworld' },
    'the page sends the same kinds of values to the core, which echoes them back',
  );
  // a value that cannot be cloned is refused where it is sent, with Electron's text
  const refused = await appWin.eval(`(async () => {
    const out = {};
    try { window.vmapp.send('x', { f() {} }); out.send = 'sent'; } catch (e) { out.send = e.message; }
    out.invoke = await window.vmapp.invoke('echo', { f() {} }).then(() => 'resolved', (e) => e.message);
    return out;
  })()`);
  assert.match(refused.send, /could not be cloned\.$/, JSON.stringify(refused));
  assert.match(refused.invoke, /could not be cloned\.$/, JSON.stringify(refused));
  // ipcMain.on(...) can be replied to: event.reply (spec/api-ipc-main-spec.ts)
  assert.equal(await appWin.eval(`new Promise((res) => { const off = window.vmapp.on('replied', (v) => { off(); res(v); }); window.vmapp.send('reply-me', 'hello'); })`), 'hello');
  // ipcRenderer: once, removal, eventNames/listenerCount (spec/api-ipc-renderer-spec.ts "removeAllListeners")
  const l = await appWin.eval(`(async () => {
    const ipc = window.vmapp.ipcRenderer;
    const base = ipc.listenerCount('tick');
    const got = [];
    ipc.once('tick', (ev, t) => got.push('once' + t.n));
    const off = ipc.on('tick', (ev, t) => got.push('on' + t.n));
    const counts = [base, ipc.listenerCount('tick')];
    window.vmapp.send('tick-me', 21);
    await new Promise((r) => setTimeout(r, 700));
    window.vmapp.send('tick-me', 22);
    await new Promise((r) => setTimeout(r, 700));
    off();
    const afterOff = ipc.listenerCount('tick');
    let offErr = null; try { ipc.off('tick', () => 1); } catch (e) { offErr = e.message; }
    let removeErr = null; try { ipc.removeListener('tick', () => 1); } catch (e) { removeErr = e.message; }
    let syncErr = null; try { ipc.sendSync('x'); } catch (e) { syncErr = e.message; }
    ipc.on('zzz-1', () => {}); ipc.addListener('zzz-2', () => {});
    const names = ipc.eventNames();
    ipc.removeAllListeners('zzz-1');
    const afterOne = ipc.eventNames();
    ipc.removeAllListeners('zzz-2');
    return { got, counts, afterOff, offErr, removeErr, syncErr, has: [names.includes('zzz-1'), names.includes('zzz-2')], afterOne: [afterOne.includes('zzz-1'), afterOne.includes('zzz-2')], gone: !ipc.eventNames().includes('zzz-2'), appOwn: ipc.listenerCount('tick') === base };
  })()`);
  assert.deepEqual(l.got, ['once21', 'on21', 'on22'], 'once runs once; on runs every time; both in the order they were added');
  assert.deepEqual(l.counts, [l.counts[0], l.counts[0] + 2]);
  assert.equal(l.afterOff, l.counts[0] + 0, 'the function on() returned removes the listener (and the once one has gone)');
  assert.match(l.offErr, /cannot be matched by identity across the context bridge/);
  assert.match(l.removeErr, /cannot be matched by identity across the context bridge/);
  assert.match(l.syncErr, /sendSync is not available.*invoke/);
  assert.deepEqual([l.has, l.afterOne, l.gone, l.appOwn], [[true, true], [false, true], true, true], 'removeAllListeners(channel) removes only that channel');

  step('folders: granted work folder (read & write)');
  assert.deepEqual(await appWin.eval(`window.vmapp.invoke('list-folder', 'work')`), ['seed.txt']);
  await appWin.eval(`window.vmapp.invoke('write-folder', 'work', 'from-app.txt', 'hello')`);
  assert.equal(fs.readFileSync(path.join(workDir, 'from-app.txt'), 'utf8'), 'hello', 'the app wrote into the granted folder');
  await appWin.eval(`window.vmapp.invoke('write-data', 'state.txt', 'persisted')`);
  assert.equal(fs.readFileSync(path.join(home, 'data', ID, 'state.txt'), 'utf8'), 'persisted');

  step('dialogs: directory pick (read only), directory pick (read & write), file pick (APFS clone), save, message, external');
  const pickA = await appWin.eval(`window.vmapp.invoke('pick-dir')`);
  assert.deepEqual(pickA, { canceled: false, dir: '/host/pick-0', entries: ['a.txt', 'b.txt'] });
  assert.match(await appWin.eval(`window.vmapp.invoke('write-in', '/host/pick-0', 'x.txt', 'no').then(() => 'written', (e) => e.message)`), /EROFS|read-only|EACCES|EPERM|permission/i, 'read-only pick cannot be written');
  assert.ok(!fs.existsSync(path.join(pickDir, 'x.txt')));
  const pickB = await appWin.eval(`window.vmapp.invoke('pick-dir', 'readwrite')`);
  assert.deepEqual(pickB, { canceled: false, dir: '/host/pick-1', entries: ['c.txt'] });
  await appWin.eval(`window.vmapp.invoke('write-in', '/host/pick-1', 'written-by-app.txt', 'rw ok')`);
  assert.equal(fs.readFileSync(path.join(pickDir2, 'written-by-app.txt'), 'utf8'), 'rw ok', 'readwrite pick lets the app change files');
  const pickF = await appWin.eval(`window.vmapp.invoke('pick-file')`);
  assert.deepEqual(pickF, { canceled: false, file: '/host/pick-2/doc.txt', content: 'document content', siblings: ['doc.txt'] }, 'the app sees the chosen file only, never its siblings');
  const clone = path.join(home, 'picks', ID, 'pick-2', 'doc.txt');
  assert.ok(fs.existsSync(clone), 'a clone of the file sits under $VMAPP_HOME/picks/<id>/pick-N/');
  assert.equal(fs.readFileSync(clone, 'utf8'), 'document content');
  assert.notEqual(fs.statSync(clone).ino, fs.statSync(path.join(fileDir, 'doc.txt')).ino, 'a clone is a different file');

  const saved = await appWin.eval(`window.vmapp.invoke('save', 'saved by the app')`);
  assert.deepEqual(saved, { canceled: false, path: '/host/save-0/result.txt' });
  await waitFor(() => fs.existsSync(saveTarget) && fs.readFileSync(saveTarget, 'utf8') === 'saved by the app', { what: 'save delivered to the chosen file', timeout: 15000 });
  assert.equal(await appWin.eval(`window.vmapp.invoke('message')`), 1);
  assert.equal(await appWin.eval(`window.vmapp.invoke('external', 'https://example.com/x')`), true);
  assert.match(await appWin.eval(`window.vmapp.invoke('external', 'http://example.com/').then(() => 'ok', (e) => e.message)`), /only https/);

  const dl = readDialogLog().map((d) => ({ ...d.detail, kind: d.kind }));
  const msgOf = (descr) => dl.filter((d) => d.descr === descr).map((d) => d.message);
  assert.ok(msgOf('folder:read').some((m) => m === '“Loader Test” wants to open a folder (read only): Pick a folder'), `read folder wording: ${msgOf('folder:read')}`);
  assert.ok(msgOf('folder:readwrite').some((m) => m.startsWith('“Loader Test” wants to open a folder (it will be able to change files in this folder)')));
  assert.ok(msgOf('file').some((m) => m.startsWith('“Loader Test” wants to open a file')));
  assert.ok(dl.some((d) => d.kind === 'save' && d.message.startsWith('“Loader Test” wants to save a file')));
  assert.ok(dl.some((d) => d.kind === 'external' && d.message === '“Loader Test” wants to open https://example.com/x in your browser'));
  assert.ok(dl.some((d) => d.kind === 'message' && d.message.startsWith('“Loader Test”')));

  await appWin.shot('05-app-window');

  step('buttons while running: Reset and Uninstall and Permissions are disabled');
  for (const a of ['reset', 'uninstall', 'permissions', 'launch']) {
    assert.equal(await lib.eval(`document.querySelector(${q(appBtn(a))}).disabled`), true, `${a} disabled while running`);
  }
  assert.equal(await lib.eval(`document.querySelector(${q(appBtn('stop'))}).disabled`), false);

  // ---- inspector ----
  step('inspector: rows, filter, preview, log and files tabs');
  await click(lib, appBtn('inspect'));
  const insp = await waitTarget(isInspector, 'inspector window');
  await waitFor(() => insp.eval(`document.querySelectorAll('#rows tr.row').length > 30`), { what: 'inspector rows' });
  const rows = await insp.eval(`[...document.querySelectorAll('#rows tr.row')].map((tr) => ({ t: tr.dataset.t, dir: tr.dataset.dir, cells: [...tr.children].map((td) => td.textContent) }))`);
  assert.equal(rows[0].t, 'init');
  assert.equal(rows[0].dir, 'to-core');
  const invokeRow = rows.find((r) => r.t === 'invoke' && r.cells[3] === 'echo');
  assert.ok(invokeRow && invokeRow.dir === 'to-core' && invokeRow.cells[1] === '→');
  const resultRow = rows.find((r) => r.t === 'result' && r.cells[3] === 'echo');
  assert.ok(resultRow && resultRow.dir === 'from-core' && /^\d+ ms$/.test(resultRow.cells[6]) && Number(resultRow.cells[5]) > 0, 'result row has the matched channel, bytes and duration');
  assert.ok(rows.some((r) => r.t === 'emit' && r.cells[3] === 'hello'), 'emit rows');
  assert.ok(rows.some((r) => r.t === 'request' && r.cells[3] === 'dialog.open'), 'request rows');
  assert.ok(rows.some((r) => r.t === 'reply' && r.cells[3] === 'dialog.open' && /ms$/.test(r.cells[6])), 'reply rows with duration');
  assert.ok(rows.some((r) => r.t === 'grant' && r.cells[3].startsWith('pick-')), 'dialog grants appear');
  assert.ok(rows.some((r) => r.t === 'grant' && r.cells[3] === 'save-0'));
  // select a row -> preview
  await insp.eval(`[...document.querySelectorAll('#rows tr.row')].find((tr) => tr.dataset.t === 'invoke' && tr.children[3].textContent === 'echo').click()`);
  const pre = await text(insp, '#detail-pre');
  assert.match(pre, /"channel": "echo"/);
  assert.match(await text(insp, '#detail-meta'), /Directionhost → core/);
  // filter
  await insp.eval(`(() => { const f = document.getElementById('filter'); f.value = 'dialog.open'; f.dispatchEvent(new Event('input')); })()`);
  const visible = await insp.eval(`[...document.querySelectorAll('#rows tr.row:not(.hidden)')].map((tr) => tr.children[3].textContent)`);
  assert.ok(visible.length >= 2 && visible.every((c) => c === 'dialog.open'), `filter keeps only dialog.open rows: ${visible}`);
  const seqs = await insp.eval(`[...document.querySelectorAll('#rows tr.row')].map((tr) => tr.dataset.seq)`);
  assert.equal(new Set(seqs).size, seqs.length, 'no row is shown twice');
  await insp.eval(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
  // live: a new invoke shows up; pause stops the view; clear empties it
  const before = await insp.eval(`document.querySelectorAll('#rows tr.row').length`);
  await appWin.eval(`window.vmapp.invoke('echo', 'live')`);
  await waitFor(() => insp.eval(`document.querySelectorAll('#rows tr.row').length >= ${before + 2}`), { what: 'live rows' });
  await click(insp, '#btn-pause');
  const paused = await insp.eval(`document.querySelectorAll('#rows tr.row').length`);
  await appWin.eval(`window.vmapp.invoke('echo', 'while paused')`);
  await sleep(500);
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row').length`), paused, 'paused view does not change');
  await click(insp, '#btn-pause');
  await insp.shot('06-inspector');
  // other tabs
  await click(insp, '[data-tab="log"]');
  await waitFor(() => insp.eval(`document.querySelectorAll('#log-events .ll').length > 0`), { what: 'core log events' });
  await waitFor(() => insp.eval(`document.getElementById('console-tail').textContent.length > 0`), { what: 'console log tail', timeout: 8000 }).catch(() => step('note: console log tail is empty (the app printed nothing)'));
  assert.match(await text(insp, '#log-events'), /core ready/);
  await insp.shot('07-inspector-log');
  await click(insp, '[data-tab="files"]');
  await insp.shot('08-inspector-files');
  await click(insp, '[data-tab="traffic"]');
  await insp.eval(`document.getElementById('btn-clear').click()`);
  await waitFor(() => insp.eval(`document.querySelectorAll('#rows tr.row').length === 0`), { what: 'cleared view' });

  // ---- stop via the library ----
  step('stop: from the library');
  const vmsRunning = testVms(home);
  assert.ok(vmsRunning.length >= 1, 'a vmapp-vm process runs for the app');
  const vmPids = vmsRunning.map((p) => p.pid);
  const loaderPid = A.pid;
  assert.ok(vmsRunning.every((p) => p.ppid === loaderPid), 'vmapp-vm is a child of the loader');
  const dataBefore = fs.readdirSync(path.join(home, 'data', ID));
  assert.ok(dataBefore.includes('state.txt'));
  await click(lib, appBtn('stop'));
  await waitFor(async () => (await cardState(lib)) === 'stopped', { what: 'card shows stopped', timeout: 30000 });
  await waitFor(() => vmPids.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), { what: 'vmapp-vm exited', timeout: 20000 });
  assert.equal(testVms(home).length, 0);
  await waitFor(async () => !(await targets()).some((t) => isApp(t.url)), { what: 'app windows closed' });
  await waitFor(() => vmCount() <= baseline, { what: `Virtualization VM processes back to baseline (${baseline})`, timeout: 15000 });
  assert.ok(!fs.existsSync(path.join(home, 'picks', ID)), 'file-pick clones removed when the app stopped');
  assert.ok(fs.existsSync(path.join(home, 'grants', `${ID}.json`)), 'grants are kept across stop');
  assert.equal(fs.readFileSync(saveTarget, 'utf8'), 'saved by the app');
  // inspector still shows the last run
  const stillThere = await insp.eval(`document.getElementById('app-select').value`);
  assert.equal(stillThere, ID);
  await lib.shot('09-library-stopped');

  // ---- reset ----
  step('reset: confirm text, data emptied, grants forgotten, user folders untouched');
  await click(lib, appBtn('reset'));
  await waitSel(lib, '[data-action="confirm-reset"]', 'reset confirmation');
  assert.equal(await text(lib, '.sheet .confirm-text'), 'Reset “Loader Test”? This deletes the app\'s data and forgets your folder choices. Your own folders are not touched.');
  await lib.shot('10-reset-confirm');
  await click(lib, '[data-action="confirm-reset"]');
  await waitFor(() => !fs.existsSync(path.join(home, 'grants', `${ID}.json`)), { what: 'grants deleted' });
  assert.deepEqual(fs.readdirSync(path.join(home, 'data', ID)), [], 'app data emptied');
  assert.ok(fs.existsSync(path.join(workDir, 'from-app.txt')) && fs.existsSync(path.join(workDir, 'seed.txt')), 'the user\'s own folder is untouched');
  assert.ok(fs.existsSync(path.join(home, 'apps', ID, '1.0.0', 'vmapp.json')), 'the app stays installed');
  await waitFor(async () => /not decided yet/.test(await text(lib, cardSel('[data-role="grants"]'))), { what: 'card shows undecided folders' });

  // ---- launch again: sheet again (reset forgot the choices); ask-every-time; the app quits by itself ----
  step('launch after reset: sheet again; ask every time; app quits itself');
  await click(lib, appBtn('launch'));
  await waitSel(lib, '[data-folder="work"]', 'sheet after reset');
  await click(lib, '[data-folder="work"] [data-action="choose"]');
  await waitFor(async () => (await text(lib, '[data-folder="work"] [data-role="path"]')) === workDir, { what: 'folder chosen again' });
  await lib.eval(`(() => { const s = document.querySelector('[data-folder="work"] select'); s.value = 'read'; s.dispatchEvent(new Event('change')); })()`);
  assert.match(await text(lib, '[data-folder="work"] .accessrow'), /read but not change/, 'downgrade is explained');
  await lib.eval(`document.getElementById('ask-every-time').click()`);
  await click(lib, '[data-action="sheet-launch"]');
  const g2 = await waitFor(() => {
    const f = path.join(home, 'grants', `${ID}.json`);
    return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8'));
  }, { what: 'grants saved (second run)' });
  assert.deepEqual(g2, { folders: { work: { path: workDir, access: 'read' }, extra: null }, askEveryTime: true }, 'downgraded access and "ask every time" are saved');
  const appWin2 = await waitTarget(isApp, 'app window (second run)', 90000);
  await waitFor(() => appWin2.eval('window.__hello !== null && window.__hello !== undefined'), { what: 'hello (second run)', timeout: 30000 });
  assert.match(await appWin2.eval(`window.vmapp.invoke('write-folder', 'work', 'denied.txt', 'x').then(() => 'written', (e) => e.message)`), /EROFS|read-only|EACCES|EPERM|permission/i, 'a downgraded folder is read only');
  assert.ok(!fs.existsSync(path.join(workDir, 'denied.txt')));
  const vms2 = testVms(home).map((p) => p.pid);
  assert.ok(vms2.length >= 1);
  await appWin2.eval(`window.vmapp.invoke('quit')`).catch(() => {});
  await waitFor(async () => (await cardState(lib)) === 'stopped', { what: 'card shows stopped after the app quit itself', timeout: 30000 });
  await waitFor(async () => !(await targets()).some((t) => isApp(t.url)), { what: 'app windows closed after quit' });
  await waitFor(() => vms2.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), { what: 'vmapp-vm exited after app.quit', timeout: 20000 });
  // ask every time: the sheet is shown again; cancel it
  await click(lib, appBtn('launch'));
  await waitSel(lib, '[data-action="sheet-launch"]', 'sheet because of ask-every-time');

  // too-broad folders: the home folder needs a second confirmation, / and the loader's data dir are refused outright
  step('permission sheet: too-broad folders (home declined, home confirmed, / refused, data dir refused)');
  const pathBefore = await text(lib, '[data-folder="work"] [data-role="path"]');
  assert.equal(pathBefore, workDir, 'the sheet starts with the previously chosen folder');
  const logLen = readDialogLog().length;
  await click(lib, '[data-folder="work"] [data-action="choose"]');
  await waitFor(() => readDialogLog().some((d, i) => i >= logLen && d.kind === 'broad-folder'), { what: 'home-folder warning shown' });
  assert.equal(await text(lib, '[data-folder="work"] [data-role="path"]'), workDir, 'declining the warning keeps the previous choice');
  await click(lib, '[data-folder="work"] [data-action="choose"]');
  await waitFor(async () => (await text(lib, '[data-folder="work"] [data-role="path"]')) === os.homedir(), { what: 'home folder chosen after the second confirm' });
  const broadLog = readDialogLog().filter((d, i) => i >= logLen && d.kind === 'broad-folder');
  assert.equal(broadLog.length, 2);
  assert.deepEqual(broadLog.map((d) => d.detail.answer), [false, true]);
  assert.equal(broadLog[0].detail.folder, os.homedir());
  assert.match(broadLog[0].detail.message, /Are you sure you want to share .* with “Loader Test”\?/);
  assert.deepEqual(broadLog[0].detail.buttons, ['Choose a different folder', 'Share this folder anyway'], 'the safe answer is the default');
  assert.match(broadLog[0].detail.reason, /whole home folder/);
  await click(lib, '[data-folder="work"] [data-action="choose"]'); // '/'
  await waitFor(() => readDialogLog().some((d) => d.detail.descr === 'folder-refused'), { what: 'root refused' });
  assert.equal(await text(lib, '[data-folder="work"] [data-role="path"]'), os.homedir(), 'refusing / leaves the previous choice');
  await click(lib, '[data-folder="work"] [data-action="choose"]'); // the data dir
  await sleep(500);
  assert.equal(await text(lib, '[data-folder="work"] [data-role="path"]'), os.homedir(), 'refusing the loader data dir leaves the previous choice');
  const refusals = readDialogLog().filter((d) => d.detail.descr === 'folder-refused');
  assert.equal(refusals.length, 2, 'two refusal dialogs (/ and the data dir)');
  assert.ok(!readDialogLog().some((d) => d.kind === 'broad-folder' && (d.detail.folder === '/' || d.detail.folder === home)), '/ and the data dir are refused, not offered with a warning');
  // and the renderer cannot smuggle a refused folder past the sheet
  const sneaky = await lib.eval(`window.loader.launchWithGrants(${JSON.stringify(ID)}, { work: { path: '/', access: 'read' } }, false).then(() => 'accepted', (e) => 'rejected: ' + e.message)`);
  assert.match(sneaky, /rejected|whole disk/, 'saving "/" as a grant is refused by the main process');
  assert.ok(!fs.existsSync(path.join(home, 'grants', `${ID}.json`)) || JSON.parse(fs.readFileSync(path.join(home, 'grants', `${ID}.json`), 'utf8')).folders.work.path !== '/');
  await click(lib, '[data-action="cancel"]');
  assert.equal(await cardState(lib), 'stopped');
  // Permissions button: edit without launching
  await click(lib, appBtn('permissions'));
  await waitSel(lib, '[data-action="sheet-save"]', 'permissions editor');
  await click(lib, '[data-action="cancel"]');
  // uninstall confirm (cancel), then really uninstall with "delete data"
  await click(lib, appBtn('uninstall'));
  await waitSel(lib, '[data-action="confirm-uninstall"]', 'uninstall confirmation');
  assert.equal(await exists(lib, '#purge-data'), true);
  await click(lib, '[data-action="cancel"]');
  assert.ok(fs.existsSync(path.join(home, 'apps', ID)), 'cancelled uninstall keeps the app');

  step('run A: quit the loader (stops nothing: no app is running)');
  dropConns();
  const exitA = await killLoader(A, 'SIGTERM');
  assert.ok(exitA.code === 0 || exitA.sig === 'SIGTERM' || exitA.code === null, `loader exited: ${JSON.stringify(exitA)}`);
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run A', timeout: 10000 });

  // =========================================================================================== run A2: quit with a running app
  step('run A2: quitting the loader stops a running app (before-quit, shutdown, windows closed)');
  const A2 = startLoader({
    home,
    name: 'loader-A2',
    env: { VMAPP_TEST_GRANTS: JSON.stringify({ [ID]: { work: { path: workDir, access: 'read' }, extra: null } }), VMAPP_TEST_DIALOGS: JSON.stringify({ message: 0 }) },
  });
  const libA2 = await waitTarget(isLibrary, 'library (A2)');
  await waitSel(libA2, `[data-app="${ID}"]`, 'card (A2)');
  await click(libA2, appBtn('launch'));
  await waitTarget(isApp, 'app window (A2)', 90000);
  const vmsA2 = testVms(home).map((p) => p.pid);
  assert.ok(vmsA2.length >= 1);
  dropConns();
  const tQuit = Date.now();
  const exitA2 = await killLoader(A2, 'SIGTERM', 30000);
  step(`loader quit took ${((Date.now() - tQuit) / 1000).toFixed(1)}s`);
  assert.notEqual(exitA2.code, 'timeout', 'loader quit within the time limit');
  assert.ok(Date.now() - tQuit < 14000, 'quit waits at most ~10 s for the apps');
  assert.ok(vmsA2.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), 'vmapp-vm gone after the loader quit');
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run A2', timeout: 10000 });

  // =========================================================================================== run B
  step('run B: VMAPP_TEST_GRANTS (no sheet), then kill -9 the loader');
  fs.rmSync(path.join(home, 'grants'), { recursive: true, force: true });
  const B = startLoader({
    home,
    name: 'loader-B',
    env: { VMAPP_TEST_GRANTS: JSON.stringify({ [ID]: { work: { path: workDir, access: 'read' }, extra: null } }), VMAPP_TEST_DIALOGS: JSON.stringify({ message: 0 }) },
  });
  const libB = await waitTarget(isLibrary, 'library (B)');
  await waitSel(libB, `[data-app="${ID}"]`, 'card (B)');
  await click(libB, appBtn('launch'));
  await sleep(300);
  assert.equal(await exists(libB, '.sheet'), false, 'no sheet with pre-seeded grants');
  const appB = await waitTarget(isApp, 'app window (B)', 90000);
  await waitFor(() => appB.eval('window.__hello !== null && window.__hello !== undefined'), { what: 'hello (B)', timeout: 30000 });
  assert.deepEqual(await appB.eval(`window.vmapp.invoke('folders')`), { work: '/host/f-work', extra: null });
  const vmsB = testVms(home).map((p) => p.pid);
  assert.ok(vmsB.length >= 1, 'VM running');
  dropConns();
  step(`kill -9 loader (pid ${B.pid}); VM pids ${vmsB}`);
  process.kill(B.pid, 'SIGKILL');
  await B.exited;
  await waitFor(() => vmsB.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), { what: 'vmapp-vm followed its parent', timeout: 25000 });
  await waitFor(() => vmCount() <= baseline, { what: `Virtualization VM processes back to baseline (${baseline})`, timeout: 20000 });
  step('run B: the VM is gone after kill -9');

  await runC(baseline);
  await runD(baseline);
  await runE(baseline);
  await runF(baseline);
  await runG(baseline);
  await runH(baseline);
  await runI();
  await runJ();
  await runK();
  await runKR();
  await runL();
  await runM();
  await runW();
  await runU();
  await runY();

  step('ALL PASSED');
}

// =============================================================================================== run C: versions and updates
// A REAL registry (registry/server.js on a free port, data under the scratch folder) serves four builds of the fixture app. The
// loader installs 1.0.0 from it through the UI, then: "Latest compatible" launch -> 1.1.0 (not 2.0.0); a build that
// asks for an extra folder -> the "asks for more" sheet, Keep -> still 1.1.0; withdrawn reason on the card; Versions…
// (registry list, Use this version with the older-version confirmation); Install this version; offline launch.
async function runC(baseline) {
  step('run C: versions and updates against the real registry');
  const regData = path.join(ROOT, 'registry-data');
  const homeC = path.join(ROOT, 'home-c');
  const variants = path.join(ROOT, 'variants');
  const workC = path.join(ROOT, 'user-c', 'work');
  fs.mkdirSync(workC, { recursive: true });
  fs.mkdirSync(variants, { recursive: true });

  const variant = (version, extraFolders = []) => {
    const dir = path.join(variants, `v${version}`);
    fs.cpSync(path.join(LOADER, 'test', 'fixture-app'), dir, { recursive: true });
    const mf = path.join(dir, 'vmapp.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.version = version;
    m.permissions.folders.push(...extraFolders);
    fs.writeFileSync(mf, JSON.stringify(m, null, 2));
    const file = path.join(variants, `${version}.vmapp`);
    hostlib.pack(dir, file);
    return file;
  };
  const builds = {
    '1.0.0': variant('1.0.0'),
    '1.1.0': variant('1.1.0'),
    // the real registry only accepts increasing versions, so the build that asks for more comes after 2.0.0
    '2.1.0': variant('2.1.0', [{ name: 'photos', access: 'read', purpose: 'Pictures to show' }]),
    '2.0.0': variant('2.0.0'),
  };

  // ---- the registry ----
  const regProc = spawn(process.execPath, [path.join(VMAPP, 'registry', 'server.js'), '--port', '0', '--data', regData, '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(regProc);
  const regUrl = await new Promise((resolve, reject) => {
    let buf = '';
    regProc.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on (http:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    regProc.once('exit', () => reject(new Error('the registry exited before it was listening')));
    setTimeout(() => reject(new Error('registry did not start')), 15000);
  });
  step(`registry at ${regUrl}`);
  let ownerToken = null;
  const publish = async (version) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
    const res = await fetch(`${regUrl}/api/publish`, { method: 'POST', headers, body: fs.readFileSync(builds[version]) });
    const j = await res.json();
    assert.equal(res.status, 201, `publish ${version}: ${JSON.stringify(j)}`);
    if (j.ownerToken) ownerToken = j.ownerToken;
  };
  const withdraw = async (version, reason) => {
    const res = await fetch(`${regUrl}/api/apps/${ID}/${version}/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ reason }) });
    assert.equal(res.status, 200, `withdraw ${version}`);
  };
  await publish('1.0.0');

  // ---- helpers ----
  const appDir = path.join(homeC, 'apps', ID);
  const current = () => (fs.existsSync(path.join(appDir, 'current')) ? fs.readFileSync(path.join(appDir, 'current'), 'utf8').trim() : null);
  const policyFile = () => (fs.existsSync(path.join(appDir, 'policy.json')) ? JSON.parse(fs.readFileSync(path.join(appDir, 'policy.json'), 'utf8')).update : 'manual');
  const setValue = (c, sel, v) => c.eval(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const sheetText = (c) => c.eval(`(document.querySelector('.sheet') || {}).textContent || ''`);
  const bannerText = (c) => c.eval(`(document.getElementById('banners') || {}).textContent || ''`);
  const appVersion = async () => {
    const w = await waitTarget(isApp, 'app window (C)', 90000);
    await waitFor(() => w.eval('window.__hello !== null && window.__hello !== undefined'), { what: 'hello (C)', timeout: 30000 });
    return (await w.eval('window.vmapp.app')).version;
  };
  const stopApp = async (lib) => {
    await click(lib, appBtn('stop'));
    await waitFor(async () => (await cardState(lib)) === 'stopped', { what: 'app stopped (C)', timeout: 30000 });
  };

  const C = startLoader({
    home: homeC,
    name: 'loader-C',
    env: {
      VMAPP_REGISTRY: regUrl,
      VMAPP_TEST_GRANTS: JSON.stringify({ [ID]: { work: { path: workC, access: 'read' }, extra: null } }),
      VMAPP_TEST_DIALOGS: JSON.stringify({ message: 0 }),
    },
  });
  const lib = await waitTarget(isLibrary, 'library (C)');
  await waitSel(lib, '[data-role="empty"]', 'empty library (C)');

  // ---- install 1.0.0 from the registry through the UI (by pasting the app's page address) ----
  step('C: Browse registry… → Install on the app’s card (review "from <registry>")');
  await click(lib, '#btn-browse-registry');
  await waitSel(lib, '[data-role="browse"]', 'Browse sheet (C)');
  assert.equal(await text(lib, '[data-role="browse-registry"]'), regUrl, 'the registry is the loader’s own (VMAPP_REGISTRY)');
  await lib.shot('10-registry-dialog');
  await lib.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'Browse sheet closed (C)' });
  await browseInstall(lib, ID, 'C');
  await waitSel(lib, '[data-role="review"]', 'registry install review', 30000);
  const rv = await sheetText(lib);
  assert.match(rv, /Loader Test 1\.0\.0/);
  assert.match(rv, new RegExp(`from ${regUrl.replace(/[.:/]/g, '\\$&')}`), 'the review says where it comes from');
  assert.match(rv, /[0-9a-f]{64}/);
  await lib.shot('11-registry-review');
  assert.ok(!fs.existsSync(appDir), 'nothing is installed before the user confirms');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${ID}"]`, 'app card (C)');
  assert.equal(current(), '1.0.0');
  const src = JSON.parse(fs.readFileSync(path.join(appDir, 'source.json'), 'utf8'));
  assert.deepEqual(src, { registry: regUrl, id: ID, installedFrom: '1.0.0' });
  assert.equal(policyFile(), 'manual', 'the default is "Stay on this version"');
  assert.deepEqual(fs.readdirSync(path.join(homeC, 'tmp')), [], 'the download is deleted after the install');
  assert.equal(await lib.eval(`document.querySelector('[data-app="${ID}"] [data-role="policy"]').disabled`), false, 'the update choice is enabled for a registry app');
  assert.equal(await lib.eval(`document.querySelector('[data-app="${ID}"] [data-role="policy"]').value`), 'manual');
  assert.match(await text(lib, cardSel('[data-role="source"]')), new RegExp(`from ${regUrl.replace(/[.:/]/g, '\\$&')}`));

  // ---- Latest compatible: launch runs 1.1.0, not 2.0.0 ----
  step('C: "Latest compatible" -> Launch installs 1.1.0 (not 2.0.0) and runs it');
  await setValue(lib, cardSel('[data-role="policy"]'), 'compatible');
  await waitFor(() => policyFile() === 'compatible', { what: 'policy saved' });
  await publish('1.1.0');
  await publish('2.0.0');
  await click(lib, appBtn('launch'));
  assert.equal(await appVersion(), '1.1.0', 'runs the latest compatible version');
  assert.equal(current(), '1.1.0');
  assert.deepEqual(fs.readdirSync(path.join(appDir)).filter((n) => /^\d/.test(n)).sort(), ['1.0.0', '1.1.0'], '2.0.0 was never installed');
  await waitFor(async () => /Updated Loader Test to 1\.1\.0/.test(await bannerText(lib)), { what: 'Updated note' });
  assert.match(await text(lib, cardSel('[data-role="notice"]')), /Updated to 1\.1\.0/);
  assert.deepEqual(fs.readdirSync(path.join(homeC, 'tmp')), []);
  await lib.shot('12-updated');
  await stopApp(lib);

  // ---- a build that asks for more ----
  step('C: "Always latest": 2.1.0 asks for an extra folder -> "asks for more" sheet; Keep -> still 1.1.0');
  await setValue(lib, cardSel('[data-role="policy"]'), 'latest');
  await waitFor(() => policyFile() === 'latest', { what: 'policy latest (C)' });
  await publish('2.1.0');
  await click(lib, appBtn('launch'));
  await waitSel(lib, '[data-role="asks-more"]', 'asks-for-more sheet', 30000);
  const more = await sheetText(lib);
  assert.match(more, /Version 2\.1\.0 asks for more:/);
  assert.match(more, /A new folder: “photos” \(read only\)/);
  assert.match(more, /Pictures to show/);
  assert.doesNotMatch(more, /dialogs|links in your browser/, 'only what is new is listed');
  assert.equal(current(), '1.1.0', 'nothing changes before the user decides');
  await lib.shot('13-asks-for-more');
  assert.equal(await exists(lib, '[data-action="update-review"]'), true);
  await click(lib, '[data-action="keep-version"]');
  assert.equal(await appVersion(), '1.1.0', 'Keep launches the current version');
  assert.equal(current(), '1.1.0');
  assert.deepEqual(fs.readdirSync(path.join(homeC, 'tmp')), [], 'the discarded download is deleted');
  await stopApp(lib);

  // ---- withdrawn current version, then Update and review permissions ----
  step('C: a withdrawn current version shows its reason; Check for updates -> asks for more -> Update and review permissions');
  await withdraw('1.1.0', 'corrupts notes on save');
  await click(lib, appBtn('check-updates'));
  await waitSel(lib, '[data-role="asks-more"]', 'asks-for-more sheet (check)', 30000);
  assert.match(await text(lib, cardSel('[data-role="withdrawn"]')), /Version 1\.1\.0 was withdrawn by its publisher: corrupts notes on save/);
  assert.match(await sheetText(lib), /Version 2\.1\.0 asks for more:/);
  await click(lib, '[data-action="update-review"]');
  await waitSel(lib, '[data-role="folders"] [data-folder="photos"]', 'permission sheet with the new folder', 20000);
  assert.equal(current(), '2.1.0');
  assert.equal(await exists(lib, '[data-action="sheet-save"]'), true, 'opened as the normal permission sheet');
  await click(lib, '[data-action="cancel"]');
  assert.deepEqual(fs.readdirSync(path.join(appDir)).filter((n) => /^\d/.test(n)).sort(), ['1.0.0', '1.1.0', '2.1.0']);

  // ---- Versions… ----
  step('C: Versions… (installed + registry list), Use this version with the older-version confirmation');
  await click(lib, appBtn('versions'));
  await waitSel(lib, '[data-role="versions"]', 'versions modal');
  const vt = await text(lib, '[data-role="installed-versions"]');
  assert.match(vt, /2\.1\.0.*current/s);
  assert.match(vt, /1\.1\.0/);
  assert.match(vt, /1\.0\.0/);
  assert.equal(await exists(lib, '[data-role="registry-list"]'), false, 'the registry is not contacted until the user asks');
  await click(lib, '[data-action="show-registry-versions"]');
  await waitSel(lib, '[data-role="registry-list"]', 'registry versions');
  const rt = await text(lib, '[data-role="registry-list"]');
  assert.match(rt, /2\.0\.0/);
  assert.match(rt, /Withdrawn by the publisher: corrupts notes on save/);
  assert.equal(await exists(lib, '[data-role="registry-list"] [data-action="install-version"][data-version="2.0.0"]'), true);
  assert.equal(await exists(lib, '[data-role="registry-list"] [data-action="install-version"][data-version="1.1.0"]'), false, 'installed versions have no install button');
  await lib.shot('14-versions');
  await click(lib, '[data-role="installed-versions"] [data-action="use-version"][data-version="1.0.0"]');
  await waitSel(lib, '[data-role="older-warning"]', 'older-version confirmation');
  assert.match(await sheetText(lib), /Going back to an older version.*shares its app data.*may not be able to read data written by the newer version/s);
  assert.match(await sheetText(lib), /Stay on this version/);
  assert.equal(current(), '2.1.0', 'nothing changes before the user confirms');
  await click(lib, '[data-action="confirm-older"]');
  await waitFor(() => current() === '1.0.0', { what: 'switched back to 1.0.0' });
  assert.equal(policyFile(), 'manual', 'going back turns automatic updates off, so it does not jump forward again');
  assert.equal(await lib.eval(`document.querySelector('[data-app="${ID}"] [data-role="policy"]').value`), 'manual');
  assert.match(await text(lib, `[data-app="${ID}"] .version`), /1\.0\.0/);

  // ---- Install this version (registry) ----
  step('C: Install this version (2.0.0) from the registry list');
  await click(lib, appBtn('versions'));
  await waitSel(lib, '[data-role="versions"]', 'versions modal (2)');
  await click(lib, '[data-action="show-registry-versions"]');
  await waitSel(lib, '[data-role="registry-list"] [data-action="install-version"][data-version="2.0.0"]', 'install button');
  await click(lib, '[data-role="registry-list"] [data-action="install-version"][data-version="2.0.0"]');
  await waitSel(lib, '[data-role="review"]', 'review of 2.0.0', 30000);
  assert.match(await sheetText(lib), /Loader Test 2\.0\.0/);
  await click(lib, '[data-action="confirm-install"]');
  await waitFor(() => current() === '2.0.0', { what: 'installed 2.0.0' });
  assert.equal(policyFile(), 'manual');
  assert.deepEqual(fs.readdirSync(path.join(homeC, 'tmp')), []);

  // ---- offline ----
  step('C: registry offline -> Launch runs the current version with an inline notice');
  await setValue(lib, cardSel('[data-role="policy"]'), 'latest');
  await waitFor(() => policyFile() === 'latest', { what: 'policy latest' });
  regProc.kill('SIGKILL');
  await new Promise((r) => regProc.once('exit', r));
  await click(lib, appBtn('launch'));
  assert.equal(await appVersion(), '2.0.0', 'launches what is installed');
  await waitFor(async () => /Could not check for updates/.test((await text(lib, cardSel('[data-role="notice"]'))) || ''), { what: 'offline notice' });
  await lib.shot('15-offline-notice');
  await stopApp(lib);

  dropConns();
  await killLoader(C, 'SIGTERM', 30000);
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run C', timeout: 15000 });
  step('run C passed');
}

// =============================================================================================== run D: developer and publishing
// "Run project folder…" (picker through VMAPP_TEST_DIALOGS, a fixture project copied to a scratch folder), the card's
// "Developer build from <folder>" badge and "Rebuild & run" (the test edits its copy between builds), then "Publish…"
// against the REAL registry (registry/server.js on a free port, data under the scratch folder): a first publish (owner token shown once
// and saved 0600), a second version with the saved token, and the friendly texts for 409 / 401 / 403.
async function runD(baseline) {
  step('run D: Run project folder…, Rebuild & run, Publish… against the real registry');
  const DID = 'com.vmapp.devproject';
  const homeD = path.join(ROOT, 'home-d');
  const regData = path.join(ROOT, 'registry-data-d');
  const scratch = path.join(ROOT, 'dev-scratch');
  const proj = path.join(scratch, 'my-dev-app');
  const notProject = path.join(scratch, 'not-a-project');
  const noCore = path.join(scratch, 'no-core');
  const workD = path.join(ROOT, 'user-d', 'work');
  for (const d of [notProject, workD, path.join(noCore, 'ui')]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(LOADER, 'test', 'fixture-project'), proj, { recursive: true });
  fs.copyFileSync(path.join(proj, 'vmapp.json'), path.join(noCore, 'vmapp.json'));
  fs.writeFileSync(path.join(noCore, 'ui', 'index.html'), '<!doctype html><title>x</title>');

  const isAppD = (u) => u.startsWith(`vmapp-ui://${DID}/`);
  const dCard = (sel) => `[data-app="${DID}"] ${sel}`;
  const dState = (c) => c.eval(`(document.querySelector('[data-app="${DID}"]') || {dataset:{}}).dataset.state || null`);
  const setVal = (c, sel, v) => c.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('no element ' + ${q(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const banners = (c) => c.eval(`(document.getElementById('banners') || {}).textContent || ''`);
  const clearBanners = (c) => c.eval(`(() => { document.querySelectorAll('#banners .banner button').forEach((b) => b.click()); return true; })()`);
  const dialogLogD = path.join(ROOT, 'dialogs-d.jsonl');
  const readLogD = () => (fs.existsSync(dialogLogD) ? fs.readFileSync(dialogLogD, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const editScratch = (file, from, to) => {
    const f = path.join(proj, file);
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(s.includes(from), `${file} contains ${from}`);
    fs.writeFileSync(f, s.replace(from, to));
  };
  const appDirD = path.join(homeD, 'apps', DID);
  const marker = async () => {
    const w = await waitTarget(isAppD, 'dev app window', 90000);
    return w.eval(`window.vmapp.invoke('marker')`);
  };
  const waitMarker = async (want, what) => {
    await waitFor(async () => (await marker()) === want, { what, timeout: 90000, interval: 500 });
    const w = await waitTarget(isAppD, 'dev app window');
    return w;
  };

  // ---- the registry ----
  const regProc = spawn(process.execPath, [path.join(VMAPP, 'registry', 'server.js'), '--port', '0', '--data', regData, '--quiet', '--publish-per-hour', '100'], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(regProc);
  const regUrl = await new Promise((resolve, reject) => {
    let buf = '';
    regProc.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on (http:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    regProc.once('exit', () => reject(new Error('the registry exited before it was listening')));
    setTimeout(() => reject(new Error('registry did not start')), 15000);
  });
  step(`registry at ${regUrl}`);

  const D = startLoader({
    home: homeD,
    name: 'loader-D',
    env: {
      VMAPP_REGISTRY: regUrl,
      VMAPP_TEST_DIALOGS: JSON.stringify({ open: [notProject, noCore, proj, workD], external: true, message: 0 }),
      VMAPP_TEST_DIALOG_LOG: dialogLogD,
    },
  });
  const lib = await waitTarget(isLibrary, 'library (D)');
  await waitSel(lib, '[data-role="empty"]', 'empty library (D)');
  assert.equal(await text(lib, '[data-action="install"]'), 'Install from file…', 'the install button says where the package comes from');
  assert.equal(await text(lib, '[data-action="run-folder"]'), 'Run project folder…');
  assert.match(await text(lib, '[data-role="empty"]'), /“Install from file…”/);

  // ---- not a project / a broken project: precise errors, nothing installed ----
  step('D: a folder that is not a project, and one that cannot be packed -> errors shown verbatim, nothing installed');
  await click(lib, '[data-action="run-folder"]');
  await waitFor(async () => /is not a D9010 VmApp project: there is no vmapp\.json in it/.test(await banners(lib)), { what: 'not-a-project error' });
  assert.ok((await banners(lib)).includes(notProject), 'the error names the folder');
  await clearBanners(lib);
  await click(lib, '[data-action="run-folder"]');
  await waitFor(async () => (await banners(lib)).includes(`core folder not found: ${path.join(noCore, 'core')}`), { what: 'packaging error shown verbatim' });
  await lib.shot('16-run-folder-error');
  await clearBanners(lib);
  assert.equal(await exists(lib, `[data-app="${DID}"]`), false, 'nothing was installed');
  assert.equal(fs.existsSync(appDirD), false);
  assert.deepEqual(fs.existsSync(path.join(homeD, 'tmp')) ? fs.readdirSync(path.join(homeD, 'tmp')) : [], [], 'no build files left behind');

  // ---- Run project folder… ----
  step('D: Run project folder… -> pack, install as a developer build, permission sheet, launch');
  await click(lib, '[data-action="run-folder"]');
  await waitSel(lib, '[data-role="folders"] [data-folder="work"]', 'permission sheet of the dev build', 60000);
  await lib.shot('17-dev-permission-sheet');
  await click(lib, '[data-folder="work"] [data-action="choose"]');
  await waitFor(async () => (await text(lib, '[data-folder="work"] [data-role="path"]')) === workD, { what: 'work folder chosen (D)' });
  await click(lib, '[data-action="sheet-launch"]');
  assert.match(await text(lib, dCard('[data-role="dev-badge"]')), /^Developer build from my-dev-app$/, 'the card says where the build came from');
  assert.equal(await lib.eval(`document.querySelector(${q(dCard('[data-role="dev-badge"]'))}).title`), proj, 'the badge’s tooltip is the full path');
  assert.equal(await exists(lib, dCard('[data-action="rebuild"]')), true, 'Rebuild & run is on the card');
  assert.equal(await text(lib, dCard('[data-action="rebuild"]')), 'Rebuild & run');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appDirD, 'dev.json'), 'utf8')), { path: proj });
  assert.ok(fs.existsSync(path.join(appDirD, 'pkg', '0.1.0.vmapp')), 'the package file is kept for Publish');
  assert.deepEqual(fs.readdirSync(path.join(homeD, 'tmp')), [], 'the dev build file in tmp/ is removed after the install');
  const w1 = await waitMarker('first build', 'first build runs');
  assert.equal(await w1.eval(`document.getElementById('ui-marker').textContent`), 'UI first build');
  assert.deepEqual(await w1.eval(`window.vmapp.invoke('echo', 1, 'two')`), [1, 'two'], 'invoke round trip');
  assert.equal(await dState(lib), 'running');
  await lib.shot('18-dev-build-card');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeD, 'grants', `${DID}.json`), 'utf8')).folders, { work: { path: workD, access: 'read' } });

  // ---- Rebuild & run (while running) ----
  step('D: edit the project, Rebuild & run (stops the running app first) picks up the change; grants are kept');
  editScratch(path.join('core', 'main.js'), "'first build'", "'second build'");
  editScratch(path.join('ui', 'index.html'), 'UI first build', 'UI second build');
  const vmsBefore = testVms(homeD).map((p) => p.pid);
  assert.ok(vmsBefore.length >= 1);
  await click(lib, dCard('[data-action="rebuild"]'));
  const w2 = await waitMarker('second build', 'second build runs');
  assert.equal(await w2.eval(`document.getElementById('ui-marker').textContent`), 'UI second build', 'the UI change is served too');
  assert.ok(vmsBefore.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), 'the first VM was stopped by the rebuild');
  assert.equal(await exists(lib, '[data-action="sheet-launch"]'), false, 'no permission sheet again: the folder choice is kept');
  assert.match(await banners(lib), /Built Dev Project 0\.1\.0 from the project folder/);
  assert.equal(fs.readFileSync(path.join(appDirD, 'current'), 'utf8').trim(), '0.1.0');
  assert.deepEqual(fs.readdirSync(path.join(homeD, 'tmp')), []);

  // ---- Publish…: first publish ----
  step('D: Publish… (first publish): sheet, publisher fields, owner token shown once and saved 0600');
  await clearBanners(lib);
  await click(lib, dCard('[data-action="publish"]'));
  await waitSel(lib, '[data-role="publish"]', 'publish sheet');
  await waitFor(async () => (await lib.eval(`document.querySelector('[data-role="publish-registry"]').value`)) === regUrl, { what: 'registry prefilled from the configured default' });
  assert.equal(await lib.eval(`document.querySelector('[data-role="publish-token"]').value`), '', 'no token yet');
  assert.equal(await lib.eval(`document.querySelector('[data-role="publish-token"]').type`), 'password', 'the token is hidden by default');
  assert.equal(await lib.eval(`getComputedStyle(document.querySelector('[data-role="publisher-fields"]')).display`), 'grid', 'publisher fields are shown on a first publish');
  assert.match(await text(lib, '[data-role="publisher-fields"]'), /Only sent now, on the first publish.*shows none of it until you verify.*docs\/DISTRIBUTING\.md/s);
  assert.match(await text(lib, '[data-role="publish-token-state"]'), /first publish of this app id/);
  assert.equal((await text(lib, '[data-role="publish-insecure"]')) || '', '', 'a loopback http registry is no warning');
  assert.match(await text(lib, '[data-role="publish"]'), /uploads the installed package of “Dev Project” 0\.1\.0.*developer build from my-dev-app/s);
  // a plain-http registry on the network gets the dev-only warning (the field change contacts nothing)
  await setVal(lib, '[data-role="publish-registry"]', 'http://192.0.2.1:8790');
  await waitFor(async () => /plain http.*development only/.test(await text(lib, '[data-role="publish-insecure"]')), { what: 'plain-http warning' });
  await setVal(lib, '[data-role="publish-registry"]', regUrl);
  await waitFor(async () => !(await text(lib, '[data-role="publish-insecure"]')), { what: 'warning gone again' });
  await setVal(lib, '[data-role="publisher-name"]', 'Dev Tester');
  await setVal(lib, '[data-role="publisher-company"]', 'Test Co');
  await setVal(lib, '[data-role="publisher-email"]', 'dev@example.com');
  await lib.shot('19-publish-sheet');
  await click(lib, '[data-action="publish-go"]');
  await waitSel(lib, '[data-role="publish-result"]', 'publish result', 60000);
  const ownerToken = await text(lib, '[data-role="owner-token"]');
  assert.match(ownerToken, /^[0-9a-f]{64}$/, 'the owner token is shown');
  assert.equal(await text(lib, '[data-role="page-url"]'), `${regUrl}/apps/${DID}`);
  assert.match(await text(lib, '[data-role="token-note"]'), /Saved to this Mac.*publish-tokens\.json.*readable only by you.*Keep a copy/s);
  await lib.shot('20-published');
  const tokensFile = path.join(homeD, 'publish-tokens.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(tokensFile, 'utf8')), { [regUrl]: { [DID]: ownerToken } }, 'saved in the CLI’s file format');
  assert.equal(fs.statSync(tokensFile).mode & 0o777, 0o600);
  const apiApp = await (await fetch(`${regUrl}/api/apps/${DID}`)).json();
  assert.equal(apiApp.latestVersion, '0.1.0');
  const mine = await (await fetch(`${regUrl}/api/publisher/me`, { headers: { Authorization: `Bearer ${ownerToken}` } })).text();
  assert.match(mine, /Dev Tester/, 'the publisher fields were sent on the first publish');
  // copy and open the page (both loader-owned; the open asks first)
  await click(lib, '[data-action="copy-token"]');
  await waitFor(() => readLogD().some((d) => d.kind === 'copy' && d.detail.length === 64), { what: 'copy asked the clipboard' });
  assert.equal(await text(lib, '[data-action="copy-token"]'), 'Copied');
  await click(lib, '[data-action="open-page"]');
  await waitFor(() => readLogD().some((d) => d.kind === 'openExternal' && d.detail === `${regUrl}/apps/${DID}`), { what: 'page opened after the confirmation' });
  const confirmLog = readLogD().find((d) => d.kind === 'open-page');
  assert.equal(confirmLog.detail.message, `Open ${regUrl}/apps/${DID} in your browser?`);
  // the renderer cannot make the loader open an address it did not just get from a publish
  assert.match(await lib.eval(`window.loader.openPage('https://example.com/').then(() => 'opened', (e) => e.message)`), /not one this loader just published to/);
  assert.equal(readLogD().filter((d) => d.kind === 'openExternal').length, 1);
  await click(lib, '[data-action="publish-done"]');
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-D.log'), 'utf8').includes(ownerToken), 'the token never reaches the loader log');

  // ---- second version through Rebuild, with the saved token ----
  step('D: bump the version, Rebuild & run, Publish… uses the saved token -> 201; no new token');
  editScratch('vmapp.json', '"version": "0.1.0"', '"version": "0.2.0"');
  await click(lib, dCard('[data-action="rebuild"]'));
  await waitFor(() => fs.existsSync(path.join(appDirD, 'pkg', '0.2.0.vmapp')), { what: '0.2.0 installed' });
  await waitMarker('second build', 'second build runs again');
  await waitFor(async () => /^0\.2\.0$/.test((await text(lib, dCard('.version'))) || ''), { what: 'card shows 0.2.0' });
  await clearBanners(lib);
  await click(lib, dCard('[data-action="publish"]'));
  await waitSel(lib, '[data-role="publish"]', 'publish sheet (2)');
  await waitFor(async () => (await lib.eval(`document.querySelector('[data-role="publish-registry"]').value`)) === regUrl, { what: 'registry (2)' });
  await waitFor(async () => (await lib.eval(`document.querySelector('[data-role="publish-token"]').value`)) === ownerToken, { what: 'the saved token is prefilled' });
  assert.equal(await lib.eval(`getComputedStyle(document.querySelector('[data-role="publisher-fields"]')).display`), 'none', 'no publisher fields once a token is present');
  assert.match(await text(lib, '[data-role="publish-token-state"]'), /Owner token found on this Mac/);
  await lib.shot('21-publish-sheet-second');
  await click(lib, '[data-action="publish-go"]');
  await waitSel(lib, '[data-role="publish-result"]', 'publish result (2)', 60000);
  assert.equal(await exists(lib, '[data-role="owner-token"]'), false, 'a later version shows no new token');
  assert.match(await text(lib, '[data-role="publish-result"]'), /Dev Project 0\.2\.0|com\.vmapp\.devproject 0\.2\.0/);
  assert.equal((await (await fetch(`${regUrl}/api/apps/${DID}`)).json()).latestVersion, '0.2.0');
  assert.deepEqual((await (await fetch(`${regUrl}/api/apps/${DID}/versions`)).json()).map((v) => v.version).sort(), ['0.1.0', '0.2.0']);
  await click(lib, '[data-action="publish-done"]');

  // ---- friendly errors ----
  step('D: Publish… the same version again -> 409 text; empty token -> 401 text; wrong token -> 403 text');
  await click(lib, dCard('[data-action="publish"]'));
  await waitSel(lib, '[data-role="publish"]', 'publish sheet (3)');
  await waitFor(async () => (await lib.eval(`document.querySelector('[data-role="publish-token"]').value`)) === ownerToken, { what: 'token prefilled (3)' });
  await click(lib, '[data-action="publish-go"]');
  await waitFor(async () => /version already exists.*Raise the version in vmapp\.json/s.test((await text(lib, '[data-role="publish-error"]')) || ''), { what: '409 text', timeout: 30000 });
  await lib.shot('22-publish-409');
  assert.equal(await lib.eval(`document.querySelector('[data-action="publish-go"]').disabled`), false, 'the sheet stays open and can be retried');
  await setVal(lib, '[data-role="publish-token"]', '');
  await click(lib, '[data-action="publish-go"]');
  await waitFor(async () => /already published and no owner token was sent/.test((await text(lib, '[data-role="publish-error"]')) || ''), { what: '401 text', timeout: 30000 });
  await setVal(lib, '[data-role="publish-token"]', 'e'.repeat(64));
  await click(lib, '[data-action="publish-go"]');
  await waitFor(async () => /does not own this app id/.test((await text(lib, '[data-role="publish-error"]')) || ''), { what: '403 text', timeout: 30000 });
  assert.deepEqual((await (await fetch(`${regUrl}/api/apps/${DID}/versions`)).json()).map((v) => v.version).sort(), ['0.1.0', '0.2.0'], 'nothing new was published by the failed attempts');
  assert.deepEqual(JSON.parse(fs.readFileSync(tokensFile, 'utf8')), { [regUrl]: { [DID]: ownerToken } }, 'a failed publish does not overwrite the saved token');
  await click(lib, '[data-action="cancel"]');

  // ---- the developer marker survives a restart; a vanished project folder is reported ----
  step('D: stop; the developer build survives a restart of the loader; a vanished project folder is reported');
  await click(lib, dCard('[data-action="stop"]'));
  await waitFor(async () => (await dState(lib)) === 'stopped', { what: 'dev app stopped', timeout: 30000 });
  dropConns();
  await killLoader(D, 'SIGTERM', 30000);
  const D2 = startLoader({ home: homeD, name: 'loader-D2', env: { VMAPP_REGISTRY: regUrl, VMAPP_TEST_DIALOGS: JSON.stringify({ message: 0 }) } });
  const lib2 = await waitTarget(isLibrary, 'library (D2)');
  await waitSel(lib2, `[data-app="${DID}"]`, 'dev card after restart');
  assert.match(await text(lib2, dCard('[data-role="dev-badge"]')), /Developer build from my-dev-app/);
  // the project folder disappears -> Rebuild & run says so
  const gone = proj + '-moved';
  fs.renameSync(proj, gone);
  await click(lib2, dCard('[data-action="rebuild"]'));
  await waitFor(async () => /project folder .* no longer exists/.test(await banners(lib2)), { what: 'missing folder message' });
  fs.renameSync(gone, proj);
  dropConns();
  await killLoader(D2, 'SIGTERM', 30000);
  regProc.kill('SIGTERM');
  await new Promise((r) => regProc.once('exit', r));
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run D', timeout: 15000 });
  step('run D passed');
}

// =============================================================================================== run E: host capabilities
/**
 * Starts an install from the loader's registry the way a user does it now (there is no "Install from registry…" dialog): Browse registry…,
 * find the card by its id, press Install. The ordinary install review follows (`[data-role="review"]`), exactly as for any other install.
 */
async function browseInstall(c, id, what) {
  await click(c, '#btn-browse-registry');
  await waitSel(c, '[data-role="browse"]', `Browse sheet (${what})`);
  await setIn(c, '[data-role="browse-query"]', id);
  await click(c, '[data-action="browse-search"]');
  await waitFor(async () => !((await text(c, '[data-role="browse-status"]')) || '').startsWith('Asking the registry'), { what: `the registry answered (${what})`, timeout: 30000 });
  await waitSel(c, `[data-browse-app="${id}"] [data-action="browse-install"]`, `the card of ${id} (${what})`, 30000);
  await click(c, `[data-browse-app="${id}"] [data-action="browse-install"]`);
}
const setIn = (c, sel, v) => c.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('no element ' + ${q(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const setChecked = (c, sel, on) => c.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('no element ' + ${q(sel)}); if (e.checked !== ${!!on}) e.click(); return e.checked; })()`);
/** A 2x screenshot of the page's visible area (device scale 2), named 2x-<name>.png. */
async function shot2x(c, name) {
  const m = await c.send('Page.getLayoutMetrics');
  const vp = m.cssVisualViewport || m.visualViewport;
  const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: Math.ceil(vp.clientWidth), height: Math.ceil(vp.clientHeight), scale: 2 } });
  fs.mkdirSync(SHOTS, { recursive: true });
  const f = path.join(SHOTS, `2x-${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  step(`screenshot ${path.relative(VMAPP, f)}`);
  return f;
}

async function runE(baseline) {
  step('run E: host capabilities (fake hostctl, dry-run input, scripted confirmations)');
  const EID = 'com.vmapp.hostcapstest';
  const UPD = 'com.vmapp.hostcapsupd';
  const homeE = path.join(ROOT, 'home-e');
  const fakeLog = path.join(ROOT, 'fake-hostctl-e.jsonl');
  const mcpLog = path.join(ROOT, 'fake-mcp-e.jsonl');
  const panicFile = path.join(ROOT, 'panic-now');
  const dialogLogE = path.join(ROOT, 'dialogs-e.jsonl');
  const variants = path.join(ROOT, 'variants-e');
  const isAppE = (u) => u.startsWith(`vmapp-ui://${EID}/`);
  const isSettings = (u) => u.startsWith('vmapp-loader://ui/settings.html');
  const isBadge = (u) => u.startsWith('vmapp-loader://ui/badge.html');
  const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const fakeOps = () => jsonl(fakeLog);
  const dialogsE = () => jsonl(dialogLogE);
  const confirms = () => dialogsE().filter((d) => d.kind === 'host-confirm').map((d) => d.detail);
  const eCard = (sel) => `[data-app="${EID}"] ${sel}`;
  const bannerText = (c) => c.eval(`(document.getElementById('banners') || {}).textContent || ''`);
  const sheetText = (c) => c.eval(`(document.querySelector('.sheet') || {}).textContent || ''`);
  const tools = () => JSON.parse(fs.readFileSync(path.join(homeE, 'capabilities', 'tools.json'), 'utf8'));
  const grantsE = () => JSON.parse(fs.readFileSync(path.join(homeE, 'grants', `${EID}.json`), 'utf8'));
  const badgeTarget = async () => (await targets()).find((t) => isBadge(t.url));
  const noBadge = (what) => waitFor(async () => !(await badgeTarget()), { what, timeout: 15000 });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // ---- fixtures: the host-capabilities app, and two builds of a registry app (1.1.0 asks for host capabilities) ----
  const pkgE = path.join(ROOT, 'hostcaps.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-hostcaps'), pkgE);
  fs.mkdirSync(variants, { recursive: true });
  const variant = (version, host) => {
    const dir = path.join(variants, `upd-${version}`);
    fs.cpSync(path.join(LOADER, 'test', 'fixture-hostcaps'), dir, { recursive: true });
    const mf = path.join(dir, 'vmapp.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.id = UPD;
    m.name = 'Host Caps Upd';
    m.version = version;
    if (host) m.permissions.host = host;
    else delete m.permissions.host;
    fs.writeFileSync(mf, JSON.stringify(m, null, 2));
    const file = path.join(variants, `upd-${version}.vmapp`);
    hostlib.pack(dir, file);
    return file;
  };
  const builds = {
    '1.0.0': variant('1.0.0', null),
    '1.1.0': variant('1.1.0', [
      { cap: 'screen', purpose: 'Reads the screen' },
      { cap: 'input', purpose: 'Clicks for you' },
      { cap: 'tool:*', purpose: 'Runs your tools' },
    ]),
  };
  const regProc = spawn(process.execPath, [path.join(VMAPP, 'registry', 'server.js'), '--port', '0', '--data', path.join(ROOT, 'registry-data-e'), '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(regProc);
  const regUrl = await new Promise((resolve, reject) => {
    let buf = '';
    regProc.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on (http:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    regProc.once('exit', () => reject(new Error('the registry exited before it was listening')));
    setTimeout(() => reject(new Error('registry did not start')), 15000);
  });
  let ownerToken = null;
  const publish = async (version) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
    const res = await fetch(`${regUrl}/api/publish`, { method: 'POST', headers, body: fs.readFileSync(builds[version]) });
    const j = await res.json();
    assert.equal(res.status, 201, `publish ${version}: ${JSON.stringify(j)}`);
    if (j.ownerToken) ownerToken = j.ownerToken;
  };
  await publish('1.0.0');

  // The answers to the confirmations, in the order the test causes them (an empty queue denies).
  const answers = ['once', 'once', 'deny', 'session', 'once', 'session'];
  const E = startLoader({
    home: homeE,
    name: 'loader-E',
    env: {
      VMAPP_REGISTRY: regUrl,
      FAKE_HOSTCTL_LOG: fakeLog,
      FAKE_HOSTCTL_PANIC_FILE: panicFile,
      VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pkgE], host: answers, message: 0, external: true }),
      VMAPP_TEST_DIALOG_LOG: dialogLogE,
    },
  });
  const lib = await waitTarget(isLibrary, 'library (E)');
  await waitSel(lib, '[data-role="empty"]', 'empty library (E)');

  // ---- startup: the helper is the fake; the panic shortcut is registered; nothing else was asked of it ----
  step('E: startup registers the panic shortcut and asks the helper for nothing else');
  await waitFor(() => fakeOps().some((o) => o.op === 'panic-hotkey' && o.args.enable === true), { what: 'panic-hotkey enable at startup' });
  assert.deepEqual([...new Set(fakeOps().map((o) => o.op))].filter((o) => o !== 'panic-hotkey' && o !== 'ping'), [], 'no capture, input or permission request happens by itself');

  // ---- the Host Capabilities window ----
  step('E: Host Capabilities window: macOS permissions panel');
  await click(lib, '[data-action="open-settings"]');
  const set = await waitTarget(isSettings, 'settings window');
  await waitSel(set, '[data-perm="screen"]', 'permissions panel');
  await waitFor(async () => (await text(set, '[data-role="perm-screen-status"]')) === 'Allowed', { what: 'screen recording status from hostctl status' });
  assert.equal(await text(set, '[data-role="perm-accessibility-status"]'), 'Allowed');
  assert.ok(fakeOps().some((o) => o.op === 'status'), 'the panel reads hostctl status');
  assert.ok(!fakeOps().some((o) => o.op === 'request-permissions'), 'macOS is never asked until the user clicks');
  await click(set, '[data-action="ask-screen"]');
  await waitFor(() => fakeOps().some((o) => o.op === 'request-permissions' && o.args.screenRecording === true), { what: 'Ask macOS… sends request-permissions' });
  await click(set, '[data-action="open-screen"]');
  await click(set, '[data-action="open-accessibility"]');
  await waitFor(() => dialogsE().filter((d) => d.kind === 'openExternal').length >= 2, { what: 'the two System Settings panes' });
  assert.deepEqual(
    dialogsE().filter((d) => d.kind === 'openExternal').map((d) => d.detail),
    ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'],
    'fixed loader-owned addresses, opened without a confirmation',
  );
  assert.equal(await text(set, '[data-role="panic-shortcut"]'), '⌃⌥⌘.');
  assert.match(await text(set, '[data-role="active-list"]'), /Nothing is controlling your computer/);
  assert.equal(await exists(set, '[data-action="stop-all"]'), true);

  step('E: Host Capabilities window: tools catalog (add, validate, presets, edit, remove)');
  // an invalid id is refused with the catalog's own message and nothing is written
  await click(set, '[data-action="add-tool"]');
  await waitSel(set, '[data-role="tool-form"]', 'tool form');
  await setIn(set, '[data-role="tool-name"]', 'Echo tool');
  await setIn(set, '[data-role="tool-id"]', 'Bad Id');
  await setIn(set, '[data-role="tool-path"]', '/bin/echo');
  await click(set, '[data-action="save-tool"]');
  await waitFor(async () => /tool\.id must match/.test((await text(set, '[data-role="form-error"]')) || ''), { what: 'validation message from the Catalog' });
  assert.ok(!fs.existsSync(path.join(homeE, 'capabilities', 'tools.json')), 'nothing is saved when validation fails');
  await setIn(set, '[data-role="tool-id"]', 'echo');
  await setIn(set, '[data-role="tool-path"]', '/bin/nonexistent-program');
  await click(set, '[data-action="save-tool"]');
  await waitFor(async () => /does not exist/.test((await text(set, '[data-role="form-error"]')) || ''), { what: 'a missing program is refused' });
  await setIn(set, '[data-role="tool-path"]', '/bin/echo');
  await setIn(set, '[data-role="tool-description"]', 'Prints its arguments');
  await click(set, '[data-action="add-arg"]');
  await setIn(set, '[data-role="arg-pattern"]', '^[A-Za-z0-9 ,.!-]{1,80}$');
  await setChecked(set, '[data-role="tool-variadic"]', true);
  await click(set, '[data-action="save-tool"]');
  await waitSel(set, '[data-tool="echo"]', 'echo tool listed');
  assert.deepEqual(tools().map((t) => [t.id, t.name, t.path, t.kind, t.variadic, t.args.map((a) => a.pattern)]), [['echo', 'Echo tool', '/bin/echo', 'tool', true, ['^[A-Za-z0-9 ,.!-]{1,80}$']]]);

  // presets only fill the form
  await click(set, '[data-action="preset-terminal"]');
  await waitSel(set, '[data-role="tool-form"]', 'terminal preset form');
  const termForm = await set.eval(`({ kind: document.querySelector('[data-role="tool-kind"]').value, warning: !document.querySelector('[data-role="shell-warning"]').hidden, path: document.querySelector('[data-role="tool-path"]').value, patterns: [...document.querySelectorAll('[data-role="arg-pattern"]')].map((e) => e.value) })`);
  assert.deepEqual(termForm, { kind: 'shell', warning: true, path: '/bin/zsh', patterns: ['^-c$', '^[\\s\\S]{1,10000}$'] }, 'the terminal preset: shell kind, red warning, -c and a script pattern');
  assert.equal(tools().length, 1, 'a preset saves nothing by itself');
  await shot2x(set, 'settings-shell-preset');
  await click(set, '[data-action="save-tool"]');
  await waitSel(set, '[data-tool="terminal"] [data-role="shell-chip"]', 'terminal shell listed with its red chip');
  assert.equal(tools().find((t) => t.id === 'terminal').kind, 'shell');
  for (const [key, path0, patterns] of [
    ['screenshot', '/usr/sbin/screencapture', ['^-x$', '^-R\\d+,\\d+,\\d+,\\d+$', '^/host/save-\\d+/[\\w .-]+\\.png$']],
    ['open-app', '/usr/bin/open', ['^-a$', '^[A-Za-z0-9 .-]{1,60}$']],
  ]) {
    await click(set, `[data-action="preset-${key}"]`);
    await waitSel(set, '[data-role="tool-form"]', `${key} preset form`);
    assert.deepEqual(await set.eval(`({ path: document.querySelector('[data-role="tool-path"]').value, patterns: [...document.querySelectorAll('[data-role="arg-pattern"]')].map((e) => e.value), warning: !document.querySelector('[data-role="shell-warning"]').hidden })`), { path: path0, patterns, warning: false });
    await click(set, '[data-action="cancel"]');
  }
  assert.deepEqual(tools().map((t) => t.id), ['echo', 'terminal'], 'cancelled presets are not saved');
  // a tool no app will be offered, and one added only to be removed
  await click(set, '[data-action="add-tool"]');
  await setIn(set, '[data-role="tool-name"]', 'Cat tool');
  await setIn(set, '[data-role="tool-id"]', 'cat');
  await setIn(set, '[data-role="tool-path"]', '/bin/cat');
  await click(set, '[data-action="save-tool"]');
  await waitSel(set, '[data-tool="cat"]', 'cat tool listed');
  await click(set, '[data-action="add-tool"]');
  await setIn(set, '[data-role="tool-name"]', 'Temporary');
  await setIn(set, '[data-role="tool-id"]', 'tmp');
  await setIn(set, '[data-role="tool-path"]', '/bin/echo');
  await click(set, '[data-action="save-tool"]');
  await waitSel(set, '[data-tool="tmp"]', 'tmp tool listed');
  await click(set, '[data-tool="tmp"] [data-action="remove-tool"]');
  await waitSel(set, '[data-action="confirm-remove"]', 'remove confirmation');
  await click(set, '[data-action="confirm-remove"]');
  await waitFor(async () => !(await exists(set, '[data-tool="tmp"]')), { what: 'tmp tool removed' });
  assert.deepEqual(tools().map((t) => t.id), ['echo', 'terminal', 'cat']);
  // edit: the id cannot change; a changed description is saved
  await click(set, '[data-tool="cat"] [data-action="edit-tool"]');
  assert.equal(await set.eval(`document.querySelector('[data-role="tool-id"]').readOnly`), true, 'the id of an existing tool is fixed');
  await setIn(set, '[data-role="tool-description"]', 'Prints a file');
  await click(set, '[data-action="save-tool"]');
  await waitFor(() => tools().find((t) => t.id === 'cat').description === 'Prints a file', { what: 'edited tool saved' });

  step('E: Host Capabilities window: MCP servers catalog');
  await click(set, '[data-action="add-mcp"]');
  await waitSel(set, '[data-role="mcp-form"]', 'mcp form');
  await setIn(set, '[data-role="mcp-name"]', 'Fake MCP');
  await setIn(set, '[data-role="mcp-id"]', 'fake');
  await setIn(set, '[data-role="mcp-program"]', process.execPath);
  await setIn(set, '[data-role="mcp-args"]', path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-mcp-server.js'));
  await setIn(set, '[data-role="mcp-env"]', `FAKE_MCP_LOG=${mcpLog}`);
  await click(set, '[data-action="save-mcp"]');
  await waitSel(set, '[data-mcp="fake"]', 'mcp server listed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeE, 'capabilities', 'mcp.json'), 'utf8')), [{ id: 'fake', name: 'Fake MCP', command: [process.execPath, path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-mcp-server.js')], env: { FAKE_MCP_LOG: mcpLog } }]);
  await shot2x(set, 'settings-host-capabilities');
  // the window exposes no way for an app to reach it: its page API is only what the loader preload names
  assert.deepEqual(await set.eval(`Object.keys(window.settings).sort()`), ['askMacos', 'onChanged', 'openSystemSettings', 'pickFile', 'removeMcp', 'removeTool', 'saveMcp', 'saveTool', 'setPref', 'state', 'status', 'stopAll', 'stopControl']);

  // ---- install review: INV-H6 label ----
  step('E: install review says the app requests control of your computer');
  await click(lib, '[data-action="install"]');
  await waitSel(lib, '[data-role="review"]', 'install review (E)');
  await waitSel(lib, '[data-role="review-host"]', 'host part of the review');
  assert.equal(await text(lib, '[data-role="control-label"]'), 'This app requests control of your computer.');
  const rv = await sheetText(lib);
  assert.match(rv, /Control of your computer/);
  assert.match(rv, /See your screen/);
  assert.match(rv, /Reads the screen to help you fill forms/);
  assert.match(rv, /Control your mouse and keyboard/);
  assert.match(rv, /Run tools from your own catalog/);
  assert.match(rv, /Use MCP servers from your own catalog/);
  assert.match(rv, /Installing it allows none of this/);
  await shot2x(lib, 'install-review-host');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${EID}"]`, 'host caps app card');
  assert.match(await text(lib, eCard('[data-role="host-requested"]')), /asks to: screen, mouse and keyboard, tools, MCP servers/);
  assert.equal(await exists(lib, eCard('[data-role="host-chip"]')), false, 'no red chip before anything is allowed');
  assert.match(await text(lib, eCard('[data-role="host-grants"]')), /screen: not allowed.*input: not allowed.*tool:\*: not allowed.*mcp:\*: not allowed/);

  // ---- permission sheet ----
  step('E: permission sheet: "Control of your computer" section (default Don’t allow; catalog entries as checkboxes)');
  await click(lib, eCard('[data-action="launch"]'));
  await waitSel(lib, '[data-role="host-section"]', 'host section of the permission sheet');
  const modes = await lib.eval(`[...document.querySelectorAll('[data-role="host-section"] .hostcap')].map((r) => [r.dataset.cap, r.querySelector('[data-role="host-mode"]').value, [...r.querySelectorAll('[data-role="host-mode"] option')].map((o) => o.value).join('/')])`);
  assert.deepEqual(modes, [['screen', 'none', 'none/ask/session'], ['input', 'none', 'none/ask/session'], ['tool:*', 'none', 'none/ask/session'], ['mcp:*', 'none', 'none/ask/session']], 'every capability starts as Don’t allow; "always" is not offered');
  assert.match(await text(lib, '[data-role="host-section"]'), /Control of your computer/);
  assert.match(await text(lib, '[data-cap="input"] [data-role="purpose"]'), /Clicks and types for you when you ask/);
  assert.equal(await lib.eval(`document.querySelector('[data-cap="tool:*"] [data-role="host-picks"]').hidden`), true, 'the tool list appears once a mode is chosen');
  await setIn(lib, '[data-cap="tool:*"] [data-role="host-mode"]', 'ask');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-cap="tool:*"] [data-pickrow]')].map((l) => [l.dataset.pickrow, l.classList.contains('shell')])`), [['echo', false], ['terminal', true], ['cat', false]], 'the user’s catalog is offered; the shell tool is marked');
  assert.match(await text(lib, '[data-cap="tool:*"] .pick.shell'), /shell: full access/);
  // choosing a mode without picking anything is refused with a plain message
  await click(lib, '[data-action="sheet-launch"]');
  await waitFor(async () => /Pick at least one tool/.test(await bannerText(lib)), { what: 'pick-at-least-one message' });
  assert.equal(fs.existsSync(path.join(homeE, 'grants', `${EID}.json`)), false, 'nothing is saved by the refused attempt');
  await setIn(lib, '[data-cap="screen"] [data-role="host-mode"]', 'ask');
  await setIn(lib, '[data-cap="input"] [data-role="host-mode"]', 'session');
  await setChecked(lib, '[data-cap="tool:*"] [data-pick="echo"]', true);
  await setChecked(lib, '[data-cap="tool:*"] [data-pick="terminal"]', true);
  await setIn(lib, '[data-cap="mcp:*"] [data-role="host-mode"]', 'ask');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-cap="mcp:*"] [data-pickrow]')].map((l) => l.dataset.pickrow)`), ['fake']);
  await setChecked(lib, '[data-cap="mcp:*"] [data-pick="fake"]', true);
  await shot2x(lib, 'permission-sheet-host');
  await click(lib, '[data-action="sheet-launch"]');
  const g = await waitFor(() => fs.existsSync(path.join(homeE, 'grants', `${EID}.json`)) && grantsE(), { what: 'grants saved (E)' });
  assert.deepEqual(g.host, { screen: { mode: 'ask' }, input: { mode: 'session' }, 'tool:*': { mode: 'ask', tools: ['echo', 'terminal'] }, 'mcp:*': { mode: 'ask', servers: ['fake'] } });
  assert.deepEqual(g.folders, {});

  // ---- the app ----
  step('E: the app runs; screen requests are confirmed in a loader-owned modal (answers scripted)');
  const app = await waitTarget(isAppE, 'host caps app window', 90000);
  await waitFor(() => app.eval(`typeof window.vmapp === 'object' && document.readyState === 'complete'`), { what: 'app page' });
  const call = (ch, ...args) => app.eval(`window.vmapp.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)})`);
  await waitFor(async () => /Can control your computer/.test((await text(lib, eCard('[data-role="host-chip"]'))) || ''), { what: 'the red chip on the card' });
  assert.equal(await lib.eval(`getComputedStyle(document.querySelector(${q(eCard('[data-role="host-chip"]'))})).backgroundColor`), 'rgb(196, 35, 28)', 'the chip is red');

  const wins = await call('screen-windows');
  assert.equal(wins.ok, true);
  assert.deepEqual(wins.value.map((w) => [w.windowId, w.app, w.title]), [[7, 'FakeApp', 'Fake window'], [8, 'Notes', 'Shopping list']], 'the fake desktop also has a window of the loader itself; an app never sees it');
  const cap = await call('screen-capture', { target: 'display', maxWidth: 320 });
  assert.deepEqual(cap.value, { isBuffer: true, magic: 'PNG', bytes: 70, width: 320, height: 1, target: { kind: 'display', display: 1, bounds: { x: 0, y: 0, w: 1440, h: 900 }, by: 'app' } }, 'the app got the PNG bytes from the fake helper and the target that was captured');
  const capDenied = await call('screen-capture', { target: 'window', windowId: 7 });
  assert.equal(capDenied.ok, false);
  assert.match(capDenied.error, /permission denied: declined by the user/);
  let cf = confirms();
  assert.deepEqual(cf.map((c) => c.answer), ['once', 'once', 'deny']);
  // a screenshot is a question the user answers by picking; the app’s parameters are only a suggestion (SPEC 8.2)
  assert.deepEqual(cf.map((c) => c.message), [
    '“Host Caps Test” wants to see which windows are open on your screen',
    '“Host Caps Test” wants to take a screenshot of something on your screen',
    '“Host Caps Test” wants to take a screenshot of something on your screen',
  ]);
  assert.match(cf[1].detail, /You choose what it gets: a whole display, one window or a part of a screen\. It receives only what you pick\./);
  assert.match(cf[1].detail, /It suggests: your main display\./);
  assert.match(cf[2].detail, /It suggests: the window “Fake window” of FakeApp\./);
  assert.deepEqual(cf[0].buttons, ['Deny', 'Allow once', 'Allow while the app runs']);
  assert.match(cf[0].detail, /Why the app says it needs this: “Reads the screen to help you fill forms”/);
  assert.equal(cf[0].title, 'Host Caps Test');
  assert.ok(fakeOps().some((o) => o.op === 'capture' && o.args.maxWidth === 320), 'the helper got the capture');
  assert.equal(fakeOps().filter((o) => o.op === 'capture').length, 1, 'the declined capture never reached the helper');

  step('E: input control: badge window, Stop button, further input refused; everything dry-run');
  assert.equal(await badgeTarget(), undefined, 'no badge before input control starts');
  const started = await call('input-start', 'click the test button');
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(confirms().length, 3, 'mode "session" asks nothing');
  const badge = await waitTarget(isBadge, 'control badge');
  await waitSel(badge, '[data-action="badge-stop"]', 'badge Stop button');
  assert.match(await text(badge, '[data-role="badge-text"]'), /^Host Caps Test is controlling your computer — $/);
  assert.match(await badge.eval(`document.querySelector('.row').textContent`), /Host Caps Test is controlling your computer —\s*Stop$/);
  assert.equal(await badge.eval(`document.documentElement.outerHTML.includes('<script>')`), false, 'no inline script in the badge page');
  assert.deepEqual(await badge.eval(`Object.keys(window.badge).sort()`), ['onState', 'ready', 'stop', 'stopAll'], 'the badge page can only press Stop');
  await shot2x(badge, 'control-badge');
  assert.equal((await call('input-mouse', { action: 'click', x: 10, y: 20 })).ok, true);
  assert.equal((await call('input-keys', { text: 'typed text' })).ok, true);
  assert.equal((await call('input-keys', { key: 'return' })).ok, true);
  // the library lists the control and has its own Stop; the settings window too
  await waitSel(lib, '[data-role="control-item"]', 'library lists the active control');
  assert.match(await text(lib, '[data-role="control-item"]'), /Host Caps Test is controlling your computer/);
  assert.match(await text(lib, eCard('[data-role="host-active"]')), /Controlling your computer now/);
  await shot2x(lib, 'library-controlling');
  await waitSel(set, '[data-role="active-list"] [data-action="stop-app"]', 'settings lists the active control');
  await click(badge, '[data-action="badge-stop"]');
  await noBadge('badge closes after Stop');
  const after = await call('input-mouse', { action: 'move', x: 1, y: 2 });
  assert.equal(after.ok, false);
  assert.match(after.error, /no such input session|stopped|expired/);
  assert.equal((await call('input-keys', { text: 'x' })).ok, false, 'typing is refused too');
  await waitFor(async () => !(await exists(lib, '[data-role="control-item"]')), { what: 'library strip empties' });
  const inputOps = fakeOps().filter((o) => o.op === 'mouse' || o.op === 'keys');
  assert.ok(inputOps.length >= 3, 'the helper got the mouse and keys');
  assert.ok(inputOps.every((o) => o.args.dryRun === true), 'every mouse and keyboard request is a dry run');
  assert.ok(inputOps.some((o) => o.op === 'keys' && o.args.text === 'typed text'));

  step('E: tools: constrained run, argument checks, "allow while the app runs" remembered, a shell tool shows the badge');
  const tl = await call('tool-list');
  assert.deepEqual(tl.value.map((t) => t.id).sort(), ['echo', 'terminal'], 'only the tools the user picked are offered');
  assert.ok(tl.value.every((t) => !('path' in t)), 'the host path is never shown to the app');
  const echo1 = await call('tool-run', 'echo', ['hello', 'world']);
  assert.equal(echo1.ok, true, JSON.stringify(echo1));
  assert.equal(echo1.value.stdout, 'hello world\n');
  assert.equal(echo1.value.exitCode, 0);
  cf = confirms();
  assert.equal(cf.length, 4);
  assert.equal(cf[3].message, '“Host Caps Test” wants to run the tool “Echo tool”');
  assert.match(cf[3].detail, /Program: \/bin\/echo\n\nArguments:\n {2}1\. "hello"\n {2}2\. "world"/);
  assert.equal(cf[3].answer, 'session');
  const echo2 = await call('tool-run', 'echo', ['again']);
  assert.equal(echo2.value.stdout, 'again\n');
  assert.equal(confirms().length, 4, '"Allow while the app runs" is remembered: no second question');
  const injected = await call('tool-run', 'echo', ['a; touch /tmp/vmapp-pwned']);
  assert.equal(injected.ok, false, 'an argument that does not match its pattern is refused');
  assert.ok(!fs.existsSync('/tmp/vmapp-pwned'));
  const notGranted = await call('tool-run', 'cat', []);
  assert.equal(notGranted.ok, false);
  assert.match(notGranted.error, /not granted by the user/, 'a catalog tool the user did not pick is refused');
  // the shell tool: confirmation with the red-flag wording, badge while it runs
  await app.eval(`(window.__shell = window.vmapp.invoke('tool-run', 'terminal', ['-c', 'sleep 2; echo shell-ok']), true)`);
  const shellBadge = await waitTarget(isBadge, 'badge while the shell runs');
  await waitSel(shellBadge, '[data-kind="shell"]', 'shell row');
  assert.match(await text(shellBadge, '[data-role="badge-text"]'), /^Host Caps Test is running a shell command — $/);
  const shellRes = await app.eval(`window.__shell`);
  assert.equal(shellRes.ok, true, JSON.stringify(shellRes));
  assert.equal(shellRes.value.stdout, 'shell-ok\n');
  await noBadge('shell badge closes when the command ends');
  cf = confirms();
  assert.equal(cf.length, 5);
  assert.equal(cf[4].message, '“Host Caps Test” wants to run a shell command (“Terminal shell”)');
  assert.equal(cf[4].shell, true);
  assert.match(cf[4].detail, /Program: \/bin\/zsh\n\nArguments:\n {2}1\. "-c"\n {2}2\. "sleep 2; echo shell-ok"/);
  assert.match(cf[4].detail, /A shell can do anything you can do on this Mac/);

  step('E: MCP: list and call through the broker (own server process per app)');
  const ml = await call('mcp-list');
  assert.equal(ml.ok, true, JSON.stringify(ml));
  assert.deepEqual(ml.value.map((s) => [s.id, s.tools.map((t) => t.name)]), [['fake', ['echo', 'pid', 'env']]]);
  const mc = await call('mcp-call', 'fake', 'tools/call', { name: 'echo', arguments: { a: 1 } });
  assert.equal(mc.ok, true, JSON.stringify(mc));
  assert.equal(mc.value.content[0].text, '{"a":1}');
  assert.equal((await call('mcp-call', 'nope', 'tools/list', {})).ok, false);
  cf = confirms();
  assert.equal(cf.length, 6);
  assert.equal(cf[5].message, '“Host Caps Test” wants to start Fake MCP and see which tools it offers');
  assert.equal(cf[5].answer, 'session');
  const mcpStarts = jsonl(mcpLog).filter((e) => e.event === 'start');
  assert.equal(mcpStarts.length, 1);
  assert.ok(jsonl(mcpLog).some((e) => e.event === 'initialize'));

  // ---- Stop from the library (the second way to stop) ----
  step('E: Stop from the library strip');
  assert.equal((await call('input-start', 'second session')).ok, true);
  await waitTarget(isBadge, 'badge (second session)');
  await waitSel(lib, '[data-action="control-stop"]', 'library Stop button');
  await click(lib, '[data-action="control-stop"]');
  await noBadge('badge closes after the library Stop');
  assert.equal((await call('input-mouse', { action: 'move', x: 3, y: 4 })).ok, false);
  // Stop for one app ends everything it has running on the host: its MCP server process too (the app keeps running)
  await waitFor(() => !alive(mcpStarts[0].pid), { what: 'Stop also ended the app’s MCP server process', timeout: 10000 });

  // ---- Inspector ----
  step('E: Inspector: host rows (cap, op, allowed/denied, duration) and the Host filter');
  await click(lib, eCard('[data-action="inspect"]'));
  const insp = await waitTarget(isInspector, 'inspector (E)');
  await waitFor(() => insp.eval(`document.querySelectorAll('#rows tr.row.host').length >= 10`), { what: 'host rows in the inspector' });
  const hostRows = () => insp.eval(`[...document.querySelectorAll('#rows tr.row.host')].map((tr) => ({ cells: [...tr.children].map((td) => td.textContent), hidden: tr.classList.contains('hidden'), err: tr.classList.contains('err') }))`);
  const hr = await hostRows();
  const find = (chan, res) => hr.find((r) => r.cells[3] === chan && r.cells[7] === res);
  assert.ok(find('screen host.screen.windows', 'allowed'));
  assert.ok(find('screen host.screen.capture', 'allowed') && /^\d+ ms$/.test(find('screen host.screen.capture', 'allowed').cells[6]));
  assert.ok(find('screen host.screen.capture', 'denied'), 'the declined capture is logged as denied');
  assert.ok(find('input host.input.start', 'allowed') && find('input host.input.mouse', 'allowed') && find('input host.input.keys', 'allowed'));
  assert.ok(find('input host.input.stop', 'allowed'), 'the Stop button’s end of the session is logged');
  assert.ok(find('input host.input.mouse', 'denied'), 'input after Stop is logged as denied');
  assert.ok(find('tool:echo host.tool.run', 'allowed'));
  assert.ok(find('tool:cat host.tool.run', 'denied'), 'a tool that was not picked is denied');
  assert.ok(find('tool:terminal host.tool.run', 'allowed'));
  assert.ok(find('mcp:* host.mcp.list', 'allowed') && find('mcp:fake host.mcp.call', 'allowed'));
  assert.ok(find('mcp:nope host.mcp.call', 'denied'), 'a server that is not granted is denied');
  const allText = JSON.stringify(hr);
  assert.ok(!allText.includes('typed text'), 'typed text is never in the inspector');
  assert.ok(!/iVBOR/.test(await insp.eval(`document.body.textContent`)), 'no screenshot bytes in the inspector');
  const totalRows = await insp.eval(`document.querySelectorAll('#rows tr.row').length`);
  assert.ok(totalRows > hr.length, 'the generic bridge rows are there too');
  await click(insp, '#btn-host');
  assert.equal(await insp.eval(`document.getElementById('btn-host').getAttribute('aria-pressed')`), 'true');
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row:not(.hidden)').length`), hr.length, 'the Host filter shows only host rows');
  assert.equal(await insp.eval(`[...document.querySelectorAll('#rows tr.row:not(.hidden)')].every((tr) => tr.dataset.t === 'host')`), true);
  await insp.eval(`[...document.querySelectorAll('#rows tr.row.host')].find((tr) => tr.children[3].textContent === 'screen host.screen.capture').click()`);
  assert.match(await text(insp, '#detail-meta'), /Capabilityscreen/);
  await shot2x(insp, 'inspector-host');
  await click(insp, '#btn-host');
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row:not(.hidden)').length === document.querySelectorAll('#rows tr.row').length`), true, 'the filter can be turned off');

  // ---- panic ----
  step('E: panic (the helper reports the shortcut): input, tools, MCP servers all stop at once');
  // the MCP server was ended by the Stop above; using it again starts a fresh one ("allow while the app runs" is remembered)
  const mcpAgain = await call('mcp-call', 'fake', 'tools/call', { name: 'echo', arguments: { b: 2 } });
  assert.equal(mcpAgain.ok, true, JSON.stringify(mcpAgain));
  const mcpNow = jsonl(mcpLog).filter((e) => e.event === 'start');
  assert.equal(mcpNow.length, 2, 'the MCP server was started again');
  const mcpPid = mcpNow[1].pid;
  assert.ok(alive(mcpPid), 'the app’s MCP server is running');
  assert.equal(confirms().length, 6, 'no new question: the earlier "allow while the app runs" still stands');
  assert.equal((await call('input-start', 'third session')).ok, true);
  await waitTarget(isBadge, 'badge (third session)');
  await waitFor(async () => (await exists(set, '[data-role="active-list"] [data-action="stop-app"]')), { what: 'settings lists the control' });
  fs.writeFileSync(panicFile, '1'); // the fake helper deletes it and sends {"event":"panic"}, as the real one does for ⌃⌥⌘.
  await noBadge('badge closes on panic');
  await waitFor(() => !alive(mcpPid), { what: 'the MCP server was killed by the panic', timeout: 10000 });
  assert.equal((await call('input-mouse', { action: 'move', x: 5, y: 6 })).ok, false, 'input is refused after panic');
  await waitFor(async () => /Panic shortcut: every app was stopped/.test(await bannerText(lib)), { what: 'the library says so' });
  await waitFor(() => dialogsE().some((d) => d.kind === 'notice' && /Panic shortcut/.test(d.detail.body)), { what: 'a system notice (recorded by the test hook)' });
  await waitFor(async () => /Nothing is controlling your computer/.test(await text(set, '[data-role="active-list"]')), { what: 'settings empties' });
  const afterPanic = await call('tool-run', 'echo', ['after panic']);
  assert.equal(afterPanic.ok, false, '"allow while the app runs" answers are forgotten by panic: the next use asks again (the scripted queue is empty: deny)');
  assert.match(afterPanic.error, /declined by the user/);
  assert.equal(confirms().length, 7);
  assert.ok(fs.existsSync(path.join(homeE, 'grants', `${EID}.json`)), 'panic does not touch the saved grants');
  assert.equal(grantsE().host['tool:*'].mode, 'ask');

  // ---- stop the app: session grants return to ask; revoking in the sheet ----
  step('E: stopping the app returns "session" to "ask"; the Permissions sheet revokes');
  await click(lib, eCard('[data-action="stop"]'));
  await waitFor(async () => (await cardState2(lib, EID)) === 'stopped', { what: 'app stopped (E)', timeout: 30000 });
  await waitFor(() => grantsE().host.input.mode === 'ask', { what: 'the session grant went back to ask' });
  await click(lib, eCard('[data-action="permissions"]'));
  await waitSel(lib, '[data-role="host-section"]', 'host section (edit)');
  assert.equal(await lib.eval(`document.querySelector('[data-cap="input"] [data-role="host-mode"]').value`), 'ask', 'the sheet shows the saved choice');
  assert.equal(await lib.eval(`document.querySelector('[data-cap="tool:*"] [data-pick="terminal"]').checked`), true);
  for (const c of ['screen', 'input', 'tool:*', 'mcp:*']) await setIn(lib, `[data-cap="${c}"] [data-role="host-mode"]`, 'none');
  await click(lib, '[data-action="sheet-save"]');
  await waitFor(() => grantsE().host === undefined, { what: 'all host grants revoked' });
  await waitFor(async () => !(await exists(lib, eCard('[data-role="host-chip"]'))), { what: 'the red chip is gone' });
  // the renderer cannot save a grant the manifest does not ask for, or a mode the sheet does not offer
  const sneaky = await lib.eval(`window.loader.savePermissions(${JSON.stringify(EID)}, {}, false, { input: { mode: 'always' }, 'tool:other': { mode: 'ask' } }).then(() => 'accepted', (e) => 'rejected: ' + e.message)`);
  assert.match(sneaky, /rejected: .*cannot be set here/);
  assert.equal(grantsE().host, undefined);

  // ---- an update that adds host capabilities always stops and asks ----
  step('E: update that adds host capabilities: the "asks for more" sheet lists them');
  await browseInstall(lib, UPD, 'E');
  await waitSel(lib, '[data-role="review"]', 'review of the registry app', 30000);
  assert.equal(await exists(lib, '[data-role="review-host"]'), false, 'version 1.0.0 asks for nothing of that kind');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${UPD}"]`, 'registry app card');
  await publish('1.1.0');
  await click(lib, `[data-app="${UPD}"] [data-action="check-updates"]`);
  await waitSel(lib, '[data-role="asks-more"]', 'asks-for-more sheet (host)', 30000);
  const more = await sheetText(lib);
  assert.match(more, /Version 1\.1\.0 asks for more:/);
  const li = await lib.eval(`[...document.querySelectorAll('[data-more="host"]')].map((e) => [e.dataset.cap, e.textContent])`);
  assert.deepEqual(li.map((x) => x[0]), ['screen', 'input', 'tool:*']);
  assert.ok(!/requests control/.test(li[0][1]) && /requests control of your computer/.test(li[1][1]) && /requests control of your computer/.test(li[2][1]), 'screen is not "control"; input and tool:* are');
  assert.match(li[1][1], /Clicks for you/);
  await shot2x(lib, 'asks-for-more-host');
  assert.equal(fs.readFileSync(path.join(homeE, 'apps', UPD, 'current'), 'utf8').trim(), '1.0.0', 'nothing changes before the user decides');
  await click(lib, '[data-action="keep-version"]');

  // ---- the end ----
  dropConns();
  await killLoader(E, 'SIGTERM', 30000);
  regProc.kill('SIGTERM');
  await new Promise((r) => regProc.once('exit', r));
  assert.ok(!alive(mcpPid));
  assert.ok(!fakeOps().some((o) => (o.op === 'mouse' || o.op === 'keys') && o.args.dryRun !== true), 'no real input event was ever requested');
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run E', timeout: 15000 });
  step('run E passed');
}
// =============================================================================================== run G: the user picks; the overlay
// SPEC 8.2: a screenshot is a question the USER answers by picking a display, a window or a region (the app's parameters are
// only a suggestion), and while an app controls the mouse and keyboard the loader draws a click-through overlay. Everything
// here uses the FAKE helper (two displays side by side, three windows, one of them the loader's own) and dry-run input.
async function runG(baseline) {
  step('run G: the user picks what a screenshot contains; the virtual-input overlay');
  const GID = 'com.vmapp.hostcapstest';
  const homeG = path.join(ROOT, 'home-g');
  const fakeLog = path.join(ROOT, 'fake-hostctl-g.jsonl');
  const panicFile = path.join(ROOT, 'panic-now-g');
  const dialogLogG = path.join(ROOT, 'dialogs-g.jsonl');
  const overlayLog = path.join(ROOT, 'overlay-g.jsonl');
  const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const fakeOps = () => jsonl(fakeLog);
  const dialogsG = () => jsonl(dialogLogG);
  const isAppG = (u) => u.startsWith(`vmapp-ui://${GID}/`);
  const isPicker = (u) => u.startsWith('vmapp-loader://ui/picker.html');
  const isOverlay = (u) => u.startsWith('vmapp-loader://ui/overlay.html');
  const isBadge = (u) => u.startsWith('vmapp-loader://ui/badge.html');
  const pickerGone = () => waitFor(async () => !(await targets()).some((t) => isPicker(t.url)), { what: 'the picker closes', timeout: 15000 });
  const noOverlay = (what) => waitFor(async () => !(await targets()).some((t) => isOverlay(t.url)), { what, timeout: 15000 });
  const overlayPages = async () => {
    const out = [];
    for (const t of (await targets()).filter((x) => isOverlay(x.url))) {
      if (!conns.has(t.id)) conns.set(t.id, await Cdp.connect(t.webSocketDebuggerUrl));
      out.push(conns.get(t.id));
    }
    return out;
  };

  // ---- fixtures: the host-capabilities app, installed with grants (screen: ask, input: session) so no permission sheet is
  // needed (the sheet itself is run E). The picker is the loader's, scripted by VMAPP_TEST_DIALOGS.capture = 'ui' (real window).
  const pkgG = path.join(ROOT, 'hostcaps-g.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-hostcaps'), pkgG);
  const seed = new hostlib.Store({ home: homeG, skipRuntimeCheck: true });
  seed.install(pkgG);
  seed.saveHostGrants(GID, { screen: { mode: 'ask' }, input: { mode: 'session' } });

  const G = startLoader({
    home: homeG,
    name: 'loader-G',
    env: {
      FAKE_HOSTCTL_LOG: fakeLog,
      FAKE_HOSTCTL_PANIC_FILE: panicFile,
      VMAPP_TEST_DIALOGS: JSON.stringify({
        capture: ['ui', 'ui', 'ui', 'ui', 'ui'],
        // "Select a region…": 1st the user cancels (null), 2nd and 3rd use the REAL selection window ('ui': the test drags, then
        // presses Esc, over CDP), 4th is this rectangle (global points, on display 2) given by the hook
        region: [null, 'ui', 'ui', { x: 1500, y: 100, w: 400, h: 300 }],
        message: 0,
      }),
      VMAPP_TEST_DIALOG_LOG: dialogLogG,
      VMAPP_TEST_OVERLAY_LOG: overlayLog,
    },
  });
  const lib = await waitTarget(isLibrary, 'library (G)');
  await waitSel(lib, `[data-app="${GID}"]`, 'host caps app card (G)');
  await click(lib, `[data-app="${GID}"] [data-action="launch"]`);
  const app = await waitTarget(isAppG, 'host caps app window (G)', 90000);
  await waitFor(() => app.eval(`typeof window.vmapp === 'object' && document.readyState === 'complete'`), { what: 'app page (G)' });
  const call = (ch, ...args) => app.eval(`window.vmapp.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)})`);
  const callLater = (name, ch, ...args) => app.eval(`(window.__${name} = window.vmapp.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)}), true)`);
  const later = (name) => app.eval(`window.__${name}`);
  // A command whose effect destroys the page it was sent to (a click on Allow / Deny, Esc, the end of a drag) may never get its
  // reply: the window is gone first. Those are sent without waiting for one (the test then waits for the effect instead).
  const fire = (c, method, params) => {
    c.send(method, params).catch(() => {});
  };
  const clickClosing = (c, sel) => fire(c, 'Runtime.evaluate', { expression: `(() => { const e = document.querySelector(${q(sel)}); if (!e || e.disabled) throw new Error('no usable ' + ${q(sel)}); e.click(); return true; })()`, returnByValue: true });
  const evalClosing = (c, expression) => fire(c, 'Runtime.evaluate', { expression, returnByValue: true });
  const thumbsOps = () => fakeOps().filter((o) => o.op === 'capture' && o.args.maxWidth === 360); // the loader's own previews
  const appOps = () => fakeOps().filter((o) => o.op === 'capture' && o.args.maxWidth !== 360); // what the app’s requests became
  const picks = () => dialogsG().filter((d) => d.kind === 'capture-pick').map((d) => [d.detail.answer, d.detail.target]);

  // ---- the picker renders what the helper reports ----
  step('G: the picker is a modal sheet on the app’s window; it lists displays (with thumbnails), windows and "Select a region…"');
  await callLater('cap1', 'screen-capture', { target: 'window', windowId: 7, maxWidth: 320 });
  const pk = await waitTarget(isPicker, 'screenshot picker', 30000);
  await waitSel(pk, '[data-pick="display:1"]', 'display cards');
  const wdet = dialogsG().find((d) => d.kind === 'capture-window');
  assert.ok(wdet, 'the real picker was opened (the hook said "ui")');
  assert.deepEqual({ modal: wdet.detail.modal, hasParent: wdet.detail.hasParent, title: wdet.detail.title }, { modal: true, hasParent: true, title: 'Choose what “Host Caps Test” can see' }, 'a modal window parented to the app’s window, named after the app');
  assert.equal(await text(pk, '[data-role="picker-title"]'), '“Host Caps Test” wants to take a screenshot');
  assert.match(await text(pk, '[data-role="picker-purpose"]'), /Why the app says it needs this: “Reads the screen to help you fill forms”/);
  assert.equal(await text(pk, '[data-role="picker-suggestion"]'), 'It suggests: the window “Fake window” of FakeApp.');
  assert.match(await text(pk, '[data-role="picker-lead"]'), /You choose what it gets: a whole display, one window or a part of a screen\. It receives only what you pick/);
  assert.match(await text(pk, '[data-role="session-note"]'), /^Allow while the app runs: later screenshots need no question, and show what the app asks for then/);
  assert.deepEqual(
    await pk.eval(`[...document.querySelectorAll('[data-role="display"]')].map((l) => [l.dataset.pick, l.querySelector('[data-role="display-name"]').firstChild.textContent, l.querySelector('[data-role="display-size"]').textContent])`),
    [['display:1', 'Built-in Retina Display', '1440 × 900 points'], ['display:2', 'External Monitor', '1920 × 1080 points']],
    'each display: name and resolution',
  );
  assert.equal(await text(pk, '[data-pick="display:1"] .tag'), 'main');
  assert.deepEqual(
    await pk.eval(`[...document.querySelectorAll('[data-role="window"]')].map((l) => [l.dataset.pick, l.querySelector('[data-role="window-app"]').textContent, l.querySelector('[data-role="window-title"]').textContent])`),
    [['window:7', 'FakeApp', 'Fake window'], ['window:8', 'Notes', 'Shopping list']],
    'each window: app and title; the loader’s own window (badge, picker…) is not offered',
  );
  assert.deepEqual(
    await pk.eval(`[...document.querySelectorAll('[data-action="region"]')].map((b) => [b.dataset.display, b.textContent])`),
    [['1', 'Select a region on Built-in Retina Display…'], ['2', 'Select a region on External Monitor…']],
  );
  assert.equal(await pk.eval(`document.querySelector('input[name=pick]:checked').value`), 'window:7', 'the app’s suggestion is preselected');
  assert.match(await text(pk, '[data-role="picker-summary"]'), /^It will receive: the window “Fake window” of FakeApp\. \(This is what the app suggested\.\)$/);
  assert.equal(await pk.eval(`document.activeElement && document.activeElement.id`), 'deny', 'Deny is the default button');
  await waitFor(() => pk.eval(`document.querySelectorAll('[data-role="display"] img').length === 2`), { what: 'a live thumbnail for each display' });
  assert.ok(await pk.eval(`[...document.querySelectorAll('[data-role="display"] img')].every((i) => i.src.startsWith('data:image/png;base64,iVBOR'))`), 'thumbnails are the loader’s own captures, shown here only');
  assert.deepEqual(thumbsOps().map((o) => [o.args.target, o.args.display]), [['display', 1], ['display', 2]], 'the LOADER captured the previews through the helper');
  assert.deepEqual(appOps(), [], 'nothing was captured for the app yet');
  assert.deepEqual(await pk.eval(`Object.keys(window.picker).sort()`), ['answer', 'onThumb', 'ready', 'selectRegion'], 'the picker page can only answer, read thumbnails and ask for a region');
  await shot2x(pk, 'capture-picker');
  // the page can only choose among what it was offered
  for (const bad of [{ kind: 'display', display: 3 }, { kind: 'window', windowId: 99 }, { kind: 'file', path: '/etc/passwd' }, { kind: 'region' }]) {
    const r = await pk.eval(`window.picker.answer('once', ${JSON.stringify(bad)}).then(() => 'accepted', (e) => 'rejected: ' + e.message)`);
    assert.match(r, /^rejected: choose a display, a window or a region first/, JSON.stringify(bad));
  }
  assert.ok(await exists(pk, '[data-role="display"]'), 'a refused answer leaves the question open');

  step('G: choosing display 2 gives the app display 2, not the window it suggested');
  await click(pk, '[data-pick="display:2"] input');
  assert.match(await text(pk, '[data-role="picker-summary"]'), /^It will receive: display “External Monitor” \(1920 × 1080 points\)\.$/);
  clickClosing(pk, '[data-action="allow-once"]');
  const r1 = await later('cap1');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(r1.value.target, { kind: 'display', display: 2, bounds: { x: 1440, y: 0, w: 1920, h: 1080 }, by: 'user' }, 'the app is told what it really got');
  assert.deepEqual(appOps().map((o) => o.args), [{ target: 'display', display: 2, maxWidth: 320, excludePids: [G.pid] }], 'the helper captured display 2 (the app only keeps the say over the size)');
  assert.ok(!fakeOps().some((o) => o.op === 'capture' && o.args.windowId === 7), 'the suggested window was never captured');
  await pickerGone();

  step('G: Deny, Esc and closing the window all answer "permission denied"; a suggested region is preselected');
  await callLater('cap2', 'screen-capture', {});
  const pk2 = await waitTarget(isPicker, 'picker (deny)', 30000);
  await waitSel(pk2, '[data-pick="display:1"]', 'cards (deny)');
  assert.equal(await pk2.eval(`document.querySelector('input[name=pick]:checked').value`), 'display:1', 'no suggestion: the main display');
  clickClosing(pk2, '[data-action="deny"]');
  const r2 = await later('cap2');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /permission denied: declined by the user/);
  await pickerGone();
  await callLater('cap3', 'screen-capture', { target: 'region', region: { x: 10, y: 10, w: 100, h: 100 } });
  const pk3 = await waitTarget(isPicker, 'picker (Esc)', 30000);
  await waitSel(pk3, '[data-pick="region"]', 'the suggested region card');
  assert.equal(await pk3.eval(`document.querySelector('input[name=pick]:checked').value`), 'region', 'the app’s suggested region is preselected');
  assert.equal(await text(pk3, '[data-role="region-size"]'), '100 × 100 points on Built-in Retina Display');
  assert.equal(await text(pk3, '[data-role="picker-suggestion"]'), 'It suggests: a part of your screen (100 × 100 points at 10, 10).');
  evalClosing(pk3, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  const r3 = await later('cap3');
  assert.equal(r3.ok, false);
  assert.match(r3.error, /declined by the user/);
  await pickerGone();
  await callLater('cap4', 'screen-capture', {});
  const pk4 = await waitTarget(isPicker, 'picker (close)', 30000);
  await waitSel(pk4, '[data-pick="display:1"]', 'cards (close)');
  evalClosing(pk4, 'window.close()');
  const r4 = await later('cap4');
  assert.equal(r4.ok, false);
  assert.match(r4.error, /declined by the user/);
  await pickerGone();
  assert.deepEqual(picks().map((p) => p[0]), ['once', 'deny', 'deny'], 'Deny and Esc are recorded as denials; closing the window is a denial too');
  assert.deepEqual(appOps().length, 1, 'no screenshot reached the helper for a denied question');

  step('G: "Select a region…" (the dev hook gives the rectangle): cancel keeps the picker open, a drag selects a region');
  await callLater('cap5', 'screen-capture', { target: 'display', display: 1, maxWidth: 640 });
  const pk5 = await waitTarget(isPicker, 'picker (region)', 30000);
  await waitSel(pk5, '[data-action="region"][data-display="2"]', 'region buttons');
  await click(pk5, '[data-action="region"][data-display="2"]');
  await waitFor(() => dialogsG().some((d) => d.kind === 'region-select'), { what: 'the first region selection (cancelled)' });
  await sleep(300);
  assert.equal(await exists(pk5, '[data-pick="region"]'), false, 'a cancelled selection selects nothing');
  assert.equal(await pk5.eval(`document.querySelector('input[name=pick]:checked').value`), 'display:1');
  // the REAL selection window: a full-screen, dimmed, transparent loader page on the display; the test drags in it with synthetic
  // CDP mouse events (nothing touches the real mouse), so only this window is affected
  const isRegion = (u) => u.startsWith('vmapp-loader://ui/region.html');
  const mouse = (c, type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await click(pk5, '[data-action="region"][data-display="2"]');
  const rg = await waitTarget(isRegion, 'the region selection window', 30000);
  await waitFor(() => rg.eval(`document.readyState === 'complete' && !document.getElementById('hint').hidden`), { what: 'the selection page' });
  const rw = dialogsG().find((d) => d.kind === 'region-window').detail;
  assert.ok(rw.bounds.width > 0 && rw.bounds.height > 0);
  assert.deepEqual(await rg.eval(`[window.innerWidth, window.innerHeight]`), [rw.bounds.width, rw.bounds.height], 'the selection window covers its whole display');
  assert.equal(await rg.eval(`getComputedStyle(document.body).cursor`), 'crosshair');
  assert.deepEqual(await rg.eval(`Object.keys(window.region).sort()`), ['cancel', 'done'], 'the selection page can only send a rectangle or cancel');
  await mouse(rg, 'mousePressed', 100, 100);
  await mouse(rg, 'mouseMoved', 250, 180);
  assert.equal(await rg.eval(`document.getElementById('size').textContent`), '150 × 80', 'the live size while dragging');
  await mouse(rg, 'mouseMoved', 400, 300);
  fire(rg, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300, button: 'left', buttons: 0, clickCount: 1 }); // the window closes on release
  await waitFor(async () => !(await targets()).some((t) => isRegion(t.url)), { what: 'the selection window closes after the drag' });
  await waitSel(pk5, '[data-pick="region"]', 'the dragged region card');
  assert.equal(await text(pk5, '[data-role="region-size"]'), '300 × 200 points on External Monitor', 'a drag from (100,100) to (400,300)');
  // Esc cancels the next selection and keeps the earlier one
  await click(pk5, '[data-action="region"][data-display="1"]');
  const rg2 = await waitTarget(isRegion, 'the region selection window (Esc)', 30000);
  // (the target is listed as soon as its navigation starts, while the document is still the empty initial one: wait for the page itself)
  await waitFor(() => rg2.eval(`typeof window.region === 'object' && !!document.getElementById('hint') && !document.getElementById('hint').hidden`), { what: 'the selection page (Esc)' });
  // (no drag is started first: this window covers a real display for a moment, and a physical mouse release by whoever is at
  // the machine would end such a drag. Esc alone is what is being tested.)
  evalClosing(rg2, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); // (a CDP key event needs the page to have the focus)
  await waitFor(async () => !(await targets()).some((t) => isRegion(t.url)), { what: 'Esc closes the selection window' });
  await sleep(200);
  assert.equal(await text(pk5, '[data-role="region-size"]'), '300 × 200 points on External Monitor', 'Esc cancelled: the earlier region is unchanged');
  // the hook's rectangle (a scripted drag) replaces it
  await click(pk5, '[data-action="region"][data-display="2"]');
  await waitFor(async () => (await text(pk5, '[data-role="region-size"]')) === '400 × 300 points on External Monitor', { what: 'the scripted region' });
  assert.equal(await pk5.eval(`document.querySelector('input[name=pick]:checked').value`), 'region');
  assert.match(await text(pk5, '[data-role="picker-summary"]'), /^It will receive: a part of the screen \(400 × 300 points\)\.$/);
  assert.deepEqual(dialogsG().filter((d) => d.kind === 'region-select').map((d) => [d.detail.display, d.detail.answer]), [[2, null], [2, 'ui'], [1, 'ui'], [2, { x: 1500, y: 100, w: 400, h: 300 }]]);
  await waitFor(() => pk5.eval(`!!document.querySelector('[data-pick="region"] img')`), { what: 'a preview of the region' });
  assert.ok(thumbsOps().some((o) => o.args.target === 'region' && o.args.region.w === 400), 'the loader captured the preview of the region');
  await shot2x(pk5, 'capture-picker-region');
  clickClosing(pk5, '[data-action="allow-session"]');
  const r5 = await later('cap5');
  assert.equal(r5.ok, true, JSON.stringify(r5));
  assert.deepEqual(r5.value.target, { kind: 'region', region: { x: 1500, y: 100, w: 400, h: 300 }, display: 2, bounds: { x: 1500, y: 100, w: 400, h: 300 }, by: 'user' }, 'a region in global points; the app suggested display 1 and got the user’s region on display 2');
  assert.deepEqual(appOps().at(-1).args, { target: 'region', region: { x: 1500, y: 100, w: 400, h: 300 }, maxWidth: 640, excludePids: [G.pid] });
  await pickerGone();

  step('G: "Allow while the app runs" remembers the permission, never a target');
  const asked = dialogsG().filter((d) => d.kind === 'capture-window').length;
  const r6 = await call('screen-capture', { target: 'window', windowId: 8 });
  assert.equal(r6.ok, true, JSON.stringify(r6));
  assert.deepEqual(r6.value.target, { kind: 'window', windowId: 8, display: 2, bounds: { x: 1500, y: 100, w: 500, h: 400 }, by: 'app' }, 'no question: the app’s own suggestion is captured');
  const r7 = await call('screen-capture', { target: 'display', display: 99 });
  assert.deepEqual(r7.value.target, { kind: 'display', display: 1, bounds: { x: 0, y: 0, w: 1440, h: 900 }, by: 'default' }, 'a suggestion that does not exist: the main display');
  assert.equal(dialogsG().filter((d) => d.kind === 'capture-window').length, asked, 'no picker was opened');
  assert.ok(!(await targets()).some((t) => isPicker(t.url)));
  assert.deepEqual(picks().map((p) => p[0]), ['once', 'deny', 'deny', 'session']);
  assert.deepEqual(picks()[3][1], { kind: 'region', region: { x: 1500, y: 100, w: 400, h: 300 } });
  // every screenshot, the app’s and the loader’s previews, asks the helper to leave the loader’s own windows out
  const allCaps = fakeOps().filter((o) => o.op === 'capture');
  assert.ok(allCaps.length >= 8);
  assert.ok(allCaps.every((o) => JSON.stringify(o.args.excludePids) === JSON.stringify([G.pid])), 'excludePids is the loader’s own process in every capture');

  // ---- the virtual-input overlay ----
  step('G: input control: one overlay window per display, click-through, not focusable, always on top, content-protected');
  assert.equal((await targets()).filter((t) => isOverlay(t.url)).length, 0, 'no overlay before input control starts');
  const started = await call('input-start', 'click the test button');
  assert.equal(started.ok, true, JSON.stringify(started));
  await waitTarget(isBadge, 'control badge (G)');
  let pages = await overlayPages();
  assert.ok(pages.length >= 1, 'an overlay window exists');
  const winProbes = () => jsonl(overlayLog).filter((e) => e.event === 'window');
  assert.equal(winProbes().length, pages.length, 'one overlay window per display');
  assert.equal(new Set(winProbes().map((p) => p.display)).size, pages.length, 'each on its own display');
  for (const p of winProbes()) {
    assert.deepEqual({ ignoreMouseEvents: p.ignoreMouseEvents, focusable: p.focusable, alwaysOnTop: p.alwaysOnTop, contentProtected: p.contentProtected }, { ignoreMouseEvents: true, focusable: false, alwaysOnTop: true, contentProtected: true }, 'the overlay never intercepts a real click and never takes the focus');
    assert.ok(p.bounds.width > 0 && p.bounds.height > 0);
  }
  for (const pg of pages) assert.deepEqual(await pg.eval(`Object.keys(window.overlay).sort()`), ['onEvent', 'ready'], 'the overlay page can only draw');
  const ring = async () => {
    for (const pg of await overlayPages()) {
      const r = await pg.eval(`(() => { const e = document.getElementById('ring'); return { x: e.dataset.x, y: e.dataset.y, inside: e.dataset.inside, down: e.dataset.down, hidden: e.hidden, transform: e.style.transform }; })()`);
      if (r.inside === 'true') return r;
    }
    return null;
  };
  const caption = async () => {
    for (const pg of await overlayPages()) {
      const r = await pg.eval(`(() => { const e = document.getElementById('caption'); return { text: e.dataset.text || '', shown: e.classList.contains('show') }; })()`);
      if (r.text) return r;
    }
    return null;
  };

  step('G: the ring follows every host.input.mouse; a ripple on a click; the pressed state on down/up');
  assert.equal((await call('input-mouse', { action: 'move', x: 10, y: 20 })).ok, true);
  await waitFor(async () => { const r = await ring(); return r && r.x === '10' && r.y === '20' && r.hidden === false; }, { what: 'the ring at (10, 20)' });
  assert.equal((await call('input-mouse', { action: 'move', x: 300, y: 200 })).ok, true);
  await waitFor(async () => { const r = await ring(); return r && r.x === '300' && r.y === '200'; }, { what: 'the ring at (300, 200)' });
  assert.match((await ring()).transform, /^translate3d\(300px, 200px, 0px?\)/);
  const dprobe = jsonl(overlayLog).filter((e) => e.event === 'activity' && e.kind === 'mouse');
  assert.deepEqual(dprobe.map((e) => e.global), [{ x: 10, y: 20 }, { x: 300, y: 200 }], 'the dev probe reports the position each event was drawn at');
  assert.ok(dprobe[0].windows.some((w) => w.inside && w.x === 10 && w.y === 20), 'and where it is inside a display');
  assert.equal((await call('input-mouse', { action: 'click', x: 30, y: 40, clicks: 2 })).ok, true);
  await waitFor(async () => { for (const pg of await overlayPages()) if (await pg.eval(`document.querySelectorAll('.ripple').length >= 1`)) return true; return false; }, { what: 'a ripple', interval: 20 });
  await waitFor(async () => (await ring()).x === '30', { what: 'the ring moved to the click' });
  assert.equal((await call('input-mouse', { action: 'down', x: 50, y: 60, button: 'right' })).ok, true);
  await waitFor(async () => (await ring()).down === 'true', { what: 'pressed' });
  assert.match((await ring()).transform, /scale\(0\.8\)/);
  assert.equal((await call('input-mouse', { action: 'up', x: 50, y: 60, button: 'right' })).ok, true);
  await waitFor(async () => (await ring()).down === 'false', { what: 'released' });

  step('G: typed text is MASKED by default ("typing… (N characters)"); key combinations are shown');
  const TYPED = 'Hello, world! This is a long sentence that goes on';
  assert.equal((await call('input-keys', { text: TYPED })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === `typing… (${TYPED.length} characters)` && c.shown; }, { what: 'the masked typed text caption' });
  assert.ok(!jsonl(overlayLog).some((e) => JSON.stringify(e).includes('Hello')), 'the test probe never sees typed text while it is masked');
  assert.equal((await call('input-keys', { key: 's', modifiers: ['cmd'] })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === '⌘S'; }, { what: 'the ⌘S caption' });
  assert.equal((await call('input-keys', { key: 'p' })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === 'typing… (1 character)'; }, { what: 'a single plain key is typed text too, and masked' });
  assert.equal((await call('input-keys', { key: 'return' })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === '↩'; }, { what: 'Return is a named key, shown' });

  step('G: Host Capabilities has "Show typed text in the overlay" (off by default); turning it on shows the first 28 characters, off masks again at once');
  const isSettings = (u) => u.startsWith('vmapp-loader://ui/settings.html');
  await click(lib, '#btn-settings');
  const sett = await waitTarget(isSettings, 'Host Capabilities window (G)');
  await waitSel(sett, '[data-role="overlay-panel"] [data-role="pref-overlay-typed"]', 'the overlay switch');
  const prefFile = path.join(homeG, 'loader-prefs.json');
  assert.equal(await sett.eval(`document.querySelector('[data-role="pref-overlay-typed"]').checked`), false, 'off by default');
  assert.match(await text(sett, '[data-role="overlay-panel"]'), /Show typed text in the overlay/);
  assert.match(await text(sett, '[data-role="overlay-panel"]'), /typing… \(12 characters\)/, 'the panel explains the mask');
  assert.match(await text(sett, '[data-role="pref-overlay-note"]'), /^Off: typed text is hidden\./);
  assert.equal(fs.existsSync(prefFile), false, 'nothing is written until the user changes it');
  await click(sett, '[data-role="pref-overlay-typed"]');
  await waitFor(() => fs.existsSync(prefFile) && JSON.parse(fs.readFileSync(prefFile, 'utf8')).overlayShowTyped === true, { what: 'the setting is saved' });
  await waitFor(() => sett.eval(`document.querySelector('[data-role="pref-overlay-typed"]').checked && /^On:/.test(document.querySelector('[data-role="pref-overlay-note"]').textContent)`), { what: 'the panel says it is on' });
  assert.equal((await call('input-keys', { text: TYPED })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === 'Hello, world! This is a long…' && c.shown; }, { what: 'the typed text caption (cut at 28 characters) with the setting on' });
  await click(sett, '[data-role="pref-overlay-typed"]');
  await waitFor(() => JSON.parse(fs.readFileSync(prefFile, 'utf8')).overlayShowTyped === false, { what: 'the setting is saved again' });
  assert.equal((await call('input-keys', { text: 'abc' })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === 'typing… (3 characters)'; }, { what: 'masked again at once' });
  assert.deepEqual(await sett.eval(`Object.keys(window.settings).includes('setPref')`), true);
  assert.equal(await lib.eval(`typeof window.loader.setPref + typeof window.settings`), 'undefinedundefined', 'only the settings window can change the setting');
  assert.match(await sett.eval(`window.settings.setPref('overlayShowTypedText', true).then(() => 'accepted', (e) => e.message)`), /unknown preference/, 'only known switches');
  const keyProbes = jsonl(overlayLog).filter((e) => e.event === 'activity' && e.kind === 'keys').map((e) => e.caption);
  assert.ok(keyProbes.includes('typing… (50 characters)') && keyProbes.includes('Hello, world! This is a long…') && keyProbes.includes('typing… (3 characters)'), `the probe logs what the user saw: ${keyProbes.join(' | ')}`);
  await sett.eval(`window.close()`).catch(() => {});
  step('G: a scroll is captioned; the caption shows Return');
  assert.equal((await call('input-mouse', { action: 'scroll', dy: 240 })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === 'Scroll ↓'; }, { what: 'the scroll caption' });
  assert.equal((await call('input-keys', { key: 'return' })).ok, true);
  await waitFor(async () => { const c = await caption(); return c && c.text === '↩'; }, { what: 'the Return caption' });
  const inRing = (await overlayPages())[0];
  for (const pg of await overlayPages()) if ((await pg.eval(`document.getElementById('ring').dataset.inside`)) === 'true') await shot2x(pg, 'input-overlay');
  assert.ok(inRing);
  const inputOps = fakeOps().filter((o) => o.op === 'mouse' || o.op === 'keys');
  assert.ok(inputOps.length >= 8 && inputOps.every((o) => o.args.dryRun === true), 'all input stayed a dry run');

  step('G: the overlay goes away on Stop, on panic and when the app stops');
  assert.equal((await call('input-stop')).ok, true);
  await noOverlay('overlay closes after input stop');
  assert.equal(jsonl(overlayLog).filter((e) => e.event === 'destroyed').length, pages.length, 'every overlay window was destroyed');
  assert.equal((await call('input-start', 'again')).ok, true);
  pages = await overlayPages();
  await waitFor(async () => (await overlayPages()).length >= 1, { what: 'the overlay is back' });
  assert.equal((await call('input-mouse', { action: 'move', x: 5, y: 6 })).ok, true);
  await waitFor(async () => { const r = await ring(); return r && r.x === '5'; }, { what: 'the ring in the new session' });
  fs.writeFileSync(panicFile, '1'); // the fake helper deletes it and sends {"event":"panic"}, as the real one does for ⌃⌥⌘.
  await noOverlay('overlay closes on panic');
  await waitFor(async () => !(await targets()).some((t) => isBadge(t.url)), { what: 'badge closes on panic' });
  assert.equal((await call('input-mouse', { action: 'move', x: 1, y: 2 })).ok, false, 'input is refused after panic');
  assert.equal((await call('input-start', 'a third time')).ok, true);
  await waitFor(async () => (await overlayPages()).length >= 1, { what: 'the overlay is back again' });
  await click(lib, `[data-app="${GID}"] [data-action="stop"]`);
  await waitFor(async () => (await cardState2(lib, GID)) === 'stopped', { what: 'app stopped (G)', timeout: 30000 });
  await noOverlay('overlay closes when the app stops');
  assert.ok(!fakeOps().some((o) => (o.op === 'mouse' || o.op === 'keys') && o.args.dryRun !== true), 'no real input event was ever requested');

  dropConns();
  await killLoader(G, 'SIGTERM', 30000);
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run G', timeout: 15000 });
  step('run G passed');
}

// =============================================================================================== run F: DevTools per window
// SPEC 6 / 7, INV-B1: the app's own core decides DevTools, per window, like Electron's webPreferences.devTools (the SDK sends
// devTools:true|false in window.create; there is no manifest field). The fixture's core opens a "Plain" window (default: off)
// and a "Debuggable" one (webPreferences.devTools: true). The loader's test hook VMAPP_TEST_DEVTOOLS_LOG (dev builds only)
// probes every window once after it loads (the View-menu path, then a direct openDevTools) and also turns on the
// packaged-mode `devtools-opened` closer, which must close DevTools on the loader's own windows.
async function runF(baseline) {
  step('run F: DevTools: the core decides per window (default off); the loader windows never keep them');
  const FID = 'com.vmapp.devtoolstest';
  const homeF = path.join(ROOT, 'home-f');
  const probeLog = path.join(ROOT, 'devtools-probe-f.jsonl');
  const pkgF = path.join(ROOT, 'devtoolstest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-devtools'), pkgF);
  const isAppF = (u) => u.startsWith(`vmapp-ui://${FID}/`);
  const F = startLoader({
    home: homeF,
    name: 'loader-F',
    env: { VMAPP_TEST_DEVTOOLS_LOG: probeLog, VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pkgF], message: 0 }) },
  });
  const lib = await waitTarget(isLibrary, 'library (F)');
  await waitSel(lib, '[data-role="empty"]', 'empty library (F)');

  step('F: install (nothing about DevTools in the review: it is not a permission or a manifest field) and launch');
  await click(lib, '[data-action="install"]');
  await waitSel(lib, '[data-role="review"]', 'install review (F)');
  assert.doesNotMatch(await lib.eval(`(document.querySelector('.sheet') || {}).textContent || ''`), /developer tools/i);
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${FID}"]`, 'card (F)');
  await click(lib, `[data-app="${FID}"] [data-action="launch"]`);
  await waitFor(async () => (await targets()).filter((t) => isAppF(t.url)).length >= 2, { what: 'both app windows (F)', timeout: 90000 });

  step('F: every window is probed once (menu path, then a direct openDevTools attempt)');
  const probes = () => (fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  await waitFor(() => probes().filter((p) => p.kind === 'app').length >= 2 && probes().some((p) => p.kind === 'library'), { what: 'the devtools probes of the library and both app windows', timeout: 60000 });
  const byWin = (n) => probes().find((p) => p.kind === 'app' && p.win === n); // the core creates "Plain" (1) first, then "Debuggable" (2)
  assert.deepEqual(
    byWin(1),
    { kind: 'app', appId: FID, win: 1, requested: false, viaMenu: false, openAfterMenu: false, directEvent: false, openAfterDirect: false },
    'created without devTools: the menu item refuses, and even a direct openDevTools() opens nothing at all (webPreferences.devTools is false: no devtools-opened event, isDevToolsOpened stays false)',
  );
  assert.deepEqual(
    byWin(2),
    { kind: 'app', appId: FID, win: 2, requested: true, viaMenu: true, openAfterMenu: true, directEvent: true, openAfterDirect: true },
    'created with webPreferences.devTools: true: the menu path opens DevTools (and they can be opened again)',
  );
  assert.deepEqual(
    probes().find((p) => p.kind === 'library'),
    { kind: 'library', appId: null, win: null, requested: null, viaMenu: null, openAfterMenu: null, directEvent: true, openAfterDirect: false },
    'a loader window never keeps DevTools (dev webPreferences let them open; the packaged-mode closer closed them at once)',
  );
  assert.equal(probes().filter((p) => p.kind === 'app').length, 2, 'the app has exactly the two windows');
  // the SDK warned once that it ignored the other webPreferences key, and the app window with DevTools off still works
  const logF = fs.readFileSync(path.join(ROOT, 'loader-F.log'), 'utf8');
  assert.equal((logF.match(/webPreferences are ignored except devTools/g) || []).length, 1, 'one warning per run');
  assert.match(logF, /webPreferences are ignored except devTools[^\n]*: nodeIntegration/);
  const plain = await waitTarget(isAppF, 'an app window (F)');
  assert.equal(await plain.eval(`typeof window.vmapp`), 'object');

  step('F: stop');
  await click(lib, `[data-app="${FID}"] [data-action="stop"]`);
  await waitFor(async () => (await cardState2(lib, FID)) === 'stopped', { what: 'app stopped (F)', timeout: 30000 });
  dropConns();
  await killLoader(F, 'SIGTERM', 30000);
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run F', timeout: 15000 });
  step('run F passed');
}
// =============================================================================================== run H: microphone + live monitor
// SPEC 2.2 permissions.devices / SPEC 7 (the microphone is the only permission an app window can ever be given) and the live
// monitor (menu-bar popover + the library's Activity section). Chromium's FAKE media devices are used (dev tests only, the
// switch --use-fake-device-for-media-stream): no real microphone is ever opened, nothing is recorded.
async function runH(baseline) {
  step('run H: microphone permission (denied paths first) and the live monitor');
  const MID = 'com.vmapp.mictest';
  const NOMIC = 'com.vmapp.micless';
  const HID = 'com.vmapp.hostcapstest';
  const homeG = path.join(ROOT, 'home-g');
  const dialogLogG = path.join(ROOT, 'dialogs-g.jsonl');
  const fakeLogG = path.join(ROOT, 'fake-hostctl-g.jsonl');
  const variants = path.join(ROOT, 'variants-g');
  const workG = path.join(ROOT, 'user-g', 'work');
  fs.mkdirSync(variants, { recursive: true });
  fs.mkdirSync(workG, { recursive: true });
  const isMonitor = (u) => u.startsWith('vmapp-loader://ui/monitor.html');
  const isAppG = (id) => (u) => u.startsWith(`vmapp-ui://${id}/`);
  const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const grantsFile = (id) => path.join(homeG, 'grants', `${id}.json`);
  const readGrants = (id) => JSON.parse(fs.readFileSync(grantsFile(id), 'utf8'));
  const card = (id, sel) => `[data-app="${id}"] ${sel}`;

  // ---- fixtures: the mic app (installed through the UI), and three apps installed up front ----
  const pkgMic = path.join(ROOT, 'mictest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-mic'), pkgMic);
  const micless = path.join(variants, 'micless');
  fs.cpSync(path.join(LOADER, 'test', 'fixture-mic'), micless, { recursive: true });
  const mf = path.join(micless, 'vmapp.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.id = NOMIC;
  m.name = 'Mic Less';
  delete m.permissions.devices;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  const pkgNoMic = path.join(variants, 'micless.vmapp');
  hostlib.pack(micless, pkgNoMic);
  const pkgHost = path.join(ROOT, 'hostcaps-g.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-hostcaps'), pkgHost);
  const pkgFolders = path.join(ROOT, 'loadertest-g.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-app'), pkgFolders);
  const pre = new hostlib.Store({ home: homeG, skipRuntimeCheck: true });
  for (const f of [pkgNoMic, pkgHost, pkgFolders]) pre.install(f);
  // the host-capabilities app already has its choices (no sheet): the monitor lists what the user allowed
  fs.mkdirSync(path.join(homeG, 'grants'), { recursive: true });
  fs.writeFileSync(grantsFile(HID), JSON.stringify({ folders: {}, askEveryTime: false, host: { screen: { mode: 'ask' }, input: { mode: 'session' }, 'tool:*': { mode: 'ask', tools: ['echo'] }, 'mcp:*': { mode: 'ask', servers: ['fake'] } } }));
  // an app that does NOT ask for the microphone, with a hand-written grant for it: the manifest decides first
  fs.writeFileSync(grantsFile(NOMIC), JSON.stringify({ folders: {}, askEveryTime: false, devices: { microphone: { mode: 'allow' } } }));

  // a REAL registry with two versions of one app: 1.0.0 asks for nothing, 1.1.0 asks for the microphone ("asks for more")
  const UPD = 'com.vmapp.micupd';
  const micDevices = JSON.parse(fs.readFileSync(path.join(LOADER, 'test', 'fixture-mic', 'vmapp.json'), 'utf8')).permissions.devices;
  const updBuild = (version, devices) => {
    const dir = path.join(variants, `upd-${version}`);
    fs.cpSync(path.join(LOADER, 'test', 'fixture-mic'), dir, { recursive: true });
    const f = path.join(dir, 'vmapp.json');
    const mm = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.assign(mm, { id: UPD, name: 'Mic Upd', version });
    if (devices) mm.permissions.devices = devices;
    else delete mm.permissions.devices;
    fs.writeFileSync(f, JSON.stringify(mm, null, 2));
    const file = path.join(variants, `upd-${version}.vmapp`);
    hostlib.pack(dir, file);
    return file;
  };
  const updFiles = { '1.0.0': updBuild('1.0.0', null), '1.1.0': updBuild('1.1.0', micDevices) };
  const regProc = spawn(process.execPath, [path.join(VMAPP, 'registry', 'server.js'), '--port', '0', '--data', path.join(ROOT, 'registry-data-h'), '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(regProc);
  const regUrl = await new Promise((resolve, reject) => {
    let buf = '';
    regProc.stdout.on('data', (d) => {
      buf += d;
      const mm = /listening on (http:\/\/\S+)/.exec(buf);
      if (mm) resolve(mm[1]);
    });
    regProc.once('exit', () => reject(new Error('the registry exited before it was listening')));
    setTimeout(() => reject(new Error('registry did not start')), 15000);
  });
  let ownerToken = null;
  const publish = async (version) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
    const res = await fetch(`${regUrl}/api/publish`, { method: 'POST', headers, body: fs.readFileSync(updFiles[version]) });
    const j = await res.json();
    assert.equal(res.status, 201, `publish ${version}: ${JSON.stringify(j)}`);
    if (j.ownerToken) ownerToken = j.ownerToken;
  };
  await publish('1.0.0');

  const G = startLoader({
    home: homeG,
    name: 'loader-H',
    // --monitor: the popover opens pinned, so the test can read it. --use-fake-device-for-media-stream switches Chromium to a FAKE
    // microphone. NOT --use-fake-ui-for-media-stream: that switch makes Chromium accept every request itself and would skip
    // the loader's permission handler, which is exactly what this run tests (a packaged loader refuses both switches).
    args: ['--monitor', '--use-fake-device-for-media-stream'],
    env: {
      VMAPP_REGISTRY: regUrl,
      FAKE_HOSTCTL_LOG: fakeLogG,
      VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pkgMic], message: 0 }),
      VMAPP_TEST_DIALOG_LOG: dialogLogG,
      VMAPP_TEST_GRANTS: JSON.stringify({ [ID]: { work: { path: workG, access: 'read' }, extra: null } }),
    },
  });
  const lib = await waitTarget(isLibrary, 'library (G)');
  await waitSel(lib, `[data-app="${NOMIC}"]`, 'preinstalled cards (G)');
  const mon = await waitTarget(isMonitor, 'activity monitor popover (G)');

  step('H: nothing runs yet: the library Activity section and the popover say so');
  await waitSel(lib, '[data-role="activity"] [data-role="act-empty"]', 'empty Activity section');
  await waitSel(mon, '[data-role="act-empty"]', 'empty popover');
  assert.match(await text(lib, '[data-role="activity"]'), /Activity.*No app is running/s);
  assert.deepEqual(await mon.eval(`Object.keys(window.monitor).sort()`), ['inspect', 'onState', 'openLibrary', 'resize', 'showData', 'state', 'stop'], 'the popover page can do nothing but these');
  assert.equal(await mon.eval(`typeof window.loader + typeof window.settings + typeof window.badge`), 'undefinedundefinedundefined', 'only its own API');
  assert.match(await mon.eval(`window.monitor.stop('com.vmapp.nothing').then(() => 'stopped', (e) => e.message)`), /not running/, 'Stop only names a running app');
  assert.match(await mon.eval(`window.monitor.showData('com.vmapp.nothing').then(() => 'shown', (e) => e.message)`), /unknown app/, 'the data folder only of an installed app');
  assert.equal(fs.readFileSync(path.join(ROOT, 'loader-H.log'), 'utf8').includes('menu-bar icon unavailable'), false, 'the menu-bar icon was created');

  step('H: install review lists the microphone (nothing is allowed by installing)');
  await click(lib, '[data-action="install"]');
  await waitSel(lib, '[data-role="review-devices"]', 'devices part of the install review');
  const rv = await lib.eval(`(document.querySelector('.sheet') || {}).textContent || ''`);
  assert.match(rv, /Devices/);
  assert.match(rv, /Use your microphone/);
  assert.match(rv, /Records a voice note when you press the button/, 'the app’s stated reason is shown');
  assert.match(rv, /Installing it allows none of this/);
  assert.equal(await exists(lib, '[data-role="review-host"]'), false);
  await shot2x(lib, 'install-review-devices');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${MID}"]`, 'mic app card');
  assert.match(await text(lib, card(MID, '[data-role="devices-requested"]')), /asks to use: microphone/);
  assert.match(await text(lib, card(MID, '[data-role="devices-grants"]')), /microphone: not allowed/);
  assert.equal(await exists(lib, card(MID, '[data-role="device-chip"]')), false, 'no chip before anything is allowed');

  // ---- default: Don't allow ----
  step('H: permission sheet: "Devices" section, default “Don’t allow”; launching without allowing');
  await click(lib, card(MID, '[data-action="launch"]'));
  await waitSel(lib, '[data-role="device-section"]', 'devices section of the permission sheet');
  assert.equal(await lib.eval(`document.querySelector('[data-device="microphone"] [data-role="device-mode"]').value`), 'none', 'the default is Don’t allow');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-device="microphone"] [data-role="device-mode"] option')].map((o) => [o.value, o.textContent])`), [['none', 'Don’t allow'], ['allow', 'Allow while the app runs']]);
  assert.match(await text(lib, '[data-device="microphone"] [data-role="purpose"]'), /Records a voice note/);
  assert.equal(await exists(lib, '[data-role="folders"]'), false, 'no folder part for an app that asks for no folders');
  await shot2x(lib, 'permission-sheet-devices');
  await click(lib, '[data-action="sheet-launch"]');
  const gDenied = await waitFor(() => fs.existsSync(grantsFile(MID)) && readGrants(MID), { what: 'grants saved (G)' });
  assert.equal(gDenied.devices, undefined, 'nothing is allowed by default');
  const app1 = await waitTarget(isAppG(MID), 'mic app window', 90000);
  await waitFor(() => app1.eval(`document.readyState === 'complete' && typeof window.vmapp === 'object'`), { what: 'app page (G)' });
  const gum = (c, constraints) =>
    c.eval(`navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name)`);
  const everythingDenied = async (c, why) => {
    for (const constraints of [{ audio: true }, { video: true }, { audio: true, video: true }]) {
      assert.equal(await gum(c, constraints), 'NotAllowedError', `${why}: getUserMedia(${JSON.stringify(constraints)}) is rejected`);
    }
    assert.equal(await c.eval(`navigator.permissions.query({ name: 'microphone' }).then((r) => r.state)`), 'denied', `${why}: the microphone permission reads as denied`);
    assert.notEqual(await c.eval(`navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name)`), 'granted', `${why}: screen sharing is not available`);
    assert.equal(await c.eval(`Notification.requestPermission()`), 'denied', `${why}: notifications stay denied`);
    assert.equal(await c.eval(`new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), () => res('denied')))`), 'denied', `${why}: geolocation stays denied`);
  };
  await everythingDenied(app1, 'without a grant');
  // the Inspector kept the refusals (the microphone request is logged either way)
  await click(lib, card(MID, '[data-action="inspect"]'));
  const insp = await waitTarget(isInspector, 'inspector (G)');
  const hostRows = () => insp.eval(`[...document.querySelectorAll('#rows tr.row.host')].map((tr) => ({ cells: [...tr.children].map((td) => td.textContent) }))`);
  await waitFor(async () => (await hostRows()).length >= 4, { what: 'microphone rows in the inspector' });
  const rows1 = await hostRows();
  assert.ok(rows1.filter((r) => r.cells[3] === 'microphone media.audio' && r.cells[7] === 'denied').length >= 1, `the audio request is logged as denied: ${JSON.stringify(rows1.map((r) => r.cells))}`);
  assert.ok(rows1.some((r) => r.cells[3] === 'camera media.video' && r.cells[7] === 'denied'), 'a request with video is denied as a whole and logged');
  assert.ok(!rows1.some((r) => r.cells[7] === 'allowed'), 'nothing was allowed');
  // the popover lists the running app, with no pill: it can reach nothing
  await waitSel(mon, `[data-act-app="${MID}"]`, 'the running app in the popover');
  assert.equal(await exists(mon, `[data-act-app="${MID}"] [data-pill]`), false, 'no pill for an app that can reach nothing');
  assert.match(await text(mon, `[data-act-app="${MID}"] [data-role="no-pills"]`), /Can reach nothing/);
  await click(lib, card(MID, '[data-action="stop"]'));
  await waitFor(async () => (await cardState2(lib, MID)) === 'stopped', { what: 'mic app stopped (G)', timeout: 30000 });
  await waitFor(async () => !(await exists(mon, `[data-act-app="${MID}"]`)), { what: 'popover drops the stopped app' });

  // ---- allow it in the sheet ----
  step('H: allow “while the app runs” in the Permissions sheet; the card says so');
  await click(lib, card(MID, '[data-action="permissions"]'));
  await waitSel(lib, '[data-role="device-section"]', 'devices section (edit)');
  await setIn(lib, '[data-device="microphone"] [data-role="device-mode"]', 'allow');
  await click(lib, '[data-action="sheet-save"]');
  await waitFor(() => (fs.existsSync(grantsFile(MID)) ? readGrants(MID).devices : null), { what: 'device grant saved' }).then((d) => assert.deepEqual(d, { microphone: { mode: 'allow' } }));
  await waitFor(async () => /Can use the microphone/.test((await text(lib, card(MID, '[data-role="device-chip"]'))) || ''), { what: 'the red chip on the card' });
  assert.equal(await lib.eval(`getComputedStyle(document.querySelector(${q(card(MID, '[data-role="device-chip"]'))})).backgroundColor`), 'rgb(196, 35, 28)', 'the chip is red');
  assert.match(await text(lib, card(MID, '[data-role="devices-grants"]')), /microphone: allowed while the app runs/);
  // a renderer cannot save a device or a mode the sheet does not offer
  const sneaky = await lib.eval(`window.loader.savePermissions(${JSON.stringify(MID)}, {}, false, undefined, { camera: { mode: 'allow' }, microphone: { mode: 'always' } }).then(() => 'accepted', (e) => 'rejected: ' + e.message)`);
  assert.match(sneaky, /rejected: .*cannot be set here/);
  assert.deepEqual(readGrants(MID).devices, { microphone: { mode: 'allow' } }, 'the refused attempt changed nothing');

  step('H: with the grant: audio works, video and screen sharing still fail, the indicator shows');
  await click(lib, card(MID, '[data-action="launch"]'));
  const app2 = await waitTarget(isAppG(MID), 'mic app window (granted)', 90000);
  await waitFor(() => app2.eval(`document.readyState === 'complete' && typeof window.vmapp === 'object'`), { what: 'app page (granted)' });
  assert.equal(await exists(lib, '.sheet'), false, 'no sheet: the choices were saved');
  assert.equal(await app2.eval(`navigator.permissions.query({ name: 'microphone' }).then((r) => r.state)`), 'granted');
  const live = await app2.eval(`navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { window.__stream = s; const t = s.getAudioTracks()[0]; return { n: s.getTracks().length, kind: t.kind, state: t.readyState, video: s.getVideoTracks().length }; }, (e) => ({ error: e.name + ': ' + e.message }))`);
  assert.deepEqual(live, { n: 1, kind: 'audio', state: 'live', video: 0 }, `an audio track is live: ${JSON.stringify(live)}`);
  assert.equal(await gum(app2, { video: true }), 'NotAllowedError', 'video is still rejected');
  assert.equal(await gum(app2, { audio: true, video: true }), 'NotAllowedError', 'audio together with video is rejected as a whole');
  assert.notEqual(await app2.eval(`navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => 'granted', (e) => e.name)`), 'granted', 'screen sharing is not available');
  assert.equal(await app2.eval(`Notification.requestPermission()`), 'denied', 'every other permission stays denied');
  assert.equal(await app2.eval(`new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), () => res('denied')))`), 'denied');
  // the indicator: the card (best effort, from the live track) and the monitor pill
  await waitFor(async () => /Using the microphone now/.test((await text(lib, card(MID, '[data-role="mic-active"]'))) || ''), { what: 'the “Using the microphone now” chip', timeout: 20000 });
  const micPill = `[data-act-app="${MID}"] [data-pill="mic"]`;
  await waitFor(() => mon.eval(`(document.querySelector(${q(micPill)}) || {dataset:{}}).dataset.live === '1'`), { what: 'the live microphone pill in the popover', timeout: 20000 });
  const pill = await mon.eval(`(() => { const e = document.querySelector(${q(micPill)}); return { text: e.textContent, cls: e.className, use: e.dataset.use, title: e.title }; })()`);
  assert.match(pill.text, /Microphone.*listening/);
  assert.match(pill.cls, /pulse/);
  assert.match(pill.title, /Microphone: can listen/);
  assert.equal(await exists(lib, `[data-role="activity"] [data-act-app="${MID}"] [data-pill="mic"].pulse`), true, 'the library’s Activity section shows it too');
  await shot2x(lib, 'library-microphone-active');
  await shot2x(mon, 'monitor-microphone-active');
  // the track ends: the indicator goes away
  assert.equal(await app2.eval(`(window.__stream.getTracks().forEach((t) => t.stop()), window.__stream.getAudioTracks()[0].readyState)`), 'ended');
  await waitFor(async () => !(await exists(lib, card(MID, '[data-role="mic-active"]'))), { what: 'the “using now” chip goes away', timeout: 20000 });
  await waitFor(() => mon.eval(`(document.querySelector(${q(micPill)}) || {dataset:{}}).dataset.live === '0'`), { what: 'the pill is no longer live' });
  assert.equal(await exists(lib, card(MID, '[data-role="device-chip"]')), true, 'the “can use” chip stays while the grant stands');
  // the Inspector logged the allowed request
  const rows2 = await hostRows();
  assert.ok(rows2.some((r) => r.cells[3] === 'microphone media.audio' && r.cells[7] === 'allowed'), 'the granted audio request is logged as allowed');

  step('H: revoking applies at once (grants are read at every request)');
  const g0 = readGrants(MID);
  fs.writeFileSync(grantsFile(MID), JSON.stringify({ folders: g0.folders, askEveryTime: g0.askEveryTime }));
  assert.equal(await gum(app2, { audio: true }), 'NotAllowedError', 'rejected right after the grant was removed');
  assert.equal(await app2.eval(`navigator.permissions.query({ name: 'microphone' }).then((r) => r.state)`), 'denied');
  fs.writeFileSync(grantsFile(MID), JSON.stringify(g0));
  assert.equal(await gum(app2, { audio: true }), 'granted', 'and allowed again when it is back');

  // ---- a grant file cannot give an app a device its manifest does not ask for ----
  step('H: a hand-written grant does not help an app whose manifest does not ask for the microphone');
  await click(lib, card(NOMIC, '[data-action="launch"]'));
  const app3 = await waitTarget(isAppG(NOMIC), 'the mic-less app window', 90000);
  await waitFor(() => app3.eval(`document.readyState === 'complete' && typeof window.vmapp === 'object'`), { what: 'mic-less page' });
  await everythingDenied(app3, 'manifest does not ask');
  await click(lib, card(NOMIC, '[data-action="stop"]'));
  await waitFor(async () => (await cardState2(lib, NOMIC)) === 'stopped', { what: 'mic-less app stopped', timeout: 30000 });

  // ---- an update that newly asks for the microphone ----
  step('H: an update that newly asks for the microphone always stops at the “asks for more” sheet');
  await browseInstall(lib, UPD, 'H');
  await waitSel(lib, '[data-role="review"]', 'review of the registry app (H)', 30000);
  assert.equal(await exists(lib, '[data-role="review-devices"]'), false, 'version 1.0.0 asks for no device');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${UPD}"]`, 'registry app card (H)');
  await publish('1.1.0');
  await click(lib, card(UPD, '[data-action="check-updates"]'));
  await waitSel(lib, '[data-role="asks-more"]', 'asks-for-more sheet (devices)', 30000);
  assert.match(await lib.eval(`(document.querySelector('.sheet') || {}).textContent || ''`), /Version 1\.1\.0 asks for more:/);
  const more = await lib.eval(`[...document.querySelectorAll('[data-more="device"]')].map((e) => [e.dataset.device, e.textContent])`);
  assert.equal(more.length, 1);
  assert.equal(more[0][0], 'microphone');
  assert.match(more[0][1], /A new device: Use your microphone.*Records a voice note/);
  assert.equal(fs.readFileSync(path.join(homeG, 'apps', UPD, 'current'), 'utf8').trim(), '1.0.0', 'nothing changes before the user decides');
  await shot2x(lib, 'asks-for-more-devices');
  await click(lib, '[data-action="update-review"]'); // "Update and review permissions": installed, then the sheet, microphone on Don't allow
  await waitSel(lib, '[data-role="device-section"]', 'permission sheet after the update');
  assert.equal(await lib.eval(`document.querySelector('[data-device="microphone"] [data-role="device-mode"]').value`), 'none', 'the new device is off until the user allows it');
  assert.equal(fs.readFileSync(path.join(homeG, 'apps', UPD, 'current'), 'utf8').trim(), '1.1.0');
  assert.ok(!fs.existsSync(grantsFile(UPD)) || readGrants(UPD).devices === undefined, 'the update granted nothing');
  await click(lib, '[data-action="cancel"]');

  // ---- the monitor with several apps ----
  step('H: monitor: folders, screen, input, tools, MCP and the microphone pills of three running apps');
  await click(lib, card(HID, '[data-action="launch"]'));
  await click(lib, card(ID, '[data-action="launch"]'));
  const appH = await waitTarget(isAppG(HID), 'host caps app window (G)', 90000);
  await waitTarget(isAppG(ID), 'folders app window (G)', 90000);
  await waitFor(() => appH.eval(`typeof window.vmapp === 'object' && document.readyState === 'complete'`), { what: 'host caps page (G)' });
  for (const id of [MID, HID, ID]) await waitSel(mon, `[data-act-app="${id}"]`, `popover row ${id}`);
  const pills = (c, id) => c.eval(`[...document.querySelectorAll('[data-act-app="${id}"] [data-pill]')].map((e) => [e.dataset.pill, e.textContent.trim(), e.title])`);
  assert.deepEqual((await pills(mon, HID)).map((p) => p[0]), ['screen', 'input', 'tools', 'mcp'], 'the host-capability pills, in order');
  const hp = await pills(mon, HID);
  assert.match(hp[0][2], /Screen: can see your screen \(asks you every time\)/);
  assert.match(hp[1][2], /Input: .*\(allowed while the app runs\)/);
  assert.match(hp[2][2], /Tools: echo/);
  assert.match(hp[3][2], /MCP servers: fake/);
  const fp = await pills(mon, ID);
  assert.deepEqual(fp.map((p) => [p[0], p[1]]), [['folders', 'Folders 1']], 'the folders pill counts the granted folders');
  assert.match(fp[0][2], /work \(read only\)/, 'the folder names are in the hover text');
  assert.deepEqual((await pills(mon, MID)).map((p) => p[0]), ['mic']);
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-role="activity"] [data-act-app]')].map((e) => e.dataset.actApp).sort()`), [HID, ID, MID].sort(), 'the library Activity section lists the same three apps');
  assert.deepEqual((await pills(lib, HID)).map((p) => p[0]), ['screen', 'input', 'tools', 'mcp'], 'with the same pills');
  assert.equal(await lib.eval(`[...document.querySelectorAll('[data-role="activity"] [data-act-app] button')].every((b) => b.dataset.action === 'act-stop')`), true, 'the library’s section is compact: Stop only');
  assert.deepEqual(await mon.eval(`[...document.querySelectorAll('[data-act-app="${ID}"] button')].map((b) => b.dataset.action)`), ['act-inspect', 'act-data', 'act-stop']);
  // an event makes the pill pulse for about 2 seconds
  assert.equal(await mon.eval(`document.querySelector('[data-act-app="${HID}"] [data-pill="input"]').dataset.use`), '0', 'idle: not pulsing');
  const call = (ch, ...args) => appH.eval(`window.vmapp.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)})`);
  const started = await call('input-start', 'monitor test');
  assert.equal(started.ok, true, JSON.stringify(started));
  await waitFor(() => mon.eval(`document.querySelector('[data-act-app="${HID}"] [data-pill="input"]').dataset.live === '1'`), { what: 'input pill live during the session' });
  assert.equal(await mon.eval(`document.querySelector('[data-act-app="${HID}"] [data-pill="input"]').classList.contains('pulse')`), true);
  assert.equal(await call('input-stop').then((r) => r.ok), true);
  await waitFor(() => mon.eval(`document.querySelector('[data-act-app="${HID}"] [data-pill="input"]').dataset.live === '0'`), { what: 'input pill no longer live' });
  await waitFor(() => mon.eval(`!document.querySelector('[data-act-app="${HID}"] [data-pill="input"]').classList.contains('pulse')`), { what: 'pulse ends about 2 s after the last event', timeout: 8000 });
  await shot2x(mon, 'monitor-three-apps');

  step('H: monitor: Stop, Inspect and “Show app data in Finder” from the popover');
  await click(mon, `[data-act-app="${ID}"] [data-action="act-data"]`);
  await waitFor(() => jsonl(dialogLogG).some((d) => d.kind === 'show-in-folder' && d.detail === path.join(homeG, 'data', ID)), { what: 'show-in-folder recorded for the app’s data folder' });
  assert.deepEqual(jsonl(dialogLogG).filter((d) => d.kind === 'show-in-folder').map((d) => d.detail), [path.join(homeG, 'data', ID)], 'only that folder, named by the loader');
  const vmsG = testVms(homeG).map((p) => p.pid);
  assert.ok(vmsG.length >= 3, `three VMs run (${vmsG.length})`);
  await click(mon, `[data-act-app="${ID}"] [data-action="act-stop"]`);
  await waitFor(async () => (await cardState2(lib, ID)) === 'stopped', { what: 'folders app stopped from the popover', timeout: 30000 });
  await waitFor(async () => !(await exists(mon, `[data-act-app="${ID}"]`)), { what: 'its row leaves the popover' });
  await waitFor(async () => !(await exists(lib, `[data-role="activity"] [data-act-app="${ID}"]`)), { what: 'and the library’s Activity section' });
  assert.equal(await exists(mon, `[data-act-app="${MID}"]`), true, 'the other apps keep running');
  assert.equal(testVms(homeG).length, vmsG.length - 1, 'one VM fewer');
  const inspBefore = (await targets()).filter((t) => isInspector(t.url)).length;
  await click(mon, `[data-act-app="${HID}"] [data-action="act-inspect"]`);
  await waitFor(async () => (await targets()).some((t) => isInspector(t.url)), { what: 'the inspector is open' });
  assert.ok(inspBefore <= 1);
  await waitFor(async () => (await insp.eval(`document.getElementById('app-select').value`)) === HID, { what: 'the inspector shows the app that was inspected' });

  step('H: stop everything; the loader quits cleanly');
  for (const id of [HID, MID]) await click(mon, `[data-act-app="${id}"] [data-action="act-stop"]`);
  await waitFor(async () => (await mon.eval(`document.querySelectorAll('[data-act-app]').length`)) === 0, { what: 'popover empty again', timeout: 30000 });
  await waitFor(async () => /No app is running/.test(await text(lib, '[data-role="activity"]')), { what: 'library Activity empty again' });
  dropConns();
  await killLoader(G, 'SIGTERM', 30000);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-H.log'), 'utf8').includes('unhandled rejection'), 'no unhandled rejection in the loader log');
  regProc.kill('SIGTERM');
  await new Promise((r) => regProc.once('exit', r));
  await waitFor(() => vmCount() <= baseline, { what: 'VMs at baseline after run H', timeout: 15000 });
  step('run H passed');
}

// =============================================================================================== run I: network UI + the VM's size
// SPEC 8.3 (network) and SPEC 2.2 / 8 (the VM's size is the user's choice). A REAL VM runs the fixture-net app. Network traffic
// needs no internet: a host that was not granted is refused by vmapp-vm before any lookup, and a granted `api.example.com` either
// does not resolve or fails to connect (still a row). The install review lists the hosts (wildcard and port 80 marked) and the
// loud "could read your folder and send it" banner; the permission sheet has a Network section (every host on Don't allow),
// a live risk banner and a Resources section; the card shows the grants, an amber chip and the monitor pill; a grant changed in
// "Network…" applies to the RUNNING app at once; the Inspector has `net` rows and a Network filter; an update that asks for more
// ports / hosts stops at the "asks for more" sheet, and the old grant does not widen. The VM really has the size the user chose.
async function runI() {
  step('run I: network permission UI and the VM size the user chooses');
  const NID = 'com.vmapp.nettest';
  const UPD = 'com.vmapp.netupd';
  const homeI = path.join(ROOT, 'home-i');
  const dialogLogI = path.join(ROOT, 'dialogs-i.jsonl');
  const variants = path.join(ROOT, 'variants-i');
  const notesI = path.join(ROOT, 'user-i', 'notes');
  fs.mkdirSync(variants, { recursive: true });
  fs.mkdirSync(notesI, { recursive: true });
  const isMonitor = (u) => u.startsWith('vmapp-loader://ui/monitor.html');
  const isAppN = (u) => u.startsWith(`vmapp-ui://${NID}/`);
  const grantsFile = (id) => path.join(homeI, 'grants', `${id}.json`);
  const readGrants = (id) => JSON.parse(fs.readFileSync(grantsFile(id), 'utf8'));
  const card = (id, sel) => `[data-app="${id}"] ${sel}`;
  const limits = hostlib.resources.hostLimits(); // the same numbers the loader computes (its logical cores, half of its memory)
  assert.ok(limits.cpus >= 2, 'this test needs a Mac with at least 2 logical cores');
  assert.ok(limits.memoryMiB >= 1024, 'and at least 2 GiB of memory');

  const pkgNet = path.join(ROOT, 'nettest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-net'), pkgNet);

  // a REAL registry with two versions of one app: 1.1.0 asks for more ports on a host and for a new wildcard host
  const updBuild = (version, network) => {
    const dir = path.join(variants, `upd-${version}`);
    fs.cpSync(path.join(LOADER, 'test', 'fixture-net'), dir, { recursive: true });
    const f = path.join(dir, 'vmapp.json');
    const mm = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.assign(mm, { id: UPD, name: 'Net Upd', version });
    mm.permissions.network = network;
    fs.writeFileSync(f, JSON.stringify(mm, null, 2));
    const file = path.join(variants, `upd-${version}.vmapp`);
    hostlib.pack(dir, file);
    return file;
  };
  const updFiles = {
    '1.0.0': updBuild('1.0.0', [{ host: 'api.example.com', purpose: 'Syncs' }]),
    '1.1.0': updBuild('1.1.0', [{ host: 'api.example.com', ports: [443, 8443], purpose: 'Syncs, also on a second port' }, { host: '*.example.org', purpose: 'Loads files from everywhere' }]),
    // DEV-APPS C2: any public host on any port, the "full access" request
    '1.2.0': updBuild('1.2.0', [
      { host: 'api.example.com', ports: [443, 8443], purpose: 'Syncs, also on a second port' },
      { host: '*.example.org', purpose: 'Loads files from everywhere' },
      { host: '*', ports: '*', purpose: 'Anything you reach from its terminal' },
    ]),
  };
  const regProc = spawn(process.execPath, [path.join(VMAPP, 'registry', 'server.js'), '--port', '0', '--data', path.join(ROOT, 'registry-data-i'), '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(regProc);
  const regUrl = await new Promise((resolve, reject) => {
    let buf = '';
    regProc.stdout.on('data', (d) => {
      buf += d;
      const mm = /listening on (http:\/\/\S+)/.exec(buf);
      if (mm) resolve(mm[1]);
    });
    regProc.once('exit', () => reject(new Error('the registry exited before it was listening')));
    setTimeout(() => reject(new Error('registry did not start')), 15000);
  });
  let ownerToken = null;
  const publish = async (version) => {
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
    const res = await fetch(`${regUrl}/api/publish`, { method: 'POST', headers, body: fs.readFileSync(updFiles[version]) });
    const j = await res.json();
    assert.equal(res.status, 201, `publish ${version}: ${JSON.stringify(j)}`);
    if (j.ownerToken) ownerToken = j.ownerToken;
  };
  await publish('1.0.0');

  const L = startLoader({
    home: homeI,
    name: 'loader-I',
    args: ['--monitor'],
    env: { VMAPP_REGISTRY: regUrl, VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pkgNet, notesI], message: 0 }), VMAPP_TEST_DIALOG_LOG: dialogLogI },
  });
  const lib = await waitTarget(isLibrary, 'library (I)');
  await waitSel(lib, '[data-role="empty"]', 'empty library (I)');
  const mon = await waitTarget(isMonitor, 'activity monitor popover (I)');
  const banners = () => lib.eval(`[...document.querySelectorAll('#banners .banner')].map((b) => b.className + ': ' + b.textContent)`);

  // ---- the install review ----
  step('I: the install review lists the hosts (wildcard and port 80 marked) and warns that the app could read the folder and send it out');
  await click(lib, '[data-action="install"]');
  await waitSel(lib, '[data-role="review-network"]', 'network part of the install review');
  const rv = await lib.eval(`(document.querySelector('.sheet') || {}).textContent || ''`);
  assert.match(rv, /Network/);
  assert.match(await text(lib, '[data-role="review-network"] [data-role="net-risk"]'), /^This app could read the folder “notes” and send what it reads to api\.example\.com and \*\.cdn\.example\.com\.$/, 'INV-N4: the loader’s own sentence');
  assert.equal(await lib.eval(`getComputedStyle(document.querySelector('[data-role="review-network"] [data-role="net-risk"]')).color`), 'rgb(196, 35, 28)', 'the banner is red');
  assert.match(await text(lib, '[data-net-host="api.example.com"] [data-role="purpose"]'), /Syncs your notes with its service/);
  assert.equal(await text(lib, '[data-net-host="api.example.com"] [data-role="net-ports-asked"]'), 'port 443');
  assert.equal(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-ports-asked"]'), 'ports 443, 80 (not encrypted)');
  assert.match(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-wildcard"]'), /^Wildcard: any address under cdn\.example\.com\. It covers many servers/);
  assert.equal(await exists(lib, '[data-net-host="api.example.com"] [data-role="net-wildcard"]'), false, 'an exact host is not marked');
  assert.match(rv, /Installing it allows none of this/);
  assert.match(await text(lib, '[data-role="review"]'), /recommends 2 vCPUs, 512 MB \(you choose the size when you first launch it\)/);
  assert.equal(await exists(lib, '[data-role="review-host"]'), false);
  await shot2x(lib, 'install-review-network');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${NID}"]`, 'net app card');

  // ---- the card, before anything is allowed ----
  step('I: the card: nothing allowed, no chip; a Resources row with the defaults (1 vCPU, the recommended memory)');
  assert.match(await text(lib, card(NID, '[data-role="net-requested"]')), /asks to reach: api\.example\.com, \*\.cdn\.example\.com/);
  assert.equal(await text(lib, card(NID, '[data-role="net-grants"]')), 'api.example.com: not allowed  •  *.cdn.example.com: not allowed');
  assert.equal(await exists(lib, card(NID, '[data-role="net-chip"]')), false, 'no chip before anything is allowed');
  assert.equal(await exists(lib, card(NID, '[data-role="net-risk-active"]')), false);
  assert.equal(fs.existsSync(grantsFile(NID)), false, 'installing granted and saved nothing');
  const res = card(NID, '[data-role="resources"]');
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-role="res-cpus"]')}).value`), '1', 'the default is ONE vCPU, whatever the app recommends');
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-role="res-memory"]')}).value`), '512', 'and the recommended memory');
  assert.equal(await text(lib, res + ' [data-role="res-source"]'), 'default');
  assert.equal(await text(lib, res + ' [data-action="use-recommended"]'), 'Use recommended (2 vCPUs, 512 MB)');
  assert.equal((await text(lib, res + ' [data-role="res-warning"]')) || '', '', 'the memory is the recommendation: no warning');
  assert.match(await text(lib, res + ' [data-role="res-note"]'), /The app recommends 2 vCPUs; with fewer it may be slower\./);
  assert.match(await text(lib, res + ' [data-role="res-hint"]'), new RegExp(`up to ${limits.cpus} vCPUs and ${limits.memoryMiB} MB for one app\\. The app recommends 2 vCPUs, 512 MB; you choose\\.`));
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-role="res-cpus"]')}).max`), String(limits.cpus), 'at most the Mac’s logical cores');
  const memOptions = await lib.eval(`[...document.querySelectorAll(${q(res + ' [data-role="res-memory"] option')})].map((o) => [Number(o.value), o.textContent])`);
  assert.ok(memOptions.every(([m]) => m >= 64 && m <= limits.memoryMiB), 'memory choices stay within half of the Mac’s memory');
  assert.ok(memOptions.some(([m, t]) => m === 512 && t === '512 MB (recommended)'));
  assert.ok(memOptions.some(([m]) => m === 64) && memOptions.at(-1)[0] >= Math.min(limits.memoryMiB, 4096));
  await shot2x(lib, 'card-resources-network');

  step('I: the Resources row on the card: stepper, memory, “Use recommended”, a warning below the recommendation; saved at once');
  await click(lib, res + ' [data-action="cpus-inc"]');
  await waitFor(() => fs.existsSync(grantsFile(NID)) && readGrants(NID).resources, { what: 'the chosen size is saved' }).then((r) => assert.deepEqual(r, { cpus: 2, memoryMiB: 512 }));
  assert.deepEqual(readGrants(NID), { resources: { cpus: 2, memoryMiB: 512 } }, 'a file that holds only the size says nothing else');
  assert.equal(await text(lib, res + ' [data-role="res-source"]'), 'your choice');
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-action="use-recommended"]')}).disabled`), true, 'already at the recommendation');
  assert.equal((await text(lib, res + ' [data-role="res-note"]')) || '', '');
  await setIn(lib, res + ' [data-role="res-memory"]', '256');
  await waitFor(() => readGrants(NID).resources.memoryMiB === 256, { what: 'memory saved' });
  assert.match(await text(lib, res + ' [data-role="res-warning"]'), /^That is less memory than the 512 MB the app recommends: it may run slowly or fail\.$/);
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-action="use-recommended"]')}).disabled`), false);
  await click(lib, res + ' [data-action="use-recommended"]');
  await waitFor(() => readGrants(NID).resources.memoryMiB === 512, { what: 'recommended memory saved' });
  assert.deepEqual(readGrants(NID).resources, { cpus: 2, memoryMiB: 512 });
  assert.equal((await text(lib, res + ' [data-role="res-warning"]')) || '', '');
  // never more than the Mac has: the stepper stops, the page cannot ask for more, and the loader refuses it again
  await setIn(lib, res + ' [data-role="res-cpus"]', '999');
  await waitFor(() => readGrants(NID).resources.cpus === limits.cpus, { what: 'vCPUs capped at the Mac’s cores' });
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-role="res-cpus"]')}).value`), String(limits.cpus));
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-action="cpus-inc"]')}).disabled`), true, '+ stops at the cap');
  assert.match(await lib.eval(`window.loader.setResources(${q(NID)}, { cpus: ${limits.cpus + 1}, memoryMiB: 512 }).then(() => 'accepted', (e) => e.message)`), /more than it can give/);
  assert.match(await lib.eval(`window.loader.setResources(${q(NID)}, { cpus: 1, memoryMiB: ${limits.memoryMiB + 1} }).then(() => 'accepted', (e) => e.message)`), /more than half of this Mac's memory/);
  assert.match(await lib.eval(`window.loader.setResources(${q(NID)}, { cpus: 1, memoryMiB: 10 }).then(() => 'accepted', (e) => e.message)`), /at least 64/);
  assert.equal(readGrants(NID).resources.cpus, limits.cpus, 'the refused choices changed nothing');
  await setIn(lib, res + ' [data-role="res-cpus"]', '2');
  await waitFor(() => readGrants(NID).resources.cpus === 2, { what: 'two vCPUs saved' });

  // ---- the permission sheet ----
  step('I: launch: the permission sheet has a Network section (everything on “Don’t allow”), a live risk banner and a Resources section');
  await click(lib, card(NID, '[data-action="launch"]'));
  await waitSel(lib, '[data-role="net-section"]', 'network section of the permission sheet');
  assert.equal(await exists(lib, '.sheet [data-role="folders"]'), true, 'the folder part is there too');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-role="net-section"] [data-net-host]')].map((e) => e.dataset.netHost)`), ['api.example.com', '*.cdn.example.com']);
  for (const host of ['api.example.com', '*.cdn.example.com']) {
    assert.equal(await lib.eval(`document.querySelector('[data-net-host="${host}"] [data-role="net-mode"]').value`), 'none', `${host} starts on Don’t allow`);
  }
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-net-host="api.example.com"] [data-role="net-mode"] option')].map((o) => [o.value, o.textContent])`), [['none', 'Don’t allow'], ['allow', 'Allow']]);
  assert.match(await text(lib, '[data-role="net-section"] .hostwarn'), /Everything starts as “Don’t allow”/);
  assert.match(await text(lib, '[data-net-host="api.example.com"] [data-role="purpose"]'), /Syncs your notes with its service/);
  assert.equal(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-wildcard-chip"]'), 'wildcard');
  assert.equal(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-insecure-chip"]'), 'not encrypted');
  assert.match(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-wildcard"]'), /Wildcard: any address under cdn\.example\.com\. It covers many servers, not one, so you are trusting all of them\./, 'a wildcard gets an explicit warning');
  assert.match(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-insecure"]'), /Port 80 is plain HTTP/);
  assert.equal(await exists(lib, '[data-net-host="api.example.com"] [data-role="net-ports"]'), false, 'one port: nothing to pick');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="*.cdn.example.com"] [data-role="net-ports"]').hidden`), true, 'ports are chosen once the host is allowed');
  await waitSel(lib, '[data-role="net-risk"]', 'the risk banner');
  assert.match(await text(lib, '.sheet [data-role="net-risk"]'), /^This app could read the folder “notes” and send what it reads to api\.example\.com and \*\.cdn\.example\.com\.$/);
  assert.equal(await exists(lib, '[data-role="net-risk-active"]'), false, 'nothing is allowed yet, so “could”, not “can”');
  // the Resources section shows what the card chose; “Use recommended” is already satisfied
  assert.equal(await lib.eval(`document.querySelector('[data-role="resources-section"] [data-role="res-cpus"]').value`), '2');
  assert.equal(await lib.eval(`document.querySelector('[data-role="resources-section"] [data-role="res-memory"]').value`), '512');
  assert.equal(await text(lib, '[data-role="resources-section"] [data-role="res-source"]'), 'your choice');
  await shot2x(lib, 'permission-sheet-network');

  step('I: the warning follows the choices: it says “can” once a readable folder AND a host are both allowed');
  await click(lib, '[data-folder="notes"] [data-action="choose"]');
  await waitFor(async () => (await text(lib, '[data-folder="notes"] [data-role="path"]')) === notesI, { what: 'folder chosen' });
  await sleep(300);
  assert.equal(await exists(lib, '[data-role="net-risk-active"]'), false, 'a folder but no host');
  await setIn(lib, '[data-net-host="api.example.com"] [data-role="net-mode"]', 'allow');
  await waitSel(lib, '[data-role="net-risk-active"]', 'the active warning');
  assert.equal(await text(lib, '[data-role="net-risk-active"]'), 'Right now: This app can read the folder “notes” and send what it reads to api.example.com. You have allowed both.');
  assert.equal(await lib.eval(`getComputedStyle(document.querySelector('[data-role="net-risk-active"]')).backgroundColor`), 'rgb(196, 35, 28)', 'loud: a solid red box');
  await setIn(lib, '[data-net-host="api.example.com"] [data-role="net-mode"]', 'none');
  await waitFor(async () => !(await exists(lib, '[data-role="net-risk-active"]')), { what: 'the active warning goes away' });
  await setIn(lib, '[data-net-host="api.example.com"] [data-role="net-mode"]', 'allow');
  await waitSel(lib, '[data-role="net-risk-active"]', 'the active warning again');
  await shot2x(lib, 'permission-sheet-network-risk');

  step('I: a wildcard can be allowed on fewer ports; at least one port is needed');
  await setIn(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-mode"]', 'allow');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="*.cdn.example.com"] [data-role="net-ports"]').hidden`), false);
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-net-host="*.cdn.example.com"] [data-port]')].map((b) => [b.dataset.port, b.checked])`), [['443', true], ['80', true]]);
  assert.match(await text(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-ports"]'), /80 \(not encrypted\)/);
  await setChecked(lib, '[data-net-host="*.cdn.example.com"] [data-port="443"]', false);
  await setChecked(lib, '[data-net-host="*.cdn.example.com"] [data-port="80"]', false);
  await click(lib, '[data-action="sheet-launch"]');
  await waitFor(async () => (await banners()).some((b) => /Pick at least one port for “\*\.cdn\.example\.com”/.test(b)), { what: 'the error banner' });
  assert.equal(await exists(lib, '.sheet'), true, 'the sheet stays open');
  assert.equal(readGrants(NID).network, undefined, 'nothing was saved');
  await setChecked(lib, '[data-net-host="*.cdn.example.com"] [data-port="443"]', true);
  // the VM size in the sheet: 768 MB (a change from the card’s 512)
  await setIn(lib, '[data-role="resources-section"] [data-role="res-memory"]', '768');
  assert.match(await text(lib, '[data-role="resources-section"] [data-role="res-source"]'), /your choice/);
  await click(lib, '[data-action="sheet-launch"]');
  const g1 = await waitFor(() => (fs.existsSync(grantsFile(NID)) && readGrants(NID).network ? readGrants(NID) : null), { what: 'the sheet’s choices are saved' });
  assert.deepEqual(g1.network, { 'api.example.com': { allow: true }, '*.cdn.example.com': { allow: true, ports: [443] } }, 'allowed hosts, the wildcard on port 443 only');
  assert.deepEqual(g1.folders, { notes: { path: notesI, access: 'read' } });
  assert.deepEqual(g1.resources, { cpus: 2, memoryMiB: 768 });

  // ---- the running app ----
  step('I: the app runs in a REAL VM with the size the user chose (2 vCPUs, 768 MB), not the manifest’s');
  const appN = await waitTarget(isAppN, 'net app window', 90000);
  await waitFor(() => appN.eval(`document.readyState === 'complete' && typeof window.vmapp === 'object'`), { what: 'net app page' });
  const callN = (ch, ...args) => appN.eval(`window.vmapp.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)})`);
  const size = await callN('vm:size');
  assert.equal(size.cpus, 2, `the VM has the 2 vCPUs the user chose: ${JSON.stringify(size)}`);
  assert.ok(size.memKiB > 600 * 1024 && size.memKiB <= 768 * 1024, `the VM has about 768 MiB, not the recommended 512: ${JSON.stringify(size)}`);
  await waitFor(async () => (await cardState2(lib, NID)) === 'running', { what: 'net app running' });

  step('I: the card while it runs: amber chip, the loader’s warning, a locked Resources row, and “Network…” still available');
  assert.equal(await text(lib, card(NID, '[data-role="net-chip"]')), 'Can reach the internet');
  assert.match(await lib.eval(`document.querySelector(${q(card(NID, '[data-role="net-chip"]'))}).title`), /api\.example\.com \(port 443\); \*\.cdn\.example\.com \(port 443\)/);
  assert.equal(await text(lib, card(NID, '[data-role="net-risk-active"]')), 'This app can read the folder “notes” and send what it reads to api.example.com and *.cdn.example.com.');
  assert.equal(await text(lib, card(NID, '[data-role="net-grants"]')), 'api.example.com: allowed on port 443  •  *.cdn.example.com: allowed on port 443');
  assert.equal(await text(lib, res + ' [data-role="res-locked"]'), 'Stop the app to change its size.');
  for (const sel of ['[data-role="res-cpus"]', '[data-role="res-memory"]', '[data-action="use-recommended"]', '[data-action="cpus-inc"]', '[data-action="cpus-dec"]']) {
    assert.equal(await lib.eval(`document.querySelector(${q(res + ' ' + sel)}).disabled`), true, `${sel} is disabled while the app runs`);
  }
  assert.equal(await lib.eval(`document.querySelector(${q(card(NID, '[data-action="permissions"]'))}).disabled`), true);
  assert.equal(await lib.eval(`document.querySelector(${q(card(NID, '[data-action="network"]'))}).disabled`), false, 'the network can be changed while it runs');
  assert.match(await lib.eval(`window.loader.setResources(${q(NID)}, { cpus: 1, memoryMiB: 256 }).then(() => 'accepted', (e) => e.message)`), /Stop the app first/, 'a VM cannot change size while it runs');
  assert.deepEqual(readGrants(NID).resources, { cpus: 2, memoryMiB: 768 });
  await shot2x(lib, 'card-running-network');

  step('I: the monitor pill “Network” and the library’s Activity section show the granted hosts');
  const netPill = (id) => `[data-act-app="${id}"] [data-pill="net"]`;
  await waitSel(mon, netPill(NID), 'the Network pill in the popover');
  assert.equal(await text(mon, netPill(NID)), 'Network');
  assert.equal(await mon.eval(`document.querySelector(${q(netPill(NID))}).title`), 'Network: api.example.com:443, *.cdn.example.com:443');
  await waitSel(lib, `[data-role="activity"] ${netPill(NID)}`, 'the Network pill in the library’s Activity section');

  // ---- the Inspector ----
  step('I: the Inspector shows every connection as a `net` row (host, port, allowed or denied, bytes up and down, duration, reason)');
  const denied1 = await callN('net:fetch', 'https://other.example.net/');
  assert.ok(denied1.error, `a host that was not granted is refused: ${JSON.stringify(denied1)}`);
  const open1 = await callN('net:fetch', 'https://api.example.com/');
  assert.ok(open1.error || open1.status, JSON.stringify(open1)); // (it does not resolve or fails to connect; either way a row)
  await click(lib, card(NID, '[data-action="inspect"]'));
  const insp = await waitTarget(isInspector, 'inspector (I)');
  const netRows = () => insp.eval(`[...document.querySelectorAll('#rows tr.row.net')].map((tr) => ({ type: tr.children[2].textContent, target: tr.querySelector('[data-role="net-target"]').firstChild.textContent, reason: (tr.querySelector('[data-role="net-reason"]') || {}).textContent || '', bytes: tr.querySelector('[data-role="net-bytes"]').textContent, duration: tr.children[6].textContent, result: tr.querySelector('[data-role="host-result"]').textContent, resultClass: tr.querySelector('[data-role="host-result"]').className, hidden: tr.classList.contains('hidden'), seq: tr.dataset.seq }))`);
  await waitFor(async () => (await netRows()).some((r) => r.target === 'other.example.net:443') && (await netRows()).some((r) => r.target === 'api.example.com:443'), { what: 'the net rows' });
  const rows = await netRows();
  const rDenied = rows.find((r) => r.target === 'other.example.net:443');
  assert.equal(rDenied.type, 'net');
  assert.equal(rDenied.result, 'denied');
  assert.match(rDenied.resultClass, /res-denied/);
  assert.match(rDenied.reason, /not allowed: other\.example\.net:443/, `a refusal says why: ${rDenied.reason}`);
  assert.match(rDenied.bytes, /^↑0 B ↓0 B$/);
  const rApi = rows.find((r) => r.target === 'api.example.com:443');
  assert.equal(rApi.result, 'allowed', 'the granted host: the host allowed it (the attempt itself may fail without the internet)');
  assert.match(rApi.resultClass, /res-allowed/);
  assert.match(rApi.bytes, /^↑[\d.]+ (B|KiB|MiB) ↓[\d.]+ (B|KiB|MiB)$/);
  assert.match(rApi.duration, /^\d+ ms$/);
  await shot2x(insp, 'inspector-network');
  // the Network filter shows only these rows; Host and the text filter still work
  await click(insp, '#btn-net');
  assert.equal(await insp.eval(`document.getElementById('btn-net').getAttribute('aria-pressed')`), 'true');
  assert.equal(await insp.eval(`[...document.querySelectorAll('#rows tr.row:not(.hidden)')].every((tr) => tr.classList.contains('net'))`), true, 'only network rows are visible');
  assert.ok(await insp.eval(`document.querySelectorAll('#rows tr.row:not(.net):not(.hidden)').length === 0 && document.querySelectorAll('#rows tr.row.net:not(.hidden)').length >= 2`));
  assert.ok(await insp.eval(`document.querySelectorAll('#rows tr.row.hidden').length > 0`), 'the other rows are hidden, not gone');
  await setIn(insp, '#filter', 'other.example');
  assert.deepEqual((await netRows()).filter((r) => !r.hidden).map((r) => r.target), ['other.example.net:443'], 'the text filter searches host names');
  await setIn(insp, '#filter', '');
  await click(insp, '#btn-net');
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row:not(.hidden)').length > document.querySelectorAll('#rows tr.row.net').length`), true, 'without the filter every row is back');
  // the details of a row
  await insp.eval(`document.querySelector('#rows tr.row.net[data-seq="${rDenied.seq}"]').click()`);
  const meta = await insp.eval(`[...document.querySelectorAll('#detail-meta dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])`);
  const metaOf = (k) => (meta.find((m) => m[0] === k) || [])[1];
  assert.equal(metaOf('Host'), 'other.example.net');
  assert.equal(metaOf('Port'), '443');
  assert.match(metaOf('Result'), /^denied/);
  assert.equal(metaOf('Bytes up'), '0 (from the app)');
  assert.equal(metaOf('Bytes down'), '0 (to the app)');
  assert.match(metaOf('Reason'), /not allowed: other\.example\.net:443/);
  // an allowed connection makes the pill pulse (a refused one is not use)
  await callN('net:fetch', 'https://api.example.com/');
  await waitFor(() => mon.eval(`document.querySelector(${q(netPill(NID))}).dataset.use === '1'`), { what: 'the Network pill pulses on an allowed connection', timeout: 8000 });

  // ---- a grant changed while the app runs ----
  step('I: “Network…” while the app runs: taking api.example.com away cuts it off at once (syncNetwork)');
  const apiDeniedCount = async () => (await netRows()).filter((r) => r.target === 'api.example.com:443' && r.result === 'denied').length;
  assert.equal(await apiDeniedCount(), 0, 'api.example.com has only been allowed so far');
  await click(lib, card(NID, '[data-action="network"]'));
  await waitSel(lib, '[data-role="network-sheet"] [data-role="net-section"]', 'the Network… sheet');
  assert.equal(await exists(lib, '[data-role="network-sheet"] [data-role="folders"]'), false, 'only the network part');
  assert.match(await text(lib, '[data-role="net-running"]'), /The app is running\. What you choose here applies to it at once/);
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="api.example.com"] [data-role="net-mode"]').value`), 'allow', 'it shows the saved choice');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-net-host="*.cdn.example.com"] [data-port]')].map((b) => [b.dataset.port, b.checked])`), [['443', true], ['80', false]], 'and the saved ports');
  await waitSel(lib, '[data-role="net-risk-active"]', 'the active warning in the Network… sheet');
  await setIn(lib, '[data-net-host="api.example.com"] [data-role="net-mode"]', 'none');
  await shot2x(lib, 'network-sheet-running');
  await click(lib, '[data-action="net-save"]');
  await waitFor(() => readGrants(NID).network['api.example.com'].allow === false, { what: 'the change is saved' });
  await waitFor(async () => (await banners()).some((b) => /Network access saved and applied to “Net Test” \(cut off: api\.example\.com\)\./.test(b)), { what: 'the banner says it was applied' });
  assert.deepEqual(readGrants(NID).network['*.cdn.example.com'], { allow: true, ports: [443] }, 'the other host is untouched');
  assert.deepEqual(readGrants(NID).resources, { cpus: 2, memoryMiB: 768 }, 'and so is the size');
  const after1 = await callN('net:fetch', 'https://api.example.com/');
  assert.ok(after1.error, `the same fetch now fails: ${JSON.stringify(after1)}`);
  await waitFor(async () => (await apiDeniedCount()) >= 1, { what: 'a DENIED row for api.example.com in the Inspector' });
  const rRevoked = (await netRows()).find((r) => r.target === 'api.example.com:443' && r.result === 'denied');
  assert.match(rRevoked.reason, /not allowed: api\.example\.com:443/);
  await waitFor(async () => (await mon.eval(`document.querySelector(${q(netPill(NID))}).title`)) === 'Network: *.cdn.example.com:443', { what: 'the pill follows the grants' });
  await waitFor(async () => (await text(lib, card(NID, '[data-role="net-risk-active"]'))) === 'This app can read the folder “notes” and send what it reads to *.cdn.example.com.', { what: 'the card’s warning follows the grants' });

  step('I: allowing it again applies at once too; taking everything away removes the chip, the pill and the warning');
  const apiAllowedCount = async () => (await netRows()).filter((r) => r.target === 'api.example.com:443' && r.result === 'allowed').length;
  const before = await apiAllowedCount();
  await click(lib, card(NID, '[data-action="network"]'));
  await waitSel(lib, '[data-role="network-sheet"]', 'Network… sheet again');
  await setIn(lib, '[data-net-host="api.example.com"] [data-role="net-mode"]', 'allow');
  await click(lib, '[data-action="net-save"]');
  await waitFor(() => readGrants(NID).network['api.example.com'].allow === true, { what: 'allowed again' });
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed' });
  await callN('net:fetch', 'https://api.example.com/');
  await waitFor(async () => (await apiAllowedCount()) > before, { what: 'an ALLOWED row again' });
  await click(lib, card(NID, '[data-action="network"]'));
  await waitSel(lib, '[data-role="network-sheet"]', 'Network… sheet (revoke all)');
  await setIn(lib, '[data-net-host="api.example.com"] [data-role="net-mode"]', 'none');
  await setIn(lib, '[data-net-host="*.cdn.example.com"] [data-role="net-mode"]', 'none');
  await click(lib, '[data-action="net-save"]');
  await waitFor(() => Object.values(readGrants(NID).network).every((g) => g.allow === false), { what: 'everything taken away' });
  await waitFor(async () => !(await exists(lib, card(NID, '[data-role="net-chip"]'))), { what: 'the chip goes' });
  await waitFor(async () => !(await exists(lib, card(NID, '[data-role="net-risk-active"]'))), { what: 'the warning goes' });
  await waitFor(async () => !(await exists(mon, netPill(NID))), { what: 'the pill goes' });
  const after2 = await callN('net:fetch', 'https://api.example.com/');
  assert.ok(after2.error, `with nothing allowed the fetch fails: ${JSON.stringify(after2)}`);
  // a renderer cannot grant more than the sheet offers, or change the network of an app that is not the library's
  assert.match(await lib.eval(`window.loader.saveNetwork(${q(NID)}, { 'api.example.com': { allow: true, ports: [22] } }).then(() => 'accepted', (e) => e.message)`), /wider than the requested/);
  assert.equal(readGrants(NID).network['api.example.com'].allow, false, 'the refused grant changed nothing');
  assert.equal(await appN.eval(`typeof window.loader + typeof window.settings`), 'undefinedundefined', 'the app’s window has no way to reach any of this');

  // ---- stop; the saved choices; Reset ----
  step('I: stop; the sheet shows the saved choices; Reset forgets the size and the network choices');
  await click(lib, card(NID, '[data-action="stop"]'));
  await waitFor(async () => (await cardState2(lib, NID)) === 'stopped', { what: 'net app stopped', timeout: 30000 });
  await waitFor(() => testVms(homeI).length === 0, { what: 'no VM of run I', timeout: 20000 });
  await waitFor(async () => !(await exists(mon, `[data-act-app="${NID}"]`)), { what: 'popover drops the stopped app' });
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-role="res-cpus"]')}).disabled`), false, 'the size can be changed again');
  await click(lib, card(NID, '[data-action="permissions"]'));
  await waitSel(lib, '[data-role="net-section"]', 'permission sheet (edit)');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="api.example.com"] [data-role="net-mode"]').value`), 'none');
  assert.equal(await lib.eval(`document.querySelector('[data-role="resources-section"] [data-role="res-memory"]').value`), '768');
  await click(lib, '[data-action="cancel"]');
  await click(lib, card(NID, '[data-action="reset"]'));
  await click(lib, '[data-action="confirm-reset"]');
  await waitFor(() => !fs.existsSync(grantsFile(NID)), { what: 'Reset forgets the grants, size included' });
  await waitFor(async () => (await lib.eval(`document.querySelector(${q(res + ' [data-role="res-cpus"]')}).value`)) === '1', { what: 'the card is back to the defaults' });
  assert.equal(await text(lib, res + ' [data-role="res-source"]'), 'default');
  assert.equal(await lib.eval(`document.querySelector(${q(res + ' [data-role="res-memory"]')}).value`), '512');

  // ---- an update that asks for more ----
  step('I: an update that asks for more ports on a host and a new wildcard host stops at the “asks for more” sheet; the old grant does not widen');
  await browseInstall(lib, UPD, 'I');
  await waitSel(lib, '[data-role="review"]', 'review of the registry app (I)', 30000);
  assert.match(await text(lib, '[data-role="review-network"]'), /api\.example\.com/);
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${UPD}"]`, 'registry app card (I)');
  // the user's earlier choice (made in the sheet): api.example.com allowed (all the ports version 1.0.0 asks for)
  fs.mkdirSync(path.join(homeI, 'grants'), { recursive: true });
  fs.writeFileSync(grantsFile(UPD), JSON.stringify({ folders: { notes: { path: notesI, access: 'read' } }, askEveryTime: false, network: { 'api.example.com': { allow: true } } }));
  await publish('1.1.0');
  await click(lib, card(UPD, '[data-action="check-updates"]'));
  await waitSel(lib, '[data-role="asks-more"]', 'asks-for-more sheet (network)', 30000);
  assert.match(await lib.eval(`(document.querySelector('.sheet') || {}).textContent || ''`), /Version 1\.1\.0 asks for more:/);
  const more = await lib.eval(`[...document.querySelectorAll('[data-more="net"]')].map((e) => [e.dataset.host, e.dataset.kind, e.textContent, e.className])`);
  assert.deepEqual(more.map((m) => [m[0], m[1]]), [['api.example.com', 'ports'], ['*.example.org', 'host']]);
  assert.match(more[0][2], /^More network ports on api\.example\.com: port 8443\. Syncs, also on a second port$/);
  assert.match(more[1][2], /^A new address to reach: \*\.example\.org \(port 443\)\. Wildcard: any address under example\.org\. It covers many servers, not one, so you are trusting all of them\. Loads files from everywhere$/);
  assert.equal(more[1][3], 'err', 'a wildcard is marked');
  assert.match(await text(lib, '[data-role="asks-more"] [data-role="net-risk"]'), /could read the folder “notes” and send what it reads to api\.example\.com and \*\.example\.org/, 'and the combined risk of the new version is spelled out');
  assert.equal(fs.readFileSync(path.join(homeI, 'apps', UPD, 'current'), 'utf8').trim(), '1.0.0', 'nothing changes before the user decides');
  assert.deepEqual(readGrants(UPD).network, { 'api.example.com': { allow: true } });
  await shot2x(lib, 'asks-for-more-network');
  await click(lib, '[data-action="update-review"]');
  await waitSel(lib, '[data-role="net-section"]', 'permission sheet after the update');
  assert.equal(fs.readFileSync(path.join(homeI, 'apps', UPD, 'current'), 'utf8').trim(), '1.1.0');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="api.example.com"] [data-role="net-mode"]').value`), 'allow', 'the earlier choice is kept');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-net-host="api.example.com"] [data-port]')].map((b) => [b.dataset.port, b.checked])`), [['443', true], ['8443', false]], 'but the new port is OFF: an update never grants anything');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="*.example.org"] [data-role="net-mode"]').value`), 'none', 'the new host is off');
  assert.deepEqual(readGrants(UPD).network, { 'api.example.com': { allow: true, ports: [443] } }, 'the grant was pinned to the port the user saw');
  await click(lib, '[data-action="cancel"]');

  step('I: an update that asks for any server on any port ("*", DEV-APPS C2): its own red row, off until allowed, the loader’s words');
  await publish('1.2.0');
  await click(lib, card(UPD, '[data-action="check-updates"]'));
  await waitSel(lib, '[data-role="asks-more"]', 'asks-for-more sheet (any host)', 30000);
  const moreAny = await lib.eval(`[...document.querySelectorAll('[data-more="net"]')].map((e) => [e.dataset.host, e.dataset.kind, e.textContent, e.className])`);
  assert.deepEqual(moreAny.map((m) => [m[0], m[1], m[3]]), [['*', 'host', 'err']], 'only the new "*" entry is news');
  assert.match(moreAny[0][2], /^A new address to reach: any server on the internet \(any port \(including 80, not encrypted\)\)\. Any server on the internet: the app can connect to every public address there is, and send there anything it can read\. Your local network and this Mac stay unreachable\. Port 80 is not encrypted\. Anything you reach from its terminal$/);
  assert.match(await text(lib, '[data-role="asks-more"] [data-role="net-risk"]'), /could read the folder “notes” and send what it reads to any server on the internet\./);
  await click(lib, '[data-action="update-review"]');
  await waitSel(lib, '[data-net-host="*"]', 'the "*" entry in the permission sheet');
  assert.equal(await text(lib, '[data-net-host="*"] [data-role="net-any-chip"]'), 'any server');
  assert.match(await text(lib, '[data-net-host="*"] [data-role="net-any"]'), /^Any server on the internet: .* Your local network and this Mac stay unreachable\.$/);
  assert.equal(await text(lib, '[data-net-host="*"] [data-role="net-ports-asked"]'), 'asks for any port (including 80, not encrypted)');
  assert.equal(await exists(lib, '[data-net-host="*"] [data-role="net-ports"]'), false, 'any port: allowed or not as a whole, nothing to pick');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="*"] [data-role="net-mode"]').value`), 'none', '"*" starts on Don’t allow');
  assert.equal(await lib.eval(`document.querySelector('[data-net-host="*"]').classList.contains('serious')`), true);
  await shot2x(lib, 'permission-sheet-any-host');
  await setIn(lib, '[data-net-host="*"] [data-role="net-mode"]', 'allow');
  await click(lib, '[data-action="sheet-save"]');
  await waitFor(() => (readGrants(UPD).network || {})['*'], { what: 'the "*" grant is saved' });
  assert.deepEqual(readGrants(UPD).network['*'], { allow: true }, 'any server, every port it asked for');
  assert.deepEqual(hostlib.network.resolveNetwork(hostlib.manifest.parseManifest(fs.readFileSync(path.join(homeI, 'apps', UPD, '1.2.0', 'vmapp.json')), { files: 'required' }), readGrants(UPD)).args.filter((a) => a.startsWith('*:')), ['*:*'], 'the VM would get the rule *:*');
  await waitFor(async () => /can read the folder “notes” and send what it reads to any server on the internet/.test(await text(lib, card(UPD, '[data-role="net-risk-active"]')).catch(() => '')), { what: 'the card’s active risk sentence' });
  assert.equal(await text(lib, card(UPD, '[data-role="net-chip"]')), 'Can reach any server');

  step('I: quit cleanly');
  dropConns();
  await killLoader(L, 'SIGTERM', 30000);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-I.log'), 'utf8').includes('unhandled rejection'), 'no unhandled rejection in the loader log');
  regProc.kill('SIGTERM');
  await new Promise((r) => regProc.once('exit', r));
  await waitFor(() => testVms(homeI).length === 0, { what: 'no VM of run I after quitting', timeout: 15000 });
  step('run I passed');
}

// =============================================================================================== run J: the GPU (SPEC 8.6)
async function runJ() {
  step('run J: the GPU capability: permission sheet, chip, GPU… button, monitor pill, Inspector rows and filter (stand-in server)');
  const GID = 'com.vmapp.gputest';
  const homeJ = path.join(ROOT, 'home-j');
  const dialogLogJ = path.join(ROOT, 'dialogs-j.jsonl');
  const stubDir = path.join(ROOT, 'gpu-stub');
  const serverLog = path.join(stubDir, 'server.jsonl');
  const control = path.join(stubDir, 'control');
  const wrapper = path.join(stubDir, 'rpc-server');
  const profile = path.join(stubDir, 'rpc-server.sb');
  const fakeServer = path.join(LOADER, 'test', 'fake-gpu-server', 'fake-rpc-server.js');
  const isMonitor = (u) => u.startsWith('vmapp-loader://ui/monitor.html');
  const isAppG = (u) => u.startsWith(`vmapp-ui://${GID}/`);
  const grantsFile = path.join(homeJ, 'grants', `${GID}.json`);
  const readGrants = () => JSON.parse(fs.readFileSync(grantsFile, 'utf8'));
  const card = (sel) => `[data-app="${GID}"] ${sel}`;
  const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const serverEvents = (event) => jsonl(serverLog).filter((e) => e.event === event);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const sheetText = (c) => c.eval(`(document.querySelector('.sheet') || {}).textContent || ''`);
  const HELPER_NOTE = /The helper processes the app’s requests, so only allow apps you trust with your GPU\./;
  const GPU_WORDS = /Run work on your Mac’s GPU \(Metal\), through a sandboxed helper/;
  const RED = 'rgb(196, 35, 28)';

  // ---- the stand-in for the sandboxed rpc-server: a wrapper the loader starts like the real binary (through sandbox-exec) ----
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(fakeServer)} --test-log ${sq(serverLog)} --test-control ${sq(control)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(profile, '(version 1)\n(allow default)\n');
  const pkgGpu = path.join(ROOT, 'gputest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-gpu'), pkgGpu);

  const L = startLoader({
    home: homeJ,
    name: 'loader-J',
    args: ['--monitor'],
    env: { VMAPP_GPU_SERVER: wrapper, VMAPP_GPU_PROFILE: profile, VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pkgGpu], message: 0 }), VMAPP_TEST_DIALOG_LOG: dialogLogJ },
  });
  const lib = await waitTarget(isLibrary, 'library (J)');
  await waitSel(lib, '[data-role="empty"]', 'empty library (J)');
  const mon = await waitTarget(isMonitor, 'activity monitor popover (J)');
  const banners = () => lib.eval(`[...document.querySelectorAll('#banners .banner')].map((b) => b.className + ': ' + b.textContent)`);
  const pill = `[data-act-app="${GID}"] [data-pill="gpu"]`;
  const waitApp = async () => {
    const app = await waitTarget(isAppG, 'gpu app window', 90000);
    await waitFor(() => app.eval(`document.readyState === 'complete' && typeof window.vmapp === 'object'`), { what: 'gpu app page' });
    await waitFor(async () => (await cardState2(lib, GID)) === 'running', { what: 'gpu app running' });
    return (ch, ...args) => app.eval(`window.vmapp.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)})`);
  };
  const launchApp = async () => {
    await click(lib, card('[data-action="launch"]'));
    return waitApp();
  };
  const stopApp = async () => {
    await click(lib, card('[data-action="stop"]'));
    await waitFor(async () => (await cardState2(lib, GID)) === 'stopped', { what: 'gpu app stopped', timeout: 30000 });
    await waitFor(() => testVms(homeJ).length === 0, { what: 'no VM of run J', timeout: 20000 });
  };

  // ---- the install review ----
  step('J: the install review lists the GPU (in the loader’s words, not as control of the computer); installing allows nothing');
  await click(lib, '[data-action="install"]');
  await waitSel(lib, '[data-role="review-host"]', 'host part of the review (J)');
  assert.equal(await exists(lib, '[data-role="control-label"]'), false, 'the GPU is not "control of your computer"');
  assert.match(await text(lib, '[data-role="review-host"] [data-cap="gpu"]'), GPU_WORDS);
  assert.equal(await text(lib, '[data-role="review-host"] [data-cap="gpu"] .chip.amber'), 'uses your GPU');
  assert.match(await text(lib, '[data-role="review-host"] [data-cap="gpu"] .purpose'), /Runs a small language model on your GPU/);
  assert.match(await text(lib, '[data-role="review-host"] [data-cap="gpu"] [data-role="host-note"]'), HELPER_NOTE);
  const rv = await sheetText(lib);
  assert.match(rv, /Installing it allows none of this\. At its first launch you choose Don’t allow \(the default\) or Allow while the app runs\./);
  assert.doesNotMatch(rv, /Ask every time/, 'the GPU has no "Ask every time"');
  await shot2x(lib, 'install-review-gpu');
  await click(lib, '[data-action="confirm-install"]');
  await waitSel(lib, `[data-app="${GID}"]`, 'gpu app card');

  // ---- the card, before anything is allowed ----
  step('J: the card: nothing allowed, no chip; a “GPU…” button');
  assert.equal(await text(lib, card('[data-role="host-requested"]')), 'asks to: GPU');
  assert.equal(await text(lib, card('[data-role="host-grants"]')), 'gpu: not allowed');
  assert.equal(await exists(lib, card('[data-role="gpu-chip"]')), false, 'no chip before the GPU is allowed');
  assert.equal(await exists(lib, card('[data-role="host-chip"]')), false);
  assert.equal(await text(lib, card('[data-action="gpu"]')), 'GPU…');
  assert.equal(fs.existsSync(grantsFile), false, 'installing granted and saved nothing');

  // ---- the permission sheet ----
  step('J: launch: the permission sheet has the GPU on “Don’t allow”, with “Allow while the app runs” and no “Ask every time”');
  await click(lib, card('[data-action="launch"]'));
  await waitSel(lib, '[data-role="host-section"]', 'host section of the permission sheet (J)');
  const modes = await lib.eval(`[...document.querySelectorAll('[data-role="host-section"] .hostcap')].map((r) => [r.dataset.cap, r.querySelector('[data-role="host-mode"]').value, [...r.querySelectorAll('[data-role="host-mode"] option')].map((o) => o.value + '=' + o.textContent).join('/'), r.classList.contains('serious')])`);
  assert.deepEqual(modes, [['gpu', 'none', 'none=Don’t allow/session=Allow while the app runs', false]], 'one row, off by default, only on or off');
  assert.match(await text(lib, '[data-cap="gpu"]'), GPU_WORDS);
  assert.equal(await text(lib, '[data-cap="gpu"] .chip.amber'), 'uses your GPU');
  assert.match(await text(lib, '[data-cap="gpu"] [data-role="purpose"]'), /Runs a small language model on your GPU/);
  assert.match(await text(lib, '[data-cap="gpu"] [data-role="host-note"]'), HELPER_NOTE);
  await shot2x(lib, 'permission-sheet-gpu');

  // ---- not allowed: the app has no GPU and no server is started ----
  step('J: launched on “Don’t allow”: no $VMAPP_GPU_RPC, nothing listens, no server was started, no chip and no pill');
  await click(lib, '[data-action="sheet-launch"]');
  let call = await waitApp();
  assert.deepEqual(await call('gpu:env'), { gpu: null }, 'the core is not told about a GPU');
  const noGpu = await call('gpu:ping', 16, 100);
  assert.equal(noGpu.ok, false);
  assert.match(noGpu.error, /VMAPP_GPU_RPC is not set/);
  assert.equal(readGrants().host === undefined || readGrants().host.gpu === undefined, true, 'no GPU grant was saved');
  assert.deepEqual(jsonl(serverLog), [], 'no GPU server was started');
  assert.equal(await exists(lib, card('[data-role="gpu-chip"]')), false);
  assert.equal(await exists(mon, pill), false, 'no GPU pill');
  await stopApp();

  // ---- allow it in the Permissions sheet ----
  step('J: Permissions…: “Allow while the app runs” is saved; the card gets the amber “Can use your GPU” chip (not the red control chip)');
  await click(lib, card('[data-action="permissions"]'));
  await waitSel(lib, '[data-role="host-section"]', 'permission sheet (edit, J)');
  assert.equal(await lib.eval(`document.querySelector('[data-cap="gpu"] [data-role="host-mode"]').value`), 'none');
  await setIn(lib, '[data-cap="gpu"] [data-role="host-mode"]', 'session');
  await click(lib, '[data-action="sheet-save"]');
  await waitFor(() => fs.existsSync(grantsFile) && readGrants().host && readGrants().host.gpu, { what: 'the GPU grant is saved' });
  assert.deepEqual(readGrants().host, { gpu: { mode: 'session' } });
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed (J)' });
  assert.equal(await text(lib, card('[data-role="host-grants"]')), 'gpu: allowed while the app runs');
  assert.equal(await text(lib, card('[data-role="gpu-chip"]')), 'Can use your GPU');
  assert.match(await lib.eval(`document.querySelector(${q(card('[data-role="gpu-chip"]'))}).title`), /You allowed this app to run work on your Mac’s GPU while it runs, through a sandboxed helper/);
  assert.equal(await lib.eval(`document.querySelector(${q(card('[data-role="gpu-chip"]'))}).classList.contains('amber')`), true, 'amber');
  assert.notEqual(await lib.eval(`getComputedStyle(document.querySelector(${q(card('[data-role="gpu-chip"]'))})).backgroundColor`), RED, 'not the red of control');
  assert.equal(await exists(lib, card('[data-role="host-chip"]')), false, 'the GPU is not "Can control your computer"');
  await shot2x(lib, 'card-gpu-allowed');

  // ---- a server that cannot start ----
  step('J: allowed, but the server cannot start: the app runs without a GPU, and the Inspector says “failed”');
  fs.writeFileSync(control, 'fail');
  call = await launchApp();
  assert.deepEqual(await call('gpu:env'), { gpu: null }, 'no server, so the core is not told about a GPU');
  assert.equal(serverEvents('fail').length, 1);
  assert.equal(serverEvents('listening').length, 0);
  await click(lib, card('[data-action="inspect"]'));
  const insp = await waitTarget(isInspector, 'inspector (J)');
  const gpuRows = () =>
    insp.eval(`[...document.querySelectorAll('#rows tr.row.gpu')].map((tr) => ({ type: tr.children[2].textContent, target: tr.querySelector('[data-role="gpu-target"]').firstChild.textContent, reason: (tr.querySelector('[data-role="gpu-reason"]') || {}).textContent || '', bytes: tr.children[5].textContent, duration: tr.children[6].textContent, result: tr.querySelector('[data-role="host-result"]').textContent, resultClass: tr.querySelector('[data-role="host-result"]').className, hidden: tr.classList.contains('hidden'), err: tr.classList.contains('err'), seq: Number(tr.dataset.seq) }))`);
  const meta = async (seq) => {
    await insp.eval(`document.querySelector('#rows tr.row[data-seq="${seq}"]').click()`);
    const m = await insp.eval(`[...document.querySelectorAll('#detail-meta dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])`);
    return (k) => (m.find((x) => x[0] === k) || [])[1];
  };
  await waitFor(async () => (await gpuRows()).some((r) => r.target === 'gpu server start'), { what: 'the failed start row' });
  const failedRow = (await gpuRows()).find((r) => r.target === 'gpu server start');
  assert.equal(failedRow.type, 'gpu');
  assert.equal(failedRow.result, 'failed', 'a server that did not start is “failed” (it was allowed, then did not work)');
  assert.match(failedRow.resultClass, /res-denied/);
  assert.equal(failedRow.err, true);
  let m = await meta(failedRow.seq);
  assert.equal(m('GPU server'), 'could not be started');
  assert.match(m('Why'), /simulated failure: cannot create the Metal device/);
  await stopApp();
  fs.rmSync(control, { force: true });

  // ---- allowed and working ----
  step('J: allowed: the server starts (sandbox-exec profile, loopback port, MTL0), the core gets $VMAPP_GPU_RPC, the chip and the pills show');
  const startsBefore = serverEvents('start').length;
  call = await launchApp();
  assert.deepEqual(await call('gpu:env'), { gpu: '127.0.0.1:50052' }, 'the core finds the GPU at the fixed address');
  await waitFor(() => serverEvents('listening').length === 1, { what: 'the stand-in server is listening' });
  const started = serverEvents('start').at(-1);
  assert.equal(serverEvents('start').length, startsBefore + 1);
  assert.equal(started.host, '127.0.0.1', 'loopback only');
  assert.ok(Number.isInteger(started.port) && started.port >= 1024 && started.port <= 65535, `a port the loader picked: ${started.port}`);
  assert.equal(started.device, 'MTL0');
  assert.ok(alive(started.pid), 'the server process is running');
  assert.equal(await text(lib, card('[data-role="gpu-chip"]')), 'Can use your GPU');
  await waitSel(mon, pill, 'the GPU pill in the popover');
  assert.equal(await text(mon, pill), 'GPU');
  assert.equal(await mon.eval(`document.querySelector(${q(pill)}).title`), 'GPU: can run work on your Mac’s GPU (Metal) through a sandboxed helper, while the app runs');
  await waitSel(lib, `[data-role="activity"] ${pill}`, 'the GPU pill in the library’s Activity section');
  await shot2x(lib, 'card-running-gpu');
  await shot2x(mon, 'monitor-gpu');

  step('J: bytes go through 127.0.0.1:50052 to the server; the Inspector lists the server and the tunnel as gpu rows (names and byte counts only)');
  const ping = await call('gpu:ping', 4096, 1200);
  assert.deepEqual(ping, { addr: '127.0.0.1:50052', ok: true, echoed: 4096 }, 'the stand-in echoed what the app sent through the tunnel');
  await waitFor(() => serverEvents('closed').length === 1, { what: 'the server saw the connection close' });
  assert.equal(serverEvents('closed')[0].bytes, 4096);
  await waitFor(() => mon.eval(`document.querySelector(${q(pill)}).dataset.use === '1'`), { what: 'the GPU pill pulses when the tunnel is used', timeout: 8000 });
  await waitFor(async () => (await gpuRows()).some((r) => r.target.startsWith('gpu disconnect #')), { what: 'the disconnect row' });
  const rows = await gpuRows();
  const startRow = rows.find((r) => r.target === 'gpu server start' && r.result === 'allowed');
  assert.ok(startRow, 'the server start is a row');
  assert.equal(startRow.bytes, '', 'server rows have no byte counts');
  const connRow = rows.find((r) => r.target.startsWith('gpu connect #'));
  const tunnel = /#(\d+)$/.exec(connRow.target)[1];
  const trafficRow = rows.find((r) => r.target === `gpu traffic #${tunnel}`);
  const discRow = rows.find((r) => r.target === `gpu disconnect #${tunnel}`);
  assert.ok(trafficRow, 'a traffic row with the counters');
  assert.ok(connRow.seq < trafficRow.seq && trafficRow.seq < discRow.seq, 'connect, then traffic, then disconnect');
  assert.equal(connRow.bytes, '↑0 B ↓0 B');
  assert.equal(trafficRow.bytes, '↑4.0 KiB ↓4.0 KiB');
  assert.equal(discRow.bytes, '↑4.0 KiB ↓4.0 KiB', 'what the app sent and what it got back');
  assert.match(discRow.duration, /^\d+ ms$/);
  for (const r of [startRow, connRow, trafficRow, discRow]) {
    assert.equal(r.type, 'gpu');
    assert.equal(r.result, 'allowed');
    assert.match(r.resultClass, /res-allowed/);
    assert.equal(r.err, false);
  }
  m = await meta(connRow.seq);
  assert.equal(m('GPU connection'), `#${tunnel}: connect`);
  assert.equal(m('Result'), 'allowed');
  assert.equal(m('Bytes up'), '0 (from the app)');
  m = await meta(discRow.seq);
  assert.equal(m('Bytes up'), '4096 (from the app)');
  assert.equal(m('Bytes down'), '4096 (to the app)');
  m = await meta(startRow.seq);
  assert.equal(m('GPU server'), 'started (sandboxed, on 127.0.0.1 only)');
  assert.equal(m('Port'), String(started.port));
  assert.equal(m('Process'), String(started.pid));
  assert.ok(!/[\u0007]{4}/.test(await insp.eval(`document.body.textContent`)), 'what the app sent (bytes of 7) is not in the Inspector');
  await shot2x(insp, 'inspector-gpu');

  step('J: the Inspector’s GPU filter shows only gpu rows (the others are hidden, not gone); it combines with the text filter and with Host');
  const total = await insp.eval(`document.querySelectorAll('#rows tr.row').length`);
  assert.ok(total > rows.length, 'the generic bridge rows are there too');
  await click(insp, '#btn-gpu');
  assert.equal(await insp.eval(`document.getElementById('btn-gpu').getAttribute('aria-pressed')`), 'true');
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row:not(.hidden)').length`), (await gpuRows()).length, 'the GPU filter shows exactly the gpu rows');
  assert.equal(await insp.eval(`[...document.querySelectorAll('#rows tr.row:not(.hidden)')].every((tr) => tr.dataset.t === 'gpu')`), true);
  assert.ok(await insp.eval(`document.querySelectorAll('#rows tr.row.hidden').length > 0`), 'the other rows are hidden, not gone');
  await setIn(insp, '#filter', 'disconnect');
  const onlyDisc = (await gpuRows()).filter((r) => !r.hidden).map((r) => r.target);
  assert.ok(onlyDisc.length >= 1 && onlyDisc.every((t) => t.startsWith('gpu disconnect #')), `the text filter narrows the gpu rows: ${onlyDisc}`);
  await setIn(insp, '#filter', '');
  await click(insp, '#btn-gpu');
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row:not(.hidden)').length`), total, 'without the filter every row is back');
  await click(insp, '#btn-host');
  assert.equal(await insp.eval(`document.querySelectorAll('#rows tr.row.gpu:not(.hidden)').length`), 0, 'the Host filter is about the computer, not the GPU');
  await click(insp, '#btn-host');

  // ---- taking it away while the app runs ----
  step('J: “GPU…” while the app runs: Don’t allow stops the server and closes the tunnels at once; the app keeps running');
  await click(lib, card('[data-action="gpu"]'));
  await waitSel(lib, '[data-role="gpu-sheet"]', 'the GPU… sheet');
  assert.match(await text(lib, '[data-role="gpu-running"]'), /^The app is running\. Taking the GPU away applies at once: its connections close and its helper stops\. Allowing it starts at the next launch\.$/);
  assert.match(await text(lib, '.sheet [data-cap="gpu"]'), GPU_WORDS);
  assert.match(await text(lib, '.sheet [data-cap="gpu"] [data-role="host-note"]'), HELPER_NOTE);
  assert.equal(await lib.eval(`document.querySelector('[data-role="gpu-mode"]').value`), 'session', 'it shows the saved choice');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-role="gpu-mode"] option')].map((o) => [o.value, o.textContent])`), [['none', 'Don’t allow'], ['session', 'Allow while the app runs']]);
  await shot2x(lib, 'gpu-sheet-running');
  await setIn(lib, '[data-role="gpu-mode"]', 'none');
  await click(lib, '[data-action="gpu-save"]');
  await waitFor(async () => (await banners()).some((b) => /The GPU was taken away from “GPU Test”: its helper stopped and its connections closed\./.test(b)), { what: 'the banner says it was applied' });
  assert.equal(readGrants().host === undefined || readGrants().host.gpu === undefined, true, 'the grant is gone');
  await waitFor(() => !alive(started.pid), { what: 'the GPU server process is gone', timeout: 10000 });
  assert.equal(serverEvents('sigterm').filter((e) => e.pid === started.pid).length, 1, 'it was asked to stop (SIGTERM)');
  await waitFor(async () => (await gpuRows()).some((r) => r.target === 'gpu server stop'), { what: 'a stop row' });
  const stopRow = (await gpuRows()).find((r) => r.target === 'gpu server stop');
  assert.equal(stopRow.result, 'allowed');
  assert.match(stopRow.reason, /revoked/, 'and it says why');
  await waitFor(async () => !(await exists(lib, card('[data-role="gpu-chip"]'))), { what: 'the chip goes' });
  await waitFor(async () => !(await exists(mon, pill)), { what: 'the pill goes' });
  assert.equal(await text(lib, card('[data-role="host-grants"]')), 'gpu: not allowed');
  assert.equal(await cardState2(lib, GID), 'running', 'the app keeps running');
  const cut = await call('gpu:ping', 16, 100);
  assert.equal(cut.ok, false, 'with the server gone the port refuses');
  assert.match(cut.error, /^(connect: |closed after 0 bytes)/);

  step('J: allowing it again while the app runs starts at the next launch (the VM was started without the service)');
  const startsNow = serverEvents('start').length;
  await click(lib, card('[data-action="gpu"]'));
  await waitSel(lib, '[data-role="gpu-sheet"]', 'the GPU… sheet again');
  assert.equal(await lib.eval(`document.querySelector('[data-role="gpu-mode"]').value`), 'none');
  await setIn(lib, '[data-role="gpu-mode"]', 'session');
  await click(lib, '[data-action="gpu-save"]');
  await waitFor(async () => (await banners()).some((b) => /The GPU is allowed for “GPU Test”\. It starts at the next launch\./.test(b)), { what: 'the banner says it starts at the next launch' });
  assert.deepEqual(readGrants().host, { gpu: { mode: 'session' } });
  await waitSel(lib, card('[data-role="gpu-chip"]'), 'the chip is back');
  await sleep(1500); // the loader looks at the grant of a running app every second: allowing never starts a server by itself
  assert.equal(serverEvents('start').length, startsNow, 'no new server for the running app');
  assert.equal((await call('gpu:ping', 16, 100)).ok, false, 'and still no GPU for this run');

  step('J: stop, launch again: a new server (new port) and bytes flow again; stopping the app stops the server');
  await stopApp();
  call = await launchApp();
  assert.deepEqual(await call('gpu:env'), { gpu: '127.0.0.1:50052' });
  await waitFor(() => serverEvents('start').length === startsNow + 1, { what: 'a new server start' });
  const again = serverEvents('start').at(-1);
  assert.notEqual(again.pid, started.pid);
  assert.ok(alive(again.pid));
  const ping2 = await call('gpu:ping', 1024, 700);
  assert.equal(ping2.ok, true, JSON.stringify(ping2));
  assert.equal(ping2.echoed, 1024);
  await stopApp();
  await waitFor(() => !alive(again.pid), { what: 'stopping the app stopped its GPU server', timeout: 10000 });
  assert.equal(serverEvents('sigterm').filter((e) => e.pid === again.pid).length, 1);

  step('J: quit cleanly; no server and no VM left behind');
  dropConns();
  await killLoader(L, 'SIGTERM', 30000);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-J.log'), 'utf8').includes('unhandled rejection'), 'no unhandled rejection in the loader log');
  await waitFor(() => testVms(homeJ).length === 0, { what: 'no VM of run J after quitting', timeout: 15000 });
  for (const e of serverEvents('start')) assert.ok(!alive(e.pid), `no stand-in server (pid ${e.pid}) left behind`);
  step('run J passed');
}

// =============================================================================================== run K: Load examples + long text
// "Load examples" (src/examples.js; the sample apps that come with the loader) through the REAL library UI, and the check that long
// unbroken text (a 200-character folder path, ids, host names, versions) wraps inside its box in every loader window (ui/wrap.css).
// No VM is ever started here: nothing launches, nothing is allowed. The examples are fixture apps made and packed by this run into a
// folder the dev-only VMAPP_EXAMPLES_DIR names (a packaged loader ignores it).
async function runK() {
  step('run K: Load examples (empty library, File menu, the sheet, install, skips, a tampered package, nothing granted) and long text wrapping');
  const homeK = path.join(ROOT, 'home-k');
  const exDir = path.join(ROOT, 'examples-k');
  const menuDir = path.join(ROOT, 'menu-k');
  const projRoot = path.join(ROOT, 'k-proj');
  const pkgDir = path.join(ROOT, 'k-pkgs');
  const dialogLogK = path.join(ROOT, 'dialogs-k.jsonl');
  const isMonitor = (u) => u.startsWith('vmapp-loader://ui/monitor.html');
  const isSettings = (u) => u.startsWith('vmapp-loader://ui/settings.html');
  const NOTE = "Installing doesn't grant anything: each app asks for its permissions the first time you launch it.";
  const grantsDir = path.join(homeK, 'grants');
  const grantFiles = () => (fs.existsSync(grantsDir) ? fs.readdirSync(grantsDir) : []);
  const installedVersion = (id) => (fs.existsSync(path.join(homeK, 'apps', id, 'current')) ? fs.readFileSync(path.join(homeK, 'apps', id, 'current'), 'utf8').trim() : null);
  const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  // ---- the fixture apps: three ordinary ones, a package with a tampered file, a file that is no package, and one full of long text ----
  const ID = (s) => `com.vmapp.exk.${s}`;
  const base = (id, name, version, over = {}) => ({
    format: 1,
    id,
    name,
    version,
    publisher: 'D9010 VmApp tests',
    description: `${name}: a fixture app of the loader test (run K).`,
    runtime: 'node22',
    core: { command: ['node', 'main.js'], workdir: '/app', memoryMiB: 256, cpus: 1 },
    ui: { root: 'ui' },
    permissions: { folders: [], dialogs: false, external: false },
    ...over,
  });
  const LONGID = ID('z'.repeat(70));
  const LONGHOST = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`;
  const LONGHOST2 = `${'d'.repeat(60)}.${'e'.repeat(60)}.example.org`;
  const LONGNAME = 'N'.repeat(60);
  const LONGVER = `1.0.0-rc${'9'.repeat(50)}`;
  const LONGDESC = 'D'.repeat(480);
  const LONGPURPOSE = 'p'.repeat(190);
  const FOLDER = 'f'.repeat(31);
  const fixtures = {
    plain: base(ID('plain'), 'Plain Example', '1.0.0', { description: 'Does nothing special: no folders, no network.' }),
    netmic: base(ID('netmic'), 'Net Mic Example', '1.0.0', {
      description: 'Reaches two internet addresses, listens to the microphone and reads one folder.',
      permissions: {
        folders: [{ name: 'docs', access: 'read', purpose: 'The documents it reads' }],
        dialogs: false,
        external: false,
        network: [{ host: 'api.example.com', purpose: 'Sync' }, { host: '*.cdn.example.com', ports: [443, 80], purpose: 'Images' }],
        devices: [{ device: 'microphone', purpose: 'Voice notes' }],
      },
    }),
    gpuctl: base(ID('gpuctl'), 'GPU Control Example', '1.0.0', {
      description: 'Asks to use the GPU, see the screen and control the mouse and keyboard.',
      permissions: { folders: [], dialogs: false, external: false, host: [{ cap: 'gpu', purpose: 'Model' }, { cap: 'screen', purpose: 'Reads forms' }, { cap: 'input', purpose: 'Clicks' }] },
    }),
    tampered: base(ID('tampered'), 'Tampered Example', '1.0.0', { description: 'Its UI file is changed after packing, so the package no longer matches its manifest.' }),
    wrap: base(LONGID, LONGNAME, LONGVER, {
      publisher: 'P'.repeat(100),
      description: LONGDESC,
      core: { command: ['node', 'main.js', `--config=${'c'.repeat(150)}`], workdir: '/app', memoryMiB: 256, cpus: 1 },
      permissions: {
        folders: [{ name: FOLDER, access: 'readwrite', purpose: LONGPURPOSE }],
        dialogs: false,
        external: false,
        network: [{ host: LONGHOST, purpose: LONGPURPOSE }, { host: `*.${LONGHOST2}`, ports: [443, 80], purpose: LONGPURPOSE }],
        devices: [{ device: 'microphone', purpose: LONGPURPOSE }],
        host: [{ cap: 'gpu', purpose: LONGPURPOSE }, { cap: 'screen', purpose: LONGPURPOSE }],
      },
    }),
  };
  /** Writes a project folder for `m` and packs it into <dir>/<file>; the UI file carries a marker the tamper step can change. */
  const packFixture = (dir, file, m) => {
    const proj = path.join(projRoot, m.id.slice(-24));
    fs.mkdirSync(path.join(proj, 'ui'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'core'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'vmapp.json'), JSON.stringify(m, null, 2));
    fs.writeFileSync(path.join(proj, 'ui', 'index.html'), `<!doctype html><title>${m.name.slice(0, 30)}</title><!--UI-MARKER-${m.version}-->\n`);
    fs.writeFileSync(path.join(proj, 'core', 'main.js'), "console.log('fixture');\n");
    fs.mkdirSync(dir, { recursive: true });
    hostlib.pack(proj, path.join(dir, file));
    return path.join(dir, file);
  };
  const readme = [
    '# D9010 VmApp examples',
    '',
    '| File | What it shows | What to allow | Source |',
    '|---|---|---|---|',
    '| `01-plain.vmapp` (3K) | Nothing special | nothing up front; just try it | [`vmapp/x`](../x) |',
    '| `02-net-mic.vmapp` (3K) | A network and a microphone app | the docs folder (read); api.example.com; the microphone only if you want to record | [`vmapp/y`](../y) · upstream: [Z](https://example.com) 1.0 |',
    '| `04-tampered.vmapp` (3K) | A package that was changed | nothing | [`vmapp/z`](../z) |',
    '',
    'Tips: nothing here is parsed.',
  ].join('\n');

  // the packages the menu test and the wrap test open with "Install from file…" live outside the examples folder
  const pkgPlain = packFixture(pkgDir, 'plain.vmapp', fixtures.plain);
  const pkgWrap = packFixture(pkgDir, 'wrap.vmapp', fixtures.wrap);
  const longDir = path.join(ROOT, 'user-k', 'x'.repeat(200), 'y'.repeat(200));
  fs.mkdirSync(longDir, { recursive: true });
  assert.ok(longDir.length > 400);

  const L = startLoader({
    home: homeK,
    name: 'loader-K',
    args: ['--monitor'],
    env: {
      VMAPP_EXAMPLES_DIR: exDir,
      VMAPP_TEST_MENU_DIR: menuDir,
      // the queue of the native open dialog: the File menu's Install from file… (twice: a review we cancel, then the long-text app),
      // and, in between, the permission sheet's Choose folder… (the 400-character folder)
      VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pkgPlain, longDir, pkgWrap], message: 0 }),
      VMAPP_TEST_DIALOG_LOG: dialogLogK,
    },
  });
  const lib = await waitTarget(isLibrary, 'library (K)');
  const banners = () => lib.eval(`[...document.querySelectorAll('#banners .banner')].map((b) => b.className + ': ' + b.textContent)`);
  const closeSheets = async () => {
    await lib.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed (K)' });
  };
  const exRows = () =>
    lib.eval(`[...document.querySelectorAll('[data-example]')].map((r) => {
      const t = (sel) => { const e = r.querySelector(sel); return e ? e.textContent : null; };
      const box = r.querySelector('[data-role="example-check"]');
      const allow = r.querySelector('[data-role="example-allow"]');
      return {
        file: r.dataset.example, state: r.dataset.state, result: r.dataset.result || null,
        name: t('[data-role="example-name"]'), version: t('[data-role="example-version"]'), size: t('[data-role="example-size"]'), desc: t('[data-role="example-desc"]'),
        badges: [...r.querySelectorAll('[data-badge]')].map((b) => [b.dataset.badge, b.textContent, b.classList.contains('amber') ? 'amber' : b.classList.contains('red') ? 'red' : '']),
        allow: allow ? allow.textContent : null, allowFrom: allow ? allow.dataset.from : null, status: t('[data-role="example-status"]'),
        checked: box.checked, disabled: box.disabled,
      };
    })`);
  const row = async (file) => (await exRows()).find((r) => r.file === file);
  const openSheetFromMenu = async () => {
    await clickMenu('file-load-examples');
    await waitSel(lib, '[data-role="examples"]', 'Load examples sheet (menu)');
    await waitFor(async () => (await exRows()).length > 0, { what: 'the example rows' });
  };
  const menuJson = () => JSON.parse(fs.readFileSync(path.join(menuDir, 'menu.json'), 'utf8'));
  const clickMenu = async (id) => {
    const before = jsonl(path.join(menuDir, 'clicked.jsonl')).length;
    fs.writeFileSync(path.join(menuDir, 'click.txt'), id);
    await waitFor(() => jsonl(path.join(menuDir, 'clicked.jsonl')).length > before, { what: `the loader took the menu click ${id}` });
    return jsonl(path.join(menuDir, 'clicked.jsonl')).at(-1);
  };
  const installAndWait = async () => {
    await click(lib, '[data-action="examples-install"]');
    await waitSel(lib, '[data-action="examples-done"]', 'the install is done (Done button)', 60000);
  };

  // ---- 1. the empty library, with no examples folder yet (a development loader explains how to make them) ----
  step('K: empty library: “Load examples” (primary) and “Install from file…”; with no examples the dev UI says to run tools/pack-examples');
  await waitSel(lib, '[data-role="empty"]', 'empty library (K)');
  assert.match(await text(lib, '[data-role="empty"]'), /No apps installed yet\./);
  assert.equal(await text(lib, '[data-role="empty"] [data-action="load-examples"]'), 'Load examples');
  assert.equal(await lib.eval(`document.querySelector('[data-role="empty"] [data-action="load-examples"]').classList.contains('primary')`), true, 'the primary button');
  assert.equal(await text(lib, '[data-role="empty"] [data-action="install-empty"]'), 'Install from file…');
  const hint = await text(lib, '[data-role="examples-missing-hint"]');
  assert.match(hint, /run tools\/pack-examples/);
  assert.ok(hint.includes(exDir), 'it says which folder it looked in');
  await shot2x(lib, 'examples-empty-state-missing');
  await click(lib, '[data-action="load-examples"]');
  await waitSel(lib, '[data-role="examples-missing"]', 'the “no examples” sheet');
  assert.match(await text(lib, '[data-role="examples-missing"]'), /There are no examples to load yet\.[\s\S]*Run tools\/pack-examples in the repository/);
  assert.equal(await exists(lib, '[data-action="examples-install"]'), false, 'nothing to install');
  await click(lib, '.sheet [data-action="close"]');
  fs.mkdirSync(exDir, { recursive: true });
  await click(lib, '[data-action="load-examples"]');
  await waitSel(lib, '[data-role="examples-missing"]', 'the sheet for an EMPTY folder');
  await closeSheets();

  // ---- 2. the examples arrive: a README, three apps, a tampered package, a file that is no package, and the long-text app ----
  packFixture(exDir, '01-plain.vmapp', fixtures.plain);
  packFixture(exDir, '02-net-mic.vmapp', fixtures.netmic);
  packFixture(exDir, '03-gpu-control.vmapp', fixtures.gpuctl);
  const tamperedFile = packFixture(exDir, '04-tampered.vmapp', fixtures.tampered);
  const tb = fs.readFileSync(tamperedFile);
  const at = tb.indexOf(Buffer.from('UI-MARKER-'));
  assert.ok(at > 0);
  tb[at] = 'X'.charCodeAt(0); // same size, so the archive is well formed; only the hash of ui/index.html is wrong
  fs.writeFileSync(tamperedFile, tb);
  fs.writeFileSync(path.join(exDir, '05-garbage.vmapp'), 'this is not a vmapp package '.repeat(60));
  packFixture(exDir, '06-wrap-long-text.vmapp', fixtures.wrap);
  fs.writeFileSync(path.join(exDir, 'README.md'), readme);
  fs.writeFileSync(path.join(exDir, 'notes.txt'), 'not an example');

  step('K: with examples present the empty state offers the button without the hint');
  await lib.send('Page.reload');
  await waitSel(lib, '[data-role="empty"] [data-action="load-examples"]', 'empty library after reload (K)');
  assert.equal(await exists(lib, '[data-role="examples-missing-hint"]'), false, 'no hint once there are examples');
  assert.match(await text(lib, '[data-role="empty"]'), /Choose “Load examples” to try the sample apps that came with this loader, or “Install from file…” to add a \.vmapp package\./);
  await shot2x(lib, 'examples-empty-state');

  // ---- 3. the sheet ----
  step('K: the sheet lists the examples as the packages describe themselves: name, description, version, size, badges, “What to allow”');
  await click(lib, '[data-action="load-examples"]');
  await waitSel(lib, '[data-role="examples"]', 'Load examples sheet');
  await waitFor(async () => (await exRows()).length === 6, { what: 'six rows (the .txt file is not an example)' });
  assert.equal(await text(lib, '.sheet h2'), 'Load examples');
  assert.equal(await text(lib, '[data-role="examples-note"]'), NOTE, 'the loader says installing grants nothing');
  let rows = await exRows();
  assert.deepEqual(rows.map((r) => r.file), ['01-plain.vmapp', '02-net-mic.vmapp', '03-gpu-control.vmapp', '04-tampered.vmapp', '05-garbage.vmapp', '06-wrap-long-text.vmapp']);
  const [rPlain, rNet, rGpu, rTam, rGarb, rWrap] = rows;
  assert.deepEqual([rPlain.name, rPlain.version, rPlain.desc], ['Plain Example', '1.0.0', 'Does nothing special: no folders, no network.'], 'name, version and description come from the package');
  assert.match(rPlain.size, /^\d+(\.\d)? KiB$/);
  assert.deepEqual(rPlain.badges, [], 'a plain app has no badges');
  assert.deepEqual(rNet.badges, [['network', 'Network: api.example.com, *.cdn.example.com', 'amber'], ['microphone', 'Microphone', 'red']]);
  assert.deepEqual(rGpu.badges, [['gpu', 'GPU', 'amber'], ['host', 'Control of your computer', 'red']]);
  assert.equal(await lib.eval(`document.querySelector('[data-example="03-gpu-control.vmapp"] [data-badge="host"]').title`), 'Asks for: screen, mouse and keyboard');
  assert.equal(rPlain.allow, 'nothing up front; just try it');
  assert.equal(rPlain.allowFrom, 'readme', 'the hint of a package the README lists comes from the README');
  assert.equal(rNet.allow, 'the docs folder (read); api.example.com; the microphone only if you want to record');
  assert.equal(rGpu.allow, 'GPU; screen; mouse and keyboard', 'no README row: derived from the manifest');
  assert.equal(rGpu.allowFrom, 'manifest');
  assert.deepEqual(rows.slice(0, 4).map((r) => [r.checked, r.disabled, r.status]), [[true, false, ''], [true, false, ''], [true, false, ''], [true, false, '']], 'every example is checked');
  assert.equal(rGarb.checked, false);
  assert.equal(rGarb.disabled, true, 'a file that is no package cannot be chosen');
  assert.match(rGarb.status, /^Can’t be read: /);
  assert.equal(rGarb.name, '05-garbage.vmapp');
  assert.equal(rWrap.name, LONGNAME);
  assert.equal(rWrap.version, LONGVER);
  assert.equal(await text(lib, '[data-role="examples-count"]'), '5 of 5 selected');
  assert.equal(await text(lib, '[data-action="examples-toggle"]'), 'Select none');
  assert.equal(await text(lib, '[data-action="examples-install"]'), 'Install selected');
  assert.equal(await lib.eval(`document.querySelector('[data-action="examples-install"]').classList.contains('primary')`), true);
  assert.equal(await text(lib, '[data-action="examples-cancel"]'), 'Cancel');
  await shot2x(lib, 'examples-sheet');

  step('K: Select none / Select all; Install selected needs at least one; Escape and Cancel close the sheet and install nothing');
  await click(lib, '[data-action="examples-toggle"]');
  assert.equal(await text(lib, '[data-role="examples-count"]'), '0 of 5 selected');
  assert.equal(await lib.eval(`document.querySelector('[data-action="examples-install"]').disabled`), true);
  assert.equal(await text(lib, '[data-action="examples-toggle"]'), 'Select all');
  await click(lib, '[data-action="examples-toggle"]');
  assert.equal(await text(lib, '[data-role="examples-count"]'), '5 of 5 selected');
  await setChecked(lib, '[data-example="03-gpu-control.vmapp"] [data-role="example-check"]', false);
  assert.equal(await text(lib, '[data-role="examples-count"]'), '4 of 5 selected');
  assert.equal(await text(lib, '[data-action="examples-toggle"]'), 'Select all');
  await closeSheets();
  assert.equal(await exists(lib, '[data-app]'), false, 'closing the sheet installed nothing');
  await click(lib, '[data-action="load-examples"]');
  await waitSel(lib, '[data-role="examples"]', 'sheet again');
  await click(lib, '[data-action="examples-cancel"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'Cancel closes the sheet' });
  assert.equal(await exists(lib, '[data-app]'), false);

  // ---- 4. install everything that can be chosen: three install, the tampered one fails with the verification message ----
  step('K: Install selected: verify, then install, per app; the tampered package fails with a clear message and the others still install');
  await click(lib, '[data-action="load-examples"]');
  await waitSel(lib, '[data-role="examples"]', 'sheet for the install');
  await installAndWait();
  rows = await exRows();
  const byFile = Object.fromEntries(rows.map((r) => [r.file, r]));
  assert.deepEqual(['01-plain.vmapp', '02-net-mic.vmapp', '03-gpu-control.vmapp', '06-wrap-long-text.vmapp'].map((f) => byFile[f].result), ['installed', 'installed', 'installed', 'installed']);
  assert.equal(byFile['01-plain.vmapp'].status, 'Installed 1.0.0');
  assert.equal(byFile['04-tampered.vmapp'].result, 'failed');
  assert.match(byFile['04-tampered.vmapp'].status, /^Not installed: it did not pass verification\. hash mismatch for "ui\/index\.html": vmapp\.json says [0-9a-f]{64}, actual [0-9a-f]{64}$/, 'the precise verification message');
  assert.equal(byFile['05-garbage.vmapp'].result, null, 'the unreadable file was never touched');
  assert.equal(await text(lib, '[data-role="examples-summary"]'), 'Installed 4 apps, 1 failed.');
  assert.equal(await lib.eval(`document.querySelector('[data-role="examples-summary"]').classList.contains('err')`), true, 'a failure makes the summary red');
  assert.equal(await text(lib, '[data-action="examples-done"]'), 'Done');
  assert.equal(await lib.eval(`document.querySelector('[data-action="examples-cancel"]').hidden`), true, 'Cancel is gone once the install started');
  assert.equal(await lib.eval(`[...document.querySelectorAll('[data-role="example-check"]')].every((b) => b.disabled)`), true, 'the choices are locked');
  await shot2x(lib, 'examples-result');
  // the cards appear behind the sheet; the tampered app is not among them
  await waitFor(async () => (await lib.eval(`document.querySelectorAll('[data-app]').length`)) === 4, { what: 'four cards' });
  assert.equal(await exists(lib, `[data-app="${ID('tampered')}"]`), false, 'the tampered package installed nothing');
  assert.equal(fs.existsSync(path.join(homeK, 'apps', ID('tampered'))), false);
  for (const id of [ID('plain'), ID('netmic'), ID('gpuctl')]) assert.equal(installedVersion(id), '1.0.0', id);
  await click(lib, '[data-action="examples-done"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'Done closes the sheet' });

  step('K: installing granted NOTHING and launched NOTHING: no grants files, every card stopped with undecided choices, no VM');
  assert.deepEqual(grantFiles(), [], 'no grants file exists after installing');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('[data-app]')].map((c) => c.dataset.state)`), ['stopped', 'stopped', 'stopped', 'stopped']);
  assert.equal(await text(lib, `[data-app="${ID('netmic')}"] [data-role="grants"]`), 'docs: not decided yet');
  assert.equal(await text(lib, `[data-app="${ID('netmic')}"] [data-role="net-grants"]`), 'api.example.com: not allowed  •  *.cdn.example.com: not allowed');
  assert.equal(await text(lib, `[data-app="${ID('netmic')}"] [data-role="devices-grants"]`), 'microphone: not allowed');
  assert.equal(await text(lib, `[data-app="${ID('gpuctl')}"] [data-role="host-grants"]`), 'gpu: not allowed  •  screen: not allowed  •  input: not allowed');
  assert.equal(await exists(lib, '[data-role="host-chip"]'), false, 'no red “Can control your computer” chip');
  assert.equal(await exists(lib, '[data-role="net-chip"]'), false);
  assert.equal(testVms(homeK).length, 0, 'no VM was started');
  await shot2x(lib, 'examples-library-after');

  // ---- 5. the File menu ----
  step('K: File → Load examples… (and Install from file…) exist and work; the entry is on by default');
  const menu = menuJson();
  assert.deepEqual(menu.map((m) => m.label), ['D9010 VmApp Launcher', 'File', 'Edit', 'View', 'Window']);
  const file = menu.find((m) => m.label === 'File').items;
  assert.deepEqual(file.map((i) => [i.id, i.label, i.visible, i.enabled]), [['file-load-examples', 'Load examples…', true, true], ['file-browse-registry', 'Browse registry…', true, true], ['file-install', 'Install from file…', true, true]]);
  assert.equal(file[0].accelerator, 'CmdOrCtrl+Shift+E');
  const took = await clickMenu('file-load-examples');
  assert.deepEqual(took, { id: 'file-load-examples', found: true, enabled: true });
  await waitSel(lib, '[data-role="examples"]', 'the sheet opened by File → Load examples…');
  await waitFor(async () => (await exRows()).length === 6, { what: 'rows (menu)' });
  assert.equal(await text(lib, '[data-role="examples-note"]'), NOTE);

  // ---- 6. again: what is installed is skipped, with a note ----
  step('K: running it again skips the installed versions with a clear note; the tampered package fails again; nothing is reinstalled');
  rows = await exRows();
  assert.deepEqual(rows.slice(0, 3).map((r) => r.status), ['Version 1.0.0 is already installed: this one will be skipped.', 'Version 1.0.0 is already installed: this one will be skipped.', 'Version 1.0.0 is already installed: this one will be skipped.']);
  assert.equal(rows[3].status, '', 'a package that failed before is just offered again');
  assert.equal(rows[0].checked, true, 'installed ones stay checked: the install skips them');
  const stamp = (id) => fs.statSync(path.join(homeK, 'apps', id, '1.0.0')).mtimeMs;
  const before = Object.fromEntries([ID('plain'), ID('netmic'), ID('gpuctl')].map((id) => [id, stamp(id)]));
  await installAndWait();
  rows = await exRows();
  assert.deepEqual(rows.filter((r) => r.result).map((r) => [r.file, r.result]), [['01-plain.vmapp', 'skipped'], ['02-net-mic.vmapp', 'skipped'], ['03-gpu-control.vmapp', 'skipped'], ['04-tampered.vmapp', 'failed'], ['06-wrap-long-text.vmapp', 'skipped']]);
  assert.equal((await row('01-plain.vmapp')).status, 'Skipped: Version 1.0.0 is already installed.');
  assert.equal(await text(lib, '[data-role="examples-summary"]'), 'Skipped 4 apps, 1 failed.');
  for (const id of Object.keys(before)) assert.equal(stamp(id), before[id], `${id} was not touched`);
  assert.deepEqual(grantFiles(), []);
  await click(lib, '[data-action="examples-done"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed' });

  // ---- 7. a newer example updates, an older one is skipped ----
  step('K: a newer example is an update (“Update from 1.0.0”); an older one is skipped (“A newer version … is installed”)');
  packFixture(exDir, '02-net-mic.vmapp', { ...fixtures.netmic, version: '1.1.0' });
  packFixture(exDir, '03-gpu-control.vmapp', { ...fixtures.gpuctl, version: '0.9.0' });
  await openSheetFromMenu();
  rows = await exRows();
  assert.equal(rows[1].status, 'Update from 1.0.0');
  assert.equal(rows[1].version, '1.1.0');
  assert.equal(rows[2].status, 'A newer version (1.0.0) is installed: this one will be skipped.');
  await installAndWait();
  rows = await exRows();
  assert.equal((await row('02-net-mic.vmapp')).status, 'Updated to 1.1.0 (was 1.0.0)');
  assert.equal((await row('03-gpu-control.vmapp')).status, 'Skipped: A newer version (1.0.0) is installed.');
  assert.equal(await text(lib, '[data-role="examples-summary"]'), 'Updated 1 app, skipped 3, 1 failed.');
  assert.equal(installedVersion(ID('netmic')), '1.1.0');
  assert.equal(installedVersion(ID('gpuctl')), '1.0.0', 'never downgraded');
  assert.deepEqual(grantFiles(), [], 'an update grants nothing either');
  await click(lib, '[data-action="examples-done"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed (update)' });

  step('K: File → Install from file… opens the normal install review (and Cancel installs nothing)');
  assert.deepEqual(await clickMenu('file-install'), { id: 'file-install', found: true, enabled: true });
  await waitSel(lib, '[data-role="review"]', 'the install review from the File menu');
  assert.match(await text(lib, '[data-role="review"]'), /Plain Example 1\.0\.0/);
  assert.match(await text(lib, '[data-role="review"]'), /Same version as installed/);
  await click(lib, '[data-action="cancel"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'review cancelled' });

  // ======================================================================================== long text wraps (ui/wrap.css)
  step('K: long unbroken text: a 200-character folder, ids, hosts and versions stay inside the card and every sheet');
  const wrapLink = (c, on) => c.eval(`(() => { const l = document.querySelector('link[href="wrap.css"]'); if (!l) throw new Error('wrap.css is not linked'); l.disabled = ${!on}; return true; })()`);
  /** Elements under `rootSel` whose content is wider than their box (inputs and buttons aside; a text-overflow: ellipsis is on purpose). */
  const overflowing = (c, rootSel, pre = '') =>
    c.eval(`(() => {
      ${pre};
      const SKIP = /^(INPUT|SELECT|TEXTAREA|OPTION|BUTTON|SCRIPT|STYLE|IMG|HTML|BODY)$/;
      const out = [];
      for (const root of document.querySelectorAll(${q(rootSel)})) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (SKIP.test(el.tagName) || el.clientWidth === 0) continue;
          if (getComputedStyle(el).textOverflow === 'ellipsis') continue;
          if (el.scrollWidth > el.clientWidth + 1) out.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '') + (el.dataset.role ? '[' + el.dataset.role + ']' : '') + ' ' + el.scrollWidth + '>' + el.clientWidth + ' "' + el.textContent.slice(0, 30) + '"');
        }
      }
      return out;
    })()`);
  /** The library's grid: no horizontal scrolling, and no card wider than its column. */
  const gridFit = (c) =>
    c.eval(`(() => {
      const apps = document.getElementById('apps');
      const cols = getComputedStyle(apps).gridTemplateColumns.split(' ').map(parseFloat);
      const widest = Math.max(...[...document.querySelectorAll('.card')].map((e) => e.getBoundingClientRect().width));
      return { scrollX: apps.scrollWidth - apps.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth, widest, column: Math.max(...cols) };
    })()`);
  const expectFits = async (c, rootSel, what, pre = '') => {
    const bad = await overflowing(c, rootSel, pre); // `pre` runs in the same evaluation, so nothing can redraw the page in between
    assert.deepEqual(bad, [], `${what}: nothing runs out of its box: ${JSON.stringify(bad.slice(0, 6))}`);
  };
  const expectGridFits = async (what) => {
    const g = await gridFit(lib);
    assert.ok(g.scrollX <= 1, `${what}: the grid does not scroll sideways (${g.scrollX})`);
    assert.ok(g.page <= 1, `${what}: the page does not scroll sideways (${g.page})`);
    assert.ok(g.widest <= g.column + 1, `${what}: no card is wider than its column (${g.widest} > ${g.column})`);
  };
  const W = `[data-app="${LONGID}"]`;
  /** Scrolls the long-text card to the top of the grid, so the screenshot shows it. */
  const showLongCard = () => lib.eval(`(() => { const c = document.querySelector(${q(W)}); c.scrollIntoView({ block: 'start' }); document.getElementById('apps').scrollLeft = 0; return true; })()`);

  // the card as installed, with the wrap rules on, then off (the same check must see the problem, or it proves nothing)
  await waitSel(lib, W, 'the long-text card');
  assert.equal(await text(lib, `${W} .name`), `${LONGNAME}${LONGVER}`);
  await wrapLink(lib, true);
  await expectFits(lib, '.card', 'cards');
  await expectGridFits('cards');
  await showLongCard();
  await shot2x(lib, 'wrap-card-after');
  await wrapLink(lib, false);
  const brokenCards = await overflowing(lib, '.card');
  const brokenGrid = await gridFit(lib);
  assert.ok(brokenCards.length > 0 || brokenGrid.widest > brokenGrid.column + 1, 'without ui/wrap.css the same card does overflow, so the check can see it');
  step(`K: (without wrap.css ${brokenCards.length} element(s) overflow, e.g. ${brokenCards[0]})`);
  await showLongCard();
  await shot2x(lib, 'wrap-card-before');
  await wrapLink(lib, true);

  // the permission sheet, with the long folder granted through the real Choose folder… (the dialog hook returns the 400-character path)
  await click(lib, `${W} [data-action="permissions"]`);
  await waitSel(lib, '[data-role="net-section"]', 'permission sheet of the long-text app');
  await click(lib, `.sheet [data-folder="${FOLDER}"] [data-action="choose"]`);
  await waitFor(async () => (await text(lib, `.sheet [data-folder="${FOLDER}"] [data-role="path"]`)) === longDir, { what: 'the long folder is chosen' });
  await expectFits(lib, '.sheet', 'permission sheet');
  await shot2x(lib, 'wrap-permission-sheet-after');
  await wrapLink(lib, false);
  const brokenSheet = await overflowing(lib, '.sheet');
  assert.ok(brokenSheet.length > 0, 'without wrap.css the permission sheet overflows');
  await shot2x(lib, 'wrap-permission-sheet-before');
  await wrapLink(lib, true);
  await click(lib, '[data-action="sheet-save"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'permission sheet saved' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(grantsDir, `${LONGID}.json`), 'utf8')).folders[FOLDER], { path: longDir, access: 'readwrite' });
  assert.deepEqual(grantFiles(), [`${LONGID}.json`], 'only the app the user chose a folder for has a grants file');
  assert.equal(await text(lib, `${W} [data-role="grants"]`), `${FOLDER}: ${longDir} (read & write)`);
  await expectFits(lib, '.card', 'the card with the long folder granted');
  await expectGridFits('the card with the long folder granted');
  await showLongCard();
  await shot2x(lib, 'wrap-card-granted-after');

  // the other sheets of the card
  await click(lib, `${W} [data-action="network"]`);
  await waitSel(lib, '[data-role="network-sheet"]', 'Network… sheet');
  await expectFits(lib, '.sheet', 'Network… sheet');
  await shot2x(lib, 'wrap-network-sheet-after');
  await closeSheets();
  await click(lib, `${W} [data-action="gpu"]`);
  await waitSel(lib, '[data-role="gpu-sheet"]', 'GPU… sheet');
  await expectFits(lib, '.sheet', 'GPU… sheet');
  await closeSheets();
  await click(lib, `${W} [data-action="versions"]`);
  await waitSel(lib, '[data-role="versions"]', 'Versions modal');
  await expectFits(lib, '.sheet', 'Versions modal');
  await shot2x(lib, 'wrap-versions-after');
  await closeSheets();
  await click(lib, `${W} [data-action="publish"]`);
  await waitSel(lib, '[data-role="publish"]', 'Publish… sheet');
  await expectFits(lib, '.sheet', 'Publish… sheet');
  await closeSheets();
  await click(lib, `${W} [data-action="uninstall"]`);
  await waitSel(lib, '#purge-data', 'Uninstall confirmation');
  await expectFits(lib, '.sheet', 'Uninstall confirmation');
  await closeSheets();

  // the install review (File → Install from file… with the long-text package)
  await clickMenu('file-install');
  await waitSel(lib, '[data-role="review"]', 'install review (long text)');
  await waitSel(lib, '[data-role="review-network"]', 'review: network');
  await expectFits(lib, '.sheet', 'install review');
  await shot2x(lib, 'wrap-install-review-after');
  await wrapLink(lib, false);
  assert.ok((await overflowing(lib, '.sheet')).length > 0, 'without wrap.css the install review overflows');
  await wrapLink(lib, true);
  await click(lib, '[data-action="cancel"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'review cancelled (long text)' });

  // Load examples with the long-text app in the list
  await openSheetFromMenu();
  await expectFits(lib, '.sheet', 'Load examples sheet');
  await shot2x(lib, 'wrap-examples-sheet-after');
  await wrapLink(lib, false);
  assert.ok((await overflowing(lib, '.sheet')).length > 0, 'without wrap.css the examples sheet overflows');
  await shot2x(lib, 'wrap-examples-sheet-before');
  await wrapLink(lib, true);
  await closeSheets();

  // the Host Capabilities window: a tool and an MCP server with very long names, paths and patterns
  step('K: Host Capabilities window, activity monitor popover and Bridge Inspector detail pane wrap long text too');
  const longTool = path.join(ROOT, 'user-k', 't'.repeat(200));
  fs.writeFileSync(longTool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(longTool, 0o755);
  await click(lib, '[data-action="open-settings"]');
  const set = await waitTarget(isSettings, 'Host Capabilities window (K)');
  await waitSel(set, '[data-role="tools-panel"]', 'tools panel');
  await set.eval(`window.settings.saveTool(${JSON.stringify({ id: 'longtool', name: 'T'.repeat(60), path: longTool, args: [{ pattern: `^${'a'.repeat(300)}$` }], description: 'D'.repeat(480) })})`);
  await set.eval(`window.settings.saveMcp(${JSON.stringify({ id: 'longmcp', name: 'M'.repeat(60), command: [longTool, `--flag=${'m'.repeat(200)}`], env: { LONG_VALUE: 'v'.repeat(200) }, description: 'D'.repeat(480) })})`);
  await set.send('Page.reload'); // the page redraws its lists from the saved catalog
  await waitSel(set, '[data-tool="longtool"]', 'the long tool entry');
  await waitSel(set, '[data-mcp="longmcp"]', 'the long MCP entry');
  await wrapLink(set, true);
  await expectFits(set, '.settings', 'Host Capabilities window (the panels and the area that scrolls)');
  const showTool = () => set.eval(`(() => { document.querySelector('[data-tool="longtool"]').scrollIntoView({ block: 'center' }); return true; })()`);
  await showTool(); // the screenshots show the long entries, not the top of the window
  await shot2x(set, 'wrap-settings-after');
  await wrapLink(set, false);
  assert.ok((await overflowing(set, '.settings')).length > 0, 'without wrap.css the Host Capabilities window overflows');
  await showTool();
  await shot2x(set, 'wrap-settings-before');
  await wrapLink(set, true);

  // the popover: the real renderer, a made-up state (no app runs in this test)
  const mon = await waitTarget(isMonitor, 'activity monitor popover (K)');
  const popover = `Activity.render(document.getElementById('activity'), { apps: [{ id: ${JSON.stringify(LONGID)}, name: ${JSON.stringify(LONGNAME)}, version: ${JSON.stringify(LONGVER)}, state: 'running', pills: [
      { kind: 'folders', label: ${JSON.stringify(`Folders: ${'f'.repeat(120)}`)}, title: 'x', lastAt: 0, live: false },
      { kind: 'net', label: ${JSON.stringify(`Network: ${LONGHOST}`)}, title: 'x', lastAt: 0, live: false } ] }] }, { handlers: {} });
    if (document.querySelectorAll('.act-row').length !== 1) throw new Error('the popover did not draw the row')`;
  await wrapLink(mon, true);
  await expectFits(mon, '#activity', 'activity monitor popover', popover);
  await shot2x(mon, 'wrap-monitor-after');
  await wrapLink(mon, false);
  assert.ok((await overflowing(mon, '#activity', popover)).length > 0, 'without wrap.css the popover overflows');
  await shot2x(mon, 'wrap-monitor-before');
  await wrapLink(mon, true);

  // the Inspector's detail pane: the real page, a made-up selected message (the loader would fill the same elements)
  await click(lib, `${W} [data-action="inspect"]`);
  const insp = await waitTarget(isInspector, 'inspector (K)');
  await waitFor(() => insp.eval(`document.readyState === 'complete' && !!document.getElementById('detail-meta')`), { what: 'the inspector page is loaded' });
  const detail = `document.getElementById('detail-empty').hidden = true;
    document.getElementById('detail-body').hidden = false;
    const meta = document.getElementById('detail-meta');
    meta.replaceChildren();
    for (const [k, v] of [['Channel', ${JSON.stringify('c'.repeat(150))}], ['Host', ${JSON.stringify(LONGHOST)}], ['Folder', ${JSON.stringify(longDir)}]]) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      meta.append(dt, dd);
    }
    document.getElementById('detail-pre').textContent = ${JSON.stringify(`{"path":"${'q'.repeat(300)}"}`)}`;
  await wrapLink(insp, true);
  await expectFits(insp, '.detail', 'Bridge Inspector detail pane', detail);
  await shot2x(insp, 'wrap-inspector-after');

  step('K: quit cleanly; no VM was ever started');
  assert.equal(testVms(homeK).length, 0);
  assert.deepEqual((await banners()).filter((b) => /^banner error/.test(b)), [], 'no error banner in the library');
  dropConns();
  await killLoader(L, 'SIGTERM', 30000);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-K.log'), 'utf8').includes('unhandled rejection'), 'no unhandled rejection in the loader log');
  step('run K passed');
}

// =============================================================================================== run KR: Load examples from the registry
// The released launcher carries no sample apps: "Load examples" lists the apps of the publisher whose DOMAIN the registry verified and
// installs them like any registry install. The registry here is the in-process stand-in (tests/unit/fixtures/fake-registry.js); the
// dev-only VMAPP_EXAMPLES_FROM=registry makes this dev launcher use it whatever its examples folder holds. No VM is started.
async function runKR() {
  step('run KR: Load examples from the registry (the list, a registry that does not answer, install, nothing granted)');
  const { FakeRegistry } = require(path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-registry.js'));
  const homeKR = path.join(ROOT, 'home-kr');
  const projRoot = path.join(ROOT, 'kr-proj');
  const reg = new FakeRegistry();
  await reg.start();
  const OFFICIAL = { level: 'domain', label: 'Verified: d9010.com', domain: 'd9010.com', company: 'D9010 Inc' };
  const app = (id, name) => ({
    format: 1, id, name, version: '1.0.0', publisher: 'Claimed Inc.', description: `${name}: a fixture app of the loader test (run KR).`, runtime: 'node22',
    core: { command: ['node', 'main.js'], workdir: '/app', memoryMiB: 256, cpus: 1 }, ui: { root: 'ui' }, permissions: { folders: [], dialogs: false, external: false },
  });
  const fixtures = [['com.vmapp.exr.alpha', 'Alpha Sample', OFFICIAL], ['com.vmapp.exr.beta', 'Beta Sample', OFFICIAL], ['com.vmapp.exr.rogue', 'Rogue Sample', null]];
  for (const [id, name, publisher] of fixtures) {
    const proj = path.join(projRoot, id);
    fs.mkdirSync(path.join(proj, 'ui'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'core'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'vmapp.json'), JSON.stringify(app(id, name), null, 2));
    fs.writeFileSync(path.join(proj, 'ui', 'index.html'), `<!doctype html><title>${name}</title>\n`);
    fs.writeFileSync(path.join(proj, 'core', 'main.js'), "console.log('fixture');\n");
    const file = path.join(projRoot, `${id}.vmapp`);
    hostlib.pack(proj, file);
    reg.publish(file);
    if (publisher) reg.publishers.set(id, publisher);
  }
  const L = startLoader({ home: homeKR, name: 'loader-KR', env: { VMAPP_EXAMPLES_FROM: 'registry', VMAPP_REGISTRY: reg.url } });
  const lib = await waitTarget(isLibrary, 'library (KR)');
  const banners = () => lib.eval(`[...document.querySelectorAll('#banners .banner')].map((b) => b.className + ': ' + b.textContent)`);
  const rows = () =>
    lib.eval(`[...document.querySelectorAll('[data-example]')].map((r) => {
      const t = (sel) => { const e = r.querySelector(sel); return e ? e.textContent : null; };
      const allow = r.querySelector('[data-role="example-allow"]');
      return { file: r.dataset.example, result: r.dataset.result || null, name: t('[data-role="example-name"]'), version: t('[data-role="example-version"]'), size: t('[data-role="example-size"]'),
        desc: t('[data-role="example-desc"]'), allow: allow ? allow.textContent : null, allowFrom: allow ? allow.dataset.from : null, allowKey: t('[data-role="example-allow-row"] .k'), status: t('[data-role="example-status"]'), checked: r.querySelector('[data-role="example-check"]').checked };
    })`);

  step('KR: the empty library offers “Load examples” without any hint about a folder');
  await waitSel(lib, '[data-role="empty"] [data-action="load-examples"]', 'empty library (KR)');
  assert.match(await text(lib, '[data-role="empty"]'), /Choose “Load examples” to try the sample apps, or “Install from file…” to add a \.vmapp package\./);
  assert.equal(await exists(lib, '[data-role="examples-missing-hint"]'), false);

  step('KR: a registry that does not answer: a plain sentence in a banner, and “Install from file…” is named as the way around it');
  reg.failList = true;
  await click(lib, '[data-action="load-examples"]');
  await waitFor(async () => (await banners()).some((b) => /^banner error/.test(b)), { what: 'an error banner (KR)' });
  const msg = (await banners()).find((b) => /^banner error/.test(b));
  assert.match(msg, /sample apps come from the D9010 VmApp registry and it could not be reached/);
  assert.match(msg, /Install from file/);
  assert.equal(await exists(lib, '[data-role="examples"]'), false, 'no sheet');
  reg.failList = false;
  await lib.eval(`document.querySelectorAll('#banners .banner').forEach((b) => b.remove())`);

  step('KR: the sheet lists the apps of the verified publisher only, with the registry’s words');
  await click(lib, '[data-action="load-examples"]');
  await waitSel(lib, '[data-role="examples"]', 'Load examples sheet (KR)');
  await waitFor(async () => (await rows()).length === 2, { what: 'two rows: the unverified app is not an example' });
  assert.match(await text(lib, '[data-role="examples-intro"]'), /sample apps from the D9010 VmApp registry, published by D9010 Inc/);
  const list = await rows();
  assert.deepEqual(list.map((r) => [r.file, r.name, r.version]), [['com.vmapp.exr.alpha', 'Alpha Sample', '1.0.0'], ['com.vmapp.exr.beta', 'Beta Sample', '1.0.0']]);
  assert.equal(list[0].desc, 'Alpha Sample: a fixture app of the loader test (run KR).');
  assert.deepEqual([list[0].allowKey, list[0].allowFrom, list[0].allow], ['Asks for: ', 'registry', 'Alpha Sample asks for little']);
  assert.match(list[0].size, /^\d+(\.\d)? KiB$/);
  assert.ok(list.every((r) => r.checked), 'all chosen to begin with');
  assert.ok(!(await text(lib, '[data-role="examples"]')).includes('Rogue'), 'the app of an unverified publisher is not there');
  assert.ok(!(await text(lib, '[data-role="examples"]')).includes('Claimed Inc.'), 'what a package claims about its publisher is not shown');
  await shot2x(lib, 'examples-from-registry');

  step('KR: install: downloaded and verified, installed with the registry remembered, nothing granted');
  await click(lib, '[data-action="examples-install"]');
  await waitSel(lib, '[data-action="examples-done"]', 'the install is done (KR)', 60000);
  assert.deepEqual((await rows()).map((r) => [r.file, r.result]), [['com.vmapp.exr.alpha', 'installed'], ['com.vmapp.exr.beta', 'installed']]);
  assert.match(await text(lib, '[data-role="examples-summary"]'), /^Installed 2 apps\.$/);
  for (const id of ['com.vmapp.exr.alpha', 'com.vmapp.exr.beta']) assert.equal(fs.readFileSync(path.join(homeKR, 'apps', id, 'current'), 'utf8').trim(), '1.0.0');
  assert.ok(!fs.existsSync(path.join(homeKR, 'apps', 'com.vmapp.exr.rogue')), 'the unverified app was not installed');
  assert.ok(reg.log.some((l) => /\/com\.vmapp\.exr\.alpha\/1\.0\.0\/download$/.test(l.url)), 'it came from the registry');
  const grantsDir = path.join(homeKR, 'grants');
  assert.deepEqual(fs.existsSync(grantsDir) ? fs.readdirSync(grantsDir) : [], [], 'nothing granted');
  assert.deepEqual(fs.existsSync(path.join(homeKR, 'tmp')) ? fs.readdirSync(path.join(homeKR, 'tmp')) : [], [], 'the downloads were deleted');
  await click(lib, '[data-action="examples-done"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed (KR)' });
  await waitSel(lib, '[data-app="com.vmapp.exr.alpha"]', 'the installed app’s card');
  const cardText = await text(lib, '[data-app="com.vmapp.exr.alpha"]');
  assert.ok(!/nverified/.test(cardText), 'no “unverified” on the card');
  assert.ok(!cardText.includes('Claimed Inc.'), 'the publisher a package claims is not shown on the card');

  step('KR: quit cleanly; no VM was ever started');
  assert.equal(testVms(homeKR).length, 0);
  dropConns();
  await killLoader(L, 'SIGTERM', 30000);
  await reg.stop();
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-KR.log'), 'utf8').includes('unhandled rejection'), 'no unhandled rejection in the loader log');
  step('run KR passed');
}

// =============================================================================================== run L: Browse registry
// "Browse registry…" (library button and File menu) through the REAL library UI against a REAL registry (registry/lib/registry.js, started
// here on port 0 with its data under $VMAPP_WORK, the way tests/registry does). The registry's own request log is what proves how often
// the loader asked. No VM is ever started; nothing is launched or allowed.
async function runL() {
  step('run L: Browse registry (no request until opened, one per user action, cards, hostile and long text, installed apps, the verified install path, errors)');
  const regH = require(path.join(VMAPP, 'tests', 'registry', 'helpers.js'));
  const homeL = path.join(ROOT, 'home-l');
  const menuDir = path.join(ROOT, 'menu-l');
  const projRoot = path.join(ROOT, 'l-proj');
  const pkgDir = path.join(ROOT, 'l-pkgs');
  const PRE = 'com.vmapp.brk';
  const mails = [];
  const reqLog = []; // one line per request the registry answered: "GET /api/apps 200 3ms"
  const R = await regH.startRegistry({ mailer: { send: async (m) => void mails.push(m) }, log: (m) => reqLog.push(m) });
  const listReqs = () => reqLog.filter((l) => /^GET \/api\/apps \d{3} /.test(l)).length;
  const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  // ---- the registry's apps: real packages, really published ----
  const base = (id, name, version, over = {}) => ({
    format: 1,
    id,
    name,
    version,
    publisher: 'Claimed Publisher Inc.',
    description: `${name}: a fixture app of the loader test (run L).`,
    runtime: 'node22',
    core: { command: ['node', 'main.js'], workdir: '/app', memoryMiB: 256, cpus: 1 },
    ui: { root: 'ui' },
    permissions: { folders: [], dialogs: false, external: false },
    ...over,
  });
  let packN = 0;
  const packApp = (m) => {
    const proj = path.join(projRoot, `p${++packN}`);
    fs.mkdirSync(path.join(proj, 'ui'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'core'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'vmapp.json'), JSON.stringify(m, null, 2));
    fs.writeFileSync(path.join(proj, 'ui', 'index.html'), `<!doctype html><title>${packN}</title>\n`);
    fs.writeFileSync(path.join(proj, 'core', 'main.js'), "console.log('fixture');\n");
    fs.mkdirSync(pkgDir, { recursive: true });
    const file = path.join(pkgDir, `app${packN}.vmapp`);
    hostlib.pack(proj, file);
    return file;
  };
  const publishApp = async (m, opts) => {
    const r = await regH.publish(R.url, packApp(m), opts);
    assert.equal(r.status, 201, r.text);
    R.clock.advance(60 * 1000);
    return r.json;
  };
  const HOSTILE_NAME = '<img src=x onerror="window.__pwned=1">Evil';
  const HOSTILE_DESC = '<script>window.__pwned=1</script> <b>bold</b> "double" \'single\' &amp; &lt;i&gt;';
  const LONGID = `${PRE}.${'z'.repeat(70)}`;
  const LONGNAME = 'N'.repeat(60);
  const LONGVER = `1.0.0-rc${'9'.repeat(50)}`;
  const LONGDESC = 'D'.repeat(480);

  // the first publisher verifies its email: the registry then shows "Verified email @verified.test" instead of nothing
  const notesM = base(`${PRE}.notes`, 'Browse Notes', '1.0.0', {
    description: 'Takes notes. Reads one folder, reaches one internet address and can listen.',
    permissions: {
      folders: [{ name: 'docs', access: 'read', purpose: 'The documents it reads' }],
      dialogs: false,
      external: false,
      network: [{ host: 'api.example.com', purpose: 'Sync' }],
      devices: [{ device: 'microphone', purpose: 'Voice notes' }],
    },
  });
  const first = await publishApp(notesM, { profile: { email: 'dev@verified.test' } });
  assert.ok(first.ownerToken);
  assert.equal((await regH.call(R.url, '/api/publisher/verify-email', { method: 'POST', token: first.ownerToken })).status, 200);
  const code = /code: ([0-9a-f]{32})/.exec(mails.at(-1).text)[1];
  assert.equal((await regH.call(R.url, '/api/publisher/confirm-email', { method: 'POST', json: { code } })).status, 200);

  const alreadyM = base(`${PRE}.already`, 'Already Here', '1.0.0');
  const alreadyPkg = packApp(alreadyM);
  const alreadyFirst = await regH.publish(R.url, alreadyPkg);
  assert.equal(alreadyFirst.status, 201, alreadyFirst.text);
  R.clock.advance(60 * 1000);
  await publishApp(base(`${PRE}.hostile`, HOSTILE_NAME, '1.0.0', { description: HOSTILE_DESC }));
  await publishApp(base(LONGID, LONGNAME, LONGVER, { description: LONGDESC }));
  for (let i = 1; i <= 21; i++) await publishApp(base(`${PRE}.filler${String(i).padStart(2, '0')}`, `Filler ${String(i).padStart(2, '0')}`, '1.0.0'));
  // a newer version of the app that is already installed here: the card says what the registry lists
  await publishApp({ ...alreadyM, version: '1.1.0' }, { token: alreadyFirst.json.ownerToken });
  assert.equal((await regH.call(R.url, '/api/apps?limit=100')).json.total, 25);

  // ---- the loader: one app is already installed in its home; VMAPP_REGISTRY names this registry ----
  fs.mkdirSync(homeL, { recursive: true });
  new hostlib.Store({ home: homeL, skipRuntimeCheck: true }).install(alreadyPkg);
  const appDir = (id) => path.join(homeL, 'apps', id);
  const installed = (id) => (fs.existsSync(path.join(appDir(id), 'current')) ? fs.readFileSync(path.join(appDir(id), 'current'), 'utf8').trim() : null);
  const grantsDir = path.join(homeL, 'grants');
  const tmpLeft = () => (fs.existsSync(path.join(homeL, 'tmp')) ? fs.readdirSync(path.join(homeL, 'tmp')).filter((n) => n.startsWith('vmapp-dl-')) : []);
  reqLog.length = 0;
  const L = startLoader({ home: homeL, name: 'loader-L', env: { VMAPP_REGISTRY: R.url, VMAPP_TEST_MENU_DIR: menuDir } });
  const lib = await waitTarget(isLibrary, 'library (L)');
  const banners = () => lib.eval(`[...document.querySelectorAll('#banners .banner')].map((b) => b.className + ': ' + b.textContent)`);
  const closeSheets = async () => {
    await lib.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'sheet closed (L)' });
  };
  const SEL = (role) => `[data-role="${role}"]`;
  const status = () => text(lib, SEL('browse-status'));
  const settled = () => waitFor(async () => !(await status() || '').startsWith('Asking the registry'), { what: 'the registry answered', timeout: 15000 });
  const cardIds = () => lib.eval(`[...document.querySelectorAll('[data-browse-app]')].map((r) => r.dataset.browseApp)`);
  const cardInfo = (id) =>
    lib.eval(`(() => {
      const r = document.querySelector('[data-browse-app="${id}"]');
      if (!r) return null;
      const t = (s) => { const e = r.querySelector(s); return e ? e.textContent : null; };
      const pub = r.querySelector('[data-role="browse-publisher"]');
      return {
        name: t('[data-role="browse-name"]'), id: t('[data-role="browse-id"]'), desc: t('[data-role="browse-desc"]'), meta: t('[data-role="browse-meta"]'), perms: t('[data-role="browse-perms"]'),
        publisher: pub ? pub.textContent : null, level: pub ? pub.dataset.level : null, pubClass: pub ? pub.className : null, pubTitle: pub ? pub.title : null,
        installed: t('[data-role="browse-installed"]'), hasInstall: !!r.querySelector('[data-action="browse-install"]'), note: t('[data-role="browse-note"]'),
        injected: r.querySelectorAll('img, script, b, i, a, iframe, svg, style').length,
      };
    })()`);
  let expectedList = 0;
  const expectList = (what) => assert.equal(listReqs(), expectedList, `${what}: ${listReqs()} list request(s) reached the registry, expected ${expectedList} (${JSON.stringify(reqLog.slice(-4))})`);
  const search = async (q) => {
    await setIn(lib, SEL('browse-query'), q);
    await click(lib, '[data-action="browse-search"]');
    expectedList++;
    await settled();
  };
  const setSort = async (v) => {
    await setIn(lib, SEL('browse-sort'), v);
    expectedList++;
    await settled();
  };

  // ---- 1. nothing is asked until the sheet is opened ----
  step('L: the loader starts without asking the registry anything; the library has Browse registry… and no "Install from registry…"');
  await waitSel(lib, '[data-app]', 'the library with the installed app');
  await sleep(2500);
  assert.deepEqual(reqLog, [], 'no request of any kind reaches the registry before the user opens Browse');
  assert.equal(await text(lib, '#btn-browse-registry'), 'Browse registry…');
  assert.equal(await exists(lib, '#btn-install-registry'), false, 'the registry is fixed: there is no second dialog that asks for an address');
  assert.equal(await exists(lib, '[data-action="install-registry"]'), false);
  const menu = JSON.parse(fs.readFileSync(path.join(menuDir, 'menu.json'), 'utf8'));
  const fileMenu = menu.find((m) => m.label === 'File').items;
  const bItem = fileMenu.find((i) => i.id === 'file-browse-registry');
  assert.deepEqual([bItem.label, bItem.visible, bItem.enabled, bItem.accelerator], ['Browse registry…', true, true, 'CmdOrCtrl+Shift+B']);

  // ---- 2. open it: one request, the first page ----
  step('L: opening Browse asks once (the launcher’s own registry, newest first) and shows 20 cards; the registry is shown, not editable');
  await click(lib, '#btn-browse-registry');
  await waitSel(lib, SEL('browse'), 'the Browse sheet');
  expectedList++;
  await waitFor(async () => (await cardIds()).length === 20, { what: 'twenty cards', timeout: 15000 });
  expectList('after opening');
  assert.equal(await text(lib, '.sheet h2'), 'Browse registry');
  assert.equal(await text(lib, SEL('browse-registry')), R.url, 'the registry is the loader’s own (VMAPP_REGISTRY here, the public registry in a packaged loader)');
  assert.equal(await lib.eval(`document.querySelectorAll('.sheet input[type="text"]').length`), 1, 'the only text box is the search: no registry address to type');
  assert.equal(await exists(lib, '[data-action="browse-by-id"]'), false, 'no “Type an app id or link…”');
  assert.equal(await status(), `From ${R.url}: showing 20 of 25 apps.`);
  assert.equal(await lib.eval(`document.querySelector('${SEL('browse-sort')}').value`), 'new', 'the default order is the newest apps');
  const first20 = await cardIds();
  assert.equal(first20[0], `${PRE}.filler21`, 'the app published last comes first');
  assert.equal(first20[19], `${PRE}.filler02`, 'the 20 newest of the 25');
  assert.equal(await text(lib, SEL('browse-insecure')), null, 'no plain-http warning for a registry on this computer');
  assert.deepEqual(await lib.eval(`[...document.querySelectorAll('${SEL('browse-sort')} option')].map((o) => [o.value, o.textContent])`), [['new', 'Newest'], ['popular', 'Most downloaded'], ['updated', 'Recently updated'], ['name', 'Name (A to Z)']]);
  assert.equal(await exists(lib, '[data-action="browse-more"]'), true);
  assert.equal(await lib.eval(`document.querySelector('.bmore').hidden`), false);

  // ---- 2b. Show more ----
  step('L: Show more continues the list: one more request, five more cards, no repeat, the button goes away');
  await click(lib, '[data-action="browse-more"]');
  expectedList++;
  await settled();
  expectList('after Show more');
  let ids = await cardIds();
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25, 'no app twice');
  assert.equal(ids[24], `${PRE}.notes`, 'the first app published is last');
  assert.equal(await status(), `From ${R.url}: showing 25 of 25 apps.`);
  assert.equal(await lib.eval(`document.querySelector('.bmore').hidden`), true, 'nothing more to show');

  // ---- 3. what a card says ----
  step('L: a card: name, publisher label as the registry presents it, description, version, size, downloads and the registry’s permission summary');
  let notes = await cardInfo(`${PRE}.notes`);
  assert.ok(notes, 'Browse Notes is on the first page');
  assert.equal(notes.name, 'Browse Notes');
  assert.equal(notes.id, `${PRE}.notes`);
  assert.equal(notes.publisher, 'Verified email @verified.test', 'exactly the registry’s label');
  assert.equal(notes.level, 'email');
  assert.match(notes.pubClass, /pub-email/);
  assert.match(notes.pubTitle, /cannot check it/, 'the chip says the loader does not check the label');
  assert.equal(notes.desc, 'Takes notes. Reads one folder, reaches one internet address and can listen.');
  assert.match(notes.meta, /^version 1\.0\.0 · \d+\.\d KiB · 0 downloads · runs on node22$/);
  assert.match(notes.perms, /^The registry says it asks for: folder "docs" \(read only\).*microphone.*internet: api\.example\.com/);
  assert.equal(notes.hasInstall, true);
  assert.equal(notes.installed, null);
  const filler = await cardInfo(`${PRE}.filler01`);
  assert.deepEqual([filler.publisher, filler.level], [null, null], 'an unverified publisher shows nothing: no chip, and never the name it claims');
  assert.ok(!(await lib.eval(`document.querySelector('${SEL('browse')}').textContent`)).includes('nverified'), 'the word is not on the sheet');
  assert.ok(!JSON.stringify(await lib.eval(`document.querySelector('${SEL('browse')}').textContent`)).includes('Claimed Publisher'), 'the publisher’s own claimed name appears nowhere');
  assert.equal(await lib.eval(`document.querySelectorAll('.bicon').length`), 25, 'every card has the placeholder icon');

  // ---- 4. an app that is already installed ----
  step('L: an installed app says Installed <version> and has no Install button; the registry’s other version is stated plainly');
  const already = await cardInfo(`${PRE}.already`);
  assert.equal(already.installed, 'Installed 1.0.0');
  assert.equal(already.hasInstall, false);
  assert.match(already.meta, /the registry lists 1\.1\.0$/);

  // ---- 5. hostile text ----
  step('L: markup in a name or description is text: no element is made, nothing runs');
  const evil = await cardInfo(`${PRE}.hostile`);
  assert.equal(evil.name, HOSTILE_NAME);
  assert.equal(evil.desc, HOSTILE_DESC);
  assert.equal(evil.injected, 0, 'no img, script, b, i, a, iframe, svg or style element came out of the text');
  assert.equal(await lib.eval(`typeof window.__pwned`), 'undefined', 'nothing ran');
  assert.equal(await lib.eval(`document.querySelectorAll('.blist img, .blist script, .blist iframe').length`), 0);

  // ---- 7. long text stays inside its box ----
  step('L: 480 unbroken characters, a 60-character name and a long version stay inside the card and the sheet (and the same check finds the overflow with wrap.css off)');
  const wrapLink = (on) => lib.eval(`(() => { const l = document.querySelector('link[href="wrap.css"]'); if (!l) throw new Error('wrap.css is not linked'); l.disabled = ${!on}; return true; })()`);
  const overflowing = (rootSel) =>
    lib.eval(`(() => {
      const SKIP = /^(INPUT|SELECT|TEXTAREA|OPTION|BUTTON|SCRIPT|STYLE|IMG|HTML|BODY)$/;
      const out = [];
      for (const root of document.querySelectorAll(${q(rootSel)})) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (SKIP.test(el.tagName) || el.clientWidth === 0) continue;
          if (getComputedStyle(el).textOverflow === 'ellipsis') continue;
          if (el.scrollWidth > el.clientWidth + 1) out.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '') + ' ' + el.scrollWidth + '>' + el.clientWidth);
        }
      }
      return out;
    })()`);
  const wide = await cardInfo(LONGID);
  assert.ok(wide, 'the long-text app is listed');
  assert.equal(wide.name, LONGNAME);
  assert.equal(wide.desc, LONGDESC);
  assert.match(wide.meta, /^version 1\.0\.0-rc9{50} /);
  await lib.eval(`document.querySelector('[data-browse-app="${LONGID}"]').scrollIntoView({ block: 'center' })`);
  await wrapLink(true);
  assert.deepEqual(await overflowing('.sheet'), [], 'with wrap.css nothing runs out of the Browse sheet');
  assert.ok((await lib.eval(`(() => { const s = document.querySelector('.sheet'); return s.scrollWidth - s.clientWidth; })()`)) <= 1, 'the sheet does not scroll sideways');
  await wrapLink(false);
  assert.ok((await overflowing('.sheet')).length > 0, 'without wrap.css the same check finds the overflow');
  await wrapLink(true);
  await waitFor(async () => (await overflowing('.sheet')).length === 0, { what: 'wrap.css applied again' }); // a re-enabled style sheet is applied a moment later

  // ---- 8. the sort ----
  step('L: sort: each change is one request and starts the list again; Name is A to Z, Recently updated puts the app with a new version first, Newest is back to the default');
  await setSort('name');
  expectList('sort: name');
  ids = await cardIds();
  assert.equal(ids.length, 20, 'a new sort starts at the first page');
  assert.equal(await status(), `From ${R.url}: showing 20 of 25 apps.`);
  const names = await lib.eval(`[...document.querySelectorAll('[data-role="browse-name"]')].map((e) => e.textContent.toLowerCase())`);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'A to Z');
  await setSort('updated');
  expectList('sort: updated');
  assert.equal((await cardIds())[0], `${PRE}.already`, 'the app whose newer version was published last comes first');
  await setSort('popular');
  expectList('sort: popular');
  assert.equal((await cardIds()).length, 20);
  await setSort('new');
  expectList('sort: newest again');
  assert.equal((await cardIds())[0], `${PRE}.filler21`);

  // ---- 9. search ----
  step('L: search: Search is one request; the list is what matches; nothing matching says so; clearing it lists everything again');
  await search('filler 07');
  expectList('search filler 07');
  assert.deepEqual(await cardIds(), [`${PRE}.filler07`]);
  assert.equal(await status(), `Matching “filler 07” in ${R.url}: showing 1 of 1 app.`);
  assert.equal(await lib.eval(`document.querySelector('.bmore').hidden`), true, 'no Show more for one result');
  await search('zzzz nothing like it');
  expectList('search nothing');
  assert.deepEqual(await cardIds(), []);
  assert.equal(await status(), `No apps in ${R.url} match “zzzz nothing like it”.`);
  await search('');
  expectList('search cleared');
  assert.equal((await cardIds()).length, 20);
  await search('evil');
  expectList('search evil');
  assert.deepEqual(await cardIds(), [`${PRE}.hostile`], 'the name is searched as the text it is');
  await search('claimed publisher');
  expectList('search the claimed publisher');
  assert.deepEqual(await cardIds(), [], 'what a publisher merely claims is not searched (the registry’s display rule)');
  await search('verified.test');
  expectList('search the verified domain');
  assert.deepEqual(await cardIds(), [`${PRE}.notes`], 'a verified fact is');

  // ---- 10. install, cancelled ----
  step('L: Install goes through the verified path: download, then the ordinary install review; Cancel leaves nothing');
  await search('filler 07');
  expectList('search for the cancelled install');
  const before = reqLog.length;
  await click(lib, `[data-browse-app="${PRE}.filler07"] [data-action="browse-install"]`);
  await waitSel(lib, SEL('review'), 'the install review');
  assert.match(await text(lib, SEL('review')), /Filler 07 1\.0\.0/);
  assert.match(await text(lib, SEL('review')), /New app/);
  assert.match(await text(lib, SEL('review')), new RegExp(`from ${R.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(await text(lib, '.sheet h2'), 'Install this app?', 'the same review as any other install');
  const asked = reqLog.slice(before);
  assert.ok(asked.some((l) => l.startsWith(`GET /api/apps/${PRE}.filler07/versions 200`)), 'the version list was asked for');
  assert.ok(asked.some((l) => l.startsWith(`GET /api/apps/${PRE}.filler07/1.0.0/download 200`)), 'the package was downloaded');
  assert.equal(installed(`${PRE}.filler07`), null, 'downloaded is not installed');
  assert.equal(fs.existsSync(path.join(grantsDir, `${PRE}.filler07.json`)), false);
  assert.equal(tmpLeft().length, 1, 'the download waits in the loader’s temp folder while it is being reviewed');
  await click(lib, '[data-action="cancel"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'review cancelled' });
  await waitFor(() => tmpLeft().length === 0, { what: 'the cancelled download is removed' });
  assert.equal(installed(`${PRE}.filler07`), null);
  expectList('after the cancelled install');

  // ---- 11. reopen: what it showed, no new request ----
  step('L: reopening Browse shows the search it had, with no new request');
  await click(lib, '#btn-browse-registry');
  await waitSel(lib, SEL('browse'), 'the Browse sheet again');
  await sleep(500);
  expectList('after reopening');
  assert.deepEqual(await cardIds(), [`${PRE}.filler07`]);
  assert.equal(await lib.eval(`document.querySelector('${SEL('browse-query')}').value`), 'filler 07');
  assert.equal(await status(), `Matching “filler 07” in ${R.url}: showing 1 of 1 app.`);

  // ---- 12. install for real ----
  step('L: install Browse Notes from its card: the review lists the folder, the address and the microphone; nothing is installed or granted until Install is pressed');
  await search('browse notes');
  expectList('search browse notes');
  assert.deepEqual(await cardIds(), [`${PRE}.notes`]);
  await click(lib, `[data-browse-app="${PRE}.notes"] [data-action="browse-install"]`);
  await waitSel(lib, SEL('review'), 'the install review of Browse Notes');
  const reviewText = await text(lib, '.review');
  assert.match(reviewText, /Browse Notes 1\.0\.0/);
  assert.match(reviewText, /docs/);
  assert.match(reviewText, /api\.example\.com/);
  assert.match(reviewText, /microphone/i);
  assert.equal(installed(`${PRE}.notes`), null, 'reviewing installs nothing');
  assert.equal(fs.existsSync(path.join(grantsDir, `${PRE}.notes.json`)), false);
  await click(lib, '[data-action="confirm-install"]');
  await waitFor(async () => (await banners()).some((b) => b.startsWith('banner info: Installed Browse Notes 1.0.0 from ')), { what: 'the installed banner' });
  assert.equal(installed(`${PRE}.notes`), '1.0.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appDir(`${PRE}.notes`), 'source.json'), 'utf8')), { registry: R.url, id: `${PRE}.notes`, installedFrom: '1.0.0' }, 'it remembers the registry it came from');
  assert.equal(fs.existsSync(path.join(grantsDir, `${PRE}.notes.json`)), false, 'installing granted nothing');
  assert.equal(tmpLeft().length, 0);
  await waitSel(lib, `[data-app="${PRE}.notes"]`, 'the new card in the library');
  expectList('after the install');
  // the card now says Installed (the page asks nothing to know)
  await click(lib, '#btn-browse-registry');
  await waitSel(lib, SEL('browse'), 'the Browse sheet after the install');
  await sleep(300);
  expectList('after the install, reopened');
  const nowInstalled = await cardInfo(`${PRE}.notes`);
  assert.deepEqual([nowInstalled.installed, nowInstalled.hasInstall], ['Installed 1.0.0', false]);
  assert.equal(await text(lib, SEL('browse-registry')), R.url);

  // ---- 13. no way to name another registry ----
  step('L: there is no “Type an app id or link…”, no “Install from registry…” and no address box: the registry is the loader’s own');
  assert.equal(await exists(lib, '[data-action="browse-by-id"]'), false);
  assert.equal(await exists(lib, SEL('registry-url')), false);
  assert.equal(await exists(lib, '#btn-install-registry'), false);
  assert.equal(await lib.eval(`typeof loader.registryBrowse`), 'function');
  // the page cannot pass an address either: whatever it passes, the main process asks its own registry
  expectedList++;
  const viaPage = await lib.eval(`loader.registryBrowse({ registry: 'http://127.0.0.1:1', q: '', sort: 'name', offset: 0 }).then((r) => r.registry, (e) => 'error: ' + e.message)`);
  assert.equal(viaPage, R.url, 'an address passed by the page is ignored');
  expectList('after the page tried to name a registry');
  await closeSheets();

  // ---- 15. the page itself has no network and no Node ----
  step('L: the library page cannot reach the network itself (CSP) and has no Node');
  const before2 = reqLog.length;
  assert.equal(await lib.eval(`fetch(${JSON.stringify(`${R.url}/api/apps`)}).then(() => 'allowed', () => 'blocked')`), 'blocked');
  assert.equal(await lib.eval(`new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(`${R.url}/api/apps`)}); x.onerror = () => res('blocked'); x.onload = () => res('allowed'); x.send(); } catch { res('blocked'); } })`), 'blocked');
  assert.deepEqual([await lib.eval(`typeof require`), await lib.eval(`typeof process`), await lib.eval(`typeof module`)], ['undefined', 'undefined', 'undefined']);
  await sleep(300);
  assert.equal(reqLog.length, before2, 'nothing reached the registry from the page');

  // ---- 16. the File menu ----
  step('L: File → Browse registry… opens the sheet (with what it had, no request)');
  await closeSheets();
  const clickMenu = async (id) => {
    const n = jsonl(path.join(menuDir, 'clicked.jsonl')).length;
    fs.writeFileSync(path.join(menuDir, 'click.txt'), id);
    await waitFor(() => jsonl(path.join(menuDir, 'clicked.jsonl')).length > n, { what: `the loader took the menu click ${id}` });
    return jsonl(path.join(menuDir, 'clicked.jsonl')).at(-1);
  };
  assert.deepEqual(await clickMenu('file-browse-registry'), { id: 'file-browse-registry', found: true, enabled: true });
  await waitSel(lib, SEL('browse'), 'the Browse sheet from the File menu');
  await sleep(300);
  expectList('after File → Browse registry…');
  assert.deepEqual(await cardIds(), [`${PRE}.notes`], 'the last search (Browse Notes) is what the sheet had');
  await click(lib, '[data-action="browse-close"]');
  await waitFor(async () => !(await exists(lib, '.sheet')), { what: 'Close' });

  // ---- 17. nothing in the background ----
  step('L: with the sheet closed the loader stays silent; no VM was started; quit');
  const quiet = reqLog.length;
  await sleep(2500);
  assert.equal(reqLog.length, quiet, 'no request while idle');
  assert.equal(listReqs(), expectedList);
  assert.equal(testVms(homeL).length, 0);
  assert.deepEqual((await banners()).filter((b) => /^banner error/.test(b)), [], 'no error banner');

  // ---- 18. a registry that cannot be reached ----
  step('L: when the registry cannot be reached the sheet says so plainly and shows no old list under that error');
  await R.close();
  await click(lib, '#btn-browse-registry');
  await waitSel(lib, SEL('browse'), 'the Browse sheet (error)');
  await setIn(lib, SEL('browse-query'), '');
  await click(lib, '[data-action="browse-search"]');
  await settled();
  assert.match(await status(), new RegExp(`^Cannot reach the registry at ${R.url.replace(/\./g, '\\.')} \\(ECONNREFUSED\\)`));
  assert.equal(await lib.eval(`document.querySelector('${SEL('browse-status')}').className`), 'err');
  assert.deepEqual(await cardIds(), [], 'no old list under an error');
  await closeSheets();
  dropConns();
  await killLoader(L, 'SIGTERM', 30000);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-L.log'), 'utf8').includes('unhandled rejection'), 'no unhandled rejection in the loader log');
  regH.rmrf(R.dir);
  step('run L passed');
}

// =============================================================================================== run M: app menus (SPEC 7 "Menus")
async function runM() {
  step('run M: an app’s menus in the Mac menu bar: from its page and from its core (SDK Menu), clicks, kept shortcuts, the loader’s own menus');
  const MID = 'com.vmapp.menutest';
  const homeM = path.join(ROOT, 'home-m');
  const menuDir = path.join(ROOT, 'menu-m');
  const isAppM = (u) => u.startsWith(`vmapp-ui://${MID}/`);
  const pkgM = path.join(ROOT, 'menutest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-menu'), pkgM);
  new hostlib.Store({ home: homeM, skipRuntimeCheck: true }).install(pkgM);
  const readMenu = () => JSON.parse(fs.readFileSync(path.join(menuDir, 'menu.json'), 'utf8'));
  const tops = () => readMenu().map((m) => m.label);
  const clickMenu = (id) => fs.writeFileSync(path.join(menuDir, 'click.txt'), id);

  const M = startLoader({ home: homeM, name: 'loader-M', env: { VMAPP_TEST_MENU_DIR: menuDir } });
  const lib = await waitTarget(isLibrary, 'library (M)');
  await waitSel(lib, `[data-app="${MID}"]`, 'the menu test app’s card');
  const loaderTops = tops();
  assert.deepEqual(loaderTops, ['D9010 VmApp Launcher', 'File', 'Edit', 'View', 'Window'], 'the loader’s own menu bar');
  await click(lib, `[data-app="${MID}"] [data-action="launch"]`);
  const app = await waitTarget(isAppM, 'menu test app window (M)', 90000);
  await waitFor(() => app.eval(`typeof window.__setPageMenu === 'function' && document.readyState === 'complete'`), { what: 'the menu test page' });
  await app.send('Page.bringToFront');
  const log = () => app.eval('window.__menuLog.slice()');

  step('M: the page sets its menus: they sit between the loader’s first and Window menus, the loader keeps ⌘Q, a click reaches the page');
  const r = await app.eval('window.__setPageMenu()');
  assert.deepEqual(r, { items: 6, dropped: ['CmdOrCtrl+Q'] });
  await waitFor(() => tops().join() === ['D9010 VmApp Launcher', 'File', 'View', 'Edit', 'Window'].join(), { what: 'the app’s menus in the menu bar', timeout: 10000 });
  const m1 = readMenu();
  const file = m1[1].items;
  assert.deepEqual(file.map((i) => [i.id, i.label, i.accelerator]), [['app:open', 'Open…', 'CmdOrCtrl+O'], [null, '', null], ['app:quit-app', 'Quit Menu Test', null]]);
  assert.equal(m1[2].items[1].items[0].accelerator, 'CmdOrCtrl+1', 'the app may use ⌘1');
  assert.ok(m1[3].items.some((i) => i.role === 'copy') && m1[3].items.some((i) => i.role === 'paste'), 'the loader’s Edit menu keeps keyboard copy and paste');
  const win = m1[4].items;
  assert.equal(win.find((i) => i.label === 'App Library').accelerator, null, 'the loader’s ⌘1-⌘4 are left to the app');
  assert.ok(win.some((i) => i.id === 'app-devtools'));
  assert.deepEqual(m1[0].items.map((i) => i.role).filter(Boolean), ['about', 'hide', 'hideothers', 'unhide', 'quit'], 'the loader’s first menu, unchanged');
  clickMenu('app:open');
  await waitFor(async () => (await log()).includes('page:open'), { what: 'the page to hear its menu click' });
  clickMenu('app:wrap');
  await waitFor(async () => (await log()).includes('page:wrap'), { what: 'the checkbox click' });
  await assert.rejects(app.eval(`window.vmapp.menu.set([{ label: 'X', submenu: [{ label: 'Y' }] }])`), /id must be a string/);
  await assert.rejects(app.eval(`window.vmapp.menu.set([{ label: 'X', submenu: [{ id: 'q', label: 'Q', role: 'quit' }] }])`), /role must be one of/);
  assert.deepEqual(tops(), ['D9010 VmApp Launcher', 'File', 'View', 'Edit', 'Window'], 'a refused template changes nothing');

  step('M: the page removes its menus; the core sets the app’s menus with the SDK’s Menu (Electron roles mapped); a click runs the core’s handler');
  await app.eval('window.vmapp.menu.set(null)');
  await waitFor(() => tops().join() === loaderTops.join(), { what: 'the loader’s menu bar again', timeout: 10000 });
  const cr = await app.eval(`window.vmapp.invoke('core:set-menu')`);
  assert.deepEqual(cr.dropped, []);
  await waitFor(() => tops().join() === ['D9010 VmApp Launcher', 'Tools', 'Edit', 'Window'].join(), { what: 'the core’s menus (appMenu left to the loader; editMenu expanded; no extra Edit)', timeout: 10000 });
  assert.equal(readMenu()[1].items[0].accelerator, 'CmdOrCtrl+Shift+H');
  clickMenu('app:core-hello');
  await waitFor(async () => (await log()).includes('core:core-hello'), { what: 'the core’s click handler to run (it tells the page)' });

  step('M: the library window gets the focus: the loader’s own menu bar comes back');
  clickMenu('focus:library');
  await waitFor(() => tops().join() === loaderTops.join(), { what: 'the loader’s menu bar for its own window', timeout: 10000 });
  await shot2x(lib, 'menus-library');

  step('M: quit cleanly');
  await killLoader(M, 'SIGTERM', 30000);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'loader-M.log'), 'utf8').includes('unhandled rejection'));
  await waitFor(() => testVms(homeM).length === 0, { what: 'no VM of run M after quitting', timeout: 15000 });
  step('run M passed');
}

// =============================================================================================== run W: the window network
/** Sends one request head to 127.0.0.1:port and returns the first line of the answer ('' when the connection was closed or refused). */
function rawProxyAnswer(port, head) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let got = '';
    const done = () => {
      s.destroy();
      resolve(got.split('\r\n')[0]);
    };
    s.setTimeout(10000, done);
    s.on('connect', () => s.write(head));
    s.on('data', (b) => {
      got += b.toString('latin1');
      if (got.includes('\r\n')) done();
    });
    s.on('error', done);
    s.on('close', done);
  });
}

async function runW() {
  step('run W: an app window reaches the internet only through its app\'s proxy and grants (SPEC 8.3 "The app\'s windows")');
  const WID = 'com.vmapp.winnettest';
  const homeW = path.join(ROOT, 'home-w');
  const isAppW = (u) => u.startsWith(`vmapp-ui://${WID}/`);
  const card = (sel) => `[data-app="${WID}"] ${sel}`;
  const pkgW = path.join(ROOT, 'winnettest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-winnet'), pkgW);
  const store = new hostlib.Store({ home: homeW, skipRuntimeCheck: true });
  store.install(pkgW);
  // the user decided: nothing allowed yet (so no permission sheet at launch)
  store.setNetGrant(WID, 'example.com', { allow: false });
  store.setNetGrant(WID, 'example.org', { allow: false });
  const online = await dns.promises.lookup('example.com').then(() => true, () => false);
  if (!online) step('W: NOTE: example.com does not resolve here (no internet): the allowed fetch is skipped, every refusal is still checked');

  const W = startLoader({ home: homeW, name: 'loader-W' });
  const lib = await waitTarget(isLibrary, 'library (W)');
  await waitSel(lib, card('[data-action="launch"]'), 'the window net app’s card');
  await click(lib, card('[data-action="launch"]'));
  const app = await waitTarget(isAppW, 'window net app window (W)', 90000);
  await waitFor(() => app.eval(`typeof window.__fetch === 'function' && document.readyState === 'complete'`), { what: 'the window net page' });
  const pageFetch = (url) => app.eval(`window.__fetch(${q(url)})`);
  const logW = () => fs.readFileSync(path.join(ROOT, 'loader-W.log'), 'utf8');
  const portLine = await waitFor(() => /window network: through the app's proxy on 127\.0\.0\.1:(\d+)/.exec(logW()), { what: 'the window endpoint in the loader log' });
  const endpointPort = Number(portLine[1]);

  step('W: no grant yet: the fetch leaves the page, reaches only the app’s endpoint, and is refused there (a `window` row)');
  assert.equal((await pageFetch('https://example.com/')).ok, false, 'refused without a grant');
  await click(lib, card('[data-action="inspect"]'));
  const insp = await waitTarget(isInspector, 'inspector (W)');
  const netRows = () => insp.eval(`[...document.querySelectorAll('#rows tr.row.net')].map((tr) => ({ target: tr.querySelector('[data-role="net-target"]').firstChild.textContent, reason: (tr.querySelector('[data-role="net-reason"]') || {}).textContent || '', bytes: tr.querySelector('[data-role="net-bytes"]').textContent, result: tr.querySelector('[data-role="host-result"]').textContent, seq: tr.dataset.seq }))`);
  const rowsFor = async (target) => (await netRows()).filter((r) => r.target === target);
  await waitFor(async () => (await rowsFor('window example.com:443')).some((r) => r.result === 'denied'), { what: 'a denied window row for example.com' });
  assert.match((await rowsFor('window example.com:443'))[0].reason, /network not granted/);
  const deniedSeq = (await rowsFor('window example.com:443'))[0].seq;
  await insp.eval(`document.querySelector('#rows tr.row.net[data-seq="${deniedSeq}"]').click()`);
  const meta = await insp.eval(`[...document.querySelectorAll('#detail-meta dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])`);
  assert.equal((meta.find((m) => m[0] === 'From') || [])[1], "the app's window (through the app's proxy)");

  step('W: allowed in Network… while it runs: the same fetch reaches example.com');
  await click(lib, card('[data-action="network"]'));
  await waitSel(lib, '[data-role="network-sheet"] [data-role="net-section"]', 'the Network… sheet');
  await setIn(lib, '[data-net-host="example.com"] [data-role="net-mode"]', 'allow');
  await click(lib, '[data-action="net-save"]');
  await waitFor(() => store.loadNetGrants(WID)['example.com'].allow === true, { what: 'the grant is saved' });
  if (online) {
    const ok = await waitFor(async () => {
      const r = await pageFetch('https://example.com/');
      return r.ok ? r : null;
    }, { what: 'the allowed fetch (applied to the running app)', timeout: 20000 });
    assert.equal(ok.type, 'opaque');
    // (its row comes when the tunnel closes, SPEC 8.3 "Traffic events"; the browser keeps it open in its pool until the revoke below)
  }

  step('W: a host not allowed, an IP address and localhost stay refused; the last two never reach the endpoint; no script from the network');
  assert.equal((await pageFetch('https://example.org/')).ok, false);
  await waitFor(async () => (await rowsFor('window example.org:443')).some((r) => r.result === 'denied' && /not allowed: example\.org:443/.test(r.reason)), { what: 'the denied row for example.org' });
  const img = await app.eval(`window.__image('https://example.org/x.png')`);
  assert.equal(img.loaded, false, 'an image from a host not allowed');
  for (const url of ['https://93.184.215.14/', 'https://127.0.0.1:1/', 'https://localhost/', 'https://printer.local/']) {
    assert.equal((await pageFetch(url)).ok, false, url);
  }
  assert.deepEqual(await app.eval(`window.__script('https://example.com/x.js')`), { loaded: false }, 'a script from a host that IS allowed still never loads');
  await sleep(1500);
  const targets = (await netRows()).map((r) => r.target);
  for (const t of ['window 93.184.215.14:443', 'window 127.0.0.1:1', 'window localhost:443', 'window printer.local:443']) {
    assert.ok(!targets.includes(t), `the request filter refused ${t} before it reached the endpoint: ${targets.join(', ')}`);
  }

  step('W: the endpoint answers nothing without the run’s secret');
  const head = (auth) => `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`;
  assert.match(await rawProxyAnswer(endpointPort, head(null)), /^HTTP\/1\.1 407 /);
  assert.match(await rawProxyAnswer(endpointPort, head(`Basic ${Buffer.from('vmapp:guess').toString('base64')}`)), /^HTTP\/1\.1 407 /);
  assert.ok(!logW().match(/[0-9a-f]{64}/), 'the secret is in no log line');

  step('W: taken away in Network…: cut off at once');
  await click(lib, card('[data-action="network"]'));
  await waitSel(lib, '[data-role="network-sheet"] [data-role="net-section"]', 'the Network… sheet');
  await setIn(lib, '[data-net-host="example.com"] [data-role="net-mode"]', 'none');
  await click(lib, '[data-action="net-save"]');
  await waitFor(() => store.loadNetGrants(WID)['example.com'].allow === false, { what: 'the revoke is saved' });
  await waitFor(async () => (await pageFetch('https://example.com/')).ok === false, { what: 'the fetch refused again', timeout: 15000 });
  if (online) {
    // the open tunnel was closed by the revoke: its row says it was allowed, how many bytes it carried, and why it ended
    await waitFor(async () => (await rowsFor('window example.com:443')).some((r) => r.result === 'allowed' && /revoked/.test(r.reason) && !/↓0 B$/.test(r.bytes)), { what: 'the allowed window row, closed by the revoke' });
  }
  await shot2x(insp, 'inspector-window-network');

  step('W: after the stop the endpoint is gone');
  await click(lib, card('[data-action="stop"]'));
  await waitFor(async () => (await cardState2(lib, WID)) === 'stopped', { what: 'the app stopped', timeout: 30000 });
  assert.equal(await rawProxyAnswer(endpointPort, head(null)), '', 'nothing listens on the endpoint any more');
  await killLoader(W, 'SIGTERM', 30000);
  assert.ok(!logW().includes('unhandled rejection'));
  await waitFor(() => testVms(homeW).length === 0, { what: 'no VM of run W after quitting', timeout: 15000 });
  step('run W passed');
}

// =============================================================================================== run U: "Leave this page?"
async function runU() {
  step('run U: a page vetoes its unload: the loader asks "Leave this page?" in its own words (SPEC 7, DEV-APPS §11 step 18)');
  const UID = 'com.vmapp.unloadtest';
  const homeU = path.join(ROOT, 'home-u');
  const isAppU = (u) => u.startsWith(`vmapp-ui://${UID}/`);
  const pkgU = path.join(ROOT, 'unloadtest.vmapp');
  hostlib.pack(path.join(LOADER, 'test', 'fixture-unload'), pkgU);
  new hostlib.Store({ home: homeU, skipRuntimeCheck: true }).install(pkgU);
  const dialogLogU = path.join(ROOT, 'dialogs-u.jsonl');
  const asked = () => (fs.existsSync(dialogLogU) ? fs.readFileSync(dialogLogU, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((d) => d.kind === 'leave-page');
  const logU = () => fs.readFileSync(path.join(ROOT, 'loader-U.log'), 'utf8');
  // answers: Stay, then Leave; the queue is empty after that, which stays
  const U = startLoader({ home: homeU, name: 'loader-U', env: { VMAPP_TEST_DIALOGS: JSON.stringify({ leave: ['stay', 'leave'] }), VMAPP_TEST_DIALOG_LOG: dialogLogU } });
  const lib = await waitTarget(isLibrary, 'library (U)');
  await waitSel(lib, `[data-app="${UID}"] [data-action="launch"]`, 'the unload test app’s card');
  await click(lib, `[data-app="${UID}"] [data-action="launch"]`);
  const app = await waitTarget(isAppU, 'unload test app window (U)', 90000);
  await waitFor(() => app.eval(`typeof window.__armUnload === 'function' && document.readyState === 'complete'`), { what: 'the unload test page' });
  const origin = () => app.eval('performance.timeOrigin');
  // Chromium asks about a veto only after the user used the page (sticky activation): the arming counts as a user gesture
  const arm = async () => {
    const r = await app.send('Runtime.evaluate', { expression: 'window.__armUnload()', userGesture: true, returnByValue: true });
    assert.equal(r.result.value, true, 'the page armed its beforeunload handler');
  };
  // a renderer-initiated reload; the evaluation may lose its context when the reload goes ahead
  const reload = () => app.send('Runtime.evaluate', { expression: 'location.reload(), true', returnByValue: true }).catch(() => null);

  step('U: Stay keeps the page (no reload), with the loader’s wording; a veto again at once stays without a second question');
  await arm();
  const before = await origin();
  await reload();
  await reload();
  await sleep(500);
  assert.equal(await origin(), before, 'Stay: the page was not reloaded');
  assert.equal(await app.eval(`document.getElementById('state').textContent`), 'armed');
  const a1 = asked();
  assert.equal(a1.length, 1, 'one question for two vetoes within a second');
  assert.deepEqual(a1[0].detail, {
    app: UID,
    title: 'Leave this page?',
    message: '“Unload Test” asks you to confirm: changes you made may not be saved.',
    buttons: ['Leave', 'Stay'],
    answer: 'stay',
  });
  assert.ok(!fs.readFileSync(dialogLogU, 'utf8').includes('PAGE TEXT'), 'the page’s own text is never shown');
  assert.match(logU(), /vetoed its unload again within 1000 ms of Stay; it stays without asking/);

  step('U: after the quiet second, Leave reloads the page');
  await sleep(1200);
  await reload();
  await waitFor(async () => (await origin().catch(() => before)) !== before, { what: 'the page to reload after Leave', timeout: 10000 });
  await waitFor(() => app.eval(`document.readyState === 'complete' && document.getElementById('state').textContent === 'not armed'`), { what: 'the fresh page' });
  assert.equal(asked().length, 2);
  assert.equal(asked()[1].detail.answer, 'leave');

  step('U: closing the window is asked too: Stay keeps it open');
  await arm();
  const before2 = await origin();
  await app.send('Runtime.evaluate', { expression: 'window.close(), true', returnByValue: true }).catch(() => null);
  await waitFor(() => asked().length === 3, { what: 'the question for the close', timeout: 10000 });
  await sleep(500);
  assert.equal(asked()[2].detail.answer, 'stay');
  assert.ok((await targets()).some((t) => isAppU(t.url)), 'Stay: the window is still open');
  assert.equal(await origin(), before2);

  step('U: quit cleanly (the loader closes app windows without asking)');
  await killLoader(U, 'SIGTERM', 30000);
  assert.ok(!logU().includes('unhandled rejection'));
  await waitFor(() => testVms(homeU).length === 0, { what: 'no VM of run U after quitting', timeout: 15000 });
  step('run U passed');
}

// =============================================================================================== run Y: the launcher's own updates
async function runY() {
  step('run Y: the launcher update card (SPEC 8.10, INV-U1): a card by itself, Later, the menu, What’s new, Skip, a quiet restart, the switch');
  const homeY = path.join(ROOT, 'home-y');
  const menuDirY = path.join(ROOT, 'menu-y');
  const dialogLogY = path.join(ROOT, 'dialogs-y.jsonl');
  fs.mkdirSync(homeY, { recursive: true });
  const logY = (name) => fs.readFileSync(path.join(ROOT, `${name}.log`), 'utf8');
  const clickMenuY = (id) => fs.writeFileSync(path.join(menuDirY, 'click.txt'), id);
  const dialogsY = () => (fs.existsSync(dialogLogY) ? fs.readFileSync(dialogLogY, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const HOSTILE = '<img src=x onerror=alert(1)> raw markup stays text';

  // the stand-in feed: what vmapp.dev/updates/mac-arm64/latest.json would answer
  const feed = {
    version: '0.2.0',
    url: 'http://127.0.0.1:1/D9010-VmApp-Launcher-0.2.0-mac-arm64.zip',
    sha256: 'c'.repeat(64),
    size: 548 * 1024 * 1024,
    name: 'D9010 VmApp 0.2.0',
    notes: 'Notes.',
    changes: ['The launcher can update itself.', HOSTILE],
    pub_date: '2026-10-20T10:00:00Z',
    changelogUrl: 'https://vmapp.dev/docs/changelog',
    pageUrl: 'https://vmapp.dev/download',
  };
  let status = 200;
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? JSON.stringify(feed) : 'server trouble');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feedUrl = `http://127.0.0.1:${server.address().port}/updates/mac-arm64/latest.json`;
  const env = { VMAPP_TEST_UPDATE_FEED: feedUrl, VMAPP_TEST_UPDATE_DELAY_MS: '300', VMAPP_TEST_MENU_DIR: menuDirY, VMAPP_TEST_DIALOGS: JSON.stringify({ external: true }), VMAPP_TEST_DIALOG_LOG: dialogLogY };
  const cardY = '[data-role="update-card"]';
  const phaseY = (c) => c.eval(`(document.querySelector('[data-role="update-card"]') || {dataset:{}}).dataset.phase || null`);
  const cardText = (c) => text(c, cardY);
  try {
    step('Y: the card appears by itself after start-up: version, what changed (as text), a Download button because this build cannot update itself');
    let Y = startLoader({ home: homeY, name: 'loader-Y1', env });
    let lib = await waitTarget(isLibrary, 'library (Y)');
    await waitFor(async () => (await phaseY(lib)) === 'available', { what: 'the update card', timeout: 20000 });
    const t = await cardText(lib);
    assert.match(t, /Launcher 0\.2\.0 is available/);
    const RUNNING = JSON.parse(fs.readFileSync(path.join(LOADER, 'package.json'), 'utf8')).version; // the version of the launcher under test
    assert.ok(t.includes(`You have ${RUNNING}.`), `the card says which version is running (${RUNNING})`);
    assert.match(t, /Released October 20, 2026|Released 20 October 2026|Released .*2026/);
    assert.match(t, /about 548 MB/);
    assert.match(t, /The launcher can update itself\./);
    assert.ok(t.includes(HOSTILE), 'markup from the feed is shown as text');
    assert.equal(await lib.eval(`document.querySelectorAll('[data-role="update-card"] img').length`), 0, 'and no element came from it');
    assert.equal(await exists(lib, '[data-action="update-install"]'), false, 'a development build has no "Update now"');
    assert.equal(await exists(lib, '[data-action="update-download"]'), true);
    assert.match(t, /cannot update itself/);
    assert.equal(hits.length, 1, 'exactly one request, from the start-up check');
    assert.equal(hits[0].url, '/updates/mac-arm64/latest.json', 'no query: not even the version is sent');
    for (const h of ['user-agent', 'cookie', 'authorization', 'referer']) assert.equal(hits[0].headers[h], undefined, `no ${h}`);
    await shot2x(lib, 'update-card');

    step('Y: Later closes the card; "Check for Updates…" in the launcher’s menu asks again and shows it');
    await click(lib, '[data-action="update-later"]');
    await waitFor(async () => (await phaseY(lib)) === null, { what: 'the card gone' });
    await waitFor(() => fs.existsSync(path.join(menuDirY, 'menu.json')), { what: 'the menu probe' });
    const firstMenu = JSON.parse(fs.readFileSync(path.join(menuDirY, 'menu.json'), 'utf8'))[0].items;
    assert.deepEqual(firstMenu.filter((i) => i.id || i.role).map((i) => i.id || i.role).slice(0, 3), ['about', 'app-check-updates', 'hide']);
    assert.equal(firstMenu.find((i) => i.id === 'app-check-updates').label, 'Check for Updates…');
    clickMenuY('app-check-updates');
    await waitFor(async () => (await phaseY(lib)) === 'available', { what: 'the card back after the menu check', timeout: 15000 });
    assert.equal(hits.length, 2);

    step('Y: What’s new asks before opening anything, and only the vmapp.dev changelog page is offered');
    await click(lib, '[data-action="update-changelog"]');
    await waitFor(() => dialogsY().some((d) => d.kind === 'open-page'), { what: 'the open-page question' });
    const op = dialogsY().find((d) => d.kind === 'open-page');
    assert.equal(op.detail.url, 'https://vmapp.dev/docs/changelog');
    assert.match(op.detail.message, /^Open https:\/\/vmapp\.dev\/docs\/changelog in your browser\?$/);
    await click(lib, '[data-action="update-download"]');
    await waitFor(() => dialogsY().filter((d) => d.kind === 'open-page').length === 2, { what: 'the second question' });
    assert.equal(dialogsY().filter((d) => d.kind === 'open-page')[1].detail.url, 'https://vmapp.dev/download');
    assert.ok(!logY('loader-Y1').includes('openExternal https://evil'), 'nothing else was opened');

    step('Y: Skip this version hides it and is remembered; a restart then asks nothing and shows nothing');
    await click(lib, '[data-action="update-skip"]');
    await waitFor(async () => (await phaseY(lib)) === null, { what: 'the card gone after Skip' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(homeY, 'launcher-update.json'), 'utf8')).skipped, '0.2.0');
    await killLoader(Y, 'SIGTERM', 30000);
    const hitsBefore = hits.length;
    Y = startLoader({ home: homeY, name: 'loader-Y2', env });
    lib = await waitTarget(isLibrary, 'library (Y, second run)');
    await sleep(2500);
    assert.equal(hits.length, hitsBefore + 1, 'every launch asks, even minutes after the last check');
    assert.equal(await phaseY(lib), null, 'but the skipped version shows nothing');
    clickMenuY('app-check-updates'); // (a new menu probe dir state: the probe re-creates it)
    await waitFor(async () => (await phaseY(lib)) === 'available', { what: 'a manual check shows a skipped version anyway', timeout: 15000 });
    await click(lib, '[data-action="update-later"]');

    step('Y: "up to date" is said only when you ask; a broken update server is explained; nothing crashes');
    feed.version = RUNNING;
    clickMenuY('app-check-updates');
    await waitFor(async () => (await phaseY(lib)) === 'uptodate', { what: 'the up-to-date card', timeout: 15000 });
    assert.ok((await cardText(lib)).includes(`You have the newest launcher (${RUNNING}).`));
    await click(lib, '[data-action="update-dismiss"]');
    await waitFor(async () => (await phaseY(lib)) === null, { what: 'the card gone' });
    status = 500;
    clickMenuY('app-check-updates');
    await waitFor(async () => (await phaseY(lib)) === 'error', { what: 'the error card', timeout: 15000 });
    assert.match(await cardText(lib), /could not check or update[\s\S]*HTTP 500/);
    await click(lib, '[data-action="update-dismiss"]');
    status = 200;
    feed.version = '0.2.0';

    step('Y: the switch in the Host Capabilities window: on by default; off means no check by itself, but the menu still works');
    await click(lib, '[data-action="open-settings"]');
    const isSettingsY = (u) => u.startsWith('vmapp-loader://ui/settings.html');
    const set = await waitTarget(isSettingsY, 'settings window (Y)');
    await waitSel(set, '[data-role="pref-check-updates"]', 'the launcher updates switch');
    assert.equal(await set.eval(`document.querySelector('[data-role="pref-check-updates"]').checked`), true, 'on by default');
    assert.match(await text(set, '[data-role="updates-panel"]'), /sends nothing about you: no identifier, no list of your apps, not even the version you run/);
    await shot2x(set, 'update-setting');
    await click(set, '[data-role="pref-check-updates"]');
    await waitFor(() => fs.existsSync(path.join(homeY, 'loader-prefs.json')) && JSON.parse(fs.readFileSync(path.join(homeY, 'loader-prefs.json'), 'utf8')).checkForUpdates === false, { what: 'the switch saved as off' });
    await killLoader(Y, 'SIGTERM', 30000);
    fs.rmSync(path.join(homeY, 'launcher-update.json'), { force: true }); // forget "skipped" and "last checked": only the switch can keep it quiet now
    const hitsOff = hits.length;
    Y = startLoader({ home: homeY, name: 'loader-Y3', env });
    lib = await waitTarget(isLibrary, 'library (Y, switch off)');
    await sleep(2500);
    assert.equal(hits.length, hitsOff, 'switch off: nothing was asked at start-up');
    assert.equal(await phaseY(lib), null);
    clickMenuY('app-check-updates');
    await waitFor(async () => (await phaseY(lib)) === 'available', { what: 'the menu check still works', timeout: 15000 });
    assert.equal(hits.length, hitsOff + 1);

    step('Y: a copy that macOS runs from a read-only place (opened from Downloads) says so instead of failing at "Update now", and offers Move to Applications');
    await killLoader(Y, 'SIGTERM', 30000);
    const moveLogY = path.join(ROOT, 'move-y.log');
    fs.rmSync(moveLogY, { force: true });
    Y = startLoader({ home: homeY, name: 'loader-Y4', env: { ...env, VMAPP_TEST_INSTALL_BLOCK: 'translocated', VMAPP_TEST_MOVE_LOG: moveLogY } });
    lib = await waitTarget(isLibrary, 'library (Y, translocated)');
    clickMenuY('app-check-updates');
    await waitFor(async () => (await phaseY(lib)) === 'available', { what: 'the update card (translocated)', timeout: 15000 });
    assert.match(await text(lib, '[data-role="update-block"]'), /temporary, read-only place.*opened straight from Downloads.*Move it to your Applications folder/);
    assert.equal(await exists(lib, '[data-action="update-install"]'), false, 'no "Update now" that is bound to fail');
    assert.equal(await text(lib, '[data-action="update-move"]'), 'Move to Applications');
    assert.equal(await exists(lib, '[data-action="update-download"]'), true, 'Download is still offered');
    await shot2x(lib, 'update-translocated');
    await click(lib, '[data-action="update-move"]');
    await waitFor(() => fs.existsSync(moveLogY) && fs.readFileSync(moveLogY, 'utf8') === 'move\n', { what: 'the move was asked for (the test records it instead of doing it)' });
    assert.equal(logY('loader-Y4').includes('moving the launcher to the Applications folder'), true, 'and it is logged');

    step('Y: quit cleanly');
    await killLoader(Y, 'SIGTERM', 30000);
    for (const n of ['loader-Y1', 'loader-Y2', 'loader-Y3', 'loader-Y4']) assert.ok(!logY(n).includes('unhandled rejection'), `${n} had no unhandled rejection`);
  } finally {
    await new Promise((r) => server.close(r));
  }
  step('run Y passed');
}

const cardState2 =(c, id) => c.eval(`(document.querySelector('[data-app="${id}"]') || {dataset:{}}).dataset.state || null`);

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(`\nFAILED: ${e && e.stack ? e.stack : e}`);
  try {
    const ts = await targets();
    console.error('open targets:', ts.map((t) => t.url).join(', '));
  } catch {
    /* loader not running */
  }
} finally {
  dropConns();
  for (const c of spawned) {
    try {
      if (c.exitCode === null && !c.signalCode) c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}
process.exit(failed ? 1 : 0);
