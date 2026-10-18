'use strict';
// SPEC 8.2: the USER picks what a screenshot contains (the app's parameters are only a suggestion), the result says what was
// really captured (`target`), "allow while the app runs" remembers the permission and never a target, and the loader's own
// windows are excluded. Also the input activity the virtual-input overlay draws. The helper is the fake vmapp-hostctl
// (tests/unit/fixtures/fake-hostctl.js: two displays side by side, three windows, one of them the loader's own).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateManifest } = require('../../hostlib/manifest');
const { Store } = require('../../hostlib/store');
const { Catalog, HostCapabilities, captureArgs, pickedArgs, captureTarget } = require('../../hostlib/capabilities');
const { HostCtl } = require('../../hostlib/hostproc');
const { FakeCapabilitiesUi } = require('../../hostlib/headless');
const { tmpdir, rmrf } = require('./helpers');

const FAKE_CTL = path.join(__dirname, 'fixtures', 'fake-hostctl.js');
const BASE = { format: 1, id: 'com.example.agent', name: 'Agent', version: '1.0.0', runtime: 'node22', core: { command: ['node', 'main.js'] } };
const DISPLAY1 = { x: 0, y: 0, w: 1440, h: 900 };
const DISPLAY2 = { x: 1440, y: 0, w: 1920, h: 1080 };

/**
 * A broker with a scripted UI that has chooseCapture (the loader's picker) and records everything it is asked.
 * `answers` is the queue for chooseCapture: false | {allow, target} | (req) => ...; an empty queue declines.
 */
