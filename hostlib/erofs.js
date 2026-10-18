'use strict';
// Deterministic EROFS writer (from a directory tree) and a validating reader: an app's core as a read-only file system image
// (SPEC section 2.1, `core.image: "erofs"`). The guest mounts it from /dev/vdb at /app as it is, instead of copying a cpio into
// memory: the core's files cost no RAM (the kernel's page cache holds what is read, and gives it back under pressure).
//
// The format is the Linux kernel's (fs/erofs/erofs_fs.h), the subset written here and accepted by the reader:
//   4 KiB blocks; the superblock at byte 1024 of block 0; no compression, no extended attributes, no extra devices, no checksum;
//   inodes of 32 bytes ("compact"; the reader also accepts 64-byte "extended" ones) in the metadata area from byte 1152 (the root
//   is nid 36, as mkfs.erofs places it); data "flat plain" (whole blocks after the metadata) or "flat inline" (whole blocks, plus the
//   last partial block stored right after the inode, inside the same metadata block).
// The tree rules are those of core.cpio (cpio.js): regular files, directories and relative symlinks that stay inside the tree;
// uid/gid 0, time 0, modes 0755 (directories, executable files) / 0644 (other files) / 0777 (symlinks). Directory entries are
// sorted by name (byte order), "." and ".." included, as the kernel's lookup requires. The same tree gives the same bytes: inodes
// are laid out in path order, the UUID is derived from the image's content.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CpioError, checkSymlink } = require('./cpio');

class ErofsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErofsError';
  }
}

const MAGIC = 0xe0f5e1e2;
const BLKSZBITS = 12;
const BLK = 1 << BLKSZBITS;
const SB_OFFSET = 1024;
const META_START = 1152; // after the 128-byte superblock: nid 36
const ISLOT = 32; // inode slot size (nid = offset / 32)
const DIRENT = 12; // __le64 nid, __le16 nameoff, __u8 file_type, __u8 reserved
const NAME_MAX = 255;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const FT = { file: 1, dir: 2, symlink: 7 }; // EROFS_FT_REG_FILE, _DIR, _SYMLINK
const LAYOUT_PLAIN = 0; // EROFS_INODE_FLAT_PLAIN
const LAYOUT_INLINE = 2; // EROFS_INODE_FLAT_INLINE
const COMPAT_SB_CHKSUM = 0x1;
const COMPAT_MTIME = 0x2;
const IGNORED_NAMES = new Set(['.DS_Store']);

const cmpBytes = (a, b) => Buffer.compare(a, b);

/** Reads the tree below `root` into nodes (the root first, then every entry in path order). */
function scan(root) {
  const nodes = [];
  const visit = (abs, rel, parent) => {
    const node = { rel, kind: 'dir', parent, children: [], subdirs: 0 };
    nodes.push(node);
    const names = fs.readdirSync(abs).filter((n) => !IGNORED_NAMES.has(n));
    const entries = names.map((n) => ({ n, b: Buffer.from(n, 'utf8') })).sort((x, y) => cmpBytes(x.b, y.b));
    for (const { n, b } of entries) {
      if (b.length > NAME_MAX) throw new ErofsError(`"${rel ? rel + '/' : ''}${n}": a name longer than ${NAME_MAX} bytes`);
      if (n.includes('\0')) throw new ErofsError(`invalid name "${n}"`);
      const r = rel ? rel + '/' + n : n;
      const full = path.join(abs, n);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        node.subdirs++;
        node.children.push({ name: b, node: visit(full, r, node) });
      } else if (st.isFile()) {
        if (st.size > 0xffffffff) throw new ErofsError(`"${r}": files of 4 GiB or more are not supported`);
        const child = { rel: r, kind: 'file', abs: full, exec: (st.mode & 0o111) !== 0, size: st.size };
        nodes.push(child);
        node.children.push({ name: b, node: child });
      } else if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        try {
          checkSymlink(r, target);
        } catch (e) {
          throw e instanceof CpioError ? new ErofsError(e.message) : e;
        }
        const data = Buffer.from(target, 'utf8');
        if (data.length >= BLK) throw new ErofsError(`symlink "${r}": target longer than ${BLK - 1} bytes`);
        const child = { rel: r, kind: 'symlink', data, size: data.length };
        nodes.push(child);
        node.children.push({ name: b, node: child });
      } else {
        throw new ErofsError(`"${r}": only regular files, directories and symlinks are allowed`);
      }
    }
    if (node.subdirs + 2 > 0xffff) throw new ErofsError(`"${rel || '.'}": too many subdirectories`);
    return node;
  };
  visit(root, '', null);
  return nodes;
}

