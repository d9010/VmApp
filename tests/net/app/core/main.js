'use strict';
// Core of the network test app (tests/net/run.sh). It does what any Node app does: fetch(). Nothing here knows about the
// proxy; the guest's environment sends the request through it (SPEC 8.3). The test script calls the handlers.
const { app, BrowserWindow, ipcMain } = require('vmapp');

ipcMain.handle('net:fetch', async (_event, url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    const text = await r.text();
    return { status: r.status, bytes: text.length, name: (() => { try { return JSON.parse(text).name; } catch { return null; } })() };
  } catch (e) {
    return { error: String((e.cause && (e.cause.code || e.cause.message)) || e.message) };
  }
});

ipcMain.handle('net:env', () => ({
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE,
  node: process.version,
}));

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300, title: 'Net Test' });
  win.loadFile('index.html');
});