function setup(t, { grants = { screen: { mode: 'ask' } }, host = [{ cap: 'screen', purpose: 'Reads the screen' }, { cap: 'input' }], ui, opts = {} } = {}) {
  const d = tmpdir('capt-');
  t.after(() => rmrf(d));
  const ctlLog = path.join(d, 'ctl.log');
  process.env.FAKE_HOSTCTL_LOG = ctlLog;
  t.after(() => delete process.env.FAKE_HOSTCTL_LOG);
  const answers = [];
  const calls = { choose: [], confirm: [], activity: [], badges: [] };
  const theUi = ui || {
    async chooseCapture(req) {
      calls.choose.push(req);
      const a = answers.length ? answers.shift() : false;
      return typeof a === 'function' ? a(req) : a;
    },
    async confirmUse(req) {
      calls.confirm.push(req);
      return calls.confirmAnswer === undefined ? true : calls.confirmAnswer;
    },
    inputStarted: (i) => calls.badges.push(['on', i.sessionId]),
    inputStopped: (i) => calls.badges.push(['off', i.sessionId, i.reason]),
    inputActivity: (ev) => calls.activity.push(ev),
  };
  const caps = new HostCapabilities({
    store: new Store({ home: d }),
    catalog: new Catalog({ home: d }),
    ui: theUi,
    hostctl: () => new HostCtl({ command: [process.execPath, FAKE_CTL] }),
    panicHotkey: false,
    dryRun: true,
    ...opts,
  });
  t.after(() => caps.close());
  const warnings = [];
  caps.on('warning', (m) => warnings.push(m));
  const state = { grants };
  const traffic = [];
  const ctx = {
    key: 'a1',
    appId: BASE.id,
    appName: 'Agent',
    manifest: validateManifest({ ...BASE, permissions: { host } }, { files: 'forbidden' }),
    grants: () => state.grants,
    resolvePath: () => {
      throw new Error('no shares');
    },
    traffic: (e) => traffic.push(e),
  };
  const call = (op, params) => caps.requestOp(op, params, ctx);
  const captures = () => (fs.existsSync(ctlLog) ? fs.readFileSync(ctlLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((o) => o.op === 'capture').map((o) => o.args);
  return { caps, call, answers, calls, state, traffic, warnings, captures, ctx };
}

const PID = process.pid; // the fake helper's "loader" window belongs to its parent: this test process

// ------------------------------------------------------------------------------------------------ the user picks

test('capture: the user’s pick wins over the app’s suggestion, and the result says what was captured', async (t) => {
  const s = setup(t);
  s.answers.push({ allow: true, target: { kind: 'display', display: 2 } });
  const r = await s.call('host.screen.capture', { target: 'display', display: 1, maxWidth: 640 });
  assert.deepEqual(s.captures(), [{ target: 'display', display: 2, maxWidth: 640, excludePids: [PID] }], 'display 2 was captured, not the suggested display 1; the app keeps the say over the size only');
  assert.deepEqual(r.target, { kind: 'display', display: 2, bounds: DISPLAY2, by: 'user' });
  assert.equal(Buffer.from(r.png, 'base64').subarray(1, 4).toString(), 'PNG');
  // the picker got the validated suggestion, the app’s own words (purpose) and the raw params for the wording
  assert.equal(s.calls.choose.length, 1);
  const req = s.calls.choose[0];
  assert.deepEqual(req.suggestion, { target: 'display', display: 1, maxWidth: 640 });
  assert.deepEqual(req.params, { target: 'display', display: 1, maxWidth: 640 });
  assert.equal(req.purpose, 'Reads the screen');
  assert.deepEqual(req.app, { id: 'com.example.agent', name: 'Agent' });
  assert.equal(req.op, 'host.screen.capture');
  assert.equal(s.calls.confirm.length, 0, 'confirmUse is not used for a screenshot when the UI can pick');
  // the Inspector row says it was the user’s choice, and carries no pixels
  assert.match(s.traffic.at(-1).detail, /^capture display \(chosen by the user\) -> /);
  assert.ok(!JSON.stringify(s.traffic).includes(r.png.slice(0, 40)));
});

test('capture: a window, and a region in global points (across displays) clipped to the display that holds most of it', async (t) => {
  const s = setup(t);
  s.answers.push({ allow: true, target: { kind: 'window', windowId: 8 } });
  let r = await s.call('host.screen.capture', {});
  assert.deepEqual(s.captures().at(-1), { target: 'window', windowId: 8, excludePids: [PID] });
  assert.deepEqual(r.target, { kind: 'window', windowId: 8, display: 2, bounds: { x: 1500, y: 100, w: 500, h: 400 }, by: 'user' });

  s.answers.push({ allow: true, target: { kind: 'region', region: { x: 1500, y: 100, w: 400, h: 300 } } });
  r = await s.call('host.screen.capture', { target: 'window', windowId: 7 });
  assert.deepEqual(s.captures().at(-1), { target: 'region', region: { x: 1500, y: 100, w: 400, h: 300 }, excludePids: [PID] }, 'global coordinates, no display: the helper finds it');
  assert.deepEqual(r.target, { kind: 'region', region: { x: 1500, y: 100, w: 400, h: 300 }, display: 2, bounds: { x: 1500, y: 100, w: 400, h: 300 }, by: 'user' });

  // 40 points on display 1, 160 on display 2: display 2 wins and the region is clipped to it
  s.answers.push({ allow: true, target: { kind: 'region', region: { x: 1400, y: 0, w: 200, h: 100 } } });
  r = await s.call('host.screen.capture', {});
  assert.deepEqual(r.target.region, { x: 1440, y: 0, w: 160, h: 100 });
  assert.equal(r.target.display, 2);
});

test('capture: "allow while the app runs" remembers the permission, never a target; the suggestion is used afterwards', async (t) => {
  const s = setup(t);
  s.answers.push({ allow: 'session', target: { kind: 'display', display: 2 } });
  let r = await s.call('host.screen.capture', { target: 'display', display: 1 });
  assert.equal(r.target.display, 2, 'this capture is what the user picked');
  assert.equal(r.target.by, 'user');
  // later captures: no question; they show what the app suggests
  r = await s.call('host.screen.capture', { target: 'window', windowId: 7 });
  assert.equal(s.calls.choose.length, 1, 'no second question');
  assert.deepEqual(r.target, { kind: 'window', windowId: 7, display: 1, bounds: { x: 0, y: 0, w: 100, h: 80 }, by: 'app' });
  r = await s.call('host.screen.capture', { target: 'display', display: 1 });
  assert.deepEqual(r.target, { kind: 'display', display: 1, bounds: DISPLAY1, by: 'app' });
  assert.deepEqual(s.captures().map((a) => a.target + (a.display || a.windowId || '')), ['display2', 'window7', 'display1']);

  // a suggestion that does not exist (any more): the main display, and the result says so
  for (const bad of [{ target: 'display', display: 99 }, { target: 'window', windowId: 4242 }, { target: 'region', region: { x: 90000, y: 0, w: 10, h: 10 } }]) {
    r = await s.call('host.screen.capture', { ...bad, maxWidth: 800 });
    assert.deepEqual(r.target, { kind: 'display', display: 1, bounds: DISPLAY1, by: 'default' }, JSON.stringify(bad));
    assert.equal(s.captures().at(-1).maxWidth, 800);
    assert.equal(s.captures().at(-1).target, 'display');
  }
  assert.match(s.traffic.at(-1).detail, /^capture display \(main display\)/);
  assert.equal(s.calls.choose.length, 1);

  // the run ends: the question comes back
  s.caps.stopApp(s.ctx.key);
  s.answers.push(false);
  await assert.rejects(s.call('host.screen.capture', {}), /permission denied: declined by the user/);
  assert.equal(s.calls.choose.length, 2);
});

test('capture: modes session and always never ask, and use the suggestion', async (t) => {
  for (const mode of ['session', 'always']) {
    const s = setup(t, { grants: { screen: { mode } } });
    const r = await s.call('host.screen.capture', { target: 'display', display: 2 });
    assert.equal(s.calls.choose.length, 0);
    assert.deepEqual(r.target, { kind: 'display', display: 2, bounds: DISPLAY2, by: 'app' });
  }
});

test('capture: declined, or a nonsense answer from the UI, captures nothing', async (t) => {
  const s = setup(t);
  await assert.rejects(s.call('host.screen.capture', {}), /permission denied: declined by the user/);
  s.answers.push({ allow: false, target: { kind: 'display', display: 1 } });
  await assert.rejects(s.call('host.screen.capture', {}), /declined/);
  const nonsense = [
    { allow: true, target: { kind: 'display', display: -1 } },
    { allow: true, target: { kind: 'display', display: 1.5 } },
    { allow: true, target: { kind: 'window', windowId: 'x' } },
    { allow: true, target: { kind: 'region', region: { x: 0, y: 0, w: 0, h: 5 } } },
    { allow: true, target: { kind: 'region' } },
    { allow: true, target: { kind: 'file', path: '/etc/passwd' } },
    { allow: true, target: 'display' },
    { allow: true, target: null },
    'yes',
    true,
  ];
  for (const a of nonsense) {
    s.answers.push(a);
    await assert.rejects(s.call('host.screen.capture', {}), /declined/, JSON.stringify(a));
  }
  assert.deepEqual(s.captures(), [], 'the helper never got a capture request');
  assert.equal(s.warnings.filter((w) => /^confirmUse failed: /.test(w)).length, 8, 'the eight bad targets are reported as warnings');
  assert.ok(s.traffic.every((e) => e.allowed === false));
});

test('capture: a malformed request is an error and never a question; an ungranted app learns only that it is denied', async (t) => {
  const s = setup(t);
  await assert.rejects(s.call('host.screen.capture', { target: 'screen' }), /target/);
  await assert.rejects(s.call('host.screen.capture', { target: 'window' }), /windowId/);
  await assert.rejects(s.call('host.screen.capture', { display: -2 }), /display/);
  await assert.rejects(s.call('host.screen.capture', { maxWidth: 99999 }), /maxWidth/);
  assert.equal(s.calls.choose.length, 0, 'nobody was asked about a request that cannot be served');
  s.state.grants = {};
  await assert.rejects(s.call('host.screen.capture', { target: 'screen' }), /permission denied: "screen" is not granted by the user/, 'the permission check comes first');
  assert.equal(s.calls.choose.length, 0);
});

test('capture: allowing the window list does not allow screenshots; allowing screenshots allows the window list', async (t) => {
  const a = setup(t);
  a.calls.confirmAnswer = 'session';
  await a.call('host.screen.windows', {});
  assert.equal(a.calls.confirm.length, 1);
  await assert.rejects(a.call('host.screen.capture', {}), /declined/, 'asked again (the scripted picker queue is empty: declined)');
  assert.equal(a.calls.choose.length, 1, 'the earlier "allow while the app runs" for the list does not cover pictures');

  const b = setup(t);
  b.answers.push({ allow: 'session', target: { kind: 'display', display: 1 } });
  await b.call('host.screen.capture', {});
  await b.call('host.screen.windows', {});
  assert.equal(b.calls.confirm.length, 0, 'but a picture allowed for the run also covers the list of windows');
});

test('capture: a UI without chooseCapture (the headless one) keeps working: confirmUse answers, the suggestion is captured', async (t) => {
  const ui = new FakeCapabilitiesUi({ allow: true });
  const s = setup(t, { ui });
  const r = await s.call('host.screen.capture', { target: 'window', windowId: 7 });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].op, 'host.screen.capture');
  assert.deepEqual(ui.calls[0].suggestion, { target: 'window', windowId: 7 });
  assert.deepEqual(r.target, { kind: 'window', windowId: 7, display: 1, bounds: { x: 0, y: 0, w: 100, h: 80 }, by: 'app' });
  ui.allow = false;
  await assert.rejects(s.call('host.screen.capture', {}), /declined by the user/);
});

