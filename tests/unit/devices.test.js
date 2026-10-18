'use strict';
// Devices (SPEC 2.2 permissions.devices, SPEC 7, INV-B3): the manifest field, the saved grants, the update question, the
// loader's permission gate (src/devices.js: pure, no Electron), the microphone watch, and what the live monitor shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../../hostlib/package');
const { validateManifest, ManifestError } = require('../../hostlib/manifest');
const { Store, StoreError, validateGrants, deviceAllowed, defaultHome } = require('../../hostlib/store');
const { permissionDiff, deviceDiff } = require('../../hostlib/updates');
const { microphoneRequestAllowed, microphoneCheckAllowed, clipboardRequestAllowed, clipboardCheckAllowed, DeviceGate, MicWatch } = require('../../loader/src/devices');
const { forbiddenSwitches } = require('../../loader/src/hardening');
const { pillOfEvent, buildPills, networkNames } = require('../../loader/src/monitor-model');
const { tmpdir, rmrf, makeProject, wait } = require('./helpers');

const ID = 'com.example.notes';
const base = () => ({ format: 1, id: ID, name: 'Notes', version: '1.0.0', runtime: 'node22', core: { command: ['node', 'main.js'] } });
const withDevices = (devices) => Object.assign(base(), { permissions: { devices } });
const MIC = [{ device: 'microphone', purpose: 'Records a voice note' }];

// ------------------------------------------------------------------------------------------------ manifest
test('permissions.devices: the microphone with its purpose is kept, in canonical form', () => {
  const m = validateManifest(withDevices(MIC), { files: 'forbidden' });
  assert.deepEqual(m.permissions.devices, MIC);
  assert.deepEqual(Object.keys(m.permissions), ['folders', 'dialogs', 'external', 'devices']);
  assert.deepEqual(validateManifest(withDevices([{ device: 'microphone' }]), { files: 'forbidden' }).permissions.devices, [{ device: 'microphone', purpose: '' }], 'the purpose is optional');
});

test('a manifest without devices keeps its canonical form (no empty devices key)', () => {
  const m = validateManifest(base(), { files: 'forbidden' });
  assert.deepEqual(m.permissions, { folders: [], dialogs: true, external: false });
  assert.equal('devices' in validateManifest(withDevices([]), { files: 'forbidden' }).permissions, false);
});

test('permissions.devices: only the microphone; the camera is reserved; everything else is rejected', () => {
  const bad = (devices, re) => assert.throws(() => validateManifest(withDevices(devices), { files: 'forbidden' }), (e) => e instanceof ManifestError && re.test(e.message), JSON.stringify(devices));
  bad([{ device: 'camera' }], /"camera" is reserved/);
  bad([{ device: 'microphone' }, { device: 'camera', purpose: 'x' }], /reserved/);
  bad([{ device: 'bluetooth' }], /must be one of microphone/);
  bad([{ device: 'microphone' }, { device: 'microphone' }], /not unique/);
  bad(['microphone'], /must be an object/);
  bad([{ device: 'microphone', mode: 'allow' }], /not a known key/);
  bad([{ device: 'microphone', purpose: 'x'.repeat(201) }], /at most 200/);
  bad([{ purpose: 'x' }], /must be a string/);
  bad({ device: 'microphone' }, /must be an array/);
  bad(['a', 'b', 'c', 'd', 'e'].map(() => ({ device: 'microphone' })), /at most 4 entries|not unique/);
});

// ------------------------------------------------------------------------------------------------ grants
test('grants.devices: validated, and absent when empty', () => {
  assert.deepEqual(validateGrants({ folders: {}, devices: { microphone: { mode: 'allow' } } }).devices, { microphone: { mode: 'allow' } });
  assert.equal('devices' in validateGrants({ folders: {}, devices: {} }), false);
  for (const bad of [{ camera: { mode: 'allow' } }, { microphone: { mode: 'always' } }, { microphone: { mode: 'allow', extra: 1 } }, { microphone: true }, [], 'x']) {
    assert.throws(() => validateGrants({ folders: {}, devices: bad }), StoreError, JSON.stringify(bad));
  }
});

