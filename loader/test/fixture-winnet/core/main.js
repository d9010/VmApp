'use strict';
// Window Net Test (loader run W): the core only opens the window; the page does the network (SPEC 8.3 "The app's windows").
const { app, BrowserWindow } = require('vmapp');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 420, title: 'Window Net' });
  await win.loadFile('index.html');
});
