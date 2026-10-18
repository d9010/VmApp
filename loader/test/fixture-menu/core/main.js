'use strict';
// Menu Test (loader run M): the core sets the app's menus with the SDK's Electron-compatible Menu when the page asks; a click runs the
// item's click handler here, which tells the page.
const { app, BrowserWindow, ipcMain, Menu } = require('vmapp');

let win = null;
ipcMain.handle('core:set-menu', () =>
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'Tools', submenu: [{ id: 'core-hello', label: 'Say Hello', accelerator: 'CmdOrCtrl+Shift+H', click: (item) => win.webContents.send('core-click', item.id) }] },
      { role: 'editMenu' },
    ]),
  ),
);

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 640, height: 420, title: 'Menus' });
  await win.loadFile('index.html');
});
