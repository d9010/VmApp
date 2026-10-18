'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../../hostlib/package');
const { writeTar, readTar } = require('../../hostlib/tar');
const { cpioFromDir } = require('../../hostlib/cpio');
const { Store, StoreError } = require('../../hostlib/store');
const { canonicalize } = require('../../hostlib/manifest');
const { tmpdir, rmrf, makeProject, write } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function packed(overrides) {
  const d = tmpdir('pkg-');
  const proj = path.join(d, 'proj');
  makeProject(proj, overrides);
  const out = path.join(d, 'a.vmapp');
  const r = pkg.pack(proj, out);
  return { d, proj, out, r };
}

/** Rebuilds a package from entries with a manifest `mutate` hook, to craft invalid packages. */
function craft(out, mutateEntries, mutateManifest) {
  const entries = readTar(fs.readFileSync(out)).map((e) => ({ path: e.path, type: e.type, data: Buffer.from(e.data) }));
  const m = JSON.parse(entries[0].data.toString());
  if (mutateManifest) mutateManifest(m);
  entries[0].data = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  const list = mutateEntries ? mutateEntries(entries) || entries : entries;
  const f = out + '.crafted';
  fs.writeFileSync(f, writeTar(list));
  return f;
}

test('pack is reproducible and produces the SPEC layout', () => {
  const { d, proj, out, r } = packed();
  try {
    const first = fs.readFileSync(out);
    const out2 = path.join(d, 'b.vmapp');
    const r2 = pkg.pack(proj, out2);
    assert.ok(first.equals(fs.readFileSync(out2)), 'byte-identical');
    assert.equal(r.packageId, r2.packageId);
    const entries = readTar(first);
    assert.deepEqual(
      entries.map((e) => e.path),
      ['vmapp.json', 'ui', 'ui/css', 'ui/css/app.css', 'ui/index.html', 'ui/js', 'ui/js/app.js', 'core.cpio'],
    );
    const manifestBytes = entries[0].data;
    assert.equal(r.packageId, sha(manifestBytes));
    const m = JSON.parse(manifestBytes.toString());
    assert.deepEqual(Object.keys(m.files), ['core.cpio', 'ui/css/app.css', 'ui/index.html', 'ui/js/app.js']);
    assert.equal(m.files['ui/index.html'], sha(Buffer.from('<!doctype html><title>x</title>')));
    assert.equal(manifestBytes.toString(), canonicalize(m));
    assert.equal(m.core.workdir, '/app');
    assert.equal(m.core.memoryMiB, 256);
    assert.ok(!('files' in JSON.parse(fs.readFileSync(path.join(proj, 'vmapp.json'), 'utf8'))), 'project manifest is untouched');
  } finally {
    rmrf(d);
  }
});

test('pack includes an optional icon.png last', () => {
  const { d, proj } = packed();
  try {
    write(path.join(proj, 'icon.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')]));
    const out = path.join(d, 'i.vmapp');
    pkg.pack(proj, out);
    const entries = readTar(fs.readFileSync(out));
    assert.equal(entries[entries.length - 1].path, 'icon.png');
    assert.equal(entries[entries.length - 2].path, 'core.cpio');
    assert.equal(pkg.verify(out).hasIcon, true);
    write(path.join(proj, 'icon.png'), 'not a png');
    assert.throws(() => pkg.pack(proj, path.join(d, 'j.vmapp')), /not a PNG/);
  } finally {
    rmrf(d);
  }
});

test('pack rejects a project manifest with files, and bad projects', () => {
  const { d, proj } = packed();
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(proj, 'vmapp.json'), 'utf8'));
    mf.files = {};
    write(path.join(proj, 'vmapp.json'), JSON.stringify(mf));
    assert.throws(() => pkg.pack(proj, path.join(d, 'x.vmapp')), /files/);
    delete mf.files;
    mf.version = 'bad';
    write(path.join(proj, 'vmapp.json'), JSON.stringify(mf));
    assert.throws(() => pkg.pack(proj, path.join(d, 'x.vmapp')), /version/);
    mf.version = '1.0.0';
    write(path.join(proj, 'vmapp.json'), JSON.stringify(mf));
    fs.symlinkSync('index.html', path.join(proj, 'ui', 'l.html'));
    assert.throws(() => pkg.pack(proj, path.join(d, 'x.vmapp')), /symlinks are not allowed/);
    fs.unlinkSync(path.join(proj, 'ui', 'l.html'));
    fs.rmSync(path.join(proj, 'core'), { recursive: true });
    assert.throws(() => pkg.pack(proj, path.join(d, 'x.vmapp')), /core folder not found/);
  } finally {
    rmrf(d);
  }
});

