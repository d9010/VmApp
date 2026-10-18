'use strict';
// The experimental Vulkan backend (SPEC 8.7, GOVERNANCE INV-H8) in hostlib and the loader's logic, without a real VM: the manifest
// form `{cap:"gpu", api:"vulkan"}`, the grant that records the API, the update diff, the choice of the backend, AppSession with a fake
// launcher (which launcher, which kernel, the arguments, the refusal of runtime grants, the backend's own stop verdicts), the loader's
// preference and the sheet's words. The launcher itself is tested by `cargo test` in host/, the real VM by tests/gpu-vulkan/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateManifest, canonicalize, ManifestError, RUNTIMES, GPU_RUNTIMES } = require('../../hostlib/manifest');
const { Store, validateGrants } = require('../../hostlib/store');
const { checkHostGrant, hostRequestSummary, setHostGrant, Catalog } = require('../../hostlib/capabilities');
const { permissionDiff } = require('../../hostlib/updates');
const { AppSession, buildVmArgs } = require('../../hostlib/session');
const { gpuRequest, gpuApi, gpuAllowed, vulkanAllowed, chooseBackend } = require('../../hostlib/gpu');
const { pack } = require('../../hostlib/package');
const { FakeWindowManager, FakeDialogs } = require('../../hostlib/headless');
const { LoaderPrefs } = require('../../loader/src/prefs');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const APP = path.join(__dirname, 'fixtures', 'app-main.js');
const ID = 'com.example.notes';
const ORIG_ENV = Object.fromEntries(['FAKE_VM_APP', 'FAKE_VM_LOG', 'APP_MARKS', 'FAKE_VM_REASON', 'FAKE_VM_REASON_AFTER_MS'].map((k) => [k, process.env[k]]));

const base = (host, runtime = 'node22-gpu') => ({
  format: 1,
  id: 'com.example.vk',
  name: 'Vk',
  version: '1.0.0',
  runtime,
  core: { command: ['node', 'main.js'] },
  permissions: { host },
});
const manifestOf = (host, runtime) => validateManifest(base(host, runtime), { files: 'forbidden' });
const VK = { cap: 'gpu', api: 'vulkan', purpose: 'Renders with Vulkan' };
const RPC = { cap: 'gpu', purpose: 'Runs the model on the GPU' };

// ------------------------------------------------------------------------------------------------ the manifest

test('manifest: {cap:"gpu", api:"vulkan"} needs the node22-gpu runtime; api exists for gpu only, with one value', () => {
  assert.ok(RUNTIMES.includes('node22-gpu'));
  assert.deepEqual(GPU_RUNTIMES, ['node22-gpu']);
  const m = manifestOf([VK]);
  assert.deepEqual(m.permissions.host, [{ cap: 'gpu', api: 'vulkan', purpose: 'Renders with Vulkan' }]);
  assert.deepEqual(JSON.parse(canonicalize(m)).permissions.host, m.permissions.host, 'round trip');
  assert.equal(gpuApi(m), 'vulkan');
  assert.equal(gpuApi(manifestOf([RPC], 'node22')), null, 'the plain gpu has no api');
  // a manifest without api keeps its canonical form: no "api" key appears
  assert.deepEqual(manifestOf([RPC], 'node22').permissions.host, [{ cap: 'gpu', purpose: 'Runs the model on the GPU' }]);
  assert.throws(() => manifestOf([VK], 'node22'), /needs a runtime that carries the GPU driver/);
  assert.throws(() => manifestOf([VK], 'native'), /needs a runtime/);
  assert.throws(() => manifestOf([{ cap: 'gpu', api: 'metal' }]), /must be one of vulkan/);
  assert.throws(() => manifestOf([{ cap: 'gpu', api: 'Vulkan' }]), /must be one of vulkan/);
  assert.throws(() => manifestOf([{ cap: 'gpu', api: 3 }]), /must be one of vulkan/);
  assert.throws(() => manifestOf([{ cap: 'screen', api: 'vulkan' }]), /only valid for the capability "gpu"/);
  assert.throws(() => manifestOf([{ cap: 'tool:*', api: 'vulkan' }]), /only valid for the capability "gpu"/);
  // one gpu entry per app: the plain one and the Vulkan one together are a duplicate
  assert.throws(() => manifestOf([RPC, VK]), /not unique/);
  assert.throws(() => manifestOf([VK, { ...VK, purpose: 'again' }]), /not unique/);
  // the plain gpu works on node22-gpu too (the runtime is a superset)
  assert.equal(manifestOf([RPC]).runtime, 'node22-gpu');
});

