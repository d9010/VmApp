'use strict';
// "HTTP over the bridge" with streamed bodies: sdk/web/vmapp-fetch.js (the page) against sdk/node/http-bridge.js (the core), joined by a
// fake bridge that behaves like the real one where it matters (JSON-only messages, asynchronous delivery, no flow control of its own)
// and talking to a real HTTP server on 127.0.0.1. No VM. The same code runs in a real VM in tests/apps/ollama-desktop.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { createFetch, PART_BYTES } = require('../../sdk/web/vmapp-fetch.js');
const { attach } = require('../../sdk/node/http-bridge.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const LOCATION = { href: 'vmapp-ui://app.test/index.html', protocol: 'vmapp-ui:', host: 'app.test' };

/** A page and a core joined by a fake bridge. */
function bridgePair() {
  const handlers = new Map();
  const listeners = new Map(); // core side: channel -> [fn]
  const pageListeners = new Map();
  const log = [];
  let destroyed = false;
  const roundTrip = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const sender = {
    send(channel, ...args) {
      if (destroyed) return;
      const a = roundTrip(args);
      log.push({ dir: 'core->page', channel, args: a });
      setImmediate(() => {
        for (const fn of pageListeners.get(channel) || []) fn(...a);
      });
    },
    isDestroyed: () => destroyed,
  };
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
    },
    removeAllListeners: (channel) => listeners.delete(channel),
  };
  const vmapp = {
    async invoke(channel, ...args) {
      const a = roundTrip(args);
      log.push({ dir: 'page->core', channel, args: a });
      await wait(0);
      const h = handlers.get(channel);
      if (!h) throw new Error(`No handler registered for '${channel}'`);
      return roundTrip(await h({ sender }, ...a));
    },
    send(channel, ...args) {
      const a = roundTrip(args);
      log.push({ dir: 'page->core', channel, args: a });
      setImmediate(() => {
        for (const fn of listeners.get(channel) || []) fn({ sender }, ...a);
      });
    },
    on(channel, fn) {
      if (!pageListeners.has(channel)) pageListeners.set(channel, []);
      pageListeners.get(channel).push(fn);
      return () => {};
    },
  };
  return { vmapp, ipcMain, log, destroyWindow: () => (destroyed = true) };
}

/** Starts a server with `handler`, a bridge to it, and the page's fetch. */
async function setup(handler, bridgeOptions = {}, pageOptions = {}) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const pair = bridgePair();
  const bridge = attach(pair.ipcMain, { port, prefixes: ['/api/'], ...bridgeOptions });
  const fallthrough = [];
  const page = createFetch({
    vmapp: pair.vmapp,
    location: LOCATION,
    prefixes: ['/api/'],
    realFetch: async (input) => {
      fallthrough.push(String(input));
      return new Response('real fetch', { status: 200 });
    },
    ...pageOptions,
  });
  return {
    port, pair, bridge, page, fallthrough, fetch: page.fetch, server,
    async close() {
      bridge.close();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

test('GET: status, headers and JSON; a 404 with a body; HEAD has no body', async () => {
  const t = await setup((req, res) => {
    if (req.url === '/api/missing') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"nope"}');
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-version': '1.2.3', 'set-cookie': 'secret=1' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ url: req.url, method: req.method }));
  });
  try {
    const r = await t.fetch('/api/v1/chats?x=1');
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.headers.get('x-version'), '1.2.3');
    assert.equal(r.headers.get('set-cookie'), null, 'set-cookie never reaches the page');
    assert.equal(r.url, 'vmapp-ui://app.test/api/v1/chats?x=1');
    assert.deepEqual(await r.json(), { url: '/api/v1/chats?x=1', method: 'GET' });
    const m = await t.fetch('vmapp-ui://app.test/api/missing');
    assert.equal(m.status, 404);
    assert.deepEqual(await m.json(), { error: 'nope' });
    const h = await t.fetch('/api/v1/chats', { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(h.body, null);
    assert.equal(t.bridge.size, 0, 'no request is left behind');
  } finally {
    await t.close();
  }
});

test('POST: a string body, headers (lower-cased), and the core\'s own headers win over the page\'s', async () => {
  let seen;
  const t = await setup(
    (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    },
    { headers: () => ({ cookie: 'token=core-token' }) },
  );
  try {
    const r = await t.fetch('/api/v1/chat/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'token=stolen', 'X-Custom': 'yes', Host: 'evil.example' },
      body: JSON.stringify({ prompt: 'héllo 日本語' }),
    });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.body, '{"prompt":"héllo 日本語"}');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['x-custom'], 'yes');
    assert.equal(seen.headers.cookie, 'token=core-token', 'the page cannot set the cookie');
    assert.notEqual(seen.headers.host, 'evil.example');
    assert.equal(seen.headers['content-length'], String(Buffer.byteLength(seen.body)));
  } finally {
    await t.close();
  }
});

