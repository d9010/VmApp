// Code - OSS in the REAL loader, driven over the Chrome DevTools Protocol: VS Code's own web workbench in the sandboxed renderer (CSP
// script-src 'self' with the window features the app declares: workers, wasm, self-fetch, frames; no network), talking to the VS Code
// Server in a real VM over the app's WebSocket and HTTP bridges.
//
//   node tests/apps/vscode-ui.mjs
//
// What it does, with screenshots in $VMAPP_WORK/shots/vscode-*.png:
//   1. installs the package (apps/vscode, built by build.sh and packed here) into a private VMAPP_HOME, shares a folder as "workspace"
//   2. starts the loader from source (electron . --inspector --remote-debugging-port=$CDP_PORT, default 9331), launches the app from
//      its card and measures the start: the window, the workbench, the explorer listing the shared folder
//   3. opens src/main.ts: TextMate highlighting (VS Code's Oniguruma WebAssembly, tokenized in web workers), then a type error typed into the editor
//      gets TypeScript's red squiggle (tsserver in the extension host in the VM); saving writes the file on the Mac
//   4. the integrated terminal runs a command in the VM (its effect appears in the shared folder on the Mac), search finds text, the
//      Source Control view shows the repository the terminal made
//   5. a file created on the Mac appears in the explorer (the server polls the shared folder)
//   6. a color theme is chosen (the theme comes from a built-in extension through the bridge) and stays after a restart
//   7. Help: View License opens a link only through the platform (the dialog log shows the platform's question)
//   8. Markdown: Open Preview: the webview renders the README in an isolated frame (vmapp-frame://, its own origin and service worker),
//      which has no window.vmapp and cannot reach the page
//   9. Open Folder from Your Mac…: the platform's folder dialog (answered by the test hook), the window opens that folder
//      9a. Explorer Download... (step 18): the platform's save dialog (test hook), the file on the Mac with the same bytes; a folder as a .tar
//      9b. New Window (step 18): a second app window with its own workbench on the same server; closing it keeps the app running
//  10. the console: no CSP violation, no unexpected error; the Inspector shows only the app's channels and no network connection
//  11. stop the app, launch it again: the shared folder, the theme and the open editor come back; the start is measured again
// Needs: out/ built (tools/build.sh), out/runtimes/node22.img, apps/vscode built by build.sh, loader/node_modules (npm ci in loader/).
// It opens real windows. Everything it creates is under $VMAPP_WORK/vscode-ui/.
//   CDP_PORT=9331  VMAPP_WORK=<absolute dir>  VSCODE_UI_KEEP=1 (leave the loader running at the end)
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const VMAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOADER = path.join(VMAPP, 'loader');
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(VMAPP, 'out', 'work'));
const ROOT = path.join(WORK, 'vscode-ui');
const SHOTS = path.join(WORK, 'shots');
const PORT = Number(process.env.CDP_PORT) || 9331;
const ID = 'dev.vmapp.vscode';
const APP = path.join(VMAPP, 'apps', 'vscode');
const CLI = path.join(VMAPP, 'tools', 'vmapp');
const electronBin = require(path.join(LOADER, 'node_modules', 'electron'));
const FAKE_HOSTCTL = path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-hostctl.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
let checks = 0;
const ok = (m) => console.log(`  ok ${++checks}: ${m}`);

async function waitFor(fn, { timeout = 30000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------------------------------------ CDP (as tests/apps/ollama-desktop-ui.mjs)
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** Evaluates in a target attached to this one (Target.setAutoAttach with flatten: a frame of another origin, a worker). */
  async evalIn(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`exception in ${sessionId}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value : r.exceptionDetails.text}`);
    return r.result.value;
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value : r.exceptionDetails.text}`);
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `vscode-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    step(`screenshot ${f}`);
    return f;
  }
  async insertText(text) {
    await this.send('Input.insertText', { text });
  }
  async click(x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
  }
  // modifiers: 1 Alt, 2 Ctrl, 4 Meta (Cmd), 8 Shift. The modifier keys themselves go down first and come up last, as on a keyboard:
  // VS Code tracks them (window.confirmBeforeClose "keyboardOnly" vetoes a page unload while it believes Cmd is held)
  async key(key, code, vk, modifiers = 0, text) {
    const MODS = [[1, 'Alt', 'AltLeft', 18], [2, 'Control', 'ControlLeft', 17], [4, 'Meta', 'MetaLeft', 91], [8, 'Shift', 'ShiftLeft', 16]].filter(([bit]) => modifiers & bit);
    let held = 0;
    for (const [bit, k, c, v] of MODS) {
      held |= bit;
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: c, windowsVirtualKeyCode: v, nativeVirtualKeyCode: v, modifiers: held });
    }
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    for (const [bit, k, c, v] of MODS.reverse()) {
      held &= ~bit;
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: c, windowsVirtualKeyCode: v, nativeVirtualKeyCode: v, modifiers: held });
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter((t) => t.type === 'page');
}
async function waitTarget(match, what, timeout = 60000) {
  const t = await waitFor(async () => (await targets()).find((x) => match(x.url)), { timeout, what });
  return { target: t, cdp: await Cdp.connect(t.webSocketDebuggerUrl) };
}
const isLibrary = (u) => u.startsWith('vmapp-loader://ui/library.html');
const isInspector = (u) => u.startsWith('vmapp-loader://ui/inspector.html');
const isApp = (u) => u.startsWith(`vmapp-ui://${ID}/`);

