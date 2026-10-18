# Venus GPU spike: Vulkan pass-through into a Linux VM on macOS

The stack is libkrun, virglrenderer and MoltenVK, tested on an Apple M4 Max with macOS 15.7.7 (October 2026). Pins
and build commands are in [BUILD.md](BUILD.md). Raw evidence is in [results/](results/).

## 1. Verdict

**Vulkan from a Linux VM reaches the Apple GPU and is fast. It isn't yet a production-grade OS-level driver.**

| Question | Answer |
|---|---|
| Does Venus work here? | **Yes.** The guest sees `Virtio-GPU Venus (Apple M4 Max)`. Compute, offscreen graphics, llama.cpp, vkpeak and the Vulkan CTS run on the real GPU. |
| Performance | fp32 15.78 TFLOPS in the VM vs 15.79 native. llama.cpp generation runs at 92–97% of native Metal and 100–115% of native MoltenVK; prompt processing at 71–79% of native Metal. That's 2.3–2.6× (generation) and 5.7–11.9× (prompt) faster than CPU-only in the same VM. |
| Can libkrun boot D9010 VmApp's kernel? | **Yes.** The pinned 6.18.56 kernel with a small config overlay boots directly in about 0.1 s. |
| Standard ICD ABI? | **Yes.** It's the Khronos `libvulkan.so.1` loader plus the Mesa Venus ICD; unmodified `vulkaninfo`, vkpeak, llama-bench and deqp-vk run. |
| Production grade? | **No, not today.** Timeline semaphores crash or hang the VMM; error paths can deadlock the virtio-gpu worker; device loss isn't reported to the guest; the guest API is capped at Vulkan 1.3; portability-subset features are exposed wrongly; there's no GPU time limit; and the host component is a fork of an old virglrenderer. |

**Recommendation:**
- **NO-GO** as a general production OS-level driver now.
- **GO** for an opt-in, experimental, compute-first `gpu` capability, plus the follow-up work in §11.
- Keep llama.cpp RPC as the shipping inference path until those conditions are met.

## 2. Stack (built from source; pins in BUILD.md)

- **Host:**
  - libkrun v1.19.6 (Apache-2.0);
  - the slp virglrenderer fork 0.10.4e-krunkit (MIT; in-process Venus context, plus a pointer-based blob-sharing path
    for macOS);
  - MoltenVK v1.4.2 (Apache-2.0);
  - libepoxy 1.5.10.
- **Guest:** Mesa 26.2.5 (Venus), Linux 6.18.56 (D9010 VmApp pins), Debian trixie userland.
- **Workloads:** llama.cpp b11669, vkpeak, Vulkan CTS 1.4.4.0.
- **Launcher:** a ~150-line C program on libkrun's C API (`launcher/spike-vm.c`), with only
  `com.apple.security.hypervisor`. krunkit v1.3.2 only boots EFI disk images, so it wasn't used.
- **Kernel overlay** (`kernel/spike-gpu.config`): `VIRTIO_MMIO` (libkrun's devices are MMIO), `EXT4_FS` (the spike's
  root disk), `MAGIC_SYSRQ`, `DRM`, `DRM_VIRTIO_GPU`, `DRM_VIRTIO_GPU_KMS` and `SYNC_FILE`. The image is 8.8 MB
  (7.6 MB without DRM).

## 3. Evidence

**First light:**
```
[drm] features: +virgl +edid +resource_blob +host_visible +context_init   cap set id 4 = VENUS
GPU0: apiVersion = 1.3.0  driverVersion = 26.2.5  vendorID = 0x106b
      deviceName = Virtio-GPU Venus (Apple M4 Max)  driverID = DRIVER_ID_MESA_VENUS
```

**vkpeak:**

| | fp32 | fp16 vec4 | int32 | int8 dotprod | copy device→device | copy host→device |
|---|---|---|---|---|---|---|
| VM, through Venus | 15 777 GFLOPS | 15 924 | 4 036 GIOPS | 56 788 | 178 GB/s | 50 GB/s |
| Native MoltenVK | 15 787 | 16 023 | 4 037 | 57 267 | 199 GB/s | 71 GB/s |

