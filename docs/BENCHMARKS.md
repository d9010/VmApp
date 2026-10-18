# Benchmarks: reproduce every number in the README

Every figure in the README's "By the numbers" table comes from something you can run on your own Mac. This page says,
row by row, what is measured, how, what you need first, the exact command, what the output looks like, what we measured, and
how to compare with the same thing running natively.

```sh
tools/bench all            # everything, one after the other (about 10 minutes, plus one-time builds and downloads)
tools/bench boot           # or one at a time: boot, bridge, llm, vulkan
tools/bench llm --models qwen2.5-0.5b --runs 3     # a quick try of the LLM benchmark (a 0.5 GB model)
```

`tools/bench` prints a table (medians, p95, minimum and maximum), the machine (chip, cores, RAM, macOS, load), the exact
versions and pins, and writes the same in full to `$VMAPP_WORK/bench/<timestamp>.json`. `--json` prints that JSON instead of
the table. If something it needs is missing it runs nothing, names the missing file and prints the command that creates it,
and exits with status 2.

Our figures are from an **Apple M4 Max** (12 performance + 4 efficiency cores, 128 GB, macOS 15.7.7), on 2026-10-15.

## 0. Before you start

### Prerequisites

| You need | For | How |
|---|---|---|
| An Apple-silicon Mac, Node.js 22 | everything | |
| The host pieces: `out/vmapp-vm`, `out/Image` (the guest kernel), `out/initramfs.cpio`, `out/test/core-echo.cpio` | boot, bridge, llm | `tools/build.sh` (Rust with the `aarch64-unknown-linux-musl` target, Xcode command-line tools, Docker for the kernel; see [CONTRIBUTING.md](../CONTRIBUTING.md) §1–2) |
| The runtime images `out/runtimes/node22.img` and `native.img` | boot, bridge, llm | `tools/mkruntime runtimes/node22 out/runtimes/node22.img` and the same for `native` (Docker) |
| `apps/local-llm/core/bin/llama-server` | llm | `apps/local-llm/build.sh` (Docker; builds llama.cpp at the pin in `gpu/pins.env`) |
| `out/gpu/rpc-server` and `out/gpu/rpc-server.sb` (the Mac-side GPU server) | llm | `tools/build.sh`, or `gpu/build.sh` (cmake and Xcode's tools) |
| The model file (Qwen2.5 7B Q4_K_M, 4.7 GB) | llm | automatic: `tools/bench llm` downloads it by its pinned URL into `$VMAPP_WORK/cache/models` and checks the SHA-256 in [`apps/local-llm/core/models.json`](../apps/local-llm/core/models.json). Already have it? `BENCH_MODEL_DIRS=/folder tools/bench llm` looks there first (and still checks the SHA-256). |
| The Venus spike build (`out/work-gs`) and the Llama 3.1 8B model (4.9 GB) | vulkan | follow [`gpu/venus-spike/BUILD.md`](../gpu/venus-spike/BUILD.md); [`bench/vulkan/README.md`](../bench/vulkan/README.md) has the short version. The model downloads automatically (URL and SHA-256 in `bench/vulkan/models.json`). |

`tools/bench` keeps everything it creates in `$VMAPP_WORK` (default `out/work`): its own app data in `bench/home` (never your
real `VMAPP_HOME`), logs in `bench/logs`, results in `bench/<timestamp>.json`. It installs the bench app and the Local LLM
app into that private home.

### Be honest about noise

- **Quiet the Mac first.** Close other work, stop builds and other VMs (`docker`, Xcode, other D9010 VmApp apps). The tool prints the
  load average at the start and the end and says `BUSY` when it is high. The VM-start numbers hardly move with load; the bridge
  round trips and especially the LLM numbers do.
- **`p95`** is the nearest-rank 95th percentile: with 20 samples it is the 19th smallest, and with 5 samples it is simply the
  largest. For the small LLM runs read `min` and `max` instead.
- **Repeat before you believe a difference.** GPU token generation over RPC varies by about 20% between runs, and by more
  while anything else uses the GPU or the CPU. The first run after a build or a reboot can be slower (cold file cache); the
  tools discard a warm-up run where it matters and say so.
- **Other Macs differ.** A base M1 has fewer and slower cores and less memory bandwidth on both sides of every comparison.
- `tools/bench` records the git commit, how many files are uncommitted, and a hash of the `vmapp-vm` binary that actually ran.
  Two runs are comparable only if those match.

## 1. VM start

**README row:** "VM start (boot to the app's core answering)", and the memory of the VM.

**What is measured.** The time from spawning the per-app VM process (`vmapp-vm`) to (a) its `{"ready":true}` line (the guest
kernel booted, `vmapp-init` ran, the core process was started) and (b) the core's first message over the bridge (for a Node
app, the SDK's "ready", the moment the host can start talking to the app; the same moment as the app's first window request).
Also the memory the VM takes on the Mac, and how fast a VM disappears when its parent dies.

