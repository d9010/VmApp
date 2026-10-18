'use strict';
// Which folders are too broad to share with an app without a second look (permission sheet and dialog.open folders).
//
//   refuse  never shareable: the file system root and the loader's own data dir (or anything inside it): sharing those
//           would expose every app's data, the grants and the runtimes to the app
//   warn    legal but dangerous: the user's home, /Users, /Volumes and a disk root /Volumes/<disk>, /System, /Library,
//           ~/Library, system directories, credential folders (~/.ssh ...), and any folder that CONTAINS the loader's
//           data dir (it would give the app everything below it, the data dir included)
//   ok      anything else
//
// Paths are compared after realpath, so /Volumes/Macintosh HD (a symlink to /) and symlinks into the data dir are
// caught. The check works on the literal path as well as the resolved one.

const fs = require('fs');
const path = require('path');
const os = require('os');

function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const norm = (p) => (p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p);
const isInside = (child, parent) => child === parent || (parent === path.sep ? true : child.startsWith(parent + path.sep));

/**
 * @param {string} p absolute folder path
 * @param {object} o
 * @param {string} o.dataDir the loader's data root ($VMAPP_HOME)
 * @param {string} [o.userHome] defaults to os.homedir()
 * @returns {{level:'ok'|'warn'|'refuse', reason:string}}
 */
function classifyFolder(p, { dataDir, userHome = os.homedir() }) {
  const forms = [...new Set([norm(path.resolve(p)), norm(real(p))])];
  const data = [...new Set([norm(path.resolve(dataDir)), norm(real(dataDir))])];
  const home = [...new Set([norm(path.resolve(userHome)), norm(real(userHome))])];
  const sys = (n) => forms.includes(n);

  if (forms.some((f) => f === path.sep)) return { level: 'refuse', reason: 'This is the whole disk (the root folder). It cannot be shared with an app.' };
  if (forms.some((f) => data.some((d) => isInside(f, d)))) {
    return { level: 'refuse', reason: 'This is where D9010 VmApp Launcher keeps its own data (every app’s files, permissions and runtimes). It cannot be shared with an app.' };
  }

  if (forms.some((f) => home.includes(f))) return { level: 'warn', reason: 'This is your whole home folder: the app would reach your documents, photos, keys and everything else in it.' };
  if (forms.some((f) => home.some((h) => f === path.join(h, 'Library')))) return { level: 'warn', reason: 'This is your Library folder: it holds app data, mail, browser profiles and keychains.' };
  for (const name of ['.ssh', '.aws', '.gnupg', '.config', '.kube']) {
    if (forms.some((f) => home.some((h) => f === path.join(h, name)))) return { level: 'warn', reason: `This folder (~/${name}) typically holds credentials or settings for other programs.` };
  }
  if (sys('/Users') || sys('/Volumes')) return { level: 'warn', reason: 'This folder contains every user’s home folder or every disk on this Mac.' };
  if (forms.some((f) => path.dirname(f) === '/Volumes')) return { level: 'warn', reason: 'This is the root of an entire disk: the app would reach everything on it.' };
  for (const s of ['/System', '/Library', '/Applications', '/private', '/usr', '/bin', '/sbin', '/etc', '/var', '/opt', '/cores']) {
    if (forms.some((f) => f === s)) return { level: 'warn', reason: `This is a system folder (${s}). Apps normally have no business there.` };
  }
  if (forms.some((f) => data.some((d) => isInside(d, f)))) {
    return { level: 'warn', reason: 'This folder contains D9010 VmApp Launcher’s own data folder, so the app would also reach every other app’s files and permissions.' };
  }
  return { level: 'ok', reason: '' };
}

module.exports = { classifyFolder };