**llama.cpp `llama-bench -p 512 -n 128 -r 3`**, Q4_K_M, tokens/s, prompt (pp512) / generation (tg128):

| Model | Native Metal | Native MoltenVK | **VM, Venus** | VM, CPU only (12 vCPU) | Native CPU |
|---|---|---|---|---|---|
| Qwen2.5 0.5B | 13681 / 384 | 8915 / 323 | **9752 / 372** | 821 / 151 | 1587 / 155 |
| Qwen2.5 1.5B | 4409 / 244 | 3243 / 208 | **3263 / 229** | 568 / 100 | 562 / 72 |
| Qwen2.5 3B | 2163 / 143 | 1534 / 127 | **1566 / 134** | 248 / 52 | 221 / 36 |
| Llama 3.1 8B | 870 / 79.1 | 685 / 70.1 | **686 / 72.7** | 113 / 30.0 | 65 / 21.8 |

Both MoltenVK columns use `MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0`, which the VM needs (B2). The gap to Metal comes
from the Vulkan backend and MoltenVK, not from virtualisation.

*Reproduction note (2026-10-15, later the same day):* `tools/bench vulkan` (see `bench/vulkan/` and `docs/BENCHMARKS.md`)
re-ran the Llama 3.1 8B row three times on a quieter machine: VM 73.3 / 685 (generation / prompt, tokens/s, median of three
runs), native MoltenVK 70.2 / 682, **native Metal 86.3 / 901**. The VM and MoltenVK numbers match this table; native Metal
generation came out higher than the 79.1 above (83.6 to 86.8 in the three runs), so the VM is at about 85% of native Metal
for generation and 76% for prompt processing, not 92%. The fp32 vkpeak figures were 15 751 and 15 749 in the VM against 15 758
and 15 750 natively. The numbers above are left as they were measured.

**Graphics:** a 512×512 offscreen triangle on the Venus device gave 64 082 red pixels (analytic 64 000) and no stray
pixels; **PASS**. Each submit + wait + readback took 0.16–0.19 ms.

**Other libkrun features D9010 VmApp would use:**
- vsock: host-initiated and guest-initiated both work; 33 µs round trip, 1.2–1.5 GiB/s.
- Read-only and read-write virtiofs shares work.
- Clock: the PL031 RTC is emulated and the guest clock is correct.
- Guest poweroff exits the VMM with code 0.
- Two GPU VMs ran at once.
- Boot to userspace takes 0.13 s; with the GPU and the render test, 0.32 s.

## 4. Conformance: Vulkan CTS 1.4.4.0 (dEQP-VK, linux-arm64)

The same case lists ran in the VM (Venus) and natively (MoltenVK 1.4.2). About 60 000 cases were run, from strided
official mustpass lists.

| Group (cases run) | Venus: pass / fail / not supported | Native: pass / fail / not supported | Problems only in the VM |
|---|---|---|---|
| `api.*` (every 10th, 29 862) | 8276 / 2 / 21583 | 9740 / 3 / 20118 | 1 pass→fail; 1467 pass→not supported (no `VK_KHR_maintenance5` in the guest) |
| `memory.*` (all, 6165) | 4876 / 8 / 1281 | 4903 / 8 / 1254 | none (the same 8 fail natively) |
| `compute.*` (filtered, 773) | 716 / 0 / 57 | 717 / 0 / 56 | none |
| `synchronization.basic.*` (24) | 18 pass, then **VMM crash** at `timeline_semaphore.chain` | 24 / 0 / 0 | **B3** |
| `synchronization.*` without timeline (every 20th, 1886) | 519 / 0 / 1367 | 649 / 0 / 1237 | none (130 pass→not supported) |
| `synchronization.*` with timeline | **crashed after 2 cases** | 995 / 0 / 2235 | **B3** |
| `renderpasses.*` (every 15th, 5172) | 1788 / 109 / 3275 | 1953 / 246 / 2973 | none |
| `pipeline.monolithic.*` (every 50th, 5571) | 2134 / 48 / 3388 | 2189 / 1 / 3381 | **47 failures**, all `sampler...lod.select_bias_*` (B5) |