**Method.** `bench/boot/boot.mjs` does it 20 times (plus one discarded warm-up run) in three ways:

1. **Node app**: the bridge benchmark app (`bench/bridge/app`: runtime `node22`, 1 vCPU, 256 MiB) started through hostlib's
   `AppSession`, the code the loader runs. Times are taken from `hostlib`'s own log events ("spawn", "VM ready", "core ready"
   and the first window request).
2. **Minimal VM**: `vmapp-vm` with the native runtime and the 450 KB Rust test core `tests/core-echo`; the "first message" is
   the reply to a request on the bridge socket. This is the floor, with no Node and no host library in the way.
3. **kill -9**: the minimal VM started by a parent process that is then killed with `SIGKILL`; we time until `vmapp-vm` has
   exited and until Virtualization.framework's VM process is gone (the same check as `tests/e2e.sh` scenario 6, which allows 8 s).

**Memory** is read from the VM's own process (`com.apple.Virtualization.VirtualMachine`, found as the one new process after the
start; a sample is skipped when another VM starts at the same moment). We report macOS' **physical footprint**
(`footprint`: memory the VM owns and has touched; this is the figure to quote) and `ps`' RSS (which also counts clean
pages of mapped files such as the runtime image, so it is higher).

**Command.** `tools/bench boot` (`--runs N` changes the 20). About 1.5 minutes.

**Output shape.**

```
VM start  (Node app: dev.bench.bridge, runtime node22, 1 vCPU, 256 MiB; first run discarded as warm-up)
                                                                    median         p95         min         max
  Node app: spawn -> vmapp-vm "ready"           (n=20)               342 ms      346 ms      337 ms      364 ms
  Node app: spawn -> the core's first message                        445 ms      449 ms      439 ms      466 ms
  ...
  kill -9 of the parent -> VM gone              (n=20)               175 ms      193 ms      155 ms      217 ms
  sizes     kernel 7.6 MB, init 534 KB, Notes sample package 26.5 KiB
```

**Our result (M4 Max, n=20, load average 3.3, 2026-10-15).**

| | median | p95 | min – max |
|---|---|---|---|
| Node app: spawn → `vmapp-vm` "ready" | **342 ms** | 346 ms | 337 – 364 ms |
| Node app: spawn → the core's first message (= first window request) | **445 ms** | 449 ms | 439 – 466 ms |
| Node app: VM memory (footprint, 1 s after the first window) | **137 MiB** (ps RSS 248 MiB) | 138 MiB | 136 – 138 MiB |
| Node app: quit → VM stopped | 194 ms | 223 ms | 169 – 1,758 ms (one slow stop in 20 here, two in a second run; about 1.8 s each; not investigated) |
| Minimal VM (Rust core): spawn → "ready" | 338 ms | 341 ms | 332 – 342 ms |
| Minimal VM: spawn → first reply | **393 ms** | 395 ms | 386 – 396 ms |
| Minimal VM: memory (footprint, 1 s later) | **28 MiB** (RSS 52 MiB) | 28 MiB | 28 – 29 MiB |
| `kill -9` of the parent → VM gone | **175 ms** | 193 ms | 155 – 217 ms |

