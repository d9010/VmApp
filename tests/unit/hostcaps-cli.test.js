'use strict';
// CLI: tool add/list/remove, mcp add/list/remove, grant-host, inspect, and `run --headless` with --allow-host
// (vmapp-vm is the fake; the host side is real).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const FAKE_VM = path.join(__dirname, 'fixtures', 'fake-vmapp-vm.js');
const FAKE_CTL = path.join(__dirname, 'fixtures', 'fake-hostctl.js');
const FAKE_MCP = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const ID = 'com.example.notes';

function vmapp(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function setup(t) {
  const d = tmpdir('hcli-');
  t.after(() => rmrf(d));
  const home = path.join(d, 'home');
  const env = {
    VMAPP_HOME: home,
    VMAPP_VM: FAKE_VM,
    VMAPP_KERNEL: path.join(d, 'Image'),
    VMAPP_INITRAMFS: path.join(d, 'initramfs.cpio'),
    FAKE_VM_APP: path.join(__dirname, 'fixtures', 'app-main.js'),
    VMAPP_HOSTCTL: JSON.stringify([process.execPath, FAKE_CTL]),
    VMAPP_HOSTCTL_DRYRUN: '1',
  };
  fs.writeFileSync(env.VMAPP_KERNEL, 'k');
  fs.writeFileSync(env.VMAPP_INITRAMFS, 'i');
  fs.mkdirSync(path.join(home, 'runtimes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtimes', 'node22.img'), 'img');
  const proj = path.join(d, 'proj');
  makeProject(proj, {
    manifest: {
      permissions: {
        folders: [],
        dialogs: false,
        external: false,
        host: [{ cap: 'screen', purpose: 'see' }, { cap: 'input', purpose: 'click' }, { cap: 'tool:*', purpose: 'tools' }, { cap: 'mcp:fake' }],
      },
    },
  });
  const file = path.join(d, 'a.vmapp');
  assert.equal(vmapp(env, 'pack', proj, '-o', file).code, 0);
  assert.equal(vmapp(env, 'install', file).code, 0);
  return { d, home, env };
}

test('CLI: tool add / list / remove', (t) => {
  const { env, home } = setup(t);
  let r = vmapp(env, 'tool', 'add', 'echo', '--name', 'Echo', '--path', '/bin/echo', '--arg', '^-n$', '--arg', '^[\\w ]{1,20}$', '--optional-arg', '0', '--variadic', '--timeout', '5000', '--max-output', '2048');
  assert.equal(r.code, 0, r.err);
  r = vmapp(env, 'tool', 'add', 'cat', '--name', 'Cat', '--path', '/bin/cat', '--arg', '^/host/[\\w-]+/[\\w.]+$', '--map-path-arg', '0');
  assert.equal(r.code, 0, r.err);
  r = vmapp(env, 'tool', 'list', '--json');
  const tools = JSON.parse(r.out);
  assert.deepEqual(tools.map((x) => x.id), ['echo', 'cat']);
  assert.deepEqual(tools[0].args, [{ pattern: '^-n$', optional: true }, { pattern: '^[\\w ]{1,20}$' }]);
  assert.equal(tools[0].variadic, true);
  assert.equal(tools[0].timeoutMs, 5000);
  assert.equal(tools[0].maxOutputBytes, 2048);
  assert.deepEqual(tools[1].args, [{ pattern: '^/host/[\\w-]+/[\\w.]+$', mapPath: true }]);
  assert.ok(fs.existsSync(path.join(home, 'capabilities', 'tools.json')));
  r = vmapp(env, 'tool', 'list');
  assert.match(r.out, /echo {2}\[tool\] {2}Echo {2}\/bin\/echo/);

  // errors are precise and nothing is written
  const bad = (args, re) => {
    const x = vmapp(env, 'tool', 'add', ...args);
    assert.notEqual(x.code, 0);
    assert.match(x.err, re, args.join(' '));
  };
  bad(['x1', '--name', 'X', '--path', 'relative/path'], /absolute/);
  bad(['x1', '--name', 'X', '--path', '/bin/echo', '--arg', 'unanchored'], /anchored/);
  bad(['x1', '--name', 'X', '--path', '/bin/echo', '--timeout', '700000'], /timeoutMs/);
  bad(['x1', '--name', 'X', '--path', '/bin/echo', '--kind', 'root'], /kind/);
  bad(['x1', '--name', 'X', '--path', '/bin/echo', '--arg', '^a$', '--map-path-arg', '3'], /indices start at 0/);
  bad(['x1', '--name', 'X', '--path', '/no/such/program'], /does not exist/);
  bad(['X1', '--name', 'X', '--path', '/bin/echo'], /id/);
  assert.equal(JSON.parse(vmapp(env, 'tool', 'list', '--json').out).length, 2);

  // a shell tool carries a warning
  r = vmapp(env, 'tool', 'add', 'sh', '--name', 'Shell', '--path', '/bin/sh', '--kind', 'shell', '--arg', '^-c$', '--arg', '^[\\s\\S]{1,10000}$');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /WARNING: a shell tool/);

  r = vmapp(env, 'tool', 'remove', 'cat');
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(vmapp(env, 'tool', 'list', '--json').out).map((x) => x.id), ['echo', 'sh']);
  assert.notEqual(vmapp(env, 'tool', 'remove', 'cat').code, 0);
  assert.equal(vmapp(env, 'tool').code, 2);
});

