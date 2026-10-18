'use strict';
// Core of the DevTools fixture (loader test run F): one window with the default (no DevTools), one that asks for them,
// like Electron's webPreferences.devTools. Every other webPreferences key is ignored by the SDK (one warning in the log).
const { app, BrowserWindow } = require('vmapp');

app.whenReady().then(async () => {
  const plain = new BrowserWindow({ width: 500, height: 300, title: 'Plain' });
  await plain.loadFile('index.html');
  const debuggable = new BrowserWindow({ width: 500, height: 300, title: 'Debuggable', webPreferences: { devTools: true, nodeIntegration: true } });
  await debuggable.loadFile('index.html');
});