// ------------------------------------------------------------------------------------------------ processes
const spawned = [];
function startLoader(home, name, env) {
  const e = Object.assign({}, process.env, { VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_HOSTCTL]), VMAPP_HOSTCTL_DRYRUN: '1' }, env, { VMAPP_HOME: home });
  delete e.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(ROOT, `${name}.log`), 'w');
  const child = spawn(electronBin, ['.', '--inspector', `--remote-debugging-port=${PORT}`], { cwd: LOADER, env: e, stdio: ['ignore', log, log] });
  spawned.push(child);
  child.exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  return child;
}
async function killLoader(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, sleep(25000)]);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}
function cli(home, ...args) {
  const r = spawnSync(CLI, args, { env: { ...process.env, VMAPP_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, `vmapp ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ------------------------------------------------------------------------------------------------ workbench helpers
const q = (s) => JSON.stringify(s);
const visible = (c, selector) => c.eval(`(() => { const e = document.querySelector(${q(selector)}); return !!(e && e.offsetParent !== null); })()`);
const explorerRows = (c) => c.eval(`[...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].map((r) => r.textContent.trim())`);
const enter = (c) => c.key('Enter', 'Enter', 13, 0, '\r');
const escape = (c) => c.key('Escape', 'Escape', 27);

/** F1, type the command, pick the row whose label matches, Enter. */
async function command(c, text, labelRe = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')) {
  // a key typed while a frame (a webview) has the focus goes to the frame, not to the workbench
  await c.eval(`(() => { const a = document.activeElement; if (a && a.tagName === 'IFRAME') a.blur(); return true; })()`);
  // (F1 again if the palette does not come: a key sent while the workbench is busy, e.g. just after an extension installed, can be lost)
  let tries = 0;
  await waitFor(async () => {
    if (tries++ && (await visible(c, '.quick-input-widget .quick-input-box input'))) return true;
    await c.key('F1', 'F1', 112);
    return waitFor(() => visible(c, '.quick-input-widget .quick-input-box input'), { timeout: 5000, what: 'the command palette' }).catch(() => false);
  }, { timeout: 30000, interval: 200, what: 'the command palette' });
  await c.insertText(text);
  await waitFor(() => c.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => new RegExp(${q(labelRe.source)}, ${q(labelRe.flags)}).test(r.getAttribute('aria-label') || r.textContent))`), { what: `the command "${text}"` });
  await sleep(200);
  await c.eval(`(() => { const r = [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find((r) => new RegExp(${q(labelRe.source)}, ${q(labelRe.flags)}).test(r.getAttribute('aria-label') || r.textContent)); r.click(); return true; })()`);
}

/** A real click on the editor tab whose label contains `name`. */
async function clickTab(c, name) {
  const at = await c.eval(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find((x) => x.textContent.includes(${q(name)})); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  assert.ok(at, `a tab ${name}`);
  await c.click(at.x, at.y);
  await waitFor(() => c.eval(`!!document.querySelector('.tabs-container .tab.active') && document.querySelector('.tabs-container .tab.active').textContent.includes(${q(name)})`), { what: `the ${name} tab` });
}

/** Quick Open (Cmd+P) a file by name. */
async function openFile(c, name) {
  await c.key('p', 'KeyP', 80, 4);
  await waitFor(() => visible(c, '.quick-input-widget .quick-input-box input'), { what: 'quick open' });
  await c.insertText(name);
  await waitFor(() => c.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').startsWith(${q(name)}))`), { timeout: 30000, what: `${name} in quick open` });
  await enter(c);
  await waitFor(() => c.eval(`!!document.querySelector('.tabs-container .tab.active') && document.querySelector('.tabs-container .tab.active').textContent.includes(${q(name)})`), { timeout: 30000, what: `${name} to open in an editor` });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const f of ['vmapp-vm', 'Image', 'initramfs.cpio']) assert.ok(fs.existsSync(path.join(VMAPP, 'out', f)), `vmapp/out/${f} is missing (tools/build.sh)`);
  assert.ok(fs.existsSync(path.join(APP, 'core', 'vscode', 'node')) && fs.existsSync(path.join(APP, 'ui', 'index.html')), 'apps/vscode is not built (apps/vscode/build.sh)');
  const results = {};

  // ---- 1. a private home: runtime, package, the shared folder, size ----
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const home = path.join(ROOT, `home-${stamp}`);
  const ws = path.join(ROOT, `workspace-${stamp}`);
  const pickDir = path.join(ROOT, `picked-${stamp}`);
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), '# Hello\n\nA file from the Mac.\n');
  fs.writeFileSync(path.join(ws, 'src', 'main.ts'), 'export function greet(name: string): string {\n  const message = `Hello, ${name}!`;\n  return message;\n}\n');
  fs.mkdirSync(pickDir, { recursive: true });
  fs.writeFileSync(path.join(pickDir, 'picked.txt'), 'a folder picked in the dialog\n');
  // step 18 (9a): where the save dialog's test hook "saves" a download on the Mac
  const dlDir = path.join(ROOT, `downloads-${stamp}`);
  fs.mkdirSync(dlDir, { recursive: true });
  const dlPath = path.join(dlDir, 'downloaded');
  const pkg = path.join(ROOT, 'vscode.vmapp');
  cli(home, 'pack', APP, '-o', pkg);
  cli(home, 'runtime-install', 'node22', path.join(VMAPP, 'out', 'runtimes', 'node22.img'));
  cli(home, 'install', pkg);
  cli(home, 'resources', ID, '--cpus', '2', '--memory', '3072');
  cli(home, 'grant', ID, 'workspace', ws);
  // VSCODE_UI_NET=1: the user allowed the app's network request ("*"), and the run checks the extension marketplaces (needs internet)
  const NET = process.env.VSCODE_UI_NET === '1';
  if (NET) cli(home, 'grant-net', ID, '*');
  // the clipboard (SPEC 8.4): allowed in the NET run, not in the plain one; the test only reads it (never overwrites yours)
  if (NET) cli(home, 'grant-device', ID, 'clipboard');
  // port forwarding (SPEC 8.8): allowed in the NET run only
  if (NET) cli(home, 'grant-device', ID, 'ports');
  const dialogLog = path.join(ROOT, `dialogs-${stamp}.jsonl`);
  const dialogs = () => (fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  step(`installed ${ID} into ${home}; shared folder ${ws}`);

  // ---- 2. the loader, from source; launch from the card ----
  // the Mac menu bar cannot be reached over CDP: the loader's test hook writes it to menuDir/menu.json and clicks menuDir/click.txt
  const menuDir = path.join(ROOT, `menu-${stamp}`);
  const menuBar = () => JSON.parse(fs.readFileSync(path.join(menuDir, 'menu.json'), 'utf8'));
  const L1 = startLoader(home, `loader-${stamp}`, { VMAPP_TEST_DIALOGS: JSON.stringify({ open: [pickDir], save: dlPath, message: 0, external: true, leave: ['leave', 'leave', 'leave', 'leave', 'leave', 'leave'] }), VMAPP_TEST_DIALOG_LOG: dialogLog, VMAPP_TEST_MENU_DIR: menuDir });
  try {
    const { cdp: lib } = await waitTarget(isLibrary, 'the library window');
    await waitFor(() => lib.eval(`!!document.querySelector('[data-app="${ID}"]')`), { what: 'the app card' });
    const issues = [];
    const watch = async (c) => {
      c.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) issues.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
        if (m.method === 'Runtime.exceptionThrown') issues.push(`exception: ${(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text}`.slice(0, 400));
        if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) issues.push(`log ${m.params.entry.level} [${m.params.entry.source}]: ${m.params.entry.text} ${m.params.entry.url || ''}`.slice(0, 400));
      });
      await c.send('Runtime.enable');
      await c.send('Log.enable');
      await c.send('Page.enable');
    };
    const launch = async (label) => {
      const tClick = Date.now();
      await lib.eval(`document.querySelector('[data-app="${ID}"] [data-action="launch"]').click()`);
      const sheet = await waitFor(() => lib.eval(`!!document.querySelector('[data-action="sheet-launch"]')`), { timeout: 4000, what: 'the permission sheet' }).catch(() => false);
      if (sheet) await lib.eval(`document.querySelector('[data-action="sheet-launch"]').click()`);
      const { cdp: page } = await waitTarget(isApp, 'the app window', 120000);
      const tWindow = Date.now();
      await watch(page);
      await waitFor(() => page.eval(`!!document.querySelector('.monaco-workbench')`), { timeout: 120000, what: 'the workbench' });
      const tWorkbench = Date.now();
      await waitFor(async () => (await explorerRows(page)).length > 0, { timeout: 120000, what: 'the explorer to list the shared folder' });
      const tExplorer = Date.now();
      const timing = { windowMs: tWindow - tClick, workbenchMs: tWorkbench - tClick, explorerMs: tExplorer - tClick };
      step(`${label}: window ${timing.windowMs} ms, workbench ${timing.workbenchMs} ms, explorer ${timing.explorerMs} ms after the click`);
      return { page, timing };
    };

    step('launching the app from its card');
    let { page, timing } = await launch('first start');
    results.firstStart = timing;
    const title = await page.eval('document.title');
    assert.match(title, /f-workspace/);
    const rows = await explorerRows(page);
    assert.ok(rows.includes('README.md') && rows.includes('src'), rows.join(', '));
    assert.ok(await page.eval(`document.querySelector('.statusbar').innerText.includes('VM')`), 'the remote indicator says VM');
    ok(`the workbench is up ${timing.explorerMs} ms after the click (window ${timing.windowMs} ms): "${title}", the explorer lists the shared folder (${rows.join(', ')}), the status bar says VM`);
    assert.equal(await page.eval(`!!document.querySelector('.part.auxiliarybar:not(.hidden) .chat-widget')`), false, 'no chat panel');
    await sleep(2000);
    await page.shot('01-workbench');

    // ---- 3. Workspace Trust, then an editor: highlighting and TypeScript ----
    // VS Code opens a folder in Restricted Mode until the user trusts it (as upstream): TypeScript and git do not run before that
    assert.ok(await page.eval(`document.querySelector('.statusbar').innerText.includes('Restricted Mode')`), 'the folder opens in Restricted Mode');
    await command(page, 'Workspaces: Manage Workspace Trust', /Manage Workspace Trust/i);
    await waitFor(() => page.eval(`[...document.querySelectorAll('.workspace-trust-editor .monaco-button')].some((b) => /^Trust/.test(b.textContent.trim()))`), { timeout: 20000, what: 'the Workspace Trust editor' });
    await page.shot('02a-trust');
    await page.eval(`[...document.querySelectorAll('.workspace-trust-editor .monaco-button')].find((b) => /^Trust/.test(b.textContent.trim())).click()`);
    await waitFor(() => page.eval(`!document.querySelector('.statusbar').innerText.includes('Restricted Mode')`), { timeout: 20000, what: 'the folder to be trusted' });
    ok('the folder opened in Restricted Mode and is trusted through VS Code\'s own Workspace Trust editor');
    await page.key('w', 'KeyW', 87, 4); // close the Workspace Trust editor
    await sleep(500);
    await openFile(page, 'main.ts');
    await waitFor(() => page.eval(`[...document.querySelectorAll('.editor-instance .view-lines')].some((v) => v.textContent.includes('greet'))`), { what: 'the editor to show main.ts' });
    const tokenClasses = await waitFor(async () => {
      const n = await page.eval(`new Set([...document.querySelectorAll('.editor-instance .view-lines span span')].map((s) => [...s.classList].find((c) => /^mtk\\d+$/.test(c))).filter(Boolean)).size`);
      return n >= 4 && n;
    }, { timeout: 30000, what: 'TextMate highlighting (several token colours)' });
    // the page's dedicated workers (the editor worker, the TextMate tokenization worker): CDP attaches to the existing ones
    const workers = new Map();
    const frames = new Map(); // the webviews' frames (another origin: their own renderer process), by session
    page.on((m) => {
      if (m.method !== 'Target.attachedToTarget') return;
      if (m.params.targetInfo.type === 'worker') workers.set(m.params.targetInfo.targetId, m.params.targetInfo);
      if (m.params.targetInfo.type === 'iframe') {
        frames.set(m.params.sessionId, m.params.targetInfo);
        // its console and CSP reports join the page's (watch() takes every event of the connection)
        page.send('Runtime.enable', {}, m.params.sessionId).catch(() => {});
        page.send('Log.enable', {}, m.params.sessionId).catch(() => {});
      }
    });
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await waitFor(() => workers.size >= 2, { timeout: 20000, what: 'the web workers (editor, TextMate)' });
    const wasmLoaded = await page.eval(`performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /onig\\.wasm/.test(n))`);
    results.workers = [...workers.values()].map((w) => w.title || w.url);
    ok(`syntax highlighting: main.ts shows ${tokenClasses} different token colours; ${workers.size} web workers run (${results.workers.join(', ')})${wasmLoaded.length ? `, onig.wasm loaded by the page` : ' (onig.wasm is loaded in the tokenization worker)'}`);
    await page.shot('02-editor');
    // a type error after the last line: a real click at the end of the last line, then the keyboard
    const at = await page.eval(`(() => { const lines = [...document.querySelectorAll('.editor-instance .view-lines .view-line')].filter((l) => l.textContent.trim()); const r = lines.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).pop().getBoundingClientRect(); return { x: Math.round(r.left + 200), y: Math.round(r.top + r.height / 2) }; })()`);
    await page.click(at.x, at.y);
    await sleep(300);
    await page.key('End', 'End', 35, 0);
    await enter(page);
    await page.insertText('const answer: number = "forty-two";');
    const tSquiggle = Date.now();
    await waitFor(() => page.eval(`!!document.querySelector('.editor-instance .squiggly-error')`), { timeout: 120000, what: "TypeScript's error squiggle (tsserver in the VM)" });
    results.typescriptMs = Date.now() - tSquiggle;
    ok(`TypeScript (tsserver in the extension host, in the VM) marks the type error ${results.typescriptMs} ms after it was typed`);
    await page.key('s', 'KeyS', 83, 4); // Cmd+S
    await waitFor(() => fs.readFileSync(path.join(ws, 'src', 'main.ts'), 'utf8').includes('forty-two'), { timeout: 15000, what: 'the saved file on the Mac' });
    ok('Save writes the file in the shared folder on the Mac');
    await page.shot('03-typescript');

    // ---- 4. terminal, search, source control ----
    await command(page, 'Terminal: Create New Terminal');
    await waitFor(() => visible(page, '.terminal-wrapper .xterm'), { timeout: 60000, what: 'the terminal' });
    await sleep(2500);
    await page.eval(`document.querySelector('.terminal-wrapper .xterm textarea, .terminal-wrapper .xterm-helper-textarea').focus()`);
    await page.insertText('echo "vmapp-$((40+2)) $(node --version) $(git --version)" > from-terminal.txt && git init -q && git add -A && git -c user.name=T -c user.email=t@example.com commit -qm first');
    await enter(page);
    await waitFor(() => fs.existsSync(path.join(ws, 'from-terminal.txt')) && fs.readFileSync(path.join(ws, 'from-terminal.txt'), 'utf8').includes('vmapp-42'), { timeout: 30000, what: 'the terminal command to write its file on the Mac' });
    const termOut = fs.readFileSync(path.join(ws, 'from-terminal.txt'), 'utf8').trim();
    assert.match(termOut, /vmapp-42 v24\.21\.0 git version 2\.39\.5/);
    ok(`the integrated terminal runs bash in the VM: "${termOut}", written to the shared folder`);
    await waitFor(() => fs.existsSync(path.join(ws, '.git', 'HEAD')), { timeout: 15000, what: 'the repository' });
    await page.shot('04-terminal');
    await page.key('f', 'KeyF', 70, 4 | 8); // Cmd+Shift+F
    await waitFor(() => visible(page, '.search-view .search-widget .monaco-findInput textarea, .search-view .search-widget .monaco-inputbox input, .search-view .search-widget textarea'), { what: 'the search view' });
    await page.insertText('function greet');
    await waitFor(() => page.eval(`[...document.querySelectorAll('.search-view .results .monaco-list-row')].some((r) => r.textContent.includes('main.ts'))`), { timeout: 30000, what: 'search results' });
    ok('search (ripgrep in the VM) finds "function greet" in src/main.ts');
    await page.shot('05-search');
    await page.key('g', 'KeyG', 71, 2 | 8); // Ctrl+Shift+G: Source Control
    await waitFor(() => page.eval(`!!document.querySelector('.scm-view') && /main\\.ts|Changes|first/.test(document.querySelector('.scm-view').innerText)`), { timeout: 30000, what: 'the Source Control view' });
    ok('Source Control shows the repository the terminal created (git in the VM)');
    await page.shot('06-scm');

    // ---- 5. an edit on the Mac ----
    await page.key('e', 'KeyE', 69, 4 | 8); // Cmd+Shift+E: Explorer
    fs.writeFileSync(path.join(ws, 'made-on-the-mac.txt'), 'hello from the Mac\n');
    const tMac = Date.now();
    await waitFor(async () => (await explorerRows(page)).includes('made-on-the-mac.txt'), { timeout: 20000, what: 'the explorer to show a file created on the Mac' });
    results.macEditMs = Date.now() - tMac;
    ok(`a file created on the Mac appears in the explorer after ${results.macEditMs} ms`);

    // ---- 6. a color theme ----
    await command(page, 'Preferences: Color Theme');
    await waitFor(() => page.eval(`document.querySelectorAll('.quick-input-list .monaco-list-row').length > 3`), { what: 'the theme list' });
    await page.insertText('Solarized Dark');
    await waitFor(() => page.eval(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => /Solarized Dark/.test(r.getAttribute('aria-label') || r.textContent))`), { what: 'Solarized Dark in the theme list' });
    await sleep(300);
    await enter(page);
    await waitFor(() => page.eval(`document.querySelector('.monaco-workbench').classList.contains('vs-dark')`), { timeout: 20000, what: 'the dark theme' });
    ok('a color theme from a built-in extension (Solarized Dark) applies (its JSON came through the bridge)');
    await sleep(1500);
    await page.shot('07-theme');

    // ---- 6a. pictures of an installed extension (activity bar and tab icons): the launcher answers /vscode-remote-resource from the
    // server in the VM, like any file the app's server serves, so <img>, a CSS mask, a background set through the CSSOM and an inline
    // style load it by URL (older launchers: vmapp-fetch.js swaps in data: URLs; both are accepted). A picture of a built-in extension
    // asked for the way the workbench asks for an installed one (a vscode-remote-resource URL) stands in for it, and is a PNG of known size.
    const media = await page.eval(`(async () => {
      const cfg = JSON.parse(document.getElementById('vscode-workbench-web-configuration').dataset.settings);
      const url = location.origin + '/vscode-remote-resource?path=' + encodeURIComponent('/app/vscode/extensions/git/resources/icons/git.png') + '&tkn=' + encodeURIComponent(cfg.connectionToken);
      const style = document.createElement('style');
      document.head.appendChild(style);
      style.sheet.insertRule('.vmapp-media-test { mask: url("' + url + '") no-repeat 50% 50%; -webkit-mask: url("' + url + '") no-repeat 50% 50%; }', 0);
      const img = document.createElement('img');
      img.src = url;
      document.body.appendChild(img);
      // the way the editor title's "Claude Code: Open" button gets its icon: an inline style set through the CSSOM
      const probe = document.createElement('div');
      probe.style.cssText = 'width:16px;height:16px';
      probe.style.backgroundImage = 'url("' + url + '")';
      document.body.appendChild(probe);
      const loads = (u) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i.naturalWidth); i.onerror = () => resolve(0); i.src = u; });
      const t = Date.now();
      while (Date.now() - t < 20000) {
        if (img.complete && img.naturalWidth > 0) {
          // what the CSS and the inline style ask for must load too: take the URL out of them and load it the way the page does
          const rule = style.sheet.cssRules[0] && style.sheet.cssRules[0].cssText;
          const fromRule = /url\\("?([^")]+)"?\\)/.exec(rule || '');
          const fromStyle = /url\\("?([^")]+)"?\\)/.exec(probe.style.backgroundImage || '');
          const out = { rule: fromRule ? await loads(fromRule[1]) : 0, inline: fromStyle ? await loads(fromStyle[1]) : 0, img: img.naturalWidth, native: !img.src.startsWith('data:') };
          style.remove(); img.remove(); probe.remove();
          return out;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { rule: (style.sheet.cssRules[0] || {}).cssText, img: img.src.slice(0, 120), complete: img.complete, w: img.naturalWidth };
    })()`);
    assert.ok(media && media.img > 0 && media.rule > 0 && media.inline > 0, `pictures of an installed extension load in <img>, CSS and an inline style: ${JSON.stringify(media)}`);
    results.mediaLoader = media;
    ok(`pictures served from the VM (an installed extension's activity bar and tab icons) load in <img>, a CSS mask and an inline style (${media.img}px wide, ${media.native ? 'natively' : 'as data: URLs'})`);

    // ---- 7. a link ----
    await command(page, 'Help: View License', /View License/i);
    const linkAsked = await waitFor(async () => {
      if (await page.eval(`!!document.querySelector('.monaco-dialog-box')`)) {
        await page.eval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((x) => /^Open$/.test(x.textContent.trim())); if (b) b.click(); return true; })()`);
      }
      return dialogs().find((d) => d.kind === 'openExternal' && /^https:\/\/github\.com\/microsoft\/vscode\//.test(String(d.detail)));
    }, { timeout: 30000, what: 'the platform to be asked to open the licence link' });
    ok(`Help: View License reaches the platform's own question about the link: ${linkAsked.detail}`);

    // ---- 8. a webview: Markdown preview in an isolated frame ----
    await openFile(page, 'README.md');
    const lineAt = await waitFor(() => page.eval(`(() => { const l = document.querySelector('.editor-instance .monaco-editor[data-uri$="README.md"] .view-lines .view-line'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`), { what: 'the README editor' });
    await page.click(lineAt.x, lineAt.y); // the palette offers Markdown's commands for the focused Markdown editor
    await sleep(300);
    await command(page, 'Markdown: Open Preview', /^Markdown: Open Preview(?! to the Side)/i);
    const frameSrc = await waitFor(() => page.eval(`(() => { const f = [...document.querySelectorAll('iframe.webview')].find((x) => x.src.startsWith('vmapp-frame://')); return f && f.src; })()`), { timeout: 30000, what: 'the webview frame' });
    // the webview's host page (VS Code's pre/index.html) renders the content in its own inner frame (#active-frame, the same origin)
    const rendered = await waitFor(async () => {
      for (const sid of frames.keys()) { // the URL known at attach time can still be empty: ask the frame itself
        const text = await page.evalIn(sid, `(() => { if (!location.href.startsWith('vmapp-frame://')) return ''; const f = document.getElementById('active-frame'); const d = f && f.contentDocument; return d && d.body ? d.body.innerText : ''; })()`).catch(() => '');
        if (/Hello/.test(text) && /A file from the Mac/.test(text) && !/Some content has been disabled/.test(text)) return { sid, text };
      }
      return null;
    }, { timeout: 45000, what: 'the Markdown preview to render README.md in the webview' });
    const isolation = await page.evalIn(rendered.sid, `(() => { let parentDoc; try { parentDoc = !!parent.document; } catch { parentDoc = false; } return { vmapp: typeof window.vmapp, parentDoc, origin: location.origin, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller) }; })()`);
    assert.equal(isolation.vmapp, 'undefined', 'the webview frame has no window.vmapp');
    assert.equal(isolation.parentDoc, false, "the webview frame cannot reach the page's document");
    results.webview = { src: frameSrc.split('?')[0], ...isolation };
    ok(`Markdown: Open Preview renders README.md in a webview (${isolation.origin}, an isolated frame: no window.vmapp, no access to the page${isolation.sw ? ", served through VS Code's service worker" : ''})`);
    await page.shot('08-webview');
    await page.key('w', 'KeyW', 87, 4); // close the preview

    // ---- 8a. the clipboard from the page's own code (VS Code's Paste menu item and terminal paste use navigator.clipboard) ----
    // (the clipboard API also needs a focused document; the window is not the key window during a test, so focus is emulated)
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const clipRead = await page.eval(`navigator.clipboard.readText().then((t) => ({ ok: true, type: typeof t }), (e) => ({ ok: false, name: e.name }))`);
    if (NET) assert.deepEqual(clipRead, { ok: true, type: 'string' }, 'allowed: the page reads the clipboard');
    else assert.deepEqual(clipRead, { ok: false, name: 'NotAllowedError' }, 'not allowed: the read is refused');
    ok(NET ? 'the clipboard device is allowed: the page reads the Mac’s clipboard (VS Code’s Paste and terminal paste work)' : 'the clipboard device is not allowed: navigator.clipboard.readText() is refused (keyboard copy and paste still work)');

    // ---- 8b. (VSCODE_UI_NET) the extension marketplaces: Open VSX by default, the Visual Studio Marketplace by a command ----
    if (NET) {
      const extView = async () => {
        if (!(await visible(page, '.extensions-viewlet'))) await page.key('x', 'KeyX', 88, 4 | 8); // Cmd+Shift+X
        await waitFor(() => visible(page, '.extensions-viewlet .suggest-input-container'), { what: 'the Extensions view' });
      };
      const search = async (text, rowRe, what) => {
        await extView();
        // the search box is a small Monaco editor: a real click gives it the focus
        const box = await page.eval(`(() => { const r = document.querySelector('.extensions-viewlet .suggest-input-container').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        await page.click(box.x, box.y);
        await sleep(200);
        await page.key('a', 'KeyA', 65, 4);
        await page.insertText(text);
        return waitFor(() => page.eval(`[...document.querySelectorAll('.extensions-viewlet .monaco-list-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')).find((t) => new RegExp(${q(rowRe.source)}).test(t)) || null`), { timeout: 60000, what });
      };
      const row = await search('EditorConfig', /EditorConfig Support for Visual/, 'EditorConfig in the Open VSX results');
      ok(`the Extensions view searches the Open VSX Registry (through the VM's network grant): "${row.slice(0, 80)}"`);
      // the icons come into the window itself, through the app's proxy under the same grant (SPEC 8.3 "The app's windows")
      const icons = await waitFor(
        () => page.eval(`(() => { const imgs = [...document.querySelectorAll('.extensions-viewlet .monaco-list-row img.icon')].filter((i) => /^https:/.test(i.src)); const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0); return loaded.length ? { loaded: loaded.length, of: imgs.length } : null; })()`),
        { timeout: 30000, what: 'extension icons from the marketplace, in the window' },
      );
      results.marketplace = { icons };
      ok(`extension icons load in the window through the app's proxy (${icons.loaded} of ${icons.of} on screen)`);
      // installing from Open VSX: the open signature verifier (patch 0008, core/sigverify.js) checks the registry's Ed25519 signature,
      // so the extension installs without the "cannot verify the extension signature" question
      const rowSel = `[...document.querySelectorAll('.extensions-viewlet .monaco-list-row')].find((r) => /EditorConfig Support for Visual/.test(r.innerText))`;
      await page.eval(`${rowSel}.querySelector('.extension-action.install:not(.disabled), .action-label.install')?.click()`);
      const installed = await waitFor(async () => {
        const dlg = await page.eval(`(document.querySelector('.monaco-dialog-box') || {}).innerText || ''`);
        if (/cannot verify|Signature verification/i.test(dlg)) throw new Error(`signature question instead of an install: ${dlg.slice(0, 200)}`);
        // VS Code's own question for a publisher installed from for the first time (not about the signature): the user trusts it
        if (/Do you trust the publisher/i.test(dlg)) await page.eval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((x) => /Trust Publisher/i.test(x.textContent)); if (b) b.click(); return true; })()`);
        return page.eval(`(() => { const r = ${rowSel}; return r && !/Installing/.test(r.innerText) && r.querySelector('.extension-action.manage, .extension-action.uninstall') ? r.innerText.replace(/\\s+/g, ' ').slice(0, 80) : null; })()`);
      }, { timeout: 90000, what: 'EditorConfig to install from Open VSX (signature verified)' });
      await waitFor(async () => !(await page.eval(`!!document.querySelector('.monaco-dialog-box')`)), { timeout: 10000, what: 'the publisher question to close' });
      await sleep(1500); // (the keyboard focus comes back to the workbench after the dialog)
      results.marketplace.installed = installed;
      ok(`EditorConfig installs from Open VSX with its signature verified by open code: no "cannot verify the signature" question (VS Code's own "trust the publisher?" is answered) ("${installed}")`);
      results.marketplace.openVsxRow = row;
      await page.shot('08b-open-vsx');
      // the other marketplace: the window reloads with it (a new document: performance.timeOrigin changes)
      const reloaded = async (before, what) => {
        await waitFor(async () => {
          const now = await page.eval(`performance.timeOrigin`).catch(() => before);
          return now !== before && (await page.eval(`!!document.querySelector('.monaco-workbench .part.sidebar') && document.readyState === 'complete'`).catch(() => false));
        }, { timeout: 60000, what });
        await sleep(3000);
      };
      let origin0 = await page.eval(`performance.timeOrigin`);
      await command(page, 'Extensions: Use the Visual Studio Marketplace', /Use the Visual Studio Marketplace/);
      await reloaded(origin0, 'the reload with the Visual Studio Marketplace');
      const msRow = await search('Claude Code', /Claude Code for VS Code/, 'Claude Code in the Visual Studio Marketplace results');
      ok(`after "Extensions: Use the Visual Studio Marketplace" the same view searches Microsoft's marketplace: "${msRow.slice(0, 80)}"`);
      await page.shot('08b-vs-marketplace');
      origin0 = await page.eval(`performance.timeOrigin`);
      await command(page, 'Extensions: Use the Open VSX Registry', /Use the Open VSX Registry/);
      await reloaded(origin0, 'the reload with the Open VSX Registry');
      const again = await search('EditorConfig', /EditorConfig Support for Visual/, 'EditorConfig in the Open VSX results again');
      ok(`switched back to the Open VSX Registry ("${again.slice(0, 60)}")`);

      // ---- 8b2. [step 14] a browser-only extension (package.json: `browser`, no `main`) runs in VS Code's web worker extension host, in
      // an isolated frame vmapp-frame://v--<hash>.exthost/ (patches 0004 and 0006, shim/exthost/). hadesarchitect.helloworld-web-sample is
      // VS Code's helloworld-web-sample (MIT): its command "Hello World" shows "Hello World from helloworld-web-sample in a web extension
      // host!". From Open VSX it is installed in the browser and its code comes from the registry through the window's network grant.
      const WEB_EXT = 'hadesarchitect.helloworld-web-sample';
      await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); // (after the reload)
      const webRowRe = /helloworld-web-sample/;
      await search(`@id:${WEB_EXT}`, webRowRe, `${WEB_EXT} in the Open VSX results`);
      const webRowSel = `[...document.querySelectorAll('.extensions-viewlet .monaco-list-row')].find((r) => /helloworld-web-sample/.test(r.innerText))`;
      await page.eval(`${webRowSel}.querySelector('.extension-action.install:not(.disabled), .action-label.install')?.click()`);
      await waitFor(async () => {
        // an unverified publisher: VS Code asks whether to trust it (the test answers yes); no other question is expected
        await page.eval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((x) => /Trust Publisher/i.test(x.textContent)); if (b) b.click(); return true; })()`);
        return page.eval(`(() => { const r = ${webRowSel}; return !!(r && !/Installing/.test(r.innerText) && r.querySelector('.extension-action.manage, .extension-action.uninstall')); })()`);
      }, { timeout: 90000, what: `${WEB_EXT} to install` });
      const webExtState = async () => ({
        row: await page.eval(`((${webRowSel}) || {}).innerText || ''`).catch(() => '?'),
        hostFrame: await page.eval(`(document.querySelector('iframe.web-worker-ext-host-iframe') || {}).src || null`).catch(() => '?'),
        frames: [...frames.values()].map((f) => f.url),
        console: issues.slice(-25),
      });
      try {
        await command(page, 'Hello World', /^Hello World\b/);
      } catch (e) {
        step(`8b2 state: ${JSON.stringify(await webExtState(), null, 2)}`);
        throw e;
      }
      const hello = await waitFor(() => page.eval(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notification-toast .notification-list-item-message')].map((e) => e.textContent).find((t) => /Hello World from helloworld-web-sample in a web extension host/.test(t)) || null`), { timeout: 60000, what: 'the browser-only extension to activate and show its message' });
      const hostSrc = await page.eval(`(document.querySelector('iframe.web-worker-ext-host-iframe') || {}).src || ''`);
      assert.match(hostSrc, /^vmapp-frame:\/\/v--[0-9a-v]{52}\.exthost\/vmapp-exthost\/out\/vs\/workbench\/services\/extensions\/worker\/webWorkerExtensionHostIframe\.html\?/, 'the web worker extension host is in its isolated frame');
      const hostFrame = await waitFor(async () => {
        for (const sid of frames.keys()) {
          const r = await page.evalIn(sid, `(() => { let parentDoc; try { parentDoc = !!parent.document; } catch { parentDoc = false; } return { origin: location.origin, vmapp: typeof window.vmapp, parentDoc }; })()`).catch(() => null);
          if (r && /^vmapp-frame:\/\/v--[0-9a-v]{52}\.exthost$/.test(r.origin)) return r;
        }
        return null;
      }, { timeout: 20000, what: 'the extension host frame (CDP)' });
      assert.equal(hostFrame.vmapp, 'undefined', 'the extension host frame has no window.vmapp');
      assert.equal(hostFrame.parentDoc, false, "the extension host frame cannot reach the page's document");
      results.webExtension = { id: WEB_EXT, message: hello, frame: hostFrame.origin };
      ok(`a browser-only extension from Open VSX (${WEB_EXT}) runs in the web worker extension host, in an isolated frame (${hostFrame.origin}: no window.vmapp, no access to the page): "${hello}"`);
      await page.shot('08b2-web-extension');
      await page.key('e', 'KeyE', 69, 4 | 8); // back to the Explorer
    }

    // ---- 8c. VS Code's menu bar in the Mac menu bar (patch 0005 + SPEC 7 "Menus"): its menus, shortcuts and edit roles; a click ----
    const flat = (list) => list.flatMap((i) => [i, ...(i.items ? flat(i.items) : [])]);
    const tops = () => menuBar().map((m) => m.label);
    await waitFor(() => { try { return ['File', 'Edit', 'Selection', 'View', 'Go', 'Terminal', 'Help'].every((t) => tops().includes(t)); } catch { return false; } }, { timeout: 30000, what: "VS Code's menus in the Mac menu bar" });
    const bar = menuBar();
    const viewMenu = flat(bar.find((m) => m.label === 'View').items);
    const palette = viewMenu.find((i) => /^Command Palette/.test(i.label || ''));
    assert.ok(palette && /^app:m\d+$/.test(palette.id), `View → Command Palette… (${JSON.stringify(palette)})`);
    assert.match(palette.accelerator || '', /^(?=.*(Cmd|Command))(?=.*Shift).*\+P$/i, 'with its ⌘⇧P shortcut');
    const editRoles = flat(bar.find((m) => m.label === 'Edit').items).map((i) => i.role).filter(Boolean);
    assert.ok(['cut', 'copy', 'paste'].every((r) => editRoles.includes(r)), `Edit keeps the native cut, copy and paste (${editRoles.join(', ')})`);
    assert.equal(bar[0].label, 'D9010 VmApp Launcher', "the loader's first menu stays");
    assert.equal(bar[bar.length - 1].label, 'Window', "the loader's Window menu stays");
    const nItems = flat(bar.slice(1, -1).flatMap((m) => m.items)).filter((i) => i.id).length;
    fs.writeFileSync(path.join(menuDir, 'click.txt'), palette.id);
    await waitFor(() => visible(page, '.quick-input-widget .quick-input-box input'), { what: 'the command palette, opened from the Mac menu bar' });
    await escape(page);
    results.menuBar = { tops: tops(), items: nItems, palette: palette.accelerator };
    ok(`VS Code's menu bar is in the Mac menu bar (${tops().slice(1, -1).join(', ')}; ${nItems} items with their shortcuts, e.g. Command Palette… ${palette.accelerator}); clicking View → Command Palette… opens it`);

    // ---- 8d. a server started in the terminal, on this Mac's localhost (SPEC 8.8; VS Code's port detection + the page's tunnelProvider) ----
    const DEV_PORT = 47213;
    const fromMac = () => fetch(`http://127.0.0.1:${DEV_PORT}/`).then((r) => r.text(), () => null);
    await command(page, 'Terminal: Create New Terminal');
    // (the terminal of step 4 still exists, hidden behind the new one: look for a visible one)
    const shownTerm = `[...document.querySelectorAll('.terminal-wrapper .xterm')].find((e) => e.offsetParent !== null)`;
    await waitFor(() => page.eval(`!!${shownTerm}`), { timeout: 60000, what: 'a terminal' });
    await sleep(2500);
    await page.eval(`${shownTerm}.querySelector('textarea, .xterm-helper-textarea').focus()`);
    await page.insertText(`node -e "require('http').createServer((q, r) => r.end('served by the VM')).listen(${DEV_PORT}, '127.0.0.1')" &`);
    await enter(page);
    if (NET) {
      const body = await waitFor(() => fromMac(), { timeout: 45000, what: `VS Code to forward port ${DEV_PORT} (auto-detected) to this Mac` });
      assert.equal(body, 'served by the VM');
      results.portForward = { port: DEV_PORT, body };
      ok(`a server started in VS Code's terminal (port ${DEV_PORT} in the VM) is forwarded by VS Code's own port detection and answers on this Mac's localhost`);
    } else {
      await sleep(10000);
      assert.equal(await fromMac(), null, 'without the user’s allow, nothing answers on the Mac');
      ok(`without the device "ports" allowed, the server in the VM is not opened on this Mac`);
    }

    // ---- 9. Open Folder from Your Mac ----
    await command(page, 'Open Folder from Your Mac');
    await waitFor(() => dialogs().some((d) => d.kind === 'open'), { timeout: 20000, what: 'the platform folder dialog' });
    await waitFor(async () => (await explorerRows(page).catch(() => [])).includes('picked.txt'), { timeout: 60000, what: 'the window to open the picked folder' }).catch(async (e) => {
      const href = await page.eval('location.href').catch(() => '?');
      throw new Error(`${e.message}; the page is at ${href}; its last console lines:\n    ${issues.slice(-12).join('\n    ')}`);
    });
    const pickedTitle = await page.eval('document.title');
    ok(`Open Folder from Your Mac…: the platform's dialog, then the window opens that folder (${pickedTitle})`);
    await page.shot('09-picked-folder');

    // ==== step 18 (DEV-APPS §11): 9a. Download to the Mac, 9b. New Window ====
    // 9a. the Explorer's Download… (shim createDownloadCommand → core/download.js): the platform's save dialog (answered by the test
    // hook with dlPath), the file appears on the Mac with the same bytes; a folder arrives as one .tar
    {
      const rowAt = (name) => page.eval(`(() => { const r = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((x) => x.textContent.trim() === ${q(name)}); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.left + Math.min(60, b.width / 2)), y: Math.round(b.top + b.height / 2) }; })()`);
      // VS Code's context menu is drawn by the page, partly in a shadow root
      const menuItemAt = (label) => page.eval(`(() => { const roots = [document, ...[...document.querySelectorAll('*')].filter((e) => e.shadowRoot).map((e) => e.shadowRoot)]; for (const r of roots) { const it = [...r.querySelectorAll('.monaco-menu .action-menu-item')].find((a) => (a.querySelector('.action-label') || a).textContent.trim() === ${q(label)}); if (it) { const b = it.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; } } return null; })()`);
      const rightClick = async (x, y) => {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
      };
      const downloadVia = async (name) => {
        const at = await waitFor(() => rowAt(name), { timeout: 20000, what: `${name} in the explorer` });
        await page.click(at.x, at.y);
        await rightClick(at.x, at.y);
        const item = await waitFor(() => menuItemAt('Download...'), { timeout: 10000, what: `"Download..." in the context menu of ${name}` }).catch(() => null);
        if (!item) {
          await escape(page);
          return false;
        }
        await page.click(item.x, item.y);
        return true;
      };
      const saves0 = dialogs().filter((d) => d.kind === 'save').length;
      // The context menu is drawn by the page and moves while it opens; a click that lands on it too early hits nothing (no call reaches the core). A person
      // clicks again; so does the test, up to three times, and records how many it took.
      const askDownload = async (name, saves, what) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          assert.ok(await downloadVia(name), `the Explorer offers Download... for ${name}`);
          const asked = await waitFor(() => dialogs().filter((d) => d.kind === 'save').length > saves, { timeout: 8000, what }).then(() => true, () => false);
          if (asked) return attempt;
          await escape(page);
          await sleep(500);
        }
        throw new Error(`${what}: not shown after 3 clicks on Download... of ${name}`);
      };
      const attempts = [await askDownload('picked.txt', saves0, 'the platform save dialog')];
      const want = fs.readFileSync(path.join(pickDir, 'picked.txt'));
      await waitFor(() => fs.existsSync(dlPath) && Buffer.compare(fs.readFileSync(dlPath), want) === 0, { timeout: 30000, what: `the download at ${dlPath} on the Mac` });
      ok(`Download... on picked.txt: the platform's save dialog, then the file is on the Mac with the same ${want.length} bytes (${dlPath})`);
      results.download = { file: want.length, attempts };
      // a folder: offered when the workbench sees the File System Access API (HasWebFileSystemAccess); the core writes a .tar
      fs.mkdirSync(path.join(pickDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(pickDir, 'sub', 'inner.txt'), 'inside a downloaded folder\n');
      await waitFor(async () => (await explorerRows(page)).includes('sub'), { timeout: 30000, what: 'the new folder in the explorer' });
      let folderAsked = null; // null: Download... is not offered on a folder
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!(await downloadVia('sub'))) break;
        folderAsked = await waitFor(() => dialogs().filter((d) => d.kind === 'save').length > saves0 + 1, { timeout: 8000, what: 'the second save dialog' }).then(() => true, () => false);
        if (folderAsked) {
          attempts.push(attempt);
          break;
        }
        await escape(page);
        await sleep(500);
      }
      if (folderAsked !== null) {
        assert.ok(folderAsked, 'the second save dialog (not shown after 3 clicks on Download... of the folder)');
        const tarOk = () => {
          try {
            const b = fs.readFileSync(dlPath);
            return b.length >= 1024 && b.subarray(257, 262).toString() === 'ustar';
          } catch {
            return false;
          }
        };
        await waitFor(tarOk, { timeout: 30000, what: 'the folder as a .tar on the Mac' });
        const list = spawnSync('tar', ['-tf', dlPath], { encoding: 'utf8' });
        assert.equal(list.status, 0, list.stderr);
        const names = list.stdout.trim().split('\n');
        assert.ok(names.includes('sub/') && names.includes('sub/inner.txt'), names.join(', '));
        const inner = spawnSync('tar', ['-xOf', dlPath, 'sub/inner.txt'], { encoding: 'utf8' });
        assert.equal(inner.stdout, 'inside a downloaded folder\n');
        ok(`Download... on a folder: one .tar on the Mac (${names.join(', ')}), its file with the same bytes`);
        results.download.folder = names.length;
      } else {
        step('Download... is not offered on folders in this window (no File System Access API: HasWebFileSystemAccess is false)');
      }
    }

    // 9b. New Window (VS Code's WorkspaceProvider window.open → shim openAppWindow → core vscode:new-window): a second app window with
    // its own workbench and its own connection to the same server; closing it leaves the app and the first window running
    {
      const before = new Set((await targets()).filter((t) => isApp(t.url)).map((t) => t.id));
      const diag0 = await page.eval(`window.vmapp.invoke('vscode:diag')`);
      await command(page, 'New Window', /^New Window/i);
      const t2 = await waitFor(async () => (await targets()).find((t) => isApp(t.url) && !before.has(t.id)), { timeout: 60000, what: 'a second app window' });
      const page2 = await Cdp.connect(t2.webSocketDebuggerUrl);
      await watch(page2);
      await waitFor(() => page2.eval(`!!document.querySelector('.monaco-workbench')`), { timeout: 120000, what: 'the workbench in the second window' });
      await waitFor(() => page2.eval(`document.querySelector('.statusbar') && document.querySelector('.statusbar').innerText.includes('VM')`), { timeout: 60000, what: 'the second window to connect to the server' });
      const href2 = await page2.eval('location.href');
      assert.match(href2, /[?&]ew=true/, `an empty window (${href2})`);
      const diag1 = await waitFor(async () => {
        const d = await page.eval(`window.vmapp.invoke('vscode:diag')`);
        return d.sockets > diag0.sockets && d;
      }, { timeout: 60000, what: 'the second window\'s own sockets in the core' });
      await page2.shot('09b-new-window');
      ok(`New Window opens a second app window (${href2.replace(/^.*\//, '')}) with its own workbench, connected to the same server (sockets ${diag0.sockets} → ${diag1.sockets})`);
      results.newWindow = { href: href2, sockets: [diag0.sockets, diag1.sockets] };
      // the user closes it: the app keeps running, the first window still works
      page2.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${t2.id}`);
      await waitFor(async () => !(await targets()).some((t) => t.id === t2.id), { timeout: 20000, what: 'the second window to close' });
      await sleep(3000);
      assert.notEqual(await lib.eval(`document.querySelector('[data-app="${ID}"]').dataset.state`), 'stopped', 'the app still runs');
      assert.ok((await explorerRows(page)).includes('picked.txt'), 'the first window still works');
      const diag2 = await page.eval(`window.vmapp.invoke('vscode:diag')`);
      ok(`closing the second window leaves the app and the first window running (sockets back to ${diag2.sockets})`);
    }
    // ==== end of step 18 ====

    // ---- 10. console and Inspector ----
    // with the window features the page declares, nothing VS Code does is refused by the window's CSP
    const csp = issues.filter((i) => /Content Security Policy|Refused to (load|execute|compile|create|connect|frame|apply)/i.test(i));
    step(`console: ${issues.length} issue(s)${issues.length ? `:\n    ${[...new Set(issues)].slice(0, 25).join('\n    ')}` : ''}`);
    // With the window feature "network" (SPEC 8.3 "The app's windows") the window's marketplace requests and extension icons go
    // through the app's proxy under the same grant as the VM: no refusal by the CSP, with or without the grant.
    assert.deepEqual(csp, [], 'no CSP violation');
    ok(`no CSP violation in the console (workers, WebAssembly, the page's own files, the webview frames${NET ? ' and the marketplace data through the app’s proxy' : ''} are allowed by the declared features)`);
    // what Code - OSS logs anyway in this setting (PATCHES.md "Not patched"): vsda (the signing library of Microsoft's own build), Chat and
    // voice features asking for a GitHub session (sign-in is not shipped), the webview's sandbox warning (VS Code's own frame has both
    // allow-scripts and allow-same-origin, as upstream), and the reloads of the page this test causes
    // With NET, the window reaches two marketplace endpoints that refuse a browser's origin (as for VS Code for the web: no CORS header on
    // main.vscode-cdn.net's marketplace.json, 403 from Microsoft's gallery query); VS Code then asks its server, which is why the searches work.
    const KNOWN = /vsda|authentication provider 'github'|Canceled|Long running operations during shutdown|local-network-access|Unable to retrieve mac address|An unknown error occurred|allow-scripts and allow-same-origin|main\.vscode-cdn\.net\/extensions\/marketplace\.json|marketplace\.visualstudio\.com\/_apis\/public\/gallery\/extensionquery/;
    const other = [...new Set(issues.filter((i) => !KNOWN.test(i)))];
    step(`console issues not on the known list: ${other.length ? `\n    ${other.slice(0, 20).join('\n    ')}` : 'none'}`);
    results.consoleOther = other;
    const { cdp: insp } = await waitTarget(isInspector, 'the Inspector window');
    await insp.eval(`(() => { const s = document.getElementById('app-select'); s.value = ${q(ID)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(1500);
    const seen = await insp.eval(`[...document.querySelectorAll('#rows tr.row')].map((r) => ({ t: r.dataset.t, dir: r.dataset.dir, chan: (r.querySelector('[data-role="chan"], [data-role="net-target"]') || {}).textContent || '', net: r.classList.contains('net') }))`);
    const kinds = new Map();
    for (const r of seen) {
      const key = `${r.t} ${r.chan}`.trim();
      kinds.set(key, (kinds.get(key) || 0) + 1);
    }
    // the app's channels, the platform requests it makes, window events, and the platform's own record of the folder picked in the dialog
    // (+ the Ports view: VS Code asks its core to forward a port it detected, and the platform's port rows; and `log warn`: the core writes
    // "Error occurred in handler for '<channel>'" when a handler throws, as Electron prints it, e.g. a port forward the user did not allow)
    const EXPECTED = /^((invoke|result|send|emit|request|reply|window|ready|init|log|before-quit) ?(vscode:(config|open-external|pick-folder|diag|set-gallery|forward-port|close-port|new-window|download)|ws:(open|data|ack|close|ev)|fetch:(open|part|ack|abort|ev)|window\.create|window\.close|dialog\.open|dialog\.save|shell\.openExternal|port\.(forward|close|list)|app\.quit|closed|focus|blur|resize|)|log warn|(grant|revoke) (pick|save)-\d+|host clipboard clipboard\.(read|write)|port (forwarding|connection|stopped) VM port \d+ ⇄ localhost:\d+)$/;
    const unexpected = [...kinds.keys()].filter((k) => !EXPECTED.test(k));
    step(`Inspector: ${seen.length} rows: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
    const netRows = seen.filter((r) => r.net);
    // (with NET, the window's marketplace tunnels stay open in the browser's pool: their rows come when they close, checked after
    // the stop below; SPEC 8.3 "Traffic events")
    if (!NET) assert.equal(netRows.length, 0, 'no network connection');
    const unexpectedApp = unexpected.filter((k) => !(NET && netRows.some((r) => `${r.t} ${r.chan}`.trim() === k)));
    assert.deepEqual(unexpectedApp, [], 'only the app\'s own channels and the platform requests it needs');
    results.inspector = Object.fromEntries(kinds);
    ok(`the Inspector shows only the expected messages (vscode:*, ws:*, fetch:*, window.create, dialog.open, shell.openExternal) and ${NET ? `${netRows.length} network connection(s) (${[...new Set(netRows.map((r) => r.chan))].slice(0, 4).join(', ')})` : 'no network connection'}`);
    await insp.shot('10-inspector');

    // memory with the workbench, the extension host and tsserver running
    const diag = await page.eval(`window.vmapp.invoke('vscode:diag')`);
    results.vm = diag.vm;
    results.serverStartMs = diag.serverStartMs;
    ok(`VM: ${diag.vm.memMiB} MiB, ${diag.vm.availableMiB} MiB available with the extension host and tsserver running (the server started ${diag.serverStartMs} ms after the core)`);

    // ---- 11. stop, launch again ----
    await lib.eval(`document.querySelector('[data-app="${ID}"] [data-action="stop"]').click()`);
    await waitFor(() => lib.eval(`document.querySelector('[data-app="${ID}"]').dataset.state === 'stopped'`), { timeout: 60000, what: 'the app to stop' });
    page.close();
    if (NET) {
      // the stop closed every tunnel, the window's included: each is a row now, marked as the window's
      const winRows = await waitFor(async () => {
        const r = await insp.eval(`[...document.querySelectorAll('#rows tr.row.net')].map((tr) => tr.querySelector('[data-role="net-target"]').firstChild.textContent)`);
        const w = r.filter((t) => /^window [a-z0-9.-]+:443$/.test(t));
        return w.length ? { all: r.length, window: [...new Set(w)] } : null;
      }, { timeout: 20000, what: "the window's marketplace connections as Inspector rows" });
      assert.ok(winRows.window.some((t) => /open-vsx\.org|openvsx|vsassets\.io|marketplace\.visualstudio\.com|vscode-cdn\.net/.test(t)), JSON.stringify(winRows));
      results.windowNetRows = winRows;
      ok(`the window's own connections are Inspector rows once closed (${winRows.window.slice(0, 4).join(', ')})`);
    }
    step('stopped; launching again');
    ({ page, timing } = await launch('second start'));
    results.secondStart = timing;
    const rows2 = await explorerRows(page);
    assert.ok(rows2.includes('README.md') && rows2.includes('made-on-the-mac.txt'), rows2.join(', '));
    await waitFor(() => page.eval(`document.querySelector('.monaco-workbench').classList.contains('vs-dark')`), { timeout: 20000, what: 'the theme to be restored' });
    await waitFor(() => page.eval(`[...document.querySelectorAll('.tabs-container .tab')].some((t) => t.textContent.includes('main.ts'))`), { timeout: 30000, what: 'the open editor to be restored' });
    ok(`after a restart (a new VM): the shared folder, the theme and the open editor are back; workbench ready ${timing.explorerMs} ms after the click`);
    await sleep(1500);
    await page.shot('11-restarted');

    fs.writeFileSync(path.join(ROOT, `results-${stamp}.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    console.log(`\nvscode-ui: ${checks} checks passed`);
  } finally {
    if (!process.env.VSCODE_UI_KEEP) await killLoader(L1);
  }
}

main().catch(async (e) => {
  console.error(`FAIL: ${e.stack || e.message}`);
  for (const c of spawned) if (c.exitCode === null && !process.env.VSCODE_UI_KEEP) c.kill('SIGKILL');
  process.exit(1);
});