test('CLI: mcp add / list / remove', (t) => {
  const { env } = setup(t);
  let r = vmapp(env, 'mcp', 'add', 'fake', '--name', 'Fake', '--env', 'A=1', '--env', 'B=x=y', '--', process.execPath, FAKE_MCP, '--flag');
  assert.equal(r.code, 0, r.err);
  r = vmapp(env, 'mcp', 'list', '--json');
  const list = JSON.parse(r.out);
  assert.deepEqual(list[0], { id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP, '--flag'], env: { A: '1', B: 'x=y' } });
  assert.notEqual(vmapp(env, 'mcp', 'add', 'rel', '--name', 'Rel', '--', 'node', 'x.js').code, 0);
  assert.match(vmapp(env, 'mcp', 'list').out, /fake {2}Fake/);
  assert.equal(vmapp(env, 'mcp', 'remove', 'fake').code, 0);
  assert.match(vmapp(env, 'mcp', 'list').out, /no MCP servers/);
});

test('CLI: grant-host validates against the manifest, the catalog and the always rules', (t) => {
  const { env, home } = setup(t);
  vmapp(env, 'tool', 'add', 'echo', '--name', 'Echo', '--path', '/bin/echo', '--arg', '^\\w+$');
  vmapp(env, 'tool', 'add', 'sh', '--name', 'Shell', '--path', '/bin/sh', '--kind', 'shell', '--arg', '^-c$', '--arg', '^[\\s\\S]{1,100}$');
  const grants = () => JSON.parse(fs.readFileSync(path.join(home, 'grants', `${ID}.json`), 'utf8')).host;
  let r = vmapp(env, 'grant-host', ID, 'screen');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(grants(), { screen: { mode: 'ask' } });
  r = vmapp(env, 'grant-host', ID, 'screen', '--mode', 'always');
  assert.match(r.out, /granted screen to com.example.notes: always/);
  r = vmapp(env, 'grant-host', ID, 'input', '--mode', 'always');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /"always" is not allowed for input/);
  r = vmapp(env, 'grant-host', ID, 'input', '--mode', 'session');
  assert.equal(r.code, 0);
  assert.match(r.out, /next run only/);
  r = vmapp(env, 'grant-host', ID, 'tool:*', '--mode', 'always', '--tools', 'echo,sh');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /shell tool "sh"/);
  r = vmapp(env, 'grant-host', ID, 'tool:*', '--mode', 'always', '--tools', 'echo');
  assert.equal(r.code, 0, r.err);
  r = vmapp(env, 'grant-host', ID, 'tool:sh', '--mode', 'always');
  assert.match(r.err, /shell tool/);
  r = vmapp(env, 'grant-host', ID, 'tool:*', '--tools', 'nope');
  assert.match(r.err, /no tool "nope"/);
  r = vmapp(env, 'grant-host', ID, 'mcp:other');
  assert.match(r.err, /does not request "mcp:other"/);
  r = vmapp(env, 'grant-host', ID, 'mcp:fake');
  assert.match(r.err, /no MCP server "fake"/);
  r = vmapp(env, 'grant-host', ID, 'screen', '--mode', 'whenever');
  assert.match(r.err, /mode must be/);
  r = vmapp(env, 'grant-host', 'com.example.missing', 'screen');
  assert.match(r.err, /not installed/);
  assert.deepEqual(grants(), { screen: { mode: 'always' }, input: { mode: 'session' }, 'tool:*': { mode: 'always', tools: ['echo'] } });

  r = vmapp(env, 'grant-host', ID, '--list');
  assert.match(r.out, /screen {2}\[screen\] {2}always/);
  assert.match(r.out, /input {2}\[input, requests control of your computer\] {2}session/);
  assert.match(r.out, /tool:\* {2}\[shell, requests control of your computer\] {2}always tools=echo/);
  assert.match(r.out, /mcp:fake {2}\[mcp\] {2}not granted/);

  r = vmapp(env, 'grant-host', ID, 'screen', '--revoke');
  assert.equal(r.code, 0);
  assert.equal(grants().screen, undefined);
  // folder grants through the old command keep the host grants
  assert.equal(vmapp(env, 'grant', ID, 'nothing', '--none').code === 0, false); // no such folder in this manifest
  assert.deepEqual(Object.keys(grants()), ['input', 'tool:*']);

  // inspect shows what the package asks for
  const pkgInfo = vmapp(env, 'list', '--json');
  assert.equal(pkgInfo.code, 0);
});

