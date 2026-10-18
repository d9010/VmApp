'use strict';
// The GPU capability (SPEC 8.6, GOVERNANCE INV-H7) in hostlib and the loader's logic, without a real GPU server:
// manifest, grants, the update diff, the GpuBroker (with a fake server), AppSession with a fake vmapp-vm (the service arguments,
// the environment, revoke, panic, crash), the Inspector rows, the monitor pill, the registry words, the sheet's validation and the
// CLI. The sandboxed server itself is tested by tests/gpu/ (a real sandbox, a real GPU, a real llama.cpp client); the tunnel by
// host/src/net.rs (cargo test) and tests/e2e.sh scenario 12.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { validateManifest, canonicalize, parseHostCap, ManifestError } = require('../../hostlib/manifest');
const { Store, validateGrants } = require('../../hostlib/store');
const { Catalog, checkHostGrant, hostRequestSummary, setHostGrant } = require('../../hostlib/capabilities');
const { permissionDiff } = require('../../hostlib/updates');
const { AppSession, buildVmArgs, startPayload } = require('../../hostlib/session');
const { GpuBroker, gpuRequest, gpuAllowed, serviceArg, GUEST_ADDR, ENV_NAME } = require('../../hostlib/gpu');
const { GpuServer } = require('../../hostlib/hostproc');
const { pack } = require('../../hostlib/package');
const { FakeWindowManager, FakeDialogs } = require('../../hostlib/headless');
const { pillOfEvent, buildPills } = require('../../loader/src/monitor-model');
const { permissionsSummary } = require('../../registry/lib/present');
const { tmpdir, rmrf, makeProject, wait, ROOT } = require('./helpers');

const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const APP = path.join(__dirname, 'fixtures', 'app-main.js');
const CLI = path.join(ROOT, 'tools', 'vmapp');
const ID = 'com.example.notes';
// the environment variables the fake vmapp-vm reads; sessionSetup sets them and puts them back as they were
const ORIG_ENV = Object.fromEntries(['FAKE_VM_APP', 'FAKE_VM_LOG', 'APP_MARKS', 'FAKE_VM_SERVICE_EVENTS'].map((k) => [k, process.env[k]]));

const base = (host, extra = {}) => ({
  format: 1,
  id: 'com.example.gpu',
  name: 'Gpu',
  version: '1.0.0',
  runtime: 'node22',
  core: { command: ['node', 'main.js'] },
  permissions: Object.assign({ host }, extra),
});
const manifestOf = (host, extra) => validateManifest(base(host, extra), { files: 'forbidden' });
const GPU = { cap: 'gpu', purpose: 'Runs the language model on the GPU' };

// ------------------------------------------------------------------------------------------------ the manifest

test('manifest: gpu is a host capability with a purpose; it is unique, has no id and no wildcard', () => {
  const m = manifestOf([GPU]);
  assert.deepEqual(m.permissions.host, [{ cap: 'gpu', purpose: 'Runs the language model on the GPU' }]);
  assert.deepEqual(parseHostCap('gpu'), { kind: 'gpu', id: null, wildcard: false });
  for (const bad of ['gpu:0', 'gpu:*', 'GPU', 'gpu ', 'gpus', 'metal', 'tool:gpu*']) {
    assert.equal(parseHostCap(bad), null, bad);
    assert.throws(() => manifestOf([{ cap: bad }]), ManifestError, bad);
  }
  assert.throws(() => manifestOf([GPU, GPU]), /not unique/);
  assert.throws(() => manifestOf([{ cap: 'gpu', purpose: 'x', mode: 'always' }]), /not a known key/);
  assert.throws(() => manifestOf([{ cap: 'gpu', purpose: 'x'.repeat(201) }]), /at most 200/);
  // beside the other capabilities, within the limit of 8 entries
  assert.equal(manifestOf([{ cap: 'screen' }, { cap: 'input' }, GPU, { cap: 'tool:*' }]).permissions.host.length, 4);
  // canonical form: round trip
  const text = canonicalize(m);
  assert.deepEqual(JSON.parse(text).permissions.host, m.permissions.host);
});

test('manifest: the core cannot set VMAPP_GPU_RPC (VMAPP_* is the platform’s)', () => {
  assert.throws(() => validateManifest({ ...base([GPU]), core: { command: ['x'], env: { VMAPP_GPU_RPC: '127.0.0.1:22' } } }, { files: 'forbidden' }), /VMAPP_/);
  assert.equal(gpuRequest(manifestOf([GPU])).cap, 'gpu');
  assert.equal(gpuRequest(manifestOf([{ cap: 'screen' }])), null);
  assert.equal(gpuRequest(manifestOf([])), null);
});

// ------------------------------------------------------------------------------------------------ grants

