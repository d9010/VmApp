// Streaming verifier for .vmapp packages, for a Cloudflare Worker (128 MB of memory).
//
// hostlib/package.js `load(buf)` needs the whole package in memory (up to 402 MB in practice, 2047 MiB by the limits).
// This module checks the same rules in ONE forward pass over a ReadableStream of Uint8Array chunks, holding in memory
// only: the manifest (the first tar entry; at most MAX_MANIFEST bytes, enforced from the tar header BEFORE anything is
// buffered), one 512-byte tar header, the set of entry paths, the first 8 bytes of icon.png and the small state of the
// core-image validator. Every byte is hashed (SHA-256 of the whole package, and of each file entry) and discarded.
// Runs in Node 22 (tests) and in a Worker with the nodejs_compat flag (only node:crypto's createHash is used).
//
// What is checked, and how it relates to hostlib (tar.js readTar, package.js load, cpio.js readCpio, erofs.js readErofs):
//
//  * tar: every check of readTar, in a single pass, with the same messages (header checksum, ustar magic/version, entry
//    types, name/prefix, trailing "/" rule, path rules, empty link name, mode/uid/gid/mtime, directory size, duplicate
//    names, data and padding present and zero, two zero blocks at the end, nothing but zeros after the first zero block).
//    A stream that ends early or errors is an error ("truncated ..."), never a success.
//  * package layout (load): first entry vmapp.json (a file), manifest parsed with parseManifest(.., {files:'required'}),
//    entry order (UI subtree sorted bytewise starting with the root directory entry, then core.cpio|core.erofs by
//    manifest.core.image, then optional icon.png, nothing else), parent-directory-before-child, core size and UI total
//    limits, files map == set of file entries, SHA-256 of every file entry == manifest.files[path] ("hash mismatch"),
//    icon.png has the PNG magic. Also: the whole package is at most opts.maxBytes (reading stops as soon as exceeded).
//  * core.cpio: a true streaming port of readCpio (every check, same messages). Two bounds readCpio does not have, to
//    keep memory bounded: a cpio entry name or symlink target longer than MAX_CPIO_NAME (65536) bytes is rejected.
//    Like readCpio, nothing after the TRAILER!!! record is looked at (only the hash covers it).
//  * core.erofs: readErofs walks inodes and directories by random access (a directory entry names an inode that can sit
//    anywhere), which a single forward pass with bounded memory cannot do. So:
//      - core.erofs of at most EROFS_FULL_CHECK_MAX (32 MiB): the image is buffered and checked by an exact port of
//        readErofs (every check, same messages). Same strength as hostlib.
//      - larger core.erofs (e.g. the 332 MB VS Code image): only the checks at known offsets are made, as soon as the
//        bytes arrive: size is a whole number of 4 KiB blocks; the superblock (magic, compat flags, block size, extension
//        slots, incompat flags, extra devices, directory block size, xattr prefixes, block count <= image size); and the
//        root inode when it lies in the first 16 KiB (always, for mkfs.erofs and erofs.js images): layout/format bits,
//        owner root, type directory, mode 0755, no xattrs, data inside the image.
//        NOT checked for large images (readErofs checks them): every other inode (modes, owners, hard links, nlink
//        counts, data ranges, inline-data bounds, symlink targets escaping the tree), directory block structure, sorting
//        of names, "."/".." entries, name validity, entry-type/inode-type match, cycles / inodes reached twice. The
//        content hash from the manifest still binds the image bytes, so a registry that publishes whatever the
//        developer's packer produced is still protected against corruption and substitution, and the client runs the full
//        `load` (readErofs) before it ever mounts the image. This is a weaker gate for hostile large images only.
//    The 32 MiB threshold can be changed with opts.erofsFullCheckMax (tests use it to exercise both paths).
//  * Differences from load() beyond the above: errors are found in stream order, so for a package with several
//    problems the message may name a different one than load() does (both reject). A core-image error is reported only
//    after the entry's hash matched (like load, a hash mismatch wins). The UI total limit is reported as soon as the
//    running total passes it ("is at least N bytes") instead of with the final total. MAX_MANIFEST (4 MiB) has no
//    counterpart in hostlib (manifest.js has no size limit; the largest real manifest is 340 KB). Likewise
//    MAX_TAR_ENTRIES (100000) and MAX_CPIO_ENTRIES (250000) bound the memory of the path sets; hostlib has no such limit.

import { createHash } from 'node:crypto';
import { parseManifest } from '../../hostlib/manifest.js';

export class VerifyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'VerifyError';
  }
}

const MIB = 1024 * 1024;
// copied from hostlib/package.js; test/verify.test.mjs asserts they are equal
export const LIMITS = Object.freeze({
  MAX_PACKAGE: 2047 * MIB,
  MAX_CORE: 256 * MIB,
  MAX_CORE_EROFS: 2047 * MIB,
  MAX_UI: 1024 * MIB,
});
/** Largest vmapp.json accepted (it is buffered). Worker-only; hostlib has no such limit. */
export const MAX_MANIFEST = 4 * MIB;
export const EROFS_FULL_CHECK_MAX = 32 * MIB;
const MAX_CPIO_NAME = 65536;
// Worker-only memory bounds (hostlib has none): the entry paths are kept in sets, so their number is capped. The largest
// real package has 2675 tar entries and 921 cpio entries.
export const MAX_TAR_ENTRIES = 100000;
export const MAX_CPIO_ENTRIES = 250000;