// ------------------------------------------------------------------------------------------------ the loader's own windows

test('the loader’s own windows: never listed to an app, always excluded from a capture', async (t) => {
  const s = setup(t, { grants: { screen: { mode: 'always' } } });
  const list = await s.call('host.screen.windows', {});
  assert.deepEqual(list.map((w) => w.windowId), [7, 8], 'the badge/overlay/picker window (pid of the loader) is not in the list');
  await s.call('host.screen.capture', {});
  await s.call('host.screen.capture', { target: 'region', region: { x: 0, y: 0, w: 50, h: 50 } });
  assert.ok(s.captures().every((a) => Array.isArray(a.excludePids) && a.excludePids.includes(PID)), 'every capture asks the helper to leave the loader’s windows out');
  // the app cannot capture one by id: the helper says "not found" for a window of an excluded process, so the suggestion
  // counts as gone and the main display is captured instead
  const r = await s.call('host.screen.capture', { target: 'window', windowId: 99 });
  assert.equal(r.target.by, 'default');
  assert.equal(r.target.kind, 'display');
  // the exclusion list is an option of the broker; with none the fake lists everything
  const open = setup(t, { grants: { screen: { mode: 'always' } }, opts: { excludePids: [] } });
  assert.deepEqual((await open.call('host.screen.windows', {})).map((w) => w.windowId), [7, 8, 99]);
});

