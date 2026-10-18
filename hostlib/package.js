'use strict';
// .vmapp package: pack, read and verify (SPEC section 2).
//
// Project layout consumed by pack():
//   <project>/vmapp.json      manifest WITHOUT "files"
//   <project>/<ui.root>/...   the UI (default "ui")
//   <project>/core/...        the app's core files (becomes core.cpio, or core.erofs with core.image "erofs" -> /app)
//   <project>/icon.png        optional
// Package layout produced: vmapp.json, <ui.root>/ (dirs + files sorted by path), core.cpio or core.erofs, icon.png.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('./tar');
const { cpioFromDir, readCpio, CpioError } = require('./cpio');
const { erofsFromDir, readErofs, ErofsError } = require('./erofs');
const { validateManifest, canonicalize, parseManifest, ManifestError } = require('./manifest');

const MIB = 1024 * 1024;
// SPEC 2: a package is read whole into memory, and Node reads at most 2 GiB - 1 in one go
const MAX_PACKAGE = 2047 * MIB;
// core.cpio is copied into the VM's memory at boot (SPEC 4 step 3), so it stays small; core.erofs is mounted as it is
const MAX_CORE = 256 * MIB;
const MAX_CORE_EROFS = MAX_PACKAGE;
const MAX_UI = 1024 * MIB;
const mib = (n) => `${Math.round(n / MIB)} MiB`;
/** The package entry that holds the core files of a (validated) manifest: core.cpio or core.erofs (SPEC 2.1). */
const coreEntryName = (manifest) => `core.${manifest.core.image || 'cpio'}`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const cmp = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function walkUi(root, rel, out) {
  const abs = rel ? path.join(root, rel) : root;
  for (const name of fs.readdirSync(abs)) {
    if (name === '.DS_Store') continue;
    const r = rel ? rel + '/' + name : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isDirectory()) {
      out.push({ rel: r, type: 'dir' });
      walkUi(root, r, out);
    } else if (st.isFile()) {
      out.push({ rel: r, type: 'file' });
    } else {
      throw new PackageError(`ui entry "${r}" is not a regular file or directory (symlinks are not allowed)`);
    }
  }
}

/**
 * Packs a project directory into a .vmapp file. Returns { outFile, packageId, manifest, size }.
 */
