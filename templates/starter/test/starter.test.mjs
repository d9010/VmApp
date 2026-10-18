// test/starter.test.mjs: a headless test for the Starter app. `test/run.sh` runs it twice with real VMs.
//
// HOW IT WORKS. `vmapp run <id> --headless --script test/starter.test.mjs` starts the app's VM exactly like the
// loader does, but with two stand-ins in place of the screen and the user:
//   wm       a fake window manager. It records windows and lets this script act as the UI:
//              wm.waitForWindows(n)              wait until the core has created n windows
//              wm.invoke(win, channel, ...args)  same as window.vmapp.invoke() in the UI
//              wm.send(win, channel, ...args)    same as window.vmapp.send()
//              wm.waitForEmit(channel)           wait for a core -> UI message (webContents.send)
//              wm.userClose(win)                 the user clicks the window's close button
//   dialogs  a fake "user". Native dialogs (open, save, confirm-a-link) get scripted answers instead of
//            popping up. The `--open FILE`, `--save FILE` and `--allow-external` flags of the command line set
//            the answers. `dialogs.opts` holds them, so a test can change an answer at any time.
// The script's default export gets { session, wm, dialogs, store }. Throw (or assert) to fail the test.
//
// The environment variables below are set by test/run.sh:
//   STARTER_RUN        1 for the first run, 2 for the second (the counter must still be there)
//   STARTER_DOCS       the host folder that run.sh granted as "documents"
//   STARTER_OPEN_FILE  the file the fake user picks in the Open dialog
//   STARTER_SAVE_FILE  the path the fake user picks in the Save dialog

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = Number(process.env.STARTER_RUN || 1);
const docs = process.env.STARTER_DOCS;
const openFile = process.env.STARTER_OPEN_FILE;
const saveFile = process.env.STARTER_SAVE_FILE;
assert.ok(docs && openFile && saveFile, 'STARTER_DOCS, STARTER_OPEN_FILE and STARTER_SAVE_FILE must be set (use test/run.sh)');

