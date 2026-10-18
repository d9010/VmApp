'use strict';
// `tests/gpu-vulkan/run.sh --bench` (the hook of `tools/bench vulkan`, docs/BENCHMARKS.md section 8) without a VM: the report script
// (table and the JSON last line), bench/vulkan/parse.js on a VM console log, the exit-status-2 contract of the prerequisites of the
// hook, and the consistency of the pins of the Ollama Vulkan build (apps/ollama/vulkan) with the node22-gpu runtime. The real VMs are
// `tests/gpu-vulkan/run.sh --bench` itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir, rmrf } = require('./helpers');
const { parseVkpeak, parseLlamaBench, parseInfo } = require('../../bench/vulkan/parse.js');
const { buildReport } = require('../../tests/gpu-vulkan/bench-report.js');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'tests', 'gpu-vulkan', 'bench-report.js');
const RUN = path.join(ROOT, 'tests', 'gpu-vulkan', 'run.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;

// what a vmapp-vm-krun console log looks like (the core's lines start with "core: "; the init's own lines are in between)
const CON_VKPEAK = [
  'vmapp-init: control: hello',
  'core: GPUTEST-BEGIN vkpeak',
  'core: fp32-scalar  = 15612.93 GFLOPS',
  'core: copy-h2d     = 57.36 GBPS',
  'core: copy-d2d     = 186.17 GBPS',
  'core: GPUTEST-END vkpeak rc=0 secs=16',
].join('\n');
const CON_LLAMA = [
  'core: GPUTEST-BEGIN llama m.gguf',
  'core: ggml_vulkan: 0 = Virtio-GPU Venus (Apple M4 Max) (venus) | uma: 1 | fp16: 1',
  'core: | model                          |       size |     params | backend    | ngl |            test |                  t/s |',
  'core: | ------------------------------ | ---------: | ---------: | ---------- | --: | --------------: | -------------------: |',
  'core: | llama 8B Q4_K - Medium         |   4.58 GiB |     8.03 B | Vulkan     |  99 |           pp512 |        684.10 ± 4.80 |',
  'core: | llama 8B Q4_K - Medium         |   4.58 GiB |     8.03 B | Vulkan     |  99 |           tg128 |         73.20 ± 0.04 |',
  'core: build: 620d2225c (11669)',
].join('\n');
const CON_INFO = 'core: \tdeviceName         = Virtio-GPU Venus (Apple M4 Max)\ncore: \tapiVersion         = 1.3.0\n';
const NATIVE_METAL = '| model | size | params | backend | ngl | test | t/s |\n| --- | ---: | ---: | --- | --: | ---: | ---: |\n| llama 8B Q4_K - Medium | 4.58 GiB | 8.03 B | Metal,BLAS | 99 | pp512 | 901.10 ± 3.00 |\n| llama 8B Q4_K - Medium | 4.58 GiB | 8.03 B | Metal,BLAS | 99 | tg128 | 86.20 ± 0.30 |\nbuild: 620d2225c (11669)\n';
const NATIVE_VKPEAK = 'device       = Apple M4 Max\ndriver       = MoltenVK / 1.4.2\n\nfp32-scalar  = 15774.44 GFLOPS\ncopy-d2d     = 185.40 GBPS\n';

function files(d, o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = path.join(d, `${k}.log`);
    fs.writeFileSync(out[k], v);
  }
  return out;
}

test('parse.js reads the core lines of a vmapp-vm-krun console log', (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const f = files(d, { vk: CON_VKPEAK, ll: CON_LLAMA, info: CON_INFO });
  const vk = parseVkpeak(f.vk);
  assert.equal(vk.metrics['fp32-scalar'].value, 15612.93);
  assert.equal(vk.metrics['copy-d2d'].value, 186.17);
  const ll = parseLlamaBench(f.ll);
  assert.deepEqual([ll.pp512.mean, ll.pp512.sd, ll.tg128.mean, ll.tg128.sd], [684.1, 4.8, 73.2, 0.04]);
  assert.equal(ll.build, '620d2225c (11669)');
  assert.equal(parseInfo(f.info).deviceName, 'Virtio-GPU Venus (Apple M4 Max)');
});

