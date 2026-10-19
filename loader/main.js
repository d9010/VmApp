'use strict';
// VMApp Loader: the user's app manager and renderer host (SPEC 1, 7, 8). Electron main process.
// The only host-side code that ever runs for an app is this loader; the app's own code runs in a VM and its UI in a
// sandboxed renderer served by vmapp-ui://.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, ipcMain, Menu, session, autoUpdater } = require('electron');

const { resolveConfig } = require('./src/config');
const { forbiddenSwitches } = require('./src/hardening');
const { Store } = require('../hostlib/store');
const { Updates } = require('../hostlib/updates');
const { Catalog, HostCapabilities } = require('../hostlib/capabilities');
const { HostCtl, resolveHostCtlCommand } = require('../hostlib/hostproc');
const { GpuBroker } = require('../hostlib/gpu');
const { validateMenuTemplate, toElectronTemplate, MenuError } = require('../hostlib/menus');
const { windowProxyCredentials } = require('./src/window-manager');

// ---- production hardening (packaged builds only): refuse debugging / sandbox-weakening switches ----
// (Node's --inspect*, NODE_OPTIONS and ELECTRON_RUN_AS_NODE are already dead through the fuses; Chromium's own
// switches are not, so they are checked here before anything else runs.)
if (app.isPackaged) {
  const bad = forbiddenSwitches(process.argv.slice(1));
  if (bad.length) {
    const msg = `D9010 VmApp Launcher will not start with ${bad.join(' ')}. Debugging and sandbox-weakening switches are disabled in the packaged app.`;
    try {
      process.stderr.write(`${msg}\n`);
    } catch {
      /* no console */
    }
    try {
      require('electron').dialog.showErrorBox('D9010 VmApp Launcher cannot start', msg);
    } catch {
      /* the dialog is best effort */
    }
    app.exit(78);
  }
}

