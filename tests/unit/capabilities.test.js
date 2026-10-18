'use strict';
// Host capabilities (SPEC 8.2, INV-H1..H5): manifest, catalog, grants and the broker, with a fake vmapp-hostctl
// (nothing touches the desktop) and a tiny fake MCP server. Tools are /bin/echo, /bin/cat, /bin/sleep, /bin/sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateManifest, ManifestError } = require('../../hostlib/manifest');
const { Store, StoreError } = require('../../hostlib/store');
const { Catalog, CatalogError, HostCapabilities, validateTool, validateMcp, matchArgs, checkHostGrant, setHostGrant, hostRequestSummary } = require('../../hostlib/capabilities');
const { HostCtl } = require('../../hostlib/hostproc');
const { resolveShare } = require('../../hostlib/session');
const { FakeCapabilitiesUi } = require('../../hostlib/headless');
const { tmpdir, rmrf, wait } = require('./helpers');

const FAKE_CTL = path.join(__dirname, 'fixtures', 'fake-hostctl.js');
const FAKE_MCP = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

const BASE = { format: 1, id: 'com.example.agent', name: 'Agent', version: '1.0.0', runtime: 'node22', core: { command: ['node', 'main.js'] } };
const manifestWith = (host) => validateManifest({ ...BASE, permissions: host === undefined ? {} : { host } }, { files: 'forbidden' });

// ------------------------------------------------------------------------------------------------ manifest

test('manifest: permissions.host is optional and absent from the normalised form when empty', () => {
  const m = manifestWith(undefined);
  assert.equal('host' in m.permissions, false);
  const m2 = manifestWith([{ cap: 'screen', purpose: 'Reads the screen' }, { cap: 'tool:*' }, { cap: 'mcp:vscode' }]);
  assert.deepEqual(m2.permissions.host, [{ cap: 'screen', purpose: 'Reads the screen' }, { cap: 'tool:*', purpose: '' }, { cap: 'mcp:vscode', purpose: '' }]);
});

test('manifest: permissions.host is strict', () => {
  const bad = (host, re) => assert.throws(() => manifestWith(host), (e) => e instanceof ManifestError && re.test(e.message), JSON.stringify(host));
  bad('screen', /must be an array/);
  bad(Array.from({ length: 9 }, (_, i) => ({ cap: `tool:t${i}` })), /at most 8/);
  bad([{ cap: 'keyboard' }], /cap/);
  bad([{ cap: 'tool:' }], /cap/);
  bad([{ cap: 'tool:Bad' }], /cap/);
  bad([{ cap: `tool:${'a'.repeat(42)}` }], /cap/);
  bad([{ cap: 'screen:*' }], /cap/);
  bad([{ cap: 'screen' }, { cap: 'screen' }], /not unique/);
  bad([{ cap: 'screen', purpose: 'x'.repeat(201) }], /at most 200/);
  bad([{ cap: 'screen', path: '/bin/sh' }], /not a known key/);
  bad([{ purpose: 'no cap' }], /cap/);
  bad(['screen'], /must be an object/);
  assert.doesNotThrow(() => manifestWith([{ cap: `tool:${'a'.repeat(41)}` }]));
});

// ------------------------------------------------------------------------------------------------ catalog

const echoTool = (extra) => ({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^[\\s\\S]{0,200}$' }], variadic: true, ...extra });

test('catalog: tool definitions are validated', () => {
  const ok = validateTool(echoTool());
  assert.equal(ok.kind, 'tool');
  assert.equal(ok.timeoutMs, 30000);
  assert.equal(ok.maxOutputBytes, 1048576);
  const bad = (def, re) => assert.throws(() => validateTool(def), (e) => e instanceof CatalogError && re.test(e.message), JSON.stringify(def));
  bad(echoTool({ id: 'Echo' }), /id/);
  bad(echoTool({ path: 'echo' }), /absolute/);
  bad(echoTool({ path: '/bin/does-not-exist-x' }), /does not exist/);
  bad(echoTool({ path: '/etc/hosts' }), /not executable/);
  bad(echoTool({ path: '/bin' }), /not a file/);
  bad(echoTool({ timeoutMs: 600001 }), /timeoutMs/);
  bad(echoTool({ maxOutputBytes: 16 * 1024 * 1024 + 1 }), /maxOutputBytes/);
  bad(echoTool({ kind: 'root' }), /kind/);
  bad(echoTool({ cwd: 'relative' }), /cwd/);
  bad(echoTool({ extra: 1 }), /not a known key/);
  bad(echoTool({ args: [{ pattern: 'x$' }] }), /start with \^/);
  bad(echoTool({ args: [{ pattern: '^x' }] }), /end with \$/);
  bad(echoTool({ args: [{ pattern: '^x\\$' }] }), /end with \$/);
  bad(echoTool({ args: [{ pattern: '^(x$' }] }), /regular expression/);
  bad(echoTool({ args: [{ pattern: '^x$', mapPath: 'yes' }] }), /mapPath/);
  bad(echoTool({ args: [{ pattern: '^x$', other: 1 }] }), /not a known key/);
  bad(echoTool({ args: [], variadic: true }), /variadic/);
  bad(echoTool({ args: Array.from({ length: 33 }, () => ({ pattern: '^x$' })) }), /at most 32/);
  assert.doesNotThrow(() => validateTool(echoTool({ args: [{ pattern: '^x\\\\$' }] }))); // an escaped backslash, then the anchor
  assert.doesNotThrow(() => validateTool({ ...echoTool(), path: '/nonexistent/later' }, { checkFs: false }));
});

test('catalog: a top-level alternation cannot match part of an argument', () => {
  const def = validateTool(echoTool({ args: [{ pattern: '^a|b$' }], variadic: false }));
  assert.doesNotThrow(() => matchArgs(def, ['a']));
  assert.doesNotThrow(() => matchArgs(def, ['b']));
  assert.throws(() => matchArgs(def, ['xb']), /do not match/);
  assert.throws(() => matchArgs(def, ['ax']), /do not match/);
});

test('catalog: MCP definitions are validated', () => {
  const ok = validateMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP], env: { A: '1' } });
  assert.deepEqual(ok.env, { A: '1' });
  const bad = (def, re) => assert.throws(() => validateMcp(def), (e) => e instanceof CatalogError && re.test(e.message), JSON.stringify(def));
  bad({ id: 'fake', name: 'Fake', command: ['node', 'x.js'] }, /absolute/);
  bad({ id: 'fake', name: 'Fake', command: [] }, /command/);
  bad({ id: 'fake', name: 'Fake', command: ['/nonexistent/x'] }, /does not exist/);
  bad({ id: 'fake', name: 'Fake', command: [process.execPath], env: { 'bad-name': 'x' } }, /env/);
  bad({ id: 'fake', name: 'Fake', command: [process.execPath], env: { A: 1 } }, /env/);
  bad({ id: 'Fake', name: 'Fake', command: [process.execPath] }, /id/);
  bad({ id: 'fake', name: 'Fake', command: [process.execPath], shell: true }, /not a known key/);
});

test('catalog: files round-trip, duplicates are refused, the broker only gets a read-only view', (t) => {
  const d = tmpdir('cat-');
  t.after(() => rmrf(d));
  const cat = new Catalog({ home: d });
  assert.deepEqual(cat.tools(), []);
  cat.addTool(echoTool());
  cat.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP] });
  assert.equal(new Catalog({ home: d }).tool('echo').path, '/bin/echo');
  assert.equal(new Catalog({ home: d }).mcpServer('fake').name, 'Fake');
  cat.addTool(echoTool({ name: 'Echo 2' })); // same id replaces
  assert.equal(cat.tools().length, 1);
  assert.equal(cat.tool('echo').name, 'Echo 2');
  assert.throws(() => cat.saveTools([echoTool(), echoTool()]), /duplicate/);
  assert.throws(() => cat.removeTool('nope'), /no tool/);
  const view = cat.readonly();
  assert.deepEqual(Object.keys(view).sort(), ['mcpServer', 'mcpServers', 'tool', 'tools']);
  assert.ok(Object.isFrozen(view));
  fs.writeFileSync(path.join(d, 'capabilities', 'tools.json'), '{"not":"an array"}');
  assert.throws(() => cat.tools(), /JSON array/);
  fs.writeFileSync(path.join(d, 'capabilities', 'tools.json'), 'garbage');
  assert.throws(() => cat.tools(), /not valid JSON/);
  cat.removeMcp('fake');
  assert.deepEqual(cat.mcpServers(), []);
});