// ------------------------------------------------------------------------------------------------ the decisions

test('gpu: the plain gpu and the Vulkan gpu are different decisions, and each ignores the other’s grant', () => {
  const vk = manifestOf([VK]);
  const rpc = manifestOf([RPC], 'node22');
  const rpcGrant = { gpu: { mode: 'session' } };
  const vkGrant = { gpu: { mode: 'session', api: 'vulkan' } };
  assert.equal(gpuAllowed(rpc, rpcGrant), true);
  assert.equal(vulkanAllowed(rpc, rpcGrant), false);
  assert.equal(vulkanAllowed(vk, vkGrant), true);
  assert.equal(gpuAllowed(vk, vkGrant), false, 'a Vulkan request never starts the RPC server');
  assert.equal(gpuAllowed(vk, rpcGrant), false);
  assert.equal(vulkanAllowed(vk, rpcGrant), false, 'a grant made for the plain gpu is not a grant for Vulkan');
  assert.equal(gpuAllowed(rpc, vkGrant), false, 'and the other way round');
  assert.equal(vulkanAllowed(vk, {}), false);
  assert.equal(vulkanAllowed(vk, { gpu: { mode: 'ask', api: 'vulkan' } }), false, 'a hand-written ask is no grant');
  assert.equal(vulkanAllowed(manifestOf([]), vkGrant), false, 'an app that did not ask');
  assert.equal(vulkanAllowed(null, vkGrant), false);
  assert.equal(gpuRequest(vk).api, 'vulkan');
});

test('chooseBackend: krun only when asked AND allowed AND enabled AND installed; every other case is the normal backend, with the reason', () => {
  const vk = manifestOf([VK]);
  const ok = { manifest: vk, hostGrants: { gpu: { mode: 'session', api: 'vulkan' } }, enabled: true, installed: true };
  assert.deepEqual(chooseBackend(ok), { backend: 'krun', why: null });
  assert.equal(chooseBackend({ ...ok, enabled: false }).backend, 'vz');
  assert.match(chooseBackend({ ...ok, enabled: false }).why, /Experimental GPU \(Vulkan\)/);
  assert.match(chooseBackend({ ...ok, installed: false }).why, /not installed/);
  assert.match(chooseBackend({ ...ok, hostGrants: {} }).why, /not allowed/);
  assert.match(chooseBackend({ ...ok, hostGrants: { gpu: { mode: 'session' } } }).why, /not allowed/);
  // an app that does not ask for Vulkan is never on krun, whatever the setting says, and there is nothing to explain
  for (const m of [manifestOf([RPC], 'node22'), manifestOf([{ cap: 'screen' }], 'node22'), manifestOf([], 'node22')]) {
    assert.deepEqual(chooseBackend({ ...ok, manifest: m }), { backend: 'vz', why: null });
  }
  assert.deepEqual(chooseBackend({ ...ok, manifest: null }), { backend: 'vz', why: null });
});

// ------------------------------------------------------------------------------------------------ grants

test('grants: a gpu grant records the API (vulkan only); the sheet and the CLI get it from the manifest', () => {
  assert.deepEqual(validateGrants({ host: { gpu: { mode: 'session', api: 'vulkan' } } }).host, { gpu: { mode: 'session', api: 'vulkan' } });
  assert.deepEqual(validateGrants({ host: { gpu: { mode: 'session' } } }).host, { gpu: { mode: 'session' } }, 'the plain grant has none');
  assert.throws(() => validateGrants({ host: { gpu: { mode: 'session', api: 'metal' } } }), /api must be one of/);
  assert.throws(() => validateGrants({ host: { screen: { mode: 'ask', api: 'vulkan' } } }), /only valid for gpu/);
  assert.throws(() => validateGrants({ host: { gpu: { mode: 'ask', api: 'vulkan' } } }), /only mode is "session"/);
  const vk = manifestOf([VK]);
  assert.deepEqual(checkHostGrant(vk, null, 'gpu', { mode: 'session' }), { mode: 'session', api: 'vulkan' }, 'api added from the manifest');
  assert.deepEqual(checkHostGrant(vk, null, 'gpu', {}), { mode: 'session', api: 'vulkan' });
  assert.deepEqual(checkHostGrant(vk, null, 'gpu', { mode: 'session', api: 'vulkan' }), { mode: 'session', api: 'vulkan' });
  assert.throws(() => checkHostGrant(vk, null, 'gpu', { mode: 'session', api: 'metal' }), /cannot name/);
  const rpc = manifestOf([RPC], 'node22');
  assert.deepEqual(checkHostGrant(rpc, null, 'gpu', { mode: 'session' }), { mode: 'session' });
  assert.throws(() => checkHostGrant(rpc, null, 'gpu', { mode: 'session', api: 'vulkan' }), /without an API/, 'a grant cannot add the API the manifest does not ask for');
  assert.throws(() => checkHostGrant(manifestOf([{ cap: 'screen' }]), null, 'screen', { mode: 'ask', api: 'vulkan' }), /cannot name/);
});