const BLOCK = 512;
const MAX_PATH_BYTES = 255;
const MAX_NAME = 100;
const MAX_PREFIX = 155;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---------------------------------------------------------------------------------------------------------------------
// small byte helpers (Uint8Array only: no Buffer, so this runs without Node's Buffer too)

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true }); // lenient, keeps a BOM: same as Buffer#toString('utf8')
const utf8 = (b, s, e) => decoder.decode(b.subarray(s, e));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function latin1(b, s, e) {
  let r = '';
  for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
  return r;
}

function isZero(b, s, e) {
  for (let i = s; i < e; i++) if (b[i] !== 0) return false;
  return true;
}

function cstr(b, start, len) {
  let end = start;
  const max = start + len;
  while (end < max && b[end] !== 0) end++;
  return b.subarray(start, end);
}

/** Bytewise comparison like Buffer.compare. */
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function concat(a, b) {
  const r = new Uint8Array(a.length + b.length);
  r.set(a, 0);
  r.set(b, a.length);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// tar (port of hostlib/tar.js readTar, one header at a time)

class TarFail extends Error {}

function validatePath(p, dir) {
  if (typeof p !== 'string' || p.length === 0) throw new TarFail('invalid path: empty');
  if (p.startsWith('/')) throw new TarFail(`invalid path "${p}": absolute paths are not allowed`);
  let q = p;
  if (q.endsWith('/')) q = q.slice(0, -1);
  if (q.length === 0) throw new TarFail(`invalid path "${p}": empty`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(q)) throw new TarFail(`invalid path "${p}": control characters and backslashes are not allowed`);
  for (const c of q.split('/')) {
    if (c === '') throw new TarFail(`invalid path "${p}": empty path component`);
    if (c === '.' || c === '..') throw new TarFail(`invalid path "${p}": "${c}" component is not allowed`);
  }
  const stored = dir ? q + '/' : q;
  if (encoder.encode(stored).length > MAX_PATH_BYTES) throw new TarFail(`invalid path "${p}": longer than ${MAX_PATH_BYTES} bytes`);
  return q;
}

function parseOctal(b, start, len, field, where) {
  if (b[start] & 0x80) throw new TarFail(`${where}: base-256 ${field} is not allowed`);
  let s = latin1(b, start, start + len);
  s = s.replace(/[\0 ]+$/g, '').replace(/^ +/, '');
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarFail(`${where}: invalid ${field} field`);
  return parseInt(s, 8);
}

/** Parses one 512-byte header (not a zero block). Returns { path, type: 'file'|'dir', size }. `idx` = entries so far. */
function parseTarHeader(b, idx) {
  const where = `tar entry #${idx + 1}`;
  const stored = parseOctal(b, 148, 8, 'checksum', where);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i];
  if (sum !== stored) throw new TarFail(`${where}: bad header checksum`);
  if (latin1(b, 257, 263) !== 'ustar\0' || latin1(b, 263, 265) !== '00') {
    throw new TarFail(`${where}: not a POSIX ustar header (magic/version)`);
  }
  const typeflag = String.fromCharCode(b[156]);
  const nameBytes = cstr(b, 0, MAX_NAME);
  const prefixBytes = cstr(b, 345, MAX_PREFIX);
  let full = utf8(nameBytes, 0, nameBytes.length);
  if (prefixBytes.length) full = utf8(prefixBytes, 0, prefixBytes.length) + '/' + full;
  if (typeflag === '0' || typeflag === '5') {
    // ok
  } else if (typeflag === '1' || typeflag === '2') {
    throw new TarFail(`entry "${full}": links are not allowed`);
  } else if (typeflag === '3' || typeflag === '4' || typeflag === '6') {
    throw new TarFail(`entry "${full}": devices and fifos are not allowed`);
  } else if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
    throw new TarFail(`entry "${full}": pax/GNU extension headers are not allowed`);
  } else {
    throw new TarFail(`entry "${full}": unsupported entry type ${JSON.stringify(typeflag)}`);
  }
  const isDir = typeflag === '5';
  if (isDir !== full.endsWith('/')) {
    throw new TarFail(`entry "${full}": ${isDir ? 'directory name must end with "/"' : 'file name must not end with "/"'}`);
  }
  let p;
  try {
    p = validatePath(full, isDir);
  } catch (e) {
    if (e instanceof TarFail) throw new TarFail(`tar entry #${idx + 1}: ${e.message}`);
    throw e;
  }
  if (cstr(b, 157, 100).length) throw new TarFail(`entry "${p}": link name must be empty`);
  const mode = parseOctal(b, 100, 8, 'mode', where);
  const uid = parseOctal(b, 108, 8, 'uid', where);
  const gid = parseOctal(b, 116, 8, 'gid', where);
  const mtime = parseOctal(b, 136, 12, 'mtime', where);
  const size = parseOctal(b, 124, 12, 'size', where);
  if (uid !== 0 || gid !== 0) throw new TarFail(`entry "${p}": uid/gid must be 0 (got ${uid}/${gid})`);
  if (mtime !== 0) throw new TarFail(`entry "${p}": mtime must be 0 (got ${mtime})`);
  const wantMode = isDir ? 0o755 : 0o644;
  if (mode !== wantMode) {
    throw new TarFail(`entry "${p}": mode must be ${wantMode.toString(8).padStart(4, '0')} (got ${mode.toString(8).padStart(4, '0')})`);
  }
  if (isDir && size !== 0) throw new TarFail(`entry "${p}": directory with non-zero size`);
  return { path: p, type: isDir ? 'dir' : 'file', size };
}

