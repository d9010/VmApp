'use strict';
// Deterministic newc cpio writer (from a directory tree) and a validating reader (SPEC section 2.1).
//
// Entries: regular files, directories and relative symlinks that stay inside the tree. uid/gid 0, mtime 0, modes
// masked to 0755 (executable files and directories) / 0644 (other files) / 0777 (symlinks). Sorted by path (byte
// order), inode numbers assigned sequentially, ending with TRAILER!!!. The archive is zero-padded to a multiple of
// 512 bytes so it can be attached as a raw virtio block device; the guest ignores the padding after the trailer.

const fs = require('fs');
const path = require('path');

class CpioError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CpioError';
  }
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const IGNORED_NAMES = new Set(['.DS_Store']);

function hex8(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new CpioError(`value ${n} does not fit in a cpio header field`);
  return n.toString(16).padStart(8, '0');
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function header({ ino, mode, nlink, size, namesize }) {
  return Buffer.from(
    '070701' +
      hex8(ino) +
      hex8(mode) +
      hex8(0) + // uid
      hex8(0) + // gid
      hex8(nlink) +
      hex8(0) + // mtime
      hex8(size) +
      hex8(0) + // devmajor
      hex8(0) + // devminor
      hex8(0) + // rdevmajor
      hex8(0) + // rdevminor
      hex8(namesize) +
      hex8(0), // check
    'latin1',
  );
}

/** Validates that symlink `target` located at archive path `rel` stays inside the tree. */
function checkSymlink(rel, target) {
  if (typeof target !== 'string' || target.length === 0) throw new CpioError(`symlink "${rel}": empty target`);
  if (target.startsWith('/')) throw new CpioError(`symlink "${rel}": absolute target "${target}" is not allowed`);
  if (target.includes('\0')) throw new CpioError(`symlink "${rel}": invalid target`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new CpioError(`symlink "${rel}": target "${target}" escapes the app directory`);
  }
}

function walk(root, rel, out) {
  const abs = rel ? path.join(root, rel) : root;
  const names = fs.readdirSync(abs);
  for (const name of names) {
    if (IGNORED_NAMES.has(name)) continue;
    const r = rel ? rel + '/' + name : name;
    const full = path.join(root, r);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) {
      out.push({ path: r, kind: 'dir' });
      walk(root, r, out);
    } else if (st.isFile()) {
      out.push({ path: r, kind: 'file', exec: (st.mode & 0o111) !== 0, size: st.size });
    } else if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(full);
      checkSymlink(r, target);
      out.push({ path: r, kind: 'symlink', target });
    } else {
      throw new CpioError(`"${r}": only regular files, directories and symlinks are allowed`);
    }
  }
}

/**
 * Builds a newc cpio from a directory. Returns a Buffer.
 * opts.maxBytes: fail if the archive would be bigger.
 */
function cpioFromDir(dir, opts = {}) {
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new CpioError(`"${dir}" is not a directory`);
  const items = [];
  walk(dir, '', items);
  for (const it of items) {
    if (it.path.includes('\0')) throw new CpioError(`invalid path "${it.path}"`);
  }
  items.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const parts = [];
  let ino = 1;
  let total = 0;
  const push = (b) => {
    parts.push(b);
    total += b.length;
    if (opts.maxBytes !== undefined && total > opts.maxBytes) {
      throw new CpioError(`core files are larger than the limit of ${opts.maxBytes} bytes`);
    }
  };
  const emit = (name, mode, nlink, data) => {
    const nameBuf = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0])]);
    push(header({ ino: ino++, mode, nlink, size: data.length, namesize: nameBuf.length }));
    push(nameBuf);
    const np = pad4(110 + nameBuf.length);
    if (np) push(Buffer.alloc(np));
    if (data.length) {
      push(data);
      const dp = pad4(data.length);
      if (dp) push(Buffer.alloc(dp));
    }
  };
  for (const it of items) {
    if (it.kind === 'dir') emit(it.path, S_IFDIR | 0o755, 2, Buffer.alloc(0));
    else if (it.kind === 'symlink') emit(it.path, S_IFLNK | 0o777, 1, Buffer.from(it.target, 'utf8'));
    else {
      const data = fs.readFileSync(path.join(dir, it.path));
      emit(it.path, S_IFREG | (it.exec ? 0o755 : 0o644), 1, data);
    }
  }
  // trailer
  const tname = Buffer.from('TRAILER!!!\0', 'latin1');
  push(header({ ino: 0, mode: 0, nlink: 1, size: 0, namesize: tname.length }));
  push(tname);
  const tp = pad4(110 + tname.length);
  if (tp) push(Buffer.alloc(tp));
  const tail = (512 - (total % 512)) % 512;
  if (tail) push(Buffer.alloc(tail));
  return Buffer.concat(parts);
}

/**
 * Validating reader. Returns [{ path, type: 'file'|'dir'|'symlink', mode, size, data }] (data = file content or
 * symlink target). Rejects absolute and ".." paths, other file types, and symlinks that escape the tree.
 */
function readCpio(buf) {
  const entries = [];
  const seen = new Set();
  let off = 0;
  for (;;) {
    if (off + 110 > buf.length) throw new CpioError('truncated cpio: missing TRAILER!!!');
    if (buf.toString('latin1', off, off + 6) !== '070701') throw new CpioError(`bad cpio magic at offset ${off}`);
    const f = [];
    for (let i = 0; i < 13; i++) {
      const s = buf.toString('latin1', off + 6 + i * 8, off + 14 + i * 8);
      if (!/^[0-9a-fA-F]{8}$/.test(s)) throw new CpioError(`bad cpio header field at offset ${off}`);
      f.push(parseInt(s, 16));
    }
    const mode = f[1];
    const filesize = f[6];
    const namesize = f[11];
    if (namesize < 1) throw new CpioError(`bad cpio name size at offset ${off}`);
    const nameStart = off + 110;
    if (nameStart + namesize > buf.length) throw new CpioError('truncated cpio name');
    if (buf[nameStart + namesize - 1] !== 0) throw new CpioError('cpio name is not NUL terminated');
    const name = buf.toString('utf8', nameStart, nameStart + namesize - 1);
    let dataStart = nameStart + namesize;
    dataStart += pad4(110 + namesize);
    if (name === 'TRAILER!!!') return entries;
    if (dataStart + filesize > buf.length) throw new CpioError(`truncated cpio data for "${name}"`);
    const data = buf.subarray(dataStart, dataStart + filesize);
    off = dataStart + filesize + pad4(filesize);
    if (name === '.') continue;
    if (name.startsWith('/')) throw new CpioError(`cpio entry "${name}": absolute paths are not allowed`);
    const comps = name.split('/');
    for (const c of comps) {
      if (c === '' || c === '.' || c === '..') throw new CpioError(`cpio entry "${name}": invalid path component "${c}"`);
    }
    if (seen.has(name)) throw new CpioError(`cpio entry "${name}": duplicate`);
    seen.add(name);
    const fmt = mode & S_IFMT;
    if (fmt === S_IFREG) entries.push({ path: name, type: 'file', mode, size: filesize, data });
    else if (fmt === S_IFDIR) entries.push({ path: name, type: 'dir', mode, size: 0, data });
    else if (fmt === S_IFLNK) {
      const target = data.toString('utf8');
      checkSymlink(name, target);
      entries.push({ path: name, type: 'symlink', mode, size: filesize, data });
    } else {
      throw new CpioError(`cpio entry "${name}": only regular files, directories and symlinks are allowed`);
    }
  }
}

module.exports = { CpioError, cpioFromDir, readCpio, checkSymlink };
