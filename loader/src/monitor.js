'use strict';
// The live monitor: a menu-bar (Tray) icon owned by the loader, with a small popover that lists the running apps and, for each,
// what it can reach right now (pills): folders, screen, mouse and keyboard, microphone, tools, MCP servers, network. A pill pulses
// while that thing is in use (an event within the last 2 seconds, or a continuous use such as an input session or a live
// microphone track). Per app: Stop, Inspect, and "Show app data in Finder".
//
// Everything here is loader-owned UI (INV-B5): the popover is a loader page (vmapp-loader://ui/monitor.html: contextIsolation,
// sandbox, no Node, the loader CSP), every IPC handler checks that the sender is that page, and the page can only name an app
// id that the loader lists as running. The pills only REPORT: the permission checks live in the broker and the session, and this
// module changes nothing but a Stop (which the library has too). App names and folder names are shown as text, never as markup.
//
// Where "in use" comes from (nothing is measured inside the VM or the renderer):
//   folders      a dialog grant (`grant` events) or a delivered file (`exported`); reads and writes on a share are not observable
//   screen/...   the broker's `host` rows (screen, input, tool:*, mcp:*), and the broker's active() list for input and shell
//   microphone   the DeviceGate's logged requests, and its live-track watch (best effort, see devices.js)
//   network      traffic rows of kind 'net' (SPEC 8.3), when the loader emits them
// Events are matched by kind only; their payloads are never read or kept.

