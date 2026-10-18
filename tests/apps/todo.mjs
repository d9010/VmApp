// Todo (dotnet8 runtime, C# core). Two phases, each a separate VM run (run-all.sh sets TODO_PHASE):
//   1: add / toggle / delete / clear-completed, "changed" emits, window title count, /data/todos.json on the host
//   2: a SECOND run sees the todos persisted in appdata, and the window opens with the right count in its title
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emitted, ok, waitFor } from './lib.mjs';

const texts = (list) => list.map((t) => t.text);

export default async function ({ session, wm, store }) {
  const phase = process.env.TODO_PHASE || '1';
  const win = 1;
  const dataFile = path.join(store.dataDir(session.appId), 'todos.json');
  const titleIs = (re) => waitFor(() => re.test(wm.windows.get(win).title), { what: `window title ${re}` });
  const onDisk = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  await wm.waitForWindows(1, 30000);
  assert.equal(wm.windows.get(win).params.entry, 'index.html');

  if (phase === '1') {
    assert.equal(wm.windows.get(win).params.title, '0 open tasks');
    assert.deepEqual(await wm.invoke(win, 'todo:list'), []);
    ok('first run: empty list, window created with title "0 open tasks"');

    const a = await wm.invoke(win, 'todo:add', 'Buy milk');
    assert.deepEqual(texts(a), ['Buy milk']);
    await wm.invoke(win, 'todo:add', '  Write the report  ');
    const list3 = await wm.invoke(win, 'todo:add', 'Call mom');
    assert.deepEqual(texts(list3), ['Buy milk', 'Write the report', 'Call mom']);
    assert.ok(list3.every((t) => t.done === false && Number.isInteger(t.id)));
    assert.equal(new Set(list3.map((t) => t.id)).size, 3);
    await assert.rejects(() => wm.invoke(win, 'todo:add', '   '), /Type something/);
    await titleIs(/^3 open tasks$/);
    assert.deepEqual(texts(onDisk()), ['Buy milk', 'Write the report', 'Call mom']);
    ok('add x3 (trimmed, unique ids), empty text refused, title "3 open tasks", /data/todos.json written to the host');

    const ids = Object.fromEntries(list3.map((t) => [t.text, t.id]));
    const toggled = await wm.invoke(win, 'todo:toggle', ids['Buy milk']);
    assert.deepEqual(toggled.map((t) => t.done), [true, false, false]);
    await titleIs(/^2 open tasks$/);
    const back = await wm.invoke(win, 'todo:toggle', ids['Buy milk']);
    assert.equal(back[0].done, false);
    await titleIs(/^3 open tasks$/);
    await wm.invoke(win, 'todo:toggle', ids['Buy milk']);
    await titleIs(/^2 open tasks$/);
    ok('toggle done / undone / done again updates the title count');

    const afterDelete = await wm.invoke(win, 'todo:delete', ids['Call mom']);
    assert.deepEqual(texts(afterDelete), ['Buy milk', 'Write the report']);
    await assert.rejects(() => wm.invoke(win, 'todo:delete', 987654321), /No such task/);
    await titleIs(/^1 open task$/);
    ok('delete removes the item (unknown id refused), title "1 open task"');

    await wm.invoke(win, 'todo:add', 'Throw away');
    await wm.invoke(win, 'todo:toggle', (await wm.invoke(win, 'todo:list')).find((t) => t.text === 'Throw away').id);
    const cleared = await wm.invoke(win, 'todo:clear-completed');
    assert.deepEqual(texts(cleared), ['Write the report']);
    await titleIs(/^1 open task$/);
    ok('clear-completed removes every done item');

    // add one more so phase 2 sees: Write the report (open), Buy milk is gone after clear? keep a known final state
    await wm.invoke(win, 'todo:add', 'Persisted item');
    const last = await wm.invoke(win, 'todo:toggle', (await wm.invoke(win, 'todo:list')).find((t) => t.text === 'Persisted item').id);
    assert.deepEqual(last.map((t) => [t.text, t.done]), [['Write the report', false], ['Persisted item', true]]);
    await titleIs(/^1 open task$/);

    const changes = emitted(wm, win, 'changed');
    assert.ok(changes.length >= 10, `"changed" emitted after every change (${changes.length})`);
    assert.deepEqual(changes.at(-1)[0].map((t) => [t.text, t.done]), [['Write the report', false], ['Persisted item', true]]);
    assert.deepEqual(onDisk().map((t) => [t.text, t.done]), [['Write the report', false], ['Persisted item', true]]);
    ok(`"changed" emitted ${changes.length} times; final state on disk: Write the report (open), Persisted item (done)`);
  } else {
    // second run: nothing was added in this VM, yet the list is there
    assert.equal(wm.windows.get(win).params.title, '1 open task');
    const list = await wm.invoke(win, 'todo:list');
    assert.deepEqual(list.map((t) => [t.text, t.done]), [['Write the report', false], ['Persisted item', true]]);
    ok('second run: todos persisted in appdata, window opened with title "1 open task"');

    const more = await wm.invoke(win, 'todo:add', 'Added in run 2');
    assert.equal(more.length, 3);
    assert.equal(new Set(more.map((t) => t.id)).size, 3, 'ids stay unique across runs');
    await titleIs(/^2 open tasks$/);
    assert.equal(onDisk().length, 3);
    ok('a new item added in run 2 gets a fresh id; title "2 open tasks"');
  }

  // closing the window ends the core
  wm.userClose(win);
  const stopped = await Promise.race([session.whenStopped(), new Promise((r) => setTimeout(() => r(null), 15000))]);
  assert.ok(stopped, 'the VM stops after the window closed');
  assert.ok(['core-exited', 'shutdown'].includes(session.stoppedInfo.reason), session.stoppedInfo.reason);
  assert.equal(session.stoppedInfo.exitCode, 0);
  ok('window closed: the C# core exited with code 0');
  console.log(`TODO-${phase}-OK`);
}
