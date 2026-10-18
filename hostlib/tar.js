'use strict';
// Deterministic POSIX ustar writer and strict reader for .vmapp packages (SPEC section 2).
//
// Writer: regular files (mode 0644) and directories (mode 0755), uid/gid 0, mtime 0, long paths through the ustar
// prefix field. Reader: accepts exactly what the writer produces and rejects everything else (links, devices, pax or
// GNU headers, absolute or ".." paths, duplicates, wrong ownership or times, bad checksums).

const BLOCK = 512;
const MAX_PATH_BYTES = 255;
const MAX_NAME = 100;
const MAX_PREFIX = 155;

class TarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TarError';
  }
}

/**
 * Validates an archive path. Returns the canonical form (no trailing slash).
 * Rules (SPEC 2): relative, no ".." / "." / empty components, at most 255 bytes (the stored name, which for
 * directories includes the trailing slash). Also rejects NUL, control characters and backslashes.
 */
function validatePath(p, { dir = false } = {}) {
  if (typeof p !== 'string' || p.length === 0) throw new TarError('invalid path: empty');
  if (p.startsWith('/')) throw new TarError(`invalid path "${p}": absolute paths are not allowed`);
  let q = p;
  if (q.endsWith('/')) q = q.slice(0, -1);
  if (q.length === 0) throw new TarError(`invalid path "${p}": empty`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(q)) throw new TarError(`invalid path "${p}": control characters and backslashes are not allowed`);
  for (const c of q.split('/')) {
    if (c === '') throw new TarError(`invalid path "${p}": empty path component`);
    if (c === '.' || c === '..') throw new TarError(`invalid path "${p}": "${c}" component is not allowed`);
  }
  const stored = dir ? q + '/' : q;
  if (Buffer.byteLength(stored, 'utf8') > MAX_PATH_BYTES) {
    throw new TarError(`invalid path "${p}": longer than ${MAX_PATH_BYTES} bytes`);
  }
  return q;
}

function octal(value, width) {
  // width includes the trailing NUL
  const s = Math.floor(value).toString(8);
  if (s.length > width - 1) throw new TarError(`value ${value} does not fit in a ${width}-byte octal field`);
  return s.padStart(width - 1, '0') + '\0';
}

function splitName(stored) {
  const bytes = Buffer.from(stored, 'utf8');
  if (bytes.length <= MAX_NAME) return { name: bytes, prefix: Buffer.alloc(0) };
  // choose the smallest split index such that the name part fits in 100 bytes (longest name, shortest prefix)
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x2f) continue;
    const prefix = bytes.subarray(0, i);
    const name = bytes.subarray(i + 1);
    if (name.length > 0 && name.length <= MAX_NAME && prefix.length <= MAX_PREFIX) return { name, prefix };
  }
  throw new TarError(`path "${stored}" cannot be split into ustar name and prefix fields`);
}

/** Low level: builds one 512-byte header block. No validation of semantics (used by tests to craft bad archives). */
function encodeHeader(h) {
  const b = Buffer.alloc(BLOCK);
  const put = (off, val, len) => {
    const v = Buffer.isBuffer(val) ? val : Buffer.from(val, 'utf8');
    if (v.length > len) throw new TarError('header field too long');
    v.copy(b, off);
  };
  put(0, h.name, MAX_NAME);
  put(100, h.mode !== undefined ? h.mode : octal(h.type === 'dir' ? 0o755 : 0o644, 8), 8);
  put(108, h.uid !== undefined ? h.uid : octal(0, 8), 8);
  put(116, h.gid !== undefined ? h.gid : octal(0, 8), 8);
  put(124, h.size !== undefined ? h.size : octal(0, 12), 12);
  put(136, h.mtime !== undefined ? h.mtime : octal(0, 12), 12);
  b.fill(0x20, 148, 156);
  b[156] = (h.typeflag !== undefined ? h.typeflag : h.type === 'dir' ? '5' : '0').charCodeAt(0);
  if (h.linkname) put(157, h.linkname, 100);
  put(257, h.magic !== undefined ? h.magic : 'ustar\0', 6);
  put(263, h.version !== undefined ? h.version : '00', 2);
  if (h.uname) put(265, h.uname, 32);
  if (h.gname) put(297, h.gname, 32);
  put(329, h.devmajor !== undefined ? h.devmajor : octal(0, 8), 8);
  put(337, h.devminor !== undefined ? h.devminor : octal(0, 8), 8);
  if (h.prefix && h.prefix.length) put(345, h.prefix, MAX_PREFIX);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  if (h.chksum !== undefined) put(148, h.chksum, 8);
  else Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ').copy(b, 148);
  return b;
}

/**
 * Writes a ustar archive.
 * entries: [{ path, type: 'file' | 'dir', data?: Buffer }] in the order to be written.
 * Returns a Buffer. Duplicate paths and invalid paths throw TarError.
 */
