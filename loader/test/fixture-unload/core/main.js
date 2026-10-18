'use strict';
// Unload Test (loader run U): one window; everything else happens in its page.
const { app, BrowserWindow } = require('vmapp');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 420, title: 'Unload' });
  await win.loadFile('index.html');
});
