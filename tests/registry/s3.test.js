'use strict';
// The s3 backend: the registry on an S3-compatible bucket. Every test here runs against an in-process fake S3
// (fakes3.js, always) and, when VMAPP_TEST_MINIO=1, against a real MinIO in Docker (minio.js, pinned by digest).
// What is covered: write-once objects, listing in pages, presigned PUT (15 minutes, bound to the size), publish through
// POST /api/publish/init + /complete, the 302 download and both clients verifying against the registry's headers, a
// restart that rebuilds from the bucket, the single-writer lease, admin commands on a bucket, and failures.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { S3Client, S3Store, S3Error } = require('../../registry/lib/s3');
const { configFromEnv } = require('../../registry/lib/storage');
const { blobKey } = require('../../registry/lib/store');
const { readTar } = require('../../registry/lib/tar');
const { createRegistry } = require('../../registry/lib/registry');
const adminCli = require('../../registry/admin');
const { publish: publishLib, Updates, storageTarget } = require('../../hostlib/updates');
const { FakeS3 } = require('./fakes3');
const { startMinio } = require('./minio');
const { tmpdir, rmrf, buildPackage, startRegistry, call, publish, WORK } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { leaseTtlMs: 2000, leaseRenewMs: 300, leaseSettleMs: 50 }; // the lease with short times, so tests are quick

// ------------------------------------------------------------------------------------------------ backends
let minio = null;
let minioStarting = null;
const BACKENDS = [{
  name: 'fake S3',
  async fresh(t) {
    const fake = await new FakeS3({ pageSize: 3 }).start();
    t.after(() => fake.stop());
    const cfg = fake.config({ retryDelayMs: 10 });
    return { cfg, fake, client: new S3Client(cfg) };
  },
}];
if (process.env.VMAPP_TEST_MINIO) {
  BACKENDS.push({
    name: 'MinIO',
    async fresh() {
      if (!minioStarting) minioStarting = startMinio(WORK).then((m) => (minio = m));
      const m = await minioStarting;
      const bucket = 'vmapp-' + crypto.randomBytes(6).toString('hex');
      const cfg = { type: 's3', bucket, endpoint: m.endpoint, region: m.region, accessKeyId: m.accessKeyId, secretAccessKey: m.secretAccessKey, pathStyle: true };
      const client = new S3Client(cfg);
      await client.createBucket();
      return { cfg, fake: null, client };
    },
  });
  after(() => {
    if (minio) minio.stop();
  });
}

function fixture(t, prefix) {
  const dir = tmpdir(prefix);
  t.after(() => rmrf(dir));
  return dir;
}

const keysOf = async (client, prefix) => {
  const out = [];
  for await (const o of client.listObjects(prefix)) out.push(o.key);
  return out;
};

const envFor = (cfg, extra = {}) => Object.assign({
  REGISTRY_STORAGE: 's3', S3_BUCKET: cfg.bucket, S3_ENDPOINT: cfg.endpoint, S3_REGION: cfg.region, S3_ACCESS_KEY_ID: cfg.accessKeyId, S3_SECRET_ACCESS_KEY: cfg.secretAccessKey, S3_PATH_STYLE: '1',
}, extra);

/** The registry in `start`'s s3 form; the caller closes it. */
async function s3Registry(t, w, extra = {}) {
  const s = await startRegistry(Object.assign({ storage: w.cfg }, FAST, extra));
  t.after(async () => {
    await s.close().catch(() => {});
    rmrf(s.dir);
  });
  return s;
}

/** Plays "https://dl.<domain>": serves the bucket's blobs/ and nothing else (the Cloudflare rule HOSTING.md asks for). */
async function publicProxy(t, client, { everything = false } = {}) {
  const st = { hits: [], mode: 'ok', tamper: null };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    st.hits.push(u.pathname);
    if (!everything && !u.pathname.startsWith('/blobs/sha256/')) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (st.mode === '503') {
      res.writeHead(503);
      return res.end('storage down');
    }
    if (st.mode === 'redirect') {
      res.writeHead(302, { Location: '/somewhere/else' });
      return res.end();
    }
    const body = await client.getObject(u.pathname.slice(1));
    if (!body) {
      res.writeHead(404);
      return res.end('no');
    }
    const out = st.tamper ? st.tamper(Buffer.from(body)) : body;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': out.length });
    return res.end(out);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  st.base = `http://127.0.0.1:${srv.address().port}`;
  return st;
}