test('summary: the sheet’s entry says experimental and shows a grant only when it is for this API', () => {
  const vk = manifestOf([VK]);
  const [x] = hostRequestSummary(vk, null, { host: { gpu: { mode: 'session', api: 'vulkan' } } });
  assert.deepEqual({ cap: x.cap, api: x.api, experimental: x.experimental, risk: x.risk, control: x.control }, { cap: 'gpu', api: 'vulkan', experimental: true, risk: 'gpu', control: false });
  assert.deepEqual(x.grant, { mode: 'session', api: 'vulkan' });
  const [stale] = hostRequestSummary(vk, null, { host: { gpu: { mode: 'session' } } });
  assert.equal(stale.grant, null, 'a plain-gpu grant is not a grant for the Vulkan request');
  const [plain] = hostRequestSummary(manifestOf([RPC], 'node22'), null, { host: { gpu: { mode: 'session' } } });
  assert.equal(plain.api, undefined);
  assert.equal(plain.experimental, undefined);
  assert.deepEqual(plain.grant, { mode: 'session' });
  const [other] = hostRequestSummary(manifestOf([RPC], 'node22'), null, { host: { gpu: { mode: 'session', api: 'vulkan' } } });
  assert.equal(other.grant, null, 'and the other way round');
});

function storeWith(t, host, runtime = 'node22-gpu') {
  const d = tmpdir('vkstore-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { runtime, permissions: { folders: [], dialogs: false, external: false, host } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  store.install(file);
  return { d, store };
}

function install(t, ctx, version, host, runtime = 'node22-gpu') {
  const proj = path.join(ctx.d, `proj-${version}`);
  makeProject(proj, { manifest: { version, runtime, permissions: { folders: [], dialogs: false, external: false, host } } });
  const file = path.join(ctx.d, `a-${version}.vmapp`);
  pack(proj, file);
  ctx.store.install(file);
}

test('store: the grant survives a version that asks for the same API and is dropped when the API changes or goes away', (t) => {
  const ctx = storeWith(t, [VK]);
  const catalog = new Catalog({ home: ctx.store.home });
  setHostGrant(ctx.store, catalog, ctx.store.get(ID), 'gpu', { mode: 'session' });
  assert.deepEqual(ctx.store.loadHostGrants(ID), { gpu: { mode: 'session', api: 'vulkan' } });
  assert.deepEqual(ctx.store.expireSessionHostGrants(ID), [], 'like §8.6 the grant is not reset when the app stops');
  install(t, ctx, '1.1.0', [{ ...VK, purpose: 'new words' }]);
  assert.deepEqual(ctx.store.loadHostGrants(ID), { gpu: { mode: 'session', api: 'vulkan' } }, 'same API: kept');
  install(t, ctx, '1.2.0', [RPC]);
  assert.deepEqual(ctx.store.loadHostGrants(ID), {}, 'the version asks for the plain gpu now: the Vulkan grant is dropped (an update never grants)');
  const again = storeWith(t, [RPC]);
  setHostGrant(again.store, new Catalog({ home: again.store.home }), again.store.get(ID), 'gpu', { mode: 'session' });
  install(t, again, '1.1.0', [VK]);
  assert.deepEqual(again.store.loadHostGrants(ID), {}, 'plain -> Vulkan: the old grant does not carry over either');
  install(t, again, '1.2.0', []);
  assert.deepEqual(again.store.loadHostGrants(ID), {});
});

test('updates: adding the Vulkan API (or changing it) is a new host capability and always stops and asks', () => {
  const rpc = manifestOf([RPC], 'node22');
  const vk = manifestOf([VK]);
  const d = permissionDiff(rpc, vk);
  assert.equal(d.any, true);
  assert.deepEqual(d.hostAdded, [{ cap: 'gpu', api: 'vulkan', purpose: 'Renders with Vulkan', control: false }]);
  assert.deepEqual(d.hostRemoved, ['gpu']);
  const back = permissionDiff(vk, rpc);
  assert.deepEqual(back.hostAdded, [{ cap: 'gpu', purpose: 'Runs the model on the GPU', control: false }]);
  assert.deepEqual(back.hostRemoved, ['gpu:vulkan']);
  assert.deepEqual(permissionDiff(vk, manifestOf([{ ...VK, purpose: 'other words' }])).hostAdded, [], 'same API, other words: nothing new');
  assert.equal(permissionDiff(vk, vk).any, false);
  assert.deepEqual(permissionDiff(manifestOf([]), vk).hostAdded.map((h) => h.cap), ['gpu']);
});

// ------------------------------------------------------------------------------------------------ the loader's preference

test('prefs: "Experimental GPU (Vulkan)" is off by default, boolean, saved and read back', (t) => {
  const d = tmpdir('vkprefs-');
  t.after(() => rmrf(d));
  const p = new LoaderPrefs({ home: d });
  assert.equal(p.get('experimentalGpuVulkan'), false);
  assert.equal(p.set('experimentalGpuVulkan', true).experimentalGpuVulkan, true);
  assert.equal(new LoaderPrefs({ home: d }).get('experimentalGpuVulkan'), true);
  assert.throws(() => p.set('experimentalGpuVulkan', 'yes'), /must be a boolean/);
});

// ------------------------------------------------------------------------------------------------ AppSession with a fake launcher

function sessionSetup(t, { host = [VK], grants, enabled = true, installed = true, env = {}, gpuWindowMiB, runtime = 'node22-gpu' } = {}) {
  const d = tmpdir('vksess-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { runtime, permissions: { folders: [], dialogs: true, external: false, host } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(file);
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', `${runtime}.img`), 'img');
  fs.writeFileSync(path.join(d, 'Image'), 'k');
  fs.writeFileSync(path.join(d, 'Image-gpu'), 'kg');
  fs.writeFileSync(path.join(d, 'initramfs.cpio'), 'i');
  const vmLog = path.join(d, 'vm.log');
  for (const [k, v] of Object.entries({ FAKE_VM_APP: APP, FAKE_VM_LOG: vmLog, APP_MARKS: path.join(d, 'marks.txt'), ...env })) process.env[k] = v;
  t.after(() => {
    for (const [k, v] of Object.entries(ORIG_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const wm = new FakeWindowManager();
  const logs = [];
  const traffic = [];
  let setting = enabled;
  const session = new AppSession({
    appId: ID,
    home,
    store,
    vmappVmPath: [process.execPath, FAKE_VM, 'vz'],
    kernel: path.join(d, 'Image'),
    initramfs: path.join(d, 'initramfs.cpio'),
    grants: grants || { folders: {}, askEveryTime: false, host: { gpu: { mode: 'session', api: 'vulkan' } } },
    windowManager: wm,
    dialogs: new FakeDialogs({ open: () => [d], save: () => path.join(d, 'out.txt') }),
    krun: { path: installed ? [process.execPath, FAKE_VM, 'krun'] : '/nonexistent/vmapp-vm-krun', kernel: path.join(d, 'Image-gpu'), enabled: () => setting, gpuWindowMiB },
    onLog: (e) => logs.push(e),
    timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  session.on('traffic', (ev) => traffic.push(ev));
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  const lines = () => (fs.existsSync(vmLog) ? fs.readFileSync(vmLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const argv = () => lines()[0].argv;
  const arg = (name) => argv().flatMap((a, i) => (a === name ? [argv()[i + 1]] : []));
  return { d, session, logs, traffic, lines, argv, arg, setEnabled: (v) => (setting = v) };
}

test('session: asked + allowed + enabled = the krun launcher with the gpu kernel; the arguments are the normal ones plus --gpu-window', async (t) => {
  const s = sessionSetup(t, { gpuWindowMiB: 4096 });
  await s.session.start();
  assert.equal(s.session.backend, 'krun');
  assert.equal(s.argv()[0], 'krun', 'the krun launcher was started');
  assert.equal(path.basename(s.arg('--kernel')[0]), 'Image-gpu');
  assert.deepEqual(s.arg('--gpu-window'), ['4096']);
  assert.deepEqual(s.arg('--service'), [], 'no llama.cpp RPC server for a Vulkan request');
  assert.ok(!s.argv().includes('--dev-no-sandbox'), 'the loader never passes the sandbox test switch');
  assert.ok(s.arg('--runtime')[0].endsWith('node22-gpu.img'));
  assert.ok(s.logs.some((l) => /EXPERIMENTAL: the app runs on the Vulkan GPU backend/.test(l.message)));
  const row = s.traffic.find((e) => e.kind === 'gpu' && e.backend === 'krun');
  assert.deepEqual({ t: row.t, dir: row.dir, op: row.op, api: row.api }, { t: 'gpu', dir: 'host', op: 'start', api: 'vulkan' });
  assert.ok(!s.logs.some((l) => /runs without one/.test(l.message)));
});

test('session: with no --gpu-window given, the launcher gets none (its own default)', async (t) => {
  const s = sessionSetup(t);
  await s.session.start();
  assert.equal(s.session.backend, 'krun');
  assert.deepEqual(s.arg('--gpu-window'), []);
});

test('session: any switch missing = the normal launcher and kernel, and the log says why', async (t) => {
  const cases = [
    ['the loader setting is off', { enabled: false }, /Experimental GPU \(Vulkan\)/],
    ['the user did not allow it', { grants: { folders: {}, askEveryTime: false, host: {} } }, /not allowed/],
    ['the user allowed the plain gpu only', { grants: { folders: {}, askEveryTime: false, host: { gpu: { mode: 'session' } } } }, /not allowed/],
    ['the backend is not installed', { installed: false }, /not installed/],
  ];
  for (const [name, variant, why] of cases) {
    const s = sessionSetup(t, variant);
    await s.session.start();
    assert.equal(s.session.backend, 'vz', name);
    assert.equal(s.argv()[0], 'vz', name);
    assert.equal(path.basename(s.arg('--kernel')[0]), 'Image', name);
    assert.deepEqual(s.arg('--gpu-window'), [], name);
    assert.ok(s.logs.some((l) => l.level === 'warn' && /runs without one/.test(l.message) && why.test(l.message)), `${name}: ${s.logs.map((l) => l.message).join(' | ')}`);
    await s.session.stop({ skipBeforeQuit: true });
  }
});

test('session: an app that does not ask for Vulkan never uses krun, whatever the setting', async (t) => {
  for (const host of [[], [{ cap: 'screen', purpose: 's' }], [RPC]]) {
    const s = sessionSetup(t, { host, grants: { folders: {}, askEveryTime: false, host: { gpu: { mode: 'session', api: 'vulkan' } } } });
    await s.session.start();
    assert.equal(s.session.backend, 'vz', JSON.stringify(host));
    assert.equal(s.argv()[0], 'vz');
    assert.ok(!s.logs.some((l) => /Vulkan GPU, but it runs without one/.test(l.message)), 'nothing to explain: it never asked');
    await s.session.stop({ skipBeforeQuit: true });
  }
});

test('session: runtime folder grants are refused on the krun backend before the user is asked, and work on the normal one', async (t) => {
  const k = sessionSetup(t);
  await k.session.start();
  assert.equal(k.session.backend, 'krun');
  await assert.rejects(() => k.session._dialogOpen({ directory: true }), /not supported on the gpu backend/);
  await assert.rejects(() => k.session._dialogSave({ defaultName: 'x.txt' }), /not supported on the gpu backend/);
  assert.ok(!k.lines().some((l) => l.stdin && l.stdin.op === 'grant'), 'no grant command reached the launcher');
  const v = sessionSetup(t, { enabled: false });
  await v.session.start();
  const r = await v.session._dialogOpen({ directory: true });
  assert.equal(r.canceled, false, 'the normal backend grants it');
  assert.ok(v.lines().some((l) => l.stdin && l.stdin.op === 'grant'));
});

test('session: the backend’s own verdicts (gpu-hang, vmm-crashed) are logged as warnings and shown as a gpu row', async (t) => {
  for (const reason of ['gpu-hang', 'vmm-crashed']) {
    const s = sessionSetup(t, { env: { FAKE_VM_REASON: reason, FAKE_VM_REASON_AFTER_MS: '400' } });
    await s.session.start();
    const info = await s.session.whenStopped();
    assert.equal(info.reason, reason);
    assert.equal(info.detail, 'stopped by the test');
    assert.ok(s.logs.some((l) => l.level === 'warn' && new RegExp(`Vulkan GPU backend stopped this app \\(${reason}`).test(l.message)), s.logs.map((l) => l.message).join(' | '));
    const row = s.traffic.find((e) => e.kind === 'gpu' && e.op === 'stop');
    assert.deepEqual({ reason: row.reason, backend: row.backend, error: row.error }, { reason, backend: 'krun', error: true });
  }
});

test('buildVmArgs: --gpu-window only when asked for', () => {
  const o = { kernel: '/k', initramfs: '/i', runtime: '/r', core: '/c', appdata: '/a', start: {}, socket: '/s' };
  assert.ok(!buildVmArgs(o).includes('--gpu-window'));
  const a = buildVmArgs({ ...o, gpuWindowMiB: 2048 });
  assert.equal(a[a.indexOf('--gpu-window') + 1], '2048');
});
