'use strict';
// Every rule: PASS on the good fixture tree, FAIL (or WARN) on a violating variant of it.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { VMAPP, check, edit, write, remove, messages, cleanup } = require('./helpers');

after(cleanup);

const RULES = ['b1-window-prefs', 'b2-preload-api', 'b3-csp-nav-perms', 'b4-ui-handler', 'c2-request-ops', 'a1-no-code-exec', 'g3-no-network', 'u1-launcher-updates', 'deps-none', 'd1-no-vm-network', 'd4-guest-privileges', 'e2-no-panics', 'f2-pinned-bases', 'n1-no-guest-egress', 'n3-address-check', 'h7-gpu-service', 'h8-krun-sandbox'];

test('the good fixture passes every rule', () => {
  const { results, byId } = check();
  assert.deepEqual(Object.keys(byId), RULES);
  for (const r of results) assert.equal(r.status, 'PASS', `${r.id}: ${messages(r)}`);
});

/**
 * One case: apply `mutate` to a copy of the good tree; `rule` must get `status` (and a finding matching `match`);
 * no other rule may FAIL (unless listed in `alsoFails`).
 */
function violates(name, rule, mutate, { status = 'FAIL', match, alsoFails = [] } = {}) {
  test(name, () => {
    const { results, byId } = check(mutate);
    const r = byId[rule];
    assert.ok(r, `unknown rule ${rule}`);
    assert.equal(r.status, status, `${rule} should be ${status}; findings: ${messages(r)}`);
    if (match) assert.match(messages(r), match);
    for (const o of results) {
      if (o.id !== rule && !alsoFails.includes(o.id)) assert.notEqual(o.status, 'FAIL', `${o.id} also failed: ${messages(o)}`);
      assert.notEqual(o.status, 'ERROR', `${o.id}: ${o.error}`);
    }
  });
}

const WM = 'loader/src/window-manager.js';
const MAIN = 'loader/main.js';
const PRE = 'loader/preload-app.js';
const PROT = 'loader/src/protocols.js';
const SESS = 'hostlib/session.js';

// ------------------------------------------------------------------------------------------------ B1
violates('B1: sandbox: false in an app window', 'b1-window-prefs', (r) => edit(r, WM, 'sandbox: true', 'sandbox: false'), { match: /sandbox must be true/ });
violates('B1: nodeIntegration: true in an app window', 'b1-window-prefs', (r) => edit(r, WM, 'nodeIntegration: false,', 'nodeIntegration: true,'), { match: /nodeIntegration must be false/ });
violates('B1: contextIsolation: false in an app window', 'b1-window-prefs', (r) => edit(r, WM, 'contextIsolation: true', 'contextIsolation: false'));
violates('B1: webSecurity: false', 'b1-window-prefs', (r) => edit(r, WM, 'webSecurity: true', 'webSecurity: false'));
violates('B1: webviewTag: true', 'b1-window-prefs', (r) => edit(r, WM, 'webviewTag: false', 'webviewTag: true'));
violates('B1: allowRunningInsecureContent removed', 'b1-window-prefs', (r) => edit(r, WM, '        allowRunningInsecureContent: false,\n', ''), { match: /allowRunningInsecureContent is not set/ });
violates('B1: nodeIntegrationInSubFrames removed', 'b1-window-prefs', (r) => edit(r, WM, '        nodeIntegrationInSubFrames: false,\n', ''), { match: /nodeIntegrationInSubFrames is not set/ });
violates('B1: nodeIntegrationInWorker: true', 'b1-window-prefs', (r) => edit(r, WM, 'nodeIntegrationInWorker: false', 'nodeIntegrationInWorker: true'));
violates('B1: preload is not the loader\'s preload-app.js', 'b1-window-prefs', (r) => edit(r, WM, 'preload: this.preload,', "preload: '/tmp/evil-preload.js',"), { match: /preload/ });
violates('B1: the app preload is also assigned a different script elsewhere', 'b1-window-prefs', (r) => edit(r, 'loader/src/runner.js', 'preload: this.cfg.preloadApp,', "preload: require('path').join(app.dir, 'preload.js'),"), { alsoFails: ['a1-no-code-exec'], match: /preload/ });
violates('B1: partition is not persist:vmapp-<id>', 'b1-window-prefs', (r) => edit(r, WM, 'partition: partitionOf(this.app.id),', "partition: 'persist:shared',"), { match: /partition/ });
violates('B1: partition removed', 'b1-window-prefs', (r) => edit(r, WM, '        partition: partitionOf(this.app.id),\n', ''), { match: /partition is not set/ });
violates('B1: an extra app window with webPreferences spread from a variable', 'b1-window-prefs', (r) =>
  write(r, 'loader/src/extra.js', "const { BrowserWindow } = require('electron');\nconst prefs = { sandbox: false };\nnew BrowserWindow({ webPreferences: { ...prefs } });\n"), { match: /spread|object literal|not set/ });
violates('B1: a WebContentsView without webPreferences', 'b1-window-prefs', (r) =>
  write(r, 'loader/src/view.js', "const { WebContentsView } = require('electron');\nmodule.exports = () => new WebContentsView({});\n"), { match: /no explicit webPreferences/ });