// ---------------------------------------------------------------------------------------------------------------------
// core images

class CoreFail extends Error {} // a problem inside core.cpio / core.erofs (CpioError / ErofsError in hostlib)

/** Port of cpio.js checkSymlink without node:path: does symlink `target` at archive path `rel` stay inside the tree? */
function checkSymlink(rel, target) {
  if (typeof target !== 'string' || target.length === 0) throw new CoreFail(`symlink "${rel}": empty target`);
  if (target.startsWith('/')) throw new CoreFail(`symlink "${rel}": absolute target "${target}" is not allowed`);
  if (target.includes('\0')) throw new CoreFail(`symlink "${rel}": invalid target`);
  // path.posix.normalize(join(dirname(rel), target)) starts with ".." exactly when a ".." is met with nothing left to pop
  const stack = [];
  const parts = rel.split('/');
  parts.pop(); // dirname(rel) (empty when rel has no "/")
  let escapes = false;
  const walk = (segs) => {
    for (const s of segs) {
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (stack.length) stack.pop();
        else escapes = true;
      } else stack.push(s);
    }
  };
  walk(parts);
  walk(target.split('/'));
  if (escapes) throw new CoreFail(`symlink "${rel}": target "${target}" escapes the app directory`);
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const pad4 = (n) => (4 - (n % 4)) % 4;

/** Streaming port of cpio.js readCpio. write() chunks of the whole core image, then finish(). */
class CpioSink {
  constructor(total) {
    this.total = total;
    this.off = 0; // offset of the current record
    this.seen = new Set();
    this.done = false;
    this.begin();
  }

  begin() {
    if (this.off + 110 > this.total) throw new CoreFail('truncated cpio: missing TRAILER!!!');
    this.st = 'hdr';
    this.buf = new Uint8Array(110);
    this.fill = 0;
    this.need = 110;
  }

  write(chunk) {
    let pos = 0;
    for (;;) {
      if (this.done) return;
      if (this.need === 0) {
        this.step();
        continue;
      }
      if (pos >= chunk.length) return;
      const n = Math.min(this.need, chunk.length - pos);
      if (this.buf) {
        this.buf.set(chunk.subarray(pos, pos + n), this.fill);
        this.fill += n;
      }
      this.need -= n;
      pos += n;
    }
  }

  step() {
    switch (this.st) {
      case 'hdr':
        return this.onHeader();
      case 'name':
        return this.onName();
      case 'pad':
        return this.onData();
      case 'sym':
        return this.onSymlink();
      case 'skip':
        this.off = this.next;
        return this.begin();
      default:
        throw new Error('unreachable');
    }
  }

  onHeader() {
    const b = this.buf;
    if (latin1(b, 0, 6) !== '070701') throw new CoreFail(`bad cpio magic at offset ${this.off}`);
    const f = [];
    for (let i = 0; i < 13; i++) {
      const s = latin1(b, 6 + i * 8, 14 + i * 8);
      if (!/^[0-9a-fA-F]{8}$/.test(s)) throw new CoreFail(`bad cpio header field at offset ${this.off}`);
      f.push(parseInt(s, 16));
    }
    this.mode = f[1];
    this.filesize = f[6];
    this.namesize = f[11];
    if (this.namesize < 1) throw new CoreFail(`bad cpio name size at offset ${this.off}`);
    if (this.off + 110 + this.namesize > this.total) throw new CoreFail('truncated cpio name');
    if (this.namesize > MAX_CPIO_NAME) throw new CoreFail(`cpio name at offset ${this.off} is longer than ${MAX_CPIO_NAME} bytes`);
    this.st = 'name';
    this.buf = new Uint8Array(this.namesize);
    this.fill = 0;
    this.need = this.namesize;
  }

  onName() {
    const b = this.buf;
    if (b[this.namesize - 1] !== 0) throw new CoreFail('cpio name is not NUL terminated');
    this.name = utf8(b, 0, this.namesize - 1);
    const nameEnd = this.off + 110 + this.namesize;
    this.dataStart = nameEnd + pad4(110 + this.namesize);
    if (this.name === 'TRAILER!!!') {
      this.done = true;
      return;
    }
    this.st = 'pad';
    this.buf = null;
    this.need = this.dataStart - nameEnd;
  }

