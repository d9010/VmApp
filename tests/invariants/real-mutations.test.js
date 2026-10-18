'use strict';
// The rules must also bite on the REAL code (not only on the small fixtures): copy the real tree to a scratch folder,
// break one thing, and expect the matching rule to fail. A mutation whose anchor no longer exists in the evolving
// code is skipped (the fixtures in rules.test.js still cover the rule); the real tree must pass unmutated.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { VMAPP, scratch, cleanup, runRules, messages } = require('./helpers');

after(cleanup);

const SKIP = new Set(['node_modules', 'target', 'out', '.git', 'build', 'dist', '_work']);
let base = null;
function realCopy() {
  if (!base) {
    base = scratch('real');
    for (const d of ['loader', 'hostlib', 'sdk', 'host', 'guest', 'runtimes', 'tools']) {
      if (!fs.existsSync(path.join(VMAPP, d))) continue;
      fs.cpSync(path.join(VMAPP, d), path.join(base, d), { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) && !src.includes(`${path.sep}tests${path.sep}`) });
    }
    fs.copyFileSync(path.join(VMAPP, 'SPEC.md'), path.join(base, 'SPEC.md'));
    // the GPU server's sandbox profile (INV-H7); the rest of gpu/ (sources and builds of other work) is not needed
    fs.mkdirSync(path.join(base, 'gpu'), { recursive: true });
    fs.copyFileSync(path.join(VMAPP, 'gpu', 'rpc-server.sb'), path.join(base, 'gpu', 'rpc-server.sb'));
    // the experimental Vulkan backend's VMM sandbox profile (INV-H8)
    if (fs.existsSync(path.join(VMAPP, 'gpu', 'krun', 'vmm.sb'))) {
      fs.mkdirSync(path.join(base, 'gpu', 'krun'), { recursive: true });
      fs.copyFileSync(path.join(VMAPP, 'gpu', 'krun', 'vmm.sb'), path.join(base, 'gpu', 'krun', 'vmm.sb'));
    }
  }
  const dir = scratch('mut');
  fs.cpSync(base, dir, { recursive: true });
  return dir;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const writeFile = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);

/** mutate(root) returns false when its anchor is gone (test skipped). */
function bites(name, rule, mutate, match) {
  test(name, (t) => {
    const root = realCopy();
    if (mutate(root) === false) return t.skip('anchor not found in the current code');
    const r = runRules(root).find((x) => x.id === rule);
    assert.equal(r.status, 'FAIL', `${rule}: ${messages(r)}`);
    if (match) assert.match(messages(r), match);
  });
}

const sub = (rel, from, to) => (root) => {
  const text = read(root, rel);
  if (!(typeof from === 'string' ? text.includes(from) : from.test(text))) return false;
  writeFile(root, rel, typeof from === 'string' ? text.replace(from, () => to) : text.replace(from, to));
  return true;
};
const append = (rel, extra) => (root) => {
  if (!fs.existsSync(path.join(root, rel))) return false;
  writeFile(root, rel, read(root, rel) + extra);
  return true;
};
const add = (rel, content) => (root) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFile(root, rel, content);
  return true;
};

test('the unmutated copy passes (so every failure below is caused by the mutation)', () => {
  const root = realCopy();
  const bad = runRules(root).filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  assert.deepEqual(bad.map((r) => `${r.id}: ${r.error || messages(r)}`), []);
});

