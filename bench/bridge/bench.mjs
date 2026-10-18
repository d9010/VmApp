// Bridge benchmark: round trips between the host (hostlib's AppSession, standing in for the loader) and a Node core inside its VM.
// Run it with the app in bench/bridge/app installed (tools/bench bridge does all of this):
//
//   vmapp run dev.bench.bridge --headless --script bench/bridge/bench.mjs
//
// What it measures, and how:
//   small      a sequential `invoke('echo', {i, s})`, awaited one at a time, timed with process.hrtime.bigint(); per-call latency
//   parallel   1000 `invoke('echo', i)` started at once and awaited together; calls per second
//   reply      one `invoke('blob', n)` at a time (the core builds a string of n characters); median time and MiB/s, for 1 KiB,
//              100 KiB, 1 MiB and 8 MiB
//   emit       the core sends 2000 messages of 100 bytes to the window (webContents.send); messages per second until the last arrives
// The whole block is repeated BENCH_RUNS rounds (default 5) in the same VM after a warm-up. The loader adds one Electron IPC hop on
// top of this path; that hop is not measured here (docs/PROTOCOL.md section 5).
//
// Environment: BENCH_RUNS (rounds, default 5), BENCH_RESULTS (a file to write the JSON result to).
import fs from 'node:fs';
import path from 'node:path';
import { median, summarize, round } from '../lib/stats.js';

const MiB = 1048576;
const ROUNDS = Math.max(1, Number(process.env.BENCH_RUNS || 5));
const SMALL_N = 1000;
const PARALLEL_N = 1000;
const EMIT_N = 2000;
const EMIT_BYTES = 100;
const REPLY_SIZES = [1024, 100 * 1024, 1024 * 1024, 8 * 1024 * 1024];
const REPLY_REPEATS = 10;

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

export default async function ({ session, wm }) {
  await wm.waitForWindows(1, 20000);
  const win = 1;
  const call = async (channel, ...args) => {
    const t0 = process.hrtime.bigint();
    await wm.invoke(win, channel, ...args);
    return ms(t0);
  };

  // `vmapp run --headless` prints a line for every emit it sees; printing 2000 lines would be part of what we time. A benchmark
  // owns its harness, so drop that listener and count the messages ourselves.
  wm.events.removeAllListeners('emit');
  let received = 0;
  let onAll = null;
  wm.events.on('emit', (w, channel) => {
    if (channel !== 'burst') return;
    received++;
    if (onAll && received >= EMIT_N) onAll();
  });
  const burst = async (timeoutMs = 20000) => {
    received = 0;
    const done = new Promise((resolve) => (onAll = resolve));
    const t0 = process.hrtime.bigint();
    await wm.invoke(win, 'burst', EMIT_N, EMIT_BYTES);
    let timer;
    await Promise.race([done, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`only ${received} of ${EMIT_N} emits arrived`)), timeoutMs)))]);
    clearTimeout(timer);
    onAll = null;
    return EMIT_N / (ms(t0) / 1000);
  };
  const parallelBatch = async () => {
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: PARALLEL_N }, (_, i) => wm.invoke(win, 'echo', i)));
    return PARALLEL_N / (ms(t0) / 1000);
  };

  // Warm-up, so that the first round is not slower than the rest (Node's JIT on both sides, buffers, the scheduler):
  // 500 sequential calls, 20 parallel batches, 3 bursts and a few big replies. None of it is counted.
  for (let i = 0; i < 500; i++) await wm.invoke(win, 'echo', i);
  for (let i = 0; i < 20; i++) await parallelBatch();
  for (let i = 0; i < 3; i++) await burst();
  for (let i = 0; i < 3; i++) await wm.invoke(win, 'blob', 8 * MiB);

  const small = [];
  const parallel = [];
  const reply = Object.fromEntries(REPLY_SIZES.map((s) => [s, []]));
  const emit = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < SMALL_N; i++) small.push(await call('echo', { i, s: 'hello' }));

    parallel.push(await parallelBatch());

    for (const size of REPLY_SIZES) {
      const ts = [];
      for (let i = 0; i < REPLY_REPEATS; i++) ts.push(await call('blob', size));
      reply[size].push(median(ts));
    }

    emit.push(await burst());
  }

  const r = {
    rounds: ROUNDS,
    vm: session.vmSize || null,
    smallInvoke: { calls: small.length, ...Object.fromEntries(Object.entries(summarize(small)).filter(([k]) => k !== 'n').map(([k, v]) => [`${k}Ms`, round(v, 4)])) },
    parallelInvoke: { calls: PARALLEL_N, callsPerSecond: summarize(parallel) },
    reply: Object.fromEntries(
      REPLY_SIZES.map((size) => {
        const med = median(reply[size]);
        return [size, { bytes: size, medianMs: round(med, 3), mibPerSecond: round(size / MiB / (med / 1000), 1), perRoundMedianMs: reply[size].map((x) => round(x, 3)) }];
      }),
    ),
    emit: { messages: EMIT_N, bytes: EMIT_BYTES, messagesPerSecond: summarize(emit) },
  };
  for (const k of ['callsPerSecond']) for (const f of Object.keys(r.parallelInvoke[k])) r.parallelInvoke[k][f] = round(r.parallelInvoke[k][f], 0);
  for (const f of Object.keys(r.emit.messagesPerSecond)) r.emit.messagesPerSecond[f] = round(r.emit.messagesPerSecond[f], 0);

  console.log(`BENCH rounds: ${ROUNDS}`);
  console.log(`BENCH sequential small invoke (n=${small.length}): median ${r.smallInvoke.medianMs} ms, p95 ${r.smallInvoke.p95Ms} ms, p99 ${r.smallInvoke.p99Ms} ms`);
  console.log(`BENCH ${PARALLEL_N} concurrent small invokes: median ${r.parallelInvoke.callsPerSecond.median} calls/s (rounds: ${parallel.map((x) => Math.round(x)).join(', ')})`);
  for (const size of REPLY_SIZES) console.log(`BENCH reply of ${size / 1024} KiB: median ${r.reply[size].medianMs} ms (${r.reply[size].mibPerSecond} MiB/s)`);
  console.log(`BENCH ${EMIT_N} core->UI emits (${EMIT_BYTES} B each): median ${r.emit.messagesPerSecond.median} msgs/s (rounds: ${emit.map((x) => Math.round(x)).join(', ')})`);

  if (process.env.BENCH_RESULTS) {
    fs.mkdirSync(path.dirname(process.env.BENCH_RESULTS), { recursive: true });
    fs.writeFileSync(process.env.BENCH_RESULTS, JSON.stringify(r, null, 2));
  }
}
