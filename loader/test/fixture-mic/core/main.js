'use strict';
// Core of the microphone fixture (loader test run G): one window, no handlers. The microphone is used by the page; the test
// drives getUserMedia in it over the DevTools protocol.
const { app, BrowserWindow } = require('vmapp');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 320, title: 'Mic' });
  await win.loadFile('index.html');
});
