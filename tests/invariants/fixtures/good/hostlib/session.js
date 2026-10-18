'use strict';
// Fixture AppSession: spawns vmapp-vm and answers the core's request ops.
const cp = require('child_process');
const { BridgeClient } = require('./bridge');

function defaultOpenExternal(url) {
  cp.spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

class AppSession {
  constructor(o) {
    this.manifest = o.manifest;
    this.dialogs = o.dialogs;
    this.wm = o.wm;
    this.windows = new Set();
  }

  start(vmPath, args) {
    const child = cp.spawn(vmPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.bridge = new BridgeClient({ onRequest: (op, params) => this._request(op, params) });
    return child;
  }

  _requireDialogs() {
    if (!this.manifest.permissions.dialogs) throw new Error('permission denied: dialogs');
    if (!this.dialogs) throw new Error('no dialog provider available');
  }

  async _dialogOpen(p) {
    this._requireDialogs();
    return this.dialogs.open({ directory: !!p.directory });
  }

  async _dialogSave(p) {
    this._requireDialogs();
    return this.dialogs.save({ defaultName: String(p.defaultName) });
  }

  async _request(op, params) {
    const p = params && typeof params === 'object' ? params : {};
    switch (op) {
      case 'window.create': {
        const win = await this.wm.create({ entry: String(p.entry), width: 800, height: 600 });
        this.windows.add(win);
        return { win };
      }
      case 'window.close':
        await this.wm.close(p.win);
        return {};
      case 'dialog.open':
        return this._dialogOpen(p);
      case 'dialog.save':
        return this._dialogSave(p);
      case 'dialog.message': {
        if (!this.dialogs) throw new Error('no dialog provider available');
        const idx = await this.dialogs.message({ message: String(p.message) });
        return { response: idx };
      }
      case 'shell.openExternal': {
        if (!this.manifest.permissions.external) throw new Error('permission denied: external');
        const u = new URL(String(p.url));
        if (u.protocol !== 'https:') throw new Error('shell.openExternal: only https: URLs are allowed');
        if (!(await this.dialogs.confirmExternal(u.href))) return { opened: false };
        defaultOpenExternal(u.href);
        return { opened: true };
      }
      case 'app.quit':
        setImmediate(() => this.stop());
        return {};
      case 'host.screen.windows':
      case 'host.tool.run':
      case 'host.input.stop':
        return this._host(op, p);
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  _host(op, p) {
    if (!(this.manifest.permissions.host || []).length) throw new Error('permission denied: host');
    return this.capabilities.requestOp(op, p, {});
  }

  stop() {}
}

module.exports = { AppSession };
