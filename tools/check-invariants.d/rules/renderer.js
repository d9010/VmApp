'use strict';
// INV-B1..B4: the renderer (app windows, preload, CSP, navigation, permissions, the vmapp-ui handler).

const { findCalls, parseObject, evalStringExpr } = require('../lib/scan');
const { findFunctions, resolveCallable, expandedBody } = require('../lib/js');
const { prodJs, fail, at } = require('../lib/tree');
const vm = require('vm');

const LOADER = 'loader';

// ------------------------------------------------------------------------------------------------ B1

const APP_PREFS = {
  contextIsolation: 'true',
  sandbox: 'true',
  nodeIntegration: 'false',
  nodeIntegrationInWorker: 'false',
  nodeIntegrationInSubFrames: 'false',
  webSecurity: 'true',
  webviewTag: 'false',
  allowRunningInsecureContent: 'false',
};
const LOADER_PREFS = { contextIsolation: 'true', sandbox: 'true', nodeIntegration: 'false' };
// keys that weaken the sandbox or bypass the partition: never allowed
const FORBIDDEN_PREF_KEYS = new Set([
  'enableRemoteModule',
  'experimentalFeatures',
  'enableBlinkFeatures',
  'offscreen',
  'additionalArguments',
  'nodeIntegrationInSubFrames', // only checked through APP_PREFS value
  'session', // a session object instead of the partition string
  'webContents',
]);
const BENIGN_PREF_KEYS = new Set([
  'partition', 'preload', 'safeDialogs', 'safeDialogsMessage', 'spellcheck', 'devTools', 'backgroundThrottling',
  'autoplayPolicy', 'defaultFontFamily', 'defaultFontSize', 'defaultMonospaceFontSize', 'minimumFontSize',
  'defaultEncoding', 'disableDialogs', 'enableWebSQL', 'v8CacheOptions', 'transparent', 'scrollBounce', 'imageAnimationPolicy',
  ...Object.keys(APP_PREFS),
]);
FORBIDDEN_PREF_KEYS.delete('nodeIntegrationInSubFrames');

const WINDOW_RE = /\bnew\s+(?:\w+\s*\.\s*)?(BrowserWindow|WebContentsView|BrowserView)\s*\(/;

/** Every BrowserWindow / WebContentsView / BrowserView constructed in loader/ production code. */
function findWindows(tree) {
  const out = [];
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    for (const call of findCalls(sc, WINDOW_RE)) {
      const kind = /(BrowserWindow|WebContentsView|BrowserView)/.exec(call.head)[1];
      out.push({ file, sc, call, kind });
    }
  }
  return out;
}

/** Definitions of `name: expr` / `name = expr` across loader files; returns expression texts. */
function definitionsOf(tree, files, name) {
  const defs = [];
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*(?::|=(?!=))\\s*`, 'g');
  for (const file of files) {
    const sc = tree.scan(file, 'js');
    let m;
    while ((m = re.exec(sc.skel))) {
      const start = m.index + m[0].length;
      let depth = 0;
      let end = sc.skel.length;
      for (let k = start; k < sc.skel.length; k++) {
        const c = sc.skel[k];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) {
          if (depth === 0) {
            end = k;
            break;
          }
          depth--;
        } else if ((c === ',' || c === ';') && depth === 0) {
          end = k;
          break;
        }
      }
      defs.push({ file, expr: sc.code.slice(start, end).trim(), idx: m.index });
    }
  }
  return defs;
}

/** Does `expr` end up at a string containing `needle`, following simple identifier chains (a.b.c, x = y)? */
function reaches(tree, files, expr, needle, seen = new Set(), depth = 6) {
  if (expr.includes(needle)) return { ok: true, problems: [] };
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(expr.trim());
  if (!m || !/^[\w$.\s]+$/.test(expr.trim()) || depth <= 0 || seen.has(m[1])) return { ok: false, problems: [] };
  seen.add(m[1]);
  let ok = false;
  const problems = [];
  for (const d of definitionsOf(tree, files, m[1])) {
    if (d.expr.includes(needle)) {
      ok = true;
      continue;
    }
    const r = reaches(tree, files, d.expr, needle, seen, depth - 1);
    if (r.ok) ok = true;
    problems.push(...r.problems);
    // a definition that names some other script is a different preload (the loader's own preload-loader.js is the
    // known other one: name-based tracing sees both because app and loader windows both say `preload:`)
    if (!r.ok && /['"`][^'"`]*\.(?:c|m)?js['"`]/.test(d.expr) && !/preload-loader/.test(d.expr) && !reaches(tree, files, d.expr, 'preload-loader', new Set(), 4).ok) {
      problems.push(`${d.file}: ${m[1]} = ${d.expr.slice(0, 80)}`);
    }
  }
  return { ok, problems };
}

function checkPrefs(tree, w, props, want, label, out) {
  const byKey = new Map();
  for (const p of props) if (p.key) byKey.set(p.key, p);
  for (const p of props) {
    if (p.spread || p.computed) {
      out.push(at('fail', w.file, w.sc, p.index, `${label}: webPreferences has a spread or computed key; cannot verify it statically`));
    }
  }
  for (const [k, v] of Object.entries(want)) {
    const p = byKey.get(k);
    if (!p) out.push(at('fail', w.file, w.sc, w.call.index, `${label}: webPreferences.${k} is not set (must be ${v})`));
    else if (p.value !== v) out.push(at('fail', w.file, w.sc, p.index, `${label}: webPreferences.${k} must be ${v}, found ${p.value.slice(0, 60)}`));
  }
  for (const p of props) {
    if (!p.key) continue;
    if (FORBIDDEN_PREF_KEYS.has(p.key)) out.push(at('fail', w.file, w.sc, p.index, `${label}: webPreferences.${p.key} is not allowed`));
    else if (!BENIGN_PREF_KEYS.has(p.key)) out.push(at('warn', w.file, w.sc, p.index, `${label}: unrecognised webPreferences key '${p.key}' (review it)`));
  }
  return byKey;
}

// webPreferences.devTools (SPEC 7): an app window's equals `<param>.devTools === true`, where <param> is the parameter of
// create(params) (the core's own window.create request; default false, in dev AND packaged builds). A loader-owned window's is
// `!cfg.isPackaged` (dev builds only). Nothing else may set it.
const DT_APP = /^([A-Za-z_$][\w$]*)\s*\.\s*devTools\s*===\s*true$/;
const DT_LOADER = /^!\s*(?:this\s*\.\s*)?cfg\s*\.\s*isPackaged$/;

/** Every `devTools: <expr>` object key and `x.devTools = <expr>` assignment in loader/ production code. */
function devToolsDefinitions(tree, files) {
  const defs = [];
  for (const file of files) {
    const sc = tree.scan(file, 'js');
    const re = /(?:[{,]\s*devTools\s*:|\.\s*devTools\s*=(?!=))\s*/g;
    let m;
    while ((m = re.exec(sc.skel))) {
      const start = m.index + m[0].length;
      let depth = 0;
      let end = sc.skel.length;
      for (let k = start; k < sc.skel.length; k++) {
        const c = sc.skel[k];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) {
          if (depth === 0) {
            end = k;
            break;
          }
          depth--;
        } else if ((c === ',' || c === ';') && depth === 0) {
          end = k;
          break;
        }
      }
      defs.push({ file, sc, index: m.index, expr: sc.code.slice(start, end).replace(/\s+/g, ' ').trim() });
    }
  }
  return defs;
}