test('a streamed answer arrives piece by piece while the server is still writing', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"n":1}\n');
    gate.then(() => {
      res.write('{"n":2}\n');
      res.end('{"n":3}\n');
    });
  });
  try {
    const r = await t.fetch('/api/v1/chat/x', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const first = await reader.read();
    assert.equal(dec.decode(first.value), '{"n":1}\n', 'the first line arrives before the server finished');
    release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    assert.equal(rest, '{"n":2}\n{"n":3}\n');
    assert.equal(t.bridge.size, 0);
  } finally {
    await t.close();
  }
});

test('multi-byte characters split across the server\'s writes are never split on the page', async () => {
  const text = 'héllo wörld 日本語 🙂 end';
  const bytes = Buffer.from(text, 'utf8');
  const t = await setup(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    for (const b of bytes) {
      res.write(Buffer.from([b]));
      await wait(1);
    }
    res.end();
  });
  try {
    const r = await t.fetch('/api/text');
    assert.equal(await r.text(), text);
  } finally {
    await t.close();
  }
});

test('binary answers are exact (every byte value)', async () => {
  const all = Buffer.alloc(256 * 40);
  for (let i = 0; i < all.length; i++) all[i] = i % 256;
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(all);
  });
  try {
    const r = await t.fetch('/api/bin');
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(all));
  } finally {
    await t.close();
  }
});

test('an answer with NO Content-Type is binary-safe (a picture or a download from a server that omits it)', async () => {
  const all = Buffer.alloc(256 * 20);
  for (let i = 0; i < all.length; i++) all[i] = i % 256; // every byte value, including the ones that are not valid UTF-8
  const t = await setup((req, res) => {
    res.writeHead(200); // no Content-Type at all
    res.end(req.url.endsWith('/json') ? '{"ok":true,"name":"café"}' : all);
  });
  try {
    const r = await t.fetch('/api/nothing');
    assert.equal(r.headers.get('content-type'), null);
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(all), 'every byte arrives unchanged');
    const j = await t.fetch('/api/json');
    assert.deepEqual(await j.json(), { ok: true, name: 'café' }, 'and text without a type still reads as text');
  } finally {
    await t.close();
  }
});

