// SDK Probe (tests/apps/sdk-probe, runtime node22): the Node SDK's platform calls in a real VM.
//   SDK_PROBE_PHASE=allowed  (default) the clipboard and ports devices are allowed: the core reads the Mac's clipboard (the headless
//                            run's stand-in, VMAPP_HEADLESS_CLIPBOARD) and writes it; a write over 1 Mi characters is refused; a server
//                            in the VM is forwarded to this Mac's localhost (SPEC 8.8), fetched from here, then closed
//   SDK_PROBE_PHASE=denied   not allowed: the calls are refused, the stand-in is untouched
// run-all.sh installs the app and sets the grants.
import assert from 'node:assert/strict';
import { ok } from './lib.mjs';

export default async function ({ wm, clipboard }) {
  await wm.waitForWindows(1, 20000);
  const win = 1;
  const phase = process.env.SDK_PROBE_PHASE || 'allowed';
  if (phase === 'allowed') {
    assert.equal(await wm.invoke(win, 'clipboard:read'), 'copied on the Mac');
    ok('clipboard.readText() in the VM returns what was copied on the Mac');
    assert.equal(await wm.invoke(win, 'clipboard:write', 'written in the VM'), 'written');
    assert.equal(clipboard.text, 'written in the VM');
    ok('clipboard.writeText() in the VM changes the Mac’s clipboard');
    await assert.rejects(wm.invoke(win, 'clipboard:write', 'x'.repeat(1024 * 1024 + 1)), /longer than/);
    ok('a write of more than 1 Mi characters is refused');
    // port forwarding: a server in the VM, reached from this Mac
    assert.equal(await wm.invoke(win, 'ports:serve'), 8765);
    const fwd = await wm.invoke(win, 'ports:forward');
    assert.equal(fwd.port, 8765);
    assert.ok(Number.isInteger(fwd.hostPort) && fwd.hostPort > 0, JSON.stringify(fwd));
    assert.equal(fwd.url, `http://localhost:${fwd.hostPort}/`);
    const body = await (await fetch(`http://127.0.0.1:${fwd.hostPort}/hello?x=1`)).text();
    assert.equal(body, 'hello from the VM: /hello?x=1');
    const many = await Promise.all([1, 2, 3, 4, 5].map((i) => fetch(`http://127.0.0.1:${fwd.hostPort}/${i}`, { headers: { connection: 'close' } }).then((r) => r.text())));
    assert.deepEqual(many, [1, 2, 3, 4, 5].map((i) => `hello from the VM: /${i}`));
    assert.deepEqual(await wm.invoke(win, 'ports:list'), [{ port: 8765, hostPort: fwd.hostPort }]);
    ok(`ports.forward(8765): the VM's server answers on this Mac at 127.0.0.1:${fwd.hostPort} (6 requests, 5 of them at once)`);
    await wm.invoke(win, 'ports:close');
    await assert.rejects(fetch(`http://127.0.0.1:${fwd.hostPort}/`), 'nothing listens after ports.close');
    assert.deepEqual(await wm.invoke(win, 'ports:list'), []);
    ok('ports.close(8765): the Mac’s port is closed');
  } else {
    await assert.rejects(wm.invoke(win, 'ports:forward'), /permission denied: ports/);
    ok('without the user’s allow, ports.forward() is refused');
    await assert.rejects(wm.invoke(win, 'clipboard:read'), /permission denied: clipboard/);
    await assert.rejects(wm.invoke(win, 'clipboard:write', 'x'), /permission denied: clipboard/);
    assert.equal(clipboard.text, 'copied on the Mac');
    ok('without the user’s allow, clipboard.readText() and writeText() are refused and the clipboard is untouched');
  }
}