function vmapp(args, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const e = Object.assign({}, process.env, env);
    delete e.VMAPP_PUBLISH_TOKEN;
    const p = spawn(process.execPath, [CLI, ...args], { env: e, cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const runAdmin = async (args, env) => {
  const out = [];
  const code = await adminCli.run(args, env, (l) => out.push(l));
  return { code, out: out.join('\n') };
};

// ------------------------------------------------------------------------------------------------ pure client tests (fake only)
test('S3 client: URLs for path-style and virtual-hosted buckets, keys encoded once', () => {
  const c = new S3Client({ bucket: 'bkt', endpoint: 'https://acct.r2.example.test', accessKeyId: 'A', secretAccessKey: 'S', region: 'auto' });
  assert.equal(c.urlFor('events/2026/a b.json'), 'https://acct.r2.example.test/bkt/events/2026/a%20b.json');
  assert.equal(c.urlFor('', [['list-type', '2'], ['prefix', 'a/b']]), 'https://acct.r2.example.test/bkt?list-type=2&prefix=a%2Fb');
  const v = new S3Client({ bucket: 'bkt', endpoint: 'https://s3.example.test', pathStyle: false, accessKeyId: 'A', secretAccessKey: 'S' });
  assert.equal(v.urlFor('blobs/x'), 'https://bkt.s3.example.test/blobs/x');
  const aws = new S3Client({ bucket: 'bkt', region: 'eu-west-1', accessKeyId: 'A', secretAccessKey: 'S' });
  assert.equal(aws.urlFor('k'), 'https://bkt.s3.eu-west-1.amazonaws.com/k');
  assert.equal(c.pathStyle, true);
  assert.equal(aws.pathStyle, false);
  assert.throws(() => new S3Client({ bucket: 'b' }), /access key/);
  assert.throws(() => new S3Client({ accessKeyId: 'a', secretAccessKey: 'b' }), /bucket/);
  assert.throws(() => new S3Client({ bucket: 'b', endpoint: 'ftp://x', accessKeyId: 'a', secretAccessKey: 'b' }), /https:\/\/ or http:\/\//);
  // the secret does not leak through JSON, inspect or error messages
  assert.ok(!JSON.stringify(c).includes('"S"') && !JSON.stringify(c).includes('secret'));
  assert.ok(!require('util').inspect(c).includes("'S'"));
});

test('check-storage names the guarantee a misbehaving object store breaks', async (t) => {
  for (const [broken, wanted] of [[{ ifNoneMatch: true }, /REPLACED an existing object/], [{ copyIfMatch: true }, /copy went through with a wrong ETag/]]) {
    const fake = await new FakeS3({ broken }).start();
    t.after(() => fake.stop());
    const r = await runAdmin(['check-storage'], envFor(fake.config(), { REGISTRY_DATA: tmpdir('probe-') }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, wanted);
    assert.match(r.out, /NOT OK/);
  }
  // and with S3_CONDITIONAL_PUT=0 the first one is handled by checking before writing
  const fake = await new FakeS3({ broken: { ifNoneMatch: true } }).start();
  t.after(() => fake.stop());
  const r = await runAdmin(['check-storage'], envFor(fake.config(), { REGISTRY_DATA: tmpdir('probe-'), S3_CONDITIONAL_PUT: '0' }));
  assert.equal(r.code, 0, r.out);
});

test('configuration from the environment: the s3 settings, and what is refused', () => {
  const env = { REGISTRY_STORAGE: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'https://x.test', S3_ACCESS_KEY_ID: 'AK', S3_SECRET_ACCESS_KEY: 'SK', S3_REGION: 'auto', PUBLIC_DOWNLOAD_BASE: 'https://dl.example.com/' };
  const c = configFromEnv(env);
  assert.equal(c.storage.type, 's3');
  assert.equal(c.storage.bucket, 'b');
  assert.equal(c.storage.region, 'auto');
  assert.equal(c.storage.pathStyle, undefined, 'unset: the client decides (on when an endpoint is given)');
  assert.equal(c.storage.conditionalPut, true);
  assert.equal(c.publicDownloadBase, 'https://dl.example.com');
  assert.equal(configFromEnv(Object.assign({}, env, { S3_PATH_STYLE: '0', S3_CONDITIONAL_PUT: 'false' })).storage.pathStyle, false);
  assert.equal(configFromEnv(Object.assign({}, env, { S3_CONDITIONAL_PUT: '0' })).storage.conditionalPut, false);
  assert.deepEqual(configFromEnv({}).storage, { type: 'local' });
  assert.throws(() => configFromEnv({ REGISTRY_STORAGE: 's3' }), /needs S3_BUCKET/);
  assert.throws(() => configFromEnv({ REGISTRY_STORAGE: 's3', S3_BUCKET: 'b' }), /needs S3_ACCESS_KEY_ID/);
  assert.throws(() => configFromEnv({ REGISTRY_STORAGE: 'ftp' }), /local" or "s3"/);
  assert.throws(() => configFromEnv({ PUBLIC_DOWNLOAD_BASE: 'ftp://x' }), /https/);
  assert.throws(() => configFromEnv({ PUBLIC_DOWNLOAD_BASE: 'https://x.test/?a=1' }), /query/);
  assert.equal(configFromEnv({ PUBLIC_DOWNLOAD_BASE: '' }).publicDownloadBase, null);
});

test('storage targets: a redirect or upload address must be http(s), without a password, and never downgrade https', () => {
  const reg = 'https://registry.example.test';
  assert.equal(storageTarget(reg, 'https://dl.example.test/blobs/x'), 'https://dl.example.test/blobs/x');
  assert.equal(storageTarget(reg, '/blobs/x'), 'https://registry.example.test/blobs/x');
  assert.throws(() => storageTarget(reg, 'http://dl.example.test/x'), /plain http/);
  assert.throws(() => storageTarget(reg, 'ftp://dl.example.test/x'), /neither https nor http/);
  assert.throws(() => storageTarget(reg, 'https://user:pw@dl.example.test/x'), /password/);
  assert.throws(() => storageTarget(reg, 'javascript:alert(1)'), /neither/);
  assert.equal(storageTarget('http://127.0.0.1:8790', 'http://127.0.0.1:9000/blobs/x'), 'http://127.0.0.1:9000/blobs/x', 'a local test registry may use http storage');
});

test('requests are retried when the store answers with a temporary error, and an error never shows the secret', async (t) => {
  const fake = await new FakeS3().start();
  t.after(() => fake.stop());
  const client = new S3Client(fake.config({ retryDelayMs: 5 }));
  const store = new S3Store(client);
  fake.inject((q) => q.method === 'PUT' && q.key === 'events/a.json', 503, 'SlowDown', 2);
  assert.deepEqual(await store.put('events/a.json', Buffer.from('x')), { created: true });
  assert.equal(fake.requests.filter((q) => q.method === 'PUT' && q.key === 'events/a.json').length, 3);
  // a permanent error is reported after the retries, and carries neither secret nor access key
  fake.inject((q) => q.method === 'GET' && q.key === 'events/a.json', 500, 'InternalError', 100);
  await assert.rejects(store.get('events/a.json'), (e) => {
    assert.ok(e instanceof S3Error);
    assert.equal(e.status, 500);
    assert.ok(!e.message.includes(fake.secretAccessKey) && !e.message.includes(fake.accessKeyId));
    return true;
  });
  // wrong secret: SignatureDoesNotMatch, no retry, and the message is clean
  const bad = new S3Client(Object.assign(fake.config({ retryDelayMs: 5 }), { secretAccessKey: 'not-the-secret' }));
  await assert.rejects(bad.checkAccess(), (e) => e.code === 'SignatureDoesNotMatch' && !e.message.includes('not-the-secret'));
  // unreachable store
  const dead = new S3Client(Object.assign(fake.config({ retryDelayMs: 5, retries: 1 }), { endpoint: 'http://127.0.0.1:1' }));
  await assert.rejects(dead.checkAccess(), /cannot reach the object store/);
  // without conditional PUT support the client checks first, still never replacing
  const plain = new S3Store(new S3Client(fake.config({ conditionalPut: false })));
  assert.deepEqual(await plain.put('events/b.json', Buffer.from('1')), { created: true });
  assert.deepEqual(await plain.put('events/b.json', Buffer.from('2')), { created: false });
  assert.equal((await plain.get('events/b.json')).toString(), '1');
});

/** A tiny stand-in for a registry, to see what the clients do with answers a real one rarely gives. */
async function stubRegistry(t, handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks) });
      handler(req, res, hits);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return { url: `http://127.0.0.1:${srv.address().port}`, hits };
}

test('publishing clients fall back to the direct upload when the registry has no /api/info (an older registry)', async (t) => {
  const dir = fixture(t, 'old-');
  const reg = await stubRegistry(t, (req, res) => {
    if (req.url === '/api/info') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"code":"not_found","message":"no such API endpoint"}}');
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: 'com.example.old', version: '1.0.0', packageId: 'a'.repeat(64), url: '/apps/com.example.old' }));
  });
  const v1 = buildPackage(dir, 'v1', { id: 'com.example.old', name: 'Old' });
  const res = await publishLib(v1.file, { registry: reg.url });
  assert.equal(res.id, 'com.example.old');
  const r = await vmapp(['publish', v1.file, '--registry', reg.url], { env: { VMAPP_HOME: path.join(dir, 'home') } });
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(reg.hits.filter((h) => h.method === 'POST').map((h) => h.url), ['/api/publish', '/api/publish'], 'no init, no complete');
  // --direct does not even ask
  const before = reg.hits.length;
  await publishLib(v1.file, { registry: reg.url, direct: true });
  assert.deepEqual(reg.hits.slice(before).map((h) => h.url), ['/api/publish']);
});

