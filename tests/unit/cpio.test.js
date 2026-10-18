'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cpioFromDir, readCpio, CpioError } = require('../../hostlib/cpio');
const { tmpdir, rmrf, write } = require('./helpers');

function tree() {
  const d = tmpdir('cpio-');
  write(path.join(d, 'b.txt'), 'bee');
  write(path.join(d, 'a', 'x.js'), 'console.log(1)');
  write(path.join(d, 'a', 'run.sh'), '#!/bin/sh', 0o755);
  write(path.join(d, 'a-b'), 'dash');
  write(path.join(d, '.DS_Store'), 'junk');
  fs.symlinkSync('x.js', path.join(d, 'a', 'link'));
  return d;
}

test('newc archive is deterministic, sorted, 512-aligned and ends with a trailer', () => {
  const d = tree();
  try {
    const a = cpioFromDir(d);
    const b = cpioFromDir(d);
    assert.ok(a.equals(b));
    assert.equal(a.length % 512, 0);
    assert.equal(a.toString('latin1', 0, 6), '070701');
    const entries = readCpio(a);
    assert.deepEqual(
      entries.map((e) => e.path),
      ['a', 'a-b', 'a/link', 'a/run.sh', 'a/x.js', 'b.txt'],
    );
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    assert.equal(byPath['a'].type, 'dir');
    assert.equal(byPath['a/link'].type, 'symlink');
    assert.equal(byPath['a/link'].data.toString(), 'x.js');
    assert.equal(byPath['a/run.sh'].mode & 0o777, 0o755);
    assert.equal(byPath['a/x.js'].mode & 0o777, 0o644);
    assert.equal(byPath['b.txt'].data.toString(), 'bee');
    assert.ok(a.includes('TRAILER!!!'));
  } finally {
    rmrf(d);
  }
});

test('uid, gid and mtime are zero in every header', () => {
  const d = tree();
  try {
    const a = cpioFromDir(d);
    let off = 0;
    for (;;) {
      const f = (i) => parseInt(a.toString('latin1', off + 6 + i * 8, off + 14 + i * 8), 16);
      assert.equal(f(2), 0, 'uid');
      assert.equal(f(3), 0, 'gid');
      assert.equal(f(5), 0, 'mtime');
      const namesize = f(11);
      const name = a.toString('latin1', off + 110, off + 110 + namesize - 1);
      if (name === 'TRAILER!!!') break;
      const size = f(6);
      let next = off + 110 + namesize;
      next += (4 - (next - off) % 4) % 4;
      next += size;
      next += (4 - (size % 4)) % 4;
      off = next;
    }
  } finally {
    rmrf(d);
  }
});

test('absolute and escaping symlinks are rejected', () => {
  const d = tmpdir('cpio-');
  try {
    fs.symlinkSync('/etc/passwd', path.join(d, 'abs'));
    assert.throws(() => cpioFromDir(d), CpioError);
    fs.unlinkSync(path.join(d, 'abs'));
    fs.mkdirSync(path.join(d, 'sub'));
    fs.symlinkSync('../../outside', path.join(d, 'sub', 'esc'));
    assert.throws(() => cpioFromDir(d), /escapes/);
    fs.unlinkSync(path.join(d, 'sub', 'esc'));
    fs.symlinkSync('../ok', path.join(d, 'sub', 'ok'));
    assert.doesNotThrow(() => cpioFromDir(d));
  } finally {
    rmrf(d);
  }
});

test('empty tree gives just the trailer; reader rejects hostile archives', () => {
  const d = tmpdir('cpio-');
  try {
    assert.deepEqual(readCpio(cpioFromDir(d)), []);
  } finally {
    rmrf(d);
  }
  const hdr = (name, mode, data = '') => {
    const h = (n) => n.toString(16).padStart(8, '0');
    const nm = Buffer.from(name + '\0');
    const parts = [Buffer.from('070701' + [1, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nm.length, 0].map(h).join(''))];
    parts.push(nm, Buffer.alloc((4 - ((110 + nm.length) % 4)) % 4), Buffer.from(data), Buffer.alloc((4 - (data.length % 4)) % 4));
    return Buffer.concat(parts);
  };
  const trailer = hdr('TRAILER!!!', 0);
  assert.throws(() => readCpio(Buffer.concat([hdr('/abs', 0o100644, 'x'), trailer])), /absolute/);
  assert.throws(() => readCpio(Buffer.concat([hdr('a/../b', 0o100644, 'x'), trailer])), /invalid path component/);
  assert.throws(() => readCpio(Buffer.concat([hdr('dev', 0o020644), trailer])), /only regular files/);
  assert.throws(() => readCpio(Buffer.concat([hdr('l', 0o120777, '/etc'), trailer])), /absolute target/);
  assert.throws(() => readCpio(hdr('a', 0o100644, 'x')), /truncated|TRAILER/);
  assert.throws(() => readCpio(Buffer.concat([hdr('a', 0o100644), hdr('a', 0o100644), trailer])), /duplicate/);
});
