// VM start benchmark: how long from spawning the per-app VM to (1) vmapp-vm's "ready" line and (2) the app core's first message,
// the memory the VM costs the Mac, and how fast a VM disappears when its parent is killed with `kill -9`.
//
//   node bench/boot/boot.mjs        (tools/bench boot sets the environment and installs the bench app first)
//
// Three measurements, each BENCH_RUNS times (default 20) after one discarded warm-up run:
//   app    a real Node app (bench/bridge/app, runtime node22, 1 vCPU, 256 MiB) started through hostlib's AppSession, the same code
//          the loader runs. spawnToReady = vmapp-vm spawned -> its {"ready":true} line. spawnToCore = spawned -> the core's first
//          message (the SDK's "ready", which AppSession.start() waits for). spawnToWindow = spawned -> the core's first window
//          request (the point where the loader would show a window).
//   raw    the floor: vmapp-vm with the native runtime and the tiny Rust test core tests/core-echo, no AppSession. spawnToCore = spawned
//          -> the first reply to a request on the bridge socket.
//   kill   raw VMs whose parent process is killed with SIGKILL: time until vmapp-vm has exited and until the VM process of
//          Virtualization.framework is gone.
// VM memory: the memory of the VM's Virtualization.framework process (com.apple.Virtualization.VirtualMachine), found as the one new
// process after the VM started, read right at the first window (first reply for `raw`) and again 1 s later, by two measures: the
// "physical footprint" of macOS' footprint tool (memory the process owns and has dirtied: the guest RAM the guest touched; this is
// the figure to quote) and ps' RSS (which also counts clean pages of files the VM maps, so it is higher). A sample is skipped when
// another VM starts on this Mac at the same moment (the process cannot be told apart); the count is reported as samplesSkipped.
//
// Environment: VMAPP_HOME (the data root with the installed bench app and the node22 runtime), BENCH_APP_ID (default dev.bench.bridge),
// BENCH_RUNS (default 20), BENCH_DIR (scratch folder), BENCH_RESULTS (JSON file to write), BENCH_ONLY (comma list of app,raw,kill).
// VMAPP_VM, VMAPP_KERNEL and VMAPP_INITRAMFS override the built files in out/, as for tools/vmapp.
import cp from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { summarize, round } = require('../lib/stats.js');
const hostlib = require(path.join(ROOT, 'hostlib'));
const { Store, AppSession, FakeWindowManager, FakeDialogs } = hostlib;

const RUNS = Math.max(1, Number(process.env.BENCH_RUNS || 20));
const APP_ID = process.env.BENCH_APP_ID || 'dev.bench.bridge';
const ONLY = new Set((process.env.BENCH_ONLY || 'app,raw,kill').split(',').map((s) => s.trim()).filter(Boolean));
const OUT = path.join(ROOT, 'out');
const VM = process.env.VMAPP_VM || path.join(OUT, 'vmapp-vm');
const KERNEL = process.env.VMAPP_KERNEL || path.join(OUT, 'Image');
const INITRAMFS = process.env.VMAPP_INITRAMFS || path.join(OUT, 'initramfs.cpio');
const RAW_RUNTIME = path.join(OUT, 'runtimes', 'native.img');
const RAW_CORE = process.env.VMAPP_CORE_ECHO || path.join(OUT, 'test', 'core-echo.cpio');
const SCRATCH = path.resolve(process.env.BENCH_DIR || path.join(process.env.VMAPP_WORK || path.join(OUT, 'work'), 'bench', 'boot'));
const RAW_START = JSON.stringify({ command: ['/app/core-echo'], workdir: '/app', env: ['X=1'] });
const SETTLE_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const log = (m) => console.log(`BENCH ${m}`);