## 5. ABI and the proposed "D9010 VmApp GPU profile v0.1"

**The ABI is confirmed:**
- the Khronos loader `libvulkan.so.1.4.309`;
- the Venus ICD json, pointing to `libvulkan_virtio.so`;
- `/dev/dri/card0` and `renderD128` (a runtime needs a group or udev rule).

**The observed profile** (machine-readable in `results/vkinfo-venus-guest.json`):
- **Device:** 1 integrated UMA device, `Virtio-GPU Venus (<host GPU>)`.
- **API version:** device 1.3.0 (the host offers 1.4.357; the guest is capped by the old Venus protocol), instance
  1.4.309.
- **Features:** all 15 Vulkan 1.3 features. Unsupported base features: geometry shaders, wide lines, float64,
  logicOp, depth bounds, pipeline statistics, cull distance, variable multisample rate, sparse.
- **Extensions:** 88 (the host has 129). Missing vs the host include `KHR_maintenance5..9`, `EXT_host_image_copy`,
  `EXT_memory_budget` and `KHR_portability_subset`.
- **Limits:** equal to the host except 9 per-stage and per-set limits, which are roughly halved.
- **Queues:** 4 families (graphics, compute and transfer).
- **Presentation:** swapchain and headless surface are advertised, but there's no path to the host window yet.
- **Undeclared deviations (B5):** `samplerMipLodBias`, `pointPolygons`, `tessellationIsolines/PointMode` and triangle
  fans.

**Proposal:** version profiles as `vmapp-gpu-<major>.<minor>`. A manifest `gpu` capability pins a profile, the
Inspector shows device, API and driver, and the profile is bumped with each host-stack upgrade.

## 6. Blockers and findings

- **B1 (16 KiB blob alignment):** Apple's hypervisor maps 16 KiB pages, so stock guest Mesa fails at
  `vkCreateInstance`. Two fixes were verified:
  - (a) a Mesa patch that rounds allocations;
  - (b) Mesa ≥ 26.2.4 plus a ~30-line guest kernel patch (`virtio_gpu.blob_alignment=16384`). This is the right
    shape for D9010 VmApp, because D9010 VmApp owns its kernel.
- **B2 (argument buffers):** MoltenVK Metal argument buffers plus Venus lose the device ("Invalid Resource") during
  llama.cpp generation. The workaround is `MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0`, which is also faster. Device loss
  is never reported to the guest, so the VM wedges; the Mac doesn't.
- **B3 (timeline semaphores):** they crash or hang the VMM. Two crash types:
  - a SIGSEGV in `venus_state_cb_retire_fence`;
  - a SIGABRT in MoltenVK's allocation pool.

  The virtio-gpu worker also blocks in `vkr_dispatch_vkWaitRingSeqnoMESA`. Upstream runs Venus contexts in a separate
  render server, while the macOS fork runs them in the worker. Timeline semaphores are core Vulkan 1.2, so this is a
  conformance and stability blocker.
- **B4 (error paths):** a failed pipeline creation hangs Venus; the fork lacks upstream's fatal-wait check. Some
  unimplemented virtio-gpu commands in libkrun `panic!()`, so a guest can abort its own VMM. Needs hardening.
- **B5 (portability subset):** the guest doesn't see `VK_KHR_portability_subset`, so features the host lacks look
  available. This explains all 47 VM-only CTS failures.
- **B6 (old fork):** the fork is based on virglrenderer 0.10.4 (11 macOS commits). Upstream 1.3.0 changed Venus
  substantially, so a rebase is real work.
- **B7 (no GPU time limit):** a 42.7 s dispatch ran unpre-empted. The launcher must supervise it.
- **B8 (shares fixed at boot):** libkrun can't re-point virtio-fs at run time, so D9010 VmApp's grant slots need a small
  libkrun change.
- **B9 (memory):** the balloon only does free-page reporting, and RAM plus the GPU window must fit the IPA space.