violates('B1: a loader-owned window with nodeIntegration: true', 'b1-window-prefs', (r) => edit(r, MAIN, 'nodeIntegration: false,\n      webSecurity', 'nodeIntegration: true,\n      webSecurity'));
violates('B1: a loader-owned window without sandbox', 'b1-window-prefs', (r) => edit(r, MAIN, '      sandbox: true,\n', ''));
violates('B1: a session object instead of the partition string', 'b1-window-prefs', (r) => edit(r, WM, 'contextIsolation: true,', 'session: null,\n        contextIsolation: true,'), { match: /session/ });
// devTools: an app window's equals the core's window.create value (default false, dev and packaged); a loader window's is !cfg.isPackaged
violates('B1: devTools: true (a constant) in an app window', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', '        devTools: true,\n'), { match: /devTools must be <params>\.devTools === true/ });
violates('B1: devTools follows the build mode in an app window', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', '        devTools: !this.cfg.isPackaged,\n'), { match: /devTools must be <params>\.devTools === true/ });
violates('B1: devTools from an environment variable in an app window', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', '        devTools: process.env.VMAPP_DEVTOOLS === "1",\n'), { match: /devTools must be/ });
violates('B1: devTools is not strictly boolean (truthy strings would enable it)', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', '        devTools: !!params.devTools,\n'), { match: /devTools must be/ });
violates('B1: devTools removed from an app window', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', ''), { match: /devTools is not set/ });
violates('B1: devTools read from somewhere other than create(params)', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', '        devTools: this.devTools === true,\n'), { match: /not the first parameter of create/ });
violates('B1: devTools read from the app record instead of the request', 'b1-window-prefs', (r) => edit(r, WM, '        devTools: params.devTools === true,\n', '        devTools: this.app.devTools === true,\n'), { match: /devTools must be <params>/ });
violates('B1: the window registry record claims devTools: true as a constant', 'b1-window-prefs', (r) => edit(r, WM, 'win, devTools: params.devTools === true }', 'win, devTools: true }'), { match: /devTools is set from 'true'/ });
violates('B1: another module hands devTools: true to the window manager', 'b1-window-prefs', (r) => edit(r, 'loader/src/runner.js', '      preload: this.cfg.preloadApp,\n', '      preload: this.cfg.preloadApp,\n      devTools: true,\n'), { match: /devTools is set from 'true'/ });
violates('B1: a loader-owned window without devTools', 'b1-window-prefs', (r) => edit(r, MAIN, '      devTools: !cfg.isPackaged,\n', ''), { match: /devTools is not set/ });
violates('B1: a loader-owned window with devTools: true', 'b1-window-prefs', (r) => edit(r, MAIN, 'devTools: !cfg.isPackaged,', 'devTools: true,'), { match: /devTools must be !cfg\.isPackaged/ });
violates('B1: the devtools-opened closer is gone', 'b1-window-prefs', (r) => edit(r, MAIN, /  \/\/ DevTools only for[^\n]*\n  if \(app\.isPackaged\)[^\n]*\n/, ''), { match: /devtools-opened/ });
violates('B1: a <webview> in the loader UI', 'b1-window-prefs', (r) => write(r, 'loader/ui/library.html', '<html><body><webview src="https://example.com"></webview></body></html>\n'), { match: /webview/ });

// ------------------------------------------------------------------------------------------------ B2
violates('B2: window.vmapp exposes an extra key', 'b2-preload-api', (r) => edit(r, PRE, '  on,\n  menu:', '  on,\n  readFile: (p) => p,\n  menu:'), { match: /extra keys: readFile/ });
violates('B2: window.vmapp.menu exposes more than set and onClick', 'b2-preload-api', (r) => edit(r, PRE, 'menu: { set: menuSet, onClick: menuOnClick }', 'menu: { set: menuSet, onClick: menuOnClick, run: (c) => c }'), { match: /menu keys must be exactly set, onClick/ });
violates('B2: window.vmapp is missing a key', 'b2-preload-api', (r) => edit(r, PRE, '  app: { id: info.id, name: info.name, version: info.version },\n', ''), { match: /missing keys: app/ });
violates('B2: the ipcRenderer alias exposes an extra method', 'b2-preload-api', (r) => edit(r, PRE, '    send,\n    on: (channel', '    send,\n    sendSync: (c) => c,\n    on: (channel'));
violates('B2: a second exposeInMainWorld', 'b2-preload-api', (r) => edit(r, PRE, "contextBridge.exposeInMainWorld('vmapp', {", "contextBridge.exposeInMainWorld('other', { x: 1 });\ncontextBridge.exposeInMainWorld('vmapp', {"), { match: /exactly once/ });
violates('B2: the world is not named vmapp', 'b2-preload-api', (r) => edit(r, PRE, "exposeInMainWorld('vmapp'", "exposeInMainWorld('api'"));
violates('B2: the raw ipcRenderer is exposed', 'b2-preload-api', (r) => edit(r, PRE, /ipcRenderer: \{[^}]*\},\n/s, 'ipcRenderer: ipcRenderer,\n'), { match: /ipcRenderer/ });
violates('B2: invoke is the raw ipcRenderer.invoke', 'b2-preload-api', (r) => edit(r, PRE, '  invoke,\n  send,\n  on,\n  menu', '  invoke: ipcRenderer.invoke,\n  send,\n  on,\n  menu'), { match: /raw ipcRenderer/ });
violates('B2: webFrame in the preload', 'b2-preload-api', (r) => edit(r, PRE, "const { contextBridge, ipcRenderer } = require('electron');", "const { contextBridge, ipcRenderer, webFrame } = require('electron');\nwebFrame.executeJavaScript('1');"));
violates('B2: an app channel routed by a renderer-supplied id', 'b2-preload-api', (r) =>
  edit(r, MAIN, "ipcMain.handle('vmapp:invoke', async (event, channel, args) => {\n  const rec = appRecord(event);", "ipcMain.handle('vmapp:invoke', async (event, channel, args) => {\n  const rec = registry.get(args.webContentsId);"), { match: /sender/ });

// ------------------------------------------------------------------------------------------------ B3
violates("B3: connect-src is not 'none'", 'b3-csp-nav-perms', (r) => edit(r, PROT, "connect-src 'none'", "connect-src 'self'"), { match: /connect-src/ });
violates('B3: unsafe-eval in script-src', 'b3-csp-nav-perms', (r) => edit(r, PROT, "script-src 'self';", "script-src 'self' 'unsafe-eval';"), { match: /script-src/ });
violates('B3: unsafe-inline in script-src', 'b3-csp-nav-perms', (r) => edit(r, PROT, "script-src 'self';", "script-src 'self' 'unsafe-inline';"));
violates('B3: * in a directive', 'b3-csp-nav-perms', (r) => edit(r, PROT, "img-src 'self' data: blob:", 'img-src *'));
violates('B3: a directive of SPEC 7 is dropped', 'b3-csp-nav-perms', (r) => edit(r, PROT, " frame-src 'none';", ''), { match: /frame-src/ });
violates('B3: a response without the app CSP', 'b3-csp-nav-perms', (r) => edit(r, PROT, "respond(200, data, 'text/html', APP_CSP)", "respond(200, data, 'text/html', 'default-src *')"), { match: /without the app CSP/ });
violates('B3: respond() does not set the header', 'b3-csp-nav-perms', (r) => edit(r, PROT, ", 'content-security-policy': csp", ''), { match: /respond\(\)/ });
violates('B3: window.open allowed', 'b3-csp-nav-perms', (r) => edit(r, WM, "({ action: 'deny' })", "({ action: 'allow' })"), { match: /deny/ });
violates('B3: no window-open handler anywhere', 'b3-csp-nav-perms', (r) => {
  edit(r, WM, "    bw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));\n", '');
  edit(r, MAIN, "  contents.setWindowOpenHandler(() => ({ action: 'deny' }));\n", '');
}, { match: /no setWindowOpenHandler/ });
violates('B3: permission requests granted', 'b3-csp-nav-perms', (r) => edit(r, WM, '(wc, permission, callback) => callback(false)', '(wc, permission, callback) => callback(true)'), { match: /unconditional deny/ });
violates('B3: permission requests granted for some permissions', 'b3-csp-nav-perms', (r) => edit(r, WM, '(wc, permission, callback) => callback(false)', "(wc, permission, callback) => callback(permission === 'clipboard-read')"));
violates('B3: permission request handler reset to null', 'b3-csp-nav-perms', (r) => edit(r, WM, 'ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));', 'ses.setPermissionRequestHandler(null);\n  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));'));
violates('B3: permission check returns true', 'b3-csp-nav-perms', (r) => edit(r, WM, 'ses.setPermissionCheckHandler(() => false);', 'ses.setPermissionCheckHandler(() => true);'), { match: /false/ });
violates('B3: permission check returns true for some', 'b3-csp-nav-perms', (r) => edit(r, MAIN, 'ses.setPermissionCheckHandler(() => false);', "ses.setPermissionCheckHandler((wc, permission) => {\n    if (permission === 'media') return true;\n    return false;\n  });"));
violates('B3: will-navigate guard removed', 'b3-csp-nav-perms', (r) => edit(r, MAIN, "  contents.on('will-navigate', block);\n", ''), { match: /will-navigate/ });
violates('B3: will-navigate handler never prevents', 'b3-csp-nav-perms', (r) => edit(r, MAIN, 'if (!allowed(url)) e.preventDefault();', 'if (!allowed(url)) console.log(url);'), { match: /preventDefault/ });

// The microphone gate (SPEC 2.2 permissions.devices, SPEC 7): the only way a permission handler may answer `true`. The tree gets
// the REAL loader/src/devices.js and the app partition's handlers wired through it exactly as loader/src/window-manager.js does.
const GATE = 'loader/src/devices.js';
const REQ_WIRED = 'callback(microphoneRequestAllowed(devices, appId, wc, permission, details))';
const CHK_WIRED = '(wc, permission, origin, details) => microphoneCheckAllowed(devices, appId, wc, permission, details)';
const withGate = (r) => {
  write(r, GATE, fs.readFileSync(path.join(VMAPP, GATE), 'utf8'));
  edit(r, WM, 'callback(false)', REQ_WIRED);
  edit(r, WM, '(wc, permission, callback) => ', '(wc, permission, callback, details) => ');
  edit(r, WM, 'ses.setPermissionCheckHandler(() => false);', `ses.setPermissionCheckHandler(${CHK_WIRED});`);
};
const gated = (mutate) => (r) => {
  withGate(r);
  mutate(r);
};
test('B3: handlers wired through the real microphone gate pass', () => {
  const { results, byId } = check(withGate);
  assert.equal(byId['b3-csp-nav-perms'].status, 'PASS', messages(byId['b3-csp-nav-perms']));
  for (const r of results) assert.notEqual(r.status, 'FAIL', `${r.id}: ${messages(r)}`);
});
violates('B3 gate: the request handler answers true', 'b3-csp-nav-perms', gated((r) => edit(r, WM, REQ_WIRED, 'callback(true)')), { match: /unconditional deny/ });
violates('B3 gate: the request handler ORs the gate with true', 'b3-csp-nav-perms', gated((r) => edit(r, WM, REQ_WIRED, `callback(${'microphoneRequestAllowed(devices, appId, wc, permission, details)'} || true)`)), { match: /unconditional deny/ });
violates('B3 gate: the request handler gets a non-plain argument list', 'b3-csp-nav-perms', gated((r) => edit(r, WM, REQ_WIRED, "callback(microphoneRequestAllowed(devices, appId, wc, permission, { mediaTypes: ['audio'] }))")), { match: /unconditional deny/ });
violates('B3 gate: the request handler answers through some other function', 'b3-csp-nav-perms', gated((r) => edit(r, WM, REQ_WIRED, 'callback(somethingElse(devices, appId, wc, permission, details))')), { match: /unconditional deny/ });
violates('B3 gate: the check handler answers true', 'b3-csp-nav-perms', gated((r) => edit(r, WM, CHK_WIRED, '() => true')), { match: /false/ });
violates('B3 gate: the check handler is the gate OR true', 'b3-csp-nav-perms', gated((r) => edit(r, WM, CHK_WIRED, `${CHK_WIRED.replace('=> ', '=> true || ')}`)), { match: /false/ });
violates('B3 gate: the gate function is missing', 'b3-csp-nav-perms', gated((r) => remove(r, GATE)), { match: /exactly once in loader\/ \(found 0\)/ });
violates('B3 gate: the gate function is defined twice', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'module.exports = {', 'function microphoneRequestAllowed() {\n  return false;\n}\nmodule.exports = {')), { match: /exactly once in loader\/ \(found 2\)/ });
violates('B3 gate: the permission name is no longer checked', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, "  if (permission !== 'media') {\n    gate.refused(appId, permission, details);\n    return false;\n  }\n", '')), { match: /permission !== 'media'/ });
violates('B3 gate: the media type list is no longer required to be exactly one', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'types.length !== 1 || ', '')), { match: /exactly \['audio'\]/ });
violates('B3 gate: the type that is let through is not audio', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, "types[0] !== 'audio'", "types[0] !== 'video'")), { match: /exactly \['audio'\]|video or camera|audio/ });
violates('B3 gate: video is mentioned in the gate', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'const types = details && details.mediaTypes;', "const types = details && details.mediaTypes;\n  void 'video';")), { match: /video or camera/ });
violates('B3 gate: the gate answers true by itself', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'return gate.requestAllowed(appId, wc, details) === true;', 'return true;')), { match: /last return/ });
violates('B3 gate: an early return that is not false', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'if (!gate) return false;\n  if (permission !== \'media\') {', "if (!gate) return false;\n  if (permission === 'media' && !details) return true;\n  if (permission !== 'media') {")), { match: /not false/ });
violates('B3 gate: the check no longer requires the audio media type', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, "if (!details || details.mediaType !== 'audio') return false;\n", '')), { match: /mediaType === 'audio'/ });
violates('B3 gate: the grant is no longer consulted', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, /      if \(!deviceAllowed\(app\.manifest, this\.store\.loadGrants\(appId\), device\)\)[^\n]*\n/, '')), { match: /deviceAllowed/ });
violates('B3 gate: _why no longer limits the devices a window may use', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, /      if \(device !== 'microphone' && device !== 'clipboard'\)[^\n]*\n/, '')), { match: /one a window may use/ });

