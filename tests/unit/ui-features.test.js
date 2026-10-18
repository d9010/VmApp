'use strict';
// Window features (SPEC 2.2 ui.features, SPEC 7; docs/design/DEV-APPS.md C1): the manifest field, the CSP each feature adds, and the
// isolated-frame handler (vmapp-frame://) with its denied paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateManifest, ManifestError, UI_FEATURES } = require('../../hostlib/manifest');
const { APP_CSP, FRAME_CSP, UI_FEATURE_CSP, appCsp, createAppUiHandler, createAppFrameHandler } = require('../../loader/src/protocols');

const base = () => ({ format: 1, id: 'com.example.ide', name: 'IDE', version: '1.0.0', runtime: 'node22', core: { command: ['node', 'main.js'] } });
const parse = (csp) => new Map(csp.split(';').map((p) => p.trim().split(/\s+/)).filter((t) => t[0]).map((t) => [t[0], t.slice(1)]));

test('ui.features: accepted values, kept in order, absent from the canonical form when not declared', () => {
  assert.deepEqual(UI_FEATURES, ['workers', 'wasm', 'self-fetch', 'frames', 'network']);
  const m = validateManifest(Object.assign(base(), { ui: { features: ['frames', 'workers'] } }), { files: 'forbidden' });
  assert.deepEqual(m.ui, { root: 'ui', features: ['frames', 'workers'] });
  assert.deepEqual(validateManifest(base(), { files: 'forbidden' }).ui, { root: 'ui' });
  assert.deepEqual(validateManifest(Object.assign(base(), { ui: { features: [] } }), { files: 'forbidden' }).ui, { root: 'ui' });
});

test('ui.features "network" (SPEC 8.3 "The app\'s windows"): only with permissions.network', () => {
  assert.throws(() => validateManifest(Object.assign(base(), { ui: { features: ['network'] } }), { files: 'forbidden' }), /needs permissions\.network/);
  const m = validateManifest(
    Object.assign(base(), { ui: { features: ['workers', 'network'] }, permissions: { network: [{ host: 'open-vsx.org', purpose: 'Extension icons' }] } }),
    { files: 'forbidden' },
  );
  assert.deepEqual(m.ui.features, ['workers', 'network']);
});

test('ui.features: unknown, duplicate and non-string values are refused', () => {
  for (const features of [['network-anything'], ['workers', 'workers'], [1], 'workers', [null]]) {
    assert.throws(() => validateManifest(Object.assign(base(), { ui: { features } }), { files: 'forbidden' }), ManifestError, JSON.stringify(features));
  }
});

