// Ollama (node22 runtime, the real `ollama serve` release binary inside a real VM): the server's start and environment, pulling a model
// from registry.ollama.ai through the allowlist proxy (cancelled, resumed, verified), the denied-host path, chat with streaming and
// tokens/s from Ollama's own eval counters, Stop, Unload, Delete, and the GPU option.
// Run with OLLAMA_PHASE:
//   cpu   no GPU: everything on the VM's vCPUs. Records tokens/s. (run-all.sh; app dev.vmapp.ollama)
//   gpu   the experimental Vulkan backend (a VM with a render node and Ollama's Vulkan library): app dev.vmapp.ollama.gpu on the
//         `vmapp-vm-krun` backend. Run it with tests/apps/ollama-gpu.sh (builds nothing; see apps/ollama/vulkan/build-vulkan.sh first).
//         Expects Ollama to find the Venus GPU at start (the app turns the GPU option on by itself where a GPU exists), runs the model on
//         it (size_vram > 0), then switches the option off and runs the same model on the VM's CPUs for the comparison.
// Environment (run-all.sh sets it):
//   APPS_FIX         scratch folder for fixtures
//   OLLAMA_CACHE     the host folder that caches pulled models between runs ($VMAPP_WORK/cache/ollama-models); never committed
//   OLLAMA_ONLINE=0  this machine cannot reach registry.ollama.ai: a model missing from the cache skips the test
//   OLLAMA_RESULTS   where to write the measurements as JSON
//   OLLAMA_MODEL     the model to measure (default qwen2.5:0.5b)
// No secrets are involved: the only network access is registry.ollama.ai and its storage host, for the public model files.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, requireEnv, waitFor } from './lib.mjs';