// The clipboard gate (DEV-APPS C5): the second device, wired the same way and checked as strictly.
const CLIP_REQ = 'callback(clipboardRequestAllowed(devices, appId, wc, permission, details))';
const CLIP_CHK = '(wc, permission, origin, details) => clipboardCheckAllowed(devices, appId, wc, permission, details)';
const withClip = (r) => {
  write(r, GATE, fs.readFileSync(path.join(VMAPP, GATE), 'utf8'));
  edit(r, WM, 'callback(false)', CLIP_REQ);
  edit(r, WM, '(wc, permission, callback) => ', '(wc, permission, callback, details) => ');
  edit(r, WM, 'ses.setPermissionCheckHandler(() => false);', `ses.setPermissionCheckHandler(${CLIP_CHK});`);
};
const clipped = (mutate) => (r) => {
  withClip(r);
  mutate(r);
};
test('B3: handlers wired through the real clipboard gate pass', () => {
  const { byId } = check(withClip);
  assert.equal(byId['b3-csp-nav-perms'].status, 'PASS', messages(byId['b3-csp-nav-perms']));
});
violates('B3 clipboard gate: it no longer refuses other permissions', 'b3-csp-nav-perms', clipped((r) => edit(r, GATE, "  if (permission !== 'clipboard-read' && permission !== 'clipboard-sanitized-write') {\n    gate.refused(appId, permission, details);\n    return false;\n  }\n", '')), { match: /clipboard-read/ });
violates('B3 clipboard gate: it answers true by itself', 'b3-csp-nav-perms', clipped((r) => edit(r, GATE, 'return gate.clipboardAllowed(appId, wc, details, permission) === true;', 'return true;')), { match: /last return/ });
violates('B3 clipboard gate: it lets media through', 'b3-csp-nav-perms', clipped((r) => edit(r, GATE, "if (permission !== 'clipboard-read' && permission !== 'clipboard-sanitized-write') return false;", "if (permission !== 'clipboard-read' && permission !== 'clipboard-sanitized-write' && permission !== 'media') return false;")), { match: /media devices/ });
violates('B3 clipboard gate: DeviceGate.clipboardAllowed decides without _why', 'b3-csp-nav-perms', clipped((r) => edit(r, GATE, "const why = this._why(appId, wc, details, 'clipboard');", 'const why = null;')), { match: /_why\(\.\.\., 'clipboard'\)/ });
violates('B3 clipboard gate: the request handler answers through some other function', 'b3-csp-nav-perms', clipped((r) => edit(r, WM, CLIP_REQ, 'callback(clipboardAnything(devices, appId, wc, permission, details))')), { match: /unconditional deny/ });
violates('B3 gate: the window registry is no longer consulted', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'const rec = wc && this.registry.get(wc.id);', 'const rec = { appId };')), { match: /registry lookup/ });
violates('B3 gate: the main-frame check is gone', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, /      if \(!details \|\| details\.isMainFrame === false\)[^\n]*\n/, '')), { match: /main-frame/ });
violates('B3 gate: the origin check is gone', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, /      const url = details\.requestingUrl[^\n]*\n      if \(typeof url[^\n]*\n/, '')), { match: /origin check/ });
violates('B3 gate: _why can answer true', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'return null;\n    } catch (e) {', 'return true;\n    } catch (e) {')), { match: /never true|return a reason or null/ });
violates('B3 gate: requestAllowed no longer decides with _why', 'b3-csp-nav-perms', gated((r) => edit(r, GATE, 'const why = this._why(appId, wc, details);\n    this._record(appId, { cap', 'const why = null;\n    this._record(appId, { cap')), { match: /_why\(\.\.\.\) === null/ });