test('appCsp: no feature is exactly SPEC 7 (APP_CSP); each feature adds exactly its own sources; only "network" adds network sources, for data', () => {
  assert.equal(appCsp(undefined), APP_CSP);
  assert.equal(appCsp([]), APP_CSP);
  const spec = parse(APP_CSP);
  const DATA = { 'connect-src': ['https:', 'wss:'], 'img-src': ['https:'], 'media-src': ['https:'], 'font-src': ['https:'], 'style-src': ['https:'] };
  for (const f of Object.keys(UI_FEATURE_CSP)) {
    const got = parse(appCsp([f]));
    for (const [dir, srcs] of got) {
      const want = UI_FEATURE_CSP[f][dir];
      if (!want) {
        assert.deepEqual(srcs, spec.get(dir), `${f} must not change ${dir}`);
        continue;
      }
      const before = (spec.get(dir) || []).filter((s) => s !== "'none'");
      assert.deepEqual(srcs, [...before, ...want.filter((s) => !before.includes(s))], `${f}: ${dir}`);
      for (const s of srcs) {
        if (f === 'network' && (DATA[dir] || []).includes(s)) continue;
        assert.ok(!/^(https?:|wss?:|\*)/.test(s), `${f} adds no network source (${dir} ${s})`);
      }
    }
  }
  const net = parse(appCsp(['network']));
  for (const dir of ['script-src', 'worker-src', 'frame-src', 'object-src', 'default-src', 'base-uri', 'form-action']) {
    assert.deepEqual(net.get(dir), spec.get(dir), `"network" leaves ${dir} alone: no code or document from the network`);
  }
  assert.deepEqual(net.get('connect-src'), ['https:', 'wss:']);
  const all = parse(appCsp(['workers', 'wasm', 'self-fetch', 'frames']));
  assert.deepEqual(all.get('connect-src'), ["'self'"]);
  assert.deepEqual(all.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(all.get('worker-src'), ["'self'", 'blob:']);
  assert.deepEqual(all.get('frame-src'), ['vmapp-frame:']);
  assert.ok(!all.get('script-src').some((s) => s === "'unsafe-inline'" || s === "'unsafe-eval'"), 'the page never gets unsafe-inline or unsafe-eval');
  assert.deepEqual(parse(appCsp(['unknown'])), spec, 'an unknown feature adds nothing');
});

test('FRAME_CSP: only https: (for service-worker answers), never http:, ws(s): or *; no plugins, no form posts', () => {
  for (const [dir, srcs] of parse(FRAME_CSP)) for (const s of srcs) assert.ok(!/^(http:|wss?:|\*)/.test(s), `${dir} ${s}`);
  assert.deepEqual(parse(FRAME_CSP).get('object-src'), ["'none'"]);
  assert.deepEqual(parse(FRAME_CSP).get('form-action'), ["'none'"]);
});

// ---- the handlers, on a real installed-package layout ----
function fixture(features) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-uif-'));
  const files = {};
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    files[rel] = crypto.createHash('sha256').update(text).digest('hex');
  };
  put('ui/index.html', '<!doctype html><title>x</title>');
  put('ui/pre/index.html', '<!doctype html><title>frame</title>');
  const manifest = validateManifest(Object.assign(base(), { ui: features ? { features } : undefined, files: Object.assign({ 'core.cpio': 'a'.repeat(64) }, files) }));
  const contexts = new Map([['com.example.ide', { app: { manifest, dir }, verified: new Map() }]]);
  return { dir, contexts };
}
const get = (h, url, method = 'GET') => h(new Request(url, { method }));

test('vmapp-ui pages carry appCsp(features) of the installed manifest', async () => {
  const { contexts } = fixture(['frames', 'workers']);
  const r = await get(createAppUiHandler(contexts), 'vmapp-ui://com.example.ide/index.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), appCsp(['frames', 'workers']));
  const plain = fixture(undefined);
  assert.equal((await get(createAppUiHandler(plain.contexts), 'vmapp-ui://com.example.ide/index.html')).headers.get('content-security-policy'), APP_CSP);
});

test('vmapp-frame serves the verified package files with FRAME_CSP, for an app that declares frames', async () => {
  const { contexts } = fixture(['frames']);
  const h = createAppFrameHandler(contexts, 'com.example.ide');
  const r = await get(h, 'vmapp-frame://0a1b2c.webview/pre/index.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), FRAME_CSP);
  assert.match(await r.text(), /frame/);
});

test('vmapp-frame denied paths: no "frames" feature, another app, a file not in the manifest, a changed file, traversal, POST', async () => {
  const none = fixture(['workers']);
  assert.equal((await get(createAppFrameHandler(none.contexts, 'com.example.ide'), 'vmapp-frame://x/pre/index.html')).status, 404, 'no frames feature');
  const { dir, contexts } = fixture(['frames']);
  assert.equal((await get(createAppFrameHandler(contexts, 'com.other.app'), 'vmapp-frame://x/pre/index.html')).status, 404, 'the partition names another app');
  const h = createAppFrameHandler(contexts, 'com.example.ide');
  assert.equal((await get(h, 'vmapp-frame://x/vmapp.json')).status, 404, 'not a UI file');
  assert.equal((await get(h, 'vmapp-frame://x/pre/../../core.cpio')).status, 404, 'traversal');
  assert.equal((await get(h, 'vmapp-frame://x/pre/index.html', 'POST')).status, 405);
  fs.writeFileSync(path.join(dir, 'ui/pre/index.html'), 'tampered');
  assert.equal((await get(h, 'vmapp-frame://x/pre/index.html')).status, 404, 'a file that no longer matches its hash');
});
