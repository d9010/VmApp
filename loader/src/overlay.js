'use strict';
// The virtual-input overlay (SPEC 8.2, INV-H3: control is always visible). While an app controls the mouse and keyboard,
// the loader draws, on every display, where the app's virtual pointer is and what it types:
//   - a coloured ring at the virtual pointer, which moves with each host.input.mouse,
//   - a ripple on a press or a click,
//   - a fading caption of the keys and text typed ("⌘S", "Hello, wor…"), near the bottom of the screen.
//
// One window per display, owned by the loader, created when the first input session starts and destroyed when the last one
// ends (stop, expiry, panic, the app stopping). Each window is
//   - transparent, frameless, without a shadow, not focusable: it never takes the focus;
//   - setIgnoreMouseEvents(true): CLICK-THROUGH, it can never intercept a real click (the badge's Stop button, the app
//     underneath, anything). This is a security property, kept by a test;
//   - always on top at the 'screen-saver' level, on every Space, above full-screen apps;
//   - setContentProtection(true): excluded from window captures where macOS honours it. Screenshots taken for an app
//     additionally exclude every window of this process in the helper (vmapp-hostctl `excludePids`), which is what works
//     with ScreenCaptureKit; the badge and the pickers are excluded the same way.
// The drawing is plain CSS (GPU-composited by the window server): vmapp-loader://ui/overlay.html, a loader page with the
// loader CSP. It receives only positions and a caption the loader computed; nothing an app sends is rendered as markup.
//
// TYPED TEXT IS MASKED BY DEFAULT: the caption of what an app typed reads "typing… (12 characters)", so a password typed by an
// app is never readable on the screen. Key combinations (⌘S) and named keys (Return, arrows) are always shown. The loader
// setting "Show typed text in the overlay" (Host Capabilities window, `overlayShowTyped`, off by default) shows the first 28
// characters instead. The setting is read at every keystroke, so turning it off applies at once.
//
// Test probe (dev builds only, ignored when packaged): VMAPP_TEST_OVERLAY_LOG=<file> appends one JSON line per overlay
// window created ({event:'window', display, bounds, ignoreMouseEvents, focusable, alwaysOnTop, contentProtected, ...}),
// per window destroyed, and per activity ({event:'activity', ...}). The window properties are read from the real windows
// where Electron can say (focusable, always on top, content protection) and tracked at the call where it cannot
// (setIgnoreMouseEvents has no getter).

const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { keyCaption, mouseCaption, typedLength, typedCaption } = require('./host-text');

const LOAD_TIMEOUT_MS = 4000;
const TYPED_WINDOW_MS = 2200; // typed characters that follow each other within this time are counted together ("typing… (12 characters)")

