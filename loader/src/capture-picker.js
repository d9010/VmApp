'use strict';
// The screenshot picker (SPEC 8.2, INV-B5, INV-H2): when an app asks for a screenshot and its grant says `ask`, the USER
// chooses what it gets. The app's parameters are only a suggestion, and the app receives nothing but what was picked.
//
// A loader-owned modal window, parented to the app's window (vmapp-loader://ui/picker.html: contextIsolation, sandbox, no
// Node, the loader CSP), offers
//   - each display: its name, its size and a small live thumbnail the LOADER captures through vmapp-hostctl (the
//     thumbnails go to this page only, never to the app);
//   - each window: the app and the title (titles need Screen Recording; the loader's own windows are not offered);
//   - "Select a region…" per display: region-select.js, a full-screen dimmed selection window shown only during the drag;
// and the buttons Deny (the default), Allow once, Allow while the app runs. The page can only answer with a choice among the
// ones this module sent it, and the main process checks the choice again before it becomes the capture target.
//
// "Allow while the app runs" remembers the PERMISSION only, never the target (hostlib/capabilities.js): later captures use
// what the app suggests, or the main display when that no longer exists.

const { BrowserWindow, ipcMain } = require('electron');
const { RegionSelect } = require('./region-select');
const { captureWhat, CAPTURE_SESSION_NOTE } = require('./host-text');
const { clipRect, displaysForPage, windowsForPage, preselect, targetFromChoice } = require('./capture-logic');

