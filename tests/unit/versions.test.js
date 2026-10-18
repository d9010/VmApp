'use strict';
// Store: versions, pruning, source.json, policy.json (SPEC 8.1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../../hostlib/package');
const { Store, StoreError } = require('../../hostlib/store');
const { tmpdir, rmrf, makeProject, wait } = require('./helpers');

const ID = 'com.example.notes';

/** Packs a version of the test app into `dir` and returns the .vmapp path. */
function build(dir, version, manifest = {}) {
  const proj = path.join(dir, `proj-${version}`);
  makeProject(proj, { manifest: Object.assign({ version }, manifest) });
  const out = path.join(dir, `notes-${version}.vmapp`);
  pkg.pack(proj, out);
  return out;
}

function setup() {
  const d = tmpdir('ver-');
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  return { d, store };
}

test('listVersions: installed versions, oldest first; leftovers and stray files are ignored', () => {
  const { d, store } = setup();
  try {
    assert.deepEqual(store.listVersions(ID), []);
    store.install(build(d, '1.10.0'));
    store.install(build(d, '1.2.0'), { force: true });
    const root = store.appRoot(ID);
    fs.mkdirSync(path.join(root, '.install-123-abc'));
    fs.mkdirSync(path.join(root, '9.9.9')); // no vmapp.json: not an install
    assert.deepEqual(store.listVersions(ID), ['1.2.0', '1.10.0']);
  } finally {
    rmrf(d);
  }
});

test('keeps the current version plus the 2 previous ones, prunes after the switch', async () => {
  const { d, store } = setup();
  try {
    const r1 = store.install(build(d, '1.0.0'));
    assert.deepEqual(r1.pruned, []);
    await wait(15);
    store.install(build(d, '1.1.0'));
    await wait(15);
    store.install(build(d, '1.2.0'));
    assert.deepEqual(store.listVersions(ID), ['1.0.0', '1.1.0', '1.2.0'], 'current + 2 previous');
    await wait(15);
    const r4 = store.install(build(d, '1.3.0'));
    assert.deepEqual(r4.pruned, ['1.0.0'], 'the oldest one goes');
    assert.deepEqual(store.listVersions(ID), ['1.1.0', '1.2.0', '1.3.0']);
    assert.equal(store.currentVersion(ID), '1.3.0');
    assert.ok(!fs.existsSync(path.join(store.appRoot(ID), '1.0.0')));
    // app data is shared and untouched by pruning
    fs.writeFileSync(path.join(store.dataDir(ID), 'keep.txt'), 'x');
    await wait(15);
    store.install(build(d, '1.4.0'));
    assert.ok(fs.existsSync(path.join(store.dataDir(ID), 'keep.txt')));
  } finally {
    rmrf(d);
  }
});

test('useVersion switches current; "previous" means most recently used, not lowest number', async () => {
  const { d, store } = setup();
  try {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      store.install(build(d, v));
      await wait(15);
    }
    const r = store.useVersion(ID, '1.0.0');
    assert.deepEqual({ version: r.version, previous: r.previous, pruned: r.pruned }, { version: '1.0.0', previous: '1.2.0', pruned: [] });
    assert.equal(store.currentVersion(ID), '1.0.0');
    assert.equal(store.get(ID).version, '1.0.0');
    await wait(15);
    // a new install while on the old version: 1.0.0 was used last, so 1.0.0 and 1.2.0 stay, 1.1.0 goes
    const r4 = store.install(build(d, '1.3.0'));
    assert.deepEqual(r4.pruned, ['1.1.0']);
    assert.deepEqual(store.listVersions(ID), ['1.0.0', '1.2.0', '1.3.0']);
    // going to the same version again is fine
    assert.equal(store.useVersion(ID, '1.3.0').version, '1.3.0');
  } finally {
    rmrf(d);
  }
});