test('device grants are stored per app, survive a folder-only save and a host-only save, and Reset forgets them', () => {
  const d = tmpdir('dev-');
  try {
    const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
    assert.deepEqual(store.loadDeviceGrants(ID), {});
    store.setDeviceGrant(ID, 'microphone', { mode: 'allow' });
    assert.deepEqual(store.loadDeviceGrants(ID), { microphone: { mode: 'allow' } });
    store.saveGrants(ID, { folders: {}, askEveryTime: true }); // the sheet saved only folders
    assert.deepEqual(store.loadDeviceGrants(ID), { microphone: { mode: 'allow' } }, 'kept');
    store.saveHostGrants(ID, { screen: { mode: 'ask' } });
    assert.deepEqual(store.loadDeviceGrants(ID), { microphone: { mode: 'allow' } }, 'kept');
    assert.deepEqual(store.loadHostGrants(ID), { screen: { mode: 'ask' } }, 'and the other way round');
    store.saveGrants(ID, { folders: {}, askEveryTime: false, devices: {} });
    assert.deepEqual(store.loadDeviceGrants(ID), {}, 'devices: {} clears them');
    assert.throws(() => store.setDeviceGrant(ID, 'camera', { mode: 'allow' }), StoreError, 'the camera cannot be granted');
    store.setDeviceGrant(ID, 'microphone', { mode: 'allow' });
    store.setDeviceGrant(ID, 'microphone', null);
    assert.deepEqual(store.loadDeviceGrants(ID), {});
    store.setDeviceGrant(ID, 'microphone', { mode: 'allow' });
    store.resetApp(ID);
    assert.deepEqual(store.loadDeviceGrants(ID), {}, 'Reset forgets grants/<id>.json');
  } finally {
    rmrf(d);
  }
});

test('a device grant does not outlive the request: a version that stops asking drops it, a later one that asks again starts on Don’t allow', async () => {
  const d = tmpdir('prune-');
  try {
    const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
    const build = (version, devices) => {
      const proj = path.join(d, `p-${version}`);
      makeProject(proj, { manifest: { version, permissions: { folders: [], dialogs: false, external: false, ...(devices ? { devices } : {}) } } });
      const file = path.join(d, `a-${version}.vmapp`);
      pkg.pack(proj, file);
      return file;
    };
    store.install(build('1.0.0', MIC));
    store.setDeviceGrant(ID, 'microphone', { mode: 'allow' });
    await wait(15);
    store.install(build('1.1.0', MIC));
    assert.deepEqual(store.loadDeviceGrants(ID), { microphone: { mode: 'allow' } }, 'still asked: the grant stays');
    await wait(15);
    store.install(build('1.2.0', null));
    assert.deepEqual(store.loadDeviceGrants(ID), {}, 'no longer asked: dropped');
    await wait(15);
    store.install(build('1.3.0', MIC));
    assert.deepEqual(store.loadDeviceGrants(ID), {}, 'asked again: off until the user allows it');
    // switching back to a version through useVersion prunes the same way
    store.setDeviceGrant(ID, 'microphone', { mode: 'allow' });
    store.useVersion(ID, '1.2.0');
    assert.deepEqual(store.loadDeviceGrants(ID), {});
  } finally {
    rmrf(d);
  }
});

test('deviceAllowed: the manifest must ask AND the user must have allowed it', () => {
  const asks = validateManifest(withDevices(MIC), { files: 'forbidden' });
  const silent = validateManifest(base(), { files: 'forbidden' });
  const granted = { devices: { microphone: { mode: 'allow' } } };
  assert.equal(deviceAllowed(asks, granted, 'microphone'), true);
  assert.equal(deviceAllowed(asks, { folders: {} }, 'microphone'), false, 'asked, not allowed');
  assert.equal(deviceAllowed(asks, null, 'microphone'), false);
  assert.equal(deviceAllowed(silent, granted, 'microphone'), false, 'allowed by a hand-written grant, but never asked for');
  assert.equal(deviceAllowed(asks, granted, 'camera'), false, 'the camera is never allowed');
  assert.equal(deviceAllowed(asks, { devices: { microphone: { mode: 'ask' } } }, 'microphone'), false, 'only the one mode the sheet offers');
  assert.equal(deviceAllowed(null, granted, 'microphone'), false);
});

