'use strict';
// "Load examples" (loader/src/examples.js and its wiring in loader/src/library.js), without Electron: what the folder holds, what
// the sheet shows for each package (read from the package itself), the README's "What to allow" hints, and the install loop (skips,
// failures that do not stop the others, nothing granted). The loader's CDP run K drives the same thing through the real UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { Store } = require('../../hostlib/store');
const { pack, read: readPackage } = require('../../hostlib/package');
const X = require('../../loader/src/examples');
const { resolveConfig } = require('../../loader/src/config');
const { tmpdir, rmrf, makeProject, write } = require('./helpers');

/** Packs a small app into dir/<file>. `over` = manifest fields (permissions replace the default ones). Returns the manifest. */
function makeExample(t, dir, file, over = {}) {
  const proj = path.join(tmpdir('ex-proj-'));
  t.after(() => rmrf(proj));
  const manifest = makeProject(proj, {
    manifest: Object.assign({ id: `com.example.${file.replace(/\W/g, '')}`, name: file, version: '1.0.0', description: `About ${file}`, permissions: { folders: [], dialogs: false, external: false } }, over),
  });
  fs.mkdirSync(dir, { recursive: true });
  pack(proj, path.join(dir, file));
  return manifest;
}

const noDeps = { currentVersion: () => null, hasRuntime: () => true };

// ------------------------------------------------------------------------------------------------ the folder

