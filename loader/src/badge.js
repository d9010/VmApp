'use strict';
// The control badge (SPEC 8.2, INV-H3): a small always-on-top window, owned by the loader, that is on screen for as long
// as an app controls the mouse and keyboard or runs a shell command, and always has a Stop button. Apps cannot draw it,
// move it, hide it or reach it: it shows only the text the loader computes from the broker's active() list. It is a
// loader page like the others (vmapp-loader://ui/badge.html: contextIsolation, sandbox, no Node, the loader CSP).
//
// The window exists only while something is active (created on the first entry, destroyed with the last), is not
// focusable (the app in front keeps the focus), floats above full-screen apps and shows on every Space.

const { BrowserWindow, ipcMain, screen } = require('electron');
const { badgeText } = require('./host-text');

const WIDTH = 540;
const ROW = 40;
const PAD = 6;

class Badge {
  /**
   * @param {object} o
   * @param {object} o.cfg resolveConfig() result (preloadLoader, isPackaged)
   * @param {Map} o.senders webContents id -> page kind
   * @param {() => object} o.caps the broker (stopControl / stopAll / active)
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.senders = o.senders;
    this.getCaps = o.caps;
    this.log = o.log || (() => {});
    this.win = null;
    this.loading = null;
    this.list = [];
    this.chain = Promise.resolve();
    this._ipc();
  }

  _ipc() {
    const guard = (event) => {
      if (this.senders.get(event.sender.id) !== 'badge' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
    };
    ipcMain.on('badge:ready', (event) => {
      try {
        guard(event);
        event.sender.send('badge:state', this.list);
      } catch {
        /* not the badge */
      }
    });
    ipcMain.handle('badge:stop', (event, appId) => {
      try {
        guard(event);
        // only an app that is on the badge right now can be stopped from it
        if (typeof appId !== 'string' || !this.list.some((e) => e.appId === appId)) return { ok: false, error: 'not active' };
        this.getCaps().stopControl(appId, 'user');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    ipcMain.handle('badge:stopAll', (event) => {
      try {
        guard(event);
        this.getCaps().stopAll('user');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }

  /** What the badge shows right now (the dev tests and the library read it). */
  entries() {
    return this.list.slice();
  }

  /** Shows (or updates, or removes) the badge for `active` (the broker's active() list). Resolves when it is on screen. */
  update(active) {
    const list = (active || []).map((e) => ({ kind: e.kind, appId: e.appId, appName: e.appName, text: badgeText(e) }));
    const done = this.chain.then(() => this._apply(list));
    this.chain = done.catch((e) => this.log('error', `badge: ${e.message}`)); // one failure must not block later updates
    return done;
  }

  async _apply(list) {
    this.list = list;
    if (!list.length) {
      this._close();
      return;
    }
    await this._ensure();
    if (!this.win || this.win.isDestroyed()) throw new Error('the badge window could not be created');
    this.win.webContents.send('badge:state', list);
    this._layout();
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver'); // again: showing a window can reset the level
  }

  _layout() {
    const h = list2height(this.list.length);
    const wa = screen.getPrimaryDisplay().workArea;
    const w = Math.min(WIDTH, wa.width);
    this.win.setContentSize(w, h);
    this.win.setPosition(Math.round(wa.x + (wa.width - w) / 2), wa.y + 4);
  }

  async _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.loading;
    const win = new BrowserWindow({
      width: WIDTH,
      height: list2height(1),
      useContentSize: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      focusable: false, // the app in front keeps the keyboard focus; the button still works
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      hasShadow: true,
      title: 'D9010 VmApp control badge',
      backgroundColor: '#b3261e',
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
    this.senders.set(wcId, 'badge');
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(false);
    win.on('closed', () => {
      this.senders.delete(wcId);
      if (this.win === win) this.win = null;
    });
    this.loading = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the badge did not load')), 8000);
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once('did-fail-load', (e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`the badge did not load: ${desc}`));
      });
    });
    win.loadURL('vmapp-loader://ui/badge.html').catch((e) => this.log('error', `badge: ${e.message}`));
    await this.loading;
  }

  _close() {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) {
      this.senders.delete(win.webContents.id);
      win.destroy();
    }
  }

  dispose() {
    this.list = [];
    this._close();
  }
}

function list2height(n) {
  return Math.max(1, n) * ROW + (n > 1 ? ROW : 0) + PAD;
}

module.exports = { Badge };