// ---- the VM's own process (Virtualization.framework runs each VM in an XPC service) ---------------------------------------------
function vzPids() {
  const r = cp.spawnSync('pgrep', ['-f', 'com.apple.Virtualization.VirtualMachine'], { encoding: 'utf8' });
  return new Set(
    (r.stdout || '')
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0),
  );
}
/**
 * What a VM costs the Mac, in MiB, by two measures: `rss` is ps' resident set size (it includes clean pages of files the VM maps, such
 * as the runtime image), and `footprint` is macOS' "physical footprint" from the footprint tool (the memory the process owns and has
 * dirtied: guest RAM that the guest touched, plus the VMM's own). Footprint is the better answer to "how much memory does this VM take".
 */
function memoryMiB(pid) {
  if (!pid) return { rss: null, footprint: null };
  const ps = cp.spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  const kb = Number((ps.stdout || '').trim());
  const fp = cp.spawnSync('footprint', ['-f', 'bytes', String(pid)], { encoding: 'utf8' });
  const m = /Footprint:\s*(\d+) B/.exec(fp.stdout || '');
  return { rss: kb > 0 ? kb / 1024 : null, footprint: m ? Number(m[1]) / 1048576 : null };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** The one VM process that was not there before; null (and a note) when there are none or several. */
function newVzPid(before, skipped) {
  const fresh = [...vzPids()].filter((p) => !before.has(p));
  if (fresh.length === 1) return fresh[0];
  skipped.count++;
  return null;
}
async function waitGone(pid, timeoutMs = 10000) {
  const t0 = now();
  while (alive(pid)) {
    if (now() - t0 > timeoutMs) return null;
    await sleep(2);
  }
  return now() - t0;
}

function stats(list, digits = 1) {
  const s = summarize(list);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'n' ? v : round(v, digits)]));
}

// ---- app: AppSession, the loader's own path -------------------------------------------------------------------------------------
async function runApp() {
  const store = new Store({});
  const app = store.get(APP_ID);
  if (!app) throw new Error(`app ${APP_ID} is not installed in ${store.home}`);
  const rows = { spawnToReady: [], spawnToCore: [], spawnToWindow: [], stop: [], rssFirst: [], rssAfter1s: [], footprintFirst: [], footprintAfter1s: [] };
  const skipped = { count: 0 };
  let vmSize = null;
  let first = null;

  for (let i = 0; i <= RUNS; i++) {
    const warm = i === 0;
    const before = vzPids();
    const wm = new FakeWindowManager();
    let tSpawn = null;
    let tReady = null;
    let tCore = null;
    let tWindow = null;
    const session = new AppSession({
      appId: APP_ID,
      store,
      vmappVmPath: VM,
      kernel: KERNEL,
      initramfs: INITRAMFS,
      windowManager: wm,
      dialogs: new FakeDialogs(),
      onLog: (e) => {
        if (e.level === 'debug' && e.source === 'host' && e.message.startsWith('spawn ')) tSpawn = now();
        else if (e.source === 'host' && e.message.startsWith('VM ready')) tReady = now();
        else if (e.source === 'host' && e.message === 'core ready') tCore = now();
        else if (e.level === 'error') console.error(`[${e.source}] ${e.message}`);
      },
    });
    wm.attach(session);
    wm.events.on('window-created', () => {
      if (tWindow === null) tWindow = now();
    });
    const tCall = now();
    await session.start();
    await wm.waitForWindows(1, 15000);
    vmSize = session.vmSize;
    const t0 = tSpawn === null ? tCall : tSpawn;
    const vz = newVzPid(before, skipped);
    const m1 = memoryMiB(vz); // right when the first window has been requested
    await sleep(SETTLE_MS);
    const m2 = memoryMiB(vz); // one second later
    const tStop = now();
    await session.stop();
    const stopMs = now() - tStop;
    if (vz) await waitGone(vz);
    const sample = {
      spawnToReady: tReady - t0, spawnToCore: tCore - t0, spawnToWindow: tWindow - t0, stop: stopMs,
      rssFirst: m1.rss, rssAfter1s: m2.rss, footprintFirst: m1.footprint, footprintAfter1s: m2.footprint,
    };
    if (warm) {
      first = sample;
      continue;
    }
    for (const k of Object.keys(rows)) if (sample[k] !== null) rows[k].push(sample[k]);
    if (i % 5 === 0 || i === RUNS) log(`app ${i}/${RUNS}: ready ${sample.spawnToReady.toFixed(0)} ms, core ${sample.spawnToCore.toFixed(0)} ms, window ${sample.spawnToWindow.toFixed(0)} ms, VM memory ${m2.footprint === null ? 'n/a' : m2.footprint.toFixed(0) + ' MiB footprint, ' + m2.rss.toFixed(0) + ' MiB RSS'}`);
  }
  return {
    description: 'a Node app (runtime node22) started through hostlib AppSession',
    appId: APP_ID,
    runtime: app.manifest.runtime,
    vm: vmSize,
    runs: RUNS,
    discardedWarmUp: first && Object.fromEntries(Object.entries(first).map(([k, v]) => [k, round(v, 1)])),
    spawnToReadyMs: stats(rows.spawnToReady),
    spawnToCoreMs: stats(rows.spawnToCore),
    spawnToWindowMs: stats(rows.spawnToWindow),
    stopMs: stats(rows.stop),
    vmProcessMemory: {
      footprintAtFirstWindowMiB: stats(rows.footprintFirst),
      footprintAfter1sMiB: stats(rows.footprintAfter1s),
      rssAtFirstWindowMiB: stats(rows.rssFirst),
      rssAfter1sMiB: stats(rows.rssAfter1s),
      samplesSkipped: skipped.count,
    },
  };
}

