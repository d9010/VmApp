'use strict';
// "Load examples": the sample apps that travel with the loader, listed and installed from the library window.
//   packaged: <Resources>/vmapp/examples/   (*.vmapp and README.md, copied by build/package.mjs --with-examples)
//   dev:      vmapp/out/examples/           (tools/pack-examples), or $VMAPP_EXAMPLES_DIR (dev only, see src/config.js)
// This file is the pure part (no Electron): what a folder of packages looks like, what the sheet shows for each one (read from the
// PACKAGES themselves, never from the README), and the install loop with its skip and failure rules. The loader's IPC lives in
// src/library.js and installs through the very same path as "Install from file…" (Store.install after the full verification).
// Nothing here grants anything (GOVERNANCE INV-B5, INV-D3): an installed example has no grants file; its permission sheet comes at
// its first launch like any other app's.

const fs = require('fs');
const path = require('path');
const tar = require('../../hostlib/tar');
const { parseManifest, compareVersions } = require('../../hostlib/manifest');

const MAX_EXAMPLES = 64; // more files than this in the folder are not listed
const MAX_MANIFEST_PEEK = 1024 * 1024; // the manifest is the first entry of a package; anything bigger is not a manifest
const MAX_README = 256 * 1024;
const MAX_HINT = 500; // characters of a README cell shown in the sheet

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KiB' : n + ' B');
const ACCESS_WORDS = { read: 'read', readwrite: 'read & write', writeonly: 'write-only' };

/** A short name for a host capability (the same words the library's cards use). */
function hostShortName(cap) {
  if (cap === 'screen') return 'screen';
  if (cap === 'input') return 'mouse and keyboard';
  if (cap === 'gpu') return 'GPU';
  if (cap === 'tool:*') return 'tools';
  if (cap === 'mcp:*') return 'MCP servers';
  return cap.startsWith('tool:') ? `tool ${cap.slice(5)}` : `MCP server ${cap.slice(4)}`;
}

// ---------------------------------------------------------------------------------------------- the folder

/**
 * What the examples folder holds: [{name, file, size}] for every regular `*.vmapp` file (symlinks, folders and dot-files are
 * ignored), sorted by name with numbers in order (01-, 02-, ... 10-). A missing or unreadable folder is an empty list.
 */
function listPackageFiles(dir) {
  if (!dir || typeof dir !== 'string') return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.vmapp')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile()) out.push({ name, file, size: st.size });
    } catch {
      /* gone in the meantime */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return out.slice(0, MAX_EXAMPLES);
}

/**
 * {available, count, show, packaged, dir?}: whether there is anything to load, and whether the UI shows the feature at all.
 * A packaged loader without examples hides the button and the menu entry (`show: false`); a development loader always shows them
 * and explains how to make the examples when there are none. `dir` (a development path) is only given outside a packaged build.
 */
function infoOf(dir, packaged) {
  const count = listPackageFiles(dir).length;
  const info = { available: count > 0, count, show: !packaged || count > 0, packaged: !!packaged };
  if (!packaged) info.dir = dir;
  return info;
}

// ---------------------------------------------------------------------------------------------- reading a package

/**
 * The manifest of a .vmapp file, read from its first tar entry only (a few KiB, however big the package is). This is for LISTING:
 * the real check (every hash, the entry order, the limits) happens when the package is installed (hostlib/package.js `load`, called
 * by Store.install). Throws an Error with a plain message for something that is not a package.
 */
function peekManifest(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(tar.BLOCK);
    if (fs.readSync(fd, head, 0, tar.BLOCK, 0) < tar.BLOCK) throw new Error('it is too short to be a D9010 VmApp package');
    const sizeText = head.toString('latin1', 124, 136).replace(/[\0 ]+$/g, '').replace(/^ +/, '');
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('it is not a D9010 VmApp package (the first entry has no valid size)');
    const size = parseInt(sizeText, 8);
    if (size > MAX_MANIFEST_PEEK) throw new Error('the manifest (vmapp.json) is larger than 1 MiB');
    const padded = Math.ceil(size / tar.BLOCK) * tar.BLOCK;
    const body = Buffer.alloc(padded);
    if (fs.readSync(fd, body, 0, padded, tar.BLOCK) < padded) throw new Error('it is cut short in the middle of its manifest');
    let entries;
    try {
      entries = tar.readTar(Buffer.concat([head, body, Buffer.alloc(2 * tar.BLOCK)])); // the strict reader, on the first entry
    } catch (e) {
      throw new Error(e && e.message ? e.message : 'not a D9010 VmApp package');
    }
    if (entries.length !== 1 || entries[0].path !== 'vmapp.json' || entries[0].type !== 'file') throw new Error('the first entry must be vmapp.json');
    return parseManifest(Buffer.from(entries[0].data), { files: 'required' });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------- the README

const stripMarkdown = (s) =>
  String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](link) -> text
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The table of tools/pack-examples' README.md: `| File | What it shows | What to allow | Source |`, one row per package, the first cell
 * holding `` `01-starter.vmapp` (28K) ``. Returns {<file name>: {shows, allow}}. Anything that is not such a row is ignored; a
 * README that is missing, unreadable or not in this form simply gives an empty map (the sheet then derives the hint from the manifest).
 */