// ---- must happen before app ready ----
protocol.registerSchemesAsPrivileged([
  // `stream`: <video> and <audio> expect a streamed answer (Electron: protocol.registerSchemesAsPrivileged), which is what a file of the app's own server is
  { scheme: 'vmapp-ui', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  // isolated frames (SPEC 7, ui.features "frames"): the only scheme where service workers may run (web content in a frame needs them)
  { scheme: 'vmapp-frame', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true } },
  { scheme: 'vmapp-loader', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const cfg = resolveConfig(app.isPackaged);
const devtools = require('./src/devtools');
// Test hook (dev builds only, ignored when packaged): VMAPP_TEST_DEVTOOLS_LOG=<file>. Every window that finishes loading is
// probed once (the menu path, then a direct openDevTools) and one JSON line {kind, appId, win, requested, viaMenu,
// openAfterMenu, directEvent, openAfterDirect} is appended (`requested` = the devTools the app's core asked for in window.create). It
// also turns the packaged-mode `devtools-opened` closer on, so the test can see that closer work.
const devtoolsProbeLog = !cfg.isPackaged && process.env.VMAPP_TEST_DEVTOOLS_LOG ? path.resolve(process.env.VMAPP_TEST_DEVTOOLS_LOG) : null;
const enforceDevTools = cfg.isPackaged || !!devtoolsProbeLog;
app.setName('D9010 VmApp Launcher');
// The About panel: macOS shows the app's own icon (the D9010 logo, build/icon.icns) beside these.
app.setAboutPanelOptions({
  applicationName: 'D9010 VmApp Launcher',
  applicationVersion: app.getVersion(),
  copyright: 'Copyright © 2026 D9010 Inc.',
  credits: 'Open source under the MIT licence. https://vmapp.dev',
});
// Chromium's own state (cookies, partitions' storage) lives under the data root, never in the user's real profile.
fs.mkdirSync(cfg.home, { recursive: true });
app.setPath('userData', path.join(cfg.home, 'electron'));

const logLines = [];
function log(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  if (level === 'debug' && !process.env.VMAPP_LOADER_DEBUG) return;
  try {
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  } catch {
    /* no console */
  }
}

let library = null; // Library (IPC)
let libraryWin = null;
let runner = null;
let settings = null; // the Host Capabilities window (SPEC 8.2)
let hostCaps = null; // the one HostCapabilities of this loader, shared by every AppSession
let hostUi = null;
let gpuBroker = null; // the sandboxed GPU servers, one per running app that was allowed one (SPEC 8.6)
let prefs = null; // the loader's preferences (src/prefs.js)
let updater = null; // the launcher's own updates (src/updater.js, SPEC 8.10)
let appServeFor = null; // app id -> the AppServe that answers its page's requests under the paths its server serves (src/app-serve.js, SPEC 7)
let hostCtl = null; // the vmapp-hostctl client (status, request-permissions, the panic shortcut)
let devicesGate = null; // the DeviceGate: the microphone answer of app windows (SPEC 7, src/devices.js)
let monitor = null; // the live monitor: menu-bar icon + popover (src/monitor.js)
let quitting = false;
let quitDone = false;

const senders = new Map(); // webContents id -> 'library' | 'inspector' | 'settings' | 'badge' | 'monitor' (loader-owned windows)
const registry = new Map(); // webContents id -> app window record (see window-manager.js)
let uiContextsRef = null; // app id -> { app, verified }: the installed manifests the vmapp-ui / vmapp-frame handlers serve from

/** Does the running app `appId` declare isolated frames (SPEC 2.2 ui.features "frames")? Read from its installed manifest only. */
function appHasFrames(appId) {
  const ctx = uiContextsRef && uiContextsRef.get(appId);
  return !!(ctx && (ctx.app.manifest.ui.features || []).includes('frames'));
}

// ---------------------------------------------------------------------------------------------- web contents rules
// Every webContents: no popups, no webviews, and navigation only inside its own origin.
app.on('web-contents-created', (event, contents) => {
  const allowed = (url, isMainFrame) => {
    const rec = registry.get(contents.id);
    if (rec) {
      if (url.startsWith(`vmapp-ui://${rec.appId}/`)) return true;
      // a subframe of an app that declares isolated frames (SPEC 7): its own vmapp-frame origins and local documents only
      return !isMainFrame && appHasFrames(rec.appId) && /^(vmapp-frame:\/\/|about:(blank|srcdoc)$|blob:vmapp-frame:\/\/|data:)/.test(url);
    }
    if (senders.has(contents.id)) return url.startsWith('vmapp-loader://ui/');
    return false;
  };
  // will-navigate passes (event, url); will-frame-navigate passes one details event (url, isMainFrame)
  const block = (e, legacyUrl) => {
    const url = typeof legacyUrl === 'string' ? legacyUrl : String((e && e.url) || '');
    const isMainFrame = !(e && e.isMainFrame === false);
    if (!allowed(url, isMainFrame)) {
      e.preventDefault();
      log('warn', `blocked navigation to ${url.slice(0, 120)}`);
    }
  };
  contents.on('will-navigate', block);
  contents.on('will-frame-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // DevTools: only for an app window whose core created it with devTools: true (webPreferences.devTools says the same; this
  // is the belt to those braces). Where the loader enforces (packaged builds, or the test's devtools probe) it closes
  // DevTools on the loader's own windows and on app windows created with devTools: false.
  if (enforceDevTools) contents.on('devtools-opened', () => (devtools.mustClose(registry.get(contents.id), true) ? contents.closeDevTools() : undefined));
  if (devtoolsProbeLog) contents.once('did-finish-load', () => probeDevTools(contents).catch((e) => log('warn', `devtools probe: ${e.message}`)));
});

async function probeDevTools(wc) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  if (wc.isDestroyed()) return;
  const rec = registry.get(wc.id);
  const kind = rec ? 'app' : senders.get(wc.id);
  if (!kind) return; // DevTools' own contents and anything else the loader did not create
  const bw = BrowserWindow.fromWebContents(wc);
  const out = { kind, appId: rec ? rec.appId : null, win: rec ? rec.win : null, requested: rec ? rec.devTools : null, viaMenu: null, openAfterMenu: null, directEvent: null, openAfterDirect: null };
  if (rec) {
    out.viaMenu = toggleAppDevTools(bw);
    await wait(500);
    out.openAfterMenu = wc.isDestroyed() ? null : wc.isDevToolsOpened();
    if (out.openAfterMenu) {
      wc.closeDevTools();
      await wait(300);
    }
  }
  if (wc.isDestroyed()) return;
  // a direct attempt that skips the menu's check: only webPreferences.devTools and the closer stand in the way.
  // `directEvent` says whether DevTools really opened at all (webPreferences allowed it), even if the closer then closed them.
  let fired = false;
  const onOpened = () => (fired = true);
  wc.once('devtools-opened', onOpened);
  wc.openDevTools({ mode: 'detach' });
  await wait(500);
  wc.removeListener('devtools-opened', onOpened);
  out.directEvent = fired;
  out.openAfterDirect = wc.isDestroyed() ? null : wc.isDevToolsOpened();
  if (out.openAfterDirect) wc.closeDevTools();
  fs.appendFileSync(devtoolsProbeLog, JSON.stringify(out) + '\n');
}

// Authentication: the only one the loader answers is the proxy authentication of a running app's window endpoint, for that app's
// own partition (SPEC 8.3 "The app's windows"); Electron's default cancels every other one (a site's Basic login, another proxy).
app.on('login', (event, webContents, details, authInfo, callback) => {
  const creds = windowProxyCredentials(webContents, authInfo);
  if (!creds) return;
  event.preventDefault();
  callback(creds.username, creds.password);
});

// App links (SPEC 8.9): vmapp://<app id>/… opened on the Mac (a sign-in that redirects back, a link the user clicks) go to that app's
// core, only for an app whose manifest has permissions.links. macOS can deliver one before the loader is ready: kept until it is.
let linkHandler = null;
const earlyLinks = [];
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (linkHandler) linkHandler(url);
  else if (earlyLinks.length < 16) earlyLinks.push(url);
});

/** The "Developer Tools" menu item / Alt+Cmd+I: toggles DevTools of the focused window, only if it is an app window that allows it. */
function toggleAppDevTools(win) {
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (!wc || !devtools.allowedFor(registry.get(wc.id))) return false;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
  return true;
}
function refreshDevToolsMenu(win) {
  setDevToolsItem(win, win && !win.isDestroyed() ? registry.get(win.webContents.id) : null);
}
function setDevToolsItem(win, rec) {
  const menu = Menu.getApplicationMenu();
  const item = menu && menu.getMenuItemById('app-devtools');
  if (item) item.enabled = !!win && !win.isDestroyed() && devtools.allowedFor(rec);
}
app.on('browser-window-focus', (event, win) => {
  menuWindow = win;
  applyMenuFor(win);
});
// (a window shown while the loader is not the active app gets no focus event, nor a 'show' one: the newest window is the target then)
app.on('browser-window-created', (event, win) => {
  if (!BrowserWindow.getFocusedWindow()) menuWindow = win;
});
app.on('browser-window-blur', () => refreshDevToolsMenu(null));

// ---------------------------------------------------------------------------------------------- app IPC (app windows)
// The sender decides the app: the webContents id maps to the window the loader created. Nothing in the message is
// trusted to name an app or a window.
function appRecord(event) {
  const rec = registry.get(event.sender.id);
  if (!rec) return null;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
  return rec;
}

function validMessage(channel, args) {
  return typeof channel === 'string' && channel.length > 0 && channel.length <= 200 && Array.isArray(args) && args.length <= 64;
}

ipcMain.on('vmapp:hello', (event) => {
  const rec = registry.get(event.sender.id);
  event.returnValue = rec ? { id: rec.app.id, name: rec.app.name, version: rec.app.version } : null;
});

// The page says which paths its server serves (sdk/web/vmapp-fetch.js, first thing it does): `vmapp.serve([{prefix, channel}])`. The answer is
// true when the launcher answers those paths itself (SPEC 7 "Files the app's server serves"), false when it does not (the page-side layer then does).
ipcMain.on('vmapp:serve', (event, routes) => {
  const rec = appRecord(event);
  if (!rec || !appServeFor) {
    event.returnValue = false;
    return;
  }
  try {
    event.returnValue = appServeFor(rec.appId).announce(routes);
  } catch (e) {
    log('warn', `[${rec.appId}] ${e.message}`);
    event.returnValue = false;
  }
});

ipcMain.handle('vmapp:invoke', async (event, channel, args) => {
  const rec = appRecord(event);
  if (!rec) return { ok: false, error: 'denied' };
  if (!validMessage(channel, args)) return { ok: false, error: 'invalid invoke' };
  const appSession = rec.getSession();
  if (!appSession) return { ok: false, error: 'app is not running' };
  try {
    return { ok: true, result: await appSession.invoke(rec.win, channel, args) };
  } catch (e) {
    // `text` is what Electron's ipcMain sends for a handler that threw (error.toString()); the page builds "Error invoking remote method …" from it
    const error = e && e.message ? String(e.message) : 'error';
    return { ok: false, error, text: e && typeof e.remoteText === 'string' ? e.remoteText : `Error: ${error}` };
  }
});

ipcMain.on('vmapp:send', (event, channel, args) => {
  const rec = appRecord(event);
  if (!rec || !validMessage(channel, args)) return;
  const appSession = rec.getSession();
  if (!appSession) return;
  try {
    appSession.send(rec.win, channel, args);
  } catch (e) {
    log('warn', `[${rec.appId}] send: ${e.message}`);
  }
});

// vmapp.menu.set(template) from an app's page (SPEC 7 "Menus"): data only, validated; the menu bar shows it while that window is
// focused, and a click comes back to the page ('vmapp:menu-click'). null removes the page's menus.
ipcMain.handle('vmapp:menu-set', (event, template) => {
  const rec = appRecord(event);
  if (!rec) return { ok: false, error: 'not an app window' };
  let v = null;
  try {
    v = template === null ? null : validateMenuTemplate(template);
  } catch (e) {
    return { ok: false, error: e instanceof MenuError ? e.message : 'invalid menu' };
  }
  rec.pageMenu = v ? v.menus : null;
  rec.pageMenuVersion++;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === menuTarget()) showMenu(win, rec);
  const s = rec.getSession();
  if (s && typeof s.log === 'function') s.log('debug', 'host', `the window set its menus: ${v ? v.items : 0} items${v && v.dropped.length ? ` (shortcuts the loader keeps were left out: ${v.dropped.join(', ')})` : ''}`);
  return { ok: true, items: v ? v.items : 0, dropped: v ? v.dropped : [] };
});

