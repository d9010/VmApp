'use strict';
// The launcher answering an app's page natively (loader/src/app-serve.js, loader/src/protocols.js; SPEC 7 "Files the app's server serves"), with
// Electron's protocol.handle contract: a standard Request in, a standard Response with a streamed body out. A real HTTP server on 127.0.0.1, the
// real core half of the bridge (sdk/node/http-bridge.js) and the real client half (sdk/web/vmapp-fetch.js), joined by a fake host session that behaves
// like hostlib/session.js where it matters (the core answers a window; the launcher reads its own events with tapEmit before the window gets them).
// No VM and no Electron. The real thing, in a real window, is tests/apps/media-probe-ui.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppServe, cleanRoutes, MAX_ACTIVE } = require('../../loader/src/app-serve');
const { createAppUiHandler } = require('../../loader/src/protocols');
const { attach } = require('../../sdk/node/http-bridge.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const APP = 'dev.test.app';

/** A host session whose "core" is the real http-bridge attached to a fake ipcMain. */
function fakeSession(port, bridgeOptions = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const taps = new Map();
  const windowEvents = [];
  const sess = {
    windows: new Set([1]),
    windowEvents,
    tapEmit(channel, fn) {
      if (!taps.has(channel)) taps.set(channel, new Set());
      taps.get(channel).add(fn);
      return () => taps.get(channel).delete(fn);
    },
    // what hostlib/session.js _onCoreEmit does: the launcher's taps first, the window for what they do not take
    _emit(win, channel, args) {
      const set = taps.get(channel);
      let consumed = false;
      if (set) for (const fn of [...set]) if (fn(JSON.parse(JSON.stringify(args)), win) === true) consumed = true;
      if (!consumed) windowEvents.push({ win, channel, args });
    },
    async invoke(win, channel, args) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`No handler registered for '${channel}'`);
      const sender = {
        send: (ch, ...a) => setImmediate(() => sess._emit(win, ch, a)),
        isDestroyed: () => false,
      };
      return JSON.parse(JSON.stringify((await h({ sender }, ...JSON.parse(JSON.stringify(args)))) ?? null));
    },
    send(win, channel, args) {
      const sender = { send: (ch, ...a) => setImmediate(() => sess._emit(win, ch, a)), isDestroyed: () => false };
      setImmediate(() => {
        for (const fn of listeners.get(channel) || []) fn({ sender }, ...JSON.parse(JSON.stringify(args)));
      });
      return true;
    },
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
  sess.bridge = attach(ipcMain, { port, prefixes: ['/assets/', '/api/'], ...bridgeOptions });
  return sess;
}

async function setup(t, handler, { bridgeOptions, serve = {} } = {}) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sess = fakeSession(server.address().port, bridgeOptions);
  const logs = [];
  const state = { sess };
  const appServe = new AppServe({ appId: APP, getSession: () => state.sess, csp: "default-src 'self'", log: (m) => logs.push(m), ...serve });
  t.after(async () => {
    appServe.close();
    sess.bridge.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const req = (p, init) => new Request(`vmapp-ui://${APP}${p}`, init);
  return { server, sess, appServe, logs, state, req };
}

test('cleanRoutes: only safe prefixes of an app\'s server, never the whole origin', () => {
  assert.deepEqual(cleanRoutes([{ prefix: '/assets/', channel: 'fetch' }, { prefix: '/vscode-remote-resource', channel: 'fetch' }]), [
    { prefix: '/assets/', channel: 'fetch' },
    { prefix: '/vscode-remote-resource', channel: 'fetch' },
  ]);
  for (const bad of [
    [],
    null,
    'x',
    [{}],
    [{ prefix: '/', channel: 'fetch' }], // the whole origin: the page itself
    [{ prefix: 'assets/', channel: 'fetch' }],
    [{ prefix: '/a?b=1', channel: 'fetch' }],
    [{ prefix: '/a#b', channel: 'fetch' }],
    [{ prefix: '/../x', channel: 'fetch' }],
    [{ prefix: '/./x', channel: 'fetch' }],
    [{ prefix: '/a b', channel: 'fetch' }],
    [{ prefix: `/${'a'.repeat(300)}`, channel: 'fetch' }],
    [{ prefix: '/ok/', channel: 'bad channel' }],
    [{ prefix: '/ok/', channel: '1x' }],
    [{ prefix: '/ok/', channel: 7 }],
    Array.from({ length: 17 }, (_, i) => ({ prefix: `/p${i}/`, channel: 'fetch' })),
  ]) assert.throws(() => cleanRoutes(bad), /vmapp\.serve/, JSON.stringify(bad).slice(0, 60));
});

test('a request under an announced path is answered by the app\'s server: status, headers and every byte', async (t) => {
  const png = crypto.randomBytes(200 * 1024);
  const x = await setup(t, (req, res) => {
    if (req.url === '/assets/pic.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'x-custom': 'yes', 'content-length': png.length });
      return res.end(png);
    }
    if (req.url === '/assets/gone') {
      res.writeHead(404, { 'x-reason': 'not here', 'content-type': 'text/plain' });
      return res.end('missing');
    }
    if (req.url === '/assets/none') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  });
  assert.equal(x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]), true);
  const r = await x.appServe.handle(x.req('/assets/pic.png'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-custom'), 'yes');
  assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(png), 'every byte');
  const g = await x.appServe.handle(x.req('/assets/gone'));
  assert.deepEqual([g.status, g.headers.get('x-reason'), await g.text()], [404, 'not here', 'missing'], 'a 404 stays a 404, with its headers and body');
  const n = await x.appServe.handle(x.req('/assets/none'));
  assert.deepEqual([n.status, await n.text()], [204, ''], 'an empty answer');
  const c = await x.appServe.handle(x.req('/assets/made', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }));
  assert.deepEqual([c.status, await c.json()], [201, { ok: true }], 'a request with a body');
  assert.deepEqual(x.sess.windowEvents, [], 'the window never saw any of the core\'s events for these requests');
});