test('bench-report: the fields of BENCHMARKS section 8, the ratios, and the table', (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const f = files(d, { vk: CON_VKPEAK, ll: CON_LLAMA, info: CON_INFO, nm: NATIVE_METAL, nv: NATIVE_VKPEAK });
  const rep = buildReport({
    model: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    reps: 3,
    vm: { vkpeak: parseVkpeak(f.vk), llama: parseLlamaBench(f.ll), info: parseInfo(f.info) },
    native: { source: 'test', vkpeak: parseVkpeak(f.nv), metal: parseLlamaBench(f.nm), moltenvk: null },
    vmConfig: { cpus: 8, memoryMiB: 12288, gpuWindowMiB: 24576 },
  });
  assert.equal(rep.ok, true);
  const j = rep.json;
  // the four fields the contract names
  assert.equal(j.vkpeak_fp32_gflops, 15612.9);
  assert.equal(j.llama_pp512, 684.1);
  assert.equal(j.llama_tg128, 73.2);
  assert.equal(j.model, 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf');
  assert.equal(j.backend, 'vmapp-vm-krun');
  assert.equal(j.device, 'Virtio-GPU Venus (Apple M4 Max)');
  assert.equal(j.repetitions, 3);
  assert.deepEqual(j.vm, { cpus: 8, memoryMiB: 12288, gpuWindowMiB: 24576 });
  assert.equal(j.native.metal.tg128, 86.2);
  assert.equal(j.native.moltenvk, null);
  assert.equal(j.ratios_pct.llama_tg128_vs_metal, 84.9);
  assert.equal(j.ratios_pct.vkpeak_fp32_vs_native, 99);
  assert.equal(j.ratios_pct.llama_tg128_vs_moltenvk, null);
  assert.match(rep.text, /llama tg128 \(tokens\/s\)\s+73\.2\s+86\.2/);
  assert.equal('error' in j, false);
});

test('bench-report: without native baselines the native part is null; missing numbers are an error', () => {
  const rep = buildReport({ model: 'm.gguf', reps: 1, vm: { vkpeak: null, llama: null, info: null }, native: null, vmConfig: null });
  assert.equal(rep.ok, false);
  assert.equal(rep.json.native, null);
  assert.match(rep.json.error, /vkpeak fp32-scalar.*llama-bench pp512.*llama-bench tg128/);
  assert.match(rep.text, /FAILED/);
});

test('bench-report CLI: the LAST line of stdout is one JSON object (the hook contract); exit 1 when there are no numbers', (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const f = files(d, { vk: CON_VKPEAK, ll: CON_LLAMA, info: CON_INFO, nm: NATIVE_METAL, nv: NATIVE_VKPEAK, empty: 'nothing\n' });
  const run = (...a) => spawnSync(process.execPath, [REPORT, ...a], { encoding: 'utf8' });
  const ok = run('--model', '/x/y/m.gguf', '--reps', '3', '--vm-vkpeak', f.vk, '--vm-llama', f.ll, '--vm-info', f.info, '--native-metal', f.nm, '--native-vkpeak', f.nv, '--native-source', 'tests', '--cpus', '8', '--memory', '12288', '--window', '24576');
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trimEnd().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.model, 'm.gguf');
  assert.equal(last.llama_pp512, 684.1);
  assert.equal(last.native.source, 'tests');
  assert.ok(lines.length > 4, 'a human table comes before the JSON');
  const bad = run('--model', 'm.gguf', '--reps', '3', '--vm-vkpeak', f.empty, '--vm-llama', f.empty);
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout.trimEnd().split('\n').pop()).error, /no numbers/);
  assert.equal(run('--model', 'm.gguf').status, 2, 'usage error');
});

