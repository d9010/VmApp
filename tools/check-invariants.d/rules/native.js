'use strict';
// INV-D1 (no VM network), INV-D4 (guest privilege drop, read-only system), INV-E2 (no panics / no prints),
// INV-F2 (runtime base images pinned by digest).

const { findCalls } = require('../lib/scan');
const { fail, warn, at } = require('../lib/tree');

const RS = (tree, dir) => tree.list(dir, { exts: ['.rs'] });

// ------------------------------------------------------------------------------------------------ D1

function ruleD1(tree) {
  const out = [];
  const cFiles = tree.list('host/src', { exts: ['.m', '.mm', '.h', '.c'] });
  const rsFiles = RS(tree, 'host/src');
  if (!cFiles.length) out.push(fail('host/src/shim', null, 'no shim sources found under host/src (expected vz_shim.m)'));
  for (const f of cFiles) {
    const sc = tree.scan(f, 'c');
    const hit = (re, msg) => {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(sc.code))) out.push(at('fail', f, sc, m.index, typeof msg === 'function' ? msg(m) : msg));
    };
    hit(/\bVZ\w*Network\w*/, (m) => `${m[0]}: the VM has no network device`);
    // reading `networkDevices.count` (the "no network" validation) is fine; anything else is a setter or KVC
    hit(/networkDevices(?!\s*\.\s*count\b)/i, 'networkDevices used other than as `.networkDevices.count` (a configuration setter?)');
    hit(/setNetwork\w*|\bnetworkAttachment\b/i, 'network configuration call');
  }
  for (const f of rsFiles) {
    const sc = tree.scan(f, 'rust');
    // class names are also caught inside string literals (NSClassFromString-style lookups)
    const g1 = /\bVZ\w*Network\w*/g;
    let m;
    while ((m = g1.exec(sc.code))) out.push(at('fail', f, sc, m.index, `${m[0]}: the VM has no network device`));
    const g2 = /\w*(?:NetworkDevice|network_device|networkDevices|NetworkAttachment|network_attachment)\w*/gi;
    while ((m = g2.exec(sc.skel))) out.push(at('fail', f, sc, m.index, `${m[0]}: the VM has no network device`));
  }
  if (tree.exists('host/vmapp.entitlements')) {
    const t = tree.read('host/vmapp.entitlements');
    if (/com\.apple\.vm\.networking/.test(t)) out.push(fail('host/vmapp.entitlements', null, 'com.apple.vm.networking entitlement (bridged networking) must not be requested'));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ D4

function guestSources(tree) {
  return RS(tree, 'guest/src').map((f) => ({ file: f, sc: tree.scan(f, 'rust-nontest') }));
}

/** consts (global by name) and `let` bindings (per file, with their position) of the guest sources. */
function constTable(files) {
  const consts = new Map();
  const lets = new Map(); // file -> [{name, expr, idx}]
  for (const { file, sc } of files) {
    for (const m of sc.code.matchAll(/\b(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)\s*:[^=;]+=\s*([^;]+);/g)) consts.set(m[1], m[2].trim());
    const l = [];
    for (const m of sc.code.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]+)?=\s*([^;]+);/g)) l.push({ name: m[1], expr: m[2].trim(), idx: m.index });
    lets.set(file, l);
  }
  return { consts, lets };
}

/**
 * Resolves an expression used at position `idx` of `file` to a string/number literal text, through `let` bindings
 * (the nearest earlier one) and consts (last path segment); null if it is anything else.
 */
function resolveValue(expr, table, file, idx, depth = 4) {
  const e = expr.trim();
  const lit = /^"([^"]*)"$/.exec(e);
  if (lit) return lit[1];
  if (/^\d+$/.test(e)) return e;
  if (depth <= 0) return null;
  if (/^[A-Za-z_]\w*$/.test(e)) {
    const prior = (table.lets.get(file) || []).filter((x) => x.name === e && x.idx < idx);
    if (prior.length) {
      const l = prior[prior.length - 1];
      return resolveValue(l.expr, table, file, l.idx, depth - 1);
    }
  }
  const id = /(?:^|::)([A-Za-z_]\w*)$/.exec(e);
  if (id && table.consts.has(id[1])) return resolveValue(table.consts.get(id[1]), table, file, 0, depth - 1);
  return null;
}

