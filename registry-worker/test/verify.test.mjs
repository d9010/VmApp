// Tests of src/verify.js (the streaming .vmapp verifier). Run from registry-worker/:  node --test test/verify.test.mjs
// Reads the example packages (read-only) and builds every mutated package in memory: this file writes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPackageStream, VerifyError, LIMITS, MAX_MANIFEST, MAX_TAR_ENTRIES, MAX_CPIO_ENTRIES, __test } from '../src/verify.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOSTLIB = path.resolve(HERE, '../../hostlib');
const pkg = require(path.join(HOSTLIB, 'package.js'));
const tarLib = require(path.join(HOSTLIB, 'tar.js'));
const manifestLib = require(path.join(HOSTLIB, 'manifest.js'));
const cpioLib = require(path.join(HOSTLIB, 'cpio.js'));
const erofsLib = require(path.join(HOSTLIB, 'erofs.js'));
const { ManifestError } = manifestLib;

// The example packages: VMAPP_TEST_PACKAGES, else what tools/pack-examples makes (vmapp/out/examples). Without them there is
// nothing to compare against, so this file says so and runs nothing (it does not pretend to pass anything).
const EXAMPLES = process.env.VMAPP_TEST_PACKAGES || path.resolve(HERE, '../../out/examples');
if (!fs.existsSync(path.join(EXAMPLES, '14-vscode.vmapp'))) {
  console.log(`verify tests skipped: no example packages in ${EXAMPLES} (run tools/pack-examples, or set VMAPP_TEST_PACKAGES)`);
  process.exit(0);
}
const exampleFiles = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.vmapp')).sort();
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// helpers

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fileStream(file) {
  return Readable.toWeb(fs.createReadStream(file));
}

/** A web stream of `buf` cut into chunks whose sizes come from nextSize() (a number or a function). 0 = an empty chunk. */
function chunked(buf, nextSize) {
  const next = typeof nextSize === 'function' ? nextSize : () => nextSize;
  let off = 0;
  return new ReadableStream({
    pull(ctl) {
      if (off >= buf.length) {
        ctl.close();
        return;
      }
      const n = Math.min(next(), buf.length - off);
      ctl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset + off, n)); // a view: the verifier must not keep chunks
      off += n;
    },
  });
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isKnownError = (e) => e instanceof VerifyError || e instanceof ManifestError;

async function streamVerdict(buf, opts, chunk = 65536) {
  try {
    return { ok: true, r: await verifyPackageStream(chunked(buf, chunk), opts) };
  } catch (e) {
    return { ok: false, e };
  }
}

function loadVerdict(buf) {
  try {
    return { ok: true, r: pkg.load(buf) };
  } catch (e) {
    return { ok: false, e };
  }
}

function assertSameResult(got, want, label) {
  assert.deepStrictEqual(got.manifest, want.manifest, `${label}: manifest`);
  assert.ok(Buffer.from(got.manifestBytes).equals(want.manifestBytes), `${label}: manifestBytes`);
  assert.equal(got.packageId, want.packageId, `${label}: packageId`);
  assert.equal(got.uiBytes, want.uiBytes, `${label}: uiBytes`);
  assert.equal(got.coreName, want.coreName, `${label}: coreName`);
  assert.equal(got.coreBytes, want.coreBytes, `${label}: coreBytes`);
  assert.equal(got.hasIcon, want.hasIcon, `${label}: hasIcon`);
  assert.equal(got.size, want.size, `${label}: size`);
}

// ---- in-memory package construction ----
const baseFile = path.join(EXAMPLES, '02-notes.vmapp');
const baseBuf = fs.readFileSync(baseFile);
const baseLoaded = pkg.load(baseBuf);
const baseItems = () => baseLoaded.entries.slice(1).map((e) => ({ path: e.path, type: e.type, data: Buffer.from(e.data) }));

/** Builds a package. Hashes in the manifest are recomputed from `items` unless keepFiles. Returns a Buffer. */
function makePkg({ items = baseItems(), manifest, keepFiles = false } = {}) {
  const m = JSON.parse(JSON.stringify(baseLoaded.manifest));
  if (manifest) manifest(m);
  if (!keepFiles) {
    const files = {};
    for (const it of items) if (it.type === 'file') files[it.path] = sha(it.data);
    m.files = files;
  }
  const mb = Buffer.from(manifestLib.canonicalize(m));
  return tarLib.writeTar([{ path: 'vmapp.json', type: 'file', data: mb }, ...items]);
}

const withEntry = (items, p, data) => items.map((it) => (it.path === p ? { ...it, data } : it));

/** Header and data offsets of every entry of a package buffer. */
function layout(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length && !buf.subarray(off, off + 512).every((x) => x === 0)) {
    const name = buf.toString('latin1', off, off + 100).replace(/\0.*$/s, '');
    const size = parseInt(buf.toString('latin1', off + 124, off + 136).replace(/[\0 ]+$/, '') || '0', 8);
    out.push({ name, hdr: off, data: off + 512, size });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  out.end = off;
  return out;
}

function fixChecksum(buf, hdr) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[hdr + i];
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ').copy(buf, hdr + 148);
}

const flip = (buf, off, mask = 0x01) => {
  const c = Buffer.from(buf);
  c[off] ^= mask;
  return c;
};

