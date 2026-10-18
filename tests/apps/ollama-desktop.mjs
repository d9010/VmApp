// Ollama (Desktop) (dev.vmapp.ollama.desktop, runtime node22-gpu on the normal backend = CPU), in a real VM: Ollama's own Go backend
// (vmapp-ui: app/ui + app/store + app/server) supervising the `ollama` built from the v0.35.0 source WITH the proxy patch, and the
// streamed HTTP bridge (sdk/web/vmapp-fetch.js here as the "page", sdk/node/http-bridge.js in the core) in between. The "page" is this
// script: it builds the very fetch the window uses, on the fake window manager's invoke/send/emit, and calls the app exactly as the
// React app does (`/api/v1/...`) and as an Ollama client does (`/ollama/api/...`: Ollama's own API, unchanged).
//
// OLLAMA_DESKTOP_PHASE:
//   main     (default) a fresh app: the server, the UI backend's endpoints, a model pulled through Ollama's OWN downloader
//            (POST /api/pull: progress, cancel, resume, SHA-256 checked by Ollama and again here), the traffic (only the manifest's hosts),
//            Ollama's API (tags, show, ps, chat and generate streamed, the OpenAI-compatible stream, copy, delete), the UI's chat endpoint
//            (streamed events, attachments, and the download events when the model is missing), the CLI against the same server,
//            settings that restart the server, chats stored in /data
//   persist  a new VM, the same /data: the chats, the settings and the model are still there, and the model chats without a download
// Environment (run-all.sh sets it): APPS_FIX (scratch for the state between phases), OLLAMA_CACHE (host cache of pulled models),
//   OLLAMA_ONLINE=0 (registry.ollama.ai cannot be reached: a model missing from the cache skips the test), OLLAMA_COM_ONLINE=0 (ollama.com
//   cannot be reached: the account checks are skipped), OLLAMA_DESKTOP_RESULTS (where to write the measurements as JSON).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ok, requireEnv, sleep, waitFor } from './lib.mjs';

const require = createRequire(import.meta.url);
const { createFetch } = require('../../sdk/web/vmapp-fetch.js');

const PHASE = process.env.OLLAMA_DESKTOP_PHASE || 'main';
const ONLINE = process.env.OLLAMA_ONLINE !== '0';
const COM_ONLINE = process.env.OLLAMA_COM_ONLINE !== '0';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const APP_DIR = fileURLToPath(new URL('../../apps/ollama-desktop/', import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'vmapp.json'), 'utf8'));
const PINS = fs.readFileSync(path.join(APP_DIR, 'pins.env'), 'utf8');
const PINNED_VERSION = /^OLLAMA_VERSION=(\S+)$/m.exec(PINS)[1];
const HOSTS_ALLOWED = new Set(MANIFEST.permissions.network.map((n) => n.host));
const REGISTRY = 'registry.ollama.ai';
const STORAGE = [...HOSTS_ALLOWED].find((h) => h.endsWith('.r2.cloudflarestorage.com'));
const LOCATION = { href: `vmapp-ui://${MANIFEST.id}/index.html`, protocol: 'vmapp-ui:', host: MANIFEST.id };
const MiB = 1024 * 1024;

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * MiB })
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

function modelFiles(modelsDir, name) {
  const [repo, tag] = name.split(':');
  const parts = repo.includes('/') ? repo.split('/') : ['library', repo];
  const manifestRel = path.join('manifests', REGISTRY, ...parts, tag);
  const manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, manifestRel), 'utf8'));
  const digests = [manifest.config, ...manifest.layers].map((l) => l.digest);
  return { manifestRel, manifest, blobRels: [...new Set(digests)].map((d) => path.join('blobs', `sha256-${d.slice(7)}`)) };
}

function copyModel(fromDir, toDir, name) {
  const { manifestRel, blobRels } = modelFiles(fromDir, name);
  for (const rel of [...blobRels, manifestRel]) {
    fs.mkdirSync(path.dirname(path.join(toDir, rel)), { recursive: true });
    fs.copyFileSync(path.join(fromDir, rel), path.join(toDir, rel));
  }
}

