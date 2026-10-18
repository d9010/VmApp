'use strict';
// SPEC 8.1: versions, withdrawn versions, /versions, /resolve, /withdraw, /restore, and `vmapp get --choice`,
// `vmapp withdraw`, `vmapp restore`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const V = require('../../registry/lib/versions');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish, listFiles, storeText } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');

/** A minimal app record: versions given as strings; `withdrawn` lists the ones that are withdrawn. */
function mk(list, withdrawn = []) {
  const versions = {};
  for (const v of list) {
    versions[v] = { version: v, publishedAt: 1, size: 1, sha256: 'a'.repeat(64), packageId: 'b'.repeat(64) };
    if (withdrawn.includes(v)) versions[v].withdrawn = { reason: 'bad', at: 2 };
  }
  return { id: 'com.example.x', latest: list[list.length - 1], versions };
}

// ---------------------------------------------------------------------------------------------- resolve semantics
test('resolve: compatible = same major; for 0.x the same minor; never lower than `from`', () => {
  const app = mk(['0.1.0', '0.1.5', '0.2.0', '0.2.3', '1.0.0', '1.4.0', '1.9.2', '2.0.0', '2.3.0']);
  assert.equal(V.resolve(app, 'compatible', '1.0.0'), '1.9.2');
  assert.equal(V.resolve(app, 'compatible', '1.9.2'), '1.9.2', 'may equal from');
  assert.equal(V.resolve(app, 'compatible', '2.0.0'), '2.3.0');
  assert.equal(V.resolve(app, 'compatible', '0.1.0'), '0.1.5', '0.x: a new minor can break, so 0.1.x stays in 0.1');
  assert.equal(V.resolve(app, 'compatible', '0.2.0'), '0.2.3');
  assert.equal(V.resolve(app, 'compatible', '0.1.5'), '0.1.5');
  assert.equal(V.resolve(app, 'compatible', '0.3.0'), null, 'nothing in 0.3');
  assert.equal(V.resolve(app, 'compatible', '3.0.0'), null, 'nothing in major 3');
  assert.equal(V.resolve(app, 'compatible', '2.4.0'), null, 'the registry has nothing at or above 2.4.0 in major 2: no downgrade');
  assert.equal(V.resolve(app, 'compatible', '1.5.0'), '1.9.2', 'from need not be published');
  assert.throws(() => V.resolve(app, 'compatible', null), /starting version/);
  assert.throws(() => V.resolve(app, 'newest', '1.0.0'), /unknown choice/);
});

test('resolve: latest = the highest version of any major; without `from` too', () => {
  const app = mk(['0.1.0', '1.0.0', '2.0.0', '2.3.0']);
  assert.equal(V.resolve(app, 'latest', '0.1.0'), '2.3.0');
  assert.equal(V.resolve(app, 'latest', '2.3.0'), '2.3.0');
  assert.equal(V.resolve(app, 'latest', null), '2.3.0');
  assert.equal(V.resolve(app, 'latest', '9.0.0'), null, 'never lower than from');
});

test('resolve: withdrawn versions are never picked', () => {
  const app = mk(['1.0.0', '1.1.0', '1.2.0', '2.0.0'], ['1.2.0', '2.0.0']);
  assert.equal(V.resolve(app, 'compatible', '1.0.0'), '1.1.0');
  assert.equal(V.resolve(app, 'latest', '1.0.0'), '1.1.0');
  // from itself withdrawn: the answer is the best non-withdrawn version at or above it, in the same major
  assert.equal(V.resolve(app, 'compatible', '1.2.0'), null);
  assert.equal(V.resolve(app, 'latest', '1.0.0'), '1.1.0');
  const all = mk(['1.0.0', '1.1.0'], ['1.0.0', '1.1.0']);
  assert.equal(V.resolve(all, 'latest', null), null);
  assert.equal(V.newestAvailable(all), null);
  assert.equal(V.displayVersion(all), '1.1.0', 'when everything is withdrawn the page still shows the highest');
  assert.equal(V.newestAvailable(app), '1.1.0');
});

