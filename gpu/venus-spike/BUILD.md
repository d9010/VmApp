# Venus spike: how everything was built (reproducible record)

Research spike, not product code. Host: Apple M4 Max, macOS 15.7.7, Xcode 26.2. Everything lives under one scratch
folder, `VMAPP_WORK=<repository>/out/work-gs` (`W` below), prefix `P=$W/prefix`.
No Homebrew install was needed; system-wide changes: none. Docker (arm64 daemon) builds the guest side.

## Pinned sources (tag + commit)

| Component | Version | Commit | Licence | Role |
|---|---|---|---|---|
| libkrun | v1.19.6 | `227b2de6ed323fe180e02f871c5f325a90c13cc2` | Apache-2.0 | VMM on Hypervisor.framework, virtio-gpu device, vsock, virtiofs, block |
| virglrenderer, slp fork | `0.10.4e-krunkit` | `bfec2d27c3953ee0530c459c2f5d042c2b619fa1` | MIT | Venus renderer; in-process context + macOS "map pointer" blob sharing (11 commits on upstream 0.10.4) |
| MoltenVK | v1.4.2 | `db66022459ffb663aa2b50f6b018bc2e124f5edf` | Apache-2.0 | Vulkan 1.4 portability layer over Metal (host Vulkan implementation) |
| libepoxy | 1.5.10 | `c84bc9459357a40e46e2fec0408d04fbdde2c973` | MIT | link dependency of virglrenderer (GL path unused) |
| libkrunfw (baseline only) | v5.6.2 | `f14ac64ca8a04c6c9d76cac1c61ee050809c88c9` | GPL-2.0 / LGPL-2.1 | stock libkrun kernel; prebuilt bundle sha256 `adef6739...984e86` built to `libkrunfw.5.dylib`, **not used** by the final runs |
| krunkit | v1.3.2 | `a096d4aa3dc70fc1b577eaef4829b19abf9fa7ad` | Apache-2.0 | reference launcher (EFI boot); built, not used for the proof |
| Vulkan-Headers / Loader / Tools | vulkan-sdk-1.4.363.0 | `6802bb47...` / `fa218055...` / `6fe2055c...` | Apache-2.0 | host `libvulkan`, `vulkaninfo`, CTS/llama loader |
| shaderc (glslc) | v2026.4 | `b64fd42c4a2a9d501c47aca5d3571f7673a5e9cc` | Apache-2.0 | host shader compiler (native llama.cpp-Vulkan build) |
| Linux (guest kernel) | 6.18.56 (D9010 VmApp pin) | sha256 `4633bbda...cefbf89`, PGP-verified by kernel/ | GPL-2.0 | `kernel/` config + `kernel/spike-gpu.config` (+ optional patch) |
| Mesa (guest Venus driver) | mesa-26.2.5 | `ddaf85e353442d9d7f192fdcf1823e652e3f2ee3` | MIT | `libvulkan_virtio.so` (Venus) |
| Debian | trixie | image `sha256:913f6706...f5c2d5` | various | guest userland (apt package set recorded in image `/spike/dpkg-list.txt`) |
| llama.cpp | b11669 | `620d2225cc436ab0b001e3200e590e3b286ef9ab` | MIT | `llama-bench` (Vulkan + CPU, guest; Metal / MoltenVK-Vulkan / CPU, host) |
| vkpeak | 20260527 | `f108eb11d467eb3d5cdd472f8e080818a117a752` | MIT | compute throughput |
| Vulkan CTS (VK-GL-CTS) | vulkan-cts-1.4.4.0 | `03c0746a55b78eab63c664a11948b52419e1f309` | Apache-2.0 | conformance subsets (guest `vulkan_headless`, host `osx` target) |
| Rust | stable 1.99.1 (rustup-init sha256 `ec1b9233...ac696a`) | | | libkrun, krunkit |
| meson 1.9.1, ninja 1.13.2, cmake 4.3.1 (Homebrew, pre-installed) | | | | build tools (pip venv `$W/venv`) |
| Models (GGUF, Q4_K_M) | Qwen2.5-0.5B/1.5B/3B-Instruct, Llama-3.1-8B-Instruct | sha256 in `$W/cache/models` (1.5B: `6a1a2eb6...e9407e`, 0.5B: `74a4da8c...93d7a9db`) | | benchmarks |

## Host stack (macOS arm64)

