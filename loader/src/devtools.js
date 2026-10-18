'use strict';
// Who may have DevTools (SPEC 7, INV-B1). Pure decisions, so they can be unit-tested without Electron.
//
// - An app window gets DevTools only when the app's core asked for them in that window's `window.create`
//   (`devTools: true`, which the SDK sends for `new BrowserWindow({ webPreferences: { devTools: true } })`; the default is
//   false), in dev and in packaged builds alike. AppWindowManager sets webPreferences.devTools from that value and records
//   the same value in the window registry. The renderer cannot change it.
// - The loader's own windows (library, inspector, settings, badge) have DevTools in dev builds only.
// - The "Developer Tools" menu item / Alt+Cmd+I opens DevTools only for a focused app window created with devTools: true.
// - Where the loader enforces (packaged builds, and dev builds that run the CDP test's devtools probe), a `devtools-opened`
//   handler closes DevTools on every web contents this module does not allow: the loader's windows and app windows created
//   with devTools: false. It is the belt to webPreferences.devTools' braces.

/** `rec` is the window registry record of a web contents ({appId, win, devTools, ...}), or undefined for loader windows. */
function allowedFor(rec) {
  return !!rec && rec.devTools === true;
}

/** True when DevTools that just opened on this web contents must be closed. */
function mustClose(rec, enforce) {
  return !!enforce && !allowedFor(rec);
}

module.exports = { allowedFor, mustClose };
