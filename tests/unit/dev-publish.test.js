'use strict';
// Developer and publishing features behind the loader's "Run project folder…" and "Publish…":
//   - hostlib/store.js: the installed .vmapp is kept (apps/<id>/pkg/<version>.vmapp), the developer-build marker (dev.json)
//   - hostlib/updates.js: publish() against the REAL registry (in process), the friendly error texts, the token file
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../../hostlib/package');
const { Store } = require('../../hostlib/store');
const { UpdateError, publish, publishErrorText, getPublishToken, savePublishToken, publishRegistriesFor, publishTokensFile } = require('../../hostlib/updates');
const { startRegistry, call } = require('../registry/helpers');
const { tmpdir, rmrf, makeProject } = require('./helpers');

const ID = 'com.example.notes';

function build(dir, version, manifest = {}) {
  const proj = path.join(dir, `proj-${version}-${Math.random().toString(36).slice(2, 6)}`);
  makeProject(proj, { manifest: Object.assign({ version }, manifest) });
  const out = path.join(dir, `notes-${version}-${Math.random().toString(36).slice(2, 6)}.vmapp`);
  pkg.pack(proj, out);
  return out;
}

// ------------------------------------------------------------------------------------------------ store

test('store: install keeps the package file byte for byte; prune and uninstall remove it', () => {
  const dir = tmpdir('devpub-store-');
  try {
    const store = new Store({ home: path.join(dir, 'home'), skipRuntimeCheck: true });
    const files = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map((v) => build(dir, v));
    for (const f of files.slice(0, 2)) store.install(f);
    assert.deepEqual(fs.readFileSync(store.getPackageFile(ID, '1.0.0')), fs.readFileSync(files[0]), 'the kept file is the installed file');
    assert.equal(store.getPackageFile(ID), store.packagePath(ID, '1.1.0'), 'default: the current version');
    assert.equal(store.getPackageFile(ID, '9.9.9'), null);
    assert.deepEqual(store.listVersions(ID), ['1.0.0', '1.1.0'], 'pkg/ is not mistaken for a version');
    // keep current + 2 previous: the 4th install prunes 1.0.0, and its package file goes too
    store.install(files[2]);
    store.useVersion(ID, '1.1.0'); // touch order
    store.useVersion(ID, '1.2.0');
    const r = store.install(files[3]);
    assert.deepEqual(r.pruned, ['1.0.0']);
    assert.equal(store.getPackageFile(ID, '1.0.0'), null, 'pruned version: package file removed');
    assert.ok(store.getPackageFile(ID, '1.3.0'));
    // reinstalling the same version replaces the kept file
    store.install(files[3]);
    assert.deepEqual(fs.readFileSync(store.getPackageFile(ID, '1.3.0')), fs.readFileSync(files[3]));
    store.uninstall(ID);
    assert.equal(fs.existsSync(path.join(store.home, 'apps', ID)), false);
  } finally {
    rmrf(dir);
  }
});

test('store: a package that fails verification keeps nothing; non-files are refused', () => {
  const dir = tmpdir('devpub-bad-');
  try {
    const store = new Store({ home: path.join(dir, 'home'), skipRuntimeCheck: true });
    const bad = path.join(dir, 'bad.vmapp');
    fs.writeFileSync(bad, 'not a package');
    assert.throws(() => store.install(bad), /./);
    assert.equal(fs.existsSync(path.join(store.home, 'apps', ID)), false);
    assert.throws(() => store.install(dir), pkg.PackageError);
  } finally {
    rmrf(dir);
  }
});