The README rounds this to "~0.35 s" (VM ready), "~0.45 s" (a Node app's core answers), "~30 MB" (minimal VM) to "~140 MB"
(Node app), and "~0.2 s" for the `kill -9`. Under a busy Mac (load 7 to 10) the times moved by less than 5%. A Node VM's
footprint is about half of its 256 MiB, because the guest has touched that much; ps' RSS is higher because it also counts
the mapped runtime image. Do not read the footprint as "what Node needs": it is what a 256 MiB VM running this app took.

**Compare with native.** There is no native equivalent of "a VM for one app". For scale: `vmapp-vm` is ready after about
0.35 s whatever the core is (Virtualization.framework creating the VM, the guest kernel booting, `vmapp-init` starting the
core), and a Node app then needs about 0.1 s more for `node` to start and say hello. To see the floor yourself, run the
minimal variant alone: `VMAPP_HOME=$VMAPP_WORK/bench/home BENCH_ONLY=raw node bench/boot/boot.mjs`.

## 2. Kernel + init, and app size

**README rows:** "Kernel + init" and "App size".

**What is measured.** File sizes: the guest kernel `out/Image`, the `init` program inside `out/initramfs.cpio` (`vmapp-init`,
a static Rust binary), and the package of the Notes sample.

**Command.** `tools/bench boot` prints them on its `sizes` line. By hand:

```sh
ls -l out/Image                                   # the kernel
cat out/kernel.release                            # 6.18.56-vmapp
tools/vmapp pack apps/notes -o /tmp/notes.vmapp   # prints the package size
```

(`init` is the one file in the initramfs; the rest are empty device and mount-point entries. `tools/bench` reads its size from
the archive; the same binary is `vmapp-init` in cargo's `aarch64-unknown-linux-musl/release` folder.)

**Our result.** Kernel 7,573,512 bytes (7.6 MB), `init` 534,416 bytes (534 KB; the initramfs built earlier the same day had 522,960 bytes, so "about 530 KB" is
the honest round number), Notes package 26.5 KiB (27 KB).
The kernel is built reproducibly from pinned, signature-checked source: `tools/build.sh`, [kernel/](../kernel/SOURCE-OFFER.md).

## 3. UI ↔ VM bridge

**README row:** "UI ↔ VM bridge" (and [PROTOCOL.md](PROTOCOL.md) §5).

**What is measured.** Round trips between the host side of the bridge (hostlib, as the loader uses it) and a Node core in its
VM. The loader adds one Electron IPC hop between the window and hostlib, which is not measured here.

**Method.** `bench/bridge/bench.mjs` drives the app in `bench/bridge/app`, which has three handlers: `echo(x)`, `blob(n)` (a
string of n characters) and `burst(n, size)` (n messages to the window). After a warm-up (500 calls, 20 parallel batches, 3
bursts, 3 big replies, so that Node's JIT on both sides is warm), it repeats this 5 times in the same VM:

| Measurement | How |
|---|---|
| Sequential small `invoke` | 1,000 awaited `invoke('echo', {i, s})`, each timed with `process.hrtime.bigint()`; median, p95, p99 over all 5,000 calls |
| Concurrent calls | 1,000 `invoke('echo', i)` started at once and awaited together; calls per second |
| Reply sizes | `invoke('blob', n)` for 1 KiB, 100 KiB, 1 MiB, 8 MiB, 10 each; median time; MiB/s = size / median time |
| core → UI messages | `burst(2000, 100)`: 2,000 messages of 100 bytes with `webContents.send`; messages per second until the last arrives |

The headless runner prints a line for every message it receives; the benchmark removes that listener first, because printing
2,000 lines would be part of what it times.

**Command.** `tools/bench bridge` (`--runs N` changes the 5 rounds). Under a minute. By hand, with the bench home that
`tools/bench` prepared (`$VMAPP_WORK/bench/home`):

```sh
VMAPP_HOME=$VMAPP_WORK/bench/home tools/vmapp run dev.bench.bridge --headless --script bench/bridge/bench.mjs
```

**Output shape.** `BENCH` lines (`sequential small invoke (n=5000): median 0.049 ms, p95 ..., p99 ...`, `1000 concurrent small
invokes: median ... calls/s`, `reply of 8192 KiB: median ... ms (... MiB/s)`, `... core->UI emits ...`), then the table.

**Our result (M4 Max; four runs of 5 rounds each, load average 3 to 10, 2026-10-15; the figure is the median of the four
runs' medians; the fourth run was part of `tools/bench all`, with the GPU benchmarks starting right after it).**

| | median | notes |
|---|---|---|
| Sequential small `invoke` round trip | **0.049 ms** | p95 0.064 ms, p99 0.11 ms (runs: 0.049, 0.049, 0.048, **0.066** ms); the worst single call of 5,000 took 2.5 to 3.9 ms |
| 1,000 concurrent `invoke`s | **~390,000 calls/s** | runs: 389,000, 417,000, 362,000, 393,000; single rounds from 270,000 to 440,000 |
| 1 KiB reply | 0.06 ms | |
| 100 KiB reply | 0.88 ms | |
| 1 MiB reply | 9.4 ms | about 106 MiB/s |
| 8 MiB reply | 76.7 ms | **~104 MiB/s** (runs: 104, 104, 104, 111) |
| core → UI messages (100 B each) | **~565,000 / s** | runs: 552,000, 575,000, 599,000, 526,000 |

Without the warm-up the concurrent and message rates are 2 to 3 times lower in the first round (Node's JIT on both sides): the
numbers above are the steady state. The README's first figures were taken cold; see section 9.

**Compare with native.** Plain Electron has the same shape: a renderer's `ipcRenderer.invoke('echo', x)` to a main-process
`ipcMain.handle('echo', (e, x) => x)`. Time 1,000 awaited calls with `process.hrtime.bigint()` the same way. What the loader
adds for a D9010 VmApp app is that Electron figure plus the VM hop, and the VM hop alone is what the README's "0.05 ms" is.

## 4. GPU compute inside the VM (experimental Vulkan pass-through)

**README row:** "GPU compute inside the VM", 15.75 TFLOPS fp32, same as native.

**What is measured.** nihui's `vkpeak` (peak arithmetic and copy throughput written in Vulkan compute shaders), once in a Linux
VM whose Vulkan device is **Virtio-GPU Venus** (Mesa's Venus driver → libkrun → virglrenderer → MoltenVK → Metal), and once
natively through MoltenVK, on the same GPU. The README quotes `fp32-scalar`.

**Method.** `bench/vulkan/run.sh` runs the spike's own commands: `gpu/venus-spike/run-guest.sh vkpeak vkpeak gpu=8192 mem=4096
cpus=2` and `vkpeak 0` natively with `VK_DRIVER_FILES` pointing at MoltenVK. Both use
`MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0`, which the VM needs ([REPORT.md](../gpu/venus-spike/REPORT.md) B2). The VM
test checks first that the guest really sees `Virtio-GPU Venus (<your GPU>)` (`vulkaninfo --summary`).

**Prerequisites.** The Venus spike build, see section 0. The build is only read.

**Command.** `tools/bench vulkan` (this and the next section together, about 5 minutes). Or only this part:
`bench/vulkan/run.sh vkpeak && node bench/vulkan/parse.js`.

**Output shape.** `vkpeak` prints `fp32-scalar = 15776.73 GFLOPS` style lines; the table puts the VM and native values side by side with the ratio.

**Our result (M4 Max, three runs, load average 3 to 6, 2026-10-15; pins: libkrun 1.19.6, virglrenderer 0.10.4e-krunkit,
MoltenVK 1.4.2, Mesa 26.2.5, Linux 6.18.56, vkpeak 20260527). The table is the first run; the other two follow in the notes.**

| vkpeak | VM (Venus) | native (MoltenVK) | VM / native |
|---|---|---|---|
| fp32 (scalar), GFLOPS | **15,751** (also 15,749 and 15,775) | 15,758 (also 15,750 and 15,726) | 100.0% (100.0%, 100.3%) |
| fp16 (vec4), GFLOPS | 15,995 | 15,992 | 100.0% |
| int32, GIOPS | 4,029 | 4,027 | 100.0% |
| int8 dot product, GIOPS | 57,141 | 57,178 | 99.9% |
| copy device → device, GB/s | 189 (185 in the third run) | 198 (190) | 95.6% (97.8%) |

The README says "15.75 to 15.78 TFLOPS fp32, same as native (within 0.3%)". (The spike's report has 15,777 against 15,787
from its own runs; the differences between runs are of that size.)

**Compare with native.** The native column is the comparison. The VM is not slower at arithmetic because the shaders run on
the real GPU; the pass-through only carries commands and memory.

## 5. Local LLM in the VM, Vulkan

**README row:** "Local LLM in the VM, Vulkan (llama.cpp, Llama 3.1 8B Q4)".

**What is measured.** llama.cpp's `llama-bench -p 512 -n 128 -r 3` on **Meta Llama 3.1 8B Instruct Q4_K_M**: prompt
processing (`pp512`) and generation (`tg128`), in tokens per second, in the Venus VM (llama.cpp's Vulkan backend), natively on
**Metal** (llama.cpp's Metal backend; this is the reference the README quotes) and natively on MoltenVK (the same Vulkan
backend as the VM, without the VM).

**Method.** As section 4. The VM gets 8 vCPUs, 12 GiB and a 24 GiB GPU window. llama.cpp is the same build (b11669) on all
three sides. `-r 3` means each number is the mean of three repetitions, printed as `mean ± standard deviation`.

**Command.** `tools/bench vulkan`, or `bench/vulkan/run.sh llama && node bench/vulkan/parse.js`. The commands it runs, so you
can paste them, are in [`bench/vulkan/README.md`](../bench/vulkan/README.md) §3.

**Output shape.** A `llama-bench` table per line of the comparison; `tools/bench` shows `VM Venus`, `native Metal`,
`native MoltenVK` and `VM/Metal`.

**Our result (M4 Max, four runs, load average 3 to 10, 2026-10-15; tokens per second, the figure is the median of the
four runs, the runs in brackets; llama.cpp b11669).**

| Llama 3.1 8B Q4_K_M | VM, Venus | native Metal | native MoltenVK | VM / Metal | VM / MoltenVK |
|---|---|---|---|---|---|
| generation (`tg128`) | **73.3** (73.3, 73.0, 73.3, 73.3) | **86.4** (86.3, 83.6, 86.8, 86.5) | 70.9 (70.1, 70.2, 72.1, 71.6) | **85%** | 103% |
| prompt (`pp512`) | **685** (685, 684, 685, 680) | **899** (901, 893, 901, 897) | 683 (682, 684, 684, 676) | **76%** | 100% |

The VM is as fast as the same Vulkan backend running natively (the last column), and slower than Metal because llama.cpp's
Metal backend is faster than its Vulkan backend on this GPU, with or without a VM. The spike's report quoted native Metal at
79.1 tokens/s (so "92%"); its native Metal run was noisy (79.07 ± 3.08) and, in our four runs, native Metal generation never fell
below 83.6. The README therefore says 85%. Generation varies by a few percent between runs; the VM's own numbers are steadier
than native Metal's.

**Compare with native.** The native Metal and MoltenVK columns are the comparison, run by the same script. On your own
llama.cpp install the Metal command is `llama-bench -m MODEL.gguf -p 512 -n 128 -r 3`.

## 6. Local LLM in the VM, GPU over RPC (the shipping path)

**README row:** "Local LLM in the VM, GPU over RPC (Qwen2.5 7B Q4, 4 vCPUs)", 30 → 76 tokens/s generation, 53 → 860 prompt.

**What is measured.** The `apps/local-llm` app (llama.cpp's `llama-server` in the VM), with the model on the **VM's CPU**
against on **the Mac's GPU** through ggml RPC to the loader's sandboxed Metal `rpc-server`. Qwen2.5 7B Instruct Q4_K_M
(4.7 GB). Generation and prompt-processing speed, and the load time.

**Method.** `bench/llm/bench-llm.mjs` drives the real app through its bridge channels (the same ones as
`tests/apps/local-llm.mjs`, which tests behaviour; this one only measures), twice per model:

- **CPU phase**: 4 vCPUs, an **8 GB** VM (the 7B model does not fit the app's 4 GB on the CPU), no GPU grant.
- **GPU phase**: 4 vCPUs, a **4 GB** VM, the `gpu` host capability granted: the weights live in the Mac's GPU memory.

In each phase: context 4096, greedy sampling (temperature 0), `llama-server` uses every vCPU. After one warm-up,

- **generation**: the fixed prompt "Write a story about a robot who learns to paint. Keep going until you run out of space.",
  128 new tokens, **5 runs**; the speed is `llama-server`'s own `timings.predicted_per_second` for each reply; the result is the median;
- **prompt processing**: 5 prompts of about 520 tokens that each start with a different number (so nothing is served from the
  prompt cache), one new token each; `timings.prompt_per_second`; the median;
- **load**: from `llm:load` until the model is ready.

The model comes from [`models.json`](../apps/local-llm/core/models.json): the tool downloads the pinned URL (a commit of the
Hugging Face repository) with `curl`, checks size and SHA-256, and hands the file to the app through its own "Import a model
file" path. The in-VM download path (through the allowlist proxy, resumable) is covered by `tests/apps/local-llm.mjs`.

**Command.** `tools/bench llm` (Qwen2.5 7B; about 2.5 minutes once the model is on disk). `--models
qwen2.5-0.5b,qwen2.5-1.5b,qwen2.5-7b` measures the three sizes of the app's README table; `--runs N` changes the 5.

**Output shape.**

```
Local LLM: Qwen2.5 7B Instruct Q4_K_M, context 4096, greedy; 5 runs of 128 tokens; prompt ~516 tokens
                                                   median         p95         min         max
  generation, VM CPU (4 vCPUs, 8192 MiB VM)    30.5 tok/s  30.7 tok/s  30.3 tok/s  30.7 tok/s
  generation, Mac GPU over RPC (4096 MiB VM)   76.7 tok/s  80.0 tok/s  76.1 tok/s  80.0 tok/s
    GPU / CPU                                 x2.51
  prompt processing, VM CPU                      53 tok/s    54 tok/s    53 tok/s    54 tok/s
  prompt processing, Mac GPU over RPC           878 tok/s   886 tok/s   842 tok/s   886 tok/s
  ...
```

**Our result (M4 Max, Qwen2.5 7B Q4_K_M, 4 vCPUs, four runs of the whole benchmark, load average 3 to 9,
2026-10-15; llama.cpp b11299, the pin in `gpu/pins.env`).**

| Qwen2.5 7B | VM CPU (8 GB VM) | Mac GPU over RPC (4 GB VM) | GPU / CPU |
|---|---|---|---|
| generation, tokens/s, median of 5 | **30** (29.5, 30.5, 30.4, 29.4) | **76** (66.0, 76.7, 74.6, 78.9) | ×2.5 |
| prompt processing, tokens/s, median of 5 | **53** (50, 53, 53, 53) | **863** (853, 878, 849, 873) | ×16 |
| model load | 6 to 14 s | 11 to 12 s | |

(In brackets: the median of each of the four runs, in order; the figure is the median of those four. The first run had the
highest load, 5.7 rising to 8.9, and the lowest GPU generation figure.) The README rounds to "30 → 76 tok/s generation,
53 → 860 tok/s prompt". Single GPU replies ranged from 64 to 82 tokens/s, which is the 20% run-to-run variation: each
token waits for an RPC round trip, and that depends on what else the Mac is doing. The CPU figures are steady. On the GPU
the VM held 4,168 MiB of weights on the host (29 of 29 layers) in a 4 GB VM.

The other sizes (`--models qwen2.5-0.5b,qwen2.5-1.5b`, load 2.5 to 5.8): 0.5B generation 181 → 184 tok/s and prompt 311 →
9,276; 1.5B generation 118 → 157 and prompt 234 → 3,550 (CPU → GPU). These match the table in
[apps/local-llm/README.md](../apps/local-llm/README.md) within about 10%.

**Compare with native.** What the same GPU does with the same model **without a VM** (native Metal, no RPC) is the ceiling this
path is measured against. With any llama.cpp Metal build:

```sh
llama-bench -m Qwen2.5-7B-Instruct-Q4_K_M.gguf -p 512 -n 128 -r 5
```

The Venus spike's build has one (`out/work-gs/build/llama-metal/bin/llama-bench`, llama.cpp b11669). On our Mac, with
`-r 5`: **93.0 tokens/s generation and 965 tokens/s prompt** (± 0.13 and ± 0.61; load average 7). So the VM on the GPU over
RPC reaches about 80% of native generation (76 of 93) and about 89% of native prompt processing (863 of 965), and it does so
inside a 4 GB VM that never holds the weights. (This is a different llama.cpp build than the VM's, b11669 against b11299,
so read it as the ceiling, not as a controlled comparison.)

## 7. Isolation proven by tests, and the test suites

**README rows:** "Isolation proven by tests" and "Test suites".

These are not speed numbers; they are counts and pass/fail results from the test suites, and one timing:

| Claim | Command | Output |
|---|---|---|
| `kill -9` on the loader → the VM is gone in < 1 s | `tools/bench boot` (the `kill -9` row, median and worst of 20); `tests/e2e.sh` scenario 6 allows 8 s and prints the time it took | median 175 ms, worst of 20: 217 ms (`vmapp-vm` itself exits in about the same time as the VM process) |
| 300+ unit tests | `node --test tests/unit/` (about 40 s) | `# tests 308`, `# pass 308` |
| 270+ invariant tests | `node --test tests/invariants/` and `tools/check-invariants` | `# tests 289`, `# pass 288`, 1 skipped, `# fail 0` (the number grows as invariants are added; it was 276 earlier the same day) |
| 260+ real-VM end-to-end checks | `tests/e2e.sh` (about 35 s; needs `out/` and `native.img`; starts real VMs; do not run other VMs meanwhile: it counts them) | 264 `PASS:` lines and a final `264 passed, 0 failed` |
| Loader UI runs A–J | see [CONTRIBUTING.md](../CONTRIBUTING.md) (Electron; needs the loader build) | not re-run for this page |
| An app sees only granted folders; no network unless allowed | `tests/e2e.sh` scenarios 1, 10, 11; `tests/apps/run-all.sh` | `PASS` |

(Test counts grow; the README says "300+" and so on so that it stays true.)

## 8. The hook for D9010 VmApp's own Vulkan backend

Sections 4 and 5 measure the **research spike** in `gpu/venus-spike`. D9010 VmApp's own experimental Vulkan backend (SPEC 8.7: the
launcher `vmapp-vm-krun`, libkrun + Venus + MoltenVK, the VMM in its sandbox, the same VM an app gets) is measured by

```sh
tests/gpu-vulkan/run.sh --bench [--model FILE.gguf] [--runs N] [--no-native]
```

`tools/bench vulkan` runs it after the spike (with `BENCH_RUNS`, the usual `VMAPP_WORK`, and `BENCH_NATIVE_FROM` pointing at the
spike's logs, so the native baselines are not run twice) and stores the result next to the spike's in the JSON under
`vulkan.productBackend`; the table shows it under the spike's rows.

**What it does.** Boots three real VMs on the backend: `vulkaninfo` (it must say `Virtio-GPU Venus`), `vkpeak`, and
`llama-bench -p 512 -n 128 -r N` of Llama 3.1 8B Q4_K_M (8 vCPUs, 12 GiB, a 24 GiB GPU window, the spike's sizes), then the same
on the host for comparison: `llama-bench` on Metal and on MoltenVK and `vkpeak` on MoltenVK, from the spike's host builds
(`$VMAPP_GS_WORK`, default `out/work-gs`), or reused from the logs `bench/vulkan/run.sh` just wrote. It prints a table; the
**last line of stdout is one JSON object**; fields: `backend`, `vkpeak_fp32_gflops`, `vkpeak_copy_d2d_gbps`, `llama_pp512`,
`llama_tg128` (and `_sd`), `llama_build`, `model`, `device`, `repetitions`, `vm {cpus, memoryMiB, gpuWindowMiB}`, `native {source,
vkpeak_fp32_gflops, vkpeak_copy_d2d_gbps, metal {pp512, tg128}, moltenvk {pp512, tg128}}` and `ratios_pct`. Exit status: 0 it ran;
1 a VM run produced no numbers (the JSON has `error`); 2 a prerequisite is missing (stderr names it and the command that creates
it; there is no JSON line, and `tools/bench` shows those lines). It needs `out/krun` (`gpu/krun/build.sh`), `out/Image-gpu`,
`out/initramfs.cpio`, `out/runtimes/node22-gpu.img`, `out/test/gpu-vulkan-core.cpio` (`tests/gpu-vulkan/build-core.sh`) and the model.
Its logs are in `$VMAPP_WORK/gpu-vulkan/b-*.console.log`; `tests/unit/gpu-vulkan-bench.test.js` tests the report and the parser.

**Our result (M4 Max, one clean run of `tools/bench vulkan`, load average 1.3 to 2.8, 2026-10-15, `-r 3`; the spike's numbers
from the same run are in sections 4 and 5).**

| | vmapp-vm-krun | spike VM | native MoltenVK | native Metal |
|---|---|---|---|---|
| vkpeak fp32, GFLOPS | **15,728** (99.8% of native) | 15,776 | 15,765 | |
| vkpeak copy device → device, GB/s | 184 | 182 | 183 | |
| Llama 3.1 8B Q4_K_M generation (`tg128`), tokens/s | **73.0 ± 0.4** (85.6% of Metal, 103% of MoltenVK) | 73.1 | 70.8 | 85.3 |
| Llama 3.1 8B Q4_K_M prompt (`pp512`), tokens/s | **682 ± 3** (75.8% of Metal, 101% of MoltenVK) | 686 | 676 | 899 |

The backend that apps use, with the VMM sandboxed, is as fast as the spike (within 0.3% for generation, 0.6% for prompt, 0.3%
for vkpeak). `llama-bench` feeds random tokens and checks nothing about its answers: see the correctness note in
[apps/ollama/README.md, "The GPU"](../apps/ollama/README.md#the-gpu) (a different llama.cpp, Ollama's, gave wrong answers on
this device until its asynchronous path was switched off; here that switch changes `llama-bench` generation by 3.6%, 73.3 to 70.7).

## 9. What changed since the first figures

The first README figures were taken before this tooling existed, from one-off scratch runs. Re-measured with the tooling
(2026-10-15, same Mac), these changed:

| Row | First README figure | Now | Why, as far as we know |
|---|---|---|---|
| VM start | ~0.3 s | VM ready 0.34 s; a Node app's core answers after 0.45 s | the old method was not recorded; it was probably the VM alone, and a Node core needs about 0.1 s more |
| VM memory | ~90 MB | 28 MiB (minimal VM) to 137 MiB (Node app in a 256 MiB VM), footprint | the old figure's method was not recorded; the memory of a VM depends on how much its guest touches |
| `init` | ~450 KB | 523 to 534 KB | `vmapp-init` grew (network, services); the old figure was out of date |
| Bridge, concurrent calls | 134,000 / s | ~390,000 / s | the old run was cold (no JIT warm-up) |
| Bridge, core → UI messages | 70,000 / s | ~565,000 / s | the old run awaited each message in a loop; this one counts arrivals |
| Bridge, small round trip | 0.075 ms | 0.049 ms (0.048 to 0.066 between runs) | not investigated |
| Bridge, bulk | 136 MiB/s | ~104 MiB/s (104 to 111 between runs) | not investigated |
| GPU compute | 15.78 vs 15.79 TFLOPS | 15.75 to 15.78 vs 15.73 to 15.76 | run-to-run difference (no change in meaning) |
| LLM, Vulkan | 72.7 tok/s = 92% of native Metal (79.1) | 73.3 tok/s = **85%** of native Metal (86.4) | native Metal measured faster and steadier now; the VM's number is the same |
| LLM, GPU over RPC | 30 → 78 tok/s, 53 → 855 tok/s | 30 → 76 tok/s, 53 → 860 tok/s | GPU generation varies 66 to 79 between runs (medians of 5) |
| `kill -9` → VM gone | < 1 s | median 0.175 s | the old claim was an upper bound |

The spike's [REPORT.md](../gpu/venus-spike/REPORT.md) is a dated record of its own runs and keeps its figures; it now
carries a note pointing here.

## 10. Files and settings

| Path | What |
|---|---|
| `tools/bench` | the command; prerequisites, setup, running, the table, the JSON |
| `bench/boot/` | `boot.mjs` (VM start, memory, kill -9), `parent.mjs` (the parent process that gets killed) |
| `bench/bridge/` | `app/` (the benchmark app, installed as `dev.bench.bridge`), `bench.mjs` |
| `bench/llm/` | `bench-llm.mjs` |
| `bench/vulkan/` | `run.sh`, `parse.js`, `models.json`, `README.md` (the documented steps) |
| `bench/lib/stats.js` | median, nearest-rank percentiles |
| `tests/gpu-vulkan/run.sh --bench`, `bench-report.js` | the hook that measures D9010 VmApp's own Vulkan backend (section 8) |
| `tests/apps/ollama-gpu.sh` | Ollama on that backend, tokens/s on the GPU against the CPU (README of the Ollama app, "The GPU") |

| Setting | Meaning |
|---|---|
| `VMAPP_WORK` | scratch folder (default `out/work`) |
| `BENCH_HOME` | the data root of the bench apps (default `$VMAPP_WORK/bench/home`) |
| `BENCH_MODEL_CACHE`, `BENCH_MODEL_DIRS` | where models are kept / extra read-only places to look |
| `VMAPP_GS_WORK` | the Venus spike build (default `out/work-gs`) |
| `BENCH_ONLY` | for `bench/boot/boot.mjs` by hand: `app`, `raw`, `kill` (comma separated) |
| `BENCH_VULKAN_MODEL` | for `bench/vulkan/run.sh`: another GGUF in the spike's `cache/models` |
