'use strict';
// hostlib/updates.js publish() for a package that is too large for one request: the registry's `init` answers with
// `parts: {size, count}` and the package goes up as PUT <url>?part=N (registry-worker/README.md "Large packages"). Against an
// in-process fake registry that records every request.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const pkg = require('../../hostlib/package');
const { UpdateError, publish, uploadParts } = require('../../hostlib/updates');
const { tmpdir, rmrf, makeProject, write } = require('./helpers');

const MIB = 1024 * 1024;

/** A package of about 12 MiB (incompressible content, so the packed size is what is written). */
function bigPackage(dir) {
  const proj = path.join(dir, 'proj');
  makeProject(proj, {});
  write(path.join(proj, 'ui', 'blob.bin'), crypto.randomBytes(12 * MIB));
  const out = path.join(dir, 'big.vmapp');
  pkg.pack(proj, out);
  return out;
}

/**
 * A registry that offers the parts form. `behave(n, attempt)` can answer a part with a status other than 200.
 * Returns { url, requests, close }.
 */
function fakeRegistry(partSize, behave = () => 200) {
  const requests = [];
  const got = new Map();
  const attempts = new Map();
  let total = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      requests.push(`${req.method} ${u.pathname}${u.search}`);
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && u.pathname === '/api/info') return send(200, { publishModes: ['direct', 'presigned'] });
      if (req.method === 'POST' && u.pathname === '/api/publish/init') {
        total = JSON.parse(body.toString()).size;
        return send(200, { uploadId: 'u1', method: 'PUT', url: `http://127.0.0.1:${server.address().port}/api/uploads/u1`, headers: {}, parts: { size: partSize, count: Math.ceil(total / partSize) } });
      }
      if (req.method === 'PUT' && u.pathname === '/api/uploads/u1') {
        const n = Number(u.searchParams.get('part'));
        const attempt = (attempts.get(n) || 0) + 1;
        attempts.set(n, attempt);
        const status = behave(n, attempt);
        if (status !== 200) return send(status, { error: { code: 'nope', message: 'no' } });
        got.set(n, body);
        return send(200, { uploaded: true });
      }
      if (req.method === 'POST' && u.pathname === '/api/publish/complete') {
        return send(201, { id: 'com.example.notes', version: '1.0.0', packageId: 'p'.repeat(64), url: '/apps/com.example.notes' });
      }
      return send(404, { error: { code: 'not_found', message: 'no' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    got,
    attempts,
    close: () => new Promise((r) => server.close(r)),
  })));
}

test('uploadParts: only a sensible list of parts for this package size is accepted', () => {
  const size = 12 * MIB;
  assert.deepEqual(uploadParts({ size: 5 * MIB, count: 3 }, size), { size: 5 * MIB, count: 3 });
  for (const bad of [
    null, {}, { size: 5 * MIB, count: 2 }, { size: 5 * MIB, count: 4 }, // does not cover the package exactly
    { size: 1000, count: 12 * 1024 }, // parts below the smallest the storage takes
    { size: 200 * MIB, count: 1 }, // one request cannot carry it
    { size: 5 * MIB + 0.5, count: 3 }, { size: '5242880', count: 3 },
  ]) {
    assert.throws(() => uploadParts(bad, size), UpdateError, JSON.stringify(bad));
  }
  assert.throws(() => uploadParts({ size: 5 * MIB, count: 2000 }, 2000 * 5 * MIB), UpdateError, 'an absurd number of requests');
});

test('publish: a package the registry wants in parts is sent as PUT ?part=N, in order, byte for byte', async () => {
  const dir = tmpdir('parts-');
  const reg = await fakeRegistry(5 * MIB);
  try {
    const file = bigPackage(dir);
    const seen = [];
    const r = await publish(file, { registry: reg.url, onProgress: (p) => seen.push(p) });
    assert.equal(r.id, 'com.example.notes');
    const bytes = fs.readFileSync(file);
    const count = Math.ceil(bytes.length / (5 * MIB));
    assert.equal(count, 3);
    assert.deepEqual(reg.requests.filter((q) => q.startsWith('PUT')), [1, 2, 3].map((n) => `PUT /api/uploads/u1?part=${n}`));
    assert.equal(reg.requests[reg.requests.length - 1], 'POST /api/publish/complete', 'complete comes last');
    assert.deepEqual(Buffer.concat([1, 2, 3].map((n) => reg.got.get(n))), bytes);
    assert.equal(reg.got.get(1).length, 5 * MIB);
    assert.equal(reg.got.get(3).length, bytes.length - 10 * MIB, 'the last part is what is left');
    assert.deepEqual(seen.map((p) => p.part), [1, 2, 3]);
    assert.equal(seen[2].sent, bytes.length);
  } finally {
    await reg.close();
    rmrf(dir);
  }
});

test('publish: a part that fails for a moment is sent again; one the registry refuses is not, and nothing is completed', async () => {
  const dir = tmpdir('parts-retry-');
  try {
    const file = bigPackage(dir);
    let reg = await fakeRegistry(5 * MIB, (n, attempt) => (n === 2 && attempt === 1 ? 503 : 200));
    try {
      await publish(file, { registry: reg.url });
      assert.equal(reg.attempts.get(2), 2, 'part 2 was tried twice');
      assert.equal(reg.requests[reg.requests.length - 1], 'POST /api/publish/complete');
    } finally {
      await reg.close();
    }
    reg = await fakeRegistry(5 * MIB, (n) => (n === 2 ? 400 : 200));
    try {
      await assert.rejects(() => publish(file, { registry: reg.url }), (e) => e instanceof UpdateError && /Part 2 of 3/.test(e.message));
      assert.equal(reg.attempts.get(2), 1, 'a refusal (4xx) is final');
      assert.ok(!reg.requests.includes('POST /api/publish/complete'));
    } finally {
      await reg.close();
    }
  } finally {
    rmrf(dir);
  }
});
