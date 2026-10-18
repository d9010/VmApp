'use strict';
// "Select a region…" (SPEC 8.2): a loader-owned, full-screen, dimmed, transparent window on ONE display where the user
// drags a rectangle. Esc (or a right click, or two minutes without an answer) cancels. It exists only during the selection
// and nothing an app sends can reach it (INV-B5): the app never sees this window, and it receives only the rectangle the
// user picked, in global desktop points (origin: top left of the main display, a second display to the left has negative x).
//
// The selection window is NOT a window of the app and no app code runs in it: it is the loader's own page
// (vmapp-loader://ui/region.html: contextIsolation, sandbox, no Node, the loader CSP).

const { BrowserWindow, ipcMain, screen } = require('electron');
const { clipRect, localToGlobal } = require('./capture-logic');

const TIMEOUT_MS = 120000;

class RegionSelect {
  /**
   * @param {object} o
   * @param {object} o.cfg resolveConfig() result
   * @param {Map} o.senders webContents id -> page kind
   * @param {NativeDialogs} o.dialogs the dev test hook gives the rectangle instead of showing the window
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.senders = o.senders;
    this.dialogs = o.dialogs;
    this.log = o.log || (() => {});
    this.cur = null; // the selection in progress: { win, origin, resolve, timer }
    this._ipc();
  }

  _ipc() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, (event, ...args) => {
        try {
          // only the selection window of this moment, only its main frame
          if (this.senders.get(event.sender.id) !== 'region' || event.senderFrame !== event.sender.mainFrame || !this.cur || this.cur.win.webContents.id !== event.sender.id) throw new Error('denied');
          return { ok: true, result: fn(...args) };
        } catch (e) {
          this.log('warn', `${channel}: ${e.message}`);
          return { ok: false, error: e.message };
        }
      });
    handle('region:done', (sel) => {
      this._finish(localToGlobal(sel, this.cur.origin));
      return {};
    });
    handle('region:cancel', () => {
      this._finish(null);
      return {};
    });
  }

  _finish(rect) {
    const cur = this.cur;
    if (!cur) return;
    this.log('debug', `region selection: finished ${rect ? `${rect.w}x${rect.h}` : 'cancelled'}`);
    this.cur = null;
    clearTimeout(cur.timer);
    this.senders.delete(cur.wcId);
    if (!cur.win.isDestroyed()) cur.win.destroy();
    cur.resolve(rect);
  }

  /** Stops a selection that is open (panic, the loader quitting): the answer is "cancelled". */
  cancel() {
    this._finish(null);
  }

  /**
   * Lets the user drag a rectangle on `display` (an item of hostctl `displays`: {display, bounds:{x,y,w,h}, ...}).
   * Resolves with {x,y,w,h} in global points, or null when cancelled. One selection at a time.
   */
  async select(display) {
    const hooked = this.dialogs.regionAnswer(display.display);
    if (hooked !== undefined) {
      if (!hooked) return null;
      const r = ['x', 'y', 'w', 'h'].map((k) => Number(hooked[k]));
      if (r.some((v) => !Number.isFinite(v))) return null;
      return clipRect({ x: r[0], y: r[1], w: r[2], h: r[3] }, display.bounds);
    }
    if (this.cur) this._finish(null);
    // the Electron display that is this one: same area in points (hostctl and Electron use the same global space)
    const b = display.bounds;
    const all = screen.getAllDisplays();
    const same = all.find((d) => d.bounds.x === b.x && d.bounds.y === b.y && d.bounds.width === b.w && d.bounds.height === b.h);
    const eb = (same || screen.getDisplayNearestPoint({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) })).bounds;
    const win = new BrowserWindow({
      x: eb.x,
      y: eb.y,
      width: eb.width,
      height: eb.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      show: false,
      alwaysOnTop: true,
      title: 'D9010 VmApp: select a region',
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
    const wcId = win.webContents.id;
    this.senders.set(wcId, 'region');
    if (this.dialogs.hook) this.dialogs.noteRegionWindow({ x: eb.x, y: eb.y, width: eb.width, height: eb.height }, { x: eb.x, y: eb.y });
    return new Promise((resolve) => {
      const cur = { win, wcId, origin: { x: eb.x, y: eb.y }, resolve, timer: setTimeout(() => this._finish(null), TIMEOUT_MS) };
      this.cur = cur;
      win.on('closed', () => {
        if (this.cur === cur) this._finish(null);
      });
      // Esc works even before the page has focus
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') this._finish(null);
      });
      this.log('debug', `region selection: window ${wcId} on ${eb.x},${eb.y} ${eb.width}x${eb.height}`);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.setBounds(eb);
      win.webContents.once('did-finish-load', () => {
        this.log('debug', `region selection: window ${wcId} loaded`);
        if (win.isDestroyed()) return;
        win.setBounds(eb);
        win.show();
        win.focus();
      });
      win.webContents.once('did-fail-load', (e, code, desc) => {
        this.log('error', `region selection did not load: ${desc}`);
        this._finish(null);
      });
      win.loadURL('vmapp-loader://ui/region.html').catch((e) => {
        this.log('error', `region selection: ${e.message}`);
        this._finish(null);
      });
    });
  }
}

module.exports = { RegionSelect };
