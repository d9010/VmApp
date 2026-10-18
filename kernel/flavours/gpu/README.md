# Kernel flavour `gpu` (experimental)

The default D9010 VmApp guest kernel has no graphics at all (DRM is forbidden). This flavour is the same kernel (same pinned
Linux 6.18.56 source, container, config and hardening) plus what a guest needs to use a **virtio-gpu device with Venus**
(Vulkan over virtio-gpu, SPEC section 8.6) on libkrun / Hypervisor.framework. It is opt-in: nothing boots it unless a
launcher is told to.

```
kernel/build.sh --flavour gpu            # out/Image-gpu, out/kernel-gpu.config, out/kernel-gpu.release, out/kernel-info-gpu/
kernel/build.sh --flavour gpu --check    # up to date for the inputs below?  (its own stamp, the default's is untouched)
kernel/build.sh --flavour gpu --config-only    # merge the config and run the required/forbidden check only
```

The launcher must put **`virtio_gpu.blob_alignment=16384`** on the kernel command line (Apple's hypervisor maps 16 KiB
pages, the guest has 4 KiB pages) and the guest needs Mesa Venus 26.2.4 or later, which pads blob sizes to the value the
kernel reports. Without the parameter Vulkan instance creation fails (spike finding B1).

## What differs from the default kernel

| Input | Effect |
|---|---|
| `overlay.config` | `VIRTIO_MMIO` (libkrun's devices are virtio-mmio; the PCI options stay, so the same Image also boots under Virtualization.framework), `DRM`, `DRM_VIRTIO_GPU`, `DRM_VIRTIO_GPU_KMS`, `SYNC_FILE`. No fbdev, no framebuffer console, no VT, no input. |
| `patches/0001-*.patch` | adds the `virtio_gpu.blob_alignment` module parameter and `VIRTGPU_PARAM_BLOB_ALIGNMENT` (value 9) to the virtio-gpu driver; applied to the verified source by `container/apply-patches.sh` with `patch -p1 --fuzz=0`. Licences: see `../../SOURCE-OFFER.md`. |
| `kconfig-required.txt` | added to the common list: the five options above and `VIRTIO_MMIO_CMDLINE_DEVICES=n`. |
| `kconfig-forbidden.txt` | added to the common list: ten `!NAME` exemptions (below) and `MAGIC_SYSRQ`. |

The common lists stay in force in full: the effective required list is `kernel/kconfig-required.txt` plus this flavour's,
the effective forbidden list is `kernel/kconfig-forbidden.txt` plus this flavour's (both are kept in `out/kernel-info-gpu/`).

**Forbidden list, exactly what is relaxed.** Running the check with the overlay and nothing exempted reported 10
deviations, all in the DRM family and nothing outside it: `DRM`, `DRM_VIRTIO_GPU`, `DRM_VIRTIO_GPU_KMS` (the point),
`DRM_KMS_HELPER`, `DRM_GEM_SHMEM_HELPER`, `DRM_CLIENT_SELECTION` (selected by the driver), `DRM_PANEL_ORIENTATION_QUIRKS`,
`DRM_BRIDGE`, `DRM_PANEL_BRIDGE`, `DRM_PANEL` (selected or always on under `DRM`; registries, no panel or bridge driver).
Those ten are exempted by name. Everything else stays forbidden as in the default kernel, in particular modules,
namespaces, cgroups, eBPF, USB, sound, input, framebuffer, **every network device** (INV-D1: no virtio-net, no
`NETDEVICES`) and every other `DRM_*` option, so no further DRM driver, fbdev emulation, DRM client or `DRM_PANIC` can slip
in. `MAGIC_SYSRQ` is forbidden here as well.

**Implied by `DRM`, cannot be turned off** (`select` in drivers/gpu/drm/Kconfig): `I2C` core (no drivers), `HDMI`,
`VIDEO`, `DMA_SHARED_BUFFER`, `SYNC_FILE`, and the **`kcmp(2)` system call** (`KCMP`; Mesa uses it to compare file
descriptors). `kcmp` is the one new syscall of this kernel; it is limited by the ptrace access check.

## Left out on purpose (the spike had them)

- **`EXT4_FS`**: the spike booted an ext4 disk. D9010 VmApp's root is the initramfs plus an EROFS runtime image. Still forbidden.
- **`MAGIC_SYSRQ`**: the spike powered off with `echo o > /proc/sysrq-trigger`. `vmapp-init` calls `reboot(RB_POWER_OFF)`,
  which reaches the same PSCI `SYSTEM_OFF`. Checked on libkrun: `Image-gpu` with `out/initramfs.cpio` and no disks boots, `vmapp-init`
  fails to find `/dev/vda` and powers off, and the VMM exits with code 0, with sysrq and ext4 both off.

## Risks and notes

- DRM is a large attack surface and this kernel is for experiments and opt-in GPU apps (spike REPORT section 8, 11). The
  default kernel is unchanged and does not contain any of this.
- `DRM_VIRTIO_GPU_KMS` is kept because the spike verified Venus with it. The driver supports headless use without it, which
  would remove the modesetting code; not tried.
- A change of `KERNEL_VERSION` in `pins.env` can move the patched lines. The build then fails loudly (`--fuzz=0`) instead
  of patching the wrong place. Re-check whether upstream has an equivalent by then.
