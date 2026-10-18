'use strict';
// INV-H7 (SPEC 8.6): the GPU capability. A host service is a loopback endpoint the LOADER started; the launcher is told about it
// on its command line and the guest names it, nothing else. And the server behind it runs in a sandbox that allows exactly what
// the server needs.
//
//   - host/src/net.rs: a service endpoint is parsed as 127.0.0.1:PORT only; the one socket call on the service path takes its
//     address from the service table (looked up by NAME), never from the request; no other connect exists besides the network
//     path's (which INV-N3 guards)
//   - host/src/cli.rs (the command line, stdin protocol and main loop that vmapp-vm and the experimental vmapp-vm-krun share) is the
//     only place `--service` is parsed
//   - hostlib/session.js is the only place `--service` is built, and only from the GPU broker's serviceArg()
//   - hostlib/hostproc.js starts the GPU server only through /usr/bin/sandbox-exec with the loader's bundled profile first
//   - gpu/rpc-server.sb is exactly the reviewed profile: deny by default, one loopback port, the GPU's user clients, nothing writable
//     but the shader cache (a closed list: a new rule needs this rule changed, in a maintainer-reviewed change)
//   - guest/src/netproxy.rs: a service listener binds 127.0.0.1 only

const { prodJs, fail, at } = require('../lib/tree');
const { matchBracket } = require('../lib/scan');

const NET = 'host/src/net.rs';
const VM = 'host/src/cli.rs';
const PROFILE = 'gpu/rpc-server.sb';

/** The body `{ ... }` of `fn name` in a scanned Rust file: {start, end} indices (of the braces), or null. */
function fnBody(sc, name) {
  const m = new RegExp(`\\bfn\\s+${name}\\b`).exec(sc.skel);
  if (!m) return null;
  const open = sc.skel.indexOf('{', m.index);
  if (open < 0) return null;
  const close = matchBracket(sc.skel, open);
  return close < 0 ? null : { start: open, end: close, at: m.index };
}

// ---- the sandbox profile: a small s-expression reader --------------------------------------------------------------

/** Parses the profile into nested arrays; strings become {s}, atoms {a}. Comments (;) are dropped. */
function parseProfile(text) {
  const out = [];
  const stack = [out];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ';') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (/\s/.test(c)) i++;
    else if (c === '(') {
      const l = [];
      stack[stack.length - 1].push(l);
      stack.push(l);
      i++;
    } else if (c === ')') {
      if (stack.length < 2) throw new Error('unbalanced )');
      stack.pop();
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++;
        s += text[j];
        j++;
      }
      if (j >= text.length) throw new Error('unterminated string');
      stack[stack.length - 1].push({ s });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s()";]/.test(text[j])) j++;
      stack[stack.length - 1].push({ a: text.slice(i, j) });
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error('unbalanced (');
  return out;
}

const canon = (x) => (Array.isArray(x) ? `(${x.map(canon).join(' ')})` : x.s !== undefined ? JSON.stringify(x.s) : x.a);

// The whole profile, form by form. Anything else is a violation.
const IOKIT_CLASS = /^(?:AGX|IOAccel|IOSurface)[A-Za-z0-9]*$/;
const ALLOWED_FORMS = [
  '(version 1)',
  '(deny default)',
  '(import "system.sb")',
  '(system-graphics)',
  '(allow process-exec* (literal (param "BIN")))',
  '(allow file-read* (literal (param "BIN")))',
  '(allow file-read* (subpath (param "BINDIR")))',
  '(allow network-bind (local tcp (string-append "localhost:" (param "PORT"))))',
  '(allow network-inbound (local tcp (string-append "localhost:" (param "PORT"))))',
  '(allow iokit-get-properties)',
  '(allow mach-lookup (global-name "com.apple.MTLCompilerService"))',
  '(when (param "METAL_CACHE") (allow file-read-metadata (literal (param "METAL_CACHE"))) (allow file-read* file-write* (subpath (string-append (param "METAL_CACHE") "/com.apple.metal"))))',
];

