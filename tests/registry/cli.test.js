'use strict';
// `vmapp publish | search | get` against a live registry (in this process; the CLI runs as a child process).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { tmpdir, rmrf, buildPackage, startRegistry, call } = require('./helpers');

const CLI = path.resolve(__dirname, '..', '..', 'tools', 'vmapp');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

async function world(t) {
  const s = await startRegistry();
  const w = tmpdir('cli-');
  t.after(async () => {
    await s.close();
    rmrf(s.dir);
    rmrf(w);
  });
  const home = path.join(w, 'home');
  const work = path.join(w, 'work');
  fs.mkdirSync(work);
  const env = { VMAPP_HOME: home, VMAPP_REGISTRY: s.url };
  return { s, w, home, work, env };
}

test('publish: saves the owner token (mode 0600) and reuses it for new versions', async (t) => {
  const { s, w, home, env } = await world(t);
  const v1 = buildPackage(w, 'v1', { id: 'com.example.cli', name: 'Cli App', version: '1.0.0' });
  const v2 = buildPackage(w, 'v2', { id: 'com.example.cli', name: 'Cli App', version: '1.1.0' });

  let r = await vmapp(['publish', v1.file, '--name', 'Zoë', '--company', 'Acme', '--email', 'zoe@acme.test', '--url', 'https://acme.test'], { env });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /published com\.example\.cli 1\.0\.0/);
  assert.match(r.out, new RegExp(`package id: ${v1.packageId}`));
  const token = /owner token: ([0-9a-f]{64})/.exec(r.out)[1];
  assert.match(r.out, /SAVE IT NOW/);
  assert.match(r.out, /shown to users as: Unverified publisher/);
  assert.ok(!r.out.includes('zoe@acme.test'));
  const tf = path.join(home, 'publish-tokens.json');
  assert.equal(fs.statSync(tf).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(tf, 'utf8'))[s.url]['com.example.cli'], token);
  const me = await call(s.url, '/api/publisher/me', { token });
  assert.deepEqual(me.json.profile, { name: 'Zoë', company: 'Acme', email: 'zoe@acme.test', url: 'https://acme.test' });

  // same version: refused, with the server's message
  r = await vmapp(['publish', v1.file], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /already published/);

  // a new version reuses the saved token and prints no new one
  r = await vmapp(['publish', v2.file], { env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /published com\.example\.cli 1\.1\.0/);
  assert.doesNotMatch(r.out, /owner token/);

  // another machine (another VMAPP_HOME) has no token: 401 with advice; --token fixes it and is remembered
  const v3 = buildPackage(w, 'v3', { id: 'com.example.cli', name: 'Cli App', version: '1.2.0' });
  const other = { VMAPP_HOME: path.join(w, 'home2'), VMAPP_REGISTRY: s.url };
  r = await vmapp(['publish', v3.file], { env: other });
  assert.equal(r.code, 1);
  assert.match(r.err, /--token/);
  r = await vmapp(['publish', v3.file, '--token', 'f'.repeat(64)], { env: other });
  assert.equal(r.code, 1);
  assert.match(r.err, /does not own/);
  r = await vmapp(['publish', v3.file, '--token', token], { env: other });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w, 'home2', 'publish-tokens.json'), 'utf8'))[s.url]['com.example.cli'], token);

  // the same token publishes a second app id under the same publisher
  const b = buildPackage(w, 'b', { id: 'com.example.second', name: 'Second' });
  r = await vmapp(['publish', b.file, '--token', token], { env });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /owner token:/);
  assert.deepEqual((await call(s.url, '/api/publisher/me', { token })).json.apps.sort(), ['com.example.cli', 'com.example.second']);

  // an invalid package is rejected locally, before any request; an unreachable registry is explained
  const junk = path.join(w, 'junk.vmapp');
  fs.writeFileSync(junk, 'nope');
  r = await vmapp(['publish', junk], { env });
  assert.equal(r.code, 1);
  r = await vmapp(['publish', v1.file, '--registry', 'http://127.0.0.1:9'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot reach the registry/);
  r = await vmapp(['publish', v1.file, '--registry', 'ftp://x'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid registry URL/);
});