test('INV-H1: nothing the broker or a session holds can write the catalog', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'hostlib', 'capabilities.js'), 'utf8');
  const start = src.indexOf('class HostCapabilities');
  const broker = src.slice(start, src.indexOf('/** Keeps a tool result'));
  assert.ok(broker.length > 5000);
  for (const w of ['saveTools', 'saveMcp', 'addTool', 'addMcp', 'removeTool', 'removeMcp', 'setHostGrant', 'saveHostGrants', 'writeAtomic', 'writeFile']) {
    assert.ok(!broker.includes(w), `the broker must not reference ${w}`);
  }
  const sess = fs.readFileSync(path.join(__dirname, '..', '..', 'hostlib', 'session.js'), 'utf8');
  for (const w of ['saveTools', 'saveMcp', 'addTool', 'addMcp', 'setHostGrant', 'saveHostGrants', 'Catalog']) assert.ok(!sess.includes(w), `session.js must not reference ${w}`);
});

// ------------------------------------------------------------------------------------------------ grants (store)

test('grants: structure, and always is refused for input', (t) => {
  const d = tmpdir('grants-');
  t.after(() => rmrf(d));
  const store = new Store({ home: d });
  const id = 'com.example.agent';
  assert.deepEqual(store.loadHostGrants(id), {});
  assert.deepEqual(store.loadGrants(id), { folders: {}, askEveryTime: false }); // no host key without grants
  store.setHostGrant(id, 'screen', { mode: 'always' });
  store.setHostGrant(id, 'tool:*', { mode: 'ask', tools: ['echo', 'echo', 'cat'] });
  assert.deepEqual(store.loadHostGrants(id), { screen: { mode: 'always' }, 'tool:*': { mode: 'ask', tools: ['echo', 'cat'] } });
  assert.throws(() => store.setHostGrant(id, 'input', { mode: 'always' }), (e) => e instanceof StoreError && /input/.test(e.message));
  assert.throws(() => store.setHostGrant(id, 'screen', { mode: 'sometimes' }), /mode/);
  assert.throws(() => store.setHostGrant(id, 'screen', { mode: 'ask', tools: ['x'] }), /only valid for tool:\*/);
  assert.throws(() => store.setHostGrant(id, 'mcp:*', { mode: 'ask', tools: ['x'] }), /only valid for tool:\*/);
  assert.throws(() => store.setHostGrant(id, 'tool:*', { mode: 'ask', tools: ['Bad Id'] }), /invalid id/);
  assert.throws(() => store.setHostGrant(id, 'tool:*', { mode: 'ask', extra: 1 }), /not a known key/);
  assert.throws(() => store.setHostGrant(id, 'keyboard', { mode: 'ask' }), /invalid capability/);
  // folder grants saved by the permission UI keep the host grants
  store.saveGrants(id, { folders: {}, askEveryTime: true });
  assert.equal(store.loadHostGrants(id).screen.mode, 'always');
  assert.equal(store.loadGrants(id).askEveryTime, true);
  // ...unless host is given explicitly
  store.saveGrants(id, { folders: {}, host: {} });
  assert.deepEqual(store.loadHostGrants(id), {});
  // session grants expire
  store.setHostGrant(id, 'screen', { mode: 'session' });
  store.setHostGrant(id, 'input', { mode: 'ask' });
  assert.deepEqual(store.expireSessionHostGrants(id), ['screen']);
  assert.equal(store.loadHostGrants(id).screen.mode, 'ask');
  store.setHostGrant(id, 'screen', null);
  assert.deepEqual(Object.keys(store.loadHostGrants(id)), ['input']);
});

test('grants: checkHostGrant validates against the manifest and the catalog (no always for input or shell tools)', (t) => {
  const d = tmpdir('grants2-');
  t.after(() => rmrf(d));
  const cat = new Catalog({ home: d });
  cat.addTool(echoTool());
  cat.addTool({ id: 'sh', name: 'Shell', path: '/bin/sh', kind: 'shell', args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,100}$' }] });
  cat.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP] });
  const m = manifestWith([{ cap: 'screen' }, { cap: 'input' }, { cap: 'tool:*' }, { cap: 'mcp:fake' }]);
  const chk = (cap, spec) => checkHostGrant(m, cat, cap, spec);
  assert.deepEqual(chk('screen', { mode: 'always' }), { mode: 'always' });
  assert.deepEqual(chk('input', {}), { mode: 'ask' });
  assert.deepEqual(chk('input', { mode: 'session' }), { mode: 'session' });
  assert.throws(() => chk('input', { mode: 'always' }), /input/);
  assert.deepEqual(chk('tool:*', { mode: 'always', tools: ['echo'] }), { mode: 'always', tools: ['echo'] });
  assert.throws(() => chk('tool:*', { mode: 'always', tools: ['echo', 'sh'] }), /shell tool "sh"/);
  assert.deepEqual(chk('tool:*', { mode: 'ask', tools: ['sh'] }), { mode: 'ask', tools: ['sh'] });
  assert.throws(() => chk('tool:sh', { mode: 'always' }), /shell tool/); // covered by tool:*
  assert.throws(() => chk('tool:nope', { mode: 'ask' }), /no tool "nope"/);
  assert.throws(() => chk('tool:*', { mode: 'ask', tools: ['nope'] }), /no tool "nope"/);
  assert.throws(() => chk('mcp:other', { mode: 'ask' }), /does not request/);
  assert.throws(() => chk('mcp:fake', { mode: 'ask', servers: ['fake'] }), /servers is only valid/);
  const lim = manifestWith([{ cap: 'screen' }]);
  assert.throws(() => checkHostGrant(lim, cat, 'input', { mode: 'ask' }), /does not request "input"/);
  // setHostGrant stores it
  const store = new Store({ home: d });
  const app = { id: m.id, manifest: m };
  setHostGrant(store, cat, app, 'screen', { mode: 'session' });
  assert.equal(store.loadHostGrants(m.id).screen.mode, 'session');
  const sum = hostRequestSummary(m, cat, store.loadGrants(m.id));
  assert.deepEqual(sum.map((s) => [s.cap, s.risk, s.control]), [['screen', 'screen', false], ['input', 'input', true], ['tool:*', 'shell', true], ['mcp:fake', 'mcp', false]]);
  assert.deepEqual(sum[2].candidates.map((c) => c.id), ['echo', 'sh']);
  assert.equal(sum[0].grant.mode, 'session');
});

// ------------------------------------------------------------------------------------------------ the broker

