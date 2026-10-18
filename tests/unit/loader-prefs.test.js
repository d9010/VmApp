'use strict';
// The loader's own preferences (loader/src/prefs.js): "Show typed text in the overlay" is off by default, changed only through
// set(), persisted atomically, and a bad file or a bad value can never turn it on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LoaderPrefs, DEFAULTS } = require('../../loader/src/prefs');
const { tmpdir, rmrf } = require('./helpers');

function home(t) {
  const d = tmpdir('prefs-');
  t.after(() => rmrf(d));
  return d;
}

test('prefs: overlayShowTyped is off by default and nothing is written until the user changes it', (t) => {
  const d = home(t);
  const p = new LoaderPrefs({ home: d });
  assert.equal(p.get('overlayShowTyped'), false);
  assert.equal(p.get('experimentalGpuVulkan'), false, 'the experimental Vulkan backend (SPEC 8.7) is off by default');
  assert.deepEqual(p.all(), { overlayShowTyped: false, experimentalGpuVulkan: false });
  assert.deepEqual(DEFAULTS, { overlayShowTyped: false, experimentalGpuVulkan: false });
  assert.equal(fs.existsSync(path.join(d, 'loader-prefs.json')), false);
});

test('prefs: set is saved and read back by a new loader; setting the same value writes nothing', (t) => {
  const d = home(t);
  const p = new LoaderPrefs({ home: d });
  const seen = [];
  p.on('changed', (v) => seen.push(v));
  assert.deepEqual(p.set('overlayShowTyped', true), { overlayShowTyped: true, experimentalGpuVulkan: false });
  assert.equal(new LoaderPrefs({ home: d }).get('overlayShowTyped'), true, 'survives a restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'loader-prefs.json'), 'utf8')), { overlayShowTyped: true, experimentalGpuVulkan: false });
  p.set('overlayShowTyped', true);
  assert.equal(seen.length, 1, 'no change, no event');
  p.set('overlayShowTyped', false);
  assert.equal(new LoaderPrefs({ home: d }).get('overlayShowTyped'), false);
  assert.deepEqual(seen.map((v) => v.overlayShowTyped), [true, false]);
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.includes('.tmp-')), [], 'the temporary file is gone');
});

test('prefs: unknown names and values of the wrong type are refused', (t) => {
  const p = new LoaderPrefs({ home: home(t) });
  assert.throws(() => p.set('overlayShowTypedText', true), /unknown preference/);
  assert.throws(() => p.get('constructor'), /unknown preference/);
  assert.throws(() => p.get('__proto__'), /unknown preference/);
  for (const bad of ['true', 1, null, undefined, {}, []]) assert.throws(() => p.set('overlayShowTyped', bad), /must be a boolean/, String(bad));
  assert.equal(p.get('overlayShowTyped'), false);
});

test('prefs: a damaged or odd file leaves the defaults (it can never switch typed text on by accident)', (t) => {
  const d = home(t);
  const f = path.join(d, 'loader-prefs.json');
  const logs = [];
  for (const text of ['{ not json', '[]', 'null', '{"overlayShowTyped":"yes"}', '{"overlayShowTyped":1}', '{"other":true}']) {
    fs.writeFileSync(f, text);
    const p = new LoaderPrefs({ home: d, log: (l, m) => logs.push(`${l} ${m}`) });
    assert.equal(p.get('overlayShowTyped'), false, text);
  }
  assert.ok(logs.some((l) => /^warn .*loader-prefs\.json/.test(l)), 'unreadable JSON is reported');
  fs.writeFileSync(f, '{"overlayShowTyped":true,"unknown":1}');
  assert.equal(new LoaderPrefs({ home: d }).get('overlayShowTyped'), true, 'a valid value is read; unknown keys are ignored');
});

test('prefs: only the settings window writes them (source check)', () => {
  const root = path.join(__dirname, '..', '..', 'loader');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const settings = read('src', 'settings.js');
  assert.match(settings, /handle\('set:setPref'/);
  assert.match(settings, /this\.senders\.get\(event\.sender\.id\) !== 'settings'/, 'the settings handlers check the sender');
  // no other handler can change a preference
  for (const f of ['library.js', 'inspector.js', 'monitor.js', 'capture-picker.js', 'overlay.js', 'badge.js', 'window-manager.js']) {
    assert.ok(!/prefs\.set\(|setPref/.test(read('src', f)), `${f} cannot change a preference`);
  }
  assert.ok(!/setPref/.test(read('preload-app.js')), 'an app window has no way to reach the preferences');
});
