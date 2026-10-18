'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createRegistry } = require('../../registry/lib/registry');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish, listFiles, storeText } = require('./helpers');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HOUR = 3600 * 1000;

/** A request with the path sent exactly as given (fetch would normalise ".." away). */
function raw(url, rawPath, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function fixture(t, prefix) {
  const dir = tmpdir(prefix);
  t.after(() => rmrf(dir));
  return dir;
}

async function server(t, opts) {
  const s = await startRegistry(opts);
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
  });
  return s;
}

test('publish: first publish returns a one-time owner token, later versions need it', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const v1 = buildPackage(w, 'v1', { id: 'com.example.alpha', name: 'Alpha', version: '1.0.0' });
  const v11 = buildPackage(w, 'v11', { id: 'com.example.alpha', name: 'Alpha', version: '1.1.0' });
  const v09 = buildPackage(w, 'v09', { id: 'com.example.alpha', name: 'Alpha', version: '0.9.0' });

  let r = await publish(s.url, v1.file);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.id, 'com.example.alpha');
  assert.equal(r.json.version, '1.0.0');
  assert.equal(r.json.packageId, v1.packageId);
  assert.equal(r.json.created, true);
  assert.match(r.json.ownerToken, /^[0-9a-f]{64}$/);
  const token = r.json.ownerToken;

  // only the hash of the token is stored (in the event log), and the package is a blob named by its hash
  const logText = storeText(s.storeDir);
  assert.ok(!logText.includes(token), 'the token must not be stored');
  assert.ok(logText.includes(sha256(token)), 'its sha256 is stored');
  assert.deepEqual(fs.readFileSync(s.reg.blobPath(sha256(fs.readFileSync(v1.file)))), fs.readFileSync(v1.file));
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), [], 'no temp files left');

  // the same version again: 409 (with and without the token)
  r = await publish(s.url, v1.file, { token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'version_exists');
  r = await publish(s.url, v1.file);
  assert.equal(r.status, 401);

  // a new version: no token 401, malformed 401, wrong token 403, right token 201 (and no token echoed back)
  r = await publish(s.url, v11.file);
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'unauthorized');
  r = await publish(s.url, v11.file, { token: 'zz' });
  assert.equal(r.status, 401);
  r = await publish(s.url, v11.file, { token: crypto.randomBytes(32).toString('hex') });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'forbidden');
  r = await publish(s.url, v11.file, { token });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.created, false);
  assert.equal(r.json.ownerToken, undefined);

  // not newer than the latest: rejected
  r = await publish(s.url, v09.file, { token });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'version_not_newer');

  // details
  r = await call(s.url, '/api/apps/com.example.alpha');
  assert.equal(r.status, 200);
  assert.equal(r.json.latestVersion, '1.1.0');
  assert.deepEqual(r.json.versions.map((v) => v.version), ['1.1.0', '1.0.0']);
  assert.equal(r.json.versions[1].packageId, v1.packageId);
  assert.equal(r.json.versions[1].sha256, sha256(fs.readFileSync(v1.file)));
  assert.equal(r.json.versions[1].size, v1.size);
  assert.equal(r.json.manifest.files.count, 2);
  assert.equal(r.json.manifest.files.uiBytes > 0, true);
  assert.deepEqual(r.json.permissions.folders, [{ name: 'docs', access: 'read', purpose: 'The folder to show' }]);
  assert.equal(r.json.permissions.dialogs, true);
  assert.equal(r.json.manifest.files['core.cpio'], undefined, 'the files map is replaced by counts and sizes');
  assert.equal(r.json.manifest.name, 'Alpha');

  r = await call(s.url, '/api/stats');
  assert.deepEqual(r.json, { apps: 1, versions: 2, downloads: 0 });
});

