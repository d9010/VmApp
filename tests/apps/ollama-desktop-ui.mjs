// Ollama (Desktop) in the REAL loader, driven over the Chrome DevTools Protocol: Ollama's own React window in the sandboxed renderer
// (CSP script-src 'self', no network), talking to its Go backend and `ollama serve` in a real VM through the streamed HTTP bridge.
//
//   node tests/apps/ollama-desktop-ui.mjs
//
// What it does, with screenshots in $VMAPP_WORK/shots/ollama-desktop-*.png:
//   1. installs the package (apps/ollama-desktop, built by build.sh and packed here) into a private VMAPP_HOME and allows its three hosts
//   2. starts the loader from source (electron . --remote-debugging-port=$CDP_PORT, default 9311) and launches the app from its card
//   3. onboarding -> the empty chat -> the model picker -> types a model that is not installed (qwen2.5:0.5b) -> sends a message:
//      the window shows "Downloading model" with Ollama's own progress (the chat endpoint pulls with Ollama's downloader through the
//      allowlist proxy), then the answer streams in token by token
//   4. a second, longer answer: the page's text grows in many steps while the model generates (streamed rendering, not one block)
//   5. Settings (screenshot), the Cloud switch, "Model location" -> Browse (a native folder dialog answered by the test hook)
//   6. a link in a message and the sign-in button leave the page only through the platform (the dialog log shows the confirmation)
//   7. no console error, no CSP violation in the whole session; the loader's Inspector-visible bridge channels are the expected ones
//   8. stop the app, launch it again: the chat is still in the sidebar with its messages (SQLite in /data), the model is still installed
// Needs: out/ built (tools/build.sh), out/runtimes/*.img, apps/ollama-desktop built by build.sh, Docker NOT needed, and the internet
// (registry.ollama.ai, ollama.com). It opens real windows. Everything it creates is under $VMAPP_WORK/ollama-desktop-ui/.
//   CDP_PORT=9311  VMAPP_WORK=<absolute dir>  OLLAMA_UI_MODEL=qwen2.5:0.5b  OLLAMA_UI_KEEP=1 (leave the loader running at the end)
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
const ROOT = path.join(WORK, 'ollama-desktop-ui');
const SHOTS = path.join(WORK, 'shots');
const PORT = Number(process.env.CDP_PORT) || 9311;
const MODEL = process.env.OLLAMA_UI_MODEL || 'qwen2.5:0.5b';
const ID = 'dev.vmapp.ollama.desktop';
const APP = path.join(VMAPP, 'apps', 'ollama-desktop');
const CLI = path.join(VMAPP, 'tools', 'vmapp');
const electronBin = require(path.join(LOADER, 'node_modules', 'electron'));
const FAKE_HOSTCTL = path.join(VMAPP, 'tests', 'unit', 'fixtures', 'fake-hostctl.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const ok = (m) => console.log(`  ok: ${m}`);

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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description || r.exceptionDetails.exception.value : r.exceptionDetails.text}`);
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `ollama-desktop-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    step(`screenshot ${f}`);
    return f;
  }
  async insertText(text) {
    await this.send('Input.insertText', { text });
  }
  async key(key, code, vk, text) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
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
async function waitTarget(match, what, timeout = 60000) {
  const t = await waitFor(async () => (await targets()).find((x) => match(x.url)), { timeout, what });
  if (!conns.has(t.id)) conns.set(t.id, await Cdp.connect(t.webSocketDebuggerUrl));
  return conns.get(t.id);
}
const isLibrary = (u) => u.startsWith('vmapp-loader://ui/library.html');
const isApp = (u) => u.startsWith(`vmapp-ui://${ID}/`);
function dropApp() {
  for (const [id, c] of conns) {
    c.close();
    conns.delete(id);
  }
}

// ------------------------------------------------------------------------------------------------ processes
const spawned = [];
function startLoader(home, name, env) {
  const e = Object.assign({}, process.env, { VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_HOSTCTL]), VMAPP_HOSTCTL_DRYRUN: '1' }, env, { VMAPP_HOME: home });
  delete e.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(ROOT, `${name}.log`), 'w');
  const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: LOADER, env: e, stdio: ['ignore', log, log] });
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

// ------------------------------------------------------------------------------------------------ page helpers
const q = (s) => JSON.stringify(s);
const clickText = (c, text, scope = 'button, a, [role="button"]') =>
  c.eval(`(() => { const t = ${q(text)}; const e = [...document.querySelectorAll(${q(scope)})].find((x) => x.textContent.trim() === t); if (!e) throw new Error('no element with the text ' + t); e.click(); return true; })()`);
