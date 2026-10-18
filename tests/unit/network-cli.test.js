'use strict';
// CLI: `grant-net`, `inspect` (network requests and the exfiltration warning), and `run --headless` printing the net
// events and honouring the grants (SPEC 8.3). vmapp-vm is the fake; the host side (hostlib) is real.
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
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setup(t) {
  const d = tmpdir('ncli-');
  t.after(() => rmrf(d));
  const home = path.join(d, 'home');
  const log = path.join(d, 'vm.log');
  const env = {
    VMAPP_HOME: home,
    VMAPP_VM: FAKE_VM,
    VMAPP_KERNEL: path.join(d, 'Image'),
    VMAPP_INITRAMFS: path.join(d, 'initramfs.cpio'),
    FAKE_VM_APP: path.join(__dirname, 'fixtures', 'app-main.js'),
    FAKE_VM_LOG: log,
  };
  fs.writeFileSync(env.VMAPP_KERNEL, 'k');
  fs.writeFileSync(env.VMAPP_INITRAMFS, 'i');
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  const proj = path.join(d, 'proj');
  makeProject(proj, {
    manifest: {
      permissions: {
        folders: [{ name: 'notes', access: 'read', purpose: 'The notes to sync' }],
        dialogs: true,
        external: false,
        network: [
          { host: 'registry.npmjs.org', purpose: 'Looks up versions' },
          { host: '*.cdn.example.com', ports: [443, 80], purpose: 'Images' },
        ],
      },
    },
  });
  const file = path.join(d, 'a.vmapp');
  assert.equal(vmapp(env, 'pack', proj, '-o', file).code, 0);
  assert.equal(vmapp(env, 'install', file).code, 0);
  return { d, env, home, file, log };
}

const argvOf = (log) => JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).argv;
const netArgs = (argv) => argv.flatMap((a, i) => (a === '--net' ? [argv[i + 1]] : []));

test('CLI inspect: lists the network requests and warns about folder + network', (t) => {
  const s = setup(t);
  const r = vmapp(s.env, 'inspect', s.file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /network registry\.npmjs\.org:443: Looks up versions/);
  assert.match(r.out, /network \*\.cdn\.example\.com:443,80 \[wildcard; port 80: not encrypted\]: Images/);
  assert.match(r.out, /\*\* This app could read the folder “notes” and send what it reads to registry\.npmjs\.org and \*\.cdn\.example\.com\. \*\*/);
});

