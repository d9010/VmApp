'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, canonicalize, parseManifest, compareVersions, ManifestError } = require('../../hostlib/manifest');

const base = () => ({
  format: 1,
  id: 'com.example.notes',
  name: 'Notes',
  version: '1.0.0',
  runtime: 'node22',
  core: { command: ['node', 'main.js'] },
});
const withFiles = (m) => Object.assign(m, { files: { 'core.cpio': 'a'.repeat(64) } });

function bad(mutate, field, opts) {
  const m = base();
  mutate(m);
  assert.throws(
    () => validateManifest(m, opts),
    (e) => e instanceof ManifestError && e.message.includes(field) && e.field === field.replace(/^"|"$/g, ''),
    `expected an error naming ${field}`,
  );
}

test('minimal manifest gets all defaults, in canonical key order', () => {
  const m = validateManifest(base(), { files: 'forbidden' });
  assert.deepEqual(Object.keys(m), ['format', 'id', 'name', 'version', 'publisher', 'description', 'runtime', 'core', 'ui', 'permissions']);
  assert.deepEqual(m.core, { command: ['node', 'main.js'], workdir: '/app', env: {}, memoryMiB: 256, cpus: 1 });
  assert.deepEqual(m.ui, { root: 'ui' });
  assert.deepEqual(m.permissions, { folders: [], dialogs: true, external: false });
  assert.equal(m.publisher, '');
});

test('core.cpus and core.memoryMiB are recommendations: 1-16 vCPUs and 64-32768 MiB are accepted (SPEC 2.2)', () => {
  const ok = (core) => validateManifest(Object.assign(base(), { core: Object.assign({ command: ['node', 'main.js'] }, core) }), { files: 'forbidden' }).core;
  assert.deepEqual([ok({ cpus: 16, memoryMiB: 32768 }).cpus, ok({ cpus: 16, memoryMiB: 32768 }).memoryMiB], [16, 32768]);
  assert.deepEqual([ok({ cpus: 1, memoryMiB: 64 }).cpus, ok({ cpus: 1, memoryMiB: 64 }).memoryMiB], [1, 64]);
  assert.equal(ok({ cpus: 8 }).memoryMiB, 256, 'the default recommendation of memory is unchanged');
  assert.equal(ok({ memoryMiB: 8192 }).cpus, 1, 'and so is the default recommendation of cpus');
});

test('DevTools is not a manifest field (the core decides per window, SPEC 7): ui.devtools is rejected', () => {
  bad((m) => (m.ui = { devtools: true }), 'ui.devtools');
  bad((m) => (m.ui = { root: 'ui', devtools: false }), 'ui.devtools');
  bad((m) => (m.devtools = true), 'devtools');
});