```sh
export W=<repository>/out/work-gs P=$W/prefix
export CARGO_HOME=$W/rust/cargo RUSTUP_HOME=$W/rust/rustup
$W/cache/dl/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable
python3 -m venv $W/venv && $W/venv/bin/pip install meson==1.9.1 ninja

# MoltenVK (Xcode, ~2 min)
git clone --depth 1 --branch v1.4.2 https://github.com/KhronosGroup/MoltenVK.git $W/src/MoltenVK
(cd $W/src/MoltenVK && ./fetchDependencies --macos &&
  xcodebuild build -project MoltenVKPackaging.xcodeproj -scheme "MoltenVK Package (macOS only)" \
    -destination "generic/platform=macOS" -derivedDataPath $W/build/moltenvk-dd -quiet)
cp Package/Release/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib $P/lib/          # fat, arm64 slice 5.3 MB
cp -R Package/Release/MoltenVK/include/. $P/libexec/molten-vk/include/             # headers the fork expects
cp Package/Release/MoltenVK/dynamic/dylib/macOS/MoltenVK_icd.json $P/share/vulkan/icd.d/

# libepoxy
meson setup build/libepoxy --prefix=$P -Degl=no -Dglx=no -Dx11=false -Dtests=false -Ddocs=false --buildtype=release
meson compile -C build/libepoxy && meson install -C build/libepoxy

# virglrenderer (slp fork): links -lMoltenVK directly (no loader), venus in-process, no render server
export PKG_CONFIG_PATH=$P/lib/pkgconfig CFLAGS="-I$P/libexec/molten-vk/include" LDFLAGS="-L$P/lib -Wl,-rpath,$P/lib"
meson setup build/virglrenderer --prefix=$P --libdir=lib --buildtype=release \
      -Dvenus=true -Drender-server=false -Dtests=false
meson compile -C build/virglrenderer && meson install -C build/virglrenderer

# libkrun with GPU (init blob is cross-compiled with Apple clang + rust-lld's ld.lld; sysroot downloaded from Debian by the Makefile)
export PATH=$CARGO_HOME/bin:$RUSTUP_HOME/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/gcc-ld:$PATH
(cd src/libkrun && make BLK=1 NET=1 GPU=1 PREFIX=$P && make BLK=1 NET=1 GPU=1 PREFIX=$P install)   # ~20 s

# launcher (tiny C program on libkrun's C API) + ad-hoc signature with the hypervisor entitlement
clang -O2 -Wall -I$P/include -L$P/lib -lkrun -Wl,-rpath,$P/lib -Wl,-headerpad_max_install_names \
      -o $W/bin/spike-vm gpu/venus-spike/launcher/spike-vm.c
install_name_tool -change libkrun.1.dylib $P/lib/libkrun.1.dylib $W/bin/spike-vm
codesign --entitlements gpu/venus-spike/launcher/spike-vm.entitlements --force -s - $W/bin/spike-vm
```

Notes: `libkrun.1.dylib` has a relative install name and no header padding, hence the `install_name_tool -change` on the
launcher. `libMoltenVK.dylib` keeps `@rpath/libMoltenVK.dylib`; virglrenderer carries `-rpath $P/lib`. The Makefile of
libkrun ignores the Homebrew formula's `TIMESYNC=1`. The fork's `meson.build` hard-codes
`-I/opt/homebrew/opt/molten-vk/libexec/include`; the `CFLAGS` above provide the same headers from `$P`.

