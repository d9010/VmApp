'use strict';
// The pure parts of the screenshot picker and the region selection (loader/src/capture-logic.js): what is offered, what is
// preselected, how a drag becomes global points, and that the picker's answer is checked against what was offered.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../loader/src/capture-logic');

const HOSTCTL_DISPLAYS = [
  { display: 1, bounds: { x: 0, y: 0, w: 1440, h: 900 }, scale: 2, main: true, name: 'Built-in Retina Display', builtin: true },
  { display: 2, bounds: { x: 1440, y: 0, w: 1920, h: 1080 }, scale: 1, main: false, name: 'External Monitor', builtin: false },
];
const HOSTCTL_WINDOWS = [
  { windowId: 7, app: 'FakeApp', pid: 1, title: 'Fake window', bounds: { x: 0, y: 0, w: 100, h: 80 } },
  { windowId: 8, app: 'Notes', pid: 2, title: 'Shopping list', bounds: { x: 1500, y: 100, w: 500, h: 400 } },
  { windowId: 9, app: 'Mail', pid: 3, title: '', bounds: { x: 20, y: 20, w: 800, h: 600 } },
  { windowId: 10, app: 'Tooltip', pid: 4, title: 'tiny', bounds: { x: 0, y: 0, w: 20, h: 10 } },
  { windowId: 99, app: 'D9010 VmApp Launcher', pid: 4242, title: 'D9010 VmApp control badge', bounds: { x: 400, y: 0, w: 540, h: 46 } },
  { windowId: 11, app: 'Loader app window', pid: 4242, title: 'Host Caps Test', bounds: { x: 100, y: 100, w: 640, h: 420 } },
];

test('displays are offered with name, size and position; garbage is dropped', () => {
  const d = L.displaysForPage(HOSTCTL_DISPLAYS.concat([null, { display: 'x', bounds: {} }, { display: 3 }]));
  assert.deepEqual(d.map((x) => [x.display, x.name, x.main, x.bounds.w, x.bounds.h, x.bounds.x]), [[1, 'Built-in Retina Display', true, 1440, 900, 0], [2, 'External Monitor', false, 1920, 1080, 1440]]);
  assert.deepEqual(L.displaysForPage(undefined), []);
  assert.equal(L.displaysForPage([{ display: 5, bounds: { x: 0, y: 0, w: 1, h: 1 } }])[0].name, 'Display 5', 'a nameless display gets a plain name');
});

test('windows are offered without the loader’s own windows, tiny ones, and in a stable order', () => {
  const w = L.windowsForPage(HOSTCTL_WINDOWS, [4242]);
  assert.deepEqual(w.map((x) => x.windowId), [7, 9, 8], 'sorted by app (FakeApp, Mail, Notes); the loader’s windows and the 20×10 tooltip are not offered');
  assert.deepEqual(L.windowsForPage(HOSTCTL_WINDOWS, []).map((x) => x.windowId), [7, 11, 9, 8], 'without the exclusion the loader’s app window is offered (the 46-point-high badge is too small anyway)');
  assert.deepEqual(L.windowsForPage(undefined, [1]), []);
  assert.equal(L.windowsForPage(Array.from({ length: 200 }, (_, i) => ({ windowId: i, app: 'A', title: String(i).padStart(3, '0'), bounds: { x: 0, y: 0, w: 100, h: 100 } }))).length, 80, 'at most 80');
});

test('the picker opens with the app’s suggestion selected when it exists, else the main display', () => {
  const d = L.displaysForPage(HOSTCTL_DISPLAYS);
  const w = L.windowsForPage(HOSTCTL_WINDOWS, [4242]);
  assert.deepEqual(L.preselect({ target: 'display', display: 2 }, d, w), { selected: { kind: 'display', display: 2 }, suggested: true });
  assert.deepEqual(L.preselect({ target: 'display' }, d, w), { selected: { kind: 'display', display: 1 }, suggested: true }, 'no display named: the main one IS the suggestion');
  assert.deepEqual(L.preselect({ target: 'window', windowId: 8 }, d, w), { selected: { kind: 'window', windowId: 8 }, suggested: true });
  assert.deepEqual(L.preselect({ target: 'window', windowId: 99 }, d, w), { selected: { kind: 'display', display: 1 }, suggested: false }, 'a window that is not offered is not preselected');
  assert.deepEqual(L.preselect({ target: 'display', display: 77 }, d, w), { selected: { kind: 'display', display: 1 }, suggested: false });
  assert.deepEqual(L.preselect({ target: 'region', region: { x: 0, y: 0, w: 1, h: 1 } }, d, w), { selected: { kind: 'display', display: 1 }, suggested: false });
  assert.deepEqual(L.preselect(null, [], []), { selected: null, suggested: false });
  assert.deepEqual(L.preselect({ target: 'display' }, [{ display: 9, main: false, bounds: {} }], []).selected, { kind: 'display', display: 9 }, 'no main display flag: the first one');
});

