// Local LLM benchmark: tokens per second of llama.cpp's llama-server inside the app's VM, on the VM's CPU or on the Mac's GPU
// (ggml RPC to the host's sandboxed Metal rpc-server). It drives the real apps/local-llm app through the same bridge channels as
// tests/apps/local-llm.mjs, but only measures; the test suite checks behaviour.
//
//   vmapp run dev.vmapp.localllm --headless --script bench/llm/bench-llm.mjs      (tools/bench llm does the setup around it)
//
// Environment (tools/bench llm sets it):
//   BENCH_PHASE         cpu | gpu. cpu: the VM has no GPU grant, everything runs on its vCPUs. gpu: the `gpu` host capability is granted
//   BENCH_MODEL_ID      the id in apps/local-llm/core/models.json (for example qwen2.5-7b)
//   BENCH_MODEL_FILE    the host path of that model's GGUF file, already checked against the sha256 of models.json
//   BENCH_RUNS          generation runs and prompt-processing runs that are measured (default 5)
//   BENCH_RESULTS       a file to write the JSON result to
//
// Method, fixed so that two machines run the same thing:
//   context 4096, greedy sampling (temperature 0), llama-server started by the app with every vCPU of the VM as threads;
//   generation: the prompt PROMPT_GEN, 128 new tokens, BENCH_RUNS times after one warm-up. The speed is llama-server's own
//     `timings.predicted_per_second` for each reply (the app reports it as genTps); the result is the median of the runs;
//   prompt processing: BENCH_RUNS prompts of about 500 tokens that each start with a different number, so that no cached prefix is
//     reused, one new token each. The speed is llama-server's `timings.prompt_per_second` (promptTps); the result is the median;
//   load time: `llm:load` until the app reports the model ready.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from '../../tests/apps/lib.mjs';

const require = createRequire(import.meta.url);
const { summarize, round } = require('../lib/stats.js');

const PHASE = process.env.BENCH_PHASE || 'cpu';
const MODEL_ID = process.env.BENCH_MODEL_ID;
const MODEL_FILE = process.env.BENCH_MODEL_FILE;
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS || 5));
const CTX = 4096;
const GEN_TOKENS = 128;
const MiB = 1024 * 1024;
const PROMPT_GEN = 'Write a story about a robot who learns to paint. Keep going until you run out of space.';
const PROMPT_FILLER = 'The quick brown fox jumps over the lazy dog. '.repeat(50);

const catalog = JSON.parse(fs.readFileSync(new URL('../../apps/local-llm/core/models.json', import.meta.url), 'utf8')).models;
const log = (m) => console.log(`BENCH ${m}`);

