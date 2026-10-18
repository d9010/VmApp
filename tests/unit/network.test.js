'use strict';
// The network permission (SPEC 8.3) in hostlib: manifest validation, matching, grants, the rules for vmapp-vm, the update
// diff, the exfiltration warning, and AppSession with a fake vmapp-vm. The real enforcement is tested in host/src/net.rs
// (cargo test), tests/e2e.sh scenarios 10 and 11 and tests/net/run.sh; the name vectors are shared with the Rust tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('../../hostlib/network');
const { validateManifest, canonicalize } = require('../../hostlib/manifest');
const { Store, validateGrants } = require('../../hostlib/store');
const { permissionDiff } = require('../../hostlib/updates');
const { AppSession, buildVmArgs } = require('../../hostlib/session');
const { pack } = require('../../hostlib/package');
const { FakeWindowManager, FakeDialogs } = require('../../hostlib/headless');
const { tmpdir, rmrf, makeProject, wait } = require('./helpers');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'net', 'vectors.json'), 'utf8'));
const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const APP = path.join(__dirname, 'fixtures', 'app-main.js');
const ID = 'com.example.notes';

const base = (network, extra = {}) => ({
  format: 1,
  id: 'com.example.net',
  name: 'Net',
  version: '1.0.0',
  runtime: 'node22',
  core: { command: ['node', 'main.js'] },
  permissions: Object.assign({ network }, extra),
});
const manifestOf = (network, extra) => validateManifest(base(network, extra), { files: 'forbidden' });
const entry = (host, ports = [443], purpose = '') => ({ host, ports, purpose });

// ------------------------------------------------------------------------------------------------ names and matching

test('the shared vectors: valid and invalid host patterns (same file as host/src/net.rs)', () => {
  for (const p of VECTORS.validPatterns) assert.equal(net.parseHostPattern(p).problem, undefined, `should be valid: ${JSON.stringify(p)}`);
  for (const p of VECTORS.invalidPatterns) assert.ok(net.parseHostPattern(p).problem, `should be invalid: ${JSON.stringify(p)}`);
  // lengths
  assert.ok(net.parseHostPattern(`${'a'.repeat(63)}.com`).problem === undefined, 'label of 63');
  assert.ok(net.parseHostPattern(`${'a'.repeat(64)}.com`).problem, 'label of 64');
  assert.ok(net.parseHostPattern(`${'a.'.repeat(100)}com`).problem === undefined, 'name of 203');
  assert.ok(net.parseHostPattern(`${'a.'.repeat(130)}com`).problem, 'name over 253');
});

test('the shared vectors: matching (exact, wildcard, ports)', () => {
  for (const [spec, host, port, want] of VECTORS.matching) {
    const [pattern, ports] = spec.split(':');
    const e = { host: pattern, ports: ports === '*' ? '*' : ports ? ports.split(',').map(Number) : [443] };
    assert.equal(net.matchRule(e, host, port), want, `${spec} vs ${host}:${port}`);
  }
});

// ------------------------------------------------------------------------------------------------ the manifest

test('manifest: permissions.network is validated and normalised', () => {
  const m = manifestOf([{ host: 'registry.npmjs.org' }, { host: '*.example.com', ports: [443, 8443], purpose: 'API' }]);
  assert.deepEqual(m.permissions.network, [entry('registry.npmjs.org'), entry('*.example.com', [443, 8443], 'API')]);
  // canonical form: present only when the app asks, so every manifest without it keeps its package id
  const none = validateManifest(base(undefined), { files: 'forbidden' });
  assert.ok(!('network' in none.permissions));
  assert.ok(!canonicalize(none).includes('network'));
  const empty = validateManifest(base([]), { files: 'forbidden' });
  assert.ok(!('network' in empty.permissions), 'an empty list is the same as none');
  assert.equal(canonicalize(validateManifest(JSON.parse(canonicalize(m)), { files: 'forbidden' })), canonicalize(m), 'canonical form round-trips');
});