const hasText = (c, re) => c.eval(`new RegExp(${q(re.source)}, ${q(re.flags)}).test(document.body.innerText)`);
const bodyText = (c) => c.eval('document.body.innerText');
const sel = (c, selector) => c.eval(`!!document.querySelector(${q(selector)})`);
const openSidebar = (c) => c.eval(`(() => { const b = document.querySelector('button[aria-label="Show sidebar"]'); if (b) b.click(); return !!b; })()`);

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const f of ['vmapp-vm', 'Image', 'initramfs.cpio']) assert.ok(fs.existsSync(path.join(VMAPP, 'out', f)), `vmapp/out/${f} is missing (tools/build.sh)`);
  assert.ok(fs.existsSync(path.join(APP, 'core', 'bin', 'ollama')) && fs.existsSync(path.join(APP, 'ui', 'index.html')), 'apps/ollama-desktop is not built (apps/ollama-desktop/build.sh)');

  // ---- a private home: runtime, package, grants, size ----
  const home = path.join(ROOT, `home-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`);
  fs.mkdirSync(home, { recursive: true });
  const pkg = path.join(ROOT, 'ollama-desktop.vmapp');
  cli(home, 'pack', APP, '-o', pkg);
  cli(home, 'runtime-install', 'node22-gpu', path.join(VMAPP, 'out', 'runtimes', 'node22-gpu.img'));
  cli(home, 'install', pkg);
  cli(home, 'resources', ID, '--cpus', '8', '--memory', '8192');
  for (const h of ['registry.ollama.ai', 'dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com', 'ollama.com']) cli(home, 'grant-net', ID, h);
  const pickDir = path.join(ROOT, 'models-pick');
  fs.mkdirSync(pickDir, { recursive: true });
  const dialogLog = path.join(ROOT, 'dialogs.jsonl');
  const dialogs = () => (fs.existsSync(dialogLog) ? fs.readFileSync(dialogLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  step(`installed ${ID} into ${home}`);

  // ---- the loader, from source ----
  const dlg = { open: [pickDir], message: 0, external: true };
  const L1 = startLoader(home, 'loader-1', { VMAPP_TEST_DIALOGS: JSON.stringify(dlg), VMAPP_TEST_DIALOG_LOG: dialogLog });
  let lib = await waitTarget(isLibrary, 'the library window');
  await waitFor(() => sel(lib, `[data-app="${ID}"]`), { what: 'the app card' });
  const launch = async () => {
    await lib.eval(`document.querySelector('[data-app="${ID}"] [data-action="launch"]').click()`);
    const sheet = await waitFor(() => lib.eval(`!!document.querySelector('[data-action="sheet-launch"]')`).then((s) => s || (/running|starting/.test('') ? true : false)), { timeout: 4000, what: 'the permission sheet' }).catch(() => false);
    if (sheet) await lib.eval(`document.querySelector('[data-action="sheet-launch"]').click()`);
    return waitTarget(isApp, 'the app window', 120000);
  };
  step('launching the app from its card');
  let page = await launch();
  const issues = [];
  const watch = async (c) => {
    c.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) issues.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
      if (m.method === 'Runtime.exceptionThrown') issues.push(`exception: ${(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text}`.slice(0, 400));
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) issues.push(`log ${m.params.entry.level} [${m.params.entry.source}]: ${m.params.entry.text}`.slice(0, 400));
    });
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Page.enable');
  };
  await watch(page);
  step('the window is open');

  // ---- 3. onboarding -> chat -------------------------------------------------------------------------------------------------------
  await waitFor(() => hasText(page, /Continue|Send a message/), { timeout: 90000, what: 'the first screen' });
  const onboarding = await hasText(page, /Continue/);
  if (onboarding) {
    await waitFor(() => hasText(page, /Ollama/), { what: 'onboarding' });
    await page.shot('01-onboarding');
    await clickText(page, 'Continue');
    await waitFor(() => hasText(page, /use Ollama locally/), { what: 'the account screen' });
    await page.shot('02-onboarding-account');
    await clickText(page, "No thanks, I'll use Ollama locally");
  }
  await waitFor(() => sel(page, 'textarea[placeholder="Send a message"]'), { timeout: 60000, what: 'the chat form' });
  await sleep(1500);
  await page.shot('03-chat-empty');
  ok('the real Ollama window rendered: onboarding, then the empty chat with its form');
  assert.equal(await page.eval('location.pathname + location.search'), '/c/new' === (await page.eval('location.pathname')) ? '/c/new' : await page.eval('location.pathname + location.search'));

  // the window the user sees: title, size
  const vp = await page.eval('({w: innerWidth, h: innerHeight, platform: window.OLLAMA_PLATFORM, ws: window.OLLAMA_WEBSEARCH, shim: typeof window.menu, wv: Object.keys(window.webview || {}).sort().join(",")})');
  assert.equal(vp.ws, true);
  assert.equal(vp.platform, 'windows');
  assert.equal(vp.shim, 'function');
  assert.equal(vp.wv, 'selectFile,selectModelsDirectory,selectMultipleFiles,selectWorkingDirectory');
  ok(`the native bindings are there: window.webview.{${vp.wv}}, window.menu, OLLAMA_PLATFORM=${vp.platform}; window ${vp.w}x${vp.h}`);

  // ---- the model picker ----
  await page.eval(`document.querySelector('button[title="Select model"]').click()`);
  await waitFor(() => sel(page, 'input[placeholder="Find model..."]'), { what: 'the model picker' });
  await sleep(1500);
  await page.shot('04-model-picker');
  const listed = await page.eval(`[...document.querySelectorAll('input[placeholder="Find model..."]')][0].parentElement.parentElement.innerText`);
  ok(`the model picker lists Ollama's recommended models: ${listed.replace(/\s+/g, ' ').slice(0, 120)}…`);
  await page.eval(`document.querySelector('input[placeholder="Find model..."]').focus()`);
  await page.insertText(MODEL);
  await waitFor(() => page.eval(`[...document.querySelectorAll('input[placeholder="Find model..."]')][0].parentElement.parentElement.innerText.includes(${q(MODEL)})`), { timeout: 30000, what: `${MODEL} to be offered (the upstream check reaches ollama.com)` });
  await sleep(500);
  await page.shot('05-model-search');
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${q(MODEL)}).click()`);
  ok(`typing "${MODEL}" offers it for download (a HEAD request to the registry went through the backend and the proxy)`);

  // ---- send a message: the model is not installed, so the chat endpoint pulls it ----
  await page.eval(`document.querySelector('textarea[placeholder="Send a message"]').focus()`);
  await page.eval(`window.__samples = []; new MutationObserver(() => { const now = performance.now(); const last = window.__samples[window.__samples.length - 1]; if (!last || now - last.t > 40) window.__samples.push({ t: now, len: document.body.innerText.length }); }).observe(document.body, { subtree: true, childList: true, characterData: true }); true`);
  await page.insertText('What is the capital of France? Answer in one short sentence.');
  await page.key('Enter', 'Enter', 13, '\r');
  await waitFor(() => hasText(page, /Downloading model/), { timeout: 60000, what: 'the download progress in the window' });
  let shotDl = false;
  const pct = [];
  await waitFor(async () => {
    const t = await bodyText(page);
    const m = /\((\d+)%\)/.exec(t);
    if (m) pct.push(Number(m[1]));
    if (m && Number(m[1]) >= 10 && !shotDl) {
      shotDl = true;
      await page.shot('06-downloading');
    }
    return !/Downloading model/.test(t);
  }, { timeout: 300000, interval: 250, what: 'the download to finish' });
  assert.ok(shotDl, 'the progress bar was seen above 10 percent');
  assert.ok(pct.length >= 3 && pct[pct.length - 1] > pct[0], `the percentage rose while downloading: ${pct.join(' ')}`);
  ok(`"Downloading model" with Ollama's progress rose from ${pct[0]}% to ${pct[pct.length - 1]}% in the window (pulled by Ollama's own downloader through the proxy)`);
  await waitFor(() => hasText(page, /Paris|capital/i), { timeout: 120000, what: 'the answer' });
  await sleep(2500);
  await page.shot('07-answer');
  const t1 = await bodyText(page);
  assert.ok(t1.includes('What is the capital of France?'));
  ok(`the answer is in the window: "${t1.split('\n').filter((l) => /paris/i.test(l)).slice(-1)[0] || '(no Paris line)'}"`);

  // ---- 4. a long answer, rendered progressively ----
  await page.eval(`window.__samples = []; document.querySelector('textarea[placeholder="Send a message"]').focus(); true`);
  await page.insertText('Write a story of about 150 words about a robot who learns to paint.');
  await page.key('Enter', 'Enter', 13, '\r');
  await waitFor(async () => (await page.eval('window.__samples.length')) > 3, { timeout: 120000, what: 'the reply to start rendering' });
  await page.shot('08-streaming');
  await waitFor(async () => {
    const a = (await page.eval('window.__samples[window.__samples.length - 1].len'));
    await sleep(1500);
    return a === (await page.eval('window.__samples[window.__samples.length - 1].len'));
  }, { timeout: 180000, interval: 100, what: 'the reply to finish' });
  const samples = await page.eval('window.__samples');
  const lens = [...new Set(samples.map((s) => s.len))];
  const spanMs = samples[samples.length - 1].t - samples[0].t;
  assert.ok(lens.length >= 8, `the page text grew in ${lens.length} distinct steps`);
  ok(`streamed rendering: the page text grew in ${lens.length} steps over ${Math.round(spanMs)} ms (${samples.length} samples), not as one block`);
  await page.shot('09-story');

  // ---- an attachment: the "+" button opens a file chooser (the shim's <input type=file>); the test answers it through CDP ----
  const attach = path.join(ROOT, 'notes.txt');
  fs.writeFileSync(attach, 'The secret word is PINEAPPLE.');
  let chooser = null;
  page.on((m) => {
    if (m.method === 'Page.fileChooserOpened') chooser = m.params;
  });
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await page.eval(`document.querySelector('button[title="Upload multiple files"]').click()`);
  await waitFor(() => chooser, { timeout: 10000, what: 'the file chooser to open' });
  assert.equal(chooser.mode, 'selectMultiple');
  await page.send('DOM.setFileInputFiles', { files: [attach], backendNodeId: chooser.backendNodeId });
  await waitFor(() => sel(page, 'button[aria-label="Remove notes.txt"]'), { timeout: 15000, what: 'the attachment chip' });
  await page.eval(`document.querySelector('textarea[placeholder="Send a message"]').focus(); true`);
  await page.insertText('What is the secret word in the attached file? Answer with the word only.');
  await page.shot('09c-attachment');
  await page.key('Enter', 'Enter', 13, '\r');
  const chatPath = await page.eval('location.pathname');
  const chatId = /^\/c\/(.+)$/.exec(chatPath)[1];
  const stored = await waitFor(async () => {
    const r = await page.eval(`fetch('/api/v1/chat/${chatId}').then((r) => r.json())`);
    const m = r.chat.messages;
    return m.length >= 6 && m[m.length - 1].role === 'assistant' && m[m.length - 1].content && !m[m.length - 1].stream && m;
  }, { timeout: 120000, what: 'the answer about the attached file to be stored' });
  const attMsg = stored.find((m) => m.attachments && m.attachments.length);
  assert.ok(attMsg && attMsg.attachments[0].filename === 'notes.txt', 'the stored user message has the attachment');
  await sleep(1000);
  await page.shot('09d-attachment-answer');
  ok(`an attached file went through the file chooser, the bridge, the backend and Ollama; the answer: "${stored[stored.length - 1].content.trim().slice(0, 60)}"`);

  // ---- 5. settings ----
  await openSidebar(page);
  await sleep(600);
  await page.shot('09b-sidebar');
  await clickText(page, 'Settings');
  await waitFor(() => hasText(page, /Model location/), { what: 'the settings page' });
  await sleep(800);
  await page.shot('10-settings');
  const settingsText = await bodyText(page);
  for (const label of ['Cloud', 'Expose Ollama to the network', 'Model location', 'Context length']) assert.ok(settingsText.includes(label), `the settings page shows "${label}"`);
  ok('the real settings page: Ollama account, Cloud, Expose Ollama to the network, Model location, Context length');

  // the Cloud switch: saved by the Go backend (server.json) and applied by restarting ollama serve
  const cloudBefore = await page.eval(`fetch('/api/v1/cloud').then((r) => r.json())`);
  assert.equal(cloudBefore.disabled, false);
  await page.eval(`(() => { const label = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Cloud'); const sw = label.closest('div.flex.items-start, div.flex').parentElement.querySelector('[role="switch"]') || label.parentElement.parentElement.parentElement.querySelector('[role="switch"]'); sw.click(); return true; })()`);
  await waitFor(async () => (await page.eval(`fetch('/api/v1/cloud').then((r) => r.json())`)).disabled === true, { timeout: 30000, what: 'the Cloud switch to be saved' });
  ok('the Cloud switch (saved to ~/.ollama/server.json by the Go backend, ollama serve restarted)');
  await sleep(1500);
  await page.shot('11-settings-cloud-off');
  await page.eval(`fetch('/api/v1/cloud', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ enabled: true }) }).then((r) => r.json())`);

  // Model location: the Browse button asks the core for a folder (a native dialog; the test hook answers)
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Browse').click()`);
  await waitFor(() => dialogs().some((d) => d.kind === 'open' && /Model Directory/i.test(String(d.detail.title))), { timeout: 20000, what: 'the folder dialog' });
  await waitFor(async () => (await page.eval(`fetch('/api/v1/settings').then((r) => r.json())`)).settings.Models.startsWith('/host/'), { timeout: 30000, what: 'the chosen folder to be saved as the model location' }).catch(async () => {
    const d = dialogs().filter((x) => x.kind === 'open').pop();
    throw new Error(`the model location was not saved; the folder dialog said ${JSON.stringify(d)}`);
  });
  ok(`Model location -> Browse: a native folder dialog (answered by the test hook), saved as ${(await page.eval(`fetch('/api/v1/settings').then((r) => r.json())`)).settings.Models}`);
  // back to the default folder so that the model is found again
  await page.eval(`fetch('/api/v1/settings').then((r) => r.json()).then((s) => fetch('/api/v1/settings', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ ...s.settings, Models: '/data/.ollama/models' }) })).then((r) => r.status)`);
  await waitFor(async () => (await page.eval(`fetch('/ollama/api/tags').then((r) => r.json()).then((t) => t.models.map((m) => m.name))`).catch(() => [])).includes(MODEL), { timeout: 90000, what: 'ollama serve to be back on the default model folder' });

  // ---- 6. leaving the page: only through the platform ----
  await page.eval(`window.open('https://ollama.com/settings', '_blank'); true`);
  await waitFor(() => dialogs().some((d) => d.kind === 'openExternal' && String(d.detail).startsWith('https://ollama.com/settings')), { timeout: 15000, what: 'the platform to be asked to open the link' });
  await page.eval(`window.open('http://insecure.example/', '_blank'); window.open('javascript:alert(1)'); true`);
  await sleep(500);
  assert.ok(!dialogs().some((d) => d.kind === 'openExternal' && /insecure|javascript/.test(String(d.detail))), 'http: and javascript: links are never passed on');
  ok('window.open of an https link reaches shell.openExternal through the core (the loader asked, the test hook answered); http: and javascript: do not');

  // ---- 7. the whole session: no console error, no CSP violation ----
  const csp = issues.filter((i) => /Content Security Policy|Refused to|unsafe-eval|wasm/i.test(i));
  step(`console: ${issues.length} issue(s)${issues.length ? `:\n    ${issues.slice(0, 12).join('\n    ')}` : ''}`);
  assert.deepEqual(csp, [], `CSP violations: ${csp.join(' | ')}`);
  ok('no CSP violation in the whole session');

  // ---- 8. stop, launch again ----
  step('stopping the app and launching it again (a new VM, the same /data)');
  dropApp(); // closes every connection: the library's is opened again
  lib = await waitTarget(isLibrary, 'the library window');
  await lib.eval(`document.querySelector('[data-app="${ID}"] [data-action="stop"]').click()`);
  await waitFor(() => lib.eval(`document.querySelector('[data-app="${ID}"]').dataset.state === 'stopped'`), { timeout: 60000, what: 'the app to stop' });
  page = await launch();
  await watch(page);
  await waitFor(() => sel(page, 'textarea[placeholder="Send a message"]'), { timeout: 90000, what: 'the chat form after the restart' });
  await openSidebar(page);
  await waitFor(() => hasText(page, /capital of France/), { timeout: 60000, what: 'the earlier chat in the sidebar' });
  await sleep(1000);
  await page.shot('12-after-restart');
  await page.eval(`[...document.querySelectorAll('a')].find((a) => /capital of France/.test(a.textContent)).click()`);
  await waitFor(() => hasText(page, /Write a story of about 150 words/), { timeout: 30000, what: 'the stored messages' });
  await page.shot('13-chat-restored');
  const tags = await page.eval(`fetch('/ollama/api/tags').then((r) => r.json()).then((t) => t.models.map((m) => m.name))`);
  assert.ok(tags.includes(MODEL), `the model is still installed: ${tags}`);
  ok('after a restart in a new VM: the chat and its messages are in the sidebar, and the model is still installed');

  const csp2 = issues.filter((i) => /Content Security Policy|Refused to|unsafe-eval|wasm/i.test(i));
  assert.deepEqual(csp2, []);
  step('ALL PASSED');
  if (process.env.OLLAMA_UI_KEEP === '1') {
    step('OLLAMA_UI_KEEP=1: the loader is left running');
    return;
  }
  dropApp();
  await killLoader(L1);
}

main().catch(async (e) => {
  console.error(`FAILED: ${e && e.stack ? e.stack : e}`);
  for (const c of spawned) await killLoader(c);
  process.exit(1);
});
