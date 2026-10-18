'use strict';
/**
 * Code - OSS (VS Code 1.142.0), core (runtime node22): the VS Code Server in the VM, its web workbench in the window.
 *
 *   window (ui/: VS Code's web workbench, built from the pinned source)                          VM
 *     WebSocket ws://vm:8000/?reconnectionToken=…  ──vscode-vmapp-shim.js──► bridge ──► ws-bridge.js ──► 127.0.0.1:8000 upgrade
 *       (VS Code's remote protocol: files, extension host, terminals, search)                               │
 *     fetch('/vscode-remote-resource?path=…'), fetch('/static/…')                                         VS Code Server
 *                                                    ──vmapp-fetch.js──► bridge ──► http-bridge.js ──►   (out/server-main.js, Node 24.21.0)
 *                                                                                                          ├ extension host (extensions/)
 *                                                                                                          ├ pty host (node-pty, bash)
 *                                                                                                          └ file watcher, ripgrep
 *
 * This file does what the server's HTTP front end and the browser did for the workbench, and nothing the server does itself: it starts
 * the server (core/vscode, unchanged) with the options VS Code's own `code-server` script passes, carries the window's WebSocket and its
 * few HTTP requests to it, gives the page its configuration (what the server would have rendered into workbench.html), and answers what
 * the page asks of its host:
 *
 *   vscode:config                     -> {remoteAuthority, connectionToken, folder, ...}   the page's configuration (ui/vscode-vmapp-shim.js)
 *   vscode:open-external {url}        -> {opened}       a link: https, or a forwarded localhost port; the platform asks the user
 *   vscode:forward-port {port, host}  -> {port, hostPort, url}  the Ports view: a server in the VM on this Mac's localhost (SPEC 8.8)
 *   vscode:close-port {port}          -> {closed}
 *   vscode:pick-folder {title}        -> {path|null}    "Open Folder from Your Mac…": a native dialog; the folder is shared read-write
 *   vscode:set-gallery {gallery}      -> {gallery,label} the extension marketplace: "open-vsx" (default) or "microsoft"; kept in /data
 *   vscode:diag                       -> {...}          what runs and the server's log (read-only; for tests and bug reports)
 *   vscode:new-window {query}         -> {win}          New Window / a folder in a new window: a second app window (step 18 block)
 *   vscode:download {paths}           -> {canceled}|{name, bytes, entries, skipped}  the Explorer's Download…: the platform's save
 *                                                       dialog, one file as it is, folders as one .tar (core/download.js)
 *
 * Environment of the server (and so of its extension host, terminals and tasks):
 *   HOME=/data                 the app's private storage: ~/.bashrc, ~/.gitconfig, ~/.npm of the terminal live there
 *   --server-data-dir /data/vscode-server   settings, global storage, secrets kept by the server, installed extensions, logs
 *   PATH=/app/bin:…            `node` (the server's Node 24) and `git` (core/git), then the runtime's; the server adds its own
 *                              `code-oss` (bin/remote-cli: open a file in the window) and $BROWSER (open a link through the window)
 *   SHELL=/bin/bash            the runtime's bash, for the integrated terminal
 *   SSL_CERT_FILE              a CA bundle written from Node's root store (the runtime has no /etc/ssl/certs; git needs one)
 *   HTTPS_PROXY & co           inherited: the platform's allowlist proxy is the only way out (the manifest asks for "*", any public
 *                              host on any port; nothing passes until the user allows it, and never the LAN or the Mac)
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { app, BrowserWindow, ipcMain, dialog, shell, folders, ports } = require('vmapp');
const httpBridge = require('./http-bridge');
const wsBridge = require('./ws-bridge');

const APP = __dirname;
const VSCODE = path.join(APP, 'vscode');
const NODE = path.join(VSCODE, 'node');
const BIN = path.join(APP, 'bin');
const DATA = process.env.VMAPP_DATA || '/data';
const SERVER_DATA = path.join(DATA, 'vscode-server');
const PORT = 8000;
// The authority the workbench calls its server. It names the connection, it is never resolved: the page's socket factory and resource
// provider (ui/vscode-vmapp-shim.js) send everything over the bridge. It shows in the remote indicator and in window titles.
const REMOTE_AUTHORITY = `vm:${PORT}`;
const TOKEN = crypto.randomBytes(24).toString('hex'); // the server's connection token (--connection-token-file)
const TOKEN_FILE = '/tmp/vscode-connection-token';
const CA_FILE = '/tmp/vmapp-ca-bundle.pem';
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];
// Folders the user shares from the Mac are on virtiofs, which sends no change notifications for edits made on the Mac: the server's
// recursive watcher (the one that watches the folders open in the window, all of them under /host) polls instead (its own option,
// --file-watcher-polling <interval>; with a list of paths it only polls exactly those paths, and the pick-N folders are not known in
// advance), so that the explorer and open editors see those edits. The cost is a scan of the folder every 3 s.
const POLL = '3000';

let win = null;
let child = null;
let serverPort = 0; // set when the server says it listens
let quitting = false;
let restarts = 0;
let lastStart = 0;
let lastError = '';
const logTail = [];
const coreStartedAt = Date.now();
let serverReadyAt = 0;

const log = (msg) => console.log(`[vscode] ${msg}`);

function remember(line) {
  logTail.push(line);
  if (logTail.length > 400) logTail.splice(0, logTail.length - 400);
}

function writeCaBundle() {
  const roots = tls.rootCertificates;
  if (!Array.isArray(roots) || roots.length < 20) throw new Error('Node has no root certificates');
  const tmp = `${CA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${roots.join('\n')}\n`, { mode: 0o644 });
  fs.renameSync(tmp, CA_FILE);
}

function serverEnv() {
  const env = {
    PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`,
    HOME: DATA,
    SHELL: '/bin/bash',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    SSL_CERT_FILE: CA_FILE,
    GIT_SSL_CAINFO: CA_FILE,
    // git, shipped in core/git (build.sh): where it finds its helper programs and templates in a read-only /app
    GIT_EXEC_PATH: path.join(APP, 'git', 'libexec', 'git-core'),
    GIT_TEMPLATE_DIR: path.join(APP, 'git', 'share', 'git-core', 'templates'),
    // the open extension signature verifier (patch 0008, core/sigverify.js): Open VSX signatures verified, Microsoft's in part
    VSCODE_SIGNATURE_VERIFIER: path.join(APP, 'sigverify.js'),
  };
  for (const k of PROXY_VARS) if (process.env[k]) env[k] = process.env[k];
  return env;
}

// ------------------------------------------------------------------------------------------------ the server

function serverArgs() {
  return [
    path.join(VSCODE, 'out', 'server-main.js'),
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--connection-token-file', TOKEN_FILE,
    '--server-data-dir', SERVER_DATA,
    '--telemetry-level', 'off',
    '--file-watcher-polling', POLL,
    // The extension host's environment is the server's (PATH with /app/bin: git, node). Without this the server asks a login shell for
    // the "user's environment", and Debian's /etc/profile resets PATH, so the Git extension would not find git.
    '--force-disable-user-env',
  ];
}

function startServer() {
  if (!fs.existsSync(NODE) || !fs.existsSync(path.join(VSCODE, 'out', 'server-main.js'))) {
    throw new Error('the VS Code server is not bundled in this build of the app (run apps/vscode/build.sh and pack again)');
  }
  writeCaBundle();
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  fs.mkdirSync(SERVER_DATA, { recursive: true, mode: 0o700 });
  lastStart = Date.now();
  const p = spawn(NODE, serverArgs(), { env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'], cwd: DATA });
  child = p;
  log(`started the VS Code server (pid ${p.pid}), Node ${NODE}`);
  const lines = (stream, fn) => {
    let carry = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      carry += d;
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        fn(carry.slice(0, i).replace(/\r$/, ''));
        carry = carry.slice(i + 1);
      }
      if (carry.length > 16384) carry = '';
    });
  };
  const onLine = (line) => {
    if (!line) return;
    remember(line);
    const m = /^Extension host agent listening on (\d+)$/.exec(line);
    if (m) {
      serverPort = Number(m[1]);
      if (!serverReadyAt) serverReadyAt = Date.now();
      log(`the server listens on 127.0.0.1:${serverPort} (${serverReadyAt - coreStartedAt} ms after the core started)`);
    } else {
      log(`[server] ${line.slice(0, 400)}`);
    }
  };
  lines(p.stdout, onLine);
  lines(p.stderr, onLine);
  p.on('error', (e) => {
    lastError = e.message;
    log(`could not start the server: ${e.message}`);
  });
  p.on('exit', (code, signal) => {
    if (child === p) child = null;
    serverPort = 0;
    if (quitting) return;
    lastError = `the server exited (${signal || `code ${code}`})`;
    log(lastError);
    // a server that dies right after it started is not restarted in a loop
    restarts = Date.now() - lastStart > 30000 ? 0 : restarts + 1;
    if (restarts > 4) {
      log('the server keeps failing: not restarting it again');
      return;
    }
    setTimeout(() => {
      if (!quitting) {
        try {
          startServer();
        } catch (e) {
          log(e.message);
        }
      }
    }, Math.min(1000 * 2 ** restarts, 10000));
  });
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (serverPort) return resolve(serverPort);
      if (!child) return reject(new Error(lastError || 'the VS Code server did not start'));
      if (Date.now() > deadline) return reject(new Error('the VS Code server did not start in time'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ------------------------------------------------------------------------------------------------ the window's connections

// VS Code's remote protocol: the one WebSocket of the workbench
const sockets = wsBridge.attach(ipcMain, {
  port: () => serverPort,
  headers: () => ({ cookie: `vscode-tkn=${TOKEN}` }),
});

// HTTP: the resources of extensions (grammars, themes, snippets, icons: /vscode-remote-resource?path=…) and the server's static files
// (/static/…) that the workbench fetches. Only GET and HEAD: the workbench reads, it never posts to its server.
const bridge = httpBridge.attach(ipcMain, {
  port: () => serverPort,
  prefixes: ['/vscode-remote-resource', '/static/'],
  methods: ['GET', 'HEAD'],
  headers: () => ({ cookie: `vscode-tkn=${TOKEN}` }),
  window: 512 * 1024,
});

// ------------------------------------------------------------------------------------------------ what the page asks of its host

function workspaceFolder() {
  const f = folders && folders.workspace;
  return f && fs.existsSync(f) ? f : null;
}

// The built-in extensions that can also run in a browser ("browser" in their package.json: TypeScript, JSON, CSS, HTML, Markdown, ...)
// exist twice for the workbench: as built-in web extensions of the page (baked into the bundle) and on the server. VS Code may then put
// them in the web worker extension host (it does when they become enabled after the folder is trusted), which a vmapp window cannot run.
// The page pins them to the server's extension host with remote.extensionKind (a configuration default; the user's own value wins).
let webCapable = null;
function webCapableBuiltins() {
  if (webCapable) return webCapable;
  webCapable = [];
  const dir = path.join(VSCODE, 'extensions');
  for (const name of fs.readdirSync(dir)) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, name, 'package.json'), 'utf8'));
      if (p.browser && p.main && p.publisher && p.name) webCapable.push(`${p.publisher}.${p.name}`);
    } catch {
      /* not an extension folder (node_modules) */
    }
  }
  return webCapable;
}

