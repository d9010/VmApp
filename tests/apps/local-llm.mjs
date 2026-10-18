// Local LLM (node22 runtime, llama.cpp's llama-server inside a real VM): the model download (through the allowlist proxy, resumed,
// checked against its sha256) or an import from the host's model cache, loading the model, streamed chat, the Stop button, the
// CPU builds of llama-server and, when the `gpu` host capability is granted, the Mac's GPU through ggml RPC.
// Run by run-all.sh with LOCAL_LLM_PHASE:
//   cpu   no GPU grant: everything on the VM's vCPUs. Records tokens/s.
//   gpu   the gpu capability is granted: loads the same model on the GPU and on the CPU in the same VM and compares tokens/s.
// Environment (run-all.sh sets it):
//   APPS_FIX             scratch folder for fixtures
//   LOCAL_LLM_CACHE      the host folder that caches models between runs ($VMAPP_WORK/cache/models); models are never committed
//   LOCAL_LLM_ONLINE=0   this machine cannot reach huggingface.co: a model missing from the cache skips the test
//   LOCAL_LLM_MODELS     catalog ids to measure, comma separated (default qwen2.5-0.5b). The first one is also used for the
//                        download/import checks. Bigger models make the CPU/GPU comparison more meaningful, but take longer.
//   LOCAL_LLM_RESULTS    where to write the measurements as JSON
// No secrets are involved: the only network access is huggingface.co and its CDN, for the public model files.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, requireEnv, waitFor } from './lib.mjs';

const PHASE = process.env.LOCAL_LLM_PHASE || 'cpu';
const ONLINE = process.env.LOCAL_LLM_ONLINE !== '0';
const MODEL_IDS = (process.env.LOCAL_LLM_MODELS || 'qwen2.5-0.5b').split(',').map((s) => s.trim()).filter(Boolean);
const CATALOG = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../apps/local-llm/core/models.json', import.meta.url)), 'utf8')).models;
const HOSTS_ALLOWED = new Set(['huggingface.co', 'us.aws.cdn.hf.co']);
const MiB = 1024 * 1024;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 4 * MiB })
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

