'use strict';
// App menus (SPEC 7 "Menus", DEV-APPS C9): hostlib/menus.js validates the template every app gives (page or core) and turns it into
// the Electron template the loader builds; the session's menu.set; the SDK's Electron-compatible Menu end to end with the fake VM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMenuTemplate, toElectronTemplate, normalizeAccelerator, MenuError } = require('../../hostlib/menus');

const FILE = { label: 'File', submenu: [{ id: 'new', label: 'New File', accelerator: 'CmdOrCtrl+N' }, { type: 'separator' }, { id: 'save', label: 'Save', accelerator: 'Cmd+S' }] };

test('a valid template is kept, normalised, and counted', () => {
  const v = validateMenuTemplate([
    FILE,
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'copy', label: 'Copy' }, { role: 'paste' }] },
    { label: 'View', submenu: [{ id: 'wrap', label: 'Word Wrap', type: 'checkbox', checked: true }, { label: 'Appearance', submenu: [{ id: 'zen', label: 'Zen Mode', enabled: false }] }] },
  ]);
  assert.equal(v.items, 9);
  assert.deepEqual(v.dropped, []);
  assert.deepEqual(v.menus[0].submenu[0], { type: 'normal', id: 'new', label: 'New File', accelerator: 'CmdOrCtrl+N' });
  assert.deepEqual(v.menus[2].submenu[1], { type: 'submenu', label: 'Appearance', submenu: [{ type: 'normal', id: 'zen', label: 'Zen Mode', enabled: false }] });
  assert.deepEqual(v.menus[1].submenu[0], { type: 'normal', role: 'undo' });
});

test('the loader keeps Cmd+Q, Cmd+H and Alt+Cmd+H: such a shortcut is dropped, the item stays', () => {
  const v = validateMenuTemplate([{ label: 'App', submenu: [{ id: 'q', label: 'Quit Editor', accelerator: 'CmdOrCtrl+Q' }, { id: 'h', label: 'Hide', accelerator: 'Command+H' }, { id: 'ho', label: 'Hide Others', accelerator: 'Option+Cmd+H' }, { id: 'p', label: 'Palette', accelerator: 'Shift+Cmd+P' }] }]);
  assert.deepEqual(v.dropped, ['CmdOrCtrl+Q', 'Command+H', 'Option+Cmd+H']);
  assert.deepEqual(v.menus[0].submenu.map((i) => [i.id, i.accelerator]), [['q', undefined], ['h', undefined], ['ho', undefined], ['p', 'Shift+Cmd+P']]);
});

test('accelerators: Electron grammar only', () => {
  for (const ok of ['CmdOrCtrl+S', 'Cmd+Shift+P', 'Alt+F4', 'Ctrl+`', 'Cmd+Plus', 'Cmd+=', 'Cmd+[', 'F12', 'Shift+Delete', 'CommandOrControl+Alt+Down', 'Cmd+num5', 'Cmd++']) {
    assert.ok(normalizeAccelerator(ok), ok);
  }
  for (const bad of ['', 'Cmd+', 'Cmd+Cmd+S', 'Hyper+S', 'Cmd+Shift', 'Cmd+SS', 'Cmd+F25', 'Cmd+é', 'x'.repeat(70)]) {
    assert.equal(normalizeAccelerator(bad), null, bad);
  }
  assert.equal(normalizeAccelerator('Shift+Cmd+P'), normalizeAccelerator('Cmd+Shift+P'), 'order does not matter');
  assert.equal(normalizeAccelerator('Command+Q'), 'cmd+q');
});

test('refused: unknown keys, roles and types; bad shapes; duplicate ids; limits', () => {
  const bad = (t, re) => assert.throws(() => validateMenuTemplate(t), (e) => e instanceof MenuError && re.test(e.message), re.source);
  bad({}, /must be an array/);
  bad([{ label: 'X' }], /submenu must be an array/);
  bad([{ label: 'X', submenu: [], click: 1 }], /click is not a known key/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A', click: () => 1 }] }], /click is not a known key/);
  bad([{ label: 'X', submenu: [{ role: 'quit' }] }], /role must be one of/);
  bad([{ label: 'X', submenu: [{ role: 'toggleDevTools' }] }], /role must be one of/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A', type: 'button' }] }], /type must be one of/);
  bad([{ label: 'X', submenu: [{ label: 'A' }] }], /id must be a string/);
  bad([{ label: 'X', submenu: [{ id: '', label: 'A' }] }], /must not be empty/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }], /not unique/);
  bad([{ label: 'X', submenu: [{ id: 'a' }] }], /label is required/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A', accelerator: 'Cmd+Ü' }] }], /not a valid shortcut/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A', enabled: 'yes' }] }], /must be a boolean/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A\u0007' }] }], /control characters/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'x'.repeat(121) }] }], /longer than 120/);
  bad([{ label: 'X', submenu: [{ id: 'a', label: 'A', type: 'normal', submenu: [] }] }], /submenu needs type "submenu"/);
  bad(Array.from({ length: 17 }, (_, i) => ({ label: `M${i}`, submenu: [] })), /at most 16/);
  let deep = [{ id: 'leaf', label: 'Leaf' }];
  for (let i = 0; i < 6; i++) deep = [{ label: `L${i}`, submenu: deep }];
  bad([{ label: 'X', submenu: deep }], /at most 5 levels/);
  bad([{ label: 'X', submenu: Array.from({ length: 4001 }, (_, i) => ({ id: `i${i}`, label: 'I' })) }], /at most 4000/);
});

test('toElectronTemplate: ids become app:<id> with a click that reports the id; roles stay Electron roles; nothing else', () => {
  const clicked = [];
  const v = validateMenuTemplate([FILE, { label: 'Edit', submenu: [{ role: 'copy' }] }]);
  const t = toElectronTemplate(v.menus, (id) => clicked.push(id));
  assert.equal(t[0].submenu[0].id, 'app:new');
  t[0].submenu[2].click();
  assert.deepEqual(clicked, ['save']);
  assert.deepEqual(t[1].submenu[0], { type: 'normal', role: 'copy' });
  assert.equal(t[0].submenu[1].type, 'separator');
  assert.deepEqual(Object.keys(t[0].submenu[0]).sort(), ['accelerator', 'click', 'id', 'label', 'type']);
});
