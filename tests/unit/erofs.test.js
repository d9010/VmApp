'use strict';
// hostlib/erofs.js and the core.image "erofs" packages (SPEC 2.1): the writer, the validating reader, pack/verify/install.
// The kernel's own reading of these images is tested in a real VM (tests/e2e.sh); fsck.erofs agrees with them (docs in erofs.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../../hostlib/package');
const { erofsFromDir, readErofs, isErofs, ErofsError } = require('../../hostlib/erofs');
const { readTar, writeTar } = require('../../hostlib/tar');
const { Store } = require('../../hostlib/store');
const { tmpdir, rmrf, makeProject, write } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function tree(dir) {
  write(path.join(dir, 'main.js'), "console.log('hi')\n");
  write(path.join(dir, 'empty'), '');
  write(path.join(dir, 'bin', 'run.sh'), '#!/bin/sh\n', 0o755);
  for (const n of [4064, 4065, 4096, 4097, 9000, 70000]) write(path.join(dir, 'sizes', `s${n}`), Buffer.alloc(n, n % 251));
  for (let i = 0; i < 500; i++) write(path.join(dir, 'many', `f-${String(i).padStart(4, '0')}-${'x'.repeat(i % 30)}`), `${i}`);
  for (const n of ['!a', '-b', 'Zed', 'a.b', 'ä']) write(path.join(dir, 'names', n), n);
  fs.mkdirSync(path.join(dir, 'deep', 'a', 'b', 'c'), { recursive: true });
  fs.symlinkSync('main.js', path.join(dir, 'link.js'));
  fs.symlinkSync('../main.js', path.join(dir, 'bin', 'up.js'));
}

function walk(root, rel = '') {
  return fs.readdirSync(path.join(root, rel)).sort().flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(path.join(root, r));
    return [r, ...(st.isDirectory() ? walk(root, r) : [])];
  });
}

test('erofsFromDir: reproducible, a whole number of 4 KiB blocks, and the reader gives back the tree', () => {
  const d = tmpdir('erofs-');
  try {
    tree(d);
    const a = erofsFromDir(d);
    assert.ok(a.equals(erofsFromDir(d)), 'the same tree gives the same bytes');
    assert.equal(a.length % 4096, 0);
    assert.ok(isErofs(a));
    const r = readErofs(a, { data: true });
    assert.deepEqual(r.entries.map((e) => e.path).sort(), walk(d).sort());
    for (const e of r.entries) {
      const full = path.join(d, e.path);
      if (e.type === 'file') {
        assert.ok(fs.readFileSync(full).equals(e.data), e.path);
        assert.equal(e.mode & 0o777, (fs.statSync(full).mode & 0o111) ? 0o755 : 0o644, e.path);
      }
      if (e.type === 'symlink') assert.equal(e.data.toString(), fs.readlinkSync(full));
      if (e.type === 'dir') assert.equal(e.mode & 0o777, 0o755);
    }
    assert.equal(r.files, r.entries.filter((e) => e.type === 'file').length);
  } finally {
    rmrf(d);
  }
});

test('erofsFromDir refuses what core.cpio refuses', () => {
  const d = tmpdir('erofs-');
  try {
    write(path.join(d, 'a'), 'x');
    fs.symlinkSync('/etc/passwd', path.join(d, 'abs'));
    assert.throws(() => erofsFromDir(d), /absolute target/);
    fs.unlinkSync(path.join(d, 'abs'));
    fs.symlinkSync('../../outside', path.join(d, 'esc'));
    assert.throws(() => erofsFromDir(d), /escapes/);
    fs.unlinkSync(path.join(d, 'esc'));
    assert.throws(() => erofsFromDir(d, { maxBytes: 1024 }), /larger than the limit/);
  } finally {
    rmrf(d);
  }
});

