'use strict';
// `vmapp new`: copies a template, replaces its placeholders, refuses to overwrite, and the result packs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir, rmrf } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const TEMPLATE = path.resolve(__dirname, '..', '..', 'templates', 'starter');

function vmapp(cwd, env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('vmapp new: copies the starter, replaces id and name, and the result packs', (t) => {
  const d = tmpdir('new-');
  t.after(() => rmrf(d));
  const env = { VMAPP_HOME: path.join(d, 'home') };

  const r = vmapp(d, env, 'new', 'my-notes');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created .*my-notes/);
  assert.match(r.out, /next steps:/);
  assert.match(r.out, /test\/run\.sh/);

  const app = path.join(d, 'my-notes');
  const m = JSON.parse(read(app, 'vmapp.json'));
  assert.equal(m.id, 'com.example.my-notes');
  assert.equal(m.name, 'My Notes');
  assert.equal(m.runtime, 'node22');
  assert.deepEqual(m.permissions.folders.map((f) => f.name), ['documents']);

  const html = read(app, 'ui', 'index.html');
  assert.match(html, /<title>My Notes<\/title>/);
  assert.match(html, /<h1>My Notes<\/h1>/);
  assert.doesNotMatch(html, /<title>Starter<\/title>|<h1>Starter<\/h1>/);
  assert.match(read(app, 'core', 'main.js'), /const WINDOW_TITLE = 'My Notes';/);

  // the whole template came along, including the working test, and the script is still executable
  for (const f of ['TEMPLATE.md', 'core/main.js', 'ui/index.html', 'ui/app.js', 'ui/style.css', 'test/starter.test.mjs', 'test/run.sh', 'test/fixtures/sample.txt', 'test/fixtures/documents/hello.txt']) {
    assert.ok(fs.existsSync(path.join(app, f)), `missing ${f}`);
  }
  assert.ok(fs.statSync(path.join(app, 'test', 'run.sh')).mode & 0o100, 'test/run.sh lost its exec bit');
  // the template itself is untouched
  assert.equal(JSON.parse(read(TEMPLATE, 'vmapp.json')).id, 'com.example.starter');

  // the copied app is a valid project: it packs, and the package carries the new id
  const pkg = path.join(d, 'my-notes.vmapp');
  const p = vmapp(d, env, 'pack', app, '-o', pkg);
  assert.equal(p.code, 0, p.err);
  assert.match(p.out, /package id: [0-9a-f]{64}/);
  const v = vmapp(d, env, 'verify', pkg);
  assert.equal(v.code, 0, v.err);
  assert.match(v.out, /^OK com\.example\.my-notes 1\.0\.0 [0-9a-f]{64}/);
  const i = vmapp(d, env, 'inspect', pkg);
  assert.match(i.out, /My Notes 1\.0\.0 {2}\(com\.example\.my-notes\)/);
  // tests and fixtures are not shipped in the package
  assert.doesNotMatch(i.out, /test\//);
});

test('vmapp new: --id, --dir and --template', (t) => {
  const d = tmpdir('new-opts-');
  t.after(() => rmrf(d));
  const env = { VMAPP_HOME: path.join(d, 'home') };
  const dest = path.join(d, 'deep', 'er', 'somewhere');

  const r = vmapp(d, env, 'new', 'demo', '--id', 'org.acme.demo-app', '--dir', dest, '--template', 'starter');
  assert.equal(r.code, 0, r.err);
  const m = JSON.parse(read(dest, 'vmapp.json'));
  assert.equal(m.id, 'org.acme.demo-app');
  assert.equal(m.name, 'Demo');
  assert.ok(!fs.existsSync(path.join(d, 'demo')), '--dir must replace the default location');
});

test('vmapp new: refuses to overwrite an existing directory', (t) => {
  const d = tmpdir('new-over-');
  t.after(() => rmrf(d));
  const env = { VMAPP_HOME: path.join(d, 'home') };
  fs.mkdirSync(path.join(d, 'taken'));
  fs.writeFileSync(path.join(d, 'taken', 'keep.txt'), 'mine');

  const r = vmapp(d, env, 'new', 'taken');
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; refusing to overwrite/);
  assert.deepEqual(fs.readdirSync(path.join(d, 'taken')), ['keep.txt']);
  assert.equal(read(d, 'taken', 'keep.txt'), 'mine');

  // an existing plain file at the destination is refused as well
  fs.writeFileSync(path.join(d, 'afile'), 'x');
  assert.equal(vmapp(d, env, 'new', 'afile').code, 1);
  assert.equal(read(d, 'afile'), 'x');

  // creating the same app twice: the second call fails and leaves the first intact
  assert.equal(vmapp(d, env, 'new', 'twice').code, 0);
  const before = read(d, 'twice', 'vmapp.json');
  assert.equal(vmapp(d, env, 'new', 'twice').code, 1);
  assert.equal(read(d, 'twice', 'vmapp.json'), before);
});

test('vmapp new: rejects bad names, ids and templates, and creates nothing', (t) => {
  const d = tmpdir('new-bad-');
  t.after(() => rmrf(d));
  const env = { VMAPP_HOME: path.join(d, 'home') };

  for (const bad of ['A', 'Notes', '1notes', 'a', 'my_notes', 'my notes', 'x'.repeat(42)]) {
    const r = vmapp(d, env, 'new', bad);
    assert.equal(r.code, 1, `name "${bad}" should be refused`);
    assert.match(r.err, /invalid app name/);
  }
  let r = vmapp(d, env, 'new', 'okname', '--id', 'NotValid');
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid app id/);
  r = vmapp(d, env, 'new', 'okname', '--template', 'nope');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown template "nope" \(available: .*starter/);
  r = vmapp(d, env, 'new');
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: vmapp new/);
  assert.ok(!fs.existsSync(path.join(d, 'okname')));
  assert.ok(!fs.existsSync(path.join(d, 'A')));
});