test('the fake helper models excludePids like the real one (what the loader tests rely on)', async (t) => {
  const ctl = new HostCtl({ command: [process.execPath, FAKE_CTL] });
  t.after(() => ctl.close());
  let r = await ctl.request('capture', { target: 'display', excludePids: [PID] });
  assert.deepEqual(r.omitted, [99], 'the loader’s window would be left out of the picture');
  r = await ctl.request('capture', { target: 'display' });
  assert.deepEqual(r.omitted, [], 'nothing is left out without excludePids');
  await assert.rejects(ctl.request('capture', { target: 'window', windowId: 99, excludePids: [PID] }), (e) => e.code === 'not-found');
  r = await ctl.request('capture', { target: 'window', windowId: 99 });
  assert.equal(r.bounds.w, 540);
  await assert.rejects(ctl.request('capture', { target: 'display', display: 5 }), (e) => e.code === 'not-found');
  await assert.rejects(ctl.request('capture', { target: 'region', region: { x: 99999, y: 0, w: 10, h: 10 } }), (e) => e.code === 'bad-request');
});

// ------------------------------------------------------------------------------------------------ parameters and results

test('captureArgs: the suggestion is validated; display is an id; a region is global; a window names its own display', () => {
  assert.deepEqual(captureArgs({}), { target: 'display' });
  assert.deepEqual(captureArgs({ display: 4294967295 }), { target: 'display', display: 4294967295 }, 'a CGDirectDisplayID can be large');
  assert.deepEqual(captureArgs({ target: 'region', region: { x: -1500, y: 20, w: 300, h: 200 }, display: 3 }), { target: 'region', region: { x: -1500, y: 20, w: 300, h: 200 } }, 'negative x: a display to the left; display is ignored for a region');
  assert.deepEqual(captureArgs({ target: 'window', windowId: 5, display: 2 }), { target: 'window', windowId: 5 });
  for (const bad of [{ display: 4294967296 }, { display: -1 }, { display: 1.5 }, { display: '1' }, { windowId: 1, target: 'window', maxWidth: 0 }]) assert.throws(() => captureArgs(bad), Error, JSON.stringify(bad));
});

