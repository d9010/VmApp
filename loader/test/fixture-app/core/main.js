'use strict';
// Core of the loader test fixture: runs inside the VM with the vmapp Node SDK.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, folders } = require('vmapp');

let win = null;

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 760, height: 520, minWidth: 400, minHeight: 300, title: 'Loader Test' });
  await win.loadFile('index.html');
  // delivered to window.vmapp.on('hello') once the page is loaded
  win.webContents.send('hello', { name: app.getName(), version: app.getVersion(), folders });
});

ipcMain.handle('echo', (e, ...args) => args);
ipcMain.handle('fail', () => {
  throw new Error('boom from the core');
});
ipcMain.handle('folders', () => folders);
ipcMain.handle('list-folder', (e, name) => fs.readdirSync(folders[name]).sort());
ipcMain.handle('write-folder', (e, name, file, text) => {
  fs.writeFileSync(path.join(folders[name], file), text);
  return true;
});

// the app's private data folder (/data): what "Reset" deletes
ipcMain.handle('write-data', (e, file, text) => {
  fs.writeFileSync(path.join(app.getPath('userData'), file), text);
  return true;
});
ipcMain.handle('read-data', (e, file) => {
  try {
    return fs.readFileSync(path.join(app.getPath('userData'), file), 'utf8');
  } catch {
    return null;
  }
});

// dialog.open of a directory, with the vmapp `access` extension
ipcMain.handle('pick-dir', async (e, access) => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a folder', properties: ['openDirectory'], access });
  if (r.canceled) return { canceled: true };
  const dir = r.filePaths[0];
  return { canceled: false, dir, entries: fs.readdirSync(dir).sort() };
});
ipcMain.handle('write-in', (e, dir, file, text) => {
  fs.writeFileSync(path.join(dir, file), text);
  return true;
});

// dialog.open of a file: the host hands over a clone, never the folder it lives in
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a file', properties: ['openFile'] });
  if (r.canceled) return { canceled: true };
  const file = r.filePaths[0];
  return { canceled: false, file, content: fs.readFileSync(file, 'utf8'), siblings: fs.readdirSync(path.dirname(file)).sort() };
});

ipcMain.handle('save', async (e, text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Save', defaultPath: 'result.txt' });
  if (r.canceled) return { canceled: true };
  fs.writeFileSync(r.filePath, text);
  return { canceled: false, path: r.filePath };
});
ipcMain.handle('message', (e) => dialog.showMessageBox(win, { type: 'question', message: 'Continue?', buttons: ['Yes', 'No'] }).then((r) => r.response));
ipcMain.handle('external', (e, url) => shell.openExternal(url));

// the core pushes to the window by itself
ipcMain.on('tick-me', (e, n) => {
  win.webContents.send('tick', { n, from: 'core' });
});

// Electron's ipcMain / ipcRenderer contract, in a real window (tests/electron-conformance/MAPPING.md)
ipcMain.on('reply-me', (e, x) => e.reply('replied', x)); // "can be replied to"
ipcMain.handle('throw-type', () => {
  throw new TypeError('bad type from the core');
});
ipcMain.handle('typed', () => [new Uint8Array([1, 2, 3]), new Date(86400000), new Map([['k', new Set([1, 2])]]), undefined, 12345678901234567890n, NaN, -0, new Error('inner')]);
ipcMain.handle('typed-cycle', () => {
  const child = { hello: 'world' };
  child.child = child;
  const array = [5];
  array.push(array);
  return [array, child];
});
ipcMain.handle('send-typed', (e, ...args) => {
  win.webContents.send('typed', ...args);
});
ipcMain.handle('quit', () => {
  setTimeout(() => app.quit(), 20);
});