test('readErofs refuses damaged and unsupported images', () => {
  const d = tmpdir('erofs-');
  try {
    tree(d);
    const good = erofsFromDir(d);
    const bad = (mutate, re) => {
      const b = Buffer.from(good);
      mutate(b);
      assert.throws(() => readErofs(b), (e) => e instanceof ErofsError && re.test(e.message), re.source);
    };
    const rootOff = 36 * 32;
    bad((b) => b.writeUInt32LE(0, 1024), /bad magic/);
    bad((b) => b.writeUInt8(13, 1024 + 12), /block size/);
    bad((b) => b.writeUInt32LE(1, 1024 + 80), /incompatible features/);
    bad((b) => b.writeUInt16LE(2 << 1 | (1 << 4), rootOff), /format bits/);
    bad((b) => b.writeUInt16LE(1 << 1, rootOff), /compressed/); // layout 1: compressed
    bad((b) => b.writeUInt16LE(1, rootOff + 2), /extended attributes/);
    bad((b) => b.writeUInt16LE(1000, rootOff + 24), /not root/);
    bad((b) => b.writeUInt16LE(0o040777, rootOff + 4), /mode 777/);
    bad((b) => b.writeUInt16LE(0o100644, rootOff + 4) && b.writeUInt16LE(1, rootOff + 6), /not a directory/);
    // a file with the setuid bit, a device, data outside the image: find main.js's inode through the reader's own walk
    const findNid = (name) => {
      // the root's directory data is inline after its inode (a small root)
      const size = good.readUInt32LE(rootOff + 8);
      const dir = good.subarray(rootOff + 32, rootOff + 32 + size);
      const n = dir.readUInt16LE(8) / 12;
      for (let j = 0; j < n; j++) {
        const off = dir.readUInt16LE(j * 12 + 8);
        const end = j + 1 < n ? dir.readUInt16LE((j + 1) * 12 + 8) : size;
        if (dir.toString('utf8', off, end).replace(/\0+$/, '') === name) return Number(dir.readBigUInt64LE(j * 12));
      }
      throw new Error(`no ${name}`);
    };
    const main = findNid('main.js') * 32;
    bad((b) => b.writeUInt16LE(0o104755, main + 4), /mode 4755/);
    bad((b) => b.writeUInt16LE(0o020644, main + 4), /only regular files/);
    bad((b) => b.writeUInt16LE(2, main + 6), /hard links/);
    const big = findNid('sizes') * 32; // a directory: break its type in the parent's entry instead
    bad((b) => { const size = b.readUInt32LE(rootOff + 8); const dir = b.subarray(rootOff + 32, rootOff + 32 + size); const n = dir.readUInt16LE(8) / 12; for (let j = 0; j < n; j++) if (Number(dir.readBigUInt64LE(j * 12)) * 32 === big) dir.writeUInt8(1, j * 12 + 10); }, /type does not match/);
    const link = findNid('link.js') * 32;
    bad((b) => { b.write('/etc', link + 32, 'latin1'); }, /absolute target/);
    bad((b) => b.writeUInt32LE(0xfffffff0, findNid('empty') * 32 + 8), /data outside|inline data/);
    bad((b) => b.subarray(0, 4096).fill(0, 1024 + 36, 1024 + 40) && b.writeUInt32LE(1 << 30, 1024 + 36), /counts .* blocks/);
    assert.throws(() => readErofs(good.subarray(0, 4000)), /whole number of 4 KiB blocks/);
  } finally {
    rmrf(d);
  }
});

