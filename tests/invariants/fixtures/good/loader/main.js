'use strict';
// Fixture loader main process: navigation guards, sender-routed IPC, one loader-owned window.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { resolveConfig } = require('./src/config');

const cfg = resolveConfig(app.isPackaged);
const senders = new Map();
const registry = new Map();

app.on('web-contents-created', (event, contents) => {
  const allowed = (url) => {
    const rec = registry.get(contents.id);
    if (rec) return url.startsWith(`vmapp-ui://${rec.appId}/`);
    return senders.has(contents.id) && url.startsWith('vmapp-loader://ui/');
  };
  const block = (e, url) => {
    if (!allowed(url)) e.preventDefault();
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // DevTools only for an app window its core created with devTools: true; packaged: closed everywhere else
  if (app.isPackaged) contents.on('devtools-opened', () => (registry.has(contents.id) && registry.get(contents.id).devTools === true ? undefined : contents.closeDevTools()));
});

function appRecord(event) {
  return registry.get(event.sender.id) || null;
}

ipcMain.on('vmapp:hello', (event) => {
  const rec = registry.get(event.sender.id);
  event.returnValue = rec ? { id: rec.appId } : null;
});

ipcMain.handle('vmapp:invoke', async (event, channel, args) => {
  const rec = appRecord(event);
  if (!rec) return { ok: false, error: 'denied' };
  return { ok: true, result: [channel, args] };
});

function createLibraryWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: cfg.preloadLoader,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      devTools: !cfg.isPackaged,
    },
  });
  senders.set(win.webContents.id, 'library');
  win.loadURL('vmapp-loader://ui/library.html');
  return win;
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  createLibraryWindow();
});