test('manifest: network entries that must be refused', () => {
  const bad = (network, re) => assert.throws(() => manifestOf(network), re);
  bad('registry.npmjs.org', /permissions\.network must be an array/);
  bad(Array.from({ length: 33 }, (_, i) => ({ host: `h${i}.example.com` })), /at most 32 entries/);
  bad([null], /permissions\.network\[0\] must be an object/);
  bad([{ host: 'a.example.com', extra: 1 }], /permissions\.network\[0\]\.extra is not a known key/);
  bad([{}], /\.host must be a string/);
  bad([{ host: '127.0.0.1' }], /IP addresses are not allowed/);
  bad([{ host: '[::1]' }], /IP addresses are not allowed/);
  bad([{ host: '**' }], /two labels|lower-case/);
  bad([{ host: '*', ports: '**' }], /non-empty array of ports, or "\*"/);
  bad([{ host: '*', ports: ['*'] }], /1 to 65535/);
  bad([{ host: '*.com' }], /wildcard needs a suffix with at least two labels/);
  bad([{ host: 'localhost' }], /at least two labels/);
  bad([{ host: 'printer.local' }], /must not name this machine or a local network/);
  bad([{ host: 'Example.com' }], /lower-case/);
  bad([{ host: 'a.example.com' }, { host: 'a.example.com' }], /not unique/);
  bad([{ host: 'a.example.com', ports: [] }], /non-empty array/);
  bad([{ host: 'a.example.com', ports: [0] }], /1 to 65535/);
  bad([{ host: 'a.example.com', ports: [65536] }], /1 to 65535/);
  bad([{ host: 'a.example.com', ports: [443, 443] }], /not unique/);
  bad([{ host: 'a.example.com', ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] }], /at most 8 ports/);
  bad([{ host: 'a.example.com', ports: ['443'] }], /1 to 65535/);
  bad([{ host: 'a.example.com', purpose: 5 }], /purpose must be a string/);
  bad([{ host: 'a.example.com', purpose: 'x'.repeat(201) }], /at most 200 characters/);
  bad([{ host: 'a.example.com', purpose: 'a\nb' }], /control characters/);
  assert.throws(() => validateManifest(base([], { sockets: [] }), { files: 'forbidden' }), /permissions\.sockets is not a known key/);
});

// ------------------------------------------------------------------------------------------------ grants -> rules

test('resolveNetwork: nothing without a grant; only allowed manifest entries; ports never wider', () => {
  const m = manifestOf([
    { host: 'registry.npmjs.org' },
    { host: '*.example.com', ports: [443, 8443] },
    { host: 'plain.example.org', ports: [80, 443] },
  ]);
  assert.deepEqual(net.resolveNetwork(m, {}).args, [], 'default is deny');
  assert.deepEqual(net.resolveNetwork(m, { folders: {}, askEveryTime: false }).args, []);
  assert.deepEqual(net.resolveNetwork(m, null).args, []);
  const g = {
    network: {
      'registry.npmjs.org': { allow: true },
      '*.example.com': { allow: true, ports: [443] },
      'plain.example.org': { allow: false },
      'unlisted.example.net': { allow: true },
    },
  };
  const r = net.resolveNetwork(m, g);
  assert.deepEqual(r.args, ['registry.npmjs.org:443', '*.example.com:443']);
  assert.ok(r.notes.some((n) => /unlisted\.example\.net.*does not request/.test(n)), r.notes.join('|'));
  // a grant with more ports than requested is ignored, not trimmed
  const wide = net.resolveNetwork(m, { network: { 'registry.npmjs.org': { allow: true, ports: [443, 80] } } });
  assert.deepEqual(wide.args, []);
  assert.ok(wide.notes.some((n) => /wider than requested/.test(n)));
  // the map itself is accepted too
  assert.deepEqual(net.resolveNetwork(m, g.network).args, r.args);
});

test('checkNetGrant: only listed hosts, only requested ports', () => {
  const m = manifestOf([{ host: 'a.example.com', ports: [443, 8443] }]);
  assert.deepEqual(net.checkNetGrant(m, 'a.example.com'), { allow: true });
  assert.deepEqual(net.checkNetGrant(m, 'a.example.com', { ports: [8443] }), { allow: true, ports: [8443] });
  assert.deepEqual(net.checkNetGrant(m, 'a.example.com', { ports: [8443, 443] }), { allow: true }, 'all requested ports is the default');
  assert.deepEqual(net.checkNetGrant(m, 'a.example.com', { allow: false }), { allow: false });
  assert.throws(() => net.checkNetGrant(m, 'b.example.com'), /does not request network access to "b\.example\.com"/);
  assert.throws(() => net.checkNetGrant(m, 'a.example.com', { ports: [80] }), /wider than the requested/);
  assert.throws(() => net.checkNetGrant(m, 'a.example.com', { ports: [] }), /non-empty/);
});

test('netRequestSummary: what the sheet shows', () => {
  const m = manifestOf([
    { host: 'registry.npmjs.org', purpose: 'versions' },
    { host: '*.example.com', ports: [443, 8443] },
    { host: 'plain.example.org', ports: [80] },
  ]);
  const s = net.netRequestSummary(m, { network: { 'registry.npmjs.org': { allow: true }, '*.example.com': { allow: false } } });
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { host: 'registry.npmjs.org', ports: [443], purpose: 'versions', wildcard: false, any: false, anyPort: false, insecure: false, odd: false, grant: { allow: true }, allowed: true, allowedPorts: [443] });
  assert.deepEqual([s[1].wildcard, s[1].odd, s[1].allowed, s[1].grant], [true, true, false, { allow: false }]);
  assert.deepEqual([s[2].insecure, s[2].allowed, s[2].grant], [true, false, null]);
});

