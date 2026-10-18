'use strict';
// Fixture window manager: one BrowserWindow per window.create, in the app's own partition, with the loader's preload.
const { BrowserWindow, session: electronSession } = require('electron');

const allowedSchemes = /^(vmapp-ui|data|blob):/i;

function lockPartition(partition, handleAppUi) {
  const ses = electronSession.fromPartition(partition);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedSchemes.test(details.url) }));
  ses.protocol.handle('vmapp-ui', handleAppUi);
  return ses;
}

function partitionOf(appId) {
  return `persist:vmapp-${appId}`;
}

class AppWindowManager {
  constructor(o) {
    this.app = o.app;
    this.registry = o.registry;
    this.preload = o.preload;
    this.nextId = 1;
  }

  async create(params) {
    const win = this.nextId++;
    const bw = new BrowserWindow({
      width: params.width,
      height: params.height,
      show: false,
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
        devTools: params.devTools === true,
      },
    });
    bw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.registry.set(bw.webContents.id, { appId: this.app.id, win, devTools: params.devTools === true });
    bw.loadURL(`vmapp-ui://${this.app.id}/${params.entry}`);
    return win;
  }
}

module.exports = { AppWindowManager, lockPartition, partitionOf };