test('verify accepts a good package and returns the summary', () => {
  const { d, out, r } = packed();
  try {
    const v = pkg.verify(out);
    assert.equal(v.ok, true);
    assert.equal(v.packageId, r.packageId);
    assert.equal(v.manifest.id, 'com.example.notes');
    const rd = pkg.read(out);
    assert.equal(rd.entries.length, 8);
  } finally {
    rmrf(d);
  }
});

test('verify: hash mismatch', () => {
  const { d, out } = packed();
  try {
    const f = craft(out, (es) => {
      es.find((e) => e.path === 'ui/index.html').data = Buffer.from('tampered');
    });
    assert.throws(() => pkg.verify(f), /hash mismatch for "ui\/index\.html"/);
    // flip a byte in the raw file (content of core.cpio)
    const raw = fs.readFileSync(out);
    const at = raw.indexOf('070701');
    raw[at + 100] ^= 0xff;
    fs.writeFileSync(out + '.flip', raw);
    assert.throws(() => pkg.verify(out + '.flip'), /hash mismatch for "core\.cpio"|core\.cpio is invalid/);
  } finally {
    rmrf(d);
  }
});

test('verify: extra and missing entries', () => {
  const { d, out } = packed();
  try {
    const extra = craft(out, (es) => {
      es.splice(7, 0, { path: 'ui/zz.js', type: 'file', data: Buffer.from('x') });
    });
    assert.throws(() => pkg.verify(extra), /"ui\/zz\.js" is not listed in vmapp\.json files/);
    const extra2 = craft(out, (es) => {
      es.push({ path: 'evil.sh', type: 'file', data: Buffer.from('x') });
    });
    assert.throws(() => pkg.verify(extra2), /unexpected entry "evil\.sh"/);
    const missing = craft(out, (es) => es.filter((e) => e.path !== 'ui/js/app.js'));
    assert.throws(() => pkg.verify(missing), /lists "ui\/js\/app\.js" in files but the package has no such entry/);
    const noCore = craft(out, (es) => es.filter((e) => e.path !== 'core.cpio'));
    assert.throws(() => pkg.verify(noCore), /no core\.cpio/);
    const phantom = craft(out, null, (m) => (m.files['ui/ghost.js'] = 'a'.repeat(64)));
    assert.throws(() => pkg.verify(phantom), /"ui\/ghost\.js" in files but the package has no such entry/);
  } finally {
    rmrf(d);
  }
});

