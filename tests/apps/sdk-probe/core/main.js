'use strict';
// SDK Probe (tests/apps/sdk-probe.mjs): each handler calls one part of the Node SDK (`require('vmapp')`, from the runtime image)
// and returns what it got, so the headless test can check the platform end to end in a real VM.
const http = require('http');
const { app, BrowserWindow, ipcMain, clipboard, ports } = require('vmapp');

// port forwarding (SPEC 6, 8.8): a server in the VM, opened on the Mac's localhost; needs the device "ports" and the user's allow
const PORT = 8765;
let server = null;
ipcMain.handle('ports:serve', () =>
  new Promise((resolve, reject) => {
    if (server) return resolve(PORT);
    server = http.createServer((req, res) => res.end(`hello from the VM: ${req.url}`));
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(PORT));
  }),
);
ipcMain.handle('ports:forward', () => ports.forward(PORT));
ipcMain.handle('ports:list', () => ports.list());
ipcMain.handle('ports:close', () => ports.close(PORT));

// the clipboard (SPEC 6, 8.4): needs the device "clipboard" in the manifest and the user's allow
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', async (event, text) => {
  await clipboard.writeText(text);
  return 'written';
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 320, title: 'SDK Probe' });
  await win.loadFile('index.html');
});