  onData() {
    const { name, filesize, mode } = this;
    if (this.dataStart + filesize > this.total) throw new CoreFail(`truncated cpio data for "${name}"`);
    this.next = this.dataStart + filesize + pad4(filesize);
    if (name !== '.') {
      if (name.startsWith('/')) throw new CoreFail(`cpio entry "${name}": absolute paths are not allowed`);
      for (const c of name.split('/')) {
        if (c === '' || c === '.' || c === '..') throw new CoreFail(`cpio entry "${name}": invalid path component "${c}"`);
      }
      if (this.seen.has(name)) throw new CoreFail(`cpio entry "${name}": duplicate`);
      if (this.seen.size >= MAX_CPIO_ENTRIES) throw new CoreFail(`more than ${MAX_CPIO_ENTRIES} entries are not supported`);
      this.seen.add(name);
      const fmt = mode & S_IFMT;
      if (fmt === S_IFLNK) {
        if (filesize > MAX_CPIO_NAME) throw new CoreFail(`symlink "${name}": target longer than ${MAX_CPIO_NAME} bytes`);
        this.st = 'sym';
        this.buf = new Uint8Array(filesize);
        this.fill = 0;
        this.need = filesize;
        return;
      }
      if (fmt !== S_IFREG && fmt !== S_IFDIR) {
        throw new CoreFail(`cpio entry "${name}": only regular files, directories and symlinks are allowed`);
      }
    }
    this.st = 'skip';
    this.buf = null;
    this.need = filesize + pad4(filesize);
  }

  onSymlink() {
    checkSymlink(this.name, utf8(this.buf, 0, this.filesize));
    this.st = 'skip';
    this.buf = null;
    this.need = pad4(this.filesize);
  }

  finish() {
    if (!this.done) throw new CoreFail('truncated cpio: missing TRAILER!!!');
  }
}

// ---- erofs (erofs.js) ----
const EROFS_MAGIC = 0xe0f5e1e2;
const BLKSZBITS = 12;
const BLK = 1 << BLKSZBITS;
const SB_OFFSET = 1024;
const META_START = 1152;
const ISLOT = 32;
const DIRENT = 12;
const NAME_MAX = 255;
const FT = { file: 1, dir: 2, symlink: 7 };
const LAYOUT_PLAIN = 0;
const LAYOUT_INLINE = 2;
const COMPAT_SB_CHKSUM = 0x1;
const COMPAT_MTIME = 0x2;
const EROFS_PREFIX = 16384; // bytes kept for the large-image checks (superblock and the root inode)

/** Superblock checks of readErofs; `b` holds at least the first SB_OFFSET + 128 bytes, `total` is the image size. */
function erofsSuperblock(b, total) {
  if (total < BLK || total % BLK) throw new CoreFail(`the image is ${total} bytes, not a whole number of 4 KiB blocks`);
  const dv = view(b);
  const sb = SB_OFFSET;
  if (dv.getUint32(sb, true) !== EROFS_MAGIC) throw new CoreFail('not an EROFS image (bad magic)');
  const compat = dv.getUint32(sb + 8, true);
  if (compat & ~(COMPAT_SB_CHKSUM | COMPAT_MTIME)) throw new CoreFail(`unsupported compatible features 0x${compat.toString(16)}`);
  if (dv.getUint8(sb + 12) !== BLKSZBITS) throw new CoreFail('the block size must be 4 KiB');
  if (dv.getUint8(sb + 13) !== 0) throw new CoreFail('superblock extension slots are not supported');
  if (dv.getUint32(sb + 80, true) !== 0) throw new CoreFail(`unsupported incompatible features 0x${dv.getUint32(sb + 80, true).toString(16)} (compression, chunks, devices…)`);
  if (dv.getUint16(sb + 86, true) !== 0) throw new CoreFail('extra devices are not supported');
  if (dv.getUint8(sb + 90) !== 0) throw new CoreFail('the directory block size must be the block size');
  if (dv.getUint8(sb + 91) !== 0) throw new CoreFail('extended attribute prefixes are not supported');
  const blocks = dv.getUint32(sb + 36, true);
  if (blocks * BLK > total) throw new CoreFail(`the superblock counts ${blocks} blocks, the image has ${total / BLK}`);
  return { metaBase: dv.getUint32(sb + 40, true) * BLK, rootNid: dv.getUint16(sb + 14, true) };
}

/**
 * Port of readErofs' inode(): `b` holds the image (or its first bytes, see needs), `total` is the real image size.
 * Needs the bytes [off, off + 64) available in `b`.
 */