test('store: developer-build marker (dev.json) is set by install({dev}) and ended by any other install', () => {
  const dir = tmpdir('devpub-dev-');
  try {
    const store = new Store({ home: path.join(dir, 'home'), skipRuntimeCheck: true });
    const v1 = build(dir, '1.0.0');
    const v2 = build(dir, '1.1.0');
    store.install(v1);
    assert.equal(store.getDevSource(ID), null);
    const folder = path.join(dir, 'my project');
    store.install(v2, { force: true, dev: { path: folder } });
    assert.deepEqual(store.getDevSource(ID), { path: folder });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.appRoot(ID), 'dev.json'), 'utf8')), { path: folder });
    // a developer build may replace a higher version (force), and rebuilding the same version works
    store.install(v1, { force: true, dev: { path: folder } });
    assert.equal(store.currentVersion(ID), '1.0.0');
    store.install(v1, { force: true, dev: { path: folder } });
    assert.deepEqual(store.getDevSource(ID), { path: folder });
    // any normal install ends the marker
    store.install(v2);
    assert.equal(store.getDevSource(ID), null);
    // validation
    assert.throws(() => store.setDevSource(ID, { path: 'relative/dir' }), /absolute/);
    fs.writeFileSync(path.join(store.appRoot(ID), 'dev.json'), '{"path":"relative"}');
    assert.equal(store.getDevSource(ID), null, 'a hand-edited relative path is ignored');
    fs.writeFileSync(path.join(store.appRoot(ID), 'dev.json'), 'not json');
    assert.equal(store.getDevSource(ID), null);
    store.clearDevSource(ID);
  } finally {
    rmrf(dir);
  }
});

// ------------------------------------------------------------------------------------------------ pure helpers

test('publishErrorText: every status of docs/PUBLISHING.md section 3.4 has a plain text', () => {
  assert.match(publishErrorText(400, { message: 'hash mismatch for "ui/app.js"' }), /not valid: hash mismatch for "ui\/app\.js"/);
  assert.match(publishErrorText(401, { hadToken: false }), /already published and no owner token was sent/);
  assert.match(publishErrorText(401, { hadToken: true }), /did not accept the owner token/);
  assert.match(publishErrorText(403), /does not own this app id/);
  assert.match(publishErrorText(403), /Do not change the app id/);
  assert.match(publishErrorText(409), /version already exists.*Raise the version in vmapp\.json/s);
  assert.match(publishErrorText(413), /2047 MiB/);
  assert.match(publishErrorText(415), /application\/octet-stream/);
  assert.match(publishErrorText(429), /rate limiting.*10 per hour/s);
  assert.match(publishErrorText(500, { message: 'oops' }), /problem \(HTTP 500\): oops/);
  assert.match(publishErrorText(418), /HTTP 418/);
});