/** A broker with a catalog in a scratch home, a fake hostctl and a scripted UI. */
function setup(t, { allow = false, host = [{ cap: 'screen' }, { cap: 'input' }, { cap: 'tool:*' }, { cap: 'mcp:*' }], grants = {}, opts = {} } = {}) {
  const d = tmpdir('caps-');
  t.after(() => rmrf(d));
  const store = new Store({ home: d });
  const catalog = new Catalog({ home: d });
  const ui = new FakeCapabilitiesUi({ allow });
  const ctlLog = path.join(d, 'ctl.log');
  const mcpLog = path.join(d, 'mcp.log');
  process.env.FAKE_HOSTCTL_LOG = ctlLog;
  process.env.FAKE_MCP_LOG = mcpLog;
  t.after(() => {
    delete process.env.FAKE_HOSTCTL_LOG;
    delete process.env.FAKE_MCP_LOG;
    delete process.env.FAKE_HOSTCTL_BIG;
  });
  const caps = new HostCapabilities({
    store,
    catalog,
    ui,
    hostctl: () => new HostCtl({ command: [process.execPath, FAKE_CTL] }),
    panicHotkey: true,
    dryRun: true,
    ...opts,
  });
  t.after(() => caps.close());
  const shares = new Map();
  const state = { grants };
  const traffic = [];
  const mkCtx = (key = 'a1', appId = 'com.example.agent') => ({
    key,
    appId,
    appName: 'Agent',
    manifest: manifestWith(host),
    grants: () => state.grants,
    resolvePath: (p) => resolveShare(shares, p),
    traffic: (e) => traffic.push(e),
  });
  const ctx = mkCtx();
  const call = (op, params, c = ctx) => caps.requestOp(op, params, c);
  const ctlOps = () => (fs.existsSync(ctlLog) ? fs.readFileSync(ctlLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const mcpEvents = () => (fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { d, store, catalog, ui, caps, ctx, mkCtx, call, state, shares, traffic, ctlOps, mcpEvents };
}

const denied = (re = /permission denied/) => (e) => re.test(e.message);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await wait(25);
  return !alive(pid);
}

test('broker: denied by default (not in the manifest, no grant, declined)', async (t) => {
  const s = setup(t, { allow: false, host: [{ cap: 'screen' }] });
  s.catalog.addTool(echoTool());
  // not requested in the manifest, even though granted
  s.state.grants = { input: { mode: 'ask' }, 'tool:echo': { mode: 'always' } };
  await assert.rejects(s.call('host.input.start', { reason: 'x' }), denied(/not requested in the app manifest/));
  await assert.rejects(s.call('host.tool.run', { id: 'echo', args: ['hi'] }), denied(/not requested/));
  // requested but not granted
  s.state.grants = {};
  await assert.rejects(s.call('host.screen.windows', {}), denied(/not granted/));
  await assert.rejects(s.call('host.screen.capture', { target: 'display' }), denied(/not granted/));
  // granted with ask, the user says no
  s.state.grants = { screen: { mode: 'ask' } };
  await assert.rejects(s.call('host.screen.windows', {}), denied(/declined by the user/));
  assert.equal(s.ui.calls.length, 1);
  assert.equal(s.ui.calls[0].cap, 'screen');
  assert.equal(s.ui.calls[0].app.name, 'Agent');
  // no UI at all: ask fails closed
  const s2 = setup(t, { host: [{ cap: 'screen' }], grants: { screen: { mode: 'ask' } }, opts: { ui: null } });
  s2.caps.ui = null;
  await assert.rejects(s2.call('host.screen.windows', {}), denied(/declined/));
  assert.deepEqual(s2.ctlOps(), []); // hostctl was never even started
  assert.deepEqual(s.ctlOps(), []);
});

test('broker: unknown and malformed ops are errors; every use emits a host event', async (t) => {
  const s = setup(t, { allow: true, grants: { screen: { mode: 'always' } } });
  await assert.rejects(s.call('host.fs.read', {}), /unknown host op/);
  await assert.rejects(s.call('screen.windows', {}), /unknown host op/);
  const r = await s.call('host.screen.windows', {});
  // (the fake desktop also has a window of the loader itself, pid = this process: never listed to an app)
  assert.deepEqual(r, [
    { windowId: 7, app: 'FakeApp', title: 'Fake window', bounds: { x: 0, y: 0, w: 100, h: 80 } },
    { windowId: 8, app: 'Notes', title: 'Shopping list', bounds: { x: 1500, y: 100, w: 500, h: 400 } },
  ]);
  const ev = s.traffic.at(-1);
  assert.equal(ev.kind, 'host');
  assert.equal(ev.cap, 'screen');
  assert.equal(ev.op, 'host.screen.windows');
  assert.equal(ev.allowed, true);
  assert.equal(typeof ev.durationMs, 'number');
  // denied uses are logged too
  s.state.grants = {};
  await assert.rejects(s.call('host.screen.windows', {}));
  const dn = s.traffic.at(-1);
  assert.equal(dn.allowed, false);
  assert.match(dn.message, /permission denied/);
});

test('broker: modes ask / session / always, and "allow for this session"', async (t) => {
  const s = setup(t, { allow: true, grants: { screen: { mode: 'ask' } } });
  await s.call('host.screen.windows', {});
  await s.call('host.screen.windows', {});
  assert.equal(s.ui.calls.length, 2, 'ask: asked at every use');
  s.ui.allow = 'session';
  await s.call('host.screen.windows', {});
  await s.call('host.screen.windows', {});
  assert.equal(s.ui.calls.length, 3, 'the "session" answer is remembered: no third question');
  s.caps.stopApp(s.ctx.key);
  s.ui.allow = true;
  await s.call('host.screen.windows', {});
  assert.equal(s.ui.calls.length, 4, 'a new run asks again');
  // session mode: not asked while the run lasts
  s.state.grants = { screen: { mode: 'session' } };
  await s.call('host.screen.windows', {});
  assert.equal(s.ui.calls.length, 4);
  // always: not asked
  s.state.grants = { screen: { mode: 'always' } };
  await s.call('host.screen.windows', {});
  assert.equal(s.ui.calls.length, 4);
  // revocation applies to the very next call
  s.state.grants = {};
  await assert.rejects(s.call('host.screen.windows', {}), denied());
});

test('broker: stopApp turns session grants of the app back into ask', async (t) => {
  const s = setup(t, { allow: true, grants: { screen: { mode: 'session' } } });
  s.store.setHostGrant('com.example.agent', 'screen', { mode: 'session' });
  await s.call('host.screen.windows', {});
  s.caps.stopApp(s.ctx.key);
  assert.equal(s.store.loadHostGrants('com.example.agent').screen.mode, 'ask');
});

test('broker: always is never honoured for input or a shell tool (it asks)', async (t) => {
  const s = setup(t, { allow: false, grants: { input: { mode: 'always' }, 'tool:sh': { mode: 'always' } } }); // hand-edited file
  s.catalog.addTool({ id: 'sh', name: 'Shell', path: '/bin/sh', kind: 'shell', args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,100}$' }] });
  await assert.rejects(s.call('host.input.start', { reason: 'x' }), denied(/declined/));
  await assert.rejects(s.call('host.tool.run', { id: 'sh', args: ['-c', 'echo x'] }), denied(/declined/));
  assert.deepEqual(s.ui.calls.map((c) => [c.cap, !!c.shell]), [['input', false], ['tool:sh', true]]);
});

// ---- screen

test('screen: windows and capture through the fake hostctl; the png is data, never in the event log', async (t) => {
  const s = setup(t, { allow: true, grants: { screen: { mode: 'always' } } });
  const w = await s.call('host.screen.windows', {});
  assert.equal(w[0].windowId, 7);
  assert.ok(!('pid' in w[0]));
  const c = await s.call('host.screen.capture', { target: 'window', windowId: 7, maxWidth: 640 });
  assert.equal(c.width, 640);
  const png = Buffer.from(c.png, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const req = s.ctlOps().find((o) => o.op === 'capture');
  assert.deepEqual(req.args, { target: 'window', windowId: 7, maxWidth: 640, excludePids: [process.pid] }, 'the loader’s own windows are always excluded');
  assert.deepEqual(c.target, { kind: 'window', windowId: 7, display: 1, bounds: { x: 0, y: 0, w: 100, h: 80 }, by: 'app' }, 'the result says what was captured');
  for (const e of s.traffic) assert.ok(!JSON.stringify(e).includes(c.png.slice(0, 40)), 'no screenshot bytes in events');
  assert.match(s.traffic.at(-1).detail, /capture window/);
  // parameters are validated and forwarded only as whitelisted fields
  await assert.rejects(s.call('host.screen.capture', { target: 'screen' }), /target/);
  await assert.rejects(s.call('host.screen.capture', { target: 'window' }), /windowId/);
  await assert.rejects(s.call('host.screen.capture', { target: 'region', region: { x: 0, y: 0, w: 0, h: 5 } }), /region\.w/);
  await assert.rejects(s.call('host.screen.capture', { target: 'display', maxWidth: 99999 }), /maxWidth/);
  const before = s.ctlOps().length;
  await s.call('host.screen.capture', { target: 'display', native: true, legacy: true, junk: 1 });
  assert.deepEqual(s.ctlOps()[before].args, { target: 'display', excludePids: [process.pid] });
});

test('screen: a capture too large for the bridge is retried smaller', async (t) => {
  const s = setup(t, { allow: true, grants: { screen: { mode: 'always' } } });
  process.env.FAKE_HOSTCTL_BIG = '1';
  // the helper process inherits the env of the first request's spawn; start it only now
  const c = await s.call('host.screen.capture', { target: 'display' });
  assert.equal(c.png.length < 1000, true);
  assert.equal(s.ctlOps().filter((o) => o.op === 'capture').map((o) => o.args.maxWidth).join(','), ',1920');
});

test('screen: a hostctl permission error is reported as a macOS permission problem', async (t) => {
  const s = setup(t, { allow: true, grants: { screen: { mode: 'always' } }, opts: { hostctl: () => ({ request: async () => { const e = new Error('Screen Recording is not allowed'); e.code = 'permission'; throw e; }, on() {}, close: async () => {} }) } });
  await assert.rejects(s.call('host.screen.windows', {}), /macOS permission missing: Screen Recording/);
});

// ---- input

test('input: start needs a grant, shows the badge, mouse/keys pass through (dry run), stop ends it', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'ask' } } });
  await assert.rejects(s.call('host.input.mouse', { sessionId: 'nope', action: 'move', x: 1, y: 2 }), /no such input session/);
  const { sessionId } = await s.call('host.input.start', { reason: 'fill the form' });
  assert.match(sessionId, /^[0-9a-f]{16}$/);
  assert.equal(s.ui.calls[0].detail.includes('fill the form'), true);
  assert.deepEqual(s.ui.badges.map((b) => [b.badge, b.state]), [['input', 'on']]);
  assert.equal(s.ui.badges[0].reason, 'fill the form');
  assert.equal(s.caps.active().length, 1);
  assert.equal(s.caps.active()[0].kind, 'input');
  // the panic hotkey was registered
  assert.ok(s.ctlOps().some((o) => o.op === 'panic-hotkey' && o.args.enable === true));

  await s.call('host.input.mouse', { sessionId, action: 'click', x: 10, y: 20, button: 'left', junk: 'x' });
  await s.call('host.input.keys', { sessionId, text: 'hello secret' });
  await s.call('host.input.keys', { sessionId, key: 'a', modifiers: ['cmd', 'shift'] });
  const ops = s.ctlOps().filter((o) => o.op === 'mouse' || o.op === 'keys');
  assert.deepEqual(ops.map((o) => o.args), [
    { action: 'click', x: 10, y: 20, button: 'left', dryRun: true },
    { text: 'hello secret', dryRun: true },
    { key: 'a', modifiers: ['cmd', 'shift'], dryRun: true },
  ]);
  assert.ok(!s.traffic.some((e) => JSON.stringify(e).includes('hello secret')), 'typed text is not logged');
  assert.ok(s.traffic.some((e) => e.detail === 'type 12 characters'));

  // validation
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'teleport' }), /action/);
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 'a', y: 1 }), /x must be a number/);
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'click', x: 1, y: 1, clicks: 9 }), /clicks/);
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 1e9, y: 1 }), /x must be/);
  await assert.rejects(s.call('host.input.keys', { sessionId }), /exactly one of text or key/);
  await assert.rejects(s.call('host.input.keys', { sessionId, text: 'a', key: 'b' }), /exactly one/);
  await assert.rejects(s.call('host.input.keys', { sessionId, key: 'a', modifiers: ['meta'] }), /modifiers/);
  await assert.rejects(s.call('host.input.keys', { sessionId, key: 'a b' }), /key must be/);

  await s.call('host.input.stop', { sessionId });
  assert.deepEqual(s.ui.badges.map((b) => [b.badge, b.state]), [['input', 'on'], ['input', 'off']]);
  assert.equal(s.ui.badges[1].reason, 'stopped');
  assert.equal(s.caps.active().length, 0);
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }), /no such input session/);
  await s.call('host.input.stop', { sessionId }); // idempotent
});