test('Range reaches the server and a 206 comes back with its Content-Range (what <video> and <audio> need)', async (t) => {
  const data = crypto.randomBytes(5000);
  const seen = [];
  const x = await setup(t, (req, res) => {
    seen.push(req.headers.range || null);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': data.length });
      return res.end(data);
    }
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : data.length - 1;
    res.writeHead(206, { 'content-type': 'video/webm', 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 });
    return res.end(data.subarray(start, end + 1));
  });
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  const r = await x.appServe.handle(x.req('/assets/v.webm', { headers: { range: 'bytes=1000-1999' } }));
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 1000-1999/5000');
  assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(data.subarray(1000, 2000)));
  assert.deepEqual(seen, ['bytes=1000-1999']);
});

test('the server\'s redirect comes back as a redirect (the browser follows it, as with Electron\'s own handler)', async (t) => {
  const x = await setup(t, (req, res) => {
    res.writeHead(302, { location: '/assets/real.png' });
    res.end();
  });
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  const r = await x.appServe.handle(x.req('/assets/old.png'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/assets/real.png');
});

test('a failure is a network error, as in Electron: not a made-up HTTP status', async (t) => {
  const x = await setup(t, (req, res) => res.end('x'));
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  // the app has no window (so the core has nobody to answer): Response.error()
  x.sess.windows.clear();
  const r = await x.appServe.handle(x.req('/assets/a'));
  assert.equal(r.type, 'error');
  assert.match(x.logs.at(-1), /the app is not running/);
  // no session at all
  x.state.sess = null;
  assert.equal((await x.appServe.handle(x.req('/assets/a'))).type, 'error');
});

test('a server that is down is a network error too, and the launcher keeps working', async (t) => {
  const x = await setup(t, (req, res) => res.end('x'));
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  await new Promise((r) => x.server.close(r));
  const r = await x.appServe.handle(x.req('/assets/a'));
  assert.ok(r.type === 'error' || r.status >= 500, `an error (${r.type} ${r.status})`);
});

test('what the core says in an HTML answer is still under the window\'s policy; other answers are untouched', async (t) => {
  const x = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': req.url.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end('x');
  });
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  assert.equal((await x.appServe.handle(x.req('/assets/p.html'))).headers.get('content-security-policy'), "default-src 'self'");
  assert.equal((await x.appServe.handle(x.req('/assets/p.txt'))).headers.get('content-security-policy'), null);
});

test('the page\'s own fetch events are not taken: only the events of the launcher\'s own requests', async (t) => {
  const x = await setup(t, (req, res) => res.end('x'));
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  await (await x.appServe.handle(x.req('/assets/a'))).text(); // makes the client and its tap
  // an event for some id the launcher never made, as the page's own bridged fetch would get: it goes on to the window
  x.sess._emit(1, 'fetch:ev', [{ id: 'f9-page', t: 'head', status: 200, headers: [] }]);
  assert.equal(x.sess.windowEvents.length, 1);
  assert.equal(x.sess.windowEvents[0].args[0].id, 'f9-page');
});