test('the folder: only regular *.vmapp files, numbers in order, dot-files and links ignored, a missing folder is empty', (t) => {
  const d = tmpdir('ex-dir-');
  t.after(() => rmrf(d));
  for (const n of ['10-last.vmapp', '02-second.vmapp', '01-first.vmapp']) write(path.join(d, n), 'x');
  write(path.join(d, 'README.md'), '# x');
  write(path.join(d, '.hidden.vmapp'), 'x');
  write(path.join(d, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(d, 'folder.vmapp'));
  fs.symlinkSync(path.join(d, '01-first.vmapp'), path.join(d, '00-link.vmapp'));
  assert.deepEqual(X.listPackageFiles(d).map((e) => e.name), ['01-first.vmapp', '02-second.vmapp', '10-last.vmapp']);
  assert.equal(X.listPackageFiles(d)[0].size, 1);
  assert.deepEqual(X.listPackageFiles(path.join(d, 'missing')), []);
  assert.deepEqual(X.listPackageFiles(''), []);
  assert.deepEqual(X.listPackageFiles(undefined), []);
});

test('the info: a packaged loader without examples hides the feature; a development loader always shows it', (t) => {
  const d = tmpdir('ex-info-');
  t.after(() => rmrf(d));
  const missing = path.join(d, 'nope');
  assert.deepEqual(X.infoOf(missing, true), { available: false, count: 0, show: false, packaged: true }, 'packaged, no examples: hidden, and no path is given');
  assert.deepEqual(X.infoOf(missing, false), { available: false, count: 0, show: true, packaged: false, dir: missing }, 'dev, no examples: shown (it explains tools/pack-examples)');
  fs.mkdirSync(missing);
  assert.equal(X.infoOf(missing, true).show, false, 'an empty folder is no examples');
  write(path.join(missing, 'a.vmapp'), 'x');
  assert.deepEqual(X.infoOf(missing, true), { available: true, count: 1, show: true, packaged: true });
});

test('config: the examples folder is out/examples in dev (or $VMAPP_EXAMPLES_DIR), and inside the bundle when packaged, whatever the environment says', () => {
  const saved = process.env.VMAPP_EXAMPLES_DIR;
  const hadRes = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  const savedRes = process.resourcesPath;
  try {
    delete process.env.VMAPP_EXAMPLES_DIR;
    assert.equal(resolveConfig(false).examplesDir, path.join(resolveConfig(false).root, 'out', 'examples'));
    process.env.VMAPP_EXAMPLES_DIR = '/tmp/some/examples';
    assert.equal(resolveConfig(false).examplesDir, '/tmp/some/examples');
    process.resourcesPath = '/Applications/D9010VmAppLauncher.app/Contents/Resources';
    assert.equal(resolveConfig(true).examplesDir, path.join('/Applications/D9010VmAppLauncher.app/Contents/Resources', 'vmapp', 'examples'), 'a packaged loader ignores the environment');
  } finally {
    if (saved === undefined) delete process.env.VMAPP_EXAMPLES_DIR;
    else process.env.VMAPP_EXAMPLES_DIR = saved;
    if (hadRes) process.resourcesPath = savedRes;
    else delete process.resourcesPath;
  }
});

// ------------------------------------------------------------------------------------------------ reading a package

test('the manifest is read from the package itself, from its first entry only', (t) => {
  const d = tmpdir('ex-peek-');
  t.after(() => rmrf(d));
  const m = makeExample(t, d, 'a.vmapp', { name: 'Alpha', version: '2.3.4', description: 'The alpha app' });
  const got = X.peekManifest(path.join(d, 'a.vmapp'));
  assert.equal(got.id, m.id);
  assert.equal(got.name, 'Alpha');
  assert.equal(got.version, '2.3.4');
  assert.equal(got.description, 'The alpha app');
});

test('what is not a package says so; a tampered package is still listed (the install is what verifies it)', (t) => {
  const d = tmpdir('ex-bad-');
  t.after(() => rmrf(d));
  write(path.join(d, 'text.vmapp'), 'this is not a package, though it is longer than one block of the tar format'.repeat(30));
  write(path.join(d, 'short.vmapp'), 'tiny');
  write(path.join(d, 'empty.vmapp'), '');
  for (const n of ['text.vmapp', 'short.vmapp', 'empty.vmapp']) assert.throws(() => X.peekManifest(path.join(d, n)), /./, n);
  // tamper with a UI file inside a real package: same size, so the tar stays well formed and only the hash is wrong
  makeExample(t, d, 'tampered.vmapp');
  const f = path.join(d, 'tampered.vmapp');
  const bytes = fs.readFileSync(f);
  const at = bytes.indexOf(Buffer.from('console.log(1)'));
  assert.ok(at > 0);
  bytes[at] = 'X'.charCodeAt(0);
  fs.writeFileSync(f, bytes);
  assert.equal(X.peekManifest(f).name, 'tampered.vmapp', 'the listing reads the manifest only');
  assert.throws(() => readPackage(f), /hash mismatch for "ui\/js\/app\.js"/, 'the verification the install runs refuses it');
});

// ------------------------------------------------------------------------------------------------ the README

const README = [
  '# D9010 VmApp examples',
  '',
  '| File | What it shows | What to allow | Source |',
  '|---|---|---|---|',
  '| `01-starter.vmapp` (28K) | The starter template | documents folder (read), optional | [`vmapp/templates/starter`](../../templates/starter) |',
  '| `06-terminal-gemini.vmapp` (98M) | A terminal | workspace folder (read & write); network generativelanguage.googleapis.com; paste your **Gemini** API key in its Settings | [x](y) · upstream: [Gemini CLI](https://github.com/google-gemini/gemini-cli) 0.62.0 |',
  '| `07-desk-helper.vmapp` (40K) | Computer-use demo | screen / input / tools / MCP in the red section; register tools in Host Capabilities (⌘3) | [`vmapp/apps/computer-use`](../../apps/computer-use) |',
  '| `odd.txt` (1K) | not a package row | whatever | x |',
  '| not a row | at all |',
  '',
  'Tips:',
  '- a list item | with a pipe',
].join('\n');

test('the README gives the “What to allow” hint of each package it lists, as plain text', () => {
  const r = X.parseReadme(README);
  assert.deepEqual(Object.keys(r), ['01-starter.vmapp', '06-terminal-gemini.vmapp', '07-desk-helper.vmapp']);
  assert.equal(r['01-starter.vmapp'].allow, 'documents folder (read), optional');
  assert.equal(r['01-starter.vmapp'].shows, 'The starter template');
  assert.equal(r['06-terminal-gemini.vmapp'].allow, 'workspace folder (read & write); network generativelanguage.googleapis.com; paste your Gemini API key in its Settings', 'markup is stripped');
  assert.equal(r['07-desk-helper.vmapp'].allow, 'screen / input / tools / MCP in the red section; register tools in Host Capabilities (⌘3)');
});

test('a README that is missing, empty or in another form gives no hints, and a long cell is cut', (t) => {
  assert.deepEqual(X.parseReadme(''), {});
  assert.deepEqual(X.parseReadme('just prose\n\n- a list'), {});
  assert.deepEqual(X.parseReadme(undefined), {});
  assert.deepEqual(X.parseReadme(null), {});
  const long = `| \`a.vmapp\` (1K) | s | ${'x'.repeat(2000)} | src |`;
  assert.equal(X.parseReadme(long)['a.vmapp'].allow.length, 500);
  const d = tmpdir('ex-readme-');
  t.after(() => rmrf(d));
  assert.deepEqual(X.readReadme(d), {}, 'no README.md in the folder');
  write(path.join(d, 'README.md'), README);
  assert.equal(Object.keys(X.readReadme(d)).length, 3);
});

// ------------------------------------------------------------------------------------------------ badges and hints

test('badges: network (the hosts), GPU, control of the computer, microphone; in that order, from the manifest', () => {
  const none = { permissions: { folders: [], dialogs: false, external: false } };
  assert.deepEqual(X.badgesOf(none), []);
  const net = X.badgesOf({ permissions: { network: [{ host: 'a.example.com', ports: [443] }, { host: '*.b.example.com', ports: [443, 80] }] } });
  assert.deepEqual(net.map((b) => [b.kind, b.label]), [['network', 'Network: a.example.com, *.b.example.com']]);
  assert.equal(net[0].title, 'Asks to reach: a.example.com, *.b.example.com');
  const many = X.badgesOf({ permissions: { network: ['a', 'b', 'c', 'd', 'e'].map((h) => ({ host: `${h}.example.com`, ports: [443] })) } });
  assert.equal(many[0].label, 'Network: a.example.com, b.example.com, c.example.com +2 more');
  const all = X.badgesOf({
    permissions: {
      devices: [{ device: 'microphone' }],
      host: [{ cap: 'input' }, { cap: 'gpu' }, { cap: 'screen' }, { cap: 'tool:*' }],
      network: [{ host: 'x.example.com', ports: [443] }],
    },
  });
  assert.deepEqual(all.map((b) => b.kind), ['network', 'gpu', 'host', 'microphone']);
  assert.deepEqual(all.map((b) => b.label), ['Network: x.example.com', 'GPU', 'Control of your computer', 'Microphone']);
  assert.equal(all[2].title, 'Asks for: mouse and keyboard, screen, tools');
  assert.equal(X.badgesOf({ permissions: { host: [{ cap: 'gpu', api: 'vulkan' }] } })[0].label, 'GPU (experimental)');
  assert.deepEqual(X.badgesOf({ permissions: { host: [{ cap: 'gpu' }] } }).map((b) => b.kind), ['gpu'], 'the GPU alone is not control of the computer');
});

test('the hint derived from the manifest says what to allow in the loader’s words', () => {
  assert.equal(X.deriveAllow({ permissions: { folders: [], dialogs: false, external: false } }), 'nothing up front');
  assert.equal(
    X.deriveAllow({
      permissions: {
        folders: [{ name: 'notes', access: 'readwrite' }, { name: 'export', access: 'writeonly' }, { name: 'docs', access: 'read' }],
        network: [{ host: 'api.example.com', ports: [443] }],
        host: [{ cap: 'screen' }, { cap: 'gpu', api: 'vulkan' }],
        devices: [{ device: 'microphone' }],
      },
    }),
    'notes folder (read & write); export folder (write-only); docs folder (read); network api.example.com; screen; GPU (experimental); microphone',
  );
});

test('versions: new, update, same, older', () => {
  const m = { version: '1.2.0' };
  assert.deepEqual(X.statusOf(m, null), { kind: 'new', installed: null });
  assert.deepEqual(X.statusOf(m, '1.1.9'), { kind: 'update', installed: '1.1.9' });
  assert.deepEqual(X.statusOf(m, '1.2.0'), { kind: 'same', installed: '1.2.0' });
  assert.deepEqual(X.statusOf(m, '1.10.0'), { kind: 'older', installed: '1.10.0' });
});

test('a row of the sheet: name, description, version, size, badges, the README hint (or the derived one) and what is installed', (t) => {
  const d = tmpdir('ex-row-');
  t.after(() => rmrf(d));
  makeExample(t, d, '01-net.vmapp', {
    name: 'Net App',
    version: '1.5.0',
    publisher: 'Example',
    description: 'Talks to the internet',
    permissions: { folders: [{ name: 'docs', access: 'read', purpose: 'Your docs' }], dialogs: false, external: false, network: [{ host: 'api.example.com', purpose: 'Sync' }], devices: [{ device: 'microphone', purpose: 'Voice' }] },
  });
  write(path.join(d, '02-broken.vmapp'), 'x'.repeat(2000));
  const [a, b] = X.listPackageFiles(d);
  const withReadme = X.describeExample(a, { '01-net.vmapp': { shows: 'unused', allow: 'the docs folder; api.example.com' } }, { currentVersion: () => '1.4.0', hasRuntime: () => true });
  assert.equal(withReadme.name, 'Net App');
  assert.equal(withReadme.version, '1.5.0');
  assert.equal(withReadme.description, 'Talks to the internet', 'the description comes from the package, not the README');
  assert.equal(withReadme.publisher, 'Example');
  assert.match(withReadme.sizeText, /KiB$/);
  assert.deepEqual(withReadme.badges.map((x) => x.kind), ['network', 'microphone']);
  assert.equal(withReadme.allow, 'the docs folder; api.example.com');
  assert.equal(withReadme.allowFrom, 'readme');
  assert.deepEqual(withReadme.status, { kind: 'update', installed: '1.4.0' });
  assert.equal(withReadme.runtimeMissing, false);
  const derived = X.describeExample(a, {}, { currentVersion: () => '1.5.0', hasRuntime: () => false });
  assert.equal(derived.allow, 'docs folder (read); network api.example.com; microphone');
  assert.equal(derived.allowFrom, 'manifest');
  assert.deepEqual(derived.status, { kind: 'same', installed: '1.5.0' });
  assert.equal(derived.runtimeMissing, true);
  const broken = X.describeExample(b, {}, noDeps);
  assert.equal(broken.name, '02-broken.vmapp');
  assert.ok(broken.error && broken.error.length > 5, 'an unreadable package says why');
  assert.deepEqual(broken.badges, []);
});

// ------------------------------------------------------------------------------------------------ the install loop

/** A stand-in for the library's deps over a map of installed versions; `files` = {<file name>: manifest | Error}. */
function fakeDeps({ installed = {}, files, running = [], missingRuntime = [], failInstall = [] }) {
  const events = [];
  const calls = [];
  const deps = {
    verify: (file) => {
      const v = files[path.basename(file)];
      if (v instanceof Error) throw v;
      return { manifest: v };
    },
    currentVersion: (id) => installed[id] || null,
    hasRuntime: (rt) => !missingRuntime.includes(rt),
    isRunning: (id) => running.includes(id),
    install: (file) => {
      const m = files[path.basename(file)];
      if (failInstall.includes(m.id)) throw new Error(`disk full for ${m.id}`);
      calls.push(m.id);
      const previous = installed[m.id] || null;
      installed[m.id] = m.version;
      return { id: m.id, version: m.version, previous };
    },
    onProgress: (ev) => events.push(ev),
  };
  return { deps, events, calls, installed };
}
const man = (id, version, over = {}) => Object.assign({ id, name: id.split('.').pop(), version, runtime: 'node22' }, over);
const entries = (files) => Object.keys(files).map((name) => ({ name, file: `/x/${name}` }));

test('install: new, update, same and older versions; a failing package does not stop the rest', async () => {
  const files = {
    'a.vmapp': man('com.e.a', '1.0.0'),
    'b.vmapp': man('com.e.b', '1.1.0'),
    'c.vmapp': man('com.e.c', '1.0.0'),
    'd.vmapp': man('com.e.d', '1.0.0'),
    'e.vmapp': new Error('hash mismatch for "ui/app.js": vmapp.json says aa, actual bb'),
    'f.vmapp': man('com.e.f', '1.0.0'),
  };
  const s = fakeDeps({ installed: { 'com.e.b': '1.0.0', 'com.e.c': '1.0.0', 'com.e.d': '2.0.0' }, files });
  const results = await X.installExamples(entries(files), s.deps);
  assert.deepEqual(results.map((r) => [r.file, r.status]), [['a.vmapp', 'installed'], ['b.vmapp', 'updated'], ['c.vmapp', 'skipped'], ['d.vmapp', 'skipped'], ['e.vmapp', 'failed'], ['f.vmapp', 'installed']]);
  assert.deepEqual(s.calls, ['com.e.a', 'com.e.b', 'com.e.f'], 'only what needed installing was installed');
  assert.equal(results[1].previous, '1.0.0');
  assert.equal(results[2].note, 'Version 1.0.0 is already installed.');
  assert.equal(results[3].note, 'A newer version (2.0.0) is installed.');
  assert.equal(results[4].step, 'verify');
  assert.match(results[4].error, /^hash mismatch for "ui\/app\.js"/, 'the precise message of the verification is kept');
  const c = X.countsOf(results);
  assert.deepEqual(c, { installed: 2, updated: 1, skipped: 2, failed: 1, total: 6 });
  assert.equal(X.summaryText(c), 'Installed 2 apps, updated 1, skipped 2, 1 failed.');
});

test('install: progress is verifying, then installing, then the result, per package, in order', async () => {
  const files = { 'a.vmapp': man('com.e.a', '1.0.0'), 'b.vmapp': man('com.e.b', '1.0.0') };
  const s = fakeDeps({ installed: { 'com.e.b': '1.0.0' }, files });
  await X.installExamples(entries(files), s.deps);
  assert.deepEqual(s.events.map((e) => `${e.file}:${e.phase}`), ['a.vmapp:verifying', 'a.vmapp:installing', 'a.vmapp:installed', 'b.vmapp:verifying', 'b.vmapp:skipped']);
  assert.equal(s.events[2].version, '1.0.0');
  assert.equal(s.events[4].note, 'Version 1.0.0 is already installed.');
});

test('install: a missing runtime, a running app and a failing install are reported per package, with the step they failed at', async () => {
  const files = { 'a.vmapp': man('com.e.a', '1.0.0', { runtime: 'dotnet8' }), 'b.vmapp': man('com.e.b', '2.0.0'), 'c.vmapp': man('com.e.c', '1.0.0'), 'd.vmapp': man('com.e.d', '1.0.0') };
  const s = fakeDeps({ installed: { 'com.e.b': '1.0.0' }, files, running: ['com.e.b'], missingRuntime: ['dotnet8'], failInstall: ['com.e.c'] });
  const results = await X.installExamples(entries(files), s.deps);
  assert.deepEqual(results.map((r) => [r.status, r.step || null]), [['failed', 'install'], ['failed', 'install'], ['failed', 'install'], ['installed', null]]);
  assert.equal(results[0].error, 'The runtime “dotnet8” is not installed on this Mac.');
  assert.equal(results[1].error, 'Stop the app first.');
  assert.equal(results[2].error, 'disk full for com.e.c');
  assert.deepEqual(s.calls, ['com.e.d']);
  assert.equal(X.summaryText(X.countsOf(results)), 'Installed 1 app, 3 failed.');
});

test('the summary line', () => {
  const c = (installed, updated, skipped, failed) => ({ installed, updated, skipped, failed, total: installed + updated + skipped + failed });
  assert.equal(X.summaryText(c(0, 0, 0, 0)), 'Nothing was selected.');
  assert.equal(X.summaryText(c(1, 0, 0, 0)), 'Installed 1 app.');
  assert.equal(X.summaryText(c(13, 0, 0, 0)), 'Installed 13 apps.');
  assert.equal(X.summaryText(c(0, 2, 0, 0)), 'Updated 2 apps.');
  assert.equal(X.summaryText(c(0, 0, 3, 0)), 'Skipped 3 apps.');
  assert.equal(X.summaryText(c(0, 0, 0, 1)), '1 failed.');
  assert.equal(X.summaryText(c(2, 0, 1, 1)), 'Installed 2 apps, skipped 1, 1 failed.');
});

// ------------------------------------------------------------------------------------------------ the library: the same install path, nothing granted

function loadLibrary() {
  const sent = [];
  const fake = {
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 1, send: (ch, p) => sent.push([ch, p]) } }], fromWebContents: () => null },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) },
  };
  const handlers = {};
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : orig.call(this, request, ...rest);
  };
  try {
    for (const f of ['library', 'window-manager']) delete require.cache[require.resolve(`../../loader/src/${f}`)];
    return { Library: require('../../loader/src/library').Library, handlers, sent };
  } finally {
    Module._load = orig;
  }
}