test('resolve: prereleases are skipped unless `from` is a prerelease of the same x.y.z', () => {
  const app = mk(['1.0.0', '1.1.0-beta.1', '1.1.0-beta.2', '1.2.0-beta.1', '2.0.0-rc.1']);
  assert.equal(V.resolve(app, 'compatible', '1.0.0'), '1.0.0', 'a stable user is never moved onto a prerelease');
  assert.equal(V.resolve(app, 'latest', '1.0.0'), '1.0.0');
  assert.equal(V.resolve(app, 'latest', null), '1.0.0');
  // a beta tester follows the betas of their own line
  assert.equal(V.resolve(app, 'compatible', '1.1.0-beta.1'), '1.1.0-beta.2');
  assert.equal(V.resolve(app, 'latest', '1.1.0-beta.1'), '1.1.0-beta.2', 'but not the betas of other lines (1.2.0-beta.1, 2.0.0-rc.1)');
  // ... and ends on the release of that line, which is higher than its prereleases
  const rel = mk(['1.1.0-beta.1', '1.1.0-beta.2', '1.1.0', '1.2.0-beta.1']);
  assert.equal(V.resolve(rel, 'compatible', '1.1.0-beta.1'), '1.1.0');
  assert.equal(V.resolve(rel, 'latest', '1.1.0-beta.2'), '1.1.0');
  // withdrawn prereleases are skipped too
  const w = mk(['1.1.0-beta.1', '1.1.0-beta.2'], ['1.1.0-beta.2']);
  assert.equal(V.resolve(w, 'compatible', '1.1.0-beta.1'), '1.1.0-beta.1');
  // prerelease ordering follows semver: beta.2 < beta.10 < rc.1
  const order = mk(['1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1']);
  assert.equal(V.resolve(order, 'latest', '1.0.0-beta.2'), '1.0.0-rc.1');
});

test('checkReason: plain text, 1 to 200 characters', () => {
  assert.equal(V.checkReason('  Corrupts notes  '), 'Corrupts notes');
  assert.equal(V.checkReason('€'.repeat(200)).length, 200);
  assert.throws(() => V.checkReason('€'.repeat(201)), /too long/);
  assert.throws(() => V.checkReason(''), /required/);
  assert.throws(() => V.checkReason('   '), /required/);
  assert.throws(() => V.checkReason(undefined), /required/);
  assert.throws(() => V.checkReason(5), /required/);
  assert.throws(() => V.checkReason('two\nlines'), /one line/);
  assert.throws(() => V.checkReason('bell\u0007'), /one line/);
});

// ---------------------------------------------------------------------------------------------- the endpoints
const ID = 'com.example.vers';
const SEQUENCE = ['0.1.0', '0.1.5', '0.2.0', '1.0.0', '1.1.0', '1.2.0-beta.1', '1.2.0', '2.0.0-rc.1', '2.0.0', '2.1.0'];