/** Splits a directory's entries (sorted, with "." and "..") into blocks; returns [[entry…]…] and the directory's size. */
function dirBlocks(node) {
  const all = [
    { name: Buffer.from('.'), node, ft: FT.dir },
    { name: Buffer.from('..'), node: node.parent || node, ft: FT.dir },
    ...node.children.map((c) => ({ name: c.name, node: c.node, ft: FT[c.node.kind] })),
  ].sort((a, b) => cmpBytes(a.name, b.name));
  const blocks = [];
  let cur = [];
  let used = 0;
  for (const e of all) {
    const need = DIRENT + e.name.length;
    if (used + need > BLK) {
      blocks.push({ entries: cur, used });
      cur = [];
      used = 0;
    }
    cur.push(e);
    used += need;
  }
  blocks.push({ entries: cur, used });
  return { blocks, size: (blocks.length - 1) * BLK + blocks[blocks.length - 1].used };
}

/**
 * Builds an EROFS image of a directory. Returns a Buffer (a whole number of 4 KiB blocks).
 * opts.maxBytes: fail if the image would be bigger.
 */
function erofsFromDir(dir, opts = {}) {
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new ErofsError(`"${dir}" is not a directory`);
  const nodes = scan(dir);
  for (const n of nodes) {
    if (n.kind === 'dir') {
      n.dir = dirBlocks(n);
      n.size = n.dir.size;
    }
  }

  // the metadata area: each inode at a 32-byte slot, the tail of its data right after it when it fits in the same block
  let pos = META_START;
  for (const n of nodes) {
    const tail = n.size % BLK;
    n.layout = tail > 0 && ISLOT + tail <= BLK ? LAYOUT_INLINE : LAYOUT_PLAIN;
    if (n.layout === LAYOUT_INLINE && (pos % BLK) + ISLOT + tail > BLK) pos = Math.ceil(pos / BLK) * BLK;
    n.offset = pos;
    n.nid = (pos - 0) / ISLOT; // meta_blkaddr 0
    n.tail = n.layout === LAYOUT_INLINE ? tail : 0;
    pos += Math.ceil((ISLOT + n.tail) / ISLOT) * ISLOT;
  }
  // the data area: the whole blocks of every inode, in the same order
  let blk = Math.ceil(pos / BLK);
  for (const n of nodes) {
    n.nblocks = n.layout === LAYOUT_INLINE ? Math.floor(n.size / BLK) : Math.ceil(n.size / BLK);
    n.blkaddr = n.nblocks ? blk : 0;
    blk += n.nblocks;
  }
  const total = blk * BLK;
  if (opts.maxBytes !== undefined && total > opts.maxBytes) throw new ErofsError(`core files are larger than the limit of ${opts.maxBytes} bytes`);
  if (blk > 0xffffffff) throw new ErofsError('the image is too large');
  const img = Buffer.alloc(total);

  const dirData = (n) => {
    const out = Buffer.alloc(n.size);
    n.dir.blocks.forEach((b, i) => {
      const base = i * BLK;
      let nameoff = b.entries.length * DIRENT;
      b.entries.forEach((e, j) => {
        const at = base + j * DIRENT;
        out.writeBigUInt64LE(BigInt(e.node.nid), at);
        out.writeUInt16LE(nameoff, at + 8);
        out.writeUInt8(e.ft, at + 10);
        e.name.copy(out, base + nameoff);
        nameoff += e.name.length;
      });
    });
    return out;
  };

  nodes.forEach((n, i) => {
    const mode = n.kind === 'dir' ? S_IFDIR | 0o755 : n.kind === 'symlink' ? S_IFLNK | 0o777 : S_IFREG | (n.exec ? 0o755 : 0o644);
    const o = n.offset;
    img.writeUInt16LE(n.layout << 1, o); // i_format: compact (version 0), data layout
    img.writeUInt16LE(0, o + 2); // i_xattr_icount
    img.writeUInt16LE(mode, o + 4);
    img.writeUInt16LE(n.kind === 'dir' ? 2 + n.subdirs : 1, o + 6); // i_nlink
    img.writeUInt32LE(n.size, o + 8);
    img.writeUInt32LE(0, o + 12); // i_mtime (relative to the superblock's build time, 0)
    img.writeUInt32LE(n.blkaddr, o + 16); // i_u.raw_blkaddr
    img.writeUInt32LE(i + 1, o + 20); // i_ino
    // i_uid, i_gid, reserved: 0
    let data;
    if (n.kind === 'dir') data = dirData(n);
    else if (n.kind === 'symlink') data = n.data;
    else {
      data = fs.readFileSync(n.abs);
      if (data.length !== n.size) throw new ErofsError(`"${n.rel}" changed while the image was built`);
    }
    const whole = n.nblocks * BLK;
    data.copy(img, n.blkaddr * BLK, 0, Math.min(whole, data.length));
    if (n.tail) data.copy(img, o + ISLOT, whole, data.length);
  });

  // the superblock
  const sb = SB_OFFSET;
  img.writeUInt32LE(MAGIC, sb);
  img.writeUInt8(BLKSZBITS, sb + 12);
  img.writeUInt16LE(nodes[0].nid, sb + 14); // root_nid
  img.writeBigUInt64LE(BigInt(nodes.length), sb + 16); // inos
  img.writeUInt32LE(blk, sb + 36); // blocks
  img.write('vmapp-core', sb + 64, 'latin1'); // volume_name
  crypto.createHash('sha256').update(img).digest().copy(img, sb + 48, 0, 16); // uuid: from the content
  return img;
}

