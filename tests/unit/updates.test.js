'use strict';
// hostlib/updates.js: permission diff, candidate choice, check(), fetchAndVerify() and apply() against an in-process
// fake registry (tests/unit/fixtures/fake-registry.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../../hostlib/package');
const { Store } = require('../../hostlib/store');
const { Updates, UpdateError, permissionDiff, pickCandidate, parseAppRef, isInsecureRemote } = require('../../hostlib/updates');
const { FakeRegistry } = require('./fixtures/fake-registry');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const ID = 'com.example.notes';
const FOLDERS = [
  { name: 'notes', access: 'readwrite', purpose: 'Where notes live' },
  { name: 'export', access: 'writeonly', purpose: 'Exports' },
];

function build(dir, version, manifest = {}) {
  const proj = path.join(dir, `proj-${version}-${Object.keys(manifest).join('')}-${Math.random().toString(36).slice(2, 6)}`);
  makeProject(proj, { manifest: Object.assign({ version }, manifest) });
  const out = path.join(dir, `notes-${version}-${Math.random().toString(36).slice(2, 6)}.vmapp`);
  pkg.pack(proj, out);
  return out;
}
const names = (a) => a.map((x) => x.name);

// ------------------------------------------------------------------------------------------------ pure functions

test('permissionDiff: added folders, raised access, dialogs and external turned on', () => {
  const m = (folders, dialogs = false, external = false) => ({ permissions: { folders, dialogs, external } });
  const f = (name, access) => ({ name, access, purpose: '' });
  const none = m([f('a', 'read')]);
  // nothing new
  let d = permissionDiff(none, m([f('a', 'read')]));
  assert.equal(d.any, false);
  assert.deepEqual([d.added, d.raised, d.removed, d.dialogs, d.external], [[], [], [], false, false]);
  // a new folder request
  d = permissionDiff(none, m([f('a', 'read'), f('b', 'read')]));
  assert.deepEqual(names(d.added), ['b']);
  assert.equal(d.any, true);
  // raised access
  d = permissionDiff(m([f('a', 'read')]), m([f('a', 'readwrite')]));
  assert.deepEqual(d.raised.map((r) => [r.name, r.from, r.to]), [['a', 'read', 'readwrite']]);
  d = permissionDiff(m([f('a', 'writeonly')]), m([f('a', 'readwrite')]));
  assert.deepEqual(d.raised.map((r) => [r.from, r.to]), [['writeonly', 'readwrite']]);
  assert.equal(d.any, true);
  // read -> writeonly gains the ability to write: also asked
  d = permissionDiff(m([f('a', 'read')]), m([f('a', 'writeonly')]));
  assert.equal(d.raised.length, 1);
  // lowered access, removed folders: never asked
  d = permissionDiff(m([f('a', 'readwrite'), f('b', 'read')]), m([f('a', 'read')]));
  assert.equal(d.any, false);
  assert.deepEqual(d.removed, ['b']);
  d = permissionDiff(m([f('a', 'readwrite')]), m([f('a', 'writeonly')]));
  assert.equal(d.any, false);
  // dialogs / external
  d = permissionDiff(none, m([f('a', 'read')], true, false));
  assert.deepEqual([d.dialogs, d.external, d.any], [true, false, true]);
  d = permissionDiff(none, m([f('a', 'read')], false, true));
  assert.deepEqual([d.dialogs, d.external, d.any], [false, true, true]);
  // turning them off, or leaving them on, is not news
  d = permissionDiff(m([], true, true), m([], false, false));
  assert.equal(d.any, false);
  d = permissionDiff(m([], true, true), m([], true, true));
  assert.equal(d.any, false);
  // several at once
  d = permissionDiff(m([f('a', 'read')]), m([f('a', 'readwrite'), f('b', 'writeonly')], true, true));
  assert.deepEqual([d.added.length, d.raised.length, d.dialogs, d.external], [1, 1, true, true]);
});