test('at most MAX_ACTIVE requests are in flight; the rest wait their turn and all of them complete', async (t) => {
  let now = 0;
  let peak = 0;
  const releaseAll = [];
  const x = await setup(
    t,
    (req, res) => {
      now++;
      peak = Math.max(peak, now);
      releaseAll.push(() => {
        now--;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(req.url);
      });
    },
    { bridgeOptions: { maxConcurrent: 256 } },
  );
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  const total = MAX_ACTIVE * 2 + 5;
  const results = Array.from({ length: total }, (_, i) => x.appServe.handle(x.req(`/assets/${i}`)).then((r) => r.text()));
  await wait(400);
  assert.equal(peak, MAX_ACTIVE, 'no more than MAX_ACTIVE at the server');
  // let them finish, a wave at a time
  for (let waves = 0; waves < 10 && releaseAll.length; waves++) {
    for (const f of releaseAll.splice(0)) f();
    await wait(150);
  }
  const bodies = await Promise.all(results);
  assert.deepEqual(bodies.sort(), Array.from({ length: total }, (_, i) => `/assets/${i}`).sort());
  assert.ok(peak <= MAX_ACTIVE);
});

test('a body that is cancelled gives its place back (a window that went away does not hold the queue)', async (t) => {
  const x = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    if (req.url === '/assets/endless') {
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 5);
      res.on('close', () => clearInterval(timer));
    } else res.end('quick');
  });
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  const open = [];
  for (let i = 0; i < MAX_ACTIVE; i++) {
    const r = await x.appServe.handle(x.req('/assets/endless'));
    const reader = r.body.getReader();
    await reader.read();
    open.push(reader);
  }
  const queued = x.appServe.handle(x.req('/assets/after')).then((r) => r.text());
  await wait(200);
  assert.equal(x.appServe.active, MAX_ACTIVE, 'all places are taken');
  await open[0].cancel(); // one body is dropped
  assert.equal(await queued, 'quick', 'the waiting request got the freed place');
  for (const reader of open.slice(1)) await reader.cancel();
  await wait(100);
  assert.equal(x.appServe.active, 0, 'every place is back');
});

test('covers(): announced paths yes; before the announcement a request waits for it, once; a disabled launcher never covers', async (t) => {
  const x = await setup(t, (req, res) => res.end('x'));
  // before the page announced: a request for a file the package lacks waits, then is answered by the announcement
  const early = x.appServe.covers('/assets/pic.png');
  await wait(50);
  x.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]);
  assert.equal(await early, true, 'a request that arrived before the announcement is covered by it');
  assert.equal(await x.appServe.covers('/assets/other'), true);
  assert.equal(await x.appServe.covers('/index.html'), false, 'a path outside the announced ones is not');

  // a run in which the page never announces: the first such request waits at most WAIT_MS, and later ones do not wait at all
  const y = await setup(t, (req, res) => res.end('x'));
  const t0 = Date.now();
  assert.equal(await y.appServe.covers('/missing.png'), false);
  assert.ok(Date.now() - t0 >= 2000 && Date.now() - t0 < 4500, `waited ${Date.now() - t0} ms`);
  const t1 = Date.now();
  assert.equal(await y.appServe.covers('/missing2.png'), false);
  assert.ok(Date.now() - t1 < 100, 'only once per run');

  // switched off (a test flag of development builds): announce answers false, nothing is covered, nothing waits
  const z = await setup(t, (req, res) => res.end('x'), { serve: { enabled: false } });
  assert.equal(z.appServe.announce([{ prefix: '/assets/', channel: 'fetch' }]), false);
  const t2 = Date.now();
  assert.equal(await z.appServe.covers('/assets/a'), false);
  assert.ok(Date.now() - t2 < 100);
});

test('a new run of the app starts from what its own page announces', async (t) => {
  const x = await setup(t, (req, res) => res.end('x'));
  x.appServe.announce([{ prefix: '/old/', channel: 'fetch' }]);
  assert.equal(await x.appServe.covers('/old/a'), true);
  x.state.sess = { ...x.sess, windows: new Set([1]) }; // another session object: the app was restarted
  x.appServe.announce([{ prefix: '/new/', channel: 'fetch' }]);
  assert.equal(await x.appServe.covers('/new/a'), true);
  assert.equal(await x.appServe.covers('/old/a'), false, 'the old run\'s routes are gone');
});

// ------------------------------------------------------------------------------------------------ the vmapp-ui handler: the package first

function packageFixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = { ui: { root: 'ui', features: [] }, files: {} };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, 'ui', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    manifest.files[`ui/${name}`] = sha(Buffer.from(content));
  }
  return { app: { dir, manifest }, verified: new Map() };
}

test('vmapp-ui: a file of the package always wins, a tampered one is refused (never replaced by the core), the rest goes to the core', async (t) => {
  const ctx = packageFixture(t, { 'index.html': '<p>hi</p>', 'assets/inpackage.png': 'package bytes' });
  // tamper with one file after the manifest was made
  fs.writeFileSync(path.join(ctx.app.dir, 'ui', 'assets', 'inpackage.png'), 'TAMPERED');
  const asked = [];
  const bridge = {
    covers: async (appId, pathname) => pathname.startsWith('/assets/') || pathname.startsWith('/api/'),
    handle: async (appId, request) => {
      asked.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response('from the core', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  };
  const handler = createAppUiHandler(new Map([[APP, ctx]]), () => {}, bridge);
  const get = (p, init) => handler(new Request(`vmapp-ui://${APP}${p}`, init));

  assert.equal(await (await get('/index.html')).text(), '<p>hi</p>', 'a package file');
  const tampered = await get('/assets/inpackage.png');
  assert.equal(tampered.status, 404, 'a package file whose hash does not match is refused');
  assert.deepEqual(asked, [], 'and the core was never asked to stand in for it');
  const served = await get('/assets/other.png');
  assert.equal(await served.text(), 'from the core');
  assert.equal((await get('/api/x', { method: 'POST', body: 'data' })).status, 200, 'any method goes to the core; its bridge decides what is allowed');
  assert.deepEqual(asked, ['GET /assets/other.png', 'POST /api/x']);
  assert.equal((await get('/nothing-here.png')).status, 404, 'outside the announced paths: not found, the core is not asked');
  assert.equal((await get('/index.html', { method: 'POST', body: 'x' })).status, 405, 'a package file is still GET and HEAD only');
  assert.equal(asked.length, 2);
  assert.equal((await handler(new Request('vmapp-ui://some.other.app/assets/a.png'))).status, 404, 'an app that is not installed');
});

test('vmapp-ui: with no bridge at all (an older setup, or an app without one) the handler is exactly what it was', async (t) => {
  const ctx = packageFixture(t, { 'index.html': '<p>hi</p>' });
  const handler = createAppUiHandler(new Map([[APP, ctx]]), () => {});
  assert.equal(await (await handler(new Request(`vmapp-ui://${APP}/index.html`))).text(), '<p>hi</p>');
  assert.equal((await handler(new Request(`vmapp-ui://${APP}/assets/a.png`))).status, 404);
});

test('vmapp-ui: a core that cannot answer gives the page a network error, never a package file or a hang', async (t) => {
  const ctx = packageFixture(t, { 'index.html': '<p>hi</p>' });
  const bridge = { covers: async () => true, handle: async () => Response.error() };
  const handler = createAppUiHandler(new Map([[APP, ctx]]), () => {}, bridge);
  const r = await handler(new Request(`vmapp-ui://${APP}/assets/a.png`));
  assert.equal(r.type, 'error');
});

test('the host session lets the launcher take its own events (tapEmit) and passes every other event on to the window', () => {
  // hostlib/session.js: _onCoreEmit with taps, on a bare object (the method does not need the rest of a session)
  const { AppSession } = require('../../hostlib/session');
  const emitted = [];
  const self = Object.create(AppSession.prototype);
  self.log = () => {};
  self.wm = { emit: (win, channel, args) => emitted.push({ win, channel, args }) };
  const off = self.tapEmit('fetch:ev', (args) => args[0] && args[0].id === 'mine');
  self._onCoreEmit({ win: 3, channel: 'fetch:ev', args: [{ id: 'mine' }] });
  self._onCoreEmit({ win: 3, channel: 'fetch:ev', args: [{ id: 'theirs' }] });
  self._onCoreEmit({ win: 3, channel: 'other', args: [1] });
  assert.deepEqual(emitted.map((e) => e.args[0].id || e.args[0]), ['theirs', 1], 'the launcher\'s event was taken, the rest reached the window');
  off();
  self._onCoreEmit({ win: 3, channel: 'fetch:ev', args: [{ id: 'mine' }] });
  assert.equal(emitted.length, 3, 'once the tap is removed the event goes to the window again');
  // a tap that throws never loses an event
  self.tapEmit('boom', () => {
    throw new Error('x');
  });
  self._onCoreEmit({ win: 3, channel: 'boom', args: [9] });
  assert.equal(emitted.length, 4);
});