function libSetup(t) {
  const d = tmpdir('ex-lib-');
  t.after(() => rmrf(d));
  const dir = path.join(d, 'examples');
  makeExample(t, dir, '01-a.vmapp', { id: 'com.e.a', name: 'Alpha', permissions: { folders: [{ name: 'docs', access: 'read', purpose: 'p' }], dialogs: false, external: false, network: [{ host: 'x.example.com', purpose: 'p' }] } });
  makeExample(t, dir, '02-b.vmapp', { id: 'com.e.b', name: 'Beta' });
  makeExample(t, dir, '03-c.vmapp', { id: 'com.e.c', name: 'Gamma', version: '2.0.0' });
  const store = new Store({ home: path.join(d, 'home'), skipRuntimeCheck: true });
  fs.mkdirSync(path.join(store.home, 'runtimes'), { recursive: true });
  fs.writeFileSync(store.runtimePath('node22'), 'img');
  const running = new Set();
  const runner = { on() {}, state: () => 'stopped', isActive: (id) => running.has(id), sessionOf: () => null, error: () => null, note: () => null, uiContexts: new Map() };
  const { Library, handlers, sent } = loadLibrary();
  const lib = new Library({ store, runner, inspector: {}, nativeDialogs: {}, senders: new Map([[1, 'library']]), updates: {}, catalog: null, capabilities: null, examplesDir: dir, packaged: false, log: () => {} });
  const ipc = (channel, ...args) => handlers[channel]({ sender: { id: 1, mainFrame: 'f' }, senderFrame: 'f' }, ...args);
  return { d, dir, store, lib, ipc, running, sent };
}

