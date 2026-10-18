# The D9010 VmApp guest kernel: licence and source offer

D9010 VmApp ships a Linux kernel as the file `Image` (built by `kernel/build.sh`). Every VM that runs an app boots it.

It can also ship a second, experimental build of the same kernel, the **`gpu` flavour**, as the file `Image-gpu`
(`kernel/build.sh --flavour gpu`, see [flavours/gpu/README.md](flavours/gpu/README.md)). It exists for VMs that get a
virtio-gpu device. Everything below applies to both; where they differ, it says so.

## Licence

The Linux kernel is licensed under the **GNU General Public License, version 2 only (GPL-2.0-only)**, with the
**Linux-syscall-note** exception for user-space programs that use the system-call interface. The full texts are
shipped next to the kernel: `out/kernel-info/licenses/linux/COPYING` and `out/kernel-info/licenses/linux/LICENSES/`
(`out/kernel-info-gpu/...` for the `gpu` flavour, and in the kernel source archive). The kernel image as a whole is
GPL-2.0-only in both flavours.

The one patch of the `gpu` flavour modifies four files of the DRM virtio-gpu driver. Those files carry their own
licences in the kernel tree: MIT for `virtgpu_drv.h`, `virtgpu_ioctl.c` and the uapi header `virtgpu_drm.h`, and
GPL-2.0 for `virtgpu_vram.c`. The patch is offered under the licence of the file each hunk changes.

The kernel is a separate program. Apps, the loader, the host launcher and the guest init are **not** derived from it:
they talk to it only through system calls, and they are under their own licences.

## Corresponding source (GPL-2.0 section 3)

The corresponding source of every `Image` that D9010 VmApp ships is exactly:

1. **The unmodified upstream source archive**, `linux-<KERNEL_VERSION>.tar.xz` from kernel.org
   (`KERNEL_URL_BASE` and `KERNEL_VERSION` in [pins.env](pins.env)), identified by its SHA-256 (`KERNEL_SHA256` in
   the same file). The build verifies it against kernel.org's PGP-signed checksum list and the release signature
   (`container/fetch-kernel.sh`). The default kernel is built from it **without any patch**.
2. **The kernel configuration**: [vmapp-guest.config](vmapp-guest.config) applied over `make ARCH=arm64
   allnoconfig`, resolved with `make olddefconfig`. The resulting `.config` is shipped as `kernel.config`.
3. **The build scripts**: everything in this folder (`Dockerfile`, `container/*.sh`, `build.sh`, `pins.env`) and the
   pinned build environment they describe (Ubuntu 24.04 by digest, apt snapshot date, fixed build identity). With
   them, `kernel/build.sh` rebuilds the same `Image` bytes.

`out/kernel-info/BUILD-INFO.txt` records the exact values for a given build.

### The `gpu` flavour (`Image-gpu`)

Its corresponding source is the three items above plus the flavour folder [flavours/gpu/](flavours/gpu/):

- **One patch to the kernel source**, `flavours/gpu/patches/0001-drm-virtio-blob-alignment-for-hosts-with-larger-pages.patch`.
  `container/apply-patches.sh` applies it to the verified upstream source with `patch -p1 --fuzz=0` before the
  configuration is made. It adds the module parameter `virtio_gpu.blob_alignment` and the DRM parameter
  `VIRTGPU_PARAM_BLOB_ALIGNMENT` to the virtio-gpu driver. No other change is made to the source.
- **The configuration** is `vmapp-guest.config` followed by `flavours/gpu/overlay.config` (the same `allnoconfig` and
  `olddefconfig` steps). The shipped `.config` is `kernel-gpu.config`.

`out/kernel-info-gpu/` records exactly what was used: `BUILD-INFO.txt` (hashes of Image, config, overlay and patch),
`patches/` (the patch files themselves), `kernel-patches.txt` (what `patch` reported), `vmapp-guest.effective.config`
(the fragment as the build saw it), and the effective required and forbidden lists.

## Written offer

Anyone who has received a D9010 VmApp release (the D9010 VmApp Launcher or the `Image` file) may obtain the corresponding source
above, on a durable medium and for no more than the cost of physically performing the distribution, for at least
three years after the release was published: ask the maintainers of this repository.

> Contact for source requests: **to be filled in by the maintainer before the first release.**

Releases should also publish this file, `kernel/` at the release commit, and the SHA-256 of the shipped `Image`.