function ruleD4(tree) {
  const out = [];
  const files = guestSources(tree);
  if (!files.length) return [fail('guest/src', null, 'no guest sources found')];
  const table = constTable(files);
  const rv = (expr, call) => resolveValue(expr, table, call.file, call.index);
  const calls = (re) => files.flatMap(({ file, sc }) => findCalls(sc, re).map((c) => ({ ...c, file, sc })));

  // never become root: setuid/setgid(0) etc.
  for (const c of calls(/(?<![\w$])(?:libc\s*::\s*)?(set(?:e)?(?:u|g)id|setres(?:u|g)id|setre(?:u|g)id)\s*\(/)) {
    if (c.args.some((a) => rv(a.text, c) === '0')) out.push(at('fail', c.file, c.sc, c.index, 'sets a uid/gid to 0 (root)'));
  }

  const find = (name) => calls(new RegExp(`(?<![\\w$])(?:libc\\s*::\\s*)?${name}\\s*\\(`));
  const setgroups = find('setgroups');
  const setgid = find('setgid');
  const setuid = find('setuid');
  const chroot = find('chroot');
  const prctl = find('prctl').filter((c) => c.args[0] && /PR_SET_NO_NEW_PRIVS/.test(c.args[0].text));

  if (!chroot.length) out.push(fail('guest/src', null, 'chroot to the runtime root is missing'));
  if (!setgroups.length) out.push(fail('guest/src', null, 'setgroups(0, ...) is missing'));
  else if (!setgroups.some((c) => c.args[0] && rv(c.args[0].text, c) === '0')) out.push(at('fail', setgroups[0].file, setgroups[0].sc, setgroups[0].index, 'setgroups must clear the groups (0, null)'));
  if (!setgid.length) out.push(fail('guest/src', null, 'setgid(1000) is missing'));
  else if (!setgid.some((c) => c.args[0] && rv(c.args[0].text, c) === '1000')) out.push(at('fail', setgid[0].file, setgid[0].sc, setgid[0].index, 'setgid must be 1000 (constant not resolvable to 1000)'));
  if (!setuid.length) out.push(fail('guest/src', null, 'setuid(1000) is missing'));
  else if (!setuid.some((c) => c.args[0] && rv(c.args[0].text, c) === '1000')) out.push(at('fail', setuid[0].file, setuid[0].sc, setuid[0].index, 'setuid must be 1000 (constant not resolvable to 1000)'));
  if (!prctl.length) out.push(fail('guest/src', null, 'prctl(PR_SET_NO_NEW_PRIVS, 1, ...) is missing'));
  else if (!prctl.some((c) => c.args[1] && c.args[1].text.trim() === '1')) out.push(at('fail', prctl[0].file, prctl[0].sc, prctl[0].index, 'PR_SET_NO_NEW_PRIVS must be set to 1'));

  // order inside the file that drops privileges: chroot, then groups, gid, uid
  const u = setuid[0];
  if (u) {
    const same = (list) => list.find((c) => c.file === u.file);
    const ch = same(chroot);
    const sg = same(setgroups);
    const gi = same(setgid);
    if (ch && ch.index > u.index) out.push(at('fail', u.file, u.sc, u.index, 'chroot must happen before setuid'));
    if (sg && sg.index > u.index) out.push(at('fail', u.file, u.sc, u.index, 'setgroups must happen before setuid'));
    if (gi && gi.index > u.index) out.push(at('fail', u.file, u.sc, u.index, 'setgid must happen before setuid'));
    const ex = find('execve').concat(find('execv'), find('execvp'), find('execvpe')).find((c) => c.file === u.file);
    const pr = same(prctl);
    if (ex && pr && pr.index > ex.index) out.push(at('fail', u.file, u.sc, pr.index, 'PR_SET_NO_NEW_PRIVS must be set before exec'));
  }

  // mounts: /rt read-only; /rt/app remounted read-only; no remount without MS_RDONLY on those
  const mounts = calls(/(?<![\w$:])(?:mount|mount_logged)\s*\(/).filter((c) => c.args.length >= 4 && !/\bfn\s+$/.test(c.sc.skel.slice(Math.max(0, c.index - 4), c.index)));
  let rtOk = false;
  let appRemountRo = false;
  let sawRt = false;
  let sawApp = false;
  for (const c of mounts) {
    const target = rv(c.args[1].text, c);
    const flags = c.args[3].text;
    const ro = /MS_RDONLY/.test(flags);
    const remount = /MS_REMOUNT/.test(flags);
    if (target === '/rt') {
      sawRt = true;
      if (ro) rtOk = true;
      else out.push(at('fail', c.file, c.sc, c.index, 'the runtime root /rt must be mounted MS_RDONLY'));
    } else if (target === '/rt/app') {
      sawApp = true;
      if (remount && ro) appRemountRo = true;
      if (remount && !ro) out.push(at('fail', c.file, c.sc, c.index, 'MS_REMOUNT of /rt/app without MS_RDONLY'));
    } else if (remount && !ro) {
      out.push(at('warn', c.file, c.sc, c.index, `MS_REMOUNT without MS_RDONLY on ${target === null ? 'an unresolved target' : target}`));
    }
  }
  if (!sawRt || !rtOk) {
    if (!sawRt) out.push(fail('guest/src', null, 'cannot find the mount of the runtime root /rt'));
  }
  if (!sawApp || !appRemountRo) out.push(fail('guest/src', null, '/rt/app is not remounted read-only (MS_REMOUNT | MS_RDONLY)'));
  return out;
}

// ------------------------------------------------------------------------------------------------ E2

function ruleE2(tree) {
  const out = [];
  const host = RS(tree, 'host/src');
  if (!host.length) out.push(fail('host/src', null, 'no launcher sources found'));
  for (const f of host) {
    const sc = tree.scan(f, 'rust-nontest');
    const g = /(?<![\w$])(println|eprintln|print|eprint|dbg)\s*!/g;
    let m;
    while ((m = g.exec(sc.skel))) out.push(at('fail', f, sc, m.index, `${m[1]}! in the launcher (panics when the parent's pipe is closed)`));
  }
  const guest = RS(tree, 'guest/src');
  if (!guest.length) out.push(fail('guest/src', null, 'no guest sources found'));
  const idx = [];
  for (const f of guest) {
    const sc = tree.scan(f, 'rust-nontest');
    let m;
    const g1 = /\.\s*(unwrap|expect|unwrap_err|expect_err|unwrap_unchecked)\s*\(/g;
    while ((m = g1.exec(sc.skel))) {
      // `.unwrap_or*` are different identifiers, not matched here
      out.push(at('fail', f, sc, m.index, `.${m[1]}() in the guest init (PID 1 must never panic)`));
    }
    const g2 = /(?<![\w$])(panic|unreachable|todo|unimplemented|assert|assert_eq|assert_ne|println|eprintln|print|eprint|dbg)\s*!/g;
    while ((m = g2.exec(sc.skel))) {
      const lvl = /^(println|eprintln|print|eprint|dbg)$/.test(m[1]) ? 'fail' : 'warn';
      out.push(at(lvl, f, sc, m.index, `${m[1]}! in the guest init`));
    }
    // indexing heuristic: ident[expr] (not slices of the full range) can panic
    const g3 = /(?<=[\w)\]])\[([^\[\]\n]+)\]/g;
    while ((m = g3.exec(sc.skel))) {
      if (/^\s*\.\.\s*$/.test(m[1])) continue;
      const before = sc.skel.slice(Math.max(0, m.index - 30), m.index);
      if (/#!?$/.test(before) || /(?:\bvec|\bmatches|\bformat|\bwrite|\bwriteln)!$/.test(before)) continue;
      idx.push({ f, sc, i: m.index });
    }
  }
  const seenLines = new Set();
  const sites = idx.filter((x) => {
    const k = `${x.f}:${x.sc.liner(x.i)}`;
    if (seenLines.has(k)) return false;
    seenLines.add(k);
    return true;
  });
  for (const x of sites.slice(0, 15)) out.push(at('warn', x.f, x.sc, x.i, 'indexing/slicing can panic (heuristic; prefer .get())'));
  if (sites.length > 15) out.push(warn(null, null, `... and ${sites.length - 15} more indexing/slicing lines in guest/src`));
  return out;
}

// ------------------------------------------------------------------------------------------------ F2

const PIN = /@sha256:[0-9a-f]{64}$/;

/** Logical Dockerfile instructions with their starting line numbers (continuations joined, comments dropped). */
function instructions(text) {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (cur === null) {
      if (!line.trim() || line.trim().startsWith('#')) return;
      cur = { line: i + 1, text: '' };
    } else if (line.trim().startsWith('#')) return;
    const cont = /\\\s*$/.test(line);
    cur.text += (cur.text ? ' ' : '') + line.replace(/\\\s*$/, '').trim();
    if (!cont) {
      out.push(cur);
      cur = null;
    }
  });
  if (cur) out.push(cur);
  return out;
}

