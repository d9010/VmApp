// Notes when the user declined both folders: no crash, an empty status the UI turns into an explanation,
// and clear errors for anything that needs a folder.
import assert from 'node:assert/strict';
import { ok } from './lib.mjs';

export default async function ({ wm }) {
  await wm.waitForWindows(1, 20000);
  const win = 1;
  const status = await wm.invoke(win, 'notes:status');
  assert.deepEqual(status, { notesGranted: false, exportGranted: false, last: null, notes: [] });
  ok('status reports both folders as not granted (the UI shows its empty state)');
  assert.deepEqual(await wm.invoke(win, 'notes:list'), []);
  await assert.rejects(() => wm.invoke(win, 'notes:save', 'x.md', 'text'), /notes folder has not been granted/);
  await assert.rejects(() => wm.invoke(win, 'notes:create', 'x'), /notes folder has not been granted/);
  await assert.rejects(() => wm.invoke(win, 'notes:export', 'x.md', 'text'), /export folder has not been granted/);
  ok('save, create and export fail with friendly messages');
  console.log('NOTES-EMPTY-OK');
}
