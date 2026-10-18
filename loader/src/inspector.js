'use strict';
// The bridge inspector: a loader-owned, read-only window showing the live bridge traffic of a running app (WHY.md).

const fs = require('fs');
const { BrowserWindow, ipcMain } = require('electron');

const FLUSH_MS = 80;

class Inspector {
  /**
   * @param {object} o
   * @param {Runner} o.runner
   * @param {Store} o.store
   * @param {object} o.cfg
   * @param {(wc)=>void} o.markLoaderWindow registers a webContents as a loader window (navigation lock etc.)
   * @param {Map} o.senders webContents id -> 'library' | 'inspector'
   * @param {(level,msg)=>void} o.log
   */
  constructor(o) {
    this.runner = o.runner;
    this.store = o.store;
    this.cfg = o.cfg;
    this.senders = o.senders;
    this.log = o.log || (() => {});
    this.win = null;
    this.pending = [];
    this.timer = null;
    this._ipc();
    this.runner.on('inspect', (appId, kind, item) => this._queue({ appId, kind, item }));
    this.runner.on('changed', () => this._send('insp:apps', this._apps()));
  }

  _apps() {
    const out = [];
    for (const id of this.runner.knownIds()) {
      const a = this._name(id);
      out.push({ id, name: a, state: this.runner.state(id) });
    }
    return out;
  }

  _name(id) {
    try {
      const a = this.store.get(id);
      return a ? a.manifest.name : id;
    } catch {
      return id;
    }
  }

  _send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  _queue(ev) {
    if (!this.win || this.win.isDestroyed()) return;
    this.pending.push(ev);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const batch = this.pending.splice(0);
        if (batch.length) this._send('insp:events', batch);
      }, FLUSH_MS);
    }
  }

  _ipc() {
    const guard = (event) => {
      if (this.senders.get(event.sender.id) !== 'inspector') throw new Error('denied');
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
    };
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          guard(event);
          return { ok: true, result: await fn(...args) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      });
    handle('insp:apps', () => this._apps());
    handle('insp:snapshot', (appId) => {
      if (typeof appId !== 'string') throw new Error('bad app id');
      const b = this.runner.buffers(appId) || { traffic: [], log: [], exported: [] };
      return { traffic: b.traffic, log: b.log, exported: b.exported, state: this.runner.state(appId) };
    });
    handle('insp:clear', (appId) => {
      if (typeof appId !== 'string') throw new Error('bad app id');
      this.runner.clearBuffers(appId);
    });
    handle('insp:console', (appId) => {
      if (typeof appId !== 'string') throw new Error('bad app id');
      return this._consoleTail(appId);
    });
  }

  /** Last lines of $VMAPP_HOME/logs/<id>.console.log (the core's stdout/stderr and the guest's messages). */
  _consoleTail(appId, maxBytes = 65536, maxLines = 400) {
    let file;
    try {
      file = this.store.consoleLogPath(appId);
    } catch {
      return [];
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let lines = buf.toString('utf8').split('\n');
      if (size > len) lines = lines.slice(1);
      return lines.filter((l) => l !== '').slice(-maxLines);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /** Opens (or focuses) the window; `appId` selects the app, `tab` is 'traffic' | 'log' | 'files'. */
  show(appId, tab) {
    const first = !this.win || this.win.isDestroyed();
    if (first) {
      this.win = new BrowserWindow({
        width: 1100,
        height: 700,
        minWidth: 760,
        minHeight: 420,
        title: 'Bridge Inspector — D9010 VmApp Launcher',
        backgroundColor: '#1e1f22',
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
      const wcId = this.win.webContents.id;
      this.senders.set(wcId, 'inspector');
      this.win.on('closed', () => {
        this.senders.delete(wcId);
        this.win = null;
        this.pending = [];
      });
      const q = new URLSearchParams();
      if (appId) q.set('app', appId);
      if (tab) q.set('tab', tab);
      this.win.loadURL(`vmapp-loader://ui/inspector.html${q.toString() ? '?' + q : ''}`).catch((e) => this.log('error', `inspector: ${e.message}`));
    } else {
      this._send('insp:select', { appId, tab });
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
    }
    return this.win;
  }
}

module.exports = { Inspector };