const ok = (what) => console.log(`ok - run ${run}: ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, check, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// The two handlers that use native dialogs: 'file:open' and 'file:save'.
async function testDialogs({ wm, win, dialogs }) {
  // ---- file:open: a native dialog, then a read of the picked file ------------------------------------------------
  const real = fs.readFileSync(openFile);
  const opened = await wm.invoke(win, 'file:open');
  assert.equal(opened.canceled, false);
  assert.equal(opened.name, path.basename(openFile));
  assert.equal(opened.size, real.length);
  assert.ok(real.length > 2048, 'the fixture should be bigger than 2 KB, to prove the preview is cut');
  assert.equal(opened.preview, real.subarray(0, 2048).toString('utf8'));
  assert.equal(dialogs.calls.filter((c) => c.kind === 'open').length, 1);
  ok(`file:open previewed the first 2 KB of ${opened.name} (${opened.size} bytes)`);

  // A user who presses Cancel: the core must cope, and the UI shows "No file chosen".
  const answers = { open: dialogs.opts.open, save: dialogs.opts.save };
  dialogs.opts.open = null;
  assert.deepEqual(await wm.invoke(win, 'file:open'), { canceled: true });
  dialogs.opts.open = answers.open;
  ok('file:open handles Cancel');

  // ---- file:save: a native dialog, then a write that the host delivers -------------------------------------------
  const text = `written by the Starter core, run ${run}`;
  assert.deepEqual(await wm.invoke(win, 'file:save', text), { canceled: false, bytes: Buffer.byteLength(text) });
  // The host delivers the file to the user's chosen path a moment after the core finished writing it.
  await until(`the saved file ${saveFile}`, () => fs.existsSync(saveFile) && fs.readFileSync(saveFile, 'utf8') === text);
  ok(`file:save delivered "${text}" to the chosen path`);

  dialogs.opts.save = null;
  assert.deepEqual(await wm.invoke(win, 'file:save', 'never written'), { canceled: true });
  dialogs.opts.save = answers.save;
  ok('file:save handles Cancel');
}

export default async function ({ session, wm, dialogs, store }) {
  // ---- the window -------------------------------------------------------------------------------------------------
  // The core creates its window as soon as it is ready. Window ids are assigned by the (fake) window manager.
  const [first] = await wm.waitForWindows(1, 15000);
  const win = first.id;
  assert.equal(first.params.entry, 'index.html');
  assert.equal(first.params.title, session.manifest.name); // main.js uses the app's name as the window title
  ok('the core created its window');

  // ---- info: the core really runs in a Linux VM ------------------------------------------------------------------
  const info = await wm.invoke(win, 'info');
  assert.equal(info.name, session.manifest.name);
  assert.equal(info.version, session.manifest.version);
  assert.equal(info.uid, 1000); // the unprivileged app user, not your Mac user
  assert.equal(info.platform, 'linux/arm64');
  assert.notEqual(info.kernel, os.release()); // the VM's kernel, not this Mac's
  assert.equal(info.userData, '/data');
  ok(`info: Node ${info.node} on Linux ${info.kernel}`);

  // ---- documents:list: a granted folder -------------------------------------------------------------------------
  const expected = fs
    .readdirSync(docs, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    .sort();
  assert.ok(expected.length > 0, 'the fixture folder should not be empty');
  assert.deepEqual(await wm.invoke(win, 'documents:list'), expected);
  ok(`documents:list shows the granted folder: ${expected.join(', ')}`);

  // ---- counter: persisted in /data -------------------------------------------------------------------------------
  // Run 1 starts from 0 (run.sh purges the app's data first). Each run adds 2, so run 2 starts from 2.
  const start = (run - 1) * 2;
  assert.deepEqual(await wm.invoke(win, 'counter:get'), { value: start, launches: run });
  assert.deepEqual(await wm.invoke(win, 'counter:increment'), { value: start + 1, launches: run });
  assert.deepEqual(await wm.invoke(win, 'counter:increment'), { value: start + 2, launches: run });
  ok(`counter: ${start} -> ${start + 2}${run > 1 ? ' (it survived the restart)' : ''}`);

  // ---- link:open: the user must confirm --------------------------------------------------------------------------
  // Nothing is really opened in a test: the session calls `session.openExternal` instead of launching a browser.
  // We wrap it to record which URLs the app asked for.
  const openedUrls = [];
  const realOpen = session.openExternal;
  session.openExternal = (url) => {
    openedUrls.push(url);
    return realOpen ? realOpen(url) : undefined;
  };
  const confirm = dialogs.opts.confirmExternal;
  dialogs.opts.confirmExternal = false; // the user says no
  assert.equal(await wm.invoke(win, 'link:open'), false);
  assert.deepEqual(openedUrls, []);
  dialogs.opts.confirmExternal = true; // the user says yes
  assert.equal(await wm.invoke(win, 'link:open'), true);
  assert.deepEqual(openedUrls, ['https://example.com/']);
  dialogs.opts.confirmExternal = confirm;
  ok('link:open asks first, and only then opens https://example.com/');

  // ---- an unknown channel is an error, not a hang ----------------------------------------------------------------
  await assert.rejects(() => wm.invoke(win, 'no-such-channel'), /no-such-channel|handler/i);
  ok('an unknown channel is rejected');

  // ---- the dialog handlers ---------------------------------------------------------------------------------------
  await testDialogs({ wm, win, dialogs });

  // ---- tick: core -> UI events -----------------------------------------------------------------------------------
  // Wait for two ticks. In run 1 no state-saving call is made after this point, so a lastTick of 2 or more in
  // state.json can only come from the core's before-quit handler.
  const t1 = await wm.waitForEmit('tick', { win, timeoutMs: 15000 });
  const t2 = await wm.waitForEmit('tick', { win, timeoutMs: 15000 });
  assert.equal(typeof t1[0], 'number');
  assert.equal(t2[0], t1[0] + 1);
  ok(`tick events arrive (#${t1[0]}, #${t2[0]})`);

  // ---- close the window: window-all-closed -> app.quit() -> before-quit -> the VM powers off ---------------------
  wm.userClose(win);
  await Promise.race([
    session.whenStopped(),
    sleep(20000).then(() => Promise.reject(new Error('the app did not quit after its window closed'))),
  ]);
  ok('closing the last window quit the app and stopped the VM');

  // ---- the state file on the host (the app's /data) --------------------------------------------------------------
  const stateFile = path.join(store.dataDir(session.appId), 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.counter, start + 2);
  assert.equal(state.launches, run);
  assert.ok(state.lastTick >= t2[0], `before-quit should have saved lastTick (>= ${t2[0]}), got ${state.lastTick}`);
  ok(`state.json on the host: ${JSON.stringify(state)}`);

  console.log(`STARTER-OK run ${run}`);
}
