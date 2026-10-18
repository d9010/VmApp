#!/usr/bin/env node
'use strict';
// The report of `tests/gpu-vulkan/run.sh --bench` (EXPERIMENTAL Vulkan backend, SPEC 8.7; docs/BENCHMARKS.md section 8).
//
//   node tests/gpu-vulkan/bench-report.js --model FILE --reps N
//        --vm-vkpeak LOG --vm-llama LOG [--vm-info LOG]
//        [--native-vkpeak LOG] [--native-metal LOG] [--native-moltenvk LOG] [--native-source TEXT]
//        [--cpus N] [--memory MiB] [--window MiB]
//
// The logs are the raw output of the commands (a VM console log, whose lines start with "core: ", or a native command's own
// output); bench/vulkan/parse.js reads both. It prints a human table and, as the LAST line of stdout, ONE JSON object: the
// contract of `tools/bench vulkan` (docs/BENCHMARKS.md section 8). Exit status 0 when the VM's numbers are there, 1 when not (the
// JSON then carries "error").
const fs = require('fs');
const path = require('path');
const { parseVkpeak, parseLlamaBench, parseInfo } = require('../../bench/vulkan/parse.js');

const r1 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const pct = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const fmt = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
const fmtPct = (x) => (x === null || x === undefined ? '-' : `${x.toFixed(0)}%`);

/**
 * @param {object} o  {model, reps, vm: {vkpeak, llama, info}, native: {vkpeak, metal, moltenvk, source} | null, vmConfig: {cpus, memoryMiB, gpuWindowMiB}}
 *   where vkpeak/llama/info/metal/moltenvk are the parsed logs (bench/vulkan/parse.js) or null.
 * @returns {{ok: boolean, text: string, json: object}}
 */
function buildReport(o) {
  const vk = o.vm.vkpeak;
  const ll = o.vm.llama;
  const nat = o.native || null;
  const json = { backend: 'vmapp-vm-krun' };
  const missing = [];
  if (!vk || !vk.metrics['fp32-scalar']) missing.push('vkpeak fp32-scalar');
  if (!ll || !ll.pp512) missing.push('llama-bench pp512');
  if (!ll || !ll.tg128) missing.push('llama-bench tg128');

  json.vkpeak_fp32_gflops = vk && vk.metrics['fp32-scalar'] ? r1(vk.metrics['fp32-scalar'].value) : null;
  json.llama_pp512 = ll && ll.pp512 ? r1(ll.pp512.mean) : null;
  json.llama_tg128 = ll && ll.tg128 ? r1(ll.tg128.mean) : null;
  json.model = o.model;
  json.device = (o.vm.info && o.vm.info.deviceName) || null;
  json.vkpeak_copy_d2d_gbps = vk && vk.metrics['copy-d2d'] ? r1(vk.metrics['copy-d2d'].value) : null;
  json.llama_pp512_sd = ll && ll.pp512 ? r1(ll.pp512.sd) : null;
  json.llama_tg128_sd = ll && ll.tg128 ? r1(ll.tg128.sd) : null;
  json.llama_build = (ll && ll.build) || null;
  json.repetitions = o.reps;
  json.vm = o.vmConfig || null;

  let nj = null;
  if (nat) {
    const n = (p, k) => (p && p[k] ? r1(p[k].mean) : null);
    nj = {
      source: nat.source || null,
      vkpeak_fp32_gflops: nat.vkpeak && nat.vkpeak.metrics['fp32-scalar'] ? r1(nat.vkpeak.metrics['fp32-scalar'].value) : null,
      vkpeak_copy_d2d_gbps: nat.vkpeak && nat.vkpeak.metrics['copy-d2d'] ? r1(nat.vkpeak.metrics['copy-d2d'].value) : null,
      metal: nat.metal ? { pp512: n(nat.metal, 'pp512'), tg128: n(nat.metal, 'tg128') } : null,
      moltenvk: nat.moltenvk ? { pp512: n(nat.moltenvk, 'pp512'), tg128: n(nat.moltenvk, 'tg128') } : null,
    };
    json.native = nj;
    json.ratios_pct = {
      vkpeak_fp32_vs_native: pct(json.vkpeak_fp32_gflops, nj.vkpeak_fp32_gflops),
      llama_pp512_vs_metal: pct(json.llama_pp512, nj.metal && nj.metal.pp512),
      llama_tg128_vs_metal: pct(json.llama_tg128, nj.metal && nj.metal.tg128),
      llama_pp512_vs_moltenvk: pct(json.llama_pp512, nj.moltenvk && nj.moltenvk.pp512),
      llama_tg128_vs_moltenvk: pct(json.llama_tg128, nj.moltenvk && nj.moltenvk.tg128),
    };
  } else {
    json.native = null;
  }
  if (missing.length) json.error = `no numbers for: ${missing.join(', ')} (see the logs in the work folder)`;

  // ---- the human table ----
  const L = [];
  const cfg = o.vmConfig;
  L.push(`D9010 VmApp's experimental Vulkan backend (vmapp-vm-krun): ${json.device || 'GPU not identified'}`);
  L.push(`  llama-bench ${o.model}: -p 512 -n 128 -r ${o.reps}${json.llama_build ? ` (build ${json.llama_build})` : ''}${cfg ? `; VM ${cfg.cpus} vCPUs, ${cfg.memoryMiB} MiB, GPU window ${cfg.gpuWindowMiB} MiB` : ''}`);
  if (nat) L.push(`  native baselines: ${nat.source || 'run now'}`);
  else L.push('  native baselines: none (no spike build; set VMAPP_GS_WORK, see bench/vulkan/README.md)');
  L.push('');
  const hdr = ['', 'VM (krun)', 'native Metal', 'native MoltenVK', 'VM/Metal', 'VM/MoltenVK'];
  const rows = [
    [
      'vkpeak fp32 (GFLOPS)',
      fmt(json.vkpeak_fp32_gflops),
      '-',
      fmt(nj && nj.vkpeak_fp32_gflops),
      '-',
      fmtPct(json.ratios_pct && json.ratios_pct.vkpeak_fp32_vs_native),
    ],
    ['vkpeak copy d2d (GB/s)', fmt(json.vkpeak_copy_d2d_gbps), '-', fmt(nj && nj.vkpeak_copy_d2d_gbps), '-', nj && nj.vkpeak_copy_d2d_gbps ? fmtPct(pct(json.vkpeak_copy_d2d_gbps, nj.vkpeak_copy_d2d_gbps)) : '-'],
    [
      'llama pp512 (tokens/s)',
      fmt(json.llama_pp512),
      fmt(nj && nj.metal && nj.metal.pp512),
      fmt(nj && nj.moltenvk && nj.moltenvk.pp512),
      fmtPct(json.ratios_pct && json.ratios_pct.llama_pp512_vs_metal),
      fmtPct(json.ratios_pct && json.ratios_pct.llama_pp512_vs_moltenvk),
    ],
    [
      'llama tg128 (tokens/s)',
      fmt(json.llama_tg128, 1),
      fmt(nj && nj.metal && nj.metal.tg128, 1),
      fmt(nj && nj.moltenvk && nj.moltenvk.tg128, 1),
      fmtPct(json.ratios_pct && json.ratios_pct.llama_tg128_vs_metal),
      fmtPct(json.ratios_pct && json.ratios_pct.llama_tg128_vs_moltenvk),
    ],
  ];
  const w = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => `  ${r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')}`;
  L.push(line(hdr));
  for (const r of rows) L.push(line(r));
  if (missing.length) L.push('', `FAILED: ${json.error}`);
  return { ok: !missing.length, text: L.join('\n'), json };
}

