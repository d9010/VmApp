// Code - OSS (dev.vmapp.vscode, runtime node22), in a real VM: the VS Code Server 1.142.0 built from source by apps/vscode/build.sh, and
// the two bridges between it and the window. The "page" is this script: it uses the window's own code (sdk/web/vmapp-fetch.js and the
// socket factory of apps/vscode/shim/vscode-vmapp-shim.js) on the fake window manager's invoke/send/emit, and speaks VS Code's remote
// protocol to the server over that socket exactly as the workbench does (tests/apps/vscode-remote.mjs: handshake, IPC channels).
//
// VSCODE_PHASE:
//   main     (default) a fresh app: the window and its configuration; the HTTP bridge (static files, extension resources) and what it
//            refuses; the WebSocket bridge (VS Code's handshake) and what it refuses; the server's environment; the remote file system on
//            the folder shared from the Mac (read, write, mkdir, rename, delete; nothing else of the Mac is visible); file watching of
//            that folder, including an edit made ON THE MAC (the server polls /host); the built-in extensions (all but Copilot);
//            installing an extension from a VSIX; the integrated terminal (node-pty in the VM): bash, node, git, ripgrep, the remote
//            CLI, a git repository in the shared folder; the network refused (the server's own request channel, and a program in the
//            terminal), with the platform's traffic events; links (https only) and the folder dialog (cancelled here)
//   persist  a new VM, the same /data: the settings, the extension installed from the VSIX, the marker file and the git repository
//   network  the same /data, and the user allowed the app's network request ("*": any public host, any port): a program in the
//            terminal and the server's own HTTP reach the internet (github.com, example.com); a LAN address and
//            localhost stay refused; every connection is a platform event
//   declined the user declined the "workspace" folder (vmapp grant … --none): the server starts, the window gets no folder, nothing of the
//            Mac is under /host (VSCODE_WS is not needed)
// Environment (run-all.sh sets it): APPS_FIX (fixtures; VSCODE_WS is the folder granted as "workspace"), VSCODE_RESULTS (where the
//   measurements go, as JSON).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ok, requireEnv, sleep, waitFor } from './lib.mjs';
import { connectManagement, makeVsix, remoteUri } from './vscode-remote.mjs';

const require = createRequire(import.meta.url);
const { createFetch } = require('../../sdk/web/vmapp-fetch.js');
const { createSocketFactory } = require('../../apps/vscode/shim/vscode-vmapp-shim.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..', '..', 'apps', 'vscode');
const PRODUCT = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'core', 'vscode', 'product.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'vmapp.json'), 'utf8'));
const LOCATION = { href: `vmapp-ui://${MANIFEST.id}/index.html`, protocol: 'vmapp-ui:', host: MANIFEST.id };
const PHASE = process.env.VSCODE_PHASE || 'main';
const VSIX_ID = 'vmapp-tests.hello-vmapp';

