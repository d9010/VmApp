'use strict';
// AppSession end to end without a VM: `vmapp-vm` is replaced by fixtures/fake-vmapp-vm.js, which speaks the same
// stdout/stdin protocol and runs the SDK fixture app on the requested socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AppSession, resolveFolders, buildVmArgs, sanitizeName, bridgePreview } = require('../../hostlib/session');
const { Store } = require('../../hostlib/store');
const { pack } = require('../../hostlib/package');
const { FakeWindowManager, FakeDialogs, FakeClipboard } = require('../../hostlib/headless');
const { tmpdir, rmrf, makeProject, wait } = require('./helpers');

const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const APP = path.join(__dirname, 'fixtures', 'app-main.js');
const ID = 'com.example.notes';

/** Creates a home with the app installed, a dummy runtime/kernel/initramfs, and two granted folders. */
function setup(t, { manifest, dialogs, grants, clipboard } = {}) {
  const d = tmpdir('sess-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest });
  const vmapp = path.join(d, 'a.vmapp');
  pack(proj, vmapp);
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(vmapp);
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  const kernel = path.join(d, 'Image');
  const initramfs = path.join(d, 'initramfs.cpio');
  fs.writeFileSync(kernel, 'k');
  fs.writeFileSync(initramfs, 'i');
  const notes = path.join(d, 'notes');
  const exportDir = path.join(d, 'export');
  fs.mkdirSync(notes);
  fs.mkdirSync(exportDir);
  const vmLog = path.join(d, 'vm.log');
  const marks = path.join(d, 'marks.txt');
  process.env.FAKE_VM_APP = APP;
  process.env.FAKE_VM_LOG = vmLog;
  process.env.APP_MARKS = marks;
  t.after(() => {
    delete process.env.FAKE_VM_APP;
    delete process.env.FAKE_VM_LOG;
    delete process.env.APP_MARKS;
    delete process.env.FAKE_VM_FAIL_GRANT;
    delete process.env.FAKE_VM_NO_READY;
  });
  const wm = new FakeWindowManager();
  const dlg = new FakeDialogs(dialogs);
  const logs = [];
  const session = new AppSession({
    appId: ID,
    home,
    vmappVmPath: [process.execPath, FAKE_VM],
    kernel,
    initramfs,
    grants: grants || {
      folders: { notes: { path: notes, access: 'readwrite' }, export: { path: exportDir, access: 'writeonly' } },
      askEveryTime: false,
    },
    windowManager: wm,
    dialogs: dlg,
    clipboard,
    onLog: (e) => logs.push(e),
    timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  const vmLines = () => (fs.existsSync(vmLog) ? fs.readFileSync(vmLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { d, home, store, session, wm, dlg, logs, notes, exportDir, vmLines, marks };
}

async function startRunning(s) {
  await s.session.start();
  await s.wm.waitForWindows(1, 5000);
  await s.wm.waitForEmit('hello', { timeoutMs: 5000 });
  return s;
}

test('start: vmapp-vm arguments, init folders, window, invoke/send/emit routing', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const { session, wm } = s;
  assert.equal(session.state, 'running');

  const argv = s.vmLines()[0].argv;
  const arg = (k) => argv[argv.indexOf(k) + 1];
  assert.equal(argv[0], 'run');
  assert.equal(arg('--kernel'), path.join(s.d, 'Image'));
  assert.equal(arg('--initramfs'), path.join(s.d, 'initramfs.cpio'));
  assert.equal(arg('--runtime'), path.join(s.home, 'runtimes', 'node22.img'));
  assert.equal(arg('--core'), path.join(s.home, 'apps', ID, '1.0.0', 'core.cpio'));
  assert.equal(arg('--appdata'), path.join(s.home, 'data', ID));
  assert.ok(arg('--socket').startsWith('/tmp/vmapp-') && arg('--socket').endsWith('/b.sock') && Buffer.byteLength(arg('--socket')) < 104);
  assert.equal(arg('--console'), path.join(s.home, 'logs', ID + '.console.log'));
  assert.match(arg('--id'), /^[0-9a-f]{8}$/);
  assert.equal(arg('--memory'), '256');
  assert.equal(arg('--cpus'), '1');
  const shares = argv.flatMap((a, i) => (a === '--share' ? [argv[i + 1]] : []));
  assert.deepEqual(shares, [`f-notes:rw:${s.notes}`, `f-export:wo:${s.exportDir}`]);
  assert.deepEqual(JSON.parse(arg('--start')), { command: ['node', 'main.js'], workdir: '/app', env: ['NODE_ENV=production'] });
  assert.ok(!argv.includes('--no-follow-parent'));

  assert.deepEqual(await wm.invoke(1, 'folders'), { notes: '/host/f-notes', export: '/host/f-export' });
  assert.deepEqual(wm.windows.get(1).params, { entry: 'index.html', width: 640, height: 480, title: 'Fixture', devTools: false });
  assert.deepEqual(await wm.invoke(1, 'echo', 1, 'two'), [1, 'two']);
  await assert.rejects(wm.invoke(1, 'fail'), /^Error: boom$/);
  wm.send(1, 'ping', 'hello');
  assert.deepEqual(await wm.waitForEmit('pong', { timeoutMs: 3000 }), ['hello']);
  assert.deepEqual(wm.windows.get(1).received.map((r) => r.channel), ['early', 'hello', 'pong']);

  await wm.invoke(1, 'title', 'T2');
  await wm.invoke(1, 'focus');
  assert.equal(wm.windows.get(1).title, 'T2');
  assert.equal(wm.windows.get(1).focusCount, 1);
  const id2 = await wm.invoke(1, 'second-window');
  assert.equal(id2, 2);
  assert.ok(s.logs.some((l) => l.source === 'host' && /core ready/.test(l.message)));

  // graceful stop: before-quit reaches the core, windows are closed, 'stopped' carries the stopped line
  const stoppedEvents = [];
  session.on('stopped', (x) => stoppedEvents.push(x));
  const info = await session.stop();
  assert.equal(info.stopped, true);
  assert.ok(['core-exited', 'shutdown'].includes(info.reason), info.reason);
  assert.equal(stoppedEvents.length, 1);
  assert.deepEqual(stoppedEvents[0], info);
  assert.equal(session.state, 'stopped');
  assert.ok([...wm.windows.values()].every((w) => w.closed), 'all windows closed');
  assert.equal(fs.readFileSync(s.marks, 'utf8').trim(), 'before-quit');
  assert.ok(!fs.existsSync(path.dirname(argv[argv.indexOf('--socket') + 1])), 'socket dir removed');
  assert.equal(await session.stop(), info, 'stop is idempotent');
});

test('dialog.open: directory pick, file pick (parent shared ro), multi-pick, cancel', async (t) => {
  const s = setup(t);
  const dirA = path.join(s.d, 'dirA');
  const dirB = path.join(s.d, 'dirB');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.writeFileSync(path.join(dirA, 'one.txt'), '1');
  fs.writeFileSync(path.join(dirA, 'two.txt'), '2');
  fs.writeFileSync(path.join(dirB, 'three.txt'), '3');
  const answers = [[dirA], [path.join(dirA, 'one.txt')], [path.join(dirA, 'one.txt'), path.join(dirA, 'two.txt'), path.join(dirB, 'three.txt')], null, [dirB], [dirB]];
  s.dlg.opts.open = () => answers.shift();
  await startRunning(s);
  const grants = () => s.vmLines().filter((l) => l.stdin && l.stdin.op === 'grant').map((l) => l.stdin);
  const picks = path.join(s.home, 'picks', ID);

  // directory pick: default access is read
  assert.deepEqual(await s.wm.invoke(1, 'dialog:open', true, false), { canceled: false, filePaths: ['/host/pick-0'] });
  // file pick: a clone in its own folder, never the parent folder
  assert.deepEqual(await s.wm.invoke(1, 'dialog:open', false, false), { canceled: false, filePaths: ['/host/pick-1/one.txt'] });
  // several files: one fresh folder each
  assert.deepEqual(await s.wm.invoke(1, 'dialog:open', false, true), {
    canceled: false,
    filePaths: ['/host/pick-2/one.txt', '/host/pick-3/two.txt', '/host/pick-4/three.txt'],
  });
  assert.deepEqual(await s.wm.invoke(1, 'dialog:open', true, false), { canceled: true, filePaths: [] });
  // readwrite directory pick, and the access is passed through the SDK to the dialogs
  assert.deepEqual(await s.wm.invoke(1, 'dialog:open', true, false, 'readwrite'), { canceled: false, filePaths: ['/host/pick-5'] });
  await assert.rejects(s.wm.invoke(1, 'dialog:open', true, false, 'writeonly'), /access must be "read" or "readwrite"/);
  const real = (p) => fs.realpathSync(p);
  assert.deepEqual(grants(), [
    { op: 'grant', name: 'pick-0', access: 'ro', path: real(dirA) },
    { op: 'grant', name: 'pick-1', access: 'ro', path: path.join(picks, 'pick-1') },
    { op: 'grant', name: 'pick-2', access: 'ro', path: path.join(picks, 'pick-2') },
    { op: 'grant', name: 'pick-3', access: 'ro', path: path.join(picks, 'pick-3') },
    { op: 'grant', name: 'pick-4', access: 'ro', path: path.join(picks, 'pick-4') },
    { op: 'grant', name: 'pick-5', access: 'rw', path: real(dirB) },
  ]);
  assert.deepEqual(s.dlg.calls.map((c) => c.params.access), ['read', 'read', 'read', 'read', 'readwrite']);
  assert.equal(s.dlg.calls[0].params.directory, true);
  assert.equal(s.dlg.calls[0].params.win, 1);
  assert.deepEqual(s.dlg.calls[0].params.app, { id: ID, name: 'Notes' });
  assert.equal(s.dlg.calls[2].params.multiple, true);

  // the clones hold the content, the folders hold nothing else (siblings are never exposed)
  assert.deepEqual(fs.readdirSync(picks).sort(), ['pick-1', 'pick-2', 'pick-3', 'pick-4']);
  assert.deepEqual(fs.readdirSync(path.join(picks, 'pick-1')), ['one.txt']);
  assert.equal(fs.readFileSync(path.join(picks, 'pick-1', 'one.txt'), 'utf8'), '1');
  assert.equal(fs.readFileSync(path.join(picks, 'pick-3', 'two.txt'), 'utf8'), '2');
  assert.equal(fs.readFileSync(path.join(picks, 'pick-4', 'three.txt'), 'utf8'), '3');
  assert.equal(fs.readFileSync(path.join(dirA, 'one.txt'), 'utf8'), '1', 'the original is untouched');

  // the picks are removed when the session stops
  await s.session.stop();
  assert.ok(!fs.existsSync(picks), 'picks/<id> removed after stop');
});

test('dialog.open: a file pick for a directory (and the reverse) is refused; a failed grant removes its clone', async (t) => {
  const s = setup(t);
  const dir = path.join(s.d, 'd');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  const answers = [[dir], [path.join(dir, 'f.txt')], [path.join(dir, 'f.txt')]];
  s.dlg.opts.open = () => answers.shift();
  process.env.FAKE_VM_FAIL_GRANT = '1';
  await startRunning(s);
  await assert.rejects(s.wm.invoke(1, 'dialog:open', false, false), /not a file/);
  await assert.rejects(s.wm.invoke(1, 'dialog:open', true, false), /not a folder/);
  await assert.rejects(s.wm.invoke(1, 'dialog:open', false, false), /refused by test/);
  const picks = path.join(s.home, 'picks', ID);
  assert.deepEqual(fs.existsSync(picks) ? fs.readdirSync(picks) : [], [], 'no clone left behind');
});

test('traffic events: every bridge message in both directions, matched durations, truncated previews', async (t) => {
  const s = setup(t);
  const events = [];
  s.session.on('traffic', (e) => events.push(e));
  await startRunning(s);
  await s.wm.invoke(1, 'echo', 'x'.repeat(1000));
  await assert.rejects(s.wm.invoke(1, 'fail'), /boom/);
  s.wm.send(1, 'ping', 'hi');
  await s.wm.waitForEmit('pong', { timeoutMs: 3000 });

  const dirs = (t_, dir) => events.filter((e) => e.t === t_ && e.dir === dir);
  assert.equal(events[0].t, 'init');
  assert.equal(events[0].dir, 'to-core');
  assert.ok(dirs('ready', 'from-core').length >= 1);
  const create = events.find((e) => e.t === 'request' && e.op === 'window.create');
  assert.equal(create.dir, 'from-core');
  const reply = events.find((e) => e.t === 'reply' && e.id === create.id);
  assert.equal(reply.dir, 'to-core');
  assert.equal(reply.op, 'window.create');
  assert.equal(typeof reply.durationMs, 'number');

  const inv = dirs('invoke', 'to-core').find((e) => e.channel === 'echo');
  assert.equal(inv.win, 1);
  const res = dirs('result', 'from-core').find((e) => e.id === inv.id);
  assert.equal(res.channel, 'echo');
  assert.ok(res.durationMs >= 0 && res.ts >= inv.ts);
  assert.ok(res.bytes > 1000, 'bytes counts the whole message');
  assert.ok(res.preview.length <= 200 && res.preview.startsWith('{"t":"result"'), 'preview is truncated JSON');
  const failInv = dirs('invoke', 'to-core').find((e) => e.channel === 'fail');
  assert.equal(dirs('result', 'from-core').find((e) => e.id === failInv.id).error, true);

  assert.ok(dirs('send', 'to-core').some((e) => e.channel === 'ping'));
  assert.ok(dirs('emit', 'from-core').some((e) => e.channel === 'pong' && e.win === 1));
  assert.ok(events.every((e) => typeof e.ts === 'number' && typeof e.bytes === 'number' && typeof e.preview === 'string'));
  s.wm.userClose(1);
  await wait(100);
  assert.ok(events.some((e) => e.t === 'window' && e.event === 'closed' && e.dir === 'to-core'));
});

test('the Inspector preview hides what looks like a secret and keeps the rest readable', () => {
  const KEY = 'fw-vmapp-test-1700000000000';
  // by field name: the value goes, the field and its neighbours stay
  let p = bridgePreview({ t: 'invoke', id: 7, win: 1, channel: 'settings:save', args: [{ providerId: 'fireworks', apiKey: KEY, note: 'hello' }] }, 'settings:save');
  assert.ok(!p.includes(KEY) && p.includes('"apiKey":"[hidden]"') && p.includes('"providerId":"fireworks"') && p.includes('"note":"hello"'), p);
  // by the shape of a well-known key or token, wherever it sits
  for (const secret of ['sk-or-v1-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'Bearer abcdefghijklmnop1234', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop']) {
    p = bridgePreview({ t: 'emit', win: 1, channel: 'log-line', args: [`using ${secret} now`] }, 'log-line');
    assert.ok(!p.includes(secret) && p.includes('using [hidden] now'), `${secret}: ${p}`);
  }
  // by channel name: the whole payload goes, in both directions, the envelope stays
  p = bridgePreview({ t: 'invoke', id: 3, win: 1, channel: 'api-keys:set', args: ['plain-looking-secret'] }, 'api-keys:set');
  assert.equal(p, '{"t":"invoke","id":3,"win":1,"channel":"api-keys:set","args":"[hidden]"}');
  p = bridgePreview({ t: 'result', id: 3, result: { ok: 1 } }, 'api-keys:set ');
  assert.ok(p.includes('"result":"[hidden]"') && p.includes('"t":"result"'), p);
  // numbers and booleans under a secret-looking name are not secrets (a token count)
  assert.ok(bridgePreview({ t: 'emit', channel: 'usage', args: [{ maxTokens: 4096, ok: true }] }, 'usage').includes('"maxTokens":4096'));
  // an ordinary message is shown as before: the first 200 characters of its JSON
  const plain = { t: 'result', id: 9, result: 'x'.repeat(1000) };
  assert.equal(bridgePreview(plain, 'echo'), JSON.stringify(plain).slice(0, 200));
  // a crafted message cannot make it slow or large: deep, wide and huge values are cut
  let deep = 'end';
  for (let i = 0; i < 5000; i++) deep = { a: deep };
  const t0 = Date.now();
  const crafted = bridgePreview({ t: 'emit', win: 1, channel: 'big', args: [deep, new Array(1e6).fill('y'.repeat(300)), 'z'.repeat(5e6)] }, 'big');
  assert.ok(crafted.length <= 200 && Date.now() - t0 < 500, `crafted message: ${crafted.length} chars in ${Date.now() - t0} ms`);
});

test('traffic events never carry a secret in their preview', async (t) => {
  const s = setup(t);
  const events = [];
  s.session.on('traffic', (e) => events.push(e));
  await startRunning(s);
  const KEY = 'fw-vmapp-test-1700000000000';
  await s.wm.invoke(1, 'echo', { apiKey: KEY, note: 'hello' });
  await s.wm.invoke(1, 'api-keys:set', { providerId: 'fireworks', apiKey: KEY });
  assert.ok(events.length > 0);
  assert.ok(!events.some((e) => e.preview.includes(KEY)), 'no event shows the key, in either direction');
  const inv = events.find((e) => e.t === 'invoke' && e.channel === 'api-keys:set');
  assert.ok(inv.preview.includes('"channel":"api-keys:set"') && inv.preview.includes('"args":"[hidden]"'), inv.preview);
  const echo = events.find((e) => e.t === 'result' && e.channel === 'echo');
  assert.ok(echo.preview.includes('"apiKey":"[hidden]"') && echo.preview.includes('"note":"hello"'), echo.preview);
  s.wm.userClose(1);
});

test('grant events are emitted for picks and saves', async (t) => {
  const s = setup(t);
  const target = path.join(s.d, 'export', 'r.html');
  s.dlg.opts.open = () => [s.notes];
  s.dlg.opts.save = () => target;
  const got = [];
  s.session.on('grant', (g) => got.push(g));
  await startRunning(s);
  await s.wm.invoke(1, 'dialog:open', true, false, 'readwrite');
  await s.wm.invoke(1, 'dialog:save', 'r.html');
  assert.deepEqual(got, [
    { name: 'pick-0', access: 'rw', path: fs.realpathSync(s.notes) },
    { name: 'save-0', access: 'wo', path: target },
  ]);
});

test('dialog.save: wo grant on the chosen file, guest path, cancel, name sanitising', async (t) => {
  const s = setup(t);
  const target = path.join(s.d, 'export', 'report.html');
  const answers = [target, null];
  s.dlg.opts.save = () => answers.shift();
  await startRunning(s);
  const r = await s.wm.invoke(1, 'dialog:save', '/anything/at/all/default.html');
  assert.deepEqual(r, { canceled: false, filePath: '/host/save-0/report.html' });
  assert.equal(s.dlg.calls[0].params.defaultName, 'default.html');
  const g = s.vmLines().filter((l) => l.stdin && l.stdin.op === 'grant').map((l) => l.stdin);
  assert.deepEqual(g, [{ op: 'grant', name: 'save-0', access: 'wo', path: target }]);
  assert.deepEqual(await s.wm.invoke(1, 'dialog:save', ''), { canceled: true }); // (undefined is dropped by JSON)
  assert.equal(s.dlg.calls[1].params.defaultName, 'untitled');
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('a\u0000b\n.txt'), 'ab.txt');
  assert.equal(sanitizeName('..'), 'untitled');
});

test('dialog.message and shell.openExternal go through the dialogs; a grant error is reported to the core', async (t) => {
  const s = setup(t, { dialogs: { message: 1, confirmExternal: true } });
  await startRunning(s);
  assert.deepEqual(await s.wm.invoke(1, 'dialog:msg'), { response: 1, checkboxChecked: false });
  assert.deepEqual(s.dlg.calls[0].params.buttons, ['No', 'Yes']);
  assert.equal(s.dlg.calls[0].params.type, 'question');
  assert.equal(await s.wm.invoke(1, 'external', 'https://example.com/a?b=1'), true);
  assert.deepEqual(s.dlg.opened, ['https://example.com/a?b=1']);
  await assert.rejects(s.wm.invoke(1, 'external', 'http://example.com'), /only https/);
  await assert.rejects(s.wm.invoke(1, 'external', 'javascript:alert(1)'), /only https/);
  await assert.rejects(s.wm.invoke(1, 'external', 'not a url'), /invalid url/);
  s.dlg.opts.confirmExternal = false;
  assert.equal(await s.wm.invoke(1, 'external', 'https://example.com/'), false);
  assert.equal(s.dlg.opened.length, 1, 'declined URL is not opened');
});

test('clipboard.readText / writeText: the device "clipboard" asked AND allowed, checked at every call; the text is not traced', async (t) => {
  const devices = [{ device: 'clipboard', purpose: 'paste' }];
  const clip = new FakeClipboard('copied on the Mac');
  const s = setup(t, {
    manifest: { permissions: { folders: [], dialogs: false, external: false, devices } },
    grants: { folders: {}, askEveryTime: false, devices: { clipboard: { mode: 'allow' } } },
    clipboard: clip,
  });
  const traffic = [];
  s.session.on('traffic', (ev) => traffic.push(ev));
  await startRunning(s);
  assert.equal(await s.wm.invoke(1, 'clip:read'), 'copied on the Mac');
  assert.equal(await s.wm.invoke(1, 'clip:write', 'from the VM'), 'written');
  assert.equal(clip.text, 'from the VM');
  await assert.rejects(s.wm.invoke(1, 'clip:write', 'x'.repeat(1024 * 1024 + 1)), /longer than/);
  // the user revokes: the very next call is refused (session.grants is what the loader passes; it is read at every call)
  s.session.grants.devices = {};
  await assert.rejects(s.wm.invoke(1, 'clip:read'), /permission denied: clipboard/);
  const rows = traffic.filter((e) => e.op === 'clipboard.readText' || e.op === 'clipboard.writeText');
  assert.ok(rows.length >= 4, 'every call is a traffic row');
  assert.ok(rows.every((e) => /payload not shown/.test(e.preview)), 'the clipboard text never reaches the Inspector');
  // (what the app itself then sends between its window and its core is the app's own traffic, shown like any other message)
  assert.ok(!traffic.filter((e) => e.t === 'request' || e.t === 'reply').some((e) => /copied on the Mac|from the VM/.test(e.preview || '')), 'no platform request or reply shows it');
});

test('clipboard: refused when the manifest does not ask for it, even with a hand-written grant', async (t) => {
  const s = setup(t, {
    manifest: { permissions: { folders: [], dialogs: false, external: false } },
    grants: { folders: {}, askEveryTime: false, devices: { clipboard: { mode: 'allow' } } },
    clipboard: new FakeClipboard('secret'),
  });
  await startRunning(s);
  await assert.rejects(s.wm.invoke(1, 'clip:read'), /permission denied: clipboard/);
  await assert.rejects(s.wm.invoke(1, 'clip:write', 'x'), /permission denied: clipboard/);
});

async function waitFor(cond, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('port.forward (SPEC 8.8): the device "ports" asked AND allowed; a forwarded localhost link opens; a revoke closes the forwards', async (t) => {
  const devices = [{ device: 'ports', purpose: 'dev server' }];
  const s = setup(t, {
    manifest: { permissions: { folders: [], dialogs: false, external: true, devices } },
    grants: { folders: {}, askEveryTime: false, devices: { ports: { mode: 'allow' } } },
    dialogs: { confirmExternal: true },
  });
  const rows = [];
  s.session.on('traffic', (ev) => ev.kind === 'port' && rows.push(ev));
  await startRunning(s);
  const open = (url) => s.session._request('shell.openExternal', { url });
  await assert.rejects(open('http://localhost:13000/'), /only https: URLs/, 'not a forward yet');
  assert.deepEqual(await s.session._request('port.forward', { port: 3000 }), { port: 3000, hostPort: 13000, url: 'http://localhost:13000/' });
  assert.deepEqual(await s.session._request('port.list', {}), { ports: [{ port: 3000, hostPort: 13000 }] });
  assert.deepEqual(await open('http://localhost:13000/index.html'), { opened: true });
  assert.deepEqual(await open('http://127.0.0.1:13000/'), { opened: true });
  for (const bad of ['http://localhost:3000/', 'http://localhost:13001/', 'http://example.com:13000/', 'http://user:pw@localhost:13000/', 'file:///etc/passwd']) {
    await assert.rejects(open(bad), /only https: URLs|invalid url/, bad);
  }
  for (const port of [0, 65536, 1.5, '3000', null]) {
    await assert.rejects(s.session._request('port.forward', { port }), /port must be an integer/, String(port));
  }
  await waitFor(() => rows.some((r) => r.phase === 'listen'), 'the listen row');
  assert.match(rows.find((r) => r.phase === 'listen').preview, /^forwarding VM port 3000 on localhost:13000/);
  // the user takes it away (the grant is read at every call, and once a second while forwards exist)
  s.session.grants.devices = {};
  await assert.rejects(s.session._request('port.forward', { port: 4000 }), /permission denied: ports/);
  await waitFor(() => s.session.listPorts().length === 0, 'the forward closed after the revoke (looked at once a second)');
  // the list empties before the close message reaches the VM's stdin, so wait for the message too (not for the clock)
  await waitFor(() => s.vmLines().some((l) => l.stdin && l.stdin.op === 'port-close' && l.stdin.port === 3000), 'the port-close message to the VM');
  await assert.rejects(open('http://localhost:13000/'), /only https: URLs/, 'its link no longer opens');
  assert.deepEqual(await s.session._request('port.close', { port: 3000 }), { closed: 0 }, 'closing again needs no grant and does nothing');
});

test('port.forward: refused when the manifest does not ask for "ports", even with a hand-written grant', async (t) => {
  const s = setup(t, {
    manifest: { permissions: { folders: [], dialogs: false, external: true } },
    grants: { folders: {}, askEveryTime: false, devices: { ports: { mode: 'allow' } } },
  });
  await startRunning(s);
  await assert.rejects(s.session._request('port.forward', { port: 3000 }), /permission denied: ports/);
  assert.ok(!s.vmLines().some((l) => l.stdin && l.stdin.op === 'port-forward'), 'vmapp-vm was never asked');
});

test('app links (SPEC 8.9): a vmapp:// link for this app reaches the core as open-url; others and apps without permissions.links are refused', async (t) => {
  const s = setup(t, { manifest: { permissions: { folders: [], dialogs: false, external: false, links: true } } });
  const traffic = [];
  s.session.on('traffic', (ev) => ev.t === 'open-url' && traffic.push(ev));
  await startRunning(s);
  const link = `vmapp://${s.session.appId}/auth/callback?code=SECRET123&state=x`;
  assert.equal(s.session.openUrl(link), true);
  await waitFor(async () => (await s.wm.invoke(1, 'links')).length === 1, 'the core hears the link');
  assert.deepEqual(await s.wm.invoke(1, 'links'), [{ url: link, preventDefault: true }]);
  assert.equal(traffic.length, 1);
  assert.ok(!traffic[0].preview.includes('SECRET123'), 'the Inspector never shows the link’s parameters');
  for (const bad of ['vmapp://com.other.app/x', 'https://evil.example.com/', `vmapp://user@${s.session.appId}/x`, `vmapp://${s.session.appId}:99/x`, 'not a link', 42]) {
    assert.throws(() => s.session.openUrl(bad), /not a link for|invalid link/, String(bad));
  }
});

test('app links: refused for an app whose manifest does not ask for them', async (t) => {
  const s = setup(t, { manifest: { permissions: { folders: [], dialogs: false, external: false } } });
  await startRunning(s);
  assert.throws(() => s.session.openUrl(`vmapp://${s.session.appId}/x`), /permission denied: links/);
});

test('menu.set from the SDK: the template arrives validated; a click comes back to the right click handler', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const r = await s.wm.invoke(1, 'menu:set');
  assert.deepEqual(r.dropped, ['Cmd+Q'], 'the loader keeps Cmd+Q');
  const menus = s.wm.menus;
  assert.deepEqual(menus.map((m) => m.label), ['File', 'Edit', 'View'], 'appMenu is the loader’s; editMenu is expanded');
  assert.deepEqual(menus[0].submenu.map((i) => i.label || i.type), ['New', 'separator', 'Save'], 'the quit role is left out');
  assert.deepEqual(menus[1].submenu.map((i) => i.role || i.type), ['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
  assert.deepEqual(menus[2].submenu.map((i) => i.label), ['Word Wrap', 'Quit Me'], 'toggleDevTools is left out');
  assert.equal(menus[2].submenu[1].accelerator, undefined);
  // the user chooses items (the loader's click becomes the window event 'menu' {id})
  s.wm.menuClick(1, menus[0].submenu[0].id);
  s.wm.menuClick(1, 'save');
  s.wm.menuClick(1, 'wrap');
  s.wm.menuClick(1, 'wrap');
  s.wm.menuClick(1, 'not-an-item');
  await wait(100);
  assert.deepEqual(await s.wm.invoke(1, 'menu:runs'), ['new', 'save:save', 'wrap:true', 'wrap:false'], 'the click handlers ran, with Electron’s checkbox toggle');
  assert.equal(await s.wm.invoke(1, 'menu:get'), false);
  await assert.rejects(s.wm.invoke(1, 'menu:bad'), /menu\.set: .*not a valid shortcut/);
});

test('grant failure from vmapp-vm rejects the dialog request', async (t) => {
  const s = setup(t);
  process.env.FAKE_VM_FAIL_GRANT = '1';
  s.dlg.opts.open = () => [s.notes];
  await startRunning(s);
  await assert.rejects(s.wm.invoke(1, 'dialog:open', true, false), /refused by test/);
});

test('permissions are enforced by the host: dialogs:false and external:false', async (t) => {
  const s = setup(t, {
    manifest: { permissions: { folders: [], dialogs: false, external: false } },
    dialogs: { open: () => ['/tmp'], save: () => '/tmp/x', confirmExternal: true },
  });
  await startRunning(s);
  await assert.rejects(s.wm.invoke(1, 'dialog:open', true, false), /permission denied: dialogs/);
  await assert.rejects(s.wm.invoke(1, 'dialog:save', 'a.txt'), /permission denied: dialogs/);
  await assert.rejects(s.wm.invoke(1, 'external', 'https://example.com'), /permission denied: external/);
  assert.equal(s.dlg.calls.length, 0, 'the dialogs were never shown');
  assert.deepEqual(await s.wm.invoke(1, 'folders'), {});
  // message boxes are not gated by permissions.dialogs
  assert.deepEqual(await s.wm.invoke(1, 'dialog:msg'), { response: 0, checkboxChecked: false });
  assert.equal(s.vmLines().filter((l) => l.stdin).length, 0, 'no grants were sent');
});

test('request validation: window entries, unknown windows, unknown ops', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const req = (op, p) => s.session._request(op, p);
  for (const entry of ['../x.html', '/abs.html', 'a//b.html', 'a\\b.html', '', 5, 'a/./b']) {
    await assert.rejects(req('window.create', { entry }), /invalid window entry/, String(entry));
  }
  await assert.rejects(req('window.create', { entry: 'x.html', width: 'wide' }), /invalid window size/);
  await assert.rejects(req('window.close', { win: 99 }), /unknown window/);
  await assert.rejects(req('window.setTitle', { win: 'x', title: 't' }), /unknown window/);
  await assert.rejects(req('nope', {}), /unknown op: nope/);
  const r = await req('window.create', { entry: 'x.html', width: 10, height: 99999, resizable: false });
  assert.equal(r.win, 2);
  assert.deepEqual(s.wm.windows.get(2).params, { entry: 'x.html', width: 100, height: 16384, resizable: false });
});

test('window.create devTools: the core\'s own boolean; only true turns DevTools on, anything else is false (SPEC 7)', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const req = (op, p) => s.session._request(op, p);
  const created = async (devTools) => {
    const p = { entry: 'x.html', width: 200, height: 200 };
    if (devTools !== 'absent') p.devTools = devTools;
    return s.wm.windows.get((await req('window.create', p)).win).params;
  };
  assert.equal('devTools' in (await created('absent')), false, 'absent: nothing is passed on, which a window manager reads as off');
  assert.equal((await created(true)).devTools, true);
  assert.equal((await created(false)).devTools, false);
  for (const v of ['true', 1, {}, null, 'yes']) assert.equal((await created(v)).devTools, false, `${JSON.stringify(v)} is not true`);
});

test('core quit (app.quit) stops the session and closes windows', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const stopped = new Promise((r) => s.session.once('stopped', r));
  await s.wm.invoke(1, 'quit');
  const info = await stopped;
  assert.equal(info.stopped, true);
  assert.equal(s.session.state, 'stopped');
  assert.ok(s.wm.windows.get(1).closed);
});

test('last window closed by the user: windowEvent reaches the core and the default quits the app', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const stopped = new Promise((r) => s.session.once('stopped', r));
  s.wm.userClose(1);
  const info = await Promise.race([stopped, wait(8000).then(() => null)]);
  assert.ok(info, 'session stopped');
  assert.ok(info.reason === 'core-exited' || info.reason === 'shutdown');
});

test('exported lines are forwarded as events', async (t) => {
  const s = setup(t);
  await startRunning(s);
  const got = [];
  s.session.on('exported', (e) => got.push(e));
  s.session._onVmLine(JSON.stringify({ exported: { share: 'f-export', files: ['a.html'] } }));
  assert.deepEqual(got, [{ share: 'f-export', files: ['a.html'] }]);
});

test('start fails cleanly when vmapp-vm never prints the ready line', async (t) => {
  const s = setup(t);
  process.env.FAKE_VM_NO_READY = '1';
  s.session.timeouts.ready = 300;
  await assert.rejects(s.session.start(), /timed out waiting for the vmapp-vm ready line/);
  assert.equal(s.session.state, 'stopped');
  const pid = s.session.child.pid;
  await wait(100);
  assert.throws(() => process.kill(pid, 0), 'child is gone');
});

test('start fails when the app is not installed or files are missing', async (t) => {
  const s = setup(t);
  const bad = new AppSession({ appId: 'com.example.other', home: s.home, vmappVmPath: [process.execPath, FAKE_VM], kernel: 'k', initramfs: 'i', windowManager: s.wm });
  await assert.rejects(bad.start(), /not installed/);
  const noKernel = new AppSession({ appId: ID, home: s.home, vmappVmPath: [process.execPath, FAKE_VM], kernel: '/nope/Image', initramfs: 'i', windowManager: s.wm });
  await assert.rejects(noKernel.start(), /kernel not found/);
  const noVm = new AppSession({ appId: ID, home: s.home, vmappVmPath: '/nope/vmapp-vm', kernel: s.d + '/Image', initramfs: s.d + '/initramfs.cpio', windowManager: s.wm });
  await assert.rejects(noVm.start(), /vmapp-vm not found/);
});

test('resolveFolders: downgrades allowed, widening and missing paths ignored', () => {
  const d = tmpdir('rf-');
  try {
    const m = {
      permissions: {
        folders: [
          { name: 'rw', access: 'readwrite' },
          { name: 'ro', access: 'read' },
          { name: 'wo', access: 'writeonly' },
          { name: 'gone', access: 'read' },
          { name: 'skip', access: 'read' },
          { name: 'file', access: 'read' },
        ],
      },
    };
    fs.writeFileSync(path.join(d, 'f'), 'x');
    const r = resolveFolders(m, {
      folders: {
        rw: { path: d, access: 'read' },
        ro: { path: d, access: 'readwrite' },
        wo: { path: d, access: 'writeonly' },
        gone: { path: path.join(d, 'nonexistent'), access: 'read' },
        skip: null,
        file: { path: path.join(d, 'f'), access: 'read' },
        undeclared: { path: d, access: 'read' },
      },
    });
    assert.deepEqual(r.shares, [
      { name: 'f-rw', access: 'ro', path: d },
      { name: 'f-wo', access: 'wo', path: d },
    ]);
    assert.deepEqual(r.folders, { rw: '/host/f-rw', ro: null, wo: '/host/f-wo', gone: null, skip: null, file: null });
    assert.equal(r.notes.length, 3);
  } finally {
    rmrf(d);
  }
});

test('buildVmArgs follows the SPEC 5 command line', () => {
  const a = buildVmArgs({
    kernel: 'K', initramfs: 'I', runtime: 'R', core: 'C', appdata: 'D',
    shares: [{ name: 'f-x', access: 'ro', path: '/p' }],
    start: { command: ['a'], workdir: '/app', env: [] }, socket: '/tmp/vmapp-1/b.sock', memory: 512, cpus: 2, console: 'L', id: 'deadbeef',
  });
  assert.deepEqual(a, [
    'run', '--kernel', 'K', '--initramfs', 'I', '--runtime', 'R', '--core', 'C', '--appdata', 'D', '--share', 'f-x:ro:/p',
    '--start', '{"command":["a"],"workdir":"/app","env":[]}', '--socket', '/tmp/vmapp-1/b.sock', '--memory', '512', '--cpus', '2',
    '--console', 'L', '--id', 'deadbeef',
  ]);
});