test('input: a session of another app is not usable; no grant means no mouse even in a live session', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'session' } } });
  const { sessionId } = await s.call('host.input.start', {});
  const other = s.mkCtx('b2', 'com.example.other');
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }, other), /no such input session/);
  // the user revokes the grant mid-session: the session ends at the next call
  s.state.grants = {};
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }), denied());
  assert.equal(s.caps.active().length, 0);
  assert.equal(s.ui.badges.at(-1).reason, 'revoked');
});

test('input: expires after the time limit (10 minutes in production; shortened here)', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'ask' } }, opts: { inputMaxMs: 120 } });
  const { sessionId } = await s.call('host.input.start', { reason: 'x' });
  await s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 });
  await wait(250);
  assert.equal(s.ui.badges.at(-1).state, 'off');
  assert.equal(s.ui.badges.at(-1).reason, 'expired');
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }), /no such input session/);
  assert.equal(require('../../hostlib/capabilities').INPUT_MAX_MS, 600000);
  // a new start renews it
  const second = await s.call('host.input.start', { reason: 'again' });
  assert.notEqual(second.sessionId, sessionId);
});

test('input: a new start replaces the running session; buttons held down are released on stop', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'always' } } }); // hand-edited always: still asks, ui allows
  const a = await s.call('host.input.start', { reason: 'one' });
  await s.call('host.input.mouse', { sessionId: a.sessionId, action: 'down', x: 5, y: 6 });
  const b = await s.call('host.input.start', { reason: 'two' });
  assert.deepEqual(s.ui.badges.map((x) => `${x.state}:${x.reason}`), ['on:one', 'off:renewed', 'on:two']);
  await wait(100);
  const up = s.ctlOps().filter((o) => o.op === 'mouse').at(-1).args;
  assert.deepEqual(up, { action: 'up', x: 5, y: 6, button: 'left', dryRun: true });
  await assert.rejects(s.call('host.input.mouse', { sessionId: a.sessionId, action: 'move', x: 1, y: 2 }), /no such input session/);
  await s.call('host.input.stop', { sessionId: b.sessionId });
});