## 7. Host translator: MoltenVK vs KosmicKrisp

- **MoltenVK 1.4.2:** builds in 2 minutes. It reports API 1.4.357 and conformance 1.4.4.0 *as a portability
  implementation*.
- **KosmicKrisp (Mesa, LunarG):**
  - **Can't run on macOS 15.** It's built on Metal 4, which needs macOS 26; the `MTL4*` classes are missing on 15.7.7.
  - **Not built here.** It needs LLVM ≥ 20.1.8 and other tooling, and the result couldn't have run.
  - **Reported conformance:** press reports claim Vulkan 1.4 CTS conformance (October 2026). Not verified here.
- **Design consequence:** keep the host Vulkan implementation behind the loader. Upstream virglrenderer 1.x
  `dlopen`s it, so MoltenVK and KosmicKrisp become interchangeable. Re-run this harness on macOS 26.

## 8. Security and robustness

- **Process model:**
  - Today, libkrun's virtio devices, the Venus decoder, MoltenVK and Metal all run in **one VMM process per VM**.
  - A separate GPU process isn't possible with the current fork: macOS can't export GPU buffers as fds, and the render
    server is compiled out. It's a research item (shared-memory-backed Vulkan memory).
- **The sandbox is proven.** The whole GPU VM ran under a `(deny default)` Seatbelt profile with no network, no
  fork/exec of other programs, and writes only to its run and disk directories.
- **Faults:**
  - Crashes killed only that VM, while another VM kept running.
  - Device loss isn't reported.
  - Worker deadlocks wedge that VM's GPU, so a watchdog is needed (a heartbeat plus a per-submit budget, then kill and
    restart).
- **Attack surface:**
  - **What the host parses:** every guest command goes through libkrun's virtio-gpu worker and the generated Venus
    decoder, all in one process.
  - **Validation review:** all guest-controlled sizes, offsets and handles need a systematic review, because the
    macOS sharing path replaces the fd path that upstream has audited.
  - **Controls:**
    - a sandboxed VMM;
    - GPU only when granted;
    - pinned host components;
    - a virtio-gpu feature allow-list;
    - limits on the GPU window and resources.
- **Fuzzing plan:**
  1. ASAN/UBSAN plus libFuzzer on virglrenderer in a Linux container, with lavapipe.
  2. Seeds recorded from CTS and llama.cpp streams.
  3. `cargo-fuzz` on libkrun's virtio-gpu worker.
  4. A macOS harness below the guest's DRM driver.
  5. Differential CTS on every host-stack bump.
  6. The sandboxed VMM run in CI.

## 9. Presenting frames to the host window (later)

libkrun has a display-backend API (`configure_scanout` / `alloc_frame` / `present_frame`):
- **First step, one copy:** an IOSurface or shared-memory buffer, the surface id sent over the control channel, and
  the surface mapped into the app window.
- **Zero copy:** needs `SET_SCANOUT_BLOB` (unimplemented in libkrun) plus Metal texture interop.

The proven offscreen render-and-readback path is enough for the first step.