// A stricter CSP passes
test('B3: a stricter CSP (fewer sources, extra directives) passes', () => {
  const { byId } = check((r) => {
    edit(r, PROT, "img-src 'self' data: blob:", "img-src 'self'");
    edit(r, PROT, "form-action 'none'", "form-action 'none'; worker-src 'none'");
  });
  assert.equal(byId['b3-csp-nav-perms'].status, 'PASS', messages(byId['b3-csp-nav-perms']));
});
test('B3: a CSP written differently (spacing, trailing semicolon) but equal passes', () => {
  const { byId } = check((r) => {
    edit(r, PROT, "default-src 'self'; script-src 'self';", "default-src   'self' ;  script-src 'self' ;");
  });
  assert.equal(byId['b3-csp-nav-perms'].status, 'PASS', messages(byId['b3-csp-nav-perms']));
});
test('B3: a looser source in a known directive fails', () => {
  const { byId } = check((r) => edit(r, PROT, "font-src 'self' data:", "font-src 'self' data: https://fonts.example"));
  assert.equal(byId['b3-csp-nav-perms'].status, 'FAIL');
  assert.match(messages(byId['b3-csp-nav-perms']), /font-src/);
});

// ------------------------------------------------------------------------------------------------ B4
violates('B4: the SHA-256 comparison removed', 'b4-ui-handler', (r) => edit(r, PROT, "      if (got !== want) return notFound();\n", ''), { match: /never compared/ });
violates('B4: no hash computed', 'b4-ui-handler', (r) => edit(r, PROT, "crypto.createHash('sha256')", "crypto.createHash('md5')"), { match: /SHA-256/ });
violates('B4: no manifest files lookup', 'b4-ui-handler', (r) => edit(r, PROT, 'const want = Object.prototype.hasOwnProperty.call(m.files, key) ? m.files[key] : null;', 'const want = key;'), { match: /files/, alsoFails: [] });
violates('B4: no containment check', 'b4-ui-handler', (r) => edit(r, PROT, "if (rel.split('/').some((c) => c === '' || c === '.' || c === '..')) return null;", ''), { match: /containment/ });
violates('B4: no symlink check', 'b4-ui-handler', (r) => edit(r, PROT, 'await fs.promises.lstat(file)', 'await fs.promises.stat(file)'), { match: /symlink/ });
violates('B4: the handler is gone', 'b4-ui-handler', (r) => {
  edit(r, PROT, 'function createAppUiHandler(contexts) {', 'function somethingElse(contexts) {');
  edit(r, PROT, 'return async function handleAppUi(request) {', 'return async function other(request) {');
}, { match: /not found/ });

// ------------------------------------------------------------------------------------------------ C2
violates('C2: an op that is not in SPEC 6', 'c2-request-ops', (r) => edit(r, SESS, "      case 'app.quit':", "      case 'fs.readFile':\n        return { data: 'x' };\n      case 'app.quit':"), { match: /fs\.readFile/ });
violates('C2: a SPEC 6 op is not handled', 'c2-request-ops', (r) => edit(r, SESS, /      case 'app.quit':\n        setImmediate\(\(\) => this.stop\(\)\);\n        return \{\};\n/, ''), { match: /app\.quit/ });
violates('C2: dialog.open without the dialogs permission check', 'c2-request-ops', (r) => edit(r, SESS, "    if (!this.manifest.permissions.dialogs) throw new Error('permission denied: dialogs');\n", ''), { match: /dialog\.open.*permissions\.dialogs/ });
violates('C2: shell.openExternal without the external permission check', 'c2-request-ops', (r) => edit(r, SESS, "        if (!this.manifest.permissions.external) throw new Error('permission denied: external');\n", ''), { match: /shell\.openExternal.*permissions\.external/ });
violates('C2: the default clause does not reply with an error', 'c2-request-ops', (r) => edit(r, SESS, "        throw new Error(`unknown op: ${op}`);", '        return {};'), { match: /default clause/ });
violates('C2: no default clause', 'c2-request-ops', (r) => edit(r, SESS, /      default:\n        throw new Error\(`unknown op: \$\{op\}`\);\n/, ''), { match: /no default clause/ });
violates('C2: ops moved to a map with an extra op', 'c2-request-ops', (r) => {
  edit(r, SESS, /  async _request\(op, params\) \{[\s\S]*?\n  \}\n\n  stop/, "  async _request(op, params) {\n    const handlers = {\n      'window.create': () => 1,\n      'window.close': () => 1,\n      'dialog.open': () => 1,\n      'dialog.save': () => 1,\n      'dialog.message': () => 1,\n      'shell.openExternal': () => 1,\n      'app.quit': () => 1,\n      'clipboard.read': () => 1,\n    };\n    return handlers[op](params);\n  }\n\n  stop");
}, { match: /clipboard\.read/, alsoFails: [] });
const CAPS = 'hostlib/capabilities.js';
const HP = 'hostlib/hostproc.js';
violates('C2: a SPEC 8.2 op is not handled in session.js', 'c2-request-ops', (r) => edit(r, SESS, "      case 'host.tool.run':\n", ''), { match: /host\.tool\.run/ });
violates('C2: a host.* op without the permissions.host check', 'c2-request-ops', (r) => edit(r, SESS, "    if (!(this.manifest.permissions.host || []).length) throw new Error('permission denied: host');\n", ''), { match: /host\.screen\.windows.*permissions\.host/ });
violates('C2: a host.* op in the broker never authorizes', 'c2-request-ops', (r) => edit(r, CAPS, "        await this._authorize(ctx, st, rec, `tool:${p.id}`);\n", ''), { match: /host\.tool\.run.*_authorize/ });
violates('C2: the broker acts before authorizing', 'c2-request-ops', (r) => edit(r, CAPS, "        await this._authorize(ctx, st, rec, 'screen');\n        return this._ctlRequest('windows');", "        const w = await this._ctlRequest('windows');\n        await this._authorize(ctx, st, rec, 'screen');\n        return w;"), { match: /before _authorize/ });
violates('C2: the broker no longer checks the grant', 'c2-request-ops', (r) => {
  edit(r, CAPS, "    const grants = ctx.grants();\n", '');
  edit(r, CAPS, "    if (!grants[cap]) return { ok: false, reason: 'not granted' };\n", '');
}, { match: /grant/ });
violates('C2: the broker dispatch has no default', 'c2-request-ops', (r) => edit(r, CAPS, "      default:\n        throw new Error(`unknown host op: ${op}`);\n", ''), { match: /no default clause/ });
violates('C2: the broker is missing', 'c2-request-ops', (r) => remove(r, CAPS), { match: /broker/ });
violates('C2: a broker op outside SPEC 8.2', 'c2-request-ops', (r) => edit(r, CAPS, "      default:\n", "      case 'host.fs.read':\n        await this._authorize(ctx, st, rec, 'screen');\n        return {};\n      default:\n"), { match: /host\.fs\.read/ });