test('permissionDiff: added host capabilities always ask; narrower or removed ones do not', () => {
  const m = (...host) => ({ permissions: { folders: [], dialogs: false, external: false, host: host.map((h) => (typeof h === 'string' ? { cap: h, purpose: '' } : h)) } });
  const caps = (d) => d.hostAdded.map((h) => h.cap);
  // nothing before (also: a manifest without a host list at all)
  let d = permissionDiff({ permissions: { folders: [] } }, m({ cap: 'screen', purpose: 'Reads the screen' }));
  assert.deepEqual(d.hostAdded, [{ cap: 'screen', purpose: 'Reads the screen', control: false }]);
  assert.equal(d.any, true, 'a new host capability always stops and asks');
  // the same list: nothing to ask, even if the purpose text changed
  d = permissionDiff(m({ cap: 'screen', purpose: 'a' }, 'input'), m({ cap: 'screen', purpose: 'b' }, 'input'));
  assert.deepEqual([d.hostAdded, d.hostRemoved, d.any], [[], [], false]);
  // input, tool:*, mcp:* are control (INV-H6); screen and a named tool are not
  d = permissionDiff(m(), m('screen', 'input', 'tool:*', 'mcp:*', 'tool:echo', 'mcp:vscode'));
  assert.deepEqual(d.hostAdded.map((h) => [h.cap, h.control]), [['screen', false], ['input', true], ['tool:*', true], ['mcp:*', true], ['tool:echo', false], ['mcp:vscode', false]]);
  // a named tool is covered by an old wildcard; the wildcard is news when only a named tool was there
  d = permissionDiff(m('tool:*', 'mcp:*'), m('tool:*', 'tool:echo', 'mcp:*', 'mcp:vscode'));
  assert.deepEqual([caps(d), d.any], [[], false]);
  d = permissionDiff(m('tool:echo', 'mcp:vscode'), m('tool:*', 'mcp:*'));
  assert.deepEqual(caps(d), ['tool:*', 'mcp:*']);
  assert.equal(d.any, true);
  // a different named tool or server is added
  d = permissionDiff(m('tool:echo'), m('tool:echo', 'tool:cat'));
  assert.deepEqual(caps(d), ['tool:cat']);
  // dropping a capability is informational only
  d = permissionDiff(m('screen', 'input', 'tool:*'), m('screen', 'tool:echo'));
  assert.deepEqual([d.hostAdded, d.hostRemoved, d.any], [[], ['input', 'tool:*'], false]);
  // host additions combine with folder changes
  d = permissionDiff({ permissions: { folders: [] } }, { permissions: { folders: [{ name: 'a', access: 'read', purpose: '' }], host: [{ cap: 'input', purpose: 'x' }] } });
  assert.deepEqual([d.added.length, d.hostAdded.length, d.any], [1, 1, true]);
});

test('pickCandidate: compatible stays within the major (0.x: minor), latest crosses, withdrawn and older are skipped', () => {
  const vs = (...a) => a.map((x) => (typeof x === 'string' ? { version: x, withdrawn: null } : { version: x[0], withdrawn: { reason: x[1] } }));
  const list = vs('1.0.0', '1.1.0', ['1.2.0', 'bad'], '2.0.0', '2.1.0-beta.1');
  assert.equal(pickCandidate(list, 'compatible', '1.0.0'), '1.1.0');
  assert.equal(pickCandidate(list, 'latest', '1.0.0'), '2.0.0', 'withdrawn 1.2.0 and the pre-release are skipped');
  assert.equal(pickCandidate(list, 'compatible', '1.1.0'), null, 'nothing newer in 1.x that is not withdrawn');
  assert.equal(pickCandidate(list, 'latest', '2.0.0'), null);
  assert.equal(pickCandidate(list, 'latest', '3.0.0'), null, 'never a downgrade');
  assert.equal(pickCandidate(list, 'manual', '1.0.0'), null);
  const zero = vs('0.1.0', '0.1.5', '0.2.0', '1.0.0');
  assert.equal(pickCandidate(zero, 'compatible', '0.1.0'), '0.1.5', '0.x: same minor only');
  assert.equal(pickCandidate(zero, 'latest', '0.1.0'), '1.0.0');
  assert.equal(pickCandidate(vs('1.0.0-rc.1', '1.0.0-rc.2'), 'latest', '1.0.0-rc.1'), '1.0.0-rc.2', 'on a pre-release, pre-releases count');
});

