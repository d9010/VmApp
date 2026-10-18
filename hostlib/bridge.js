'use strict';
// Host side of the bridge protocol (SPEC section 6): JSON lines over a Unix socket, one connection per app run.
// BridgeClient attaches to an existing socket, so it works with vmapp-vm's bridge socket and also directly with an
// SDK process in tests.

const net = require('net');
const { EventEmitter } = require('events');

const MAX_LINE = 16 * 1024 * 1024;

class BridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BridgeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.socketPath
   * @param {(op:string, params:object, msg:object)=>Promise<any>} [opts.onRequest] answers core `request`s; a
   *   rejection becomes reply.error = {message}
   *
   * Events: 'ready' (core sent ready), 'emit' (msg), 'log' ({level,message}), 'unknown' (msg), 'message' (any msg),
   * 'close', 'error'.
   */
  constructor(opts) {
    super();
    this.socketPath = opts.socketPath;
    this.onRequest = opts.onRequest || (async (op) => {
      throw new Error(`unsupported request: ${op}`);
    });
    this.socket = null;
    this.connected = false;
    this.coreReady = false;
    this._nextId = 1;
    this._pending = new Map();
    this._chunks = [];
    this._chunkBytes = 0;
    this._closed = false;
  }

  /** Connects, retrying while the socket does not exist / refuses (up to timeoutMs). */
  async connect(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this._tryConnect();
        return;
      } catch (e) {
        // ENOTSOCK: a stale plain file that the listener is about to replace
        if ((e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK') && Date.now() < deadline) {
          await sleep(50);
          continue;
        }
        throw new BridgeError(`cannot connect to bridge socket ${this.socketPath}: ${e.message}`);
      }
    }
  }

  _tryConnect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.socketPath);
      const onErr = (e) => {
        s.destroy();
        reject(e);
      };
      s.once('error', onErr);
      s.once('connect', () => {
        s.removeListener('error', onErr);
        this.socket = s;
        this.connected = true;
        s.on('data', (c) => this._onData(c));
        s.on('error', (e) => {
          if (this.listenerCount('error') > 0) this.emit('error', e);
          else this.emit('log', { level: 'warn', message: `bridge socket error: ${e.message}` });
        });
        s.on('close', () => this._onClose());
        resolve();
      });
    });
  }

  _onData(chunk) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      this._chunks.push(chunk.subarray(start, nl));
      this._chunkBytes += nl - start;
      const line = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
      this._chunks = [];
      this._chunkBytes = 0;
      start = nl + 1;
      if (line.length) this._dispatch(line.toString('utf8'));
    }
    if (start < chunk.length) {
      this._chunks.push(chunk.subarray(start));
      this._chunkBytes += chunk.length - start;
      if (this._chunkBytes > MAX_LINE) {
        this.emit('log', { level: 'error', message: 'bridge: incoming line exceeds 16 MiB; closing connection' });
        this.socket.destroy();
      }
    }
  }

  _dispatch(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.emit('log', { level: 'warn', message: `bridge: ignoring malformed line (${text.slice(0, 80)})` });
      return;
    }
    if (msg === null || typeof msg !== 'object' || typeof msg.t !== 'string') {
      this.emit('log', { level: 'warn', message: 'bridge: ignoring message without "t"' });
      return;
    }
    this.emit('message', msg);
    switch (msg.t) {
      case 'ready':
        this.coreReady = true;
        this.emit('ready');
        break;
      case 'result': {
        const p = this._pending.get(msg.id);
        if (!p) {
          this.emit('log', { level: 'warn', message: `bridge: result for unknown id ${msg.id}` });
          break;
        }
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'error'));
        else p.resolve(msg.result === undefined ? null : msg.result);
        break;
      }
      case 'emit':
        this.emit('emit', msg);
        break;
      case 'log':
        this.emit('log', { level: msg.level || 'info', message: String(msg.message) });
        break;
      case 'request':
        this._handleRequest(msg);
        break;
      default:
        this.emit('log', { level: 'warn', message: `bridge: unknown message type ${JSON.stringify(msg.t)} ignored` });
        this.emit('unknown', msg);
    }
  }

  async _handleRequest(msg) {
    let reply;
    try {
      const result = await this.onRequest(msg.op, msg.params, msg);
      reply = { t: 'reply', id: msg.id, result: result === undefined ? {} : result };
    } catch (e) {
      reply = { t: 'reply', id: msg.id, error: { message: String((e && e.message) || e) } };
    }
    try {
      this.send(reply);
    } catch (e) {
      // e.g. a result over the 16 MiB line limit: the core still gets an answer
      this.send({ t: 'reply', id: msg.id, error: { message: String((e && e.message) || e) } });
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    this.connected = false;
    for (const [, p] of this._pending) p.reject(new BridgeError('bridge closed'));
    this._pending.clear();
    this.emit('close');
  }

  /** Writes one JSON line. Returns false if the connection is gone. */
  send(obj) {
    if (!this.connected || !this.socket || this.socket.destroyed) return false;
    const line = JSON.stringify(obj) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE) throw new BridgeError('message exceeds the 16 MiB line limit');
    this.socket.write(line);
    return true;
  }

  // ---- host -> core messages ----
  init(payload) {
    return this.send(Object.assign({ t: 'init' }, payload));
  }

  /** Calls the core's ipcMain.handle(channel). Resolves with the result, rejects with Error(message). */
  invoke(win, channel, args) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new BridgeError('bridge closed'));
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      try {
        this.send({ t: 'invoke', id, win, channel, args: args || [] });
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  }
  sendToCore(win, channel, args) {
    return this.send({ t: 'send', win, channel, args: args || [] });
  }
  windowEvent(win, event, data) {
    return this.send({ t: 'window', win, event, data: data || {} });
  }
  beforeQuit() {
    return this.send({ t: 'before-quit' });
  }
  /** A vmapp://<app id>/… link was opened on the Mac for this app (SPEC 6, 8.9). */
  openUrl(url) {
    return this.send({ t: 'open-url', url });
  }

  /** Resolves when the core's `ready` arrives (immediately if it already did). */
  waitReady(timeoutMs = 30000) {
    if (this.coreReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new BridgeError(`core did not send ready within ${timeoutMs} ms`));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new BridgeError('bridge closed before the core was ready'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('ready', onReady);
        this.removeListener('close', onClose);
      };
      this.once('ready', onReady);
      this.once('close', onClose);
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

module.exports = { BridgeClient, BridgeError, MAX_LINE };
