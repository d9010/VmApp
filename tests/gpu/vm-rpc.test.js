'use strict';
// REAL end to end (SPEC 8.6): an app in a real VM, the GPU capability granted by the CLI exactly as a user would, the loader's own
// code starting the sandboxed Metal rpc-server, and the app speaking llama.cpp's RPC protocol to it through 127.0.0.1:50052 (HELLO,
// DEVICE_COUNT, GET_DEVICE_MEMORY, then a few hundred round trips for latency). Checks the whole chain:
//   manifest cap -> grant -> AppSession -> GpuBroker -> sandbox-exec rpc-server (Metal) -> vmapp-vm --service -> guest listener
//   -> $VMAPP_GPU_RPC -> the app
// and the denied paths: no grant (no variable, port closed), revoke while running (the tunnel dies, the port closes, the server is
// gone), and no server left behind after the app stops.
//
//   node --test tests/gpu/vm-rpc.test.js
//
// Needs out/ (vmapp-vm, Image, initramfs.cpio, runtimes/node22.img) and out/gpu/rpc-server (gpu/build.sh); VMAPP_VM, VMAPP_KERNEL and
// VMAPP_INITRAMFS point it at other builds. Skipped when something is missing, off Apple silicon, or VMAPP_NO_REALVM=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out');
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(OUT, 'work'));
const SCRATCH = path.join(WORK, 'scratch', 'gpu-vm');
const CLI = path.join(ROOT, 'tools', 'vmapp');
const ID = 'dev.vmapp.gpu-test';
const need = [
  process.env.VMAPP_VM || path.join(OUT, 'vmapp-vm'),
  process.env.VMAPP_KERNEL || path.join(OUT, 'Image'),
  process.env.VMAPP_INITRAMFS || path.join(OUT, 'initramfs.cpio'),
  path.join(OUT, 'runtimes', 'node22.img'),
  process.env.VMAPP_GPU_SERVER || path.join(OUT, 'gpu', 'rpc-server'),
];
const missing = need.filter((f) => !fs.existsSync(f));
const skip =
  process.env.VMAPP_NO_REALVM === '1' ? 'VMAPP_NO_REALVM=1'
  : process.platform !== 'darwin' || process.arch !== 'arm64' ? 'needs an Apple-silicon Mac'
  : missing.length ? `missing ${missing.map((f) => path.relative(ROOT, f)).join(', ')}`
  : false;

function cli(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** Processes of GPU servers on this port (the test's run knows its server's port from the CLI's output). */
const serversOn = (port) => spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes('rpc-server') && l.includes(`--port ${port}`));
const portOf = (out) => Number((/GPU server start on 127\.0\.0\.1:(\d+)/.exec(out) || [])[1]);

test('real VM: the app reaches the sandboxed Metal server only when the user allowed the GPU; revoke cuts it off', { skip, timeout: 600000 }, async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const d = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const env = { VMAPP_HOME: path.join(d, 'home') };
  const ok = (r, what) => assert.equal(r.code, 0, `${what}: ${r.err || r.out}`);
  const pkg = path.join(d, 'gpu-test.vmapp');
  ok(cli(env, 'pack', path.join(__dirname, 'fixtures', 'gpu-app'), '-o', pkg), 'pack');
  ok(cli(env, 'runtime-install', 'node22', path.join(OUT, 'runtimes', 'node22.img')), 'runtime-install');
  ok(cli(env, 'install', pkg), 'install');
  const script = path.join(__dirname, 'fixtures', 'gpu-script.mjs');
  const result = (r) => {
    const line = r.out.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `no RESULT line:\n${r.out}\n${r.err}`);
    return JSON.parse(line.slice(7));
  };

  // 1. not allowed (the default): no variable, the port is closed, no server was started
  let r = cli(env, 'run', ID, '--headless', '--script', script);
  assert.equal(r.code, 0, r.out + r.err);
  let res = result(r);
  assert.deepEqual(res.env, { gpu: null }, 'no VMAPP_GPU_RPC without the grant');
  assert.equal(res.first.ok, false);
  assert.match(res.first.error, /VMAPP_GPU_RPC is not set/);
  assert.doesNotMatch(r.out, /\[gpu\] GPU server start/, 'no server was started');
  assert.match(r.out, /GPU requested but not allowed/);

  // 2. allowed while the app runs: the app talks RPC to the real server
  ok(cli(env, 'grant-host', ID, 'gpu', '--mode', 'session'), 'grant gpu');
  r = cli(env, 'run', ID, '--headless', '--script', script);
  assert.equal(r.code, 0, r.out + r.err);
  res = result(r);
  assert.deepEqual(res.env, { gpu: '127.0.0.1:50052' });
  assert.equal(res.first.ok, true, JSON.stringify(res.first));
  const pins = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'gpu', 'pins.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')));
  assert.equal(res.first.proto, pins.RPC_PROTO_VERSION, 'the server speaks the protocol version of gpu/pins.env');
  assert.ok(res.first.devices >= 1, `devices: ${res.first.devices}`);
  assert.ok(res.first.totalMiB > 1024, `the Metal device reports ${res.first.totalMiB} MiB`);
  assert.ok(res.first.avgRoundTripUs > 0 && res.first.avgRoundTripUs < 20000, `round trip ${res.first.avgRoundTripUs} us`);
  console.log(`  info: VM -> tunnel -> sandboxed Metal server: RPC ${res.first.proto}, ${res.first.devices} device(s), ${res.first.totalMiB} MiB, ${res.first.rounds} round trips at ${res.first.avgRoundTripUs} µs each`);
  assert.match(r.out, /\[gpu\] GPU server start on 127\.0\.0\.1:\d+/);
  assert.match(r.out, /\[gpu\] connect gpu #\d+/);
  assert.match(r.out, /\[gpu\] disconnect gpu #\d+ up \d+ down \d+/);
  const down = /disconnect gpu #\d+ up (\d+) down (\d+)/.exec(r.out);
  assert.ok(Number(down[1]) > 0 && Number(down[2]) > 0, 'the Inspector rows count the bytes');
  assert.match(r.out, /\[gpu\] GPU server stop \(app-stopped\)/);
  assert.deepEqual(serversOn(portOf(r.out)), [], 'no server is left behind after the app stopped');

  // 3. revoked while the app runs: the tunnel and the port are cut off within a couple of seconds, the app keeps running
  r = cli({ ...env, GPU_TEST_REVOKE: '1' }, 'run', ID, '--headless', '--script', script);
  assert.equal(r.code, 0, r.out + r.err);
  res = result(r);
  assert.equal(res.first.ok, true);
  assert.ok(res.afterRevoke && res.afterRevoke.ok === false, `still reachable after the revoke: ${JSON.stringify(res.stillOk)}`);
  assert.match(res.afterRevoke.error, /connect: ECONNREFUSED|closed|reset/i);
  assert.ok(res.revokedAfterMs < 5000, `took ${res.revokedAfterMs} ms`);
  assert.equal(res.again.ok, false, 'and it stays off');
  assert.equal(res.running, 'running', 'the app itself was not stopped');
  assert.match(r.out, /the GPU grant was taken away/);
  assert.match(r.out, /\[gpu\] GPU server stop \(revoked\)/);
  assert.deepEqual(serversOn(portOf(r.out)), [], 'no server is left behind after the revoke');
  // the grant is gone: the next run is back to Don't allow
  r = cli(env, 'run', ID, '--headless', '--script', script);
  assert.deepEqual(result(r).env, { gpu: null });
});