test('backpressure: a page that stops reading stops the server; resuming delivers every byte', async () => {
  const total = 24 * 1024 * 1024;
  const block = crypto.randomBytes(64 * 1024);
  const hash = crypto.createHash('sha256');
  let written = 0;
  let serverSocket = null;
  const t = await setup((req, res) => {
    serverSocket = res.socket;
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const pump = () => {
      while (written < total) {
        const chunk = block.subarray(0, Math.min(block.length, total - written));
        hash.update(chunk);
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  try {
    const r = await t.fetch('/api/big');
    const reader = r.body.getReader();
    const first = await reader.read(); // one piece, then the page stops reading
    assert.ok(first.value.length > 0);
    await wait(500);
    // Everything between the server's write() and the page: socket buffers (a few MB on loopback), the core's window (256 KiB) and
    // the page's. Without flow control the server would have written all 24 MiB by now.
    assert.ok(written < total / 2, `the server wrote ${written} of ${total} bytes while the page did not read: no backpressure`);
    const stalled = written;
    await wait(200);
    assert.equal(written, stalled, 'and it stays stalled');
    let got = first.value.length;
    const recv = crypto.createHash('sha256').update(first.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      recv.update(value);
    }
    assert.equal(got, total);
    assert.equal(recv.digest('hex'), hash.digest('hex'));
    assert.ok(serverSocket);
  } finally {
    await t.close();
  }
});

test('AbortSignal: the answer rejects with AbortError and the server\'s request is destroyed', async () => {
  let closed;
  const serverClosed = new Promise((r) => (closed = r));
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"tick":0}\n');
    const iv = setInterval(() => res.write('{"tick":1}\n'), 20);
    res.on('close', () => {
      clearInterval(iv);
      closed();
    });
  });
  try {
    const ac = new AbortController();
    const r = await t.fetch('/api/v1/chat/x', { method: 'POST', body: '{}', signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read();
    ac.abort();
    await assert.rejects(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) throw new Error('the stream ended instead of failing');
      }
    }, (e) => e.name === 'AbortError');
    await serverClosed;
    await wait(20);
    assert.equal(t.bridge.size, 0);
  } finally {
    await t.close();
  }
});

test('an AbortSignal that is already aborted, or aborted before the answer, rejects fetch()', async () => {
  const t = await setup(() => {}); // never answers
  try {
    const done = new AbortController();
    done.abort();
    await assert.rejects(t.fetch('/api/x', { signal: done.signal }), (e) => e.name === 'AbortError');
    const ac = new AbortController();
    const p = t.fetch('/api/never', { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    await wait(50);
    assert.equal(t.bridge.size, 0);
  } finally {
    await t.close();
  }
});

test('reader.cancel() destroys the server\'s request', async () => {
  let closed;
  const serverClosed = new Promise((r) => (closed = r));
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('x');
    res.on('close', closed);
  });
  try {
    const r = await t.fetch('/api/s');
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    await serverClosed;
  } finally {
    await t.close();
  }
});

test('request bodies: a large Blob goes in pieces and arrives exactly', async () => {
  const data = crypto.randomBytes(PART_BYTES * 3 + 12345);
  let received = null;
  const t = await setup((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ len: received.length, type: req.headers['content-type'] }));
    });
  });
  try {
    const r = await t.fetch('/api/upload', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([data]) });
    assert.deepEqual(await r.json(), { len: data.length, type: 'application/octet-stream' });
    assert.equal(sha(received), sha(data));
    const parts = t.pair.log.filter((m) => m.dir === 'page->core' && m.channel === 'fetch:part').length;
    assert.equal(parts, 4, 'a body above one piece is sent as pieces (3 full ones and the rest), after the open');
  } finally {
    await t.close();
  }
});

test('request bodies: a large string, FormData with a file, URLSearchParams and a Request object', async () => {
  const seen = [];
  const t = await setup((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ type: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.writeHead(204);
      res.end();
    });
  });
  try {
    const big = 'ß'.repeat(PART_BYTES); // 2 bytes per character: more than one piece
    await t.fetch('/api/s', { method: 'POST', body: big });
    assert.equal(seen[0].body.toString('utf8'), big);

    const fd = new FormData();
    fd.append('name', 'a.txt');
    fd.append('file', new Blob(['file-bytes-\u0000ÿ'], { type: 'text/plain' }), 'a.txt');
    await t.fetch('/api/f', { method: 'POST', body: fd });
    assert.match(seen[1].type, /^multipart\/form-data; boundary=/);
    assert.ok(seen[1].body.includes(Buffer.from('file-bytes-')));
    assert.ok(seen[1].body.includes(Buffer.from('filename="a.txt"')));

    await t.fetch('/api/u', { method: 'POST', body: new URLSearchParams({ a: '1', b: 'x y' }) });
    assert.match(seen[2].type, /^application\/x-www-form-urlencoded/);
    assert.equal(seen[2].body.toString(), 'a=1&b=x+y');

    await t.fetch(new Request('vmapp-ui://app.test/api/r', { method: 'POST', body: 'from a request', headers: { 'x-a': 'b' } }));
    assert.equal(seen[3].body.toString(), 'from a request');
  } finally {
    await t.close();
  }
});