test('a refused upload to the storage address is reported by both clients, and complete is never called', async (t) => {
  const dir = fixture(t, 'refused-');
  const storage = await stubRegistry(t, (req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/xml' });
    res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
  });
  const reg = await stubRegistry(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/info') return res.end(JSON.stringify({ publishModes: ['direct', 'presigned'] }));
    return res.end(JSON.stringify({ uploadId: 'u-1', method: 'PUT', url: `${storage.url}/staging/u-1.vmapp?X-Amz-Signature=x`, headers: {}, expiresAt: 'x', size: 1 }));
  });
  const v1 = buildPackage(dir, 'v1', { id: 'com.example.ref', name: 'Ref' });
  await assert.rejects(publishLib(v1.file, { registry: reg.url }), (e) => e.code === 'upload_failed' && /HTTP 403/.test(e.message));
  const r = await vmapp(['publish', v1.file, '--registry', reg.url], { env: { VMAPP_HOME: path.join(dir, 'home') } });
  assert.equal(r.code, 1);
  assert.match(r.err, /publish failed: the upload to the registry's storage at .* answered HTTP 403/);
  assert.ok(!reg.hits.some((h) => h.url === '/api/publish/complete'));
  assert.equal(storage.hits.length, 2, 'both clients tried the PUT once');
  assert.deepEqual(storage.hits[0].body, fs.readFileSync(v1.file), 'the file itself was sent');
});

test('an https registry that points an upload or a download at plain http is refused by the clients', async (t) => {
  // storageTarget is what both clients use; the stubs here are http, so the rule is tested at its source
  assert.throws(() => storageTarget('https://registry.example.test', 'http://127.0.0.1:9000/x'), /plain http/);
  const dir = fixture(t, 'dg-');
  const reg = await stubRegistry(t, (req, res) => {
    // a registry on http redirecting to another origin: allowed, but the answer must carry both checksums
    res.writeHead(302, { Location: 'http://127.0.0.1:1/blobs/x' });
    res.end();
  });
  const up = new Updates({ home: path.join(dir, 'h') });
  await assert.rejects(up.fetchAndVerify('com.example.nohdr', '1.0.0', { registry: reg.url }), /did not send X-Vmapp-Sha256/);
  const r = await vmapp(['get', 'com.example.nohdr', '-o', path.join(dir, 'x.vmapp')], { env: { VMAPP_HOME: path.join(dir, 'home'), VMAPP_REGISTRY: reg.url } });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not send X-Vmapp-Sha256/);
});

