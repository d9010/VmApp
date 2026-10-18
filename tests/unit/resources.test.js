'use strict';
// The VM size is the USER's choice (SPEC 2.2, 8): the manifest only recommends. Bounds, defaults, persistence (kept across
// saves and updates, cleared by Reset), the host's caps, the session's argv, and the `vmapp resources` command.
// vmapp-vm is the fake; the host side (hostlib) is real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('../../hostlib/resources');
const { Store } = require('../../hostlib/store');
const { AppSession } = require('../../hostlib/session');
const { pack } = require('../../hostlib/package');
const { FakeWindowManager, FakeDialogs } = require('../../hostlib/headless');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const ID = 'com.example.notes';
const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const APP = path.join(__dirname, 'fixtures', 'app-main.js');

const manifestOf = (core = {}) => ({ core: Object.assign({ command: ['x'], memoryMiB: 256, cpus: 1 }, core) });
const BIG = { cpus: 10, memoryMiB: 8192 }; // a Mac with 10 cores and 16 GiB

// ------------------------------------------------------------------------------------------------ limits and defaults

test('hostLimits: logical cores and half of the memory; never below the smallest VM', () => {
  assert.deepEqual(R.hostLimits({ cpus: 10, totalMemoryMiB: 16384 }), { cpus: 10, memoryMiB: 8192 });
  assert.deepEqual(R.hostLimits({ cpus: 8, totalMemoryMiB: 8192 }), { cpus: 8, memoryMiB: 4096 });
  assert.deepEqual(R.hostLimits({ cpus: 0, totalMemoryMiB: 10 }), { cpus: 1, memoryMiB: 64 }, 'a Mac that reports nothing still gets a usable minimum');
  const real = R.hostLimits();
  assert.equal(real.cpus, Math.max(1, os.cpus().length), 'the real host: os.cpus().length');
  assert.equal(real.memoryMiB, Math.max(64, Math.floor(os.totalmem() / 1048576 / 2)), 'the real host: 50% of its RAM');
});

test('defaults: ONE vCPU and the recommended memory, whatever the manifest recommends', () => {
  const r = R.resolveResources(manifestOf({ cpus: 4, memoryMiB: 2048 }), null, BIG);
  assert.deepEqual([r.cpus, r.memoryMiB, r.custom, r.chosen], [1, 2048, false, null]);
  assert.deepEqual(r.recommended, { cpus: 4, memoryMiB: 2048 });
  assert.deepEqual(r.notes, []);
  const d = R.resolveResources(manifestOf(), { folders: {} }, BIG);
  assert.deepEqual([d.cpus, d.memoryMiB], [1, 256]);
  assert.deepEqual(R.recommendedOf({ core: {} }), { cpus: 1, memoryMiB: 256 }, 'a manifest without the fields recommends the SPEC defaults');
});

test('the user’s choice wins; a missing half falls back to its default', () => {
  const m = manifestOf({ cpus: 4, memoryMiB: 2048 });
  let r = R.resolveResources(m, { resources: { cpus: 3, memoryMiB: 512 } }, BIG);
  assert.deepEqual([r.cpus, r.memoryMiB, r.custom], [3, 512, true]);
  r = R.resolveResources(m, { resources: { cpus: 2 } }, BIG);
  assert.deepEqual([r.cpus, r.memoryMiB], [2, 2048], 'only vCPUs chosen: memory is the recommendation');
  r = R.resolveResources(m, { resources: { memoryMiB: 1024 } }, BIG);
  assert.deepEqual([r.cpus, r.memoryMiB], [1, 1024], 'only memory chosen: one vCPU');
  r = R.resolveResources(m, { resources: { cpus: 'x', memoryMiB: -5 } }, BIG);
  assert.deepEqual([r.cpus, r.memoryMiB, r.custom], [1, 2048, false], 'a malformed stored choice counts as no choice');
});