test('a server that dies mid-answer fails the stream with a TypeError; one that is down fails fetch()', async () => {
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(1000));
    setTimeout(() => res.socket.destroy(), 20);
  });
  try {
    const r = await t.fetch('/api/die');
    await assert.rejects(r.arrayBuffer(), (e) => e instanceof TypeError);
    assert.equal(t.bridge.size, 0);
  } finally {
    await t.close();
  }
  const down = await setup(() => {});
  await new Promise((r) => down.server.close(r));
  try {
    await assert.rejects(down.fetch('/api/x'), (e) => e instanceof TypeError && /Failed to fetch/.test(e.message));
  } finally {
    down.bridge.close();
  }
});

test('what is not for the bridge: other prefixes and other origins go to the real fetch', async () => {
  const t = await setup(() => {});
  try {
    assert.equal(await (await t.fetch('/assets/x.js')).text(), 'real fetch');
    assert.equal(await (await t.fetch('https://example.com/api/x')).text(), 'real fetch');
    assert.equal(await (await t.fetch('vmapp-ui://other.app/api/x')).text(), 'real fetch', 'another app\'s origin is not ours');
    assert.deepEqual(t.fallthrough, ['/assets/x.js', 'https://example.com/api/x', 'vmapp-ui://other.app/api/x']);
    // the page's own origin with the port an HTTP client library adds (ollama-js: "vmapp-ui://app.test:80/api/tags") is still the page
    const ok = await setup((req, res) => res.end('answered'));
    try {
      assert.equal(await (await ok.fetch('vmapp-ui://app.test:80/api/x')).text(), 'answered');
    } finally {
      await ok.close();
    }
    assert.equal(t.pair.log.filter((m) => m.channel.startsWith('fetch:')).length, 0, 'nothing went over the bridge');
  } finally {
    await t.close();
  }
});

test('the core refuses what a page must not do', async () => {
  const t = await setup((req, res) => res.end('ok'), { maxConcurrent: 2, methods: ['GET', 'POST'] });
  try {
    const call = (r) => t.pair.vmapp.invoke('fetch:open', r);
    await assert.rejects(call({ id: 'a1', method: 'TRACE', path: '/api/x' }), /method not allowed/);
    await assert.rejects(call({ id: 'a2', method: 'GET', path: '/other' }), /path not allowed/);
    await assert.rejects(call({ id: 'a3', method: 'GET', path: '//evil.example/api/' }), /bad path/);
    await assert.rejects(call({ id: 'a4', method: 'GET', path: '/api/x y' }), /bad path/);
    await assert.rejects(call({ id: 'a5', method: 'GET', path: '/api/x\r\nX: y' }), /bad path/);
    await assert.rejects(call({ id: '', method: 'GET', path: '/api/x' }), /bad request id/);
    await assert.rejects(call({ id: 'a6', method: 'POST', path: '/api/x', length: 5, text: 'too long body' }), /longer than announced/);
    await assert.rejects(t.pair.vmapp.invoke('fetch:part', { id: 'nope', b64: '' }), /unknown request/);
    // two held-open requests fill the limit; the third is refused
    const hold = http.createServer(() => {});
    await new Promise((r) => hold.listen(0, '127.0.0.1', r));
    const t2 = await setup(() => {}, { maxConcurrent: 2 });
    try {
      await t2.pair.vmapp.invoke('fetch:open', { id: 'h1', method: 'GET', path: '/api/hold' });
      await t2.pair.vmapp.invoke('fetch:open', { id: 'h2', method: 'GET', path: '/api/hold' });
      await assert.rejects(t2.pair.vmapp.invoke('fetch:open', { id: 'h3', method: 'GET', path: '/api/hold' }), /too many requests/);
      await assert.rejects(t2.pair.vmapp.invoke('fetch:open', { id: 'h1', method: 'GET', path: '/api/hold' }), /duplicate request id/);
    } finally {
      await t2.close();
      await new Promise((r) => hold.close(r));
    }
  } finally {
    await t.close();
  }
});