// The extension marketplace (product.json "extensionsGallery"; Code - OSS ships none). The page passes the chosen one to the workbench as
// its productConfiguration, and the workbench hands it to the server (the extensionGalleryManifest channel), so one choice configures
// both: the window searches and shows, the server downloads and installs in the VM. Both go through the app's network grant.
// Open VSX (the Eclipse Foundation's registry) is the default; the Visual Studio Marketplace is one command away. Microsoft's terms of
// use limit its extensions to Microsoft's own Visual Studio products: the choice is the user's, and the command says so.
const GALLERIES = {
  'open-vsx': {
    label: 'Open VSX Registry',
    extensionsGallery: {
      serviceUrl: 'https://open-vsx.org/vscode/gallery',
      itemUrl: 'https://open-vsx.org/vscode/item',
      resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
      extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
      controlUrl: '',
      nlsBaseUrl: '',
    },
  },
  microsoft: {
    label: 'Visual Studio Marketplace',
    extensionsGallery: {
      serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery',
      itemUrl: 'https://marketplace.visualstudio.com/items',
      publisherUrl: 'https://marketplace.visualstudio.com/publishers',
      resourceUrlTemplate: 'https://{publisher}.vscode-unpkg.net/{publisher}/{name}/{version}/{path}',
      extensionUrlTemplate: 'https://www.vscode-unpkg.net/_gallery/{publisher}/{name}/latest',
      controlUrl: 'https://main.vscode-cdn.net/extensions/marketplace.json',
      nlsBaseUrl: 'https://www.vscode-unpkg.net/_lp/',
    },
  },
};
const GALLERY_FILE = path.join(DATA, 'vmapp-gallery.json');
function galleryId() {
  try {
    const id = JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8')).gallery;
    if (Object.prototype.hasOwnProperty.call(GALLERIES, id)) return id;
  } catch {
    /* no choice yet */
  }
  return 'open-vsx';
}