// ---------------------------------------------------------------------------------------------- windows
function createLibraryWindow() {
  if (libraryWin && !libraryWin.isDestroyed()) {
    if (libraryWin.isMinimized()) libraryWin.restore();
    libraryWin.show();
    libraryWin.focus();
    return libraryWin;
  }
  libraryWin = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: 'D9010 VmApp Launcher',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: cfg.preloadLoader,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      devTools: !cfg.isPackaged,
    },
  });
  const wcId = libraryWin.webContents.id;
  senders.set(wcId, 'library');
  libraryWin.on('closed', () => {
    senders.delete(wcId);
    libraryWin = null;
  });
  libraryWin.loadURL('vmapp-loader://ui/library.html').catch((e) => log('error', `library: ${e.message}`));
  return libraryWin;
}

/** "Check for Updates…" (the first menu): brings the library forward and asks; the card in the library shows what the answer was. */
function checkForUpdatesNow() {
  createLibraryWindow();
  if (updater) updater.check({ manual: true }).catch((e) => log('warn', `check for updates: ${e.message}`));
}

/**
 * The File menu asks the library page to open one of its own sheets ("Load examples…", "Browse registry…", "Install from file…"). The page decides
 * and shows everything; the menu only brings the library window forward and names the action. A window that is still loading
 * gets the message when it is ready.
 */