test('publish: invalid packages and bad requests', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const ok = buildPackage(w, 'ok', { id: 'com.example.ok', name: 'Ok' });

  let r = await call(s.url, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('this is not a tar archive at all'.repeat(40)) });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'invalid_package');
  assert.ok(r.json.error.message.length > 5);

  // a well-formed tar whose file content does not match the manifest hash: hostlib's message is passed on
  const bytes = fs.readFileSync(ok.file);
  const at = bytes.indexOf('Basic fixture');
  assert.ok(at > 0);
  bytes[at] ^= 0x20;
  r = await call(s.url, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /hash mismatch/);

  r = await call(s.url, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(0) });
  assert.equal(r.status, 400);

  r = await call(s.url, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: fs.readFileSync(ok.file) });
  assert.equal(r.status, 415);

  r = await call(s.url, '/api/publish', { method: 'GET' });
  assert.equal(r.status, 405);

  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), [], 'rejected uploads leave no temp files');
  r = await call(s.url, '/api/apps');
  assert.equal(r.json.total, 0);
});

test('publish: size limit and rate limit', async (t) => {
  const s = await server(t, { maxPackageBytes: 1000, publishPerHour: 3, apiPerMinute: 8 });
  const w = fixture(t, 'pkg-');
  const ok = buildPackage(w, 'ok', { id: 'com.example.ok', name: 'Ok' });
  assert.ok(ok.size > 1000);

  let r = await publish(s.url, ok.file);
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'too_large');

  // chunked upload without a Content-Length is cut off at the limit as well
  const u = new URL(s.url);
  const status = await new Promise((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/publish', method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('reset'));
    req.write(Buffer.alloc(4000, 1));
    setTimeout(() => req.end(Buffer.alloc(4000, 1)), 50);
  });
  assert.ok(status === 413 || status === 'reset', `status ${status}`);
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), []);

  // 3 publishes per hour: the 4th attempt (even a failing one) is refused
  r = await publish(s.url, ok.file);
  assert.equal(r.status, 413);
  r = await publish(s.url, ok.file, { ip: '203.0.113.9' }); // another address has its own budget
  assert.equal(r.status, 413);
  r = await publish(s.url, ok.file);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal(r.json.error.code, 'rate_limited');

  // 8 API requests per minute per address; the window resets with the clock
  for (let i = 0; i < 8; i++) assert.equal((await call(s.url, '/api/stats', { ip: '198.51.100.1' })).status, 200);
  assert.equal((await call(s.url, '/api/stats', { ip: '198.51.100.1' })).status, 429);
  s.clock.advance(61 * 1000);
  assert.equal((await call(s.url, '/api/stats', { ip: '198.51.100.1' })).status, 200);
});