ipcMain.handle('vscode:set-gallery', (event, req) => {
  const id = req && req.gallery;
  if (!Object.prototype.hasOwnProperty.call(GALLERIES, id)) throw new Error(`unknown marketplace "${id}"`);
  fs.writeFileSync(GALLERY_FILE, JSON.stringify({ gallery: id }) + '\n', { mode: 0o600 });
  return { gallery: id, label: GALLERIES[id].label };
});

ipcMain.handle('vscode:config', (event) => {
  const folder = workspaceFolder();
  const gallery = galleryId();
  return {
    remoteAuthority: REMOTE_AUTHORITY,
    connectionToken: TOKEN,
    serverReady: !!serverPort,
    serverError: serverPort ? null : lastError || null,
    // the folder opened when the window has no ?folder= of its own: the one shared at the first launch (manifest folder "workspace")
    folder,
    builtinExtensionsPath: path.join(VSCODE, 'extensions'),
    serverExtensions: webCapableBuiltins(),
    gallery: { id: gallery, label: GALLERIES[gallery].label, extensionsGallery: GALLERIES[gallery].extensionsGallery },
    // [step 18] a window opened by New Window: the query its page starts with (?folder=… | ?workspace=… | ?ew=true), once
    location: takeWindowLocation(event),
  };
});

