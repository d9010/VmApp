// Notes (node22 runtime): list, edit + save, create, delete (confirm / cancel), export to a write-only folder,
// import through the open dialog, settings in userData, and refusal of bad names.
// Run by run-all.sh with: --open <fixtures>/import/ideas.txt, folders granted to <fixtures>/notes and <fixtures>/export.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emitted, ok, requireEnv, waitFor, waitForFile } from './lib.mjs';

export default async function ({ session, wm, dialogs, store }) {
  const fix = requireEnv('APPS_FIX');
  const notesDir = path.join(fix, 'notes');
  const exportDir = path.join(fix, 'export');
  const importFile = path.join(fix, 'import', 'ideas.txt');
  const settingsFile = path.join(store.dataDir(session.appId), 'settings.json');

  await wm.waitForWindows(1, 20000);
  const win = 1;
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  assert.equal(wm.windows.get(win).params.title, 'Notes');
  ok('window created: index.html, title "Notes"');

  // list ------------------------------------------------------------------------------------------------
  const status = await wm.invoke(win, 'notes:status');
  assert.equal(status.notesGranted, true);
  assert.equal(status.exportGranted, true);
  assert.deepEqual(status.notes.map((n) => n.name), ['alpha.md', 'beta.md']);
  assert.equal(status.last, null);
  ok('status: both folders granted, notes alpha.md and beta.md listed from /host/f-notes');

  // open + edit + save ----------------------------------------------------------------------------------
  const alpha = await wm.invoke(win, 'notes:read', 'alpha.md');
  assert.equal(alpha, fs.readFileSync(path.join(notesDir, 'alpha.md'), 'utf8'));
  const edited = alpha + '\nEdited in the VM: **saved**.\n';
  await wm.invoke(win, 'notes:save', 'alpha.md', edited);
  assert.equal(fs.readFileSync(path.join(notesDir, 'alpha.md'), 'utf8'), edited);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).last, 'alpha.md');
  ok('edit saved on the host (read/write share) and the last-opened note is in userData/settings.json');

  // create -----------------------------------------------------------------------------------------------
  const created = await wm.invoke(win, 'notes:create', 'Fresh');
  assert.equal(created.name, 'Fresh.md');
  assert.ok(fs.existsSync(path.join(notesDir, 'Fresh.md')));
  const changed = emitted(wm, win, 'notes:changed').at(-1)[0];
  assert.ok(changed.some((n) => n.name === 'Fresh.md'), 'notes:changed carries the new list');
  ok('new note created on the host and notes:changed emitted');

  // delete: cancel, then confirm ------------------------------------------------------------------------
  dialogs.opts.message = 1; // "Cancel"
  assert.deepEqual(await wm.invoke(win, 'notes:delete', 'Fresh.md'), { deleted: false });
  assert.ok(fs.existsSync(path.join(notesDir, 'Fresh.md')));
  dialogs.opts.message = 0; // "Delete"
  assert.deepEqual(await wm.invoke(win, 'notes:delete', 'Fresh.md'), { deleted: true });
  assert.ok(!fs.existsSync(path.join(notesDir, 'Fresh.md')));
  const msgs = dialogs.calls.filter((c) => c.kind === 'message');
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0].params.buttons, ['Delete', 'Cancel']);
  assert.match(msgs[0].params.message, /Fresh\.md/);
  ok('delete asks dialog.showMessageBox; Cancel keeps the file, Delete removes it');

  // export -----------------------------------------------------------------------------------------------
  const exportedLines = [];
  session.on('exported', (e) => exportedLines.push(e));
  const text = '# Title <b>x</b>\n\nSome **bold**, *italic* and `code <i>`.\n\n- item 1\n- item 2\n\n```\nraw <script>alert(1)</script>\n```\n';
  const ex = await wm.invoke(win, 'notes:export', 'alpha.md', text);
  assert.equal(ex.file, 'alpha.html');
  const outFile = await waitForFile(path.join(exportDir, 'alpha.html'));
  const html = fs.readFileSync(outFile, 'utf8');
  assert.match(html, /<h1>Title &lt;b&gt;x&lt;\/b&gt;<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code &lt;i&gt;<\/code>/);
  assert.match(html, /<ul>\s*<li>item 1<\/li>\s*<li>item 2<\/li>\s*<\/ul>/);
  assert.match(html, /<pre><code>raw &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.ok(!/<script>alert/.test(html), 'user HTML is escaped');
  assert.ok(!fs.existsSync(outFile + '.partial'));
  await waitFor(() => exportedLines.length > 0 || emitted(wm, win, 'notes:exported').length > 0, { what: 'exported notification' });
  assert.deepEqual(emitted(wm, win, 'notes:exported')[0][0], { file: 'alpha.html' });
  ok('export delivered to the export folder as alpha.html (.partial renamed), Markdown converted and HTML escaped');

  // import via the open dialog ---------------------------------------------------------------------------
  const imp = await wm.invoke(win, 'notes:import');
  assert.deepEqual(imp, { canceled: false, name: 'ideas.md' });
  assert.equal(fs.readFileSync(path.join(notesDir, 'ideas.md'), 'utf8'), fs.readFileSync(importFile, 'utf8'));
  const openCall = dialogs.calls.find((c) => c.kind === 'open');
  assert.equal(openCall.params.directory, false);
  assert.equal(openCall.params.multiple, false);
  ok('import: picked file read from /host/pick-N and added as ideas.md in the notes folder');

  // importing the same file again must not overwrite ----------------------------------------------------
  const imp2 = await wm.invoke(win, 'notes:import');
  assert.equal(imp2.name, 'ideas (1).md');
  ok('a second import of the same file gets a new name instead of overwriting');

  // cancelled import --------------------------------------------------------------------------------------
  const savedOpen = dialogs.opts.open;
  dialogs.opts.open = null;
  assert.deepEqual(await wm.invoke(win, 'notes:import'), { canceled: true });
  dialogs.opts.open = savedOpen;
  ok('a cancelled open dialog changes nothing');

  // bad names ------------------------------------------------------------------------------------------------
  for (const bad of ['../evil', 'a/b.md', '.hidden', '']) {
    await assert.rejects(() => wm.invoke(win, 'notes:read', bad), /Invalid note name/);
    await assert.rejects(() => wm.invoke(win, 'notes:save', bad, 'x'), /Invalid note name/);
  }
  ok('path traversal and invalid note names are rejected');

  // settings + final list ----------------------------------------------------------------------------------
  const finalStatus = await wm.invoke(win, 'notes:status');
  assert.deepEqual(finalStatus.notes.map((n) => n.name), ['alpha.md', 'beta.md', 'ideas (1).md', 'ideas.md']);
  // settings.json in /data must keep working after a dialog grant (regression test for the stale-mount bug)
  assert.equal(finalStatus.last, 'ideas (1).md', 'settings saved after the import dialog');
  ok('final list is correct; settings saved after a dialog');

  // closing the only window quits the app (Electron default, provided by the SDK) ---------------------
  wm.userClose(win);
  const stopped = await Promise.race([session.whenStopped(), new Promise((r) => setTimeout(() => r(null), 15000))]);
  assert.ok(stopped, 'the app stops after its last window closes');
  assert.ok(['core-exited', 'shutdown'].includes(session.stoppedInfo.reason), session.stoppedInfo.reason);
  assert.equal(session.stoppedInfo.exitCode, 0);
  ok('closing the last window quits the app (exit code 0)');
  console.log('NOTES-OK');
}
