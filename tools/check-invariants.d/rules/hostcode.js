'use strict';
// INV-A1 (no code execution / no processes outside session.js), INV-G3 (no network from the loader),
// hygiene: no dependencies.

const { builtinModules } = require('module');
const { findCalls, evalStringExpr } = require('../lib/scan');
const { prodJs, fail, warn, at } = require('../lib/tree');

// Host processes: vmapp-vm (session.js only); vmapp-hostctl, user-registered tools and user-registered MCP servers
// (hostproc.js only, started by capabilities.js). INV-A1 / INV-H4.
const SPAWN_FILE = 'hostlib/session.js';
const HOSTPROC_FILE = 'hostlib/hostproc.js';
const SPAWN_FILES = [SPAWN_FILE, HOSTPROC_FILE];
// A command argument that is a plain identifier or member path (this.command[0], file, def.path), not built from strings.
const TRACEABLE_COMMAND = /^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function hostFiles(tree) {
  return [...prodJs(tree, 'loader'), ...prodJs(tree, 'hostlib')];
}

const PLAIN_LITERAL = /^\s*(?:'[^'\\\n]*'|"[^"\\\n]*"|`[^`$\\]*`)\s*$/;

// ------------------------------------------------------------------------------------------------ A1

function ruleA1(tree) {
  const out = [];
  const files = hostFiles(tree);
  if (!files.length) return [fail(null, null, 'no JavaScript found under loader/ or hostlib/')];
  for (const file of files) {
    const sc = tree.scan(file, 'js');
    const hit = (idx, msg, level = 'fail') => out.push(at(level, file, sc, idx, msg));
    const each = (re, msg, level) => {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(sc.skel))) hit(m.index, typeof msg === 'function' ? msg(m) : msg, level);
    };
    each(/(?<![\w$])eval\s*\(/, 'eval(');
    each(/(?<![\w$.])(?:new\s+)?Function\s*\(/, 'Function constructor');
    each(/\bvm\s*\.\s*(?:runIn\w+|Script|compileFunction|SourceTextModule)\b|\bnew\s+vm\.Script\b|\brunIn(?:This|New)Context\s*\(|\bcompileFunction\s*\(/, 'vm code execution');
    each(/\b(?:createRequire|process\s*\.\s*dlopen|process\s*\.\s*binding|Module\s*\.\s*_load|module\s*\.\s*require|process\s*\.\s*mainModule)\b/, (m) => `${m[0].replace(/\s+/g, '')}: dynamic or native code loading`);
    for (const c of findCalls(sc, /(?<![\w$])set(?:Timeout|Interval|Immediate)\s*\(/)) {
      if (c.args[0] && /^['"`]/.test(c.args[0].text.trim())) hit(c.index, 'timer called with a string (eval)');
    }
    for (const kind of ['require', 'import']) {
      for (const c of findCalls(sc, new RegExp(`(?<![\\w$.])${kind}\\s*\\(`))) {
        if (c.args.length !== 1 || !PLAIN_LITERAL.test(c.args[0].text)) hit(c.index, `${kind}() with a non-literal argument`);
        else {
          const spec = evalStringExpr(c.args[0].text);
          if (spec === 'vm' || spec === 'node:vm') hit(c.index, `${kind}('vm')`);
          if (/\.node$/.test(spec)) hit(c.index, `native addon loaded: ${spec}`);
        }
      }
    }
    // child_process: only hostlib/session.js (vmapp-vm) and hostlib/hostproc.js (hostctl, tools, MCP servers)
    const cpRe = /['"`](?:node:)?child_process['"`]/g;
    let m;
    while ((m = cpRe.exec(sc.code))) {
      if (!SPAWN_FILES.includes(file)) hit(m.index, `child_process outside ${SPAWN_FILES.join(' / ')}`);
    }
    each(/\bspawn_sync\b|\bprocess\s*\.\s*binding\s*\(\s*['"]spawn/, 'child process through internals');
    if (SPAWN_FILES.includes(file)) {
      const alias = [...sc.code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/g)].map((x) => x[1]);
      const names = alias.length ? alias.join('|') : 'cp|child_process';
      // no string commands, no fork / sync variants in either file; execFile (argv array, no shell) only in hostproc.js
      const banned = file === HOSTPROC_FILE ? 'exec|execSync|execFileSync|fork|spawnSync' : 'exec|execSync|execFile|execFileSync|fork|spawnSync';
      each(new RegExp(`(?:\\b(?:${names})\\s*\\.\\s*|(?<![\\w$.]))(${banned})\\s*\\(`), (x) => `child_process.${x[1]}() is not allowed (${file === HOSTPROC_FILE ? 'spawn / execFile with an argv array and no shell only' : 'spawn vmapp-vm / the opener only'})`);
      const calls = file === HOSTPROC_FILE ? `(?:spawn|execFile)` : 'spawn';
      for (const c of findCalls(sc, new RegExp(`\\b(?:${names})\\s*\\.\\s*${calls}\\s*\\(`))) {
        if (/\bshell\s*:(?!\s*false\b)/.test(c.args.map((a) => a.text).join(','))) hit(c.index, 'spawn with a shell');
        if (file === HOSTPROC_FILE) {
          // best effort: the command must come from a variable (the hostctl path, a catalog entry), not be assembled here
          const first = c.args[0] ? c.args[0].text.trim() : '';
          if (!TRACEABLE_COMMAND.test(first) && !PLAIN_LITERAL.test(first)) hit(c.index, `child process command '${first.slice(0, 50)}' is not traceable to the hostctl path or the catalog`, 'warn');
        }
      }
    }
    // executing script in a page from the loader
    each(/\bexecuteJavaScript(?:InIsolatedWorld)?\s*\(/, 'executeJavaScript in the loader (review what string it runs)', 'warn');
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ G3

const NET_REQUIRE = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns']);
const URL_OK = /^https?:\/\/(www\.w3\.org|w3\.org)\//i;
// The launcher's own updates (INV-U1): Electron's updater may appear only in these two files, and the only address the loader may name is
// the fixed pages on vmapp.dev that the updater offers to open. The feed itself is asked in hostlib/updates.js (the one network module).
const UPDATER_FILE = 'loader/src/updater.js';
const UPDATER_WIRING = 'loader/main.js';
const UPDATER_PAGE = /^https:\/\/vmapp\.dev\//;

function ruleG3(tree) {
  const out = [];
  for (const file of prodJs(tree, 'loader')) {
    const sc = tree.scan(file, 'js');
    const hit = (idx, msg) => out.push(at('warn', file, sc, idx, msg));
    const each = (re, msg) => {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(sc.skel))) hit(m.index, typeof msg === 'function' ? msg(m) : msg);
    };
    const updaterFile = file === UPDATER_FILE || file === UPDATER_WIRING; // INV-U1 checks these two strictly instead
    each(/(?<![\w$.])fetch\s*\(/, 'fetch() in the loader');
    each(/\bnet\s*\.\s*(?:request|fetch|connect|createConnection)\s*\(/, 'electron net / node net request');
    each(updaterFile ? /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/ : /\b(?:XMLHttpRequest|WebSocket|EventSource|autoUpdater)\b/, (m) => `${m[0]} in the loader`);
    each(/\bsendBeacon\s*\(|\bdownloadURL\s*\(|\bdownloadURL\b/, 'network download API');
    for (const c of findCalls(sc, /(?<![\w$.])require\s*\(/)) {
      const spec = c.args[0] ? evalStringExpr(c.args[0].text) : null;
      if (spec && NET_REQUIRE.has(spec)) hit(c.index, `require('${spec}') in the loader`);
    }
    for (const c of findCalls(sc, /\bimport\s*\(/)) {
      const spec = c.args[0] ? evalStringExpr(c.args[0].text) : null;
      if (spec && NET_REQUIRE.has(spec)) hit(c.index, `import('${spec}') in the loader`);
    }
    const re = /https?:\/\/[^\s'"`)<>]+/g;
    let m;
    while ((m = re.exec(sc.code))) {
      if (!URL_OK.test(m[0]) && !(file === UPDATER_FILE && UPDATER_PAGE.test(m[0]))) hit(m.index, `URL literal ${m[0].slice(0, 80)}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ U1
// INV-U1 (SPEC 8.10): the launcher's own updates. What it checks, in loader/ and hostlib/:
//   - Electron's updater API (autoUpdater, setFeedURL, checkForUpdates(), quitAndInstall) and fetchLauncherFeed appear nowhere but
//     loader/src/updater.js and (the wiring) loader/main.js; fetchLauncherFeed is defined only in hostlib/updates.js;
//   - in updater.js: one call each of setFeedURL (with exactly the feed address the updater was given, as json), checkForUpdates and
//     quitAndInstall, the first two only in install() and the last only in restart(); the automatic path (start, check) never
//     installs or restarts; the only addresses named are pages on vmapp.dev;
//   - in main.js: install and restart are reached only through the library-window-only handlers (upd:install, upd:restart);
//   - in the page: install and restart are called only from a click handler.
// Nothing downloads without "Update now", nothing restarts without "Restart to update".

const UPDATE_API = /\bautoUpdater\b|\bquitAndInstall\s*\(|\bsetFeedURL\s*\(|\.\s*checkForUpdates\s*\(|\bfetchLauncherFeed\b/g;

/** [start, end) of the body of the class method `name` (two-space indent) in `text`, or null. */
function methodSpan(text, name) {
  const head = new RegExp(`^  (?:async )?${name}\\([^\\n]*\\) \\{$`, 'm').exec(text);
  if (!head) return null;
  const from = head.index + head[0].length;
  const next = /^(?:  (?:async |static )?[A-Za-z_]\w*\([^\n]*\) \{|\})$/m.exec(text.slice(from));
  return [head.index, from + (next ? next.index : text.length - from)];
}

function ruleU1(tree) {
  const out = [];
  const outside = (file, sc, re, where) => {
    const g = new RegExp(re.source, re.flags);
    let m;
    while ((m = g.exec(sc.skel))) out.push(at('fail', file, sc, m.index, `${m[0].trim()} outside ${where}`));
  };
  for (const file of prodJs(tree, 'loader')) {
    if (file === UPDATER_FILE || file === UPDATER_WIRING) continue;
    outside(file, tree.scan(file, 'js'), UPDATE_API, `${UPDATER_FILE} and ${UPDATER_WIRING}`);
  }
  for (const file of prodJs(tree, 'hostlib')) {
    if (file === 'hostlib/updates.js') continue;
    outside(file, tree.scan(file, 'js'), /\bfetchLauncherFeed\b/g, 'hostlib/updates.js');
  }

  if (tree.exists(UPDATER_FILE)) {
    const sc = tree.scan(UPDATER_FILE, 'js');
    const text = sc.skel;
    const problem = (idx, msg) => out.push(at('fail', UPDATER_FILE, sc, idx, msg));
    const calls = (re) => [...text.matchAll(new RegExp(re.source, 'g'))].map((m) => m.index);
    const inside = (name, idx) => {
      const s = methodSpan(text, name);
      return !!s && idx >= s[0] && idx < s[1];
    };
    for (const [re, what, method] of [[/\bsetFeedURL\s*\(/, 'setFeedURL', 'install'], [/\.\s*checkForUpdates\s*\(/, 'checkForUpdates()', 'install'], [/\bquitAndInstall\s*\(/, 'quitAndInstall', 'restart']]) {
      const at1 = calls(re);
      if (at1.length !== 1) problem(at1[1] || 0, `${what} must be called exactly once (found ${at1.length})`);
      else if (!inside(method, at1[0])) problem(at1[0], `${what} must be called only in ${method}()`);
    }
    if (!/setFeedURL\(\s*\{\s*url:\s*this\.feedUrl,\s*serverType:\s*'json'\s*\}\s*\)/.test(sc.code)) problem(0, "setFeedURL must be called with { url: this.feedUrl, serverType: 'json' } and nothing else");
    for (const name of ['start', 'check']) {
      const s = methodSpan(text, name);
      if (!s) problem(0, `${name}() not found`);
      else if (/\binstall\s*\(|\brestart\s*\(|\bquitAndInstall\b|\.\s*checkForUpdates\s*\(/.test(text.slice(s[0], s[1]))) problem(s[0], `${name}() (the automatic path) must never install or restart`);
    }
    const url = /https?:\/\/[^\s'"`)<>]+/g;
    let m;
    while ((m = url.exec(sc.code))) if (!UPDATER_PAGE.test(m[0])) problem(m.index, `URL literal ${m[0].slice(0, 80)}: only pages on https://vmapp.dev/ may be named here`);
  }

  if (tree.exists(UPDATER_WIRING)) {
    const sc = tree.scan(UPDATER_WIRING, 'js');
    const lines = sc.code.split('\n');
    lines.forEach((line, i) => {
      if (/\bupdater\s*\.\s*(?:install|restart)\s*\(/.test(line) && !/updateHandle\(\s*'upd:(?:install|restart)'/.test(line)) {
        out.push(fail(UPDATER_WIRING, i + 1, 'updater.install() and updater.restart() may be reached only through the upd:install and upd:restart handlers'));
      }
    });
    if (/updater\s*\.\s*(?:install|restart)\s*\(/.test(sc.code) && !/const updateHandle[\s\S]{0,400}senders\.get\(event\.sender\.id\) !== 'library'/.test(sc.code)) {
      out.push(fail(UPDATER_WIRING, null, 'the update handlers must refuse every sender but the library window'));
    }
  }

  const page = 'loader/ui/update.js';
  if (tree.exists(page)) {
    tree.read(page).split('\n').forEach((line, i) => {
      if (/\bapi\s*\.\s*(?:install|restart)\s*\(/.test(line) && !/onclick/.test(line)) out.push(fail(page, i + 1, 'install and restart may be called only from a click handler'));
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ deps

function readJson(tree, rel, out) {
  try {
    return JSON.parse(tree.read(rel));
  } catch (e) {
    out.push(fail(rel, null, `cannot parse ${rel}: ${e.message}`));
    return null;
  }
}

function ruleDeps(tree) {
  const out = [];
  const DEP_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies'];
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);

  if (!tree.exists('loader/package.json')) out.push(fail('loader/package.json', null, 'loader/package.json is missing'));
  else {
    const pj = readJson(tree, 'loader/package.json', out);
    if (pj) {
      for (const k of DEP_KEYS) if (nonEmpty(pj[k])) out.push(fail('loader/package.json', null, `loader/package.json has ${k}: ${JSON.stringify(pj[k]).slice(0, 120)} (the loader has no runtime dependencies; Electron is a devDependency)`));
      const dev = Object.keys(pj.devDependencies || {}).filter((d) => d !== 'electron');
      if (dev.length) out.push(warn('loader/package.json', null, `devDependencies besides electron: ${dev.join(', ')} (build-time only; check they are justified)`));
      for (const s of ['preinstall', 'install', 'postinstall']) {
        if (pj.scripts && pj.scripts[s]) out.push(warn('loader/package.json', null, `install-time script '${s}': ${String(pj.scripts[s]).slice(0, 100)}`));
      }
    }
    if (tree.exists('loader/package-lock.json')) {
      const lk = readJson(tree, 'loader/package-lock.json', out);
      const root = lk && lk.packages && lk.packages[''];
      if (root) for (const k of DEP_KEYS) if (nonEmpty(root[k])) out.push(fail('loader/package-lock.json', null, `lockfile root has ${k}`));
    }
  }
  for (const dir of ['hostlib', 'sdk']) {
    for (const f of tree.list(dir, { names: /^package\.json$/ })) {
      const pj = readJson(tree, f, out);
      if (!pj) continue;
      for (const k of [...DEP_KEYS, 'devDependencies']) if (nonEmpty(pj[k])) out.push(fail(f, null, `${f} has ${k}: ${JSON.stringify(pj[k]).slice(0, 120)} (${dir}/ has no dependencies)`));
      for (const s of ['preinstall', 'install', 'postinstall']) if (pj.scripts && pj.scripts[s]) out.push(warn(f, null, `install-time script '${s}'`));
    }
  }
  // code must not require anything that is neither Node built-in nor relative (nor Electron in the loader)
  for (const dir of ['loader', 'hostlib', 'sdk']) {
    for (const file of prodJs(tree, dir)) {
      if (/(^|\/)ui\//.test(file)) continue; // renderer scripts do not require
      const sc = tree.scan(file, 'js');
      for (const c of findCalls(sc, /(?<![\w$.])require\s*\(/)) {
        const spec = c.args[0] ? evalStringExpr(c.args[0].text) : null;
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec)) continue;
        if (spec === 'electron' && dir === 'loader') continue;
        out.push(at('fail', file, sc, c.index, `require('${spec}'): third-party module (${dir}/ may use Node built-ins${dir === 'loader' ? ' and electron' : ''} only)`));
      }
    }
  }
  return out;
}

module.exports = {
  rules: [
    { id: 'a1-no-code-exec', inv: 'INV-A1', name: 'no eval / Function / vm / dynamic require; child_process only in hostlib/session.js and hostlib/hostproc.js', run: ruleA1 },
    { id: 'g3-no-network', inv: 'INV-G3', name: 'no network API use in loader/', run: ruleG3 },
    { id: 'u1-launcher-updates', inv: 'INV-U1', name: "the launcher's own updates: the updater API only in loader/src/updater.js and main.js; nothing downloads or restarts without a click", run: ruleU1 },
    { id: 'deps-none', inv: 'INV-A1', name: 'no runtime dependencies (loader: Electron only as devDependency; hostlib, sdk: none)', run: ruleDeps },
  ],
};