function erofsInode(b, total, metaBase, nid, where) {
  const dv = view(b);
  const off = metaBase + nid * ISLOT;
  if (!Number.isSafeInteger(off) || off < META_START || off + ISLOT > total) throw new CoreFail(`${where}: inode ${nid} is outside the image`);
  const format = dv.getUint16(off, true);
  const extended = (format & 1) === 1;
  const isize = extended ? 64 : 32;
  if ((off % BLK) + isize > BLK) throw new CoreFail(`${where}: inode ${nid} crosses a block boundary`);
  if (format & ~0xf) throw new CoreFail(`${where}: unsupported inode format bits 0x${format.toString(16)}`);
  const layout = (format >> 1) & 0x7;
  if (layout !== LAYOUT_PLAIN && layout !== LAYOUT_INLINE) throw new CoreFail(`${where}: compressed or chunked data is not supported`);
  if (dv.getUint16(off + 2, true) !== 0) throw new CoreFail(`${where}: extended attributes are not supported`);
  const mode = dv.getUint16(off + 4, true);
  const nlink = extended ? dv.getUint32(off + 44, true) : dv.getUint16(off + 6, true);
  const size = extended ? Number(dv.getBigUint64(off + 8, true)) : dv.getUint32(off + 8, true);
  const blkaddr = dv.getUint32(off + 16, true);
  const uid = extended ? dv.getUint32(off + 24, true) : dv.getUint16(off + 24, true);
  const gid = extended ? dv.getUint32(off + 28, true) : dv.getUint16(off + 26, true);
  if (uid !== 0 || gid !== 0) throw new CoreFail(`${where}: owned by ${uid}:${gid}, not root`);
  const fmt = mode & S_IFMT;
  const perm = mode & 0o7777;
  let type;
  if (fmt === S_IFREG) {
    type = 'file';
    if (perm !== 0o644 && perm !== 0o755) throw new CoreFail(`${where}: mode ${perm.toString(8)} (files are 0644 or 0755)`);
    if (nlink !== 1) throw new CoreFail(`${where}: hard links are not supported`);
  } else if (fmt === S_IFDIR) {
    type = 'dir';
    if (perm !== 0o755) throw new CoreFail(`${where}: mode ${perm.toString(8)} (directories are 0755)`);
  } else if (fmt === S_IFLNK) {
    type = 'symlink';
    if (perm & 0o7000) throw new CoreFail(`${where}: mode ${perm.toString(8)} (no setuid, setgid or sticky bit)`);
    if (size < 1 || size >= BLK) throw new CoreFail(`${where}: a symlink target of ${size} bytes`);
  } else {
    throw new CoreFail(`${where}: only regular files, directories and symlinks are allowed`);
  }
  const nblocks = layout === LAYOUT_INLINE ? Math.floor(size / BLK) : Math.ceil(size / BLK);
  if (nblocks && (blkaddr + nblocks) * BLK > total) throw new CoreFail(`${where}: data outside the image`);
  const tail = layout === LAYOUT_INLINE ? size % BLK : 0;
  const tailOff = off + isize;
  if (tail && (tailOff % BLK) + tail > BLK) throw new CoreFail(`${where}: inline data crosses a block boundary`);
  if (tail && tailOff + tail > total) throw new CoreFail(`${where}: inline data outside the image`);
  const read = () => {
    const whole = b.subarray(blkaddr * BLK, blkaddr * BLK + Math.min(size, nblocks * BLK));
    return tail ? concat(whole, b.subarray(tailOff, tailOff + tail)) : whole;
  };
  return { nid, type, mode, size, nlink, read };
}

/** Exact port of readErofs for a whole image in `b` (validation only: the entries are not collected). */
function erofsFull(b) {
  const total = b.length;
  const { metaBase, rootNid } = erofsSuperblock(b, total);
  const seen = new Set([rootNid]);
  const root = erofsInode(b, total, metaBase, rootNid, 'the root');
  if (root.type !== 'dir') throw new CoreFail('the root is not a directory');
  const stack = [{ ino: root, rel: '', parentNid: rootNid }];
  while (stack.length) {
    const { ino, rel, parentNid } = stack.pop();
    const where = rel || 'the root';
    const data = ino.read();
    let prevName = null;
    let subdirs = 0;
    let dots = 0;
    for (let base = 0; base < data.length; base += BLK) {
      const chunk = data.subarray(base, Math.min(base + BLK, data.length));
      const cdv = view(chunk);
      if (chunk.length < DIRENT) throw new CoreFail(`${where}: a truncated directory block`);
      const first = cdv.getUint16(8, true);
      if (first < DIRENT || first % DIRENT || first >= chunk.length) throw new CoreFail(`${where}: an invalid directory block`);
      const n = first / DIRENT;
      for (let j = 0; j < n; j++) {
        const nid = Number(cdv.getBigUint64(j * DIRENT, true));
        const nameoff = cdv.getUint16(j * DIRENT + 8, true);
        const ft = cdv.getUint8(j * DIRENT + 10);
        const end = j + 1 < n ? cdv.getUint16((j + 1) * DIRENT + 8, true) : chunk.length;
        if (nameoff < first || end > chunk.length || end <= nameoff) throw new CoreFail(`${where}: an invalid directory entry`);
        let nameBuf = chunk.subarray(nameoff, end);
        if (j + 1 === n) {
          const z = nameBuf.indexOf(0);
          if (z >= 0) nameBuf = nameBuf.subarray(0, z);
        }
        if (nameBuf.length < 1 || nameBuf.length > NAME_MAX || nameBuf.includes(0x2f) || nameBuf.includes(0)) {
          throw new CoreFail(`${where}: an invalid name in the directory`);
        }
        if (prevName && cmpBytes(prevName, nameBuf) >= 0) throw new CoreFail(`${where}: directory entries are not sorted`);
        prevName = nameBuf;
        const name = utf8(nameBuf, 0, nameBuf.length);
        if (name === '.' || name === '..') {
          if (nid !== (name === '.' ? ino.nid : parentNid) || ft !== FT.dir) throw new CoreFail(`${where}: a wrong "${name}" entry`);
          dots++;
          continue;
        }
        const r = rel ? rel + '/' + name : name;
        if (seen.has(nid)) throw new CoreFail(`"${r}": an inode reached twice (a hard link or a cycle)`);
        seen.add(nid);
        const child = erofsInode(b, total, metaBase, nid, `"${r}"`);
        if (FT[child.type] !== ft) throw new CoreFail(`"${r}": the directory entry's type does not match the inode`);
        if (child.type === 'dir') {
          subdirs++;
          stack.push({ ino: child, rel: r, parentNid: ino.nid });
        } else if (child.type === 'symlink') {
          const t = child.read();
          checkSymlink(r, utf8(t, 0, t.length));
        }
      }
    }
    if (dots !== 2) throw new CoreFail(`${where}: the directory lacks "." or ".."`);
    if (ino.nlink !== 2 + subdirs) throw new CoreFail(`${where}: a link count of ${ino.nlink} for ${subdirs} subdirectories`);
  }
}