ipcMain.handle('vscode:open-external', async (event, req) => {
  let u;
  try {
    u = new URL(String(req && req.url));
  } catch {
    throw new Error('That is not a link I can open.');
  }
  // https, or a forwarded port on this Mac's localhost (the platform checks that it is one of ours)
  const local = (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) throw new Error('Only https links (and forwarded localhost ports) can be opened.');
  return { opened: await shell.openExternal(u.href) };
});

// The Ports view (SPEC 8.8; the page's tunnelProvider in ui/vscode-vmapp-shim.js): a server in the VM opened on this Mac's localhost.
// The device "ports" must be allowed; the platform refuses otherwise and VS Code shows the message.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::', '::1'];
ipcMain.handle('vscode:forward-port', async (event, req) => {
  const port = Number(req && req.port);
  const host = String((req && req.host) || 'localhost');
  if (!LOCAL_HOSTS.includes(host)) throw new Error(`Only ports of the VM itself can be forwarded (not ${host}).`);
  return ports.forward(port);
});
ipcMain.handle('vscode:close-port', async (event, req) => ports.close(Number(req && req.port)));

ipcMain.handle('vscode:pick-folder', async (event, req) => {
  const title = req && typeof req.title === 'string' ? req.title.slice(0, 100) : 'Open Folder';
  const r = await dialog.showOpenDialog(win || undefined, { title, properties: ['openDirectory'], access: 'readwrite' });
  return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] };
});

function memAvailableMiB() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

ipcMain.handle('vscode:diag', () => ({
  serverPort,
  serverPid: child ? child.pid : null,
  serverError: lastError || null,
  serverStartMs: serverReadyAt ? serverReadyAt - coreStartedAt : null, // from the core's start to the server's "listening"
  sockets: sockets.size,
  requests: bridge.size,
  workspace: workspaceFolder(),
  vm: { cpus: os.availableParallelism(), memMiB: Math.round(os.totalmem() / 1048576), freeMiB: Math.round(os.freemem() / 1048576), availableMiB: memAvailableMiB() },
  paths: { data: DATA, serverData: SERVER_DATA, vscode: VSCODE },
  serverLog: logTail.join('\n'),
}));