// ------------------------------------------------------------------------------------------------ A1, host processes
violates('A1: child_process in a new hostlib file next to hostproc.js', 'a1-no-code-exec', (r) => write(r, 'hostlib/capabilities-extra.js', "const cp = require('child_process');\nmodule.exports = (f) => cp.spawn(f, []);\n"), { match: /child_process outside/ });
violates('A1: hostproc.js spawns with a shell', 'a1-no-code-exec', (r) => edit(r, HP, "stdio: 'pipe', shell: false, detached: true", "stdio: 'pipe', shell: true, detached: true"), { match: /shell/ });
violates('A1: hostproc.js uses exec with a string command', 'a1-no-code-exec', (r) => edit(r, HP, 'function startTool(file, args, opts) {', "function startTool(file, args, opts) {\n  cp.exec(file + ' ' + args.join(' '));"), { match: /exec\(\)/ });
violates('A1: hostproc.js uses execSync', 'a1-no-code-exec', (r) => edit(r, HP, 'function startTool(file, args, opts) {', "function startTool(file, args, opts) {\n  cp.execSync(file);"), { match: /execSync/ });
violates('A1: hostproc.js spawns a command assembled from strings (warning)', 'a1-no-code-exec', (r) => edit(r, HP, 'cp.spawn(file, args,', "cp.spawn('/bin/' + file, args,"), { status: 'WARN', match: /not traceable/ });
violates('A1: session.js may not use execFile (only hostproc.js may)', 'a1-no-code-exec', (r) => edit(r, SESS, "cp.spawn('open', [url], { stdio: 'ignore', detached: true }).unref();", "cp.execFile('open', [url]);"), { match: /execFile/ });

// ------------------------------------------------------------------------------------------------ A1
violates('A1: eval in the loader', 'a1-no-code-exec', (r) => write(r, 'loader/src/x.js', "module.exports = (s) => eval(s);\n"), { match: /eval/ });
violates('A1: new Function in hostlib', 'a1-no-code-exec', (r) => write(r, 'hostlib/x.js', "module.exports = (s) => new Function('a', s);\n"), { match: /Function/ });
violates('A1: vm.runInNewContext', 'a1-no-code-exec', (r) => write(r, 'hostlib/x.js', "const vm = require('vm');\nmodule.exports = (s) => vm.runInNewContext(s);\n"), { match: /vm/ });
violates('A1: require with a variable', 'a1-no-code-exec', (r) => write(r, 'loader/src/x.js', "module.exports = (p) => require(p);\n"), { match: /non-literal/, alsoFails: [] });
violates('A1: require with a concatenated string', 'a1-no-code-exec', (r) => write(r, 'loader/src/x.js', "module.exports = (n) => require('./plugins/' + n);\n"), { match: /non-literal/ });
violates('A1: dynamic import', 'a1-no-code-exec', (r) => write(r, 'hostlib/x.js', "module.exports = (p) => import(p);\n"), { match: /import/ });
violates('A1: a native addon', 'a1-no-code-exec', (r) => write(r, 'loader/src/x.js', "module.exports = require('./build/addon.node');\n"), { match: /native addon/ });
violates('A1: child_process in the loader', 'a1-no-code-exec', (r) => write(r, 'loader/src/x.js', "const { spawn } = require('child_process');\nmodule.exports = () => spawn('ls');\n"), { match: /child_process outside/ });
violates('A1: child_process in hostlib outside session.js', 'a1-no-code-exec', (r) => write(r, 'hostlib/x.js', "const cp = require('node:child_process');\nmodule.exports = (c) => cp.execSync(c);\n"), { match: /child_process outside/ });
violates('A1: exec in session.js', 'a1-no-code-exec', (r) => edit(r, SESS, "cp.spawn('open', [url], { stdio: 'ignore', detached: true }).unref();", "cp.execSync('open ' + url);"), { match: /execSync/ });
violates('A1: spawn with a shell in session.js', 'a1-no-code-exec', (r) => edit(r, SESS, "{ stdio: ['pipe', 'pipe', 'pipe'] }", "{ stdio: 'pipe', shell: true }"), { match: /shell/ });
violates('A1: setTimeout with a string', 'a1-no-code-exec', (r) => write(r, 'loader/src/x.js', "setTimeout('doIt()', 10);\n"), { match: /timer/ });
test('A1: eval inside a string or a comment is not a violation', () => {
  const { byId } = check((r) => write(r, 'loader/src/x.js', "// eval(x) is bad\nconst s = 'eval(x) and new Function(y)';\nconst t = `${1} eval(`;\nmodule.exports = { s, t };\n"));
  assert.equal(byId['a1-no-code-exec'].status, 'PASS', messages(byId['a1-no-code-exec']));
});

// ------------------------------------------------------------------------------------------------ G3
violates('G3: fetch in the loader is a warning', 'g3-no-network', (r) => write(r, 'loader/src/x.js', "module.exports = () => fetch('https://example.com/update');\n"), { status: 'WARN', match: /fetch|URL/ });
violates('G3: electron net.request is a warning', 'g3-no-network', (r) => write(r, 'loader/src/x.js', "const { net } = require('electron');\nmodule.exports = () => net.request('x');\n"), { status: 'WARN', match: /net/ });
violates('G3: require https is a warning', 'g3-no-network', (r) => write(r, 'loader/src/x.js', "module.exports = require('https');\n"), { status: 'WARN', match: /https/ });

