'use strict';
// Core of the GPU fixture (loader test run J): runs inside the VM with the vmapp Node SDK. It does what a llama.cpp client does with
// $VMAPP_GPU_RPC: connect to the address, send bytes, read the answer. Nothing here knows how the platform tunnels it (SPEC 8.6).
// The handlers answer data so the test can read refusals (no variable, a closed port) as plain values.
const net = require('net');
const { app, BrowserWindow, ipcMain } = require('vmapp');

ipcMain.handle('gpu:env', () => ({ gpu: process.env.VMAPP_GPU_RPC === undefined ? null : process.env.VMAPP_GPU_RPC }));

/**
 * Sends `bytes` bytes to the GPU server and waits for the same number back (the test's stand-in server echoes). The connection
 * is then held open for `holdMs` so that the host sees traffic counters before it closes.
 */
ipcMain.handle('gpu:ping', (_event, bytes = 4096, holdMs = 1200) => {
  const addr = process.env.VMAPP_GPU_RPC;
  if (!addr) return Promise.resolve({ ok: false, error: 'VMAPP_GPU_RPC is not set' });
  const [host, port] = addr.split(':');
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port) });
    let got = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(Object.assign({ addr }, r));
    };
    const timer = setTimeout(() => finish({ ok: false, error: `timeout after ${got} bytes` }), 15000);
    sock.once('error', (e) => finish({ ok: false, error: `connect: ${e.code || e.message}` }));
    sock.once('close', () => finish({ ok: false, error: `closed after ${got} bytes` }));
    sock.once('connect', () => sock.write(Buffer.alloc(bytes, 7)));
    sock.on('data', (d) => {
      got += d.length;
      if (got >= bytes) setTimeout(() => finish({ ok: true, echoed: got }), holdMs);
    });
  });
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 320, title: 'GPU Test' });
  await win.loadFile('index.html');
});
