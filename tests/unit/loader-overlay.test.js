'use strict';
// The virtual-input overlay must never intercept a real click or take the focus (SPEC 8.2, INV-H3). The loader's CDP run G
// checks the real windows (ignoreMouseEvents, focusable, alwaysOnTop, contentProtected through the VMAPP_TEST_OVERLAY_LOG
// probe); this test guards the SOURCE, so a later edit cannot quietly weaken it, and the pages' shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LOADER = path.join(__dirname, '..', '..', 'loader');
const read = (...p) => fs.readFileSync(path.join(LOADER, ...p), 'utf8');
const count = (s, re) => (s.match(re) || []).length;

test('overlay.js: click-through, not focusable, always on top, content-protected, and never turned back', () => {
  const src = read('src', 'overlay.js');
  assert.ok(count(src, /win\.setIgnoreMouseEvents\(true\)/g) >= 2, 'ignores mouse events when created and again when shown');
  const calls = src.match(/setIgnoreMouseEvents\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2 && calls.every((c) => c === 'setIgnoreMouseEvents(true)'), `no call turns click-through off: ${calls.join(' ')}`);
  assert.match(src, /focusable:\s*false/);
  assert.match(src, /setContentProtection\(true\)/);
  assert.match(src, /setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(src, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true/);
  assert.match(src, /hasShadow:\s*false/);
  assert.match(src, /transparent:\s*true/);
  assert.match(src, /frame:\s*false/);
  assert.ok(!/\.focus\(\)|\.show\(\)/.test(src.replace(/showInactive\(\)/g, '')), 'it is shown with showInactive only (the app in front keeps the focus)');
});

test('overlay page: transparent, pointer-events none, no inline script or style, only draws what the loader sends', () => {
  const html = read('ui', 'overlay.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script');
  assert.ok(!/\sstyle=/i.test(html), 'no inline style attribute');
  const css = read('ui', 'overlay.css');
  assert.match(css, /background:\s*transparent/);
  assert.match(css, /pointer-events:\s*none/);
  const js = read('ui', 'overlay.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), 'text is inserted as text');
  const preload = read('preload-loader.js');
  assert.match(preload, /exposeInMainWorld\('overlay', \{\s*onEvent: [^\n]*\n\s*ready: [^\n]*\n\s*\}\)/, 'the overlay page can only listen and say ready');
});

test('the picker and the region window are loader pages with the same hardening as the other loader windows', () => {
  for (const f of ['src/capture-picker.js', 'src/region-select.js', 'src/overlay.js']) {
    const src = read(...f.split('/'));
    for (const want of [/contextIsolation:\s*true/, /sandbox:\s*true/, /nodeIntegration:\s*false/, /webSecurity:\s*true/, /webviewTag:\s*false/, /devTools:\s*!this\.cfg\.isPackaged/]) assert.match(src, want, `${f}: ${want}`);
  }
  for (const f of ['picker.html', 'region.html', 'overlay.html']) {
    const html = read('ui', f);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f}: no inline script`);
    assert.ok(!/\son\w+=/i.test(html), `${f}: no inline handlers`);
  }
  // every IPC handler of the new windows checks the sender
  for (const f of ['src/capture-picker.js', 'src/region-select.js', 'src/overlay.js']) {
    const src = read(...f.split('/'));
    assert.match(src, /event\.sender\.id/, `${f}: the sender decides`);
    assert.match(src, /event\.senderFrame !== event\.sender\.mainFrame/, `${f}: only the main frame`);
  }
});

// ------------------------------------------------------------------------------------------------ typed text is masked

/** Loads loader/src/overlay.js with a stand-in for Electron (the logic under test needs no windows). */
function loadOverlay() {
  const Module = require('module');
  const orig = Module._load;
  const fake = { BrowserWindow: class {}, ipcMain: { on() {} }, screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }), on() {}, removeListener() {} } };
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : orig.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../../loader/src/overlay')];
    return require('../../loader/src/overlay').Overlay;
  } finally {
    Module._load = orig;
  }
}

function overlayWith(prefs) {
  const Overlay = loadOverlay();
  const ov = new Overlay({ cfg: { isPackaged: false }, senders: new Map(), prefs });
  ov.on = true;
  const shown = [];
  ov._sendCaption = (t) => shown.push(t);
  const type = (ev) => (ov.activity(Object.assign({ kind: 'keys' }, ev)), shown.at(-1));
  return { ov, shown, type };
}

test('overlay: typed text is MASKED by default ("typing… (N characters)"); key combinations are still shown', () => {
  const { type, ov } = overlayWith(undefined); // no preferences at all: masked
  assert.equal(type({ text: 'hunter2' }), 'typing… (7 characters)');
  assert.equal(ov.model.caption, 'typing… (7 characters)');
  assert.equal(type({ key: 's', modifiers: ['cmd'] }), '⌘S');
  assert.equal(type({ key: 'return' }), '↩');
  const off = overlayWith({ get: () => false });
  assert.equal(off.type({ text: 'hunter2' }), 'typing… (7 characters)');
  const odd = overlayWith({ get: () => 'true' }); // anything but exactly true keeps the mask
  assert.equal(odd.type({ text: 'hunter2' }), 'typing… (7 characters)');
  const broken = overlayWith({ get: () => { throw new Error('unreadable'); } }); // when in doubt, mask
  assert.equal(broken.type({ text: 'hunter2' }), 'typing… (7 characters)');
});

test('overlay: characters typed one key at a time are counted together while the caption is still on screen', () => {
  const { type } = overlayWith({ get: () => false });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal(type({ key: 'p' }), 'typing… (1 character)');
    now += 400;
    assert.equal(type({ key: 'a' }), 'typing… (2 characters)');
    now += 400;
    assert.equal(type({ text: 'ssword' }), 'typing… (8 characters)');
    now += 400;
    assert.equal(type({ key: 'return' }), '↩', 'a named key is shown and ends the count');
    now += 400;
    assert.equal(type({ key: 'x' }), 'typing… (1 character)', 'a new count');
    now += 3000;
    assert.equal(type({ text: 'abc' }), 'typing… (3 characters)', 'a pause longer than the caption starts a new count');
  } finally {
    Date.now = realNow;
  }
});

test('overlay: "Show typed text in the overlay" shows the first 28 characters, and turning it off masks again at once', () => {
  const prefs = { value: true, get(name) { return name === 'overlayShowTyped' ? this.value : undefined; } };
  const { type } = overlayWith(prefs);
  assert.equal(type({ text: 'Hello, world! This is a long sentence that goes on' }), 'Hello, world! This is a long…');
  assert.equal(type({ text: 'abc' }), 'abc');
  assert.equal(type({ key: 'p' }), 'P');
  prefs.value = false;
  assert.equal(type({ text: 'abc' }), 'typing… (3 characters)', 'read at every keystroke');
  prefs.value = true;
  assert.equal(type({ text: 'abc' }), 'abc');
});

test('overlay: the caption in the test probe is the masked one (typed text never reaches the log by default)', () => {
  const src = read('src', 'overlay.js');
  assert.match(src, /const text = this\._keysCaption\(ev\);[\s\S]{0,200}this\._probe\(\{ event: 'activity', kind: 'keys', caption: text \}\)/, 'the probe logs the caption the user sees');
  assert.ok(!/ev\.text/.test(src), 'overlay.js never touches the raw typed text itself; host-text.js turns it into a caption');
});