test('the library lists the examples from the packages and installs the chosen ones through the normal path, granting nothing', async (t) => {
  const s = libSetup(t);
  const info = await s.ipc('lib:examplesInfo');
  assert.equal(info.result.available, true);
  assert.equal(info.result.count, 3);
  const list = (await s.ipc('lib:examplesList')).result;
  assert.deepEqual(list.items.map((i) => [i.file, i.name, i.version]), [['01-a.vmapp', 'Alpha', '1.0.0'], ['02-b.vmapp', 'Beta', '1.0.0'], ['03-c.vmapp', 'Gamma', '2.0.0']]);
  assert.deepEqual(list.items[0].badges.map((b) => b.kind), ['network']);
  assert.equal(list.items[0].allow, 'docs folder (read); network x.example.com', 'no README: derived from the manifest');

  const r = (await s.ipc('lib:examplesInstall', ['01-a.vmapp', '03-c.vmapp'])).result;
  assert.deepEqual(r.results.map((x) => [x.file, x.status]), [['01-a.vmapp', 'installed'], ['03-c.vmapp', 'installed']]);
  assert.equal(r.text, 'Installed 2 apps.');
  assert.deepEqual(s.store.list().map((a) => a.id).sort(), ['com.e.a', 'com.e.c']);
  assert.equal(s.store.currentVersion('com.e.b'), null, 'what was not chosen is not installed');
  assert.ok(s.store.getPackageFile('com.e.a'), 'the package is kept exactly as Install from file keeps it');
  for (const id of ['com.e.a', 'com.e.c']) {
    assert.equal(fs.existsSync(s.store.grantsPath(id)), false, `${id}: installing wrote no grants`);
    assert.equal(s.store.hasDecided(id), false);
  }
  assert.deepEqual(s.store.loadNetGrants('com.e.a'), {}, 'no network grant');
  const progress = s.sent.filter(([ch]) => ch === 'lib:examplesProgress').map(([, ev]) => `${ev.file}:${ev.phase}`);
  assert.deepEqual(progress, ['01-a.vmapp:verifying', '01-a.vmapp:installing', '01-a.vmapp:installed', '03-c.vmapp:verifying', '03-c.vmapp:installing', '03-c.vmapp:installed']);
  assert.ok(s.sent.some(([ch]) => ch === 'lib:changed'), 'the library is told to show the new cards');

  // again: skipped, with a note, nothing reinstalled
  const again = (await s.ipc('lib:examplesInstall', ['01-a.vmapp', '02-b.vmapp', '03-c.vmapp'])).result;
  assert.deepEqual(again.results.map((x) => x.status), ['skipped', 'installed', 'skipped']);
  assert.equal(again.text, 'Installed 1 app, skipped 2.');
  assert.deepEqual(s.store.list().map((a) => a.id).sort(), ['com.e.a', 'com.e.b', 'com.e.c']);
});

