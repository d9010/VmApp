'use strict';
// Core of the host-capabilities fixture (loader test run E): runs inside the VM with the vmapp Node SDK. Every handler
// answers {ok:true, value} or {ok:false, error} so the test can read refusals as data.
const { app, BrowserWindow, ipcMain, host } = require('vmapp');

const attempt = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

let session = null; // the app's current input session

ipcMain.handle('screen-windows', () => attempt(() => host.screen.windows()));
ipcMain.handle('screen-capture', (e, opts) =>
  attempt(async () => {
    const r = await host.screen.capture(opts || {});
    // `target` is what was ACTUALLY captured (the user picks; the app's options are only a suggestion)
    return { isBuffer: Buffer.isBuffer(r.png), magic: r.png.subarray(1, 4).toString(), bytes: r.png.length, width: r.width, height: r.height, target: r.target };
  }),
);

ipcMain.handle('input-start', (e, reason) =>
  attempt(async () => {
    session = await host.input.start(reason);
    return { id: session.id };
  }),
);
ipcMain.handle('input-mouse', (e, p) => attempt(async () => (await session.mouse(p), true)));
ipcMain.handle('input-keys', (e, p) => attempt(async () => (await session.keys(p), true)));
ipcMain.handle('input-stop', () => attempt(async () => (await session.stop(), true)));

ipcMain.handle('tool-list', () => attempt(() => host.tool.list()));
ipcMain.handle('tool-run', (e, id, args) => attempt(() => host.tool.run(id, args)));

ipcMain.handle('mcp-list', () => attempt(() => host.mcp.list()));
ipcMain.handle('mcp-call', (e, server, method, params) => attempt(() => host.mcp.call(server, method, params)));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 420, title: 'Host Caps Test' });
  await win.loadFile('index.html');
});
