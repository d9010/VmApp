'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const ID = 'com.example.notes';

function vmapp(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: pack, inspect, verify, runtime-install, install, list, grant, run --headless, uninstall', (t) => {
  const d = tmpdir('cli-');
  t.after(() => rmrf(d));
  const home = path.join(d, 'home');
  const env = {
    VMAPP_HOME: home,
    VMAPP_VM: FAKE_VM,
    VMAPP_KERNEL: path.join(d, 'Image'),
    VMAPP_INITRAMFS: path.join(d, 'initramfs.cpio'),
    FAKE_VM_APP: path.join(__dirname, 'fixtures', 'app-main.js'),
  };
  fs.writeFileSync(env.VMAPP_KERNEL, 'k');
  fs.writeFileSync(env.VMAPP_INITRAMFS, 'i');
  const proj = path.join(d, 'proj');
  makeProject(proj);
  const file = path.join(d, 'notes.vmapp');

  let r = vmapp(env, 'pack', proj, '-o', file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /package id: [0-9a-f]{64}/);

  r = vmapp(env, 'inspect', file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Notes 1\.0\.0 {2}\(com\.example\.notes\)/);
  assert.match(r.out, /ui\/index\.html/);
  r = vmapp(env, 'inspect', file, '--json');
  const j = JSON.parse(r.out);
  assert.equal(j.manifest.id, ID);
  assert.match(j.packageId, /^[0-9a-f]{64}$/);

  r = vmapp(env, 'verify', file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^OK com\.example\.notes 1\.0\.0 [0-9a-f]{64}/);

  // tampered file fails with a precise message and exit code 1
  const raw = fs.readFileSync(file);
  const at = raw.indexOf('<!doctype');
  raw[at + 2] ^= 1;
  fs.writeFileSync(file + '.bad', raw);
  r = vmapp(env, 'verify', file + '.bad');
  assert.equal(r.code, 1);
  assert.match(r.err, /hash mismatch for "ui\/index\.html"/);

  // runtime is not installed yet
  r = vmapp(env, 'install', file);
  assert.equal(r.code, 1);
  assert.match(r.err, /runtime "node22" is not installed/);
  fs.writeFileSync(path.join(d, 'node22.img'), 'img');
  r = vmapp(env, 'runtime-install', 'node22', path.join(d, 'node22.img'));
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(home, 'runtimes', 'node22.img')));
  r = vmapp(env, 'install', file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /installed com\.example\.notes 1\.0\.0/);

  r = vmapp(env, 'list');
  assert.match(r.out, /com\.example\.notes {2}1\.0\.0 {2}Notes {2}\[node22\]/);
  r = vmapp(env, 'list', '--json');
  assert.equal(JSON.parse(r.out)[0].id, ID);

  // grants: wider than requested is refused, a narrower one is accepted
  const notes = path.join(d, 'notes-dir');
  fs.mkdirSync(notes);
  r = vmapp(env, 'grant', ID, 'export', notes, '--access', 'readwrite');
  assert.equal(r.code, 1);
  assert.match(r.err, /wider than the requested/);
  r = vmapp(env, 'grant', ID, 'nosuch', notes);
  assert.equal(r.code, 1);
  r = vmapp(env, 'grant', ID, 'notes', notes, '--access', 'read');
  assert.equal(r.code, 0, r.err);
  const g = JSON.parse(fs.readFileSync(path.join(home, 'grants', ID + '.json'), 'utf8'));
  assert.deepEqual(g.folders.notes, { path: notes, access: 'read' });

  // headless run with a script
  r = vmapp(env, 'run', ID, '--headless', '--script', path.join(__dirname, 'fixtures', 'run-script.mjs'));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /SCRIPT-OK com\.example\.notes/);
  assert.match(r.out, /\[window\] 1 created: index\.html 640x480 "Fixture"/);
  assert.match(r.out, /\[run\] stopped: \{"stopped":true/);
  const vmArgs = fs.existsSync(path.join(home, 'logs')) ? 'logs-dir' : '';
  assert.equal(vmArgs, 'logs-dir');

  // headless run without a script waits for the first window, then stops cleanly
  r = vmapp(env, 'run', ID, '--headless', '--duration', '100');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\[window\] 1 created/);
  assert.match(r.out, /\[run\] windows created: 1/);

  r = vmapp(env, 'run', ID);
  assert.equal(r.code, 2);

  r = vmapp(env, 'uninstall', ID, '--purge');
  assert.equal(r.code, 0, r.err);
  r = vmapp(env, 'list');
  assert.match(r.out, /no apps installed/);
  assert.ok(!fs.existsSync(path.join(home, 'grants', ID + '.json')));
  r = vmapp(env, 'bogus');
  assert.equal(r.code, 2);
});
