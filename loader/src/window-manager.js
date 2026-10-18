'use strict';
// The real window manager for one running app (hostlib/README.md "Window manager interface", SPEC 7).
// One BrowserWindow per window.create, in the app's own partition, with the loader's preload and no Node.

const { BrowserWindow, session: electronSession } = require('electron');
const { APP_CSP, createAppFrameHandler } = require('./protocols');
const { microphoneRequestAllowed, microphoneCheckAllowed, clipboardRequestAllowed, clipboardCheckAllowed } = require('./devices');
const { windowNetAllowed } = require('./window-net');
const { createLeaveGuard, LEAVE_QUIET_MS } = require('./leave-page');

// vmapp-frame (SPEC 7, isolated frames) is answered by its handler only for an app that declares "frames"; it is no network either
const allowedSchemes = /^(vmapp-ui|vmapp-frame|data|blob|devtools):/i;
const configuredPartitions = new Set();
// appId -> the window endpoint of the app's current run ({host, port, username, password}, AppSession.windowProxy), while the
// partition's proxy points at it (SPEC 8.3 "The app's windows"). Without an entry nothing but allowedSchemes leaves the partition.
const windowNet = new Map();
const windowNetChain = new Map(); // appId -> the last proxy change of that partition (changes run one after the other)

/**
 * Locks a partition down once per process: every permission request/check is denied, and any request outside
 * vmapp-ui / data / blob is cancelled (defence in depth beside the CSP: the renderer has no network of its own). The one
 * exception is the network of an app that declares the window feature "network" (SPEC 8.3 "The app's windows"):
 * windowNetAllowed (window-net.js) lets https/wss data requests out while the run's window endpoint is set, and the partition's
 * proxy sends them to that endpoint, where vmapp-vm applies the app's network rules.
 *
 * The permissions SPEC defines for app windows are two devices (SPEC 2.2 permissions.devices, SPEC 7, 8.4): the microphone,
 * answered only by microphoneRequestAllowed / microphoneCheckAllowed (`true` for getUserMedia({audio})), and the clipboard,
 * answered only by clipboardRequestAllowed / clipboardCheckAllowed (`true` for clipboard-read / clipboard-sanitized-write), each
 * when the manifest asks for the device AND the user allowed it for this app; `false` for everything else. `devices` is the
 * loader's DeviceGate; without one every permission is denied.
 */
function lockPartition(partition, handleAppUi, devices, uiContexts) {
  if (configuredPartitions.has(partition)) return electronSession.fromPartition(partition);
  configuredPartitions.add(partition);
  const ses = electronSession.fromPartition(partition);
  const appId = partition.replace(/^persist:vmapp-/, '');
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') return callback(microphoneRequestAllowed(devices, appId, wc, permission, details));
    return callback(clipboardRequestAllowed(devices, appId, wc, permission, details));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission === 'media') return microphoneCheckAllowed(devices, appId, wc, permission, details);
    return clipboardCheckAllowed(devices, appId, wc, permission, details);
  });
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(allowedSchemes.test(details.url) || windowNetAllowed(windowNet.get(appId), details)) }));
  ses.protocol.handle('vmapp-ui', handleAppUi);
  // isolated frames of this app only: the partition names the app, the URL's host only makes the frame's origin
  if (uiContexts) ses.protocol.handle('vmapp-frame', createAppFrameHandler(uiContexts, appId));
  return ses;
}

function partitionOf(appId) {
  return `persist:vmapp-${appId}`;
}

function chainWindowNet(appId, step) {
  const next = (windowNetChain.get(appId) || Promise.resolve()).then(step, step);
  windowNetChain.set(appId, next.catch(() => {}));
  return next;
}

/**
 * Points the app's partition at its run's window endpoint (SPEC 8.3 "The app's windows"): every http(s)/ws(s) request goes to
 * the endpoint (`<-loopback>`: even a loopback one, which the endpoint refuses), then the request filter lets the allowed kinds out.
 */
