'use strict';
/**
 * http-bridge.js: the core half of "HTTP over the bridge" with streamed bodies (docs/CONVERTING.md section 5.3).
 *
 * A vmapp window has no network, but the VM has a loopback interface. The page half (sdk/web/vmapp-fetch.js) replaces window.fetch for
 * the page's own origin and hands each request to the core over the bridge; this half forwards it, with Node's http module, to a server
 * that listens on 127.0.0.1 INSIDE the VM, and streams the answer back: the status line and headers first, then the body in chunks as
 * the server writes them (a server-sent stream, newline-delimited JSON, a big download), never all at once.
 *
 *   const bridge = require('./http-bridge').attach(ipcMain, { port: 11501, prefixes: ['/api/'], headers: () => ({ cookie: 'token=…' }) });
 *
 * Wire protocol "vmapp-fetch/1" (one channel prefix, default `fetch`; every message is JSON, so it also fits the bridge's limits):
 *
 *   page -> core  invoke `fetch:open`  {id, method, path, headers: {lower-case-name: value}, length, text? | b64?}
 *                   `length` is the size of the request body in bytes (0 for none). The first bytes (or all of them) may come with the
 *                   call, as `text` (UTF-8, for a string body) or `b64`; when fewer than `length` bytes came, the page continues with
 *                   `fetch:part`. The call resolves {} once the request is accepted (it does not wait for the answer).
 *   page -> core  invoke `fetch:part`  {id, b64}   the next piece of the body (at most 1 MiB of bytes). Resolves {} when the piece is
 *                   written to the server's socket: the page sends the next one only then (flow control for uploads).
 *   page -> core  send   `fetch:ack`    {id, n}     the page has consumed n bytes of the answer (flow control for downloads, below)
 *   page -> core  send   `fetch:abort`  {id}        the page gave up (AbortSignal, reader.cancel()): the connection to the server is
 *                   destroyed, which is what stops a chat generation in the server.
 *   core -> page  emit   `fetch:ev`     {id, t:'head', status, statusText, headers: [[name, value], ...]}
 *                                       {id, t:'data', enc:'t'|'b', d, n}  a piece of the answer (`t`: UTF-8 text, `b`: base64); the page
 *                                                                          acknowledges `n` (the server's bytes in it) once it has read it
 *                                       {id, t:'end'}                      the answer is complete
 *                                       {id, t:'error', message, phase:'request'|'response'}   the request or the answer failed
 *
 * Flow control: the core may have at most `window` bytes (default 256 KiB) of the answer sent and not acknowledged. When the page reads
 * slowly it stops acknowledging, the core stops sending, pauses the server's socket, and the server blocks in its own write: the
 * pressure reaches the program that produces the data. Text answers (JSON, NDJSON, event streams) travel as UTF-8 strings, split only
 * at character boundaries; everything else as base64.
 *
 * What it refuses (a page is untrusted): a host or port other than the configured loopback server, a path outside `prefixes`, a method
 * outside `methods`, a (method, path) pair that the optional `allow(method, path)` function refuses, a body above `maxBodyBytes`, more
 * than `maxConcurrent` requests at once, hop-by-hop request headers, and a request header the page may not set (`cookie` and `host`
 * among them: the core's `headers` option sets what the server must see).
 *
 * Several servers: call attach() once per server with its own `channel` ("fetch", "raw", ...) and, if its paths must not collide with
 * another's, a mount point: `strip: '/ollama'` makes the page's `/ollama/api/tags` reach the server as `/api/tags`. The page half takes
 * the same pairs as `routes`.
 */
