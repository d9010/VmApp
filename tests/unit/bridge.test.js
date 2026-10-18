'use strict';
// SDK <-> hostlib bridge, in-process on the host side: the SDK app runs as a child process, a BridgeClient attaches
// to its socket (no vmapp-vm involved).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const cp = require('child_process');
const { BridgeClient } = require('../../hostlib/bridge');
const { wait } = require('./helpers');

const APP = path.join(__dirname, 'fixtures', 'app-main.js');

async function until(cond, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

/** Starts the fixture app; returns helpers. `answer(op, params)` may override request answers. */
async function startApp(t, { answer, stale = false, env = {} } = {}) {
  const dir = fs.mkdtempSync('/tmp/vmapp-t-');
  const sock = path.join(dir, 'b.sock');
  if (stale) fs.writeFileSync(sock, 'stale');
  const marks = path.join(dir, 'marks.txt');
  const child = cp.spawn(process.execPath, [APP], {
    env: Object.assign({}, process.env, { VMAPP_SOCKET: sock, APP_MARKS: marks }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const requests = [];
  const events = []; // chronological: 'ready' | 'request:<op>'
  const emits = [];
  const logs = [];
  let nextWin = 7;
  const makeClient = () => {
    const c = new BridgeClient({
      socketPath: sock,
      onRequest: async (op, params) => {
        requests.push({ op, params });
        events.push('request:' + op);
        if (answer) {
          const a = await answer(op, params);
          if (a !== undefined) return a;
        }
        if (op === 'window.create') return { win: nextWin++ };
        return {};
      },
    });
    c.on('ready', () => events.push('ready'));
    c.on('emit', (m) => emits.push(m));
    c.on('log', (l) => logs.push(l));
    return c;
  };
  const client = makeClient();
  t.after(() => {
    client.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(5000);
  return { dir, sock, child, exited, client, makeClient, requests, events, emits, logs, marks, stderr: () => stderr };
}

const INIT = {
  app: { id: 'com.example.notes', name: 'Notes', version: '1.2.3' },
  platform: { os: 'linux', arch: 'arm64' },
  folders: { notes: '/host/f-notes', export: null },
  data: '/data',
};

async function boot(t, opts) {
  const a = await startApp(t, opts);
  a.client.init(INIT);
  await a.client.waitReady(5000);
  await until(() => a.requests.some((r) => r.op === 'window.create'), 5000, 'window.create');
  await until(() => a.emits.some((e) => e.channel === 'hello'), 5000, 'hello emit');
  return a;
}

test('init -> ready ordering, window.create, queued emits delivered after creation', async (t) => {
  const a = await boot(t);
  // ready is written before the window.create request the whenReady callback causes
  assert.ok(a.events.indexOf('ready') >= 0 && a.events.indexOf('ready') < a.events.indexOf('request:window.create'), a.events.join(','));
  const create = a.requests.find((r) => r.op === 'window.create');
  assert.deepEqual(create.params, { entry: 'index.html', width: 640, height: 480, title: 'Fixture', devTools: false }, 'DevTools default to off: the SDK sends devTools:false');
  // 'early' was sent before the window existed: queued, then delivered with the real window id
  assert.deepEqual(a.emits.map((e) => [e.win, e.channel]), [[7, 'early'], [7, 'hello']]);
  assert.deepEqual(a.emits[0].args, [1, 2]);
  assert.deepEqual(a.emits[1].args, [{ name: 'Notes', version: '1.2.3', data: '/data' }]);
  assert.deepEqual(await a.client.invoke(7, 'order', []), ['ready-event', 'whenReady']);
  assert.deepEqual(await a.client.invoke(7, 'folders', []), { notes: '/host/f-notes', export: null });
});

test('invoke: results, undefined, errors carry only the message', async (t) => {
  const a = await boot(t);
  const c = a.client;
  assert.deepEqual(await c.invoke(7, 'echo', [1, 'two', { three: [3] }, null]), [1, 'two', { three: [3] }, null]);
  assert.equal(await c.invoke(7, 'nothing', []), null);
  await assert.rejects(c.invoke(7, 'fail', []), (e) => e.message === 'boom' && !/\n\s+at /.test(e.message));
  await assert.rejects(c.invoke(7, 'fail-async', []), (e) => e.message === 'async boom');
  await assert.rejects(c.invoke(7, 'nope', []), /No handler registered for 'nope'/);
  await assert.rejects(c.invoke(7, 'circular', []), /circular|serial/i);
  assert.deepEqual(await c.invoke(7, 'who', []), { win: 7, same: true });
  assert.deepEqual(await c.invoke(7, 'windows', []), [7]);
  assert.equal(await c.invoke(7, 'from-id', [7]), 'win');
  assert.equal(await c.invoke(7, 'from-id', [99]), 'null');
  // many in flight at once
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => c.invoke(7, 'echo', [i])));
  assert.deepEqual(rs.map((r) => r[0]), Array.from({ length: 50 }, (_, i) => i));
});

test('large payloads cross the bridge in both directions', async (t) => {
  const a = await boot(t);
  const big = 'x'.repeat(3 * 1024 * 1024);
  const r = await a.client.invoke(7, 'echo', [big]);
  assert.equal(r[0].length, big.length);
});

test('send reaches ipcMain.on; webContents.send arrives as emit; listener errors are logged', async (t) => {
  const a = await boot(t);
  a.emits.length = 0;
  a.client.sendToCore(7, 'ping', ['hi', 2]);
  await until(() => a.emits.some((e) => e.channel === 'pong'), 5000, 'pong');
  assert.deepEqual(a.emits.find((e) => e.channel === 'pong').args, ['hi']);
  await a.client.invoke(7, 'emit', ['custom', { a: 1 }, [2]]);
  await until(() => a.emits.some((e) => e.channel === 'custom'), 5000, 'custom');
  assert.deepEqual(a.emits.find((e) => e.channel === 'custom'), { t: 'emit', win: 7, channel: 'custom', args: [{ a: 1 }, [2]] });
  a.client.sendToCore(7, 'throws', []);
  await until(() => a.logs.some((l) => l.level === 'error' && /listener failure/.test(l.message)), 5000, 'error log');
  // still alive afterwards
  assert.deepEqual(await a.client.invoke(7, 'echo', ['alive']), ['alive']);
});

test('window requests: setTitle, focus, second window, close', async (t) => {
  const a = await boot(t);
  await a.client.invoke(7, 'title', ['New title']);
  await a.client.invoke(7, 'focus', []);
  const id2 = await a.client.invoke(7, 'second-window', []);
  assert.equal(id2, 8);
  assert.deepEqual(await a.client.invoke(7, 'windows', []), [7, 8]);
  await a.client.invoke(7, 'close-win', []);
  await until(() => a.requests.some((r) => r.op === 'window.close'), 5000, 'window.close');
  const ops = a.requests.map((r) => r.op + ':' + (r.params.win || ''));
  assert.ok(ops.includes('window.setTitle:7'));
  assert.ok(ops.includes('window.focus:7'));
  assert.ok(ops.includes('window.close:7'));
  assert.equal(a.requests.find((r) => r.op === 'window.setTitle').params.title, 'New title');
  assert.deepEqual(a.requests.filter((r) => r.op === 'window.create').map((r) => r.params.entry), ['index.html', 'second.html']);
  // closing one of two windows does not quit
  a.client.windowEvent(7, 'closed', {});
  await wait(150);
  assert.equal(a.child.exitCode, null);
  assert.deepEqual(await a.client.invoke(8, 'windows', []), [8]);
});

test('BrowserWindow webPreferences: only devTools === true is sent (default false); the other keys are ignored, warned once', async (t) => {
  const a = await boot(t);
  assert.equal(await a.client.invoke(7, 'second-window', []), 8);
  assert.equal(await a.client.invoke(7, 'third-window', []), 9);
  const creates = a.requests.filter((r) => r.op === 'window.create');
  assert.deepEqual(creates.map((r) => r.params.devTools), [false, true, false], 'no webPreferences: false; devTools:true: true; devTools:"yes": false');
  assert.ok(creates.every((r) => !('webPreferences' in r.params) && !('preload' in r.params) && !('sandbox' in r.params) && !('nodeIntegration' in r.params)), 'no other webPreferences key is forwarded');
  await until(() => a.logs.some((l) => /webPreferences are ignored/.test(l.message)), 5000, 'the webPreferences warning');
  const warns = a.logs.filter((l) => /webPreferences are ignored/.test(l.message));
  assert.equal(warns.length, 1, 'one warning per run, however many windows');
  assert.equal(warns[0].level, 'warn');
  assert.match(warns[0].message, /: preload, sandbox$/, 'it names the ignored keys of the first window, not devTools');
});

test('window-all-closed default quits: before-quit listeners run, app.quit request, exit 0', async (t) => {
  const a = await boot(t);
  a.client.windowEvent(7, 'closed', {});
  const r = await Promise.race([a.exited, wait(8000).then(() => 'timeout')]);
  assert.notEqual(r, 'timeout', a.stderr());
  assert.equal(r.code, 0);
  assert.ok(a.requests.some((x) => x.op === 'app.quit'), 'app.quit request');
  assert.equal(fs.readFileSync(a.marks, 'utf8').trim(), 'before-quit');
});

test('app.quit() from a handler: request goes out and the process exits', async (t) => {
  const a = await boot(t);
  await a.client.invoke(7, 'quit', []);
  const r = await a.exited;
  assert.equal(r.code, 0);
  assert.ok(a.requests.some((x) => x.op === 'app.quit'));
});

test('host before-quit: listeners run, no app.quit request, exit 0', async (t) => {
  const a = await boot(t);
  a.client.beforeQuit();
  const r = await a.exited;
  assert.equal(r.code, 0);
  assert.ok(!a.requests.some((x) => x.op === 'app.quit'));
  assert.equal(fs.readFileSync(a.marks, 'utf8').trim(), 'before-quit');
});

test('bridge connection closing makes the SDK process exit 0', async (t) => {
  const a = await boot(t);
  a.client.close();
  const r = await Promise.race([a.exited, wait(5000).then(() => 'timeout')]);
  assert.notEqual(r, 'timeout');
  assert.equal(r.code, 0);
});

test('stale socket file is replaced; a second connection replaces the first', async (t) => {
  const a = await startApp(t, { stale: true });
  a.client.init(INIT);
  await a.client.waitReady(5000);
  const second = a.makeClient();
  await second.connect(2000);
  second.init(INIT);
  await second.waitReady(5000);
  // the old connection was closed by the SDK; the process is still alive and talks to the new one
  await until(() => !a.client.connected, 3000, 'old connection closed');
  assert.equal(a.child.exitCode, null);
  assert.deepEqual(await second.invoke(7, 'echo', ['x']), ['x']);
  second.close();
  const r = await a.exited;
  assert.equal(r.code, 0);
});

test('dialog / shell round trips with the host answers', async (t) => {
  const asked = [];
  const a = await boot(t, {
    answer: (op, params) => {
      if (op.startsWith('dialog.') || op === 'shell.openExternal') asked.push({ op, params });
      if (op === 'dialog.open') return params.multiple ? { canceled: false, paths: ['/host/pick-0/a', '/host/pick-1/b'] } : { canceled: true };
      if (op === 'dialog.save') return { canceled: false, path: '/host/save-0/' + params.defaultName };
      if (op === 'dialog.message') return { response: 1 };
      if (op === 'shell.openExternal') return { opened: params.url.startsWith('https://ok') };
    },
  });
  const c = a.client;
  assert.deepEqual(await c.invoke(7, 'dialog:open', [true, true]), { canceled: false, filePaths: ['/host/pick-0/a', '/host/pick-1/b'] });
  assert.deepEqual(await c.invoke(7, 'dialog:open', [false, false]), { canceled: true, filePaths: [] });
  assert.deepEqual(await c.invoke(7, 'dialog:save', ['/some/where/report.html']), { canceled: false, filePath: '/host/save-0/report.html' });
  assert.deepEqual(await c.invoke(7, 'dialog:msg', []), { response: 1, checkboxChecked: false });
  assert.equal(await c.invoke(7, 'external', ['https://ok.example/x']), true);
  assert.equal(await c.invoke(7, 'external', ['https://no.example/x']), false);
  assert.deepEqual(asked[0], { op: 'dialog.open', params: { win: 7, title: 'Pick', directory: true, multiple: true } });
  assert.deepEqual(asked[1].params, { win: 7, title: 'Pick', directory: false, multiple: false });
  assert.deepEqual(asked[2].params, { title: 'Save', defaultName: 'report.html' }); // fixture passes no window
  assert.deepEqual(asked[3].params, { win: 7, type: 'question', message: 'Sure?', detail: 'really', buttons: ['No', 'Yes'] });
});

test('errors from host requests reject in the SDK with the message (permission denied)', async (t) => {
  const a = await boot(t, {
    answer: (op) => {
      if (op === 'dialog.open') throw new Error('permission denied: dialogs');
      if (op === 'shell.openExternal') throw new Error('permission denied: external');
    },
  });
  await assert.rejects(a.client.invoke(7, 'dialog:open', [true, false]), /permission denied: dialogs/);
  await assert.rejects(a.client.invoke(7, 'external', ['https://x.example']), /permission denied: external/);
});

test('unknown host message types are ignored (the SDK logs a warning and keeps working)', async (t) => {
  const a = await boot(t);
  a.client.send({ t: 'mystery', x: 1 });
  await until(() => a.logs.some((l) => l.level === 'warn' && /mystery/.test(l.message)), 5000, 'warn log');
  assert.deepEqual(await a.client.invoke(7, 'echo', [1]), [1]);
  // malformed line
  await new Promise((resolve) => a.client.socket.write('{not json\n', resolve));
  await until(() => a.logs.some((l) => /malformed/.test(l.message)), 5000, 'malformed log');
  assert.deepEqual(await a.client.invoke(7, 'echo', [2]), [2]);
});

test('BridgeClient: connect times out on a missing socket and rejects pending invokes on close', async () => {
  const c = new BridgeClient({ socketPath: '/tmp/vmapp-nonexistent/none.sock' });
  const t0 = Date.now();
  await assert.rejects(c.connect(300), /cannot connect/);
  assert.ok(Date.now() - t0 >= 250);
  // a server that never answers
  const dir = fs.mkdtempSync('/tmp/vmapp-t-');
  const sock = path.join(dir, 's.sock');
  const server = net.createServer((s) => setTimeout(() => s.destroy(), 100));
  await new Promise((r) => server.listen(sock, r));
  try {
    const c2 = new BridgeClient({ socketPath: sock });
    await c2.connect(1000);
    await assert.rejects(c2.invoke(1, 'x', []), /bridge closed/);
    await assert.rejects(c2.waitReady(100), /bridge closed|did not send ready/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