/**
 * Validating reader. Returns { entries: [{ path, type: 'file'|'dir'|'symlink', mode, size, data? }], files, bytes } (data, the file
 * content or symlink target, only with opts.data). Rejects anything outside the subset above, other file types, owners other than
 * root, modes other than 0755/0644 (a symlink's mode is ignored by Linux: any, without setuid/setgid/sticky), symlinks that escape the
 * tree, hard links, cycles and data outside the image. An uncompressed image of mkfs.erofs (-T0 --all-root -x-1) passes.
 */
function readErofs(buf, opts = {}) {
  if (buf.length < BLK || buf.length % BLK) throw new ErofsError(`the image is ${buf.length} bytes, not a whole number of 4 KiB blocks`);
  const sb = SB_OFFSET;
  if (buf.readUInt32LE(sb) !== MAGIC) throw new ErofsError('not an EROFS image (bad magic)');
  const compat = buf.readUInt32LE(sb + 8);
  if (compat & ~(COMPAT_SB_CHKSUM | COMPAT_MTIME)) throw new ErofsError(`unsupported compatible features 0x${compat.toString(16)}`);
  if (buf.readUInt8(sb + 12) !== BLKSZBITS) throw new ErofsError('the block size must be 4 KiB');
  if (buf.readUInt8(sb + 13) !== 0) throw new ErofsError('superblock extension slots are not supported');
  if (buf.readUInt32LE(sb + 80) !== 0) throw new ErofsError(`unsupported incompatible features 0x${buf.readUInt32LE(sb + 80).toString(16)} (compression, chunks, devices…)`);
  if (buf.readUInt16LE(sb + 86) !== 0) throw new ErofsError('extra devices are not supported');
  if (buf.readUInt8(sb + 90) !== 0) throw new ErofsError('the directory block size must be the block size');
  if (buf.readUInt8(sb + 91) !== 0) throw new ErofsError('extended attribute prefixes are not supported');
  const blocks = buf.readUInt32LE(sb + 36);
  if (blocks * BLK > buf.length) throw new ErofsError(`the superblock counts ${blocks} blocks, the image has ${buf.length / BLK}`);
  const metaBase = buf.readUInt32LE(sb + 40) * BLK;
  const rootNid = buf.readUInt16LE(sb + 14);

  const inode = (nid, where) => {
    const off = metaBase + nid * ISLOT;
    if (!Number.isSafeInteger(off) || off < META_START || off + ISLOT > buf.length) throw new ErofsError(`${where}: inode ${nid} is outside the image`);
    const format = buf.readUInt16LE(off);
    const extended = (format & 1) === 1;
    const isize = extended ? 64 : 32;
    if ((off % BLK) + isize > BLK) throw new ErofsError(`${where}: inode ${nid} crosses a block boundary`);
    if (format & ~0xf) throw new ErofsError(`${where}: unsupported inode format bits 0x${format.toString(16)}`);
    const layout = (format >> 1) & 0x7;
    if (layout !== LAYOUT_PLAIN && layout !== LAYOUT_INLINE) throw new ErofsError(`${where}: compressed or chunked data is not supported`);
    if (buf.readUInt16LE(off + 2) !== 0) throw new ErofsError(`${where}: extended attributes are not supported`);
    const mode = buf.readUInt16LE(off + 4);
    const nlink = extended ? buf.readUInt32LE(off + 44) : buf.readUInt16LE(off + 6);
    const size = extended ? Number(buf.readBigUInt64LE(off + 8)) : buf.readUInt32LE(off + 8);
    const blkaddr = buf.readUInt32LE(off + 16);
    const uid = extended ? buf.readUInt32LE(off + 24) : buf.readUInt16LE(off + 24);
    const gid = extended ? buf.readUInt32LE(off + 28) : buf.readUInt16LE(off + 26);
    if (uid !== 0 || gid !== 0) throw new ErofsError(`${where}: owned by ${uid}:${gid}, not root`);
    const fmt = mode & S_IFMT;
    const perm = mode & 0o7777;
    let type;
    if (fmt === S_IFREG) {
      type = 'file';
      if (perm !== 0o644 && perm !== 0o755) throw new ErofsError(`${where}: mode ${perm.toString(8)} (files are 0644 or 0755)`);
      if (nlink !== 1) throw new ErofsError(`${where}: hard links are not supported`);
    } else if (fmt === S_IFDIR) {
      type = 'dir';
      if (perm !== 0o755) throw new ErofsError(`${where}: mode ${perm.toString(8)} (directories are 0755)`);
    } else if (fmt === S_IFLNK) {
      type = 'symlink';
      if (perm & 0o7000) throw new ErofsError(`${where}: mode ${perm.toString(8)} (no setuid, setgid or sticky bit)`); // Linux ignores a symlink's permissions
      if (size < 1 || size >= BLK) throw new ErofsError(`${where}: a symlink target of ${size} bytes`);
    } else {
      throw new ErofsError(`${where}: only regular files, directories and symlinks are allowed`);
    }
    const nblocks = layout === LAYOUT_INLINE ? Math.floor(size / BLK) : Math.ceil(size / BLK);
    if (nblocks && (blkaddr + nblocks) * BLK > buf.length) throw new ErofsError(`${where}: data outside the image`);
    const tail = layout === LAYOUT_INLINE ? size % BLK : 0;
    const tailOff = off + isize;
    if (tail && (tailOff % BLK) + tail > BLK) throw new ErofsError(`${where}: inline data crosses a block boundary`);
    if (tail && tailOff + tail > buf.length) throw new ErofsError(`${where}: inline data outside the image`);
    const read = () => {
      const whole = buf.subarray(blkaddr * BLK, blkaddr * BLK + Math.min(size, nblocks * BLK));
      return tail ? Buffer.concat([whole, buf.subarray(tailOff, tailOff + tail)]) : whole;
    };
    return { nid, type, mode, size, nlink, read };
  };

  const entries = [];
  const seen = new Set([rootNid]);
  let files = 0;
  let bytes = 0;
  const root = inode(rootNid, 'the root');
  if (root.type !== 'dir') throw new ErofsError('the root is not a directory');
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
      if (chunk.length < DIRENT) throw new ErofsError(`${where}: a truncated directory block`);
      const first = chunk.readUInt16LE(8);
      if (first < DIRENT || first % DIRENT || first >= chunk.length) throw new ErofsError(`${where}: an invalid directory block`);
      const n = first / DIRENT;
      for (let j = 0; j < n; j++) {
        const nid = Number(chunk.readBigUInt64LE(j * DIRENT));
        const nameoff = chunk.readUInt16LE(j * DIRENT + 8);
        const ft = chunk.readUInt8(j * DIRENT + 10);
        const end = j + 1 < n ? chunk.readUInt16LE((j + 1) * DIRENT + 8) : chunk.length;
        if (nameoff < first || end > chunk.length || end <= nameoff) throw new ErofsError(`${where}: an invalid directory entry`);
        let nameBuf = chunk.subarray(nameoff, end);
        if (j + 1 === n) {
          const z = nameBuf.indexOf(0);
          if (z >= 0) nameBuf = nameBuf.subarray(0, z);
        }
        if (nameBuf.length < 1 || nameBuf.length > NAME_MAX || nameBuf.includes(0x2f) || nameBuf.includes(0)) throw new ErofsError(`${where}: an invalid name in the directory`);
        if (prevName && cmpBytes(prevName, nameBuf) >= 0) throw new ErofsError(`${where}: directory entries are not sorted`);
        prevName = nameBuf;
        const name = nameBuf.toString('utf8');
        if (name === '.' || name === '..') {
          if (nid !== (name === '.' ? ino.nid : parentNid) || ft !== FT.dir) throw new ErofsError(`${where}: a wrong "${name}" entry`);
          dots++;
          continue;
        }
        const r = rel ? rel + '/' + name : name;
        if (seen.has(nid)) throw new ErofsError(`"${r}": an inode reached twice (a hard link or a cycle)`);
        seen.add(nid);
        const child = inode(nid, `"${r}"`);
        if (FT[child.type] !== ft) throw new ErofsError(`"${r}": the directory entry's type does not match the inode`);
        if (child.type === 'dir') {
          subdirs++;
          entries.push({ path: r, type: 'dir', mode: child.mode, size: 0 });
          stack.push({ ino: child, rel: r, parentNid: ino.nid });
        } else if (child.type === 'symlink') {
          const target = child.read().toString('utf8');
          try {
            checkSymlink(r, target);
          } catch (e) {
            throw e instanceof CpioError ? new ErofsError(e.message) : e;
          }
          entries.push({ path: r, type: 'symlink', mode: child.mode, size: child.size, ...(opts.data ? { data: Buffer.from(target, 'utf8') } : {}) });
        } else {
          files++;
          bytes += child.size;
          entries.push({ path: r, type: 'file', mode: child.mode, size: child.size, ...(opts.data ? { data: child.read() } : {}) });
        }
      }
    }
    if (dots !== 2) throw new ErofsError(`${where}: the directory lacks "." or ".."`);
    if (ino.nlink !== 2 + subdirs) throw new ErofsError(`${where}: a link count of ${ino.nlink} for ${subdirs} subdirectories`);
  }
  entries.sort((a, b) => cmpBytes(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return { entries, files, bytes };
}

/** True when `buf` starts like an EROFS image (the magic at byte 1024). */
function isErofs(buf) {
  return buf.length >= SB_OFFSET + 4 && buf.readUInt32LE(SB_OFFSET) === MAGIC;
}

module.exports = { ErofsError, erofsFromDir, readErofs, isErofs, BLOCK_SIZE: BLK };
