// End to end: the registry Worker running locally under `wrangler dev` (workerd, a local Durable Object with SQLite and a local R2),
// driven by the real `vmapp` CLI and real packages. Nothing here touches Cloudflare.
//
//   VMAPP_TEST_PACKAGES=<folder with .vmapp files> node --test test/e2e.test.mjs
//
// The folder defaults to vmapp/out/examples (what tools/pack-examples makes). The tests that need a package skip when it is missing.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, '..');
const VMAPP = path.resolve(WORKER_DIR, '..');
const CLI = path.join(VMAPP, 'tools', 'vmapp');
const PACKAGES = process.env.VMAPP_TEST_PACKAGES || path.join(VMAPP, 'out', 'examples');
const WRANGLER = 'wrangler@4.151.1';
const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmapp-worker-test-'));
const persist = path.join(tmp, 'state');
const home = path.join(tmp, 'home');
let server = null;
let serverLog = '';

const find = (suffix) => {
  if (!fs.existsSync(PACKAGES)) return null;
  const f = fs.readdirSync(PACKAGES).find((n) => n.endsWith(suffix));
  return f ? path.join(PACKAGES, f) : null;
};
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init) => {
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, body, text };
};

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--registry', BASE], { env: { ...process.env, VMAPP_HOME: home }, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function startServer() {
  serverLog = '';
  server = spawn('npx', ['--yes', WRANGLER, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--local-upstream', `127.0.0.1:${PORT}`, '--persist-to', persist, '--show-interactive-dev-session=false'], { cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      if ((await fetch(`${BASE}/api/info`)).ok) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error(`the Worker did not start:\n${serverLog.slice(-3000)}`);
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGINT');
  await new Promise((r) => { s.on('close', r); setTimeout(r, 5000); });
  spawnSync('pkill', ['-f', `--port ${PORT}`]);
  await sleep(500);
}

before(async () => { await startServer(); });
after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const notes = find('02-notes.vmapp');
const todo = find('04-todo-dotnet.vmapp');
const midsize = find('09-ollama.vmapp');
const big = find('06-terminal-gemini.vmapp');
let ownerToken = null;
let notesId = null;

test('an empty registry answers info, stats and the app list', async () => {
  const info = await api('/api/info');
  assert.equal(info.status, 200);
  assert.equal(info.body.name, 'vmapp-registry');
  assert.deepEqual(info.body.publishModes, ['direct', 'presigned']);
  assert.equal(info.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual((await api('/api/stats')).body, { apps: 0, versions: 0, downloads: 0 });
  const list = await api('/api/apps');
  assert.equal(list.body.total, 0);
  const nope = await api('/api/apps/com.example.nope');
  assert.equal(nope.status, 404);
  assert.equal(nope.body.error.code, 'not_found');
  assert.equal((await api('/api/apps?sort=bogus')).status, 400);
  assert.equal((await api('/api/nothing-here')).status, 404);
});

test('publishing a package with the real CLI (init, PUT, complete) and reading it back', { skip: !notes && 'no packages' }, async () => {
  const r = cli(['publish', notes, '--name', 'Test Publisher', '--email', 'test@example.com']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /published .* to /);
  ownerToken = (/owner token: ([0-9a-f]{64})/.exec(r.out) || [])[1];
  assert.ok(ownerToken, `no owner token in:\n${r.out}`);
  const list = await api('/api/apps');
  assert.equal(list.body.total, 1);
  const item = list.body.items[0];
  notesId = item.id;
  assert.equal(item.publisher.level, 'unverified');
  assert.ok(item.name && item.latestVersion && item.permissionsSummary);
  const detail = await api(`/api/apps/${notesId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.manifest && detail.body.permissions && Array.isArray(detail.body.versions));
  assert.equal(detail.body.claimedPublisher !== undefined, true);
  const search = await api('/api/apps?q=notes');
  assert.equal(search.body.total, 1);
  assert.equal((await api('/api/apps?q=zzzzzz')).body.total, 0);
  assert.deepEqual((await api('/api/stats')).body.apps, 1);
});

test('the download is byte-identical, has the verification headers, and supports HEAD and If-None-Match', { skip: !notes && 'no packages' }, async () => {
  const want = sha(notes);
  const v = (await api(`/api/apps/${notesId}/versions`)).body[0];
  assert.equal(v.sha256, want);
  const res = await fetch(`${BASE}/api/apps/${notesId}/latest/download`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-vmapp-sha256'), want);
  assert.equal(res.headers.get('etag'), `"${want}"`);
  assert.equal(createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex'), want);
  const head = await fetch(`${BASE}/api/apps/${notesId}/${v.version}/download`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), fs.statSync(notes).size);
  const cached = await fetch(`${BASE}/api/apps/${notesId}/${v.version}/download`, { headers: { 'if-none-match': `"${want}"` } });
  assert.equal(cached.status, 304);
  assert.equal((await api(`/api/apps/${notesId}/9.9.9/download`)).status, 404);
  assert.equal((await api(`/api/apps/${notesId}/not-a-version/download`)).status, 400);
  assert.equal((await api('/api/stats')).body.downloads, 1, 'repeated downloads from one address count once a day');
});

test('ownership and version rules', { skip: !notes && 'no packages' }, async () => {
  // without a token (the CLI would reuse the one it saved, so go through the API): the id exists, so a token is required
  const bytes = fs.readFileSync(notes);
  const jsonHeaders = { 'content-type': 'application/json' };
  const init = await api('/api/publish/init', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ size: bytes.length, sha256: sha(notes) }) });
  assert.equal(init.status, 200);
  assert.equal((await fetch(init.body.url, { method: 'PUT', body: bytes })).status, 200);
  const noToken = await api('/api/publish/complete', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ uploadId: init.body.uploadId }) });
  assert.equal(noToken.status, 401, noToken.text);
  assert.equal(noToken.body.error.code, 'unauthorized');
  assert.ok(noToken.headers.get('www-authenticate'));
  const wrongTok = cli(['publish', notes, '--token', 'a'.repeat(64)]);
  assert.notEqual(wrongTok.code, 0);
  assert.match(wrongTok.out, /403|unknown owner token|does not own/i, wrongTok.out);
  const same = cli(['publish', notes, '--token', ownerToken]);
  assert.notEqual(same.code, 0);
  assert.match(same.out, /already published|version_exists|409/i, same.out);
});

test('withdraw, resolve and restore', { skip: !notes && 'no packages' }, async () => {
  const v = (await api(`/api/apps/${notesId}/versions`)).body[0].version;
  const auth = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' };
  assert.equal((await api(`/api/apps/${notesId}/${v}/withdraw`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'broken' }) })).status, 200);
  const list = (await api(`/api/apps/${notesId}/versions`)).body;
  assert.equal(list[0].withdrawn.reason, 'broken');
  assert.equal((await api(`/api/apps/${notesId}/latest/download`)).body.error.code, 'all_withdrawn');
  assert.equal((await api(`/api/apps/${notesId}/resolve?choice=latest`)).body.version, null);
  const exact = await fetch(`${BASE}/api/apps/${notesId}/${v}/download`);
  assert.equal(exact.status, 200);
  assert.equal(decodeURIComponent(exact.headers.get('x-vmapp-withdrawn')), 'broken');
  await exact.arrayBuffer();
  assert.equal((await api(`/api/apps/${notesId}/${v}/withdraw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reason":"x"}' })).status, 401);
  assert.equal((await api(`/api/apps/${notesId}/${v}/restore`, { method: 'POST', headers: auth, body: '{}' })).status, 200);
  assert.equal((await api(`/api/apps/${notesId}/resolve?choice=latest`)).body.version, v);
  assert.equal((await api(`/api/apps/${notesId}/resolve?choice=compatible`)).status, 400);
});

test('a direct upload (POST /api/publish) of a second app', { skip: !todo && 'no packages' }, async () => {
  const r = cli(['publish', todo, '--direct', '--name', 'Test Publisher', '--email', 'test@example.com']);
  assert.equal(r.code, 0, r.out);
  assert.equal((await api('/api/apps')).body.total, 2);
});

test('a corrupted package is refused with a precise reason, and nothing is published', { skip: !notes && 'no packages' }, async () => {
  const bytes = Buffer.from(fs.readFileSync(notes));
  bytes[bytes.length - 2048] ^= 0xff; // a byte inside the package, after the manifest
  const init = await api('/api/publish/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) });
  assert.equal(init.status, 200, init.text);
  assert.equal((await fetch(init.body.url, { method: 'PUT', body: bytes })).status, 200);
  const done = await api('/api/publish/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: init.body.uploadId }) });
  assert.equal(done.status, 400, done.text);
  assert.equal(done.body.error.code, 'invalid_package');
  assert.ok(done.body.error.message.length > 10);
  const before = (await api('/api/stats')).body;
  assert.equal(before.apps, 2);
});

test('an upload that does not match what init announced is refused', async () => {
  const bytes = Buffer.from('not a package at all');
  const init = await api('/api/publish/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: bytes.length + 5, sha256: 'a'.repeat(64) }) });
  assert.equal(init.status, 200);
  const short = await fetch(init.body.url, { method: 'PUT', body: bytes });
  assert.equal(short.status, 400);
  assert.equal((await api('/api/publish/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: init.body.uploadId }) })).body.error.code, 'upload_missing');
  assert.equal((await api('/api/publish/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: crypto.randomUUID() }) })).status, 404);
  assert.equal((await api('/api/publish/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: 10, sha256: 'xyz' }) })).status, 400);
});

test('a medium package (tens of MB) publishes and downloads intact', { skip: !midsize && 'no packages' }, async () => {
  const r = cli(['publish', midsize, '--name', 'Test Publisher', '--email', 'test@example.com']);
  assert.equal(r.code, 0, r.out);
  const list = (await api('/api/apps')).body.items.find((i) => i.sizeBytes === fs.statSync(midsize).size);
  assert.ok(list, 'the package is listed');
  const res = await fetch(`${BASE}/api/apps/${list.id}/latest/download`);
  const h = createHash('sha256');
  for await (const c of res.body) h.update(c);
  assert.equal(h.digest('hex'), sha(midsize));
});

test('a package over the proxy limit is refused with a clear message until direct-to-storage uploads exist', { skip: !big && 'no packages' }, async () => {
  const size = fs.statSync(big).size;
  if (size <= 95 * 1024 * 1024) return;
  const init = await api('/api/publish/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size, sha256: sha(big) }) });
  assert.equal(init.status, 413);
  assert.equal(init.body.error.code, 'too_large_for_proxy');
});

test('everything survives a restart of the Worker (the log is replayed from SQLite)', async () => {
  const before = (await api('/api/apps?sort=name')).body;
  await stopServer();
  await startServer();
  const after2 = (await api('/api/apps?sort=name')).body;
  assert.equal(after2.total, before.total);
  assert.deepEqual(after2.items.map((i) => [i.id, i.latestVersion, i.publisher.level]), before.items.map((i) => [i.id, i.latestVersion, i.publisher.level]));
  if (notesId) {
    const res = await fetch(`${BASE}/api/apps/${notesId}/latest/download`);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  }
});