test('input: panic (stopAll, or the helper reporting the hotkey) stops input, kills tools and MCP servers of every app', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'ask' }, 'tool:*': { mode: 'always', tools: ['slow'] }, 'mcp:*': { mode: 'always', servers: ['fake'] } } });
  s.catalog.addTool({ id: 'slow', name: 'Slow', path: '/bin/sleep', args: [{ pattern: '^\\d+$' }], timeoutMs: 20000 });
  s.catalog.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP] });
  const panics = [];
  s.caps.on('panic', (e) => panics.push(e));

  const { sessionId } = await s.call('host.input.start', { reason: 'x' });
  const run = s.call('host.tool.run', { id: 'slow', args: ['30'] });
  const pidText = await s.call('host.mcp.call', { server: 'fake', method: 'tools/call', params: { name: 'pid' } });
  const mcpPid = Number(pidText.content[0].text);
  await wait(100);
  assert.ok(alive(mcpPid));
  const other = s.mkCtx('b2', 'com.example.other');
  s.state.grants = { input: { mode: 'ask' }, 'tool:*': { mode: 'always', tools: ['slow'] }, 'mcp:*': { mode: 'always', servers: ['fake'] } };
  const { sessionId: other2 } = await s.call('host.input.start', {}, other);
  assert.equal(s.caps.active().length, 2);

  // the helper reports the hotkey
  const ctl = s.caps._hostctl();
  await ctl.request('__panic', {});
  await assert.rejects(run, /was stopped \(panic\)/);
  await wait(50);
  assert.equal(panics.length, 1);
  assert.equal(panics[0].reason, 'panic');
  assert.equal(s.caps.active().length, 0);
  assert.ok(await gone(mcpPid), 'the MCP server process is gone');
  assert.deepEqual(s.ui.badges.filter((b) => b.state === 'off').map((b) => b.reason), ['panic', 'panic']);
  await assert.rejects(s.call('host.input.mouse', { sessionId, action: 'move', x: 1, y: 2 }), /no such input session/);
  await assert.rejects(s.call('host.input.mouse', { sessionId: other2, action: 'move', x: 1, y: 2 }, other), /no such input session/);

  // stopAll() directly (the badge's Stop for everything)
  const again = await s.call('host.input.start', {});
  s.caps.stopAll('user');
  assert.equal(s.caps.active().length, 0);
  assert.equal(panics.length, 2);
  await assert.rejects(s.call('host.input.keys', { sessionId: again.sessionId, text: 'x' }), /no such input session/);
});

test('input: the app stopping ends its input session and its tools', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'always' }, 'tool:slow': { mode: 'always' } } });
  s.catalog.addTool({ id: 'slow', name: 'Slow', path: '/bin/sleep', args: [{ pattern: '^\\d+$' }], timeoutMs: 20000 });
  await s.call('host.input.start', {});
  const run = s.call('host.tool.run', { id: 'slow', args: ['30'] });
  await wait(150);
  s.caps.stopApp(s.ctx.key, 'app-stopped');
  await assert.rejects(run, /was stopped \(app-stopped\)/);
  assert.equal(s.ui.badges.at(-1).reason, 'app-stopped');
  await assert.rejects(s.call('host.screen.windows', {}), denied()); // a stopped app's state is gone; no screen grant anyway
});

test('input: refused when the loader cannot show the badge', async (t) => {
  const s = setup(t, { allow: true, grants: { input: { mode: 'ask' } } });
  s.caps.ui = { confirmUse: async () => true }; // no inputStarted
  await assert.rejects(s.call('host.input.start', {}), /badge/);
  s.caps.ui = { confirmUse: async () => true, inputStarted: () => { throw new Error('window gone'); }, inputStopped() {} };
  await assert.rejects(s.call('host.input.start', {}), /cannot show the control badge/);
  assert.equal(s.caps.active().length, 0);
});

// ---- tools

test('tools: argument patterns (match, missing, extra, variadic, optional)', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['echo', 'two', 'opt', 'var'] } } });
  s.catalog.addTool({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^hello$' }] });
  s.catalog.addTool({ id: 'two', name: 'Two', path: '/bin/echo', args: [{ pattern: '^-n$' }, { pattern: '^\\w+$' }] });
  s.catalog.addTool({ id: 'opt', name: 'Opt', path: '/bin/echo', args: [{ pattern: '^-x$' }, { pattern: '^-R\\d+$', optional: true }, { pattern: '^\\w+$' }] });
  s.catalog.addTool({ id: 'var', name: 'Var', path: '/bin/echo', args: [{ pattern: '^-n$' }, { pattern: '^\\w+$' }], variadic: true });
  const run = (id, args) => s.call('host.tool.run', { id, args });
  assert.equal((await run('echo', ['hello'])).stdout, 'hello\n');
  await assert.rejects(run('echo', []), /missing arguments/);
  await assert.rejects(run('echo', ['hello', 'extra']), /too many arguments/);
  await assert.rejects(run('echo', ['HELLO']), /do not match/);
  await assert.rejects(run('echo', ['hello\n']), /do not match/, 'the whole argument must match');
  await assert.rejects(run('echo', ['xhellox']), /do not match/);
  await assert.rejects(run('echo', [5]), /must be a string/);
  await assert.rejects(run('echo', 'hello'), /must be an array/);
  await assert.rejects(run('echo', ['a\0b']), /NUL|do not match/);
  assert.equal((await run('two', ['-n', 'abc'])).stdout, 'abc');
  await assert.rejects(run('two', ['-n']), /missing/);
  await assert.rejects(run('two', ['abc', '-n']), /do not match/);
  assert.equal((await run('opt', ['-x', 'name'])).stdout, '-x name\n');
  assert.equal((await run('opt', ['-x', '-R12', 'name'])).stdout, '-x -R12 name\n');
  await assert.rejects(run('opt', ['-x', '-R12']), /do not match|missing/);
  await assert.rejects(run('opt', ['-x', '-Rzz', 'name']), /do not match/);
  assert.equal((await run('var', ['-n', 'a', 'b', 'c'])).stdout, 'a b c');
  assert.equal((await run('var', ['-n', 'a'])).stdout, 'a');
  await assert.rejects(run('var', ['-n', 'a', 'b c']), /do not match/);
  await assert.rejects(run('var', []), /missing/);
  const r = await run('echo', ['hello']);
  assert.deepEqual(Object.keys(r).sort(), ['exitCode', 'signal', 'stderr', 'stdout', 'timedOut', 'truncated']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.truncated, false);
});

test('tools: no shell interpretation, clean environment, stdin, cwd', async (t) => {
  process.env.VMAPP_TEST_SECRET = 'leak';
  t.after(() => delete process.env.VMAPP_TEST_SECRET);
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['echo', 'env', 'cat', 'pwd'] } } });
  s.catalog.addTool(echoTool());
  s.catalog.addTool({ id: 'env', name: 'Env', path: '/usr/bin/env', args: [] });
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [] });
  s.catalog.addTool({ id: 'pwd', name: 'Pwd', path: '/bin/pwd', args: [], cwd: s.d });
  const nasty = ['hi;rm -rf /', '$(touch /tmp/vmapp-pwned)', '`id`', '$HOME', '*', '| cat', '> /tmp/vmapp-pwned2', '&& echo x', "'; echo y; '", '~'];
  const r = await s.call('host.tool.run', { id: 'echo', args: ['hi;rm -rf /'] });
  assert.equal(r.stdout, 'hi;rm -rf /\n');
  for (const a of nasty) assert.equal((await s.call('host.tool.run', { id: 'echo', args: [a] })).stdout, `${a}\n`, a);
  assert.ok(!fs.existsSync('/tmp/vmapp-pwned') && !fs.existsSync('/tmp/vmapp-pwned2'));
  const env = (await s.call('host.tool.run', { id: 'env', args: [] })).stdout;
  assert.ok(!env.includes('VMAPP_TEST_SECRET'));
  assert.match(env, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  assert.match(env, /^HOME=/m);
  assert.equal((await s.call('host.tool.run', { id: 'cat', args: [], stdin: 'from stdin ü' })).stdout, 'from stdin ü');
  assert.equal((await s.call('host.tool.run', { id: 'cat', args: [] })).stdout, '', 'no stdin: closed, does not hang');
  await assert.rejects(s.call('host.tool.run', { id: 'cat', args: [], stdin: 'x'.repeat(1024 * 1024 + 1) }), /1 MiB/);
  await assert.rejects(s.call('host.tool.run', { id: 'cat', args: [], stdin: 5 }), /stdin must be a string/);
  assert.equal(fs.realpathSync((await s.call('host.tool.run', { id: 'pwd', args: [] })).stdout.trim()), fs.realpathSync(s.d));
  // exit codes and stderr
  s.catalog.addTool({ id: 'sh0', name: 'Sh', path: '/bin/sh', args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,100}$' }] });
  s.state.grants = { 'tool:sh0': { mode: 'always' } };
  const bad = await s.call('host.tool.run', { id: 'sh0', args: ['-c', 'echo oops >&2; exit 3'] });
  assert.equal(bad.exitCode, 3);
  assert.equal(bad.stderr, 'oops\n');
  // unknown tool: granted but not in the catalog; ungranted tools look the same as before
  s.state.grants = { 'tool:ghost': { mode: 'always' } };
  await assert.rejects(s.call('host.tool.run', { id: 'ghost', args: [] }), /not registered/);
  await assert.rejects(s.call('host.tool.run', { id: '../etc', args: [] }), /id must be a tool id/);
  s.state.grants = {};
  await assert.rejects(s.call('host.tool.run', { id: 'echo', args: ['x'] }), denied());
});