async function world(t, versions = SEQUENCE) {
  const s = await startRegistry();
  const w = tmpdir('vers-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  let token = null;
  const pkgs = {};
  for (const v of versions) {
    pkgs[v] = buildPackage(w, `p-${v}`, { id: ID, name: 'Vers', version: v });
    const r = await publish(s.url, pkgs[v].file, { token });
    assert.equal(r.status, 201, r.text);
    if (r.json.ownerToken) token = r.json.ownerToken;
  }
  return { s, w, token, pkgs };
}

const resolve = async (url, q) => (await call(url, `/api/apps/${ID}/resolve?${q}`)).json;
const withdraw = (url, version, reason, token) => call(url, `/api/apps/${ID}/${version}/withdraw`, { method: 'POST', json: { reason }, token });
const restore = (url, version, token) => call(url, `/api/apps/${ID}/${version}/restore`, { method: 'POST', json: {}, token });

test('GET /versions: every version, highest first, with withdrawn:null', async (t) => {
  const { s, pkgs } = await world(t);
  const r = await call(s.url, `/api/apps/${ID}/versions`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(r.json.map((x) => x.version), ['2.1.0', '2.0.0', '2.0.0-rc.1', '1.2.0', '1.2.0-beta.1', '1.1.0', '1.0.0', '0.2.0', '0.1.5', '0.1.0']);
  assert.deepEqual(Object.keys(r.json[0]).sort(), ['packageId', 'publishedAt', 'sha256', 'size', 'version', 'withdrawn']);
  const last = r.json[0];
  assert.equal(last.packageId, pkgs['2.1.0'].packageId);
  assert.equal(last.sha256, crypto.createHash('sha256').update(fs.readFileSync(pkgs['2.1.0'].file)).digest('hex'));
  assert.equal(last.size, pkgs['2.1.0'].size);
  assert.equal(last.publishedAt, '2026-03-01T12:00:00.000Z');
  assert.ok(r.json.every((x) => x.withdrawn === null));
  assert.equal((await call(s.url, '/api/apps/com.example.nope/versions')).status, 404);
  assert.equal((await call(s.url, '/api/apps/..%2Fx/versions')).status, 400);
  assert.equal((await call(s.url, `/api/apps/${ID}/versions`, { method: 'POST' })).status, 405);
});

test('GET /resolve: choices, the 0.x rule, prereleases, validation', async (t) => {
  const { s } = await world(t);
  const q = (choice, from) => resolve(s.url, `choice=${choice}${from === undefined ? '' : `&from=${encodeURIComponent(from)}`}`);
  assert.deepEqual(await q('compatible', '0.1.0'), { version: '0.1.5' });
  assert.deepEqual(await q('compatible', '0.2.0'), { version: '0.2.0' }, 'may equal from');
  assert.deepEqual(await q('compatible', '1.0.0'), { version: '1.2.0' }, 'the 1.2.0 release, not its beta');
  assert.deepEqual(await q('compatible', '1.2.0-beta.1'), { version: '1.2.0' }, 'a prerelease user ends on the release of its line');
  assert.deepEqual(await q('compatible', '2.0.0-rc.1'), { version: '2.1.0' });
  assert.deepEqual(await q('compatible', '2.0.0'), { version: '2.1.0' });
  assert.deepEqual(await q('latest', '0.1.0'), { version: '2.1.0' });
  assert.deepEqual(await q('latest'), { version: '2.1.0' });
  assert.deepEqual(await q('compatible', '3.0.0'), { version: null });
  assert.deepEqual(await q('latest', '3.0.0'), { version: null });

  for (const bad of ['', 'choice=compatible', 'choice=compatible&from=1.x', 'choice=compatible&from=', 'choice=latest&from=abc', 'choice=newest&from=1.0.0', 'from=1.0.0']) {
    const r = await call(s.url, `/api/apps/${ID}/resolve?${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.json.error.code, 'bad_request');
  }
  assert.equal((await call(s.url, '/api/apps/com.example.nope/resolve?choice=latest')).status, 404);
  assert.equal((await call(s.url, `/api/apps/${ID}/resolve?choice=latest`, { method: 'POST' })).status, 405);
});

test('withdraw / restore: owner token only (401 without, 403 for the wrong one)', async (t) => {
  const { s, w, token } = await world(t, ['1.0.0', '1.1.0']);
  const other = buildPackage(w, 'other', { id: 'com.example.other', name: 'Other' });
  const o = await publish(s.url, other.file);
  assert.equal(o.status, 201);

  for (const verb of ['withdraw', 'restore']) {
    const p = `/api/apps/${ID}/1.1.0/${verb}`;
    let r = await call(s.url, p, { method: 'POST', json: { reason: 'x' } });
    assert.equal(r.status, 401, verb);
    assert.equal(r.json.error.code, 'unauthorized');
    assert.match(r.headers.get('www-authenticate'), /Bearer/);
    r = await call(s.url, p, { method: 'POST', json: { reason: 'x' }, token: 'zz' });
    assert.equal(r.status, 401, 'malformed token');
    r = await call(s.url, p, { method: 'POST', json: { reason: 'x' }, token: crypto.randomBytes(32).toString('hex') });
    assert.equal(r.status, 403, 'unknown token');
    assert.equal(r.json.error.code, 'forbidden');
    r = await call(s.url, p, { method: 'POST', json: { reason: 'x' }, token: o.json.ownerToken });
    assert.equal(r.status, 403, 'another publisher\'s token');
    r = await call(s.url, p, { method: 'GET' });
    assert.equal(r.status, 405);
  }
  const v = (await call(s.url, `/api/apps/${ID}/versions`)).json;
  assert.ok(v.every((x) => x.withdrawn === null), 'nothing changed');

  let r = await withdraw(s.url, '1.1.0', 'Crashes on start', token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.id, ID);
  assert.equal(r.json.version, '1.1.0');
  assert.equal(r.json.withdrawn.reason, 'Crashes on start');
  assert.match(r.json.withdrawn.at, /^2026-03-01T12:00:00\.000Z$/);
  r = await restore(s.url, '1.1.0', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.withdrawn, null);
});

test('withdraw: validates the version, the app and the reason', async (t) => {
  const { s, token } = await world(t, ['1.0.0']);
  assert.equal((await withdraw(s.url, '9.9.9', 'x', token)).status, 404, 'unknown version');
  assert.equal((await withdraw(s.url, 'latest', 'x', token)).status, 400, 'only exact versions');
  assert.equal((await withdraw(s.url, '1.0', 'x', token)).status, 400);
  let r = await call(s.url, '/api/apps/com.example.nope/1.0.0/withdraw', { method: 'POST', json: { reason: 'x' }, token });
  assert.equal(r.status, 404);
  for (const bad of [undefined, '', '   ', 5, null, ['x'], 'a'.repeat(201), 'line\nbreak', '€'.repeat(201)]) {
    r = await withdraw(s.url, '1.0.0', bad, token);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error.code, 'bad_request');
  }
  r = await call(s.url, `/api/apps/${ID}/1.0.0/withdraw`, { method: 'POST', body: 'not json', token });
  assert.equal(r.status, 400);
  assert.equal((await withdraw(s.url, '1.0.0', 'a'.repeat(200), token)).status, 200, '200 characters is allowed');
  assert.equal((await withdraw(s.url, '1.0.0', '€'.repeat(200), token)).status, 200, '200 characters, not bytes');
  // withdrawing again replaces the reason
  r = await withdraw(s.url, '1.0.0', '  Replaced  ', token);
  assert.equal(r.json.withdrawn.reason, 'Replaced');
  // restoring something that is not withdrawn is a harmless no-op
  assert.equal((await restore(s.url, '1.0.0', token)).status, 200);
  r = await restore(s.url, '1.0.0', token);
  assert.equal(r.status, 200);
  assert.equal(r.json.withdrawn, null);
  assert.equal((await restore(s.url, '9.9.9', token)).status, 404);
});

test('withdrawn versions: out of resolve and "latest", still downloadable by exact version, shown with the reason', async (t) => {
  const { s, token, pkgs } = await world(t);
  assert.equal((await withdraw(s.url, '2.1.0', 'Deletes data: see notes', token)).status, 200);

  // resolve
  assert.deepEqual(await resolve(s.url, 'choice=latest&from=0.1.0'), { version: '2.0.0' });
  assert.deepEqual(await resolve(s.url, 'choice=compatible&from=2.0.0'), { version: '2.0.0' });
  assert.deepEqual(await resolve(s.url, 'choice=compatible&from=2.1.0'), { version: null }, 'the version you are on is withdrawn and nothing newer exists');

  // lists and details show the newest version that is not withdrawn
  let r = await call(s.url, '/api/apps?q=vers');
  assert.equal(r.json.items[0].latestVersion, '2.0.0');
  assert.equal(r.json.items[0].sizeBytes, pkgs['2.0.0'].size);
  r = await call(s.url, `/api/apps/${ID}`);
  assert.equal(r.json.latestVersion, '2.0.0');
  assert.equal(r.json.packageId, pkgs['2.0.0'].packageId);
  assert.equal(r.json.manifest.version, '2.0.0');
  const entry = r.json.versions.find((x) => x.version === '2.1.0');
  assert.deepEqual(entry.withdrawn, { reason: 'Deletes data: see notes', at: '2026-03-01T12:00:00.000Z' });
  assert.equal(r.json.versions.find((x) => x.version === '2.0.0').withdrawn, null);
  assert.equal((await call(s.url, `/api/apps/${ID}/versions`)).json[0].withdrawn.reason, 'Deletes data: see notes');

  // the latest alias skips it
  r = await call(s.url, `/api/apps/${ID}/latest/download`, { ip: '10.0.0.1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-vmapp-version'), '2.0.0');
  assert.equal(r.headers.get('x-vmapp-withdrawn'), null);
  assert.equal(r.headers.get('x-vmapp-package-id'), pkgs['2.0.0'].packageId);
  // an exact request still works, and says why it was withdrawn (percent-encoded: a header is ASCII)
  r = await call(s.url, `/api/apps/${ID}/2.1.0/download`, { ip: '10.0.0.1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-vmapp-version'), '2.1.0');
  assert.equal(decodeURIComponent(r.headers.get('x-vmapp-withdrawn')), 'Deletes data: see notes');
  assert.equal(r.headers.get('x-vmapp-package-id'), pkgs['2.1.0'].packageId);
  r = await call(s.url, `/api/apps/${ID}/2.1.0/download`, { method: 'HEAD' });
  assert.equal(r.status, 200);

  // restoring brings it back everywhere
  assert.equal((await restore(s.url, '2.1.0', token)).status, 200);
  assert.deepEqual(await resolve(s.url, 'choice=latest&from=0.1.0'), { version: '2.1.0' });
  assert.equal((await call(s.url, `/api/apps/${ID}`)).json.latestVersion, '2.1.0');
  r = await call(s.url, `/api/apps/${ID}/latest/download`, { ip: '10.0.0.2' });
  assert.equal(r.headers.get('x-vmapp-version'), '2.1.0');
  assert.equal(r.headers.get('x-vmapp-withdrawn'), null);
});

test('withdrawing every version: latest has nothing to serve, exact versions still download, the page data still shows the app', async (t) => {
  const { s, token } = await world(t, ['1.0.0', '1.1.0']);
  assert.equal((await withdraw(s.url, '1.0.0', 'one', token)).status, 200);
  assert.equal((await withdraw(s.url, '1.1.0', 'two', token)).status, 200);
  assert.deepEqual(await resolve(s.url, 'choice=latest'), { version: null });
  let r = await call(s.url, `/api/apps/${ID}/latest/download`);
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'all_withdrawn');
  assert.equal((await call(s.url, `/api/apps/${ID}/1.0.0/download`)).status, 200);
  r = await call(s.url, `/api/apps/${ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.latestVersion, '1.1.0', 'the highest, shown as withdrawn in versions[]');
  assert.equal(r.json.versions[0].withdrawn.reason, 'two');
  assert.equal((await call(s.url, '/api/apps')).json.total, 1);
  // publishing continues to need a higher version than the highest ever published, withdrawn or not
  const w = tmpdir('vers-');
  t.after(() => rmrf(w));
  const low = buildPackage(w, 'low', { id: ID, name: 'Vers', version: '1.0.5' });
  r = await publish(s.url, low.file, { token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'version_not_newer');
});

test('log: nothing is withdrawn until an event says so; withdrawals and restores survive restarts as events', async (t) => {
  const dir = tmpdir('vers-db-');
  t.after(() => rmrf(dir));
  const dataDir = path.join(dir, 'data');
  const w = path.join(dir, 'pkgs');
  fs.mkdirSync(w);
  let s = await startRegistry({ dataDir });
  let token = null;
  for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
    const p = buildPackage(w, `p-${v}`, { id: ID, name: 'Vers', version: v });
    const r = await publish(s.url, p.file, { token });
    assert.equal(r.status, 201, r.text);
    if (r.json.ownerToken) token = r.json.ownerToken;
  }
  await s.close();
  assert.ok(!storeText(s.storeDir).includes('version.withdrawn'), 'a registry that never withdrew anything has no withdrawal event');

  s = await startRegistry({ dataDir });
  let r = await call(s.url, `/api/apps/${ID}/versions`);
  assert.deepEqual(r.json.map((x) => [x.version, x.withdrawn]), [['1.2.0', null], ['1.1.0', null], ['1.0.0', null]]);
  assert.deepEqual((await resolve(s.url, 'choice=compatible&from=1.0.0')), { version: '1.2.0' });
  assert.equal((await call(s.url, `/api/apps/${ID}`)).json.latestVersion, '1.2.0');
  assert.equal((await withdraw(s.url, '1.2.0', 'Broken update', token)).status, 200);
  await s.close();

  // the withdrawal is an event: the version and its package are still there
  assert.equal((storeText(s.storeDir).match(/"type":"version\.withdrawn"/g) || []).length, 1);
  s = await startRegistry({ dataDir });
  assert.deepEqual((await resolve(s.url, 'choice=latest&from=1.0.0')), { version: '1.1.0' });
  assert.equal((await call(s.url, `/api/apps/${ID}/versions`)).json[0].withdrawn.reason, 'Broken update');
  assert.equal((await call(s.url, `/api/apps/${ID}/1.2.0/download`)).status, 200, 'still downloadable by its exact number');
  // restoring is another event; a second restore is a no-op that writes nothing
  const restore = (v) => call(s.url, `/api/apps/${ID}/${v}/restore`, { method: 'POST', token });
  assert.equal((await restore('1.2.0')).status, 200);
  const before = listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length;
  assert.equal((await restore('1.2.0')).status, 200);
  assert.equal(listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length, before, 'restoring a version that is not withdrawn writes no event');
  await s.close();

  s = await startRegistry({ dataDir });
  t.after(() => s.close());
  r = await call(s.url, `/api/apps/${ID}/versions`);
  assert.deepEqual(r.json.map((x) => [x.version, x.withdrawn]), [['1.2.0', null], ['1.1.0', null], ['1.0.0', null]]);
});

// ---------------------------------------------------------------------------------------------- the CLI
function vmapp(args, { env = {}, cwd } = {}) {
  return new Promise((resolveP) => {
    const e = Object.assign({}, process.env, env);
    delete e.VMAPP_PUBLISH_TOKEN;
    const p = spawn(process.execPath, [CLI, ...args], { env: e, cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolveP({ code, out, err }));
  });
}

test('CLI: withdraw, restore, and get --choice', async (t) => {
  const s = await startRegistry();
  const w = tmpdir('vers-cli-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const home = path.join(w, 'home');
  const work = path.join(w, 'work');
  fs.mkdirSync(work);
  const env = { VMAPP_HOME: home, VMAPP_REGISTRY: s.url };
  const ID2 = 'com.example.cvers';
  for (const v of ['1.0.0', '1.1.0', '2.0.0']) {
    const p = buildPackage(w, `p-${v}`, { id: ID2, name: 'CVers', version: v });
    const r = await vmapp(['publish', p.file], { env });
    assert.equal(r.code, 0, r.err);
  }
  const get = (extra) => vmapp(['get', ID2, ...extra], { env, cwd: work });

  // --choice
  let r = await get(['--choice', 'compatible', '--from', '1.0.0', '-o', path.join(work, 'a.vmapp')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /compatible version of com\.example\.cvers from 1\.0\.0: 1\.1\.0/);
  assert.match(r.out, /downloaded com\.example\.cvers 1\.1\.0/);
  r = await get(['--choice', 'latest', '--from', '1.0.0', '-o', path.join(work, 'b.vmapp')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /downloaded com\.example\.cvers 2\.0\.0/);
  r = await get(['--choice=latest', '-o', path.join(work, 'c.vmapp')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /downloaded com\.example\.cvers 2\.0\.0/);
  r = await get(['--choice', 'compatible', '--from', '5.0.0']);
  assert.equal(r.code, 1);
  assert.match(r.out, /no compatible version of com\.example\.cvers for 5\.0\.0/);
  assert.deepEqual(fs.readdirSync(work).filter((f) => f.includes('cvers')), [], 'nothing downloaded when nothing matched');

  // usage errors
  r = await get(['--choice', 'compatible']);
  assert.equal(r.code, 2, 'compatible needs --from when the app is not installed');
  assert.match(r.err, /--from/);
  r = await get(['--choice', 'newest', '--from', '1.0.0']);
  assert.equal(r.code, 2);
  r = await get(['--from', '1.0.0']);
  assert.equal(r.code, 2, '--from without --choice');
  r = await get(['--choice', 'latest', '--version', '1.0.0']);
  assert.equal(r.code, 2);
  r = await get(['--choice', 'compatible', '--from', 'x.y']);
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid --from/);

  // withdraw
  r = await vmapp(['withdraw', ID2, '1.1.0'], { env });
  assert.equal(r.code, 2, 'a reason is required');
  assert.match(r.err, /reason is required/);
  r = await vmapp(['withdraw', ID2, '1.1.0', '--reason', 'x'.repeat(201)], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /too long/);
  r = await vmapp(['withdraw', ID2, '1.1.0', '--reason', 'Corrupts notes'], { env: { VMAPP_HOME: path.join(w, 'nobody'), VMAPP_REGISTRY: s.url } });
  assert.equal(r.code, 1, 'no owner token on this machine');
  assert.match(r.err, /no owner token/);
  r = await vmapp(['withdraw', ID2, '1.1.0', '--reason', 'Corrupts notes', '--token', 'ab'.repeat(32)], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /403/);
  r = await vmapp(['withdraw', ID2, '1.1.0', '--reason', 'Corrupts notes'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /withdrew com\.example\.cvers 1\.1\.0: Corrupts notes/);
  r = await vmapp(['withdraw', ID2, '9.9.9', '--reason', 'x'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /no version 9\.9\.9/);

  r = await get(['--choice', 'compatible', '--from', '1.0.0', '-o', path.join(work, 'd.vmapp')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /: 1\.0\.0$/m, 'the withdrawn 1.1.0 is skipped');
  assert.match(r.out, /downloaded com\.example\.cvers 1\.0\.0/);
  r = await get(['-o', path.join(work, 'e.vmapp')]);
  assert.match(r.out, /downloaded com\.example\.cvers 2\.0\.0/);

  // an exact request still works, with a warning that carries the reason
  r = await get(['--version', '1.1.0', '-o', path.join(work, 'f.vmapp')]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /com\.example\.cvers 1\.1\.0 was withdrawn by its publisher: Corrupts notes/);
  assert.match(r.out, /downloaded com\.example\.cvers 1\.1\.0/);

  // restore
  r = await vmapp(['restore', ID2, '1.1.0'], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /restored com\.example\.cvers 1\.1\.0/);
  r = await get(['--choice', 'compatible', '--from', '1.0.0', '-o', path.join(work, 'g.vmapp')]);
  assert.match(r.out, /downloaded com\.example\.cvers 1\.1\.0/);
  r = await get(['--version', '1.1.0', '-o', path.join(work, 'h.vmapp')]);
  assert.equal(r.err, '', 'no warning once restored');
  r = await vmapp(['restore', ID2], { env });
  assert.equal(r.code, 2);
});