test('any public host, any port ("*"): manifest, grants, rules, the update diff and the risk sentence (DEV-APPS C2)', () => {
  const m = manifestOf([{ host: '*', ports: '*', purpose: 'anything you reach from a terminal' }], { folders: [{ name: 'workspace', access: 'readwrite', purpose: 'p' }] });
  assert.deepEqual(m.permissions.network, [entry('*', '*', 'anything you reach from a terminal')]);
  assert.equal(canonicalize(validateManifest(JSON.parse(canonicalize(m)), { files: 'forbidden' })), canonicalize(m), 'canonical form round-trips');
  assert.match(canonicalize(m), /"host": "\*",\s+"ports": "\*"/);
  // nothing until the user allows it
  assert.deepEqual(net.resolveNetwork(m, {}).args, []);
  assert.deepEqual(net.resolveNetwork(m, { network: { '*': { allow: true } } }).args, ['*:*']);
  // the user may narrow the ports of a "*" request, and never widen a list
  assert.deepEqual(net.checkNetGrant(m, '*', { ports: [22, 443] }), { allow: true, ports: [22, 443] });
  assert.deepEqual(net.checkNetGrant(m, '*', { ports: '*' }), { allow: true });
  assert.deepEqual(net.resolveNetwork(m, { network: { '*': { allow: true, ports: [22, 443] } } }).args, ['*:22,443']);
  const listed = manifestOf([{ host: '*', ports: [443] }]);
  assert.throws(() => net.checkNetGrant(listed, '*', { ports: '*' }), /wider than the requested 443/);
  assert.deepEqual(net.resolveNetwork(listed, { network: { '*': { allow: true, ports: '*' } } }).args, [], 'a stored grant wider than the request is ignored');
  assert.deepEqual(net.validateNetworkGrants({ '*': { allow: true, ports: '*' } }), { '*': { allow: true, ports: '*' } });
  // what the sheet shows
  const [s] = net.netRequestSummary(m, { network: { '*': { allow: true } } });
  assert.deepEqual([s.any, s.anyPort, s.wildcard, s.insecure, s.odd, s.allowed, s.allowedPorts], [true, true, false, true, true, true, '*']);
  // matching agrees with NetRule::matches (the shared vectors cover more)
  assert.ok(net.matchRule({ host: '*', ports: '*' }, 'github.com', 22));
  assert.ok(!net.matchRule({ host: '*', ports: [443] }, 'github.com', 22));
  // the update diff: "*" is a new host for any narrower old request; nothing is new under an old "*:*"
  const old = manifestOf([{ host: 'registry.npmjs.org' }]);
  const d = net.netDiff(old, m);
  assert.deepEqual(d.added.map((x) => [x.host, x.kind, x.newPorts, x.any, x.insecure]), [['*', 'host', '*', true, true]]);
  assert.deepEqual(net.netDiff(m, manifestOf([{ host: 'api.example.com', ports: [8443] }])).added, []);
  assert.deepEqual(net.netDiff(manifestOf([{ host: '*', ports: [443] }]), m).added.map((x) => [x.kind, x.newPorts]), [['ports', '*']]);
  assert.deepEqual(net.netDiff(m, old).removed, ['*']);
  // the risk sentence names "any server on the internet"
  const r = net.riskSummary(m, { folders: { workspace: { access: 'readwrite' } }, network: { '*': { allow: true } } });
  assert.equal(r.message, 'This app could read the folder “workspace” and send what it reads to any server on the internet.');
  assert.equal(r.activeMessage, 'This app can read the folder “workspace” and send what it reads to any server on the internet.');
});

test('network grants: validated structure', () => {
  const ok = net.validateNetworkGrants({ 'a.example.com': { allow: true }, '*.b.example.com': { allow: false, ports: [443] } });
  assert.deepEqual(ok, { 'a.example.com': { allow: true }, '*.b.example.com': { allow: false, ports: [443] } });
  assert.throws(() => net.validateNetworkGrants([]), /must be an object/);
  assert.throws(() => net.validateNetworkGrants({ '127.0.0.1': { allow: true } }), /invalid host/);
  assert.throws(() => net.validateNetworkGrants({ 'a.example.com': true }), /must be an object/);
  assert.throws(() => net.validateNetworkGrants({ 'a.example.com': { allow: 'yes' } }), /allow must be a boolean/);
  assert.throws(() => net.validateNetworkGrants({ 'a.example.com': { allow: true, mode: 'ask' } }), /not a known key/);
  assert.throws(() => net.validateNetworkGrants({ 'a.example.com': { allow: true, ports: [0] } }), /1 to 65535/);
  // folded into the whole grants object
  assert.deepEqual(validateGrants({ folders: {}, network: { 'a.example.com': { allow: true } } }).network, { 'a.example.com': { allow: true } });
  assert.ok(!('network' in validateGrants({ folders: {}, network: {} })));
});

// ------------------------------------------------------------------------------------------------ the store

