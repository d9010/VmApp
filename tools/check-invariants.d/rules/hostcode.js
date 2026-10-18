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
    each(/(?<![\w$.])fetch\s*\(/, 'fetch() in the loader');
    each(/\bnet\s*\.\s*(?:request|fetch|connect|createConnection)\s*\(/, 'electron net / node net request');
    each(/\b(?:XMLHttpRequest|WebSocket|EventSource|autoUpdater)\b/, (m) => `${m[0]} in the loader`);
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
      if (!URL_OK.test(m[0])) hit(m.index, `URL literal ${m[0].slice(0, 80)}`);
    }
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
    { id: 'deps-none', inv: 'INV-A1', name: 'no runtime dependencies (loader: Electron only as devDependency; hostlib, sdk: none)', run: ruleDeps },
  ],
};
