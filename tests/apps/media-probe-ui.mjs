// Media Probe in the REAL loader, driven over the Chrome DevTools Protocol: files that the app's own server (in a real VM) serves, shown by
// the page every way a page can show a file, under the window's real Content-Security-Policy. The page's code never mentions the bridge.
//
//   node tests/apps/media-probe-ui.mjs                       the way it works for the launcher you have
//   MEDIA_PROBE_MODE=fallback node tests/apps/media-probe-ui.mjs   force the page-side layer (sdk/web/vmapp-fetch.js): the launcher is told not to
//                                                            serve the paths itself (VMAPP_TEST_NO_NATIVE_SERVE, development builds only)
//   MEDIA_PROBE_MODE=native                                  require that the launcher serves the paths itself (Electron's protocol.handle contract)
//
// Both modes must show EVERY file; what differs is how (a native path leaves the page's attributes untouched; the fallback swaps in
// data: and blob: URLs) and two limits (the fallback cannot show a font above its data: limit; the native path can).
// Needs: out/ built (tools/build.sh), out/runtimes/node22.img, loader/node_modules. It opens real windows. Everything is under $VMAPP_WORK/media-probe-ui/.
//   CDP_PORT=9341  VMAPP_WORK=<absolute dir>
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
const MODE = process.env.MEDIA_PROBE_MODE || 'auto'; // auto | fallback | native
const ROOT = path.join(WORK, `media-probe-ui-${MODE}`);
const PORT = Number(process.env.CDP_PORT) || 9341;
const ID = 'dev.vmapp.mediaprobe';
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
    const f = path.join(ROOT, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    step(`screenshot ${f}`);
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
  return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
}
async function waitTarget(match, what, timeout = 90000) {
  const t = await waitFor(async () => (await targets()).find((x) => match(x.url)), { timeout, what });
  return Cdp.connect(t.webSocketDebuggerUrl);
}
const isLibrary = (u) => u.startsWith('vmapp-loader://ui/library.html');
const isApp = (u) => u.startsWith(`vmapp-ui://${ID}/`);

const spawned = [];
function startLoader(home, env) {
  const e = Object.assign({}, process.env, { VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_HOSTCTL]), VMAPP_HOSTCTL_DRYRUN: '1' }, env, { VMAPP_HOME: home });
  delete e.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(ROOT, 'loader.log'), 'w');
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

// ------------------------------------------------------------------------------------------------ the app, staged with the SDK files it uses
function stageApp() {
  const stage = path.join(ROOT, 'app');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(path.join(VMAPP, 'tests', 'apps', 'media-probe'), stage, { recursive: true });
  fs.copyFileSync(path.join(VMAPP, 'sdk', 'node', 'http-bridge.js'), path.join(stage, 'core', 'http-bridge.js'));
  fs.copyFileSync(path.join(VMAPP, 'sdk', 'web', 'vmapp-fetch.js'), path.join(stage, 'ui', 'vmapp-fetch.js'));
  // two real fonts (KaTeX, MIT, already in the repository as part of apps/ollama-desktop)
  const assets = path.join(VMAPP, 'apps', 'ollama-desktop', 'ui', 'assets');
  const pick = (re) => {
    const f = fs.readdirSync(assets).find((n) => re.test(n));
    assert.ok(f, `a font matching ${re} in apps/ollama-desktop/ui/assets`);
    return path.join(assets, f);
  };
  fs.mkdirSync(path.join(stage, 'core', 'fonts'), { recursive: true });
  fs.copyFileSync(pick(/^KaTeX_Main-Regular-.*\.woff2$/), path.join(stage, 'core', 'fonts', 'main.woff2'));
  fs.copyFileSync(pick(/^KaTeX_Main-Regular-.*\.ttf$/), path.join(stage, 'core', 'fonts', 'main.ttf'));
  return stage;
}

