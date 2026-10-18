'use strict';
// Runs inside the VM (node22 runtime). The test script calls 'run' and checks what came back.
const { app, BrowserWindow, ipcMain, host } = require('vmapp');

const attempt = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

ipcMain.handle('run', async () => {
  const out = {};
  out.echo = await attempt(() => host.tool.run('echo', ['hi;rm -rf /']));
  out.echoDollar = await attempt(() => host.tool.run('echo', ['$(touch /tmp/pwned)', '`id`']));
  out.echoBad = await attempt(() => host.tool.run('echo', ['x'.repeat(300)]));
  out.list = await attempt(() => host.tool.list());
  out.cat = await attempt(() => host.tool.run('cat', []));
  out.windows = await attempt(() => host.screen.windows());
  out.capture = await attempt(async () => {
    const r = await host.screen.capture({ target: 'display', maxWidth: 320 });
    return { isBuffer: Buffer.isBuffer(r.png), magic: r.png.subarray(1, 4).toString(), width: r.width, bytes: r.png.length };
  });
  out.input = await attempt(async () => {
    const s = await host.input.start('click the test button');
    await s.mouse({ action: 'click', x: 10, y: 20 });
    await s.keys('typed text');
    await s.keys({ key: 'return' });
    await s.stop();
    let after = null;
    try {
      await s.mouse({ action: 'move', x: 1, y: 2 });
    } catch (e) {
      after = e.message;
    }
    return { id: s.id, afterStop: after };
  });
  out.mcp = await attempt(() => host.mcp.list());
  return out;
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, title: 'HostCaps' });
  await win.loadFile('index.html');
});