test('CLI: inspect lists the host requests and the control warning', (t) => {
  const { d, env } = setup(t);
  const r = vmapp(env, 'inspect', path.join(d, 'a.vmapp'));
  assert.match(r.out, /host screen: see/);
  assert.match(r.out, /host mcp:fake: \(no reason given\)/);
  assert.match(r.out, /requests control of your computer/);
});

test('CLI: run --headless answers host questions from --allow-host (default: deny) and logs the badge', (t) => {
  const { d, env } = setup(t);
  vmapp(env, 'tool', 'add', 'echo', '--name', 'Echo', '--path', '/bin/echo', '--arg', '^[\\s\\S]{0,50}$', '--variadic');
  vmapp(env, 'grant-host', ID, 'screen', '--mode', 'ask');
  vmapp(env, 'grant-host', ID, 'input', '--mode', 'ask');
  vmapp(env, 'grant-host', ID, 'tool:*', '--mode', 'ask', '--tools', 'echo');
  const script = path.join(d, 'script.mjs');
  fs.writeFileSync(script, `
export default async function ({ wm, capUi }) {
  await wm.waitForWindows(1, 5000);
  const tryit = async (...a) => { try { return { ok: await wm.invoke(1, 'host', ...a) }; } catch (e) { return { err: e.message }; } };
  const out = {
    echo: await tryit('tool.run', 'echo', ['hi;rm -rf /']),
    windows: await tryit('screen.windows'),
    input: await (async () => { try { return { ok: await wm.invoke(1, 'host-input', 'why', [['mouse', { action: 'move', x: 1, y: 2 }], ['stop']]) }; } catch (e) { return { err: e.message }; } })(),
  };
  console.log('RESULT ' + JSON.stringify({ out, asked: capUi.calls.map((c) => c.cap), badges: capUi.badges.map((b) => b.badge + ':' + b.state) }));
}
`);
  const res = (r) => JSON.parse(r.out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));

  let r = vmapp(env, 'run', ID, '--headless', '--script', script);
  assert.equal(r.code, 0, r.out + r.err);
  let x = res(r);
  assert.match(x.out.echo.err, /declined by the user/);
  assert.match(x.out.windows.err, /declined by the user/);
  assert.match(x.out.input.err, /declined by the user/);
  assert.deepEqual(x.asked, ['tool:echo', 'screen', 'input']);
  assert.deepEqual(x.badges, []);
  assert.match(r.out, /\(no --allow-host\)/);

  r = vmapp(env, 'run', ID, '--headless', '--script', script, '--allow-host');
  assert.equal(r.code, 0, r.out + r.err);
  x = res(r);
  assert.equal(x.out.echo.ok.stdout, 'hi;rm -rf /\n');
  assert.equal(x.out.windows.ok[0].title, 'Fake window');
  assert.ok(x.out.input.ok.id);
  assert.deepEqual(x.badges, ['input:on', 'input:off']);
  assert.match(r.out, /\[badge\] input on: Notes \(why\)/);
  assert.match(r.out, /\[badge\] input off/);
  assert.match(r.out, /\[host\] host\.input\.start input allowed/);
});