test('grants: the GPU has one mode, session (“Allow while the app runs”); ask and always are refused everywhere', () => {
  assert.deepEqual(validateGrants({ host: { gpu: { mode: 'session' } } }).host, { gpu: { mode: 'session' } });
  for (const mode of ['ask', 'always', 'allow', undefined]) assert.throws(() => validateGrants({ host: { gpu: { mode } } }), /gpu/);
  assert.throws(() => validateGrants({ host: { gpu: { mode: 'session', tools: ['x'] } } }), /tools/);
  const m = manifestOf([GPU]);
  assert.deepEqual(checkHostGrant(m, null, 'gpu', { mode: 'session' }), { mode: 'session' });
  assert.deepEqual(checkHostGrant(m, null, 'gpu', {}), { mode: 'session' }, 'no mode given: the only one there is');
  assert.throws(() => checkHostGrant(m, null, 'gpu', { mode: 'ask' }), /only be allowed while the app runs/);
  assert.throws(() => checkHostGrant(m, null, 'gpu', { mode: 'always' }), /only be allowed while the app runs/);
  assert.throws(() => checkHostGrant(manifestOf([{ cap: 'screen' }]), null, 'gpu', { mode: 'session' }), /does not request/, 'the manifest must ask');
  // the decision
  assert.equal(gpuAllowed(m, { gpu: { mode: 'session' } }), true);
  assert.equal(gpuAllowed(m, {}), false, 'no grant: off');
  assert.equal(gpuAllowed(m, { gpu: { mode: 'ask' } }), false, 'a hand-written ask is no grant');
  assert.equal(gpuAllowed(manifestOf([]), { gpu: { mode: 'session' } }), false, 'a grant for an app that did not ask is ignored');
  assert.equal(gpuAllowed(null, { gpu: { mode: 'session' } }), false);
});