// ---- raw: vmapp-vm + native runtime + the echo core -----------------------------------------------------------------------------
function rawArgs(dir, sock) {
  return [
    'run', '--kernel', KERNEL, '--initramfs', INITRAMFS, '--runtime', RAW_RUNTIME, '--core', RAW_CORE,
    '--appdata', path.join(dir, 'appdata'), '--start', RAW_START, '--socket', sock, '--console', path.join(dir, 'console.log'),
  ];
}
const TEMP_PREFIX = '/tmp/vmapp-bench-';
function shortTempDir() {
  return fs.mkdtempSync(TEMP_PREFIX); // a Unix socket path must be short (SUN_LEN), so not under the long work folder
}
function removeTempDir(dir) {
  if (dir.startsWith(TEMP_PREFIX)) fs.rmSync(dir, { recursive: true, force: true }); // only what shortTempDir() made
}
/** Sends one request line to the core on the bridge socket and resolves when its reply line arrives. */
function askCore(sock, line, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error('no reply from the core'));
    }, timeoutMs);
    s.on('connect', () => s.write(line + '\n'));
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        clearTimeout(t);
        s.destroy();
        resolve(buf.split('\n')[0]);
      }
    });
    s.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
function readyLine(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('timed out waiting for the ready line')), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      for (const l of buf.split('\n')) {
        if (!l.includes('"ready"')) continue;
        try {
          const o = JSON.parse(l);
          if (o.ready) {
            clearTimeout(t);
            resolve(o);
            return;
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`vmapp-vm exited early (${code})`));
    });
  });
}