> **Update 2026-10-15 (after this report).** The owner took option 2 of §11: the experimental, opt-in `gpu` Vulkan capability was built as a
> second launcher backend, `vmapp-vm-krun`, with a gpu kernel flavour, the `node22-gpu` runtime, a sandboxed VMM and a watchdog. What it is
> and is not: [SPEC §8.7](../../SPEC.md), [GOVERNANCE INV-H8](../../GOVERNANCE.md), [gpu/krun/README.md](../krun/README.md). Of the §11
> conditions it does **item 4 partly** (a sandboxed VMM and a watchdog; no budgets, no fuzzing) and **item 5** (the kernel flavour and Mesa
> 26.2.5 in the runtime), and back-ports the fatal-wait part of item 1; the rest is open. Measured on the new stack (sandbox on,
> `tests/gpu-vulkan/run.sh`): vkpeak fp32 15.6 TFLOPS; llama-bench Q4_K_M pp512/tg128 tokens/s: 0.5B 9080 to 9709 / 359 to 372,
> 1.5B 3265 / 222, 3B 1562 / 134 (§3's VM column: 9752 / 372, 3263 / 229, 1566 / 134).

## 10. Production integration: a second launcher backend, `vmapp-vm-krun`

- **Proven in the spike:**
  - direct kernel and initramfs boot;
  - vsock ports, with the host using AF_UNIX sockets declared before boot;
  - static and read-only virtiofs;
  - the console;
  - poweroff;
  - RTC and RNG;
  - the GPU (`krun_set_gpu_options2(VENUS | NO_VIRGL, window)`).
- **Needs work:**
  - the 8 grant slots (B8);
  - read-only virtio-blk (the API exists, but wasn't exercised);
  - a kernel flavour split (MMIO plus DRM for GPU apps);
  - entitlement `com.apple.security.hypervisor` with Developer ID signing (untested).
- **Licences** are all compatible: Apache-2.0 and MIT, plus Linux's GPL-2.0, already covered by the existing source
  offer.
- **Footprint:** about 14.7 MB on the host, and about 4 MB in the guest.
- **Effort (rough):**
  - rebase virglrenderer and fix the deadlocks, device loss and portability subset: 3–6 engineer-weeks;
  - libkrun hardening and re-pointable shares: 1–3 weeks;
  - sandbox, watchdog and budgets: 1–2 weeks;
  - fuzzing and a CI conformance gate: 2–4 weeks;
  - windowed presentation: a separate project.

## 11. Go / no-go against "production OS-level driver" criteria

| Criterion | Status |
|---|---|
| Standard Vulkan ICD ABI; unmodified binaries | **PASS** |
| Performance | **PASS** |
| API/ABI completeness, versioned profile | **PARTIAL**: 1.3 vs 1.4; 88 of 129 extensions |
| Conformance (CTS) | **FAIL**: parity in 4 groups; portability failures; the timeline crash |
| Stability under CTS | **FAIL**: B3, B4 |
| Fault isolation, device-lost semantics | **PARTIAL** |
| Security hardening | **NOT YET**: the sandbox is proven; the audit, fuzzing and limits aren't done |
| Maintainability | **RISK**: an old fork |
| Platform scope | **LIMITED**: MoltenVK on macOS 15; KosmicKrisp needs 26 |
| Licences, size | **PASS** |

**Decision:** no-go for a general production GPU driver now. Go for an experimental, opt-in, compute-first `gpu`
capability, with these conditions in order:
1. Rebase the macOS virglrenderer delta onto current upstream. That brings Vulkan 1.4, the fatal-wait fix, and a
   loader-based host Vulkan.
2. Make the control-queue worker non-blocking, and propagate device loss. Then re-run the synchronization groups to
   native parity.
3. Mask or expose the portability subset, publish profile v0.2, and add a CTS regression gate.
4. Add a sandboxed VMM, a watchdog and per-VM GPU and RAM budgets, and fuzz the decoder and the macOS delta.
5. Ship the kernel blob-alignment fix in a GPU kernel flavour, and require Mesa ≥ 26.2.4 in GPU runtimes.
6. Re-evaluate on macOS 26 with KosmicKrisp.

## 12. Not done

- Only strided CTS samples (about 60 000 cases, 7 groups). No draw, glsl, image or ycbcr groups.
- KosmicKrisp wasn't run.
- No windowed presentation.
- No Developer ID or App Sandbox test.
- The watchdog was tested to 43 s only.
- No soak tests.
- The spike's patches are spike quality, not upstream quality.
- Generation numbers vary 3–10% between runs; quoted tables are from quiet repeats.

## 13. Files

- **Here:** `BUILD.md`, `launcher/`, `run-guest.sh`, `vsock-host-test.py`, `cts-summary.sh`, `cts-compare.sh`,
  `kernel/` (overlay, checks, blob-alignment patch), `guest/` (rootfs and CTS Dockerfiles, Mesa patch, tools),
  `results/`.
- **Build outputs** (git-ignored): `out/work-gs/`.
