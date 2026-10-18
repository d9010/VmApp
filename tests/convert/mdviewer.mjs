// Markdown Viewer (examples/convert-electron), run twice by run.sh in REAL VMs (PHASE=1, then PHASE=2).
// run.sh passes: --open <fixtures>/sample.md  (the answer of the native open dialog), CONVERT_FIXTURES=<fixtures dir>.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const phase = process.env.PHASE || '1';
const fixtures = process.env.CONVERT_FIXTURES;
let n = 0;
const ok = (msg) => console.log(`  ok ${++n}: ${msg}`);

export default async function ({ session, wm, dialogs, store }) {
  assert.ok(fixtures, 'CONVERT_FIXTURES is not set (run tests/convert/run.sh)');
  const sample = fs.readFileSync(path.join(fixtures, 'sample.md'), 'utf8');
  const recentFile = path.join(store.dataDir(session.appId), 'recent.json');

  await wm.waitForWindows(1, 20000);
  assert.equal(wm.windows.get(1).params.entry, 'index.html');
  assert.equal(wm.windows.get(1).params.title, 'Markdown Viewer');
  ok('window created: index.html, title "Markdown Viewer"');

  if (phase === '1') {
    assert.deepEqual(await wm.invoke(1, 'recent:list'), []);
    ok('recent:list is empty on a fresh install');

    // open-file without a path -> the native open dialog (answered with --open <fixture>)
    const file = await wm.invoke(1, 'open-file');
    assert.equal(dialogs.calls.filter((c) => c.kind === 'open').length, 1);
    assert.equal(file.name, 'sample.md');
    assert.match(file.path, /^\/host\/pick-\d+\/sample\.md$/);
    assert.equal(file.content, sample);
    ok(`open-file via the dialog returned ${file.path} with the exact file content (${file.content.length} chars)`);

    // the open dialog was Electron-style: properties openFile
    const call = dialogs.calls.find((c) => c.kind === 'open');
    assert.equal(call.params.directory, false);
    ok('dialog.showOpenDialog(properties:["openFile"]) reached the host as a file pick');

    // open-file with a path that does not exist -> a rejected promise carrying the message
    await assert.rejects(wm.invoke(1, 'open-file', '/nonexistent/missing.md'), /ENOENT/);
    ok('open-file with a missing path rejects with ENOENT');

    // open-file with the path just returned reads the same file again (what a click in "Recent" does)
    const again = await wm.invoke(1, 'open-file', file.path);
    assert.equal(again.content, sample);
    ok('open-file with an explicit path re-reads the picked file');

    await assert.rejects(wm.invoke(1, 'recent:add', { nope: true }), /needs \{ path, name \}/);
    ok('recent:add validates its argument');

    const list = await wm.invoke(1, 'recent:add', { path: file.path, name: file.name });
    assert.equal(list.length, 1);
    assert.deepEqual(await wm.invoke(1, 'recent:list'), list);
    ok('recent:add stored one entry and recent:list returns it');

    const disk = JSON.parse(fs.readFileSync(recentFile, 'utf8'));
    assert.equal(disk.length, 1);
    assert.equal(disk[0].name, 'sample.md');
    ok(`recent.json is in the app's data folder on the host: ${recentFile}`);
  } else {
    // second run: a new VM, the same /data
    const list = await wm.invoke(1, 'recent:list');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'sample.md');
    ok('recent list survived to a second run (a new VM; /data persisted)');

    // add a second entry; the list is newest first and deduplicated by path
    const second = await wm.invoke(1, 'recent:add', { path: '/host/pick-9/other.md', name: 'other.md' });
    assert.deepEqual(second.map((e) => e.name), ['other.md', 'sample.md']);
    const dedup = await wm.invoke(1, 'recent:add', { path: list[0].path, name: 'sample.md' });
    assert.deepEqual(dedup.map((e) => e.name), ['sample.md', 'other.md']);
    ok('recent list is newest first and deduplicated by path');
  }
  console.log(`MDVIEWER-OK phase ${phase}`);
}