test('verify: entry order', () => {
  const { d, out } = packed();
  try {
    const manifestLast = craft(out, (es) => [...es.slice(1), es[0]]);
    assert.throws(() => pkg.verify(manifestLast), /first entry must be vmapp\.json/);
    const coreFirst = craft(out, (es) => [es[0], es[es.length - 1], ...es.slice(1, -1)]);
    assert.throws(() => pkg.verify(coreFirst), /core\.cpio|order/);
    const unsorted = craft(out, (es) => {
      const a = es.findIndex((e) => e.path === 'ui/css/app.css');
      const b = es.findIndex((e) => e.path === 'ui/index.html');
      [es[a], es[b]] = [es[b], es[a]];
    });
    assert.throws(() => pkg.verify(unsorted), /entry order: "ui\/css\/app\.css" must sort after/);
    const uiAfterCore = craft(out, (es) => {
      const u = es.splice(es.findIndex((e) => e.path === 'ui/js/app.js'), 1)[0];
      es.push(u);
    });
    assert.throws(() => pkg.verify(uiAfterCore), /entry order/);
    const noParent = craft(out, (es) => es.filter((e) => e.path !== 'ui/js'));
    assert.throws(() => pkg.verify(noParent), /parent directory "ui\/js\/"/);
    const iconBeforeCore = craft(
      out,
      (es) => {
        const core = es.pop();
        es.push({ path: 'icon.png', type: 'file', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
        es.push(core);
      },
      (m) => (m.files['icon.png'] = sha(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))),
    );
    assert.throws(() => pkg.verify(iconBeforeCore), /icon\.png must come last/);
  } finally {
    rmrf(d);
  }
});

test('verify: dangerous entries and invalid core.cpio', () => {
  const { d, out } = packed();
  try {
    const clean = craft(out, (es) => {
      es.splice(2, 0, { path: 'ui/a', type: 'file', data: Buffer.from('x') });
    }, (m) => (m.files['ui/a'] = sha(Buffer.from('x'))));
    assert.doesNotThrow(() => pkg.verify(clean)); // sanity: a well-ordered extra file with a matching hash is fine
    assert.throws(() => writeTar([{ path: 'ui/../../x', type: 'file', data: Buffer.alloc(0) }]), /not allowed/);
    const badCpio = Buffer.from('not a cpio');
    const f = craft(
      out,
      (es) => {
        es[es.length - 1].data = badCpio;
      },
      (m) => (m.files['core.cpio'] = sha(badCpio)),
    );
    assert.throws(() => pkg.verify(f), /core\.cpio is invalid/);
    // manifest rules are enforced on verify too
    const badManifest = craft(out, null, (m) => (m.core.memoryMiB = 1));
    assert.throws(() => pkg.verify(badManifest), /core\.memoryMiB/);
  } finally {
    rmrf(d);
  }
});

test('package size limits constants match the SPEC', () => {
  assert.equal(pkg.MAX_PACKAGE, 2047 * 1024 * 1024);
  assert.equal(pkg.MAX_CORE, 256 * 1024 * 1024);
  assert.equal(pkg.MAX_CORE_EROFS, pkg.MAX_PACKAGE);
  assert.equal(pkg.MAX_UI, 1024 * 1024 * 1024);
});

test('pack -> verify -> install -> list -> uninstall round trip', () => {
  const { d, out, r } = packed();
  const home = path.join(d, 'home');
  try {
    const store = new Store({ home, skipRuntimeCheck: true });
    assert.deepEqual(store.list(), []);
    const inst = store.install(out);
    assert.equal(inst.id, 'com.example.notes');
    assert.equal(inst.version, '1.0.0');
    assert.equal(inst.packageId, r.packageId);
    assert.equal(fs.readFileSync(path.join(home, 'apps', 'com.example.notes', 'current'), 'utf8').trim(), '1.0.0');
    const dir = path.join(home, 'apps', 'com.example.notes', '1.0.0');
    for (const f of ['vmapp.json', 'core.cpio', 'ui/index.html', 'ui/css/app.css']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    assert.ok(fs.existsSync(path.join(home, 'data', 'com.example.notes')));
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'com.example.notes');
    assert.equal(list[0].packageId, r.packageId);
    assert.equal(store.get('com.example.notes').manifest.name, 'Notes');
    assert.equal(store.verifyInstalled('com.example.notes'), true);
    fs.writeFileSync(path.join(dir, 'ui', 'index.html'), 'changed');
    assert.throws(() => store.verifyInstalled('com.example.notes'), /modified/);
    store.saveGrants('com.example.notes', { folders: { notes: { path: '/tmp', access: 'read' }, export: null }, askEveryTime: true });
    assert.equal(store.loadGrants('com.example.notes').folders.notes.access, 'read');
    // uninstall keeps data and grants without --purge
    fs.writeFileSync(path.join(home, 'data', 'com.example.notes', 'f.txt'), 'x');
    store.uninstall('com.example.notes');
    assert.deepEqual(store.list(), []);
    assert.ok(fs.existsSync(path.join(home, 'data', 'com.example.notes', 'f.txt')));
    assert.ok(fs.existsSync(path.join(home, 'grants', 'com.example.notes.json')));
    store.install(out);
    store.uninstall('com.example.notes', { purge: true });
    assert.ok(!fs.existsSync(path.join(home, 'data', 'com.example.notes')));
    assert.ok(!fs.existsSync(path.join(home, 'grants', 'com.example.notes.json')));
    assert.throws(() => store.uninstall('com.example.notes'), /not installed/);
  } finally {
    rmrf(d);
  }
});

test('install: runtime check and version rule', () => {
  const { d, proj, out } = packed();
  const home = path.join(d, 'home');
  try {
    const strict = new Store({ home });
    assert.throws(() => strict.install(out), /runtime "node22" is not installed/);
    const img = path.join(d, 'node22.img');
    fs.writeFileSync(img, 'img');
    strict.installRuntime('node22', img);
    assert.deepEqual(strict.listRuntimes(), ['node22']);
    assert.doesNotThrow(() => strict.install(out));
    // same version again is fine; newer is fine; older needs --force
    assert.doesNotThrow(() => strict.install(out));
    const mf = JSON.parse(fs.readFileSync(path.join(proj, 'vmapp.json'), 'utf8'));
    mf.version = '1.1.0';
    write(path.join(proj, 'vmapp.json'), JSON.stringify(mf));
    const v11 = path.join(d, 'v11.vmapp');
    pkg.pack(proj, v11);
    const up = strict.install(v11);
    assert.equal(up.previous, '1.0.0');
    assert.equal(strict.get('com.example.notes').version, '1.1.0');
    assert.throws(() => strict.install(out), /refusing to downgrade/);
    assert.equal(strict.install(out, { force: true }).version, '1.0.0');
    assert.equal(strict.get('com.example.notes').version, '1.0.0');
    // skip option per call
    const other = new Store({ home: path.join(d, 'home2') });
    assert.doesNotThrow(() => other.install(out, { skipRuntimeCheck: true }));
  } finally {
    rmrf(d);
  }
});

test('store rejects bad ids and invalid grants', () => {
  const d = tmpdir('store-');
  try {
    const s = new Store({ home: d, skipRuntimeCheck: true });
    assert.throws(() => s.dataDir('../evil'), StoreError);
    assert.throws(() => s.get('x'), StoreError);
    assert.throws(() => s.saveGrants('com.a.b', { folders: { notes: { path: 'relative', access: 'read' } } }), /absolute/);
    assert.throws(() => s.saveGrants('com.a.b', { folders: { notes: { path: '/x', access: 'rw' } } }), /access/);
    assert.throws(() => s.saveGrants('com.a.b', { folders: { Bad: null } }), /invalid folder name/);
    assert.deepEqual(s.loadGrants('com.a.b'), { folders: {}, askEveryTime: false });
  } finally {
    rmrf(d);
  }
});

test('Store.resetApp empties data, forgets grants, clears picks; keeps package, other apps and the log', () => {
  const d = tmpdir('reset-');
  try {
    const s = new Store({ home: d, skipRuntimeCheck: true });
    const id = 'com.a.b';
    const other = 'com.a.c';
    write(path.join(s.dataDir(id), 'db.sqlite'), 'x');
    write(path.join(s.dataDir(id), 'sub', 'deep', 'f.txt'), 'y');
    write(path.join(s.dataDir(other), 'keep.txt'), 'z');
    s.saveGrants(id, { folders: { notes: { path: '/some/where', access: 'read' } }, askEveryTime: true });
    s.saveGrants(other, { folders: {} });
    write(path.join(s.picksDir(id), 'pick-0', 'a.txt'), 'p');
    write(s.consoleLogPath(id), 'log');
    write(path.join(s.appRoot(id), 'current'), '1.0.0\n');
    assert.deepEqual(s.resetApp(id), { id, reset: true });
    assert.ok(fs.statSync(s.dataDir(id)).isDirectory());
    assert.deepEqual(fs.readdirSync(s.dataDir(id)), []);
    assert.deepEqual(s.loadGrants(id), { folders: {}, askEveryTime: false });
    assert.ok(!fs.existsSync(s.grantsPath(id)));
    assert.ok(!fs.existsSync(s.picksDir(id)));
    assert.ok(fs.existsSync(s.consoleLogPath(id)));
    assert.ok(fs.existsSync(path.join(s.appRoot(id), 'current')), 'the installed package stays');
    assert.ok(fs.existsSync(path.join(s.dataDir(other), 'keep.txt')));
    assert.ok(fs.existsSync(s.grantsPath(other)));
    // idempotent, also when nothing exists yet
    assert.doesNotThrow(() => s.resetApp(id));
    assert.doesNotThrow(() => s.resetApp('com.a.never'));
    assert.throws(() => s.resetApp('../evil'), StoreError);
  } finally {
    rmrf(d);
  }
});

test('core.cpio of a package matches cpioFromDir of the project core folder', () => {
  const { d, proj, out } = packed();
  try {
    const entries = readTar(fs.readFileSync(out));
    assert.ok(entries.find((e) => e.path === 'core.cpio').data.equals(cpioFromDir(path.join(proj, 'core'))));
  } finally {
    rmrf(d);
  }
});