function ruleH7(tree) {
  const out = [];
  const hasNet = tree.exists(NET) && /\bServiceSpec\b/.test(tree.read(NET));
  if (!hasNet && !tree.exists(PROFILE) && !tree.exists('hostlib/gpu.js')) return out; // a tree without the GPU capability

  // ---- the launcher ----
  if (!hasNet) out.push(fail(NET, null, 'host/src/net.rs has no ServiceSpec: the launcher has no way to be given a host service (INV-H7)'));
  else {
    const sc = tree.scan(NET, 'rust-nontest');
    const specImpl = /impl\s+ServiceSpec\b/.exec(sc.skel);
    if (!specImpl || !/\bKNOWN_SERVICES\b/.test(sc.skel)) out.push(fail(NET, null, 'ServiceSpec / KNOWN_SERVICES is missing (INV-H7)'));
    // ServiceSpec::parse: after impl ServiceSpec, the loopback literal is the only accepted address
    const implPart = specImpl ? sc.skel.slice(specImpl.index, specImpl.index + 2500) : '';
    if (!/Ipv4Addr::LOCALHOST/.test(implPart) || !/KNOWN_SERVICES\s*\.\s*contains/.test(implPart)) {
      out.push(fail(NET, null, 'ServiceSpec::parse must accept only a known service name and the IPv4 loopback address (Ipv4Addr::LOCALHOST) (INV-H7)'));
    }
    const run = fnBody(sc, 'run_service_connection');
    if (!run) out.push(fail(NET, null, 'fn run_service_connection is missing (INV-H7)'));
    else {
      const body = sc.code.slice(run.start, run.end);
      if (!/let\s+Some\(addr\)\s*=\s*self\s*\.\s*service_addr\(/.test(body)) {
        out.push(at('fail', NET, sc, run.at, 'run_service_connection must take its address from the service table (self.service_addr(name)) (INV-H7)'));
      }
      const socketCalls = [...body.matchAll(/TcpStream\s*::\s*connect\w*\s*\(\s*([^,)]*)/g)];
      if (socketCalls.length !== 1 || socketCalls[0][1].trim() !== '&addr') {
        out.push(at('fail', NET, sc, run.at, 'run_service_connection must make exactly one socket call, TcpStream::connect_timeout(&addr, ...), to the endpoint from the service table (INV-H7)'));
      }
    }
    const lookup = fnBody(sc, 'service_addr');
    if (!lookup || !/self\s*\.\s*services\b/.test(sc.code.slice(lookup.start, lookup.end))) {
      out.push(fail(NET, null, 'service_addr must read the endpoint from self.services only (INV-H7)'));
    }
    // service-open is answered by service_request, which refuses unknown names before anything else
    const req = fnBody(sc, 'service_request');
    if (!req || !/KNOWN_SERVICES\s*\.\s*contains\(/.test(sc.code.slice(req.start, req.end)) || !/service_addr\(/.test(sc.code.slice(req.start, req.end))) {
      out.push(fail(NET, null, 'service_request must refuse a name that is not a known service the launcher was given (INV-H7)'));
    }
    // the only socket calls in the file: the network path's (establish, after check_addresses: INV-N3) and the service path's
    const allConnects = [...sc.skel.matchAll(/\bTcpStream\s*::\s*connect\w*\s*\(/g)];
    if (allConnects.length !== 2) out.push(fail(NET, null, `host/src/net.rs has ${allConnects.length} TcpStream::connect calls, expected exactly 2 (the network path's and the service path's) (INV-H7, INV-N3)`));
  }

  // `--service` is parsed by the launcher's command line parser only
  for (const f of tree.list('host/src', { exts: ['.rs'] })) {
    if (f === NET || f === VM) continue;
    const sc = tree.scan(f, 'rust-nontest');
    // other files may carry the type around (the launch configuration), but only the command line parser makes one
    for (const m of sc.skel.matchAll(/\bServiceSpec\s*(?:::\s*parse\b|\{)/g)) out.push(at('fail', f, sc, m.index, 'a ServiceSpec is made in host/src/net.rs and by the launcher’s command line parser only (INV-H7)'));
    for (const m of sc.code.matchAll(/"--service"/g)) out.push(at('fail', f, sc, m.index, '--service is parsed in host/src/cli.rs only (INV-H7)'));
  }
  if (tree.exists(VM)) {
    const sc = tree.scan(VM, 'rust-nontest');
    if (hasNet && !/"--service"/.test(sc.code)) out.push(fail(VM, null, 'the launcher has no --service flag (INV-H7)'));
  }

  // ---- hostlib and the loader ----
  for (const f of [...prodJs(tree, 'hostlib'), ...prodJs(tree, 'loader')]) {
    if (/(^|\/)ui\//.test(f)) continue;
    const sc = tree.scan(f, 'js');
    for (const m of sc.code.matchAll(/['"`]--service['"`]/g)) {
      if (f !== 'hostlib/session.js') out.push(at('fail', f, sc, m.index, '--service is built in hostlib/session.js only, from the GPU broker (INV-H7)'));
    }
    for (const m of sc.code.matchAll(/sandbox-exec/g)) {
      if (f !== 'hostlib/hostproc.js') out.push(at('fail', f, sc, m.index, 'sandbox-exec is started in hostlib/hostproc.js only (INV-H7, INV-A1)'));
    }
  }
  if (tree.exists('hostlib/session.js')) {
    const sc = tree.scan('hostlib/session.js', 'js');
    const hits = [...sc.code.matchAll(/services\s*:\s*([^\n]*)/g)];
    for (const m of hits) {
      if (!/gpuLib\.serviceArg\(/.test(m[1])) out.push(at('fail', 'hostlib/session.js', sc, m.index, 'the services passed to vmapp-vm must come from gpuLib.serviceArg(), the broker’s own endpoint (INV-H7)'));
    }
    if (!hits.length) out.push(fail('hostlib/session.js', null, 'hostlib/session.js passes no services: the GPU capability is not wired (INV-H7)'));
  }
  if (tree.exists('hostlib/hostproc.js')) {
    const sc = tree.scan('hostlib/hostproc.js', 'js');
    const cls = /class\s+GpuServer\b/.exec(sc.skel);
    if (!cls) out.push(fail('hostlib/hostproc.js', null, 'class GpuServer is missing (INV-H7)'));
    else {
      const body = sc.code.slice(cls.index);
      if (!/cp\.spawn\('\/usr\/bin\/sandbox-exec',\s*this\.argv\(\)/.test(body)) {
        out.push(at('fail', 'hostlib/hostproc.js', sc, cls.index, 'GpuServer must start /usr/bin/sandbox-exec with this.argv() (INV-H7)'));
      }
      if (!/const a = \['-f', this\.profile, '-D', `BIN=\$\{this\.binary\}`/.test(body) || !/a\.push\(this\.binary, '--host', '127\.0\.0\.1'/.test(body)) {
        out.push(at('fail', 'hostlib/hostproc.js', sc, cls.index, 'GpuServer.argv() must be: -f <bundled profile>, -D BIN=<bundled binary> ..., <binary> --host 127.0.0.1 ... (INV-H7)'));
      }
    }
  }

  // ---- the sandbox profile ----
  if (!tree.exists(PROFILE)) out.push(fail(PROFILE, null, 'gpu/rpc-server.sb is missing: the GPU server must run in a sandbox (INV-H7)'));
  else {
    let forms = null;
    try {
      forms = parseProfile(tree.read(PROFILE));
    } catch (e) {
      out.push(fail(PROFILE, null, `the sandbox profile cannot be read: ${e.message}`));
    }
    if (forms) {
      const canonForms = forms.map(canon);
      if (canonForms[0] !== '(version 1)' || canonForms[1] !== '(deny default)') {
        out.push(fail(PROFILE, null, 'the sandbox profile must start with (version 1) and (deny default) (INV-H7)'));
      }
      for (const form of forms) {
        const c = canon(form);
        if (ALLOWED_FORMS.includes(c)) continue;
        // the GPU's user clients: a closed family of names
        if (Array.isArray(form) && form.length === 3 && form[0].a === 'allow' && form[1].a === 'iokit-open' && Array.isArray(form[2]) && form[2][0] && form[2][0].a === 'iokit-user-client-class' && form[2].slice(1).every((x) => x.s !== undefined && IOKIT_CLASS.test(x.s))) continue;
        out.push(fail(PROFILE, null, `the sandbox profile has a rule the reviewed profile does not: ${c.slice(0, 160)} (INV-H7: a change to what the GPU server may do is a maintainer-reviewed change of this rule)`));
      }
      if (!canonForms.some((c) => c.startsWith('(allow iokit-open (iokit-user-client-class '))) out.push(fail(PROFILE, null, 'the sandbox profile does not let the server open the GPU (iokit-open); it would not work (INV-H7)'));
    }
  }

  // ---- the guest ----
  if (tree.exists('guest/src/netproxy.rs')) {
    const sc = tree.scan('guest/src/netproxy.rs', 'rust-nontest');
    const fn = fnBody(sc, 'start_service');
    if (!fn) out.push(fail('guest/src/netproxy.rs', null, 'fn start_service is missing in the guest (INV-H7)'));
    else if (!/start_listener\(\s*svc,\s*&format!\("127\.0\.0\.1:\{port\}"\)\s*\)/.test(sc.code.slice(fn.start, fn.end))) {
      out.push(at('fail', 'guest/src/netproxy.rs', sc, fn.at, 'the guest’s service listener must bind 127.0.0.1 only (INV-H7, INV-N1)'));
    }
  }
  return out;
}

// ---- INV-H8: the experimental Vulkan backend (SPEC 8.7) ---------------------------------------------------------------------
//
//   - gpu/krun/vmm.sb is exactly the reviewed profile: deny by default; files only through parameters the launcher builds from its own command line;
//     Unix sockets only in the VMM's run folder; the GPU's user clients and the shader compiler (a closed list, like rpc-server.sb)
//   - host/src/krun.rs: the VMM enters the sandbox (sandbox_init_with_parameters) before it configures libkrun, loads libkrun by dlopen (the launcher
//     links no GPU library), and never attaches a network device (no krun_add_net_*)
//   - the test switch --dev-no-sandbox is parsed by host/src/cli.rs only and never appears in hostlib/ or loader/
//   - hostlib/session.js picks the backend with gpuLib.chooseBackend only

const KRUN_PROFILE = 'gpu/krun/vmm.sb';
const KRUN_RS = 'host/src/krun.rs';
const KRUN_ALLOWED_FORMS = [
  '(version 1)',
  '(deny default)',
  '(import "system.sb")',
  '(system-graphics)',
  '(allow file-read* (subpath (param "EXEDIR")))',
  '(allow file-read-metadata (literal (param "HOME")))',
  '(allow file-read* file-write* (subpath (param "RUNDIR")))',
  '(allow file-read* file-write* (literal (param "CONSOLE")))',
  '(allow network-bind (local unix-socket (subpath (param "RUNDIR"))))',
  '(allow network-inbound (local unix-socket (subpath (param "RUNDIR"))))',
  '(allow iokit-get-properties)',
  '(allow mach-lookup (global-name "com.apple.MTLCompilerService"))',
  '(when (param "METAL_CACHE") (allow file-read-metadata (literal (param "METAL_CACHE"))) (allow file-read* file-write* (subpath (string-append (param "METAL_CACHE") "/com.apple.metal"))))',
];
const KRUN_SLOT_FORM = /^\(when \(param "(RO|RW)(\d|1[0-5])"\) \(allow file-read\*( file-write\*)? \(subpath \(param "(RO|RW)(\d|1[0-5])"\)\)\)\)$/;

function ruleH8(tree) {
  const out = [];
  const hasKrun = tree.exists(KRUN_RS);
  if (!hasKrun && !tree.exists(KRUN_PROFILE)) return out; // a tree without the experimental backend

  // ---- the profile ----
  if (!tree.exists(KRUN_PROFILE)) out.push(fail(KRUN_PROFILE, null, 'gpu/krun/vmm.sb is missing: the VMM must run in a sandbox (INV-H8)'));
  else {
    let forms = null;
    try {
      forms = parseProfile(tree.read(KRUN_PROFILE));
    } catch (e) {
      out.push(fail(KRUN_PROFILE, null, `the sandbox profile cannot be read: ${e.message}`));
    }
    if (forms) {
      const canonForms = forms.map(canon);
      if (canonForms[0] !== '(version 1)' || canonForms[1] !== '(deny default)') out.push(fail(KRUN_PROFILE, null, 'the VMM profile must start with (version 1) and (deny default) (INV-H8)'));
      for (const form of forms) {
        const c = canon(form);
        if (KRUN_ALLOWED_FORMS.includes(c)) continue;
        if (KRUN_SLOT_FORM.test(c)) {
          const m = KRUN_SLOT_FORM.exec(c);
          const writes = !!m[3];
          // RO slots may only read; RW slots read and write; the name in the guard and in the rule must be the same slot
          if (m[1] !== m[4] || m[2] !== m[5] || (m[1] === 'RO') === writes) out.push(fail(KRUN_PROFILE, null, `a path slot of the VMM profile is inconsistent: ${c.slice(0, 160)} (INV-H8)`));
          continue;
        }
        if (Array.isArray(form) && form.length === 3 && form[0].a === 'allow' && form[1].a === 'iokit-open' && Array.isArray(form[2]) && form[2][0] && form[2][0].a === 'iokit-user-client-class' && form[2].slice(1).every((x) => x.s !== undefined && IOKIT_CLASS.test(x.s))) continue;
        out.push(fail(KRUN_PROFILE, null, `the VMM sandbox profile has a rule the reviewed profile does not: ${c.slice(0, 160)} (INV-H8: a change to what the VMM may do is a maintainer-reviewed change of this rule)`));
      }
      if (!canonForms.some((c) => c.startsWith('(allow iokit-open (iokit-user-client-class '))) out.push(fail(KRUN_PROFILE, null, 'the VMM profile does not let it open the GPU (iokit-open); it would not work (INV-H8)'));
      // 16 + 16 path slots, each exactly once
      const slots = canonForms.filter((c) => KRUN_SLOT_FORM.test(c)).map((c) => KRUN_SLOT_FORM.exec(c)[1] + KRUN_SLOT_FORM.exec(c)[2]);
      if (new Set(slots).size !== slots.length) out.push(fail(KRUN_PROFILE, null, 'a path slot of the VMM profile appears twice (INV-H8)'));
    }
  }

  // ---- the launcher and the VMM ----
  if (hasKrun) {
    const sc = tree.scan(KRUN_RS, 'rust-nontest');
    const vmm = fnBody(sc, 'vmm_main');
    if (!vmm) out.push(fail(KRUN_RS, null, 'fn vmm_main is missing (INV-H8)'));
    else {
      const body = sc.code.slice(vmm.start, vmm.end);
      const enter = body.search(/\benter_sandbox\s*\(/);
      const run = body.search(/\brun_vmm\s*\(/);
      if (enter < 0) out.push(at('fail', KRUN_RS, sc, vmm.at, 'vmm_main never enters the sandbox (enter_sandbox) (INV-H8)'));
      else if (run >= 0 && run < enter) out.push(at('fail', KRUN_RS, sc, vmm.at, 'vmm_main starts the VM (run_vmm) before it enters the sandbox (INV-H8)'));
      if (!/Api::load\(/.test(body)) out.push(at('fail', KRUN_RS, sc, vmm.at, 'vmm_main must load libkrun with Api::load (dlopen) itself: the launcher links no GPU library (INV-H8)'));
      if (/if let Some\(sb\) = &spec\.sandbox/.test(body) === false) out.push(at('fail', KRUN_RS, sc, vmm.at, 'vmm_main applies the sandbox profile only from the spec (INV-H8)'));
    }
    const create = sc.code.search(/\bsandbox\s*=\s*if opts\.sandbox\b|\bsandbox\s*:\s*if opts\.sandbox\b|let sandbox = if opts\.sandbox/);
    if (create < 0) out.push(fail(KRUN_RS, null, 'the sandbox must be on unless opts.sandbox (--dev-no-sandbox) says otherwise, and nothing else turns it off (INV-H8)'));
    const g = /sandbox_init_with_parameters/g;
    let m;
    let count = 0;
    while ((m = g.exec(sc.skel))) count++;
    if (count < 2) out.push(fail(KRUN_RS, null, 'sandbox_init_with_parameters is not declared and called in host/src/krun.rs (INV-H8)'));
  }
  for (const f of tree.list('host/src', { exts: ['.rs'] })) {
    const sc = tree.scan(f, 'rust-nontest');
    for (const m of sc.code.matchAll(/\bkrun_add_net\w*|krun_set_passt_fd|krun_set_gvproxy_path/g)) out.push(at('fail', f, sc, m.index, `${m[0]}: the VM has no network device, on any backend (INV-D1, INV-H8)`));
    if (f !== 'host/src/cli.rs') for (const m of sc.code.matchAll(/"--dev-no-sandbox"/g)) out.push(at('fail', f, sc, m.index, '--dev-no-sandbox is parsed in host/src/cli.rs only (INV-H8)'));
  }
  for (const f of [...prodJs(tree, 'hostlib'), ...prodJs(tree, 'loader'), ...tree.list('tools', { names: /^vmapp$/ })]) {
    if (/(^|\/)ui\//.test(f)) continue;
    const sc = tree.scan(f, 'js');
    for (const m of sc.code.matchAll(/dev-no-sandbox/g)) out.push(at('fail', f, sc, m.index, 'the sandbox test switch never reaches hostlib/, loader/ or the CLI (INV-H8)'));
  }
  if (tree.exists('hostlib/session.js')) {
    const sc = tree.scan('hostlib/session.js', 'js');
    if (!/gpuLib\.chooseBackend\(/.test(sc.code)) out.push(fail('hostlib/session.js', null, 'hostlib/session.js must choose the backend with gpuLib.chooseBackend (INV-H8)'));
    for (const m of sc.code.matchAll(/vmapp-vm-krun/g)) {
      const line = sc.code.slice(sc.code.lastIndexOf('\n', m.index) + 1, sc.code.indexOf('\n', m.index));
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /['"`][^'"`]*vmapp-vm-krun/.test(line)) continue; // comments and messages
      out.push(at('warn', 'hostlib/session.js', sc, m.index, 'vmapp-vm-krun named in code of session.js: check that it is only reached through chooseBackend'));
    }
  }
  return out;
}

module.exports = {
  rules: [
    { id: 'h7-gpu-service', inv: 'INV-H7', name: 'GPU: services are loopback endpoints the loader started, named by the guest; the server runs in the reviewed sandbox', run: ruleH7 },
    { id: 'h8-krun-sandbox', inv: 'INV-H8', name: 'experimental Vulkan backend: the VMM runs in the reviewed deny-by-default sandbox, no network device, the test switch stays in the launcher', run: ruleH8 },
  ],
};