const PHASE = process.env.OLLAMA_PHASE || 'cpu';
const ONLINE = process.env.OLLAMA_ONLINE !== '0';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const APP_DIR = fileURLToPath(new URL('../../apps/ollama/', import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'vmapp.json'), 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'core/models.json'), 'utf8')).models;
const PINS = fs.readFileSync(path.join(APP_DIR, 'pins.env'), 'utf8');
const PINNED_VERSION = /^OLLAMA_VERSION=(\S+)$/m.exec(PINS)[1];
const REGISTRY = 'registry.ollama.ai';
const HOSTS_ALLOWED = new Set(MANIFEST.permissions.network.map((n) => n.host));
const MiB = 1024 * 1024;

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * MiB })
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** The store files of one pulled model: the manifest and the blobs it lists. */
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
  const cacheRoot = requireEnv('OLLAMA_CACHE');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const cacheDir = path.join(cacheRoot, MODEL.replace(/[^A-Za-z0-9.]+/g, '-'));
  const dataDir = store.dataDir(session.appId);
  const modelsDir = path.join(dataDir, 'ollama', 'models');
  const downloadsDir = path.join(dataDir, 'ollama', 'downloads');
  const win = 1;
  const results = { phase: PHASE, model: MODEL, notes: [], hostLoadAtStart: Number(os.loadavg()[0].toFixed(1)) }; // the Mac's 1-minute load: speeds are only comparable at similar loads

  await wm.waitForWindows(1, 30000);
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  assert.equal(wm.windows.get(win).params.title, 'Ollama');
  ok('window created: index.html, title "Ollama"');

  // ---- everything the core emits, and every network connection --------------------------------------------------------
  const ev = { pull: [], status: [], token: [], done: [], error: [], models: [], loaded: [] };
  wm.events.on('emit', (w, channel, args) => {
    const m = args[0];
    if (channel === 'ollama:pull') ev.pull.push(m);
    else if (channel === 'ollama:status') ev.status.push(m);
    else if (channel === 'ollama:token') ev.token.push(m);
    else if (channel === 'ollama:done') ev.done.push(m);
    else if (channel === 'ollama:chat-error') ev.error.push(m);
    else if (channel === 'ollama:models') ev.models.push(m);
    else if (channel === 'ollama:loaded') ev.loaded.push(m);
  });
  const net = [];
  session.on('traffic', (e) => {
    if (e.kind === 'net') net.push(e);
  });

  // ---- the server comes up ---------------------------------------------------------------------------------------------
  const init = await waitFor(
    async () => {
      const i = await wm.invoke(win, 'ollama:init');
      if (i.server.state === 'error') throw new Error(`Ollama did not start: ${i.server.message}`);
      return i.server.state === 'ready' && i;
    },
    { timeoutMs: 90000, intervalMs: 200, what: 'ollama serve to be ready' },
  );
  assert.equal(init.server.version, PINNED_VERSION, 'the running server is the pinned version');
  assert.equal(init.binary.version, PINNED_VERSION, 'BUILD-INFO.txt names the pinned version');
  assert.ok(init.binary.present, 'the ollama binary is bundled');
  assert.ok(init.binary.cpuVariants.length >= 4, `CPU backend variants: ${init.binary.cpuVariants.join(' ')}`);
  assert.deepEqual(init.models.catalog.map((m) => m.name), CATALOG.map((m) => m.name));
  assert.ok(init.models.catalog.every((m) => m.bytes > 1e8 && !m.installed), 'a fresh app has no model installed');
  assert.deepEqual(init.models.local, []);
  if (PHASE === 'gpu') {
    // with a usable GPU Ollama lists the GPU as its compute device (the CPU is only listed when there is nothing else)
    assert.ok(init.server.devices.some((d) => d.library && d.library !== 'cpu'), `the server reports a GPU compute device (Vulkan): ${JSON.stringify(init.server.devices)}; the server log says:\n${(await wm.invoke(win, 'ollama:logs')).lines.filter((l) => /vulkan|igpu|gpu|dropping|device|inference compute/i.test(l)).slice(-20).join('\n')}`);
  } else {
    assert.ok(init.server.devices.some((d) => d.library === 'cpu'), `the server reports a CPU compute device: ${JSON.stringify(init.server.devices)}`);
  }
  results.vm = init.vm;
  results.server = { version: init.server.version, readyMs: init.server.readyMs, devices: init.server.devices };
  results.binary = init.binary;
  ok(`ollama ${init.server.version} serving after ${init.server.readyMs} ms on ${init.vm.cpus} vCPUs, ${init.vm.memMiB} MiB; compute devices: ${init.server.devices.map((d) => `${d.library}(${d.total})`).join(', ')}`);

  // the environment the server was started with, as Ollama itself prints it ("server config")
  const bootLog = (await wm.invoke(win, 'ollama:logs')).lines.join('\n');
  for (const want of [
    'OLLAMA_HOST:http://127.0.0.1:11434',
    'OLLAMA_MODELS:/data/ollama/models',
    'OLLAMA_NOHISTORY:true',
    'OLLAMA_NO_CLOUD:true',
    'HTTPS_PROXY:http://127.0.0.1:3128',
    'Listening on 127.0.0.1:11434',
  ]) {
    assert.ok(bootLog.includes(want), `the server log shows ${want}`);
  }
  assert.ok(bootLog.includes(`OLLAMA_VULKAN:${PHASE === 'gpu' ? 'true' : 'false'}`), `OLLAMA_VULKAN is ${PHASE === 'gpu'} in phase ${PHASE}`);
  assert.equal(init.gpu.eligible, PHASE === 'gpu', `gpu.eligible must be ${PHASE === 'gpu'} in phase ${PHASE}: ${JSON.stringify(init.gpu)}`);
  ok(`server environment: loopback only, models in /data/ollama/models, no history, no cloud, proxy inherited, Vulkan ${PHASE === 'gpu' ? 'on' : 'off'}`);

  // ---- guards that need no model -------------------------------------------------------------------------------------
  await assert.rejects(() => wm.invoke(win, 'ollama:pull', { name: '../../etc/passwd' }), /not a model name/);
  await assert.rejects(() => wm.invoke(win, 'ollama:pull', { name: 'evil.example.com/team/model:latest' }), /not a model name/);
  await assert.rejects(() => wm.invoke(win, 'ollama:pull', { name: 'x'.repeat(200) }), /not a model name/);
  await assert.rejects(() => wm.invoke(win, 'ollama:pull', {}), /Missing model name/);
  await assert.rejects(() => wm.invoke(win, 'ollama:delete', { name: '../x:y' }), /not a model name/);
  await assert.rejects(() => wm.invoke(win, 'ollama:delete', { name: 'nothere:latest' }), /not installed/);
  await assert.rejects(() => wm.invoke(win, 'ollama:chat', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] }), /not installed/);
  await assert.rejects(() => wm.invoke(win, 'ollama:chat', { model: 'a/b/c:d', messages: [{ role: 'user', content: 'hi' }] }), /not a model name/);
  ok('pull/delete/chat refuse path traversal, a registry host in the name, over-long and missing names, and models that are not installed');

  // a model that does not exist: the registry's 404 reaches the window as a plain sentence, and only the registry was contacted
  if (ONLINE) {
    const since = ev.pull.length;
    assert.equal((await wm.invoke(win, 'ollama:pull', { name: 'no-such-model-vmapp-test:1b' })).started, true);
    const end = await waitFor(() => ev.pull.slice(since).find((p) => p.phase === 'error' || p.phase === 'done'), { timeoutMs: 60000, what: 'the pull of a missing model to fail' });
    assert.equal(end.phase, 'error');
    assert.match(end.error, /There is no model "no-such-model-vmapp-test:1b" on registry\.ollama\.ai/);
    ok(`pulling a model that does not exist: "${end.error}"`);
  }

  // ---- get the model: a real pull (online), or from the host's cache ----------------------------------------------------
  const cachedOk = fs.existsSync(cacheDir) && (() => {
    try {
      const { manifestRel, blobRels } = modelFiles(cacheDir, MODEL);
      return fs.existsSync(path.join(cacheDir, manifestRel)) && blobRels.every((r) => fs.existsSync(path.join(cacheDir, r)));
    } catch {
      return false;
    }
  })();
  const entry = CATALOG.find((m) => m.name === MODEL);
  const waitPull = async (since, timeoutMs) => {
    const end = await waitFor(() => ev.pull.slice(since).find((p) => ['done', 'error', 'cancelled'].includes(p.phase)), {
      timeoutMs,
      intervalMs: 200,
      what: `the pull of ${MODEL} to finish (last: ${JSON.stringify(ev.pull[ev.pull.length - 1])})`,
    });
    return end;
  };
  let pulledForReal = false;

  if (ONLINE) {
    const since = ev.pull.length;
    const t0 = Date.now();
    assert.equal((await wm.invoke(win, 'ollama:pull', { name: MODEL })).started, true);
    await assert.rejects(() => wm.invoke(win, 'ollama:pull', { name: 'qwen2.5:1.5b' }), /Another download is still running/);
    // let some data arrive, then cancel (the partial file stays), then resume
    const first = await waitFor(
      () => ev.pull.slice(since).find((p) => p.phase === 'error' || p.phase === 'done' || (p.phase === 'download' && p.received > 40 * MiB)),
      { timeoutMs: 300000, intervalMs: 50, what: 'the first 40 MiB of the pull' },
    ).catch((e) => e);
    if (first instanceof Error || first.phase === 'error') {
      const why = first instanceof Error ? first.message : first.error;
      console.log(`SKIP: the pull of ${MODEL} did not start: ${why}`);
      results.notes.push(`skipped: pull failed (${why})`);
      await wm.invoke(win, 'ollama:cancel').catch(() => {});
      if (!cachedOk) return finish(results, 'skipped');
    } else {
      ok(`${MODEL}: pulling through the proxy, ${Math.round(first.received / MiB)} MiB of ${Math.round(first.total / MiB)} MiB so far at ${((first.bps || 0) / 1e6).toFixed(1)} MB/s (${first.status})`);
      if (first.phase === 'download') {
        await wm.invoke(win, 'ollama:cancel');
        const cancelled = await waitPull(since, 30000);
        assert.equal(cancelled.phase, 'cancelled', JSON.stringify(cancelled));
        const partials = fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir).filter((f) => f.endsWith('.partial')) : [];
        assert.equal(partials.length, 1, `one partial file is kept: ${partials}`);
        const kept = fs.statSync(path.join(downloadsDir, partials[0])).size;
        assert.ok(kept >= 40 * MiB && kept < entry.bytes, `partial size ${kept}`);
        assert.equal((await wm.invoke(win, 'ollama:init')).models.local.length, 0, 'a cancelled pull installs nothing');
        ok(`cancelled at ${Math.round(kept / MiB)} MiB: the partial file is kept in /data/ollama/downloads and nothing is installed`);
        const since2 = ev.pull.length;
        await wm.invoke(win, 'ollama:pull', { name: MODEL });
        const resumed = await waitFor(() => ev.pull.slice(since2).find((p) => p.phase === 'download' && p.received >= kept), { timeoutMs: 120000, what: 'the resumed pull' });
        assert.ok(resumed.received >= kept, `resumed from ${resumed.received}`);
        const end = await waitPull(since2, 1800000);
        assert.equal(end.phase, 'done', JSON.stringify(end));
        ok(`resumed from ${Math.round(kept / MiB)} MiB and finished (every file's SHA-256 was checked by the core)`);
      } else {
        const end = await waitPull(since, 1800000);
        assert.equal(end.phase, 'done', JSON.stringify(end));
        results.notes.push('the pull finished before it could be cancelled: no resume check');
      }
      pulledForReal = true;
      ok(`${MODEL} pulled in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  }

  if (pulledForReal) {
    // the store on disk: every blob's file name is the SHA-256 of its content, computed here on the host
    const { manifestRel, manifest, blobRels } = modelFiles(modelsDir, MODEL);
    for (const l of [manifest.config, ...manifest.layers]) {
      const f = path.join(modelsDir, 'blobs', `sha256-${l.digest.slice(7)}`);
      assert.equal(fs.statSync(f).size, l.size, `size of ${l.digest}`);
      assert.equal(await sha256File(f), l.digest.slice(7), `sha256 of ${f}`);
    }
    const total = [manifest.config, ...manifest.layers].reduce((s, l) => s + l.size, 0);
    assert.equal(total, entry.bytes, 'the catalog size is the sum of the manifest');
    assert.deepEqual(fs.readdirSync(downloadsDir).filter((f) => f.endsWith('.partial')), [], 'no partial file is left');
    ok(`the store holds ${blobRels.length} blobs, each verified against its digest on the host, and ${manifestRel}`);
    // keep a copy for runs without internet
    if (!cachedOk) {
      copyModel(modelsDir, cacheDir, MODEL);
      console.log(`  (cached ${MODEL} in ${cacheDir} for runs without internet)`);
    }
  } else {
    if (!cachedOk) {
      console.log(`SKIP: ${MODEL} is not in ${cacheRoot} and registry.ollama.ai cannot be reached from this machine`);
      results.notes.push('skipped: model unavailable offline');
      return finish(results, 'skipped');
    }
    copyModel(cacheDir, modelsDir, MODEL);
    ok(`${MODEL}: seeded from the host cache into /data/ollama/models (no internet in this run)`);
  }
  // Ollama reads its store on demand: the model must be listed now
  await waitFor(async () => (await wm.invoke(win, 'ollama:init')).models.local.some((l) => l.name === MODEL), { timeoutMs: 15000, what: `${MODEL} in Ollama's list` });
  const listed = (await wm.invoke(win, 'ollama:init')).models;
  const mine = listed.local.find((l) => l.name === MODEL);
  assert.equal(mine.bytes, entry.bytes);
  assert.ok(listed.catalog.find((c) => c.name === MODEL).installed);
  ok(`Ollama lists ${MODEL}: ${mine.params}, ${mine.quant}, ${Math.round(mine.bytes / MiB)} MiB`);

  // ---- the network: only the manifest's hosts, and (for a real pull) both of them ---------------------------------------------
  if (pulledForReal) {
    await waitFor(() => net.some((n) => n.host !== REGISTRY && n.bytesDown > 1e8), { timeoutMs: 15000, what: 'the storage host connection to be reported' });
    const hosts = [...new Set(net.map((n) => n.host))].sort();
    assert.ok(hosts.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${hosts.join(', ')}`);
    assert.deepEqual(hosts, [...HOSTS_ALLOWED].sort(), 'the pull used exactly the two hosts of the manifest');
    assert.ok(net.every((n) => n.allowed && n.port === 443), `denied or non-443 connections: ${JSON.stringify(net.filter((n) => !n.allowed || n.port !== 443))}`);
    results.pullHosts = hosts;
    results.pullBytesDown = net.reduce((s, n) => s + n.bytesDown, 0);
    ok(`the pull contacted exactly: ${hosts.join(', ')} (port 443, all allowed by the manifest; ${Math.round(results.pullBytesDown / MiB)} MiB down)`);
  }

  // a revoked storage host: the pull fails with a sentence that names the host, and the grant works again afterwards
  if (ONLINE) {
    const blobHost = [...HOSTS_ALLOWED].find((h) => h !== REGISTRY);
    await session.netRevoke(blobHost);
    const other = CATALOG.find((m) => m.name !== MODEL && m.bytes < 1e9).name;
    const since = ev.pull.length;
    const denied0 = net.filter((n) => !n.allowed).length;
    await wm.invoke(win, 'ollama:pull', { name: other });
    const end = await waitPull(since, 60000);
    assert.equal(end.phase, 'error', JSON.stringify(end));
    assert.match(end.error, new RegExp(`Could not connect to ${blobHost.replace(/\./g, '\\.')}`));
    await waitFor(() => net.filter((n) => !n.allowed).length > denied0, { timeoutMs: 10000, what: 'the refused connection to be reported' });
    const refused = net.filter((n) => !n.allowed);
    assert.ok(refused.every((n) => n.host === blobHost), `refused: ${JSON.stringify(refused.map((n) => n.host))}`);
    assert.equal((await wm.invoke(win, 'ollama:init')).models.local.some((l) => l.name === other), false, 'a failed pull installs nothing');
    ok(`with ${blobHost} revoked, pulling ${other} fails with "${end.error.slice(0, 90)}…" and the Inspector shows the refused connection`);
    await session.syncNetwork();
  }

  // ---- chat -----------------------------------------------------------------------------------------------------------
  async function chat(prompt, { maxTokens = 64, temperature = 0, system } = {}) {
    const since = { token: ev.token.length, done: ev.done.length, error: ev.error.length };
    const messages = (system ? [{ role: 'system', content: system }] : []).concat([{ role: 'user', content: prompt }]);
    const { id } = await wm.invoke(win, 'ollama:chat', { model: MODEL, messages, temperature, maxTokens });
    const end = await waitFor(
      () => ev.done.slice(since.done).find((d) => d.id === id) || ev.error.slice(since.error).find((d) => d.id === id),
      { timeoutMs: 600000, intervalMs: 50, what: `the reply ${id}` },
    );
    const toks = ev.token.slice(since.token).filter((t) => t.id === id && t.kind === 'content');
    return { id, end, toks, text: toks.map((t) => t.text).join('') };
  }

  const chatsStart = Date.now(); // events are reported when a connection closes: a connection counts as made during the chats if it was opened after this
  const PROMPT_FACT = 'What is the capital of France? Answer in one short sentence.';
  const PROMPT_LONG = 'Write a story about a robot who learns to paint. Keep going until you run out of space.';

  async function runModel(label) {
    // 1. a short streamed answer (the first one also loads the model)
    const a = await chat(PROMPT_FACT, { maxTokens: 48 });
    assert.ok(a.end.stats, `chat error: ${JSON.stringify(a.end)}`);
    assert.ok(a.text.trim().length > 0, 'a non-empty reply');
    assert.ok(a.toks.length >= 1);
    assert.equal(a.end.stats.model, MODEL);
    ok(`reply: "${a.text.trim().slice(0, 90).replace(/\s+/g, ' ')}" (${a.end.stats.genTokens} tokens in ${a.toks.length} streamed batches, first token after ${a.end.stats.firstTokenMs} ms, model load ${a.end.stats.loadMs} ms)`);
    if (!/paris/i.test(a.text)) console.log(`  note: the model did not say Paris: ${JSON.stringify(a.text.slice(0, 120))}`);
    // A faster-looking GPU that computes garbage is not a result: on the GPU the answer must be right (the CPU's tokens/s are only
    // meaningful with a correct model too, and a small model may legitimately word it differently, so this is checked on the GPU only).
    if (PHASE === 'gpu' && label.includes('GPU')) assert.match(a.text, /paris/i, `the model computed on the GPU must answer correctly, it said ${JSON.stringify(a.text.slice(0, 120))}`);

    // 2. throughput from Ollama's own counters: a warm-up, then longer generations; the median generation speed
    await chat(PROMPT_LONG, { maxTokens: 64 });
    const speeds = [];
    for (let i = 0; i < 5; i++) {
      const r = await chat(PROMPT_LONG, { maxTokens: 128 });
      assert.ok(r.end.stats, `chat error: ${JSON.stringify(r.end)}`);
      assert.ok(r.end.stats.genTps > 0, 'tokens/s from eval_count / eval_duration');
      assert.ok(r.end.stats.genTokens >= 100, `generated ${r.end.stats.genTokens} tokens`);
      speeds.push(r.end.stats.genTps);
    }
    const tps = median(speeds);
    // prompt processing: one new, long prompt (a random start, so that no cached prefix is reused), one token of output
    const pp = [];
    for (let i = 0; i < 2; i++) {
      const long = `${Math.random()} Read this text and say OK. ${'The quick brown fox jumps over the lazy dog. '.repeat(50)}`;
      const r = await chat(long, { maxTokens: 1 });
      assert.ok(r.end.stats, `chat error: ${JSON.stringify(r.end)}`);
      if (r.end.stats.promptTokens >= 400) pp.push(r.end.stats.promptTps);
    }
    const ptps = median(pp.filter(Boolean));
    ok(`${label}: ${tps.toFixed(1)} tokens/s generation (runs: ${speeds.map((s) => s.toFixed(1)).join(', ')}), prompt processing ${ptps ? ptps.toFixed(0) : '?'} tokens/s (about 500 tokens)`);
    return { tps, speeds, promptTps: ptps, loadMs: a.end.stats.loadMs, where: a.end.stats.where, replyText: a.text.trim() };
  }

  // where does it run? (the window's status line is built from the same /api/ps data)
  const ps = async () => (await wm.invoke(win, 'ollama:ps')).compute;

  if (PHASE === 'cpu') {
    const cpu = await runModel(`CPU, ${init.vm.cpus} vCPUs`);
    assert.equal(cpu.where, 'cpu');
    const c = await ps();
    const m = c.models.find((x) => x.name === MODEL);
    assert.ok(m, `${MODEL} is loaded after the chat: ${JSON.stringify(c.models)}`);
    assert.equal(m.where, 'cpu');
    assert.equal(m.vramBytes, 0, 'size_vram is 0 on the CPU');
    assert.equal(c.threads, init.vm.cpus, `Ollama's runner uses every vCPU (n_threads ${c.threads})`);
    assert.equal(c.gpuDevices.length, 0);
    ok(`/api/ps: ${MODEL} is loaded, ${Math.round(m.sizeBytes / MiB)} MiB, size_vram 0 (CPU), context ${m.contextLength}, ${c.threads} threads`);
    results.cpu = { tps: cpu.tps, speeds: cpu.speeds, promptTps: cpu.promptTps, loadMs: cpu.loadMs, threads: c.threads, vcpus: init.vm.cpus };

    // chatting made no network connection at all (the server and the core stay on the VM's loopback)
    const during = net.filter((n) => n.ts - n.durationMs > chatsStart);
    assert.deepEqual(during, [], `connections opened during the chats: ${JSON.stringify(during.map((n) => n.host))}`);
    ok('chatting opened no network connection');

    // the Stop button: a reply that cannot finish by itself within the test
    {
      const since = { token: ev.token.length, done: ev.done.length };
      const { id } = await wm.invoke(win, 'ollama:chat', { model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 500, separated by commas. Write only the numbers.' }], temperature: 0, maxTokens: 1024 });
      await waitFor(() => ev.token.length - since.token >= 2 || ev.done.slice(since.done).some((d) => d.id === id), { timeoutMs: 120000, intervalMs: 5, what: 'the first tokens' });
      assert.ok(!ev.done.slice(since.done).some((d) => d.id === id), 'the reply finished before it could be stopped');
      wm.send(win, 'ollama:stop', { id });
      const end = await waitFor(() => ev.done.slice(since.done).find((d) => d.id === id), { timeoutMs: 30000, what: 'the stopped reply to finish' });
      assert.equal(end.stats.finish, 'stopped');
      assert.ok(end.stats.genTokens < 1024, 'stopped early');
      const again = await chat('Say OK.', { maxTokens: 8 });
      assert.ok(again.end.stats && again.text.trim().length > 0, 'Ollama still answers after a stop');
      ok(`Stop ends a reply early (${end.stats.genTokens} tokens) and the server keeps working`);
    }

    // malformed chat requests never reach Ollama
    await assert.rejects(() => wm.invoke(win, 'ollama:chat', { model: MODEL, messages: [{ role: 'tool', content: 'x' }] }), /Bad message/);
    await assert.rejects(() => wm.invoke(win, 'ollama:chat', { model: MODEL, messages: [] }), /No messages/);
    await assert.rejects(() => wm.invoke(win, 'ollama:chat', { model: MODEL, messages: [{ role: 'user', content: 5 }] }), /Bad message/);
    ok('malformed chat requests are refused by the core');

    // asking for the GPU where there is none: the server restarts and still runs on the CPU (OLLAMA_VULKAN stays off)
    {
      const since = ev.status.length;
      await wm.invoke(win, 'ollama:settings', { useGpu: true });
      await waitFor(() => ev.status.slice(since).some((s) => s.state === 'ready') && ev.status.slice(since).some((s) => s.state === 'starting'), { timeoutMs: 60000, what: 'Ollama to restart' });
      const st = (await wm.invoke(win, 'ollama:init')).server;
      assert.equal(st.state, 'ready');
      assert.equal(st.gpuRequested, true);
      assert.equal(st.vulkan, false, 'no Vulkan without a device');
      const r = await chat('Say OK.', { maxTokens: 8 });
      assert.ok(r.end.stats && r.end.stats.where === 'cpu', JSON.stringify(r.end));
      const l = (await wm.invoke(win, 'ollama:logs')).lines.join('\n');
      assert.ok(l.includes('OLLAMA_VULKAN:false'));
      await wm.invoke(win, 'ollama:settings', { useGpu: false });
      await waitFor(async () => (await wm.invoke(win, 'ollama:init')).server.state === 'ready', { timeoutMs: 60000, what: 'Ollama to restart again' });
      ok('switching the GPU option on without a GPU restarts Ollama, which stays on the CPU with OLLAMA_VULKAN=0; then back off');
    }

    // the Restart button (also what the window offers after a crash): the state goes through "starting" and back to "ready"
    {
      const since = ev.status.length;
      assert.deepEqual(await wm.invoke(win, 'ollama:restart'), { started: true });
      await assert.rejects(() => wm.invoke(win, 'ollama:restart'), /already restarting/);
      await waitFor(async () => (await wm.invoke(win, 'ollama:init')).server.state === 'ready', { timeoutMs: 60000, what: 'Ollama to come back' });
      assert.ok(ev.status.slice(since).some((s) => s.state === 'starting'), 'the window was told that Ollama is starting');
      const r = await chat('Say OK.', { maxTokens: 8 });
      assert.ok(r.end.stats && r.text.trim().length > 0, 'a reply after the restart');
      ok('Restart brings Ollama back (starting, then ready) and the model answers again');
    }

    // Unload frees the model; Delete removes the model from the store
    await chat('Say OK.', { maxTokens: 8 });
    assert.ok((await ps()).models.some((x) => x.name === MODEL), 'the model is loaded after a reply');
    await wm.invoke(win, 'ollama:unload', {});
    await waitFor(async () => (await ps()).models.length === 0, { timeoutMs: 20000, what: 'nothing to be loaded after Unload' });
    ok('Unload frees the model (/api/ps is empty)');
    const filesBefore = modelFiles(modelsDir, MODEL);
    assert.deepEqual(await wm.invoke(win, 'ollama:delete', { name: MODEL }), { removed: true });
    assert.equal((await wm.invoke(win, 'ollama:init')).models.local.some((l) => l.name === MODEL), false);
    assert.ok(!fs.existsSync(path.join(modelsDir, filesBefore.manifestRel)), 'the manifest is gone');
    assert.ok(filesBefore.blobRels.every((r) => !fs.existsSync(path.join(modelsDir, r))), 'the blobs are gone');
    ok('Delete removes the model: it leaves the list, and its manifest and blobs leave the disk');
    results.models = { [MODEL]: results.cpu };
  } else if (PHASE === 'gpu') {
    const c0 = await ps();
    assert.ok(c0.gpuDevices.length > 0, `Ollama found a GPU device: ${JSON.stringify(c0.devices)}`);
    assert.ok(c0.vulkanOn, 'the server was started with OLLAMA_VULKAN=1');
    const gpu = await runModel("the Mac's GPU (Vulkan)");
    const c = await ps();
    const m = c.models.find((x) => x.name === MODEL);
    assert.equal(m.where, 'gpu', JSON.stringify(m));
    assert.ok(m.vramBytes > 0 && m.percentGpu > 0);
    ok(`/api/ps: size_vram ${Math.round(m.vramBytes / MiB)} MiB of ${Math.round(m.sizeBytes / MiB)} MiB (${m.percentGpu}% on ${c.gpuDevices[0].library}: ${c.gpuDevices[0].name})`);
    results.gpu = { tps: gpu.tps, speeds: gpu.speeds, promptTps: gpu.promptTps, loadMs: gpu.loadMs, device: c.gpuDevices[0], percentGpu: m.percentGpu };
    await wm.invoke(win, 'ollama:settings', { useGpu: false });
    await waitFor(async () => (await wm.invoke(win, 'ollama:init')).server.state === 'ready', { timeoutMs: 60000, what: 'Ollama to restart on the CPU' });
    const cpu = await runModel(`CPU, ${init.vm.cpus} vCPUs (same VM)`);
    assert.equal(cpu.where, 'cpu');
    results.cpu = { tps: cpu.tps, speeds: cpu.speeds, promptTps: cpu.promptTps, loadMs: cpu.loadMs };
    ok(`${MODEL}: GPU ${gpu.tps.toFixed(1)} tokens/s vs CPU ${cpu.tps.toFixed(1)} tokens/s (x${(gpu.tps / cpu.tps).toFixed(2)}); prompt ${gpu.promptTps ? gpu.promptTps.toFixed(0) : '?'} vs ${cpu.promptTps ? cpu.promptTps.toFixed(0) : '?'} tokens/s`);
  } else {
    throw new Error(`unknown OLLAMA_PHASE ${PHASE}`);
  }

  // ---- the network over the whole run: only the manifest's hosts -------------------------------------------------------------
  const hosts = [...new Set(net.map((n) => n.host))];
  assert.ok(hosts.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${hosts.join(', ')}`);
  ok(hosts.length ? `network over the whole run: only ${hosts.join(', ')}` : 'network: no connection was made in this run (the model came from the cache)');

  return finish(results, 'done');

  function finish(res, status) {
    res.status = status;
    res.hostLoadAtEnd = Number(os.loadavg()[0].toFixed(1));
    const out = process.env.OLLAMA_RESULTS;
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(res, null, 2));
    }
    console.log(`  results: ${JSON.stringify(res)}`);
    return undefined;
  }
}