class ErofsSink {
  constructor(total, fullMax) {
    if (total < BLK || total % BLK) throw new CoreFail(`the image is ${total} bytes, not a whole number of 4 KiB blocks`);
    this.total = total;
    this.full = total <= fullMax;
    this.buf = new Uint8Array(this.full ? total : Math.min(total, EROFS_PREFIX));
    this.fill = 0;
    this.sb = null;
    this.rootChecked = false;
  }

  write(chunk) {
    const n = Math.min(chunk.length, this.buf.length - this.fill);
    if (n > 0) {
      this.buf.set(chunk.subarray(0, n), this.fill);
      this.fill += n;
    }
    if (!this.sb && this.fill >= SB_OFFSET + 128) this.sb = erofsSuperblock(this.buf, this.total); // fail fast
    if (!this.full && !this.rootChecked && this.sb && this.fill >= EROFS_PREFIX) this.checkRoot();
  }

  checkRoot() {
    this.rootChecked = true;
    const { metaBase, rootNid } = this.sb;
    const off = metaBase + rootNid * ISLOT;
    if (!Number.isSafeInteger(off) || off + 64 > this.fill) {
      // the root inode is outside the kept prefix: unchecked (never the case for mkfs.erofs / erofs.js images)
      if (off < META_START || off + ISLOT > this.total) throw new CoreFail(`the root: inode ${rootNid} is outside the image`);
      return;
    }
    const root = erofsInode(this.buf, this.total, metaBase, rootNid, 'the root');
    if (root.type !== 'dir') throw new CoreFail('the root is not a directory');
  }