test('CLI grant-net: allow, narrow the ports, decline, revoke, list; refuses what the manifest does not ask', (t) => {
  const s = setup(t);
  let r = vmapp(s.env, 'grant-net', ID, '--list');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^registry\.npmjs\.org {2}ports 443 {2}not granted {2}- Looks up versions$/m);
  assert.match(r.out, /^\*\.cdn\.example\.com {2}ports 443,80 {2}\[wildcard; port 80: not encrypted\] {2}not granted/m);

  r = vmapp(s.env, 'grant-net', ID, 'registry.npmjs.org');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /allowed registry\.npmjs\.org for com\.example\.notes on ports 443/);
  r = vmapp(s.env, 'grant-net', ID, '*.cdn.example.com', '--ports', '443');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /on ports 443/);
  r = vmapp(s.env, 'grant-net', ID, '--list');
  assert.match(r.out, /registry\.npmjs\.org {2}ports 443 {2}allowed on 443/);
  assert.match(r.out, /\*\.cdn\.example\.com .* allowed on 443/);
  assert.doesNotMatch(r.out, /\*\* This app can read/, 'hosts granted but no folder yet: not the exfiltration pair');
  // now the folder too: the pair is complete and the CLI says so (saving the folder grant keeps the network grants)
  const notes = path.join(s.d, 'notes');
  fs.mkdirSync(notes);
  assert.equal(vmapp(s.env, 'grant', ID, 'notes', notes).code, 0);
  r = vmapp(s.env, 'grant-net', ID, '--list');
  assert.match(r.out, /registry\.npmjs\.org {2}ports 443 {2}allowed on 443/, 'the folder grant did not wipe the network grants');
  assert.match(r.out, /\*\* This app can read the folder “notes” and send what it reads to registry\.npmjs\.org and \*\.cdn\.example\.com\. \*\*/);

  // refused
  r = vmapp(s.env, 'grant-net', ID, 'other.example.net');
  assert.equal(r.code, 1);
  assert.match(r.err, /does not request network access to "other\.example\.net"/);
  r = vmapp(s.env, 'grant-net', ID, '*.cdn.example.com', '--ports', '8443');
  assert.equal(r.code, 1);
  assert.match(r.err, /wider than the requested 443,80/);
  r = vmapp(s.env, 'grant-net', ID, '*.cdn.example.com', '--ports', 'abc');
  assert.equal(r.code, 2);
  r = vmapp(s.env, 'grant-net', 'com.example.missing', 'a.example.com');
  assert.equal(r.code, 1);
  assert.match(r.err, /is not installed/);

  // stored in grants/<id>.json, next to nothing else that was lost
  const g = JSON.parse(fs.readFileSync(path.join(s.home, 'grants', `${ID}.json`), 'utf8'));
  assert.deepEqual(g.network, { 'registry.npmjs.org': { allow: true }, '*.cdn.example.com': { allow: true, ports: [443] } });

  r = vmapp(s.env, 'grant-net', ID, 'registry.npmjs.org', '--deny');
  assert.match(r.out, /declined registry\.npmjs\.org/);
  assert.match(vmapp(s.env, 'grant-net', ID, '--list').out, /registry\.npmjs\.org .* declined/);
  r = vmapp(s.env, 'grant-net', ID, '*.cdn.example.com', '--revoke');
  assert.match(r.out, /revoked \*\.cdn\.example\.com/);
  assert.match(vmapp(s.env, 'grant-net', ID, '--list').out, /\*\.cdn\.example\.com .* not granted/);
  assert.equal(vmapp(s.env, 'grant-net', ID, 'unknown.example.net', '--revoke').code, 1);
});

test('CLI run --headless: only granted hosts reach vmapp-vm; net events are printed', (t) => {
  const s = setup(t);
  // no grants: no --net at all
  let r = vmapp(s.env, 'run', ID, '--headless');
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(netArgs(argvOf(s.log)), []);
  assert.match(r.out, /network requested but not granted/);

  fs.rmSync(s.log);
  assert.equal(vmapp(s.env, 'grant-net', ID, 'registry.npmjs.org').code, 0);
  assert.equal(vmapp(s.env, 'grant-net', ID, '*.cdn.example.com', '--ports', '443').code, 0);
  const events = [
    { id: 1, host: 'registry.npmjs.org', port: 443, allowed: true, bytesUp: 100, bytesDown: 2000, durationMs: 12 },
    { id: 2, host: 'tracker.example.net', port: 443, allowed: false, bytesUp: 0, bytesDown: 0, durationMs: 0, reason: 'not allowed: tracker.example.net:443 is not in this app\'s network permissions' },
  ];
  r = vmapp({ ...s.env, FAKE_VM_NET_EVENTS: JSON.stringify(events) }, 'run', ID, '--headless', '--duration', '1500');
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(netArgs(argvOf(s.log)), ['registry.npmjs.org:443', '*.cdn.example.com:443']);
  assert.match(r.out, /\[net\] allowed registry\.npmjs\.org:443 up 100 down 2000 12ms/);
  assert.match(r.out, /\[net\] DENIED {2}tracker\.example\.net:443 up 0 down 0 0ms \(not allowed: tracker\.example\.net:443/);
  assert.ok(!argvOf(s.log).includes('--dev-allow-loopback'));
});

test('CLI update: a new version that adds a host stops and asks (describeDiff lists it)', (t) => {
  // the diff itself is covered in network.test.js; here only that the help text documents the command
  const s = setup(t);
  const r = vmapp(s.env, 'help');
  assert.match(r.out, /grant-net <appId> <host> \[--ports 443,80\]/);
  assert.match(r.out, /grant-net <appId> --list/);
});
