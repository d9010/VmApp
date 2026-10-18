'use strict';
// Core of the dev-project fixture. The test edits the MARKER line in a copy of this folder and rebuilds.
const { app, BrowserWindow, ipcMain } = require('vmapp');

const MARKER = 'first build';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 520, height: 360, title: 'Dev Project' });
  await win.loadFile('index.html');
});

ipcMain.handle('marker', () => MARKER);
ipcMain.handle('echo', (e, ...args) => args);