  finish() {
    if (this.full) erofsFull(this.buf);
    else {
      if (!this.sb) this.sb = erofsSuperblock(this.buf, this.total);
      if (!this.rootChecked) this.checkRoot();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the verifier

const ST_HEADER = 0;
const ST_BODY = 1;
const ST_PAD = 2;
const ST_END = 3;

class Verifier {
  constructor(opts) {
    this.label = opts.label;
    this.maxBytes = opts.maxBytes;
    this.erofsFullMax = opts.erofsFullCheckMax;
    this.whole = createHash('sha256');
    this.size = 0;
    this.state = ST_HEADER;
    this.hdr = new Uint8Array(BLOCK);
    this.hdrFill = 0;
    this.endBytes = 0;
    this.entryCount = 0;
    this.seen = new Set();
    this.cur = null;
    // package level state (load)
    this.manifest = null;
    this.manifestBytes = null;
    this.packageId = null;
    this.root = null;
    this.coreName = null;
    this.phase = 0;
    this.prev = null;
    this.prevBytes = null;
    this.dirs = new Set();
    this.uiBytes = 0;
    this.coreEntry = null;
    this.iconEntry = null;
    this.present = new Set();
  }

  fail(msg) {
    return new VerifyError(msg);
  }

  tarFail(e) {
    return new VerifyError(`${this.label}: ${e.message}`);
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw this.fail(`${this.label}: the stream delivered a chunk that is not a Uint8Array`);
    if (chunk.length === 0) return;
    if (this.size + chunk.length > this.maxBytes) throw this.fail(`${this.label} is larger than the limit of ${this.maxBytes} bytes`);
    this.whole.update(chunk);
    this.size += chunk.length;
    let pos = 0;
    const len = chunk.length;
    while (pos < len) {
      switch (this.state) {
        case ST_HEADER: {
          if (this.hdrFill === 0 && len - pos >= BLOCK) {
            this.onHeader(chunk.subarray(pos, pos + BLOCK));
            pos += BLOCK;
          } else {
            const n = Math.min(BLOCK - this.hdrFill, len - pos);
            this.hdr.set(chunk.subarray(pos, pos + n), this.hdrFill);
            this.hdrFill += n;
            pos += n;
            if (this.hdrFill === BLOCK) {
              this.hdrFill = 0;
              this.onHeader(this.hdr);
            }
          }
          break;
        }
        case ST_BODY: {
          const cur = this.cur;
          const n = Math.min(cur.remaining, len - pos);
          this.feed(cur, chunk.subarray(pos, pos + n));
          cur.remaining -= n;
          pos += n;
          if (cur.remaining === 0) this.bodyDone();
          break;
        }
        case ST_PAD: {
          const cur = this.cur;
          const n = Math.min(cur.pad, len - pos);
          if (!isZero(chunk, pos, pos + n)) throw this.fail(`${this.label}: entry "${cur.path}": non-zero padding`);
          cur.pad -= n;
          pos += n;
          if (cur.pad === 0) this.entryDone();
          break;
        }
        default: {
          // ST_END: after the first zero block only zeros may follow
          if (!isZero(chunk, pos, len)) throw this.fail(`${this.label}: data after end-of-archive marker`);
          this.endBytes += len - pos;
          pos = len;
        }
      }
    }
  }

  onHeader(b) {
    if (isZero(b, 0, BLOCK)) {
      this.state = ST_END;
      this.endBytes = BLOCK;
      return;
    }
    let h;
    try {
      h = parseTarHeader(b, this.entryCount);
    } catch (e) {
      if (e instanceof TarFail) throw this.tarFail(e);
      throw e;
    }
    if (this.seen.has(h.path)) throw this.fail(`${this.label}: duplicate entry "${h.path}"`);
    if (this.seen.size >= MAX_TAR_ENTRIES) throw this.fail(`${this.label}: more than ${MAX_TAR_ENTRIES} entries are not supported`);
    this.seen.add(h.path);
    this.beginEntry(h);
    const cur = this.cur;
    cur.path = h.path;
    cur.type = h.type;
    cur.size = h.size;
    cur.remaining = h.size;
    cur.pad = Math.ceil(h.size / BLOCK) * BLOCK - h.size;
    if (cur.remaining > 0) this.state = ST_BODY;
    else this.bodyDone();
  }

  /** Entry classification: the first entry, then the loop of package.js load(). Sets this.cur. */
  beginEntry(h) {
    const { path: p, type, size } = h;
    if (this.entryCount === 0) {
      if (p !== 'vmapp.json' || type !== 'file') {
        throw this.fail(`${this.label}: the first entry must be vmapp.json (found "${p}")`);
      }
      if (size > MAX_MANIFEST) throw this.fail(`${this.label}: vmapp.json is ${size} bytes, larger than the limit of ${MAX_MANIFEST}`);
      this.cur = { kind: 'manifest', buf: new Uint8Array(size), fill: 0 };
      return;
    }
    const root = this.root;
    const coreName = this.coreName;
    const inUi = p === root || p.startsWith(root + '/');
    let kind;
    if (inUi) {
      if (this.phase !== 0) throw this.fail(`entry order: "${p}" comes after ${coreName}/icon.png (UI entries must come first)`);
      const pb = encoder.encode(p);
      if (this.prev === null) {
        if (p !== root || type !== 'dir') {
          throw this.fail(`entry order: expected directory entry "${root}/" first after vmapp.json, found "${p}"`);
        }
      } else if (cmpBytes(this.prevBytes, pb) >= 0) {
        throw this.fail(`entry order: "${p}" must sort after "${this.prev}"`);
      }
      if (p !== root) {
        const parent = p.slice(0, p.lastIndexOf('/'));
        if (!this.dirs.has(parent)) throw this.fail(`entry "${p}": parent directory "${parent}/" has no directory entry before it`);
      }
      if (type === 'dir') this.dirs.add(p);
      else {
        this.uiBytes += size;
        if (this.uiBytes > LIMITS.MAX_UI) throw this.fail(`${root}/ is at least ${this.uiBytes} bytes, larger than the limit of ${LIMITS.MAX_UI}`);
      }
      this.prev = p;
      this.prevBytes = pb;
      kind = type === 'dir' ? 'dir' : 'ui';
    } else if (p === coreName) {
      if (type !== 'file') throw this.fail(`${coreName} must be a regular file`);
      if (this.prev === null) throw this.fail(`entry order: UI directory "${root}/" must precede ${coreName}`);
      if (this.phase !== 0) throw this.fail(`entry order: ${coreName} must come right after the UI entries`);
      const maxCore = coreName === 'core.erofs' ? LIMITS.MAX_CORE_EROFS : LIMITS.MAX_CORE;
      if (size > maxCore) throw this.fail(`${coreName} is ${size} bytes, larger than the limit of ${maxCore}`);
      this.phase = 1;
      this.coreEntry = { size };
      kind = 'core';
    } else if (p === 'icon.png') {
      if (type !== 'file') throw this.fail('icon.png must be a regular file');
      if (this.phase !== 1) throw this.fail(`entry order: icon.png must come last, right after ${coreName}`);
      this.phase = 2;
      this.iconEntry = { size };
      kind = 'icon';
    } else {
      throw this.fail(`unexpected entry "${p}" (allowed: vmapp.json, ${root}/..., ${coreName}, icon.png)`);
    }
    this.cur = { kind };
    if (type === 'dir') return;
    if (!hasOwn(this.manifest.files, p)) throw this.fail(`package entry "${p}" is not listed in vmapp.json files`);
    this.present.add(p);
    this.cur.hash = createHash('sha256');
    this.cur.expected = this.manifest.files[p];
    if (kind === 'core') {
      try {
        this.cur.sink = coreName === 'core.erofs' ? new ErofsSink(size, this.erofsFullMax) : new CpioSink(size);
      } catch (e) {
        if (!(e instanceof CoreFail)) throw e;
        this.cur.sinkError = e;
      }
    } else if (kind === 'icon') {
      this.cur.head = new Uint8Array(8);
      this.cur.headFill = 0;
    }
  }

  feed(cur, bytes) {
    if (cur.kind === 'manifest') {
      cur.buf.set(bytes, cur.fill);
      cur.fill += bytes.length;
      return;
    }
    cur.hash.update(bytes);
    if (cur.kind === 'core') {
      if (cur.sink && !cur.sinkError) {
        try {
          cur.sink.write(bytes);
        } catch (e) {
          if (!(e instanceof CoreFail)) throw e;
          cur.sinkError = e; // reported after the hash check, like load()
        }
      }
    } else if (cur.kind === 'icon' && cur.headFill < 8) {
      const n = Math.min(8 - cur.headFill, bytes.length);
      cur.head.set(bytes.subarray(0, n), cur.headFill);
      cur.headFill += n;
    }
  }

  bodyDone() {
    const cur = this.cur;
    if (cur.kind === 'manifest') {
      this.manifestBytes = cur.buf;
      this.manifest = parseManifest(this.manifestBytes, { files: 'required' });
      this.packageId = sha256hex(this.manifestBytes);
      this.root = this.manifest.ui.root;
      this.coreName = `core.${this.manifest.core.image || 'cpio'}`;
    } else if (cur.kind !== 'dir') {
      const actual = cur.hash.digest('hex');
      if (actual !== cur.expected) {
        throw this.fail(`hash mismatch for "${cur.path}": vmapp.json says ${cur.expected}, actual ${actual}`);
      }
      if (cur.kind === 'core') {
        try {
          if (cur.sinkError) throw cur.sinkError;
          cur.sink.finish();
        } catch (e) {
          if (e instanceof CoreFail) throw this.fail(`${this.coreName} is invalid: ${e.message}`);
          throw e;
        }
      } else if (cur.kind === 'icon') {
        if (cur.size < 8 || PNG_MAGIC.some((v, i) => cur.head[i] !== v)) throw this.fail('icon.png is not a PNG file');
      }
    }
    if (cur.pad > 0) this.state = ST_PAD;
    else this.entryDone();
  }

  entryDone() {
    this.cur = null;
    this.entryCount++;
    this.state = ST_HEADER;
  }

  finish() {
    const label = this.label;
    switch (this.state) {
      case ST_HEADER:
        if (this.hdrFill > 0) throw this.fail(`${label}: truncated archive: partial header block`);
        throw this.fail(`${label}: truncated archive: missing end-of-archive marker`);
      case ST_BODY:
        throw this.fail(`${label}: entry "${this.cur.path}": truncated data`);
      case ST_PAD:
        throw this.fail(`${label}: entry "${this.cur.path}": truncated padding`);
      default:
        if (this.endBytes < BLOCK * 2) throw this.fail(`${label}: truncated archive: end-of-archive marker needs two zero blocks`);
    }
    if (this.entryCount === 0) throw this.fail(`${label}: the first entry must be vmapp.json`);
    if (this.prev === null) throw this.fail(`package has no UI directory "${this.root}/"`);
    if (!this.coreEntry) throw this.fail(`package has no ${this.coreName} entry`);
    for (const k of Object.keys(this.manifest.files)) {
      if (!this.present.has(k)) throw this.fail(`vmapp.json lists "${k}" in files but the package has no such entry`);
    }
    return {
      manifest: this.manifest,
      manifestBytes: this.manifestBytes,
      packageId: this.packageId,
      size: this.size,
      sha256: this.whole.digest('hex'),
      uiBytes: this.uiBytes,
      coreName: this.coreName,
      coreBytes: this.coreEntry.size,
      hasIcon: !!this.iconEntry,
    };
  }
}

/**
 * Verifies a whole .vmapp read from a stream, holding only the manifest and small state in memory.
 * Resolves { manifest, manifestBytes, packageId, size, sha256, uiBytes, coreName, coreBytes, hasIcon } (the values
 * hostlib/package.js load() returns for the same bytes, plus sha256 of the whole package) or rejects with
 * VerifyError (package structure) or ManifestError (from hostlib/manifest.js).
 * @param {ReadableStream<Uint8Array>} stream the whole .vmapp
 * @param {{maxBytes?: number, label?: string, erofsFullCheckMax?: number}} [opts]
 */
export async function verifyPackageStream(stream, opts = {}) {
  const v = new Verifier({
    label: opts.label ?? 'package',
    maxBytes: opts.maxBytes ?? LIMITS.MAX_PACKAGE,
    erofsFullCheckMax: opts.erofsFullCheckMax ?? EROFS_FULL_CHECK_MAX,
  });
  const reader = stream.getReader();
  try {
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        throw new VerifyError(`${v.label}: reading the package failed: ${e && e.message ? e.message : String(e)}`, { cause: e });
      }
      if (r.done) break;
      v.push(r.value);
    }
    return v.finish();
  } catch (e) {
    reader.cancel(e).catch(() => {}); // release the source; the verdict is already known
    throw e;
  }
}

export const __test = { checkSymlink, cmpBytes, CoreFail };