test('list: popular / new / updated / name, search, paging', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const apps = {};
  for (const n of ['alpha', 'beta', 'gamma']) {
    apps[n] = buildPackage(w, n, { id: `com.example.${n}`, name: n[0].toUpperCase() + n.slice(1), description: `The ${n} app` });
    const r = await publish(s.url, apps[n].file);
    assert.equal(r.status, 201, r.text);
    apps[n].token = r.json.ownerToken;
    s.clock.advance(60 * 1000);
  }
  const ids = async (qs) => (await call(s.url, `/api/apps?${qs}`)).json.items.map((i) => i.id.split('.').pop());

  assert.deepEqual(await ids('sort=new'), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(await ids('sort=updated'), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(await ids('sort=name'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(await ids('sort=popular'), ['alpha', 'beta', 'gamma'], 'no downloads yet: ties by name');
  assert.deepEqual(await ids(''), ['alpha', 'beta', 'gamma'], 'popular is the default');

  // downloads move apps up the popular list
  for (const ip of ['10.0.0.1', '10.0.0.2']) assert.equal((await call(s.url, '/api/apps/com.example.beta/1.0.0/download', { ip })).status, 200);
  assert.equal((await call(s.url, '/api/apps/com.example.gamma/latest/download', { ip: '10.0.0.1' })).status, 200);
  assert.deepEqual(await ids('sort=popular'), ['beta', 'gamma', 'alpha']);

  // a new version of alpha puts it first in "updated" but not in "new"
  const v2 = buildPackage(w, 'alpha2', { id: 'com.example.alpha', name: 'Alpha', version: '2.0.0', description: 'The alpha app' });
  assert.equal((await publish(s.url, v2.file, { token: apps.alpha.token })).status, 201);
  assert.deepEqual(await ids('sort=updated'), ['alpha', 'gamma', 'beta']);
  assert.deepEqual(await ids('sort=new'), ['gamma', 'beta', 'alpha']);

  // item shape
  const item = (await call(s.url, '/api/apps?sort=popular&limit=1')).json.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'createdAt', 'description', 'downloads', 'downloads30d', 'id', 'latestVersion', 'name', 'permissionsSummary', 'publisher', 'runtime', 'sizeBytes', 'updatedAt',
  ].sort());
  assert.equal(item.id, 'com.example.beta');
  assert.equal(item.downloads, 2);
  assert.equal(item.downloads30d, 2);
  assert.equal(item.runtime, 'node22');
  assert.match(item.permissionsSummary, /folder "docs" \(read only\)/);

  // search: id, name, description; several terms must all match; case-insensitive
  assert.deepEqual(await ids('q=beta'), ['beta']);
  assert.deepEqual(await ids('q=ALP'), ['alpha']);
  assert.deepEqual(await ids('q=the%20gamma'), ['gamma']);
  assert.deepEqual(await ids('q=com.example&sort=name'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(await ids('q=nothing-matches-this'), []);
  assert.equal((await call(s.url, '/api/apps?q=zzz')).json.total, 0);

  // paging
  let r = await call(s.url, '/api/apps?sort=name&limit=2&offset=0');
  assert.deepEqual(r.json.items.map((i) => i.name), ['Alpha', 'Beta']);
  assert.equal(r.json.total, 3);
  r = await call(s.url, '/api/apps?sort=name&limit=2&offset=2');
  assert.deepEqual(r.json.items.map((i) => i.name), ['Gamma']);

  // bad parameters
  assert.equal((await call(s.url, '/api/apps?sort=bogus')).status, 400);
  assert.equal((await call(s.url, '/api/apps?limit=abc')).status, 400);
  assert.equal((await call(s.url, '/api/apps?offset=-1')).status, 400);
  assert.equal((await call(s.url, '/api/apps/com.example.nope')).status, 404);
});

test('download: headers, counting, 24 h de-duplication, 30-day window', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const v1 = buildPackage(w, 'v1', { id: 'com.example.dl', name: 'Dl', version: '1.0.0' });
  const v2 = buildPackage(w, 'v2', { id: 'com.example.dl', name: 'Dl', version: '1.1.0' });
  const token = (await publish(s.url, v1.file)).json.ownerToken;
  assert.equal((await publish(s.url, v2.file, { token })).status, 201);
  const dl = (p, o) => call(s.url, `/api/apps/com.example.dl/${p}/download`, o);
  const counts = async () => {
    const d = (await call(s.url, '/api/apps/com.example.dl')).json;
    return { total: d.downloads, d30: d.downloads30d, v1: d.versions.find((v) => v.version === '1.0.0').downloads, v11: d.versions.find((v) => v.version === '1.1.0').downloads };
  };

  let r = await dl('1.0.0', { ip: '192.0.2.1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/x-vmapp');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="com.example.dl-1.0.0.vmapp"');
  assert.equal(r.headers.get('x-vmapp-package-id'), v1.packageId);
  assert.equal(r.headers.get('x-vmapp-sha256'), sha256(fs.readFileSync(v1.file)));
  assert.equal(r.headers.get('etag'), `"${sha256(fs.readFileSync(v1.file))}"`);
  assert.equal(r.text.length > 0, true);
  assert.deepEqual(await counts(), { total: 1, d30: 1, v1: 1, v11: 0 });

  // the same address and version again: not counted
  await dl('1.0.0', { ip: '192.0.2.1' });
  await dl('1.0.0', { ip: '192.0.2.1' });
  assert.deepEqual(await counts(), { total: 1, d30: 1, v1: 1, v11: 0 });
  // another address, another version, and "latest" (= 1.1.0)
  await dl('1.0.0', { ip: '192.0.2.2' });
  await dl('latest', { ip: '192.0.2.1' });
  assert.deepEqual(await counts(), { total: 3, d30: 3, v1: 2, v11: 1 });
  r = await dl('latest', { ip: '192.0.2.3' });
  assert.equal(r.headers.get('x-vmapp-package-id'), v2.packageId);

  // HEAD and conditional requests are not downloads
  const before = await counts();
  r = await dl('1.0.0', { method: 'HEAD', ip: '192.0.2.50' });
  assert.equal(r.status, 200);
  r = await dl('1.0.0', { ip: '192.0.2.51', headers: { 'If-None-Match': `"${sha256(fs.readFileSync(v1.file))}"` } });
  assert.equal(r.status, 304);
  assert.deepEqual(await counts(), before);

  // after 24 h the same address counts again
  s.clock.advance(23 * HOUR);
  await dl('1.0.0', { ip: '192.0.2.1' });
  assert.equal((await counts()).v1, 2);
  s.clock.advance(2 * HOUR);
  await dl('1.0.0', { ip: '192.0.2.1' });
  assert.equal((await counts()).v1, 3);

  // downloads30d forgets old days, the total does not
  s.clock.advance(31 * 24 * HOUR);
  const c = await counts();
  assert.equal(c.d30, 0);
  assert.equal(c.total, before.total + 1, 'only the download after 25 h was added');

  // no addresses anywhere on disk: neither raw nor in the clear
  await s.reg.flush();
  const logText = storeText(s.storeDir);
  assert.ok(logText.includes('counters.downloads'), 'the counters were written to the log');
  assert.ok(!logText.includes('192.0.2.') && !logText.includes('10.0.0.'));

  assert.equal((await dl('9.9.9')).status, 404);
  assert.equal((await call(s.url, '/api/apps/com.example.none/latest/download')).status, 404);
});

test('ids and versions are validated before the file system is touched', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  assert.equal((await publish(s.url, a.file)).status, 201);
  fs.writeFileSync(path.join(s.dataDir, 'secret.txt'), 'TOP-SECRET');

  const bad = [
    '/api/apps/..%2f..%2fsecret.txt',
    '/api/apps/../../secret.txt',
    '/api/apps/com.example.alpha/..%2f..%2f..%2fsecret.txt/download',
    '/api/apps/com.example.alpha/../../../secret.txt/download',
    '/api/apps/com.example.alpha/1.0.0/../../../../secret.txt',
    '/api/apps/%2e%2e%2f%2e%2e%2fsecret.txt/1.0.0/download',
    '/api/apps/com.example.alpha%2f..%2f..%2fpackages/1.0.0/download',
    '/api/apps/COM.EXAMPLE.ALPHA/1.0.0/download',
    '/api/apps/com.example.alpha/1.0/download',
    '/api/apps/com.example.alpha/latest%00/download',
    '/api/apps/com.example.alpha/1.0.0%00.vmapp/download',
    '/api/apps/com.example.alpha/v1.0.0/download',
    '/api/apps/com%5Cexample.alpha/1.0.0/download',
    '/api/apps/a/1.0.0/download',
    '/api/apps/' + 'a.'.repeat(80) + 'b/1.0.0/download',
    '/api/apps/com.example.alpha/' + '1'.repeat(80) + '.0.0/download',
    '/..%2fdb.json',
    '/%2e%2e/db.json',
    '/db.json',
    '/server.js',
    '/lib/registry.js',
    '/../lib/registry.js',
    '/apps/..%2f..%2fdb.json',
    '/apps/../db.json',
  ];
  for (const p of bad) {
    const r = await raw(s.url, p);
    assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('TOP-SECRET') && !r.text.includes('"schema"'), `${p} leaked data`);
  }
  // sanity: the valid form of the same request works
  assert.equal((await raw(s.url, '/api/apps/com.example.alpha/1.0.0/download')).status, 200);
  assert.equal((await raw(s.url, '/apps/com.example.alpha')).status, 200);
  assert.equal((await raw(s.url, '/apps/not%20an%20id')).status, 404);

  // ids in manifests cannot escape either: hostlib rejects them, so nothing reaches the file system
  const evil = buildPackage(w, 'e', { id: 'com.example.ok2', name: 'Ok2' });
  const bytes = fs.readFileSync(evil.file);
  const i = bytes.indexOf('com.example.ok2');
  Buffer.from('../../../etc/pw').copy(bytes, i); // same length, no longer a valid id (and a broken hash chain)
  const r = await call(s.url, '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(r.status, 400);
  assert.deepEqual(listFiles(s.storeDir).filter((f) => f.startsWith('blobs/')).length, 1, 'only the valid package is stored');
  assert.equal(listFiles(s.storeDir).filter((f) => f.startsWith('events/')).length, 2, 'a publisher and one app version, nothing from the refused upload');
});

test('persistence across restarts, single-process lock, interrupted uploads cleaned up', async (t) => {
  const s = await startRegistry();
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.alpha', name: 'Alpha' });
  const a2 = buildPackage(w, 'a2', { id: 'com.example.alpha', name: 'Alpha', version: '1.1.0' });
  const token = (await publish(s.url, a.file)).json.ownerToken;
  await call(s.url, '/api/apps/com.example.alpha/latest/download', { ip: '10.1.1.1' });

  // a second process (instance) on the same directory is refused
  const second = createRegistry({ dataDir: s.dataDir, port: 0 });
  await assert.rejects(second.start(), /in use by process/);

  // the counter is only scheduled to be written: closing flushes it
  await s.close();
  fs.writeFileSync(path.join(s.dataDir, 'tmp', 'leftover.part'), 'x');
  const s2 = await startRegistry({ dataDir: s.dataDir });
  t.after(async () => {
    await s2.close();
    rmrf(s.dir);
  });
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'tmp')), []);
  const d = (await call(s2.url, '/api/apps/com.example.alpha')).json;
  assert.equal(d.downloads, 1);
  assert.equal(d.versions.length, 1);
  assert.equal((await publish(s2.url, a2.file)).status, 401);
  assert.equal((await publish(s2.url, a2.file, { token })).status, 201, 'the owner token survives a restart');
  // the dedupe map is memory only: a restart forgets it (documented)
  await call(s2.url, '/api/apps/com.example.alpha/1.0.0/download', { ip: '10.1.1.1' });
  assert.equal((await call(s2.url, '/api/apps/com.example.alpha')).json.downloads, 2);
});