function parseReadme(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const m = /`([^`/\\]+\.vmapp)`/.exec(cells[0]);
    if (!m) continue;
    const shows = stripMarkdown(cells[1]).slice(0, MAX_HINT);
    const allow = stripMarkdown(cells[2]).slice(0, MAX_HINT);
    out[m[1]] = { shows, allow };
  }
  return out;
}

/** README.md of the examples folder, parsed; {} when there is none. */
function readReadme(dir) {
  try {
    const file = path.join(dir, 'README.md');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_README) return {};
    return parseReadme(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------- what the sheet shows

/**
 * The badges of an example, from its manifest (the authoritative request): [{kind, label, title}] with kind
 * 'network' | 'gpu' | 'host' | 'microphone', in this order. Network lists the hosts (the first three, then "+N more").
 */
function badgesOf(manifest) {
  const perm = (manifest && manifest.permissions) || {};
  const badges = [];
  const hosts = (perm.network || []).map((e) => e.host);
  if (hosts.length) {
    const shown = hosts.slice(0, 3).join(', ') + (hosts.length > 3 ? ` +${hosts.length - 3} more` : '');
    badges.push({ kind: 'network', label: `Network: ${shown}`, title: `Asks to reach: ${hosts.join(', ')}` });
  }
  const caps = perm.host || [];
  const gpu = caps.find((h) => h.cap === 'gpu');
  if (gpu) {
    badges.push({ kind: 'gpu', label: gpu.api === 'vulkan' ? 'GPU (experimental)' : 'GPU', title: 'Asks to run work on your Mac’s GPU' + (gpu.api === 'vulkan' ? ' through the experimental Vulkan backend' : '') });
  }
  const control = caps.filter((h) => h.cap !== 'gpu');
  if (control.length) {
    badges.push({ kind: 'host', label: 'Control of your computer', title: `Asks for: ${control.map((h) => hostShortName(h.cap)).join(', ')}` });
  }
  if ((perm.devices || []).some((d) => d.device === 'microphone')) {
    badges.push({ kind: 'microphone', label: 'Microphone', title: 'Asks to use your microphone' });
  }
  return badges;
}

/**
 * The "What to allow" hint when the README has none for this package, derived from what the manifest asks for.
 * Example: "notes folder (read & write); network api.example.com; microphone".
 */
function deriveAllow(manifest) {
  const perm = (manifest && manifest.permissions) || {};
  const parts = [];
  for (const f of perm.folders || []) parts.push(`${f.name} folder (${ACCESS_WORDS[f.access] || f.access})`);
  const hosts = (perm.network || []).map((e) => e.host);
  if (hosts.length) parts.push(`network ${hosts.join(', ')}`);
  for (const h of perm.host || []) parts.push(h.cap === 'gpu' ? `GPU${h.api === 'vulkan' ? ' (experimental)' : ''}` : hostShortName(h.cap));
  for (const d of perm.devices || []) parts.push(d.device);
  return parts.length ? parts.join('; ') : 'nothing up front';
}

/**
 * How an example relates to what is installed: {kind, installed}. kind is 'new' (nothing installed), 'update' (the package is
 * newer), 'same' or 'older' (the installed version is newer). The last two are skipped by the install.
 */
function statusOf(manifest, installedVersion) {
  if (!installedVersion) return { kind: 'new', installed: null };
  const c = compareVersions(manifest.version, installedVersion);
  return { kind: c > 0 ? 'update' : c === 0 ? 'same' : 'older', installed: installedVersion };
}

/**
 * One row of the sheet, read from the package itself: {file, id, name, version, publisher, description, size, sizeText, badges,
 * allow, allowFrom, status, runtime, runtimeMissing}. A package whose manifest cannot be read is {file, name: file, error, ...}
 * and cannot be selected. `readme` is parseReadme()'s map; `deps` = {currentVersion(id), hasRuntime(name)}.
 */
function describeExample(entry, readme, deps) {
  const base = { file: entry.name, size: entry.size, sizeText: fmtSize(entry.size) };
  let m;
  try {
    m = peekManifest(entry.file);
  } catch (e) {
    return Object.assign(base, { name: entry.name, version: '', description: '', publisher: '', badges: [], allow: '', allowFrom: null, status: null, error: e && e.message ? e.message : String(e) });
  }
  let installed = null;
  try {
    installed = deps.currentVersion(m.id);
  } catch {
    installed = null; // a damaged installation is shown by its card; here it is just "not installed"
  }
  let runtimeMissing = false;
  try {
    runtimeMissing = !deps.hasRuntime(m.runtime);
  } catch {
    runtimeMissing = true;
  }
  const fromReadme = readme && readme[entry.name] && readme[entry.name].allow ? readme[entry.name].allow : null;
  return Object.assign(base, {
    id: m.id,
    name: m.name,
    version: m.version,
    publisher: m.publisher || '',
    description: m.description || (readme && readme[entry.name] ? readme[entry.name].shows : '') || '',
    badges: badgesOf(m),
    allow: fromReadme || deriveAllow(m),
    allowFrom: fromReadme ? 'readme' : 'manifest',
    status: statusOf(m, installed),
    runtime: m.runtime,
    runtimeMissing,
  });
}

// ---------------------------------------------------------------------------------------------- the registry as the source

/**
 * The sample apps can also come from the launcher's own registry instead of a folder: the apps of the publisher whose DOMAIN the
 * registry has verified (D9010 Inc, d9010.com). That is the only thing that makes an app an example; a name, a description or a
 * company that an app merely claims never does. The domain is a constant of the launcher (a dev launcher may name another one, for
 * tests: src/config.js).
 */
const EXAMPLES_DOMAIN = 'd9010.com';

/** Is this Browse item (hostlib/updates.js browseItem) an app of the verified publisher `domain`? */
function isOfficial(item, domain = EXAMPLES_DOMAIN) {
  const p = item && item.publisher;
  return !!p && p.level === 'domain' && typeof p.domain === 'string' && p.domain.toLowerCase() === String(domain).toLowerCase();
}

/**
 * One row of the sheet for a registry app, in the shape describeExample gives for a package: what the registry says (never what a
 * package says) and how it relates to what is installed. `file` is the app id: the page names examples by it. `allow` is the
 * registry's own words for what the app asks for; the list that counts is the one the app shows at its first launch.
 */
function describeRegistryExample(item, deps) {
  let installed = null;
  try {
    installed = deps.currentVersion(item.id);
  } catch {
    installed = null; // a damaged installation is shown by its card; here it is just "not installed"
  }
  let runtimeMissing = false;
  if (item.runtime) {
    try {
      runtimeMissing = !deps.hasRuntime(item.runtime);
    } catch {
      runtimeMissing = true;
    }
  }
  const size = item.sizeBytes === null || item.sizeBytes === undefined ? 0 : item.sizeBytes;
  return {
    file: item.id,
    id: item.id,
    name: item.name,
    version: item.latestVersion,
    publisher: item.publisher && item.publisher.company ? item.publisher.company : '',
    description: item.description || '',
    size,
    sizeText: size ? fmtSize(size) : '',
    badges: [],
    allow: item.permissionsSummary || '',
    allowFrom: 'registry',
    status: statusOf({ version: item.latestVersion }, installed),
    runtime: item.runtime || '',
    runtimeMissing,
  };
}

// ---------------------------------------------------------------------------------------------- installing

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Installs the chosen examples one after the other, with the progress of each, never stopping at a failure.
 *   entries   [{name, file}] already checked against the folder by the caller
 *   deps.verify(file)            the full verification (hostlib/package.js read); throws a precise message
 *   deps.currentVersion(id)      the installed version or null
 *   deps.hasRuntime(name)        is the runtime image installed
 *   deps.isRunning(id)           an app that runs cannot be replaced
 *   deps.install(file, entry)    THE install path (Library._installFile: verify again, Store.install); returns {id, version, previous}
 *   deps.prepare(entry)          only for a registry example (entry = {name, id, version}): downloads it and checks it (hostlib/updates.js
 *                                fetchAndVerify); returns {file, manifest}. An example whose listed version is installed already, or
 *                                older than the installed one, is skipped before anything is downloaded.
 *   deps.release(file)           deletes the downloaded file (always called after a prepare, whatever happened)
 *   deps.onProgress(ev)          {file, phase: 'downloading'|'verifying'|'installing'|'installed'|'updated'|'skipped'|'failed', ...}
 * Skips (with a note) a package whose version is already installed or older than the installed one. Returns the results
 * [{file, status: 'installed'|'updated'|'skipped'|'failed', name?, id?, version?, previous?, note?, error?, step?}] in order.
 */
async function installExamples(entries, deps) {
  const results = [];
  const emit = (r) => {
    results.push(r);
    try {
      deps.onProgress(Object.assign({ phase: r.status }, r));
    } catch {
      /* progress is best effort */
    }
  };
  const phase = (file, p, name) => {
    try {
      deps.onProgress({ file, phase: p, name });
    } catch {
      /* best effort */
    }
  };
  for (const e of entries) {
    let name = e.name;
    let step = 'verify';
    let file = e.file;
    let downloaded = false;
    try {
      let p;
      if (deps.prepare) {
        // a registry example: what the list says is installed already is skipped without a download
        const listed = statusOf({ version: e.version }, deps.currentVersion(e.id));
        if (listed.kind === 'same' || listed.kind === 'older') {
          emit({ file: e.name, status: 'skipped', name, id: e.id, version: e.version, note: listed.kind === 'same' ? `Version ${listed.installed} is already installed.` : `A newer version (${listed.installed}) is installed.` });
          continue;
        }
        step = 'download';
        phase(e.name, 'downloading', name);
        await tick();
        downloaded = true; // from here the file (if it exists) is ours to delete
        const got = await deps.prepare(e);
        file = got.file;
        p = { manifest: got.manifest }; // the download already passed the full verification
        step = 'verify';
      }
      phase(e.name, 'verifying', name);
      await tick();
      if (!p) p = deps.verify(file);
      const m = p.manifest;
      name = m.name;
      const st = statusOf(m, deps.currentVersion(m.id));
      if (st.kind === 'same') {
        emit({ file: e.name, status: 'skipped', name, id: m.id, version: m.version, note: `Version ${st.installed} is already installed.` });
        continue;
      }
      if (st.kind === 'older') {
        emit({ file: e.name, status: 'skipped', name, id: m.id, version: m.version, note: `A newer version (${st.installed}) is installed.` });
        continue;
      }
      step = 'install';
      if (!deps.hasRuntime(m.runtime)) throw new Error(`The runtime “${m.runtime}” is not installed on this Mac.`);
      if (deps.isRunning(m.id)) throw new Error('Stop the app first.');
      phase(e.name, 'installing', name);
      await tick();
      const r = deps.install(file, e);
      emit({ file: e.name, status: st.kind === 'update' ? 'updated' : 'installed', name, id: r.id, version: r.version, previous: st.kind === 'update' ? st.installed : null });
    } catch (err) {
      emit({ file: e.name, status: 'failed', name, step, error: err && err.message ? String(err.message) : String(err) });
    } finally {
      if (downloaded && file && deps.release) {
        try {
          deps.release(file);
        } catch {
          /* a leftover temp file is swept at the next start */
        }
      }
    }
  }
  return results;
}

/** {installed, updated, skipped, failed, total} of install results. */
function countsOf(results) {
  const c = { installed: 0, updated: 0, skipped: 0, failed: 0, total: results.length };
  for (const r of results) c[r.status] += 1;
  return c;
}

/** The one-line summary of an install run: "Installed 3 apps, updated 1, skipped 2, 1 failed." */
function summaryText(c) {
  if (!c.total) return 'Nothing was selected.';
  const apps = (n) => `${n} app${n === 1 ? '' : 's'}`;
  const parts = [];
  if (c.installed) parts.push(`installed ${apps(c.installed)}`);
  if (c.updated) parts.push(`updated ${c.installed ? c.updated : apps(c.updated)}`);
  if (c.skipped) parts.push(`skipped ${c.installed || c.updated ? c.skipped : apps(c.skipped)}`);
  if (c.failed) parts.push(`${c.failed} failed`);
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

module.exports = {
  MAX_EXAMPLES,
  fmtSize,
  hostShortName,
  listPackageFiles,
  infoOf,
  peekManifest,
  parseReadme,
  readReadme,
  badgesOf,
  deriveAllow,
  statusOf,
  describeExample,
  EXAMPLES_DOMAIN,
  isOfficial,
  describeRegistryExample,
  installExamples,
  countsOf,
  summaryText,
};