export default async function ({ session, wm, store }) {
  const t0 = Date.now();
  const win = 1;
  const ws = PHASE === 'declined' ? null : requireEnv('VSCODE_WS');
  const dataDir = store.dataDir(session.appId);
  const results = { phase: PHASE, notes: [] };

  await wm.waitForWindows(1, 90000);
  results.windowMs = Date.now() - t0;
  const params = wm.windows.get(win).params;
  assert.equal(params.entry, 'index.html');
  assert.equal(params.title, 'Code - OSS');
  assert.equal(params.devTools, false);
  ok(`window created ${results.windowMs} ms after the script started (the core opens it once the server listens): index.html, "Code - OSS", no DevTools`);

  const net = [];
  session.on('traffic', (e) => {
    if (e.kind === 'net') net.push(e);
  });

  // ---- the page: the window's own fetch and socket factory, on the fake window manager ------------------------------------------
  const listeners = new Map();
  wm.events.on('emit', (w, channel, args) => {
    if (w !== win) return;
    for (const fn of listeners.get(channel) || []) fn(...args);
  });
  const vmapp = {
    invoke: (channel, ...args) => wm.invoke(win, channel, ...args),
    send: (channel, ...args) => wm.send(win, channel, ...args),
    on: (channel, fn) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
      return () => {};
    },
  };
  const page = createFetch({ vmapp, location: LOCATION, routes: [{ prefix: '/vscode-remote-resource', channel: 'fetch' }, { prefix: '/static/', channel: 'fetch' }] });
  const origin = `vmapp-ui://${MANIFEST.id}`;

  // ---- configuration (what the server would render into workbench.html) ----------------------------------------------------------
  const cfg = await wm.invoke(win, 'vscode:config');
  assert.equal(cfg.remoteAuthority, 'vm:8000');
  assert.equal(cfg.serverReady, true, `the server is not ready: ${cfg.serverError}`);
  assert.equal(cfg.folder, PHASE === 'declined' ? null : '/host/f-workspace');
  assert.equal(cfg.builtinExtensionsPath, '/app/vscode/extensions');
  assert.match(cfg.connectionToken, /^[0-9a-f]{48}$/);
  assert.ok(cfg.serverExtensions.includes('vscode.typescript-language-features'), 'the web-capable built-ins are pinned to the server');
  ok(PHASE === 'declined'
    ? 'vscode:config: the server is ready; the folder was declined, so the window opens with no folder (folder: null)'
    : 'vscode:config: authority vm:8000, the server is ready, the shared folder /host/f-workspace is the default folder');
  const diag0 = await wm.invoke(win, 'vscode:diag');
  assert.equal(diag0.serverPort, 8000);
  assert.match(diag0.serverLog, /Extension host agent listening on 8000/);
  results.vm = diag0.vm;
  ok(`the server listens on 127.0.0.1:8000 in a VM of ${diag0.vm.cpus} vCPUs and ${diag0.vm.memMiB} MiB (${diag0.vm.freeMiB} MiB free with the server idle)`);

  // ---- the HTTP bridge ------------------------------------------------------------------------------------------------------------
  const tkn = encodeURIComponent(cfg.connectionToken);
  const res = async (p) => page.fetch(`${origin}/vscode-remote-resource?path=${encodeURIComponent(p)}&tkn=${tkn}`);
  let r = await res('/app/vscode/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).scopeName, 'source.ts');
  r = await page.fetch(`${origin}/static/extensions/theme-defaults/package.json`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).name, 'theme-defaults');
  r = await page.fetch(`${origin}/static/node_modules/vscode-oniguruma/release/onig.wasm`);
  assert.equal(r.status, 200);
  ok('HTTP bridge: an extension resource (TypeScript grammar), a built-in extension file and a static file of the server');
  if (PHASE !== 'declined') {
    r = await res('/host/f-workspace/README.md');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /A file from the Mac/);
    ok('HTTP bridge: a file of the shared folder through /vscode-remote-resource (what the workbench uses for images in Markdown)');
  }
  // what the bridge refuses
  const open = (o) => wm.invoke(win, 'fetch:open', { id: `t-${crypto.randomUUID()}`, headers: {}, length: 0, ...o });
  await assert.rejects(() => open({ method: 'GET', path: '/version' }), /not allowed|outside|refused|prefix/i);
  await assert.rejects(() => open({ method: 'POST', path: '/static/out/nls.messages.js' }), /method|not allowed|refused/i);
  await assert.rejects(() => open({ method: 'GET', path: '//example.com/static/x' }), /./);
  ok('HTTP bridge refuses: a path outside /static/ and /vscode-remote-resource, a POST, another host');

  // ---- the WebSocket bridge and VS Code's handshake -------------------------------------------------------------------------------
  const factory = createSocketFactory(vmapp);
  await assert.rejects(() => wm.invoke(win, 'ws:open', { id: 9001, path: '/admin', query: '' }), /only the server's remote connection/);
  await assert.rejects(() => wm.invoke(win, 'ws:open', { id: 9002, path: '/../x', query: '' }), /only the server's remote connection/);
  ok('WebSocket bridge refuses any path but the server\'s remote connection');
  const tHs = Date.now();
  const m = await connectManagement({ factory, authority: cfg.remoteAuthority, token: cfg.connectionToken, commit: PRODUCT.commit });
  results.handshakeMs = Date.now() - tHs;
  ok(`VS Code's handshake over the bridge (auth, sign, connectionType management, ok) in ${results.handshakeMs} ms`);
  await assert.rejects(() => connectManagement({ factory, authority: cfg.remoteAuthority, token: 'wrong', commit: PRODUCT.commit }), /refused|closed|auth/i);
  await assert.rejects(() => connectManagement({ factory, authority: cfg.remoteAuthority, token: cfg.connectionToken, commit: '0'.repeat(40) }), /version mismatch|refused|closed/i);
  ok('the server refuses a wrong connection token and another commit (its own checks, through the bridge)');

  const env = await m.call('remoteextensionsenvironment', 'getEnvironmentData', { remoteAuthority: cfg.remoteAuthority });
  assert.equal(env.appRoot.path, '/app/vscode');
  assert.equal(env.userHome.path, '/data');
  assert.ok(env.settingsPath.path.startsWith('/data/vscode-server/'), env.settingsPath.path);
  assert.equal(env.arch, 'arm64');
  ok(`the server's environment: app root /app/vscode, home /data, settings ${env.settingsPath.path}, ${env.arch}`);

  const U = (p) => remoteUri(cfg.remoteAuthority, p);
  const fsCall = (name, ...args) => m.call('remoteFilesystem', name, args);
  const text = async (p) => (await fsCall('readFile', U(p), {})).toString('utf8');
  const write = (p, s) => fsCall('writeFile', U(p), Buffer.from(s), { create: true, overwrite: true, unlock: false, atomic: false });

  if (PHASE === 'declined') {
    const hostDirs = (await fsCall('readdir', U('/host'))).map(([n]) => n).sort();
    assert.deepEqual(hostDirs.filter((n) => n.startsWith('f-') || n.startsWith('pick-') || n.startsWith('save-')), []);
    await write('/data/declined-run.txt', 'the server works without a shared folder\n');
    assert.equal(await text('/data/declined-run.txt'), 'the server works without a shared folder\n');
    ok(`declined folder: nothing of the Mac is under /host (${hostDirs.join(', ')}); the server, the bridges and /data work as usual`);
    m.close();
    wm.userClose(win);
    return;
  }

  if (PHASE === 'main') {
    // ---- the remote file system on the shared folder ----------------------------------------------------------------------------
    assert.match(await text('/host/f-workspace/README.md'), /A file from the Mac/);
    const st = await fsCall('stat', U('/host/f-workspace/src/main.ts'));
    assert.equal(st.type, 1);
    await fsCall('mkdir', U('/host/f-workspace/notes'));
    await write('/host/f-workspace/notes/from-vm.md', '# written in the VM\n');
    assert.equal(fs.readFileSync(path.join(ws, 'notes', 'from-vm.md'), 'utf8'), '# written in the VM\n');
    await fsCall('rename', U('/host/f-workspace/notes/from-vm.md'), U('/host/f-workspace/notes/renamed.md'), { overwrite: false });
    assert.ok(fs.existsSync(path.join(ws, 'notes', 'renamed.md')) && !fs.existsSync(path.join(ws, 'notes', 'from-vm.md')));
    const listing = (await fsCall('readdir', U('/host/f-workspace'))).map(([n]) => n).sort();
    assert.deepEqual(listing.filter((n) => ['README.md', 'notes', 'src'].includes(n)), ['README.md', 'notes', 'src']);
    await fsCall('delete', U('/host/f-workspace/notes'), { recursive: true, useTrash: false, atomic: false });
    assert.ok(!fs.existsSync(path.join(ws, 'notes')));
    ok('remote file system on the folder shared from the Mac: read, stat, mkdir, write (the file appears on the Mac), rename, readdir, delete');
    const hostDirs = (await fsCall('readdir', U('/host'))).map(([n]) => n).sort();
    assert.deepEqual(hostDirs.filter((n) => n.startsWith('f-') || n.startsWith('pick-') || n.startsWith('save-')), ['f-workspace']);
    await assert.rejects(() => fsCall('stat', U('/Users')), /ENOENT|not found|nonexistent|EntryNotFound/i);
    ok(`nothing else of the Mac is visible: /host has ${hostDirs.join(', ')}; /Users does not exist in the VM`);

    // ---- file watching: an edit made in the VM, and one made ON THE MAC (virtiofs sends no notifications: the server polls /host)
    const session1 = crypto.randomUUID();
    const changes = [];
    const unlisten = await m.listen('remoteFilesystem', 'fileChange', [session1], (ev) => {
      if (Array.isArray(ev)) changes.push(...ev);
    });
    await fsCall('watch', session1, 1, U('/host/f-workspace'), { recursive: true, excludes: [] });
    await sleep(4000); // the polling watcher takes its first snapshot
    fs.writeFileSync(path.join(ws, 'edited-on-the-mac.txt'), 'hello\n');
    const tWatch = Date.now();
    await waitFor(() => changes.some((c) => c.resource && c.resource.path === '/host/f-workspace/edited-on-the-mac.txt'), { timeoutMs: 20000, what: 'a change event for a file created on the Mac' });
    results.macEditSeenMs = Date.now() - tWatch;
    ok(`a file created on the Mac in the shared folder is reported by the server's watcher after ${results.macEditSeenMs} ms (polling, 3 s)`);
    await fsCall('unwatch', session1, 1);
    unlisten();
    fs.unlinkSync(path.join(ws, 'edited-on-the-mac.txt'));
  }

  // ---- extensions --------------------------------------------------------------------------------------------------------------
  const installed = await m.call('extensions', 'getInstalled', [undefined]);
  const ids = new Set(installed.map((e) => e.identifier.id.toLowerCase()));
  // every built-in of upstream's reh-web but Copilot (it comes with network and sign-in: apps/vscode/pins.env), including those that
  // render in webviews (Mermaid, Markdown Math, media preview, notebook renderers, Simple Browser) and sign-in, GitHub, port forwarding
  for (const id of ['vscode.typescript-language-features', 'vscode.git', 'vscode.json-language-features', 'vscode.markdown-language-features', 'vscode.emmet', 'vscode.theme-defaults', 'ms-vscode.js-debug',
    'vscode.github-authentication', 'vscode.microsoft-authentication', 'vscode.github', 'vscode.mermaid-markdown-features', 'vscode.markdown-math', 'vscode.media-preview', 'vscode.builtin-notebook-renderers',
    'vscode.simple-browser', 'vscode.tunnel-forwarding', 'ms-vscode.js-debug-companion', 'ms-vscode.vscode-js-profile-table']) {
    assert.ok(ids.has(id), `${id} is installed`);
  }
  for (const id of ['github.copilot-chat', 'vscode.copilot']) {
    assert.ok(!ids.has(id), `${id} is not shipped yet`);
  }
  const builtin = installed.filter((e) => e.type === 0).length;
  ok(`${builtin} built-in extensions: every one of upstream's reh-web but Copilot (TypeScript, git, Markdown with Mermaid and Math, media preview, notebook renderers, Simple Browser, sign-in, js-debug, themes, ...)`);

  if (PHASE === 'main') {
    const vsix = makeVsix(zlib, {
      name: 'hello-vmapp', publisher: 'vmapp-tests', displayName: 'Hello D9010 VmApp', version: '1.0.0', engines: { vscode: '^1.100.0' }, main: './extension.js',
      activationEvents: ['onCommand:hello-vmapp.hello'], contributes: { commands: [{ command: 'hello-vmapp.hello', title: 'Hello from the VM' }] },
    }, 'exports.activate = (ctx) => { ctx.subscriptions.push(require("vscode").commands.registerCommand("hello-vmapp.hello", () => "hello from the VM")); };\n');
    await write('/data/hello-vmapp-1.0.0.vsix', vsix);
    await m.call('extensions', 'install', [U('/data/hello-vmapp-1.0.0.vsix'), { installGivenVersion: true }], 120000);
    const after = await m.call('extensions', 'getInstalled', [1]);
    const mine = after.find((e) => e.identifier.id === VSIX_ID);
    assert.ok(mine, 'the extension from the VSIX is installed');
    assert.ok(mine.location.path.startsWith('/data/vscode-server/extensions/'), mine.location.path);
    ok(`an extension installed from a VSIX in the VM (Install from VSIX…): ${VSIX_ID} in ${mine.location.path}`);
  } else {
    const user = await m.call('extensions', 'getInstalled', [1]);
    assert.ok(user.some((e) => e.identifier.id === VSIX_ID), 'the extension installed in the first run is still there');
    ok(`persist: ${VSIX_ID}, installed in the first run, is still installed`);
  }

  // ---- settings and a marker in /data -------------------------------------------------------------------------------------------
  const marker = '/data/vmapp-test-marker.txt';
  if (PHASE === 'main') {
    await write(env.settingsPath.path, JSON.stringify({ 'editor.fontSize': 15, 'files.autoSave': 'afterDelay' }, null, 2));
    await write(marker, 'first run\n');
    ok('machine settings and a marker written to /data');
  } else {
    assert.deepEqual(JSON.parse(await text(env.settingsPath.path)), { 'editor.fontSize': 15, 'files.autoSave': 'afterDelay' });
    assert.equal(await text(marker), 'first run\n');
    assert.ok(fs.existsSync(path.join(dataDir, 'vmapp-test-marker.txt')), 'the marker is in the app data folder on the Mac');
    ok('persist: the machine settings and the marker written in the first run are there');
  }

  // ---- the integrated terminal: node-pty in the VM ---------------------------------------------------------------------------------
  const term = async (script, { cwd = '/host/f-workspace', timeoutMs = 60000 } = {}) => {
    let out = '';
    let exit = null;
    let id = null;
    const early = [];
    const offData = await m.listen('remoteterminal', '$onProcessDataEvent', undefined, (e) => {
      if (id === null) early.push(e);
      else if (e.id === id) out += typeof e.event === 'string' ? e.event : e.event.data;
    });
    const offExit = await m.listen('remoteterminal', '$onProcessExitEvent', undefined, (e) => {
      if (e.id === id) exit = e.event;
    });
    const created = await m.call('remoteterminal', '$createProcess', {
      configuration: { 'terminal.integrated.env.linux': {}, 'terminal.integrated.cwd': '', 'terminal.integrated.detectLocale': 'off' },
      resolvedVariables: {},
      envVariableCollections: [],
      shellLaunchConfig: { name: 'test', executable: '/bin/bash', args: ['-c', script], cwd },
      workspaceId: 'test',
      workspaceName: 'test',
      workspaceFolders: [],
      activeWorkspaceFolder: null,
      activeFileResource: undefined,
      shouldPersistTerminal: false,
      options: { shellIntegration: { enabled: false, suggestEnabled: false, nonce: 'x' }, windowsEnableConpty: false, windowsUseConptyDll: false, environmentVariableCollections: undefined, workspaceFolder: undefined, isScreenReaderOptimized: false },
      cols: 200,
      rows: 50,
      unicodeVersion: '11',
      resolverEnv: {},
    });
    id = created.persistentTerminalId;
    for (const e of early) if (e.id === id) out += typeof e.event === 'string' ? e.event : e.event.data;
    const err = await m.call('remoteterminal', '$start', [id]);
    assert.ok(!err || !err.message, `the terminal process started: ${JSON.stringify(err)}`);
    await waitFor(() => exit !== null, { timeoutMs, what: 'the terminal process to exit' });
    offData();
    offExit();
    return { out: out.replace(/\r/g, ''), exit };
  };

  if (PHASE === 'main') {
    const t = await term([
      'echo "cwd=$(pwd) user=$(id -u) shell=$0"',
      'node --version',
      'git --version',
      // the ripgrep that VS Code's search runs (the server resolves it the same way), searching the shared folder
      'RG=$(node --input-type=module -e "import(\'/app/vscode/node_modules/@vscode/ripgrep-universal/lib/index.js\').then(m => console.log(m.rgPath))")',
      '"$RG" --version | head -n 1',
      '"$RG" -n --no-heading "function greet" src | sed "s/^/RG-HIT /"',
      '$(command -v code-oss || echo /app/vscode/bin/remote-cli/code-oss) --version | head -n 1',
      'node -e "fetch(\'https://example.com/\').then(r => console.log(\'FETCH-STATUS\', r.status), e => console.log(\'FETCH-REFUSED\', e.message))"',
      'test -w /app && echo APP-WRITABLE || echo APP-READONLY',
      'git init -q demo && cd demo && echo hi > hello.txt && git add hello.txt && git -c user.name=Test -c user.email=test@example.com commit -qm first && git log --oneline | wc -l | sed "s/^/COMMITS=/"',
    ].join('; '));
    assert.equal(t.exit, 0, t.out);
    assert.match(t.out, /cwd=\/host\/f-workspace user=1000 shell=\/bin\/bash/);
    assert.match(t.out, /^v24\.21\.0$/m);
    assert.match(t.out, /^git version 2\.39\.5$/m);
    assert.match(t.out, /^ripgrep \d+\.\d+/m);
    assert.match(t.out, /^RG-HIT src\/main\.ts:1:export function greet/m);
    assert.match(t.out, /^1\.142\.0$/m);
    assert.match(t.out, /FETCH-REFUSED|FETCH-STATUS 403/);
    assert.match(t.out, /APP-READONLY/);
    assert.match(t.out, /COMMITS=1/);
    assert.ok(fs.existsSync(path.join(ws, 'demo', '.git', 'HEAD')), 'the git repository is in the shared folder on the Mac');
    ok('terminal (node-pty, bash, uid 1000, in the shared folder): node v24.21.0, git 2.39.5, code-oss 1.142.0, /app read-only, a git repository committed in the shared folder');
    ok('search: the ripgrep VS Code\'s search runs finds "function greet" in src/main.ts of the shared folder');
    ok('a program in the terminal cannot reach the internet: fetch of https://example.com is refused');
    results.terminal = t.out.split('\n').filter(Boolean).slice(0, 12);
  } else {
    const t = await term('git -C demo log --oneline | wc -l | sed "s/^/COMMITS=/"; cat demo/hello.txt');
    assert.match(t.out, /COMMITS=1/);
    assert.match(t.out, /^hi$/m);
    ok('persist: the git repository made in the first run is in the shared folder, with its commit');
  }

  if (PHASE === 'network') {
    // the user allowed "*" (any public host, any port; `vmapp grant-net dev.vmapp.vscode '*'`): the internet works from the
    // terminal and the server, through the host's proxy; the LAN and this Mac stay out (the address check)
    const t = await term([
      'node -e "fetch(\'https://github.com/\').then(r => console.log(\'FETCH-STATUS \' + r.status), e => console.log(\'FETCH-REFUSED \' + e.message))"',
      // git over HTTPS (core/git's transport, with its libraries in core/git/lib) through the platform's proxy
      'git ls-remote https://github.com/microsoft/vscode.git refs/tags/1.142.0 2>&1 | sed "s/^/LS-REMOTE /"',
      'node -e "fetch(\'http://192.168.1.1/\').then(r => console.log(\'LAN-STATUS \' + r.status), e => console.log(\'LAN-REFUSED \' + e.message))"',
      'node -e "fetch(\'http://localhost.\' + \'/\').then(r => console.log(\'LOCAL-STATUS \' + r.status), e => console.log(\'LOCAL-REFUSED \' + e.message))"',
    ].join('; '));
    assert.match(t.out, /FETCH-STATUS 200/, t.out);
    assert.match(t.out, /^LS-REMOTE [0-9a-f]{40}\s+refs\/tags\/1\.142\.0$/m, t.out);
    assert.match(t.out, /LAN-STATUS 403|LAN-REFUSED/, t.out);
    assert.match(t.out, /LOCAL-STATUS 403|LOCAL-REFUSED/, t.out);
    ok('with "*" allowed: a program in the terminal fetches https://github.com (200) and git reaches github.com over HTTPS (ls-remote of the 1.142.0 tag); a LAN address and localhost stay refused');
    const req = await m.call('request', 'request', [{ type: 'GET', url: 'https://example.com/' }]).catch((e) => ({ error: e.message }));
    const status = Array.isArray(req) ? req[0].statusCode : null;
    assert.equal(status, 200, `the server's request channel reaches the internet: ${JSON.stringify(req).slice(0, 200)}`);
    ok('with "*" allowed: the server\'s own HTTP (the request channel the workbench uses for downloads) gets 200 from https://example.com');
    await waitFor(() => net.some((e) => e.host === 'github.com' && e.allowed), { timeoutMs: 10000, what: 'an allowed net event for github.com' });
    const hosts = [...new Set(net.filter((e) => e.allowed).map((e) => `${e.host}:${e.port}`))];
    results.netAllowed = hosts;
    ok(`every connection is a platform event (the Inspector's rows): ${hosts.join(', ')} allowed${net.some((e) => !e.allowed) ? `; ${[...new Set(net.filter((e) => !e.allowed).map((e) => e.host))].join(', ')} refused` : ''}`);
  } else {
    await networkRefused();
  }

  // ---- the network without a grant: refused for the server too ------------------------------------------------------------------
  async function networkRefused() {
  const req = await m.call('request', 'request', [{ type: 'GET', url: 'https://example.com/' }]).catch((e) => ({ error: e.message }));
  const status = Array.isArray(req) ? req[0].statusCode : null;
  assert.ok(status === 403 || req.error, `the server's request channel is refused: ${JSON.stringify(req).slice(0, 200)}`);
  const body = Array.isArray(req) && req[1] ? (Buffer.isBuffer(req[1]) ? req[1] : Buffer.from(req[1].data || req[1].buffer || [])).toString().trim() : '';
  ok(`the server's own HTTP (the request channel the workbench uses for downloads): refused (${status ? `${status} ${body}` : req.error})`);
  await waitFor(() => net.some((e) => e.host === 'example.com' && e.allowed === false), { timeoutMs: 10000, what: 'a refused net event for example.com' }).catch(() => null);
  const denied = net.filter((e) => e.allowed === false);
  const allowed = net.filter((e) => e.allowed);
  assert.equal(allowed.length, 0, `no connection was allowed: ${JSON.stringify(allowed)}`);
  results.netDenied = denied.map((e) => `${e.host}:${e.port}`);
  ok(`the platform saw ${net.length} connection attempt(s), none allowed${denied.length ? `: ${[...new Set(results.netDenied)].join(', ')} refused` : ' (refused in the VM: no network grant at all)'}`);
  }

  // ---- links and the folder dialog ----------------------------------------------------------------------------------------------
  await assert.rejects(() => wm.invoke(win, 'vscode:open-external', { url: 'http://example.com/' }), /Only https links/);
  await assert.rejects(() => wm.invoke(win, 'vscode:open-external', { url: 'file:///etc/passwd' }), /Only https links/);
  ok('links: only https links reach the platform (which asks the user)');
  const pick = await wm.invoke(win, 'vscode:pick-folder', { title: 'Open Folder' });
  assert.equal(pick.path, null);
  ok('Open Folder from Your Mac…: the native dialog is the platform\'s (cancelled here: no folder is shared)');

  m.close();
  const diag = await wm.invoke(win, 'vscode:diag');
  results.vmAfter = diag.vm;
  ok(`after the session: ${diag.vm.freeMiB} MiB free of ${diag.vm.memMiB} MiB in the VM`);
  results.totalMs = Date.now() - t0;
  if (process.env.VSCODE_RESULTS) {
    fs.mkdirSync(process.env.VSCODE_RESULTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.VSCODE_RESULTS, `vscode-${PHASE}.json`), JSON.stringify(results, null, 2));
  }
  wm.userClose(win);
}