// ------------------------------------------------------------------------------------------------ U1
// A conforming launcher updater (loader/src/updater.js, SPEC 8.10) and its wiring in main.js, then one mutation per guarantee.
const UPD = 'loader/src/updater.js';
const UPD_GOOD = `'use strict';
const { fetchLauncherFeed } = require('../../hostlib/updates');
const PAGE = 'https://vmapp.dev/download';
class LauncherUpdater {
  constructor(o) {
    this.autoUpdater = o.autoUpdater;
    this.feedUrl = o.feedUrl;
  }

  start() {
    this.timer = setTimeout(() => this.check({ manual: false }), 1000);
  }

  async check({ manual = false } = {}) {
    this.feed = await fetchLauncherFeed(this.feedUrl);
    return manual;
  }

  install() {
    this.autoUpdater.setFeedURL({ url: this.feedUrl, serverType: 'json' });
    this.autoUpdater.checkForUpdates();
  }

  async restart(prepare) {
    await prepare();
    this.autoUpdater.quitAndInstall();
  }
}
module.exports = { LauncherUpdater, PAGE };
`;
const UPD_WIRING = `
const updateHandle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  if (senders.get(event.sender.id) !== 'library' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
  return fn(...args);
});
updateHandle('upd:install', () => updater.install());
updateHandle('upd:restart', () => updater.restart(async () => true));
`;
const UPD_UI = "const api = window.loader.update;\nbutton.addEventListener('click', () => api.install());\nh('button', { onclick: () => api.restart() });\n";
const withUpdater = (r) => {
  write(r, UPD, UPD_GOOD);
  edit(r, 'loader/main.js', /$/, UPD_WIRING);
  write(r, 'loader/ui/update.js', UPD_UI.replace("button.addEventListener('click', () => api.install());", "h('button', { onclick: () => api.install() });"));
};
test('U1: a conforming updater with its wiring and page passes, and G3 raises nothing for it', () => {
  const { byId } = check(withUpdater);
  assert.equal(byId['u1-launcher-updates'].status, 'PASS', messages(byId['u1-launcher-updates']));
  assert.equal(byId['g3-no-network'].status, 'PASS', messages(byId['g3-no-network']));
});
violates('U1: Electron’s updater anywhere else in loader/ fails (and G3 warns)', 'u1-launcher-updates', (r) => { withUpdater(r); write(r, 'loader/src/x.js', "const { autoUpdater } = require('electron');\nmodule.exports = () => autoUpdater;\n"); }, { match: /autoUpdater outside loader\/src\/updater\.js/, alsoFails: [] });
violates('U1: quitAndInstall outside the updater fails', 'u1-launcher-updates', (r) => { withUpdater(r); write(r, 'loader/src/x.js', 'module.exports = (u) => u.quitAndInstall();\n'); }, { match: /quitAndInstall\( outside/ });
violates('U1: fetchLauncherFeed called from another hostlib file fails', 'u1-launcher-updates', (r) => { withUpdater(r); write(r, 'hostlib/x.js', "module.exports = (u) => u.fetchLauncherFeed('x');\n"); }, { match: /fetchLauncherFeed outside hostlib\/updates\.js/ });
violates('U1: quitAndInstall in start() (an automatic restart) fails', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, UPD, 'this.timer = setTimeout(() => this.check({ manual: false }), 1000);', 'this.autoUpdater.quitAndInstall();'); }, { match: /quitAndInstall must be called only in restart\(\)|exactly once/ });
violates('U1: the automatic check installing by itself fails', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, UPD, 'this.feed = await fetchLauncherFeed(this.feedUrl);', 'this.feed = await fetchLauncherFeed(this.feedUrl);\n    this.install();'); }, { match: /check\(\) \(the automatic path\) must never install or restart/ });
violates('U1: a second checkForUpdates() call fails', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, UPD, 'this.feed = await fetchLauncherFeed(this.feedUrl);', 'this.feed = await fetchLauncherFeed(this.feedUrl);\n    this.autoUpdater.checkForUpdates();'); }, { match: /checkForUpdates\(\) must be called exactly once/ });
violates('U1: a feed address built from other parts fails', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, UPD, "{ url: this.feedUrl, serverType: 'json' }", "{ url: this.feedUrl + '?v=1', serverType: 'json' }"); }, { match: /setFeedURL must be called with/ });
violates('U1: another address named in the updater fails', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, UPD, "const PAGE = 'https://vmapp.dev/download';", "const PAGE = 'https://example.com/download';"); }, { match: /only pages on https:\/\/vmapp\.dev\/ may be named here/ });
violates('U1: updater.install() outside the handlers in main.js fails', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, 'loader/main.js', /$/, '\nsetTimeout(() => updater.install(), 10);\n'); }, { match: /only through the upd:install and upd:restart handlers/ });
violates('U1: update handlers that do not check the sender fail', 'u1-launcher-updates', (r) => { withUpdater(r); edit(r, 'loader/main.js', "senders.get(event.sender.id) !== 'library' || ", ''); }, { match: /refuse every sender but the library window/ });
violates('U1: the page calling install outside a click fails', 'u1-launcher-updates', (r) => { withUpdater(r); write(r, 'loader/ui/update.js', 'const api = window.loader.update;\napi.install();\n'); }, { match: /only from a click handler/ });
violates('G3: autoUpdater outside the updater is still a warning', 'g3-no-network', (r) => { withUpdater(r); write(r, 'loader/src/x.js', "const { autoUpdater } = require('electron');\nmodule.exports = autoUpdater;\n"); }, { status: 'WARN', match: /autoUpdater/, alsoFails: ['u1-launcher-updates'] });

// ------------------------------------------------------------------------------------------------ dependencies
violates('deps: loader/package.json has dependencies', 'deps-none', (r) => edit(r, 'loader/package.json', '"devDependencies"', '"dependencies": { "left-pad": "1.3.0" },\n  "devDependencies"'), { match: /dependencies/ });
violates('deps: hostlib has a package.json with dependencies', 'deps-none', (r) => write(r, 'hostlib/package.json', '{ "name": "h", "dependencies": { "x": "1.0.0" } }\n'));
violates('deps: sdk has a package.json with devDependencies', 'deps-none', (r) => write(r, 'sdk/node/package.json', '{ "name": "s", "devDependencies": { "x": "1.0.0" } }\n'));
violates('deps: another devDependency in the loader is a warning', 'deps-none', (r) => edit(r, 'loader/package.json', '"electron": "44.4.5"', '"electron": "44.4.5",\n    "electron-builder": "25.0.0"'), { status: 'WARN', match: /electron-builder/ });
violates('deps: a third-party require', 'deps-none', (r) => write(r, 'hostlib/x.js', "module.exports = require('lodash');\n"), { match: /lodash/ });
violates('deps: a third-party require in the loader', 'deps-none', (r) => write(r, 'loader/src/x.js', "module.exports = require('left-pad');\n"), { match: /left-pad/ });