/** devTools in the webPreferences of one window; `app` = app-content window (else loader-owned). */
function checkDevToolsPref(w, byKey, wp, app, label, out) {
  const p = byKey.get('devTools');
  if (!p) {
    out.push(at('fail', w.file, w.sc, wp.index, `${label}: webPreferences.devTools is not set (${app ? "must be params.devTools === true, the core's window.create value" : 'must be !cfg.isPackaged'})`));
    return;
  }
  const expr = p.value.replace(/\s+/g, ' ').trim();
  if (!app) {
    if (!DT_LOADER.test(expr)) out.push(at('fail', w.file, w.sc, p.index, `${label}: webPreferences.devTools must be !cfg.isPackaged (DevTools on the loader's own windows are dev-only), found ${expr.slice(0, 60)}`));
    return;
  }
  const m = DT_APP.exec(expr);
  if (!m) {
    out.push(at('fail', w.file, w.sc, p.index, `${label}: webPreferences.devTools must be <params>.devTools === true (what the app's core asked for in window.create; never a constant, a build mode or an environment variable), found ${expr.slice(0, 60)}`));
    return;
  }
  // <params> must be the first parameter of the enclosing create(params) method
  const encl = findFunctions(w.sc, 'create').find((f) => f.bodyStart <= w.call.index && w.call.index < f.bodyEnd);
  if (!encl) out.push(at('fail', w.file, w.sc, p.index, `${label}: the app window is not built inside create(params), so devTools cannot be traced to the window.create request`));
  else if (encl.params[0] !== m[1]) out.push(at('fail', w.file, w.sc, p.index, `${label}: webPreferences.devTools reads ${m[1]}.devTools, which is not the first parameter of create(${encl.params[0] || ''})`));
}

