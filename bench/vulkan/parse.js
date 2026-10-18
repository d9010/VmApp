#!/usr/bin/env node
'use strict';
// Turns the logs of bench/vulkan/run.sh into numbers.
//
//   node bench/vulkan/parse.js [LOGDIR]      prints JSON (default LOGDIR: ${VMAPP_WORK:-out/work}/bench/vulkan)
//
// The logs are the raw output of the commands: vkpeak prints "name = value unit" lines, llama-bench prints a markdown table whose
// last column is "t/s" as "mean ± standard deviation over -r repetitions". Guest logs carry a "[timestamp LEVEL source] " prefix on
// every line, which is dropped here.
const fs = require('fs');
const path = require('path');

const PREFIX = /^\[\d{4}-\d\d-\d\dT[^\]]*\]\s?/;
// A console log of vmapp's own backend (tests/gpu-vulkan/run.sh --bench) prefixes the core's output with "core: ".
const CORE_PREFIX = /^core: ?/;

function lines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(PREFIX, '').replace(CORE_PREFIX, '').replace(/\r$/, ''));
  } catch {
    return null;
  }
}

/** vkpeak: the metrics of the LAST complete report in the log (the guest test prints the device list first, which already runs one). */
function parseVkpeak(file) {
  const ls = lines(file);
  if (!ls) return null;
  let start = 0;
  ls.forEach((l, i) => {
    if (/^device\s*=/.test(l)) start = i;
  });
  const out = { device: null, driver: null, metrics: {} };
  for (const l of ls.slice(start)) {
    let m;
    if ((m = /^device\s*=\s*(.+)$/.exec(l))) out.device = m[1].trim();
    else if ((m = /^driver\s*=\s*(.+)$/.exec(l))) out.driver = m[1].trim();
    else if ((m = /^([a-z0-9-]+)\s*=\s*([\d.]+)\s*(GFLOPS|GIOPS|GBPS)\s*$/.exec(l))) out.metrics[m[1]] = { value: Number(m[2]), unit: m[3] };
  }
  return Object.keys(out.metrics).length ? out : null;
}

/** llama-bench: { pp512: {mean, sd}, tg128: {mean, sd}, backend, build }. */
function parseLlamaBench(file) {
  const ls = lines(file);
  if (!ls) return null;
  const out = {};
  for (const l of ls) {
    const cells = l.split('|').map((c) => c.trim());
    if (cells.length >= 8 && /^(pp|tg)\d+$/.test(cells[6])) {
      const m = /^([\d.]+)\s*±\s*([\d.]+)$/.exec(cells[7]);
      if (m) {
        out[cells[6]] = { mean: Number(m[1]), sd: Number(m[2]) };
        out.backend = cells[4];
        out.model = cells[1];
        out.sizeAndParams = `${cells[2]}, ${cells[3]}`;
      }
    }
    const b = /^build:\s*(.+)$/.exec(l);
    if (b) out.build = b[1].trim();
  }
  return out.pp512 || out.tg128 ? out : null;
}

function parseInfo(file) {
  const ls = lines(file);
  if (!ls) return null;
  const out = {};
  for (const l of ls) {
    let m;
    if (!out.deviceName && (m = /deviceName\s*=\s*(.+)$/.exec(l))) out.deviceName = m[1].trim();
    else if (!out.apiVersion && (m = /apiVersion\s*=\s*(\S+)/.exec(l))) out.apiVersion = m[1];
    else if (!out.driverVersion && (m = /driverVersion\s*=\s*(\S+)/.exec(l))) out.driverVersion = m[1];
    else if (!out.driverID && (m = /driverID\s*=\s*(\S+)/.exec(l))) out.driverID = m[1];
  }
  return out.deviceName ? out : null;
}

function parseDir(dir) {
  const f = (n) => path.join(dir, n);
  return {
    dir,
    info: parseInfo(f('info.log')),
    vkpeak: { vm: parseVkpeak(f('vkpeak-vm.log')), native: parseVkpeak(f('vkpeak-native.log')) },
    llama: {
      vmVenus: parseLlamaBench(f('llama-vm-venus.log')),
      nativeMetal: parseLlamaBench(f('llama-native-metal.log')),
      nativeMoltenvk: parseLlamaBench(f('llama-native-moltenvk.log')),
    },
  };
}

module.exports = { parseDir, parseVkpeak, parseLlamaBench, parseInfo };

if (require.main === module) {
  const dir = process.argv[2] || path.join(process.env.VMAPP_WORK || path.join(__dirname, '..', '..', 'out', 'work'), 'bench', 'vulkan');
  console.log(JSON.stringify(parseDir(path.resolve(dir)), null, 2));
}