// ------------------------------------------------------------------------------------------------ D1
const SHIM = 'host/src/shim/vz_shim.m';
violates('D1: a NAT attachment', 'd1-no-vm-network', (r) => edit(r, SHIM, '    cfg.bootLoader = boot;', '    VZNATNetworkDeviceAttachment *nat = [[VZNATNetworkDeviceAttachment alloc] init];\n    (void)nat;\n    cfg.bootLoader = boot;'), { match: /VZNATNetworkDeviceAttachment/ });
violates('D1: a bridged attachment', 'd1-no-vm-network', (r) => edit(r, SHIM, '    cfg.bootLoader = boot;', '    id a = [[VZBridgedNetworkDeviceAttachment alloc] initWithInterface:nil];\n    cfg.bootLoader = boot;'));
violates('D1: a file-handle attachment', 'd1-no-vm-network', (r) => edit(r, SHIM, '    cfg.bootLoader = boot;', '    id a = [[VZFileHandleNetworkDeviceAttachment alloc] initWithFileHandle:nil];\n    cfg.bootLoader = boot;'));
violates('D1: networkDevices assigned', 'd1-no-vm-network', (r) => edit(r, SHIM, '    cfg.bootLoader = boot;', '    cfg.networkDevices = @[];\n    cfg.bootLoader = boot;'), { match: /networkDevices/ });
violates('D1: networkDevices through a setter', 'd1-no-vm-network', (r) => edit(r, SHIM, '    cfg.bootLoader = boot;', '    [cfg setNetworkDevices:@[]];\n    cfg.bootLoader = boot;'));
violates('D1: the networking entitlement', 'd1-no-vm-network', (r) => edit(r, 'host/vmapp.entitlements', '</dict>', '<key>com.apple.vm.networking</key><true/>\n</dict>'));
violates('D1: a network attachment named in Rust', 'd1-no-vm-network', (r) => edit(r, 'host/src/lib.rs', 'pub fn first', 'pub fn net() -> &\'static str {\n    "VZNATNetworkDeviceAttachment"; "x"\n}\n\npub fn first'), { match: /Network/ });