const THUMB_WIDTH = 360;
const LIST_TIMEOUT_MS = 4000;
const THUMB_TIMEOUT_MS = 8000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class CapturePicker {
  /**
   * @param {object} o
   * @param {object} o.cfg resolveConfig() result
   * @param {Map} o.senders webContents id -> page kind
   * @param {object} o.ctl the vmapp-hostctl client
   * @param {NativeDialogs} o.dialogs (test hook for the region step, and the log of the real picks)
   * @param {(appId)=>BrowserWindow|null} o.parentOf the app's window the picker is a sheet of
   * @param {()=>number[]} o.excludePids processes whose windows are never offered nor captured (the loader's own)
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.senders = o.senders;
    this.ctl = o.ctl;
    this.dialogs = o.dialogs;
    this.parentOf = o.parentOf;
    this.excludePids = o.excludePids || (() => [process.pid]);
    this.log = o.log || (() => {});
    this.sessions = new Map(); // webContents id -> session
    this.region = new RegionSelect({ cfg: o.cfg, senders: o.senders, dialogs: o.dialogs, log: this.log });
    this._ipc();
  }

  _ipc() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          // the sender decides the session, never an id the page sends; only the main frame of a picker window
          const s = this.sessions.get(event.sender.id);
          if (!s || this.senders.get(event.sender.id) !== 'picker' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
          return { ok: true, result: await fn(s, ...args) };
        } catch (e) {
          this.log('warn', `${channel}: ${e.message}`);
          return { ok: false, error: e.message };
        }
      });
    handle('picker:ready', (s) => this._ready(s));
    handle('picker:region', (s, display) => this._selectRegion(s, display));
    handle('picker:answer', (s, allow, choice) => this._answer(s, allow, choice));
  }

  /** The open pickers (the dev tests and the library read it). */
  count() {
    return this.sessions.size;
  }

  /** Panic, or the loader quitting: every open question is answered "no". */
  cancelAll() {
    this.region.cancel();
    for (const s of [...this.sessions.values()]) this._settle(s, false);
  }

  async _list(op, args) {
    try {
      const r = await this.ctl.request(op, args || {}, { timeoutMs: LIST_TIMEOUT_MS });
      return Array.isArray(r) ? r : [];
    } catch (e) {
      this.log('warn', `picker: ${op}: ${e.message}`);
      return [];
    }
  }

  /**
   * Asks the user. `req` is what the broker passes to ui.chooseCapture ({app, purpose, suggestion, ...}); `text` is
   * host-text.confirmText(req). Resolves with false (denied, or the window was closed) or {allow: true | 'session', target}.
   */
  async choose(req, text) {
    const displays = displaysForPage(await this._list('displays'));
    const windows = windowsForPage(await this._list('windows'), this.excludePids());
    const parent = this.parentOf(req.app.id);
    const appName = String((req.app && req.app.name) || req.app.id || 'This app').slice(0, 60);
    if (parent && !parent.isDestroyed()) {
      // the question must be seen: bring the app's window forward, the picker opens on it
      if (parent.isMinimized()) parent.restore();
      parent.show();
      parent.focus();
    }
    const usable = parent && !parent.isDestroyed();
    const win = new BrowserWindow({
      width: 720,
      height: 640,
      minWidth: 560,
      minHeight: 480,
      parent: usable ? parent : undefined,
      modal: !!usable,
      show: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: `Choose what “${appName}” can see`,
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
    const wcId = win.webContents.id;
    this.senders.set(wcId, 'picker');
    this.dialogs.noteCaptureWindow(win);
    return new Promise((resolve) => {
      const pre = preselect(req.suggestion, displays, windows);
      const s = {
        win,
        wcId,
        req,
        text,
        appName,
        displays,
        windows,
        region: null, // {x,y,w,h,display}: set by "Select a region…" (or by a suggested region)
        selected: pre.selected,
        suggested: pre.suggested,
        thumbsStarted: false,
        settled: false,
        resolve,
      };
      this.sessions.set(wcId, s);
      const sug = isObj(req.suggestion) ? req.suggestion : {};
      if (sug.target === 'region' && isObj(sug.region)) {
        // a suggested region is preselected too, when it is on a display (the user still has to press Allow)
        const hit = displays.map((d) => [d, clipRect(sug.region, d.bounds)]).find(([, r]) => r);
        if (hit) {
          s.region = Object.assign({}, hit[1], { display: hit[0].display, suggested: true });
          s.selected = { kind: 'region' };
          s.suggested = true;
        }
      }
      win.on('closed', () => this._settle(s, false)); // closing the window (or the app's window) is "Deny"
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) win.show();
      });
      win.loadURL('vmapp-loader://ui/picker.html').catch((e) => {
        this.log('error', `picker: ${e.message}`);
        this._settle(s, false);
      });
    });
  }

  _settle(s, answer) {
    if (s.settled) return;
    s.settled = true;
    this.sessions.delete(s.wcId);
    this.senders.delete(s.wcId);
    s.resolve(answer);
    if (!s.win.isDestroyed()) s.win.destroy();
  }

  /** What the page needs to draw itself. Thumbnails follow one by one (picker:thumb). */
  _ready(s) {
    if (!s.thumbsStarted) {
      s.thumbsStarted = true;
      this._thumbs(s).catch((e) => this.log('warn', `picker thumbnails: ${e.message}`));
    }
    return {
      app: { name: s.appName },
      message: s.text.message,
      purpose: s.req.purpose || '',
      suggestion: captureWhat(s.req.suggestion, { windows: s.windows, displays: s.displays }),
      sessionNote: CAPTURE_SESSION_NOTE,
      displays: s.displays,
      windows: s.windows,
      titlesHidden: s.windows.length > 0 && s.windows.every((w) => !w.title),
      selected: s.selected,
      suggested: s.suggested,
      region: s.region,
    };
  }

  async _thumb(s, args) {
    const r = await this.ctl.request('capture', Object.assign({ maxWidth: THUMB_WIDTH, excludePids: this.excludePids() }, args), { timeoutMs: THUMB_TIMEOUT_MS });
    if (!r || typeof r.png !== 'string') throw new Error('no image');
    return `data:image/png;base64,${r.png}`;
  }

  _send(s, channel, payload) {
    if (!s.settled && !s.win.isDestroyed()) s.win.webContents.send(channel, payload);
  }

  async _thumbs(s) {
    for (const d of s.displays) {
      if (s.settled) return;
      try {
        this._send(s, 'picker:thumb', { display: d.display, src: await this._thumb(s, { target: 'display', display: d.display }) });
      } catch (e) {
        this._send(s, 'picker:thumb', { display: d.display, error: e.code === 'permission' ? 'permission' : 'failed' });
      }
    }
    if (s.region && s.region.suggested) await this._regionThumb(s);
  }

  async _regionThumb(s) {
    if (!s.region) return;
    const r = s.region;
    try {
      this._send(s, 'picker:thumb', { region: true, src: await this._thumb(s, { target: 'region', region: { x: r.x, y: r.y, w: r.w, h: r.h } }) });
    } catch (e) {
      this._send(s, 'picker:thumb', { region: true, error: e.code === 'permission' ? 'permission' : 'failed' });
    }
  }

  /** "Select a region…" on one of the offered displays. Returns {region} or {canceled:true}. */
  async _selectRegion(s, displayId) {
    const d = s.displays.find((x) => x.display === displayId);
    if (!d) throw new Error('unknown display');
    const rect = await this.region.select(d);
    if (s.settled) return { canceled: true };
    if (!rect) return { canceled: true };
    s.region = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, display: d.display };
    s.selected = { kind: 'region' };
    s.suggested = false;
    this._regionThumb(s).catch(() => {});
    if (!s.win.isDestroyed()) {
      s.win.show();
      s.win.focus();
    }
    return { region: s.region };
  }

  /** The user pressed a button. `choice` must be one the page was offered; anything else is refused. */
  _answer(s, allow, choice) {
    if (allow !== 'once' && allow !== 'session') {
      this.dialogs.noteCapturePick(s.req, 'deny', null);
      this._settle(s, false);
      return {};
    }
    const target = targetFromChoice(choice, { displays: s.displays, windows: s.windows, region: s.region });
    if (!target) throw new Error('choose a display, a window or a region first');
    this.dialogs.noteCapturePick(s.req, allow, target);
    this._settle(s, { allow: allow === 'session' ? 'session' : true, target });
    return {};
  }

  dispose() {
    this.cancelAll();
  }
}

module.exports = { CapturePicker };
