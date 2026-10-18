'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeTar, readTar, encodeHeader, octal, TarError, validatePath } = require('../../hostlib/tar');

const file = (p, s = 'x') => ({ path: p, type: 'file', data: Buffer.from(s) });
const dir = (p) => ({ path: p, type: 'dir' });

function raw(h, data = Buffer.alloc(0)) {
  const parts = [encodeHeader(h)];
  if (data.length) {
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return parts;
}
const end = () => Buffer.alloc(1024);
const arch = (...parts) => Buffer.concat([...parts.flat(), end()]);

test('writer is deterministic and the reader round-trips', () => {
  const entries = [file('vmapp.json', '{}'), dir('ui'), file('ui/index.html', 'hello'), file('core.cpio', 'c'.repeat(1000))];
  const a = writeTar(entries);
  const b = writeTar(entries);
  assert.ok(a.equals(b));
  assert.equal(a.length % 512, 0);
  const back = readTar(a);
  assert.deepEqual(
    back.map((e) => [e.path, e.type, e.size]),
    [['vmapp.json', 'file', 2], ['ui', 'dir', 0], ['ui/index.html', 'file', 5], ['core.cpio', 'file', 1000]],
  );
  assert.equal(back[2].data.toString(), 'hello');
});

test('header uses uid/gid/mtime 0 and modes 0644/0755', () => {
  const t = writeTar([file('a.txt'), dir('d')]);
  assert.equal(t.toString('latin1', 100, 108), '0000644\0');
  assert.equal(t.toString('latin1', 108, 116), '0000000\0');
  assert.equal(t.toString('latin1', 136, 148), '00000000000\0');
  assert.equal(t.toString('latin1', 257, 263), 'ustar\0');
  assert.equal(t.toString('latin1', 512 + 512 + 100, 512 + 512 + 108), '0000755\0');
});

test('long paths use the prefix field and round-trip', () => {
  const longDir = 'ui/' + 'd'.repeat(90) + '/' + 'e'.repeat(60);
  const p = longDir + '/' + 'f'.repeat(80) + '.js';
  assert.ok(Buffer.byteLength(p) > 200 && Buffer.byteLength(p) <= 255);
  const t = writeTar([file(p, 'data')]);
  assert.ok(t.subarray(345, 500).some((b) => b !== 0), 'prefix field is used');
  assert.equal(readTar(t)[0].path, p);
});

test('paths over 255 bytes are rejected by the writer', () => {
  const p = 'a/' + 'b'.repeat(254);
  assert.throws(() => writeTar([file(p)]), TarError);
});

test('writer rejects bad paths and duplicates', () => {
  for (const p of ['/abs', 'a/../b', 'a//b', './a', 'a\\b', '', 'a/.']) {
    assert.throws(() => writeTar([file(p)]), TarError, p);
  }
  assert.throws(() => writeTar([file('a'), file('a')]), /duplicate/);
  assert.throws(() => validatePath('x\u0001y'), TarError);
});

test('reader rejects an absolute path', () => {
  assert.throws(() => readTar(arch(raw({ name: '/etc/passwd', size: octal(0, 12) }))), /absolute/);
});

test('reader rejects a .. component', () => {
  assert.throws(() => readTar(arch(raw({ name: 'ui/../x', size: octal(0, 12) }))), /"\.\." component/);
});

test('reader rejects symlinks, hard links and devices', () => {
  assert.throws(() => readTar(arch(raw({ name: 'l', typeflag: '2', linkname: 'target' }))), /links are not allowed/);
  assert.throws(() => readTar(arch(raw({ name: 'l', typeflag: '1', linkname: 'target' }))), /links are not allowed/);
  assert.throws(() => readTar(arch(raw({ name: 'c', typeflag: '3' }))), /devices/);
  assert.throws(() => readTar(arch(raw({ name: 'f', typeflag: '6' }))), /devices/);
});

test('reader rejects pax and GNU headers', () => {
  const pax = Buffer.from('30 path=foo\n');
  assert.throws(() => readTar(arch(raw({ name: 'PaxHeader', typeflag: 'x', size: octal(pax.length, 12) }, pax))), /pax/);
  assert.throws(() => readTar(arch(raw({ name: 'g', typeflag: 'g' }))), /pax/);
  assert.throws(() => readTar(arch(raw({ name: '././@LongLink', typeflag: 'L' }))), /pax|GNU/);
});

test('reader rejects wrong ownership, times and modes', () => {
  assert.throws(() => readTar(arch(raw({ name: 'a', uid: octal(1000, 8) }))), /uid\/gid/);
  assert.throws(() => readTar(arch(raw({ name: 'a', gid: octal(1, 8) }))), /uid\/gid/);
  assert.throws(() => readTar(arch(raw({ name: 'a', mtime: octal(1700000000, 12) }))), /mtime/);
  assert.throws(() => readTar(arch(raw({ name: 'a', mode: octal(0o755, 8) }))), /mode must be 0644/);
  assert.throws(() => readTar(arch(raw({ name: 'd/', type: 'dir', mode: octal(0o700, 8) }))), /mode must be 0755/);
});

test('reader rejects duplicate paths', () => {
  const t = Buffer.concat([...raw({ name: 'a' }), ...raw({ name: 'a' }), end()]);
  assert.throws(() => readTar(t), /duplicate entry "a"/);
});

test('reader rejects bad checksum, magic and truncation', () => {
  const good = writeTar([file('a', 'hello')]);
  const bad = Buffer.from(good);
  bad[0] ^= 1;
  assert.throws(() => readTar(bad), /checksum/);
  const bad2 = Buffer.from(good);
  bad2.write('GNUtar', 257, 'latin1');
  // recompute checksum so only the magic is wrong
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : bad2[i];
  bad2.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  assert.throws(() => readTar(bad2), /ustar/);
  assert.throws(() => readTar(good.subarray(0, 600)), /truncated/);
  assert.throws(() => readTar(good.subarray(0, 1024)), /end-of-archive/);
});

test('reader rejects data after the end-of-archive marker', () => {
  const good = writeTar([file('a')]);
  const t = Buffer.concat([good, Buffer.from('junk')]);
  assert.throws(() => readTar(t), /after end-of-archive|partial/);
});

test('reader enforces directory/file naming and the size limit option', () => {
  assert.throws(() => readTar(arch(raw({ name: 'd', type: 'dir' }))), /must end with "\/"/);
  assert.throws(() => readTar(arch(raw({ name: 'f/', typeflag: '0' }))), /must not end with "\/"/);
  assert.throws(() => readTar(writeTar([file('a')]), { maxBytes: 100 }), /larger than the limit/);
});
