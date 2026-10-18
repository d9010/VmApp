'use strict';
// Core of the network fixture (loader test run I): runs inside the VM with the vmapp Node SDK. It does what any Node app does,
// fetch(), and nothing here knows about the allowlist proxy (SPEC 8.3). Handlers answer data so the test can read refusals.
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('vmapp');

ipcMain.handle('net:fetch', async (_event, url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    await r.arrayBuffer();
    return { status: r.status };
  } catch (e) {
    return { error: String((e.cause && (e.cause.code || e.cause.message)) || e.message) };
  }
});

// How big the VM really is: the test compares it with the size the user chose (SPEC 2.2, 8)
ipcMain.handle('vm:size', () => {
  let memKiB = null;
  try {
    const m = /^MemTotal:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    memKiB = m ? Number(m[1]) : null;
  } catch {
    /* no /proc in this view */
  }
  return { cpus: os.availableParallelism(), cpuList: os.cpus().length, memKiB, totalmem: os.totalmem() };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 320, title: 'Net Test' });
  await win.loadFile('index.html');
});