function storeWith(t, host) {
  const d = tmpdir('gpustore-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: { folders: [], dialogs: false, external: false, host } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  store.install(file);
  return { d, store, file, proj };
}

test('store: a gpu grant is kept across runs (unlike other session grants) and dropped when a version stops asking', (t) => {
  const { d, store } = storeWith(t, [GPU, { cap: 'screen', purpose: 's' }]);
  const catalog = new Catalog({ home: store.home });
  setHostGrant(store, catalog, store.get(ID), 'gpu', { mode: 'session' });
  setHostGrant(store, catalog, store.get(ID), 'screen', { mode: 'session' });
  assert.deepEqual(store.loadHostGrants(ID), { gpu: { mode: 'session' }, screen: { mode: 'session' } });
  // the app stops: the screen grant goes back to ask, the GPU grant stays (there is no ask for the GPU)
  assert.deepEqual(store.expireSessionHostGrants(ID), ['screen']);
  assert.deepEqual(store.loadHostGrants(ID), { gpu: { mode: 'session' }, screen: { mode: 'ask' } });
  // a version that no longer asks for the GPU does not keep the grant, so a later one that asks again starts on “Don't allow”
  const proj2 = path.join(d, 'proj2');
  makeProject(proj2, { manifest: { version: '1.1.0', permissions: { folders: [], dialogs: false, external: false, host: [{ cap: 'screen', purpose: 's' }] } } });
  const f2 = path.join(d, 'b.vmapp');
  pack(proj2, f2);
  store.install(f2);
  assert.deepEqual(store.loadHostGrants(ID), { screen: { mode: 'ask' } }, 'the gpu grant did not survive a version without gpu');
  const proj3 = path.join(d, 'proj3');
  makeProject(proj3, { manifest: { version: '1.2.0', permissions: { folders: [], dialogs: false, external: false, host: [GPU] } } });
  const f3 = path.join(d, 'c.vmapp');
  pack(proj3, f3);
  store.install(f3);
  assert.equal(gpuAllowed(store.get(ID).manifest, store.loadHostGrants(ID)), false, 'the version that asks again starts on Don’t allow');
  // going back to the version with a grant-less history keeps nothing either
  setHostGrant(store, catalog, store.get(ID), 'gpu', { mode: 'session' });
  store.useVersion(ID, '1.1.0');
  assert.equal(store.loadHostGrants(ID).gpu, undefined);
});

test('hostRequestSummary: risk gpu, not “control of your computer”', (t) => {
  const { store } = storeWith(t, [GPU, { cap: 'input', purpose: 'click' }]);
  const sum = hostRequestSummary(store.get(ID).manifest, null, {});
  const g = sum.find((x) => x.cap === 'gpu');
  assert.deepEqual({ risk: g.risk, control: g.control, purpose: g.purpose, grant: g.grant }, { risk: 'gpu', control: false, purpose: GPU.purpose, grant: null });
  assert.equal(sum.find((x) => x.cap === 'input').control, true);
});

// ------------------------------------------------------------------------------------------------ the update diff and the registry

test('permissionDiff: a new gpu request always stops and asks, and is not “control of your computer”', () => {
  const v1 = manifestOf([{ cap: 'screen' }]);
  const v2 = manifestOf([{ cap: 'screen' }, GPU]);
  const d = permissionDiff(v1, v2);
  assert.equal(d.any, true);
  assert.deepEqual(d.hostAdded, [{ cap: 'gpu', purpose: GPU.purpose, control: false }]);
  assert.equal(permissionDiff(v2, v2).any, false, 'the same request is not news');
  assert.equal(permissionDiff(v2, v1).any, false, 'dropping it is not news');
  assert.deepEqual(permissionDiff(v2, v1).hostRemoved, ['gpu']);
  assert.equal(permissionDiff(manifestOf([]), v2).any, true, 'from no host requests at all');
});

test('registry: the app page and the listing say the app wants the GPU, in the registry’s words, apart from screen and control', () => {
  const s = (host) => permissionsSummary({ folders: [], dialogs: false, external: false, host });
  assert.equal(s([GPU]), "run work on your Mac's GPU through a sandboxed helper (you choose whether to allow it)");
  assert.match(s([GPU, { cap: 'input' }]), /control of your computer.*GPU/);
  assert.match(s([GPU, { cap: 'screen' }]), /see your screen.*GPU/);
  assert.equal(s([{ cap: 'screen' }]), 'see your screen (you choose whether to allow it)');
});

// ------------------------------------------------------------------------------------------------ the broker (with a fake server)

class FakeServer extends EventEmitter {
  constructor(o, behaviour = {}) {
    super();
    this.o = o;
    this.behaviour = behaviour;
    this.running = false;
    this.stops = [];
  }
  start() {
    if (this.behaviour.fail) return Promise.reject(new Error(this.behaviour.fail));
    this.running = true;
    return Promise.resolve({ pid: 4242 });
  }
  stop(reason) {
    this.stops.push(reason);
    if (!this.running) return Promise.resolve(null);
    this.running = false;
    this.emit('exit', { code: 0, signal: 'SIGTERM', requested: true, reason });
    return Promise.resolve({ code: 0 });
  }
  crash() {
    this.running = false;
    this.emit('exit', { code: 1, signal: null, requested: false, reason: 'exited' });
  }
}

function brokerWith(t, behaviour, ports = [51001, 51002, 51003]) {
  const d = tmpdir('gpubroker-');
  t.after(() => rmrf(d));
  const binary = path.join(d, 'rpc-server');
  const profile = path.join(d, 'rpc-server.sb');
  fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(profile, '(version 1)\n');
  const servers = [];
  const broker = new GpuBroker({
    binary,
    profile,
    home: path.join(d, 'home'),
    metalCache: false,
    skipPlatformCheck: true,
    pickPort: async () => ports.shift(),
    serverFactory: (o) => {
      const s = new FakeServer(o, behaviour);
      servers.push(s);
      return s;
    },
  });
  return { d, binary, profile, servers, broker };
}

test('broker: starts one server per run on the port it picked, hands out the loopback endpoint, stops it, tells who stopped it why', async (t) => {
  const { broker, servers, binary, profile } = brokerWith(t);
  const events = [];
  broker.on('started', (e) => events.push(['started', e.key, e.port, e.pid]));
  broker.on('stopped', (e) => events.push(['stopped', e.key, e.reason]));
  const a = await broker.start('run-a', { appId: ID, appName: 'Notes' });
  assert.deepEqual({ endpoint: a.endpoint, port: a.port, pid: a.pid, key: a.key }, { endpoint: '127.0.0.1:51001', port: 51001, pid: 4242, key: 'run-a' });
  assert.deepEqual({ binary: servers[0].o.binary, profile: servers[0].o.profile, port: servers[0].o.port, device: servers[0].o.device }, { binary, profile, port: 51001, device: 'MTL0' });
  assert.equal((await broker.start('run-a')).port, 51001, 'the same run gets the same server');
  assert.equal(servers.length, 1);
  const b = await broker.start('run-b', { appId: 'com.example.other', appName: 'Other' });
  assert.equal(b.port, 51002, 'another run, another server and port');
  assert.deepEqual(broker.active().map((x) => [x.key, x.appId, x.port]), [['run-a', ID, 51001], ['run-b', 'com.example.other', 51002]]);
  assert.equal(broker.isRunning('run-a'), true);
  assert.ok(fs.readdirSync(path.join(broker.home, 'gpu', 'servers')).length >= 1, 'a pid file for the reaper');
  await broker.stop('run-a', 'app-stopped');
  assert.equal(broker.isRunning('run-a'), false);
  assert.deepEqual(broker.active().map((x) => x.key), ['run-b']);
  await broker.stopAll('panic');
  assert.deepEqual(broker.active(), []);
  assert.deepEqual(events, [['started', 'run-a', 51001, 4242], ['started', 'run-b', 51002, 4242], ['stopped', 'run-a', 'app-stopped'], ['stopped', 'run-b', 'panic']]);
  await broker.stop('never-ran', 'x'); // nothing happens
});

test('broker: a server that dies by itself is reported as crashed; a server that cannot start is an error and counts as nothing', async (t) => {
  const { broker, servers } = brokerWith(t);
  const stopped = [];
  broker.on('stopped', (e) => stopped.push(e.reason));
  await broker.start('r1', { appId: ID });
  servers[0].crash();
  assert.deepEqual(stopped, ['crashed']);
  assert.deepEqual(broker.active(), []);
  const bad = brokerWith(t, { fail: 'the GPU server exited at once (code 65): sandbox-exec: bad profile' });
  bad.broker.on('stopped', () => assert.fail('a server that never started is not reported as stopped'));
  await assert.rejects(bad.broker.start('r1', { appId: ID }), /exited at once/);
  assert.deepEqual(bad.broker.active(), []);
});

test('broker: runs that start together never get the same port', async (t) => {
  const { broker } = brokerWith(t, undefined, [52000, 52000, 52000, 52001]);
  const [a, b] = await Promise.all([broker.start('r1', { appId: ID }), broker.start('r2', { appId: ID })]);
  assert.notEqual(a.port, b.port);
  assert.deepEqual([a.port, b.port].sort(), [52000, 52001]);
  // and a pick that keeps colliding is an error, not a shared port
  const stuck = brokerWith(t, undefined, new Array(20).fill(53000));
  await stuck.broker.start('x', { appId: ID });
  await assert.rejects(stuck.broker.start('y', { appId: ID }), /no free port/);
});

test('broker: not available without the files, or off Apple silicon; the reason is in plain words', () => {
  const none = new GpuBroker({ skipPlatformCheck: true });
  assert.equal(none.availability().ok, false);
  assert.match(none.availability().reason, /no GPU server/);
  const missing = new GpuBroker({ binary: '/nonexistent/rpc-server', profile: '/nonexistent/rpc-server.sb', skipPlatformCheck: true });
  assert.match(missing.availability().reason, /not installed.*gpu\/build\.sh/);
  const real = new GpuBroker({ binary: process.execPath, profile: __filename });
  assert.equal(real.availability().ok, process.platform === 'darwin' && process.arch === 'arm64');
  return assert.rejects(missing.start('k'), /not installed/);
});

test('broker.reapStale: stops a server a crashed loader left behind, only if it is still ours', async (t) => {
  const d = tmpdir('gpureap-');
  t.after(() => rmrf(d));
  const dir = path.join(d, 'gpu', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  const broker = new GpuBroker({ binary: '/x/rpc-server', profile: '/x/rpc-server.sb', home: d, skipPlatformCheck: true });
  // a record whose process is gone, a garbage record, a record of a live loader, and one of ours: nothing to stop, the first two are removed
  fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, port: 51000, binary: '/x/rpc-server', loader: 999998 }));
  fs.writeFileSync(path.join(dir, '5.json'), 'not json');
  fs.writeFileSync(path.join(dir, '6.json'), JSON.stringify({ pid: process.pid, port: 51000, binary: '/x/rpc-server', loader: process.ppid }));
  fs.writeFileSync(path.join(dir, '7.json'), JSON.stringify({ pid: process.pid, port: 51000, binary: '/x/rpc-server', loader: process.pid }));
  assert.deepEqual(await broker.reapStale(), []);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['6.json', '7.json'], 'dead and unreadable records are dropped; a live loader’s and our own are kept');
  // a record of a dead loader pointing at a live process that is NOT our server (a reused pid): the process is left alone
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, port: 51000, binary: '/x/rpc-server', loader: 999998 }));
  assert.deepEqual(await broker.reapStale(), []);
  assert.ok(!fs.existsSync(path.join(dir, `${process.pid}.json`)), 'the stale record is dropped');
});

