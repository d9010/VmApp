// The GPU capability against the REAL thing on this Mac (SPEC 8.6): the sandboxed Metal rpc-server of gpu/, started by the loader's own
// code (hostlib GpuBroker -> hostproc GpuServer -> /usr/bin/sandbox-exec with gpu/rpc-server.sb), and a real llama.cpp client built from
// the same pinned commit (CPU only, gpu/build.sh --client) that offloads a small model to it over RPC.
//
//   tests/gpu/run.sh            builds what is missing, downloads the model once, runs this
//
// What it checks:
//   1. the server starts under the sandbox, listens on 127.0.0.1 only, and the client connects to it
//   2. the client offloads every layer to RPC0 (the log shows the RPC0 buffer) and generates the right words
//   3. throughput numbers (llama-bench: prompt processing and generation, tokens per second)
//   4. the sandbox really confines: with the same profile a program cannot write a file, read the user's files, start another
//      program, connect out, or bind a port other than the assigned one; and the server cannot bind another port either
// Environment: VMAPP_WORK (default vmapp/out/work); GPU_MODEL, GPU_CLIENT_BIN to override the model and the client folder.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = path.resolve(process.env.VMAPP_WORK || path.join(ROOT, 'out', 'work'));
const OUT = path.join(ROOT, 'out', 'gpu');
const SERVER = process.env.VMAPP_GPU_SERVER || path.join(OUT, 'rpc-server');
const PROFILE = process.env.VMAPP_GPU_PROFILE || path.join(ROOT, 'gpu', 'rpc-server.sb');
const CLIENTS = process.env.GPU_CLIENT_BIN || path.join(WORK, 'gpu-client', 'bin');
const MODEL = process.env.GPU_MODEL || path.join(WORK, 'cache', 'models', 'smollm2-360m-instruct-q8_0.gguf');
const SCRATCH = path.join(WORK, 'scratch', 'gpu-host-test');
const { GpuBroker } = require(path.join(ROOT, 'hostlib', 'gpu.js'));
const { metalCacheRoot } = require(path.join(ROOT, 'hostlib', 'hostproc.js'));

let passes = 0;
let fails = 0;
const results = { passes: [], fails: [] };
function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    results.passes.push(name);
    console.log(`PASS: ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    fails++;
    results.fails.push(name);
    console.log(`FAIL: ${name}${detail ? `  (${detail})` : ''}`);
  }
}
const info = (s) => console.log(`  info: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listening(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function waitListening(port, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await listening(port)) return Date.now() - t0;
    await sleep(150);
  }
  return null;
}

/** Runs a client binary, resolves {code, out} (stdout and stderr together). */
function run(cmd, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, out });
    });
  });
}

/** Runs a program under the GPU server's own sandbox profile (BIN is that program), like GpuServer does for the server. */
function sandboxed(bin, args, port, { cwd = SCRATCH, timeoutMs = 20000 } = {}) {
  const cache = metalCacheRoot();
  const a = ['-f', PROFILE, '-D', `BIN=${bin}`, '-D', `BINDIR=${path.dirname(bin)}`, '-D', `PORT=${port}`];
  if (cache) a.push('-D', `METAL_CACHE=${cache}`);
  return spawnSync('/usr/bin/sandbox-exec', [...a, bin, ...args], { encoding: 'utf8', cwd, timeout: timeoutMs });
}