test('caps: vCPUs at most the Mac’s cores, memory at most half of its RAM (applied at start, with a note)', () => {
  const m = manifestOf({ memoryMiB: 4096 });
  const small = { cpus: 4, memoryMiB: 2048 };
  let r = R.resolveResources(m, { resources: { cpus: 12, memoryMiB: 16384 } }, small);
  assert.deepEqual([r.cpus, r.memoryMiB], [4, 2048]);
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[0], /vCPUs: 12 is more than this Mac has \(4 logical cores\); using 4/);
  assert.match(r.notes[1], /memory: 16384 MiB is more than half of this Mac's memory \(2048 MiB\); using 2048 MiB/);
  r = R.resolveResources(m, null, small);
  assert.deepEqual([r.cpus, r.memoryMiB], [1, 2048], 'a recommendation bigger than the cap is lowered too');
  assert.equal(r.notes.length, 1);
});

// ------------------------------------------------------------------------------------------------ bounds of a choice

test('checkResources: vCPUs 1..cores, memory 64 MiB..half the RAM, whole numbers only', () => {
  assert.deepEqual(R.checkResources({ cpus: 1, memoryMiB: 64 }, BIG), { cpus: 1, memoryMiB: 64 });
  assert.deepEqual(R.checkResources({ cpus: 10, memoryMiB: 8192 }, BIG), { cpus: 10, memoryMiB: 8192 }, 'the caps themselves are allowed');
  assert.deepEqual(R.checkResources({ cpus: 2 }, BIG), { cpus: 2 }, 'a partial choice stays partial');
  assert.deepEqual(R.checkResources({}, BIG), {});
  const bad = (spec, re) => assert.throws(() => R.checkResources(spec, BIG), (e) => e instanceof R.ResourceError && re.test(e.message), JSON.stringify(spec));
  bad({ cpus: 0 }, /at least 1/);
  bad({ cpus: 11 }, /this Mac has 10 logical cores; 11 vCPUs is more/);
  bad({ cpus: 1.5 }, /whole number/);
  bad({ cpus: '2' }, /whole number/);
  bad({ memoryMiB: 63 }, /at least 64/);
  bad({ memoryMiB: 8193 }, /more than half of this Mac's memory.*8192 MiB/);
  bad({ memoryMiB: 512.5 }, /whole number/);
  bad({ gpu: 1 }, /not something that can be set/);
  bad(null, /must be an object/);
  bad([], /must be an object/);
  assert.throws(() => R.checkResources({ cpus: 2 }, { cpus: 1, memoryMiB: 512 }), /this Mac has 1 logical core; 2 vCPUs/, 'singular for a one-core Mac');
});

test('a value below the recommendation is allowed (the UI warns); the summary says which', () => {
  const m = manifestOf({ cpus: 4, memoryMiB: 2048 });
  const s = R.resourceSummary(m, { resources: { cpus: 2, memoryMiB: 1024 } }, BIG);
  assert.deepEqual(s.below, { cpus: true, memoryMiB: true });
  assert.deepEqual(s.current, { cpus: 2, memoryMiB: 1024 });
  assert.equal(s.custom, true);
  const d = R.resourceSummary(m, null, BIG);
  assert.deepEqual(d.below, { cpus: true, memoryMiB: false }, 'by default: one vCPU is below a recommendation of 4, the recommended memory is not');
  assert.deepEqual(d.limits, BIG);
  assert.ok(d.memoryChoices.includes(2048) && d.memoryChoices.includes(64) && d.memoryChoices.at(-1) <= BIG.memoryMiB);
  assert.deepEqual([...d.memoryChoices].sort((a, b) => a - b), d.memoryChoices, 'ordered');
});

test('memoryChoices: usual steps up to the cap, plus the recommendation and the current value', () => {
  const c = R.memoryChoices({ cpus: 4, memoryMiB: 3000 }, { cpus: 1, memoryMiB: 1000 }, { cpus: 1, memoryMiB: 777 });
  assert.ok(c.includes(1000) && c.includes(777), 'the recommendation and the current value are offered even if they are not a usual step');
  assert.ok(c.every((m) => m >= 64 && m <= 3000));
  assert.ok(!c.includes(4096));
  assert.equal(new Set(c).size, c.length, 'no duplicates');
});

test('recommendedChoice: the recommendation lowered to what this Mac allows', () => {
  assert.deepEqual(R.recommendedChoice(manifestOf({ cpus: 4, memoryMiB: 2048 }), BIG), { cpus: 4, memoryMiB: 2048 });
  assert.deepEqual(R.recommendedChoice(manifestOf({ cpus: 16, memoryMiB: 32768 }), BIG), { cpus: 10, memoryMiB: 8192 });
  assert.equal(R.describeSize({ cpus: 1, memoryMiB: 256 }), '1 vCPU, 256 MB');
  assert.equal(R.describeSize({ cpus: 4, memoryMiB: 2048 }, 'MiB'), '4 vCPUs, 2048 MiB');
});

test('stored choice: structure is checked', () => {
  assert.deepEqual(R.validateStoredResources({ cpus: 2, memoryMiB: 512 }), { cpus: 2, memoryMiB: 512 });
  assert.equal(R.validateStoredResources({}), null);
  assert.throws(() => R.validateStoredResources([]), /must be an object/);
  assert.throws(() => R.validateStoredResources({ cpus: 0 }), /cpus must be an integer/);
  assert.throws(() => R.validateStoredResources({ memoryMiB: 63 }), /memoryMiB must be an integer/);
  assert.throws(() => R.validateStoredResources({ memoryMiB: '256' }), /memoryMiB must be an integer/);
  assert.throws(() => R.validateStoredResources({ gpus: 1 }), /not a known key/);
});

// ------------------------------------------------------------------------------------------------ the store

function storeWith(t, core) {
  const d = tmpdir('res-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { core: Object.assign({ command: ['node', 'main.js'] }, core) } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  store.install(file);
  return { d, store, proj };
}

function repack(s, version, core) {
  const m = JSON.parse(fs.readFileSync(path.join(s.proj, 'vmapp.json'), 'utf8'));
  m.version = version;
  Object.assign(m.core, core);
  fs.writeFileSync(path.join(s.proj, 'vmapp.json'), JSON.stringify(m, null, 2));
  const file = path.join(s.d, `v${version}.vmapp`);
  pack(s.proj, file);
  return file;
}

test('store: the choice is saved in grants/<id>.json `resources`, loaded back, and forgotten with null', (t) => {
  const { store } = storeWith(t, { cpus: 2, memoryMiB: 512 });
  assert.equal(store.loadResources(ID), null);
  assert.equal(store.loadGrants(ID).resources, undefined, 'no key until the user chooses');
  store.saveResources(ID, { cpus: 2, memoryMiB: 1024 });
  assert.deepEqual(store.loadResources(ID), { cpus: 2, memoryMiB: 1024 });
  assert.deepEqual(JSON.parse(fs.readFileSync(store.grantsPath(ID), 'utf8')), { resources: { cpus: 2, memoryMiB: 1024 } }, 'a file that holds only the size says nothing else');
  store.saveResources(ID, { memoryMiB: 2048 });
  assert.deepEqual(store.loadResources(ID), { memoryMiB: 2048 });
  store.saveResources(ID, null);
  assert.equal(store.loadResources(ID), null);
  assert.equal(fs.existsSync(store.grantsPath(ID)), false, 'forgetting the only thing in the file removes the file');
  assert.throws(() => store.saveResources(ID, { cpus: 0 }), /cpus must be an integer/);
  assert.throws(() => store.saveResources(ID, { cpus: 2, memoryMiB: 1, extra: 1 }), /not a known key/);
});

test('store: choosing the size is not a decision about permissions (the first launch still shows the sheet)', (t) => {
  const { store } = storeWith(t, {});
  assert.equal(store.hasDecided(ID), false);
  store.saveResources(ID, { cpus: 2 });
  assert.equal(store.hasDecided(ID), false, 'the card’s Resources row must not suppress the first-launch permission sheet');
  store.saveGrants(ID, { folders: {}, askEveryTime: false });
  assert.equal(store.hasDecided(ID), true, 'saving the sheet is a decision');
  assert.deepEqual(store.loadResources(ID), { cpus: 2 }, 'and it kept the size');
  store.saveResources(ID, { cpus: 3 });
  assert.equal(store.hasDecided(ID), true, 'a size saved after a decision keeps it');
  assert.deepEqual(store.loadGrants(ID).resources, { cpus: 3 });
  store.resetApp(ID);
  assert.equal(store.hasDecided(ID), false);
});

test('store: saving folder, host, device or network grants keeps the size; saveGrants(resources: null) clears it', (t) => {
  const { store } = storeWith(t, { memoryMiB: 512 });
  store.saveResources(ID, { cpus: 2, memoryMiB: 768 });
  store.saveGrants(ID, { folders: { notes: null }, askEveryTime: true });
  assert.deepEqual(store.loadResources(ID), { cpus: 2, memoryMiB: 768 }, 'the permission sheet saves {folders, askEveryTime} only');
  store.saveHostGrants(ID, { screen: { mode: 'ask' } });
  store.saveDeviceGrants(ID, {});
  store.saveNetGrants(ID, {});
  assert.deepEqual(store.loadResources(ID), { cpus: 2, memoryMiB: 768 });
  store.saveGrants(ID, { folders: {}, askEveryTime: false, resources: { cpus: 1, memoryMiB: 128 } });
  assert.deepEqual(store.loadResources(ID), { cpus: 1, memoryMiB: 128 }, 'an explicit value replaces it');
  store.saveGrants(ID, { folders: {}, askEveryTime: false, resources: null });
  assert.equal(store.loadResources(ID), null, 'null forgets it');
});

test('store: an update keeps the size (the user’s choice outlives the version); a downgrade and a switch too', (t) => {
  const s = storeWith(t, { cpus: 1, memoryMiB: 256 });
  s.store.saveResources(ID, { cpus: 3, memoryMiB: 384 });
  s.store.install(repack(s, '1.1.0', { cpus: 8, memoryMiB: 4096 }));
  assert.deepEqual(s.store.loadResources(ID), { cpus: 3, memoryMiB: 384 }, 'the new recommendation does not replace the choice');
  const r = R.resolveResources(s.store.get(ID).manifest, s.store.loadGrants(ID), BIG);
  assert.deepEqual([r.cpus, r.memoryMiB, r.recommended.memoryMiB], [3, 384, 4096]);
  assert.equal(R.resourceSummary(s.store.get(ID).manifest, s.store.loadGrants(ID), BIG).below.memoryMiB, true, 'and the sheet warns that it is below the new recommendation');
  s.store.useVersion(ID, '1.0.0');
  assert.deepEqual(s.store.loadResources(ID), { cpus: 3, memoryMiB: 384 });
});

test('store: Reset forgets the size with the rest of the grants; uninstall keeps it unless --purge', (t) => {
  const { store, d } = storeWith(t, {});
  store.saveGrants(ID, { folders: {}, askEveryTime: false, resources: { cpus: 2, memoryMiB: 512 } });
  store.resetApp(ID);
  assert.equal(store.loadResources(ID), null);
  assert.deepEqual(R.resolveResources(store.get(ID).manifest, store.loadGrants(ID), BIG).custom, false, 'back to the defaults');
  store.saveResources(ID, { cpus: 2 });
  store.uninstall(ID);
  assert.deepEqual(store.loadResources(ID), { cpus: 2 }, 'uninstall keeps grants (SPEC 8, step 6)');
  assert.ok(fs.existsSync(path.join(d, 'home', 'grants')));
});

test('store: uninstall --purge forgets the size', (t) => {
  const { store } = storeWith(t, {});
  store.saveResources(ID, { cpus: 2 });
  store.uninstall(ID, { purge: true });
  assert.equal(store.loadResources(ID), null);
});

// ------------------------------------------------------------------------------------------------ the session

function sessionSetup(t, { manifest, grants, hostLimits } = {}) {
  const d = tmpdir('ressess-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest });
  const vmapp = path.join(d, 'a.vmapp');
  pack(proj, vmapp);
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(vmapp);
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  fs.writeFileSync(path.join(d, 'Image'), 'k');
  fs.writeFileSync(path.join(d, 'initramfs.cpio'), 'i');
  const vmLog = path.join(d, 'vm.log');
  process.env.FAKE_VM_APP = APP;
  process.env.FAKE_VM_LOG = vmLog;
  t.after(() => {
    delete process.env.FAKE_VM_APP;
    delete process.env.FAKE_VM_LOG;
  });
  const wm = new FakeWindowManager();
  const logs = [];
  const session = new AppSession({
    appId: ID,
    store,
    vmappVmPath: [process.execPath, FAKE_VM],
    kernel: path.join(d, 'Image'),
    initramfs: path.join(d, 'initramfs.cpio'),
    grants,
    hostLimits,
    windowManager: wm,
    dialogs: new FakeDialogs(),
    onLog: (e) => logs.push(e),
    timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  const argv = () => JSON.parse(fs.readFileSync(vmLog, 'utf8').trim().split('\n')[0]).argv;
  const arg = (k) => argv()[argv().indexOf(k) + 1];
  return { store, session, wm, logs, arg };
}

test('session: the VM is started with the user’s choice, not the manifest’s', async (t) => {
  const s = sessionSetup(t, {
    manifest: { core: { command: ['node', 'main.js'], cpus: 4, memoryMiB: 2048 }, permissions: { folders: [], dialogs: true, external: false } },
    grants: { folders: {}, askEveryTime: false, resources: { cpus: 2, memoryMiB: 640 } },
    hostLimits: BIG,
  });
  await s.session.start();
  assert.equal(s.arg('--cpus'), '2');
  assert.equal(s.arg('--memory'), '640');
  assert.deepEqual(s.session.vmSize, { cpus: 2, memoryMiB: 640, recommended: { cpus: 4, memoryMiB: 2048 }, custom: true });
  assert.ok(s.logs.some((l) => /VM size: 2 vCPUs, 640 MiB \(your choice\); the app recommends 4 vCPUs, 2048 MiB/.test(l.message)));
});

test('session: with no choice the VM gets ONE vCPU and the recommended memory, whatever the manifest recommends', async (t) => {
  const s = sessionSetup(t, {
    manifest: { core: { command: ['node', 'main.js'], cpus: 4, memoryMiB: 2048 }, permissions: { folders: [], dialogs: true, external: false } },
    grants: { folders: {}, askEveryTime: false },
    hostLimits: BIG,
  });
  await s.session.start();
  assert.equal(s.arg('--cpus'), '1');
  assert.equal(s.arg('--memory'), '2048');
  assert.equal(s.session.vmSize.custom, false);
});

test('session: the choice stored on disk is used when the session is not given grants; caps apply at start', async (t) => {
  const s = sessionSetup(t, {
    manifest: { core: { command: ['node', 'main.js'], memoryMiB: 512 }, permissions: { folders: [], dialogs: true, external: false } },
    hostLimits: { cpus: 2, memoryMiB: 1024 },
  });
  s.store.saveGrants(ID, { folders: {}, askEveryTime: false, resources: { cpus: 8, memoryMiB: 4096 } });
  await s.session.start();
  assert.equal(s.arg('--cpus'), '2', 'lowered to this Mac’s cores');
  assert.equal(s.arg('--memory'), '1024', 'lowered to half of this Mac’s memory');
  assert.ok(s.logs.some((l) => l.level === 'warn' && /vCPUs: 8 is more than this Mac has/.test(l.message)));
  assert.ok(s.logs.some((l) => l.level === 'warn' && /memory: 4096 MiB is more than half/.test(l.message)));
});

// ------------------------------------------------------------------------------------------------ the CLI

function cliSetup(t, core) {
  const d = tmpdir('rescli-');
  t.after(() => rmrf(d));
  const home = path.join(d, 'home');
  const env = { VMAPP_HOME: home, VMAPP_VM: FAKE_VM, VMAPP_KERNEL: path.join(d, 'Image'), VMAPP_INITRAMFS: path.join(d, 'initramfs.cpio'), FAKE_VM_APP: APP, FAKE_VM_LOG: path.join(d, 'vm.log') };
  fs.writeFileSync(env.VMAPP_KERNEL, 'k');
  fs.writeFileSync(env.VMAPP_INITRAMFS, 'i');
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { core: Object.assign({ command: ['node', 'main.js'] }, core), permissions: { folders: [], dialogs: true, external: false } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  assert.equal(run('install', file).code, 0);
  return { d, home, env, run, vmLog: env.FAKE_VM_LOG };
}

test('CLI resources: show, set vCPUs and memory, --recommended, --default; bounds are refused', (t) => {
  const s = cliSetup(t, { cpus: 2, memoryMiB: 512 });
  const limits = R.hostLimits();
  let r = s.run('resources', ID);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^recommended : 2 vCPUs, 512 MiB$/m);
  assert.match(r.out, /^your choice : none \(default: 1 vCPU, 512 MiB\)$/m);
  assert.match(r.out, new RegExp(`^this Mac    : up to ${limits.cpus} vCPUs? and ${limits.memoryMiB} MiB`, 'm'));
  assert.ok(!/applies at the next launch/.test(r.out));

  r = s.run('resources', ID, '--memory', '128');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^your choice : 1 vCPU, 128 MiB$/m, 'only memory chosen: one vCPU by default');
  assert.match(r.out, /warning: 128 MiB is less than the 512 MiB the app recommends/);
  assert.match(r.out, /applies at the next launch/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'grants', `${ID}.json`), 'utf8')), { resources: { memoryMiB: 128 } });

  r = s.run('resources', ID, '--recommended');
  assert.equal(r.code, 0, r.err);
  const want = R.recommendedChoice({ core: { cpus: 2, memoryMiB: 512 } }, limits);
  assert.match(r.out, new RegExp(`your choice : ${want.cpus} vCPUs?, ${want.memoryMiB} MiB`));
  assert.ok(!/warning:/.test(r.out));

  if (limits.cpus >= 2) {
    r = s.run('resources', ID, '--cpus', '2', '--memory', '256');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /your choice : 2 vCPUs, 256 MiB/);
    assert.match(r.out, /warning: 256 MiB is less than the 512 MiB/);
  }

  // refusals: nothing is saved
  const before = fs.readFileSync(path.join(s.home, 'grants', `${ID}.json`), 'utf8');
  r = s.run('resources', ID, '--cpus', String(limits.cpus + 1));
  assert.equal(r.code, 1);
  assert.match(r.err, /more than it can give/);
  r = s.run('resources', ID, '--memory', String(limits.memoryMiB + 1));
  assert.equal(r.code, 1);
  assert.match(r.err, /more than half of this Mac's memory/);
  r = s.run('resources', ID, '--memory', '10');
  assert.equal(r.code, 1);
  assert.match(r.err, /at least 64/);
  r = s.run('resources', ID, '--cpus', '0');
  assert.equal(r.code, 1);
  r = s.run('resources', ID, '--cpus', 'many');
  assert.equal(r.code, 2);
  assert.match(r.err, /--cpus needs a whole number/);
  r = s.run('resources', 'com.example.nope');
  assert.equal(r.code, 1);
  assert.match(r.err, /not installed/);
  assert.equal(fs.readFileSync(path.join(s.home, 'grants', `${ID}.json`), 'utf8'), before, 'a refused choice changed nothing');

  r = s.run('resources', ID, '--default');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /your choice : none \(default: 1 vCPU, 512 MiB\)/);
  assert.equal(fs.existsSync(path.join(s.home, 'grants', `${ID}.json`)), false);
  r = s.run('resources', ID, '--default', '--cpus', '2');
  assert.equal(r.code, 2);
  r = s.run('resources', ID, '--json');
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).recommended.memoryMiB, 512);
});

