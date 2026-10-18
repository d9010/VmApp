'use strict';
// The core of the bridge benchmark app (bench/bridge). Three handlers, nothing else:
//   echo(x)          returns x unchanged                  -> the small round trip and the concurrent calls
//   blob(n)          returns a string of n characters     -> reply sizes (bulk throughput)
//   burst(n, size)   sends n messages of `size` characters to the window with webContents.send, then returns n
//                                                          -> core -> UI event throughput
const { app, BrowserWindow, ipcMain } = require('vmapp');

app.whenReady().then(() => new BrowserWindow({ width: 300, height: 200, title: 'Bench' }).loadFile('index.html'));

ipcMain.handle('echo', (e, x) => x);
ipcMain.handle('blob', (e, n) => 'x'.repeat(n));
ipcMain.handle('burst', async (e, n, size) => {
  const win = BrowserWindow.getAllWindows()[0];
  const s = 'y'.repeat(size);
  for (let i = 0; i < n; i++) win.webContents.send('burst', i, s);
  return n;
});