test('search', async (t) => {
  const { s, w, env } = await world(t);
  for (const n of ['alpha', 'beta']) {
    const p = buildPackage(w, n, { id: `com.example.${n}`, name: n.toUpperCase(), description: `the ${n} thing` });
    assert.equal((await vmapp(['publish', p.file], { env })).code, 0);
  }
  await call(s.url, '/api/apps/com.example.beta/latest/download', { ip: '10.9.9.9' });

  let r = await vmapp(['search'], { env });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^com\.example\.beta\s+1\.0\.0\s+1 dl\s+BETA \[Unverified publisher\] - the beta thing/);
  assert.match(lines[1], /^com\.example\.alpha/);
  r = await vmapp(['search', '--sort', 'name'], { env });
  assert.match(r.out.split('\n')[0], /^com\.example\.alpha/);
  r = await vmapp(['search', 'alp'], { env });
  assert.equal(r.out.trim().split('\n').length, 1);
  r = await vmapp(['search', 'zzzz'], { env });
  assert.match(r.out, /no apps match "zzzz"/);
  r = await vmapp(['search', 'beta', '--json'], { env });
  assert.equal(JSON.parse(r.out).items[0].id, 'com.example.beta');
  r = await vmapp(['search', '--sort', 'bogus'], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /sort must be one of/);
});

test('get: downloads, verifies, writes the exact bytes, installs on request', async (t) => {
  const { s, w, home, work, env } = await world(t);
  const v1 = buildPackage(w, 'v1', { id: 'com.example.getme', name: 'Get Me', version: '1.0.0' });
  const v2 = buildPackage(w, 'v2', { id: 'com.example.getme', name: 'Get Me', version: '2.0.0' });
  let r = await vmapp(['publish', v1.file], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal((await vmapp(['publish', v2.file], { env })).code, 0);

  // default file name in the current directory; latest version
  r = await vmapp(['get', 'com.example.getme'], { env, cwd: work });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /downloaded com\.example\.getme 2\.0\.0/);
  assert.match(r.out, new RegExp(`package id ${v2.packageId}`));
  const got = path.join(work, 'com.example.getme-2.0.0.vmapp');
  assert.deepEqual(fs.readFileSync(got), fs.readFileSync(v2.file));
  assert.deepEqual(fs.readdirSync(work).filter((f) => f.includes('.part')), []);

  // an existing file is not overwritten without --force
  r = await vmapp(['get', 'com.example.getme'], { env, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists/);
  r = await vmapp(['get', 'com.example.getme', '--force'], { env, cwd: work });
  assert.equal(r.code, 0, r.err);

  // a chosen version and output file
  const out = path.join(work, 'sub', 'old.vmapp');
  r = await vmapp(['get', 'com.example.getme', '--version', '1.0.0', '-o', out], { env });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(v1.file));
  // three downloads from one address: 2.0.0 twice (counted once, de-duplicated) and 1.0.0 once
  const d = (await call(s.url, '/api/apps/com.example.getme')).json;
  assert.equal(d.downloads, 2);
  assert.deepEqual(d.versions.map((v) => [v.version, v.downloads]), [['2.0.0', 1], ['1.0.0', 1]]);

  // unknown app / version
  r = await vmapp(['get', 'com.example.nope'], { env, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /no app "com\.example\.nope"/);
  r = await vmapp(['get', 'com.example.getme', '--version', '9.9.9'], { env, cwd: work });
  assert.equal(r.code, 1);
  r = await vmapp(['get', '../etc/passwd'], { env, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid app id/);
  r = await vmapp(['get', 'com.example.getme', '--version', '../x'], { env, cwd: work });
  assert.equal(r.code, 1);

  // --install: needs the runtime image in the home, then installs and leaves no temporary copy
  const dummy = path.join(w, 'node22.img');
  fs.writeFileSync(dummy, 'not a real runtime image');
  assert.equal((await vmapp(['runtime-install', 'node22', dummy], { env })).code, 0);
  r = await vmapp(['get', 'com.example.getme', '--install'], { env, cwd: work });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /installed com\.example\.getme 2\.0\.0/);
  r = await vmapp(['list'], { env });
  assert.match(r.out, /com\.example\.getme\s+2\.0\.0/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'tmp')), [], 'no temporary download left behind');
});