test('the library refuses names the folder does not hold, installs nothing then, and does not run two installs at once', async (t) => {
  const s = libSetup(t);
  for (const bad of [['../x.vmapp'], ['01-a.vmapp', 'nope.vmapp'], [42], [], 'not a list', [path.join(s.dir, '01-a.vmapp')], ['README.md']]) {
    const r = await s.ipc('lib:examplesInstall', bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(s.store.list(), [], 'nothing was installed by a bad request');
  assert.match((await s.ipc('lib:examplesInstall', ['01-a.vmapp', 'nope.vmapp'])).error, /“nope\.vmapp” is not one of the examples\./);
  s.lib.examplesBusy = true;
  assert.match((await s.ipc('lib:examplesInstall', ['01-a.vmapp'])).error, /already being installed/);
  s.lib.examplesBusy = false;
  assert.equal((await s.ipc('lib:examplesInstall', ['01-a.vmapp'])).ok, true);
  assert.equal(s.lib.examplesBusy, false);
});

test('the library: a tampered package fails with the verification message while the others install; a running app is not replaced', async (t) => {
  const s = libSetup(t);
  const f = path.join(s.dir, '02-b.vmapp');
  const bytes = fs.readFileSync(f);
  bytes[bytes.indexOf(Buffer.from('console.log(1)'))] = 'X'.charCodeAt(0);
  fs.writeFileSync(f, bytes);
  const r = (await s.ipc('lib:examplesInstall', ['01-a.vmapp', '02-b.vmapp', '03-c.vmapp'])).result;
  assert.deepEqual(r.results.map((x) => x.status), ['installed', 'failed', 'installed']);
  assert.match(r.results[1].error, /^hash mismatch for "ui\/js\/app\.js"/);
  assert.equal(r.results[1].step, 'verify');
  assert.equal(s.store.currentVersion('com.e.b'), null, 'the tampered package was not installed');
  assert.equal(r.text, 'Installed 2 apps, 1 failed.');
  // a newer version of a running app: refused with a clear note, the others still go
  s.running.add('com.e.c');
  makeExample(t, s.dir, '03-c.vmapp', { id: 'com.e.c', name: 'Gamma', version: '2.1.0' });
  const r2 = (await s.ipc('lib:examplesInstall', ['03-c.vmapp'])).result;
  assert.equal(r2.results[0].status, 'failed');
  assert.match(r2.results[0].error, /Stop the app first/);
  assert.equal(s.store.currentVersion('com.e.c'), '2.0.0');
});

test('the File menu may ask the page for “examples” and “install” only', (t) => {
  const s = libSetup(t);
  s.lib.menuAction('examples');
  s.lib.menuAction('install');
  assert.deepEqual(s.sent.filter(([ch]) => ch === 'lib:menu').map(([, a]) => a), ['examples', 'install']);
  assert.throws(() => s.lib.menuAction('quit'), /unknown menu action/);
});