function openWindowNet(appId, proxy) {
  return chainWindowNet(appId, async () => {
    const ses = electronSession.fromPartition(partitionOf(appId));
    const at = `${proxy.host}:${proxy.port}`;
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http=${at};https=${at}`, proxyBypassRules: '<-loopback>' });
    await ses.closeAllConnections();
    windowNet.set(appId, proxy);
  });
}

/**
 * The run ended: the filter refuses at once, then the proxy setting and the cached proxy credentials go. Chained after a change
 * still in flight, so an endpoint set for a window that was being created cannot outlive its run.
 */
function closeWindowNet(appId) {
  windowNet.delete(appId);
  return chainWindowNet(appId, async () => {
    windowNet.delete(appId);
    const ses = electronSession.fromPartition(partitionOf(appId));
    await ses.setProxy({ mode: 'direct' });
    await ses.clearAuthCache();
    await ses.closeAllConnections();
  });
}

/**
 * The credentials for a proxy authentication (Electron's app 'login' event), or null: only for the window endpoint of a running app,
 * and only for a request of that app's own partition. A request without a webContents (a service worker) can only have reached
 * this endpoint through that partition's proxy setting, since no other session points at it.
 */
function windowProxyCredentials(webContents, authInfo) {
  if (!authInfo || authInfo.isProxy !== true || String(authInfo.scheme).toLowerCase() !== 'basic') return null;
  for (const [appId, p] of windowNet) {
    if (authInfo.host !== p.host || Number(authInfo.port) !== p.port) continue;
    if (webContents && webContents.session !== electronSession.fromPartition(partitionOf(appId))) return null;
    return { username: p.username, password: p.password };
  }
  return null;
}

class AppWindowManager {
  /**
   * @param {object} o
   * @param {{id,name,version}} o.app
   * @param {Map} o.registry webContents id -> { appId, win, getSession }, used to route renderer IPC
   * @param {string} o.preload path of preload-app.js
   * @param {(level,msg)=>void} o.log
   * @param {NativeDialogs} [o.dialogs] asks "Leave this page?" when a page vetoes its unload; without it the page stays
   */
  constructor(o) {
    this.app = o.app;
    this.registry = o.registry;
    this.preload = o.preload;
    this.log = o.log || (() => {});
    this.dialogs = o.dialogs || null;
    this.session = null;
    this.wins = new Map(); // host window id -> { bw, wcId, title, queue, loaded, resizeTimer }
    this.nextId = 1;
    // the app's menus as its core set them (menu.set, validated by the session): used for every window of the app whose page set none
    this.coreMenu = null;
    this.coreMenuVersion = 0;
    this.onMenuChanged = o.onMenuChanged || (() => {});
  }

  /** menu.set from the core (SPEC 7 "Menus"): the loader shows it while a window of this app is focused. */
  async setMenu(menus) {
    this.coreMenu = menus;
    this.coreMenuVersion++;
    this.onMenuChanged();
  }

  attach(session) {
    this.session = session;
    return this;
  }

  _title(base) {
    return base ? `${base} — ${this.app.name}` : this.app.name;
  }

  _report(win, event, data) {
    if (this.session) this.session.windowEvent(win, event, data || {});
  }

  /** Windows currently open (host window id -> BrowserWindow) for dialog parenting. */
  browserWindow(win) {
    const rec = this.wins.get(win);
    return rec && !rec.bw.isDestroyed() ? rec.bw : null;
  }
  anyBrowserWindow() {
    for (const rec of this.wins.values()) if (!rec.bw.isDestroyed()) return rec.bw;
    return null;
  }

  async create(params) {
    // the run's window endpoint, before its first window loads anything (SPEC 8.3 "The app's windows")
    const proxy = this.session && this.session.windowProxy;
    if (proxy && windowNet.get(this.app.id) !== proxy) await openWindowNet(this.app.id, proxy);
    const win = this.nextId++;
    const bw = new BrowserWindow({
      width: params.width,
      height: params.height,
      minWidth: params.minWidth,
      minHeight: params.minHeight,
      resizable: params.resizable !== false,
      title: this._title(params.title),
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: partitionOf(this.app.id),
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
        // DevTools: what the app's core asked for in this window.create (the SDK's webPreferences.devTools, default false),
        // in dev and packaged builds alike (SPEC 7, INV-B1). The renderer cannot change it.
        devTools: params.devTools === true,
      },
    });
    const wc = bw.webContents;
    const wcId = wc.id;
    const rec = { bw, wcId, queue: [], loaded: false, resizeTimer: null };
    this.wins.set(win, rec);
    this.registry.set(wcId, {
      appId: this.app.id,
      win,
      getSession: () => this.session,
      app: this.app,
      devTools: params.devTools === true,
      // menus (SPEC 7): the page's own (vmapp.menu.set, kept here by main.js) win over the core's while this window is focused
      pageMenu: null,
      pageMenuVersion: 0,
      coreMenu: () => this.coreMenu,
      coreMenuVersion: () => this.coreMenuVersion,
      // a click of one of the app's menu items: to the page that set the menu, or to the core as the window event 'menu'
      menuClick: (id, toPage) => {
        if (toPage) {
          if (!wc.isDestroyed()) wc.send('vmapp:menu-click', id);
        } else this._report(win, 'menu', { id });
      },
    });

    wc.on('page-title-updated', (e) => e.preventDefault()); // the host owns the title
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const flush = () => {
      rec.loaded = true;
      for (const m of rec.queue.splice(0)) this._deliver(rec, m.channel, m.args);
    };
    wc.on('did-finish-load', flush);
    wc.on('did-fail-load', (e, code, desc, url) => {
      this.log('warn', `window ${win}: failed to load ${url}: ${desc} (${code})`);
      flush();
    });
    // the page vetoed its unload (beforeunload): the loader asks in its own words (SPEC 7, INV-B5); preventDefault = Leave anyway
    const leaveGuard = createLeaveGuard({ appName: this.app.name, ask: (text) => (this.dialogs ? this.dialogs.confirmLeave(bw, text, this.app) : false) });
    wc.on('will-prevent-unload', (e) => {
      const r = leaveGuard();
      if (r.leave) e.preventDefault();
      else if (!r.asked) this.log('info', `window ${win}: the page vetoed its unload again within ${LEAVE_QUIET_MS} ms of Stay; it stays without asking`);
    });
    wc.on('render-process-gone', (e, details) => this.log('error', `window ${win}: renderer gone (${details.reason})`));
    wc.on('unresponsive', () => this.log('warn', `window ${win}: renderer is not responding`));
    bw.once('ready-to-show', () => {
      if (!bw.isDestroyed()) bw.show();
    });
    bw.on('focus', () => this._report(win, 'focus'));
    bw.on('blur', () => this._report(win, 'blur'));
    bw.on('resize', () => {
      clearTimeout(rec.resizeTimer);
      rec.resizeTimer = setTimeout(() => {
        if (bw.isDestroyed()) return;
        const [width, height] = bw.getContentSize();
        this._report(win, 'resize', { width, height });
      }, 100);
    });
    bw.on('closed', () => {
      clearTimeout(rec.resizeTimer);
      this.wins.delete(win);
      this.registry.delete(wcId);
      this._report(win, 'closed');
    });

    const url = `vmapp-ui://${this.app.id}/${params.entry.split('/').map(encodeURIComponent).join('/')}`;
    bw.loadURL(url).catch((e) => this.log('warn', `window ${win}: loadURL: ${e.message}`));
    return win;
  }

  _rec(win) {
    const rec = this.wins.get(win);
    if (!rec || rec.bw.isDestroyed()) throw new Error(`unknown window ${win}`);
    return rec;
  }

  async close(win) {
    const rec = this.wins.get(win);
    if (!rec || rec.bw.isDestroyed()) return;
    rec.bw.destroy(); // 'closed' follows and is reported to the session
  }

  async setTitle(win, title) {
    this._rec(win).bw.setTitle(this._title(title));
  }

  async focus(win) {
    const bw = this._rec(win).bw;
    if (bw.isMinimized()) bw.restore();
    bw.show();
    bw.focus();
  }

  emit(win, channel, args) {
    const rec = this._rec(win);
    if (!rec.loaded) rec.queue.push({ channel, args });
    else this._deliver(rec, channel, args);
  }

  _deliver(rec, channel, args) {
    if (rec.bw.isDestroyed() || rec.bw.webContents.isDestroyed()) return;
    rec.bw.webContents.send('vmapp:emit', channel, args);
  }

  closeAll() {
    for (const win of [...this.wins.keys()]) {
      const rec = this.wins.get(win);
      if (rec && !rec.bw.isDestroyed()) rec.bw.destroy();
    }
    closeWindowNet(this.app.id).catch((e) => this.log('warn', `window network: ${e.message}`));
  }
}

module.exports = { AppWindowManager, lockPartition, partitionOf, windowProxyCredentials, APP_CSP };
