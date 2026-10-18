'use strict';
// Production hardening that does not need Electron (so the dev test can unit-test it).
//
// A packaged loader refuses to start when it was launched with a switch that opens a debugging or code-injection
// path into the main process or weakens Chromium's sandbox. The fuses (build/package.js) already make Node ignore
// --inspect*, NODE_OPTIONS and ELECTRON_RUN_AS_NODE; Chromium's own switches (--remote-debugging-port, ...) are
// not covered by fuses, so the loader checks for them itself.

// Matched against the switch name (without the leading dashes, without "=value"), case-insensitively.
const FORBIDDEN = [
  /^remote-debugging-.*$/,
  /^remote-allow-origins$/,
  /^inspect(-brk|-port|-publish-uid|-wait)?$/,
  /^debug(-brk|-port)?$/,
  /^js-flags$/,
  /^no-sandbox$/,
  /^disable-(web-security|site-isolation-trials|setuid-sandbox)$/,
  /^allow-(file-access-from-files|running-insecure-content)$/,
  /^use-fake-(device|ui)-for-media-stream$/, // the dev tests' fake microphone; a packaged loader only ever uses real, user-allowed ones
  /^enable-automation$/,
  /^user-data-dir$/,
  /^load-extension$/,
  /^disable-extensions-except$/,
];

/** Returns the forbidden switches found in argv (as written), e.g. ['--remote-debugging-port=9333']. */
function forbiddenSwitches(argv) {
  const found = [];
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0].toLowerCase();
    if (FORBIDDEN.some((re) => re.test(name))) found.push(a);
  }
  return found;
}

module.exports = { forbiddenSwitches };