function ruleF2(tree) {
  const out = [];
  const files = new Set(tree.list('runtimes', { names: /^Dockerfile(\..*)?$|\.Dockerfile$/ }));
  if (!files.size) out.push(fail('runtimes', null, 'no runtimes/*/Dockerfile found'));
  for (const f of tree.list('tools', { names: /^Dockerfile(\..*)?$|\.Dockerfile$/ })) files.add(f);
  for (const f of tree.list('kernel', { names: /^Dockerfile(\..*)?$|\.Dockerfile$/ })) files.add(f); // the guest kernel build
  if (!tree.exists('tools/mkerofs.Dockerfile')) out.push(warn('tools/mkerofs.Dockerfile', null, 'tools/mkerofs.Dockerfile is missing'));
  for (const f of [...files].sort()) {
    const stages = new Set();
    let stageCount = 0;
    for (const ins of instructions(tree.read(f))) {
      const mk = (msg) => ({ level: 'fail', file: f, line: ins.line, message: msg, text: ins.text.slice(0, 200) });
      const kw = /^(\w+)\s*/.exec(ins.text);
      if (!kw) continue;
      const k = kw[1].toUpperCase();
      const rest = ins.text.slice(kw[0].length);
      if (k === 'FROM') {
        const m = /^((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?/i.exec(rest);
        if (!m) {
          out.push(mk('cannot parse FROM'));
          continue;
        }
        const img = m[2];
        if (img.toLowerCase() !== 'scratch' && !stages.has(img) && !PIN.test(img)) {
          out.push(mk(/\$/.test(img) ? `FROM ${img}: base image is a build argument; cannot verify the digest pin` : `FROM ${img} is not pinned by @sha256:<digest>`));
        }
        if (m[3]) stages.add(m[3]);
        stageCount++;
      } else if (k === 'COPY' || k === 'ADD' || k === 'RUN') {
        const f2 = /--(?:from=|mount=[^\s]*?\bfrom=)([^\s,]+)/.exec(rest);
        if (f2) {
          const src = f2[1];
          if (!stages.has(src) && !/^\d+$/.test(src) && !PIN.test(src)) out.push(mk(`${k} --from=${src} pulls an image not pinned by @sha256:<digest>`));
        }
        if (k === 'ADD' && /https?:\/\//.test(rest)) out.push(mk('ADD of a remote URL (not reproducible)'));
      }
    }
    if (!stageCount) out.push(fail(f, null, 'no FROM instruction found'));
  }
  return out;
}

module.exports = {
  rules: [
    { id: 'd1-no-vm-network', inv: 'INV-D1', name: 'host shim configures no VM network device', run: ruleD1 },
    { id: 'd4-guest-privileges', inv: 'INV-D4', name: 'guest: chroot, setgroups, uid/gid 1000, no_new_privs, read-only /rt and /rt/app', run: ruleD4 },
    { id: 'e2-no-panics', inv: 'INV-E2', name: 'launcher: no print macros; guest init: no unwrap/expect', run: ruleE2 },
    { id: 'f2-pinned-bases', inv: 'INV-F2', name: 'every Dockerfile FROM is pinned by @sha256 digest', run: ruleF2 },
  ],
  instructions,
};
