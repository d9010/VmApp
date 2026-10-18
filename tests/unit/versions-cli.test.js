'use strict';
// CLI: versions, use, policy, update (SPEC 8.1) against the in-process fake registry.
// The CLI runs as a child process (async spawn: the fake registry lives in this process and must keep answering).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pkg = require('../../hostlib/package');
const { Store } = require('../../hostlib/store');
const { FakeRegistry } = require('./fixtures/fake-registry');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const ID = 'com.example.notes';

function vmapp(home, ...args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: Object.assign({}, process.env, { VMAPP_HOME: home }) });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

function build(dir, version, manifest = {}) {
  const proj = path.join(dir, `proj-${version}`);
  makeProject(proj, { manifest: Object.assign({ version }, manifest) });
  const out = path.join(dir, `notes-${version}.vmapp`);
  pkg.pack(proj, out);
  return out;
}

test('CLI versions / use / policy / update', async (t) => {
  const d = tmpdir('vcli-');
  const reg = new FakeRegistry();
  const url = await reg.start();
  t.after(async () => {
    await reg.stop();
    rmrf(d);
  });
  const more = { permissions: { folders: [{ name: 'notes', access: 'readwrite', purpose: 'n' }, { name: 'photos', access: 'read', purpose: 'Pictures' }], dialogs: true, external: true } };
  const files = { '1.0.0': build(d, '1.0.0'), '1.1.0': build(d, '1.1.0'), '1.2.0': build(d, '1.2.0', more), '2.0.0': build(d, '2.0.0') };
  for (const v of ['1.0.0', '1.1.0', '2.0.0']) reg.publish(files[v]); // 1.2.0 is published later
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'fake runtime'); // the CLI's own store checks for it

  // an app installed from a file has no registry
  store.install(files['1.0.0']);
  let r = await vmapp(home, 'versions', ID);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /current 1\.0\.0/);
  assert.match(r.out, /update choice: manual/);
  assert.match(r.out, /installed from a file/);
  r = await vmapp(home, 'policy', ID, 'compatible');
  assert.equal(r.code, 1);
  assert.match(r.err, /installed from a file/);
  r = await vmapp(home, 'update', ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /installed from a file/);
  r = await vmapp(home, 'versions', ID, '--remote');
  assert.equal(r.code, 1);

  // from a registry
  store.install(files['1.0.0'], { source: { registry: url } });
  r = await vmapp(home, 'policy', ID);
  assert.match(r.out, /manual \(Stay on this version\)/);
  r = await vmapp(home, 'policy', ID, 'sometimes');
  assert.equal(r.code, 2);
  r = await vmapp(home, 'policy', ID, 'compatible');
  assert.equal(r.code, 0, r.err);
  assert.equal(store.getPolicy(ID), 'compatible');

  r = await vmapp(home, 'versions', ID, '--remote');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`source: ${url.replace(/\./g, '\\.')}`));
  assert.match(r.out, /2\.0\.0/);
  assert.match(r.out, /1\.0\.0 {2}installed/);
  r = await vmapp(home, 'versions', ID, '--json');
  assert.deepEqual(JSON.parse(r.out).installed, ['1.0.0']);

  // update: 1.0.0 -> 1.1.0 (same permissions): applied without --yes; never crosses the major
  r = await vmapp(home, 'update', ID);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1\.0\.0 -> 1\.1\.0/);
  assert.equal(store.currentVersion(ID), '1.1.0');
  // 1.1.0 -> 1.2.0 asks for more: stops without --yes
  reg.publish(files['1.2.0']);
  r = await vmapp(home, 'update', ID);
  assert.equal(r.code, 3, r.err);
  assert.match(r.out, /new folder "photos"/);
  assert.match(r.out, /Not applied/);
  assert.equal(store.currentVersion(ID), '1.1.0');
  assert.deepEqual(fs.existsSync(path.join(home, 'tmp')) ? fs.readdirSync(path.join(home, 'tmp')) : [], [], 'the refused download is removed');
  r = await vmapp(home, 'update', ID, '--yes');
  assert.equal(r.code, 0, r.err);
  assert.equal(store.currentVersion(ID), '1.2.0');
  r = await vmapp(home, 'update', ID);
  assert.match(r.out, /up to date/);
  assert.match(r.out, /2\.0\.0 exists/);
  r = await vmapp(home, 'update', ID, '--choice', 'latest', '--yes');
  assert.equal(store.currentVersion(ID), '2.0.0');

  // use: go back (warns, sets manual), forward again; unknown versions are refused
  store.setPolicy(ID, 'latest');
  r = await vmapp(home, 'use', ID, '1.1.0');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Going back to an older version/);
  assert.match(r.out, /set to manual/);
  assert.equal(store.currentVersion(ID), '1.1.0');
  assert.equal(store.getPolicy(ID), 'manual');
  r = await vmapp(home, 'use', ID, '1.2.0');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Going back/);
  assert.equal(store.currentVersion(ID), '1.2.0');
  r = await vmapp(home, 'use', ID, '9.9.9');
  assert.equal(r.code, 1);
  assert.match(r.err, /not installed/);
});