test('get refuses anything that does not verify, and leaves nothing behind', async (t) => {
  const { s, w, work, env } = await world(t);
  const v1 = buildPackage(w, 'v1', { id: 'com.example.safe', name: 'Safe', version: '1.0.0' });
  assert.equal((await vmapp(['publish', v1.file], { env })).code, 0);
  const stored = s.reg.blobPath(sha256(fs.readFileSync(v1.file))); // the package is a blob named by its SHA-256
  const original = fs.readFileSync(stored);
  const leftovers = () => fs.readdirSync(work);

  // 1. the server's file changed on disk (one byte): the SHA-256 announced at publish time no longer matches
  const tampered = Buffer.from(original);
  tampered[tampered.indexOf('Basic fixture')] ^= 0x20;
  fs.writeFileSync(stored, tampered);
  let r = await vmapp(['get', 'com.example.safe'], { env, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing: .*SHA-256/);
  assert.deepEqual(leftovers(), []);

  // 2. a dishonest server that also fixes the announced SHA-256: the package itself fails verification
  const rec = s.reg.db.getApp('com.example.safe').versions['1.0.0'];
  const honestSha = rec.sha256;
  rec.sha256 = sha256(tampered);
  const forged = s.reg.blobPath(rec.sha256); // blobs are named by hash, so the forged bytes need their own name
  fs.mkdirSync(path.dirname(forged), { recursive: true });
  fs.writeFileSync(forged, tampered);
  r = await vmapp(['get', 'com.example.safe'], { env, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing: the downloaded file is not a valid package: .*hash mismatch/);
  assert.deepEqual(leftovers(), []);

  // 3. a valid file, but the announced package id is a lie
  fs.writeFileSync(stored, original);
  rec.sha256 = honestSha;
  const honestId = rec.packageId;
  rec.packageId = 'a'.repeat(64);
  r = await vmapp(['get', 'com.example.safe', '-o', path.join(work, 'x.vmapp')], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing: the package id of the file/);
  assert.deepEqual(leftovers(), []);
  rec.packageId = honestId;

  // 4. the untouched file is fine again
  r = await vmapp(['get', 'com.example.safe', '-o', path.join(work, 'ok.vmapp')], { env });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readFileSync(path.join(work, 'ok.vmapp')), original);
  fs.rmSync(path.join(work, 'ok.vmapp'));

  // a server that sends no verification headers, or the wrong app, or a damaged body, is refused too
  const other = buildPackage(w, 'other', { id: 'com.example.other', name: 'Other' });
  const otherBytes = fs.readFileSync(other.file);
  const mode = { v: 'noheaders' };
  const fake = http.createServer((req, res) => {
    const body = mode.v === 'wrongapp' ? otherBytes : original;
    const h = { 'Content-Type': 'application/x-vmapp' };
    if (mode.v !== 'noheaders') {
      h['X-Vmapp-Sha256'] = sha256(body);
      h['X-Vmapp-Package-Id'] = mode.v === 'wrongapp' ? other.packageId : v1.packageId;
    }
    res.writeHead(200, h);
    res.end(mode.v === 'truncated' ? body.subarray(0, 100) : body);
  });
  await new Promise((r2) => fake.listen(0, '127.0.0.1', r2));
  t.after(() => new Promise((r2) => { fake.closeAllConnections(); fake.close(r2); }));
  const fenv = { VMAPP_HOME: env.VMAPP_HOME, VMAPP_REGISTRY: `http://127.0.0.1:${fake.address().port}` };
  r = await vmapp(['get', 'com.example.safe'], { env: fenv, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not send X-Vmapp-Sha256/);
  mode.v = 'wrongapp';
  r = await vmapp(['get', 'com.example.safe'], { env: fenv, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.err, /asked for com\.example\.safe but the package is com\.example\.other/);
  mode.v = 'truncated';
  r = await vmapp(['get', 'com.example.safe'], { env: fenv, cwd: work });
  assert.equal(r.code, 1);
  assert.deepEqual(leftovers(), []);
});
