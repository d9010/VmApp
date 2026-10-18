'use strict';
// The "Host Capabilities" settings window (SPEC 8.2): the macOS permissions panel, the user's tools and MCP servers
// (the catalog), and the Stop-everything button. Loader-owned (INV-B5, INV-H1): only this window and the CLI write the
// catalog; every handler checks that the sender is this window; nothing an app sends can reach it.

const { BrowserWindow, ipcMain } = require('electron');
const { validateTool, validateMcp, CatalogError } = require('../../hostlib/capabilities');

const SHORTCUT = '⌃⌥⌘.';

class Settings {
  /**
   * @param {object} o
   * @param {Catalog} o.catalog the WRITABLE catalog (the broker only holds a read-only view)
   * @param {Store} o.store
   * @param {object} o.caps the broker
   * @param {object} o.ctl the vmapp-hostctl client
   * @param {NativeDialogs} o.nativeDialogs
   * @param {object} o.cfg
   * @param {Map} o.senders
   * @param {LoaderPrefs} [o.prefs] the loader's own switches (src/prefs.js): "Show typed text in the overlay"
   * @param {(level,msg)=>void} o.log
   * @param {()=>void} o.onCatalogChanged called after the catalog or the grants changed (the library refreshes)
   */
  constructor(o) {
    this.prefs = o.prefs || null;
    this.catalog = o.catalog;
    this.store = o.store;
    this.caps = o.caps;
    this.ctl = o.ctl;
    this.dialogs = o.nativeDialogs;
    this.cfg = o.cfg;
    this.senders = o.senders;
    this.log = o.log || (() => {});
    this.onCatalogChanged = o.onCatalogChanged || (() => {});
    this.win = null;
    this._ipc();
    this.caps.on('active-changed', () => this.push());
  }

  /** Tells an open settings window that something changed. */
  push() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('set:changed');
  }

  show() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return this.win;
    }
    const win = new BrowserWindow({
      width: 900,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      title: 'Host Capabilities — D9010 VmApp Launcher',
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
    this.senders.set(wcId, 'settings');
    win.on('closed', () => {
      this.senders.delete(wcId);
      if (this.win === win) this.win = null;
    });
    win.loadURL('vmapp-loader://ui/settings.html').catch((e) => this.log('error', `settings: ${e.message}`));
    return win;
  }

  // ------------------------------------------------------------------------------------------------ data

  state() {
    const out = { platform: process.platform, shortcut: SHORTCUT, tools: [], mcp: [], errors: [], active: this.caps.active(), prefs: this.prefs ? this.prefs.all() : {} };
    try {
      out.tools = this.catalog.tools();
    } catch (e) {
      out.errors.push(e.message);
    }
    try {
      out.mcp = this.catalog.mcpServers();
    } catch (e) {
      out.errors.push(e.message);
    }
    return out;
  }

  async status() {
    try {
      const s = await this.ctl.request('status', {}, { timeoutMs: 8000 });
      return { ok: true, screenRecording: !!s.screenRecording, accessibility: !!s.accessibility, macos: s.macos || '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** The user clicked "Ask macOS…": the system prompt for one permission (never called by anything else). */
  async askMacos(which) {
    const args = which === 'screen' ? { screenRecording: true } : which === 'accessibility' ? { accessibility: true } : null;
    if (!args) throw new Error('unknown permission');
    try {
      const s = await this.ctl.request('request-permissions', args, { timeoutMs: 30000 });
      return { ok: true, screenRecording: !!s.screenRecording, accessibility: !!s.accessibility, macos: s.macos || '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** After a tool or server is removed: no grant keeps naming it (the broker would refuse it anyway). */
  _pruneGrants(kind, id) {
    const key = kind === 'tool' ? 'tools' : 'servers';
    for (const a of this.store.list()) {
      if (a.error) continue;
      try {
        const host = Object.assign({}, this.store.loadHostGrants(a.id));
        let changed = false;
        if (host[`${kind}:${id}`]) {
          delete host[`${kind}:${id}`];
          changed = true;
        }
        const w = host[`${kind}:*`];
        if (w && Array.isArray(w[key]) && w[key].includes(id)) {
          host[`${kind}:*`] = Object.assign({}, w, { [key]: w[key].filter((x) => x !== id) });
          changed = true;
        }
        if (changed) this.store.saveHostGrants(a.id, host);
      } catch (e) {
        this.log('warn', `pruning grants of ${a.id}: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ IPC

  _ipc() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (event, ...args) => {
        try {
          if (this.senders.get(event.sender.id) !== 'settings' || event.senderFrame !== event.sender.mainFrame) throw new Error('denied');
          const parent = BrowserWindow.fromWebContents(event.sender);
          return { ok: true, result: await fn(parent, ...args) };
        } catch (e) {
          this.log('warn', `${channel}: ${e.message}`);
          return { ok: false, error: e.message };
        }
      });

    handle('set:state', () => this.state());
    // the loader's own switches (src/prefs.js); only known names with a value of the right type are accepted
    handle('set:setPref', (parent, name, value) => {
      if (!this.prefs) throw new Error('preferences are not available');
      return this.prefs.set(String(name), value);
    });
    handle('set:status', () => this.status());
    handle('set:askMacos', (parent, which) => this.askMacos(which));
    handle('set:openSystemSettings', async (parent, pane) => {
      await this.dialogs.openSystemSettings(pane === 'accessibility' ? 'accessibility' : 'screen');
      return {};
    });

    handle('set:saveTool', (parent, def) => {
      const v = validateTool(def, { checkFs: true }); // the program must exist and be executable
      const saved = this.catalog.addTool(v);
      this.onCatalogChanged();
      return saved;
    });
    handle('set:removeTool', (parent, id) => {
      if (typeof id !== 'string') throw new Error('bad tool id');
      this.catalog.removeTool(id);
      this._pruneGrants('tool', id);
      this.onCatalogChanged();
      return {};
    });
    handle('set:saveMcp', (parent, def) => {
      const v = validateMcp(def, { checkFs: true });
      const saved = this.catalog.addMcp(v);
      this.onCatalogChanged();
      return saved;
    });
    handle('set:removeMcp', (parent, id) => {
      if (typeof id !== 'string') throw new Error('bad server id');
      this.catalog.removeMcp(id);
      this._pruneGrants('mcp', id);
      this.onCatalogChanged();
      return {};
    });

    handle('set:pickFile', async (parent) => {
      const r = await this.dialogs.open(parent, { title: 'Choose the program', buttonLabel: 'Choose', properties: ['openFile', 'showHiddenFiles'] }, 'catalog-program');
      return r ? { path: r[0] } : { canceled: true };
    });

    // Stop everything now: every input session, every tool, every MCP server (same as the panic shortcut)
    handle('set:stopAll', () => {
      this.caps.stopAll('user');
      return {};
    });
    handle('set:stopControl', (parent, appId) => {
      if (typeof appId !== 'string') throw new Error('bad app id');
      this.caps.stopControl(appId, 'user');
      return {};
    });
  }
}

module.exports = { Settings, SHORTCUT, CatalogError };