function libraryAction(action) {
  const win = createLibraryWindow();
  const send = () => {
    if (library) library.menuAction(action);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

// ---------------------------------------------------------------------------------------------- the menu bar
// The loader's own menu (buildMenu) is the menu bar while a loader window (or nothing) is focused. While an app window is focused and
// its page (vmapp.menu.set) or its core (menu.set) gave menus, the menu bar is: the loader's first menu (About, Hide, Quit), the
// app's menus (data validated by hostlib/menus.js, built here; a click only sends the item's id to the app), the loader's Edit menu
// when the app's menus have no copy or paste of their own (keyboard copy and paste keep working), and the loader's Window menu
// (its windows without shortcuts, so the app may use ⌘1-⌘4; Developer Tools). SPEC 7 "Menus".
let loaderMenu = null;
let loaderMenuParts = null; // { first, edit, window } (templates)
const appMenuCache = new WeakMap(); // registry record -> { key, menu }
let shownMenu = null;
// The window the menu bar belongs to: the focused one, or, while the loader is not the active app, the one focused or shown last
// (the one macOS makes key when the user comes back to the loader).
let menuWindow = null;
const menuTarget = () => BrowserWindow.getFocusedWindow() || (menuWindow && !menuWindow.isDestroyed() ? menuWindow : null);

function effectiveAppMenu(rec) {
  if (!rec) return null;
  if (rec.pageMenu) return { menus: rec.pageMenu, key: `p${rec.pageMenuVersion}`, toPage: true };
  const core = typeof rec.coreMenu === 'function' ? rec.coreMenu() : null;
  return core ? { menus: core, key: `c${rec.coreMenuVersion()}`, toPage: false } : null;
}

function hasEditRoles(menus) {
  const walk = (items) => items.some((it) => (it.role && ['copy', 'paste'].includes(it.role)) || (it.submenu && walk(it.submenu)));
  return menus.some((m) => walk(m.submenu));
}

/** Shows the menu bar that belongs to the focused `win` (an app window with menus, or the loader's own). */
function applyMenuFor(win) {
  showMenu(win, win && !win.isDestroyed() ? registry.get(win.webContents.id) : null);
}

/** The same, for a window whose app record the caller already has (the IPC handler: from the sender). */
function showMenu(win, rec) {
  if (!loaderMenu) return;
  const eff = effectiveAppMenu(rec);
  let menu = loaderMenu;
  if (eff) {
    const cached = appMenuCache.get(rec);
    if (cached && cached.key === eff.key) menu = cached.menu;
    else {
      const appTemplate = toElectronTemplate(eff.menus, (id) => rec.menuClick(id, eff.toPage));
      const template = [loaderMenuParts.first, ...appTemplate];
      if (!hasEditRoles(eff.menus)) template.push(loaderMenuParts.edit);
      template.push(loaderMenuParts.windowForApps);
      try {
        menu = Menu.buildFromTemplate(template);
      } catch (e) {
        log('warn', `[${rec.appId}] its menus could not be shown: ${e.message}`);
        menu = loaderMenu;
      }
      appMenuCache.set(rec, { key: eff.key, menu });
    }
  }
  if (menu !== shownMenu) {
    Menu.setApplicationMenu(menu);
    shownMenu = menu;
    writeMenuProbe();
  }
  setDevToolsItem(win, rec);
}

function buildMenu(inspector, openSettings, openMonitor, showExamples) {
  const first = {
    label: 'D9010 VmApp Launcher',
    submenu: [
      { role: 'about' },
      // asks the update address now (SPEC 8.10): the answer appears as a card in the library window
      { id: 'app-check-updates', label: 'Check for Updates…', click: () => checkForUpdatesNow() },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  const edit = { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] };
  const windowItems = (withKeys) => [
    { label: 'App Library', accelerator: withKeys ? 'CmdOrCtrl+1' : undefined, click: () => createLibraryWindow() },
    { label: 'Bridge Inspector', accelerator: withKeys ? 'CmdOrCtrl+2' : undefined, click: () => inspector.show() },
    { label: 'Host Capabilities…', accelerator: withKeys ? 'CmdOrCtrl+3' : undefined, click: () => openSettings() },
    { label: 'Activity Monitor', accelerator: withKeys ? 'CmdOrCtrl+4' : undefined, click: () => openMonitor() },
    { type: 'separator' },
    { role: 'minimize' },
    { role: 'close' },
  ];
  loaderMenuParts = {
    first,
    edit,
    windowForApps: {
      label: 'Window',
      submenu: [
        ...windowItems(false),
        { type: 'separator' },
        { id: 'app-devtools', label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', enabled: false, click: (item, win) => toggleAppDevTools(win) },
      ],
    },
  };
  const template = [
    first,
    {
      // "Load examples…" is offered whenever the loader has examples to load (a development loader always offers it and explains
      // how to make them when there are none; a packaged one without examples hides the entry).
      label: 'File',
      submenu: [
        { id: 'file-load-examples', label: 'Load examples…', accelerator: 'CmdOrCtrl+Shift+E', visible: !!showExamples, click: () => libraryAction('examples') },
        // "Browse registry…" opens the library's Browse sheet; nothing is asked of any registry until the sheet is open
        { id: 'file-browse-registry', label: 'Browse registry…', accelerator: 'CmdOrCtrl+Shift+B', click: () => libraryAction('browse') },
        { id: 'file-install', label: 'Install from file…', accelerator: 'CmdOrCtrl+O', click: () => libraryAction('install') },
      ],
    },
    edit,
    {
      // The one DevTools entry: enabled only while an app window is focused that its core created with devTools: true
      // (SPEC 7). It never opens DevTools for the loader's own windows. (An app with its own menus has it in the Window menu.)
      label: 'View',
      submenu: [{ id: 'app-devtools', label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', enabled: false, click: (item, win) => toggleAppDevTools(win) }],
    },
    { label: 'Window', submenu: windowItems(true) },
  ];
  loaderMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(loaderMenu);
  shownMenu = loaderMenu;
  startMenuProbe();
}

// Test hook (dev builds only, ignored when packaged): VMAPP_TEST_MENU_DIR=<dir>. The application menu cannot be reached over CDP, so
// the loader writes <dir>/menu.json (every top-level menu with its items: id, label, enabled, visible, accelerator, and their
// submenus) whenever the menu bar changes (an app window with menus gets focused, an app sets new menus), and every 100 ms looks for
// <dir>/click.txt holding a menu item id: it deletes the file, clicks that item exactly as a click of the user would (MenuItem.click,
// which runs the item's own handler) and appends {id, found, enabled} to <dir>/clicked.jsonl. App items have the id `app:<their id>`.
// The line `focus:library` instead stands for the user clicking the library window (macOS gives no focus to a loader that is not
// the active app, which it is not while a test drives it).
let menuProbeDir = null;
function writeMenuProbe() {
  if (!menuProbeDir) return;
  try {
    const items = (list) => list.map((i) => ({ id: i.id || null, label: i.label, role: i.role || null, type: i.type, enabled: i.enabled, visible: i.visible, checked: i.checked, accelerator: i.accelerator ? String(i.accelerator) : null, ...(i.submenu ? { items: items(i.submenu.items) } : {}) }));
    const tree = Menu.getApplicationMenu().items.map((top) => ({ label: top.label, items: items(top.submenu ? top.submenu.items : []) }));
    fs.writeFileSync(path.join(menuProbeDir, 'menu.json'), JSON.stringify(tree, null, 2));
  } catch (e) {
    log('warn', `menu probe: ${e.message}`);
  }
}
function startMenuProbe() {
  const dir = !cfg.isPackaged && process.env.VMAPP_TEST_MENU_DIR ? path.resolve(process.env.VMAPP_TEST_MENU_DIR) : null;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log('warn', `menu probe: ${e.message}`);
    return;
  }
  menuProbeDir = dir;
  writeMenuProbe();
  const clickFile = path.join(dir, 'click.txt');
  setInterval(() => {
    let id;
    try {
      id = fs.readFileSync(clickFile, 'utf8').trim();
      fs.rmSync(clickFile, { force: true });
    } catch {
      return;
    }
    // `open-url:<link>` stands for macOS handing the loader a vmapp:// link (SPEC 8.9), as a click in a browser would
    if (id.startsWith('open-url:')) {
      app.emit('open-url', { preventDefault() {} }, id.slice('open-url:'.length));
      fs.appendFileSync(path.join(dir, 'clicked.jsonl'), JSON.stringify({ id: 'open-url', found: true }) + '\n');
      return;
    }
    if (id === 'focus:library') {
      if (libraryWin && !libraryWin.isDestroyed()) {
        menuWindow = libraryWin;
        applyMenuFor(libraryWin);
      }
      fs.appendFileSync(path.join(dir, 'clicked.jsonl'), JSON.stringify({ id, found: !!libraryWin }) + '\n');
      return;
    }
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    const out = { id, found: !!item, enabled: !!item && item.enabled };
    fs.appendFileSync(path.join(dir, 'clicked.jsonl'), JSON.stringify(out) + '\n');
    if (item && item.enabled) item.click({}, BrowserWindow.getFocusedWindow() || undefined, undefined);
  }, 100).unref();
}

function parseJsonEnv(name, what) {
  if (cfg.isPackaged || !process.env[name]) return null;
  try {
    return JSON.parse(process.env[name]);
  } catch (e) {
    log('error', `${name} ignored (${what}): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- start
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createLibraryWindow());

  app.whenReady().then(() => {
    const { syncRuntimes } = require('./src/runtimes');
    const { createAppUiHandler, createLoaderHandler } = require('./src/protocols');
    const { NativeDialogs } = require('./src/dialogs');
    const { Runner } = require('./src/runner');
    const { Inspector } = require('./src/inspector');
    const { Library } = require('./src/library');
    const { HostUi } = require('./src/host-ui');

    log('info', `data root ${cfg.home}${cfg.homeFromEnv ? ' (from VMAPP_HOME)' : ''}`);
    // a development run (npm start) has no app bundle to take the icon from: give its Dock icon the logo too
    if (!cfg.isPackaged && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(path.join(cfg.uiDir, 'icon.png'));
      } catch (e) {
        log('warn', `dock icon: ${e.message}`);
      }
    }
    if (cfg.isPackaged) {
      const ignored = Object.keys(process.env).filter((k) => /^VMAPP_(TEST_|VM$|KERNEL$|INITRAMFS$|EXAMPLES_DIR$)/.test(k));
      if (ignored.length) log('warn', `packaged build: ignoring ${ignored.join(', ')}`);
    }
    const store = new Store({ home: cfg.home });

    // dev convenience: install the runtime images that sit next to the binaries
    try {
      const r = syncRuntimes(store, cfg.runtimesSrc, (m) => log('info', m));
      if (r.installed.length) log('info', `runtimes installed: ${r.installed.join(', ')}`);
    } catch (e) {
      log('error', `runtime sync failed: ${e.message}`);
    }
    // file-pick clones only exist while an app runs; whatever is left is from a crashed run
    try {
      fs.rmSync(path.join(cfg.home, 'picks'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // default session (the loader's own windows): no permissions, nothing but the loader scheme
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(vmapp-loader|devtools|data):/i.test(details.url) }));

    const uiContexts = new Map();
    uiContextsRef = uiContexts;
    // Files the app's own server serves, answered natively (Electron's protocol.handle contract; src/app-serve.js). The page announces its paths;
    // a path of the package always wins. VMAPP_TEST_NO_NATIVE_SERVE=1 (development builds only) switches it off, to test the page-side layer.
    const { AppServe } = require('./src/app-serve');
    const { appCsp } = require('./src/protocols');
    const noNativeServe = !cfg.isPackaged && process.env.VMAPP_TEST_NO_NATIVE_SERVE === '1';
    const appServes = new Map();
    appServeFor = (appId) => {
      let s = appServes.get(appId);
      if (!s) {
        const ctx = uiContexts.get(appId);
        s = new AppServe({
          appId,
          getSession: () => (runner ? runner.sessionOf(appId) : null),
          csp: ctx ? appCsp(ctx.app.manifest.ui.features) : '',
          enabled: !noNativeServe,
          log: (m) => log('warn', m),
        });
        appServes.set(appId, s);
      }
      return s;
    };
    const serveBridge = {
      covers: (appId, pathname) => appServeFor(appId).covers(pathname),
      handle: (appId, request) => appServeFor(appId).handle(request),
    };
    const handleAppUi = createAppUiHandler(uiContexts, (m) => log('warn', m), serveBridge);
    const getIconPath = (id) => {
      try {
        const a = store.get(id);
        return a && a.iconPath;
      } catch {
        return null;
      }
    };
    ses.protocol.handle('vmapp-loader', createLoaderHandler({ uiDir: cfg.uiDir, getIconPath }));

    const nativeDialogs = new NativeDialogs({ isPackaged: cfg.isPackaged, log, dataDir: cfg.home });

    // ---- host capabilities (SPEC 8.2): one broker for the whole loader, handed to every AppSession ----
    // The catalog (tools.json, mcp.json) is written only by the settings window and the CLI (INV-H1); the broker gets a
    // read-only view. The helper vmapp-hostctl is spawned lazily, except that the panic shortcut is registered at startup.
    const catalog = new Catalog({ home: store.home });
    let ctl;
    try {
      ctl = new HostCtl({ command: resolveHostCtlCommand({ packaged: cfg.isPackaged, bundled: cfg.hostctl }), panicHotkey: process.platform === 'darwin' });
    } catch (e) {
      log('error', `host helper unavailable: ${e.message}`);
      const err = e;
      ctl = { request: () => Promise.reject(err), on() {}, close: () => Promise.resolve() };
    }
    // the loader's own switches (src/prefs.js): today "Show typed text in the overlay", off by default; changed only in the settings window
    const { LoaderPrefs } = require('./src/prefs');
    prefs = new LoaderPrefs({ home: store.home, log });
    hostUi = new HostUi({ nativeDialogs, parentOf: (id) => (runner ? runner.parentWindow(id) : null), catalog: catalog.readonly(), ctl, cfg, senders, prefs, log });
    hostCaps = new HostCapabilities({ store, catalog, ui: hostUi, hostctl: ctl, packaged: cfg.isPackaged });
    hostCaps.on('warning', (m) => {
      log('warn', `host capabilities: ${m}`);
      if (library) library.notice('warn', m);
    });
    hostCaps.on('active-changed', () => {
      if (library) library.notify();
    });
    // Panic (the shortcut, or a Stop-everything button): the broker has already stopped everything; say so.
    hostCaps.on('panic', ({ reason }) => {
      const text = reason === 'panic' ? 'Panic shortcut: every app was stopped from controlling your computer.' : 'Stopped: no app is controlling your computer now.';
      log('warn', `host capabilities: ${text}`);
      nativeDialogs.notify('D9010 VmApp Launcher', text);
      if (library) library.notice('warn', text);
    });
    hostCtl = ctl;
    hostCaps.enablePanic().catch((e) => log('warn', `host helper: ${e.message}`)); // the shortcut works from the start

    // ---- the GPU (SPEC 8.6, INV-H7): one sandboxed rpc-server per running app that asked for `gpu` and was allowed ----
    // The binary and its sandbox profile are the loader's own bundled files (src/config.js). A server that a crashed loader left
    // behind is stopped now; panic (the shortcut, Stop everything) stops every server and the quit sequence does too.
    gpuBroker = new GpuBroker({ binary: cfg.gpuServer, profile: cfg.gpuProfile, home: store.home });
    gpuBroker.reapStale().then((pids) => (pids.length ? log('warn', `stopped ${pids.length} GPU server(s) left behind by an earlier run of the loader`) : undefined)).catch(() => {});
    gpuBroker.on('active-changed', () => {
      if (library) library.notify();
    });
    hostCaps.on('panic', ({ reason }) => {
      gpuBroker.stopAll('panic').catch((e) => log('warn', `stopping the GPU servers: ${e.message}`));
      if (reason === 'panic' && gpuBroker.active().length) log('warn', 'panic: the GPU servers were stopped');
    });

    // ---- devices (SPEC 7): the microphone gate of every app window's partition (INV-B3). Its requests are logged in the Inspector. ----
    const { DeviceGate } = require('./src/devices');
    devicesGate = new DeviceGate({ store, registry, log });
    runner = new Runner({ store, cfg, registry, uiContexts, handleAppUi, nativeDialogs, capabilities: hostCaps, devices: devicesGate, gpu: gpuBroker, prefs, log, onMenuChanged: () => applyMenuFor(menuTarget()) });
    devicesGate.on('event', ({ appId, ev }) => runner.emitTraffic(appId, ev));
    devicesGate.on('listening', () => {
      if (library) library.notify();
    });
    const inspector = new Inspector({ runner, store, cfg, senders, log });
    // The only network code of the loader lives in hostlib/updates.js and runs only on the user's say-so (INV-G3).
    const updates = new Updates(store);
    updates.cleanTmp(); // downloads left by a crashed run
    library = new Library({
      store,
      updates,
      registryDefault: cfg.registry,
      examplesDir: cfg.examplesDir,
      packaged: cfg.isPackaged,
      runner,
      inspector,
      nativeDialogs,
      senders,
      catalog,
      capabilities: hostCaps,
      devices: devicesGate,
      activity: () => (monitor ? monitor.state() : { apps: [] }),
      openSettings: () => settings.show(),
      testGrants: parseJsonEnv('VMAPP_TEST_GRANTS', 'test grants'),
      log,
    });
    const { Settings } = require('./src/settings');
    settings = new Settings({ catalog, store, caps: hostCaps, ctl, nativeDialogs, cfg, senders, prefs, log, onCatalogChanged: () => library.notify() });
    // ---- the launcher's own updates (SPEC 8.10, INV-U1) ----
    // The question "is there a newer launcher?" is network code and lives in hostlib/updates.js; Electron's updater downloads and
    // installs, and refuses an app that is not signed like this one. Nothing downloads without "Update now", nothing restarts
    // without "Restart to update". A development build (or an ad hoc signed one) shows the update but offers "Download" instead.
    const { LauncherUpdater } = require('./src/updater');
    const testFeed = !cfg.isPackaged && process.env.VMAPP_TEST_UPDATE_FEED ? process.env.VMAPP_TEST_UPDATE_FEED : ''; // dev builds only
    const testDelay = !cfg.isPackaged && process.env.VMAPP_TEST_UPDATE_DELAY_MS ? Number(process.env.VMAPP_TEST_UPDATE_DELAY_MS) : undefined;
    // Where this copy sits decides whether it can replace itself: macOS runs an app opened from Downloads from a temporary read-only copy
    // ("app translocation"), and Squirrel.Mac then refuses ("Cannot update while running on a read-only volume"). Said before "Update now".
    const bundlePath = path.resolve(process.execPath, '..', '..', '..');
    const locationBlock = () => {
      if (!cfg.isPackaged || process.platform !== 'darwin') return '';
      if (bundlePath.includes('/AppTranslocation/')) return 'translocated';
      try {
        fs.accessSync(path.dirname(bundlePath), fs.constants.W_OK);
      } catch {
        return 'readonly';
      }
      return '';
    };
    // dev builds only: pretend to sit somewhere that cannot update, and record the move instead of doing it (the CDP run Y)
    const testBlock = !cfg.isPackaged && ['translocated', 'readonly'].includes(process.env.VMAPP_TEST_INSTALL_BLOCK) ? process.env.VMAPP_TEST_INSTALL_BLOCK : '';
    const testMoveLog = !cfg.isPackaged && process.env.VMAPP_TEST_MOVE_LOG ? path.resolve(process.env.VMAPP_TEST_MOVE_LOG) : '';
    const moveToApplications =
      cfg.isPackaged && process.platform === 'darwin' && typeof app.moveToApplicationsFolder === 'function'
        ? async () => {
            // an older copy in Applications is replaced (the user pressed Move); one that is running is not touched
            const moved = app.moveToApplicationsFolder({ conflictHandler: (type) => type === 'exists' });
            if (!moved) throw new Error('A copy of the launcher is already open in the Applications folder; quit it and try again.');
          }
        : testBlock && testMoveLog
          ? async () => {
              fs.appendFileSync(testMoveLog, 'move\n');
            }
          : null;
    updater = new LauncherUpdater({
      home: store.home,
      version: app.getVersion(),
      packaged: cfg.isPackaged,
      prefs,
      autoUpdater: cfg.isPackaged && process.platform === 'darwin' ? autoUpdater : null,
      feedUrl: testFeed || undefined,
      dev: !cfg.isPackaged,
      osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
      startupDelayMs: Number.isFinite(testDelay) ? testDelay : undefined,
      installBlock: testBlock || locationBlock(),
      moveToApplications,
      log,
    });
    updater.on('state', (s) => library.push('upd:state', s));
    const confirmRestart = async (parent, moving = false) => {
      const running = runner.activeIds();
      if (running.length) {
        const r = await nativeDialogs.message(
          parent,
          {
            type: 'question',
            buttons: [moving ? 'Move and restart' : 'Restart and update', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            message: moving ? 'Move the launcher to the Applications folder and restart it?' : 'Restart the launcher to finish updating?',
            detail: `${running.length === 1 ? '1 app is' : `${running.length} apps are`} running and will be stopped.`,
          },
          'launcher-restart',
        );
        if (r !== 0) return false;
      }
      await runner.stopAll(10000);
      return true;
    };
    const updateHandle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          if (senders.get(event.sender.id) !== 'library' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
          return { ok: true, result: await fn(BrowserWindow.fromWebContents(event.sender), ...args) };
        } catch (e) {
          log('warn', `${channel}: ${e.message}`);
          return { ok: false, error: e.message };
        }
      });
    updateHandle('upd:state', () => updater.state());
    updateHandle('upd:check', () => updater.check({ manual: true }));
    updateHandle('upd:install', () => updater.install());
    updateHandle('upd:restart', (parent) => updater.restart(() => confirmRestart(parent)));
    updateHandle('upd:move', (parent) => updater.moveToApplications(() => confirmRestart(parent, true)));
    updateHandle('upd:skip', () => updater.skip());
    updateHandle('upd:later', () => updater.later());
    updateHandle('upd:dismiss', () => updater.dismiss());
    updateHandle('upd:open', async (parent, kind) => ({ opened: await nativeDialogs.openLauncherPage(parent, updater.pageFor(String(kind))) }));
    // ---- live monitor: the menu-bar icon and its popover (running apps, what each can reach, Stop) ----
    const { Monitor } = require('./src/monitor');
    monitor = new Monitor({ store, runner, caps: hostCaps, devices: devicesGate, inspector, nativeDialogs, senders, cfg, log, openLibrary: () => createLibraryWindow() });
    monitor.on('state', (s) => library.pushActivity(s));
    library.onNotify = () => monitor.refresh();
    // ---- app links (SPEC 8.9) ----
    const pendingLinks = new Map(); // app id -> links waiting for the app to finish starting (2 minutes at most)
    const deliverLink = (id, href) => {
      try {
        runner.sessionOf(id).openUrl(href);
        log('info', `[${id}] app link delivered`);
      } catch (e) {
        log('warn', `[${id}] app link not delivered: ${e.message}`);
      }
    };
    runner.on('changed', (id) => {
      const waiting = pendingLinks.get(id);
      if (!waiting || runner.state(id) === 'starting') return;
      pendingLinks.delete(id);
      if (runner.state(id) !== 'running') return;
      for (const l of waiting) if (Date.now() - l.at < 120000) deliverLink(id, l.href);
    });
    linkHandler = async (url) => {
      let u;
      try {
        u = new URL(String(url).slice(0, 4096));
      } catch {
        return log('warn', 'app link ignored: not a link');
      }
      const id = u.hostname;
      const a = u.protocol === 'vmapp:' ? store.get(id) : null;
      if (!a) return log('warn', `app link ignored: no installed app "${id.slice(0, 100)}"`);
      if (!a.manifest.permissions.links) return log('warn', `app link ignored: ${id} does not take vmapp:// links`);
      if (runner.state(id) === 'running') return deliverLink(id, u.href);
      if (runner.state(id) === 'starting') return void pendingLinks.set(id, [...(pendingLinks.get(id) || []), { href: u.href, at: Date.now() }]);
      // not running: the user decides (loader words; a link never starts an app by itself)
      const answer = await nativeDialogs.message(
        null,
        { type: 'question', buttons: ['Start', 'Cancel'], defaultId: 0, cancelId: 1, message: `Open this link in “${a.manifest.name}”?`, detail: `“${a.manifest.name}” is not running. Start it to open the link (vmapp://${id}${u.pathname}).` },
        'app-link',
      );
      if (answer !== 0) return log('info', `[${id}] app link: the user did not start the app`);
      pendingLinks.set(id, [...(pendingLinks.get(id) || []), { href: u.href, at: Date.now() }]);
      createLibraryWindow();
      try {
        await library.launch(id); // the permission sheet comes first if it is needed; the link is delivered once the app runs
      } catch (e) {
        log('warn', `[${id}] app link: ${e.message}`);
      }
    };
    for (const l of earlyLinks.splice(0)) linkHandler(l);
    // the loader is the Mac's handler of vmapp:// links (packaged: Info.plist CFBundleURLTypes; dev: registered for this checkout)
    if (cfg.isPackaged) app.setAsDefaultProtocolClient('vmapp');
    buildMenu(inspector, () => settings.show(), () => monitor.show(), library.examplesInfo().show);
    createLibraryWindow();
    updater.start(); // the automatic checks (a little after start-up, then daily), unless the user turned them off
    if (process.argv.includes('--inspector')) inspector.show();
    if (process.argv.includes('--host-settings')) settings.show();
    if (process.argv.includes('--monitor')) monitor.show({ pinned: true }); // the popover, kept open (developers, tests)
    app.on('activate', () => createLibraryWindow());
    log('info', 'ready');
  });

  // Closing every window does not quit on macOS; the apps keep running until the user stops them or quits.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Quit: stop every running app (before-quit, shutdown, windows closed; at most 10 s), then really quit.
  app.on('before-quit', (e) => {
    if (quitDone || !runner) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    if (updater) updater.stop();
    runner
      .stopAll(10000)
      .catch((err) => log('error', `stopping apps: ${err.message}`))
      // then everything host capabilities started (input sessions, tools, MCP servers, the helper) and the badge
      .then(() => (hostCaps ? hostCaps.close() : undefined))
      .then(() => (gpuBroker ? gpuBroker.stopAll('loader-quit') : undefined))
      .then(() => (hostCtl ? hostCtl.close() : undefined))
      .catch((err) => log('error', `stopping host capabilities: ${err.message}`))
      .finally(() => {
        if (hostUi) hostUi.dispose();
        if (monitor) monitor.dispose();
        if (devicesGate) devicesGate.dispose();
        quitDone = true;
        log('info', 'apps stopped; quitting');
        app.quit();
        // a quit that was started by a signal can stall on macOS after before-quit was deferred: make sure we leave
        setTimeout(() => app.exit(0), 2000).unref();
      });
  });

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      log('info', `${sig}: quitting`);
      app.quit();
    });
  }
}

process.on('uncaughtException', (e) => log('error', `uncaught exception: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => log('error', `unhandled rejection: ${e && e.stack ? e.stack : e}`));