test('core.image "erofs": pack writes core.erofs, verify and install accept it, the store points the VM at it', () => {
  const d = tmpdir('erofs-pkg-');
  try {
    const proj = path.join(d, 'proj');
    makeProject(proj, { manifest: { core: { command: ['node', 'main.js'], image: 'erofs' } } });
    const out = path.join(d, 'a.vmapp');
    const r = pkg.pack(proj, out);
    assert.equal(r.manifest.core.image, 'erofs');
    const entries = readTar(fs.readFileSync(out));
    assert.deepEqual(entries.map((e) => e.path).slice(-1), ['core.erofs']);
    const core = entries.find((e) => e.path === 'core.erofs');
    assert.ok(core.data.equals(erofsFromDir(path.join(proj, 'core'))));
    assert.equal(r.manifest.files['core.erofs'], sha(core.data));
    const v = pkg.verify(out);
    assert.equal(v.coreName, 'core.erofs');
    assert.ok(Buffer.from(fs.readFileSync(out)).equals(fs.readFileSync(pkg.pack(proj, path.join(d, 'b.vmapp')).outFile)), 'reproducible');

    const home = path.join(d, 'home');
    const store = new Store({ home, skipRuntimeCheck: true });
    store.install(out);
    const app = store.get('com.example.notes');
    assert.equal(path.basename(app.coreFile), 'core.erofs');
    assert.ok(fs.readFileSync(app.coreFile).equals(core.data));

    // a cpio manifest keeps its canonical form: no "image" key, the same package id as before this feature
    const cproj = path.join(d, 'cproj');
    makeProject(cproj);
    const c = pkg.pack(cproj, path.join(d, 'c.vmapp'));
    assert.equal(c.manifest.core.image, undefined);
    assert.ok(!fs.readFileSync(path.join(d, 'c.vmapp')).includes('"image"'));
  } finally {
    rmrf(d);
  }
});

test('core.image decides the entry: the other one, a damaged image, or an unknown image are refused', () => {
  const d = tmpdir('erofs-pkg-');
  try {
    const proj = path.join(d, 'proj');
    makeProject(proj, { manifest: { core: { command: ['node', 'main.js'], image: 'erofs' } } });
    const out = path.join(d, 'a.vmapp');
    pkg.pack(proj, out);
    const entries = readTar(fs.readFileSync(out)).map((e) => ({ path: e.path, type: e.type, data: Buffer.from(e.data) }));
    const m = JSON.parse(entries[0].data.toString());
    const save = (list, mm) => {
      const f = path.join(d, `x-${crypto.randomUUID()}.vmapp`);
      const copy = list.map((e) => ({ ...e }));
      copy[0] = { ...copy[0], data: Buffer.from(JSON.stringify(mm, null, 2) + '\n') };
      fs.writeFileSync(f, writeTar(copy));
      return f;
    };
    // renamed to core.cpio while the manifest says erofs
    const renamed = entries.map((e) => (e.path === 'core.erofs' ? { ...e, path: 'core.cpio' } : e));
    const m2 = JSON.parse(JSON.stringify(m));
    m2.files['core.cpio'] = m2.files['core.erofs'];
    delete m2.files['core.erofs'];
    assert.throws(() => pkg.verify(save(renamed, m2)), /unexpected entry "core.cpio"/);
    // the manifest says cpio but the package has core.erofs
    const m3 = JSON.parse(JSON.stringify(m));
    delete m3.core.image;
    assert.throws(() => pkg.verify(save(entries, m3)), /unexpected entry "core.erofs"/);
    // a damaged image with a matching hash
    const broken = entries.map((e) => (e.path === 'core.erofs' ? { ...e, data: Buffer.alloc(e.data.length) } : e));
    const m4 = JSON.parse(JSON.stringify(m));
    m4.files['core.erofs'] = sha(broken[broken.length - 1].data);
    assert.throws(() => pkg.verify(save(broken, m4)), /core\.erofs is invalid: not an EROFS image/);
    // an unknown image kind
    const m5 = JSON.parse(JSON.stringify(m));
    m5.core.image = 'squashfs';
    assert.throws(() => pkg.verify(save(entries, m5)), /core\.image/);
  } finally {
    rmrf(d);
  }
});

test('a core.cpio over its limit suggests core.image "erofs"', () => {
  const d = tmpdir('erofs-pkg-');
  try {
    const proj = path.join(d, 'proj');
    makeProject(proj);
    const f = path.join(proj, 'core', 'big.bin');
    fs.writeFileSync(f, '');
    fs.truncateSync(f, pkg.MAX_CORE + 1); // sparse: no disk space, but pack reads it
    assert.throws(() => pkg.pack(proj, path.join(d, 'a.vmapp')), /"image": "erofs"/);
  } finally {
    rmrf(d);
  }
});