export default async function ({ session, wm, dialogs, store }) {
  assert.ok(['cpu', 'gpu'].includes(PHASE), `BENCH_PHASE must be cpu or gpu, not ${PHASE}`);
  const entry = catalog.find((m) => m.id === MODEL_ID);
  assert.ok(entry, `BENCH_MODEL_ID ${MODEL_ID} is not in models.json`);
  assert.ok(MODEL_FILE && fs.existsSync(MODEL_FILE), `BENCH_MODEL_FILE ${MODEL_FILE} does not exist`);
  const win = 1;

  // The headless runner prints a line per emit; a benchmark owns its harness, so collect the events ourselves instead.
  wm.events.removeAllListeners('emit');
  const ev = { transfer: [], status: [], token: [], done: [], error: [] };
  wm.events.on('emit', (w, channel, args) => {
    const m = args[0];
    if (channel === 'llm:transfer') ev.transfer.push(m);
    else if (channel === 'llm:status') ev.status.push(m);
    else if (channel === 'llm:token') ev.token.push(m);
    else if (channel === 'llm:done') ev.done.push(m);
    else if (channel === 'llm:chat-error') ev.error.push(m);
  });

  await wm.waitForWindows(1, 30000);
  const init = await wm.invoke(win, 'llm:init');
  assert.ok(init.binary.present && init.binary.supported, `llama-server: ${JSON.stringify(init.binary)}`);
  assert.equal(init.gpu.granted, PHASE === 'gpu', `the GPU grant must be ${PHASE === 'gpu'} in phase ${PHASE} (granted: ${init.gpu.granted})`);
  log(`${entry.name} (${entry.quant}), phase ${PHASE}: ${init.vm.cpus} vCPUs, ${init.vm.memMiB} MiB VM, llama-server ${init.binary.label}`);

  // ---- the model must be in the app's data folder; the file was verified against models.json by the caller ----------------------------
  const target = path.join(store.dataDir(session.appId), 'models', entry.file);
  if (!(fs.existsSync(target) && fs.statSync(target).size === entry.bytes)) {
    dialogs.opts.open = () => [MODEL_FILE]; // the app's own import path (an open dialog); the answer is scripted
    const since = ev.transfer.length;
    const t0 = Date.now();
    const r = await wm.invoke(win, 'llm:import');
    assert.equal(r.started, true, JSON.stringify(r));
    const end = await waitFor(
      () => ev.transfer.slice(since).find((t) => t.kind === 'import' && ['done', 'error', 'cancelled'].includes(t.phase)),
      { timeoutMs: 1800000, intervalMs: 200, what: 'the model import' },
    );
    dialogs.opts.open = null;
    assert.equal(end.phase, 'done', JSON.stringify(end));
    assert.equal(fs.statSync(target).size, entry.bytes);
    log(`imported ${Math.round(entry.bytes / MiB)} MiB into the app's data in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  // ---- load, then measure -------------------------------------------------------------------------------------------------------------
  const since = ev.status.length;
  const tLoad = Date.now();
  assert.equal((await wm.invoke(win, 'llm:load', { name: entry.file, useGpu: PHASE === 'gpu', ctx: CTX })).started, true);
  const st = await waitFor(() => ev.status.slice(since).reverse().find((s) => s.state === 'ready' || s.state === 'error'), {
    timeoutMs: 900000,
    intervalMs: 100,
    what: `${entry.file} to load`,
  });
  if (st.state !== 'ready') throw new Error(`load failed: ${st.message}\n${(await wm.invoke(win, 'llm:logs')).lines.slice(-25).join('\n')}`);
  const loadMs = Date.now() - tLoad;
  assert.equal(st.threads, init.vm.cpus, 'llama-server uses every vCPU of the VM');
  assert.equal(st.gpu.requested, PHASE === 'gpu');
  assert.equal(st.gpu.active, PHASE === 'gpu', `the model must be on the GPU exactly in the gpu phase: ${JSON.stringify(st.gpu)}`);
  const logLines = (await wm.invoke(win, 'llm:logs')).lines;
  const evidence = logLines.filter((l) => /RPC|Metal|device|backend/i.test(l)).slice(0, 8).map((l) => l.trim().slice(0, 200));
  log(`loaded in ${(loadMs / 1000).toFixed(1)} s (${PHASE === 'gpu' ? `GPU: ${st.gpu.layers}/${st.gpu.totalLayers} layers, ${st.gpu.rpcMiB} MiB on the host` : `CPU, ${st.threads} threads`})`);

  async function chat(prompt, maxTokens) {
    const s0 = { token: ev.token.length, done: ev.done.length, error: ev.error.length };
    const { id } = await wm.invoke(win, 'llm:chat', { messages: [{ role: 'user', content: prompt }], temperature: 0, maxTokens });
    const end = await waitFor(() => ev.done.slice(s0.done).find((d) => d.id === id) || ev.error.slice(s0.error).find((d) => d.id === id), {
      timeoutMs: 600000,
      intervalMs: 50,
      what: `reply ${id}`,
    });
    assert.ok(end.stats, `chat error: ${JSON.stringify(end)}`);
    return end.stats;
  }

  await chat(PROMPT_GEN, 16); // warm-up: weights paged in, caches and the compute graph built
  const gen = [];
  const firstToken = [];
  for (let i = 0; i < RUNS; i++) {
    const s = await chat(PROMPT_GEN, GEN_TOKENS);
    assert.ok(s.genTps > 0 && s.genTokens >= GEN_TOKENS - 8, `generated ${s.genTokens} tokens at ${s.genTps}`);
    gen.push(s.genTps);
    firstToken.push(s.firstTokenMs);
    log(`generation ${i + 1}/${RUNS}: ${s.genTps.toFixed(1)} tokens/s (${s.genTokens} tokens)`);
  }
  const prompt = [];
  let promptTokens = null;
  for (let i = 0; i < RUNS; i++) {
    const s = await chat(`Document number ${1000 + i * 37}. Read this text and say OK. ${PROMPT_FILLER}`, 1);
    assert.ok(s.promptTokens >= 400, `the prompt was only ${s.promptTokens} tokens (cached?)`);
    promptTokens = s.promptTokens;
    prompt.push(s.promptTps);
    log(`prompt processing ${i + 1}/${RUNS}: ${s.promptTps.toFixed(0)} tokens/s (${s.promptTokens} tokens)`);
  }
  await wm.invoke(win, 'llm:unload');

  const result = {
    phase: PHASE,
    model: { id: entry.id, name: entry.name, quant: entry.quant, file: entry.file, bytes: entry.bytes, sha256: entry.sha256 },
    vm: init.vm,
    llamaServer: init.binary.label,
    context: CTX,
    threads: st.threads,
    gpu: st.gpu,
    loadMs,
    generation: { prompt: PROMPT_GEN, newTokens: GEN_TOKENS, runs: RUNS, tokensPerSecond: gen.map((x) => round(x, 2)), summary: Object.fromEntries(Object.entries(summarize(gen)).map(([k, v]) => [k, round(v, 2)])), firstTokenMs: firstToken },
    promptProcessing: { promptTokens, runs: RUNS, tokensPerSecond: prompt.map((x) => round(x, 1)), summary: Object.fromEntries(Object.entries(summarize(prompt)).map(([k, v]) => [k, round(v, 1)])) },
    logEvidence: evidence,
  };
  log(`${PHASE}: generation median ${result.generation.summary.median} tokens/s (min ${result.generation.summary.min}, max ${result.generation.summary.max}); prompt median ${result.promptProcessing.summary.median} tokens/s; load ${(loadMs / 1000).toFixed(1)} s`);
  if (process.env.BENCH_RESULTS) {
    fs.mkdirSync(path.dirname(process.env.BENCH_RESULTS), { recursive: true });
    fs.writeFileSync(process.env.BENCH_RESULTS, JSON.stringify(result, null, 2));
  }
}