test('useVersion refuses an unknown version and a modified installation', () => {
  const { d, store } = setup();
  try {
    store.install(build(d, '1.0.0'));
    store.install(build(d, '1.1.0'));
    assert.throws(() => store.useVersion(ID, '2.0.0'), /not installed/);
    assert.throws(() => store.useVersion(ID, 'banana'), /invalid version|not installed/);
    assert.throws(() => store.useVersion('..', '1.0.0'), StoreError);
    const f = path.join(store.appDir(ID, '1.0.0'), 'ui', 'index.html');
    fs.writeFileSync(f, 'tampered');
    assert.throws(() => store.useVersion(ID, '1.0.0'), /modified/);
    assert.equal(store.currentVersion(ID), '1.1.0', 'a refused switch changes nothing');
  } finally {
    rmrf(d);
  }
});

test('policy: default manual, set/get, invalid choice refused, needs an installed app', () => {
  const { d, store } = setup();
  try {
    assert.equal(store.getPolicy(ID), 'manual');
    assert.throws(() => store.setPolicy(ID, 'latest'), /not installed/);
    store.install(build(d, '1.0.0'));
    assert.equal(store.getPolicy(ID), 'manual');
    for (const c of ['compatible', 'latest', 'manual']) {
      store.setPolicy(ID, c);
      assert.equal(store.getPolicy(ID), c);
    }
    assert.throws(() => store.setPolicy(ID, 'sometimes'), /manual, compatible, latest/);
    assert.throws(() => store.setPolicy(ID, undefined), StoreError);
    store.setPolicy(ID, 'latest');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.appRoot(ID), 'policy.json'), 'utf8')), { update: 'latest' });
    fs.writeFileSync(path.join(store.appRoot(ID), 'policy.json'), '{ not json');
    assert.equal(store.getPolicy(ID), 'manual', 'an unreadable file means manual');
    fs.writeFileSync(path.join(store.appRoot(ID), 'policy.json'), '{"update":"always"}');
    assert.equal(store.getPolicy(ID), 'manual', 'an unknown value means manual');
    // the policy survives an update, and goes with the app on uninstall
    store.setPolicy(ID, 'compatible');
    store.install(build(d, '1.1.0'));
    assert.equal(store.getPolicy(ID), 'compatible');
    store.uninstall(ID);
    assert.equal(store.getPolicy(ID), 'manual');
  } finally {
    rmrf(d);
  }
});

test('source.json: written on install from a registry, absent for file installs', () => {
  const { d, store } = setup();
  try {
    store.install(build(d, '1.0.0'));
    assert.equal(store.getSource(ID), null, 'installed from a file');
    store.install(build(d, '1.1.0'), { source: { registry: 'http://127.0.0.1:8790/' } });
    assert.deepEqual(store.getSource(ID), { registry: 'http://127.0.0.1:8790', id: ID, installedFrom: '1.1.0' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.appRoot(ID), 'source.json'), 'utf8')), { registry: 'http://127.0.0.1:8790', id: ID, installedFrom: '1.1.0' });
    // a later update from the same registry keeps the original installedFrom; another registry replaces it
    store.install(build(d, '1.2.0'), { source: { registry: 'http://127.0.0.1:8790' } });
    assert.equal(store.getSource(ID).installedFrom, '1.1.0');
    store.install(build(d, '1.3.0'), { source: { registry: 'https://registry.example.org/vm' } });
    assert.deepEqual(store.getSource(ID), { registry: 'https://registry.example.org/vm', id: ID, installedFrom: '1.3.0' });
    // a file install later does not remove the source (it is where updates are looked for, nothing more)
    store.install(build(d, '1.4.0'));
    assert.equal(store.getSource(ID).registry, 'https://registry.example.org/vm');
    // bad registry addresses are refused, bad files read as "no source"
    for (const bad of ['file:///etc/passwd', 'ftp://x/', 'not a url', 'http://user:pw@host/', '', undefined]) {
      assert.throws(() => store.setSource(ID, { registry: bad, installedFrom: '1.0.0' }), /invalid registry/);
    }
    fs.writeFileSync(path.join(store.appRoot(ID), 'source.json'), '{"registry":"javascript:alert(1)"}');
    assert.equal(store.getSource(ID), null);
    store.uninstall(ID);
    assert.equal(store.getSource(ID), null);
  } finally {
    rmrf(d);
  }
});