// ------------------------------------------------------------------------------------------------ the suite, per backend
for (const b of BACKENDS) {
  const n = b.name;

  test(`[${n}] object store: write-once, listing in pages, copy only if unchanged, deletes only blobs and staging, presigned PUT bound to the size`, async (t) => {
    const w = await b.fresh(t);
    const store = new S3Store(w.client);
    await store.init();
    const key = 'events/2026/03/01/000000000001-aaaaaaaaaaaa.json';
    assert.deepEqual(await store.put(key, Buffer.from('one')), { created: true });
    assert.deepEqual(await store.put(key, Buffer.from('two')), { created: false }, 'an object is never replaced');
    assert.equal((await store.get(key)).toString(), 'one');
    assert.equal((await store.head(key)).size, 3);
    assert.equal(await store.head('events/none.json'), null);
    assert.equal(await store.get('events/none.json'), null);
    assert.equal(await store.getStream('events/none.json'), null);

    // listing: more keys than a page
    const keys = [];
    for (let i = 2; i <= 9; i++) {
      const k = `events/2026/03/0${i}/00000000000${i}-bbbbbbbbbbbb.json`;
      keys.push(k);
      await store.put(k, Buffer.from(`e${i}`));
    }
    await store.put('snapshots/000000000009.json', Buffer.from('s'));
    const all = [];
    for await (const o of store.list('events/')) all.push(o.key);
    assert.deepEqual(all, [key, ...keys]);
    const after = [];
    for await (const o of store.list('events/', { startAfter: 'events/2026/03/05/' })) after.push(o.key);
    assert.deepEqual(after, keys.filter((k) => k > 'events/2026/03/05/'));
    const o1 = (await (async () => { const r = []; for await (const o of store.list('snapshots/')) r.push(o); return r; })())[0];
    assert.equal(o1.size, 1);
    assert.ok(o1.mtimeMs > 0);

    // a file stored with a payload hash that the store checks
    const body = crypto.randomBytes(5000);
    const dir = fixture(t, 'put-');
    const f = path.join(dir, 'blob');
    fs.writeFileSync(f, body);
    const bk = blobKey(sha256(body));
    assert.deepEqual(await store.putFile(bk, f, { sha256: sha256(body), size: body.length }), { created: true });
    assert.deepEqual(await store.putFile(bk, f, { sha256: sha256(body), size: body.length }), { created: false });
    const st = await store.getStream(bk);
    const got = [];
    for await (const c of st.stream) got.push(c);
    assert.deepEqual(Buffer.concat(got), body);
    assert.equal(st.size, body.length);
    assert.ok(st.etag);
    if (b.fake) {
      // the fake checks x-amz-content-sha256 against the bytes, like S3: a wrong declared hash is refused
      await assert.rejects(store.putFile(blobKey('b'.repeat(64)), f, { sha256: 'b'.repeat(64), size: body.length }), (e) => e.code === 'XAmzContentSHA256Mismatch');
    }

    // server-side copy: only while the source is the one that was checked
    await store.put('staging/x.vmapp', Buffer.from('staged bytes'));
    const etag = (await store.head('staging/x.vmapp')).etag;
    await assert.rejects(store.copy('staging/x.vmapp', 'blobs/sha256/aa/y.vmapp', { ifMatch: '"0000"' }), (e) => e instanceof S3Error && e.status === 412);
    assert.equal(await store.head('blobs/sha256/aa/y.vmapp'), null, 'nothing was copied');
    await store.copy('staging/x.vmapp', 'blobs/sha256/aa/y.vmapp', { ifMatch: etag });
    assert.equal((await store.get('blobs/sha256/aa/y.vmapp')).toString(), 'staged bytes');
    await assert.rejects(store.copy('staging/none.vmapp', 'blobs/sha256/aa/z.vmapp'), (e) => e.status === 404);

    // deletes: blobs and staging only
    await assert.rejects(store.delete(key), /only blobs\/ and staging\//);
    await assert.rejects(store.delete('snapshots/000000000009.json'), /only blobs\/ and staging\//);
    await assert.rejects(store.putMutable(key, Buffer.from('x')), /only lease\//);
    assert.equal(await store.delete('staging/x.vmapp'), true);
    assert.equal(await store.head('staging/x.vmapp'), null);
    assert.equal((await store.get(key)).toString(), 'one');

    // presigned PUT: 15 minutes, exactly the announced size
    const data = Buffer.from('presigned upload body');
    const ps = store.presignPut('staging/p.vmapp', { size: data.length });
    assert.equal(ps.method, 'PUT');
    assert.deepEqual(ps.headers, { 'Content-Length': String(data.length) });
    assert.match(ps.url, /X-Amz-Expires=900/);
    assert.match(ps.url, /X-Amz-SignedHeaders=content-length%3Bhost/);
    assert.ok(Math.abs(ps.expiresAt - (Date.now() + 900000)) < 5000);
    assert.ok(!ps.url.includes(w.cfg.secretAccessKey));
    let r = await fetch(ps.url, { method: 'PUT', body: Buffer.concat([data, Buffer.from('!')]) });
    assert.equal(r.status, 403, 'one byte too many');
    r = await fetch(ps.url, { method: 'PUT', body: data.subarray(0, 5) });
    assert.equal(r.status, 403, 'too few');
    assert.equal(await store.head('staging/p.vmapp'), null);
    r = await fetch(ps.url, { method: 'PUT', body: data });
    assert.equal(r.status, 200);
    assert.equal((await store.get('staging/p.vmapp')).toString(), data.toString());
    // another key with the same signature is refused
    r = await fetch(ps.url.replace('staging/p.vmapp', 'staging/q.vmapp'), { method: 'PUT', body: data });
    assert.equal(r.status, 403);
    // and a URL signed 20 minutes ago has expired
    const old = new S3Client(Object.assign({}, w.cfg, { now: () => Date.now() - 20 * 60 * 1000 }));
    const stale = old.presignPut('staging/s.vmapp', { size: data.length });
    r = await fetch(stale.url, { method: 'PUT', body: data });
    assert.equal(r.status, 403);
    assert.equal(await store.head('staging/s.vmapp'), null);
  });

  test(`[${n}] check-storage: the probe passes on a store that behaves, next to a running server`, async (t) => {
    const w = await b.fresh(t);
    const s = await s3Registry(t, w);
    const env = envFor(w.cfg, { REGISTRY_DATA: path.join(s.dataDir, 'probe') });
    const r = await runAdmin(['check-storage'], env);
    assert.equal(r.code, 0, r.out);
    assert.equal((r.out.match(/^PASS /gm) || []).length, 4);
    assert.match(r.out, /OK: the object store behaves as the registry needs/);
    assert.equal((await keysOf(w.client, 'staging/probe-')).length, 3);
    assert.equal((await call(s.url, '/api/stats')).status, 200, 'the server was not disturbed');
  });

  test(`[${n}] publish through a presigned upload; downloads redirect to the public address; CLI and loader client verify what they get`, async (t) => {
    const w = await b.fresh(t);
    const proxy = await publicProxy(t, w.client);
    const logs = [];
    const s = await s3Registry(t, w, { publicDownloadBase: proxy.base, log: (m) => logs.push(m) });
    const dir = fixture(t, 'pub-');
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const env = { VMAPP_HOME: path.join(dir, 'home'), VMAPP_REGISTRY: s.url };
    const info = (await call(s.url, '/api/info')).json;
    assert.deepEqual(info.publishModes, ['direct', 'presigned']);
    assert.equal(info.downloads, 'redirect');

    const v1 = buildPackage(dir, 'v1', { id: 'com.example.s3app', name: 'S3 App', version: '1.0.0' });
    const v2 = buildPackage(dir, 'v2', { id: 'com.example.s3app', name: 'S3 App', version: '1.1.0' });
    const v3 = buildPackage(dir, 'v3', { id: 'com.example.s3app', name: 'S3 App', version: '1.2.0' });
    let r = await vmapp(['publish', v1.file, '--name', 'Zed', '--email', 'zed@acme.test'], { env });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /published com\.example\.s3app 1\.0\.0/);
    const token = /owner token: ([0-9a-f]{64})/.exec(r.out)[1];
    assert.ok(logs.some((l) => /POST \/api\/publish\/init 200/.test(l)), 'the CLI asked for an upload address');
    assert.ok(logs.some((l) => /POST \/api\/publish\/complete 201/.test(l)));
    assert.ok(!logs.some((l) => /POST \/api\/publish 201/.test(l)), 'the package did not pass through the registry');
    const sha1 = sha256(fs.readFileSync(v1.file));
    assert.equal((await keysOf(w.client, 'blobs/')).join(), blobKey(sha1), 'copied from staging to its content-addressed name');
    assert.equal((await keysOf(w.client, 'staging/')).length, 1, 'the staged upload is left for the lifecycle rule');
    assert.equal((await keysOf(w.client, 'events/')).length, 2);
    if (w.fake) {
      const put = w.fake.requests.find((q) => q.method === 'PUT' && q.key.startsWith('staging/'));
      assert.ok(put.query['X-Amz-Signature'], 'the package was PUT with a presigned URL');
      assert.equal(put.query['X-Amz-Expires'], '900');
      assert.match(put.query['X-Amz-SignedHeaders'], /content-length/, 'the size is part of what was signed');
    }

    // the loader's client publishes through the same path
    const res = await publishLib(v2.file, { registry: s.url, token });
    assert.equal(res.version, '1.1.0');
    assert.equal(res.ownerToken, null);
    assert.equal((await keysOf(w.client, 'staging/')).length, 2);
    assert.ok(!logs.some((l) => /POST \/api\/publish 201/.test(l)));
    // direct still works on request (and on an unknown registry)
    const res3 = await publishLib(v3.file, { registry: s.url, token, direct: true });
    assert.equal(res3.version, '1.2.0');
    assert.ok(logs.some((l) => /POST \/api\/publish 201/.test(l)));

    // the download is a 302 with the registry's headers
    const raw = await fetch(`${s.url}/api/apps/com.example.s3app/1.0.0/download`, { redirect: 'manual' });
    assert.equal(raw.status, 302);
    assert.equal(raw.headers.get('location'), `${proxy.base}/${blobKey(sha1)}`);
    assert.equal(raw.headers.get('x-vmapp-sha256'), sha1);
    assert.equal(raw.headers.get('x-vmapp-package-id'), v1.packageId);

    // vmapp get follows it and verifies against the registry's headers
    const out = path.join(work, 'got.vmapp');
    r = await vmapp(['get', 'com.example.s3app', '--version', '1.0.0', '-o', out], { env });
    assert.equal(r.code, 0, r.err + r.out);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(v1.file));
    assert.ok(proxy.hits.includes(`/${blobKey(sha1)}`), 'the bytes came from the public address');
    assert.match(r.out, new RegExp(`sha256 ${sha1}`));

    // so does the loader's client
    const up = new Updates({ home: path.join(dir, 'loader-home') });
    const p = await up.fetchAndVerify('com.example.s3app', '1.0.0', { registry: s.url });
    assert.equal(p.sha256, sha1);
    assert.equal(p.packageId, v1.packageId);
    assert.deepEqual(fs.readFileSync(p.file), fs.readFileSync(v1.file));
    up.discard(p.file);
    const latest = await up.fetchAndVerify('com.example.s3app', 'latest', { registry: s.url });
    assert.equal(latest.version, '1.2.0');
    up.discard(latest.file);

    // a bucket that serves other bytes is not trusted: both clients refuse, and nothing is left behind
    proxy.tamper = (buf) => {
      buf[buf.length - 1] ^= 1;
      return buf;
    };
    fs.rmSync(out);
    r = await vmapp(['get', 'com.example.s3app', '--version', '1.0.0', '-o', out], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /refusing: .*SHA-256/);
    assert.deepEqual(fs.readdirSync(work), []);
    await assert.rejects(up.fetchAndVerify('com.example.s3app', '1.0.0', { registry: s.url }), /SHA-256/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'loader-home', 'tmp')), []);
    // a bucket that redirects again, or is down
    proxy.tamper = null;
    proxy.mode = 'redirect';
    r = await vmapp(['get', 'com.example.s3app', '--version', '1.0.0', '-o', out], { env });
    assert.equal(r.code, 1);
    assert.deepEqual(fs.readdirSync(work), []);
    await assert.rejects(up.fetchAndVerify('com.example.s3app', '1.0.0', { registry: s.url }), /storage/);
    proxy.mode = '503';
    r = await vmapp(['get', 'com.example.s3app', '--version', '1.0.0', '-o', out], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, /package storage .* HTTP 503/);
    proxy.mode = 'ok';
    r = await vmapp(['get', 'com.example.s3app', '--version', '1.0.0', '-o', out], { env });
    assert.equal(r.code, 0);

    // downloads were counted at the redirect, once per address
    await s.reg.flush();
    assert.ok((await call(s.url, '/api/apps/com.example.s3app')).json.downloads >= 1);
    // withdrawn: the redirect carries the reason; the CLI warns and still verifies
    assert.equal((await call(s.url, '/api/apps/com.example.s3app/1.0.0/withdraw', { method: 'POST', token, json: { reason: 'bad one' } })).status, 200);
    fs.rmSync(out);
    r = await vmapp(['get', 'com.example.s3app', '--version', '1.0.0', '-o', out], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /was withdrawn by its publisher: bad one/);
  });

  test(`[${n}] presigned publish: bad requests, mismatches, an invalid package, and an object changed after it was checked`, async (t) => {
    const w = await b.fresh(t);
    const s = await s3Registry(t, w, { maxPackageBytes: 8 * 1024 * 1024, publishPerHour: 1000 });
    const dir = fixture(t, 'neg-');
    const v1 = buildPackage(dir, 'v1', { id: 'com.example.neg', name: 'Neg', version: '1.0.0' });
    const bytes = fs.readFileSync(v1.file);
    const sha = sha256(bytes);
    const init = (body, token) => call(s.url, '/api/publish/init', { method: 'POST', json: body, token });
    const complete = (uploadId, extra = {}) => call(s.url, '/api/publish/complete', Object.assign({ method: 'POST', json: { uploadId } }, extra));
    const put = (up, body) => fetch(up.url, { method: 'PUT', body });
    const eventCount = async () => (await keysOf(w.client, 'events/')).length;

    assert.equal((await init({})).status, 400);
    assert.equal((await init({ size: 0, sha256: sha })).status, 400);
    assert.equal((await init({ size: 1.5, sha256: sha })).status, 400);
    assert.equal((await init({ size: 10, sha256: 'xyz' })).status, 400);
    assert.equal((await init({ size: 9 * 1024 * 1024, sha256: sha })).status, 413);
    assert.equal((await call(s.url, '/api/publish/init', { method: 'POST', headers: { Authorization: 'Bearer zz' }, json: { size: 10, sha256: sha } })).status, 401);
    assert.equal((await init({ size: 10, sha256: sha }, 'f'.repeat(64))).status, 403);
    assert.equal((await call(s.url, '/api/publish/init')).status, 405);
    assert.equal((await complete('00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await complete(undefined)).status, 404);

    let up = (await init({ size: bytes.length, sha256: sha })).json;
    assert.equal(up.method, 'PUT');
    assert.equal(up.size, bytes.length);
    assert.deepEqual(up.headers, { 'Content-Length': String(bytes.length) });
    assert.ok(Math.abs(Date.parse(up.expiresAt) - (Date.now() + 15 * 60 * 1000)) < 60 * 1000, 'valid for fifteen minutes');
    assert.match(up.url, /X-Amz-Expires=900/);
    assert.ok(up.url.includes(`/staging/${up.uploadId}.vmapp`));

    // nothing uploaded yet
    let r = await complete(up.uploadId);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'upload_missing');
    // the wrong size is refused by the store itself (the size is part of the signature)
    assert.equal((await put(up, Buffer.concat([bytes, Buffer.from('x')]))).status, 403);
    // right size, wrong content: the registry hashes what it fetches, and it is not what was announced
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 1] ^= 1;
    assert.equal((await put(up, flipped)).status, 200);
    r = await complete(up.uploadId);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'upload_mismatch');
    assert.equal((await keysOf(w.client, 'blobs/')).length, 0);
    assert.equal(await eventCount(), 0);

    // right hash and size but not a package at all
    const junk = crypto.randomBytes(4000);
    up = (await init({ size: junk.length, sha256: sha256(junk) })).json;
    assert.equal((await put(up, junk)).status, 200);
    r = await complete(up.uploadId);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'invalid_package');
    assert.equal((await keysOf(w.client, 'blobs/')).length, 0, 'no blob for a package that does not verify');
    assert.equal(await eventCount(), 0);

    // the staged object is replaced after the registry read it: the copy is conditional on the ETag, so nothing gets in
    up = (await init({ size: bytes.length, sha256: sha })).json;
    assert.equal((await put(up, bytes)).status, 200);
    const orig = s.reg.store.getStream.bind(s.reg.store);
    s.reg.store.getStream = async (key) => {
      const o = await orig(key);
      if (key.startsWith('staging/')) {
        const evil = Buffer.from(bytes);
        evil[10] ^= 0xff;
        await w.client.request({ method: 'PUT', key, headers: { 'Content-Type': 'application/octet-stream' }, body: evil });
      }
      return o;
    };
    r = await complete(up.uploadId);
    s.reg.store.getStream = orig;
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'upload_changed');
    assert.equal((await keysOf(w.client, 'blobs/')).length, 0, 'the swapped bytes did not reach the content-addressed name');
    assert.equal(await eventCount(), 0);

    // the same upload id can still be completed when it is untouched: upload again
    up = (await init({ size: bytes.length, sha256: sha })).json;
    assert.equal((await put(up, bytes)).status, 200);
    r = await complete(up.uploadId, { headers: { 'X-Vmapp-Publisher': JSON.stringify({ name: 'Zed' }) } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.id, 'com.example.neg');
    assert.equal(r.json.sha256, sha);
    assert.match(r.json.ownerToken, /^[0-9a-f]{64}$/);
    assert.equal((await keysOf(w.client, 'blobs/')).join(), blobKey(sha));
    // a finished upload id is gone
    assert.equal((await complete(up.uploadId)).status, 404);
    // the same version again: 409 version_exists, after the upload (the registry cannot know the id before it reads the package)
    up = (await init({ size: bytes.length, sha256: sha })).json;
    assert.equal((await put(up, bytes)).status, 200);
    r = await complete(up.uploadId, { token: undefined });
    assert.equal(r.status, 401, 'the id exists and no token was sent');
  });

  test(`[${n}] presigned publish is rate limited like a direct one`, async (t) => {
    const w = await b.fresh(t);
    const s = await s3Registry(t, w, { publishPerHour: 2 });
    const body = { size: 10, sha256: 'a'.repeat(64) };
    const init = () => call(s.url, '/api/publish/init', { method: 'POST', json: body });
    assert.equal((await init()).status, 200);
    assert.equal((await init()).status, 200);
    const r = await init();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });

  test(`[${n}] direct publish and a streamed download work on the bucket too (small packages, no public address)`, async (t) => {
    const w = await b.fresh(t);
    const s = await s3Registry(t, w);
    const dir = fixture(t, 'direct-');
    const v1 = buildPackage(dir, 'v1', { id: 'com.example.direct', name: 'Direct' });
    const r = await publish(s.url, v1.file);
    assert.equal(r.status, 201, r.text);
    const sha = sha256(fs.readFileSync(v1.file));
    assert.deepEqual(await keysOf(w.client, 'blobs/'), [blobKey(sha)]);
    assert.deepEqual(await keysOf(w.client, 'staging/'), [], 'a direct publish stages nothing');
    const dl = await fetch(`${s.url}/api/apps/com.example.direct/1.0.0/download`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('x-vmapp-sha256'), sha);
    assert.equal(dl.headers.get('content-type'), 'application/x-vmapp');
    assert.equal(dl.headers.get('content-length'), String(fs.statSync(v1.file).size));
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), fs.readFileSync(v1.file));
    assert.equal((await fetch(`${s.url}/api/apps/com.example.direct/1.0.0/download`, { method: 'HEAD' })).status, 200);
    assert.equal((await call(s.url, '/api/info')).json.downloads, 'direct');
    // a package that vanished from the bucket is a clear 500, not a hang
    await w.client.request({ method: 'DELETE', key: blobKey(sha), okStatuses: [200, 204] });
    assert.equal((await call(s.url, '/api/apps/com.example.direct/1.0.0/download')).status, 500);
  });

  test(`[${n}] a new server rebuilds everything from the bucket (with and without snapshots); the local disk is only a cache`, async (t) => {
    const w = await b.fresh(t);
    const dir = fixture(t, 'rebuild-');
    const state = async (url) => JSON.stringify([
      (await call(url, '/api/apps?limit=100')).json, (await call(url, '/api/apps/com.example.rb')).json,
      (await call(url, '/api/apps/com.example.rb/versions')).json, (await call(url, '/api/stats')).json,
    ]);
    const s1 = await s3Registry(t, w, { snapshotEvery: 4, mailer: { send: async () => {} } });
    let token = null;
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
      const p = buildPackage(dir, `p${v}`, { id: 'com.example.rb', name: 'Rb', version: v });
      const r = await publish(s1.url, p.file, { token, profile: token ? undefined : { name: 'Q', email: 'q@acme.test' } });
      assert.equal(r.status, 201, r.text);
      token = token || r.json.ownerToken;
    }
    for (const ip of ['10.0.0.1', '10.0.0.2']) await call(s1.url, '/api/apps/com.example.rb/latest/download', { ip });
    assert.equal((await call(s1.url, '/api/apps/com.example.rb/1.1.0/withdraw', { method: 'POST', token, json: { reason: 'r' } })).status, 200);
    await call(s1.url, '/api/publisher/profile', { method: 'POST', token, json: { name: 'Q2', email: 'q@acme.test', company: 'Acme' } });
    const before = await state(s1.url);
    await s1.close();
    assert.ok((await keysOf(w.client, 'snapshots/')).length >= 1);
    assert.equal(JSON.parse(before)[3].downloads, 2);

    const s2 = await s3Registry(t, w, { snapshotEvery: 4 }); // a fresh data dir: nothing local to rebuild from
    assert.equal(await state(s2.url), before);
    assert.equal(s2.reg.events.snapshotSeq > 0, true, 'started from a snapshot');
    await s2.close();

    // no snapshots at all: the whole log is listed (several pages) and replayed
    for (const k of await keysOf(w.client, 'snapshots/')) await w.client.request({ method: 'DELETE', key: k, okStatuses: [200, 204] });
    const s3 = await s3Registry(t, w);
    assert.equal(s3.reg.events.snapshotSeq, 0);
    assert.equal(await state(s3.url), before);
    assert.equal((await publish(s3.url, buildPackage(dir, 'p14', { id: 'com.example.rb', name: 'Rb', version: '1.4.0' }).file, { token })).status, 201);
    await s3.close();
    // everything above was only reads of the cache: the data dirs held nothing but scratch
    const left = fs.readdirSync(path.join(s3.dataDir)).sort();
    assert.ok(!left.includes('db.json') && !left.includes('packages'));
  });

  test(`[${n}] admin commands on a bucket: verify, snapshot, export, gc, hide (the writer ones refuse while a server runs)`, async (t) => {
    const w = await b.fresh(t);
    const dir = fixture(t, 'adm-');
    const s = await s3Registry(t, w);
    const v1 = buildPackage(dir, 'v1', { id: 'com.example.adm', name: 'Adm', version: '1.0.0' });
    const v2 = buildPackage(dir, 'v2', { id: 'com.example.adm', name: 'Adm', version: '1.1.0' });
    const token = (await publish(s.url, v1.file)).json.ownerToken;
    assert.equal((await publish(s.url, v2.file, { token })).status, 201);
    const env = envFor(w.cfg, { REGISTRY_DATA: path.join(dir, 'admin-data') });

    // read-only commands next to the running server
    let r = await runAdmin(['verify'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /2 packages referenced \(2 re-hashed/);
    r = await runAdmin(['status'], env);
    assert.equal(r.code, 0);
    assert.match(r.out, /events:\s+3/);
    // the writer commands cannot run: the server holds the lease
    assert.equal((await runAdmin(['hide', 'com.example.adm', '--reason', 'x'], env)).code, 2);
    assert.equal((await runAdmin(['gc', '--confirm', '--min-age-hours', '0'], env)).code, 2);
    await s.close();

    // plant garbage: an orphan blob and a staged upload nobody completed
    const orphan = Buffer.from('orphan package bytes');
    await w.client.putObject(blobKey(sha256(orphan)), orphan);
    await w.client.putObject('staging/22222222-2222-2222-2222-222222222222.vmapp', Buffer.from('half an upload'));
    r = await runAdmin(['verify'], env);
    assert.equal(r.code, 0);
    assert.match(r.out, /1 unreferenced, 3 staging|1 unreferenced, 1 staging|1 unreferenced, 2 staging/);
    r = await runAdmin(['gc', '--min-age-hours', '0'], env);
    assert.equal(r.code, 2, 'no --confirm: nothing is deleted');
    assert.ok((await keysOf(w.client, 'staging/')).includes('staging/22222222-2222-2222-2222-222222222222.vmapp'));
    const eventsBefore = (await keysOf(w.client, 'events/')).length;
    r = await runAdmin(['gc', '--confirm', '--min-age-hours', '0'], env);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(await keysOf(w.client, 'staging/'), []);
    assert.equal((await keysOf(w.client, 'blobs/')).length, 2, 'the two referenced packages stay');
    assert.equal((await keysOf(w.client, 'events/')).length, eventsBefore + 1, 'one audit event');
    // hide / unhide
    assert.equal((await runAdmin(['hide', 'com.example.adm', '--reason', 'takedown'], env)).code, 0);
    const s2 = await s3Registry(t, w);
    assert.equal((await call(s2.url, '/api/apps/com.example.adm')).status, 404);
    await s2.close();
    assert.equal((await runAdmin(['unhide', 'com.example.adm'], env)).code, 0);
    // snapshot and export
    r = await runAdmin(['snapshot'], env);
    assert.equal(r.code, 0, r.out);
    const out = path.join(dir, 'bucket-backup.tar');
    r = await runAdmin(['export', '--out', out], env);
    assert.equal(r.code, 0, r.out);
    const entries = readTar(fs.readFileSync(out)).map((e) => e.path).filter((p) => p !== 'EXPORT.json').sort();
    assert.deepEqual(entries, [...(await keysOf(w.client, 'events/')), ...(await keysOf(w.client, 'snapshots/'))].sort());
    assert.equal((await runAdmin(['verify'], env)).code, 0);
    // a bucket-side loss is found
    await w.client.request({ method: 'DELETE', key: blobKey(sha256(fs.readFileSync(v1.file))), okStatuses: [200, 204] });
    r = await runAdmin(['verify'], env);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL: .*is missing/);
  });

  test(`[${n}] one writer: a second server on the bucket is refused, a dead one's lease is taken over, a lost lease stops writing`, async (t) => {
    const w = await b.fresh(t);
    const dir = fixture(t, 'lease-');
    const faults = [];
    const a = await s3Registry(t, w, { onFault: (e) => faults.push(e.message) });
    const v1 = buildPackage(dir, 'v1', { id: 'com.example.lease', name: 'Lease', version: '1.0.0' });
    const v2 = buildPackage(dir, 'v2', { id: 'com.example.lease', name: 'Lease', version: '1.1.0' });
    const token = (await publish(a.url, v1.file)).json.ownerToken;

    // a second server, another data dir, same bucket
    await assert.rejects(startRegistry(Object.assign({ storage: w.cfg }, FAST)), /another registry process is writing to this bucket/);
    assert.equal((await publish(a.url, v2.file, { token })).status, 201, 'the first server is unaffected');
    const lease = JSON.parse((await w.client.getObject('lease/writer.json')).toString());
    assert.ok(lease.id && lease.host && lease.pid && lease.renewedAt && !lease.releasedAt);
    await a.close();
    assert.ok(JSON.parse((await w.client.getObject('lease/writer.json')).toString()).releasedAt, 'a clean shutdown releases the lease');

    // after a clean shutdown the next server starts at once
    const t0 = Date.now();
    const c = await s3Registry(t, w);
    assert.ok(Date.now() - t0 < 1500);
    await c.close();

    // a lease that nobody renews (the server was killed): taken over once it has not moved for its ttl
    await w.client.putMutable('lease/writer.json', Buffer.from(JSON.stringify({ id: 'dead-writer', host: 'ghost', pid: 1, startedAt: new Date().toISOString(), renewedAt: new Date().toISOString(), ttlMs: 1000 })));
    const t1 = Date.now();
    const d = await s3Registry(t, w, { onFault: (e) => faults.push(e.message) });
    const waited = Date.now() - t1;
    assert.ok(waited >= 900 && waited < 6000, `waited ${waited} ms`);

    // the lease is taken away from a running server: it stops writing, keeps reading, and reports it
    await w.client.putMutable('lease/writer.json', Buffer.from(JSON.stringify({ id: 'usurper', host: 'elsewhere', pid: 2, startedAt: new Date().toISOString(), renewedAt: new Date().toISOString(), ttlMs: 60000 })));
    for (let i = 0; i < 40 && !d.reg.events.faulted; i++) await sleep(100);
    assert.ok(d.reg.events.faulted, 'noticed within a renewal period');
    assert.ok(faults.some((m) => /elsewhere/.test(m)));
    const v3 = buildPackage(dir, 'v3', { id: 'com.example.lease', name: 'Lease', version: '1.2.0' });
    const r = await publish(d.url, v3.file, { token });
    assert.equal(r.status, 503);
    assert.equal((await call(d.url, '/api/apps/com.example.lease')).status, 200, 'reads continue');
    assert.equal((await keysOf(w.client, 'events/')).length, 3, 'and no event was written');
  });

  test(`[${n}] the public address must not expose more than blobs/: a warning if it does`, async (t) => {
    const w = await b.fresh(t);
    const open = await publicProxy(t, w.client, { everything: true });
    const closed = await publicProxy(t, w.client);
    const logsOpen = [];
    const logsClosed = [];
    const s1 = await s3Registry(t, w, { publicDownloadBase: open.base, log: (m) => logsOpen.push(m) });
    for (let i = 0; i < 40 && !logsOpen.some((l) => /WARNING/.test(l)); i++) await sleep(50);
    assert.ok(logsOpen.some((l) => /WARNING: .*publicly readable/.test(l)), logsOpen.join('\n'));
    await s1.close();
    const s2 = await s3Registry(t, w, { publicDownloadBase: closed.base, log: (m) => logsClosed.push(m) });
    for (let i = 0; i < 20 && !closed.hits.length; i++) await sleep(50);
    await sleep(100);
    assert.ok(closed.hits.includes('/lease/writer.json'), 'it looked');
    assert.ok(!logsClosed.some((l) => /WARNING/.test(l)));
    await s2.close();
  });

  test(`[${n}] the server process: configured by environment variables only; clean shutdown; no secret in any output`, async (t) => {
    const w = await b.fresh(t);
    const proxy = await publicProxy(t, w.client);
    const dir = fixture(t, 'proc-');
    const base = Object.assign({}, process.env, envFor(w.cfg, {
      REGISTRY_DATA: path.join(dir, 'data'), REGISTRY_PORT: '0', REGISTRY_HOST: '127.0.0.1', PUBLIC_DOWNLOAD_BASE: proxy.base, REGISTRY_LEASE_TTL_SEC: '2', REGISTRY_LEASE_RENEW_SEC: '0.3',
    }));
    const run = (extra = {}, args = []) => {
      const p = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'registry', 'server.js'), ...args], { env: Object.assign({}, base, extra) });
      const st = { out: '', err: '', code: null, p };
      p.stdout.on('data', (d) => (st.out += d));
      p.stderr.on('data', (d) => (st.err += d));
      st.closed = new Promise((r) => p.on('close', (c) => { st.code = c; r(c); }));
      t.after(() => { if (st.code === null) p.kill('SIGKILL'); });
      return st;
    };
    // a missing setting is a clear refusal that names the variable and nothing secret
    const bad = run({ S3_BUCKET: '' });
    assert.equal(await bad.closed, 2);
    assert.match(bad.err, /needs S3_BUCKET/);

    const srv = run();
    let url = null;
    for (let i = 0; i < 100 && !url; i++) {
      const m = /listening on (http:\/\/[^ ]+)/.exec(srv.out);
      if (m) url = m[1];
      else await sleep(100);
    }
    assert.ok(url, `the server did not start: ${srv.out} ${srv.err}`);
    assert.deepEqual((await call(url, '/api/stats')).json, { apps: 0, versions: 0, downloads: 0 });
    const home = path.join(dir, 'home');
    const v1 = buildPackage(dir, 'v1', { id: 'com.example.proc', name: 'Proc' });
    let r = await vmapp(['publish', v1.file], { env: { VMAPP_HOME: home, VMAPP_REGISTRY: url } });
    assert.equal(r.code, 0, r.err + r.out);
    const out = path.join(dir, 'got.vmapp');
    r = await vmapp(['get', 'com.example.proc', '-o', out], { env: { VMAPP_HOME: home, VMAPP_REGISTRY: url } });
    assert.equal(r.code, 0, r.err + r.out);
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(v1.file));
    // a second process on the bucket is refused
    const second = run({ REGISTRY_DATA: path.join(dir, 'data2') });
    assert.equal(await second.closed, 1);
    assert.match(second.err, /another registry process is writing to this bucket/);
    srv.p.kill('SIGTERM');
    assert.equal(await srv.closed, 0, srv.err);
    assert.ok(JSON.parse((await w.client.getObject('lease/writer.json')).toString()).releasedAt, 'released on SIGTERM');
    for (const o of [srv, bad, second]) {
      assert.ok(!(o.out + o.err).includes(w.cfg.secretAccessKey), 'the secret is in no output');
    }
    // flags still win over the environment, and secrets have no flag
    const help = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'registry', 'server.js'), '--help'], { env: process.env });
    let helpText = '';
    help.stdout.on('data', (d) => (helpText += d));
    await new Promise((r2) => help.on('close', r2));
    assert.ok(helpText.includes('S3_SECRET_ACCESS_KEY'));
    assert.ok(!/--s3-secret|--secret/.test(helpText));
  });
}