bites('real B1: sandbox: false in the app window', 'b1-window-prefs', sub('loader/src/window-manager.js', /sandbox:\s*true/, 'sandbox: false'), /sandbox/);
bites('real B1: partition dropped from the app window', 'b1-window-prefs', sub('loader/src/window-manager.js', /partition:\s*partitionOf\([^)]*\),/, ''), /partition/);
bites('real B1: DevTools forced on in the app window', 'b1-window-prefs', sub('loader/src/window-manager.js', /devTools:\s*params\.devTools === true,/, 'devTools: true,'), /devTools must be/);
bites('real B1: DevTools in a packaged loader window', 'b1-window-prefs', sub('loader/src/settings.js', /devTools:\s*!this\.cfg\.isPackaged/, 'devTools: true'), /devTools must be !cfg\.isPackaged/);
bites('real B1: the packaged devtools-opened closer removed', 'b1-window-prefs', sub('loader/main.js', /contents\.on\('devtools-opened'/, "contents.on('devtools-removed'"), /devtools-opened/);
bites('real B1: a second, unchecked window in the loader', 'b1-window-prefs', add('loader/src/zz.js', "const { BrowserWindow } = require('electron');\nnew BrowserWindow({ webPreferences: { preload: '/x.js' } });\n"));
bites('real B2: an extra key on window.vmapp', 'b2-preload-api', sub('loader/preload-app.js', /^( *)ipcRenderer:\s*\{/m, '$1fs: require("fs"),\n$1ipcRenderer: {'), /extra keys/);
bites('real B3: connect-src relaxed in the app CSP', 'b3-csp-nav-perms', sub('loader/src/protocols.js', "connect-src 'none'", "connect-src 'self'"), /connect-src/);
bites('real B3: permission requests granted', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', /callback\(microphoneRequestAllowed\([^\n]*\)\);/, 'callback(true);'), /unconditional deny/);
bites('real B3: the check handler of an app partition returns true', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', /ses\.setPermissionCheckHandler\(\(wc, permission, origin, details\) => \{[\s\S]*?\n  \}\);/, 'ses.setPermissionCheckHandler(() => true);'));
bites('real B3: the loader’s own session grants permissions', 'b3-csp-nav-perms', sub('loader/main.js', /ses\.setPermissionRequestHandler\(\(wc, permission, callback\) => callback\(false\)\)/, 'ses.setPermissionRequestHandler((wc, permission, callback) => callback(true))'));
bites('real B3 gate: the microphone gate answers true by itself', 'b3-csp-nav-perms', sub('loader/src/devices.js', 'return gate.requestAllowed(appId, wc, details) === true;', 'return true;'), /last return/);
bites('real B3 gate: a request that includes video can pass', 'b3-csp-nav-perms', sub('loader/src/devices.js', 'types.length !== 1 || ', ''), /exactly \['audio'\]/);
bites('real B3 gate: the user’s grant is no longer consulted', 'b3-csp-nav-perms', sub('loader/src/devices.js', /      if \(!deviceAllowed\([^\n]*\n/, ''), /deviceAllowed/);
bites('real B3 gate: the window registry is no longer consulted', 'b3-csp-nav-perms', sub('loader/src/devices.js', 'const rec = wc && this.registry.get(wc.id);', 'const rec = { appId };'), /registry lookup/);
bites('real B3: window.open allowed', 'b3-csp-nav-perms', sub('loader/main.js', /action:\s*'deny'/, "action: 'allow'"));
bites('real B3: navigation guard never prevents', 'b3-csp-nav-perms', sub('loader/main.js', /e\.preventDefault\(\);\s*\n\s*log\('warn', `blocked/, "log('warn', `blocked"));
bites('real B4: the hash comparison is gone', 'b4-ui-handler', sub('loader/src/protocols.js', /if \(got !== want\)/, 'if (false)'));
bites('real C2: an op outside SPEC 6', 'c2-request-ops', sub('hostlib/session.js', "      case 'app.quit':", "      case 'fs.readFile':\n        return {};\n      case 'app.quit':"), /fs\.readFile/);
bites('real C2: the dialogs permission check is gone', 'c2-request-ops', sub('hostlib/session.js', /permissions\.dialogs/g, 'permissions.dialogz'), /permissions\.dialogs/);
bites('real C2: a host op in the broker skips _authorize', 'c2-request-ops', sub('hostlib/capabilities.js', "await this._authorize(ctx, st, rec, 'screen', 'list the windows on screen', { alsoApprovedBy: ['screen.capture'] });", ''), /host\.screen\.windows.*_authorize/);
bites('real C2: the host permission check in session.js is gone', 'c2-request-ops', sub('hostlib/session.js', /permissions\.host \|\| \[\]/g, 'permissions.hostz || []'), /permissions\.host/);
bites('real A1: hostproc.js spawns with a shell', 'a1-no-code-exec', sub('hostlib/hostproc.js', 'shell: false, detached: true, windowsHide: true });\n  const out', 'shell: true, detached: true, windowsHide: true });\n  const out'), /shell/);
bites('real C2: the external permission check is gone', 'c2-request-ops', sub('hostlib/session.js', /permissions\.external/g, 'permissions.externalz'), /permissions\.external/);
bites('real A1: eval in hostlib', 'a1-no-code-exec', add('hostlib/zz.js', 'module.exports = (s) => eval(s);\n'));
bites('real A1: child_process in the loader', 'a1-no-code-exec', add('loader/src/zz.js', "module.exports = require('child_process');\n"));
bites('real deps: a dependency in the loader', 'deps-none', sub('loader/package.json', '"devDependencies"', '"dependencies": { "x": "1.0.0" },\n  "devDependencies"'));
bites('real D1: a network device in the shim', 'd1-no-vm-network', append('host/src/shim/vz_shim.m', '\nstatic void zz(VZVirtualMachineConfiguration *c) { c.networkDevices = @[]; }\n'));
bites('real D4: setgroups removed', 'd4-guest-privileges', sub('guest/src/appcore.rs', /libc::setgroups\(/, 'libc::setgroupz('), /setgroups/);
bites('real D4: no_new_privs removed', 'd4-guest-privileges', sub('guest/src/appcore.rs', /PR_SET_NO_NEW_PRIVS/, 'PR_SET_DUMPABLE'), /NO_NEW_PRIVS/);
bites('real D4: setuid(0)', 'd4-guest-privileges', sub('guest/src/appcore.rs', /libc::setuid\(APP_UID\)/, 'libc::setuid(0)'));
bites('real D4: the root image mounted writable', 'd4-guest-privileges', sub('guest/src/main.rs', 'mount("/dev/vda", root, "erofs", libc::MS_RDONLY | nsd, None)', 'mount("/dev/vda", root, "erofs", nsd, None)'), /MS_RDONLY/);
bites('real E2: println! in the launcher', 'e2-no-panics', append('host/src/lib.rs', '\nfn zz() {\n    println!("x");\n}\n'), /println!/);
bites('real E2: unwrap in the guest init', 'e2-no-panics', append('guest/src/main.rs', '\nfn zz() {\n    let _ = Some(1).unwrap();\n}\n'), /unwrap/);
bites('real N1: an outbound connect in the guest', 'n1-no-guest-egress', append('guest/src/main.rs', '\nfn zz() {\n    let _ = std::net::TcpStream::connect("1.1.1.1:80");\n}\n'), /TcpStream::connect/);
bites('real N1: the guest proxy listening on every interface', 'n1-no-guest-egress', sub('guest/src/netproxy.rs', 'pub const PROXY_ADDR: &str = "127.0.0.1:3128";', 'pub const PROXY_ADDR: &str = "0.0.0.0:3128";'), /all interfaces/);
bites('real N3: the address check dropped from the proxy', 'n3-address-check', sub('host/src/net.rs', 'check_addresses(host, &addrs, self.opts.allow_loopback)', 'Ok::<(), String>(())'), /check_addresses/);
bites('real N3: a socket opened outside host/src/net.rs', 'n3-address-check', append('host/src/lib.rs', '\nfn zz() {\n    let _ = std::net::TcpStream::connect("1.1.1.1:80");\n}\n'), /belong in host\/src\/net\.rs/);
bites('real N3: the loopback test switch in the loader', 'n3-address-check', add('loader/src/zz.js', "module.exports = ['--dev-allow-loopback'];\n"), /test switches/);
bites('real N3: the test switch in the manifest or store code', 'n3-address-check', append('hostlib/store.js', "\nmodule.exports.zz = { devNet: { allowLoopback: true } };\n"), /outside hostlib\/session\.js/);
bites('real F2: a runtime base image without its digest', 'f2-pinned-bases', sub('runtimes/node22/Dockerfile', /@sha256:[0-9a-f]{64}/, ':22-bookworm-slim'));

// ---- INV-H7: the GPU capability (SPEC 8.6) ----
bites('real H7: a service endpoint that need not be loopback', 'h7-gpu-service', sub('host/src/net.rs', 'SocketAddr::V4(a) if *a.ip() == Ipv4Addr::LOCALHOST && a.port() != 0 => {}', 'SocketAddr::V4(_) => {}'), /Ipv4Addr::LOCALHOST/);
bites('real H7: the service connect no longer uses the service table', 'h7-gpu-service', sub('host/src/net.rs', 'TcpStream::connect_timeout(&addr, SERVICE_CONNECT_TIMEOUT)', 'TcpStream::connect_timeout(&other, SERVICE_CONNECT_TIMEOUT)'), /exactly one socket call/);
bites('real H7: the address of the service comes from somewhere else', 'h7-gpu-service', sub('host/src/net.rs', 'let Some(addr) = self.service_addr(&name) else {', 'let Some(addr) = guess(&name) else {'), /service table/);
bites('real H7: another connect in the network proxy', 'h7-gpu-service', append('host/src/net.rs', '\nfn zz() {\n    let _ = TcpStream::connect_timeout(&"1.1.1.1:80".parse().unwrap(), Duration::from_secs(1));\n}\n'), /expected exactly 2/);
bites('real H7: an unknown service name is no longer refused', 'h7-gpu-service', sub('host/src/net.rs', 'if !KNOWN_SERVICES.contains(&raw) || self.service_addr(raw).is_none() {', 'if false {'), /refuse a name/);
bites('real H7: --service parsed outside the launcher parser', 'h7-gpu-service', append('host/src/lib.rs', '\nfn zz() -> &\'static str {\n    "--service"\n}\n'), /--service is parsed in/);
bites('real H7: a ServiceSpec made outside the parser', 'h7-gpu-service', append('host/src/lib.rs', '\nfn zz() {\n    let _ = net::ServiceSpec::parse("gpu=127.0.0.1:1");\n}\n'), /ServiceSpec is made/);
bites('real H7: --service built in the loader', 'h7-gpu-service', add('loader/src/zz.js', "module.exports = ['--service', 'gpu=127.0.0.1:22'];\n"), /session\.js only/);
bites('real H7: session.js passes a service the broker did not make', 'h7-gpu-service', sub('hostlib/session.js', 'services: gpu ? [gpuLib.serviceArg(gpu.port)] : [],', "services: ['gpu=127.0.0.1:22'],"), /serviceArg/);
bites('real H7: sandbox-exec started outside hostproc.js', 'h7-gpu-service', add('hostlib/zz.js', "module.exports = '/usr/bin/sandbox-exec';\n"), /hostproc\.js only/);
bites('real H7: the GPU server started without the sandbox', 'h7-gpu-service', sub('hostlib/hostproc.js', "cp.spawn('/usr/bin/sandbox-exec', this.argv()", 'cp.spawn(this.binary, this.argv()'), /GpuServer must start/);
bites('real H7: the sandbox profile allows everything', 'h7-gpu-service', append('gpu/rpc-server.sb', '\n(allow default)\n'), /reviewed profile/);
bites('real H7: the sandbox profile allows outbound connections', 'h7-gpu-service', append('gpu/rpc-server.sb', '\n(allow network-outbound)\n'), /network-outbound/);
bites('real H7: the sandbox profile allows writing to the home folder', 'h7-gpu-service', append('gpu/rpc-server.sb', '\n(allow file-write* (subpath "/Users"))\n'), /file-write/);
bites('real H7: the sandbox profile allows any mach service', 'h7-gpu-service', append('gpu/rpc-server.sb', '\n(allow mach-lookup)\n'), /mach-lookup/);
bites('real H7: the sandbox profile allows reading any file', 'h7-gpu-service', append('gpu/rpc-server.sb', '\n(allow file-read*)\n'), /file-read/);
bites('real H7: the sandbox profile allows starting programs', 'h7-gpu-service', append('gpu/rpc-server.sb', '\n(allow process-fork)\n(allow process-exec*)\n'), /process-/);
bites('real H7: the sandbox profile binds any port', 'h7-gpu-service', sub('gpu/rpc-server.sb', '(allow network-bind (local tcp (string-append "localhost:" (param "PORT"))))', '(allow network-bind)'), /network-bind/);
bites('real H7: the sandbox profile no longer denies by default', 'h7-gpu-service', sub('gpu/rpc-server.sb', '(deny default)', ''), /deny default/);
bites('real H7: the sandbox profile is gone', 'h7-gpu-service', (root) => {
  fs.rmSync(path.join(root, 'gpu', 'rpc-server.sb'));
  return true;
}, /missing/);
// ---- INV-H8: the experimental Vulkan backend (SPEC 8.7) ----
bites('real H8: the VMM profile allows outbound connections', 'h8-krun-sandbox', append('gpu/krun/vmm.sb', '\n(allow network-outbound)\n'), /network-outbound/);
bites('real H8: the VMM profile allows starting programs', 'h8-krun-sandbox', append('gpu/krun/vmm.sb', '\n(allow process-exec*)\n'), /process-exec/);
bites('real H8: the VMM profile allows reading every file', 'h8-krun-sandbox', append('gpu/krun/vmm.sb', '\n(allow file-read*)\n'), /file-read/);
bites('real H8: the VMM profile binds sockets anywhere', 'h8-krun-sandbox', sub('gpu/krun/vmm.sb', '(allow network-bind (local unix-socket (subpath (param "RUNDIR"))))', '(allow network-bind)'), /network-bind/);
bites('real H8: a read-only slot that can write', 'h8-krun-sandbox', sub('gpu/krun/vmm.sb', '(when (param "RO3") (allow file-read* (subpath (param "RO3"))))', '(when (param "RO3") (allow file-read* file-write* (subpath (param "RO3"))))'), /slot/);
bites('real H8: the VMM profile no longer denies by default', 'h8-krun-sandbox', sub('gpu/krun/vmm.sb', '(deny default)', ''), /deny default/);
bites('real H8: the VMM profile is gone', 'h8-krun-sandbox', (root) => {
  fs.rmSync(path.join(root, 'gpu', 'krun', 'vmm.sb'));
  return true;
}, /missing/);
bites('real H8: the VMM starts the VM before it enters the sandbox', 'h8-krun-sandbox', sub('host/src/krun.rs', /(if let Some\(sb\) = &spec\.sandbox \{[\s\S]*?\n    \}\n)(    match run_vmm\(&spec, &api\))/, '$2$1'), /before it enters the sandbox/);
bites('real H8: the VMM never enters the sandbox', 'h8-krun-sandbox', sub('host/src/krun.rs', 'if let Err(e) = enter_sandbox(sb) {', 'if let Err(e) = noop(sb) {'), /never enters the sandbox/);
bites('real H8: a network device is attached to the VM', 'h8-krun-sandbox', append('host/src/krun.rs', '\nfn zz() {\n    let _ = "krun_add_net_unixstream";\n}\n'), /no network device/);
bites('real H8: the sandbox test switch is parsed outside the launcher command line', 'h8-krun-sandbox', append('host/src/lib.rs', '\nfn zz() -> &\'static str {\n    "--dev-no-sandbox"\n}\n'), /cli\.rs only/);
bites('real H8: the sandbox test switch in the loader', 'h8-krun-sandbox', add('loader/src/zz.js', "module.exports = ['--dev-no-sandbox'];\n"), /never reaches/);
bites('real H8: the backend is chosen without chooseBackend', 'h8-krun-sandbox', sub('hostlib/session.js', 'gpuLib.chooseBackend(', 'gpuLib.chooseBackendX('), /chooseBackend/);
bites('real H7: the guest service listener on every interface', 'h7-gpu-service', sub('guest/src/netproxy.rs', 'start_listener(svc, &format!("127.0.0.1:{port}"))', 'start_listener(svc, &format!("0.0.0.0:{port}"))'), /127\.0\.0\.1 only/);

// window features (SPEC 2.2 ui.features, SPEC 7, docs/design/DEV-APPS.md C1)
bites('real B3: a window feature adds a network source', 'b3-csp-nav-perms', sub('loader/src/protocols.js', `'self-fetch': Object.freeze({ 'connect-src': Object.freeze(["'self'"]) })`, `'self-fetch': Object.freeze({ 'connect-src': Object.freeze(["'self'", 'https:']) })`), /UI_FEATURE_CSP/);
bites('real B3: a window feature adds unsafe-inline to the page', 'b3-csp-nav-perms', sub('loader/src/protocols.js', `wasm: Object.freeze({ 'script-src': Object.freeze(["'wasm-unsafe-eval'"]) })`, `wasm: Object.freeze({ 'script-src': Object.freeze(["'wasm-unsafe-eval'", "'unsafe-inline'"]) })`), /unsafe-inline/);
bites('real B3: the frame CSP gets a websocket source', 'b3-csp-nav-perms', sub('loader/src/protocols.js', `font-src 'self' blob: data: https:; connect-src 'self' blob: data: https:;`, `font-src 'self' blob: data: https:; connect-src 'self' blob: data: https: wss:;`), /FRAME_CSP/);
bites('real B3: the app partition request filter lets https through', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', 'const allowedSchemes = /^(vmapp-ui|vmapp-frame|data|blob|devtools):/i;', 'const allowedSchemes = /^(vmapp-ui|vmapp-frame|data|blob|devtools|https):/i;'), /request filter/);
bites('real B3: the vmapp-ui handler ignores the manifest features', 'b3-csp-nav-perms', sub('loader/src/protocols.js', 'appCsp(ctx.app.manifest.ui.features)', "appCsp(['workers', 'wasm', 'self-fetch', 'frames'])"), /appCsp/);
bites('real B4: the vmapp-frame handler serves without the "frames" feature', 'b4-ui-handler', sub('loader/src/protocols.js', "if (!ctx || !(ctx.app.manifest.ui.features || []).includes('frames')) return notFound();", 'if (!ctx) return notFound();'), /frames/);
bites('real B4: the vmapp-frame handler serves around the verified path', 'b4-ui-handler', sub('loader/src/protocols.js', 'return serveVerified(ctx, u, request, FRAME_CSP, log);', "return new Response('x', { headers: { 'content-security-policy': FRAME_CSP } });"), /serveVerified/);
// the window network (SPEC 8.3 "The app's windows", DEV-APPS C3)
bites('real B3: the "network" feature names a network source for scripts', 'b3-csp-nav-perms', sub('loader/src/protocols.js', "'connect-src': Object.freeze(['https:', 'wss:']),", "'connect-src': Object.freeze(['https:', 'wss:']),\n    'script-src': Object.freeze(['https:']),"), /network source https: to script-src/);
bites('real B3: the "network" feature adds http:', 'b3-csp-nav-perms', sub('loader/src/protocols.js', "'img-src': Object.freeze(['https:']),", "'img-src': Object.freeze(['https:', 'http:']),"), /http:/);
bites('real B3: windowNetAllowed lets scripts out', 'b3-csp-nav-perms', sub('loader/src/window-net.js', "const NET_TYPES = Object.freeze(['xhr',", "const NET_TYPES = Object.freeze(['script', 'subFrame', 'xhr',"), /windowNetAllowed lets https:\/\/a\.example\.com\/x\.js \(script\)/);
bites('real B3: windowNetAllowed lets http out', 'b3-csp-nav-perms', sub('loader/src/window-net.js', "const NET_SCHEMES = Object.freeze(['https:', 'wss:']);", "const NET_SCHEMES = Object.freeze(['https:', 'wss:', 'http:', 'ws:']);"), /http:\/\/a\.example\.com/);
bites('real B3: windowNetAllowed lets requests out without an endpoint', 'b3-csp-nav-perms', sub('loader/src/window-net.js', "if (!state || !Number.isInteger(state.port) || !details || typeof details.url !== 'string') return false;", "if (!details || typeof details.url !== 'string') return false;"), /without a window endpoint/);
bites('real B3: windowNetAllowed lets addresses and local names out', 'b3-csp-nav-perms', sub('loader/src/window-net.js', '  if (LOCAL_NAME.test(host)) return false;\n', ''), /localhost|\.local|\.lan/);
bites('real B3: window-net.js requires a module', 'b3-csp-nav-perms', sub('loader/src/window-net.js', "const NET_SCHEMES = ", "const fs = require('fs');\nconst NET_SCHEMES = "), /self-contained/);
bites('real B3: the request filter lets everything out while an endpoint is set', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', 'windowNetAllowed(windowNet.get(appId), details)', 'windowNet.has(appId)'), /must cancel every request/);
bites('real B3: the login handler answers every authentication', 'b3-csp-nav-perms', sub('loader/main.js', '  if (!creds) return;\n  event.preventDefault();', "  event.preventDefault();\n  if (!creds) return callback('vmapp', 'guess');"), /'login' handler/);
bites('real B3: a second login handler', 'b3-csp-nav-perms', append('loader/src/runner.js', "\nrequire('electron').app.on('login', (e, wc, d, a, cb) => { e.preventDefault(); cb('u', 'p'); });\n"), /login/);
bites('real B3: windowProxyCredentials answers a site login', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', "if (!authInfo || authInfo.isProxy !== true || String(authInfo.scheme).toLowerCase() !== 'basic') return null;", 'if (!authInfo) return null;'), /proxy authentication/);
bites('real B3: windowProxyCredentials answers another partition', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', '    if (webContents && webContents.session !== electronSession.fromPartition(partitionOf(appId))) return null;\n', ''), /own partition/);
bites('real B3: a proxy set outside the window manager', 'b3-csp-nav-perms', append('loader/src/runner.js', "\nrequire('electron').session.defaultSession.setProxy({ proxyRules: 'http=proxy.example.com:3128' });\n"), /setProxy outside/);
bites('real B3: the endpoint proxy lets loopback bypass it', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', "proxyBypassRules: '<-loopback>'", "proxyBypassRules: '<local>'"), /window endpoint/);
bites('real B3: the filter opens before the proxy is the endpoint', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', "    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http=${at};https=${at}`, proxyBypassRules: '<-loopback>' });\n", ''), /windowNet\.set/);
bites('real B3: the filter opens somewhere else too', 'b3-csp-nav-perms', sub('loader/src/window-manager.js', '    const proxy = this.session && this.session.windowProxy;\n', '    const proxy = this.session && this.session.windowProxy;\n    if (proxy) windowNet.set(this.app.id, proxy);\n'), /windowNet\.set/);
bites('real B3: the session logs the endpoint secret', 'b3-csp-nav-perms', sub('hostlib/session.js', "this.log('info', 'host', `window network: through the app's proxy on 127.0.0.1:${port}, with the app's network permissions`);", "this.log('debug', 'host', `window endpoint ${port} ${secret}`);"), /secret/);
// port forwarding (SPEC 8.8): the guest's one connect, to its own loopback only
bites('real N1: port forwarding connects to an address it was given', 'n1-no-guest-egress', sub('guest/src/portfwd.rs', 'let target = SocketAddr::from((Ipv4Addr::LOCALHOST, port));', 'let target = SocketAddr::from((Ipv4Addr::new(192, 168, 1, 1), port));'), /portfwd|loopback/);
bites('real N1: a second connect in the port forwarder', 'n1-no-guest-egress', append('guest/src/portfwd.rs', '\nfn leak() { let _ = TcpStream::connect("1.1.1.1:443"); }\n'), /connect once/);
bites('real N1: a connect elsewhere in the guest', 'n1-no-guest-egress', append('guest/src/netproxy.rs', '\nfn leak() { let _ = TcpStream::connect_timeout(&"1.1.1.1:443".parse().unwrap(), std::time::Duration::from_secs(1)); }\n'), /TcpStream::connect in the guest/);
bites('real N1: a forward listens on every interface', 'n3-address-check', sub('host/src/net.rs', 'TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))', 'TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))'), /loopback only/);
bites('real N1: the launcher listens on every interface', 'n3-address-check', sub('host/src/net.rs', 'TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))', 'TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)))'), /loopback only/);
