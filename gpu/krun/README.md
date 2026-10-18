# gpu/krun: the host libraries of the EXPERIMENTAL Vulkan GPU backend

> **Experimental and opt-in.** This is the reproducible build of the stack the Venus spike proved
> ([../venus-spike/REPORT.md](../venus-spike/REPORT.md)): Vulkan from a Linux VM reaches the Apple GPU through
> libkrun, virglrenderer (Venus) and MoltenVK. The spike's verdict stands: **not a production driver** (timeline
> semaphores crash or hang the VMM, device loss is not reported, no GPU time limit, old virglrenderer fork). The shipping
> GPU path remains llama.cpp RPC ([../README.md](../README.md)). Nothing in the default build uses these libraries.

This folder turns the spike's ad-hoc recipe ([../venus-spike/BUILD.md](../venus-spike/BUILD.md)) into pinned,
relocatable build scripts. `build-libs.sh` builds the four host libraries; `build.sh` builds the whole backend into
`out/krun/` (libraries + the launcher `vmapp-vm-krun` from `host/` + the VMM's sandbox profile `vmm.sb`). The design, the
sandbox, the watchdog and what is and is not supported are SPEC §8.7 and GOVERNANCE INV-H8; this file is the build
and the maintainer's notes.

```sh
export VMAPP_WORK=/abs/scratch
gpu/krun/build.sh                  # libraries + launcher -> out/krun/{lib,bin,share,licenses}; --check verifies, --libs-only stops after the libraries
kernel/build.sh --flavour gpu      # the guest kernel -> out/Image-gpu (needs Docker)
tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img
bash tests/gpu-vulkan/build-core.sh                  # the test core (vulkaninfo, vkpeak, llama-bench, ...)
bash tests/gpu-vulkan/run.sh [--e2e]                 # real VMs on the real GPU (numbers in $VMAPP_WORK/gpu-vulkan/results.txt)
```

| File | What |
|---|---|
| `build.sh` | the orchestrator: `build-libs.sh`, then `cargo build --locked` of `host/` with the pinned toolchain, ad-hoc signing with `host/krun.entitlements`, installs `out/krun/bin/vmapp-vm-krun` and `out/krun/share/vmm.sb` |
| `vmm.sb` | the VMM's sandbox profile (INV-H8; `tools/check-invariants` rule `h8-krun-sandbox` holds it to a closed list of rules) |
| `build-libs.sh`, `pins.env`, `requirements.txt`, `patches/`, `PATCHES.md` | the libraries, below |

**Run it by hand** (the loader does this when all three switches of SPEC §8.7 are on):

```sh
out/krun/bin/vmapp-vm-krun run --kernel out/Image-gpu --initramfs out/initramfs.cpio \
  --runtime out/runtimes/node22-gpu.img --core app/core.cpio --appdata /tmp/appdata \
  --start '{"command":["node","main.js"],"workdir":"/app","env":[]}' --socket /tmp/vmapp-x/b.sock --console /tmp/x.log \
  --memory 4096 --cpus 4 --gpu-window 8192
```

It prints the same JSON lines as `vmapp-vm` (SPEC §5). The launcher finds `lib/` and `share/vmm.sb` in the folder above its own
executable (`--krun-dir DIR` overrides). On macOS 15, with a full-disk system volume, set `TMPDIR` to a folder with room: the
launcher puts a padded copy of the core image and the VMM's run folder (`vmapp-<id>-k`, sockets must stay under 104 bytes) there.

**Maintainer's notes**

- *Signing for distribution.* Everything is ad-hoc signed. A Developer ID release needs the hardened runtime on `vmapp-vm-krun`, the four
  libraries signed with the same identity (library validation), and the entitlement `com.apple.security.hypervisor` only. `loader/build/sign-mac.sh`
  does not know these files yet; `loader/build/package.mjs --with-krun` copies them next to the other VM bits for a developer's own Mac.
- *Sandbox changes.* To find what a new MoltenVK or macOS needs, run a VM and watch the kernel's denials:
  `log stream --style compact --predicate 'process == "kernel" AND eventMessage CONTAINS "deny"'`. Benign today: `user-preference-read`, metadata
  reads of volume mount points, `DiskArbitration` and `coreservicesd` look-ups. Anything that makes the VMM crash (Metal's device discovery
  dereferences a refused bundle lookup) must be allowed; every rule you add is a rule `h8-krun-sandbox` must list.
- *libkrun behaviours the launcher works around.* (1) The host's end-of-file on a vsock Unix socket resets the whole connection (no half-close),
  and libkrun keeps its end for about 5 s: the network proxy closes both directions when its target is done
  (`NetOptions::close_both_on_target_eof`), the launcher polls the guest every 500 ms instead of every 100 ms, and the VMM raises its descriptor
  limit. A patch that sends a vsock shutdown instead of a reset would remove all three. (2) `krun_start_enter` never returns: libkrun calls
  `exit()` when the guest powers off, hence the VMM is a child process. (3) Virtiofs ownership is simplified (`krun_add_virtiofs4`,
  `KRUN_SEMANTICS_LINUX_SIMPLIFIED`) so the app user can write a share owned by the Mac user.
- *Metal's shader cache.* The profile lets the VMM write `<DARWIN_USER_CACHE_DIR>/com.apple.metal`, the cache every Metal program of the user shares.
  `com.apple.metalfe` is not allowed (metadata reads of it are denied and harmless).

| File | What |
|---|---|
| `pins.env` | Every pinned input: repo, tag and **full commit** of MoltenVK, libepoxy, virglrenderer (slp fork) and libkrun; the Rust toolchain, the `rustup-init` download and its sha256; meson/ninja versions; the Debian packages of libkrun's init sysroot (sha256). Plain `KEY=VALUE`, read it, never `source` it. |
| `requirements.txt` | meson and ninja, pinned **by wheel hash** (pip `--require-hashes`). |
| `patches/*.patch` | `git apply` patches on the pinned virglrenderer commit, each with a what/why/upstream header. [PATCHES.md](PATCHES.md) explains them (including why the upstream "fatal wait" fix is backported). |
| `build-libs.sh` | The build. |

## Build

```sh
export VMAPP_WORK=/abs/scratch                    # default: vmapp/out/work (git-ignored)
gpu/krun/build-libs.sh                            # -> vmapp/out/krun/        (first run ~10 min incl. Rust + crates; --clean with warm caches ~2 min; unchanged inputs: a no-op)
gpu/krun/build-libs.sh --check                    # exit 0 when out/krun is complete, current for the pins, signed, relocatable
gpu/krun/build-libs.sh --out DIR                  # -> DIR/krun/
gpu/krun/build-libs.sh --clean                    # wipe sources/build/prefix/output, build from scratch
```

Other options: `--clean-all` (also the Rust toolchain and the venv), `--clean-only`, `--force`, `--verbose`; `--help` lists them.
Logs: `$VMAPP_WORK/krun-build/logs/<step>.log` (the tail is printed when a step fails).

Needs (nothing is installed for you): macOS on Apple silicon, the full **Xcode** app (MoltenVK is an Xcode project),
`git`, `curl`, `python3` >= 3.8, and `cmake` and `pkg-config` (Homebrew's are fine; they are linked into a private PATH,
nothing else from `/opt/homebrew` is visible to the build). Network access for the clones, crates.io, `static.rust-lang.org`,
PyPI and `snapshot.debian.org`. Everything it creates lives under `$VMAPP_WORK/krun-*` and `$VMAPP_WORK/cache/dl`:

| Folder | Content |
|---|---|
| `krun-src/` | the shallow clones (`git clone --depth 1 --branch <tag>`, **refused unless HEAD is the pinned commit**) |
| `krun-build/` | build folders, logs, the Debian sysroot, tool shims |
| `krun-prefix/` | intermediate install prefix (with the install names the build produced; never shipped) |
| `krun-rust/` | cargo + rustup, the pinned toolchain (rustup-init verified by sha256) |
| `krun-venv/` | pinned meson + ninja |
| `cache/dl/` | `rustup-init`, the 4 Debian packages (all sha256-verified) |

Each component is rebuilt only when its inputs changed (its pins, its patches, its recipe, the inputs of what it links);
`--force` rebuilds everything.

## Outputs: `out/krun/`

```
lib/libkrun.1.dylib  lib/libvirglrenderer.1.dylib  lib/libepoxy.0.dylib  lib/libMoltenVK.dylib
include/libkrun.h
licenses/        per-component licence files, libkrun-crates.txt + libkrun-crates/, rust/, debian/, NOTICES.txt
BUILD-INFO.txt   pins, patch hashes, tool versions, minos per library, sha256 + size of every output
```

Sizes (2026-10-15 build): libMoltenVK 5.3 MB, libkrun 5.75 MB (init program embedded), libvirglrenderer 2.3 MB,
libepoxy 1.26 MB, about 14.6 MB in all; licenses/ 3 MB. All four are thin arm64 libraries, ad-hoc signed. Hashes are in
`BUILD-INFO.txt`. Two consecutive `--clean` builds on the same machine gave byte-identical libraries.

**Relocatable**: install names are `@rpath/<name>`, `libkrun` and `libvirglrenderer` reference their siblings as
`@rpath/<name>`, and the rpath of the two that need one is `@loader_path`. The libraries reference nothing but system
libraries and each other, and no string of the build machine (`/opt/homebrew`, the repo, `$VMAPP_WORK`, `$HOME`) is left
in them (`--check` greps for it). A launcher links `libkrun` with `-Wl,-rpath,@executable_path/../lib` and the whole
`krun/` folder can be moved or copied anywhere (this is how the spike launcher was verified, see below).

## What is built, and the choices

| Component | Pin | Notes |
|---|---|---|
| libkrun | v1.19.6 `227b2de6` | `make BLK=1 GPU=1`. **NET is not built**: it is libkrun's own virtio-net code (passt/gvproxy/tap), nothing here uses it, and the C API the launcher needs (`krun_add_disk3`, `krun_add_virtiofs3`, `krun_add_vsock*`, `krun_set_gpu_options2`, `krun_set_kernel`) does not need it. So a network device cannot be attached at all, even by a bug. |
| virglrenderer | slp fork `0.10.4e-krunkit` `bfec2d27` + 3 patches | Venus in-process, no render server, no GL path; links `libMoltenVK` directly (no Vulkan loader) |
| libepoxy | 1.5.10 `c84bc945` | link dependency of virglrenderer only |
| MoltenVK | v1.4.2 `db660224` | Xcode `MoltenVK Package (macOS only)`, arm64 |
| Rust | 1.99.1 | rustup-init 1.29.1, sha256 `ec1b9233...ac696a` |
| meson / ninja | 1.9.1 / 1.13.2 | pip wheels pinned by hash |

Notes that matter to the launcher author:

- **vsock/TSI is still compiled in.** libkrun creates an *implicit* vsock device with TSI socket hijacking (a network
  path to the host) unless the launcher calls `krun_disable_implicit_vsock()` and then `krun_add_vsock(ctx, 0)`. The spike
  launcher does so; `vmapp-vm-krun` must too.
- **`MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0` must be set in the VMM process** (spike REPORT B2).
- The VMM process needs the `com.apple.security.hypervisor` entitlement (the spike's launcher is ad-hoc signed with it).
- libkrun's embedded init program is a static Linux binary linked against Debian's glibc (LGPL-2.1+) and libgcc; the
  Debian packages are pinned and their copyright files are in `licenses/debian/` (see `NOTICES.txt`).
- Deployment target 13.0 for the meson and cargo builds (`MACOS_DEPLOYMENT_TARGET`), MoltenVK keeps its own (12.0).
  Only macOS 15 on an M4 Max has been tested.

## Updating a pin

Change the values in `pins.env` (tag **and** commit: `git ls-remote <repo> refs/tags/<tag>`; for an annotated tag use the
`^{}` line), run the script. For a new Rust version also update `RUSTUP_INIT_*` if rustup-init changes (the sha256 is next
to the download: `.../rustup-init.sha256`). For meson/ninja, replace the hashes in `requirements.txt` (PyPI JSON API). A
new virglrenderer pin will probably need the patches redone: `build-libs.sh` stops at the first one that does not apply.

## How it fits

`host/` holds `vmapp-vm-krun` (host/src/krun.rs, cli.rs, bin/vmapp-vm-krun.rs), the second launcher backend; its VMM child loads
`out/krun/lib/libkrun.1.dylib` with `dlopen`. The guest side is `kernel/flavours/gpu/` (kernel), `runtimes/node22-gpu/` (Mesa Venus,
the liveness probe) and `guest/` (`vmapp-init`). The spike's own guest (`../venus-spike/guest/`) is research only.

## Verified how (2026-10-15, M4 Max, macOS 15.7.7, Xcode 26.2)

End to end with the spike's own launcher and guest, from a **copy** of `out/krun/lib` in another folder, no `DYLD_*`
variable, launcher rpath `@executable_path/../lib`:

```sh
K=vmapp/out/krun  R=$VMAPP_WORK/krun-build/vmcheck/reloc
mkdir -p $R/bin $R/lib && cp $K/lib/*.dylib $R/lib/
clang -O2 -I$K/include -o $R/bin/spike-vm-check gpu/venus-spike/launcher/spike-vm.c $R/lib/libkrun.1.dylib \
      -Wl,-rpath,@executable_path/../lib
codesign --entitlements gpu/venus-spike/launcher/spike-vm.entitlements --force -s - $R/bin/spike-vm-check
# a COPY of the spike rootfs (the guest mounts it read-write): cp -c .../work-gs/guest/rootfs.ext4 $VMAPP_WORK/krun-build/vmcheck/
MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0 $R/bin/spike-vm-check --cpus 2 --mem 4096 --kernel <spike kernel-gs/out/Image> \
  --cmdline "console=hvc0 root=/dev/vda rootfstype=ext4 rw init=/spike/init panic=-1 loglevel=4 spike.test=info" \
  --disk <rootfs copy> --virtiofs spike=gpu/venus-spike/guest/scripts:ro --gpu=8192        # spike.test=offscreen likewise
```

Result: the guest's `vulkaninfo` shows `deviceName = Virtio-GPU Venus (Apple M4 Max)`, `driverID = DRIVER_ID_MESA_VENUS`,
`apiVersion = 1.3.0`; the `offscreen` test passes (`pixels: red=64082 black=198062 other=0`, 0.158 ms per submit + wait +
readback), the same numbers as in the spike report. The VM powers off by itself. (This is a smoke test of the build, not a
conformance run; the CTS groups of the spike report are the regression gate to use before relying on a changed pin or patch.)