const { EventEmitter } = require('events');
const { BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const { pillOfEvent, buildPills, PULSE_MS } = require('./monitor-model');

const WIDTH = 400;
const MIN_HEIGHT = 130;
const MAX_HEIGHT = 560;

/** A monochrome ring-and-dot icon drawn in code (no image file), 18 pt at 2x, a macOS template image. */
function trayImage() {
  const S = 36;
  const buf = Buffer.alloc(S * S * 4);
  const c = (S - 1) / 2;
  const cover = (v) => Math.max(0, Math.min(1, v + 0.5));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = cover(Math.min(d - 11.5, 15 - d));
      const dot = cover(6.5 - d);
      buf[(y * S + x) * 4 + 3] = Math.round(Math.max(ring, dot) * 255); // B, G, R stay 0: black, the OS tints a template
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

class Monitor extends EventEmitter {
  /**
   * @param {object} o
   * @param {Store} o.store
   * @param {Runner} o.runner
   * @param {object} o.caps the HostCapabilities broker (active() for input / shell)
   * @param {DeviceGate} o.devices
   * @param {Inspector} o.inspector
   * @param {NativeDialogs} o.nativeDialogs
   * @param {Map} o.senders webContents id -> page kind
   * @param {object} o.cfg
   * @param {()=>void} o.openLibrary shows the library window
   * @param {(level,msg)=>void} o.log
   * @param {boolean} [o.noTray] tests that cannot have a menu-bar icon
   *
   * Events: 'state' (the state object) after anything changed, at most about 8 times a second.
   */
  constructor(o) {
    super();
    this.store = o.store;
    this.runner = o.runner;
    this.caps = o.caps;
    this.devices = o.devices;
    this.inspector = o.inspector;
    this.dialogs = o.nativeDialogs;
    this.senders = o.senders;
    this.cfg = o.cfg;
    this.openLibrary = o.openLibrary || (() => {});
    this.log = o.log || (() => {});
    this.win = null;
    this.tray = null;
    this.pinned = false; // opened with --monitor: stays open when it loses focus (developers, tests)
    this.hiddenAt = 0;
    this.last = new Map(); // app id -> { <pill>: ms of the last use }
    this.picks = new Map(); // app id -> Set of dialog-grant names of this run
    this.timer = null;
    this.disposed = false;
    this._ipc();
    this.runner.on('inspect', (appId, kind, item) => this._onInspect(appId, kind, item));
    this.runner.on('changed', (appId) => this._onChanged(appId));
    if (this.caps && typeof this.caps.on === 'function') this.caps.on('active-changed', () => this.refresh());
    if (this.devices && typeof this.devices.on === 'function') this.devices.on('listening', () => this.refresh());
    if (!o.noTray) this._tray();
  }

  // ------------------------------------------------------------------------------------------------ state

  _onChanged(appId) {
    if (this.runner.state(appId) === 'stopped') {
      this.last.delete(appId);
      this.picks.delete(appId);
    }
    this.refresh();
  }

  _onInspect(appId, kind, item) {
    const pill = pillOfEvent(kind, item);
    if (!pill) return;
    if (pill === 'folders' && item && item.t === 'grant' && typeof item.op === 'string') {
      if (!this.picks.has(appId)) this.picks.set(appId, new Set());
      this.picks.get(appId).add(item.op);
    }
    let m = this.last.get(appId);
    if (!m) this.last.set(appId, (m = {}));
    m[pill] = Date.now();
    this.refresh();
  }

  _pills(id, app) {
    const m = app.manifest;
    let grants = {};
    try {
      grants = this.store.loadGrants(id);
    } catch {
      /* shown as nothing allowed */
    }
    return buildPills({
      manifest: m,
      grants,
      active: this.caps && typeof this.caps.active === 'function' ? this.caps.active().filter((e) => e.appId === id) : [],
      picks: this.picks.get(id) ? this.picks.get(id).size : 0,
      listening: !!this.devices && this.devices.listening(id),
      used: this.last.get(id) || {},
    });
  }

  /** { ts, apps: [{id, name, version, state, pills: [{kind, label, title, live, lastAt}]}] } for the apps that are running. */
  state() {
    const now = Date.now();
    const apps = [];
    for (const id of this.runner.activeIds()) {
      let app = null;
      try {
        app = this.store.get(id);
      } catch {
        /* a damaged install is not listed */
      }
      if (!app) continue;
      apps.push({ id, name: app.manifest.name, version: app.manifest.version, state: this.runner.state(id), pills: this._pills(id, app) });
    }
    return { ts: now, pulseMs: PULSE_MS, apps };
  }

  /** Pushes the new state to the open windows (coalesced). */
  refresh() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      const s = this.state();
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('mon:state', s);
      if (this.tray && !this.tray.isDestroyed()) {
        try {
          this.tray.setTitle(s.apps.length ? ` ${s.apps.length}` : '');
          this.tray.setToolTip(s.apps.length ? `D9010 VmApp Launcher: ${s.apps.length} app${s.apps.length === 1 ? '' : 's'} running` : 'D9010 VmApp Launcher: no app is running');
        } catch {
          /* the tray is best effort */
        }
      }
      this.emit('state', s);
    }, 120);
    this.timer.unref();
  }

  // ------------------------------------------------------------------------------------------------ tray and popover

  _tray() {
    try {
      this.tray = new Tray(trayImage());
      this.tray.setToolTip('D9010 VmApp Launcher: no app is running');
      this.tray.on('click', () => this.toggle());
      this.tray.on('right-click', () => {
        this.tray.popUpContextMenu(
          Menu.buildFromTemplate([
            { label: 'Show D9010 VmApp Launcher', click: () => this.openLibrary() },
            { label: 'Activity monitor', click: () => this.show() },
            { type: 'separator' },
            { role: 'quit', label: 'Quit D9010 VmApp Launcher' },
          ]),
        );
      });
    } catch (e) {
      this.log('warn', `menu-bar icon unavailable: ${e.message}`);
      this.tray = null;
    }
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: MIN_HEIGHT + 60,
      useContentSize: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      hasShadow: true,
      title: 'D9010 VmApp activity monitor',
      backgroundColor: '#f5f5f7',
      webPreferences: {
        preload: this.cfg.preloadLoader,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: !this.cfg.isPackaged,
      },
    });
    this.win = win;
    const wcId = win.webContents.id;
    this.senders.set(wcId, 'monitor');
    win.on('blur', () => {
      if (!this.pinned && !win.isDestroyed() && !(win.webContents.isDevToolsOpened && win.webContents.isDevToolsOpened())) this.hide();
    });
    win.on('closed', () => {
      this.senders.delete(wcId);
      if (this.win === win) this.win = null;
    });
    win.loadURL('vmapp-loader://ui/monitor.html').catch((e) => this.log('error', `monitor: ${e.message}`));
    return win;
  }

  _place(win) {
    const [w, h] = win.getSize();
    const b = this.tray && !this.tray.isDestroyed() ? this.tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    const disp = screen.getDisplayNearestPoint({ x: b.x + Math.floor(b.width / 2), y: b.y });
    const wa = disp.workArea;
    let x = b.width ? Math.round(b.x + b.width / 2 - w / 2) : wa.x + wa.width - w - 12;
    x = Math.max(wa.x + 6, Math.min(x, wa.x + wa.width - w - 6));
    const y = b.width ? Math.round(b.y + b.height + 4) : wa.y + 6;
    win.setPosition(x, Math.max(wa.y, y));
  }

  /** Opens the popover under the menu-bar icon. `pinned`: it stays open when it loses focus. */
  show({ pinned = false } = {}) {
    const win = this._ensureWindow();
    this.pinned = pinned;
    this._place(win);
    win.show();
    win.focus();
    win.webContents.send('mon:state', this.state());
    return win;
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.hiddenAt = Date.now();
      this.win.hide();
    }
  }

  toggle() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) return this.hide();
    if (Date.now() - this.hiddenAt < 250) return; // the click that closed it by taking the focus away
    this.show();
  }

  // ------------------------------------------------------------------------------------------------ IPC (the popover page only)

  _runningId(id) {
    if (typeof id !== 'string' || !this.runner.isActive(id)) throw new Error('that app is not running');
    return id;
  }

  _ipc() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          if (this.senders.get(event.sender.id) !== 'monitor' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
          return { ok: true, result: await fn(...args) };
        } catch (e) {
          this.log('warn', `${channel}: ${e.message}`);
          return { ok: false, error: e.message };
        }
      });
    handle('mon:state', () => this.state());
    handle('mon:stop', async (id) => {
      await this.runner.stop(this._runningId(id));
      return {};
    });
    handle('mon:inspect', (id) => {
      if (typeof id !== 'string' || !this.runner.knownIds().includes(id)) throw new Error('unknown app');
      this.inspector.show(id, 'traffic');
      return {};
    });
    handle('mon:showData', (id) => this.showData(id));
    handle('mon:openLibrary', () => {
      this.openLibrary();
      return {};
    });
    handle('mon:resize', (h) => {
      if (!Number.isFinite(h)) throw new Error('bad height');
      if (this.win && !this.win.isDestroyed()) {
        const [w] = this.win.getContentSize();
        this.win.setContentSize(w, Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h))));
      }
      return {};
    });
  }

  /** "Show app data in Finder": the folder is the loader's own data/<id>, never a path from a page. */
  showData(id) {
    if (typeof id !== 'string' || !this.store.get(id)) throw new Error('unknown app');
    this.dialogs.showInFolder(this.store.dataDir(id));
    return {};
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.win && !this.win.isDestroyed()) {
      this.senders.delete(this.win.webContents.id);
      this.win.destroy();
    }
    this.win = null;
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { Monitor };
