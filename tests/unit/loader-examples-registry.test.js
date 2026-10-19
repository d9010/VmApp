'use strict';
// "Load examples" from the registry (loader/src/examples.js, loader/src/library.js): a launcher that carries no samples lists the
// apps of the publisher whose DOMAIN the registry verified and installs them through the same download-and-check path as every
// registry install. Without Electron, against an in-process registry (fixtures/fake-registry.js); the folder source has its own
// tests in loader-examples.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Store } = require('../../hostlib/store');
const { Updates } = require('../../hostlib/updates');
const { pack } = require('../../hostlib/package');
const X = require('../../loader/src/examples');
const { FakeRegistry } = require('./fixtures/fake-registry');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const OFFICIAL = { level: 'domain', label: 'Verified: d9010.com', domain: 'd9010.com', company: 'D9010 Inc' };

function makePackage(t, dir, file, over = {}) {
  const proj = tmpdir('exr-proj-');
  t.after(() => rmrf(proj));
  makeProject(proj, { manifest: Object.assign({ id: `com.example.${file.replace(/\W/g, '')}`, name: file, version: '1.0.0', description: `About ${file}`, permissions: { folders: [], dialogs: false, external: false } }, over) });
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, file);
  pack(proj, out);
  return out;
}

function loadLibrary() {
  const handlers = {};
  const sent = [];
  const fake = {
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 1, send: (ch, p) => sent.push([ch, p]) } }], fromWebContents: () => null },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) },
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : orig.call(this, request, ...rest);
  };
  try {
    for (const f of ['library', 'window-manager']) delete require.cache[require.resolve(`../../loader/src/${f}`)];
    return { Library: require('../../loader/src/library').Library, handlers, sent };
  } finally {
    Module._load = orig;
  }
}

/** A registry with: A (official), B (official, 2 versions), C (unverified), D (another verified domain), E (a verified e-mail, claims the company). */
async function setup(t, { libOver = {} } = {}) {
  const d = tmpdir('exr-');
  t.after(() => rmrf(d));
  const reg = new FakeRegistry();
  await reg.start();
  t.after(() => reg.stop());
  const pk = path.join(d, 'pk');
  const ids = {};
  for (const [key, name, version, publisher] of [
    ['a', 'Alpha', '1.0.0', OFFICIAL],
    ['b', 'Beta', '1.0.0', OFFICIAL],
    ['b2', 'Beta', '1.1.0', OFFICIAL],
    ['c', 'Gamma', '1.0.0', null],
    ['d', 'Delta', '1.0.0', { level: 'domain', label: 'Verified: example.org', domain: 'example.org', company: 'D9010 Inc' }],
    ['e', 'Epsilon', '1.0.0', { level: 'email', label: 'Verified email @d9010.com', company: 'D9010 Inc' }],
  ]) {
    const id = `com.e.${key.replace(/\d/g, '')}`;
    ids[key] = id;
    reg.publish(makePackage(t, pk, `${key}-${version}.vmapp`, { id, name, version, description: `${name} sample` }));
    if (publisher) reg.publishers.set(id, publisher);
  }
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  fs.mkdirSync(path.join(store.home, 'runtimes'), { recursive: true });
  fs.writeFileSync(store.runtimePath('node22'), 'img');
  const running = new Set();
  const runner = { on() {}, state: () => 'stopped', isActive: (id) => running.has(id), sessionOf: () => null, error: () => null, note: () => null, uiContexts: new Map() };
  const updates = new Updates(store);
  const { Library, handlers, sent } = loadLibrary();
  const lib = new Library(Object.assign({ store, runner, inspector: {}, nativeDialogs: {}, senders: new Map([[1, 'library']]), updates, registryDefault: reg.url, catalog: null, capabilities: null, examplesDir: path.join(d, 'no-examples'), packaged: true, log: () => {} }, libOver));
  const ipc = (channel, ...args) => handlers[channel]({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'f' }, ...args);
  return { d, reg, store, updates, lib, ipc, running, sent, ids, pk };
}

const downloads = (reg) => reg.log.filter((l) => /\/download$/.test(l.url)).map((l) => l.url.split('/')[3]);