// ------------------------------------------------------------------------------------------------ D4
const MAINRS = 'guest/src/main.rs';
const CORE = 'guest/src/appcore.rs';
violates('D4: setgroups removed', 'd4-guest-privileges', (r) => edit(r, CORE, /    if libc::setgroups\(0, std::ptr::null\(\)\) != 0 \{\n        return Err\(3\);\n    \}\n/, ''), { match: /setgroups/ });
violates('D4: setgid removed', 'd4-guest-privileges', (r) => edit(r, CORE, /    if libc::setgid\(APP_GID\) != 0 \{\n        return Err\(4\);\n    \}\n/, ''), { match: /setgid/ });
violates('D4: setuid(0)', 'd4-guest-privileges', (r) => edit(r, CORE, 'libc::setuid(APP_UID)', 'libc::setuid(0)'), { match: /root|1000/ });
violates('D4: the uid constant is not 1000', 'd4-guest-privileges', (r) => edit(r, CORE, 'pub const APP_UID: u32 = 1000;', 'pub const APP_UID: u32 = 0;'));
violates('D4: PR_SET_NO_NEW_PRIVS removed', 'd4-guest-privileges', (r) => edit(r, CORE, '    libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);\n', ''), { match: /NO_NEW_PRIVS/ });
violates('D4: PR_SET_NO_NEW_PRIVS set to 0', 'd4-guest-privileges', (r) => edit(r, CORE, 'PR_SET_NO_NEW_PRIVS, 1,', 'PR_SET_NO_NEW_PRIVS, 0,'));
violates('D4: chroot removed', 'd4-guest-privileges', (r) => edit(r, CORE, /    if libc::chroot\(root\) != 0 \{\n        return Err\(1\);\n    \}\n/, ''), { match: /chroot/ });
violates('D4: setuid before setgid', 'd4-guest-privileges', (r) => {
  edit(r, CORE, /    if libc::setgid\(APP_GID\) != 0 \{\n        return Err\(4\);\n    \}\n/, '');
  edit(r, CORE, '    libc::prctl(', '    if libc::setgid(APP_GID) != 0 {\n        return Err(4);\n    }\n    libc::prctl(');
}, { match: /before setuid/ });
violates('D4: /rt mounted writable', 'd4-guest-privileges', (r) => edit(r, MAINRS, 'libc::MS_RDONLY | nsd, None).map_err(|e| format!("runtime image', 'nsd, None).map_err(|e| format!("runtime image'), { match: /MS_RDONLY/ });
violates('D4: /rt/app remount without MS_RDONLY', 'd4-guest-privileges', (r) => edit(r, MAINRS, 'libc::MS_REMOUNT | libc::MS_RDONLY | nsd', 'libc::MS_REMOUNT | nsd'), { match: /MS_REMOUNT/ });
violates('D4: /rt/app never remounted', 'd4-guest-privileges', (r) => edit(r, MAINRS, /    mount\("", app, "", libc::MS_REMOUNT[^\n]*\n/, ''), { match: /remounted read-only/ });
test('D4: a violation inside #[cfg(test)] code is ignored; a real one is not', () => {
  const { byId } = check((r) => edit(r, CORE, 'fn unwrap_is_fine_in_tests() {', 'fn unwrap_is_fine_in_tests() {\n        unsafe { libc::setuid(0) };'));
  assert.equal(byId['d4-guest-privileges'].status, 'PASS', messages(byId['d4-guest-privileges']));
});

// ------------------------------------------------------------------------------------------------ E2
violates('E2: println! in the launcher', 'e2-no-panics', (r) => edit(r, 'host/src/lib.rs', '    let _ = writeln!(std::io::stderr(), "{msg}");', '    println!("{msg}");'), { match: /println!/ });
violates('E2: eprintln! in the launcher', 'e2-no-panics', (r) => edit(r, 'host/src/lib.rs', '    let _ = writeln!(std::io::stderr(), "{msg}");', '    eprintln!("{msg}");'), { match: /eprintln!/ });
violates('E2: print! in the launcher binary', 'e2-no-panics', (r) => write(r, 'host/src/bin/vmapp-vm.rs', 'fn main() {\n    print!("x");\n}\n'), { match: /print!/ });
violates('E2: .unwrap() in the guest init', 'e2-no-panics', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    let v: Option<u8> = None;\n    let _ = (setup_root(), name, v.unwrap());'), { match: /unwrap/ });
violates('E2: .expect( in the guest init', 'e2-no-panics', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    let _ = (setup_root(), name, std::env::var("Y").expect("set"));'), { match: /expect/ });
violates('E2: println! in the guest init', 'e2-no-panics', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    println!("hi");\n    let _ = (setup_root(), name);'), { match: /println!/ });
violates('E2: indexing in the guest is a warning', 'e2-no-panics', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    let v = vec![1u8];\n    let _ = (setup_root(), name, v[3]);'), { status: 'WARN', match: /indexing/ });
violates('E2: panic! in the guest is a warning', 'e2-no-panics', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    if name.is_empty() { panic!("empty"); }\n    let _ = (setup_root(), name);'), { status: 'WARN', match: /panic!/ });
test('E2: .unwrap_or and uses in tests/comments/strings are fine', () => {
  const { byId } = check((r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    // x.unwrap() and println!("a") in a comment\n    let s = "y.expect(1) println!";\n    let _ = (setup_root(), name, s);'));
  assert.equal(byId['e2-no-panics'].status, 'PASS', messages(byId['e2-no-panics']));
});

// ------------------------------------------------------------------------------------------------ F2
const DF = 'runtimes/native/Dockerfile';
violates('F2: FROM with a tag only', 'f2-pinned-bases', (r) => edit(r, DF, 'FROM scratch', 'FROM alpine:3.20'), { match: /not pinned/ });
violates('F2: FROM without a tag', 'f2-pinned-bases', (r) => edit(r, DF, /FROM debian@sha256:[0-9a-f]{64} AS certs/, 'FROM debian AS certs'));
violates('F2: FROM with a tag and no digest', 'f2-pinned-bases', (r) => edit(r, 'tools/mkerofs.Dockerfile', /FROM debian@sha256:[0-9a-f]{64}/, 'FROM debian:bookworm-slim'));
violates('F2: FROM with a truncated digest', 'f2-pinned-bases', (r) => edit(r, DF, /@sha256:[0-9a-f]{64} AS certs/, '@sha256:7c7b2c96 AS certs'));
violates('F2: FROM from a build argument', 'f2-pinned-bases', (r) => edit(r, DF, 'FROM scratch', 'ARG BASE=alpine\nFROM ${BASE}'), { match: /build argument/ });
violates('F2: COPY --from an unpinned image', 'f2-pinned-bases', (r) => edit(r, DF, 'COPY --from=certs', 'COPY --from=busybox:latest'), { match: /--from=busybox/ });
violates('F2: no Dockerfile in runtimes', 'f2-pinned-bases', (r) => remove(r, DF), { match: /no runtimes/ });
test('F2: a continued FROM line and a stage reference pass', () => {
  const { byId } = check((r) => write(r, 'runtimes/extra/Dockerfile', 'FROM --platform=linux/arm64 \\\n  debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS base\nFROM base\nCOPY --from=base /a /b\n'));
  assert.equal(byId['f2-pinned-bases'].status, 'PASS', messages(byId['f2-pinned-bases']));
});

// ------------------------------------------------------------------------------------------------ N1 (the guest opens no outbound socket)
violates('N1: TcpStream::connect in the guest', 'n1-no-guest-egress', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    let _ = std::net::TcpStream::connect("1.1.1.1:80");\n    let _ = (setup_root(), name);'), { match: /TcpStream::connect/ });
violates('N1: UdpSocket in the guest', 'n1-no-guest-egress', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    let _ = std::net::UdpSocket::bind("127.0.0.1:0");\n    let _ = (setup_root(), name);'), { match: /UdpSocket/ });
violates('N1: libc::connect in the guest', 'n1-no-guest-egress', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    unsafe { libc::connect(3, std::ptr::null(), 0) };\n    let _ = (setup_root(), name);'), { match: /libc::connect/ });
violates('N1: the guest proxy listening on every interface', 'n1-no-guest-egress', (r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    let _ = std::net::TcpListener::bind("0.0.0.0:3128");\n    let _ = (setup_root(), name);'), { match: /all interfaces/ });
test('N1: loopback listeners, UnixStream::connect and mentions in comments or tests are fine', () => {
  const { byId } = check((r) => edit(r, MAINRS, '    let _ = (setup_root(), name);', '    // TcpStream::connect and UdpSocket in a comment\n    let _ = std::net::TcpListener::bind("127.0.0.1:3128");\n    let _ = std::os::unix::net::UnixStream::connect("/run/x");\n    let _ = (setup_root(), name);'));
  assert.equal(byId['n1-no-guest-egress'].status, 'PASS', messages(byId['n1-no-guest-egress']));
});

// ------------------------------------------------------------------------------------------------ N3 (the host checks addresses; the test switches stay out)
const NET_RS = 'host/src/net.rs';
const GOOD_NET = [
  '//! Fixture network proxy.',
  'use std::net::{IpAddr, SocketAddr, TcpStream};',
  'use std::time::Duration;',
  'pub fn is_forbidden_ip(ip: IpAddr) -> bool {',
  '    ip.is_loopback()',
  '}',
  'pub fn check_addresses(addrs: &[SocketAddr]) -> Result<(), String> {',
  '    if addrs.iter().any(|a| is_forbidden_ip(a.ip())) {',
  '        return Err("refused".into());',
  '    }',
  '    Ok(())',
  '}',
  'pub fn dial(addrs: &[SocketAddr]) -> Option<TcpStream> {',
  '    check_addresses(addrs).ok()?;',
  '    TcpStream::connect_timeout(addrs.first()?, Duration::from_secs(10)).ok()',
  '}',
  '',
].join('\n');
test('N3: a proxy that checks addresses before it connects passes', () => {
  const { byId } = check((r) => write(r, NET_RS, GOOD_NET));
  assert.equal(byId['n3-address-check'].status, 'PASS', messages(byId['n3-address-check']));
});
violates('N3: connecting without check_addresses', 'n3-address-check', (r) => write(r, NET_RS, GOOD_NET.replace('    check_addresses(addrs).ok()?;\n', '')), { match: /never calls check_addresses|before any check_addresses/ });
violates('N3: connecting before check_addresses', 'n3-address-check', (r) => write(r, NET_RS, GOOD_NET.replace('    check_addresses(addrs).ok()?;\n    TcpStream::connect_timeout(addrs.first()?, Duration::from_secs(10)).ok()', '    let s = TcpStream::connect_timeout(addrs.first()?, Duration::from_secs(10)).ok();\n    check_addresses(addrs).ok()?;\n    s')), { match: /before any check_addresses/ });
violates('N3: the address classifier is never used', 'n3-address-check', (r) => write(r, NET_RS, GOOD_NET.replace('is_forbidden_ip(a.ip())', 'a.ip().is_loopback()')), { match: /is_forbidden_ip is never called/ });
violates('N3: the address classifier is gone', 'n3-address-check', (r) => write(r, NET_RS, GOOD_NET.replace(/pub fn is_forbidden_ip[^}]*}\n/, '').replace('is_forbidden_ip(a.ip())', 'a.ip().is_loopback()')), { match: /is_forbidden_ip is missing/ });
violates('N3: connect() without a timeout in the proxy', 'n3-address-check', (r) => write(r, NET_RS, GOOD_NET.replace('TcpStream::connect_timeout(addrs.first()?, Duration::from_secs(10))', 'TcpStream::connect(addrs.first()?)')), { match: /without a timeout/ });
violates('N3: another launcher file opens a socket', 'n3-address-check', (r) => edit(r, 'host/src/lib.rs', 'pub fn first(v: &[u8]) -> u8 {', 'pub fn zz() {\n    let _ = std::net::TcpStream::connect("1.1.1.1:80");\n}\n\npub fn first(v: &[u8]) -> u8 {'), { match: /belong in host\/src\/net\.rs/ });
violates('N3: the loader mentions the loopback test switch', 'n3-address-check', (r) => write(r, 'loader/src/zz.js', "module.exports = ['--dev-allow-loopback'];\n"), { match: /loader\/: the network test switches/ });
violates('N3: the loader passes devNet', 'n3-address-check', (r) => write(r, 'loader/src/zz.js', 'module.exports = { devNet: { allowLoopback: true } };\n'), { match: /loader\/: the network test switches/ });
violates('N3: another hostlib file builds the test switches', 'n3-address-check', (r) => write(r, 'hostlib/zz.js', "module.exports = ['--dev-resolve', 'a=1.2.3.4'];\n"), { match: /outside hostlib\/session\.js/ });
test('N3: hostlib/session.js may pass the test switches (its devNet option is the one door)', () => {
  const { byId } = check((r) => edit(r, SESS, "'use strict';", "'use strict';\nconst DEV = ['--dev-allow-loopback', '--dev-resolve'];"));
  assert.equal(byId['n3-address-check'].status, 'PASS', messages(byId['n3-address-check']));
});