test('the default data root lives under $VMAPP_WORK (default out/work), unless $VMAPP_HOME says otherwise', () => {
  const keep = { home: process.env.VMAPP_HOME, work: process.env.VMAPP_WORK };
  try {
    delete process.env.VMAPP_HOME;
    delete process.env.VMAPP_WORK;
    assert.equal(defaultHome(), path.resolve(__dirname, '..', '..', 'out', 'work', 'vmapp-home'));
    process.env.VMAPP_WORK = path.join(path.sep, 'some', 'scratch');
    assert.equal(defaultHome(), path.join(path.sep, 'some', 'scratch', 'vmapp-home'));
    process.env.VMAPP_HOME = path.join(path.sep, 'elsewhere');
    assert.equal(defaultHome(), path.join(path.sep, 'elsewhere'));
  } finally {
    for (const [k, v] of [['VMAPP_HOME', keep.home], ['VMAPP_WORK', keep.work]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ------------------------------------------------------------------------------------------------ updates
test('an update that asks for the microphone always stops and asks (SPEC 8.1)', () => {
  const oldM = validateManifest(base(), { files: 'forbidden' });
  const newM = validateManifest(withDevices(MIC), { files: 'forbidden' });
  const d = permissionDiff(oldM, newM);
  assert.equal(d.any, true);
  assert.deepEqual(d.devicesAdded, [{ device: 'microphone', purpose: 'Records a voice note' }]);
  assert.deepEqual(deviceDiff(oldM, newM).removed, []);
  // already asked: no news; asked no more: informational only
  assert.equal(permissionDiff(newM, newM).any, false);
  assert.deepEqual(permissionDiff(newM, newM).devicesAdded, []);
  const gone = permissionDiff(newM, oldM);
  assert.equal(gone.any, false);
  assert.deepEqual(gone.devicesRemoved, ['microphone']);
  // nothing else changed: the question is about the device alone
  assert.deepEqual([d.added, d.raised, d.hostAdded, d.dialogs, d.external], [[], [], [], false, false]);
});

// ------------------------------------------------------------------------------------------------ the gate (pure functions)
function fakeGate(answer = true) {
  const calls = [];
  return {
    calls,
    requestAllowed: (...a) => (calls.push(['request', ...a]), answer),
    checkAllowed: (...a) => (calls.push(['check', ...a]), answer),
    refused: (...a) => calls.push(['refused', ...a]),
  };
}
const WC = { id: 7 };
const REQ = { isMainFrame: true, requestingUrl: `vmapp-ui://${ID}/index.html` };

test('microphoneRequestAllowed: only getUserMedia with exactly ["audio"] reaches the gate; everything else is false', () => {
  const g = fakeGate(true);
  assert.equal(microphoneRequestAllowed(g, ID, WC, 'media', { ...REQ, mediaTypes: ['audio'] }), true);
  assert.equal(g.calls.filter((c) => c[0] === 'request').length, 1);
  const denied = [
    ['media', { mediaTypes: ['video'] }],
    ['media', { mediaTypes: ['audio', 'video'] }],
    ['media', { mediaTypes: ['video', 'audio'] }],
    ['media', { mediaTypes: ['audio', 'audio'] }],
    ['media', { mediaTypes: [] }],
    ['media', { mediaTypes: 'audio' }],
    ['media', {}],
    ['media', undefined],
    ['notifications', { mediaTypes: ['audio'] }],
    ['geolocation', {}],
    ['clipboard-read', {}],
    ['display-capture', {}],
    ['camera', {}],
    ['microphone', { mediaTypes: ['audio'] }],
    [undefined, {}],
  ];
  for (const [perm, details] of denied) {
    const g2 = fakeGate(true); // even a gate that would say yes is never asked
    assert.equal(microphoneRequestAllowed(g2, ID, WC, perm, details), false, `${perm} ${JSON.stringify(details)}`);
    assert.equal(g2.calls.filter((c) => c[0] === 'request').length, 0, 'the gate is not asked');
  }
  assert.equal(microphoneRequestAllowed(null, ID, WC, 'media', { mediaTypes: ['audio'] }), false, 'no gate: everything is denied');
  assert.equal(microphoneRequestAllowed(fakeGate(false), ID, WC, 'media', { ...REQ, mediaTypes: ['audio'] }), false, 'the gate decides');
  assert.equal(microphoneRequestAllowed(fakeGate('yes'), ID, WC, 'media', { ...REQ, mediaTypes: ['audio'] }), false, 'only a real true counts');
});

test('microphoneCheckAllowed: only the audio check reaches the gate', () => {
  assert.equal(microphoneCheckAllowed(fakeGate(true), ID, WC, 'media', { ...REQ, mediaType: 'audio' }), true);
  for (const [perm, details] of [['media', { mediaType: 'video' }], ['media', { mediaType: 'unknown' }], ['media', {}], ['media', undefined], ['notifications', { mediaType: 'audio' }], ['clipboard-read', {}], ['hid', {}]]) {
    const g = fakeGate(true);
    assert.equal(microphoneCheckAllowed(g, ID, WC, perm, details), false, `${perm} ${JSON.stringify(details)}`);
    assert.equal(g.calls.length, 0);
  }
  assert.equal(microphoneCheckAllowed(null, ID, WC, 'media', { mediaType: 'audio' }), false);
});

// ------------------------------------------------------------------------------------------------ the gate with a real store
function gateWith(manifestPermissions, grants) {
  const d = tmpdir('gate-');
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: manifestPermissions } });
  const file = path.join(d, 'a.vmapp');
  pkg.pack(proj, file);
  store.install(file);
  if (grants) store.saveGrants(ID, grants);
  const registry = new Map([[7, { appId: ID }], [8, { appId: 'com.example.other' }]]);
  const events = [];
  const gate = new DeviceGate({ store, registry, watch: { arm: (wc, appId) => events.push(['arm', wc.id, appId]), count: () => 0, forgetApp() {}, dispose() {} } });
  gate.on('event', (e) => events.push(['event', e.ev.cap, e.ev.op, e.ev.allowed, e.ev.message]));
  return { d, store, gate, events };
}
const asked = { folders: [], dialogs: false, external: false, devices: MIC };
const allowed = { folders: {}, askEveryTime: false, devices: { microphone: { mode: 'allow' } } };
const REQA = { ...REQ, mediaTypes: ['audio'] };

test('DeviceGate: allowed only when the manifest asks, the user allowed, and the window is this app’s own main page', () => {
  const { d, gate, events } = gateWith(asked, allowed);
  try {
    const run = (appId, wc, details) => microphoneRequestAllowed(gate, appId, wc, 'media', details);
    assert.equal(run(ID, WC, REQA), true);
    assert.deepEqual(events.filter((e) => e[0] === 'arm'), [['arm', 7, ID]], 'a granted request starts the listening watch');
    assert.deepEqual(events.filter((e) => e[0] === 'event').pop(), ['event', 'microphone', 'media.audio', true, undefined]);
    assert.equal(run(ID, { id: 8 }, REQA), false, 'a window of another app');
    assert.equal(run(ID, { id: 99 }, REQA), false, 'a web contents the loader did not create as an app window');
    assert.equal(run(ID, undefined, REQA), false);
    assert.equal(run(ID, WC, { ...REQA, isMainFrame: false }), false, 'a sub-frame');
    assert.equal(run(ID, WC, { ...REQA, requestingUrl: 'https://example.com/' }), false, 'a foreign page');
    assert.equal(run(ID, WC, { ...REQA, requestingUrl: 'vmapp-ui://com.example.other/index.html' }), false, 'another app’s origin');
    assert.equal(run(ID, WC, { mediaTypes: ['audio'] }), false, 'no page given');
    assert.equal(run('com.example.other', { id: 8 }, { isMainFrame: true, requestingUrl: 'vmapp-ui://com.example.other/', mediaTypes: ['audio'] }), false, 'an app that is not installed here');
    const denials = events.filter((e) => e[0] === 'event' && e[3] === false);
    assert.ok(denials.length >= 7 && denials.every((e) => /permission denied|^$|./.test(String(e[4]))), 'every refusal is logged with its reason');
    // the check handler uses the same decision
    assert.equal(microphoneCheckAllowed(gate, ID, WC, 'media', { ...REQ, mediaType: 'audio' }), true);
    assert.equal(microphoneCheckAllowed(gate, ID, { id: 8 }, 'media', { ...REQ, mediaType: 'audio' }), false);
  } finally {
    rmrf(d);
  }
});

test('DeviceGate: no grant, a revoked grant, and a grant for an app that never asked all say no', () => {
  const a = gateWith(asked, null);
  try {
    assert.equal(microphoneRequestAllowed(a.gate, ID, WC, 'media', REQA), false, 'asked but not allowed (the default)');
    assert.match(a.events.filter((e) => e[0] === 'event').pop()[4], /not allowed/);
    a.store.setDeviceGrant(ID, 'microphone', { mode: 'allow' });
    assert.equal(microphoneRequestAllowed(a.gate, ID, WC, 'media', REQA), true, 'allowed');
    a.store.setDeviceGrant(ID, 'microphone', null);
    assert.equal(microphoneRequestAllowed(a.gate, ID, WC, 'media', REQA), false, 'revoked: the very next request is refused');
    assert.equal(a.events.some((e) => e[0] === 'arm'), true);
  } finally {
    rmrf(a.d);
  }
  const b = gateWith({ folders: [], dialogs: false, external: false }, allowed); // a hand-written grant, no request in the manifest
  try {
    assert.equal(microphoneRequestAllowed(b.gate, ID, WC, 'media', REQA), false);
    assert.match(b.events.filter((e) => e[0] === 'event').pop()[4], /manifest does not ask/);
    assert.equal(b.events.some((e) => e[0] === 'arm'), false);
  } finally {
    rmrf(b.d);
  }
});

// ------------------------------------------------------------------------------------------------ the clipboard (DEV-APPS C5)
const CLIP = [{ device: 'clipboard', purpose: 'Paste into the editor' }];
const clipAsked = { folders: [], dialogs: false, external: false, devices: CLIP };
const clipAllowed = { folders: {}, askEveryTime: false, devices: { clipboard: { mode: 'allow' } } };

test('clipboardRequestAllowed / clipboardCheckAllowed: only clipboard-read and clipboard-sanitized-write reach the gate', () => {
  const gate = (answer) => ({ calls: [], clipboardAllowed(...a) { this.calls.push(a); return answer; }, clipboardChecked(...a) { this.calls.push(a); return answer; }, refused() {} });
  for (const perm of ['clipboard-read', 'clipboard-sanitized-write']) {
    assert.equal(clipboardRequestAllowed(gate(true), ID, WC, perm, REQ), true, perm);
    assert.equal(clipboardCheckAllowed(gate(true), ID, WC, perm, REQ), true, perm);
    assert.equal(clipboardRequestAllowed(gate(false), ID, WC, perm, REQ), false);
    assert.equal(clipboardRequestAllowed(gate('yes'), ID, WC, perm, REQ), false, 'only a real true counts');
    assert.equal(clipboardRequestAllowed(null, ID, WC, perm, REQ), false, 'no gate: denied');
  }
  for (const perm of ['media', 'notifications', 'geolocation', 'clipboard', 'clipboard-write', 'display-capture', 'hid', undefined]) {
    const g = gate(true);
    assert.equal(clipboardRequestAllowed(g, ID, WC, perm, REQ), false, String(perm));
    assert.equal(clipboardCheckAllowed(g, ID, WC, perm, REQ), false, String(perm));
    assert.equal(g.calls.length, 0, 'the gate is not asked');
  }
});

test('DeviceGate (clipboard): the manifest asks, the user allowed, this app’s own main page; revoking applies at once; logged', () => {
  const a = gateWith(clipAsked, null);
  try {
    const run = (wc, details, perm = 'clipboard-read') => clipboardRequestAllowed(a.gate, ID, wc, perm, details);
    assert.equal(run(WC, REQ), false, 'asked but not allowed (the default)');
    a.store.setDeviceGrant(ID, 'clipboard', { mode: 'allow' });
    assert.equal(run(WC, REQ), true);
    assert.equal(run(WC, REQ, 'clipboard-sanitized-write'), true);
    assert.equal(clipboardCheckAllowed(a.gate, ID, WC, 'clipboard-read', REQ), true);
    assert.equal(run({ id: 8 }, REQ), false, 'a window of another app');
    assert.equal(run(WC, { ...REQ, isMainFrame: false }), false, 'a sub-frame (a webview cannot read the clipboard)');
    assert.equal(run(WC, { ...REQ, requestingUrl: 'vmapp-frame://abc/x.html' }), false, 'an isolated frame');
    assert.equal(microphoneRequestAllowed(a.gate, ID, WC, 'media', REQA), false, 'the clipboard grant is not the microphone');
    a.store.setDeviceGrant(ID, 'clipboard', null);
    assert.equal(run(WC, REQ), false, 'revoked: the very next request is refused');
    const rows = a.events.filter((e) => e[0] === 'event' && e[1] === 'clipboard');
    assert.deepEqual(rows.slice(0, 3).map((e) => [e[2], e[3]]), [['clipboard.read', false], ['clipboard.read', true], ['clipboard.write', true]]);
  } finally {
    rmrf(a.d);
  }
  const b = gateWith({ folders: [], dialogs: false, external: false }, clipAllowed); // a hand-written grant, no request in the manifest
  try {
    assert.equal(clipboardRequestAllowed(b.gate, ID, WC, 'clipboard-read', REQ), false);
  } finally {
    rmrf(b.d);
  }
  const c = gateWith(asked, { ...allowed, devices: { microphone: { mode: 'allow' }, clipboard: { mode: 'allow' } } }); // asks for the microphone only
  try {
    assert.equal(clipboardRequestAllowed(c.gate, ID, WC, 'clipboard-read', REQ), false, 'a grant for a device the manifest does not ask for');
  } finally {
    rmrf(c.d);
  }
});

test('DeviceGate: a request that includes video is refused as a whole and logged as the camera', () => {
  const { d, gate, events } = gateWith(asked, allowed);
  try {
    assert.equal(microphoneRequestAllowed(gate, ID, WC, 'media', { ...REQ, mediaTypes: ['audio', 'video'] }), false);
    assert.equal(microphoneRequestAllowed(gate, ID, WC, 'media', { ...REQ, mediaTypes: ['video'] }), false);
    const rows = events.filter((e) => e[0] === 'event');
    assert.deepEqual(rows.map((e) => [e[1], e[2], e[3]]), [['camera', 'media.video', false], ['camera', 'media.video', false]]);
    assert.equal(events.some((e) => e[0] === 'arm'), false);
  } finally {
    rmrf(d);
  }
});

// ------------------------------------------------------------------------------------------------ the listening watch
function fakeWc(id, trackCounts) {
  const handlers = {};
  let attached = false;
  const log = [];
  return {
    id,
    log,
    once: (ev, fn) => (handlers[ev] = fn),
    isDestroyed: () => false,
    destroy: () => handlers.destroyed && handlers.destroyed(),
    debugger: {
      isAttached: () => attached,
      attach: () => (attached = true),
      detach: () => (attached = false),
      sendCommand: async (m, p) => {
        log.push(m);
        if (m === 'Runtime.evaluate') return { result: { objectId: 'proto' } };
        if (m === 'Runtime.queryObjects') return { objects: { objectId: 'list' } };
        if (m === 'Runtime.callFunctionOn') return { result: { value: trackCounts.length > 1 ? trackCounts.shift() : trackCounts[0] } };
        void p;
        return {};
      },
    },
    get attached() {
      return attached;
    },
  };
}

test('MicWatch: counts live audio tracks of a granted window, tells when it changes, and detaches when idle', async () => {
  const changes = [];
  const w = new MicWatch({ intervalMs: 20, idlePolls: 3, onChange: (appId, n) => changes.push([appId, n]) });
  const wc = fakeWc(5, [0, 1, 1, 0]);
  w.arm(wc, ID);
  assert.equal(w.count(ID), 0);
  await wait(120);
  assert.deepEqual(changes, [[ID, 1], [ID, 0]], 'on, then off');
  await wait(150);
  assert.equal(wc.attached, false, 'detached once the microphone has been idle for a while');
  assert.ok(wc.log.includes('Runtime.queryObjects'));
  assert.ok(wc.log.includes('Runtime.releaseObjectGroup'));
  w.arm(wc, ID); // a new grant starts it again
  await wait(40);
  assert.equal(wc.attached, true);
  wc.destroy();
  assert.equal(w.count(ID), 0, 'a closed window is forgotten');
  w.dispose();
});

test('MicWatch: a window that fails to answer counts as no live track and never throws', async () => {
  const w = new MicWatch({ intervalMs: 20, idlePolls: 2 });
  const wc = fakeWc(6, [0]);
  wc.debugger.sendCommand = async () => {
    throw new Error('Target closed');
  };
  w.arm(wc, ID);
  await wait(100);
  assert.equal(w.count(ID), 0);
  w.dispose();
});

test('the registry says plainly that an app asks for the microphone', () => {
  const { permissionsSummary } = require('../../registry/lib/present');
  assert.equal(permissionsSummary({ folders: [], dialogs: false, external: false }), 'none');
  assert.match(permissionsSummary({ folders: [], dialogs: false, external: false, devices: [{ device: 'microphone' }] }), /microphone \(you choose whether to allow it\)/);
});

// ------------------------------------------------------------------------------------------------ CLI
test('CLI: inspect lists the device, grant-device allows and revokes it (only for an app that asks), the camera is refused', (t) => {
  const { spawnSync } = require('child_process');
  const cli = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
  const d = tmpdir('dcli-');
  t.after(() => rmrf(d));
  const env = { ...process.env, VMAPP_HOME: path.join(d, 'home') };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: { folders: [], dialogs: false, external: false, devices: MIC } } });
  const file = path.join(d, 'a.vmapp');
  pkg.pack(proj, file);
  const inspected = run('inspect', file);
  assert.equal(inspected.code, 0, inspected.err);
  assert.match(inspected.out, /device microphone: Records a voice note/);
  fs.mkdirSync(path.join(d, 'home', 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(d, 'home', 'runtimes', 'node22.img'), 'img'); // the install only checks that the runtime exists
  const installed = run('install', file);
  assert.equal(installed.code, 0, installed.err);
  assert.match(run('grant-device', ID, '--list').out, /microphone {2}not allowed {2}- Records a voice note/);
  assert.match(run('grant-device', ID, 'microphone').out, /allowed microphone/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'home', 'grants', `${ID}.json`), 'utf8')).devices, { microphone: { mode: 'allow' } });
  assert.match(run('grant-device', ID, '--list').out, /allowed while the app runs/);
  const cam = run('grant-device', ID, 'camera');
  assert.notEqual(cam.code, 0);
  assert.match(cam.err, /does not ask for the device "camera"/);
  assert.match(run('grant-device', ID, 'microphone', '--revoke').out, /revoked/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'home', 'grants', `${ID}.json`), 'utf8')).devices, undefined);
  // a package whose manifest asks for the camera is not valid at all
  makeProject(path.join(d, 'cam'), { manifest: { permissions: { folders: [], dialogs: false, external: false, devices: [{ device: 'camera' }] } } });
  const bad = run('pack', path.join(d, 'cam'), '-o', path.join(d, 'cam.vmapp'));
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /"camera" is reserved/);
});