function storeWith(t, network) {
  const d = tmpdir('net-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: { folders: [{ name: 'notes', access: 'read' }], network } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  store.install(file);
  return { d, store, proj };
}

function repack(s, version, network) {
  const m = JSON.parse(fs.readFileSync(path.join(s.proj, 'vmapp.json'), 'utf8'));
  m.version = version;
  m.permissions.network = network;
  fs.writeFileSync(path.join(s.proj, 'vmapp.json'), JSON.stringify(m, null, 2));
  const file = path.join(s.d, `v${version}.vmapp`);
  pack(s.proj, file);
  return file;
}

test('store: network grants are saved, kept when folder grants are saved, and pruned when the manifest drops the host', (t) => {
  const s = storeWith(t, [{ host: 'a.example.com' }, { host: '*.b.example.com', ports: [443, 8443] }]);
  const { store } = s;
  assert.deepEqual(store.loadNetGrants(ID), {});
  store.setNetGrant(ID, 'a.example.com', { allow: true });
  store.setNetGrant(ID, '*.b.example.com', { allow: true, ports: [8443] });
  assert.deepEqual(store.loadNetGrants(ID), { 'a.example.com': { allow: true }, '*.b.example.com': { allow: true, ports: [8443] } });
  // the folder UI saves {folders, askEveryTime} only: the network grants must survive
  const g = store.loadGrants(ID);
  g.folders.notes = null;
  delete g.network;
  store.saveGrants(ID, { folders: g.folders, askEveryTime: false });
  assert.deepEqual(Object.keys(store.loadNetGrants(ID)), ['a.example.com', '*.b.example.com']);
  // ... and saveGrants with network: {} clears them
  store.saveGrants(ID, { folders: {}, askEveryTime: false, network: {} });
  assert.deepEqual(store.loadNetGrants(ID), {});
  // a bad stored shape is refused when read
  fs.writeFileSync(store.grantsPath(ID), JSON.stringify({ folders: {}, network: { '127.0.0.1': { allow: true } } }));
  assert.throws(() => store.loadGrants(ID), /invalid host/);
  fs.rmSync(store.grantsPath(ID));

  // Installing a version that no longer lists a host (or lists fewer ports) drops that grant for good: when a later
  // version lists the host again it must be asked again.
  store.setNetGrant(ID, 'a.example.com', { allow: true });
  store.setNetGrant(ID, '*.b.example.com', { allow: true, ports: [8443] });
  store.install(repack(s, '1.1.0', [{ host: '*.b.example.com', ports: [443] }]));
  assert.deepEqual(store.loadNetGrants(ID), {}, 'a.example.com is gone, and 8443 is no longer requested for *.b.example.com');
  store.setNetGrant(ID, '*.b.example.com', { allow: true });
  store.install(repack(s, '1.2.0', [{ host: 'a.example.com' }, { host: '*.b.example.com', ports: [443] }]));
  assert.deepEqual(store.loadNetGrants(ID), { '*.b.example.com': { allow: true } }, 'a still-listed host keeps its grant; a.example.com was not resurrected');
  // switching versions prunes too
  store.setNetGrant(ID, 'a.example.com', { allow: true });
  store.useVersion(ID, '1.1.0');
  assert.deepEqual(Object.keys(store.loadNetGrants(ID)), ['*.b.example.com']);
  // reset forgets everything
  store.resetApp(ID);
  assert.deepEqual(store.loadNetGrants(ID), {});
});

test('store: an update that asks for more ports never gets them from an old grant (INV-N2: an update grants nothing)', (t) => {
  const s = storeWith(t, [{ host: 'a.example.com', ports: [443] }, { host: 'b.example.com', ports: [443, 8443] }, { host: 'c.example.com', ports: [443] }]);
  const { store } = s;
  // "allow" without explicit ports means every port the manifest requests: that must not widen with the manifest
  store.setNetGrant(ID, 'a.example.com', { allow: true });
  store.setNetGrant(ID, 'b.example.com', { allow: true });
  store.setNetGrant(ID, 'c.example.com', { allow: true });
  store.install(repack(s, '1.1.0', [{ host: 'a.example.com', ports: [443, 8443] }, { host: 'b.example.com', ports: [443] }, { host: 'c.example.com', ports: [8443] }]));
  const g = store.loadNetGrants(ID);
  assert.deepEqual(g['a.example.com'], { allow: true, ports: [443] }, 'pinned to the port the user saw: 8443 stays off until the user allows it');
  assert.deepEqual(g['b.example.com'], { allow: true }, 'fewer ports requested: nothing to pin, the grant simply covers what is left');
  assert.equal(g['c.example.com'], undefined, 'a port the old grant never covered: the grant is dropped');
  assert.deepEqual(net.resolveNetwork(store.get(ID).manifest, store.loadGrants(ID)).args, ['a.example.com:443', 'b.example.com:443'], 'the rules the VM gets');
  // switching to another version pins as well
  store.setNetGrant(ID, 'a.example.com', { allow: true });
  store.useVersion(ID, '1.0.0');
  store.useVersion(ID, '1.1.0');
  assert.deepEqual(store.loadNetGrants(ID)['a.example.com'], { allow: true, ports: [443] });
  // a declined host stays declined; an explicit narrower grant stays as it is
  store.setNetGrant(ID, 'b.example.com', { allow: false });
  store.install(repack(s, '1.2.0', [{ host: 'a.example.com', ports: [443, 8443] }, { host: 'b.example.com', ports: [443, 8443] }]));
  assert.deepEqual(store.loadNetGrants(ID), { 'a.example.com': { allow: true, ports: [443] }, 'b.example.com': { allow: false } });
});

test('store: an update from "*" on 443 to "*" on any port keeps the user on 443; back to a list keeps a narrower grant', (t) => {
  const s = storeWith(t, [{ host: '*', ports: [443] }]);
  const { store } = s;
  store.setNetGrant(ID, '*', { allow: true });
  store.install(repack(s, '1.1.0', [{ host: '*', ports: '*' }]));
  assert.deepEqual(store.loadNetGrants(ID)['*'], { allow: true, ports: [443] }, 'any port stays off until the user allows it');
  assert.deepEqual(net.resolveNetwork(store.get(ID).manifest, store.loadGrants(ID)).args, ['*:443']);
  store.setNetGrant(ID, '*', { allow: true }); // now the user allows any port
  assert.deepEqual(net.resolveNetwork(store.get(ID).manifest, store.loadGrants(ID)).args, ['*:*']);
  store.install(repack(s, '1.2.0', [{ host: '*', ports: [22, 443] }]));
  assert.deepEqual(store.loadNetGrants(ID)['*'], { allow: true }, 'fewer ports requested: the grant covers what is left');
  assert.deepEqual(net.resolveNetwork(store.get(ID).manifest, store.loadGrants(ID)).args, ['*:22,443']);
});

// ------------------------------------------------------------------------------------------------ updates

test('permissionDiff: new hosts, wider wildcards and new ports ask for more; narrower requests do not', () => {
  const m = (network) => manifestOf(network);
  const none = m(undefined);
  // nothing -> a host
  let d = permissionDiff(none, m([{ host: 'a.example.com' }]));
  assert.equal(d.any, true);
  assert.deepEqual(d.netAdded.map((x) => [x.host, x.kind, x.newPorts]), [['a.example.com', 'host', [443]]]);
  // same host, same ports: nothing new
  d = permissionDiff(m([{ host: 'a.example.com' }]), m([{ host: 'a.example.com', purpose: 'new words' }]));
  assert.equal(d.any, false);
  assert.deepEqual(d.netAdded, []);
  // more ports on a host
  d = permissionDiff(m([{ host: 'a.example.com' }]), m([{ host: 'a.example.com', ports: [443, 8443] }]));
  assert.equal(d.any, true);
  assert.deepEqual(d.netAdded.map((x) => [x.host, x.kind, x.newPorts, x.ports]), [['a.example.com', 'ports', [8443], [443, 8443]]]);
  // port 80 is flagged as not encrypted
  d = permissionDiff(m([{ host: 'a.example.com' }]), m([{ host: 'a.example.com', ports: [80, 443] }]));
  assert.equal(d.netAdded[0].insecure, true);
  // exact host -> wildcard that covers more
  d = permissionDiff(m([{ host: 'api.example.com' }]), m([{ host: '*.example.com' }]));
  assert.deepEqual(d.netAdded.map((x) => [x.host, x.wildcard]), [['*.example.com', true]]);
  // wildcard -> an exact host under it (narrower): not news; the bare suffix is NOT covered by the wildcard
  d = permissionDiff(m([{ host: '*.example.com' }]), m([{ host: 'api.example.com' }]));
  assert.equal(d.any, false);
  assert.deepEqual(d.netRemoved, ['*.example.com']);
  d = permissionDiff(m([{ host: '*.example.com' }]), m([{ host: 'example.com' }]));
  assert.equal(d.any, true, 'the bare suffix was not covered by *.example.com');
  // wildcard -> narrower wildcard
  assert.equal(permissionDiff(m([{ host: '*.example.com' }]), m([{ host: '*.api.example.com' }])).any, false);
  assert.equal(permissionDiff(m([{ host: '*.api.example.com' }]), m([{ host: '*.example.com' }])).any, true);
  // removing a host is informational
  d = permissionDiff(m([{ host: 'a.example.com' }, { host: 'b.example.com' }]), m([{ host: 'a.example.com' }]));
  assert.equal(d.any, false);
  assert.deepEqual(d.netRemoved, ['b.example.com']);
  // the folder part still works next to it
  d = permissionDiff(m(undefined), manifestOf([{ host: 'a.example.com' }], { folders: [{ name: 'x', access: 'read' }] }));
  assert.equal(d.added.length, 1);
  assert.equal(d.netAdded.length, 1);
});

// ------------------------------------------------------------------------------------------------ the exfiltration warning

test('riskSummary: readable folders (or the screen) together with hosts', () => {
  const m = manifestOf([{ host: 'api.example.com' }, { host: '*.cdn.example.com' }], {
    folders: [
      { name: 'docs', access: 'read' },
      { name: 'notes', access: 'readwrite' },
      { name: 'out', access: 'writeonly' },
    ],
  });
  const r = net.riskSummary(m);
  assert.deepEqual(r.requested, { folders: ['docs', 'notes'], screen: false, hosts: ['api.example.com', '*.cdn.example.com'] });
  assert.equal(r.atRisk, true);
  assert.equal(r.active, false);
  assert.equal(r.message, 'This app could read the folders “docs” and “notes” and send what it reads to api.example.com and *.cdn.example.com.');
  assert.equal(r.activeMessage, null);
  // active only for what the user granted
  const g = {
    folders: { docs: { path: '/x', access: 'read' }, notes: null, out: { path: '/y', access: 'writeonly' } },
    network: { 'api.example.com': { allow: true }, '*.cdn.example.com': { allow: false } },
  };
  const a = net.riskSummary(m, g);
  assert.deepEqual(a.granted, { folders: ['docs'], screen: false, hosts: ['api.example.com'] });
  assert.equal(a.active, true);
  assert.equal(a.activeMessage, 'This app can read the folder “docs” and send what it reads to api.example.com.');
  // a host without a readable folder is not the pair; neither is a readable folder without a host
  assert.equal(net.riskSummary(m, { folders: { docs: null }, network: g.network }).active, false);
  assert.equal(net.riskSummary(m, { folders: g.folders }).active, false);
  assert.equal(net.riskSummary(manifestOf([{ host: 'a.example.com' }], { folders: [{ name: 'o', access: 'writeonly' }] })).atRisk, false);
  assert.equal(net.riskSummary(manifestOf(undefined, { folders: [{ name: 'o', access: 'read' }] })).atRisk, false);
  // the screen counts as something to read
  const sc = net.riskSummary(manifestOf([{ host: 'a.example.com' }], { host: [{ cap: 'screen', purpose: 'p' }] }), { host: { screen: { mode: 'ask' } }, network: { 'a.example.com': { allow: true } } });
  assert.equal(sc.atRisk, true);
  assert.equal(sc.active, true);
  assert.equal(net.riskSummary(manifestOf([{ host: 'a.example.com' }], { host: [{ cap: 'screen', purpose: 'p' }] }), { network: { 'a.example.com': { allow: true } } }).active, false, 'screen not granted');
  assert.equal(sc.activeMessage, 'This app can read your screen and send what it reads to a.example.com.');
  // many hosts are summarised
  const many = net.riskSummary(manifestOf(['a', 'b', 'c', 'd', 'e'].map((x) => ({ host: `${x}.example.com` })), { folders: [{ name: 'f', access: 'read' }] }));
  assert.match(many.message, /to a\.example\.com, b\.example\.com, c\.example\.com and 2 more\.$/);
});

// ------------------------------------------------------------------------------------------------ the launcher arguments

test('buildVmArgs: --net rules and the test-only switches', () => {
  const o = { kernel: 'k', initramfs: 'i', runtime: 'r', core: 'c', appdata: 'd', start: {}, socket: 's' };
  const a = buildVmArgs(Object.assign({ net: ['registry.npmjs.org:443', '*.example.com:443,8443'] }, o));
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--net'), ['registry.npmjs.org:443', '*.example.com:443,8443']);
  assert.ok(!a.includes('--dev-allow-loopback') && !a.includes('--dev-resolve'));
  const none = buildVmArgs(o);
  assert.ok(!none.includes('--net'), 'no rules, no --net: no network channel');
  const dev = buildVmArgs(Object.assign({ devNet: { allowLoopback: true, resolve: { 'a.example.test': '127.0.0.1' } } }, o));
  assert.ok(dev.includes('--dev-allow-loopback'));
  assert.equal(dev[dev.indexOf('--dev-resolve') + 1], 'a.example.test=127.0.0.1');
});

// ------------------------------------------------------------------------------------------------ AppSession with a fake vmapp-vm

function sessionSetup(t, { network, grants, env = {}, features } = {}) {
  const d = tmpdir('netsess-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  const ui = features ? { ui: { root: 'ui', features } } : {};
  makeProject(proj, { manifest: { ...ui, permissions: { folders: [{ name: 'notes', access: 'readwrite' }], dialogs: true, external: false, network } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(file);
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  fs.writeFileSync(path.join(d, 'Image'), 'k');
  fs.writeFileSync(path.join(d, 'initramfs.cpio'), 'i');
  const vmLog = path.join(d, 'vm.log');
  const saved = {};
  for (const [k, v] of Object.entries({ FAKE_VM_APP: APP, FAKE_VM_LOG: vmLog, APP_MARKS: path.join(d, 'marks.txt'), ...env })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const wm = new FakeWindowManager();
  const logs = [];
  const session = new AppSession({
    appId: ID,
    home,
    vmappVmPath: [process.execPath, FAKE_VM],
    kernel: path.join(d, 'Image'),
    initramfs: path.join(d, 'initramfs.cpio'),
    grants: grants || { folders: {}, askEveryTime: false },
    windowManager: wm,
    dialogs: new FakeDialogs(),
    onLog: (e) => logs.push(e),
    timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  const vmLines = () => (fs.existsSync(vmLog) ? fs.readFileSync(vmLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { d, session, wm, logs, vmLines, store };
}

const netArgs = (argv) => argv.flatMap((a, i) => (a === '--net' ? [argv[i + 1]] : []));

test('session: only allowed entries reach vmapp-vm as --net; nothing granted means no --net', async (t) => {
  const network = [{ host: 'registry.npmjs.org' }, { host: '*.example.com', ports: [443, 8443] }, { host: 'declined.example.org' }];
  const s = sessionSetup(t, {
    network,
    grants: { folders: {}, askEveryTime: false, network: { 'registry.npmjs.org': { allow: true }, '*.example.com': { allow: true, ports: [8443] }, 'declined.example.org': { allow: false } } },
  });
  await s.session.start();
  assert.deepEqual(netArgs(s.vmLines()[0].argv), ['registry.npmjs.org:443', '*.example.com:8443']);
  assert.ok(!s.vmLines()[0].argv.includes('--dev-allow-loopback'), 'the loader-style session never passes the test switches');
  assert.ok(s.logs.some((l) => /network allowed: registry\.npmjs\.org:443, \*\.example\.com:8443/.test(l.message)));
  await s.session.stop({ skipBeforeQuit: true });

  const n = sessionSetup(t, { network });
  await n.session.start();
  assert.deepEqual(netArgs(n.vmLines()[0].argv), []);
  assert.ok(n.logs.some((l) => /network requested but not granted/.test(l.message)));
});

test('session: net lines of vmapp-vm become traffic events (host, port, bytes, reason)', async (t) => {
  const events = [
    { id: 1, host: 'registry.npmjs.org', port: 443, allowed: true, bytesUp: 512, bytesDown: 20480, durationMs: 140 },
    { id: 2, host: 'evil.example.net', port: 443, allowed: false, bytesUp: 0, bytesDown: 0, durationMs: 0, reason: 'not allowed: evil.example.net:443 is not in this app\'s network permissions' },
  ];
  const s = sessionSetup(t, { network: [{ host: 'registry.npmjs.org' }], env: { FAKE_VM_NET_EVENTS: JSON.stringify(events) } });
  const seen = [];
  s.session.on('traffic', (ev) => ev.kind === 'net' && seen.push(ev));
  await s.session.start();
  for (let i = 0; i < 100 && seen.length < 2; i++) await wait(20);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    { ...seen[0], ts: 0, preview: '' },
    { ts: 0, dir: 'from-core', t: 'net', kind: 'net', appId: ID, id: 1, host: 'registry.npmjs.org', port: 443, allowed: true, bytesUp: 512, bytesDown: 20480, durationMs: 140, bytes: 20992, preview: '' },
  );
  assert.match(seen[0].preview, /^allowed registry\.npmjs\.org:443 up 512 down 20480/);
  assert.equal(seen[1].allowed, false);
  assert.match(seen[1].reason, /^not allowed: evil\.example\.net:443/);
  assert.match(seen[1].preview, /^DENIED evil\.example\.net:443/);
  assert.ok(Number.isInteger(seen[0].ts));
});

test('session: the window endpoint (SPEC 8.3 "The app\'s windows") for an app that declares "network"; the secret is never logged', async (t) => {
  const events = [{ id: 1099511627776, host: 'open-vsx.org', port: 443, allowed: true, bytesUp: 900, bytesDown: 4096, durationMs: 80, window: true }];
  const s = sessionSetup(t, { network: [{ host: 'open-vsx.org' }], features: ['network'], env: { FAKE_VM_NET_EVENTS: JSON.stringify(events) } });
  const seen = [];
  s.session.on('traffic', (ev) => ev.kind === 'net' && seen.push(ev));
  await s.session.start();
  const p = s.session.windowProxy;
  assert.deepEqual({ ...p, password: p.password.length }, { host: '127.0.0.1', port: 54321, username: 'vmapp', password: 64 });
  assert.match(p.password, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(p));
  assert.ok(s.vmLines().some((l) => l.stdin && l.stdin.op === 'window-proxy' && l.stdin.secretOk === true), 'sent on stdin, in the right form');
  assert.ok(!s.session.vmArgs.join(' ').includes(p.password), 'never on the command line');
  for (let i = 0; i < 100 && seen.length < 1; i++) await wait(20);
  assert.equal(seen[0].window, true);
  assert.match(seen[0].preview, /^allowed window open-vsx\.org:443 up 900 down 4096/);
  await s.session.stop({ skipBeforeQuit: true });
  assert.equal(s.session.windowProxy, null, 'gone with the VM');
  assert.ok(!s.logs.some((e) => e.message.includes(p.password)), 'never in a log line');
});

test('session: no window endpoint without the feature; a failed endpoint leaves the app running without window network', async (t) => {
  const plain = sessionSetup(t, { network: [{ host: 'open-vsx.org' }] });
  await plain.session.start();
  assert.equal(plain.session.windowProxy, null);
  assert.ok(!plain.vmLines().some((l) => l.stdin && l.stdin.op === 'window-proxy'));
  await plain.session.stop({ skipBeforeQuit: true });
  const failing = sessionSetup(t, { network: [{ host: 'open-vsx.org' }], features: ['network'], env: { FAKE_VM_FAIL_WINDOW_PROXY: '1' } });
  await failing.session.start();
  assert.equal(failing.session.state, 'running');
  assert.equal(failing.session.windowProxy, null);
  assert.ok(failing.logs.some((e) => e.level === 'error' && /window endpoint did not start/.test(e.message)));
});

test('session: hostile or odd net lines cannot break the event', async (t) => {
  const s = sessionSetup(t, { network: [{ host: 'a.example.com' }], env: { FAKE_VM_NET_EVENTS: JSON.stringify([{ host: 'x'.repeat(400), port: 'nope', bytesUp: -5, allowed: 'yes', reason: 'r'.repeat(1000) }, 5, null]) } });
  const seen = [];
  s.session.on('traffic', (ev) => ev.kind === 'net' && seen.push(ev));
  await s.session.start();
  for (let i = 0; i < 100 && seen.length < 1; i++) await wait(20);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].host.length, 253);
  assert.equal(seen[0].port, 0);
  assert.equal(seen[0].bytesUp, 0);
  assert.equal(seen[0].allowed, false, 'only a boolean true counts');
  assert.equal(seen[0].reason.length, 300);
});

test('session: netAllow, netRevoke and syncNetwork drive the running VM', async (t) => {
  const grants = { folders: {}, askEveryTime: false, network: { 'a.example.com': { allow: true } } };
  const s = sessionSetup(t, { network: [{ host: 'a.example.com' }, { host: '*.b.example.com', ports: [443, 8443] }], grants });
  await s.session.start();
  const stdin = () => s.vmLines().filter((l) => l.stdin && /^net-/.test(l.stdin.op)).map((l) => l.stdin);
  assert.deepEqual(netArgs(s.vmLines()[0].argv), ['a.example.com:443']);

  // nothing to do when the running VM already matches the grants
  assert.deepEqual(await s.session.syncNetwork(), { allowed: [], revoked: [] });
  assert.deepEqual(stdin(), []);

  // the user grants another host (fewer ports than requested) and revokes the first: one sync applies both
  grants.network['*.b.example.com'] = { allow: true, ports: [8443] };
  grants.network['a.example.com'] = { allow: false };
  assert.deepEqual(await s.session.syncNetwork(), { allowed: ['*.b.example.com'], revoked: ['a.example.com'] });
  assert.deepEqual(stdin(), [
    { op: 'net-revoke', rule: 'a.example.com' },
    { op: 'net-allow', rule: '*.b.example.com:8443' },
  ]);
  assert.deepEqual(await s.session.syncNetwork(), { allowed: [], revoked: [] }, 'idempotent');

  // direct calls: the manifest limits what can be allowed
  await assert.rejects(s.session.netAllow('other.example.net'), /does not request network access/);
  await assert.rejects(s.session.netAllow('a.example.com', [80]), /not within the requested/);
  const r = await s.session.netAllow('a.example.com');
  assert.equal(r.rule, 'a.example.com:443');
  const rv = await s.session.netRevoke('a.example.com');
  assert.equal(rv.rule, 'a.example.com');
  assert.equal(rv.closed, 0);
});

test('session: an error line from vmapp-vm rejects the network command', async (t) => {
  const s = sessionSetup(t, { network: [{ host: 'a.example.com' }], env: { FAKE_VM_FAIL_NET: '1' } });
  await s.session.start();
  await assert.rejects(s.session.netAllow('a.example.com'), /refused by test/);
  await assert.rejects(s.session.netRevoke('a.example.com'), /refused by test/);
});

test('session: stored grants are read when none were given (the loader path)', async (t) => {
  const d = tmpdir('netstore-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: { folders: [], dialogs: true, external: false, network: [{ host: 'registry.npmjs.org' }] } } });
  pack(proj, path.join(d, 'a.vmapp'));
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(path.join(d, 'a.vmapp'));
  store.setNetGrant(ID, 'registry.npmjs.org', { allow: true });
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  fs.writeFileSync(path.join(d, 'Image'), 'k');
  fs.writeFileSync(path.join(d, 'initramfs.cpio'), 'i');
  process.env.FAKE_VM_APP = APP;
  process.env.FAKE_VM_LOG = path.join(d, 'vm.log');
  t.after(() => {
    delete process.env.FAKE_VM_APP;
    delete process.env.FAKE_VM_LOG;
  });
  const wm = new FakeWindowManager();
  const session = new AppSession({
    appId: ID, store, vmappVmPath: [process.execPath, FAKE_VM], kernel: path.join(d, 'Image'), initramfs: path.join(d, 'initramfs.cpio'),
    windowManager: wm, dialogs: new FakeDialogs(), timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  await session.start();
  const first = JSON.parse(fs.readFileSync(path.join(d, 'vm.log'), 'utf8').trim().split('\n')[0]);
  assert.deepEqual(netArgs(first.argv), ['registry.npmjs.org:443']);
  // revoked in the store while running: the next sync revokes it in the VM
  store.setNetGrant(ID, 'registry.npmjs.org', null);
  assert.deepEqual(await session.syncNetwork(), { allowed: [], revoked: ['registry.npmjs.org'] });
});