const http = require('http');
const { StringDecoder } = require('string_decoder');

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// request headers the page cannot set: hop-by-hop ones, the ones the HTTP client computes, and the ones that carry credentials
const DROP_REQUEST = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect', 'cookie',
  'proxy-authorization', 'proxy-connection', 'accept-encoding',
]);
// response headers that stay behind: hop-by-hop ones and the ones that describe the encoding of bytes the page never sees
const DROP_RESPONSE = new Set(['connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'content-length', 'content-encoding', 'set-cookie', 'set-cookie2']);
const TEXT_TYPE = /^(text\/|application\/(json|x-ndjson|ndjson|jsonl|x-jsonlines|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;
const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function attach(ipcMain, options = {}) {
  const o = {
    host: '127.0.0.1',
    channel: 'fetch',
    prefixes: ['/'],
    methods: DEFAULT_METHODS,
    headers: null,
    window: 256 * 1024,
    maxEvent: 192 * 1024,
    maxConcurrent: 64,
    maxBodyBytes: 1024 * 1024 * 1024,
    ...options,
  };
  if (o.host !== '127.0.0.1' && o.host !== '::1' && o.host !== 'localhost') throw new Error('http-bridge: the server must be on the loopback interface');
  if (!CHANNEL_RE.test(o.channel)) throw new Error('http-bridge: bad channel prefix');
  if (!Array.isArray(o.prefixes) || !o.prefixes.length || o.prefixes.some((p) => typeof p !== 'string' || !p.startsWith('/'))) {
    throw new Error('http-bridge: prefixes must be paths that start with "/"');
  }
  const methods = new Set(o.methods.map((m) => String(m).toUpperCase()));
  const strip = o.strip ? `/${String(o.strip).replace(/^\/+|\/+$/g, '')}` : '';
  const portOf = typeof o.port === 'function' ? o.port : () => o.port;
  const extraHeaders = typeof o.headers === 'function' ? o.headers : () => o.headers || {};
  const ch = (name) => `${o.channel}:${name}`;

  /** id -> {id, sender, req, sentBody, length, res, queue, queued, credit, ended, decoder, text, done} */
  const active = new Map();
  let closed = false;

  function emit(entry, payload) {
    const s = entry.sender;
    if (!s || (typeof s.isDestroyed === 'function' && s.isDestroyed())) {
      // the window is gone: nobody reads the answer, so stop the work (this is what ends a generation the user closed the window on)
      if (!entry.done) {
        if (entry.req) entry.req.destroy();
        if (entry.res) entry.res.destroy();
        finish(entry);
      }
      return;
    }
    try {
      s.send(ch('ev'), { id: entry.id, ...payload });
    } catch (e) {
      if (!entry.done) {
        if (entry.req) entry.req.destroy();
        finish(entry);
      }
    }
  }

  function finish(entry) {
    if (entry.done) return;
    entry.done = true;
    active.delete(entry.id);
    entry.queue = [];
  }

  function fail(entry, message, phase) {
    if (entry.done) return;
    emit(entry, { t: 'error', message: String(message), phase });
    if (entry.req) entry.req.destroy();
    finish(entry);
  }

  function cleanHeaders(h) {
    const out = {};
    if (!h || typeof h !== 'object') return out;
    for (const [k, v] of Object.entries(h)) {
      const name = String(k).toLowerCase();
      if (DROP_REQUEST.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) continue;
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
      out[name] = String(v);
    }
    return out;
  }

  // ---- the answer: head, then paced data
  function pump(entry) {
    if (entry.done) return;
    while (entry.queued > 0 && entry.credit > 0) {
      const want = Math.min(entry.credit, o.maxEvent);
      const parts = [];
      let got = 0;
      while (entry.queue.length && got < want) {
        const b = entry.queue[0];
        const take = Math.min(b.length, want - got);
        parts.push(take === b.length ? b : b.subarray(0, take));
        got += take;
        if (take === b.length) entry.queue.shift();
        else entry.queue[0] = b.subarray(take);
      }
      entry.queued -= got;
      const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      // `n` is what the page acknowledges when it has read the piece (credit is counted in the server's bytes, however they are encoded)
      if (entry.text) {
        const s = entry.decoder.write(buf);
        if (s) {
          entry.credit -= got;
          emit(entry, { t: 'data', enc: 't', d: s, n: got });
        } // else: an incomplete character, held by the decoder for the next piece; nothing was sent, nothing is owed
      } else {
        entry.credit -= got;
        emit(entry, { t: 'data', enc: 'b', d: buf.toString('base64'), n: got });
      }
    }
    if (entry.res && entry.paused && entry.queued < o.window / 2) {
      entry.paused = false;
      entry.res.resume();
    }
    if (entry.ended && entry.queued === 0) {
      if (entry.text) {
        const rest = entry.decoder.end();
        if (rest) emit(entry, { t: 'data', enc: 't', d: rest });
      }
      emit(entry, { t: 'end' });
      finish(entry);
    }
  }

  function onResponse(entry, res) {
    const type = String(res.headers['content-type'] || '');
    entry.res = res;
    entry.text = TEXT_TYPE.test(type) || !type;
    entry.decoder = new StringDecoder('utf8');
    const headers = [];
    for (const [k, v] of Object.entries(res.headers)) {
      if (DROP_RESPONSE.has(k)) continue;
      headers.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
    }
    emit(entry, { t: 'head', status: res.statusCode, statusText: res.statusMessage || '', headers });
    res.on('data', (c) => {
      if (entry.done) return;
      entry.queue.push(c);
      entry.queued += c.length;
      if (!entry.paused && entry.queued >= o.window) {
        entry.paused = true;
        res.pause();
      }
      pump(entry);
    });
    res.on('end', () => {
      entry.ended = true;
      pump(entry);
    });
    res.on('error', (e) => fail(entry, e.message, 'response'));
    res.on('aborted', () => fail(entry, 'the server closed the connection', 'response'));
    res.on('close', () => {
      if (!entry.ended && !entry.done) fail(entry, 'the server closed the connection', 'response');
    });
  }

  // ---- the request
  function writeBody(entry, buf) {
    return new Promise((resolve, reject) => {
      entry.sentBody += buf.length;
      if (entry.sentBody > entry.length) return reject(new Error('the request body is longer than announced'));
      if (!entry.req.write(buf, (err) => (err ? reject(err) : undefined))) entry.req.once('drain', resolve);
      else resolve();
    });
  }

  function endBodyIfComplete(entry) {
    if (entry.sentBody === entry.length && !entry.requestEnded) {
      entry.requestEnded = true;
      entry.req.end();
    }
  }

  function bytesOf(part) {
    if (part && typeof part.text === 'string') return Buffer.from(part.text, 'utf8');
    if (part && typeof part.b64 === 'string') return Buffer.from(part.b64, 'base64');
    return Buffer.alloc(0);
  }

  ipcMain.handle(ch('open'), async (event, r) => {
    if (closed) throw new Error('the bridge is closed');
    r = r || {};
    const id = String(r.id || '');
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new Error('bad request id');
    if (active.has(id)) throw new Error('duplicate request id');
    if (active.size >= o.maxConcurrent) throw new Error('too many requests at once');
    const method = String(r.method || 'GET').toUpperCase();
    if (!methods.has(method)) throw new Error(`method not allowed: ${method}`);
    let p = r.path;
    if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || /[\s\u0000-\u001f\u007f]/.test(p)) throw new Error('bad path');
    if (strip) {
      // a mount point: the page asks for /ollama/api/tags, the server is asked for /api/tags
      if (!p.startsWith(`${strip}/`)) throw new Error('path not allowed');
      p = p.slice(strip.length);
    }
    if (!o.prefixes.some((x) => p.startsWith(x))) throw new Error('path not allowed');
    if (typeof o.allow === 'function' && !o.allow(method, p.split('?')[0])) throw new Error(`${method} ${p.split('?')[0]} is not available here`);
    const length = Number(r.length) || 0;
    if (!Number.isInteger(length) || length < 0 || length > o.maxBodyBytes) throw new Error('bad body length');
    const port = Number(portOf());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('the server is not running');

    const headers = { ...cleanHeaders(r.headers), 'accept-encoding': 'identity', ...(extraHeaders() || {}) };
    if (length > 0 || (method !== 'GET' && method !== 'HEAD')) headers['content-length'] = String(length);

    const entry = {
      id, sender: event && event.sender, req: null, length, sentBody: 0, requestEnded: false,
      res: null, queue: [], queued: 0, credit: o.window, ended: false, paused: false, decoder: null, text: true, done: false,
    };
    active.set(id, entry);
    try {
      entry.req = http.request({ host: o.host, port, method, path: p, headers, agent: false }, (res) => onResponse(entry, res));
    } catch (e) {
      active.delete(id);
      throw e;
    }
    entry.req.on('error', (e) => fail(entry, e.message, entry.res ? 'response' : 'request'));
    entry.req.on('close', () => {
      if (!entry.res && !entry.done) fail(entry, 'the server closed the connection', 'request');
    });
    const first = bytesOf(r);
    if (first.length) {
      try {
        await writeBody(entry, first);
      } catch (e) {
        fail(entry, e.message, 'request');
        throw e;
      }
    }
    endBodyIfComplete(entry);
    return {};
  });

  ipcMain.handle(ch('part'), async (event, r) => {
    const entry = active.get(String((r && r.id) || ''));
    if (!entry || entry.requestEnded) throw new Error('unknown request');
    try {
      await writeBody(entry, bytesOf(r));
    } catch (e) {
      fail(entry, e.message, 'request');
      throw e;
    }
    endBodyIfComplete(entry);
    return {};
  });

  ipcMain.on(ch('ack'), (event, r) => {
    const entry = active.get(String((r && r.id) || ''));
    const n = Number(r && r.n);
    if (!entry || !Number.isFinite(n) || n <= 0) return;
    entry.credit = Math.min(entry.credit + n, o.window);
    pump(entry);
  });

  ipcMain.on(ch('abort'), (event, r) => {
    const entry = active.get(String((r && r.id) || ''));
    if (!entry) return;
    if (entry.req) entry.req.destroy();
    if (entry.res) entry.res.destroy();
    finish(entry);
  });

  return {
    /** Number of requests in flight. */
    get size() {
      return active.size;
    },
    /** Destroys every request in flight and stops accepting new ones. */
    close() {
      closed = true;
      for (const entry of [...active.values()]) {
        if (entry.req) entry.req.destroy();
        if (entry.res) entry.res.destroy();
        finish(entry);
      }
      ipcMain.removeHandler(ch('open'));
      ipcMain.removeHandler(ch('part'));
      ipcMain.removeAllListeners(ch('ack'));
      ipcMain.removeAllListeners(ch('abort'));
    },
  };
}

module.exports = { attach, TEXT_TYPE, DEFAULT_METHODS };