// ------------------------------------------------------------------------------------------------ hardening
test('a packaged loader refuses the fake-media switches (--use-fake-ui-for-media-stream would skip the permission gate)', () => {
  assert.deepEqual(forbiddenSwitches(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--monitor']), ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
  assert.deepEqual(forbiddenSwitches(['--monitor', '--inspector']), []);
});

// ------------------------------------------------------------------------------------------------ the live monitor's model
test('monitor: which events make which pill pulse (kinds only; refused attempts do not count)', () => {
  assert.equal(pillOfEvent('exported', {}), 'folders');
  assert.equal(pillOfEvent('traffic', { t: 'grant', op: 'pick-0' }), 'folders');
  assert.equal(pillOfEvent('traffic', { kind: 'host', cap: 'screen', allowed: true }), 'screen');
  assert.equal(pillOfEvent('traffic', { kind: 'host', cap: 'input', allowed: true }), 'input');
  assert.equal(pillOfEvent('traffic', { kind: 'host', cap: 'tool:echo', allowed: true }), 'tools');
  assert.equal(pillOfEvent('traffic', { kind: 'host', cap: 'mcp:fake', allowed: true }), 'mcp');
  assert.equal(pillOfEvent('traffic', { kind: 'host', cap: 'microphone', allowed: true }), 'mic');
  assert.equal(pillOfEvent('traffic', { kind: 'net', allowed: true }), 'net');
  assert.equal(pillOfEvent('traffic', { t: 'net' }), 'net');
  assert.equal(pillOfEvent('traffic', { kind: 'host', cap: 'screen', allowed: false }), null, 'a refusal is not use');
  assert.equal(pillOfEvent('traffic', { dir: 'to-core', t: 'invoke', channel: 'echo' }), null, 'ordinary bridge traffic is not a pill');
  assert.equal(pillOfEvent('log', {}), null);
  assert.equal(pillOfEvent('traffic', null), null);
});

test('monitor: pills come from what the user allowed, in a fixed order, with hover text', () => {
  const m = validateManifest(
    Object.assign(base(), { permissions: { folders: [{ name: 'notes', access: 'readwrite' }, { name: 'export', access: 'writeonly' }, { name: 'skipped', access: 'read' }], devices: MIC, host: [{ cap: 'screen' }, { cap: 'input' }, { cap: 'tool:*' }, { cap: 'mcp:*' }] } }),
    { files: 'forbidden' },
  );
  const grants = {
    folders: { notes: { path: '/a', access: 'read' }, export: { path: '/b', access: 'writeonly' }, skipped: null },
    host: { screen: { mode: 'ask' }, input: { mode: 'session' }, 'tool:*': { mode: 'ask', tools: ['echo', 'cat'] }, 'mcp:*': { mode: 'ask', servers: ['fake'] } },
    devices: { microphone: { mode: 'allow' } },
  };
  const pills = buildPills({ manifest: m, grants, active: [{ kind: 'input' }], picks: 1, listening: true, used: { screen: 12345 } });
  assert.deepEqual(pills.map((p) => p.kind), ['folders', 'screen', 'input', 'mic', 'tools', 'mcp']);
  const by = Object.fromEntries(pills.map((p) => [p.kind, p]));
  assert.equal(by.folders.label, 'Folders 3');
  assert.equal(by.folders.title, 'Folders: notes (read only), export (write only), 1 chosen in a dialog');
  assert.equal(by.screen.lastAt, 12345);
  assert.equal(by.screen.live, false);
  assert.equal(by.input.live, true, 'an input session is continuous use');
  assert.equal(by.mic.live, true, 'a live microphone is continuous use');
  assert.match(by.tools.title, /echo, cat/);
  assert.match(by.mcp.title, /fake/);
  assert.match(by.screen.title, /asks you every time/);
  // nothing allowed, nothing shown
  assert.deepEqual(buildPills({ manifest: m, grants: { folders: {} } }), []);
  // a microphone the manifest never asked for is not shown even if a grant exists
  assert.deepEqual(buildPills({ manifest: validateManifest(base(), { files: 'forbidden' }), grants: { folders: {}, devices: { microphone: { mode: 'allow' } } } }), []);
});

test('monitor: a network pill appears only for a requested AND allowed host (SPEC 8.3 grants: {"<host>": {allow, ports?}})', () => {
  // the manifest is built by hand: this test does not depend on how manifest.js validates permissions.network
  const manifest = { permissions: { folders: [], network: [{ host: 'api.example.com' }, { host: '*.example.org', ports: [443, 8443] }, { host: 'declined.example.net' }] } };
  assert.equal(networkNames({}, manifest), null);
  assert.equal(networkNames({ network: {} }, manifest), null);
  assert.equal(networkNames({ network: { 'api.example.com': { allow: false } } }, manifest), null, 'declined');
  assert.equal(networkNames({ network: { 'unrequested.example.com': { allow: true } } }, manifest), null, 'a grant the manifest does not request is ignored');
  assert.equal(networkNames({ network: ['api.example.com'] }, manifest), null, 'not the SPEC shape');
  assert.deepEqual(networkNames({ network: { 'api.example.com': { allow: true }, 'declined.example.net': { allow: false }, '*.example.org': { allow: true, ports: [443] } } }, manifest), ['api.example.com:443', '*.example.org:443']);
  assert.deepEqual(networkNames({ network: { '*.example.org': { allow: true } } }, manifest), ['*.example.org:443,8443'], 'no ports in the grant: all the requested ones');
  const p = buildPills({ manifest, grants: { folders: {}, network: { 'api.example.com': { allow: true } } }, used: { net: 5 } });
  assert.deepEqual(p.map((x) => [x.kind, x.label, x.lastAt]), [['net', 'Network', 5]]);
  assert.match(p[0].title, /api\.example\.com:443/);
});

test('devices.js and window-manager.js: the permission handlers of an app partition answer only through the gate', () => {
  const wm = fs.readFileSync(path.join(__dirname, '..', '..', 'loader', 'src', 'window-manager.js'), 'utf8');
  // 'media' goes to the microphone gate, everything else to the clipboard gate (which refuses all but the two clipboard permissions)
  assert.match(wm, /if \(permission === 'media'\) return callback\(microphoneRequestAllowed\(devices, appId, wc, permission, details\)\);\s*return callback\(clipboardRequestAllowed\(devices, appId, wc, permission, details\)\);/);
  assert.match(wm, /if \(permission === 'media'\) return microphoneCheckAllowed\(devices, appId, wc, permission, details\);\s*return clipboardCheckAllowed\(devices, appId, wc, permission, details\);/);
  assert.match(wm, /setDevicePermissionHandler\(\(\) => false\)/, 'hid / usb / serial stay denied');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'loader', 'main.js'), 'utf8');
  assert.match(main, /ses\.setPermissionRequestHandler\(\(wc, permission, callback\) => callback\(false\)\)/, 'the loader’s own windows get nothing');
  assert.match(main, /ses\.setPermissionCheckHandler\(\(\) => false\)/);
});