test('error messages name the offending field', () => {
  bad((m) => (m.format = 2), 'format');
  bad((m) => (m.id = 'NoDots'), 'id');
  bad((m) => (m.id = 'a.b'.repeat(40)), 'id');
  bad((m) => delete m.name, 'name');
  bad((m) => (m.name = 'x'.repeat(61)), 'name');
  bad((m) => (m.name = 'bad\nname'), 'name');
  bad((m) => (m.version = '1.0'), 'version');
  bad((m) => (m.version = 'v1.0.0'), 'version');
  bad((m) => (m.publisher = 'x'.repeat(101)), 'publisher');
  bad((m) => (m.description = 'x'.repeat(501)), 'description');
  bad((m) => (m.runtime = 'python'), 'runtime');
  bad((m) => delete m.core, 'core');
  bad((m) => (m.core.command = []), 'core.command');
  bad((m) => (m.core.command = ['node', 3]), 'core.command[1]');
  bad((m) => (m.core.workdir = 'app'), 'core.workdir');
  bad((m) => (m.core.workdir = '/app/../etc'), 'core.workdir');
  bad((m) => (m.core.env = { lower: 'x' }), 'core.env.lower');
  bad((m) => (m.core.env = { VMAPP_SOCKET: 'x' }), 'core.env.VMAPP_SOCKET');
  bad((m) => (m.core.env = { A: 1 }), 'core.env.A');
  bad((m) => (m.core.memoryMiB = 32), 'core.memoryMiB');
  bad((m) => (m.core.memoryMiB = 32769), 'core.memoryMiB');
  bad((m) => (m.core.memoryMiB = 256.5), 'core.memoryMiB');
  bad((m) => (m.core.cpus = 17), 'core.cpus');
  bad((m) => (m.core.cpus = 0), 'core.cpus');
  bad((m) => (m.ui = { root: '../x' }), 'ui.root');
  bad((m) => (m.ui = { root: 'a/b' }), 'ui.root');
  bad((m) => (m.ui = { root: 'core.cpio' }), 'ui.root');
  bad((m) => (m.permissions = { dialogs: 'yes' }), 'permissions.dialogs');
  bad((m) => (m.permissions = { external: 1 }), 'permissions.external');
  bad((m) => (m.permissions = { folders: 'x' }), 'permissions.folders');
  bad((m) => (m.permissions = { folders: [{ name: 'Bad', access: 'read' }] }), 'permissions.folders[0].name');
  bad((m) => (m.permissions = { folders: [{ name: 'a', access: 'rw' }] }), 'permissions.folders[0].access');
  bad((m) => (m.permissions = { folders: [{ name: 'a', access: 'read', purpose: 'x'.repeat(201) }] }), 'permissions.folders[0].purpose');
  bad(
    (m) =>
      (m.permissions = {
        folders: [
          { name: 'a', access: 'read' },
          { name: 'a', access: 'read' },
        ],
      }),
    'permissions.folders[1].name',
  );
  bad((m) => (m.permissions = { folders: Array.from({ length: 9 }, (_, i) => ({ name: 'f' + i, access: 'read' })) }), 'permissions.folders');
});

test('unknown keys are rejected at every level', () => {
  bad((m) => (m.extra = 1), 'extra');
  bad((m) => (m.signature = 'x'), 'signature');
  bad((m) => (m.core.extra = 1), 'core.extra');
  bad((m) => (m.ui = { root: 'ui', extra: 1 }), 'ui.extra');
  bad((m) => (m.permissions = { network: true }), 'permissions.network');
  bad((m) => (m.permissions = { folders: [{ name: 'a', access: 'read', extra: 1 }] }), 'permissions.folders[0].extra');
});

test('files: forbidden / required, hex format, no vmapp.json', () => {
  bad((m) => (m.files = {}), 'files', { files: 'forbidden' });
  assert.throws(() => validateManifest(base()), /files is required/);
  assert.doesNotThrow(() => validateManifest(withFiles(base())));
  const m = withFiles(base());
  m.files['ui/x.js'] = 'ABC';
  assert.throws(() => validateManifest(m), /files\.ui\/x\.js/);
  const m2 = withFiles(base());
  m2.files['vmapp.json'] = 'a'.repeat(64);
  assert.throws(() => validateManifest(m2), /vmapp\.json/);
  const m3 = withFiles(base());
  m3.files['../x'] = 'a'.repeat(64);
  assert.throws(() => validateManifest(m3), /valid relative path/);
});

test('full example validates; canonical JSON is stable', () => {
  const m = withFiles(base());
  m.publisher = 'Example Inc.';
  m.description = 'd';
  m.core.env = { NODE_ENV: 'production' };
  m.permissions = { folders: [{ name: 'notes', access: 'readwrite', purpose: 'p' }], dialogs: false, external: true };
  m.files['ui/index.html'] = 'b'.repeat(64);
  const text = canonicalize(m);
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.startsWith('{\n  "format": 1,\n  "id": "com.example.notes",'));
  assert.deepEqual(Object.keys(JSON.parse(text).files), ['core.cpio', 'ui/index.html']);
  assert.equal(canonicalize(JSON.parse(text)), text);
});

test('parseManifest rejects bad bytes', () => {
  assert.throws(() => parseManifest(Buffer.from([0xff, 0xfe, 0x00])), /UTF-8/);
  assert.throws(() => parseManifest(Buffer.from('{nope')), /valid JSON/);
  assert.throws(() => parseManifest(Buffer.from('﻿{}')), /byte order mark/);
  assert.throws(() => parseManifest(Buffer.from('[]')), /JSON object/);
});

test('semver comparison', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});
