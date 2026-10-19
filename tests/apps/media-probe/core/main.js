'use strict';
// Media Probe (tests/apps/media-probe-ui.mjs): a server on the VM's loopback that serves files the way real servers do, and the window
// that shows them. The server is the app's own (here a few lines of Node; in a converted app it is the original server); the page
// reaches it only through sdk/web/vmapp-fetch.js over the bridge. Nothing in the page's code knows about the bridge.
//
// The files are made here, so the test needs no fixtures except two fonts that the test runner copies next to this file (core/fonts/).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('vmapp');
const httpBridge = require('./http-bridge');

// ---- files made on the fly
function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set([r, g, b, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function bmp(w, h) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowBytes * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowBytes * h, 34);
  for (let i = 54; i < size; i += 3) b.set([200, 60, 20], i);
  return b;
}
function wav(seconds, rate = 8000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin((i / rate) * 2 * Math.PI * 440));
  return b;
}
const SVG = (color) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="${color}"/></svg>`;
const font = (name) => {
  try {
    return fs.readFileSync(path.join(__dirname, 'fonts', name));
  } catch {
    return null;
  }
};

const PNG4 = png(4, 4, [220, 30, 30]);
const PNG8 = png(8, 8, [30, 30, 220]);
const THEME_CSS = [
  '/* relative addresses here are relative to THIS file: /assets/css/theme.css */',
  '@font-face { font-family: ThemeFont; src: url(../fonts/main.woff2) format("woff2"); }',
  '.themed { background-image: url(../img/pixel.png); font-family: ThemeFont, sans-serif; }',
].join('\n');

// path -> [content type (undefined: the header is left out), body]
const FILES = {
  '/assets/pixel.png': ['image/png', PNG4],
  '/assets/img/pixel.png': ['image/png', PNG4],
  '/assets/pixel2.png': ['image/png', PNG8],
  '/assets/icon.svg': ['image/svg+xml', Buffer.from(SVG('#c00'))],
  '/assets/wrongtype.svg': ['application/octet-stream', Buffer.from(SVG('#0a0'))], // an SVG as application/octet-stream: the extension says what it is
  '/assets/textplain-svg': ['text/plain', Buffer.from(SVG('#00c'))], // an SVG as text, no extension: the bytes say what it is
  '/assets/blob': [undefined, PNG8], // no extension, no Content-Type: the bytes say what it is
  '/assets/big.bmp': ['image/bmp', bmp(700, 500)], // 1.05 MB: above the page's data: limit (set by the page), so it is shown as a blob: URL
  '/assets/tone.wav': ['audio/wav', wav(0.5)],
  '/assets/css/theme.css': ['text/css; charset=utf-8', Buffer.from(THEME_CSS)],
  '/assets/fonts/main.woff2': ['font/woff2', font('main.woff2')],
  '/assets/font.woff2': ['font/woff2', font('main.woff2')],
  '/assets/font-octet.woff2': ['application/octet-stream', font('main.woff2')],
  '/assets/font.ttf': ['font/ttf', font('main.ttf')],
};
// a real font padded to 1.2 MB: a font above the page's data: limit cannot be shown (the window allows data: only for fonts)
const ttf = font('main.ttf');
if (ttf) FILES['/assets/huge.ttf'] = ['font/ttf', Buffer.concat([ttf, Buffer.alloc(1200000)])];

FILES['/assets/redirect-target.png'] = ['image/png', png(6, 6, [30, 160, 30])];
// the server's own redirects (a picture at /avatar/7 that moves to /avatar/7.png): a browser and Electron's protocol handler follow them
const REDIRECTS = {
  '/assets/redirect.png': [302, '/assets/redirect-target.png'],
  '/assets/redirect-chain': [301, '/assets/redirect.png'],
};

const counts = {};
let port = 0;
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  counts[p] = (counts[p] || 0) + 1;
  if (p === '/assets/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(counts));
  }
  if (REDIRECTS[p]) {
    res.writeHead(REDIRECTS[p][0], { location: REDIRECTS[p][1], 'content-length': 0 });
    return res.end();
  }
  const f = FILES[p];
  if (!f || !f[1]) {
    res.writeHead(404, { 'content-type': 'text/plain', 'x-reason': 'not in this server' });
    return res.end('not found');
  }
  const body = f[1];
  const headers = { 'accept-ranges': 'bytes' };
  if (f[0]) headers['content-type'] = f[0];
  // a single byte range, the way a media element asks for it (Range: bytes=a-b): 206 with Content-Range. The test reads how many were asked.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    counts[`range ${p}`] = (counts[`range ${p}`] || 0) + 1;
    const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    if (start >= body.length || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${body.length}` });
      return res.end();
    }
    headers['content-range'] = `bytes ${start}-${end}/${body.length}`;
    headers['content-length'] = end - start + 1;
    res.writeHead(206, headers);
    return res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  return res.end(req.method === 'HEAD' ? undefined : body);
});

httpBridge.attach(ipcMain, { port: () => port, prefixes: ['/assets/'], methods: ['GET', 'HEAD'] });
ipcMain.handle('probe:files', () => Object.keys(FILES));

app.whenReady().then(
  () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', async () => {
        port = server.address().port;
        const win = new BrowserWindow({ width: 900, height: 700, title: 'Media Probe' });
        await win.loadFile('index.html');
        resolve();
      });
    }),
);