test('a corrupt event file stops the server instead of being skipped or overwritten', async (t) => {
  const dir = fixture(t, 'corrupt-');
  const evDir = path.join(dir, 'data', 'store', 'events', '2026', '03', '01');
  fs.mkdirSync(evDir, { recursive: true });
  const bad = path.join(evDir, '000000000001-aaaaaaaaaaaa.json');
  fs.writeFileSync(bad, '{ not json');
  const reg = createRegistry({ dataDir: path.join(dir, 'data'), port: 0 });
  await assert.rejects(reg.start(), /not valid JSON/);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{ not json');
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'server.pid')), 'the lock is released after a failed start');
});

test('concurrent first publishes of one id: exactly one wins', async (t) => {
  const s = await server(t);
  const w = fixture(t, 'pkg-');
  const a = buildPackage(w, 'a', { id: 'com.example.race', name: 'Race' });
  const results = await Promise.all([publish(s.url, a.file), publish(s.url, a.file), publish(s.url, a.file)]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 401, 401]);
  assert.equal((await call(s.url, '/api/stats')).json.apps, 1);
});

test('security headers on pages and API', async (t) => {
  const s = await server(t);
  for (const p of ['/', '/publish', '/api/stats', '/nope']) {
    const r = await call(s.url, p);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, p);
    assert.match(csp, /script-src 'self'/, p);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  const r = await call(s.url, '/api/nothing');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
  assert.match(r.headers.get('content-type'), /application\/json/);
});