class Overlay {
  /**
   * @param {object} o
   * @param {object} o.cfg resolveConfig() result
   * @param {Map} o.senders webContents id -> page kind
   * @param {{get:(name:string)=>any}} [o.prefs] the loader's preferences (src/prefs.js); without it typed text is masked
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.senders = o.senders;
    this.prefs = o.prefs || null;
    this.typed = null; // {n, at}: characters typed in the last moments, for the masked caption
    this.log = o.log || (() => {});
    this.probeLog = !o.cfg.isPackaged && process.env.VMAPP_TEST_OVERLAY_LOG ? path.resolve(process.env.VMAPP_TEST_OVERLAY_LOG) : null;
    this.on = false; // an input session is active
    this.wins = new Map(); // webContents id -> { win, display, bounds, ignoreMouseEvents }
    this.model = { pos: null, down: false, caption: '' };
    this.chain = Promise.resolve();
    this._displayEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
    this._onDisplays = () => {
      if (this.on) this.update(true);
    };
    this._ipc();
  }

  _ipc() {
    ipcMain.on('overlay:ready', (event) => {
      try {
        if (this.senders.get(event.sender.id) !== 'overlay' || event.senderFrame !== event.sender.mainFrame) return;
        const w = this.wins.get(event.sender.id);
        if (w) this._replay(w);
      } catch {
        /* not an overlay window */
      }
    });
  }

  _probe(obj) {
    if (!this.probeLog) return;
    try {
      fs.appendFileSync(this.probeLog, JSON.stringify(Object.assign({ ts: Date.now() }, obj)) + '\n');
    } catch {
      /* the probe is best effort */
    }
  }

  /** The overlay windows right now, for the dev tests and the library: [{display, bounds, ...window properties}]. */
  windows() {
    return [...this.wins.values()].map((w) => this._props(w));
  }

  _props(w) {
    const win = w.win;
    const gone = win.isDestroyed();
    return {
      display: w.display,
      bounds: w.bounds,
      ignoreMouseEvents: w.ignoreMouseEvents,
      focusable: gone ? null : win.isFocusable(),
      alwaysOnTop: gone ? null : win.isAlwaysOnTop(),
      contentProtected: gone ? null : win.isContentProtected(),
    };
  }

  /** Shows the overlay on every display (`on`) or removes it. Resolves when it is on screen (or after a few seconds). */
  update(on) {
    const done = this.chain.then(() => this._apply(!!on));
    this.chain = done.catch((e) => this.log('warn', `overlay: ${e.message}`)); // one failure must not block later updates
    return done;
  }

  async _apply(on) {
    if (!on) {
      if (this.on) {
        this.on = false;
        for (const ev of this._displayEvents) screen.removeListener(ev, this._onDisplays);
      }
      this._closeAll();
      this.model = { pos: null, down: false, caption: '' };
      this.typed = null;
      return;
    }
    if (!this.on) {
      this.on = true;
      for (const ev of this._displayEvents) screen.on(ev, this._onDisplays);
    }
    // one window per display; windows of displays that went away are removed, new displays get one
    const displays = screen.getAllDisplays();
    const have = new Map([...this.wins.values()].map((w) => [w.display, w]));
    for (const w of have.values()) {
      if (!displays.some((d) => d.id === w.display)) this._close(w);
    }
    const loading = [];
    for (const d of displays) {
      const cur = have.get(d.id);
      if (cur && !cur.win.isDestroyed()) {
        const b = d.bounds;
        if (cur.bounds.x !== b.x || cur.bounds.y !== b.y || cur.bounds.width !== b.width || cur.bounds.height !== b.height) {
          cur.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
          cur.win.setBounds(b);
        }
        continue;
      }
      loading.push(this._create(d));
    }
    await Promise.all(loading);
  }

  _create(display) {
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      focusable: false, // never takes the keyboard focus from the app in front
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      show: false,
      alwaysOnTop: true,
      title: 'D9010 VmApp input overlay',
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
    const w = { win, wcId, display: display.id, bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, ignoreMouseEvents: null };
    // setIgnoreMouseEvents has no getter: remember what it was last called with, so a test can see the real state
    const setIgnore = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = (ignore, options) => {
      w.ignoreMouseEvents = !!ignore;
      return setIgnore(ignore, options);
    };
    this.senders.set(wcId, 'overlay');
    this.wins.set(wcId, w);
    win.setIgnoreMouseEvents(true); // CLICK-THROUGH: it must never intercept a real click
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setContentProtection(true);
    win.setBounds(b);
    win.on('closed', () => {
      this.senders.delete(wcId);
      this.wins.delete(wcId);
    });
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
      const fin = () => {
        clearTimeout(timer);
        resolve();
      };
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) {
          win.setIgnoreMouseEvents(true); // again: showing a window can reset it
          win.setAlwaysOnTop(true, 'screen-saver');
          win.showInactive();
          this._probe(Object.assign({ event: 'window' }, this._props(w)));
        }
        fin();
      });
      win.webContents.once('did-fail-load', (e, code, desc) => {
        this.log('warn', `overlay did not load: ${desc}`);
        fin();
      });
      win.loadURL('vmapp-loader://ui/overlay.html').catch((e) => {
        this.log('warn', `overlay: ${e.message}`);
        fin();
      });
    });
  }

  _close(w) {
    this.wins.delete(w.wcId);
    this.senders.delete(w.wcId);
    if (!w.win.isDestroyed()) {
      this._probe({ event: 'destroyed', display: w.display });
      w.win.destroy();
    }
  }

  _closeAll() {
    for (const w of [...this.wins.values()]) this._close(w);
    this.wins.clear();
  }

  // ------------------------------------------------------------------------------------------------ drawing

  /** Global points -> this window's own points. */
  _local(w, p) {
    const x = p.x - w.bounds.x;
    const y = p.y - w.bounds.y;
    return { x, y, inside: x >= 0 && y >= 0 && x < w.bounds.width && y < w.bounds.height };
  }

  _send(w, payload) {
    try {
      if (!w.win.isDestroyed()) w.win.webContents.send('overlay:event', payload);
    } catch {
      /* the window is going away */
    }
  }

  /** The window that shows the caption: the one under the virtual pointer, else the primary display's. */
  _captionWindow() {
    const all = [...this.wins.values()];
    if (this.model.pos) {
      const hit = all.find((w) => this._local(w, this.model.pos).inside);
      if (hit) return hit;
    }
    const primary = screen.getPrimaryDisplay().id;
    return all.find((w) => w.display === primary) || all[0] || null;
  }

  _sendRing(w, ripples) {
    const p = this.model.pos;
    if (!p) return;
    const l = this._local(w, p);
    this._send(w, { t: 'ring', x: l.x, y: l.y, inside: l.inside, down: this.model.down, ripples: l.inside ? ripples : 0 });
  }

  _sendCaption(text) {
    const target = this._captionWindow();
    for (const w of this.wins.values()) this._send(w, { t: 'caption', text: w === target ? text : '' });
  }

  /** A page that just loaded gets the current picture. */
  _replay(w) {
    this._sendRing(w, 0);
    const t = this._captionWindow();
    this._send(w, { t: 'caption', text: w === t ? this.model.caption : '' });
  }

  /** Does the user want to see typed text in the overlay? Off unless they turned it on (read at every keystroke). */
  _showTyped() {
    try {
      return !!this.prefs && this.prefs.get('overlayShowTyped') === true;
    } catch {
      return false; // when in doubt, mask
    }
  }

  /** The caption of a keys event: masked typed text ("typing… (N characters)", counted over a short window) or the key itself. */
  _keysCaption(ev) {
    const showTyped = this._showTyped();
    const n = showTyped ? 0 : typedLength(ev);
    if (n > 0) {
      const now = Date.now();
      this.typed = this.typed && now - this.typed.at < TYPED_WINDOW_MS ? { n: this.typed.n + n, at: now } : { n, at: now };
      return typedCaption(this.typed.n);
    }
    this.typed = null;
    return keyCaption(ev, { showTyped });
  }

  /**
   * What the app just did with its input session (hostlib/capabilities.js ui.inputActivity):
   * {kind:'mouse', action, x?, y?, button, clicks, dx?, dy?} or {kind:'keys', text} | {kind:'keys', key, modifiers}.
   */
  activity(ev) {
    if (!this.on || !ev) return;
    if (ev.kind === 'mouse') {
      if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) this.model.pos = { x: ev.x, y: ev.y };
      if (ev.action === 'down') this.model.down = true;
      else if (ev.action === 'up' || ev.action === 'click') this.model.down = false;
      const ripples = ev.action === 'click' ? Math.max(1, Math.min(3, Number(ev.clicks) || 1)) : ev.action === 'down' ? 1 : 0;
      for (const w of this.wins.values()) this._sendRing(w, ripples);
      const cap = mouseCaption(ev);
      if (cap) {
        this.model.caption = cap;
        this._sendCaption(cap);
      }
      this._probe({ event: 'activity', kind: 'mouse', action: ev.action, global: this.model.pos, down: this.model.down, windows: [...this.wins.values()].map((w) => Object.assign({ display: w.display }, this.model.pos ? this._local(w, this.model.pos) : {})) });
    } else if (ev.kind === 'keys') {
      const text = this._keysCaption(ev);
      if (!text) return;
      this.model.caption = text;
      this._sendCaption(text);
      this._probe({ event: 'activity', kind: 'keys', caption: text });
    }
  }

  dispose() {
    this.on = false;
    for (const ev of this._displayEvents) screen.removeListener(ev, this._onDisplays);
    this._closeAll();
  }
}

module.exports = { Overlay };
