'use strict';
// The loader's library logic for the network permission (SPEC 8.3) and the VM size (SPEC 2.2, 8), without Electron:
// loader/src/library.js is loaded with a stand-in for `electron`, on top of the real hostlib Store. What the renderer sends is
// re-validated here (INV-B5, INV-D3, INV-N2): the sheet can only grant what the manifest asks, never more ports, and nothing
// is saved if any part of the sheet is invalid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Store } = require('../../hostlib/store');
const { pack } = require('../../hostlib/package');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const ID = 'com.example.notes';

function loadLibrary() {
  const handlers = {};
  const fake = {
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) },
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : orig.call(this, request, ...rest);
  };
  try {
    for (const f of ['library', 'window-manager']) delete require.cache[require.resolve(`../../loader/src/${f}`)];
    return { Library: require('../../loader/src/library').Library, handlers };
  } finally {
    Module._load = orig;
  }
}

/** A library over a real store with the app installed; `runner` is a stand-in. */
function setup(t, { network, folders, core, hostLimits = { cpus: 8, memoryMiB: 4096 } } = {}) {
  const d = tmpdir('lib-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, {
    manifest: {
      core: Object.assign({ command: ['node', 'main.js'] }, core),
      permissions: {
        folders: folders === undefined ? [{ name: 'notes', access: 'readwrite', purpose: 'Your notes' }] : folders,
        dialogs: true,
        external: false,
        network: network === undefined ? [{ host: 'api.example.com', purpose: 'Syncs notes' }, { host: '*.cdn.example.com', ports: [443, 80], purpose: 'Images' }] : network,
      },
    },
  });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  store.install(file);
  fs.mkdirSync(path.join(store.home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(store.runtimePath('node22')), 'img');
  const notes = path.join(d, 'user', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  const runnerState = { state: 'stopped', session: null };
  const synced = [];
  const runner = {
    on() {},
    state: () => runnerState.state,
    isActive: () => runnerState.state !== 'stopped',
    sessionOf: () => runnerState.session,
    error: () => null,
    note: () => null,
  };
  const { Library, handlers } = loadLibrary();
  const lib = new Library({
    store,
    runner,
    inspector: {},
    nativeDialogs: {},
    senders: new Map([[1, 'library']]),
    updates: {},
    catalog: null,
    capabilities: null,
    hostLimits: () => hostLimits,
    log: () => {},
  });
  const ipc = (channel, ...args) => handlers[channel]({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'f' }, ...args);
  return { d, store, lib, runnerState, synced, ipc, handlers, notes, hostLimits };
}

const app = (s) => s.store.get(ID);

// ------------------------------------------------------------------------------------------------ what the sheet and the card show

test('sheet and card data: every requested host starts on “not allowed”; the risk and the resources are filled in', (t) => {
  const s = setup(t, { core: { cpus: 4, memoryMiB: 1024 } });
  const sheet = s.lib.sheetData(app(s));
  assert.deepEqual(sheet.network.map((x) => [x.host, x.ports, x.wildcard, x.insecure, x.allowed]), [
    ['api.example.com', [443], false, false, false],
    ['*.cdn.example.com', [443, 80], true, true, false],
  ]);
  assert.equal(sheet.network[0].purpose, 'Syncs notes');
  assert.equal(sheet.risk.atRisk, true, 'folders + hosts: the loader warns');
  assert.match(sheet.risk.message, /^This app could read the folder “notes” and send what it reads to api\.example\.com and \*\.cdn\.example\.com\.$/);
  assert.equal(sheet.risk.active, false, 'nothing is allowed yet');
  assert.deepEqual(sheet.resources.recommended, { cpus: 4, memoryMiB: 1024 });
  assert.deepEqual(sheet.resources.current, { cpus: 1, memoryMiB: 1024 }, 'default: one vCPU and the recommended memory');
  assert.deepEqual(sheet.resources.limits, s.hostLimits);
  assert.equal(sheet.resources.custom, false);
  const card = s.lib.describe(app(s));
  assert.deepEqual(card.network.map((x) => x.allowed), [false, false]);
  assert.equal(card.risk.active, false);
  assert.deepEqual(card.resources.current, { cpus: 1, memoryMiB: 1024 });
});

test('an app that asks for no network has empty network data, and no risk', (t) => {
  const s = setup(t, { network: [] });
  const sheet = s.lib.sheetData(app(s));
  assert.deepEqual(sheet.network, []);
  assert.equal(sheet.risk.atRisk, false);
  assert.equal(sheet.risk.message, null);
});

test('the install review lists the hosts and says in words that the app could read folders and send them out', (t) => {
  const s = setup(t);
  const rev = s.lib._review(app(s).manifest, app(s).packageId, { package: '1 KiB', ui: '1 KiB', core: '1 KiB' });
  assert.deepEqual(rev.network.map((x) => x.host), ['api.example.com', '*.cdn.example.com']);
  assert.ok(rev.network.every((x) => x.allowed === false && x.grant === null), 'installing allows nothing');
  assert.match(rev.risk.message, /could read the folder “notes” and send what it reads to api\.example\.com/);
  assert.equal(rev.risk.active, false);
  assert.deepEqual(rev.resources.recommended, { cpus: 1, memoryMiB: 256 });
  assert.equal(s.store.hasDecided(ID), false);
});

// ------------------------------------------------------------------------------------------------ what the sheet may grant

test('normalizeNetChoices: allow / don’t allow per host; ports can only be narrowed; unknown hosts are ignored', (t) => {
  const s = setup(t);
  const a = app(s);
  assert.deepEqual(s.lib.normalizeNetChoices(a, {}), { 'api.example.com': { allow: false }, '*.cdn.example.com': { allow: false } }, 'nothing chosen: declined');
  assert.deepEqual(s.lib.normalizeNetChoices(a, undefined), { 'api.example.com': { allow: false }, '*.cdn.example.com': { allow: false } });
  assert.deepEqual(s.lib.normalizeNetChoices(a, { 'api.example.com': { allow: true } }), { 'api.example.com': { allow: true }, '*.cdn.example.com': { allow: false } });
  assert.deepEqual(s.lib.normalizeNetChoices(a, { 'api.example.com': { allow: true, ports: [443] }, '*.cdn.example.com': { allow: true, ports: [443] } }), {
    'api.example.com': { allow: true },
    '*.cdn.example.com': { allow: true, ports: [443] },
  }, 'all requested ports stay implicit; fewer are kept explicitly');
  assert.deepEqual(s.lib.normalizeNetChoices(a, { 'api.example.com': { allow: false, ports: [443] }, 'evil.example.net': { allow: true } }), { 'api.example.com': { allow: false }, '*.cdn.example.com': { allow: false } }, 'a host the manifest does not list is never granted');
  // never wider than the request
  assert.throws(() => s.lib.normalizeNetChoices(a, { 'api.example.com': { allow: true, ports: [443, 8443] } }), /wider than the requested 443/);
  assert.throws(() => s.lib.normalizeNetChoices(a, { 'api.example.com': { allow: true, ports: [] } }), /pick at least one port/);
  assert.throws(() => s.lib.normalizeNetChoices(a, { 'api.example.com': { allow: 'yes' } }), /allow or don't allow/);
  assert.throws(() => s.lib.normalizeNetChoices(a, { 'api.example.com': true }), /allow or don't allow/);
});

test('the sheet saves folders, network and the size together; an invalid part saves nothing', async (t) => {
  const s = setup(t, { core: { cpus: 2, memoryMiB: 512 } });
  const a = app(s);
  await assert.rejects(
    () => s.ipc('lib:savePermissions', ID, { notes: { path: s.notes, access: 'read' } }, false, undefined, undefined, { network: { 'api.example.com': { allow: true, ports: [9999] } }, resources: { cpus: 2, memoryMiB: 512 } }).then((r) => (r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)))),
    /wider than the requested/,
  );
  assert.equal(fs.existsSync(s.store.grantsPath(ID)), false, 'nothing was saved');
  let r = await s.ipc('lib:savePermissions', ID, { notes: { path: s.notes, access: 'read' } }, false, undefined, undefined, { network: { 'api.example.com': { allow: true } }, resources: { cpus: 2, memoryMiB: 640 } });
  assert.equal(r.ok, true, r.error);
  const g = s.store.loadGrants(ID);
  assert.deepEqual(g.folders.notes, { path: s.notes, access: 'read' });
  assert.deepEqual(g.network, { 'api.example.com': { allow: true }, '*.cdn.example.com': { allow: false } }, 'the user’s “Don’t allow” is recorded as declined');
  assert.deepEqual(g.resources, { cpus: 2, memoryMiB: 640 });
  // the card now says what the user chose
  const card = s.lib.describe(a);
  assert.deepEqual(card.network.map((x) => [x.host, x.allowed, x.allowedPorts]), [['api.example.com', true, [443]], ['*.cdn.example.com', false, []]]);
  assert.equal(card.risk.active, true, 'folder + host both allowed: the card warns');
  assert.match(card.risk.activeMessage, /^This app can read the folder “notes” and send what it reads to api\.example\.com\.$/);
  assert.deepEqual(card.resources.current, { cpus: 2, memoryMiB: 640 });
  assert.equal(card.resources.custom, true);
  // a sheet that does not mention the size or the network leaves them as they are
  r = await s.ipc('lib:savePermissions', ID, { notes: null }, false, undefined, undefined, {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(s.store.loadGrants(ID).resources, { cpus: 2, memoryMiB: 640 });
  assert.equal(s.store.loadGrants(ID).network['api.example.com'].allow, true);
  // and one that has no `extra` at all (an older caller) too
  r = await s.ipc('lib:savePermissions', ID, { notes: null }, false);
  assert.equal(r.ok, true, r.error);
  assert.equal(s.store.loadGrants(ID).network['api.example.com'].allow, true);
});

test('the sheet is refused while the app runs, and only the library window may ask', async (t) => {
  const s = setup(t);
  s.runnerState.state = 'running';
  let r = await s.ipc('lib:savePermissions', ID, {}, false, undefined, undefined, { network: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /Stop the app first/);
  r = await s.ipc('lib:setResources', ID, { cpus: 1, memoryMiB: 256 });
  assert.match(r.error, /Stop the app first/, 'a VM cannot change size while it runs');
  s.runnerState.state = 'stopped';
  for (const ch of ['lib:saveNetwork', 'lib:setResources', 'lib:riskPreview', 'lib:savePermissions']) {
    const denied = await s.handlers[ch]({ sender: { id: 99, mainFrame: 'f' }, senderFrame: 'f' }, ID, {});
    assert.deepEqual(denied, { ok: false, error: 'denied' }, `${ch}: only the library window`);
    const sub = await s.handlers[ch]({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'other' }, ID, {});
    assert.deepEqual(sub, { ok: false, error: 'denied' }, `${ch}: only its main frame`);
  }
  assert.equal(fs.existsSync(s.store.grantsPath(ID)), false);
});

// ------------------------------------------------------------------------------------------------ network while the app runs

test('saveNetwork: saved when stopped; applied to the running VM at once (syncNetwork); refused while starting or stopping', async (t) => {
  const s = setup(t);
  let r = await s.ipc('lib:saveNetwork', ID, { 'api.example.com': { allow: true } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { allowed: [], revoked: [] }, 'stopped: nothing to apply');
  assert.deepEqual(s.store.loadNetGrants(ID), { 'api.example.com': { allow: true }, '*.cdn.example.com': { allow: false } });
  // running: the session is told to sync, after the grant was saved
  const calls = [];
  s.runnerState.state = 'running';
  s.runnerState.session = {
    syncNetwork: async () => {
      calls.push(JSON.parse(JSON.stringify(s.store.loadNetGrants(ID))));
      return { allowed: [], revoked: ['api.example.com'] };
    },
  };
  r = await s.ipc('lib:saveNetwork', ID, {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { allowed: [], revoked: ['api.example.com'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]['api.example.com'].allow, false, 'the grant was on disk before the VM was told');
  // an error from the VM is reported as “saved, but ...”
  s.runnerState.session = { syncNetwork: async () => { throw new Error('vmapp-vm did not answer'); } };
  r = await s.ipc('lib:saveNetwork', ID, { 'api.example.com': { allow: true } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Saved, but the running app could not be updated \(vmapp-vm did not answer\)/);
  assert.equal(s.store.loadNetGrants(ID)['api.example.com'].allow, true, 'the choice itself was saved');
  for (const st of ['starting', 'stopping']) {
    s.runnerState.state = st;
    r = await s.ipc('lib:saveNetwork', ID, {});
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`The app is ${st}`));
  }
  // a hand-made choice for a wider port is refused here too
  s.runnerState.state = 'stopped';
  r = await s.ipc('lib:saveNetwork', ID, { 'api.example.com': { allow: true, ports: [22] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /wider than the requested/);
});

// ------------------------------------------------------------------------------------------------ the risk warning follows the choices

test('riskPreview: the loader’s sentence for the choices on screen (folders, the screen, hosts); hostile input proves nothing', (t) => {
  const s = setup(t);
  const a = app(s);
  let r = s.lib.riskPreview(a, { folders: { notes: null }, network: { 'api.example.com': { allow: true } } });
  assert.equal(r.atRisk, true);
  assert.equal(r.active, false, 'no folder chosen: the app cannot read anything');
  r = s.lib.riskPreview(a, { folders: { notes: { path: '/x', access: 'read' } }, network: {} });
  assert.equal(r.active, false, 'no host allowed');
  r = s.lib.riskPreview(a, { folders: { notes: { path: '/x', access: 'read' } }, network: { 'api.example.com': { allow: true }, '*.cdn.example.com': { allow: true } } });
  assert.equal(r.active, true);
  assert.equal(r.activeMessage, 'This app can read the folder “notes” and send what it reads to api.example.com and *.cdn.example.com.');
  // write-only access reads nothing
  const w = setup(t, { folders: [{ name: 'out', access: 'writeonly' }] });
  r = w.lib.riskPreview(app(w), { folders: { out: { path: '/x', access: 'writeonly' } }, network: { 'api.example.com': { allow: true } } });
  assert.equal(r.atRisk, false);
  assert.equal(r.active, false);
  // renderer-supplied junk: a wider access than requested, a host that is not requested, wrong types
  const ro = setup(t, { folders: [{ name: 'notes', access: 'writeonly' }] });
  r = ro.lib.riskPreview(app(ro), { folders: { notes: { path: '/x', access: 'readwrite' } }, network: { 'api.example.com': { allow: true } } });
  assert.equal(r.active, false, 'access wider than requested counts for nothing');
  for (const junk of [null, 'x', [], { folders: 5, host: 'x', network: [] }, { network: { 'evil.example.net': { allow: true } } }]) {
    const j = s.lib.riskPreview(a, junk);
    assert.equal(j.active, false);
  }
  // the screen counts as data too
  const sc = setup(t, { folders: [] });
  const m = JSON.parse(fs.readFileSync(path.join(sc.d, 'proj', 'vmapp.json'), 'utf8'));
  m.permissions.host = [{ cap: 'screen', purpose: 'Sees the screen' }];
  fs.writeFileSync(path.join(sc.d, 'proj', 'vmapp.json'), JSON.stringify(m));
  sc.store.install((() => { const f = path.join(sc.d, 'b.vmapp'); m.version = '1.0.1'; fs.writeFileSync(path.join(sc.d, 'proj', 'vmapp.json'), JSON.stringify(m)); pack(path.join(sc.d, 'proj'), f); return f; })());
  r = sc.lib.riskPreview(sc.store.get(ID), { host: { screen: { mode: 'ask' } }, network: { 'api.example.com': { allow: true } } });
  assert.equal(r.active, true);
  assert.match(r.activeMessage, /can read your screen and send what it reads to api\.example\.com/);
});

// ------------------------------------------------------------------------------------------------ the VM size

test('normalizeResources and lib:setResources: whole numbers within what this Mac allows; null forgets the choice', async (t) => {
  const s = setup(t, { core: { cpus: 4, memoryMiB: 2048 } }); // this Mac: 8 vCPUs, 4096 MB
  assert.deepEqual(s.lib.normalizeResources({ cpus: 8, memoryMiB: 4096 }), { cpus: 8, memoryMiB: 4096 });
  assert.deepEqual(s.lib.normalizeResources({ cpus: 1, memoryMiB: 64 }), { cpus: 1, memoryMiB: 64 });
  assert.equal(s.lib.normalizeResources(null), null);
  assert.throws(() => s.lib.normalizeResources({ cpus: 9, memoryMiB: 512 }), /more than it can give/);
  assert.throws(() => s.lib.normalizeResources({ cpus: 2, memoryMiB: 4097 }), /more than half of this Mac's memory/);
  assert.throws(() => s.lib.normalizeResources({ cpus: 0, memoryMiB: 512 }), /at least 1/);
  assert.throws(() => s.lib.normalizeResources({ cpus: 2, memoryMiB: 63 }), /at least 64/);
  assert.throws(() => s.lib.normalizeResources({ cpus: 2 }), /Choose the vCPUs and the memory/);
  assert.throws(() => s.lib.normalizeResources({ cpus: 1.5, memoryMiB: 512 }), /whole number/);
  assert.throws(() => s.lib.normalizeResources('big'), /not valid/);
  assert.throws(() => s.lib.normalizeResources({ cpus: 2, memoryMiB: 512, gpu: 1 }), /not something that can be set/);

  let r = await s.ipc('lib:setResources', ID, { cpus: 3, memoryMiB: 512 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result.current, { cpus: 3, memoryMiB: 512 });
  assert.equal(r.result.custom, true);
  assert.deepEqual(r.result.below, { cpus: true, memoryMiB: true }, 'below the recommendation: the card warns');
  assert.deepEqual(s.store.loadResources(ID), { cpus: 3, memoryMiB: 512 });
  assert.equal(s.store.hasDecided(ID), false, 'choosing a size does not skip the permission sheet');
  assert.equal(s.lib.needsSheet(app(s)), true, 'the first launch still shows the sheet');
  r = await s.ipc('lib:setResources', ID, { cpus: 99, memoryMiB: 512 });
  assert.equal(r.ok, false);
  assert.match(r.error, /more than it can give/);
  assert.deepEqual(s.store.loadResources(ID), { cpus: 3, memoryMiB: 512 }, 'a refused choice changes nothing');
  r = await s.ipc('lib:setResources', ID, null);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.custom, false);
  assert.deepEqual(r.result.current, { cpus: 1, memoryMiB: 2048 });
  assert.equal(s.store.loadResources(ID), null);
});

// ------------------------------------------------------------------------------------------------ when the sheet comes

test('needsSheet: an app that asks for hosts gets the sheet at its first launch, with or without a chosen size', (t) => {
  const s = setup(t, { folders: [] });
  assert.equal(s.lib.needsSheet(app(s)), true, 'network requested, nothing decided');
  s.store.saveResources(ID, { cpus: 2 });
  assert.equal(s.lib.needsSheet(app(s)), true, 'a size chosen on the card is not a decision about the hosts');
  s.store.saveGrants(ID, { folders: {}, askEveryTime: false, network: { 'api.example.com': { allow: false }, '*.cdn.example.com': { allow: false } } });
  assert.equal(s.lib.needsSheet(app(s)), false, 'decided (even to allow nothing)');
  const none = setup(t, { folders: [], network: [] });
  assert.equal(none.lib.needsSheet(app(none)), false, 'no folders, no hosts: no sheet');
});