export default async function ({ session, wm, store }) {
  const win = 1;
  const dataDir = store.dataDir(session.appId);
  const modelsDir = path.join(dataDir, '.ollama', 'models');
  const stateFile = path.join(requireEnv('APPS_FIX'), 'ollama-desktop-state.json');
  const cacheRoot = requireEnv('OLLAMA_CACHE');
  const cacheDir = path.join(cacheRoot, MODEL.replace(/[^A-Za-z0-9.]+/g, '-'));
  const results = { phase: PHASE, model: MODEL, notes: [] };

  await wm.waitForWindows(1, 60000);
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  assert.equal(wm.windows.get(win).params.title, 'Ollama');
  ok('window created: index.html, title "Ollama"');

  const net = [];
  session.on('traffic', (e) => {
    if (e.kind === 'net') net.push(e);
  });

  // ---- the page: the window's own fetch, on the fake window manager ---------------------------------------------------------
  const listeners = new Map();
  wm.events.on('emit', (w, channel, args) => {
    if (w !== win) return;
    for (const fn of listeners.get(channel) || []) fn(...args);
  });
  const vmapp = {
    invoke: (channel, ...args) => wm.invoke(win, channel, ...args),
    send: (channel, ...args) => wm.send(win, channel, ...args),
    on: (channel, fn) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
      return () => {};
    },
  };
  const page = createFetch({
    vmapp,
    location: LOCATION,
    routes: [
      { prefix: '/api/', channel: 'fetch' },
      { prefix: '/ollama/', channel: 'raw' },
    ],
  });
  const fetchP = page.fetch;
  const json = async (url, init) => {
    const r = await fetchP(url, init);
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text), headers: r.headers };
    } catch {
      return { status: r.status, text, headers: r.headers };
    }
  };
  const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** Reads a streamed answer line by line: [{at, obj}] with the arrival time of each line. */
  async function* lines(response, signal) {
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) yield { at: performance.now(), line };
        }
      }
      if (buf.trim()) yield { at: performance.now(), line: buf.trim() };
    } finally {
      reader.releaseLock?.();
    }
  }
  const objects = async (response) => {
    const out = [];
    for await (const { at, line } of lines(response)) out.push({ at, obj: JSON.parse(line) });
    return out;
  };

  // ---- the backend and the server come up ---------------------------------------------------------------------------------------
  const version = await waitFor(
    async () => {
      try {
        const r = await json('/api/version');
        return r.status === 200 && r.body.version ? r.body.version : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 120000, intervalMs: 300, what: 'the backend and ollama serve to answer /api/version (through the bridge, the Go proxy and the server)' },
  );
  assert.equal(version, PINNED_VERSION, 'the running server is the pinned version');
  const raw = await json('/ollama/api/version');
  assert.equal(raw.body.version, PINNED_VERSION, "Ollama's own API answers at /ollama/api/version");
  ok(`ollama ${version} answers through the UI backend (/api/version) and directly (/ollama/api/version)`);

  const diag = await wm.invoke(win, 'ollama:diag');
  assert.equal(diag.backendPort, 11501);
  const gpuRun = PHASE === 'gpu';
  assert.equal(diag.gpu.eligible, gpuRun, gpuRun ? `the Vulkan device and library are there: ${JSON.stringify(diag.gpu)}` : 'no Vulkan device on the normal backend');
  for (const want of ['OLLAMA_HOST:http://127.0.0.1:11434', 'OLLAMA_NO_CLOUD:false', `OLLAMA_VULKAN:${gpuRun}`, 'HTTPS_PROXY:http://127.0.0.1:3128', 'Listening on 127.0.0.1:11434']) {
    assert.ok(diag.serverLog.includes(want), `the server log shows ${want}\n${diag.serverLog.split('\n').slice(0, 30).join('\n')}`);
  }
  ok(`server environment (from its own log): loopback only, cloud not disabled, Vulkan ${gpuRun ? 'ON (the Venus device and Ollama\'s Vulkan library are there)' : 'off'}, the proxy inherited`);
  const cliVersion = await wm.invoke(win, 'ollama:cli', { args: ['--version'] });
  assert.equal(cliVersion.code, 0);
  assert.match(cliVersion.stdout + cliVersion.stderr, new RegExp(`ollama version is ${PINNED_VERSION.replace(/\./g, '\\.')}`));
  ok(`the CLI in the VM: ${cliVersion.stdout.trim() || cliVersion.stderr.trim()}`);

  if (PHASE === 'persist') return persistPhase();
  if (gpuRun) return gpuPhase();

  // ---- the UI backend's own endpoints -----------------------------------------------------------------------------------------
  const settings0 = await json('/api/v1/settings');
  assert.equal(settings0.status, 200);
  assert.equal(settings0.body.settings.Models, '/data/.ollama/models', 'the default model location is under the app data');
  assert.equal((await json('/api/v1/chats')).body.chatInfos.length, 0, 'a fresh app has no chats');
  assert.deepEqual((await json('/api/v1/cloud')).body, { disabled: false, source: 'none' });
  const compute = await waitFor(async () => {
    const r = await json('/api/v1/inference-compute');
    return r.status === 200 && r.body.inferenceComputes && r.body.inferenceComputes.length ? r.body : null;
  }, { timeoutMs: 30000, what: 'the inference compute list' });
  assert.ok(compute.inferenceComputes.every((c) => c.library === 'cpu'), JSON.stringify(compute));
  ok(`UI backend: settings (model location ${settings0.body.settings.Models}), no chats, cloud on, inference compute ${compute.inferenceComputes.map((c) => c.library).join(',')}`);

  // a request without the token cannot be made: the page cannot set a cookie; the core sets it. A forged one is dropped by the bridge.
  const forged = await json('/api/v1/chats', { headers: { cookie: 'token=forged' } });
  assert.equal(forged.status, 200, 'the core replaces the page-supplied cookie with the real token');
  // what the bridge refuses
  await assert.rejects(fetchP('/ollama/api/create', { method: 'POST', body: '{}' }), /not available here/);
  await assert.rejects(fetchP('/ollama/api/push', { method: 'POST', body: '{}' }), /not available here/);
  await assert.rejects(fetchP('/ollama/api/blobs/sha256:abc', { method: 'POST', body: '' }), /not available here/);
  ok('the raw API bridge refuses create, push and blob uploads; a forged cookie is replaced by the core');

  // ---- get the model: Ollama's own /api/pull through the allowlist proxy ----------------------------------------------------------
  const cachedOk = fs.existsSync(cacheDir) && (() => {
    try {
      const { manifestRel, blobRels } = modelFiles(cacheDir, MODEL);
      return fs.existsSync(path.join(cacheDir, manifestRel)) && blobRels.every((r) => fs.existsSync(path.join(cacheDir, r)));
    } catch {
      return false;
    }
  })();
  let pulledForReal = false;
  const pullBodies = [];
  if (ONLINE) {
    const t0 = Date.now();
    // 1. start the pull, read progress, cancel (abort) after ~40 MiB of the big layer
    const ac = new AbortController();
    const r1 = await fetchP('/ollama/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL }), signal: ac.signal });
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('content-type') || '', /ndjson|json/);
    const seen1 = [];
    let status = [];
    let kept = 0;
    try {
      for await (const { at, line } of lines(r1)) {
        const o = JSON.parse(line);
        seen1.push({ at, o });
        if (o.error) throw new Error(`the pull failed: ${o.error}`);
        if (status[status.length - 1] !== o.status && !o.digest) status.push(o.status);
        if (o.completed > 40 * MiB && o.total > 100 * MiB) {
          kept = o.completed;
          ac.abort();
          break;
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    assert.ok(kept > 0, `the pull reached 40 MiB (status lines: ${status.join(' | ')})`);
    assert.ok(seen1.some((x) => x.o.status === 'pulling manifest'), 'progress starts with "pulling manifest"');
    const progressLines = seen1.filter((x) => x.o.total && x.o.digest);
    assert.ok(progressLines.length >= 5, `progress arrives as a stream (${progressLines.length} lines)`);
    assert.ok(progressLines[progressLines.length - 1].at - progressLines[0].at > 100, 'progress lines arrive over time, not in one piece');
    ok(`POST /api/pull streams Ollama's own progress through the bridge: ${progressLines.length} lines, ${Math.round(kept / MiB)} MiB of ${Math.round(progressLines[0].o.total / MiB)} MiB, then the request was aborted`);
    // the server stops downloading; the partial blob stays on disk
    await sleep(1500);
    const blobs = fs.readdirSync(path.join(modelsDir, 'blobs'));
    const partial = blobs.filter((f) => f.includes('partial'));
    assert.ok(partial.length >= 1, `Ollama keeps a partial blob after the cancel: ${blobs.join(', ')}`);
    // (the partial file itself is preallocated to the blob's full size; Ollama's progress is in its part-state files)
    assert.equal((await json('/ollama/api/tags')).body.models.length, 0, 'a cancelled pull installs nothing');
    ok(`after the cancel Ollama keeps ${partial.length} partial blob file(s) and lists no model`);

    // 2. pull again: Ollama resumes, finishes, verifies the SHA-256 digests itself
    const r2 = await fetchP('/ollama/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL }) });
    const events2 = await objects(r2);
    pullBodies.push(...events2.map((e) => e.obj));
    const error2 = events2.find((e) => e.obj.error);
    assert.ok(!error2, `the second pull failed: ${error2 && error2.obj.error}`);
    const statuses = events2.map((e) => e.obj.status);
    assert.equal(statuses[statuses.length - 1], 'success', `the pull ends with success: ${statuses.slice(-4).join(' | ')}`);
    assert.ok(statuses.includes('verifying sha256 digest'), "Ollama's own verification step ran");
    assert.ok(statuses.includes('writing manifest'));
    const bigLines = events2.filter((e) => e.obj.total > 100 * MiB && typeof e.obj.completed === 'number');
    const firstCompleted = bigLines[0].obj.completed;
    assert.ok(firstCompleted >= kept * 0.9 && firstCompleted > 5 * MiB, `the pull resumed from ${Math.round(firstCompleted / MiB)} MiB (it had stopped at ${Math.round(kept / MiB)} MiB)`);
    ok(`resumed from ${Math.round(firstCompleted / MiB)} MiB, finished, verified by Ollama ("${statuses.slice(-3).join('" -> "')}"), ${((Date.now() - t0) / 1000).toFixed(0)} s in all`);
    pulledForReal = true;

    // 3. the store on disk, recomputed here on the host
    const { manifestRel, manifest, blobRels } = modelFiles(modelsDir, MODEL);
    for (const l of [manifest.config, ...manifest.layers]) {
      const f = path.join(modelsDir, 'blobs', `sha256-${l.digest.slice(7)}`);
      assert.equal(fs.statSync(f).size, l.size, `size of ${l.digest}`);
      assert.equal(await sha256File(f), l.digest.slice(7), `sha256 of ${f}`);
    }
    assert.deepEqual(fs.readdirSync(path.join(modelsDir, 'blobs')).filter((f) => f.includes('partial')), [], 'no partial blob is left');
    ok(`the store holds ${blobRels.length} blobs, each recomputed on the host and equal to its digest, and ${manifestRel}`);
    if (!cachedOk) {
      copyModel(modelsDir, cacheDir, MODEL);
      console.log(`  (cached ${MODEL} in ${cacheDir} for runs without internet)`);
    }

    // 4. the network: only the manifest's hosts; the model bytes came from exactly the registry and its storage
    // (a connection is reported when it closes: the aborted first pull's connections are, the resumed pull's keep-alive ones are not yet)
    await waitFor(() => net.filter((n) => n.host === STORAGE).reduce((s, n) => s + n.bytesDown, 0) > 30 * MiB, { timeoutMs: 20000, what: 'the storage connections to be reported' });
    const allowedHosts = [...new Set(net.filter((n) => n.allowed).map((n) => n.host))].sort();
    assert.ok(allowedHosts.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${allowedHosts.join(', ')}`);
    const carriers = [...new Set(net.filter((n) => n.allowed && n.bytesDown > 1 * MiB).map((n) => n.host))];
    assert.deepEqual(carriers, [STORAGE], 'the model bytes came from the storage host only');
    assert.ok(net.filter((n) => n.allowed).every((n) => n.port === 443));
    results.pullHosts = allowedHosts;
    ok(`pull traffic so far, from the platform's events: ${allowedHosts.join(', ')} (port 443, all allowed by the manifest); the model bytes came from ${STORAGE} (the registry's keep-alive connection is reported when it closes, below)`);
  } else {
    if (!cachedOk) {
      console.log(`SKIP: ${MODEL} is not in ${cacheRoot} and ${REGISTRY} cannot be reached from this machine`);
      results.notes.push('skipped: model unavailable offline');
      return finish('skipped');
    }
    copyModel(cacheDir, modelsDir, MODEL);
    ok(`${MODEL}: seeded from the host cache into the app's model store (no internet in this run)`);
  }

  // ---- Ollama's API, unchanged ---------------------------------------------------------------------------------------------------
  const tags = await json('/ollama/api/tags');
  assert.equal(tags.status, 200);
  const mine = tags.body.models.find((m) => m.name === MODEL);
  assert.ok(mine, `Ollama lists ${MODEL}: ${tags.body.models.map((m) => m.name)}`);
  const show = await post('/ollama/api/show', { model: MODEL });
  assert.equal(show.status, 200);
  assert.ok(show.body.details && show.body.capabilities, 'show returns details and capabilities');
  ok(`GET /api/tags and POST /api/show: ${mine.name}, ${mine.details.parameter_size}, ${mine.details.quantization_level}, capabilities ${show.body.capabilities.join(',')}`);
  assert.equal((await json('/ollama/api/ps')).body.models.length, 0, 'nothing is loaded yet');

  // streamed chat: lines arrive while the model is still generating
  const t1 = performance.now();
  const chatRes = await fetchP('/ollama/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Write a short story about a robot who learns to paint. Keep going until you run out of space.' }], options: { temperature: 0, num_predict: 200 } }),
  });
  const chat = await objects(chatRes);
  const last = chat[chat.length - 1].obj;
  assert.equal(last.done, true, JSON.stringify(last));
  const pieces = chat.filter((c) => c.obj.message && c.obj.message.content);
  const answer = pieces.map((c) => c.obj.message.content).join('');
  assert.ok(pieces.length >= 50, `the answer streams token by token (${pieces.length} pieces)`);
  assert.ok(pieces[pieces.length - 1].at - pieces[0].at > 100, `the pieces arrive over time, not in one piece (${Math.round(pieces[pieces.length - 1].at - pieces[0].at)} ms from the first to the last)`);
  assert.ok(Number.isFinite(last.eval_count) && last.eval_count > 0);
  const tps = last.eval_count / (last.eval_duration / 1e9);
  results.rawChat = { tps, promptTps: last.prompt_eval_count / (last.prompt_eval_duration / 1e9), loadMs: Math.round(last.load_duration / 1e6) };
  ok(`POST /api/chat streams ${pieces.length} pieces over ${Math.round(pieces[pieces.length - 1].at - pieces[0].at)} ms ("${answer.trim().slice(0, 60).replace(/\s+/g, ' ')}…"), ${tps.toFixed(0)} tokens/s, first piece after ${Math.round(pieces[0].at - t1)} ms`);
  const capital = await post('/ollama/api/generate', { model: MODEL, prompt: 'What is the capital of France? Answer in one short sentence.', stream: false, options: { temperature: 0, num_predict: 32 } });
  if (!/paris/i.test(capital.body.response)) console.log(`  note: the model did not say Paris: ${JSON.stringify(capital.body.response.slice(0, 120))}`);
  results.capital = capital.body.response.trim();

  const gen = await post('/ollama/api/generate', { model: MODEL, prompt: 'Say hello in French.', stream: false, options: { temperature: 0, num_predict: 24 } });
  assert.equal(gen.status, 200);
  assert.ok(gen.body.response && gen.body.done === true);
  const ps = (await json('/ollama/api/ps')).body.models;
  assert.equal(ps.length, 1);
  assert.equal(ps[0].name, MODEL);
  assert.equal(ps[0].size_vram, 0, 'on the VM CPUs: nothing in video memory');
  ok(`POST /api/generate (stream false) answered "${gen.body.response.trim().slice(0, 50)}"; GET /api/ps: ${ps[0].name} loaded, size_vram 0`);

  const oai = await fetchP('/ollama/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 24, messages: [{ role: 'user', content: 'Count from 1 to 5.' }] }),
  });
  assert.equal(oai.status, 200);
  assert.match(oai.headers.get('content-type') || '', /text\/event-stream/);
  const sse = [];
  for await (const { line } of lines(oai)) sse.push(line);
  assert.ok(sse.length >= 4 && sse[sse.length - 1] === 'data: [DONE]', `the OpenAI-compatible stream ends with [DONE] (${sse.length} lines)`);
  ok(`POST /v1/chat/completions (OpenAI-compatible, server-sent events): ${sse.length} lines, ends with [DONE]`);

  const copy = await post('/ollama/api/copy', { source: MODEL, destination: 'vmapp-copy:latest' });
  assert.equal(copy.status, 200);
  assert.ok((await json('/ollama/api/tags')).body.models.some((m) => m.name === 'vmapp-copy:latest'));
  const del = await json('/ollama/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'vmapp-copy:latest' }) });
  assert.equal(del.status, 200);
  assert.equal((await json('/ollama/api/tags')).body.models.some((m) => m.name === 'vmapp-copy:latest'), false);
  ok('POST /api/copy and DELETE /api/delete (a request body on DELETE) work');

  // ---- the UI backend's chat: streamed events, a stored chat, an attachment ---------------------------------------------------
  const chatEvents = async (chatId, body) => {
    const r = await fetchP(`/api/v1/chat/${chatId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200);
    return objects(r);
  };
  const ev1 = await chatEvents('new', { model: MODEL, prompt: 'List the capitals of France, Germany, Italy and Spain, one per line.', web_search: false, file_tools: false });
  assert.equal(ev1[0].obj.eventName, 'chat_created', JSON.stringify(ev1[0].obj));
  const chatId = ev1[0].obj.chatId;
  assert.ok(chatId);
  const contentEvents = ev1.filter((e) => e.obj.eventName === 'chat' && e.obj.content);
  assert.ok(contentEvents.length >= 2, `chat events stream (${contentEvents.length})`);
  assert.equal(ev1[ev1.length - 1].obj.eventName, 'done');
  assert.ok(!ev1.some((e) => e.obj.eventName === 'download'), 'the model is installed: no download');
  ok(`POST /api/v1/chat/new: chat_created, ${contentEvents.length} streamed chat events ("${contentEvents.map((e) => e.obj.content).join('').trim().slice(0, 40)}"), done`);

  const secret = 'The secret word is PINEAPPLE.';
  const ev2 = await chatEvents(chatId, {
    model: MODEL,
    prompt: 'What is the secret word in the attached file? Answer with the word only.',
    attachments: [{ filename: 'notes.txt', data: Buffer.from(secret).toString('base64') }],
    web_search: false,
    file_tools: false,
  });
  const answer2 = ev2.filter((e) => e.obj.eventName === 'chat').map((e) => e.obj.content || '').join('');
  assert.equal(ev2[ev2.length - 1].obj.eventName, 'done', JSON.stringify(ev2.slice(-2).map((e) => e.obj)));
  if (!/pineapple/i.test(answer2)) console.log(`  note: the model did not repeat the secret word: ${JSON.stringify(answer2.slice(0, 120))}`);
  const stored = await json(`/api/v1/chat/${chatId}`);
  assert.equal(stored.status, 200);
  const msgs = stored.body.chat.messages;
  assert.equal(msgs.length, 4, `two user and two assistant messages are stored: ${msgs.map((m) => m.role)}`);
  assert.equal(msgs[2].attachments[0].filename, 'notes.txt');
  assert.ok(msgs[1].content.length > 0 && msgs[3].content.length > 0, 'the assistant messages were stored while streaming');
  ok(`an attachment (notes.txt) goes through the bridge, the chat endpoint and Ollama; the chat is stored with 4 messages ("${answer2.trim().slice(0, 40)}")`);

  const list = await json('/api/v1/chats');
  assert.ok(list.body.chatInfos.some((c) => c.id === chatId));
  const rename = await json(`/api/v1/chat/${chatId}/rename`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Capitals' }) });
  assert.equal(rename.status, 200);
  assert.equal((await json('/api/v1/chats')).body.chatInfos.find((c) => c.id === chatId).title, 'Capitals');
  const second = (await chatEvents('new', { model: MODEL, prompt: 'Say hi.', web_search: false, file_tools: false }))[0].obj.chatId;
  const deleted = await json(`/api/v1/chat/${second}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.ok(!(await json('/api/v1/chats')).body.chatInfos.some((c) => c.id === second));
  ok('chats: listed, renamed, deleted (SQLite in /data)');

  // ---- the model is missing: the UI's chat endpoint downloads it with Ollama's own downloader and reports `download` events -----
  if (pulledForReal) {
    const del2 = await json('/ollama/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL }) });
    assert.equal(del2.status, 200);
    assert.equal((await json('/ollama/api/tags')).body.models.length, 0);
    const t2 = Date.now();
    const ev3 = await chatEvents('new', { model: MODEL, prompt: 'Say hi in one word.', web_search: false, file_tools: false });
    const dl = ev3.filter((e) => e.obj.eventName === 'download');
    assert.ok(dl.length >= 3, `download events stream (${dl.length}): ${JSON.stringify(ev3.slice(0, 3).map((e) => e.obj))}`);
    assert.ok(dl.some((e) => e.obj.completed > 0 && e.obj.total > 100 * MiB), 'with progress');
    assert.equal(dl[dl.length - 1].obj.done, true, 'and a final done:true');
    const chunks = ev3.filter((e) => e.obj.eventName === 'chat' && e.obj.content);
    assert.ok(chunks.length >= 1, 'then the answer');
    assert.equal(ev3[ev3.length - 1].obj.eventName, 'done');
    const { manifest } = modelFiles(modelsDir, MODEL);
    for (const l of [manifest.config, ...manifest.layers]) assert.equal(await sha256File(path.join(modelsDir, 'blobs', `sha256-${l.digest.slice(7)}`)), l.digest.slice(7));
    ok(`the model was deleted, then a chat to it pulled it again through the UI endpoint: ${dl.length} download events, digests verified on the host, then the answer (${((Date.now() - t2) / 1000).toFixed(0)} s)`);
    const hosts = [...new Set(net.filter((n) => n.allowed).map((n) => n.host))];
    assert.ok(hosts.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${hosts.join(', ')}`);
  }

  // ---- the CLI against the same server ------------------------------------------------------------------------------------------
  const cli = async (...args) => wm.invoke(win, 'ollama:cli', { args });
  const ls = await cli('list');
  assert.equal(ls.code, 0, ls.stderr);
  assert.ok(ls.stdout.includes(MODEL), ls.stdout);
  const cps = await cli('ps');
  assert.equal(cps.code, 0);
  const cshow = await cli('show', MODEL);
  assert.equal(cshow.code, 0, cshow.stderr);
  assert.match(cshow.stdout, /architecture/);
  const crun = await cli('run', MODEL, 'Reply with the single word: ready');
  assert.equal(crun.code, 0, crun.stderr);
  assert.ok(crun.stdout.trim().length > 0, 'ollama run printed an answer');
  const cpull = await cli('pull', MODEL);
  assert.equal(cpull.code, 0, cpull.stderr);
  if (pulledForReal) {
    // the CLI's own pull of a model that is not there: the same downloader in the server, through the same proxy
    const crm = await cli('rm', MODEL);
    assert.equal(crm.code, 0, crm.stderr);
    assert.equal((await json('/ollama/api/tags')).body.models.length, 0);
    const cdl = await cli('pull', MODEL);
    assert.equal(cdl.code, 0, cdl.stderr);
    assert.match(cdl.stdout + cdl.stderr, /success/);
    const { manifest } = modelFiles(modelsDir, MODEL);
    for (const l of [manifest.config, ...manifest.layers]) assert.equal(await sha256File(path.join(modelsDir, 'blobs', `sha256-${l.digest.slice(7)}`)), l.digest.slice(7));
    ok('ollama rm, then ollama pull in the VM: downloaded again through the proxy, digests verified on the host');
  }
  await assert.rejects(() => wm.invoke(win, 'ollama:cli', { args: ['create', 'x', '-f', '/etc/passwd'] }), /not available here/);
  await assert.rejects(() => wm.invoke(win, 'ollama:cli', { args: [] }), /not available here/);
  ok(`the ollama CLI in the VM talks to the same server: list, ps, show, run ("${crun.stdout.trim().slice(0, 40)}"), pull (already there)`);

  // ---- settings that restart the server -------------------------------------------------------------------------------------------
  const set = await post('/api/v1/settings', { ...settings0.body.settings, ContextLength: 4096 });
  assert.equal(set.status, 200, JSON.stringify(set.body || set.text));
  await waitFor(async () => (await wm.invoke(win, 'ollama:diag')).serverLog.includes('OLLAMA_CONTEXT_LENGTH:4096'), { timeoutMs: 60000, what: 'ollama serve to restart with the new context length' });
  await waitFor(async () => {
    try {
      return (await json('/ollama/api/version')).status === 200;
    } catch {
      return false;
    }
  }, { timeoutMs: 60000, what: 'the restarted server' });
  assert.equal((await json('/api/v1/settings')).body.settings.ContextLength, 4096);
  ok('changing the context length in the settings restarts ollama serve with OLLAMA_CONTEXT_LENGTH=4096 (the desktop app\'s own supervisor)');
  if (pulledForReal) {
    // the restart closed the server's connections: now the registry's ones are reported too
    await waitFor(() => net.some((n) => n.host === REGISTRY && n.allowed), { timeoutMs: 20000, what: "the registry's connections to be reported" });
    const hostsNow = [...new Set(net.filter((n) => n.allowed).map((n) => n.host))].sort();
    assert.ok(hostsNow.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${hostsNow.join(', ')}`);
    assert.ok(hostsNow.includes(REGISTRY) && hostsNow.includes(STORAGE));
    ok(`all connections of the run, from the platform's events: ${hostsNow.join(', ')} — only hosts of the manifest, the registry and its storage carried the model`);
  }

  // ---- sign-in and cloud (needs ollama.com) --------------------------------------------------------------------------------------
  await assert.rejects(() => wm.invoke(win, 'ollama:open-external', { url: 'http://example.com/' }), /Only https links/);
  await assert.rejects(() => wm.invoke(win, 'ollama:open-external', { url: 'file:///etc/passwd' }), /Only https links/);
  if (COM_ONLINE && net.some((n) => n.host === 'ollama.com' && n.allowed)) {
    const me = await post('/api/me', {});
    assert.equal(me.status, 401, JSON.stringify(me.body || me.text));
    assert.match(me.body.signin_url, /^https:\/\/ollama\.com\/connect\?/);
    ok('POST /api/me reaches ollama.com through the proxy: not signed in, with the sign-in URL the window opens in the browser');
  } else {
    results.notes.push('account checks skipped: ollama.com is not allowed or not reachable in this run');
    console.log('  (the account checks need ollama.com: skipped)');
  }

  // ---- what the chats did on the network -----------------------------------------------------------------------------------------
  const denied = net.filter((n) => !n.allowed);
  assert.ok(denied.every((n) => !HOSTS_ALLOWED.has(n.host) || n.host === 'ollama.com'), `refused connections: ${JSON.stringify(denied.map((n) => n.host))}`);

  fs.writeFileSync(stateFile, JSON.stringify({ chatId, title: 'Capitals', secret: msgs[2].attachments[0].filename }));
  return finish('done');

  async function persistPhase() {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const list = await json('/api/v1/chats');
    const found = list.body.chatInfos.find((c) => c.id === state.chatId);
    assert.ok(found, 'the chat of the first run is still there');
    assert.equal(found.title, state.title);
    const stored = await json(`/api/v1/chat/${state.chatId}`);
    assert.equal(stored.body.chat.messages.length, 4);
    assert.equal(stored.body.chat.messages[2].attachments[0].filename, state.secret);
    assert.equal((await json('/api/v1/settings')).body.settings.ContextLength, 4096, 'the settings persisted');
    ok('a new VM, the same /data: the chat (4 messages, the attachment) and the settings are still there');
    const tags = await json('/ollama/api/tags');
    assert.ok(tags.body.models.some((m) => m.name === MODEL), 'the model is still installed');
    const events = await objects(await fetchP(`/api/v1/chat/${state.chatId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, prompt: 'Say hi in one word.', web_search: false, file_tools: false }) }));
    assert.ok(!events.some((e) => e.obj.eventName === 'download'), 'no download: the model persisted');
    assert.equal(events[events.length - 1].obj.eventName, 'done');
    assert.equal((await json(`/api/v1/chat/${state.chatId}`)).body.chat.messages.length, 6, 'the new messages were appended to the stored chat');
    ok('the model persisted: the chat continued without a download, and the stored chat grew to 6 messages');
    return finish('done');
  }

  // The experimental Vulkan backend (SPEC 8.7; tests/apps/ollama-desktop-gpu.sh): the same app, a VM with the Venus GPU. Ollama must find
  // the device, run a model on it (size_vram > 0), and the ANSWER must be right (a fast GPU that computes garbage is not a result).
  async function gpuPhase() {
    const cachedOk = fs.existsSync(cacheDir);
    if (!fs.existsSync(path.join(modelsDir, 'manifests')) && cachedOk) copyModel(cacheDir, modelsDir, MODEL);
    else if (ONLINE) {
      const pulled = await objects(await fetchP('/ollama/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL }) }));
      assert.equal(pulled[pulled.length - 1].obj.status, 'success', JSON.stringify(pulled[pulled.length - 1].obj));
    } else {
      console.log(`SKIP: ${MODEL} is neither in ${cacheRoot} nor reachable`);
      return finish('skipped');
    }
    const compute = await waitFor(async () => {
      const r = await json('/api/v1/inference-compute');
      return r.status === 200 && r.body.inferenceComputes && r.body.inferenceComputes.length ? r.body : null;
    }, { timeoutMs: 60000, what: 'the inference compute list' });
    assert.ok(compute.inferenceComputes.some((c) => c.library !== 'cpu'), `a GPU compute device: ${JSON.stringify(compute.inferenceComputes)}`);
    const d = compute.inferenceComputes.find((c) => c.library !== 'cpu');
    const log = (await wm.invoke(win, 'ollama:diag')).serverLog;
    assert.match(log, /Vulkan0/, 'the server log names the Vulkan device');
    ok(`UI backend /api/v1/inference-compute: ${d.library} "${d.name}" (${d.vram}); the server log has Vulkan0`);
    const ans = await post('/ollama/api/generate', { model: MODEL, prompt: 'What is the capital of France? Answer in one short sentence.', stream: false, options: { temperature: 0, num_predict: 48 } });
    assert.equal(ans.status, 200);
    assert.match(ans.body.response, /paris/i, `the model computed on the GPU must answer correctly, it said ${JSON.stringify(ans.body.response)}`);
    const ps = (await json('/ollama/api/ps')).body.models;
    assert.ok(ps.length === 1 && ps[0].size_vram > 0, `the model is in video memory: ${JSON.stringify(ps)}`);
    const tps = ans.body.eval_count / (ans.body.eval_duration / 1e9);
    results.gpu = { device: d, tps, sizeVram: ps[0].size_vram, size: ps[0].size, answer: ans.body.response.trim() };
    ok(`on the GPU: "${ans.body.response.trim().slice(0, 60)}" (correct), size_vram ${Math.round(ps[0].size_vram / MiB)} of ${Math.round(ps[0].size / MiB)} MiB, ${tps.toFixed(0)} tokens/s`);
    const ev = await objects(await fetchP('/api/v1/chat/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, prompt: 'What is the capital of Italy? Answer in one short sentence.', web_search: false, file_tools: false }) }));
    const text = ev.filter((e) => e.obj.eventName === 'chat').map((e) => e.obj.content || '').join('');
    assert.match(text, /rome/i, `through the UI backend's chat on the GPU: ${JSON.stringify(text)}`);
    ok(`the UI backend's chat endpoint on the GPU: "${text.trim().slice(0, 60)}" (correct)`);
    return finish('done');
  }

  function finish(status) {
    results.status = status;
    if (process.env.OLLAMA_DESKTOP_RESULTS) {
      fs.mkdirSync(path.dirname(process.env.OLLAMA_DESKTOP_RESULTS), { recursive: true });
      fs.writeFileSync(`${process.env.OLLAMA_DESKTOP_RESULTS}.${PHASE}.json`, JSON.stringify(results, null, 2));
    }
    console.log(`  results: ${JSON.stringify(results)}`);
    return results;
  }
}