test('CLI run --headless honours the chosen size (the VM is started with it)', (t) => {
  const s = cliSetup(t, { cpus: 4, memoryMiB: 1024 });
  const limits = R.hostLimits();
  const cpus = Math.min(2, limits.cpus);
  assert.equal(s.run('resources', ID, '--cpus', String(cpus), '--memory', '300').code, 0);
  const r = s.run('run', ID, '--headless', '--timeout', '8000', '--duration', '200');
  assert.equal(r.code, 0, r.out + r.err);
  const argv = JSON.parse(fs.readFileSync(s.vmLog, 'utf8').trim().split('\n')[0]).argv;
  assert.equal(argv[argv.indexOf('--cpus') + 1], String(cpus));
  assert.equal(argv[argv.indexOf('--memory') + 1], '300');
  assert.match(r.out, new RegExp(`VM size: ${cpus} vCPUs?, 300 MiB \\(your choice\\); the app recommends 4 vCPUs, 1024 MiB`));
});

test('CLI inspect says the manifest recommends the size', (t) => {
  const s = cliSetup(t, { cpus: 4, memoryMiB: 1024 });
  const file = path.join(s.d, 'a.vmapp');
  const r = s.run('inspect', file);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /recommends 1024 MiB, 4 cpu\(s\)/);
});