test('a drag becomes global points on any display; tiny drags and nonsense are no selection', () => {
  // display 2 is to the right of the main display (origin x 1440); a display to the left has negative x
  assert.deepEqual(L.localToGlobal({ x: 10, y: 20, w: 300, h: 200 }, { x: 1440, y: 0 }), { x: 1450, y: 20, w: 300, h: 200 });
  assert.deepEqual(L.localToGlobal({ x: 10.4, y: 20.6, w: 300.2, h: 200.5 }, { x: -1920, y: -100 }), { x: -1910, y: -79, w: 300, h: 201 });
  assert.equal(L.localToGlobal({ x: 0, y: 0, w: 7, h: 300 }, { x: 0, y: 0 }), null, 'smaller than 8 points is a click');
  assert.equal(L.localToGlobal({ x: 0, y: 0, w: 300, h: 7.9 }, { x: 0, y: 0 }), null);
  assert.equal(L.localToGlobal({ x: 'a', y: 0, w: 300, h: 300 }, { x: 0, y: 0 }), null);
  assert.equal(L.localToGlobal(null, { x: 0, y: 0 }), null);
  assert.equal(L.localToGlobal({ x: 0, y: 0, w: NaN, h: 30 }, { x: 0, y: 0 }), null);
});

test('clipRect keeps the part of a rectangle that is on a display', () => {
  const b = { x: 1440, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(L.clipRect({ x: 1500, y: 100, w: 400, h: 300 }, b), { x: 1500, y: 100, w: 400, h: 300 });
  assert.deepEqual(L.clipRect({ x: 1400, y: -50, w: 200, h: 100 }, b), { x: 1440, y: 0, w: 160, h: 50 });
  assert.equal(L.clipRect({ x: 0, y: 0, w: 100, h: 100 }, b), null, 'nothing on this display');
  assert.equal(L.clipRect({ x: 3360, y: 0, w: 100, h: 100 }, b), null, 'touching the edge is not on it');
});

test('the picker’s answer must be one of the choices it offered', () => {
  const offered = { displays: L.displaysForPage(HOSTCTL_DISPLAYS), windows: L.windowsForPage(HOSTCTL_WINDOWS, [4242]), region: { x: 1500, y: 100, w: 400, h: 300, display: 2, suggested: true } };
  assert.deepEqual(L.targetFromChoice({ kind: 'display', display: 2 }, offered), { kind: 'display', display: 2 });
  assert.deepEqual(L.targetFromChoice({ kind: 'window', windowId: 8 }, offered), { kind: 'window', windowId: 8 });
  assert.deepEqual(L.targetFromChoice({ kind: 'region' }, offered), { kind: 'region', region: { x: 1500, y: 100, w: 400, h: 300 } }, 'the rectangle is the one the main process kept, not one the page sends');
  assert.deepEqual(L.targetFromChoice({ kind: 'region', region: { x: 0, y: 0, w: 5000, h: 5000 } }, offered), { kind: 'region', region: { x: 1500, y: 100, w: 400, h: 300 } });
  for (const bad of [null, 'display', {}, { kind: 'display', display: 3 }, { kind: 'window', windowId: 99 }, { kind: 'window', windowId: 10 }, { kind: 'window', windowId: '8' }, { kind: 'file' }]) {
    assert.equal(L.targetFromChoice(bad, offered), null, JSON.stringify(bad));
  }
  assert.equal(L.targetFromChoice({ kind: 'region' }, { ...offered, region: null }), null, 'no region was drawn');
});