function pack(projectDir, outFile) {
  const manifestPath = path.join(projectDir, 'vmapp.json');
  if (!fs.existsSync(manifestPath)) throw new PackageError(`${projectDir}: vmapp.json not found`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new PackageError(`${manifestPath}: not valid JSON (${e.message})`);
  }
  const m = validateManifest(raw, { files: 'forbidden' });

  const uiDir = path.join(projectDir, m.ui.root);
  const coreDir = path.join(projectDir, 'core');
  if (m.ui.root === 'core') throw new PackageError('ui.root must not be "core" (the project folder "core" holds the core files)');
  if (!fs.existsSync(uiDir) || !fs.statSync(uiDir).isDirectory()) throw new PackageError(`UI folder not found: ${uiDir}`);
  if (!fs.existsSync(coreDir) || !fs.statSync(coreDir).isDirectory()) throw new PackageError(`core folder not found: ${coreDir}`);

  // UI entries: the root dir, then everything below it, sorted by path
  const uiItems = [{ rel: '', type: 'dir' }];
  walkUi(uiDir, '', uiItems);
  const items = uiItems.map((it) => ({ path: it.rel ? m.ui.root + '/' + it.rel : m.ui.root, type: it.type, abs: path.join(uiDir, it.rel) }));
  items.sort((a, b) => cmp(a.path, b.path));

  const files = {};
  const tarEntries = [];
  let uiBytes = 0;
  const bodies = [];
  for (const it of items) {
    if (it.type === 'dir') {
      tarEntries.push({ path: it.path, type: 'dir' });
    } else {
      const data = fs.readFileSync(it.abs);
      uiBytes += data.length;
      if (uiBytes > MAX_UI) throw new PackageError(`ui/ is larger than the limit of ${MAX_UI} bytes`);
      files[it.path] = sha256(data);
      bodies.push({ path: it.path, type: 'file', data });
      tarEntries.push(bodies[bodies.length - 1]);
    }
  }
  for (const e of tarEntries) tar.validatePath(e.path, { dir: e.type === 'dir' }); // early, precise errors

  const coreName = coreEntryName(m);
  let coreData;
  try {
    coreData = coreName === 'core.erofs' ? erofsFromDir(coreDir, { maxBytes: MAX_CORE_EROFS }) : cpioFromDir(coreDir, { maxBytes: MAX_CORE });
  } catch (e) {
    if (e instanceof CpioError && /larger than the limit/.test(e.message)) {
      throw new PackageError(`core/: ${e.message} (a core.cpio is copied into the VM's memory; "core": {"image": "erofs"} mounts the files instead, up to ${mib(MAX_CORE_EROFS)})`);
    }
    if (e instanceof CpioError || e instanceof ErofsError) throw new PackageError(`core/: ${e.message}`);
    throw e;
  }
  files[coreName] = sha256(coreData);

  const iconPath = path.join(projectDir, 'icon.png');
  let icon = null;
  if (fs.existsSync(iconPath)) {
    icon = fs.readFileSync(iconPath);
    if (icon.length < 8 || !icon.subarray(0, 8).equals(PNG_MAGIC)) throw new PackageError('icon.png is not a PNG file');
    files['icon.png'] = sha256(icon);
  }

  const sortedFiles = {};
  for (const k of Object.keys(files).sort(cmp)) sortedFiles[k] = files[k];
  const finalManifest = Object.assign({}, m, { files: sortedFiles });
  const manifestText = canonicalize(finalManifest);
  const manifestBytes = Buffer.from(manifestText, 'utf8');

  const all = [{ path: 'vmapp.json', type: 'file', data: manifestBytes }, ...tarEntries, { path: coreName, type: 'file', data: coreData }];
  if (icon) all.push({ path: 'icon.png', type: 'file', data: icon });
  let out;
  try {
    out = tar.writeTar(all);
  } catch (e) {
    if (e instanceof tar.TarError) throw new PackageError(e.message);
    throw e;
  }
  if (out.length > MAX_PACKAGE) throw new PackageError(`package is larger than the limit of ${MAX_PACKAGE} bytes`);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, outFile);
  return { outFile, packageId: sha256(manifestBytes), manifest: parseManifest(manifestBytes), size: out.length };
}

/**
 * Parses and fully verifies package bytes. Returns
 * { manifest, manifestBytes, packageId, entries, size, uiBytes, coreBytes, hasIcon }.
 * Throws PackageError (or ManifestError) with a precise message on any violation.
 */