function ruleB1(tree) {
  const out = [];
  const files = prodJs(tree, LOADER);
  const windows = findWindows(tree);
  let appWindows = 0;
  for (const w of windows) {
    const label = `${w.kind}`;
    const optArg = w.call.args[0];
    if (!optArg || tree.scan(w.file, 'js').skel[optArg.start] !== '{') {
      out.push(at('fail', w.file, w.sc, w.call.index, `${label}: options are not an object literal; cannot verify webPreferences`));
      continue;
    }
    const opts = parseObject(w.sc, optArg.start);
    const wp = opts.props.find((p) => p.key === 'webPreferences');
    if (opts.props.some((p) => p.spread)) {
      out.push(at('fail', w.file, w.sc, w.call.index, `${label}: options contain a spread; cannot verify webPreferences`));
      continue;
    }
    if (!wp) {
      out.push(at('fail', w.file, w.sc, w.call.index, `${label}: no explicit webPreferences (every window must set them)`));
      continue;
    }
    if (w.sc.skel[wp.valueStart] !== '{') {
      out.push(at('fail', w.file, w.sc, wp.index, `${label}: webPreferences is not an object literal; cannot verify it`));
      continue;
    }
    const prefs = parseObject(w.sc, wp.valueStart);
    const byKey = new Map(prefs.props.filter((p) => p.key).map((p) => [p.key, p]));
    const preload = byKey.get('preload');
    const partition = byKey.get('partition');
    const loaderOwned = preload && (/loader/i.test(preload.value) || preload.value.includes('preload-loader')) ? true : !preload && !partition;
    if (loaderOwned) {
      checkPrefs(tree, w, prefs.props, LOADER_PREFS, `loader window (${label})`, out);
      checkDevToolsPref(w, byKey, wp, false, `loader window (${label})`, out);
      if (preload) {
        const r = reaches(tree, files, preload.value, 'preload-loader');
        if (!r.ok) out.push(at('fail', w.file, w.sc, preload.index, `loader window (${label}): preload does not resolve to preload-loader.js`));
      }
      continue;
    }
    appWindows++;
    const lab = `app window (${label})`;
    checkPrefs(tree, w, prefs.props, APP_PREFS, lab, out);
    checkDevToolsPref(w, byKey, wp, true, lab, out);
    if (!preload) out.push(at('fail', w.file, w.sc, wp.index, `${lab}: webPreferences.preload is not set (must be the loader's preload-app.js)`));
    else {
      const r = reaches(tree, files, preload.value, 'preload-app');
      if (!r.ok) out.push(at('fail', w.file, w.sc, preload.index, `${lab}: preload '${preload.value.slice(0, 60)}' does not resolve to the loader's preload-app.js`));
      for (const p of r.problems) out.push(at('fail', w.file, w.sc, preload.index, `${lab}: preload is also assigned elsewhere: ${p}`));
    }
    if (!partition) out.push(at('fail', w.file, w.sc, wp.index, `${lab}: webPreferences.partition is not set (must be persist:vmapp-<id>)`));
    else {
      const v = partition.value.trim();
      let ok = /^[`'"]persist:vmapp-/.test(v);
      if (!ok) {
        const call = /^([A-Za-z_$][\w$.]*?)\s*\(/.exec(v);
        if (call) {
          const fname = call[1].split('.').pop();
          for (const f of files) {
            const sc = tree.scan(f, 'js');
            for (const fn of findFunctions(sc, fname)) if (sc.code.slice(fn.bodyStart, fn.bodyEnd).includes('persist:vmapp-')) ok = true;
          }
        }
      }
      if (!ok) out.push(at('fail', w.file, w.sc, partition.index, `${lab}: partition '${v.slice(0, 60)}' is not persist:vmapp-<id>`));
    }
  }
  if (windows.length === 0) out.push(fail(null, null, 'no BrowserWindow / WebContentsView found in loader/ (app window creation must be found to be checked)'));
  else if (appWindows === 0) out.push(fail(null, null, 'no app-content window found in loader/ (a window with the loader preload-app.js and a D9010 VmApp partition)'));

  // devTools is set only in the two allowed forms, anywhere in loader/ (a constant true, a build mode, an environment
  // variable or a second source for an app window is a violation)
  for (const d of devToolsDefinitions(tree, files)) {
    if (!DT_APP.test(d.expr) && !DT_LOADER.test(d.expr)) {
      out.push(at('fail', d.file, d.sc, d.index, `devTools is set from '${d.expr.slice(0, 60)}': only <params>.devTools === true (app windows, the core's window.create value) and !cfg.isPackaged (loader windows) are allowed`));
    }
  }
  // the packaged-mode closer: a `devtools-opened` handler that calls closeDevTools() must exist
  if (!files.some((f) => {
    const sc = tree.scan(f, 'js');
    return /\.\s*on\s*\(\s*['"`]devtools-opened['"`]/.test(sc.code) && /\.\s*closeDevTools\s*\(/.test(sc.skel);
  })) out.push(fail(null, null, "no 'devtools-opened' handler that calls closeDevTools() in loader/ (a packaged loader must close DevTools on loader windows and on app windows created without devTools)"));

  // <webview> for app content is never allowed
  for (const f of tree.list(LOADER, { exts: ['.html', '.htm', '.js', '.mjs'], skip: (r) => /(^|\/)test\/$/.test(r) })) {
    const text = tree.read(f);
    const m = /<webview\b|createElement\(\s*['"]webview['"]\s*\)/i.exec(text);
    if (m) out.push({ level: 'fail', file: f, line: text.slice(0, m.index).split('\n').length, message: '<webview> in loader/', text: text.split('\n')[text.slice(0, m.index).split('\n').length - 1].trim().slice(0, 200) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ B2

// `menu` (set, onClick): the window's menus in the Mac menu bar, data only (SPEC 7 "Menus"; DEV-APPS C9, proposed 2026-10-17)
const EXPECT_TOP = ['invoke', 'send', 'on', 'menu', 'app', 'ipcRenderer'];

function ruleB2(tree) {
  const out = [];
  const file = `${LOADER}/preload-app.js`;
  if (!tree.exists(file)) return [fail(file, null, 'preload-app.js is missing')];
  const sc = tree.scan(file, 'js');
  const calls = findCalls(sc, /\bexposeInMainWorld\s*\(/);
  const tokens = (sc.code.match(/exposeInMainWorld/g) || []).length;
  if (calls.length !== 1) out.push(fail(file, null, `preload-app.js must call exposeInMainWorld exactly once (found ${calls.length})`));
  if (tokens !== calls.length) out.push(fail(file, null, 'exposeInMainWorld referenced in a form other than a direct call; cannot verify'));
  if (/exposeInIsolatedWorld/.test(sc.code)) out.push(fail(file, null, 'exposeInIsolatedWorld is not allowed in preload-app.js'));
  if (/\bwebFrame\b/.test(sc.skel)) out.push(fail(file, null, 'preload-app.js must not use webFrame (it can inject into the page)'));
  for (const r of findCalls(sc, /\brequire\s*\(/)) {
    if (evalStringExpr(r.args[0] ? r.args[0].text : '') !== 'electron') out.push(at('fail', file, sc, r.index, 'preload-app.js may only require("electron")'));
  }
  for (const c of calls) {
    const name = c.args[0] ? evalStringExpr(c.args[0].text) : null;
    if (name !== 'vmapp') out.push(at('fail', file, sc, c.index, `exposes '${name}' (must be exactly window.vmapp)`));
    const a1 = c.args[1];
    if (!a1 || sc.skel[a1.start] !== '{') {
      out.push(at('fail', file, sc, c.index, 'the exposed API is not an object literal; cannot verify its keys'));
      continue;
    }
    const top = parseObject(sc, a1.start);
    const keys = top.props.map((p) => (p.spread ? '...' : p.computed ? '[computed]' : p.key));
    const extra = keys.filter((k) => !EXPECT_TOP.includes(k));
    const missing = EXPECT_TOP.filter((k) => !keys.includes(k));
    if (extra.length) out.push(at('fail', file, sc, a1.start, `window.vmapp exposes extra keys: ${extra.join(', ')}`));
    if (missing.length) out.push(at('fail', file, sc, a1.start, `window.vmapp is missing keys: ${missing.join(', ')}`));
    if (new Set(keys).size !== keys.length) out.push(at('fail', file, sc, a1.start, 'window.vmapp has duplicate keys'));
    const sub = (key, expect) => {
      const p = top.props.find((x) => x.key === key);
      if (!p) return;
      if (sc.skel[p.valueStart] !== '{') {
        out.push(at('fail', file, sc, p.index, `window.vmapp.${key} must be an object literal with keys ${expect.join(', ')}`));
        return;
      }
      const o = parseObject(sc, p.valueStart);
      const ks = o.props.map((x) => (x.spread ? '...' : x.computed ? '[computed]' : x.key));
      if (ks.length !== expect.length || expect.some((k) => !ks.includes(k))) {
        out.push(at('fail', file, sc, p.index, `window.vmapp.${key} keys must be exactly ${expect.join(', ')} (found ${ks.join(', ')})`));
      }
      for (const x of o.props) {
        if (x.value && /^ipcRenderer\b/.test(x.value.trim())) out.push(at('fail', file, sc, x.index, `window.vmapp.${key}.${x.key} exposes the raw ipcRenderer`));
      }
    };
    sub('ipcRenderer', ['invoke', 'send', 'on']);
    sub('app', ['id', 'name', 'version']);
    sub('menu', ['set', 'onClick']);
    for (const k of ['invoke', 'send', 'on']) {
      const p = top.props.find((x) => x.key === k);
      if (p && p.value && /^ipcRenderer\b/.test(p.value.trim())) out.push(at('fail', file, sc, p.index, `window.vmapp.${k} exposes the raw ipcRenderer`));
    }
  }

  // IPC from a renderer is routed by the sender's webContents id, never by a renderer-supplied id
  for (const f of prodJs(tree, LOADER)) {
    const s = tree.scan(f, 'js');
    for (const c of findCalls(s, /\bipcMain\s*\.\s*(?:handle|handleOnce|on|once)\s*\(/)) {
      const chan = c.args[0] ? evalStringExpr(c.args[0].text) : null;
      const handler = c.args[1] && resolveCallable(s, c.args[1]);
      const appChannel = chan !== null && chan.startsWith('vmapp:');
      if (!handler) {
        out.push(at(appChannel ? 'fail' : 'warn', f, s, c.index, 'ipcMain handler is not a function expression; cannot verify it checks the sender'));
        continue;
      }
      const ev = handler.params[0];
      const body = expandedBody(s, handler);
      const usesSender = /\.sender\b|\bsender\b/.test(body);
      if (!usesSender) {
        out.push(at(appChannel ? 'fail' : 'warn', f, s, c.index, `ipcMain handler${chan ? ` '${chan}'` : ''} never reads ${ev || 'event'}.sender (route by sender webContents)`));
      }
      if (appChannel) {
        // the registry lookup must be keyed by the sender, not by a message field
        for (const m of body.matchAll(/\bregistry\s*\.\s*get\s*\(\s*([^)]*)\)/g)) {
          if (!/sender/.test(m[1])) out.push(at('fail', f, s, c.index, `ipcMain '${chan}': registry lookup keyed by '${m[1].trim()}' instead of the sender's webContents id`));
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ B3

function specCsp(tree) {
  if (!tree.exists('SPEC.md')) return null;
  const text = tree.read('SPEC.md');
  const sec = text.split(/^## 7\./m)[1] || text;
  const m = /`([^`]*default-src[^`]*connect-src[^`]*)`/.exec(sec);
  return m ? m[1] : null;
}

const normCsp = (s) => s.replace(/\s+/g, ' ').replace(/\s*;\s*/g, '; ').replace(/;\s*$/, '').trim();

function parseCsp(s) {
  const map = new Map();
  for (const part of normCsp(s).split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (toks.length) map.set(toks[0].toLowerCase(), toks.slice(1));
  }
  return map;
}

/** Is `csp` the same as, or provably stricter than, `spec`? Returns a list of problems (empty = ok). */
function cspProblems(csp, spec) {
  if (normCsp(csp) === normCsp(spec)) return [];
  const a = parseCsp(csp);
  const s = parseCsp(spec);
  const problems = [];
  const cn = a.get('connect-src');
  if (!cn || cn.length !== 1 || cn[0] !== "'none'") problems.push("connect-src must be exactly 'none'");
  const sc = a.get('script-src');
  if (!sc) problems.push('script-src is missing');
  else {
    if (sc.some((t) => /^'unsafe-/.test(t))) problems.push('script-src must not contain unsafe-*');
    if (sc.some((t) => t === '*' || /^https?:/.test(t) || t === 'data:' || t === 'blob:')) problems.push('script-src allows an external or data source');
  }
  for (const [dir, srcs] of s) {
    const mine = a.get(dir);
    if (!mine) {
      problems.push(`directive ${dir} from SPEC 7 is missing`);
      continue;
    }
    if (mine.length === 1 && mine[0] === "'none'") continue;
    const extra = mine.filter((t) => !srcs.includes(t));
    if (extra.length) problems.push(`${dir} is weaker than SPEC 7 (extra sources: ${extra.join(' ')})`);
  }
  for (const [dir, srcs] of a) if (!s.has(dir) && srcs.some((t) => t === '*' || /^'unsafe-/.test(t))) problems.push(`extra directive ${dir} allows ${srcs.join(' ')}`);
  if ([...a.values()].some((srcs) => srcs.includes('*'))) problems.push('a CSP directive contains *');
  return problems;
}

/** CSP-looking string constants in loader/: [{file, name, value, idx, sc}] */
function cspConstants(tree) {
  const out = [];
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
    let m;
    while ((m = re.exec(sc.skel))) {
      const start = m.index + m[0].length;
      let depth = 0;
      let end = sc.skel.length;
      for (let k = start; k < sc.skel.length; k++) {
        const c = sc.skel[k];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ';' && depth === 0) {
          end = k;
          break;
        }
      }
      const v = evalStringExpr(sc.code.slice(start, end));
      if (v && /default-src/.test(v)) out.push({ file, name: m[1], value: v, idx: m.index, sc });
    }
  }
  return out;
}

/** The module serving vmapp-ui://: [{file, sc, fn}] */
function findAppUiHandlers(tree) {
  const out = [];
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    for (const name of ['createAppUiHandler', 'handleAppUi']) {
      for (const fn of findFunctions(sc, name)) {
        // a definition, not the parameter or a use: it must have a body that touches requests
        if (/request|req\b/.test(sc.code.slice(fn.bodyStart, fn.bodyEnd))) out.push({ file, sc, fn, name });
      }
    }
  }
  return out;
}

// ---- the microphone gate (SPEC 2.2 permissions.devices, SPEC 7, INV-B3) ----
// The permission handlers of an app partition answer `false`, with one exception: the microphone. Their `true` can only
// come from microphoneRequestAllowed / microphoneCheckAllowed (loader/src/devices.js), called with plain arguments. This
// rule reads those two functions and the gate method they ask (DeviceGate._why): every return but the last is `false`, the
// last asks the gate, only 'audio' (alone) is ever named, and the gate checks the window, the origin, the manifest and the
// user's grant.
const GATE_FN = { request: 'microphoneRequestAllowed', check: 'microphoneCheckAllowed' };
const PLAIN_ARG = '[A-Za-z_$][\\w$]*';
const GATE_CALL = {
  request: new RegExp(`^${GATE_FN.request}\\(\\s*${PLAIN_ARG}(?:\\s*,\\s*${PLAIN_ARG}){4}\\s*\\)$`),
  check: new RegExp(`^${GATE_FN.check}\\(\\s*${PLAIN_ARG}(?:\\s*,\\s*${PLAIN_ARG}){4}\\s*\\)$`),
};
// The clipboard gate (DEV-APPS C5, SPEC 8.4): the second device a window may use, with the same shape and its own checks below.
const CLIP_FN = { request: 'clipboardRequestAllowed', check: 'clipboardCheckAllowed' };
const CLIP_CALL = {
  request: new RegExp(`^${CLIP_FN.request}\\(\\s*${PLAIN_ARG}(?:\\s*,\\s*${PLAIN_ARG}){4}\\s*\\)$`),
  check: new RegExp(`^${CLIP_FN.check}\\(\\s*${PLAIN_ARG}(?:\\s*,\\s*${PLAIN_ARG}){4}\\s*\\)$`),
};

function clipboardGateProblems(tree) {
  const out = [];
  const defs = { request: [], check: [], reqMethod: [], chkMethod: [] };
  const names = { request: CLIP_FN.request, check: CLIP_FN.check, reqMethod: 'clipboardAllowed', chkMethod: 'clipboardChecked' };
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    for (const [key, name] of Object.entries(names)) for (const fn of findFunctions(sc, name)) defs[key].push({ file, sc, fn });
  }
  const once = (key, what) => {
    if (defs[key].length !== 1) {
      out.push(fail(null, null, `clipboard gate: ${what} must be defined exactly once in loader/ (found ${defs[key].length})`));
      return null;
    }
    return defs[key][0];
  };
  const returnsOf = (d) => [...d.sc.code.slice(d.fn.bodyStart + 1, d.fn.bodyEnd - 1).matchAll(/\breturn\b\s*([^;\n}]*)/g)].map((m) => m[1].trim());
  const bodyOf = (d) => d.sc.code.slice(d.fn.bodyStart, d.fn.bodyEnd);
  for (const [key, tail] of [['request', 'clipboardAllowed'], ['check', 'clipboardChecked']]) {
    const d = once(key, CLIP_FN[key]);
    if (!d) continue;
    const rets = returnsOf(d);
    const body = bodyOf(d);
    const where = (m) => at('fail', d.file, d.sc, d.fn.bodyStart, `${CLIP_FN[key]}: ${m}`);
    if (!rets.length) out.push(where('has no return'));
    for (const r of rets.slice(0, -1)) if (r !== 'false') out.push(where(`a return other than the last is '${r.slice(0, 40)}', not false`));
    if (rets.length && !new RegExp(`^${PLAIN_ARG}\\s*\\.\\s*${tail}\\s*\\(\\s*${PLAIN_ARG}(?:\\s*,\\s*${PLAIN_ARG})*\\s*\\)\\s*===\\s*true$`).test(rets[rets.length - 1])) {
      out.push(where(`the last return must be <gate>.${tail}(...) === true (found '${rets[rets.length - 1].slice(0, 60)}')`));
    }
    if (!/!==\s*['"]clipboard-read['"]/.test(body) || !/!==\s*['"]clipboard-sanitized-write['"]/.test(body)) {
      out.push(where("must refuse every permission but 'clipboard-read' and 'clipboard-sanitized-write'"));
    }
    if (/media|audio|video|camera/i.test(body)) out.push(where('must not mention media devices (the microphone has its own gate)'));
  }
  for (const [key, label] of [['reqMethod', 'clipboardAllowed'], ['chkMethod', 'clipboardChecked']]) {
    const d = once(key, `DeviceGate.${label}`);
    if (!d) continue;
    const rets = returnsOf(d);
    if (!/\b_why\s*\([^)]*['"]clipboard['"]\s*\)/.test(bodyOf(d)) || !rets.length || !/===\s*null$/.test(rets[rets.length - 1])) {
      out.push(at('fail', d.file, d.sc, d.fn.bodyStart, `DeviceGate.${label} must decide with _why(..., 'clipboard') === null`));
    }
  }
  return out;
}

function microphoneGateProblems(tree) {
  const out = [];
  const defs = { request: [], check: [], why: [], reqMethod: [], chkMethod: [] };
  const names = { request: GATE_FN.request, check: GATE_FN.check, why: '_why', reqMethod: 'requestAllowed', chkMethod: 'checkAllowed' };
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    for (const [key, name] of Object.entries(names)) for (const fn of findFunctions(sc, name)) defs[key].push({ file, sc, fn });
  }
  const once = (key, what) => {
    if (defs[key].length !== 1) {
      out.push(fail(null, null, `microphone gate: ${what} must be defined exactly once in loader/ (found ${defs[key].length})`));
      return null;
    }
    return defs[key][0];
  };
  const returnsOf = (d) => [...d.sc.code.slice(d.fn.bodyStart + 1, d.fn.bodyEnd - 1).matchAll(/\breturn\b\s*([^;\n}]*)/g)].map((m) => m[1].trim());
  const bodyOf = (d) => d.sc.code.slice(d.fn.bodyStart, d.fn.bodyEnd);

  for (const [key, tail] of [['request', 'requestAllowed'], ['check', 'checkAllowed']]) {
    const d = once(key, GATE_FN[key]);
    if (!d) continue;
    const rets = returnsOf(d);
    const body = bodyOf(d);
    const where = (m) => at('fail', d.file, d.sc, d.fn.bodyStart, `${GATE_FN[key]}: ${m}`);
    if (!rets.length) out.push(where('has no return'));
    for (const r of rets.slice(0, -1)) if (r !== 'false') out.push(where(`a return other than the last is '${r.slice(0, 40)}', not false`));
    if (rets.length && !new RegExp(`^${PLAIN_ARG}\\s*\\.\\s*${tail}\\s*\\(\\s*${PLAIN_ARG}(?:\\s*,\\s*${PLAIN_ARG})*\\s*\\)\\s*===\\s*true$`).test(rets[rets.length - 1])) {
      out.push(where(`the last return must be <gate>.${tail}(...) === true (found '${rets[rets.length - 1].slice(0, 60)}')`));
    }
    if (!/!==\s*['"]media['"]/.test(body)) out.push(where("must refuse every permission but 'media' (permission !== 'media')"));
    if (!/['"]audio['"]/.test(body)) out.push(where("must name 'audio' (the only media type)"));
    if (/video|camera/i.test(body)) out.push(where('must not mention video or camera (the camera is reserved and never allowed)'));
    if (key === 'request' && !(/length\s*!==\s*1/.test(body) && /\[\s*0\s*\]\s*!==\s*['"]audio['"]/.test(body))) out.push(where("must require mediaTypes to be exactly ['audio'] (length !== 1, [0] !== 'audio')"));
    if (key === 'check' && !/mediaType\s*!==\s*['"]audio['"]/.test(body)) out.push(where("must require mediaType === 'audio'"));
  }
  for (const [key, label] of [['reqMethod', 'requestAllowed'], ['chkMethod', 'checkAllowed']]) {
    const d = once(key, `DeviceGate.${label}`);
    if (!d) continue;
    const rets = returnsOf(d);
    if (!/\b_why\s*\(/.test(bodyOf(d)) || !rets.length || !/===\s*null$/.test(rets[rets.length - 1])) {
      out.push(at('fail', d.file, d.sc, d.fn.bodyStart, `DeviceGate.${label} must decide with _why(...) === null`));
    }
  }
  const why = once('why', 'DeviceGate._why');
  if (why) {
    const body = bodyOf(why);
    for (const [re, what] of [
      [/\bdeviceAllowed\s*\(/, 'the manifest-and-grant decision deviceAllowed(...)'],
      [/\bregistry\s*\.\s*get\s*\(/, "the window registry lookup (the request must come from this app's own window)"],
      [/\brec\s*\.\s*appId\s*!==\s*appId/, 'the check that the window belongs to the app'],
      [/isMainFrame/, 'the main-frame check'],
      [/vmapp-ui:\/\//, "the app's own origin check"],
      [/['"]microphone['"]/, "the 'microphone' device name"],
      [/device\s*!==\s*['"]microphone['"]\s*&&\s*device\s*!==\s*['"]clipboard['"]/, 'the check that the device is one a window may use (microphone, clipboard)'],
    ]) {
      if (!re.test(body)) out.push(at('fail', why.file, why.sc, why.fn.bodyStart, `DeviceGate._why is missing ${what}`));
    }
    if (/return\s+true\b/.test(body)) out.push(at('fail', why.file, why.sc, why.fn.bodyStart, 'DeviceGate._why must return a reason or null, never true'));
  }
  return out;
}

/** SPEC 7's window-feature table: feature -> the sources it adds, e.g. { workers: "worker-src 'self' blob:" }. */
function specFeatureTable(tree) {
  if (!tree.exists('SPEC.md')) return null;
  const sec = (tree.read('SPEC.md').split(/^## 7\./m)[1] || '').split(/^## /m)[0];
  const table = {};
  for (const m of sec.matchAll(/^\s*\|\s*`([a-z-]+)`\s*\|\s*`([^`]+)`\s*\|/gm)) table[m[1]] = normCsp(m[2]);
  return Object.keys(table).length ? table : null;
}
/** SPEC 7's CSP of vmapp-frame responses (the backtick string that names vmapp-frame: in default-src). */
function specFrameCsp(tree) {
  if (!tree.exists('SPEC.md')) return null;
  const sec = (tree.read('SPEC.md').split(/^## 7\./m)[1] || '').split(/^## /m)[0];
  const m = /`(default-src 'self' vmapp-frame:[^`]*)`/.exec(sec);
  return m ? m[1] : null;
}

// The one window feature that may name network sources (SPEC 7, 8.3 "The app's windows", DEV-APPS C3): data directives only.
const NETWORK_FEATURE = 'network';
const NETWORK_FEATURE_SOURCES = Object.freeze({ 'connect-src': ['https:', 'wss:'], 'img-src': ['https:'], 'media-src': ['https:'], 'font-src': ['https:'], 'style-src': ['https:'] });

// Requests windowNetAllowed must refuse whatever the endpoint state: [url, resourceType]. Code and documents from the network,
// other schemes, addresses and local names, credentials in the URL.
const WINDOW_NET_REFUSED = [
  ['http://a.example.com/x', 'xhr'],
  ['ws://a.example.com/x', 'webSocket'],
  ['ftp://a.example.com/x', 'other'],
  ['file:///etc/passwd', 'xhr'],
  ['https://a.example.com/x.js', 'script'],
  ['https://a.example.com/', 'subFrame'],
  ['https://a.example.com/', 'mainFrame'],
  ['https://a.example.com/x', 'object'],
  ['https://a.example.com/x', 'ping'],
  ['https://a.example.com/x', 'cspReport'],
  ['https://a.example.com/x', 'other'],
  ['https://a.example.com/x', undefined],
  ['https://127.0.0.1/', 'xhr'],
  ['https://0x7f.1/', 'image'],
  ['https://2130706433/', 'image'],
  ['https://[::1]/', 'xhr'],
  ['https://[::ffff:192.168.0.1]/', 'xhr'],
  ['https://192.168.1.1:8443/', 'xhr'],
  ['https://localhost/', 'xhr'],
  ['https://a.localhost/', 'xhr'],
  ['https://printer.local/', 'image'],
  ['https://nas.lan/', 'image'],
  ['https://router.home.arpa/', 'image'],
  ['https://intranet/', 'xhr'],
  ['https://user:pw@a.example.com/', 'xhr'],
  ['wss://127.0.0.1/', 'webSocket'],
];

/**
 * The window network (SPEC 7, 8.3 "The app's windows"): loader/src/window-net.js, self-contained, is evaluated in a fresh context
 * and must refuse every WINDOW_NET_REFUSED vector with an endpoint, and everything without one; the proxy authentication is
 * answered only by windowProxyCredentials for the endpoint of a running app's own partition; only the window manager sets a
 * proxy, the app's own endpoint with <-loopback>; the session never logs the run's secret.
 */
function windowNetProblems(tree, { filterUsesIt = true } = {}) {
  const out = [];
  const f = 'loader/src/window-net.js';
  const exists = tree.exists(f);
  if (!exists && filterUsesIt) return [fail(f, null, 'missing: the decision which requests of an app window may leave (SPEC 8.3 "The app\'s windows")')];
  const code = exists ? tree.read(f) : 'module.exports = { windowNetAllowed: () => false };';
  if (/\brequire\s*\(|\bimport\b|\bprocess\b|\bglobalThis\b/.test(code)) out.push(fail(f, null, 'window-net.js must be self-contained (no require, import, process or globalThis): the checker evaluates it'));
  let allowed = null;
  try {
    const mod = { exports: {} };
    vm.runInNewContext(code, { module: mod, exports: mod.exports, URL }, { timeout: 1000, filename: f });
    allowed = mod.exports.windowNetAllowed;
  } catch (e) {
    out.push(fail(f, null, `window-net.js does not evaluate: ${e.message}`));
  }
  if (typeof allowed !== 'function') {
    if (!out.length) out.push(fail(f, null, 'window-net.js exports no windowNetAllowed function'));
  } else {
    const ask = (state, url, resourceType) => {
      try {
        return allowed(state, { url, resourceType }) === true;
      } catch {
        return false; // a throw cancels nothing in Electron's filter: it counts as a refusal only because the filter's `!(...)` sees no true
      }
    };
    for (const state of [{ host: '127.0.0.1', port: 51234, username: 'vmapp', password: 'x' }]) {
      for (const [url, type] of WINDOW_NET_REFUSED) if (ask(state, url, type)) out.push(fail(f, null, `windowNetAllowed lets ${url} (${type}) out`));
    }
    for (const state of [null, undefined, {}]) {
      for (const [url, type] of [['https://a.example.com/x', 'xhr'], ['https://a.example.com/x.png', 'image'], ['wss://a.example.com/', 'webSocket']]) {
        if (ask(state, url, type)) out.push(fail(f, null, `windowNetAllowed lets ${url} (${type}) out without a window endpoint (${JSON.stringify(state)})`));
      }
    }
  }
  // the proxy authentication: only the window endpoint of a running app, only for that app's own partition
  const wm = 'loader/src/window-manager.js';
  const w = tree.exists(wm) ? tree.read(wm) : '';
  const cred = /function\s+windowProxyCredentials\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(w);
  if (cred) {
    for (const [re, what] of [
      [/authInfo\.isProxy\s*!==\s*true/, 'the check that it is a proxy authentication'],
      [/authInfo\.host\s*!==\s*p\.host/, "the endpoint's host"],
      [/Number\(authInfo\.port\)\s*!==\s*p\.port/, "the endpoint's port"],
      [/webContents\.session\s*!==\s*electronSession\.fromPartition\(partitionOf\(appId\)\)/, "the check that the request comes from the app's own partition"],
    ]) {
      if (!re.test(cred[1])) out.push(fail(wm, null, `windowProxyCredentials is missing ${what}`));
    }
  }
  const main = 'loader/main.js';
  const mainCode = tree.exists(main) ? tree.read(main) : '';
  // none (Electron cancels every authentication), or exactly this one
  const logins = [...mainCode.matchAll(/\.on\(\s*['"]login['"]/g)];
  const handler = /app\.on\(\s*['"]login['"]\s*,\s*\(event,\s*webContents,\s*details,\s*authInfo,\s*callback\)\s*=>\s*\{\s*const\s+creds\s*=\s*windowProxyCredentials\(webContents,\s*authInfo\);\s*if\s*\(!creds\)\s*return;\s*event\.preventDefault\(\);\s*callback\(creds\.username,\s*creds\.password\);\s*\}\);/;
  if (logins.length > 1 || (logins.length === 1 && !(handler.test(mainCode) && cred))) {
    out.push(fail(main, null, "the one 'login' handler must answer only with windowProxyCredentials(webContents, authInfo) (window-manager.js) and cancel everything else"));
  }
  for (const lf of prodJs(tree, 'loader')) {
    if (lf === main) continue;
    if (/\.on\(\s*['"]login['"]/.test(tree.read(lf))) out.push(fail(lf, null, "a 'login' handler outside loader/main.js"));
  }
  // the proxy setting: only the window manager, only the run's endpoint, loopback not bypassed
  for (const lf of prodJs(tree, 'loader')) {
    if (lf !== wm && /\bsetProxy\s*\(/.test(tree.read(lf))) out.push(fail(lf, null, 'setProxy outside loader/src/window-manager.js (only the window endpoint may be an app partition\'s proxy)'));
  }
  const calls = [...w.matchAll(/\bsetProxy\s*\(/g)].length;
  const proxies = [...w.matchAll(/\bsetProxy\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;/g)].map((x) => x[1]);
  if (proxies.length !== calls) out.push(fail(wm, null, 'every setProxy must take an object literal (so that this rule can read it)'));
  const ENDPOINT = /^\s*mode:\s*'fixed_servers',\s*proxyRules:\s*`http=\$\{at\};https=\$\{at\}`,\s*proxyBypassRules:\s*'<-loopback>'\s*$/;
  for (const p of proxies) {
    if (!/^\s*mode:\s*'direct'\s*$/.test(p) && !ENDPOINT.test(p)) out.push(fail(wm, null, `an app partition's proxy must be the run's window endpoint (http and https, <-loopback>) or direct: { ${p.trim()} }`));
  }
  if (proxies.length && !/const\s+at\s*=\s*`\$\{proxy\.host\}:\$\{proxy\.port\}`/.test(w)) out.push(fail(wm, null, "the proxy address must be the session's windowProxy (proxy.host, proxy.port)"));
  // the filter may let requests out only once the partition's proxy IS the endpoint: windowNet.set happens in openWindowNet alone,
  // after that function has awaited the endpoint setProxy (otherwise the window's requests would go out directly)
  const sets = [...w.matchAll(/\bwindowNet\.set\s*\(/g)].length;
  const open = /function\s+openWindowNet\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(w);
  if (sets) {
    const body = open ? open[1] : '';
    const iProxy = body.search(/await\s+ses\.setProxy\(\s*\{\s*mode:\s*'fixed_servers'/);
    const iSet = body.search(/\bwindowNet\.set\s*\(\s*appId\s*,\s*proxy\s*\)/);
    if (sets !== 1 || !open || iProxy < 0 || iSet < 0 || iSet < iProxy) {
      out.push(fail(wm, null, "windowNet.set (which opens the request filter) must happen only in openWindowNet, after `await ses.setProxy({ mode: 'fixed_servers', … })`"));
    }
  }
  // the run's secret: given to vmapp-vm on stdin, kept in memory; never logged
  const ses = 'hostlib/session.js';
  if (tree.exists(ses)) {
    const s = tree.read(ses);
    for (const mm of s.matchAll(/\blog\s*\(([^;]*)\)\s*;/g)) {
      if (/\bsecret\b|\.password\b/.test(mm[1])) out.push(fail(ses, null, `a log line names the window endpoint's secret: log(${mm[1].slice(0, 80)})`));
    }
    if (/window-proxy/.test(s) && !/_writeStdin\(\s*\{\s*op:\s*'window-proxy',\s*secret\s*\}\s*\)/.test(s)) out.push(fail(ses, null, "the window endpoint's secret must go to vmapp-vm on stdin only (_writeStdin({ op: 'window-proxy', secret }))"));
  }
  return out;
}

/**
 * Window features (SPEC 2.2 ui.features, SPEC 7): the loader's UI_FEATURE_CSP equals SPEC 7's table, adds no network source and no
 * unsafe-inline/unsafe-eval to the page; FRAME_CSP equals SPEC 7's frame CSP and has no network source; the vmapp-ui handler answers
 * with appCsp(<the installed manifest's ui.features>) and the vmapp-frame handler with FRAME_CSP.
 */
function featureProblems(tree) {
  const out = [];
  const file = 'loader/src/protocols.js';
  if (!tree.exists(file)) return out;
  const code = tree.read(file);
  const m = /const\s+UI_FEATURE_CSP\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(code);
  const spec = specFeatureTable(tree);
  if (m) {
    const table = {};
    for (const row of m[1].matchAll(/['"]?([a-z-]+)['"]?\s*:\s*Object\.freeze\(\{([^{}]*)\}\)/g)) {
      const feature = row[1];
      const parts = [];
      for (const d of row[2].matchAll(/['"]([a-z-]+)['"]\s*:\s*Object\.freeze\(\[([^\]]*)\]\)/g)) {
        const dir = d[1];
        const srcs = [...d[2].matchAll(/["']((?:'[^']*')|[^"']+)["']/g)].map((x) => x[1]);
        parts.push(`${dir} ${srcs.join(' ')}`);
        for (const s of srcs) {
          if (s === "'unsafe-inline'" || s === "'unsafe-eval'" || s === '*' || /^(http:|ws:)/.test(s)) {
            out.push(fail(file, null, `UI_FEATURE_CSP.${feature} adds ${s} to ${dir} (no unsafe-inline/unsafe-eval, *, http: or ws: for the page)`));
          } else if (/^(https:|wss:)/.test(s) && !(feature === NETWORK_FEATURE && (NETWORK_FEATURE_SOURCES[dir] || []).includes(s))) {
            out.push(fail(file, null, `UI_FEATURE_CSP.${feature} adds the network source ${s} to ${dir} (only "network" may, and only ${JSON.stringify(NETWORK_FEATURE_SOURCES)})`));
          }
        }
      }
      table[feature] = normCsp(parts.join('; '));
    }
    if (!spec) out.push(fail('SPEC.md', null, "cannot read SPEC 7's window-feature table"));
    else if (JSON.stringify(table) !== JSON.stringify(spec)) out.push(fail(file, null, `UI_FEATURE_CSP differs from SPEC 7's table: ${JSON.stringify(table)} vs ${JSON.stringify(spec)}`));
  }
  const fm = /const\s+FRAME_CSP\s*=\s*((?:\s*(?:'[^']*'|"[^"]*")\s*\+?)+);/.exec(code);
  if (fm) {
    const value = [...fm[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => (x[1] !== undefined ? x[1] : x[2])).join('');
    const sf = specFrameCsp(tree);
    if (!sf) out.push(fail('SPEC.md', null, "cannot read SPEC 7's frame CSP"));
    else if (normCsp(value) !== normCsp(sf)) out.push(fail(file, null, "FRAME_CSP differs from SPEC 7's frame CSP"));
    if (/\bhttp:|\bwss?:|\s\*(\s|;|$)/.test(value)) out.push(fail(file, null, 'FRAME_CSP names http:, ws(s): or * (only https: for service-worker answers)'));
  } else if (/vmapp-frame/.test(code)) out.push(fail(file, null, 'vmapp-frame is served but FRAME_CSP is not a plain string constant'));
  // the network boundary of app windows and their frames (SPEC 7): the partition's request filter refuses every network scheme
  const wm = 'loader/src/window-manager.js';
  if (tree.exists(wm)) {
    const w = tree.read(wm);
    const rm = /const\s+allowedSchemes\s*=\s*\/(.+)\/([a-z]*);/.exec(w);
    if (!rm) out.push(fail(wm, null, 'the app partition request filter (allowedSchemes) is not a plain regular expression'));
    else {
      let re = null;
      try {
        re = new RegExp(rm[1], rm[2]);
      } catch {
        out.push(fail(wm, null, 'allowedSchemes does not compile'));
      }
      if (re) for (const u of ['http://example.com/', 'https://example.com/', 'ws://example.com/', 'wss://example.com/', 'file:///etc/passwd', 'ftp://x/']) if (re.test(u)) out.push(fail(wm, null, `the app partition request filter lets ${u.split(':')[0]}: through`));
    }
    // the filter: allowedSchemes alone, or with its one exception, the window network of SPEC 8.3 "The app's windows"
    // (windowNetAllowed with this run's endpoint, from the module windowNetProblems evaluates)
    const plain = /onBeforeRequest\s*\(\s*\(details,\s*callback\)\s*=>\s*callback\(\{\s*cancel:\s*!allowedSchemes\.test\(details\.url\)\s*\}\)\s*\)/.test(w);
    const withNet = /onBeforeRequest\s*\(\s*\(details,\s*callback\)\s*=>\s*callback\(\{\s*cancel:\s*!\(allowedSchemes\.test\(details\.url\)\s*\|\|\s*windowNetAllowed\(windowNet\.get\(appId\),\s*details\)\)\s*\}\)\s*\)/.test(w);
    const filters = [...w.matchAll(/\bonBeforeRequest\s*\(/g)].length;
    if (!(plain || withNet) || filters !== 1) {
      out.push(fail(wm, null, 'the app partition must cancel every request that allowedSchemes refuses (with, at most, the exception windowNetAllowed(windowNet.get(appId), details)), in one filter'));
    }
    if (withNet) {
      if (!/const\s*\{\s*windowNetAllowed\s*\}\s*=\s*require\(\s*['"]\.\/window-net['"]\s*\)/.test(w)) out.push(fail(wm, null, 'windowNetAllowed must come from ./window-net (the module this rule checks)'));
      out.push(...windowNetProblems(tree));
    } else out.push(...windowNetProblems(tree, { filterUsesIt: false }));
  }
  if (m && /function\s+createAppUiHandler/.test(code) && !/serveVerified\s*\([^)]*appCsp\s*\(\s*ctx\.app\.manifest\.ui\.features\s*\)/.test(code)) {
    out.push(fail(file, null, 'the vmapp-ui handler does not answer with appCsp(ctx.app.manifest.ui.features)'));
  }
  if (/function\s+createAppFrameHandler/.test(code) && !/serveVerified\s*\([^)]*\bFRAME_CSP\b/.test(code)) out.push(fail(file, null, 'the vmapp-frame handler does not answer with FRAME_CSP'));
  return out;
}

function ruleB3(tree) {
  const out = [];
  const spec = specCsp(tree);
  if (!spec) out.push(fail('SPEC.md', null, "cannot extract SPEC 7's CSP string"));
  out.push(...featureProblems(tree));
  const consts = cspConstants(tree);
  const appConsts = consts.filter((c) => /app|ui|vmapp/i.test(c.name) && !/loader|frame/i.test(c.name));
  if (!appConsts.length) out.push(fail(null, null, 'no CSP constant for vmapp-ui responses found in loader/ (expected e.g. APP_CSP)'));
  for (const c of appConsts) {
    if (spec) {
      for (const p of cspProblems(c.value, spec)) out.push(at('fail', c.file, c.sc, c.idx, `${c.name}: ${p}`));
    }
  }
  // the CSP must actually be sent on responses of the vmapp-ui handler
  const handlers = findAppUiHandlers(tree);
  for (const h of handlers) {
    const body = h.sc.code.slice(h.fn.bodyStart, h.fn.bodyEnd);
    const names = appConsts.filter((c) => c.file === h.file).map((c) => c.name);
    const allNames = appConsts.map((c) => c.name);
    for (const rc of findCalls({ code: body, skel: h.sc.skel.slice(h.fn.bodyStart, h.fn.bodyEnd) }, /\brespond\s*\(/)) {
      const last = rc.args[rc.args.length - 1];
      const t = last ? last.text.trim() : '';
      if (!(names.includes(t) || allNames.includes(t))) {
        out.push(at('fail', h.file, h.sc, h.fn.bodyStart + rc.index, `vmapp-ui response without the app CSP (last argument is '${t.slice(0, 40)}')`));
      }
    }
    const raw = /new\s+Response\s*\(/g;
    let rm;
    const sk = h.sc.skel.slice(h.fn.bodyStart, h.fn.bodyEnd);
    while ((rm = raw.exec(sk))) {
      const around = body.slice(rm.index, rm.index + 500).toLowerCase();
      if (!around.includes('content-security-policy')) out.push(at('fail', h.file, h.sc, h.fn.bodyStart + rm.index, 'vmapp-ui handler builds a Response without a content-security-policy header'));
    }
  }
  // respond() helper must set the header
  for (const h of handlers) {
    for (const fn of findFunctions(h.sc, 'respond')) {
      if (!/content-security-policy/i.test(h.sc.code.slice(fn.bodyStart, fn.bodyEnd))) out.push(at('fail', h.file, h.sc, fn.bodyStart, 'respond() does not set the content-security-policy header'));
    }
  }

  // window.open denied
  let sawOpen = 0;
  let sawReq = 0;
  let sawCheck = 0;
  let sawNav = 0;
  let usesGate = false; // a permission handler answers through the microphone gate: its definition is checked after the loop
  let usesClip = false; // ... through the clipboard gate
  const appFiles = new Set(findWindows(tree).map((w) => w.file));
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    for (const c of findCalls(sc, /\bsetWindowOpenHandler\s*\(/)) {
      sawOpen++;
      const fn = c.args[0] && resolveCallable(sc, c.args[0]);
      const body = fn ? expandedBody(sc, fn, 1) : '';
      if (!fn) out.push(at('fail', file, sc, c.index, 'setWindowOpenHandler: handler is not a resolvable function'));
      else if (!/action\s*:\s*['"]deny['"]/.test(body) || /action\s*:\s*['"]allow['"]/.test(body) || /\bwindowOpenHandler\b.*allow/.test(body)) {
        out.push(at('fail', file, sc, c.index, "setWindowOpenHandler must return { action: 'deny' } on every path"));
      }
    }
    // permission request handlers: every path must call the callback with false
    for (const c of findCalls(sc, /\bsetPermissionRequestHandler\s*\(/)) {
      sawReq++;
      const a = c.args[0];
      if (!a || a.text.trim() === 'null') {
        out.push(at('fail', file, sc, c.index, 'setPermissionRequestHandler(null) restores the default (permissive) behaviour'));
        continue;
      }
      const fn = resolveCallable(sc, a);
      if (!fn) {
        out.push(at('fail', file, sc, c.index, 'setPermissionRequestHandler: handler is not a resolvable function'));
        continue;
      }
      const cb = fn.params[2];
      const body = sc.code.slice(fn.bodyStart, fn.bodyEnd);
      const calls = cb ? findCalls({ code: body, skel: sc.skel.slice(fn.bodyStart, fn.bodyEnd) }, new RegExp(`(?<![\\w$.])${cb}\\s*\\(`)) : [];
      if (!cb || !calls.length) out.push(at('fail', file, sc, c.index, 'setPermissionRequestHandler: handler never calls its callback with false'));
      for (const k of calls) {
        const arg = k.args.length === 1 ? k.args[0].text.trim() : null;
        // `false`, or the one answer SPEC 7 allows to be anything else: the microphone gate (verified below)
        if (arg === 'false') continue;
        if (arg !== null && GATE_CALL.request.test(arg)) {
          usesGate = true;
          continue;
        }
        if (arg !== null && CLIP_CALL.request.test(arg)) {
          usesClip = true;
          continue;
        }
        out.push(at('fail', file, sc, c.index, `setPermissionRequestHandler: ${cb}(${k.args.map((x) => x.text).join(', ')}) is not an unconditional deny (only false, ${GATE_FN.request}(<5 plain arguments>) or ${CLIP_FN.request}(<5 plain arguments>) are allowed)`));
      }
      if (cb && new RegExp(`[^\\w$.]${cb}(?!\\s*\\()`).test(body.replace(/^\s*/, ' '))) out.push(at('fail', file, sc, c.index, `setPermissionRequestHandler: callback '${cb}' escapes (passed or stored)`));
    }
    // permission check / device handlers: return false on every path
    for (const c of [...findCalls(sc, /\bsetPermissionCheckHandler\s*\(/), ...findCalls(sc, /\bsetDevicePermissionHandler\s*\(/)]) {
      if (/setPermissionCheckHandler/.test(c.head)) sawCheck++;
      const a = c.args[0];
      if (!a || a.text.trim() === 'null') {
        out.push(at('fail', file, sc, c.index, `${c.head.replace(/\s*\($/, '')}(null) restores the default behaviour`));
        continue;
      }
      const fn = resolveCallable(sc, a);
      if (!fn) {
        out.push(at('fail', file, sc, c.index, 'permission check handler is not a resolvable function'));
        continue;
      }
      // an answer is `false`, or (setPermissionCheckHandler only) the microphone gate's check, verified below
      const answerOk = (t) =>
        t === 'false' ||
        (/setPermissionCheckHandler/.test(c.head) && GATE_CALL.check.test(t) && (usesGate = true)) ||
        (/setPermissionCheckHandler/.test(c.head) && CLIP_CALL.check.test(t) && (usesClip = true));
      if (!fn.block) {
        if (!answerOk(sc.code.slice(fn.bodyStart, fn.bodyEnd).trim())) out.push(at('fail', file, sc, c.index, `permission check handler must be an unconditional "return false" (or ${GATE_FN.check}(<5 plain arguments>))`));
      } else {
        const body = sc.code.slice(fn.bodyStart + 1, fn.bodyEnd - 1);
        const rets = [...body.matchAll(/\breturn\b\s*([^;\n}]*)/g)].map((m) => m[1].trim());
        if (!rets.length || rets.some((r) => !answerOk(r))) out.push(at('fail', file, sc, c.index, 'permission check handler must return false on every path'));
      }
    }
    // navigation guards
    for (const c of findCalls(sc, /\.\s*(?:on|once|prependListener|addListener)\s*\(/)) {
      const ev = c.args[0] ? evalStringExpr(c.args[0].text) : null;
      if (ev !== 'will-navigate') continue;
      sawNav++;
      const fn = c.args[1] && resolveCallable(sc, c.args[1]);
      if (!fn || !/\bpreventDefault\s*\(/.test(expandedBody(sc, fn, 2))) out.push(at('fail', file, sc, c.index, 'will-navigate handler never calls preventDefault()'));
    }
  }
  if (usesGate) out.push(...microphoneGateProblems(tree));
  if (usesClip) out.push(...clipboardGateProblems(tree));
  if (!sawOpen) out.push(fail(null, null, 'no setWindowOpenHandler found in loader/ (window.open must be denied)'));
  if (!sawReq) out.push(fail(null, null, 'no setPermissionRequestHandler found in loader/ (permission requests must be denied)'));
  if (!sawCheck) out.push(fail(null, null, 'no setPermissionCheckHandler found in loader/ (permission checks must be denied)'));
  if (!sawNav) out.push(fail(null, null, 'no will-navigate guard found in loader/ (navigation outside the app origin must be blocked)'));
  else {
    // the guard must cover app windows: registered globally (web-contents-created) or in an app-window file
    let covered = false;
    for (const file of prodJs(tree, LOADER)) {
      const sc = tree.scan(file, 'js');
      const wcc = findCalls(sc, /\.\s*on\s*\(\s*['"]web-contents-created['"]\s*,/);
      for (const w of wcc) {
        if (/['"]will-navigate['"]/.test(sc.code.slice(w.open, w.close))) covered = true;
      }
      if (appFiles.has(file) && /['"]will-navigate['"]/.test(sc.code)) covered = true;
    }
    if (!covered) out.push(fail(null, null, "will-navigate is not guarded for app windows (register it in app.on('web-contents-created') or where app windows are created)"));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ B4

/**
 * The function that actually serves package files for handler `h`: the handler itself, or the shared `serveVerified` it calls
 * (vmapp-ui and vmapp-frame serve the same verified files, SPEC 7). Returns { fn } in h's file.
 */
function servingFunction(h) {
  const body = h.sc.code.slice(h.fn.bodyStart, h.fn.bodyEnd);
  if (/\bserveVerified\s*\(/.test(body)) {
    const sv = findFunctions(h.sc, 'serveVerified').find((f) => /createHash/.test(h.sc.code.slice(f.bodyStart, f.bodyEnd)));
    if (sv) return sv;
  }
  return h.fn;
}

function ruleB4(tree) {
  const out = [];
  const handlers = findAppUiHandlers(tree);
  if (!handlers.length) return [fail(null, null, 'vmapp-ui handler (createAppUiHandler / handleAppUi) not found in loader/')];
  // isolated frames (SPEC 7): the vmapp-frame handler must serve through the same verified path
  for (const file of prodJs(tree, LOADER)) {
    const sc = tree.scan(file, 'js');
    for (const fn of findFunctions(sc, 'createAppFrameHandler')) {
      const b = sc.code.slice(fn.bodyStart, fn.bodyEnd);
      if (!/request/.test(b)) continue;
      if (!/\bserveVerified\s*\(/.test(b)) out.push(at('fail', file, sc, fn.bodyStart, 'the vmapp-frame handler does not serve through serveVerified (manifest lookup, SHA-256)'));
      if (!/includes\s*\(\s*['"]frames['"]\s*\)/.test(b)) out.push(at('fail', file, sc, fn.bodyStart, 'the vmapp-frame handler does not require the feature "frames" of the installed manifest'));
    }
  }
  const files = [...new Set(handlers.map((h) => h.file))];
  for (const file of files) {
    const sc = tree.scan(file, 'js');
    const h0 = handlers.find((x) => x.file === file);
    const h = Object.assign({}, h0, { fn: servingFunction(h0) });
    const body = sc.code.slice(h.fn.bodyStart, h.fn.bodyEnd);
    // 1. only files listed in the manifest
    if (!/\.\s*files\b/.test(body)) out.push(at('fail', file, sc, h.fn.bodyStart, 'handler does not consult the manifest `files` table'));
    // 2. SHA-256 computed and compared
    const hashVars = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*[^;]*createHash\s*\(\s*['"]sha256['"]\s*\)[^;]*\.digest\s*\(/g)].map((m) => m[1]);
    if (!/createHash\s*\(\s*['"]sha256['"]\s*\)/.test(body)) out.push(at('fail', file, sc, h.fn.bodyStart, 'handler never computes a SHA-256 of the served file'));
    else {
      // variables that hold a value read from the manifest `files` table
      const filesVars = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?![=>])\s*[^;]*\.\s*files\b[^;]*;/g)].map((m) => m[1]);
      const ID = '([A-Za-z_$][\\w$.]*(?:\\[[^\\]]*\\])?)';
      let compared = false;
      let tied = false;
      for (const v of hashVars) {
        const e = v.replace(/\$/g, '\\$');
        const partners = [
          ...body.matchAll(new RegExp(`\\b${e}\\b\\s*(?:!==|===|!=|==)\\s*${ID}`, 'g')),
          ...body.matchAll(new RegExp(`${ID}\\s*(?:!==|===|!=|==)\\s*\\b${e}\\b`, 'g')),
          ...body.matchAll(new RegExp(`timingSafeEqual\\s*\\([^)]*\\b${e}\\b[^)]*\\)`, 'g')),
        ];
        for (const p of partners) {
          compared = true;
          const text = p[1] || p[0];
          if (/\.\s*files\b/.test(text) || filesVars.includes(text.split(/[.[]/)[0]) || /timingSafeEqual/.test(p[0])) tied = true;
        }
      }
      if (!hashVars.length || !compared) out.push(at('fail', file, sc, h.fn.bodyStart, 'the computed SHA-256 is never compared with the manifest hash'));
      else if (!tied) out.push(at('warn', file, sc, h.fn.bodyStart, 'the SHA-256 is compared with something that is not visibly read from the manifest `files` table'));
    }
    // 3. containment + no symlinks (the path cleaner may be a helper called by the handler)
    const helper = expandedBody(sc, h.fn, 3);
    const containment = /['"]\.\.['"]/.test(helper) || /\.startsWith\s*\(/.test(helper) || /path\.relative\s*\(/.test(helper);
    if (!containment) out.push(at('fail', file, sc, h.fn.bodyStart, 'no path containment check (".." / startsWith / path.relative) in the handler or its helpers'));
    if (!/\b(lstat|lstatSync|realpath|realpathSync|isSymbolicLink)\b/.test(helper)) out.push(at('fail', file, sc, h.fn.bodyStart, 'no symlink check (lstat / realpath / isSymbolicLink) in the handler or its helpers'));
    if (!/\bdecodeURIComponent\b|\bnew\s+URL\b/.test(helper)) out.push(at('warn', file, sc, h.fn.bodyStart, 'the handler does not visibly decode the URL path before validating it'));
  }
  return out;
}

module.exports = {
  rules: [
    { id: 'b1-window-prefs', inv: 'INV-B1', name: 'app windows: exact webPreferences, loader preload, own partition', run: ruleB1 },
    { id: 'b2-preload-api', inv: 'INV-B2', name: 'preload-app.js exposes exactly window.vmapp; IPC routed by sender', run: ruleB2 },
    { id: 'b3-csp-nav-perms', inv: 'INV-B3', name: 'CSP equals SPEC 7 (or stricter); popups, navigation, permissions denied', run: ruleB3 },
    { id: 'b4-ui-handler', inv: 'INV-B4', name: 'vmapp-ui handler: manifest lookup, SHA-256 check, containment', run: ruleB4 },
  ],
  // exported for tests
  cspProblems,
  specCsp,
  normCsp,
};