async function runRaw() {
  const dir = shortTempDir();
  fs.mkdirSync(path.join(dir, 'appdata'), { recursive: true });
  const rows = { spawnToReady: [], spawnToCore: [], stop: [], rssFirst: [], rssAfter1s: [], footprintFirst: [], footprintAfter1s: [] };
  const skipped = { count: 0 };
  let first = null;
  try {
    for (let i = 0; i <= RUNS; i++) {
      const sock = path.join(dir, 'b.sock');
      const before = vzPids();
      const t0 = now();
      const child = cp.spawn(VM, rawArgs(dir, sock), { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', () => {});
      const exited = new Promise((r) => child.on('exit', r));
      const ready = await readyLine(child);
      const tReady = now() - t0;
      const reply = await askCore(ready.socket || sock, 'ENV');
      if (!reply.includes('VMAPP_ID')) throw new Error(`unexpected reply from the echo core: ${reply.slice(0, 120)}`);
      const tCore = now() - t0;
      const vz = newVzPid(before, skipped);
      const m1 = memoryMiB(vz); // right after the first reply
      await sleep(SETTLE_MS);
      const m2 = memoryMiB(vz); // one second later
      const tStop = now();
      child.stdin.end(); // EOF on stdin = graceful shutdown (tests/e2e.sh scenario 7)
      await exited;
      const stopMs = now() - tStop;
      if (vz) await waitGone(vz);
      const sample = {
        spawnToReady: tReady, spawnToCore: tCore, stop: stopMs,
        rssFirst: m1.rss, rssAfter1s: m2.rss, footprintFirst: m1.footprint, footprintAfter1s: m2.footprint,
      };
      if (i === 0) {
        first = sample;
        continue;
      }
      for (const k of Object.keys(rows)) if (sample[k] !== null) rows[k].push(sample[k]);
      if (i % 5 === 0 || i === RUNS) log(`raw ${i}/${RUNS}: ready ${tReady.toFixed(0)} ms, first reply ${tCore.toFixed(0)} ms, VM memory ${m2.footprint === null ? 'n/a' : m2.footprint.toFixed(0) + ' MiB footprint, ' + m2.rss.toFixed(0) + ' MiB RSS'}`);
    }
  } finally {
    removeTempDir(dir);
  }
  return {
    description: 'vmapp-vm with the native runtime and the Rust test core tests/core-echo (the floor: no Node, no AppSession)',
    runs: RUNS,
    discardedWarmUp: first && Object.fromEntries(Object.entries(first).map(([k, v]) => [k, round(v, 1)])),
    spawnToReadyMs: stats(rows.spawnToReady),
    spawnToCoreMs: stats(rows.spawnToCore),
    stopMs: stats(rows.stop),
    vmProcessMemory: {
      footprintAtFirstReplyMiB: stats(rows.footprintFirst),
      footprintAfter1sMiB: stats(rows.footprintAfter1s),
      rssAtFirstReplyMiB: stats(rows.rssFirst),
      rssAfter1sMiB: stats(rows.rssAfter1s),
      samplesSkipped: skipped.count,
    },
  };
}

// ---- kill: the parent dies with SIGKILL; the VM must not outlive it ---------------------------------------------------------------
async function runKill() {
  const dir = shortTempDir();
  fs.mkdirSync(path.join(dir, 'appdata'), { recursive: true });
  const toVm = [];
  const toVz = [];
  const both = [];
  const startRetries = [];
  let skipped = 0;
  try {
    for (let i = 0; i < RUNS; i++) {
      // A VM that fails to start (the Mac was busy, a socket was not yet released) is tried again, up to 3 times, and counted.
      let started = null;
      let before;
      for (let attempt = 1; !started; attempt++) {
        const sock = path.join(dir, `b${i}-${attempt}.sock`);
        before = vzPids();
        const parent = cp.spawn(process.execPath, [path.join(HERE, 'parent.mjs'), VM, ...rawArgs(dir, sock)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        parent.stderr.on('data', (d) => (err += d));
        try {
          const lines = await new Promise((resolve, reject) => {
            let buf = '';
            const t = setTimeout(() => reject(new Error('the parent helper did not report a ready VM')), 30000);
            parent.stdout.on('data', (d) => {
              buf += d;
              if (/"ready":true/.test(buf) && /^PID \d+/m.test(buf)) {
                clearTimeout(t);
                resolve(buf);
              }
            });
            parent.on('close', (code) => {
              clearTimeout(t);
              reject(new Error(`the parent helper exited early (${code}): ${buf.replace(/\s+/g, ' ').slice(-200)} ${err.replace(/\s+/g, ' ').slice(-300)}`));
            });
          });
          started = { parent, lines };
        } catch (e) {
          startRetries.push(e.message);
          log(`kill ${i + 1}/${RUNS}: start failed (attempt ${attempt}): ${e.message}`);
          try {
            process.kill(parent.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
          if (attempt >= 3) throw e;
          await sleep(1000);
        }
      }
      const { parent, lines } = started;
      const vmPid = Number(/^PID (\d+)/m.exec(lines)[1]);
      await sleep(300); // as tests/e2e.sh scenario 6: the VM has been running for a moment
      const skip = { count: 0 };
      const vz = newVzPid(before, skip);
      if (!vz) skipped++;
      process.kill(parent.pid, 'SIGKILL'); // both waits below start right after this
      const [tVm, tVz] = await Promise.all([waitGone(vmPid), vz ? waitGone(vz) : Promise.resolve(null)]);
      if (tVm === null) throw new Error(`vmapp-vm (pid ${vmPid}) is still running 10 s after its parent was killed`);
      toVm.push(tVm);
      if (tVz !== null) {
        toVz.push(tVz);
        both.push(Math.max(tVm, tVz));
      }
      if ((i + 1) % 5 === 0 || i + 1 === RUNS) log(`kill ${i + 1}/${RUNS}: vmapp-vm gone after ${tVm.toFixed(0)} ms, VM process gone after ${tVz === null ? 'n/a' : tVz.toFixed(0) + ' ms'}`);
    }
  } finally {
    removeTempDir(dir);
  }
  return {
    description: 'raw VMs whose parent process is killed with SIGKILL',
    runs: RUNS,
    killToVmappVmGoneMs: stats(toVm),
    killToVmProcessGoneMs: stats(toVz),
    killToBothGoneMs: stats(both),
    vmProcessSkipped: skipped,
    startRetries,
  };
}

// ---- main -------------------------------------------------------------------------------------------------------------------------
const result = {
  runs: RUNS,
  host: { cpus: os.cpus().length, loadAvgAtStart: os.loadavg().map((x) => round(x, 2)) },
  files: { vm: VM, kernel: KERNEL, initramfs: INITRAMFS },
};
fs.mkdirSync(SCRATCH, { recursive: true });
if (ONLY.has('app')) result.app = await runApp();
if (ONLY.has('raw')) result.raw = await runRaw();
if (ONLY.has('kill')) result.kill = await runKill();
result.host.loadAvgAtEnd = os.loadavg().map((x) => round(x, 2));

if (process.env.BENCH_RESULTS) {
  fs.mkdirSync(path.dirname(process.env.BENCH_RESULTS), { recursive: true });
  fs.writeFileSync(process.env.BENCH_RESULTS, JSON.stringify(result, null, 2));
}
const fmt = (s) => (s && s.median !== null ? `median ${s.median} p95 ${s.p95} (min ${s.min}, max ${s.max})` : 'n/a');
if (result.app) {
  log(`app: spawn -> ready ${fmt(result.app.spawnToReadyMs)} ms`);
  log(`app: spawn -> first core message ${fmt(result.app.spawnToCoreMs)} ms`);
  log(`app: spawn -> first window ${fmt(result.app.spawnToWindowMs)} ms`);
  log(`app: VM memory footprint 1 s after the first window ${fmt(result.app.vmProcessMemory.footprintAfter1sMiB)} MiB; RSS ${fmt(result.app.vmProcessMemory.rssAfter1sMiB)} MiB`);
}
if (result.raw) {
  log(`raw: spawn -> ready ${fmt(result.raw.spawnToReadyMs)} ms`);
  log(`raw: spawn -> first reply ${fmt(result.raw.spawnToCoreMs)} ms`);
  log(`raw: VM memory footprint 1 s after the first reply ${fmt(result.raw.vmProcessMemory.footprintAfter1sMiB)} MiB; RSS ${fmt(result.raw.vmProcessMemory.rssAfter1sMiB)} MiB`);
}
if (result.kill) log(`kill -9 of the parent -> VM gone ${fmt(result.kill.killToBothGoneMs)} ms`);
process.exit(0);
