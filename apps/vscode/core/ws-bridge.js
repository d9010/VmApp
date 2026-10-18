'use strict';
/**
 * ws-bridge.js: the core half of "a WebSocket over the bridge" (the page half is ui/vscode-vmapp-shim.js, `bridgeSocket`).
 *
 * VS Code's web workbench reaches its server through ONE kind of connection: a WebSocket to `ws://<remote authority>/?reconnectionToken=…`
 * carrying VS Code's own binary protocol (PersistentProtocol: the remote file system, the extension host, terminals, search, everything).
 * A vmapp window has no network (CSP connect-src 'none'), so the page hands the socket's bytes to the core over the bridge, and this file
 * opens the very same upgrade on the server in the VM (127.0.0.1) and copies bytes both ways.
 *
 * The server is asked for `skipWebSocketFrames=true` (an option of VS Code's server, remoteExtensionHostAgentServer.ts): after the 101 it
 * writes the protocol's bytes as they are, which is exactly what a browser hands to the page after it removed the WebSocket framing. The
 * page side never sees frames either way, so the chunk boundaries do not matter (the protocol has its own message headers).
 *
 * Wire protocol (channel prefix `ws`; every message is JSON):
 *   page -> core  invoke `ws:open`  {id, path, query}   id: a page-chosen integer; path must be "/" or the server's product path
 *                   "/<quality>-<commit>" (what the workbench uses); query: the page's query string, of
 *                   which only reconnectionToken and reconnection are kept. Resolves {} once the server answered 101, rejects otherwise.
 *   page -> core  send   `ws:data`  {id, b64}           bytes for the server, in order
 *   page -> core  send   `ws:ack`   {id, n}             the page has handed n bytes to VS Code (flow control, below)
 *   page -> core  send   `ws:close` {id}                the page closed the socket
 *   core -> page  emit   `ws:ev`    {id, t:'data', b64, n} | {id, t:'close', reason} | {id, t:'ack', n}
 *                   `ack` acknowledges bytes the core wrote to the server (the page uses it to bound what it has in flight)
 *
 * Flow control: the core keeps at most `window` bytes (default 2 MiB) sent to the page and not acknowledged; past that it pauses the
 * server's socket, so a big read of a file waits in the server instead of piling up in the bridge.
 *
 * What it refuses (a page is untrusted): any other path, query parameters other than the two above, more than `maxSockets` sockets,
 * a message for a socket the page did not open.
 *
 * Several windows (New Window, core/main.js): each window numbers its own sockets from 1, so a socket is known by its window and its
 * id; a window only reaches the sockets it opened. dropWindow(winId) closes the sockets of a window that closed.
 */
const crypto = require('crypto');
const http = require('http');

const CHUNK = 192 * 1024; // bytes per `data` event (base64 makes it 256 KiB of JSON)
// The path of the server's remote connection: "/" or the server's product path "/<quality>-<commit>" (RemoteAuthorities.getServerRootPath)
const SERVER_PATH = /^\/(?:[a-z]+-[0-9a-f]{40})?\/?$/;