test('publish tokens: same file and format as `vmapp publish`, mode 0600', () => {
  const dir = tmpdir('devpub-tok-');
  try {
    assert.equal(getPublishToken(dir, 'http://127.0.0.1:8790', ID), null);
    assert.deepEqual(publishRegistriesFor(dir, ID), []);
    const file = savePublishToken(dir, 'http://127.0.0.1:8790/', ID, 'tok-one');
    assert.equal(file, publishTokensFile(dir));
    assert.equal(path.basename(file), 'publish-tokens.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'http://127.0.0.1:8790': { [ID]: 'tok-one' } }, '{ "<registry url>": { "<app id>": "<token>" } }');
    savePublishToken(dir, 'https://registry.example.org', 'com.example.other', 'tok-two');
    savePublishToken(dir, 'https://registry.example.org', ID, 'tok-three');
    assert.equal(getPublishToken(dir, 'http://127.0.0.1:8790', ID), 'tok-one', 'a trailing slash on the address does not matter');
    assert.equal(getPublishToken(dir, 'https://registry.example.org', ID), 'tok-three');
    assert.equal(getPublishToken(dir, 'https://registry.example.org', 'com.example.other'), 'tok-two');
    assert.deepEqual(publishRegistriesFor(dir, ID), ['http://127.0.0.1:8790', 'https://registry.example.org']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'still 0600 after a rewrite');
    assert.deepEqual(fs.readdirSync(dir), ['publish-tokens.json'], 'no temp file left behind');
    // an unreadable file is an error with the path, not a silent empty answer
    fs.writeFileSync(file, '{broken');
    assert.throws(() => getPublishToken(dir, 'http://127.0.0.1:8790', ID), (e) => e instanceof UpdateError && e.message.includes('publish-tokens.json'));
    assert.throws(() => savePublishToken(dir, 'not a url', ID, 'x'), UpdateError);
  } finally {
    rmrf(dir);
  }
});

// ------------------------------------------------------------------------------------------------ publish() against the real registry

test('publish(): first publish (token + publisher), next version with the token, 409, 401, 403, offline', async () => {
  const r = await startRegistry();
  const dir = tmpdir('devpub-pub-');
  try {
    const v1 = build(dir, '1.0.0');
    const v2 = build(dir, '1.1.0');

    // first publish: no token, a publisher with a non-ASCII name travels as an escaped ASCII header
    const first = await publish(v1, { registry: r.url + '/', publisher: { name: 'Ada Lovelace-Zoë', company: 'Analytical Ltd', email: 'ada@example.com', url: 'https://example.com' } });
    assert.equal(first.id, ID);
    assert.equal(first.version, '1.0.0');
    assert.match(first.ownerToken, /^[0-9a-f]{64}$/);
    assert.match(first.packageId, /^[0-9a-f]{64}$/);
    assert.equal(first.url, `/apps/${ID}`);
    assert.equal(first.registry, r.url);
    const me = await call(r.url, '/api/publisher/me', { token: first.ownerToken });
    assert.equal(me.status, 200);
    assert.match(me.text, /Ada Lovelace-Zoë/, 'the publisher details were stored (not shown publicly)');
    assert.match(me.text, /Analytical Ltd/);

    // second version with the token: 201 and no new token
    const second = await publish(v2, { registry: r.url, token: first.ownerToken });
    assert.equal(second.version, '1.1.0');
    assert.equal(second.ownerToken, null);
    // the token is trimmed (pasted with a newline)
    const v3 = build(dir, '1.2.0');
    assert.equal((await publish(v3, { registry: r.url, token: `${first.ownerToken}\n` })).version, '1.2.0');

    // 409: the same version again
    await assert.rejects(publish(v2, { registry: r.url, token: first.ownerToken }), (e) => {
      assert.ok(e instanceof UpdateError);
      assert.equal(e.status, 409);
      assert.match(e.message, /Raise the version in vmapp\.json/);
      assert.ok(e.detail, 'the registry’s own message is kept in detail');
      return true;
    });
    // 401: the id exists and no token was sent; with a malformed token also 401
    const v4 = build(dir, '1.3.0');
    await assert.rejects(publish(v4, { registry: r.url }), (e) => e.status === 401 && /no owner token was sent/.test(e.message));
    // 403: a token that owns nothing here
    await assert.rejects(publish(v4, { registry: r.url, token: 'f'.repeat(64) }), (e) => e.status === 403 && /does not own this app id/.test(e.message));
    // still not published after the failures
    const list = await call(r.url, `/api/apps/${ID}/versions`);
    assert.deepEqual(list.json.map((v) => v.version).sort(), ['1.0.0', '1.1.0', '1.2.0']);
    // a token that works for a second id joins the same publisher (no new owner token)
    const other = build(dir, '1.0.0', { id: 'com.example.second' });
    const joined = await publish(other, { registry: r.url, token: first.ownerToken });
    assert.equal(joined.id, 'com.example.second');
    assert.equal(joined.ownerToken, null);
  } finally {
    await r.close();
    rmrf(r.dir);
    rmrf(dir);
  }
  // offline: nothing listens there any more
  const dir2 = tmpdir('devpub-off-');
  try {
    const v = build(dir2, '1.0.0');
    await assert.rejects(publish(v, { registry: r.url }), (e) => e instanceof UpdateError && e.offline === true && e.status === null && /Cannot reach the registry/.test(e.message));
  } finally {
    rmrf(dir2);
  }
});

test('publish(): refuses bad input before any request', async () => {
  const dir = tmpdir('devpub-in-');
  try {
    const v = build(dir, '1.0.0');
    await assert.rejects(publish(v, { registry: 'ftp://example.com' }), /registry address/);
    await assert.rejects(publish(v, {}), /registry address/);
    await assert.rejects(publish(path.join(dir, 'missing.vmapp'), { registry: 'http://127.0.0.1:9' }), /cannot be published/);
    const junk = path.join(dir, 'junk.vmapp');
    fs.writeFileSync(junk, 'junk');
    await assert.rejects(publish(junk, { registry: 'http://127.0.0.1:9' }), /cannot be published/);
    await assert.rejects(publish(v, { registry: 'http://127.0.0.1:9', token: 'bad token\r\nX-Evil: 1' }), /owner token/, 'header injection through the token is refused');
  } finally {
    rmrf(dir);
  }
});