function writeTar(entries) {
  const seen = new Set();
  const parts = [];
  for (const e of entries) {
    if (e.type !== 'file' && e.type !== 'dir') throw new TarError(`unsupported entry type "${e.type}" for "${e.path}"`);
    const isDir = e.type === 'dir';
    const p = validatePath(e.path, { dir: isDir });
    if (seen.has(p)) throw new TarError(`duplicate path "${p}"`);
    seen.add(p);
    const stored = isDir ? p + '/' : p;
    const { name, prefix } = splitName(stored);
    const data = isDir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    parts.push(encodeHeader({ name, prefix, type: e.type, size: octal(data.length, 12) }));
    if (data.length) {
      parts.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function isZero(buf, start, end) {
  for (let i = start; i < end; i++) if (buf[i] !== 0) return false;
  return true;
}

function cstr(buf, start, len) {
  let end = start;
  const max = start + len;
  while (end < max && buf[end] !== 0) end++;
  return buf.subarray(start, end);
}

function parseOctal(buf, start, len, field, where) {
  if (buf[start] & 0x80) throw new TarError(`${where}: base-256 ${field} is not allowed`);
  let s = buf.toString('latin1', start, start + len);
  s = s.replace(/[\0 ]+$/g, '').replace(/^ +/, '');
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`${where}: invalid ${field} field`);
  return parseInt(s, 8);
}

/**
 * Strict reader. Returns [{ path, type: 'file'|'dir', size, data }] in archive order (paths without trailing slash).
 * opts.maxBytes: reject archives larger than this.
 */
function readTar(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) throw new TarError('readTar expects a Buffer');
  if (opts.maxBytes !== undefined && buf.length > opts.maxBytes) {
    throw new TarError(`archive is ${buf.length} bytes, larger than the limit of ${opts.maxBytes}`);
  }
  const entries = [];
  const seen = new Set();
  let off = 0;
  let ended = false;
  while (off < buf.length) {
    if (off + BLOCK > buf.length) throw new TarError('truncated archive: partial header block');
    if (isZero(buf, off, off + BLOCK)) {
      // end of archive: need at least two zero blocks; the rest must be zeros
      if (!isZero(buf, off, buf.length)) throw new TarError('data after end-of-archive marker');
      if (buf.length - off < BLOCK * 2) throw new TarError('truncated archive: end-of-archive marker needs two zero blocks');
      ended = true;
      break;
    }
    const idx = entries.length;
    const where = `tar entry #${idx + 1}`;
    // checksum
    const stored = parseOctal(buf, off + 148, 8, 'checksum', where);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[off + i];
    if (sum !== stored) throw new TarError(`${where}: bad header checksum`);
    // magic / version
    if (buf.toString('latin1', off + 257, off + 263) !== 'ustar\0' || buf.toString('latin1', off + 263, off + 265) !== '00') {
      throw new TarError(`${where}: not a POSIX ustar header (magic/version)`);
    }
    const typeflag = String.fromCharCode(buf[off + 156]);
    const nameBytes = cstr(buf, off, MAX_NAME);
    const prefixBytes = cstr(buf, off + 345, MAX_PREFIX);
    let full = nameBytes.toString('utf8');
    if (prefixBytes.length) full = prefixBytes.toString('utf8') + '/' + full;
    if (typeflag === '0' || typeflag === '5') {
      // ok
    } else if (typeflag === '1' || typeflag === '2') {
      throw new TarError(`entry "${full}": links are not allowed`);
    } else if (typeflag === '3' || typeflag === '4' || typeflag === '6') {
      throw new TarError(`entry "${full}": devices and fifos are not allowed`);
    } else if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
      throw new TarError(`entry "${full}": pax/GNU extension headers are not allowed`);
    } else {
      throw new TarError(`entry "${full}": unsupported entry type ${JSON.stringify(typeflag)}`);
    }
    const isDir = typeflag === '5';
    if (isDir !== full.endsWith('/')) {
      throw new TarError(`entry "${full}": ${isDir ? 'directory name must end with "/"' : 'file name must not end with "/"'}`);
    }
    let p;
    try {
      p = validatePath(full, { dir: isDir });
    } catch (e) {
      throw new TarError(`tar entry #${idx + 1}: ${e.message}`);
    }
    if (cstr(buf, off + 157, 100).length) throw new TarError(`entry "${p}": link name must be empty`);
    const mode = parseOctal(buf, off + 100, 8, 'mode', where);
    const uid = parseOctal(buf, off + 108, 8, 'uid', where);
    const gid = parseOctal(buf, off + 116, 8, 'gid', where);
    const mtime = parseOctal(buf, off + 136, 12, 'mtime', where);
    const size = parseOctal(buf, off + 124, 12, 'size', where);
    if (uid !== 0 || gid !== 0) throw new TarError(`entry "${p}": uid/gid must be 0 (got ${uid}/${gid})`);
    if (mtime !== 0) throw new TarError(`entry "${p}": mtime must be 0 (got ${mtime})`);
    const wantMode = isDir ? 0o755 : 0o644;
    if (mode !== wantMode) {
      throw new TarError(`entry "${p}": mode must be ${wantMode.toString(8).padStart(4, '0')} (got ${mode.toString(8).padStart(4, '0')})`);
    }
    if (isDir && size !== 0) throw new TarError(`entry "${p}": directory with non-zero size`);
    if (seen.has(p)) throw new TarError(`duplicate entry "${p}"`);
    seen.add(p);
    off += BLOCK;
    if (off + size > buf.length) throw new TarError(`entry "${p}": truncated data`);
    const data = buf.subarray(off, off + size);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (off + padded > buf.length) throw new TarError(`entry "${p}": truncated padding`);
    if (!isZero(buf, off + size, off + padded)) throw new TarError(`entry "${p}": non-zero padding`);
    off += padded;
    entries.push({ path: p, type: isDir ? 'dir' : 'file', size, data });
  }
  if (!ended) throw new TarError('truncated archive: missing end-of-archive marker');
  return entries;
}

module.exports = {
  TarError,
  BLOCK,
  MAX_PATH_BYTES,
  validatePath,
  writeTar,
  readTar,
  encodeHeader,
  octal,
};