Host tools used for baselines (all from source, same prefix): Vulkan-Headers, Vulkan-Loader (`libvulkan.dylib`),
Vulkan-Tools (`vulkaninfo` only), shaderc (`glslc`), SPIRV-Headers (from shaderc's third_party), llama.cpp b11669 three
ways (`-DGGML_METAL=ON`; `-DGGML_VULKAN=ON` through MoltenVK; CPU via `-ngl 0`), vkpeak, and `deqp-vk`
(`cmake -DDEQP_TARGET=osx -DSELECTED_BUILD_TARGETS=deqp-vk`, loads `libvulkan.dylib` -> MoltenVK).
Runtime env for host Vulkan tools: `VK_DRIVER_FILES=$P/share/vulkan/icd.d/MoltenVK_icd.json DYLD_LIBRARY_PATH=$P/lib`.

Local patch to the fork (spike experiment, **not** part of the pinned result; see REPORT.md): in
`src/venus_context.c`, `venus_state_cb_retire_fence()` returns instead of asserting when the context is already gone.

## Guest

```sh
export VMAPP_WORK=$W
gpu/venus-spike/kernel/build.sh                 # kernel/ pins + vmapp-guest.config + kernel/spike-gpu.config -> $W/kernel-gs/out/Image (8.8 MB)
gpu/venus-spike/kernel/build.sh --patched       # + kernel/patches/0001-*.patch (blob alignment) -> $W/kernel-gs/out-patched/Image
gpu/venus-spike/guest/build-rootfs.sh           # Debian trixie ext4 (2.5 GiB): Mesa x2, llama.cpp x2, vkpeak, tools -> $W/guest/rootfs.ext4
gpu/venus-spike/guest/build-cts.sh              # deqp-vk (linux-arm64, vulkan_headless) + mustpass -> $W/cts (shared read-only into the VM)
```

- `kernel/build.sh` stages exactly what `vmapp/kernel/build.sh` stages (same Dockerfile, container scripts, pins,
  verified source tarball) except the merged config (`kernel/vmapp-guest.config` + spike overlay) and the spike's own
  required/forbidden lists (DRM allowed). It never touches `vmapp/out/Image` or `vmapp/kernel/`.
- Spike overlay adds: `VIRTIO_MMIO` (libkrun uses MMIO devices, not PCI), `EXT4_FS`, `MAGIC_SYSRQ`, `DRM`,
  `DRM_VIRTIO_GPU`, `DRM_VIRTIO_GPU_KMS`, `SYNC_FILE`. Nothing else was needed to boot on libkrun and bind the GPU.
- Two Mesa builds in the image: `/opt/mesa-venus` = 26.2.5 + `patches/mesa-26.2.5-venus-16k-blob-alignment.patch`
  (userspace workaround, runs on the stock-config kernel); `/opt/mesa-venus-upstream` = 26.2.5 unmodified (needs the
  kernel patch). Debian's own `mesa-vulkan-drivers` (25.0.x) is also in the image as `mesa=stock`.

## Run

```sh
export VMAPP_WORK=$W
gpu/venus-spike/run-guest.sh NAME TEST [key=value ...]     # TEST = info | offscreen | vkpeak | llama | cts | vsock | spin | ...
# examples
gpu/venus-spike/run-guest.sh first info gpu=8192 mem=4096 cpus=2
gpu/venus-spike/run-guest.sh bench llama gpu=24576 mem=12288 cpus=8 model=Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf mode=vk args=-p,512,-n,128,-r,3
gpu/venus-spike/run-guest.sh up offscreen mesa=upstream patchedkernel=1
python3 -I gpu/venus-spike/vsock-host-test.py                # vsock + virtiofs + RO checks
gpu/venus-spike/cts-summary.sh memory api compute-all        # counts from $W/run/work/cts-<tag>.log
gpu/venus-spike/cts-compare.sh NATIVE_LOG VM_LOG
```

`run-guest.sh` exports `MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0` (required workaround, see REPORT.md) and boots with
`console=hvc0 root=/dev/vda rootfstype=ext4 rw init=/spike/init`, ext4 root as a raw virtio-blk disk, virtiofs shares
`models` (RO), `work` (RW), `cts` (RO), `spike` (RO test scripts bind-mounted over `/spike`).

Sandbox proof (a `deny default` Seatbelt profile, VM + GPU still works):

```sh
sandbox-exec -p '(version 1)(deny default)(allow process-exec* (literal "'$W'/bin/spike-vm"))(allow file-read*)
 (allow file-write* (subpath "'$W'/run") (subpath "'$W'/guest") (subpath "/private/var/folders") (literal "/dev/null"))
 (allow file-ioctl)(allow mach-lookup)(allow iokit-open)(allow iokit-get-properties)(allow sysctl-read)(allow ipc-posix-shm)
 (allow signal (target self))(allow process-info* (target self))(allow system-info)(allow user-preference-read)' \
 $W/bin/spike-vm --kernel ... --disk ... --gpu=4096
```

## Footprint (arm64)

libMoltenVK 5.3 MB (arm64 slice), libkrun 5.8 MB (init blob embedded), libvirglrenderer 2.3 MB, libepoxy 1.2 MB, launcher
54 KB: about 14.7 MB of host code. Guest kernel with DRM: 8.8 MB (7.6 MB without, +1.2 MB). Guest userspace for Venus:
Mesa Venus driver `libvulkan_virtio.so` 2.1 MB (+ ICD json) plus the Debian Vulkan loader `libvulkan.so.1` 0.6 MB.