export default async function ({ session, wm, dialogs, store }) {
  const fix = requireEnv('APPS_FIX');
  const cacheDir = requireEnv('LOCAL_LLM_CACHE');
  fs.mkdirSync(cacheDir, { recursive: true });
  const dataDir = store.dataDir(session.appId);
  const modelsDir = path.join(dataDir, 'models');
  const win = 1;
  const results = { phase: PHASE, models: {}, notes: [] };

  await wm.waitForWindows(1, 30000);
  assert.equal(wm.windows.get(win).params.entry, 'index.html');
  assert.equal(wm.windows.get(win).params.title, 'Local LLM');
  ok('window created: index.html, title "Local LLM"');

  // ---- everything the core emits, and every network connection --------------------------------------------------------
  const ev = { transfer: [], status: [], token: [], done: [], error: [], models: [] };
  wm.events.on('emit', (w, channel, args) => {
    const m = args[0];
    if (channel === 'llm:transfer') ev.transfer.push(m);
    else if (channel === 'llm:status') ev.status.push(m);
    else if (channel === 'llm:token') ev.token.push(m);
    else if (channel === 'llm:done') ev.done.push(m);
    else if (channel === 'llm:chat-error') ev.error.push(m);
    else if (channel === 'llm:models') ev.models.push(m);
  });
  const net = [];
  const gpuTraffic = []; // the tunnel to the host's GPU server (SPEC 8.6): connect / traffic / disconnect rows with byte counts
  session.on('traffic', (e) => {
    if (e.kind === 'net') net.push(e);
    else if (e.kind === 'gpu') gpuTraffic.push(e);
  });

  // ---- init: the catalog, the VM, the GPU grant ----------------------------------------------------------------------
  const init = await wm.invoke(win, 'llm:init');
  assert.deepEqual(init.models.catalog.map((m) => m.id), CATALOG.map((m) => m.id));
  for (const m of init.models.catalog) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.bytes > 1e8, 'size');
    assert.ok(['huggingface.co'].includes(m.host), `catalog host ${m.host}`);
  }
  assert.equal(init.gpu.granted, PHASE === 'gpu', `gpu.granted must be ${PHASE === 'gpu'} in phase ${PHASE}`);
  assert.ok(init.binary.present && init.binary.supported, `llama-server: ${JSON.stringify(init.binary)}`);
  assert.equal(init.server.state, 'stopped');
  results.vm = init.vm;
  results.binary = init.binary;
  ok(`init: ${init.models.catalog.length} catalog models, ${init.vm.cpus} vCPUs, ${init.vm.memMiB} MiB, GPU ${init.gpu.granted ? 'granted' : 'not granted'}, llama-server (${init.binary.label}) runs on this CPU`);
  console.log(`  guest CPU features: ${init.binary.features.join(' ')}`);

  // ---- guards that need no model -------------------------------------------------------------------------------------
  await assert.rejects(() => wm.invoke(win, 'llm:chat', { messages: [{ role: 'user', content: 'hi' }] }), /Load a model first/);
  await assert.rejects(() => wm.invoke(win, 'llm:load', { name: '../../etc/passwd' }), /Unknown model file/);
  await assert.rejects(() => wm.invoke(win, 'llm:load', { name: 'nothere.gguf' }), /not in the models folder/);
  await assert.rejects(() => wm.invoke(win, 'llm:delete', { name: '../x.gguf' }), /Unknown model file/);
  await assert.rejects(() => wm.invoke(win, 'llm:download', { id: 'no-such-model' }), /Unknown model/);
  ok('chat before load, path traversal in load/delete and an unknown download are refused');

  // a file that is not a GGUF model is refused by the import
  const fixDir = path.join(fix, 'local-llm');
  fs.mkdirSync(fixDir, { recursive: true });
  const notModel = path.join(fixDir, 'not-a-model.gguf');
  fs.writeFileSync(notModel, 'this is plain text, not a model\n');
  dialogs.opts.open = () => [notModel];
  await assert.rejects(() => wm.invoke(win, 'llm:import'), /not a GGUF/);
  dialogs.opts.open = null;
  assert.deepEqual(await wm.invoke(win, 'llm:import'), { canceled: true });
  ok('importing a file that is not GGUF is refused; a cancelled dialog does nothing');

  // ---- get the models: from the host cache (import) or from Hugging Face (download, resume, sha256) -----------------
  const waitTransfer = async (kind, key, since, timeoutMs) => {
    let last = null;
    await waitFor(
      () => {
        for (const t of ev.transfer.slice(since)) {
          if (t.kind === kind && (t.id === key || t.name === key)) last = t;
        }
        return last && ['done', 'error', 'cancelled'].includes(last.phase);
      },
      { timeoutMs, intervalMs: 200, what: `${kind} ${key} to finish (last: ${JSON.stringify(last)})` },
    );
    return last;
  };

  const have = {}; // id -> file name in /data/models
  for (const id of MODEL_IDS) {
    const entry = CATALOG.find((m) => m.id === id);
    assert.ok(entry, `unknown model id ${id}`);
    const cached = path.join(cacheDir, entry.file);
    const target = path.join(modelsDir, entry.file);
    let cacheOk = false;
    if (fs.existsSync(cached) && fs.statSync(cached).size === entry.bytes) cacheOk = (await sha256File(cached)) === entry.sha256;
    if (fs.existsSync(target) && fs.statSync(target).size === entry.bytes) {
      have[id] = entry.file;
      ok(`${entry.name}: already in the app's data folder from an earlier run`);
      continue;
    }

    if (cacheOk && process.env.LOCAL_LLM_FORCE_DOWNLOAD !== '1') {
      // pre-seed through the real import path (the dialog gives the core a clone of the file)
      dialogs.opts.open = () => [cached];
      const since = ev.transfer.length;
      const t0 = Date.now();
      const r = await wm.invoke(win, 'llm:import');
      assert.equal(r.started, true);
      assert.equal(r.name, entry.file);
      const end = await waitTransfer('import', entry.file, since, 600000);
      dialogs.opts.open = null;
      assert.equal(end.phase, 'done', JSON.stringify(end));
      assert.equal(fs.statSync(target).size, entry.bytes);
      ok(`${entry.name}: imported from the host cache (${Math.round(entry.bytes / MiB)} MiB in ${((Date.now() - t0) / 1000).toFixed(1)} s) through the open dialog`);
      have[id] = entry.file;
      const st = await wm.invoke(win, 'llm:init');
      assert.ok(st.models.local.some((l) => l.name === entry.file), 'listed after import');
      continue;
    }

    if (!ONLINE) {
      console.log(`SKIP: ${entry.name} is not in ${cacheDir} and huggingface.co cannot be reached from this machine`);
      results.notes.push(`skipped: ${entry.name} unavailable offline`);
      if (id === MODEL_IDS[0]) return finish(results, 'skipped');
      continue;
    }

    // a real download: start, cancel after some data (the partial file stays), resume, finish, verify
    const since = ev.transfer.length;
    const t0 = Date.now();
    assert.equal((await wm.invoke(win, 'llm:download', { id })).started, true);
    await assert.rejects(() => wm.invoke(win, 'llm:download', { id: MODEL_IDS[0] }), /Another download or import/);
    let first;
    try {
      first = await waitFor(() => ev.transfer.slice(since).find((t) => t.phase === 'error') || ev.transfer.slice(since).find((t) => t.received > 40 * MiB && t.phase === 'download'), {
        timeoutMs: 300000,
        intervalMs: 100,
        what: 'the first 40 MiB of the download',
      });
    } catch (e) {
      console.log(`SKIP: the download of ${entry.name} did not start: ${e.message}`);
      results.notes.push(`skipped: download failed (${e.message})`);
      await wm.invoke(win, 'llm:cancel').catch(() => {});
      if (id === MODEL_IDS[0]) return finish(results, 'skipped');
      continue;
    }
    if (first.phase === 'error') {
      console.log(`SKIP: the download of ${entry.name} failed: ${first.error}`);
      results.notes.push(`skipped: download failed (${first.error})`);
      if (id === MODEL_IDS[0]) return finish(results, 'skipped');
      continue;
    }
    ok(`${entry.name}: downloading through the proxy, ${Math.round(first.received / MiB)} MiB so far at ${(first.bps / 1e6).toFixed(1)} MB/s`);
    if (id === MODEL_IDS[0]) {
      // cancel and resume (only for the first model: it costs nothing extra, the bytes already received are kept)
      await wm.invoke(win, 'llm:cancel');
      const cancelled = await waitTransfer('download', id, since, 30000);
      assert.equal(cancelled.phase, 'cancelled');
      const partial = target + '.partial';
      assert.ok(fs.existsSync(partial), 'the partial file is kept');
      const kept = fs.statSync(partial).size;
      assert.ok(kept >= 40 * MiB && kept < entry.bytes, `partial size ${kept}`);
      const st = await wm.invoke(win, 'llm:init');
      assert.equal(st.models.catalog.find((m) => m.id === id).partialBytes, kept);
      ok(`cancelled at ${Math.round(kept / MiB)} MiB: the partial file is kept and the catalog offers to resume it`);
      const since2 = ev.transfer.length;
      await wm.invoke(win, 'llm:download', { id });
      const resumed = await waitFor(() => ev.transfer.slice(since2).find((t) => t.phase === 'download' || t.phase === 'error'), { timeoutMs: 120000, what: 'the resumed download' });
      assert.equal(resumed.phase, 'download', JSON.stringify(resumed));
      assert.ok(resumed.received >= kept, `resumed from ${resumed.received}`);
      const end = await waitTransfer('download', id, since2, 1800000);
      assert.equal(end.phase, 'done', JSON.stringify(end));
      ok(`resumed from ${Math.round(kept / MiB)} MiB and finished (the whole file's SHA-256 was checked by the core)`);
    } else {
      const end = await waitTransfer('download', id, since, 3600000);
      assert.equal(end.phase, 'done', JSON.stringify(end));
    }
    assert.equal(fs.statSync(target).size, entry.bytes);
    assert.equal(await sha256File(target), entry.sha256, 'sha256 of the stored file, computed on the host');
    ok(`${entry.name}: ${Math.round(entry.bytes / MiB)} MiB stored in /data/models, size and sha256 verified on the host (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    have[id] = entry.file;
    if (!fs.existsSync(cached)) {
      fs.copyFileSync(target, cached);
      console.log(`  (cached ${cached} for the next runs)`);
    }
    const hosts = [...new Set(net.map((n) => n.host))];
    results.downloadHosts = hosts;
    assert.ok(hosts.length > 0 && hosts.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${hosts.join(', ')}`);
    assert.ok(net.every((n) => n.allowed), `denied connections: ${JSON.stringify(net.filter((n) => !n.allowed))}`);
    ok(`the download contacted exactly: ${hosts.join(', ')} (all allowed by the manifest)`);
  }

  // ---- load a model and chat ------------------------------------------------------------------------------------------
  const lastStatus = () => ev.status[ev.status.length - 1];
  async function load(file, { useGpu = false, ctx = 4096 } = {}) {
    const since = ev.status.length;
    const t0 = Date.now();
    assert.equal((await wm.invoke(win, 'llm:load', { name: file, useGpu, ctx })).started, true);
    const st = await waitFor(
      () => ev.status.slice(since).reverse().find((s) => s.state === 'ready' || s.state === 'error'),
      { timeoutMs: 900000, intervalMs: 100, what: `${file} to load` },
    );
    if (st.state !== 'ready') {
      const log = (await wm.invoke(win, 'llm:logs')).lines.slice(-25).join('\n');
      throw new Error(`load failed: ${st.message}\n${log}`);
    }
    return { st, ms: Date.now() - t0 };
  }

  async function chat(prompt, { maxTokens = 64, temperature = 0, system } = {}) {
    const since = { token: ev.token.length, done: ev.done.length, error: ev.error.length };
    const messages = (system ? [{ role: 'system', content: system }] : []).concat([{ role: 'user', content: prompt }]);
    const { id } = await wm.invoke(win, 'llm:chat', { messages, temperature, maxTokens });
    const end = await waitFor(
      () => ev.done.slice(since.done).find((d) => d.id === id) || ev.error.slice(since.error).find((d) => d.id === id),
      { timeoutMs: 600000, intervalMs: 50, what: `the reply ${id}` },
    );
    const toks = ev.token.slice(since.token).filter((t) => t.id === id && t.kind === 'content');
    return { id, end, toks, text: toks.map((t) => t.text).join('') };
  }

  const PROMPT_FACT = 'What is the capital of France? Answer in one short sentence.';
  const PROMPT_LONG = 'Write a story about a robot who learns to paint. Keep going until you run out of space.';
  const runModel = async (id, file, { useGpu, label }) => {
    const entry = CATALOG.find((m) => m.id === id);
    const { st, ms } = await load(file, { useGpu });
    assert.equal(st.threads, init.vm.cpus, 'llama-server uses every vCPU of the VM');
    assert.equal(st.gpu.requested, !!useGpu);
    ok(`${entry.name} loaded in ${(ms / 1000).toFixed(1)} s (${label}; ${st.threads} threads, context ${st.ctx})`);
    const log = (await wm.invoke(win, 'llm:logs')).lines.join('\n');

    // 1. a short streamed answer
    const a = await chat(PROMPT_FACT, { maxTokens: 48 });
    assert.ok(a.end.stats, `chat error: ${JSON.stringify(a.end)}`);
    assert.ok(a.text.trim().length > 0, 'a non-empty reply');
    assert.ok(a.toks.length >= 1);
    ok(`reply: "${a.text.trim().slice(0, 90).replace(/\s+/g, ' ')}" (${a.end.stats.genTokens} tokens in ${a.toks.length} streamed batches, first token after ${a.end.stats.firstTokenMs} ms)`);
    if (/france/i.test(PROMPT_FACT) && !/paris/i.test(a.text)) console.log(`  note: the model did not say Paris: ${JSON.stringify(a.text.slice(0, 120))}`);

    // 2. throughput: a warm-up (the weights are paged in from the data folder on first use), then longer generations; the median
    // generation speed. Big models are slow, so they get fewer and shorter runs.
    const big = entry.bytes > 2e9;
    await chat(PROMPT_LONG, { maxTokens: big ? 16 : 64 });
    const speeds = [];
    for (let i = 0; i < (big ? 2 : 5); i++) {
      const r = await chat(PROMPT_LONG, { maxTokens: big ? 64 : 128 });
      assert.ok(r.end.stats, `chat error: ${JSON.stringify(r.end)}`);
      assert.ok(r.end.stats.genTps > 0, 'tokens/s from llama-server timings');
      assert.ok(r.end.stats.genTokens >= (big ? 50 : 100), `generated ${r.end.stats.genTokens} tokens`);
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
    return { st, loadMs: ms, tps, speeds, promptTps: ptps, log, replyText: a.text.trim() };
  };

  const firstId = MODEL_IDS.find((i) => have[i]);
  assert.ok(firstId, 'no model available');

  // the Stop button, on the first model (CPU or GPU, whichever phase this is)
  async function stopCheck(file) {
    const since = { token: ev.token.length, done: ev.done.length };
    // a reply that cannot finish by itself within the test: a long list (about 1500 tokens, more than max_tokens)
    const { id } = await wm.invoke(win, 'llm:chat', { messages: [{ role: 'user', content: 'Count from 1 to 500, separated by commas. Write only the numbers.' }], temperature: 0, maxTokens: 1024 });
    await waitFor(() => ev.token.length - since.token >= 2 || ev.done.slice(since.done).some((d) => d.id === id), { timeoutMs: 120000, intervalMs: 5, what: 'the first tokens' });
    assert.ok(!ev.done.slice(since.done).some((d) => d.id === id), 'the reply finished before it could be stopped');
    wm.send(win, 'llm:stop', { id });
    const end = await waitFor(() => ev.done.slice(since.done).find((d) => d.id === id), { timeoutMs: 30000, what: 'the stopped reply to finish' });
    assert.equal(end.stats.finish, 'stopped');
    assert.ok(end.stats.genTokens < 1024, 'stopped early');
    const again = await chat('Say OK.', { maxTokens: 8 });
    assert.ok(again.end.stats && again.text.trim().length > 0, 'llama-server still answers after a stop');
    ok(`Stop ends a reply early (${end.stats.genTokens} tokens) and the server keeps working`);
    void file;
  }

  // bad requests never reach llama-server
  async function guards() {
    await assert.rejects(() => wm.invoke(win, 'llm:chat', { messages: [{ role: 'tool', content: 'x' }] }), /Bad message/);
    await assert.rejects(() => wm.invoke(win, 'llm:chat', { messages: [] }), /No messages/);
    await assert.rejects(() => wm.invoke(win, 'llm:chat', { messages: [{ role: 'user', content: 5 }] }), /Bad message/);
    ok('malformed chat requests are refused by the core');
  }

  // does the model fit in the VM's memory on the CPU (weights are mapped from the data folder, plus the KV cache and buffers)?
  const fitsCpu = (entry) => Math.ceil((entry.bytes * 1.15) / MiB) + 300 <= init.vm.memMiB * 0.9;

  if (PHASE === 'cpu') {
    for (const id of MODEL_IDS) {
      if (!have[id]) continue;
      const file = have[id];
      const entry = CATALOG.find((m) => m.id === id);
      const out = { name: entry.name, bytes: entry.bytes };
      if (!fitsCpu(entry)) {
        console.log(`  note: ${entry.name} does not fit in this VM's ${init.vm.memMiB} MiB on the CPU: not measured in the CPU phase`);
        results.notes.push(`${entry.name}: does not fit the VM on the CPU`);
        continue;
      }
      const cpu = await runModel(id, file, { useGpu: false, label: `CPU, ${init.vm.cpus} vCPUs` });
      assert.equal(cpu.st.gpu.active, false);
      assert.ok(!/\bRPC\d*\b/.test(cpu.log.replace(/start: .*/, '')), 'no RPC device when the GPU is not used');
      out.cpu = { tps: cpu.tps, speeds: cpu.speeds, promptTps: cpu.promptTps, loadMs: cpu.loadMs, threads: cpu.st.threads };
      if (id === firstId) {
        await guards();
        await stopCheck(file);
        // the unload really stops llama-server
        assert.deepEqual(await wm.invoke(win, 'llm:unload'), {});
        assert.equal(lastStatus().state, 'stopped');
        ok('Unload stops llama-server');
        // a window that asks for the GPU without the grant gets the CPU: the core never builds an --rpc address from the request
        const forced = await load(file, { useGpu: true });
        assert.equal(forced.st.gpu.requested, false);
        assert.ok(!/--rpc/.test((await wm.invoke(win, 'llm:logs')).lines[0]), 'llama-server was not started with --rpc');
        await wm.invoke(win, 'llm:unload');
        ok('asking for the GPU without the grant starts llama-server on the CPU, without --rpc');
      }
      results.models[id] = out;
    }
  } else if (PHASE === 'gpu') {
    for (const id of MODEL_IDS) {
      if (!have[id]) continue;
      const file = have[id];
      const entry = CATALOG.find((m) => m.id === id);
      const out = { name: entry.name, bytes: entry.bytes };
      const gpu = await runModel(id, file, { useGpu: true, label: "the Mac's GPU (ggml RPC)" });
      assert.equal(gpu.st.gpu.requested, true);
      assert.ok(/RPC/i.test(gpu.log), `llama-server's log shows an RPC device:\n${gpu.log.split('\n').slice(0, 60).join('\n')}`);
      assert.equal(gpu.st.gpu.active, true, `the core recognises that the model is on the GPU: ${JSON.stringify(gpu.st.gpu)}`);
      const rpcLines = gpu.log.split('\n').filter((l) => /RPC/i.test(l)).slice(0, 6);
      for (const l of rpcLines) console.log(`  log: ${l.trim().slice(0, 160)}`);
      ok(`llama-server's log shows the RPC device (${gpu.st.gpu.device || 'RPC'}), ${gpu.st.gpu.layers ?? '?'}/${gpu.st.gpu.totalLayers ?? '?'} layers offloaded, ${gpu.st.gpu.rpcMiB ?? '?'} MiB of weights on the host`);
      out.gpu = { tps: gpu.tps, speeds: gpu.speeds, promptTps: gpu.promptTps, loadMs: gpu.loadMs, layers: gpu.st.gpu.layers, totalLayers: gpu.st.gpu.totalLayers, rpcMiB: gpu.st.gpu.rpcMiB };
      if (id === firstId) {
        await guards();
        await stopCheck(file);
      }
      if (fitsCpu(entry)) {
        const cpu = await runModel(id, file, { useGpu: false, label: `CPU, ${init.vm.cpus} vCPUs (same VM)` });
        assert.equal(cpu.st.gpu.active, false);
        assert.ok(!/RPC\d*(\[[^\]]*\])? model buffer/i.test(cpu.log), 'no RPC buffers when the GPU is off');
        out.cpu = { tps: cpu.tps, speeds: cpu.speeds, promptTps: cpu.promptTps, loadMs: cpu.loadMs };
        ok(`${entry.name}: GPU ${gpu.tps.toFixed(1)} tokens/s vs CPU ${cpu.tps.toFixed(1)} tokens/s (x${(gpu.tps / cpu.tps).toFixed(2)}); prompt ${gpu.promptTps ? gpu.promptTps.toFixed(0) : '?'} vs ${cpu.promptTps ? cpu.promptTps.toFixed(0) : '?'} tokens/s`);
      } else {
        ok(`${entry.name}: ${gpu.tps.toFixed(1)} tokens/s on the GPU; it does not fit in the VM's ${init.vm.memMiB} MiB on the CPU, so there is no CPU figure`);
      }
      results.models[id] = out;
    }
    await wm.invoke(win, 'llm:unload');
    // the tunnels to the host's GPU server close with llama-server; their byte counts are in the Inspector rows
    await waitFor(() => gpuTraffic.some((e) => e.phase === 'disconnect'), { timeoutMs: 30000, what: 'the GPU tunnel to close' }).catch(() => {});
    assert.ok(gpuTraffic.some((e) => e.phase === 'connect' && e.allowed), `no allowed GPU tunnel was opened: ${JSON.stringify(gpuTraffic.slice(0, 3))}`);
    const up = gpuTraffic.filter((e) => e.phase === 'disconnect').reduce((s, e) => s + e.bytesUp, 0);
    const down = gpuTraffic.filter((e) => e.phase === 'disconnect').reduce((s, e) => s + e.bytesDown, 0);
    results.gpuTunnel = { connections: gpuTraffic.filter((e) => e.phase === 'connect').length, bytesUp: up, bytesDown: down };
    ok(`the GPU tunnel (the Inspector's gpu rows): ${results.gpuTunnel.connections} connection(s), ${(up / MiB).toFixed(0)} MiB to the host, ${(down / MiB).toFixed(1)} MiB back`);
  } else {
    throw new Error(`unknown LOCAL_LLM_PHASE ${PHASE}`);
  }

  // ---- the network: only the manifest's hosts, and nothing was denied ------------------------------------------------------
  const hosts = [...new Set(net.map((n) => n.host))];
  assert.ok(hosts.every((h) => HOSTS_ALLOWED.has(h)), `hosts contacted: ${hosts.join(', ')}`);
  assert.ok(net.every((n) => n.allowed));
  ok(hosts.length ? `network: only ${hosts.join(', ')}` : 'network: no connection was made in this run (the model came from the cache)');

  return finish(results, 'done');

  function finish(res, status) {
    res.status = status;
    const out = process.env.LOCAL_LLM_RESULTS;
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(res, null, 2));
    }
    console.log(`  results: ${JSON.stringify(res)}`);
    return undefined;
  }
}
