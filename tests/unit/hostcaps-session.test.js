'use strict';
// AppSession + HostCapabilities end to end without a VM: the SDK fixture app calls host.* through the real bridge,
// vmapp-vm is replaced by fixtures/fake-vmapp-vm.js and vmapp-hostctl by fixtures/fake-hostctl.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AppSession } = require('../../hostlib/session');
const { Store } = require('../../hostlib/store');
const { pack } = require('../../hostlib/package');
const { FakeWindowManager, FakeDialogs, FakeCapabilitiesUi } = require('../../hostlib/headless');
const { Catalog, HostCapabilities } = require('../../hostlib/capabilities');
const { HostCtl } = require('../../hostlib/hostproc');
const { tmpdir, rmrf, makeProject, wait } = require('./helpers');

const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const FAKE_CTL = path.join(__dirname, 'fixtures', 'fake-hostctl.js');
const APP = path.join(__dirname, 'fixtures', 'app-main.js');
const ID = 'com.example.notes';
const HOST_REQUEST = [{ cap: 'screen', purpose: 'look' }, { cap: 'input', purpose: 'click' }, { cap: 'tool:*', purpose: 'tools' }, { cap: 'mcp:*' }];

function setup(t, { hostRequest = HOST_REQUEST, hostGrants = {}, allow = true, withCaps = true, dialogs } = {}) {
  const d = tmpdir('hcs-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  const permissions = { folders: [{ name: 'notes', access: 'readwrite', purpose: 'n' }], dialogs: true, external: false };
  if (hostRequest) permissions.host = hostRequest;
  makeProject(proj, { manifest: { permissions } });
  const vmapp = path.join(d, 'a.vmapp');
  pack(proj, vmapp);
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(vmapp);
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  fs.writeFileSync(path.join(d, 'Image'), 'k');
  fs.writeFileSync(path.join(d, 'initramfs.cpio'), 'i');
  const notes = path.join(d, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'a.txt'), 'alpha');
  process.env.FAKE_VM_APP = APP;
  process.env.FAKE_VM_LOG = path.join(d, 'vm.log');
  t.after(() => {
    delete process.env.FAKE_VM_APP;
    delete process.env.FAKE_VM_LOG;
  });
  const ui = new FakeCapabilitiesUi({ allow });
  const catalog = new Catalog({ home });
  const caps = new HostCapabilities({ store, catalog, ui, dryRun: true, panicHotkey: true, hostctl: () => new HostCtl({ command: [process.execPath, FAKE_CTL] }) });
  t.after(() => caps.close());
  for (const [cap, g] of Object.entries(hostGrants)) store.setHostGrant(ID, cap, g);
  const wm = new FakeWindowManager();
  const session = new AppSession({
    appId: ID,
    home,
    vmappVmPath: [process.execPath, FAKE_VM],
    kernel: path.join(d, 'Image'),
    initramfs: path.join(d, 'initramfs.cpio'),
    grants: { folders: { notes: { path: notes, access: 'readwrite' } }, askEveryTime: false, host: undefined },
    windowManager: wm,
    dialogs: new FakeDialogs(dialogs),
    capabilities: withCaps ? caps : undefined,
    timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  // host grants are read live from the store (no explicit `grants.host`)
  session._grantsGiven = false;
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  return { d, home, store, catalog, caps, ui, wm, session, notes };
}

async function running(s) {
  await s.session.start();
  await s.wm.waitForWindows(1, 5000);
  return (channel, ...args) => s.wm.invoke(1, channel, ...args);
}

test('host ops: refused without permissions.host, and without a broker', async (t) => {
  const s = setup(t, { hostRequest: null, hostGrants: {} });
  const inv = await running(s);
  await assert.rejects(inv('host', 'screen.windows'), /permission denied: host/);
  await assert.rejects(inv('host', 'tool.list'), /permission denied: host/);
  const s2 = setup(t, { withCaps: false, hostGrants: { screen: { mode: 'always' } } });
  const inv2 = await running(s2);
  await assert.rejects(inv2('host', 'screen.windows'), /does not provide host capabilities/);
  // a bridge op outside SPEC stays an unknown op
  const { BridgeClient } = require('../../hostlib/bridge');
  assert.ok(BridgeClient);
  await assert.rejects(s.session._request('host.bogus', {}), /unknown op/);
});

test('host ops through the SDK and the bridge: tool, screen, input, with the user\'s grants', async (t) => {
  const s = setup(t, { hostGrants: { screen: { mode: 'always' }, input: { mode: 'ask' }, 'tool:*': { mode: 'always', tools: ['echo', 'cat'] } } });
  s.catalog.addTool({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^[\\s\\S]{0,100}$' }], variadic: true });
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [{ pattern: '^/host/[\\w-]+/[\\w.]+$', mapPath: true }] });
  const events = [];
  s.session.on('traffic', (e) => events.push(e));
  const inv = await running(s);

  assert.equal((await inv('host', 'tool.run', 'echo', ['hi;rm -rf /'])).stdout, 'hi;rm -rf /\n');
  assert.deepEqual((await inv('host', 'tool.list')).map((x) => x.id), ['echo', 'cat']);
  assert.equal((await inv('host', 'tool.run', 'cat', ['/host/f-notes/a.txt'])).stdout, 'alpha');
  await assert.rejects(inv('host', 'tool.run', 'cat', ['/host/f-notes/../../etc/passwd']), /do not match/);
  await assert.rejects(inv('host', 'tool.run', 'cat', ['/host/f-other/a.txt']), /not a folder or file granted/);
  await assert.rejects(inv('host', 'tool.run', 'ls', []), /not granted|not registered/);

  const w = await inv('host', 'screen.windows');
  assert.equal(w[0].title, 'Fake window');
  const cap = await inv('host', 'screen.capture', { target: 'display' });
  assert.equal(cap.magic, 'PNG');
  assert.ok(cap.bytes > 20);

  const r = await inv('host-input', 'form', [['mouse', { action: 'click', x: 3, y: 4 }], ['keys', 'hello'], ['keys', { key: 'return' }], ['stop']]);
  assert.equal(r.out.length, 4);
  assert.deepEqual(s.ui.badges.map((b) => b.state), ['on', 'off']);
  assert.equal(s.ui.calls.filter((c) => c.cap === 'input').length, 1);

  // the Inspector: separate host events, and no payload in the generic bridge trace of host.* messages
  const hostEvents = events.filter((e) => e.kind === 'host');
  assert.ok(hostEvents.length >= 8);
  assert.ok(hostEvents.every((e) => typeof e.allowed === 'boolean' && e.op.startsWith('host.')));
  assert.ok(hostEvents.some((e) => e.op === 'host.tool.run' && e.allowed === true && /echo/.test(e.detail)));
  const bridgeHost = events.filter((e) => e.t !== 'host' && typeof e.op === 'string' && e.op.startsWith('host.'));
  assert.ok(bridgeHost.length >= 8);
  for (const e of bridgeHost) assert.match(e.preview, /payload not shown/);
  assert.ok(!JSON.stringify(events).includes('iVBORw0KGgo'), 'no screenshot bytes in any event');
  assert.ok(!JSON.stringify(events).includes('text\\":\\"hello'), 'typed text is not in any event');
  assert.ok(!JSON.stringify(events).includes('"text":"hello'));
});

test('host ops: a file pick and a save target become mappable only once granted', async (t) => {
  const s = setup(t, { hostGrants: { 'tool:cat': { mode: 'always' }, 'tool:echo': { mode: 'always' } }, hostRequest: [{ cap: 'tool:cat' }, { cap: 'tool:echo' }], dialogs: {} });
  const pickFile = path.join(s.d, 'picked.txt');
  fs.writeFileSync(pickFile, 'picked!');
  const target = path.join(s.d, 'out.png');
  s.session.dialogs.opts.open = [pickFile];
  s.session.dialogs.opts.save = target;
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [{ pattern: '^/host/[\\w-]+/[\\w.]+$', mapPath: 'read' }] });
  s.catalog.addTool({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^/host/[\\w-]+/[\\w.]+$', mapPath: 'write' }] });
  const inv = await running(s);
  await assert.rejects(inv('host', 'tool.run', 'cat', ['/host/pick-0/picked.txt']), /not a folder or file granted/);
  const dlg = await s.session._request('dialog.open', { directory: false });
  assert.deepEqual(dlg.paths, ['/host/pick-0/picked.txt']);
  assert.equal((await inv('host', 'tool.run', 'cat', ['/host/pick-0/picked.txt'])).stdout, 'picked!');
  assert.equal((await inv('host', 'tool.run', 'cat', ['/host/pick-0/other.txt'])).exitCode, 1); // inside the share, but not there
  await assert.rejects(inv('host', 'tool.run', 'echo', ['/host/pick-0/picked.txt']), /read-only share/);
  const sv = await s.session._request('dialog.save', { defaultName: 'out.png' });
  assert.equal(sv.path, '/host/save-0/out.png');
  assert.equal((await inv('host', 'tool.run', 'echo', [sv.path])).stdout, `${target}\n`);
  await assert.rejects(inv('host', 'tool.run', 'cat', [sv.path]), /write-only/);
  await assert.rejects(inv('host', 'tool.run', 'echo', ['/host/save-0/x.png']), /only \/host\/save-0\/out\.png/);
});

test('host ops: stopping the app ends input control at once and turns session grants back into ask', async (t) => {
  const s = setup(t, { hostGrants: { input: { mode: 'session' }, screen: { mode: 'session' } } });
  const inv = await running(s);
  const r = await inv('host-input', 'x', []);
  assert.match(r.id, /^[0-9a-f]{16}$/);
  assert.equal(s.caps.active().length, 1);
  await s.session.stop();
  assert.equal(s.caps.active().length, 0);
  assert.equal(s.ui.badges.at(-1).state, 'off');
  assert.match(s.ui.badges.at(-1).reason, /app-stopp/);
  assert.equal(s.store.loadHostGrants(ID).input.mode, 'ask');
  assert.equal(s.store.loadHostGrants(ID).screen.mode, 'ask');
});

test('host ops: revoking a grant applies to the running app at its next call', async (t) => {
  const s = setup(t, { hostGrants: { screen: { mode: 'always' } } });
  const inv = await running(s);
  await inv('host', 'screen.windows');
  s.store.setHostGrant(ID, 'screen', null);
  await assert.rejects(inv('host', 'screen.windows'), /permission denied: "screen" is not granted/);
  await wait(10);
});