// ------------------------------------------------------------------------------------------------ GpuServer arguments

test('GpuServer: sandbox-exec, the bundled profile first, loopback only, the port the loader picked', () => {
  const s = new GpuServer({ binary: '/Applications/D9010VmAppLauncher.app/Contents/Resources/vmapp/gpu/rpc-server', profile: '/Applications/D9010VmAppLauncher.app/Contents/Resources/vmapp/gpu/rpc-server.sb', port: 51234, metalCache: '/private/var/folders/aa/bb/C' });
  assert.deepEqual(s.argv(), [
    '-f', '/Applications/D9010VmAppLauncher.app/Contents/Resources/vmapp/gpu/rpc-server.sb',
    '-D', 'BIN=/Applications/D9010VmAppLauncher.app/Contents/Resources/vmapp/gpu/rpc-server',
    '-D', 'BINDIR=/Applications/D9010VmAppLauncher.app/Contents/Resources/vmapp/gpu',
    '-D', 'PORT=51234',
    '-D', 'METAL_CACHE=/private/var/folders/aa/bb/C',
    '/Applications/D9010VmAppLauncher.app/Contents/Resources/vmapp/gpu/rpc-server', '--host', '127.0.0.1', '--port', '51234', '--device', 'MTL0',
  ]);
  assert.ok(!new GpuServer({ binary: '/b/rpc-server', profile: '/b/p.sb', port: 51234 }).argv().some((a) => a.startsWith('METAL_CACHE')), 'no cache folder: no parameter');
  for (const bad of [{ port: 80 }, { port: 70000 }, { port: 'x' }, { binary: 'relative/rpc-server' }, { profile: 'p.sb' }, { device: 'MTL0; rm -rf' }, { metalCache: 'relative' }]) {
    assert.throws(() => new GpuServer({ binary: '/b/rpc-server', profile: '/b/p.sb', port: 51234, ...bad }), /GpuServer/, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------------------------------------ AppSession with a fake vmapp-vm

function sessionSetup(t, { host = [GPU], grants, behaviour, noBroker, useStore = false, env = {}, grantGpu = true } = {}) {
  const d = tmpdir('gpusess-');
  t.after(() => rmrf(d));
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: { folders: [], dialogs: false, external: false, host } } });
  const file = path.join(d, 'a.vmapp');
  pack(proj, file);
  const home = path.join(d, 'home');
  const store = new Store({ home, skipRuntimeCheck: true });
  store.install(file);
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  fs.writeFileSync(path.join(d, 'Image'), 'k');
  fs.writeFileSync(path.join(d, 'initramfs.cpio'), 'i');
  if (grantGpu && useStore) store.setHostGrant(ID, 'gpu', { mode: 'session' });
  const vmLog = path.join(d, 'vm.log');
  for (const [k, v] of Object.entries({ FAKE_VM_APP: APP, FAKE_VM_LOG: vmLog, APP_MARKS: path.join(d, 'marks.txt'), ...env })) {
    process.env[k] = v;
  }
  // always back to what the process had when this file loaded (a test may call sessionSetup several times)
  t.after(() => {
    for (const [k, v] of Object.entries(ORIG_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const b = noBroker ? null : brokerWith(t, behaviour);
  const wm = new FakeWindowManager();
  const logs = [];
  const traffic = [];
  const session = new AppSession({
    appId: ID,
    home,
    store,
    vmappVmPath: [process.execPath, FAKE_VM],
    kernel: path.join(d, 'Image'),
    initramfs: path.join(d, 'initramfs.cpio'),
    ...(useStore ? {} : { grants: grants || { folders: {}, askEveryTime: false, host: grantGpu ? { gpu: { mode: 'session' } } : {} } }),
    windowManager: wm,
    dialogs: new FakeDialogs(),
    gpu: b ? b.broker : undefined,
    onLog: (e) => logs.push(e),
    timeouts: { ready: 5000, coreReady: 5000, beforeQuit: 3000, stop: 5000, grant: 3000 },
  });
  session.on('traffic', (ev) => traffic.push(ev));
  wm.attach(session);
  t.after(() => session.stop({ skipBeforeQuit: true }).catch(() => {}));
  const vmLines = () => (fs.existsSync(vmLog) ? fs.readFileSync(vmLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const argvOf = () => vmLines()[0].argv;
  const arg = (name) => argvOf().flatMap((a, i) => (a === name ? [argvOf()[i + 1]] : []));
  const startEnv = () => JSON.parse(arg('--start')[0]).env;
  return { d, session, wm, logs, traffic, vmLines, argvOf, arg, startEnv, store, b };
}

test('session: allowed GPU = a server, --service gpu=127.0.0.1:PORT, and VMAPP_GPU_RPC in the core’s environment', async (t) => {
  const s = sessionSetup(t);
  await s.session.start();
  assert.deepEqual(s.arg('--service'), ['gpu=127.0.0.1:51001']);
  assert.ok(s.startEnv().includes(`${ENV_NAME}=${GUEST_ADDR}`), s.startEnv().join(' '));
  assert.equal(GUEST_ADDR, '127.0.0.1:50052');
  assert.equal(ENV_NAME, 'VMAPP_GPU_RPC');
  assert.deepEqual(s.b.broker.active().map((x) => [x.key, x.appId]), [[s.session.instanceId, ID]]);
  assert.ok(!s.argvOf().includes('--dev-allow-loopback'), 'the service path needs no test switch');
  assert.ok(s.logs.some((l) => /GPU allowed: sandboxed server on 127\.0\.0\.1:51001/.test(l.message)));
  const row = s.traffic.find((e) => e.kind === 'gpu' && e.phase === 'server');
  assert.deepEqual({ t: row.t, dir: row.dir, op: row.op, port: row.port, pid: row.pid, appId: row.appId }, { t: 'gpu', dir: 'host', op: 'start', port: 51001, pid: 4242, appId: ID });
  await s.session.stop({ skipBeforeQuit: true });
  assert.deepEqual(s.b.broker.active(), [], 'the server stops with the app');
  assert.deepEqual(s.b.servers[0].stops, ['app-stopped']);
  assert.ok(s.traffic.some((e) => e.kind === 'gpu' && e.op === 'stop' && e.reason === 'app-stopped'));
});

test('session: no grant, no GPU: no server, no --service, no environment variable (the default is Don’t allow)', async (t) => {
  for (const variant of [{ grantGpu: false }, { host: [{ cap: 'screen' }], grants: { folders: {}, askEveryTime: false, host: { gpu: { mode: 'session' } } } }, { host: [] }]) {
    const s = sessionSetup(t, variant);
    await s.session.start();
    assert.deepEqual(s.arg('--service'), [], JSON.stringify(variant));
    assert.ok(!s.startEnv().some((e) => e.startsWith(ENV_NAME)), 'no VMAPP_GPU_RPC');
    assert.equal(s.b.servers.length, 0, 'no server was started');
    assert.deepEqual(s.traffic.filter((e) => e.kind === 'gpu'), []);
    await s.session.stop({ skipBeforeQuit: true });
  }
});

test('session: granted but there is no broker, or the server cannot start: the app runs without a GPU, and says why', async (t) => {
  const none = sessionSetup(t, { noBroker: true });
  await none.session.start();
  assert.deepEqual(none.arg('--service'), []);
  assert.ok(none.logs.some((l) => /this loader has no GPU server/.test(l.message)));
  await none.session.stop({ skipBeforeQuit: true });

  const failing = sessionSetup(t, { behaviour: { fail: 'the GPU server exited at once (code 65): bad profile' } });
  await failing.session.start();
  assert.deepEqual(failing.arg('--service'), []);
  assert.ok(!failing.startEnv().some((e) => e.startsWith(ENV_NAME)));
  assert.ok(failing.logs.some((l) => /its server could not start.*bad profile/.test(l.message)));
  const row = failing.traffic.find((e) => e.kind === 'gpu');
  assert.deepEqual({ op: row.op, error: row.error }, { op: 'start', error: true });
  assert.match(row.preview, /GPU server start.*bad profile/);
});

test('session: taking the grant away while the app runs revokes the service and stops the server', async (t) => {
  const s = sessionSetup(t, { useStore: true });
  await s.session.start();
  assert.equal(s.b.broker.active().length, 1);
  const revokes = () => s.vmLines().filter((l) => l.stdin && l.stdin.op === 'service-revoke');
  assert.equal(revokes().length, 0);
  s.store.setHostGrant(ID, 'gpu', null); // the sheet or the CLI
  for (let i = 0; i < 80 && s.b.broker.active().length; i++) await wait(50);
  assert.deepEqual(s.b.broker.active(), [], 'the server was stopped within a couple of seconds');
  assert.deepEqual(revokes().map((l) => l.stdin), [{ op: 'service-revoke', name: 'gpu' }], 'and the launcher was told once');
  assert.deepEqual(s.b.servers[0].stops, ['revoked']);
  assert.ok(s.traffic.some((e) => e.kind === 'gpu' && e.op === 'stop' && e.reason === 'revoked'));
  assert.equal(s.session.state, 'running', 'the app keeps running');
});

test('session: panic (the broker stops every server) and a crashed server both revoke the service', async (t) => {
  const p = sessionSetup(t);
  await p.session.start();
  await p.b.broker.stopAll('panic');
  for (let i = 0; i < 40 && !p.vmLines().some((l) => l.stdin && l.stdin.op === 'service-revoke'); i++) await wait(25);
  assert.ok(p.vmLines().some((l) => l.stdin && l.stdin.op === 'service-revoke'), 'service-revoke after panic');
  assert.ok(p.traffic.some((e) => e.kind === 'gpu' && e.op === 'stop' && e.reason === 'panic'));

  const c = sessionSetup(t);
  await c.session.start();
  c.b.servers[0].crash();
  for (let i = 0; i < 40 && !c.vmLines().some((l) => l.stdin && l.stdin.op === 'service-revoke'); i++) await wait(25);
  assert.ok(c.vmLines().some((l) => l.stdin && l.stdin.op === 'service-revoke'), 'service-revoke after a crash');
  assert.ok(c.logs.some((l) => l.level === 'warn' && /GPU server stopped \(crashed/.test(l.message)));
});

test('session: service lines of vmapp-vm become gpu rows for the Inspector (byte counts only); hostile lines cannot break them', async (t) => {
  const events = [
    { id: 1, name: 'gpu', phase: 'open', allowed: true, bytesUp: 0, bytesDown: 0, durationMs: 0 },
    { id: 1, name: 'gpu', phase: 'traffic', allowed: true, bytesUp: 5000000, bytesDown: 120, durationMs: 700 },
    { id: 1, name: 'gpu', phase: 'close', allowed: true, bytesUp: 9000000, bytesDown: 480, durationMs: 4100, reason: 'revoked' },
    { id: 2, name: 'gpu', phase: 'close', allowed: false, bytesUp: 0, bytesDown: 0, durationMs: 1, reason: 'service not granted' },
    { id: 3, name: 'other', phase: 'open', allowed: true }, // not the GPU: ignored
    { id: -5, name: 'gpu', phase: 'weird', allowed: 'yes', bytesUp: 'a', reason: 'r'.repeat(1000) },
    5,
    null,
  ];
  const s = sessionSetup(t, { env: { FAKE_VM_SERVICE_EVENTS: JSON.stringify(events) } });
  await s.session.start();
  for (let i = 0; i < 100 && s.traffic.filter((e) => e.kind === 'gpu' && e.phase !== 'server').length < 5; i++) await wait(20);
  const rows = s.traffic.filter((e) => e.kind === 'gpu' && e.phase !== 'server');
  assert.equal(rows.length, 5);
  assert.deepEqual({ ...rows[0], ts: 0, preview: '' }, { ts: 0, dir: 'from-core', t: 'gpu', kind: 'gpu', appId: ID, id: 1, phase: 'connect', allowed: true, bytesUp: 0, bytesDown: 0, durationMs: 0, bytes: 0, preview: '' });
  assert.equal(rows[1].phase, 'traffic');
  assert.equal(rows[1].bytes, 5000120);
  assert.deepEqual([rows[2].phase, rows[2].reason, rows[2].bytesUp], ['disconnect', 'revoked', 9000000]);
  assert.match(rows[2].preview, /^disconnect gpu #1 up 9000000 down 480 \(revoked\)/);
  assert.equal(rows[3].allowed, false);
  assert.match(rows[3].preview, /^disconnect gpu #2 DENIED/);
  assert.deepEqual([rows[4].id, rows[4].phase, rows[4].allowed, rows[4].bytesUp, rows[4].reason.length], [0, 'traffic', false, 0, 300], 'only a boolean true counts; numbers are clamped');
});

test('buildVmArgs: services come after the network rules, and only as given', () => {
  const a = buildVmArgs({ kernel: 'k', initramfs: 'i', runtime: 'r', core: 'c', appdata: 'a', start: { command: ['x'] }, socket: 's', net: ['a.example.com:443'], services: ['gpu=127.0.0.1:51001'] });
  assert.deepEqual(a.slice(a.indexOf('--net')), ['--net', 'a.example.com:443', '--service', 'gpu=127.0.0.1:51001']);
  assert.ok(!buildVmArgs({ kernel: 'k', initramfs: 'i', runtime: 'r', core: 'c', appdata: 'a', start: { command: ['x'] }, socket: 's' }).includes('--service'));
  assert.deepEqual(startPayload({ command: ['x'], workdir: '/app', env: { A: '1' } }, { VMAPP_GPU_RPC: '127.0.0.1:50052' }).env, ['A=1', 'VMAPP_GPU_RPC=127.0.0.1:50052']);
  assert.deepEqual(startPayload({ command: ['x'], workdir: '/app', env: { A: '1' } }).env, ['A=1']);
  assert.equal(serviceArg(51001), 'gpu=127.0.0.1:51001');
});

// ------------------------------------------------------------------------------------------------ the monitor

test('monitor: a GPU pill when the user allowed it (manifest AND grant), pulsing on tunnels but not on the server starting', () => {
  const m = manifestOf([GPU]);
  const pills = (grants, manifest = m) => buildPills({ manifest, grants, used: {} }).map((p) => p.kind);
  assert.deepEqual(pills({ host: { gpu: { mode: 'session' } } }), ['gpu']);
  assert.deepEqual(pills({ host: {} }), []);
  assert.deepEqual(pills({ host: { gpu: { mode: 'session' } } }, manifestOf([{ cap: 'screen' }])), [], 'a grant for an app that did not ask shows nothing');
  assert.equal(pillOfEvent('traffic', { kind: 'gpu', t: 'gpu', phase: 'connect', allowed: true }), 'gpu');
  assert.equal(pillOfEvent('traffic', { kind: 'gpu', t: 'gpu', phase: 'traffic', allowed: true }), 'gpu');
  assert.equal(pillOfEvent('traffic', { kind: 'gpu', t: 'gpu', phase: 'disconnect', allowed: true }), 'gpu');
  assert.equal(pillOfEvent('traffic', { kind: 'gpu', t: 'gpu', phase: 'server', op: 'start', allowed: true }), null, 'the server starting is not use');
  assert.equal(pillOfEvent('traffic', { kind: 'gpu', t: 'gpu', phase: 'disconnect', allowed: false }), null, 'a refusal is not use');
});

// ------------------------------------------------------------------------------------------------ the loader’s sheet

function loadLibrary() {
  const handlers = {};
  const fake = {
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) },
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : orig.call(this, request, ...rest);
  };
  try {
    for (const f of ['library', 'window-manager']) delete require.cache[require.resolve(`../../loader/src/${f}`)];
    return { Library: require('../../loader/src/library').Library, handlers };
  } finally {
    Module._load = orig;
  }
}

test('sheet: the GPU is Don’t allow or Allow while the app runs; the renderer cannot send ask or always; nothing is saved on an error', (t) => {
  const { store } = storeWith(t, [GPU, { cap: 'screen', purpose: 's' }]);
  const { Library } = loadLibrary();
  const lib = new Library({ store, runner: { on() {}, state: () => 'stopped', isActive: () => false }, inspector: {}, nativeDialogs: {}, senders: new Map(), updates: {}, catalog: null, capabilities: null, log: () => {} });
  const a = store.get(ID);
  // what the sheet and the card show
  const sum = lib.hostSummary(a.manifest, ID);
  assert.deepEqual(sum.map((x) => [x.cap, x.risk, x.control, x.grant]), [['gpu', 'gpu', false, null], ['screen', 'screen', false, null]], 'starts on Don’t allow');
  // allowed
  assert.deepEqual(lib.normalizeHostChoices(a, { gpu: { mode: 'session' } }), { gpu: { mode: 'session' } });
  assert.deepEqual(lib.normalizeHostChoices(a, { gpu: { mode: 'none' } }), {}, 'none: no grant');
  assert.deepEqual(lib.normalizeHostChoices(a, {}), {});
  for (const mode of ['ask', 'always', 'allow', 'on', 'true']) assert.throws(() => lib.normalizeHostChoices(a, { gpu: { mode } }), /gpu|cannot be set/, mode);
  assert.deepEqual(lib.normalizeHostChoices(a, { gpu: { mode: 'session' }, screen: { mode: 'ask' } }), { gpu: { mode: 'session' }, screen: { mode: 'ask' } });
  // saving
  lib._saveSheet(a, {}, false, { gpu: { mode: 'session' } });
  assert.deepEqual(store.loadHostGrants(ID), { gpu: { mode: 'session' } });
  assert.throws(() => lib._saveSheet(a, {}, false, { gpu: { mode: 'ask' } }), /gpu/);
  assert.deepEqual(store.loadHostGrants(ID), { gpu: { mode: 'session' } }, 'a refused sheet changes nothing');
  lib._saveSheet(a, {}, false, { gpu: { mode: 'none' } });
  assert.deepEqual(store.loadHostGrants(ID), {}, 'Don’t allow takes the grant away');
});

test('card “GPU…”: lib:saveGpu saves the choice; taking it away stops a running app’s helper at once; allowing needs the next launch', async (t) => {
  const { store } = storeWith(t, [GPU]);
  const { Library, handlers } = loadLibrary();
  const revoked = [];
  const run = { state: 'stopped', session: null };
  const runner = {
    on() {},
    state: () => run.state,
    isActive: () => run.state !== 'stopped',
    sessionOf: () => run.session,
  };
  const lib = new Library({ store, runner, inspector: {}, nativeDialogs: {}, senders: new Map([[1, 'library']]), updates: {}, catalog: null, capabilities: null, log: () => {} });
  const ipcRaw = (ch, ...args) => handlers[ch]({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'f' }, ...args);
  const ipc = async (ch, ...args) => {
    const x = await ipcRaw(ch, ...args);
    return x.ok === true ? x.result : x; // the IPC wrapper: {ok:true, result} or {ok:false, error}
  };
  // stopped: just saved
  let r = await ipc('lib:saveGpu', ID, 'session');
  assert.deepEqual(r, { gpu: 'allowed', running: false, appliesNow: false });
  assert.deepEqual(store.loadHostGrants(ID), { gpu: { mode: 'session' } });
  r = await ipc('lib:saveGpu', ID, 'none');
  assert.deepEqual(r, { gpu: 'revoked', running: false, appliesNow: false });
  assert.deepEqual(store.loadHostGrants(ID), {});
  // running, allowed in the meantime by the CLI: taking it away calls revokeGpu on the session
  store.setHostGrant(ID, 'gpu', { mode: 'session' });
  run.state = 'running';
  run.session = { revokeGpu: async (why) => (revoked.push(why), true) };
  r = await ipc('lib:saveGpu', ID, 'none');
  assert.deepEqual(r, { gpu: 'revoked', running: true, appliesNow: true });
  assert.deepEqual(revoked, ['revoked']);
  assert.deepEqual(store.loadHostGrants(ID), {});
  // running: allowing is saved, and does not touch the session (its VM has no service until the next launch)
  r = await ipc('lib:saveGpu', ID, 'session');
  assert.deepEqual(r, { gpu: 'allowed', running: true, appliesNow: false });
  assert.deepEqual(revoked, ['revoked']);
  // refused: unknown modes (the renderer is not trusted), a changing state, an app that did not ask
  for (const bad of ['ask', 'always', 'allow', 'on', '', null, 5, { mode: 'session' }]) {
    r = await ipc('lib:saveGpu', ID, bad);
    assert.equal(r.ok, false, String(bad));
  }
  for (const state of ['starting', 'stopping']) {
    run.state = state;
    r = await ipc('lib:saveGpu', ID, 'none');
    assert.match(r.error, /starting|stopping/);
  }
  assert.deepEqual(store.loadHostGrants(ID), { gpu: { mode: 'session' } }, 'none of the refusals changed anything');
  // only the library window, and only its main frame
  assert.deepEqual(await handlers['lib:saveGpu']({ sender: { id: 99, mainFrame: 'f' }, senderFrame: 'f' }, ID, 'none'), { ok: false, error: 'denied' });
  assert.deepEqual(await handlers['lib:saveGpu']({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'other' }, ID, 'none'), { ok: false, error: 'denied' });
  // an app that does not ask for the GPU
  const other = storeWith(t, [{ cap: 'screen', purpose: 's' }]);
  const lib2 = new Library({ store: other.store, runner, inspector: {}, nativeDialogs: {}, senders: new Map(), updates: {}, catalog: null, capabilities: null, log: () => {} });
  run.state = 'stopped';
  await assert.rejects(lib2.saveGpu(other.store.get(ID), 'session'), /does not ask to use the GPU/);
  assert.deepEqual(other.store.loadHostGrants(ID), {});
});

// ------------------------------------------------------------------------------------------------ the CLI

function vmapp(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: grant-host <id> gpu --mode session, --list, --revoke; ask and always are refused; inspect says what the app asks', (t) => {
  const d = tmpdir('gpucli-');
  t.after(() => rmrf(d));
  const env = { VMAPP_HOME: path.join(d, 'home') };
  fs.mkdirSync(path.join(env.VMAPP_HOME, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(env.VMAPP_HOME, 'runtimes', 'node22.img'), 'img');
  const proj = path.join(d, 'proj');
  makeProject(proj, { manifest: { permissions: { folders: [], dialogs: false, external: false, host: [GPU] } } });
  const file = path.join(d, 'a.vmapp');
  assert.equal(vmapp(env, 'pack', proj, '-o', file).code, 0);
  const inspect = vmapp(env, 'inspect', file);
  assert.equal(inspect.code, 0, inspect.err);
  assert.match(inspect.out, /host gpu: Runs the language model on the GPU/);
  assert.match(inspect.out, /GPU, through a sandboxed helper \(off until you allow it\)/);
  assert.doesNotMatch(inspect.out, /requests control of your computer/, 'the GPU is not control of the computer');
  assert.equal(vmapp(env, 'install', file).code, 0);

  let r = vmapp(env, 'grant-host', ID, '--list');
  assert.match(r.out, /^gpu  \[gpu\]  not granted  - Runs the language model on the GPU/m);
  r = vmapp(env, 'grant-host', ID, 'gpu', '--mode', 'ask');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /only be allowed while the app runs/);
  r = vmapp(env, 'grant-host', ID, 'gpu', '--mode', 'always');
  assert.notEqual(r.code, 0);
  r = vmapp(env, 'grant-host', ID, 'gpu', '--mode', 'session');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /granted gpu to com\.example\.notes: session/);
  assert.match(r.out, /on every run, until you revoke it/);
  assert.doesNotMatch(r.out, /next run only/);
  r = vmapp(env, 'grant-host', ID, '--list');
  assert.match(r.out, /^gpu  \[gpu\]  session  - /m);
  // no --mode: the only mode there is
  assert.equal(vmapp(env, 'grant-host', ID, 'gpu', '--revoke').code, 0);
  r = vmapp(env, 'grant-host', ID, 'gpu');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /granted gpu .*: session/);
  r = vmapp(env, 'grant-host', ID, 'gpu', '--revoke');
  assert.match(r.out, /revoked gpu/);
  assert.match(vmapp(env, 'grant-host', ID, '--list').out, /not granted/);
  // an app that does not ask cannot be granted it
  r = vmapp(env, 'grant-host', ID, 'screen', '--mode', 'ask');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /does not request/);
});
