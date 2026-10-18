'use strict';
// Dev convenience: make sure every runtime image shipped next to the binaries (vmapp/out/runtimes) is installed in
// $VMAPP_HOME/runtimes, re-installing when the size or the modification time differs.

const fs = require('fs');
const path = require('path');
const { RUNTIMES } = require('../../hostlib/manifest');

/** Returns { installed: [names copied], current: [names already up to date] }. */
function syncRuntimes(store, srcDir, log = () => {}) {
  const out = { installed: [], current: [] };
  let files;
  try {
    files = fs.readdirSync(srcDir);
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const m = /^([a-z0-9][a-z0-9-]*)\.img$/.exec(f);
    if (!m || !RUNTIMES.includes(m[1])) continue;
    const name = m[1];
    const src = path.join(srcDir, f);
    const sst = fs.statSync(src);
    const dest = store.runtimePath(name);
    let dst = null;
    try {
      dst = fs.statSync(dest);
    } catch {
      /* not installed yet */
    }
    if (dst && dst.size === sst.size && Math.floor(dst.mtimeMs) === Math.floor(sst.mtimeMs)) {
      out.current.push(name);
      continue;
    }
    log(`installing runtime ${name} (${sst.size} bytes)`);
    store.installRuntime(name, src);
    fs.utimesSync(dest, sst.atime, sst.mtime); // so the next start can tell it is current
    out.installed.push(name);
  }
  return out;
}

module.exports = { syncRuntimes };