test('without an examples folder the launcher takes its examples from the registry, and offers them even offline', async (t) => {
  const s = await setup(t);
  assert.equal(s.lib.examplesSource(), 'registry');
  const info = (await s.ipc('lib:examplesInfo')).result;
  assert.deepEqual(info, { source: 'registry', available: true, count: 0, show: true, packaged: true });
  // a folder with packages wins, and so does a folder named on purpose (even an empty one)
  const withFolder = await setup(t);
  makePackage(t, withFolder.lib.examplesDir, '01-x.vmapp');
  assert.equal(withFolder.lib.examplesSource(), 'folder');
  const named = await setup(t, { libOver: { examplesExplicit: true } });
  assert.equal(named.lib.examplesSource(), 'folder');
});

test('the list: only the apps of the publisher with the verified domain; what an app claims makes it nothing', async (t) => {
  const s = await setup(t);
  const list = (await s.ipc('lib:examplesList')).result;
  assert.equal(list.source, 'registry');
  assert.equal(list.count, 2);
  assert.deepEqual(list.items.map((i) => [i.file, i.name, i.version]), [['com.e.a', 'Alpha', '1.0.0'], ['com.e.b', 'Beta', '1.1.0']], 'Gamma is unverified, Delta has another domain, Epsilon only an e-mail');
  const a = list.items[0];
  assert.equal(a.publisher, 'D9010 Inc');
  assert.equal(a.allowFrom, 'registry');
  assert.equal(a.allow, 'Alpha asks for little');
  assert.equal(a.description, 'Alpha sample');
  assert.ok(a.size > 0 && a.sizeText);
  assert.deepEqual(a.status, { kind: 'new', installed: null });
  assert.equal(a.runtimeMissing, false);
  // another domain can be named (a dev launcher, for tests)
  const other = await setup(t, { libOver: { examplesDomain: 'example.org' } });
  assert.deepEqual((await other.ipc('lib:examplesList')).result.items.map((i) => i.file), ['com.e.d']);
});

test('the list needs the internet: an unreachable registry gives one plain sentence, and the file install is named as the way around it', async (t) => {
  const s = await setup(t);
  await s.reg.stop();
  const r = await s.ipc('lib:examplesList');
  assert.match(r.error || '', /could not be reached/);
  assert.match(r.error || '', /Install from file/);
});

test('install: downloaded, checked, installed through the normal path, remembering the registry; nothing granted, no download left behind', async (t) => {
  const s = await setup(t);
  const r = (await s.ipc('lib:examplesInstall', ['com.e.a', 'com.e.b'])).result;
  assert.deepEqual(r.results.map((x) => [x.file, x.status, x.version]), [['com.e.a', 'installed', '1.0.0'], ['com.e.b', 'installed', '1.1.0']], 'the newest version of each');
  assert.equal(r.text, 'Installed 2 apps.');
  assert.deepEqual(s.store.list().map((a) => a.id).sort(), ['com.e.a', 'com.e.b']);
  const source = s.store.getSource('com.e.a');
  assert.equal(source.registry, s.reg.url, 'it updates from the registry like an app installed with Browse registry…');
  assert.equal(source.installedFrom, '1.0.0');
  assert.ok(s.store.getPackageFile('com.e.a'));
  assert.equal(s.store.currentVersion('com.e.c'), null, 'what was not chosen is not installed');
  assert.deepEqual(fs.readdirSync(s.updates.tmpDir), [], 'the downloads were deleted');
  const phases = s.sent.filter(([ch]) => ch === 'lib:examplesProgress').map(([, ev]) => `${ev.file}:${ev.phase}`);
  assert.deepEqual(phases.slice(0, 4), ['com.e.a:downloading', 'com.e.a:verifying', 'com.e.a:installing', 'com.e.a:installed']);
  for (const id of ['com.e.a', 'com.e.b']) {
    assert.equal(s.store.loadHostGrants ? Object.keys(s.store.loadHostGrants(id) || {}).length : 0, 0, 'no host grant');
    assert.equal(fs.existsSync(path.join(s.store.home, 'apps', id, 'grants.json')), false, 'no grants file: the permission sheet comes at the first launch');
  }
});