function runSh(env, ...args) {
  return spawnSync('/bin/bash', [RUN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
}

test('run.sh --bench: a missing prerequisite exits 2, names every missing file and its fix command, prints no JSON line', { skip: !hasJq && 'jq is not installed' }, (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const r = runSh({ VMAPP_WORK: d, VMAPP_VM_KRUN: path.join(d, 'nope-krun'), VMAPP_RUNTIME_GPU: path.join(d, 'nope.img'), VMAPP_GPU_TEST_CORE: path.join(d, 'nope.cpio') }, '--bench');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /fix: gpu\/krun\/build\.sh/);
  assert.match(r.stderr, /fix: tools\/mkruntime runtimes\/node22-gpu out\/runtimes\/node22-gpu\.img/);
  assert.match(r.stderr, /fix: bash tests\/gpu-vulkan\/build-core\.sh/);
  assert.equal(r.stdout.trim(), '');
});

test('run.sh --bench: a missing model exits 2 and names the curl command that fetches it', { skip: !hasJq && 'jq is not installed' }, (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const present = {};
  for (const [k, n] of [['VMAPP_VM_KRUN', 'krun'], ['VMAPP_KERNEL_GPU', 'Image-gpu'], ['VMAPP_INITRAMFS', 'initramfs'], ['VMAPP_RUNTIME_GPU', 'rt.img'], ['VMAPP_GPU_TEST_CORE', 'core.cpio']]) {
    present[k] = path.join(d, n);
    fs.writeFileSync(present[k], 'x');
  }
  const gs = path.join(d, 'gs'); // an empty spike work folder: no model there
  const r = runSh({ ...present, VMAPP_WORK: d, VMAPP_GS_WORK: gs, VMAPP_MODELS: '', BENCH_MODEL_CACHE: '', BENCH_MODEL_DIRS: '' }, '--bench');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /missing the model Meta-Llama-3\.1-8B-Instruct-Q4_K_M\.gguf/);
  assert.match(r.stderr, /fix: mkdir -p .*curl -fL -o .*Meta-Llama-3\.1-8B-Instruct-Q4_K_M\.gguf.*huggingface\.co\/bartowski\/.*sha256 7b064f58/s);
  assert.equal(r.stdout.trim(), '');
  const bad = runSh({ ...present, VMAPP_WORK: d }, '--bench', '--runs', '0');
  assert.equal(bad.status, 2);
});

test('run.sh: a normal run still names what is missing (the old behaviour keeps its exit status)', { skip: !hasJq && 'jq is not installed' }, (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const r = runSh({ VMAPP_WORK: d, VMAPP_RUNTIME_GPU: path.join(d, 'nope.img') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fix: tools\/mkruntime runtimes\/node22-gpu/);
  assert.equal(runSh({}, '--bogus').status, 2);
});

test('the Ollama Vulkan build: pins, Dockerfile and runtime agree (build-vulkan.sh --check; exit 2 only when the release is not unpacked)', (t) => {
  const d = tmpdir('vkb-');
  t.after(() => rmrf(d));
  const r = spawnSync('/bin/bash', [path.join(ROOT, 'apps', 'ollama', 'vulkan', 'build-vulkan.sh'), '--check'], { env: { ...process.env, VMAPP_WORK: d }, encoding: 'utf8', timeout: 60000 });
  assert.ok(r.status === 0 || r.status === 2, `exit ${r.status}: ${r.stderr}`); // 1 = the pins disagree with each other or with the runtime
  if (r.status === 2) assert.match(r.stderr, /apps\/ollama\/build\.sh/);
  const df = fs.readFileSync(path.join(ROOT, 'apps', 'ollama', 'vulkan', 'Dockerfile'), 'utf8');
  const pins = fs.readFileSync(path.join(ROOT, 'apps', 'ollama', 'vulkan', 'pins.env'), 'utf8');
  assert.match(pins, /^LLAMA_CPP_COMMIT=[0-9a-f]{40}$/m);
  assert.match(df, /^FROM node@sha256:[0-9a-f]{64} AS base$/m, 'the base image is pinned by digest (INV-F2)');
  for (const k of ['APT_CMAKE', 'APT_GLSLC', 'APT_LIBVULKAN_DEV', 'APT_SPIRV_HEADERS', 'APT_NINJA_BUILD', 'APT_BUILD_ESSENTIAL']) assert.match(pins, new RegExp(`^${k}=\\S+$`, 'm'), k);
});

test('the Ollama (GPU) app: the manifest is valid, node22-gpu, the Vulkan form of the gpu capability, the same two hosts as the plain app', () => {
  const { validateManifest } = require('../../hostlib/manifest');
  const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', p, 'vmapp.json'), 'utf8'));
  const gpu = validateManifest(read('ollama-gpu'), { files: 'forbidden' });
  const plain = validateManifest(read('ollama'), { files: 'forbidden' });
  assert.equal(gpu.id, 'dev.vmapp.ollama.gpu');
  assert.equal(gpu.runtime, 'node22-gpu');
  assert.deepEqual(gpu.permissions.host.map((h) => [h.cap, h.api]), [['gpu', 'vulkan']]);
  assert.equal(plain.runtime, 'node22');
  assert.deepEqual(plain.permissions.host || [], [], 'the plain app asks for no GPU');
  assert.deepEqual(gpu.permissions.network.map((n) => n.host), plain.permissions.network.map((n) => n.host));
  assert.deepEqual([gpu.core.command, gpu.core.memoryMiB, gpu.core.cpus], [plain.core.command, plain.core.memoryMiB, plain.core.cpus]);
});