test('the core only talks to the loopback', () => {
  const pair = bridgePair();
  assert.throws(() => attach(pair.ipcMain, { host: '10.0.0.5', port: 1, prefixes: ['/api/'] }), /loopback/);
  assert.throws(() => attach(pair.ipcMain, { port: 1, prefixes: ['api'] }), /prefixes/);
});

test('two servers on one page: routes, a mount point (strip) and an allow list', async () => {
  const mk = (name) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ server: name, method: req.method, url: req.url }));
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
  };
  const a = await mk('ui');
  const b = await mk('raw');
  const pair = bridgePair();
  const bridgeA = attach(pair.ipcMain, { port: a.address().port, prefixes: ['/api/'] });
  const allowed = [];
  const bridgeB = attach(pair.ipcMain, {
    channel: 'raw', port: b.address().port, strip: '/ollama', prefixes: ['/api/'],
    allow: (method, p) => (allowed.push(`${method} ${p}`), method === 'GET' && p === '/api/tags') || (method === 'POST' && p === '/api/show'),
  });
  const page = createFetch({ vmapp: pair.vmapp, location: LOCATION, routes: [{ prefix: '/api/', channel: 'fetch' }, { prefix: '/ollama/', channel: 'raw' }], realFetch: async () => new Response('real') });
  try {
    assert.deepEqual(await (await page.fetch('/api/v1/chats')).json(), { server: 'ui', method: 'GET', url: '/api/v1/chats' });
    assert.deepEqual(await (await page.fetch('/ollama/api/tags?x=1')).json(), { server: 'raw', method: 'GET', url: '/api/tags?x=1' });
    assert.deepEqual(await (await page.fetch('/ollama/api/show', { method: 'POST', body: '{}' })).json(), { server: 'raw', method: 'POST', url: '/api/show' });
    await assert.rejects(page.fetch('/ollama/api/delete', { method: 'DELETE', body: '{}' }), /DELETE \/api\/delete is not available here/);
    await assert.rejects(page.fetch('/ollama/api/create', { method: 'POST', body: '{}' }), /not available here/);
    // the mount point is not a way to reach the other server's paths, and the raw channel does not serve the page's own prefix
    await assert.rejects(pair.vmapp.invoke('raw:open', { id: 'x1', method: 'GET', path: '/api/tags' }), /path not allowed/);
    await assert.rejects(pair.vmapp.invoke('raw:open', { id: 'x2', method: 'GET', path: '/ollamax/api/tags' }), /path not allowed/);
    assert.ok(allowed.includes('GET /api/tags'), 'the allow function sees the path without the mount point and the query');
  } finally {
    bridgeA.close();
    bridgeB.close();
    await new Promise((r) => a.close(r));
    await new Promise((r) => b.close(r));
  }
});

test('closing the window ends the request the page can no longer read', async () => {
  let closed;
  const serverClosed = new Promise((r) => (closed = r));
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const iv = setInterval(() => res.write('{"t":1}\n'), 10);
    res.on('close', () => {
      clearInterval(iv);
      closed();
    });
  });
  try {
    const r = await t.fetch('/api/v1/chat/x');
    await r.body.getReader().read();
    t.pair.destroyWindow();
    await serverClosed;
    await wait(20);
    assert.equal(t.bridge.size, 0);
  } finally {
    await t.close();
  }
});