test('install: an app that is installed already is skipped before anything is downloaded; an older one is updated', async (t) => {
  const s = await setup(t);
  s.store.install(path.join(s.pk, 'a-1.0.0.vmapp'));
  s.store.install(path.join(s.pk, 'b-1.0.0.vmapp'));
  const list = (await s.ipc('lib:examplesList')).result;
  assert.deepEqual(list.items.map((i) => i.status.kind), ['same', 'update']);
  s.reg.log.length = 0;
  const r = (await s.ipc('lib:examplesInstall', ['com.e.a', 'com.e.b'])).result;
  assert.deepEqual(r.results.map((x) => [x.file, x.status]), [['com.e.a', 'skipped'], ['com.e.b', 'updated']]);
  assert.match(r.results[0].note, /already installed/);
  assert.equal(r.results[1].previous, '1.0.0');
  assert.deepEqual(downloads(s.reg), ['com.e.b'], 'only the one that changes is downloaded');
});

test('install: only what the registry lists as an example right now; any other app of the registry is refused', async (t) => {
  const s = await setup(t);
  for (const bad of [['com.e.c'], ['com.e.d'], ['com.e.e'], ['com.e.a', 'com.e.nope'], ['../etc/passwd'], [7]]) {
    const r = await s.ipc('lib:examplesInstall', bad);
    assert.match(r.error || '', /is not one of the examples/, JSON.stringify(bad));
  }
  assert.deepEqual(s.store.list(), [], 'nothing was installed by a refused request');
  assert.deepEqual(downloads(s.reg), [], 'and nothing was downloaded');
});

test('install: a download that fails the checks fails only that example, with the reason, and the others go on', async (t) => {
  const s = await setup(t);
  s.reg.tamper.add('1.0.0'); // Alpha's bytes are changed on the way; its honest headers stay
  const r = (await s.ipc('lib:examplesInstall', ['com.e.a', 'com.e.b'])).result;
  assert.deepEqual(r.results.map((x) => [x.file, x.status]), [['com.e.a', 'failed'], ['com.e.b', 'installed']]);
  assert.equal(r.results[0].step, 'download');
  assert.ok(r.results[0].error.length > 10);
  assert.equal(s.store.currentVersion('com.e.a'), null);
  assert.deepEqual(fs.readdirSync(s.updates.tmpDir), [], 'a failed download leaves nothing behind');
  assert.equal(r.text, 'Installed 1 app, 1 failed.');
});

test('install: a running app is not replaced; an app whose every version was withdrawn is not installed', async (t) => {
  const s = await setup(t);
  s.running.add('com.e.a');
  s.reg.withdraw('com.e.b', '1.0.0', 'bad');
  s.reg.withdraw('com.e.b', '1.1.0', 'bad');
  const r = (await s.ipc('lib:examplesInstall', ['com.e.a', 'com.e.b'])).result;
  assert.deepEqual(r.results.map((x) => [x.file, x.status]), [['com.e.a', 'failed'], ['com.e.b', 'failed']]);
  assert.equal(r.results[0].error, 'Stop the app first.');
  assert.match(r.results[1].error, /withdrawn/);
  assert.deepEqual(fs.readdirSync(s.updates.tmpDir), []);
});

test('the pure part: isOfficial wants the verified domain, nothing else', () => {
  const item = (publisher) => ({ id: 'com.e.x', publisher });
  assert.equal(X.isOfficial(item(OFFICIAL)), true);
  assert.equal(X.isOfficial(item(Object.assign({}, OFFICIAL, { domain: 'D9010.com' }))), true, 'case does not matter');
  for (const p of [null, undefined, {}, { level: 'unverified', label: '' }, { level: 'email', label: 'x', domain: 'd9010.com' }, { level: 'domain', label: 'x', domain: 'evil-d9010.com' }, { level: 'domain', label: 'Verified: d9010.com' }, { level: 'domain', domain: 7 }]) {
    assert.equal(X.isOfficial(item(p)), false, JSON.stringify(p));
  }
  assert.equal(X.isOfficial(null), false);
  assert.equal(X.isOfficial(item(OFFICIAL), 'example.org'), false);
});