// ================================================================================================ step 18: New Window, Download to the Mac
// New Window. VS Code's WorkspaceProvider opens a window with window.open(<the page>?folder=… | ?workspace=… | ?ew=true[&payload=…]); the
// page (shim, openAppWindow) asks for `vscode:new-window` instead, and the core opens another app window on the same entry page. A
// window's entry cannot carry a query (SPEC 6 window.create: a path in ui/), so the query waits here and the new page receives it with
// its `vscode:config` (`location`) and puts it in its own URL before the workbench reads it. Every window is its own workbench with its
// own connection to the one server in the VM (ws-bridge.js knows each socket by its window). Closing a window does not quit the app;
// closing the last one does (no 'window-all-closed' listener: the SDK's default, app.quit(), SPEC 8.5).
const download = require('./download');

const WINDOW_OPTIONS = { width: 1400, height: 900, minWidth: 800, minHeight: 500, title: 'Code - OSS' };
const WORKBENCH_QUERY = ['folder', 'workspace', 'ew', 'payload']; // what workbench.ts WorkspaceProvider.create reads from the URL
const windowLocation = new Map(); // BrowserWindow -> '?…' its page starts with

/** The query of a new window: only WorkspaceProvider's own parameters, once each, bounded. '' for none. */
function workbenchQuery(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 32768) throw new Error('not a window location');
  const inQ = new URLSearchParams(raw.replace(/^\?/, ''));
  const out = new URLSearchParams();
  for (const key of WORKBENCH_QUERY) {
    const v = inQ.getAll(key);
    if (v.length === 1 && v[0].length <= (key === 'payload' ? 16384 : 4096)) out.set(key, v[0]);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/** Watches an app window: when it closes, its sockets end and `win` (the parent of the dialogs) moves to a window that is still open. */
function watchWindow(bw) {
  bw.on('closed', () => {
    windowLocation.delete(bw);
    if (bw.id !== null && bw.id !== undefined) sockets.dropWindow(bw.id);
    if (win === bw) win = BrowserWindow.getAllWindows().find((x) => x !== bw && !x.isDestroyed()) || null;
  });
  return bw;
}

function takeWindowLocation(event) {
  const bw = event && event.senderWindow;
  if (!bw || !windowLocation.has(bw)) return null;
  const q = windowLocation.get(bw);
  windowLocation.delete(bw);
  return q || null;
}

ipcMain.handle('vscode:new-window', async (event, req) => {
  const query = workbenchQuery(req && req.query);
  const bw = watchWindow(new BrowserWindow(WINDOW_OPTIONS));
  if (query) windowLocation.set(bw, query);
  await bw.loadFile('index.html');
  log(`opened another window (${bw.id})${query ? ` with ${query.slice(0, 200)}` : ''}`);
  return { win: bw.id };
});

// Download to the Mac (core/download.js): the platform's save dialog, attached to the window that asked
download.attach(ipcMain, { dialog, log, parent: (event) => (event && event.senderWindow) || win });
// ================================================================================================ end of step 18

// ------------------------------------------------------------------------------------------------ app

app.whenReady().then(async () => {
  try {
    startServer();
    await waitForServer(60000);
  } catch (e) {
    lastError = e.message;
    log(`startup: ${e.message}`);
  }
  win = watchWindow(new BrowserWindow(WINDOW_OPTIONS)); // [step 18] WINDOW_OPTIONS, watchWindow: the New Window block above
  await win.loadFile('index.html');
});

// Stop the server (it stops its extension hosts and terminals) before the VM goes down; the SDK waits for this for at most 2 s.
app.on('before-quit', async () => {
  quitting = true;
  sockets.close();
  bridge.close();
  const p = child;
  if (p && p.exitCode === null) {
    await new Promise((resolve) => {
      const kill = setTimeout(() => p.kill('SIGKILL'), 1500);
      p.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      p.kill('SIGTERM');
    });
  }
});