test('tools: tool.list shows only granted tools and never the host path', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'ask', tools: ['echo'] }, 'tool:cat': { mode: 'ask' } } });
  s.catalog.addTool(echoTool({ description: 'Echoes' }));
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [] });
  s.catalog.addTool({ id: 'hidden', name: 'Hidden', path: '/bin/ls', args: [] });
  const l = await s.call('host.tool.list', {});
  assert.deepEqual(l.map((x) => x.id).sort(), ['cat', 'echo']);
  assert.ok(!JSON.stringify(l).includes('/bin/'));
  assert.equal(l.find((x) => x.id === 'echo').description, 'Echoes');
  assert.equal(l.find((x) => x.id === 'echo').variadic, true);
  assert.equal(s.ui.calls.length, 0, 'listing does not prompt');
  // an app without any tool request cannot even list
  const s2 = setup(t, { allow: true, host: [{ cap: 'screen' }], grants: { screen: { mode: 'ask' } } });
  await assert.rejects(s2.call('host.tool.list', {}), denied(/not requested/));
  const s3 = setup(t, { allow: true, grants: {} });
  await assert.rejects(s3.call('host.tool.list', {}), denied(/no tool capability is granted/));
});

test('tools: a tool listed under tool:* only works when the user picked it', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['echo'] } } });
  s.catalog.addTool(echoTool());
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [] });
  assert.equal((await s.call('host.tool.run', { id: 'echo', args: ['ok'] })).stdout, 'ok\n');
  await assert.rejects(s.call('host.tool.run', { id: 'cat', args: [] }), denied(/"tool:cat" is not granted/));
  // an explicit tool:<id> grant needs the manifest to cover it
  const m = setup(t, { allow: true, host: [{ cap: 'tool:echo' }], grants: { 'tool:echo': { mode: 'always' }, 'tool:cat': { mode: 'always' } } });
  m.catalog.addTool(echoTool());
  m.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [] });
  assert.equal((await m.call('host.tool.run', { id: 'echo', args: ['ok'] })).stdout, 'ok\n');
  await assert.rejects(m.call('host.tool.run', { id: 'cat', args: [] }), denied(/not requested/));
});

test('tools: timeout kills the process (and its children); output beyond the limit is truncated', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['slow', 'cat', 'sh'] } } });
  s.catalog.addTool({ id: 'slow', name: 'Slow', path: '/bin/sleep', args: [{ pattern: '^\\d+$' }], timeoutMs: 300 });
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [], maxOutputBytes: 100 });
  s.catalog.addTool({ id: 'sh', name: 'Sh', path: '/bin/sh', args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,200}$' }], timeoutMs: 400 });
  const t0 = Date.now();
  const r = await s.call('host.tool.run', { id: 'slow', args: ['30'] });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGKILL');
  const big = await s.call('host.tool.run', { id: 'cat', args: [], stdin: 'x'.repeat(5000) });
  assert.equal(big.truncated, true);
  assert.equal(big.stdout.length, 100);
  const small = await s.call('host.tool.run', { id: 'cat', args: [], stdin: 'x'.repeat(100) });
  assert.equal(small.truncated, false);
  // a child of the tool dies with it
  const pidFile = path.join(s.d, 'child.pid');
  const r2 = await s.call('host.tool.run', { id: 'sh', args: ['-c', `sleep 60 & echo $! > ${pidFile}; wait`] });
  assert.equal(r2.timedOut, true);
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await gone(childPid), 'the grandchild was killed with the process group');
});

test('tools: shell tools show the badge, are never "always", and need a badge UI', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:sh': { mode: 'session' } } });
  s.catalog.addTool({ id: 'sh', name: 'Shell', path: '/bin/sh', kind: 'shell', args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,10000}$' }] });
  const r = await s.call('host.tool.run', { id: 'sh', args: ['-c', 'echo $((1+2)); ls / | head -1 >/dev/null'] });
  assert.equal(r.stdout, '3\n');
  assert.deepEqual(s.ui.badges.map((b) => [b.badge, b.state]), [['shell', 'on'], ['shell', 'off']]);
  assert.equal(s.ui.badges[0].tool.id, 'sh');
  assert.equal(s.caps.active().length, 0);
  // a plain tool never shows a badge
  s.catalog.addTool(echoTool());
  s.state.grants = { 'tool:echo': { mode: 'always' } };
  await s.call('host.tool.run', { id: 'echo', args: ['x'] });
  assert.equal(s.ui.badges.length, 2);
  // without shellStarted the shell tool is refused
  s.state.grants = { 'tool:sh': { mode: 'session' } };
  s.caps.ui = { confirmUse: async () => true };
  await assert.rejects(s.call('host.tool.run', { id: 'sh', args: ['-c', 'echo x'] }), /badge/);
  // the badge is on while it runs
  s.caps.ui = s.ui;
  s.catalog.addTool({ id: 'sh', name: 'Shell', path: '/bin/sh', kind: 'shell', args: [{ pattern: '^-c$' }, { pattern: '^[\\s\\S]{1,100}$' }], timeoutMs: 20000 });
  const run = s.call('host.tool.run', { id: 'sh', args: ['-c', 'sleep 20'] });
  await wait(300);
  assert.deepEqual(s.caps.active().map((a) => a.kind), ['shell']);
  s.caps.stopControl('com.example.agent', 'user');
  await assert.rejects(run, /was stopped \(user\)/);
  assert.equal(s.ui.badges.at(-1).state, 'off');
});

test('tools: a tool whose program vanished fails cleanly; too many at once is refused', async (t) => {
  const d0 = tmpdir('vanish-');
  t.after(() => rmrf(d0));
  const prog = path.join(d0, 'prog');
  fs.writeFileSync(prog, '#!/bin/sh\nexit 0\n'); // (a copied system binary can hang on macOS: use a script)
  fs.chmodSync(prog, 0o755);
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['vanish', 'slow'] } } });
  s.catalog.addTool({ id: 'vanish', name: 'V', path: prog, args: [] });
  s.catalog.addTool({ id: 'slow', name: 'Slow', path: '/bin/sleep', args: [{ pattern: '^\\d+$' }], timeoutMs: 20000 });
  assert.equal((await s.call('host.tool.run', { id: 'vanish', args: [] })).exitCode, 0);
  fs.rmSync(prog);
  await assert.rejects(s.call('host.tool.run', { id: 'vanish', args: [] }), /does not exist/);
  const runs = [1, 2, 3, 4].map(() => s.call('host.tool.run', { id: 'slow', args: ['30'] }));
  runs.forEach((p) => p.catch(() => {}));
  await wait(200);
  await assert.rejects(s.call('host.tool.run', { id: 'slow', args: ['30'] }), /too many tools/);
  s.caps.stopAll('user');
  for (const p of runs) await assert.rejects(p, /stopped/);
});

// ---- mapPath