// ------------------------------------------------------------------------------------------------ what the page shows (evaluated in the page)
const IMG_WIDTHS = { png: 4, svg: 24, 'svg-octet': 24, 'svg-text': 24, noext: 8, big: 700, redir: 6, 'redir-chain': 6 };
const RENDERED_IMAGES = ['png', 'svg', 'svg-octet', 'svg-text', 'noext', 'srcset', 'pic-img', 'big', 'local', 'data-url', 'redir', 'redir-chain'];

const imgState = (c, id) => c.eval(`(() => { const i = document.getElementById(${JSON.stringify(id)}); return i ? { src: i.getAttribute('src') || '', srcset: i.getAttribute('srcset') || '', complete: i.complete, w: i.naturalWidth, current: (i.currentSrc || '').slice(0, 30) } : null; })()`);
/** Loads every url("...") of a computed CSS value the way a page would and says whether each is a picture (or font) that arrived. */
const cssUrlsLoad = (c, selectorOrFn, prop, pseudo) =>
  c.eval(`(async () => {
    const el = ${typeof selectorOrFn === 'string' ? `document.querySelector(${JSON.stringify(selectorOrFn)})` : selectorOrFn.expr};
    if (!el) return { error: 'no element' };
    const v = getComputedStyle(el, ${JSON.stringify(pseudo || null)}).getPropertyValue(${JSON.stringify(prop)});
    const urls = [...v.matchAll(/url\\("([^"]*)"\\)/g)].map((m) => m[1]);
    const loaded = await Promise.all(urls.map((u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = u; })));
    return { value: v.slice(0, 80), urls: urls.map((u) => u.slice(0, 20)), loaded };
  })()`);

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const f of ['vmapp-vm', 'Image', 'initramfs.cpio']) assert.ok(fs.existsSync(path.join(VMAPP, 'out', f)), `vmapp/out/${f} is missing (tools/build.sh)`);
  assert.ok(fs.existsSync(path.join(VMAPP, 'out', 'runtimes', 'node22.img')), 'out/runtimes/node22.img is missing');

  // ---- 1. a private home, the app packed from a staged copy, installed
  const home = path.join(ROOT, 'home');
  const stage = stageApp();
  const pkg = path.join(ROOT, 'media-probe.vmapp');
  cli(home, 'pack', stage, '-o', pkg);
  cli(home, 'runtime-install', 'node22', path.join(VMAPP, 'out', 'runtimes', 'node22.img'));
  cli(home, 'install', pkg);
  step(`installed ${ID} into ${home} (mode: ${MODE})`);

  // ---- 2. the loader and the app
  const env = MODE === 'fallback' ? { VMAPP_TEST_NO_NATIVE_SERVE: '1' } : {};
  const L = startLoader(home, env);
  const warnings = [];
  const problems = [];
  let pageRef = null;
  try {
    const lib = await waitTarget(isLibrary, 'the library window');
    await waitFor(() => lib.eval(`!!document.querySelector('[data-app="${ID}"]')`), { what: 'the app card' });
    await lib.eval(`document.querySelector('[data-app="${ID}"] [data-action="launch"]').click()`);
    if (await waitFor(() => lib.eval(`!!document.querySelector('[data-action="sheet-launch"]')`), { timeout: 4000, what: 'a permission sheet' }).catch(() => false)) {
      await lib.eval(`document.querySelector('[data-action="sheet-launch"]').click()`);
    }
    const page = await waitTarget(isApp, 'the app window', 120000);
    pageRef = page;
    page.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') warnings.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text}`);
    });
    await page.send('Runtime.enable');
    await waitFor(() => page.eval(`typeof window.probe === 'object' && document.readyState === 'complete'`), { timeout: 60000, what: 'the page' });
    const native = await page.eval(`!!(window.vmapp && typeof window.vmapp.served === 'function' && window.vmapp.served())`); // true when the launcher serves the announced paths itself
    if (MODE === 'native') assert.equal(native, true, 'the launcher serves the app\'s bridged paths itself');
    if (MODE === 'fallback') assert.equal(native, false, 'the launcher was told not to serve them: the page-side layer does');
    step(`the page is up; the launcher serves the bridged paths itself: ${native}`);
    const swapped = (v) => /^(data|blob):/.test(v); // the page-side layer swaps in these

    // ---- 3. pictures in elements
    step('images: <img>, srcset, <picture>, with every kind of Content-Type');
    // An SVG needs an image Content-Type to be an image to a browser. Electron's protocol handler takes the handler's Content-Type as it is
    // (shell/browser/net/electron_url_loader_factory.cc, ToResponseHead: it defaults to text/html and Chromium sniffs raster pictures only), so an
    // SVG served as application/octet-stream or text/plain does not show in Electron, and does not here when the launcher serves the path itself.
    // The page-side layer is more forgiving (it sniffs the bytes), which is why those two are required only there.
    const forgiving = ['svg-octet', 'svg-text'];
    const widths = Object.fromEntries(Object.entries(IMG_WIDTHS).filter(([id]) => !(native && forgiving.includes(id))));
    for (const id of RENDERED_IMAGES.filter((i) => !(native && forgiving.includes(i)))) {
      await waitFor(async () => {
        const s = await imgState(page, id);
        return s && s.complete && s.w > 0;
      }, { timeout: 30000, what: `the image #${id}` });
    }
    for (const [id, w] of Object.entries(widths)) assert.equal((await imgState(page, id)).w, w, `#${id} is ${w} px wide`);
    ok(native
      ? `png, svg, a png without Content-Type (Chromium sniffs pictures), and a 1 MB bitmap show (${Object.keys(widths).join(', ')}); an svg with a wrong type does not, as in Electron`
      : `png, svg, an svg as application/octet-stream, an svg as text/plain without an extension, a png without Content-Type, and a 1 MB bitmap all show (${Object.keys(widths).join(', ')})`);
    const sIdle = await imgState(page, 'srcset');
    const pic = await imgState(page, 'pic-img');
    assert.ok(sIdle.w > 0 && pic.w > 0);
    assert.equal(pic.w, 8, 'the <picture> source (the 8 px file) was chosen');
    ok('srcset and <picture> show');
    const local = await imgState(page, 'local');
    assert.equal(local.src, 'local.svg', 'a file of the app\'s own package is left exactly as it was');
    assert.equal(local.w, 16);
    assert.equal((await imgState(page, 'data-url')).src.startsWith('data:image/gif'), true, 'a data: URL is left alone');
    assert.equal((await imgState(page, 'foreign')).src, 'https://example.com/never.png', 'another site\'s address is left alone');
    ok('the app\'s own package files, data: URLs and other sites\' addresses are untouched');
    if (!native) {
      for (const id of ['png', 'svg', 'svg-octet', 'svg-text', 'noext']) assert.ok(swapped((await imgState(page, id)).src), `#${id} src is a data: URL`);
      assert.match((await imgState(page, 'big')).src, /^blob:/, 'an image above the data: limit is a blob: URL');
      assert.ok(swapped((await imgState(page, 'srcset')).srcset), 'srcset was rewritten');
      ok('(page-side layer) pictures became data: URLs; the bitmap above the limit a blob: URL; srcset rewritten');
    } else {
      for (const id of ['png', 'svg', 'noext', 'big']) assert.match((await imgState(page, id)).src, /^\/assets\//, `#${id} keeps its address`);
      ok('(native) the pages\' addresses are untouched: the launcher answered them');
    }

    // ---- 4. a picture that is really missing and a page's own onerror
    step('a missing file keeps the page\'s own fallback working: onerror runs once for it, never for a picture that is fine');
    await waitFor(() => page.eval(`window.__events.missingError >= 1`), { timeout: 15000, what: 'the missing picture\'s error event' });
    await sleep(1500);
    const ev = await page.eval(`window.__events`);
    assert.equal(ev.missingError, 1, 'onerror of the missing picture ran exactly once');
    assert.equal(ev.fallbackError, 0, 'onerror of a picture that is fine never ran');
    assert.equal(ev.fallbackLoad, 1, 'and its onload ran once');
    assert.equal((await imgState(page, 'missing')).src, '/assets/missing.png');
    ok('onerror: once for the missing file, never for the fine one');

    // ---- 5. style sheets
    step('CSS: backgrounds, masks, list images, content, @media, absolute addresses, a linked sheet with relative urls');
    for (const [sel, prop] of [
      ['#bg', 'background-image'], ['#bg-shorthand', 'background-image'], ['#bg-two', 'background-image'], ['#mask', '-webkit-mask-image'], ['#list', 'list-style-image'],
      ['#in-media', 'background-image'], ['#abs', 'background-image'], ['#themed', 'background-image'], ['#inline', 'background-image'], ['#inline-two', 'background-image'],
    ]) {
      const r = await waitFor(async () => {
        const x = await cssUrlsLoad(page, sel, prop);
        return x.urls && x.urls.length && x.loaded.every(Boolean) ? x : null;
      }, { timeout: 30000, what: `${sel} ${prop}` });
      if (!native) assert.ok(r.urls.every((u) => /^(data|blob):/.test(u)), `${sel}: every url() is a data: URL (${r.urls})`);
    }
    const before = await waitFor(async () => {
      const x = await cssUrlsLoad(page, '#before', 'content', '::before');
      return x.urls && x.urls.length && x.loaded.every(Boolean) ? x : null;
    }, { timeout: 30000, what: '#before::before content' });
    assert.ok(before.urls.length === 1);
    const cur = await page.eval(`getComputedStyle(document.getElementById('cursor')).cursor`);
    assert.match(cur, /url\(/, 'the cursor is a url()');
    if (!native) assert.match(cur, /url\("data:/, 'and it is a data: URL');
    ok('background, shorthand, two backgrounds, mask, list-style-image, ::before content, cursor, @media, an absolute address, the linked sheet (relative urls resolved against the sheet), inline style and element.style all show');
    const untouched = await page.eval(`getComputedStyle(document.getElementById('not-bridged-url')).backgroundImage.startsWith('url("data:image/gif')`);
    const localBg = await page.eval(`getComputedStyle(document.getElementById('local-bg')).backgroundImage`);
    assert.ok(untouched && /vmapp-ui:\/\/dev\.vmapp\.mediaprobe\/local\.svg/.test(localBg), `a data: URL and the app's own file stay as they are (${localBg})`);
    ok('a data: URL in CSS and a file of the package are left alone');

    // ---- 6. fonts
    step('fonts: woff2, woff2 served as octet-stream, a font above the data: limit, a font in a linked sheet');
    const font = async (name) => page.eval(`document.fonts.load('16px ${name}', 'Hello').then((f) => f.length, () => -1)`);
    assert.equal(await font('ProbeFont'), 1);
    assert.equal(await font('ProbeFontOctet'), 1);
    assert.equal(await font('ThemeFont'), 1);
    ok('@font-face fonts load: woff2, a woff2 served as application/octet-stream, and one from a linked style sheet');
    const huge = await font('ProbeFontHuge');
    if (native) {
      assert.equal(huge, 1, 'a 1.2 MB font loads: the launcher streams it');
      ok('(native) a font of 1.2 MB loads (no data: limit)');
    } else {
      assert.notEqual(huge, 1, 'a font above the data: limit cannot be shown (the window allows data: only for fonts)');
      assert.ok(warnings.some((w) => /huge\.ttf/.test(w)), `one warning names it (${warnings.join(' | ').slice(0, 300)})`);
      ok('(page-side layer) a font above the limit is refused with one warning naming it');
    }

    // ---- 7. audio and video
    step('media: <audio src>, <audio><source>, <video poster>');
    for (const id of ['aud', 'aud2']) {
      const a = await waitFor(() => page.eval(`(() => { const a = document.getElementById(${JSON.stringify(id)}); return a.readyState >= 1 && Number.isFinite(a.duration) ? { d: a.duration, src: a.currentSrc.slice(0, 12) } : null; })()`), { timeout: 30000, what: `#${id} metadata` });
      assert.ok(a.d > 0.4 && a.d < 0.6, `#${id} is half a second long (${a.d})`);
      if (!native) assert.match(a.src, /^blob:/, `#${id} plays from a blob: URL`);
    }
    const poster = await page.eval(`document.getElementById('vid').getAttribute('poster')`);
    if (!native) assert.ok(swapped(poster), 'the poster became a data: URL');
    else assert.equal(poster, '/assets/pixel.png');
    ok('audio plays (src and <source>), and the video poster is handled');
    const svgimg = await page.eval(`document.getElementById('svgimage').getAttribute('href')`);
    const inputimg = await page.eval(`document.getElementById('inputimg').getAttribute('src')`);
    if (!native) assert.ok(swapped(svgimg) && swapped(inputimg), 'SVG <image href> and <input type=image> became data: URLs');
    ok('SVG <image> and <input type=image> are handled');

    // ---- 8. what a page does later, from script
    step('later, from script: new Image, changing src, element.style, insertRule, <style>, constructable and adopted sheets, shadow DOM, a <link>, <audio>');
    await page.eval(`probe.addImg('dyn1', '/assets/pixel.png')`);
    await waitFor(async () => (await imgState(page, 'dyn1')).w === 4, { what: 'a new Image()' });
    await page.eval(`probe.setSrc('dyn1', '/assets/icon.svg')`);
    await waitFor(async () => (await imgState(page, 'dyn1')).w === 24, { what: 'img.src changed to another file' });
    await page.eval(`probe.setSrc('dyn1', '/assets/pixel2.png')`);
    await waitFor(async () => (await imgState(page, 'dyn1')).w === 8, { what: 'img.src changed again' });
    ok('new Image(), and changing src twice, show each file');
    await page.eval(`probe.addDiv('d1'); probe.setStyle('d1', 'background-image', 'url(/assets/pixel.png)')`);
    await page.eval(`probe.addDiv('d2'); probe.setStyleAttr('d2', 'background-image:url(/assets/pixel2.png);width:40px;height:20px')`);
    await page.eval(`probe.addDiv('d3'); probe.insertRule('#d3', 'background-image: url(/assets/icon.svg)')`);
    await page.eval(`probe.addDiv('d4'); probe.styleText('#d4 { background-image: url(/assets/pixel.png); }')`);
    await page.eval(`probe.addDiv('d5'); probe.constructable('#d5 { background-image: url(/assets/pixel2.png); }')`);
    await page.eval(`probe.addDiv('d6'); probe.constructableAsync('#d6 { background-image: url(/assets/icon.svg); }')`);
    for (const id of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
      await waitFor(async () => {
        const x = await cssUrlsLoad(page, `#${id}`, 'background-image');
        return x.urls && x.urls.length && x.loaded.every(Boolean);
      }, { timeout: 30000, what: `#${id}` });
    }
    ok('element.style.setProperty, style.cssText, sheet.insertRule, a new <style>, replaceSync + adoptedStyleSheets, and replace() all show');
    await page.eval(`probe.shadow('shadow-host')`);
    await waitFor(() => page.eval(`(() => { const r = document.getElementById('shadow-host').shadowRoot; const i = r.getElementById('simg'); return i.complete && i.naturalWidth === 24; })()`), { timeout: 30000, what: 'an <img> in a shadow root' });
    for (const [expr, prop] of [[`document.getElementById('shadow-host').shadowRoot.getElementById('sx')`, 'background-image'], [`document.getElementById('shadow-host').shadowRoot.getElementById('sinline')`, 'background-image']]) {
      await waitFor(async () => {
        const x = await cssUrlsLoad(page, { expr }, prop);
        return x.urls && x.urls.length && x.loaded.every(Boolean);
      }, { timeout: 30000, what: `shadow ${prop}` });
    }
    ok('inside a shadow root: <img>, a <style> rule and an inline style all show');
    await page.eval(`probe.addLink('/assets/css/theme.css')`);
    await page.eval(`probe.addAudio('aud3', '/assets/tone.wav')`);
    await waitFor(() => page.eval(`(() => { const a = document.getElementById('aud3'); return a.readyState >= 1 && a.duration > 0.4; })()`), { timeout: 30000, what: 'an <audio> made later' });
    ok('a <link rel=stylesheet> and an <audio> added later show');

    // ---- 9. nothing was blocked, and nothing is left running
    step('the window\'s CSP was never violated, nothing loops, and the requests were made once each');
    await sleep(1200);
    // the one violation the page causes on purpose: an <img> of another site, which the CSP refuses
    assert.deepEqual((await page.eval(`window.__csp`)).filter((v) => !v.includes('example.com/never.png')), [], 'no Content-Security-Policy violation (but the other site\'s picture, refused on purpose)');
    const stats1 = await page.eval(`probe.stats()`);
    await sleep(1500);
    const stats2 = await page.eval(`probe.stats()`);
    assert.deepEqual({ ...stats2, '/assets/stats': 0 }, { ...stats1, '/assets/stats': 0 }, 'no request is repeated while the page is idle');
    if (!native) {
      for (const p of ['/assets/pixel.png', '/assets/icon.svg', '/assets/pixel2.png', '/assets/big.bmp', '/assets/font.woff2', '/assets/tone.wav']) assert.equal(stats2[p], 1, `${p} was fetched once (${stats2[p]})`);
      ok('(page-side layer) every file was fetched over the bridge exactly once, whatever number of places showed it');
    } else {
      // Electron's contract for media: the page asks with Range and the answer is 206 with Content-Range (the `stream` privilege makes <audio> and
      // <video> expect that); the launcher passes the header to the app's server and the answer back
      assert.ok((stats2['range /assets/tone.wav'] || 0) >= 1, `the audio element's Range request reached the app's server (${JSON.stringify(stats2)})`);
      ok('(native) requests are the browser\'s own, with its cache; the audio element\'s Range requests reached the app\'s server and were answered 206');
    }
    ok('no CSP violation, and the page is quiet');
    assert.deepEqual(problems, [], 'no exception in the page');
    await page.shot('media-probe');
    page.close();
    lib.close();
    ok(`all of it, in ${native ? 'native' : 'page-side-layer'} mode`);
  } catch (e) {
    // what the page said, to make a failure understandable
    console.error(`page warnings: ${JSON.stringify(warnings.slice(0, 12))}\npage exceptions: ${JSON.stringify(problems.slice(0, 5))}`);
    if (pageRef) {
      try {
        console.error(`page state: ${JSON.stringify(await pageRef.eval(`({ csp: window.__csp, events: window.__events, imgs: [...document.images].map((i) => [i.id, (i.getAttribute('src') || '').slice(0, 20), i.complete, i.naturalWidth]) })`))}`);
        console.error(`core requests: ${JSON.stringify(await pageRef.eval(`probe.stats()`))}`);
        await pageRef.shot('failure');
      } catch (e2) {
        console.error(`(could not read the page: ${e2.message})`);
      }
    }
    if (process.env.MEDIA_PROBE_KEEP === '1') {
      console.error(`MEDIA_PROBE_KEEP=1: the loader stays up; DevTools protocol on http://127.0.0.1:${PORT}/json (kill it when done)`);
      await sleep(30 * 60 * 1000);
    }
    throw e;
  } finally {
    await killLoader(L);
  }
  step('media-probe-ui passed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAIL: ${e.stack || e}`);
    for (const c of spawned) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    process.exit(1);
  },
);
