'use strict';
// vmapp entry for the Bookmarks web app. Three jobs:
//   1. start the ORIGINAL server (server.js, unchanged) on 127.0.0.1:<free port>, inside the VM, data in /data;
//   2. open a window on ui/index.html;
//   3. answer ipcMain 'http' by forwarding the renderer's request to that local server (ui/bridge-fetch.js is the
//      other end of this).
// The server never leaves the VM: it listens on the VM's loopback, and nothing outside the VM can reach it.
const { app, BrowserWindow, ipcMain } = require('vmapp');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const HOST = '127.0.0.1';
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);

let port = 0;
let child = null;
let quitting = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, HOST, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Polls the server until it answers (any HTTP status counts), or fails if it exits / takes too long.
function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (!child || child.exitCode !== null) return reject(new Error('the server exited before it was ready'));
      const req = http.get({ host: HOST, port, path: '/api/bookmarks', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('the server did not start in time'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function startServer() {
  port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, HOST, PORT: String(port), DATA_DIR: app.getPath('userData') },
    stdio: ['ignore', 'inherit', 'inherit'], // the server's console output goes to the loader's app log
  });
  child.on('exit', (code, signal) => {
    if (quitting) return;
    console.error(`server exited (code ${code}, signal ${signal})`);
    app.quit();
  });
  await waitForServer(15000);
}

// { method, path, headers, body } -> { status, headers: { 'content-type' }, body }   (text bodies)
function forward({ method, path: reqPath, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    method = String(method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return reject(new Error('method not allowed: ' + method));
    if (typeof reqPath !== 'string' || !reqPath.startsWith('/') || reqPath.startsWith('//')) {
      return reject(new Error('path must start with a single "/"'));
    }
    const data = body === undefined || body === null ? null : Buffer.from(String(body), 'utf8');
    const outHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) outHeaders[k.toLowerCase()] = String(v);
    }
    if (data) outHeaders['content-length'] = String(data.length);

    const req = http.request({ host: HOST, port, method, path: reqPath, headers: outHeaders, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = { status: res.statusCode, headers: {}, body: Buffer.concat(chunks).toString('utf8') };
        if (res.headers['content-type']) out.headers['content-type'] = res.headers['content-type'];
        resolve(out);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the server did not answer in time')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

ipcMain.handle('http', (_event, request) => forward(request));

// The streamed variant of the same bridge (docs/CONVERTING.md 5.3, "Streamed bodies"): `build.sh --streaming` vendors
// sdk/node/http-bridge.js next to this file and swaps ui/bridge-fetch.js for sdk/web/vmapp-fetch.js. Then fetch() gets streamed answers,
// AbortSignal, and binary or large request bodies. Without the vendored file this does nothing and the 'http' handler above is the bridge.
try {
  require('./http-bridge').attach(ipcMain, { port: () => port, prefixes: ['/api/'] });
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !/http-bridge/.test(e.message)) throw e;
}

app.on('before-quit', () => {
  quitting = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
});

app.whenReady().then(async () => {
  await startServer();
  const win = new BrowserWindow({ width: 760, height: 620, title: 'Bookmarks' });
  await win.loadFile('index.html');
}).catch((err) => {
  console.error('startup failed: ' + (err && err.message ? err.message : err));
  app.quit();
});