function sharesFixture(s) {
  const dir = fs.realpathSync(s.d);
  const folder = path.join(dir, 'notes');
  const pick = path.join(dir, 'pickdir');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(folder);
  fs.mkdirSync(pick);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(folder, 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(pick, 'b.txt'), 'beta');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  const saveFile = path.join(dir, 'chosen', 'out.png');
  fs.mkdirSync(path.dirname(saveFile));
  s.shares.set('f-notes', { access: 'rw', path: folder, kind: 'dir' });
  s.shares.set('pick-0', { access: 'ro', path: pick, kind: 'dir' });
  s.shares.set('save-0', { access: 'wo', path: saveFile, kind: 'file' });
  return { dir, folder, pick, outside, saveFile };
}

test('mapPath: only currently granted shares map to host paths; traversal and other tricks are refused', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['cat', 'echo'] } } });
  const f = sharesFixture(s);
  s.catalog.addTool({ id: 'cat', name: 'Cat', path: '/bin/cat', args: [{ pattern: '^/host/[\\w.-]+/[\\w./ -]+$', mapPath: true }] });
  s.catalog.addTool({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^/host/[\\s\\S]*$', mapPath: true }] });
  const cat = (p) => s.call('host.tool.run', { id: 'cat', args: [p] });
  assert.equal((await cat('/host/f-notes/a.txt')).stdout, 'alpha');
  assert.equal((await cat('/host/pick-0/b.txt')).stdout, 'beta');
  // the argv the tool sees is the real path
  assert.equal((await s.call('host.tool.run', { id: 'echo', args: ['/host/f-notes/a.txt'] })).stdout, `${f.folder}/a.txt\n`);
  assert.equal((await s.call('host.tool.run', { id: 'echo', args: ['/host/save-0/out.png'] })).stdout, `${f.saveFile}\n`);
  assert.equal((await s.call('host.tool.run', { id: 'echo', args: ['/host/f-notes'] })).stdout, `${f.folder}\n`);
  assert.equal((await s.call('host.tool.run', { id: 'echo', args: ['/host/f-notes/new/file.txt'] })).stdout, `${f.folder}/new/file.txt\n`, 'not yet existing paths inside a share are fine');
  const echo = (p) => s.call('host.tool.run', { id: 'echo', args: [p] });
  for (const bad of [
    '/host/pick-0/../../etc/passwd',
    '/host/pick-0/../outside/secret.txt',
    '/host/f-notes/../outside/secret.txt',
    '/host/f-notes/./a.txt',
    '/host/f-notes//a.txt',
    '/host/f-notes/',
    '/host/pick-1/b.txt', // never granted
    '/host/f-other/a.txt',
    '/host/save-1/out.png',
    '/host/save-0/other.png', // only the chosen file name
    '/host/save-0/out.png/extra',
    '/host/save-0',
    '/host/',
    '/host',
    `${f.folder}/a.txt`, // a real host path is not a VM path
    '/etc/passwd',
    '/host/f-notes\\..\\x',
    'host/f-notes/a.txt',
  ]) {
    await assert.rejects(echo(bad), /not a valid|not under|not a folder or file granted|plain path|only \/host|no longer|outside|do not match/, bad);
  }
  // a name that was never granted is also unusable through the cat pattern
  await assert.rejects(cat('/host/pick-0/../../outside/secret.txt'), /do not match|plain path/);
});

test('mapPath: a symlink inside a share cannot lead out of it', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:echo': { mode: 'always' } } });
  const f = sharesFixture(s);
  s.catalog.addTool({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^/host/[\\s\\S]*$', mapPath: true }] });
  fs.symlinkSync(f.outside, path.join(f.folder, 'link'));
  fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.folder, 'file-link'));
  fs.symlinkSync(path.join(f.outside, 'nonexistent'), path.join(f.folder, 'dangling'));
  fs.symlinkSync(path.join(f.folder, 'a.txt'), path.join(f.folder, 'inside-link'));
  const echo = (p) => s.call('host.tool.run', { id: 'echo', args: [p] });
  await assert.rejects(echo('/host/f-notes/link/secret.txt'), /outside the shared folder/);
  await assert.rejects(echo('/host/f-notes/link/new.txt'), /outside the shared folder/);
  await assert.rejects(echo('/host/f-notes/file-link'), /outside the shared folder/);
  await assert.rejects(echo('/host/f-notes/dangling'), /dangling symlink/);
  assert.equal((await echo('/host/f-notes/inside-link')).stdout, `${f.folder}/a.txt\n`);
});

test('mapPath: "read" and "write" also require the share to be readable / writable', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:*': { mode: 'always', tools: ['rd', 'wr'] } } });
  sharesFixture(s);
  s.catalog.addTool({ id: 'rd', name: 'Rd', path: '/bin/echo', args: [{ pattern: '^/host/[\\s\\S]*$', mapPath: 'read' }] });
  s.catalog.addTool({ id: 'wr', name: 'Wr', path: '/bin/echo', args: [{ pattern: '^/host/[\\s\\S]*$', mapPath: 'write' }] });
  await s.call('host.tool.run', { id: 'rd', args: ['/host/pick-0/b.txt'] });
  await s.call('host.tool.run', { id: 'rd', args: ['/host/f-notes/a.txt'] });
  await assert.rejects(s.call('host.tool.run', { id: 'rd', args: ['/host/save-0/out.png'] }), /write-only/);
  await s.call('host.tool.run', { id: 'wr', args: ['/host/save-0/out.png'] });
  await s.call('host.tool.run', { id: 'wr', args: ['/host/f-notes/a.txt'] });
  await assert.rejects(s.call('host.tool.run', { id: 'wr', args: ['/host/pick-0/b.txt'] }), /read-only/);
});

test('mapPath: a revoked share can no longer be used (the table is the session\'s current grants)', async (t) => {
  const s = setup(t, { allow: true, grants: { 'tool:echo': { mode: 'always' } } });
  sharesFixture(s);
  s.catalog.addTool({ id: 'echo', name: 'Echo', path: '/bin/echo', args: [{ pattern: '^/host/[\\s\\S]*$', mapPath: true }] });
  await s.call('host.tool.run', { id: 'echo', args: ['/host/pick-0/b.txt'] });
  s.shares.delete('pick-0');
  await assert.rejects(s.call('host.tool.run', { id: 'echo', args: ['/host/pick-0/b.txt'] }), /not a folder or file granted/);
});

// ---- MCP