// ---- newc cpio builder (for core images with hash-correct but invalid content) ----
const hex8 = (n) => n.toString(16).padStart(8, '0');
const pad4 = (n) => Buffer.alloc((4 - (n % 4)) % 4);
function cpioRec(name, mode, data = Buffer.alloc(0), ino = 1) {
  const nb = Buffer.concat([Buffer.from(name), Buffer.from([0])]);
  const hdr = Buffer.from('070701' + [ino, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nb.length, 0].map(hex8).join(''), 'latin1');
  return Buffer.concat([hdr, nb, pad4(110 + nb.length), data, pad4(data.length)]);
}
const REG = 0o100644;
const DIR = 0o040755;
const LNK = 0o120777;
function cpio(recs, { trailer = true } = {}) {
  const body = Buffer.concat([...recs, ...(trailer ? [cpioRec('TRAILER!!!', 0)] : [])]);
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------------------------------------------------
// 5. LIMITS

test('LIMITS equal the exports of hostlib/package.js', () => {
  assert.deepStrictEqual(
    { ...LIMITS },
    { MAX_PACKAGE: pkg.MAX_PACKAGE, MAX_CORE: pkg.MAX_CORE, MAX_CORE_EROFS: pkg.MAX_CORE_EROFS, MAX_UI: pkg.MAX_UI },
  );
  assert.ok(MAX_MANIFEST >= 340000 * 2, 'MAX_MANIFEST leaves room above the largest real manifest');
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. memory (first, in a fresh child process so the oracle's whole-file reads cannot distort the baseline)

test('memory: verifying the 402 MB package stays within ~150 MB of RSS growth', async (t) => {
  const file = path.join(EXAMPLES, '14-vscode.vmapp');
  const code = `
    import { verifyPackageStream } from ${JSON.stringify(pathToFileURL(path.join(HERE, '../src/verify.js')).href)};
    import fs from 'node:fs';
    import { Readable } from 'node:stream';
    const rss = () => process.memoryUsage.rss();
    await verifyPackageStream(Readable.toWeb(fs.createReadStream(${JSON.stringify(baseFile)}))); // warm up the code paths
    const MODE = process.env.MODE; // 'count' (a reader that does nothing), 'verify' (raw), 'verify-reuse' (see the test)
    const base = rss();
    let peak = base;
    const sample = () => { const r = rss(); if (r > peak) peak = r; };
    const timer = setInterval(sample, 5);
    const sampler = new TransformStream({ transform(c, ctl) { sample(); ctl.enqueue(c); } });
    const t0 = performance.now();
    let src;
    if (MODE === 'verify-reuse') {
      // a pull-based source that reads the file into ONE reused 64 KiB buffer: no per-chunk garbage from the source, so
      // the RSS growth is what the verifier itself holds (the verifier never keeps a chunk after push() returns)
      const fh = await fs.promises.open(${JSON.stringify(file)}, 'r');
      const buf = new Uint8Array(65536);
      src = new ReadableStream({
        async pull(ctl) {
          sample();
          const { bytesRead } = await fh.read(buf, 0, buf.length, null);
          if (!bytesRead) { ctl.close(); await fh.close(); return; }
          ctl.enqueue(buf.subarray(0, bytesRead));
        },
      }, { highWaterMark: 0 });
    } else {
      src = Readable.toWeb(fs.createReadStream(${JSON.stringify(file)})).pipeThrough(sampler);
    }
    let size, sha256;
    if (MODE === 'count') {
      size = 0;
      const rd = src.getReader();
      for (;;) { const x = await rd.read(); if (x.done) break; size += x.value.length; }
    } else {
      ({ size, sha256 } = await verifyPackageStream(src));
    }
    const ms = performance.now() - t0;
    clearInterval(timer);
    sample();
    console.log(JSON.stringify({ base, peak, ms, size, sha256 }));
  `;
  const run = (mode) =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, ['--expose-gc', '--input-type=module', '-e', code], { maxBuffer: 1 << 20, env: { ...process.env, MODE: mode } }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || String(err))) : resolve(JSON.parse(stdout.trim().split('\n').pop())),
      );
    });
  const mib = (n) => (n / MIB).toFixed(1);
  const results = {};
  for (const mode of ['count', 'verify', 'verify-reuse']) {
    const r = (results[mode] = await run(mode));
    r.growth = r.peak - r.base;
    const msg = `${mode.padEnd(9)}: ${r.size} bytes, baseline RSS ${mib(r.base)} MiB, peak RSS ${mib(r.peak)} MiB, growth ${mib(r.growth)} MiB, ${(r.ms / 1000).toFixed(2)} s`;
    console.log(`MEMORY ${msg}`);
    t.diagnostic(msg);
    assert.equal(r.size, fs.statSync(file).size);
  }
  // 'count' is a consumer that does nothing: Node's own fs stream allocates a 64 KiB Buffer per chunk and the allocator keeps
  // the freed memory, so RSS grows by ~130-170 MiB with NO verifier at all (measured; it climbs steadily although V8 reports
  // ~6 MiB of heap and ~4 MiB of array buffers afterwards). That makes the raw 'verify' number mostly a measurement of Node's
  // stream. So: (1) the verifier must add little on top of the do-nothing reader, and (2) with a source that reuses one
  // buffer (no per-chunk garbage), the growth is what the verifier itself holds, and that is asserted against the 150 MiB limit.
  assert.equal(results.verify.sha256, results['verify-reuse'].sha256);
  assert.ok(results['verify-reuse'].growth <= 150 * MIB, `RSS grew by ${mib(results['verify-reuse'].growth)} MiB with a reused source buffer (> 150 MiB)`);
  // The allowance over the do-nothing reader is 256 MiB (it was 100 MiB; that failed on a second machine at 136 MiB, because the
  // allocator noise itself moves by 50 MiB or more between runs). It still catches the failure that matters: a verifier that
  // buffered the 332 MB core image would grow by more than 400 MiB.
  assert.ok(results.verify.growth <= results.count.growth + 256 * MIB, `the verifier adds ${mib(results.verify.growth - results.count.growth)} MiB over a do-nothing reader`);
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. oracle

test('oracle: every example package gives the same result as hostlib/package.js read()', async (t) => {
  assert.equal(exampleFiles.length, 14);
  for (const f of exampleFiles) {
    const file = path.join(EXAMPLES, f);
    await t.test(f, async () => {
      const t0 = performance.now();
      const got = await verifyPackageStream(fileStream(file));
      const ms = performance.now() - t0;
      const want = pkg.read(file);
      assertSameResult(got, want, f);
      const realSha = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      assert.equal(got.sha256, realSha, `${f}: sha256 of the whole file`);
      console.log(`ORACLE ok  ${f.padEnd(26)} ${String(got.size).padStart(10)} bytes  ${got.coreName}  ${Math.round(ms)} ms  sha256 ${got.sha256.slice(0, 12)}`);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// synthetic packages (cpio with icon, erofs) used by several tests

const erofsImage = erofsLib.erofsFromDir(path.join(HOSTLIB, '..', 'templates', 'starter'));
const syntheticPackages = {
  'cpio+icon': makePkg({ items: [...baseItems(), { path: 'icon.png', type: 'file', data: Buffer.concat([PNG, Buffer.from('rest of icon')]) }] }),
  erofs: makePkg({ manifest: (m) => (m.core.image = 'erofs'), items: baseItems().map((it) => (it.path === 'core.cpio' ? { ...it, path: 'core.erofs', data: erofsImage } : it)) }),
};

test('synthetic packages (icon, erofs) are accepted and equal load()', async () => {
  for (const [name, buf] of Object.entries(syntheticPackages)) {
    const got = await verifyPackageStream(chunked(buf, 4096));
    const want = pkg.load(buf);
    assertSameResult(got, want, name);
    assert.equal(got.sha256, sha(buf));
  }
  assert.equal(pkg.load(syntheticPackages['cpio+icon']).hasIcon, true);
  assert.equal(pkg.load(syntheticPackages.erofs).coreName, 'core.erofs');
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. chunk boundaries

test('chunk boundaries: results do not depend on how the stream is cut', async (t) => {
  const mixRng = mulberry32(12345);
  const mix = () => {
    const r = mixRng();
    return r < 0.05 ? 0 : 1 + Math.floor(Math.pow(mixRng(), 3) * 3000);
  };
  const sizes = [1, 7, 511, 512, 513, 4096, 65536, 'mix'];
  const subjects = [
    ['02-notes.vmapp (small)', fs.readFileSync(path.join(EXAMPLES, '02-notes.vmapp')), sizes],
    ['cpio+icon (synthetic)', syntheticPackages['cpio+icon'], sizes],
    ['erofs (synthetic)', syntheticPackages.erofs, sizes],
    ['03-hasher-rust.vmapp (576 KB)', fs.readFileSync(path.join(EXAMPLES, '03-hasher-rust.vmapp')), sizes],
    ['13-convert-bookmarks.vmapp (2.4 MB)', fs.readFileSync(path.join(EXAMPLES, '13-convert-bookmarks.vmapp')), sizes.filter((s) => s !== 1 && s !== 7)],
  ];
  for (const [name, buf, sz] of subjects) {
    await t.test(name, async () => {
      const want = pkg.load(buf);
      for (const s of sz) {
        const got = await verifyPackageStream(chunked(buf, s === 'mix' ? mix : s));
        assertSameResult(got, want, `${name} chunk=${s}`);
        assert.equal(got.sha256, sha(buf), `${name} chunk=${s}: sha256`);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. negative and differential tests

const rows = []; // [case, streaming message, load message]
const disagreements = [];

async function expectReject(name, buf, re, { opts, chunk = 4096, checkLoad = true, record = true } = {}) {
  const s = await streamVerdict(buf, opts, chunk);
  assert.ok(!s.ok, `${name}: the streaming verifier accepted it`);
  assert.ok(isKnownError(s.e), `${name}: unexpected error type ${s.e && s.e.name}: ${s.e && s.e.stack}`);
  assert.match(s.e.message, re, `${name}: message does not name the problem`);
  let loadMsg = '(not compared)';
  if (checkLoad) {
    const l = loadVerdict(buf);
    if (l.ok) {
      loadMsg = 'ACCEPTED';
      disagreements.push(`${name}: streaming rejects ("${s.e.message}") but load() accepts`);
    } else loadMsg = `${l.e.name}: ${l.e.message}`;
  }
  if (record) rows.push([name, `${s.e.name}: ${s.e.message}`, loadMsg]);
}

const baseLayout = layout(baseBuf);
const entryAt = (name) => baseLayout.find((e) => e.name === name);

test('negative: structure, tar and content errors (differential against load())', async (t) => {
  await t.test('flip a byte inside a UI file -> hash mismatch', async () => {
    const e = entryAt('ui/app.js');
    await expectReject('flip byte in ui/app.js', flip(baseBuf, e.data + 10), /hash mismatch for "ui\/app\.js"/);
  });
  await t.test('flip a byte in the core image -> hash mismatch', async () => {
    const e = entryAt('core.cpio');
    await expectReject('flip byte in core.cpio', flip(baseBuf, e.data + 200), /hash mismatch for "core\.cpio"/);
  });
  await t.test('flip a byte in a tar header -> checksum', async () => {
    for (const name of ['vmapp.json', 'ui/app.js', 'core.cpio']) {
      const e = entryAt(name);
      await expectReject(`flip tar header byte of ${name} (name)`, flip(baseBuf, e.hdr + 1), /bad header checksum/);
      await expectReject(`flip tar header byte of ${name} (size)`, flip(baseBuf, e.hdr + 126), /bad header checksum/);
    }
  });
  await t.test('tar header fields with a valid checksum but a wrong value', async () => {
    const e = entryAt('ui/app.js');
    const mod = (off, bytes) => {
      const c = Buffer.from(baseBuf);
      Buffer.from(bytes, 'latin1').copy(c, e.hdr + off);
      fixChecksum(c, e.hdr);
      return c;
    };
    await expectReject('uid 1', mod(108, '0000001\0'), /uid\/gid must be 0/);
    await expectReject('mtime 1', mod(136, '00000000001\0'), /mtime must be 0/);
    await expectReject('mode 0600', mod(100, '0000600\0'), /mode must be 0644/);
    await expectReject('typeflag symlink', mod(156, '2'), /links are not allowed/);
    await expectReject('typeflag pax', mod(156, 'x'), /pax\/GNU/);
    await expectReject('bad magic', mod(257, 'xstar\0'), /not a POSIX ustar header/);
    await expectReject('bad version', mod(263, '01'), /not a POSIX ustar header/);
    await expectReject('linkname set', mod(157, 'foo\0'), /link name must be empty/);
    await expectReject('size not octal', mod(124, '0000000089a\0'), /invalid size field/);
    await expectReject('base-256 size', mod(124, '\x80\0\0\0\0\0\0\0\0\0\0\x10'), /base-256 size/);
    await expectReject('path with ..', mod(0, 'ui/../x.js\0'), /"\.\." component is not allowed|must sort|not listed/);
    await expectReject('absolute path', mod(0, '/ui/app.js\0'), /absolute paths are not allowed/);
    await expectReject('backslash in path', mod(0, 'ui\\app.js\0'), /control characters and backslashes/);
  });
  await t.test('truncation at many points', async () => {
    const L = baseLayout;
    const end = L.end;
    const points = {
      0: /missing end-of-archive marker/,
      100: /partial header block/,
      511: /partial header block/,
      512: /truncated data/, // the manifest header only
      513: /truncated data/,
      [L[0].data + 100]: /truncated data/,
      [L[2].data + 5]: /truncated data/, // inside ui/app.js
      [L[2].data + L[2].size + 3]: /truncated padding/,
      [L[5].data + 7]: /truncated data/, // inside core.cpio
      [end - 1]: /partial header block|truncated/,
      [end]: /missing end-of-archive marker/, // all entries, no end marker
      [end + 100]: /partial header block/,
      [end + 511]: /partial header block/,
      [end + 512]: /needs two zero blocks/,
      [end + 1023]: /needs two zero blocks/,
      [baseBuf.length - 1]: /needs two zero blocks/,
    };
    assert.equal(baseBuf.length, end + 1024);
    for (const [at, re] of Object.entries(points)) {
      await expectReject(`truncate at ${at}`, baseBuf.subarray(0, Number(at)), re);
    }
    // every 64th prefix: always rejected, by both
    for (let at = 0; at < baseBuf.length; at += 64) {
      const s = await streamVerdict(baseBuf.subarray(0, at));
      assert.ok(!s.ok && isKnownError(s.e), `prefix ${at} must be rejected`);
      assert.ok(!loadVerdict(baseBuf.subarray(0, at)).ok, `load() rejects prefix ${at}`);
    }
  });
  await t.test('trailing bytes', async () => {
    await expectReject('append 1 garbage byte', Buffer.concat([baseBuf, Buffer.from('A')]), /data after end-of-archive marker/);
    await expectReject('append garbage block', Buffer.concat([baseBuf, Buffer.alloc(512, 0x41)]), /data after end-of-archive marker/);
    await expectReject('garbage after 1 zero block + zeros', Buffer.concat([baseBuf, Buffer.alloc(3000), Buffer.from('x')]), /data after end-of-archive marker/);
    await expectReject('a second archive appended', Buffer.concat([baseBuf, baseBuf]), /data after end-of-archive marker/);
    // zeros after the end-of-archive marker are legal for readTar (and so for the verifier): both accept, same result
    for (const extra of [1, 512, 100000]) {
      const buf = Buffer.concat([baseBuf, Buffer.alloc(extra)]);
      const got = await verifyPackageStream(chunked(buf, 4096));
      assertSameResult(got, pkg.load(buf), `+${extra} zero bytes`);
    }
  });
  await t.test('wrong first entry', async () => {
    const items = baseItems();
    const m = baseLoaded.manifestBytes;
    const b1 = tarLib.writeTar([...items, { path: 'vmapp.json', type: 'file', data: m }]);
    await expectReject('vmapp.json not first', b1, /the first entry must be vmapp\.json \(found "ui"\)/);
    const b2 = tarLib.writeTar([{ path: 'ui', type: 'dir' }, ...items.slice(1)]);
    await expectReject('first entry is a UI dir (duplicate dir)', b2, /duplicate entry "ui"|the first entry must be vmapp\.json/);
    const dirHdr = tarLib.encodeHeader({ name: 'vmapp.json/', type: 'dir' });
    await expectReject('first entry is directory vmapp.json/', Buffer.concat([dirHdr, tarLib.writeTar(items)]), /the first entry must be vmapp\.json \(found "vmapp\.json"\)/);
    await expectReject('empty archive', Buffer.alloc(1024), /the first entry must be vmapp\.json/);
    await expectReject('empty stream', Buffer.alloc(0), /missing end-of-archive marker/);
  });
  await t.test('reordered / misplaced entries', async () => {
    const it = baseItems();
    const swap = (a, b) => {
      const c = it.slice();
      const i = c.findIndex((x) => x.path === a);
      const j = c.findIndex((x) => x.path === b);
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    };
    await expectReject('swap ui/app.js and ui/index.html', makePkg({ items: swap('ui/app.js', 'ui/index.html') }), /entry order: "ui\/app\.js" must sort after "ui\/index\.html"/);
    await expectReject('swap ui dir and ui/app.js', makePkg({ items: swap('ui', 'ui/app.js') }), /entry order: expected directory entry "ui\/" first/);
    await expectReject('core.cpio before the UI', makePkg({ items: [it[it.length - 1], ...it.slice(0, -1)] }), /entry order: UI directory "ui\/" must precede core\.cpio/);
    await expectReject('UI entry after core.cpio', makePkg({ items: [...it.slice(0, -1).filter((x) => x.path !== 'ui/style.css'), it[it.length - 1], it.find((x) => x.path === 'ui/style.css')] }), /UI entries must come first/);
    await expectReject('icon.png before core.cpio', makePkg({ items: [...it.slice(0, -1), { path: 'icon.png', type: 'file', data: PNG }, it[it.length - 1]] }), /icon\.png must come last|unexpected|entry order/);
    await expectReject('no UI directory entry for a subfolder', makePkg({ items: [...it.slice(0, 2), { path: 'ui/sub/x.txt', type: 'file', data: Buffer.from('x') }, ...it.slice(2)] }), /parent directory "ui\/sub\/" has no directory entry|must sort after/);
    await expectReject('no UI directory at all', makePkg({ items: it.filter((x) => !x.path.startsWith('ui')) }), /entry order: UI directory "ui\/" must precede core\.cpio|no UI directory/);
    await expectReject('no core', makePkg({ items: it.filter((x) => x.path !== 'core.cpio') }), /package has no core\.cpio entry/);
    await expectReject('core.erofs where cpio is expected', makePkg({ items: it.map((x) => (x.path === 'core.cpio' ? { ...x, path: 'core.erofs' } : x)) }), /unexpected entry "core\.erofs"/);
  });
  await t.test('entries missing from / extra to the files map', async () => {
    const it = baseItems();
    const L = (p) => it.filter((x) => x.path !== p);
    await expectReject('remove ui/style.css (still listed)', makePkg({ items: L('ui/style.css'), keepFiles: true }), /lists "ui\/style\.css" in files but the package has no such entry/);
    await expectReject('remove core.cpio (still listed)', makePkg({ items: L('core.cpio'), keepFiles: true }), /package has no core\.cpio entry|lists "core\.cpio"/);
    const extra = { path: 'ui/zzz.txt', type: 'file', data: Buffer.from('hello') };
    await expectReject('add ui/zzz.txt (not listed)', makePkg({ items: [...it.slice(0, -1), extra, it[it.length - 1]], keepFiles: true }), /package entry "ui\/zzz\.txt" is not listed in vmapp\.json files/);
    await expectReject('add extra.bin at the end', makePkg({ items: [...it, { path: 'extra.bin', type: 'file', data: Buffer.from('x') }] }), /unexpected entry "extra\.bin"/);
    await expectReject('duplicate entry ui/app.js', Buffer.concat([layoutSlice(baseBuf, 0, 3), layoutSlice(baseBuf, 2, 3), baseBuf.subarray(baseLayout[3].hdr)]), /duplicate entry "ui\/app\.js"/);
  });
  await t.test('size fields too large', async () => {
    const e = entryAt('ui/app.js');
    const setSize = (name, oct) => {
      const c = Buffer.from(baseBuf);
      const en = entryAt(name);
      Buffer.from(oct.padStart(11, '0') + '\0', 'latin1').copy(c, en.hdr + 124);
      fixChecksum(c, en.hdr);
      return c;
    };
    await expectReject('ui/app.js size = 16 MB (more than the package)', setSize('ui/app.js', (16 * MIB).toString(8)), /truncated data/);
    await expectReject('ui/app.js size beyond the package by 1 byte', setSize('ui/app.js', (baseBuf.length - e.data + 1).toString(8)), /truncated data/);
    await expectReject('ui/app.js size 4 GiB (UI limit)', setSize('ui/app.js', (4 * 1024 * MIB).toString(8)), /ui\/ is at least \d+ bytes, larger than the limit/);
    await expectReject('core.cpio size 4 GiB (core limit)', setSize('core.cpio', (4 * 1024 * MIB).toString(8)), /core\.cpio is \d+ bytes, larger than the limit of \d+/);
    await expectReject('manifest size 4 GiB (manifest limit, nothing buffered)', setSize('vmapp.json', (4 * 1024 * MIB).toString(8)), /vmapp\.json is \d+ bytes, larger than the limit/);
    await expectReject('manifest size 5 MiB (manifest limit)', setSize('vmapp.json', (5 * MIB).toString(8)), /vmapp\.json is \d+ bytes, larger than the limit/);
    await expectReject('ui/app.js size 1000 bytes too small', setSize('ui/app.js', (e.size - 1000).toString(8)), /./);
    await expectReject('ui/app.js size 1 byte too small', setSize('ui/app.js', (e.size - 1).toString(8)), /./);
    await expectReject('dir with a size', (() => {
      const c = Buffer.from(baseBuf);
      const en = entryAt('ui/');
      Buffer.from('00000000001\0', 'latin1').copy(c, en.hdr + 124);
      fixChecksum(c, en.hdr);
      return c;
    })(), /directory with non-zero size/);
    await expectReject('non-zero padding', (() => {
      const c = Buffer.from(baseBuf);
      const en = entryAt('ui/app.js');
      c[en.data + en.size + 1] = 1;
      return c;
    })(), /non-zero padding/);
  });
  await t.test('corrupt manifest', async () => {
    const e = entryAt('vmapp.json');
    await expectReject('manifest first byte changed', flip(baseBuf, e.data, 0x01), /invalid vmapp\.json: \(file\) is not valid JSON/);
    const bad = Buffer.from(baseBuf);
    bad.write('{"format":1,', e.data); // valid JSON prefix, then the old text: still invalid
    await expectReject('manifest JSON garbled', bad, /invalid vmapp\.json/);
    const nonUtf8 = Buffer.from(baseBuf);
    nonUtf8[e.data + 40] = 0xff;
    await expectReject('manifest not UTF-8', nonUtf8, /not valid UTF-8|not valid JSON/);
    const s = await streamVerdict(flip(baseBuf, e.data, 0x01));
    assert.ok(s.e instanceof ManifestError);
    // a manifest that parses but fails validation, and one without "files"
    await expectReject('manifest without files', tarLib.writeTar([{ path: 'vmapp.json', type: 'file', data: Buffer.from(JSON.stringify(manifestLib.validateManifest({ ...JSON.parse(JSON.stringify(baseLoaded.manifest)), files: undefined }, { files: 'forbidden' }))) }, ...baseItems()]), /files is required/);
    await expectReject('empty manifest', tarLib.writeTar([{ path: 'vmapp.json', type: 'file', data: Buffer.alloc(0) }, ...baseItems()]), /invalid vmapp\.json/);
    await expectReject('manifest lists a wrong hash for ui/style.css', makeWithWrongHash(), /hash mismatch for "ui\/style\.css"/);
  });
  await t.test('icon.png', async () => {
    const withIcon = (data) => makePkg({ items: [...baseItems(), { path: 'icon.png', type: 'file', data }] });
    await expectReject('icon is text', withIcon(Buffer.from('this is not a png at all')), /icon\.png is not a PNG file/);
    await expectReject('icon is 7 bytes of PNG magic', withIcon(PNG.subarray(0, 7)), /icon\.png is not a PNG file/);
    await expectReject('icon is empty', withIcon(Buffer.alloc(0)), /icon\.png is not a PNG file/);
    await expectReject('icon magic wrong in last byte', withIcon(Buffer.concat([PNG.subarray(0, 7), Buffer.from([0x0b]), Buffer.alloc(40)])), /icon\.png is not a PNG file/);
    await expectReject('icon.png is a directory', makePkg({ items: [...baseItems(), { path: 'icon.png', type: 'dir' }] }), /icon\.png must be a regular file/);
    for (const data of [PNG, Buffer.concat([PNG, Buffer.alloc(5000, 7)])]) {
      const buf = withIcon(data);
      const got = await verifyPackageStream(chunked(buf, 513));
      assertSameResult(got, pkg.load(buf), 'valid icon');
      assert.equal(got.hasIcon, true);
    }
  });
  await t.test('maxBytes', async () => {
    await expectReject('maxBytes one below the size', baseBuf, /larger than the limit of \d+ bytes/, { opts: { maxBytes: baseBuf.length - 1 }, checkLoad: false });
    const ok = await verifyPackageStream(chunked(baseBuf, 4096), { maxBytes: baseBuf.length });
    assert.equal(ok.size, baseBuf.length);
    // an endless stream: the verifier must stop reading and cancel the source
    let pulled = 0;
    let cancelled = false;
    const head = baseBuf.subarray(0, baseBuf.length - 1024);
    let off = 0;
    const endless = new ReadableStream({
      pull(ctl) {
        pulled++;
        if (off < head.length) {
          const n = Math.min(4096, head.length - off);
          ctl.enqueue(head.subarray(off, off + n));
          off += n;
        } else ctl.enqueue(new Uint8Array(65536)); // zeros for ever
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(verifyPackageStream(endless, { maxBytes: head.length + MIB }), (e) => e instanceof VerifyError && /larger than the limit/.test(e.message));
    assert.ok(cancelled, 'the source stream was cancelled');
    assert.ok(pulled < head.length / 4096 + 40, `stopped reading soon (${pulled} pulls)`);
    // an endless stream of zeros with the default limit is cut at MAX_PACKAGE: not exercised (2 GiB); the limit is the same code path
  });
  await t.test('a stream that errors midway', async () => {
    for (const failAt of [0, 1, 5, 20]) {
      let n = 0;
      let off = 0;
      const s = new ReadableStream({
        pull(ctl) {
          if (n++ === failAt) {
            ctl.error(new Error('connection reset by peer'));
            return;
          }
          const k = Math.min(1000, baseBuf.length - off);
          ctl.enqueue(baseBuf.subarray(off, off + k));
          off += k;
        },
      });
      await assert.rejects(verifyPackageStream(s), (e) => e instanceof VerifyError && /reading the package failed: connection reset by peer/.test(e.message), `error after ${failAt} chunks`);
    }
    // a stream that ends early without an error is the truncation case (above); a non-Uint8Array chunk is refused
    await assert.rejects(verifyPackageStream(new ReadableStream({ start(c) { c.enqueue('text'); c.close(); } })), VerifyError);
  });
  await t.test('summary of the differential comparison', () => {
    const w = Math.max(...rows.map((r) => r[0].length));
    console.log(`NEGATIVE: ${rows.length} mutated packages, all rejected by the streaming verifier`);
    for (const [name, s, l] of rows) console.log(`  ${name.padEnd(w)} | stream: ${s}\n  ${' '.repeat(w)} | load():  ${l}`);
    assert.deepEqual(disagreements, [], `streaming and load() disagree:\n${disagreements.join('\n')}`);
  });
});

// helpers used above that need the layouts
function layoutSlice(buf, from, to) {
  const L = layout(buf);
  return buf.subarray(L[from].hdr, L[to].hdr);
}
function makeWithWrongHash() {
  const items = baseItems();
  const m = JSON.parse(JSON.stringify(baseLoaded.manifest));
  m.files['ui/style.css'] = '0'.repeat(64);
  const mb = Buffer.from(manifestLib.canonicalize(m));
  return tarLib.writeTar([{ path: 'vmapp.json', type: 'file', data: mb }, ...items]);
}

// ---------------------------------------------------------------------------------------------------------------------
// core image contents: cpio (streaming port of readCpio) and erofs

test('cpio core: hash-correct images that readCpio rejects are rejected (differential)', async () => {
  const f = (name, data = Buffer.from('x'), ino = 1) => cpioRec(name, REG, data, ino);
  const good = cpio([cpioRec('.', DIR), cpioRec('d', DIR, undefined, 2), f('d/a.txt', Buffer.from('hello'), 3), cpioRec('d/l', LNK, Buffer.from('a.txt'), 4), cpioRec('l2', LNK, Buffer.from('d/a.txt'), 5)]);
  const pk = (core) => makePkg({ items: withEntry(baseItems(), 'core.cpio', core) });
  const ok = pk(good);
  assertSameResult(await verifyPackageStream(chunked(ok, 97)), pkg.load(ok), 'good cpio');
  const cases = {
    'bad magic': [Buffer.concat([Buffer.from('070702'), good.subarray(6)]), /bad cpio magic at offset 0/],
    'bad hex field': [(() => { const c = Buffer.from(good); c.write('0000000g', 6 + 8 * 3); return c; })(), /bad cpio header field/],
    'name size 0': [(() => { const c = Buffer.from(good); c.write('00000000', 6 + 8 * 11); return c; })(), /bad cpio name size/],
    'no trailer (zero padding follows)': [cpio([f('a')], { trailer: false }), /bad cpio magic at offset \d+/],
    'no trailer (nothing follows)': [Buffer.concat([f('a')]), /truncated cpio: missing TRAILER/],
    'empty core (all padding)': [Buffer.alloc(512), /bad cpio magic/],
    'absolute path': [cpio([f('/etc/passwd')]), /absolute paths are not allowed/],
    'dotdot path': [cpio([f('../x')]), /invalid path component "\.\."/],
    'empty component': [cpio([f('a//b')]), /invalid path component ""/],
    'dot component': [cpio([f('a/./b')]), /invalid path component "\."/],
    duplicate: [cpio([f('a'), f('a', Buffer.from('y'), 2)]), /duplicate/],
    fifo: [cpio([cpioRec('p', 0o010644)]), /only regular files, directories and symlinks/],
    'char device': [cpio([cpioRec('c', 0o020644)]), /only regular files/],
    'symlink escapes': [cpio([cpioRec('l', LNK, Buffer.from('../x'))]), /escapes the app directory/],
    'symlink escapes deeper': [cpio([cpioRec('a/b', LNK, Buffer.from('../../x'))]), /escapes the app directory/],
    'symlink absolute': [cpio([cpioRec('l', LNK, Buffer.from('/etc/passwd'))]), /absolute target/],
    'symlink empty': [cpio([cpioRec('l', LNK, Buffer.alloc(0))]), /empty target/],
    'data truncated': [(() => { const c = cpio([f('a', Buffer.alloc(100, 1))]); return c.subarray(0, 110 + 2 + 100); })(), /truncated cpio/],
    'filesize beyond the image': [(() => { const c = Buffer.from(good); c.write('7fffffff', 6 + 8 * 6); return c; })(), /truncated cpio data/],
    'namesize beyond the image': [(() => { const c = Buffer.from(good); c.write('7fffffff', 6 + 8 * 11); return c; })(), /truncated cpio name/],
    'name not NUL terminated': [(() => { const c = cpio([f('abc')]); c[110 + 3] = 0x44; return c; })(), /not NUL terminated/],
    'core shorter than a header': [Buffer.from('070701'), /truncated cpio: missing TRAILER/],
  };
  const sizes = [1, 3, 109, 110, 111, 4096];
  for (const [name, [core, re]] of Object.entries(cases)) {
    const buf = pk(core);
    for (const chunk of sizes) await expectReject(`cpio: ${name}`, buf, new RegExp(`core\\.cpio is invalid: .*${re.source}`), { chunk, record: chunk === 4096 });
  }
  // readCpio ignores everything after TRAILER!!!, and so does the verifier
  const trailing = pk(Buffer.concat([good, Buffer.alloc(1000, 0x41)]));
  assertSameResult(await verifyPackageStream(chunked(trailing, 50)), pkg.load(trailing), 'garbage after TRAILER');
  // names and symlink targets
  const rng = mulberry32(777);
  const atoms = ['a', 'b', '..', '.', '', 'c'];
  const rnd = (n) => Array.from({ length: n }, () => atoms[Math.floor(rng() * atoms.length)]).join('/');
  for (let i = 0; i < 3000; i++) {
    const rel = ['x', 'a/b', 'a/b/c', 'q/r/s/t'][i % 4];
    const target = rnd(1 + (i % 5)) || 'a';
    let want = null;
    let got = null;
    try { cpioLib.checkSymlink(rel, target); } catch (e) { want = e.message; }
    try { __test.checkSymlink(rel, target); } catch (e) { got = e.message; }
    assert.equal(got, want, `checkSymlink(${rel}, ${target})`);
  }
});

test('erofs core: full-strength port for images <= 32 MiB; random mutations agree with readErofs', async (t) => {
  const baseItemsErofs = baseItems().map((it) => (it.path === 'core.cpio' ? { ...it, path: 'core.erofs', data: erofsImage } : it));
  const mk = (img) => makePkg({ manifest: (m) => (m.core.image = 'erofs'), items: baseItemsErofs.map((it) => (it.path === 'core.erofs' ? { ...it, data: img } : it)) });
  const goodBuf = mk(erofsImage);
  assertSameResult(await verifyPackageStream(chunked(goodBuf, 777)), pkg.load(goodBuf), 'erofs');
  assertSameResult(await verifyPackageStream(chunked(goodBuf, 777), { erofsFullCheckMax: 0 }), pkg.load(goodBuf), 'erofs (large-image mode)');
  const parsed = erofsLib.readErofs(erofsImage);
  t.diagnostic(`erofs test image: ${erofsImage.length} bytes, ${parsed.entries.length} entries`);

  // targeted rejections with the exact readErofs wording
  const u16 = (img, off, v) => { const c = Buffer.from(img); c.writeUInt16LE(v, off); return c; };
  const u32 = (img, off, v) => { const c = Buffer.from(img); c.writeUInt32LE(v, off); return c; };
  const u8 = (img, off, v) => { const c = Buffer.from(img); c[off] = v; return c; };
  const sb = 1024;
  const targeted = {
    'bad magic': [u32(erofsImage, sb, 0), /not an EROFS image \(bad magic\)/],
    'unknown compat flag': [u32(erofsImage, sb + 8, 0x10), /unsupported compatible features 0x10/],
    'block size 8 KiB': [u8(erofsImage, sb + 12, 13), /block size must be 4 KiB/],
    'sb extension slots': [u8(erofsImage, sb + 13, 1), /extension slots/],
    'incompat features': [u32(erofsImage, sb + 80, 1), /unsupported incompatible features 0x1/],
    'extra devices': [u16(erofsImage, sb + 86, 1), /extra devices/],
    'dir block size': [u8(erofsImage, sb + 90, 1), /directory block size/],
    'xattr prefixes': [u8(erofsImage, sb + 91, 1), /extended attribute prefixes/],
    'block count too big': [u32(erofsImage, sb + 36, 0x7fffffff), /superblock counts \d+ blocks/],
    'root inode outside': [u16(erofsImage, sb + 14, 0xffff), /inode 65535 is outside the image|outside/],
    'image not 4 KiB multiple': [erofsImage.subarray(0, erofsImage.length - 100), /not a whole number of 4 KiB blocks/],
  };
  for (const [name, [img, re]] of Object.entries(targeted)) {
    const buf = mk(img);
    // the first fields are checked in BOTH modes, with the same wording
    for (const opts of [undefined, { erofsFullCheckMax: 0 }]) {
      const mode = opts ? 'large' : 'full';
      const s = await streamVerdict(buf, opts, 1000);
      assert.ok(!s.ok, `erofs ${name} (${mode}) accepted`);
      assert.match(s.e.message, new RegExp(`core\\.erofs is invalid: .*${re.source}`), `erofs ${name} (${mode})`);
    }
    assert.ok(!loadVerdict(buf).ok, `load() rejects erofs ${name}`);
  }

  // random single-byte mutations of the image, hashes fixed: full mode must agree with readErofs verdict for verdict
  const rng = mulberry32(2026);
  let both = 0;
  let acc = 0;
  let largeMiss = 0;
  let largeUnsound = 0;
  const bad = [];
  // the byte positions where readErofs notices a flipped bit (superblock, inodes, directory blocks): most flips go there
  const sensitive = [];
  for (let p = 1024; p < Math.min(erofsImage.length, 20000); p++) {
    const img = Buffer.from(erofsImage);
    img[p] ^= 0x01;
    try { erofsLib.readErofs(img); } catch { sensitive.push(p); }
  }
  assert.ok(sensitive.length > 100, `found ${sensitive.length} sensitive positions`);
  const N = 700;
  for (let i = 0; i < N; i++) {
    const pos = rng() < 0.8 ? sensitive[Math.floor(rng() * sensitive.length)] : Math.floor(rng() * erofsImage.length);
    const img = Buffer.from(erofsImage);
    img[pos] = rng() < 0.5 ? img[pos] ^ (1 << Math.floor(rng() * 8)) : Math.floor(rng() * 256);
    const buf = mk(img);
    const chunk = 1 + Math.floor(rng() * 5000);
    const s = await streamVerdict(buf, undefined, chunk);
    const l = loadVerdict(buf);
    const lg = await streamVerdict(buf, { erofsFullCheckMax: 0 }, chunk);
    if (s.ok !== l.ok) bad.push(`pos ${pos}: full-mode stream ${s.ok ? 'accepts' : 'rejects: ' + s.e.message}, load ${l.ok ? 'accepts' : 'rejects: ' + l.e.message}`);
    else if (!s.ok) {
      if (!isKnownError(s.e)) bad.push(`pos ${pos}: unexpected error ${s.e.stack}`);
      else if (s.e.message !== l.e.message) bad.push(`pos ${pos}: messages differ: ${s.e.message} / ${l.e.message}`);
    }
    if (l.ok) acc++;
    else both++;
    if (!lg.ok && l.ok) largeUnsound++; // large mode must never reject what load accepts
    if (lg.ok && !l.ok) largeMiss++;
  }
  assert.deepEqual(bad, [], bad.slice(0, 5).join('\n'));
  assert.equal(largeUnsound, 0, 'large-image mode rejected something load() accepts');
  console.log(`EROFS differential: ${N} random mutations of a ${erofsImage.length}-byte image: full mode agrees with readErofs on all (${both} rejected by both, ${acc} accepted by both); large-image mode (superblock + root inode only) accepted ${largeMiss} of the ${both} images readErofs rejects (the checks it does not make), and never rejected a valid one`);
  assert.ok(both > 50, 'the mutations exercised enough rejections');
});

test('erofs core, large-image mode (threshold lowered): a broken root inode is caught', async () => {
  // The code path of a >32 MiB image is the same with a lowered erofsFullCheckMax; a real 40 MiB tree is not needed.
  const broken = Buffer.from(erofsImage);
  broken.writeUInt16LE(0xffff, 1024 + 14);
  const buf = makePkg({ manifest: (m) => (m.core.image = 'erofs'), items: baseItems().map((it) => (it.path === 'core.cpio' ? { ...it, path: 'core.erofs', data: broken } : it)) });
  const s = await streamVerdict(buf, { erofsFullCheckMax: 1024 });
  assert.ok(!s.ok && /core\.erofs is invalid/.test(s.e.message));
  // the root inode (nid 36, byte 1152) turned into a regular file / given another owner / mode
  const rootNid = erofsImage.readUInt16LE(1024 + 14);
  assert.equal(rootNid * 32, 1152);
  const edits = { 'root is a file': [4, 0o100644, /the root: hard links are not supported|the root is not a directory/], 'root mode 0777': [4, 0o040777, /the root: mode 777 \(directories are 0755\)/], 'root owner 5': [24, 5, /the root: owned by 5:0, not root/] };
  for (const [name, [at, v, re]] of Object.entries(edits)) {
    const img = Buffer.from(erofsImage);
    img.writeUInt16LE(v, 1152 + at);
    const pk = makePkg({ manifest: (m) => (m.core.image = 'erofs'), items: baseItems().map((it) => (it.path === 'core.cpio' ? { ...it, path: 'core.erofs', data: img } : it)) });
    for (const opts of [undefined, { erofsFullCheckMax: 0 }]) {
      const r = await streamVerdict(pk, opts);
      assert.ok(!r.ok, `${name} accepted`);
      assert.match(r.e.message, re, name);
    }
    assert.ok(!loadVerdict(pk).ok);
  }
});

test('Worker-only memory bounds: too many tar entries / cpio entries are refused (load() has no such limit)', async () => {
  const dirs = Array.from({ length: MAX_TAR_ENTRIES + 5 }, (_, i) => ({ path: `ui/d${String(i).padStart(6, '0')}`, type: 'dir' }));
  const core = baseItems().find((it) => it.path === 'core.cpio');
  const many = makePkg({ items: [{ path: 'ui', type: 'dir' }, ...dirs, core] });
  const s = await streamVerdict(many);
  assert.ok(!s.ok && s.e instanceof VerifyError && /more than 100000 entries/.test(s.e.message), s.ok ? 'accepted' : s.e.message);
  assert.ok(loadVerdict(many).ok, 'load() accepts it (documented difference)');
  const recs = Array.from({ length: MAX_CPIO_ENTRIES + 1 }, (_, i) => cpioRec(`f${String(i).padStart(7, '0')}`, REG, Buffer.alloc(0), i + 1));
  const bigCpio = cpio(recs);
  const pk = makePkg({ items: withEntry(baseItems(), 'core.cpio', bigCpio) });
  const s2 = await streamVerdict(pk);
  assert.ok(!s2.ok && /core\.cpio is invalid: more than 250000 entries/.test(s2.e.message), s2.ok ? 'accepted' : s2.e.message);
  assert.ok(loadVerdict(pk).ok, 'load() accepts it (documented difference)');
});

// ---------------------------------------------------------------------------------------------------------------------
// fuzz: random corruption of a real package, verdicts must agree with load()

test('fuzz: random byte flips, truncations and insertions agree with load() (accept/reject)', async () => {
  const rng = mulberry32(99);
  const subjects = [baseBuf, syntheticPackages['cpio+icon'], syntheticPackages.erofs];
  let trials = 0;
  let rejected = 0;
  const bad = [];
  for (const base of subjects) {
    for (let i = 0; i < 400; i++) {
      let buf = Buffer.from(base);
      const kind = i % 4;
      if (kind === 0) buf[Math.floor(rng() * buf.length)] ^= 1 << Math.floor(rng() * 8);
      else if (kind === 1) buf = buf.subarray(0, Math.floor(rng() * buf.length));
      else if (kind === 2) {
        // flip within the first 3 KiB (headers and manifest), where most checks live
        buf[Math.floor(rng() * 3072)] = Math.floor(rng() * 256);
      } else {
        const at = Math.floor(rng() * buf.length);
        buf = Buffer.concat([buf.subarray(0, at), Buffer.from([Math.floor(rng() * 256)]), buf.subarray(at)]);
      }
      const s = await streamVerdict(buf, undefined, 1 + Math.floor(rng() * 3000));
      const l = loadVerdict(buf);
      trials++;
      if (s.ok !== l.ok) bad.push(`#${i} kind ${kind}: stream ${s.ok ? 'accepts' : s.e.message} / load ${l.ok ? 'accepts' : l.e.message}`);
      else if (!s.ok) {
        rejected++;
        if (!isKnownError(s.e)) bad.push(`#${i}: unexpected error type: ${s.e.stack}`);
      } else assertSameResult(s.r, l.r, `fuzz #${i}`);
    }
  }
  console.log(`FUZZ: ${trials} random mutations (${rejected} rejected, ${trials - rejected} accepted by both), disagreements: ${bad.length}`);
  assert.deepEqual(bad, [], bad.slice(0, 5).join('\n'));
});