async function main() {
  for (const [what, f] of [['the server (gpu/build.sh)', SERVER], ['the sandbox profile', PROFILE], ['llama-completion (gpu/build.sh --client)', path.join(CLIENTS, 'llama-completion')], ['llama-bench (gpu/build.sh --client)', path.join(CLIENTS, 'llama-bench')], ['the model (tests/gpu/run.sh)', MODEL]]) {
    if (!fs.existsSync(f)) {
      console.log(`missing ${what}: ${f}`);
      process.exit(2);
    }
  }
  fs.mkdirSync(SCRATCH, { recursive: true });
  const secret = path.join(SCRATCH, 'secret.txt');
  fs.writeFileSync(secret, 'the user’s private file\n');
  console.log(`== GPU host test on ${os.cpus()[0].model}, macOS ${os.release()} (Darwin)`);
  console.log(`   server ${SERVER}`);
  console.log(`   model  ${MODEL} (${(fs.statSync(MODEL).size / 1048576).toFixed(0)} MiB)`);

  // ---- 1. start the server the way the loader does ----
  const broker = new GpuBroker({ binary: SERVER, profile: PROFILE, home: SCRATCH });
  check('the broker finds the server and the platform', broker.availability().ok, broker.availability().reason || '');
  const t0 = Date.now();
  const srv = await broker.start('host-test', { appId: 'dev.vmapp.gpu-test', appName: 'GPU host test' });
  info(`server pid ${srv.pid} on ${srv.endpoint} (started in ${Date.now() - t0} ms; ${metalCacheRoot() ? 'shader cache' : 'no shader cache'})`);
  try {
    const waited = await waitListening(srv.port, 120000);
    check('the sandboxed server listens on 127.0.0.1 (cold start can take 15 s while macOS compiles the shaders)', waited !== null, waited !== null ? `${waited} ms` : 'never');
    check('it is a running process that ps sees', spawnSync('/bin/ps', ['-p', String(srv.pid)]).status === 0);
    // it listens on the loopback address only: not on this Mac's other addresses
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) check(`it does not listen on ${lan.address} (the network address of this Mac)`, !(await listening(srv.port, lan.address)));
    else info('no non-loopback address on this Mac to test against');
    assert.ok(waited !== null, 'the server never started listening; stopping');

    // ---- 2. a real client offloads a model to it ----
    const comp = await run(path.join(CLIENTS, 'llama-completion'), ['-lv', '4', '-m', MODEL, '-ngl', '99', '--rpc', srv.endpoint, '-p', 'The capital of France is', '-n', '48', '-no-cnv', '--temp', '0', '-s', '1']);
    fs.writeFileSync(path.join(SCRATCH, 'completion.log'), comp.out);
    check('llama-completion exits 0', comp.code === 0, `exit ${comp.code}${comp.signal ? ` ${comp.signal}` : ''}`);
    const buf = /RPC0\[127\.0\.0\.1:(\d+)\] model buffer size =\s+([\d.]+) MiB/.exec(comp.out);
    check('the log shows an RPC0 model buffer on our port (the weights live on the GPU server)', !!buf && Number(buf[1]) === srv.port, buf ? `${buf[2]} MiB on port ${buf[1]}` : 'no RPC0 buffer line');
    check('... of the size of the model', !!buf && Number(buf[2]) > 300);
    const off = /offloaded (\d+)\/(\d+) layers to GPU/.exec(comp.out);
    check('every layer is offloaded (to RPC0)', !!off && off[1] === off[2], off ? `${off[1]}/${off[2]}` : 'no offload line');
    check('the KV cache and compute buffers are on RPC0 too', /RPC0\[127\.0\.0\.1:\d+\] KV buffer size/.test(comp.out) && /RPC0\[127\.0\.0\.1:\d+\] compute buffer size/.test(comp.out));
    check('the model answers: “Paris”', /Paris/.test(comp.out.split('generate:')[1] || comp.out));
    const ev = /eval time =\s+[\d.]+ ms \/\s+(\d+) runs\s+\(\s+[\d.]+ ms per token,\s+([\d.]+) tokens per second\)/.exec(comp.out);
    const pe = /prompt eval time =\s+[\d.]+ ms \/\s+(\d+) tokens \(\s+[\d.]+ ms per token,\s+([\d.]+) tokens per second\)/.exec(comp.out);
    check('tokens were generated and timed', !!ev && Number(ev[1]) >= 20, ev ? `${ev[1]} tokens at ${ev[2]} tokens/s` : 'no timing line');
    results.completion = { generatedTokens: ev ? Number(ev[1]) : null, tokensPerSecond: ev ? Number(ev[2]) : null, promptTokensPerSecond: pe ? Number(pe[2]) : null };

    // ---- 3. numbers ----
    const bench = await run(path.join(CLIENTS, 'llama-bench'), ['-m', MODEL, '-ngl', '99', '--rpc', srv.endpoint, '-p', '512', '-n', '128', '-r', '3', '-o', 'json']);
    let rows = [];
    try {
      rows = JSON.parse(bench.out.slice(bench.out.indexOf('[')));
    } catch {
      /* reported below */
    }
    const pp = rows.find((r) => r.n_prompt === 512 && r.n_gen === 0);
    const tg = rows.find((r) => r.n_gen === 128 && r.n_prompt === 0);
    check('llama-bench ran over RPC', !!pp && !!tg && /RPC/.test(`${pp.backends}`), pp ? `backends ${pp.backends}` : bench.out.slice(-300));
    if (pp && tg) {
      info(`prompt processing (512 tokens): ${pp.avg_ts.toFixed(1)} tokens/s; generation (128 tokens): ${tg.avg_ts.toFixed(1)} tokens/s`);
      results.bench = { model: MODEL, ppTokensPerSecond: pp.avg_ts, tgTokensPerSecond: tg.avg_ts, backends: pp.backends };
    }
    check('the server is still up after the clients disconnected', await listening(srv.port));

    // ---- 4. the sandbox confines ----
    console.log('-- the sandbox (the same profile, other programs)');
    const outFile = path.join(SCRATCH, 'must-not-exist.txt');
    let r = sandboxed('/usr/bin/touch', [outFile], 1);
    check('cannot write a file', r.status !== 0 && !fs.existsSync(outFile), `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 80)}`);
    r = sandboxed('/bin/cat', [secret], 1);
    check('cannot read the user’s files', r.status !== 0 && !/private file/.test(r.stdout || ''), `exit ${r.status}`);
    r = sandboxed('/bin/ls', [os.homedir()], 1);
    check('cannot list the home folder', r.status !== 0 && !(r.stdout || '').trim(), `exit ${r.status}`);
    r = sandboxed('/bin/echo', ['hello'], 1);
    check('(control) the profile lets its own program run', r.status === 0 && /hello/.test(r.stdout || ''), `exit ${r.status}`);
    r = spawnSync('/usr/bin/sandbox-exec', ['-f', PROFILE, '-D', 'BIN=/bin/echo', '-D', 'BINDIR=/bin', '-D', 'PORT=1', '/usr/bin/true'], { encoding: 'utf8' });
    check('cannot start any other program', r.status !== 0, `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 80)}`);
    // a listener elsewhere on this Mac: reachable without the sandbox, not with it
    const bait = net.createServer((s) => s.end('bait'));
    await new Promise((res) => bait.listen(0, '127.0.0.1', res));
    const baitPort = bait.address().port;
    const free = spawnSync('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', String(baitPort)]);
    check('(control) the bait listener is reachable without the sandbox', free.status === 0);
    r = sandboxed('/usr/bin/nc', ['-z', '-w', '2', '127.0.0.1', String(baitPort)], srv.port);
    check('cannot connect out (not even to this Mac’s loopback)', r.status !== 0, `exit ${r.status}`);
    r = sandboxed('/usr/bin/nc', ['-z', '-w', '2', '93.184.216.34', '80'], srv.port);
    check('cannot reach the internet', r.status !== 0, `exit ${r.status}`);
    bait.close();
    // binding: only the assigned port
    const other = await new Promise((res) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => res(p));
      });
    });
    r = sandboxed('/usr/bin/nc', ['-l', '127.0.0.1', String(other)], 1, { timeoutMs: 4000 });
    check('cannot bind a port other than the assigned one (netcat)', r.status !== 0 && !(await listening(other)), `exit ${r.status}`);
    // the server itself, told to use another port than its profile allows
    const rogue = spawn('/usr/bin/sandbox-exec', ['-f', PROFILE, '-D', `BIN=${SERVER}`, '-D', `BINDIR=${path.dirname(SERVER)}`, '-D', 'PORT=1', SERVER, '--host', '127.0.0.1', '--port', String(other), '--device', 'MTL0'], { stdio: 'ignore' });
    await sleep(6000);
    check('the server cannot listen on a port its profile does not name', !(await listening(other)));
    rogue.kill('SIGKILL');
  } finally {
    await broker.stopAll('test-done');
  }
  check('stopping the broker stops the server', !(await listening(srv.port)) && spawnSync('/bin/ps', ['-p', String(srv.pid)]).status !== 0);
  fs.writeFileSync(path.join(WORK, 'gpu-host-test.json'), JSON.stringify({ at: new Date().toISOString(), machine: os.cpus()[0].model, results }, null, 2) + '\n');
}

try {
  await main();
} catch (e) {
  console.log(`FAIL: test aborted: ${e && e.stack ? e.stack : e}`);
  fails++;
}
console.log(`\n${passes} passed, ${fails} failed`);
if (!fails) console.log('ALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