test('mcp: a per-app server process, automatic initialize, relay of the allowed methods only, cleanup on stop', async (t) => {
  const s = setup(t, { allow: true, grants: { 'mcp:*': { mode: 'always', servers: ['fake'] } } });
  s.catalog.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP], env: { FAKE_MCP_LOG: path.join(s.d, 'mcp.log'), MY_SETTING: 'x' } });
  const call = (method, params, c) => s.call('host.mcp.call', { server: 'fake', method, params }, c);

  const echo = await call('tools/call', { name: 'echo', arguments: { a: 1 } });
  assert.deepEqual(JSON.parse(echo.content[0].text), { a: 1 });
  const ev = s.mcpEvents();
  assert.deepEqual(ev.map((e) => e.event).slice(0, 4), ['start', 'initialize', 'initialized', 'request']);
  assert.equal(ev[1].protocolVersion, '2025-06-18');
  assert.equal(ev.filter((e) => e.event === 'start').length, 1);

  assert.deepEqual((await call('resources/list')).resources[0].name, 'fake.txt');
  assert.equal((await call('resources/read', { uri: 'file:///fake.txt' })).contents[0].text, 'fake contents');
  assert.equal((await call('prompts/list')).prompts[0].name, 'hello');
  assert.equal((await call('prompts/get', { name: 'hello' })).messages[0].role, 'user');
  assert.equal((await call('tools/list')).tools.length, 2);
  assert.equal((await call('tools/list', { cursor: 'page2' })).tools[0].name, 'env');
  assert.equal(s.mcpEvents().filter((e) => e.event === 'start').length, 1, 'one process serves all calls');

  // the method allowlist
  for (const m of ['initialize', 'ping', 'notifications/initialized', 'sampling/createMessage', 'roots/list', 'completion/complete', 'logging/setLevel', 'resources/subscribe', '../x', '']) {
    await assert.rejects(call(m, {}), /method must be one of/, m);
  }
  assert.ok(!s.mcpEvents().some((e) => e.method === 'ping' || e.method === 'sampling/createMessage'));
  await assert.rejects(call('tools/list', 'str'), /params must be an object/);
  await assert.rejects(s.call('host.mcp.call', { server: 'bad id', method: 'tools/list' }), /server must be/);

  // JSON-RPC errors come back as errors
  await assert.rejects(call('tools/call', { name: 'nonexistent' }), /MCP error -32000: tool nonexistent failed/);

  // a clean environment: only PATH, HOME and what the user set for this server
  const envNames = (await call('tools/call', { name: 'env' })).content[0].text.split(',');
  assert.ok(envNames.includes('PATH') && envNames.includes('HOME') && envNames.includes('MY_SETTING'));
  assert.ok(!envNames.includes('VMAPP_HOME'));
  assert.ok(!envNames.some((n) => /^(npm_|NODE_|SSH_|AWS_|VMAPP_TEST)/.test(n)), envNames.join(','));

  // each app gets its own process
  const pid1 = Number((await call('tools/call', { name: 'pid' })).content[0].text);
  const other = s.mkCtx('b2', 'com.example.other');
  const pid2 = Number((await call('tools/call', { name: 'pid' }, other)).content[0].text);
  assert.notEqual(pid1, pid2);
  assert.ok(alive(pid1) && alive(pid2));

  // stopping the app kills its server, not the other app's
  s.caps.stopApp(s.ctx.key);
  assert.ok(await gone(pid1), 'the server of the stopped app is gone');
  assert.ok(alive(pid2));
  s.caps.stopApp(other.key);
  assert.ok(await gone(pid2));
});

test('mcp: list returns the granted servers with their tools (all pages); denied or ungranted servers are not started', async (t) => {
  const s = setup(t, { allow: true, grants: { 'mcp:*': { mode: 'always', servers: ['fake'] } } });
  const env = { FAKE_MCP_LOG: path.join(s.d, 'mcp.log') }; // servers get a clean environment: pass the log explicitly
  s.catalog.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP], env });
  s.catalog.addMcp({ id: 'other', name: 'Other', command: [process.execPath, FAKE_MCP], env });
  const l = await s.call('host.mcp.list', {});
  assert.deepEqual(l.map((x) => [x.id, x.tools.map((t2) => t2.name)]), [['fake', ['echo', 'pid', 'env']]]);
  assert.equal(s.mcpEvents().filter((e) => e.event === 'start').length, 1);
  await assert.rejects(s.call('host.mcp.call', { server: 'other', method: 'tools/list' }), denied(/"mcp:other" is not granted/));
  // ask + declined: the server is listed with the error, and not started
  const s2 = setup(t, { allow: false, grants: { 'mcp:fake': { mode: 'ask' } }, host: [{ cap: 'mcp:fake' }] });
  s2.catalog.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP], env: { FAKE_MCP_LOG: path.join(s2.d, 'mcp.log') } });
  const l2 = await s2.call('host.mcp.list', {});
  assert.match(l2[0].error, /declined/);
  assert.deepEqual(s2.mcpEvents(), []);
  await assert.rejects(s2.call('host.mcp.call', { server: 'fake', method: 'tools/list' }), denied(/declined/));
  assert.deepEqual(s2.mcpEvents(), []);
});

test('mcp: a server that dies is restarted at the next call; a hung call times out', async (t) => {
  const s = setup(t, { allow: true, grants: { 'mcp:fake': { mode: 'always' } }, host: [{ cap: 'mcp:fake' }], opts: { mcpRequestTimeoutMs: 400 } });
  s.catalog.addMcp({ id: 'fake', name: 'Fake', command: [process.execPath, FAKE_MCP] });
  const pid1 = Number((await s.call('host.mcp.call', { server: 'fake', method: 'tools/call', params: { name: 'pid' } })).content[0].text);
  process.kill(pid1, 'SIGKILL');
  assert.ok(await gone(pid1));
  const pid2 = Number((await s.call('host.mcp.call', { server: 'fake', method: 'tools/call', params: { name: 'pid' } })).content[0].text);
  assert.notEqual(pid1, pid2);
  // tools/call has a floor of 120 s in production; hung calls on other methods time out at mcpRequestTimeoutMs
  s.caps.stopApp(s.ctx.key);
  assert.ok(await gone(pid2));
});

test('mcp: a server that cannot start is an error, not a hang', async (t) => {
  const s = setup(t, { allow: true, grants: { 'mcp:bad': { mode: 'always' } }, host: [{ cap: 'mcp:bad' }], opts: { mcpRequestTimeoutMs: 500 } });
  s.catalog.addMcp({ id: 'bad', name: 'Bad', command: ['/bin/cat'] }); // cat echoes the initialize request back: not a response
  const t0 = Date.now();
  await assert.rejects(s.call('host.mcp.call', { server: 'bad', method: 'tools/list' }));
  assert.ok(Date.now() - t0 < 5000);
  s.catalog.saveMcp([{ id: 'bad', name: 'Bad', command: ['/nonexistent/server'] }]);
  await assert.rejects(s.call('host.mcp.call', { server: 'bad', method: 'tools/list' }), /cannot start|ENOENT|exited/);
});

test('hostctl: client matches replies, reports error codes, restarts after exit', async (t) => {
  const c = new HostCtl({ command: [process.execPath, FAKE_CTL] });
  t.after(() => c.close());
  assert.deepEqual(await c.request('ping', {}), { pong: true });
  const [a, b] = await Promise.all([c.request('windows', {}), c.request('status', {})]);
  assert.equal(a[0].windowId, 7);
  assert.equal(b.macos, '15.7');
  await assert.rejects(c.request('nope', {}), (e) => e.code === 'unknown-op');
  const panics = [];
  c.on('panic', () => panics.push(1));
  await c.request('__panic', {});
  await wait(50);
  assert.equal(panics.length, 1);
  await c.request('__exit', {});
  await wait(100);
  assert.equal(c.running, false);
  assert.deepEqual(await c.request('ping', {}), { pong: true }); // restarted
  assert.throws(() => new HostCtl({ command: 'relative/path' }), /absolute/);
});

test('hostctl: VMAPP_HOSTCTL and the dry-run flag are ignored in a packaged loader', () => {
  const { resolveHostCtlCommand, hostDryRun } = require('../../hostlib/hostproc');
  const env = { VMAPP_HOSTCTL: '/tmp/fake-hostctl', VMAPP_HOSTCTL_DRYRUN: '1' };
  assert.deepEqual(resolveHostCtlCommand({ packaged: false, env }), ['/tmp/fake-hostctl']);
  assert.deepEqual(resolveHostCtlCommand({ packaged: false, env: { VMAPP_HOSTCTL: '["/usr/bin/node","/x.js"]' } }), ['/usr/bin/node', '/x.js']);
  assert.deepEqual(resolveHostCtlCommand({ packaged: true, bundled: '/App/vmapp-hostctl', env }), ['/App/vmapp-hostctl']);
  assert.throws(() => resolveHostCtlCommand({ packaged: true, env }), /not available/);
  assert.equal(hostDryRun({ packaged: false, env }), true);
  assert.equal(hostDryRun({ packaged: true, env }), false);
  assert.equal(hostDryRun({ packaged: false, env: {} }), false);
});