test('pickedArgs and captureTarget: only the three kinds, exact shapes', () => {
  assert.deepEqual(pickedArgs({ kind: 'display', display: 7 }), { target: 'display', display: 7 });
  assert.deepEqual(pickedArgs({ kind: 'window', windowId: 0 }), { target: 'window', windowId: 0 });
  assert.deepEqual(pickedArgs({ kind: 'region', region: { x: 1, y: 2, w: 3, h: 4, extra: 'ignored' } }), { target: 'region', region: { x: 1, y: 2, w: 3, h: 4 } });
  for (const bad of [null, [], 'display', {}, { kind: 'x' }, { kind: 'display' }, { kind: 'display', display: NaN }, { kind: 'window' }, { kind: 'region', region: { x: 0, y: 0, w: 1e9, h: 1 } }]) assert.throws(() => pickedArgs(bad), Error, JSON.stringify(bad));
  // an older helper sends no display or bounds: the target still says what it can
  assert.deepEqual(captureTarget({ target: 'display' }, {}, 'app'), { kind: 'display', by: 'app' });
  assert.deepEqual(captureTarget({ target: 'region', region: { x: 1, y: 2, w: 3, h: 4 } }, {}, 'user'), { kind: 'region', region: { x: 1, y: 2, w: 3, h: 4 }, by: 'user' });
  assert.deepEqual(captureTarget({ target: 'display', display: 2 }, { display: 2, bounds: { x: 0, y: 0, w: 5, h: 6, junk: 1 } }, 'user'), { kind: 'display', display: 2, bounds: { x: 0, y: 0, w: 5, h: 6 }, by: 'user' });
});

// ------------------------------------------------------------------------------------------------ input activity (the overlay)

test('input activity: the UI is told what the app does (positions, keys), the Inspector never sees typed text', async (t) => {
  const s = setup(t, { grants: { input: { mode: 'session' } } });
  const { sessionId } = await s.call('host.input.start', { reason: 'test' });
  await s.call('host.input.mouse', { sessionId, action: 'move', x: 10, y: 20 });
  await s.call('host.input.mouse', { sessionId, action: 'click', x: 30, y: 40, clicks: 2 });
  await s.call('host.input.mouse', { sessionId, action: 'down', x: 50, y: 60, button: 'right' });
  await s.call('host.input.mouse', { sessionId, action: 'scroll', dy: 120 });
  await s.call('host.input.keys', { sessionId, text: 'hunter2 secret' });
  await s.call('host.input.keys', { sessionId, key: 's', modifiers: ['cmd'] });
  const strip = ({ app, sessionId: sid, ...rest }) => {
    assert.deepEqual(app, { id: 'com.example.agent', name: 'Agent' });
    assert.equal(sid, sessionId);
    return JSON.parse(JSON.stringify(rest)); // drops undefined
  };
  assert.deepEqual(s.calls.activity.map(strip), [
    { kind: 'mouse', action: 'move', x: 10, y: 20, button: 'left', clicks: 1 },
    { kind: 'mouse', action: 'click', x: 30, y: 40, button: 'left', clicks: 2 },
    { kind: 'mouse', action: 'down', x: 50, y: 60, button: 'right', clicks: 1 },
    { kind: 'mouse', action: 'scroll', button: 'left', clicks: 1, dy: 120 },
    { kind: 'keys', text: 'hunter2 secret' },
    { kind: 'keys', key: 's', modifiers: ['cmd'] },
  ]);
  assert.ok(!JSON.stringify(s.traffic).includes('hunter2'), 'typed text is not in the Inspector events');
  // a request that fails validation or is refused draws nothing
  const n = s.calls.activity.length;
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'teleport' }), /action/);
  await assert.rejects(s.call('host.input.keys', { sessionId }), /exactly one/);
  await assert.rejects(s.call('host.input.mouse', { sessionId: 'nope', action: 'move', x: 1, y: 1 }), /no such input session/);
  assert.equal(s.calls.activity.length, n);
});

test('input activity: an overlay that fails (throws, or rejects) never breaks the input', async (t) => {
  for (const bad of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('later'))]) {
    const s = setup(t, { grants: { input: { mode: 'session' } }, ui: { inputStarted() {}, inputStopped() {}, inputActivity: bad } });
    const { sessionId } = await s.call('host.input.start', {});
    assert.deepEqual(await s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }), {});
    assert.deepEqual(await s.call('host.input.keys', { sessionId, text: 'x' }), {});
  }
  // and a UI that has no inputActivity at all is fine too
  const s = setup(t, { grants: { input: { mode: 'session' } }, ui: { inputStarted() {}, inputStopped() {} } });
  const { sessionId } = await s.call('host.input.start', {});
  assert.deepEqual(await s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }), {});
});