test('parseAppRef: an id with the default registry, or an app page address; nothing unsafe', () => {
  const def = 'http://127.0.0.1:8790/';
  assert.deepEqual(parseAppRef(' com.example.notes ', def), { registry: 'http://127.0.0.1:8790', id: ID });
  assert.deepEqual(parseAppRef('https://reg.example.org/apps/com.example.notes', def), { registry: 'https://reg.example.org', id: ID });
  assert.deepEqual(parseAppRef('https://reg.example.org:8443/apps/com.example.notes/?x=1#top', def), { registry: 'https://reg.example.org:8443', id: ID });
  assert.deepEqual(parseAppRef('https://reg.example.org/vmapp/app/com.example.notes', def), { registry: 'https://reg.example.org/vmapp', id: ID });
  assert.deepEqual(parseAppRef('http://localhost:8790/apps/com.example.notes%2d2', def), { registry: 'http://localhost:8790', id: 'com.example.notes-2' });
  for (const bad of ['', '   ', 'Not An Id', '../etc/passwd', 'com.example.notes/../x', 'a', 'javascript:alert(1)', 'file:///x/apps/com.example.notes', 'https://reg.example.org/', 'https://reg.example.org/apps/', 'https://reg.example.org/apps/%E0%A4%A', 'https://reg.example.org/apps/Bad_ID', 'https://u:p@reg.example.org/apps/com.example.notes', 42]) {
    assert.throws(() => parseAppRef(bad, def), UpdateError, `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseAppRef('com.example.notes', ''), /registry address/);
  assert.equal(isInsecureRemote('http://reg.example.org'), true);
  assert.equal(isInsecureRemote('http://127.0.0.1:8790'), false);
  assert.equal(isInsecureRemote('https://reg.example.org'), false);
});

// ------------------------------------------------------------------------------------------------ against a fake registry

async function world(t, { policy = 'compatible', install = '1.0.0', versions = ['1.0.0', '1.1.0', '2.0.0'], extra = {} } = {}) {
  const d = tmpdir('upd-');
  const reg = new FakeRegistry();
  const url = await reg.start();
  const files = {};
  for (const v of versions) files[v] = build(d, v, extra[v] || {});
  for (const v of versions) reg.publish(files[v]);
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  if (install) {
    store.install(files[install] || build(d, install), { source: { registry: url } });
    if (policy) store.setPolicy(ID, policy);
  }
  const updates = new Updates(store, { timeoutMs: 1500, downloadIdleMs: 1500 });
  t.after(async () => {
    await reg.stop();
    rmrf(d);
  });
  return { d, reg, url, files, store, updates };
}
const tmpFiles = (store) => (fs.existsSync(path.join(store.home, 'tmp')) ? fs.readdirSync(path.join(store.home, 'tmp')) : []);

test('check: compatible picks the highest non-withdrawn 1.x, latest crosses the major, requests carry no identity', async (t) => {
  const w = await world(t);
  let r = await w.updates.check(ID);
  assert.equal(r.candidate, '1.1.0');
  assert.equal(r.latest, '2.0.0');
  assert.equal(r.choice, 'compatible');
  assert.equal(r.current, '1.0.0');
  assert.equal(r.offline, false);
  assert.equal(r.error, null);
  assert.equal(r.withdrawnCurrent, null);
  r = await w.updates.check(ID, { choice: 'latest' });
  assert.equal(r.candidate, '2.0.0');
  // 'manual' (an explicit "Check for updates") looks like compatible
  w.store.setPolicy(ID, 'manual');
  r = await w.updates.check(ID);
  assert.equal(r.choice, 'manual');
  assert.equal(r.candidate, '1.1.0');
  // a withdrawn version is never picked
  w.reg.withdraw(ID, '1.1.0', 'data loss');
  r = await w.updates.check(ID);
  assert.equal(r.candidate, null);
  // INV-G3: only the app id, the installed version and the choice go out
  assert.ok(w.reg.log.length >= 4);
  for (const q of w.reg.log) {
    assert.equal(q.method, 'GET');
    assert.deepEqual(q.headers.filter((h) => !['accept', 'connection', 'host'].includes(h)), [], `unexpected request headers on ${q.url}`);
    assert.match(q.url, /^\/api\/apps\/com\.example\.notes\/(versions|resolve\?choice=(compatible|latest)&from=1\.0\.0)$/);
  }
});

test('check: no source, up to date, current withdrawn, never a downgrade', async (t) => {
  const w = await world(t, { install: '2.0.0' });
  let r = await w.updates.check(ID);
  assert.equal(r.candidate, null, 'already the newest');
  w.reg.withdraw(ID, '2.0.0', 'crashes on start');
  r = await w.updates.check(ID);
  assert.equal(r.candidate, null, 'does not go back to 1.1.0 by itself');
  assert.equal(r.withdrawnCurrent.reason, 'crashes on start');
  // installed from a file: no network at all
  const w2 = await world(t, { install: null });
  w2.store.install(w2.files['1.0.0']);
  const before = w2.reg.log.length;
  r = await w2.updates.check(ID);
  assert.equal(r.noSource, true);
  assert.equal(r.candidate, null);
  assert.equal(w2.reg.log.length, before, 'no request for an app without source.json');
  await assert.rejects(w2.updates.check('com.example.other'), /not installed/);
});

test('check: the registry answer is verified (wrong resolve answers are ignored; a registry without /resolve works)', async (t) => {
  const w = await world(t);
  w.reg.badResolve = '2.0.0'; // a compatible check must not cross the major
  assert.equal((await w.updates.check(ID)).candidate, '1.1.0');
  w.reg.badResolve = '0.5.0'; // nor go back
  assert.equal((await w.updates.check(ID)).candidate, '1.1.0');
  w.reg.badResolve = '9.9.9'; // nor invent one
  assert.equal((await w.updates.check(ID)).candidate, '1.1.0');
  w.reg.badResolve = null;
  w.reg.noResolve = true; // an older registry: 404 on /resolve
  assert.equal((await w.updates.check(ID)).candidate, '1.1.0');
});

test('check: offline, timeout and a broken registry come back as data, not exceptions', async (t) => {
  const w = await world(t);
  w.reg.hang = true;
  const t0 = Date.now();
  let r = await new Updates(w.store, { timeoutMs: 300 }).check(ID);
  assert.equal(r.offline, true);
  assert.equal(r.candidate, null);
  assert.ok(Date.now() - t0 < 2000, 'gives up after the timeout');
  assert.match(r.error, /did not answer in time/);
  w.reg.hang = false;
  await w.reg.stop();
  r = await w.updates.check(ID);
  assert.equal(r.offline, true);
  assert.match(r.error, /Cannot reach the registry/);
  // a registry that answers nonsense is an error, not "offline"
  const w3 = await world(t);
  w3.reg.apps.delete(ID);
  r = await w3.updates.check(ID);
  assert.equal(r.candidate, null);
  assert.equal(r.offline, false);
  assert.match(r.error, /no app/);
});

test('fetchAndVerify: a good download is verified and left in $VMAPP_HOME/tmp; apply installs it with source.json', async (t) => {
  const w = await world(t);
  const p = await w.updates.fetchAndVerify(ID, '1.1.0');
  assert.equal(p.version, '1.1.0');
  assert.equal(p.id, ID);
  assert.equal(p.packageId, pkg.verify(p.file).packageId);
  assert.ok(p.file.startsWith(path.join(w.store.home, 'tmp') + path.sep));
  assert.equal(fs.readFileSync(p.file).length, p.size);
  assert.deepEqual(tmpFiles(w.store).length, 1);
  const r = await w.updates.apply(ID, '1.1.0', { prepared: p });
  assert.deepEqual({ version: r.version, previous: r.previous, installed: r.installed }, { version: '1.1.0', previous: '1.0.0', installed: true });
  assert.equal(w.store.currentVersion(ID), '1.1.0');
  assert.deepEqual(tmpFiles(w.store), [], 'the download is deleted after the install');
  assert.equal(w.store.getSource(ID).registry, w.url);
  assert.equal(w.store.getPolicy(ID), 'compatible', 'the policy is kept');
  // 'latest' is accepted for a first install
  const w2 = await world(t, { install: null });
  const q = await w2.updates.fetchAndVerify(ID, 'latest', { registry: w2.url });
  assert.equal(q.version, '2.0.0');
  w2.updates.discard(q.file);
  assert.deepEqual(tmpFiles(w2.store), []);
});

test('fetchAndVerify refuses a tampered download, a lying package id, missing headers and the wrong package', async (t) => {
  const w = await world(t);
  w.reg.tamper.add('1.1.0');
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.1.0'), /SHA-256 .* does not match/);
  assert.deepEqual(tmpFiles(w.store), [], 'nothing is left behind');

  w.reg.lieAbout.add('2.0.0');
  await assert.rejects(w.updates.fetchAndVerify(ID, '2.0.0'), /package id .* does not match/);
  assert.deepEqual(tmpFiles(w.store), []);

  w.reg.omitHeaders = true;
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.1.0'), /X-Vmapp-Sha256/);
  w.reg.omitHeaders = false;
  w.reg.tamper.clear();
  w.reg.lieAbout.clear();

  // the registry serves 2.0.0 when 1.1.0 was asked for (honest headers, valid package)
  w.reg.apps.get(ID).set('1.1.0', w.reg.apps.get(ID).get('2.0.0'));
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.1.0'), /Asked for version 1\.1\.0 but the package is 2\.0\.0/);
  // ... or another app
  const other = build(w.d, '1.1.0', { id: 'com.example.other' });
  w.reg.publish(other);
  w.reg.apps.get(ID).set('1.1.0', w.reg.apps.get('com.example.other').get('1.1.0'));
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.1.0'), /Asked for com\.example\.notes but the package is com\.example\.other/);

  // a file that is not a package at all, with a matching hash
  const junk = Buffer.from('this is not a tar archive'.repeat(50));
  const crypto = require('crypto');
  w.reg.apps.get(ID).set('1.1.0', { buf: junk, sha256: crypto.createHash('sha256').update(junk).digest('hex'), packageId: 'a'.repeat(64), manifest: {}, withdrawn: null });
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.1.0'), /not a valid package/);

  await assert.rejects(w.updates.fetchAndVerify(ID, '7.7.7'), /no com\.example\.notes 7\.7\.7/);
  await assert.rejects(w.updates.fetchAndVerify('../evil', '1.0.0', { registry: w.url }), /invalid app id/);
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.0.0/../../x', { registry: w.url }), /invalid version/);
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.0.0', { registry: 'file:///tmp' }), /invalid registry/);
  assert.deepEqual(tmpFiles(w.store), []);
  assert.equal(w.store.currentVersion(ID), '1.0.0', 'nothing was installed');
});

test('fetchAndVerify: unreachable registry is an offline error', async (t) => {
  const w = await world(t);
  await w.reg.stop();
  await assert.rejects(w.updates.fetchAndVerify(ID, '1.1.0'), (e) => e instanceof UpdateError && e.offline === true);
  assert.deepEqual(tmpFiles(w.store), []);
});

test('check with download: fills the permission diff; installed candidates need no download', async (t) => {
  const grow = { permissions: { folders: [...FOLDERS, { name: 'photos', access: 'read', purpose: 'Pictures' }], dialogs: true, external: true } };
  const w = await world(t, { versions: ['1.0.0', '1.1.0', '1.2.0'], extra: { '1.2.0': grow } });
  let r = await w.updates.check(ID, { download: true });
  assert.equal(r.candidate, '1.2.0');
  assert.equal(r.permissionDiff.any, true);
  assert.deepEqual([r.permissionDiff.dialogs, r.permissionDiff.external], [false, false], 'dialogs and external were already on');
  assert.deepEqual(names(r.permissionDiff.added), ['photos']);
  assert.equal(r.prepared.manifest.version, '1.2.0');
  assert.equal(r.prepared.installed, false);
  assert.equal(w.store.currentVersion(ID), '1.0.0', 'check never installs');
  w.updates.discard(r.prepared.file);

  // 1.0.0 -> 1.1.0 (same permissions): the diff is empty
  w.reg.withdraw(ID, '1.2.0', 'oops');
  r = await w.updates.check(ID, { download: true });
  assert.equal(r.candidate, '1.1.0');
  assert.equal(r.permissionDiff.any, false);
  await w.updates.apply(ID, '1.1.0', { prepared: r.prepared });

  // the user goes back to 1.0.0; 1.1.0 is still installed, so a later check finds it locally (no download)
  w.store.useVersion(ID, '1.0.0');
  w.reg.log.length = 0;
  r = await w.updates.check(ID, { download: true });
  assert.equal(r.candidate, '1.1.0');
  assert.equal(r.prepared.installed, true);
  assert.ok(!w.reg.log.some((q) => q.url.endsWith('/download')), 'no download for an installed version');
  const a = await w.updates.apply(ID, '1.1.0', { prepared: r.prepared });
  assert.equal(a.installed, false);
  assert.equal(w.store.currentVersion(ID), '1.1.0');
  assert.deepEqual(tmpFiles(w.store), []);
});

test('apply: switching to an installed version works offline; a downgrade from the registry needs force', async (t) => {
  const w = await world(t, { install: '2.0.0' });
  w.store.install(w.files['1.1.0'], { force: true });
  await w.reg.stop();
  const r = await w.updates.apply(ID, '2.0.0'); // installed: no network
  assert.equal(r.version, '2.0.0');
  assert.equal(w.store.currentVersion(ID), '2.0.0');
  const w2 = await world(t, { install: '2.0.0' });
  await assert.rejects(w2.updates.apply(ID, '1.0.0'), /refusing to downgrade/);
  assert.deepEqual(tmpFiles(w2.store), [], 'the refused download is deleted');
  const d = await w2.updates.apply(ID, '1.0.0', { force: true });
  assert.deepEqual({ version: d.version, previous: d.previous }, { version: '1.0.0', previous: '2.0.0' });
  // a prepared download that is not the one asked for is refused
  const p = await w2.updates.fetchAndVerify(ID, '1.1.0');
  await assert.rejects(w2.updates.apply(ID, '1.0.0', { prepared: p }), /not the one asked for/);
  assert.deepEqual(tmpFiles(w2.store), []);
});

test('listRegistryVersions and cleanTmp', async (t) => {
  const w = await world(t);
  w.reg.withdraw(ID, '1.1.0', 'bad build');
  const list = await w.updates.listRegistryVersions(ID);
  assert.deepEqual(list.map((v) => v.version), ['1.0.0', '1.1.0', '2.0.0']);
  assert.equal(list[1].withdrawn.reason, 'bad build');
  assert.equal(list[0].withdrawn, null);
  fs.mkdirSync(path.join(w.store.home, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(w.store.home, 'tmp', 'vmapp-dl-leftover.vmapp'), 'x');
  fs.writeFileSync(path.join(w.store.home, 'tmp', 'someone-elses.txt'), 'x');
  w.updates.cleanTmp();
  assert.deepEqual(tmpFiles(w.store), ['someone-elses.txt'], 'only our own leftovers are removed');
  w.updates.discard(path.join(w.store.home, 'tmp', 'someone-elses.txt'));
  w.updates.discard('/etc/hosts');
  assert.ok(fs.existsSync('/etc/hosts') && tmpFiles(w.store).length === 1, 'discard stays inside our download names');
});