function load(buf, label = 'package') {
  if (buf.length > MAX_PACKAGE) throw new PackageError(`${label} is ${buf.length} bytes, larger than the limit of ${MAX_PACKAGE}`);
  let entries;
  try {
    entries = tar.readTar(buf);
  } catch (e) {
    if (e instanceof tar.TarError) throw new PackageError(`${label}: ${e.message}`);
    throw e;
  }
  if (entries.length === 0 || entries[0].path !== 'vmapp.json' || entries[0].type !== 'file') {
    throw new PackageError(`${label}: the first entry must be vmapp.json${entries.length ? ` (found "${entries[0].path}")` : ''}`);
  }
  const manifestBytes = Buffer.from(entries[0].data);
  const manifest = parseManifest(manifestBytes, { files: 'required' });
  const root = manifest.ui.root;
  const coreName = coreEntryName(manifest); // the manifest's core.image decides which one the package must have

  // order: vmapp.json, <root>/ subtree sorted, core.cpio (or core.erofs), icon.png
  let phase = 0; // 0 ui, 1 the core seen, 2 icon seen
  let prev = null;
  const dirs = new Set();
  let uiBytes = 0;
  let coreEntry = null;
  let iconEntry = null;
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const inUi = e.path === root || e.path.startsWith(root + '/');
    if (inUi) {
      if (phase !== 0) throw new PackageError(`entry order: "${e.path}" comes after ${coreName}/icon.png (UI entries must come first)`);
      if (prev === null) {
        if (e.path !== root || e.type !== 'dir') {
          throw new PackageError(`entry order: expected directory entry "${root}/" first after vmapp.json, found "${e.path}"`);
        }
      } else if (cmp(prev, e.path) >= 0) {
        throw new PackageError(`entry order: "${e.path}" must sort after "${prev}"`);
      }
      if (e.path !== root) {
        const parent = e.path.slice(0, e.path.lastIndexOf('/'));
        if (!dirs.has(parent)) throw new PackageError(`entry "${e.path}": parent directory "${parent}/" has no directory entry before it`);
      }
      if (e.type === 'dir') dirs.add(e.path);
      else uiBytes += e.size;
      prev = e.path;
    } else if (e.path === coreName) {
      if (e.type !== 'file') throw new PackageError(`${coreName} must be a regular file`);
      if (prev === null) throw new PackageError(`entry order: UI directory "${root}/" must precede ${coreName}`);
      if (phase !== 0) throw new PackageError(`entry order: ${coreName} must come right after the UI entries`);
      phase = 1;
      coreEntry = e;
    } else if (e.path === 'icon.png') {
      if (e.type !== 'file') throw new PackageError('icon.png must be a regular file');
      if (phase !== 1) throw new PackageError(`entry order: icon.png must come last, right after ${coreName}`);
      phase = 2;
      iconEntry = e;
    } else {
      throw new PackageError(`unexpected entry "${e.path}" (allowed: vmapp.json, ${root}/..., ${coreName}, icon.png)`);
    }
  }
  if (prev === null) throw new PackageError(`package has no UI directory "${root}/"`);
  if (!coreEntry) throw new PackageError(`package has no ${coreName} entry`);

  // limits
  const maxCore = coreName === 'core.erofs' ? MAX_CORE_EROFS : MAX_CORE;
  if (coreEntry.size > maxCore) throw new PackageError(`${coreName} is ${coreEntry.size} bytes, larger than the limit of ${maxCore}`);
  if (uiBytes > MAX_UI) throw new PackageError(`${root}/ is ${uiBytes} bytes, larger than the limit of ${MAX_UI}`);

  // files map vs entries
  const present = new Set();
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'dir') continue;
    present.add(e.path);
    if (!Object.prototype.hasOwnProperty.call(manifest.files, e.path)) {
      throw new PackageError(`package entry "${e.path}" is not listed in vmapp.json files`);
    }
  }
  for (const k of Object.keys(manifest.files)) {
    if (!present.has(k)) throw new PackageError(`vmapp.json lists "${k}" in files but the package has no such entry`);
  }
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'dir') continue;
    const actual = sha256(e.data);
    if (actual !== manifest.files[e.path]) {
      throw new PackageError(`hash mismatch for "${e.path}": vmapp.json says ${manifest.files[e.path]}, actual ${actual}`);
    }
  }

  // contents of the special files
  try {
    if (coreName === 'core.erofs') readErofs(coreEntry.data);
    else readCpio(coreEntry.data);
  } catch (e) {
    if (e instanceof CpioError || e instanceof ErofsError) throw new PackageError(`${coreName} is invalid: ${e.message}`);
    throw e;
  }
  if (iconEntry && (iconEntry.size < 8 || !iconEntry.data.subarray(0, 8).equals(PNG_MAGIC))) {
    throw new PackageError('icon.png is not a PNG file');
  }

  return {
    manifest,
    manifestBytes,
    packageId: sha256(manifestBytes),
    entries,
    size: buf.length,
    uiBytes,
    coreName,
    coreBytes: coreEntry.size,
    hasIcon: !!iconEntry,
  };
}

function readFileLimited(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new PackageError(`${file}: not a file`);
  if (st.size > MAX_PACKAGE) throw new PackageError(`${file} is ${st.size} bytes, larger than the limit of ${MAX_PACKAGE}`);
  return fs.readFileSync(file);
}

/** Reads and fully verifies a .vmapp file. Returns { manifest, packageId, entries, ... } (see load). */
function read(file) {
  return load(readFileLimited(file), path.basename(file));
}

/** Fully verifies a .vmapp file; throws on any problem, else returns a summary. */
function verify(file) {
  const r = read(file);
  return { ok: true, packageId: r.packageId, manifest: r.manifest, size: r.size, uiBytes: r.uiBytes, coreName: r.coreName, coreBytes: r.coreBytes, hasIcon: r.hasIcon };
}

module.exports = {
  PackageError,
  ManifestError,
  MAX_PACKAGE,
  MAX_CORE,
  MAX_CORE_EROFS,
  MAX_UI,
  mib,
  coreEntryName,
  pack,
  read,
  verify,
  load,
  sha256,
};
