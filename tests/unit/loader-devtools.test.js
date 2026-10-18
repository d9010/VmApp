'use strict';
// Who may have DevTools (loader/src/devtools.js, SPEC 7, INV-B1): pure functions, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../loader/src/devtools');

test('only an app window its core created with devTools: true may open DevTools', () => {
  assert.equal(D.allowedFor({ appId: 'com.example.a', win: 1, devTools: true }), true);
  assert.equal(D.allowedFor({ appId: 'com.example.a', win: 1, devTools: false }), false);
  assert.equal(D.allowedFor({ appId: 'com.example.a', win: 1 }), false, 'a record without the flag is off');
  assert.equal(D.allowedFor(undefined), false, 'a loader window (no registry record) is never allowed');
  assert.equal(D.allowedFor(null), false);
  for (const v of ['true', 1, {}, []]) assert.equal(D.allowedFor({ devTools: v }), false, `only the boolean true counts (${JSON.stringify(v)})`);
});

test('the devtools-opened closer: closes loader windows and app windows created without devTools, where it enforces', () => {
  assert.equal(D.mustClose(undefined, true), true, 'loader window: close');
  assert.equal(D.mustClose({ appId: 'x', devTools: false }, true), true, 'app window created with devTools: false: close');
  assert.equal(D.mustClose({ appId: 'x', devTools: true }, true), false, 'app window created with devTools: true: keep');
  assert.equal(D.mustClose(undefined, false), false, 'not enforcing (a dev build): nothing is closed');
  assert.equal(D.mustClose({ appId: 'x', devTools: false }, false), false);
});