function readIf(file, parse) {
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return parse(file);
  } catch {
    return null;
  }
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h' || k === '--help') {
      process.stdout.write(`${fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')}\n`);
      return 0;
    }
    if (!k.startsWith('--') || i + 1 >= argv.length) {
      process.stderr.write(`bench-report: bad argument ${JSON.stringify(k)}\n`);
      return 2;
    }
    a[k.slice(2)] = argv[++i];
  }
  if (!a.model || !a['vm-vkpeak'] || !a['vm-llama']) {
    process.stderr.write('bench-report: --model, --vm-vkpeak and --vm-llama are required\n');
    return 2;
  }
  const native = a['native-vkpeak'] || a['native-metal'] || a['native-moltenvk']
    ? {
        source: a['native-source'] || null,
        vkpeak: readIf(a['native-vkpeak'], parseVkpeak),
        metal: readIf(a['native-metal'], parseLlamaBench),
        moltenvk: readIf(a['native-moltenvk'], parseLlamaBench),
      }
    : null;
  const num = (v) => (v === undefined ? null : Number(v));
  const rep = buildReport({
    model: path.basename(a.model),
    reps: num(a.reps) || 3,
    vm: { vkpeak: readIf(a['vm-vkpeak'], parseVkpeak), llama: readIf(a['vm-llama'], parseLlamaBench), info: readIf(a['vm-info'], parseInfo) },
    native,
    vmConfig: a.cpus ? { cpus: num(a.cpus), memoryMiB: num(a.memory), gpuWindowMiB: num(a.window) } : null,
  });
  process.stdout.write(`${rep.text}\n\n${JSON.stringify(rep.json)}\n`);
  return rep.ok ? 0 : 1;
}

module.exports = { buildReport };

if (require.main === module) process.exit(main(process.argv.slice(2)));