function attach(ipcMain, options) {
  const o = { channel: 'ws', window: 2 * 1024 * 1024, maxSockets: 32, headers: () => ({}), log: () => {}, ...options };
  const portOf = typeof o.port === 'function' ? o.port : () => o.port;
  const ch = (name) => `${o.channel}:${name}`;
  /** "<window id>:<socket id>" -> {id, key, win, sender, socket, unacked, paused, closed} */
  const active = new Map();
  let closed = false;
  const winOf = (event) => (event && event.sender && event.sender.id !== undefined && event.sender.id !== null ? String(event.sender.id) : '-');
  const keyOf = (event, id) => `${winOf(event)}:${id}`;

  function emit(entry, payload) {
    const s = entry.sender;
    if (!s || (typeof s.isDestroyed === 'function' && s.isDestroyed())) return finish(entry, 'window gone');
    try {
      s.send(ch('ev'), { id: entry.id, ...payload });
    } catch {
      finish(entry, 'window gone');
    }
  }

  function finish(entry, reason, tell) {
    if (entry.closed) return;
    entry.closed = true;
    active.delete(entry.key);
    if (entry.socket) entry.socket.destroy();
    if (tell) emit(entry, { t: 'close', reason: String(reason || '') });
  }

  function cleanQuery(query) {
    const inQ = new URLSearchParams(String(query || ''));
    const out = new URLSearchParams();
    for (const key of ['reconnectionToken', 'reconnection']) {
      const v = inQ.getAll(key);
      if (v.length === 1 && v[0].length <= 200) out.set(key, v[0]);
    }
    out.set('skipWebSocketFrames', 'true');
    return out.toString();
  }

  ipcMain.handle(ch('open'), (event, r) => {
    if (closed) throw new Error('closed');
    const id = r && Number.isSafeInteger(r.id) ? r.id : NaN;
    const key = keyOf(event, id);
    if (!Number.isSafeInteger(id) || active.has(key)) throw new Error('bad socket id');
    if (!r || typeof r.path !== 'string' || !SERVER_PATH.test(r.path)) throw new Error('only the server\'s remote connection can be opened');
    if (active.size >= o.maxSockets) throw new Error('too many sockets');
    const port = portOf();
    if (!port) throw new Error('the VS Code server is not running');
    const entry = { id, key, win: winOf(event), sender: event && event.sender, socket: null, unacked: 0, paused: false, closed: false };
    active.set(key, entry);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `${r.path}?${cleanQuery(r.query)}`,
        headers: {
          ...o.headers(),
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        },
      });
      req.setTimeout(15000, () => req.destroy(new Error('the server did not answer')));
      req.on('response', (res) => {
        res.resume();
        active.delete(key);
        entry.closed = true;
        reject(new Error(`the server refused the connection (${res.statusCode})`));
      });
      req.on('error', (e) => {
        active.delete(key);
        entry.closed = true;
        reject(new Error(`cannot reach the VS Code server: ${e.message}`));
      });
      req.on('upgrade', (res, socket, head) => {
        req.setTimeout(0);
        if (entry.closed) return socket.destroy();
        entry.socket = socket;
        socket.setNoDelay(true);
        const deliver = (buf) => {
          for (let i = 0; i < buf.length; i += CHUNK) {
            const part = buf.subarray(i, i + CHUNK);
            entry.unacked += part.length;
            emit(entry, { t: 'data', b64: part.toString('base64'), n: part.length });
          }
          if (entry.unacked > o.window && !entry.paused) {
            entry.paused = true;
            socket.pause();
          }
        };
        socket.on('data', deliver);
        socket.on('close', () => finish(entry, 'the server closed the connection', true));
        socket.on('error', (e) => finish(entry, e.message, true));
        resolve({});
        if (head && head.length) setImmediate(() => deliver(head));
      });
      req.end();
    });
  });

  ipcMain.on(ch('data'), (event, r) => {
    const entry = r && active.get(keyOf(event, r.id));
    if (!entry || !entry.socket || typeof r.b64 !== 'string') return;
    const buf = Buffer.from(r.b64, 'base64');
    entry.socket.write(buf, () => {
      if (!entry.closed) emit(entry, { t: 'ack', n: buf.length });
    });
  });

  ipcMain.on(ch('ack'), (event, r) => {
    const entry = r && active.get(keyOf(event, r.id));
    if (!entry || !Number.isSafeInteger(r.n) || r.n < 0) return;
    entry.unacked = Math.max(0, entry.unacked - r.n);
    if (entry.paused && entry.unacked <= o.window / 2) {
      entry.paused = false;
      entry.socket.resume();
    }
  });

  ipcMain.on(ch('close'), (event, r) => {
    const entry = r && active.get(keyOf(event, r.id));
    if (entry) finish(entry, 'closed by the page', false);
  });

  return {
    get size() {
      return active.size;
    },
    /** The window `winId` closed (or navigated away for good): its sockets end, as a browser's do when a tab closes. */
    dropWindow(winId) {
      const w = String(winId);
      for (const entry of [...active.values()]) if (entry.win === w) finish(entry, 'the window closed', false);
    },
    close() {
      closed = true;
      for (const entry of [...active.values()]) finish(entry, 'the app is stopping', true);
    },
  };
}

module.exports = { attach };
