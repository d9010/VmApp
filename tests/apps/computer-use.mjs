// Desk Helper (computer-use sample, node22 runtime) in a REAL VM, three runs (run-all.sh sets CU_PHASE):
//   granted   every capability granted (mode ask) and --allow-host: the host side is real (CLI, broker, /bin/echo, the
//             fake MCP server) but vmapp-hostctl is tests/unit/fixtures/fake-hostctl.js and input is a dry run
//             (VMAPP_HOSTCTL, VMAPP_HOSTCTL_DRYRUN: dev/test only), so nothing touches the owner's desktop.
//             Asserts: screenshot bytes arrive (fake PNG), windows, input calls succeed (dry run), tool output, MCP result.
//   declined  the same grants but no --allow-host: the user answers "no" to every question.
//   revoked   no grants at all (--allow-host is on, it must not matter).
//   In the last two runs every action is denied cleanly (ok:false, denied:true) and nothing reaches the helper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ok, requireEnv } from './lib.mjs';

const PHASE = process.env.CU_PHASE || 'granted';

const ctlOps = () => {
  const f = requireEnv('FAKE_HOSTCTL_LOG');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

export default async function ({ session, wm, capUi }) {
  const win = 1;
  await wm.waitForWindows(1, 30000);
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  assert.equal(wm.windows.get(win).params.title, 'Desk Helper');
  const call = (channel, p) => wm.invoke(win, channel, p);

  if (PHASE === 'granted') {
    // Look at my screen
    const look = await call('desk:look');
    assert.equal(look.ok, true, JSON.stringify(look));
    const png = Buffer.from(look.shot.png, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(look.shot.width, 1024, 'maxWidth 1024 reached the helper');
    assert.ok(png.length > 20);
    // the fake desktop also has a window of the loader itself (pid of this process): an app never sees it
    assert.deepEqual(look.windows.map((w) => [w.windowId, w.app, w.title]), [[7, 'FakeApp', 'Fake window'], [8, 'Notes', 'Shopping list']]);
    // headless there is no picker (the scripted UI answers yes/no), so the app’s own suggestion was captured, and the result
    // says so: Desk Helper shows `target` and maps clicks with its bounds
    assert.deepEqual(look.target, { kind: 'display', display: 1, bounds: { x: 0, y: 0, w: 1440, h: 900 }, by: 'app' });
    ok(`look: ${png.length}-byte PNG arrived as base64 (${look.shot.width}x${look.shot.height}), target ${look.target.kind} ${look.target.display} (${look.target.by}), window list: FakeApp "Fake window", Notes "Shopping list"`);

    // Point and click, Type text (dry run)
    const click = await call('desk:click', { x: 120.4, y: 64 });
    assert.equal(click.ok, true, JSON.stringify(click));
    assert.deepEqual(click.steps, ['input.start', 'mouse move', 'mouse click', 'input.stop']);
    const type = await call('desk:type', { text: 'Hello from the test' });
    assert.equal(type.ok, true, JSON.stringify(type));
    assert.equal(type.typed, 19);
    const bad = await call('desk:click', { x: 'left', y: 1 });
    assert.equal(bad.ok, false);
    assert.equal(bad.denied, false, 'bad input is an error, not a denial');
    assert.match(bad.error, /Pick a point/);
    ok('click (move, click) and type succeeded as a dry run; a bad point is refused without asking the host');

    // Run a tool
    const tl = await call('desk:tools');
    assert.equal(tl.ok, true, JSON.stringify(tl));
    assert.deepEqual(tl.tools.map((t) => t.id), ['echo']);
    assert.ok(!JSON.stringify(tl.tools).includes('/bin/echo'), 'no host path is shown to the app');
    const run = await call('desk:tool-run', { id: 'echo', args: ['hi;rm -rf /', '$(id)'] });
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(run.result.exitCode, 0);
    assert.equal(run.result.stdout, 'hi;rm -rf / $(id)\n');
    const longArg = await call('desk:tool-run', { id: 'echo', args: ['x'.repeat(300)] });
    assert.equal(longArg.ok, false);
    assert.equal(longArg.denied, false, 'an argument the pattern refuses is an error, not a permission denial');
    const other = await call('desk:tool-run', { id: 'cat', args: [] });
    assert.equal(other.ok, false);
    assert.equal(other.denied, true, 'a tool that is not granted is denied');
    ok('tools: echo listed (no path), output "hi;rm -rf / $(id)" printed literally (no shell), bad argument refused, ungranted tool denied');

    // MCP
    const ml = await call('desk:mcp-list');
    assert.equal(ml.ok, true, JSON.stringify(ml));
    assert.deepEqual(ml.servers.map((s) => s.id), ['fakemcp']);
    assert.equal(ml.servers[0].error, undefined);
    assert.ok(ml.servers[0].tools.map((t) => t.name).includes('echo'), JSON.stringify(ml.servers[0].tools));
    const mc = await call('desk:mcp-call', { server: 'fakemcp', tool: 'echo', args: { a: 1, b: 'two' } });
    assert.equal(mc.ok, true, JSON.stringify(mc));
    assert.equal(mc.result.content[0].text, '{"a":1,"b":"two"}');
    const mf = await call('desk:mcp-call', { server: 'fakemcp', tool: 'no-such-tool', args: {} });
    assert.equal(mf.ok, false);
    assert.equal(mf.denied, false);
    ok('mcp: fakemcp listed with its tools; tools/call echo returned {"a":1,"b":"two"}; a failing tool is a plain error');

    // What reached the (fake) helper, and what the user was asked
    const ops = ctlOps();
    assert.ok(ops.some((o) => o.op === 'capture' && o.args.maxWidth === 1024 && o.args.target === 'display'));
    assert.deepEqual(ops.filter((o) => o.op === 'mouse' || o.op === 'keys').map((o) => o.args), [
      { action: 'move', x: 120.4, y: 64, dryRun: true },
      { action: 'click', x: 120.4, y: 64, button: 'left', clicks: 1, dryRun: true },
      { text: 'Hello from the test', dryRun: true },
    ]);
    const caps = new Set(capUi.calls.map((c) => c.cap));
    for (const c of ['screen', 'input', 'tool:echo', 'mcp:fakemcp']) assert.ok(caps.has(c), `the user was asked about ${c}`);
    assert.deepEqual(capUi.badges.map((b) => `${b.badge}:${b.state}`), ['input:on', 'input:off', 'input:on', 'input:off']);
    ok('the helper got capture(maxWidth 1024) and the exact dry-run mouse/keys calls; the user was asked per capability; the badge went on and off twice');
  } else {
    // declined / revoked: every action is denied cleanly and nothing reaches the helper
    const defaultExpect = PHASE === 'declined' ? /declined by the user/ : /is not granted by the user/;
    const denied = (r, what, expect = defaultExpect) => {
      assert.equal(r.ok, false, `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.denied, true, what);
      assert.match(r.error, /^permission denied: /, what);
      assert.match(r.error, expect, what);
      return r;
    };
    denied(await call('desk:look'), 'look');
    denied(await call('desk:click', { x: 5, y: 6 }), 'click');
    denied(await call('desk:type', { text: 'nope' }), 'type');
    denied(await call('desk:tool-run', { id: 'echo', args: ['x'] }), 'tool-run');
    denied(await call('desk:mcp-call', { server: 'fakemcp', tool: 'echo', args: {} }), 'mcp-call');
    if (PHASE === 'declined') {
      // The lists are allowed (they only name what the user granted) but nothing is used: the tool list is fine,
      // the MCP list reports each server as unusable instead of starting it.
      const tl = await call('desk:tools');
      assert.equal(tl.ok, true);
      const ml = await call('desk:mcp-list');
      assert.equal(ml.ok, true);
      assert.deepEqual(ml.servers.map((s) => [s.id, s.tools.length]), [['fakemcp', 0]]);
      assert.match(ml.servers[0].error, /declined by the user/);
    } else {
      denied(await call('desk:tools'), 'tools', /no tool capability is granted/);
      denied(await call('desk:mcp-list'), 'mcp-list', /no mcp capability is granted/);
    }
    ok(`${PHASE}: look, click, type, tool run, MCP call (and the lists) all came back as clean permission-denied results`);
    const used = ctlOps().filter((o) => ['capture', 'mouse', 'keys', 'windows'].includes(o.op));
    assert.deepEqual(used, [], 'no screen or input request reached the helper');
    assert.deepEqual(capUi.badges, [], 'no badge was shown');
    ok('nothing reached the helper and no badge was shown');
  }

  wm.userClose(win);
  const stopped = await Promise.race([session.whenStopped(), new Promise((r) => setTimeout(() => r(null), 15000))]);
  assert.ok(stopped, 'the VM stops after the window closed');
  assert.equal(session.stoppedInfo.exitCode, 0);
  ok('window closed: the core exited with code 0');
  console.log(`COMPUTER-USE-${PHASE}-OK`);
}
