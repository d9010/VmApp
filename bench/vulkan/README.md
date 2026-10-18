# bench/vulkan: reproducing the Vulkan numbers

These are the two GPU rows of the README: **GPU compute inside the VM** (vkpeak) and **Local LLM in the VM, Vulkan**
(llama.cpp's `llama-bench`). They come from the Venus spike in [`gpu/venus-spike`](../../gpu/venus-spike/REPORT.md): a
Linux VM on libkrun whose Vulkan calls travel through virglrenderer's Venus protocol to MoltenVK and the Mac's GPU.
The spike is research code and **experimental**; this folder only measures it.

`tools/bench vulkan` runs everything below and prints the table. Do it by hand to see each step.

## 1. Build the spike (once)

Follow [`gpu/venus-spike/BUILD.md`](../../gpu/venus-spike/BUILD.md) exactly; it pins every source by tag and commit.
In short, with `W` the folder that holds the whole build (the default of this tooling is `out/work-gs`):

```sh
export W=$PWD/out/work-gs
export VMAPP_WORK=$W
# host stack: MoltenVK, libepoxy, virglrenderer (slp fork), libkrun, the launcher       (BUILD.md, "Host stack")
# guest:
gpu/venus-spike/kernel/build.sh          # the pinned 6.18.56 kernel with the GPU overlay      -> $W/kernel-gs/out/Image
gpu/venus-spike/guest/build-rootfs.sh    # Debian trixie root disk: Mesa Venus, llama.cpp, vkpeak -> $W/guest/rootfs.ext4
# native baselines, from the same sources and the same prefix ("Host tools used for baselines" in BUILD.md):
#   llama.cpp three ways (Metal, MoltenVK, CPU), vkpeak, Vulkan Loader     -> $W/build/llama-metal, llama-vk, vkpeak
```

Needs: Xcode with the command-line tools, cmake, meson, ninja, Rust, Docker (arm64). The spike's own build folder was 21 GB,
of which 5 GB is cloned sources, 8 GB models (four of them) and 1.7 GB the conformance suite you do not need for these
numbers. Nothing is installed system-wide.

## 2. The model

The LLM row uses **Meta Llama 3.1 8B Instruct, Q4_K_M** (4.9 GB). [`models.json`](models.json) has its URL (pinned to a
commit of the Hugging Face repository), size and sha256. `run.sh` downloads it into `$W/cache/models/` when missing and
refuses a file with another sha256. To fetch it yourself:

```sh
curl -fL -o $W/cache/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/bf5b95e96dac0462e2a09145ec66cae9a3f12067/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"
shasum -a 256 $W/cache/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf   # 7b064f58...3033557c
```

The smaller models of the report (Qwen2.5 0.5B, 1.5B, 3B) work the same way: put the GGUF into `$W/cache/models/` and set
`BENCH_VULKAN_MODEL=<file name>`.

## 3. Run

```sh
bench/vulkan/run.sh                  # everything: info, vkpeak, llama; logs in $VMAPP_WORK/bench/vulkan/
bench/vulkan/run.sh vkpeak           # or one part
node bench/vulkan/parse.js           # the logs as JSON
```

Environment: `VMAPP_GS_WORK` (the build, default `out/work-gs`), `BENCH_OUT` (the logs), `BENCH_RUNS` (`llama-bench -r`,
default 3), `BENCH_VULKAN_MODEL`. The build is used read-only. The commands it runs are the spike's own, so you can
paste them:

```sh
W=$PWD/out/work-gs; P=$W/prefix; M=$W/cache/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf
export SPIKE_RUN_DIR=/some/folder/for/logs          # optional: keeps the logs out of $W/run

# a) does the VM see the GPU?  expect: deviceName = Virtio-GPU Venus (Apple M4 Max)
VMAPP_WORK=$W gpu/venus-spike/run-guest.sh info info gpu=8192 mem=4096 cpus=2

# b) vkpeak in the VM, then natively through MoltenVK
VMAPP_WORK=$W gpu/venus-spike/run-guest.sh vkpeak vkpeak gpu=8192 mem=4096 cpus=2
VK_DRIVER_FILES=$P/share/vulkan/icd.d/MoltenVK_icd.json DYLD_LIBRARY_PATH=$P/lib MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0 \
  $W/build/vkpeak/vkpeak 0

# c) llama-bench in the VM (Vulkan through Venus), natively on Metal, natively on MoltenVK
VMAPP_WORK=$W gpu/venus-spike/run-guest.sh llama llama gpu=24576 mem=12288 cpus=8 \
  model=Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf mode=vk args=-p,512,-n,128,-r,3
$W/build/llama-metal/bin/llama-bench -m $M -p 512 -n 128 -r 3
VK_DRIVER_FILES=$P/share/vulkan/icd.d/MoltenVK_icd.json DYLD_LIBRARY_PATH=$P/lib MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0 \
  $W/build/llama-vk/bin/llama-bench -m $M -ngl 99 -p 512 -n 128 -r 3
```

`MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0` is required for the VM (REPORT.md, finding B2) and is used for the native
MoltenVK run too, so the two are comparable. Native **Metal** is the reference the README quotes ("92% of native Metal").

## 4. Reading the output

- `vkpeak` prints `fp32-scalar = 15776.73 GFLOPS` and similar lines. The README's "15.78 TFLOPS" is `fp32-scalar`.
- `llama-bench` prints a table; `pp512` is prompt processing and `tg128` is generation, in tokens per second
  (`mean ± standard deviation` over the `-r` repetitions). The README's 72.7 is `tg128` of the VM line.
- The guest log prefixes every line with a timestamp; `parse.js` strips it. A line `krun_devices::virtio::vsock::muxer ERROR
  unexpected dgram pkt: 3` in a guest log is harmless noise from libkrun.

## 5. The product backend (not here yet)

The spike is not D9010 VmApp's shipping path. When the experimental Vulkan backend of D9010 VmApp itself exists, it will have its own
tests in `tests/gpu-vulkan/`, and `tools/bench vulkan` will run **`tests/gpu-vulkan/run.sh --bench`** after the spike and
store its result next to the spike's. The contract is in [docs/BENCHMARKS.md](../../docs/BENCHMARKS.md#the-hook-for-d9010-vmapps-own-vulkan-backend).
