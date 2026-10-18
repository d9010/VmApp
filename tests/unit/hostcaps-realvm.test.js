'use strict';
// REAL-VM integration test (headless): a node22 app inside a real Apple-Virtualization VM calls the SDK's host.*
// through the bridge. The host side is real (CLI, session, broker, /bin/echo); only vmapp-hostctl is a fake script and
// input is a dry run, so nothing touches the desktop. Skipped when out/ (vmapp-vm, kernel, initramfs, node22 runtime)
// is missing or VMAPP_NO_REALVM=1. Needs the node22 runtime rebuilt after the SDK got `host`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir, rmrf } = require('./helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out');
const CLI = path.join(ROOT, 'tools', 'vmapp');
const need = [path.join(OUT, 'vmapp-vm'), path.join(OUT, 'Image'), path.join(OUT, 'initramfs.cpio'), path.join(OUT, 'runtimes', 'node22.img')];
const missing = need.filter((f) => !fs.existsSync(f));
const skip = process.env.VMAPP_NO_REALVM === '1' ? 'VMAPP_NO_REALVM=1' : missing.length ? `missing ${missing.map((f) => path.relative(ROOT, f)).join(', ')}` : false;

const FAKE_CTL = path.join(__dirname, 'fixtures', 'fake-hostctl.js');
const ID = 'dev.vmapp.hostcaps';

function cli(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('real VM: host.tool.run, host.input (dry run) and host.screen.capture (fake hostctl) through the SDK', { skip, timeout: 240000 }, (t) => {
  const d = tmpdir('realvm-');
  t.after(() => rmrf(d));
  const home = path.join(d, 'home');
  const ctlLog = path.join(d, 'ctl.log');
  const env = {
    VMAPP_HOME: home,
    VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_CTL]),
    VMAPP_HOSTCTL_DRYRUN: '1',
    FAKE_HOSTCTL_LOG: ctlLog,
  };
  const ok = (r, what) => assert.equal(r.code, 0, `${what}: ${r.err || r.out}`);
  const pkgFile = path.join(d, 'hostcaps.vmapp');
  ok(cli(env, 'pack', path.join(__dirname, 'fixtures', 'hostcaps-app'), '-o', pkgFile), 'pack');
  ok(cli(env, 'runtime-install', 'node22', path.join(OUT, 'runtimes', 'node22.img')), 'runtime-install');
  ok(cli(env, 'install', pkgFile), 'install');
  ok(cli(env, 'tool', 'add', 'echo', '--name', 'Echo', '--path', '/bin/echo', '--arg', '^[\\s\\S]{0,200}$', '--variadic'), 'tool add');
  ok(cli(env, 'grant-host', ID, 'screen', '--mode', 'always'), 'grant screen');
  ok(cli(env, 'grant-host', ID, 'input', '--mode', 'ask'), 'grant input');
  ok(cli(env, 'grant-host', ID, 'tool:echo', '--mode', 'always'), 'grant tool');
  const script = path.join(__dirname, 'fixtures', 'hostcaps-script.mjs');

  const result = (r) => {
    const line = r.out.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `no RESULT line:\n${r.out}\n${r.err}`);
    return JSON.parse(line.slice(7));
  };

  // 1. the user allows the input question (--allow-host)
  let r = cli(env, 'run', ID, '--headless', '--script', script, '--allow-host');
  assert.equal(r.code, 0, r.out + r.err);
  let { r: res, confirms, badges } = result(r);
  assert.equal(res.echo.ok, true, JSON.stringify(res.echo));
  assert.equal(res.echo.value.stdout, 'hi;rm -rf /\n');
  assert.equal(res.echo.value.exitCode, 0);
  assert.equal(res.echoDollar.value.stdout, '$(touch /tmp/pwned) `id`\n');
  assert.ok(!fs.existsSync('/tmp/pwned'));
  assert.equal(res.echoBad.ok, false);
  assert.deepEqual(res.list.value.map((x) => x.id), ['echo']);
  assert.ok(!JSON.stringify(res.list.value).includes('/bin/echo'));
  assert.equal(res.cat.ok, false); // not requested in the manifest
  assert.match(res.cat.error, /permission denied/);
  assert.equal(res.windows.value[0].title, 'Fake window');
  assert.equal(res.capture.value.isBuffer, true);
  assert.equal(res.capture.value.magic, 'PNG');
  assert.equal(res.capture.value.width, 320);
  assert.ok(res.capture.value.bytes > 20);
  assert.equal(res.input.ok, true, JSON.stringify(res.input));
  assert.match(res.input.value.afterStop, /no such input session/);
  assert.equal(res.mcp.ok, false);
  assert.match(res.mcp.error, /permission denied/);
  assert.deepEqual(confirms, ['input']);
  assert.deepEqual(badges, ['input:on', 'input:off']);
  const ops = fs.readFileSync(ctlLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ops.some((o) => o.op === 'capture' && o.args.maxWidth === 320));
  assert.deepEqual(ops.filter((o) => o.op === 'mouse' || o.op === 'keys').map((o) => o.args), [
    { action: 'click', x: 10, y: 20, dryRun: true },
    { text: 'typed text', dryRun: true },
    { key: 'return', dryRun: true },
  ]);
  assert.match(r.out, /\[host\] host\.tool\.run tool:echo allowed/);

  // 2. the user declines (no --allow-host): input is denied, the always-granted capabilities still work
  r = cli(env, 'run', ID, '--headless', '--script', script);
  assert.equal(r.code, 0, r.out + r.err);
  ({ r: res, confirms, badges } = result(r));
  assert.equal(res.echo.value.stdout, 'hi;rm -rf /\n');
  assert.equal(res.capture.ok, true);
  assert.equal(res.input.ok, false);
  assert.match(res.input.error, /declined by the user/);
  assert.deepEqual(badges, []);

  // 3. no grants at all: everything is denied by default
  ok(cli(env, 'grant-host', ID, 'screen', '--revoke'), 'revoke screen');
  ok(cli(env, 'grant-host', ID, 'input', '--revoke'), 'revoke input');
  ok(cli(env, 'grant-host', ID, 'tool:echo', '--revoke'), 'revoke tool');
  r = cli(env, 'run', ID, '--headless', '--script', script, '--allow-host');
  ({ r: res } = result(r));
  for (const k of ['echo', 'echoDollar', 'list', 'windows', 'capture', 'input']) {
    assert.equal(res[k].ok, false, k);
    assert.match(res[k].error, /permission denied/, k);
  }
});
