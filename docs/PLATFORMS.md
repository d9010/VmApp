# D9010 VmApp on macOS, Windows and Linux

**For:** contributors who want to bring D9010 VmApp to another host operating system, and anyone asking "does it run on
X?". App developers don't need this. The `.vmapp` format, the bridge protocol and the SDK are the same on every
host.

## Status

| Host | Hypervisor | Status |
|---|---|---|
| **macOS** 13+, Apple silicon | Apple Virtualization.framework | ✅ built and tested |
| **Windows** 10/11, x64 and ARM64 | Hyper-V through the Host Compute Service (HCS), the API WSL2 and Docker use | 📐 designed (below); not built. It needs a Windows machine to develop and test. |
| **Linux**, x86_64 and arm64 | KVM through a small VMM (cloud-hypervisor or Firecracker) | 📐 planned for later. Closest to the macOS design. |
| macOS on Intel | Virtualization.framework (x86_64 guests) | possible; needs the x86_64 kernel and runtimes (shared with Windows and Linux x64) |

## What is the same everywhere

- **The app format:** `.vmapp` packages, manifests, the bridge protocol and the SDK.
- **The loader** (Electron runs on all three), `hostlib`, the CLI and the registry.
- **`vmapp-init`'s behaviour:** mounts, extraction, privilege drop and control ops. Only its transports differ, as
  below.
- **The launcher protocol** (SPEC §5): stdin and stdout JSON lines, so the loader doesn't care which OS it runs on.

## What each host needs

The whole porting job is **a `vmapp-vm` for that hypervisor**, plus **guest transports** for it:

| Need | macOS (done) | Windows (HCS) | Linux (KVM) |
|---|---|---|---|
| Boot kernel + initramfs with read-only disks | VZLinuxBootLoader + VZVirtioBlockDevice | HCS compute system with a kernel and initrd (LinuxKit-style), VHD/VHDX read-only disks | VMM direct kernel boot + virtio-blk |
| Host↔guest stream sockets | virtio-vsock (`AF_VSOCK`) | **Hyper-V sockets** (`AF_HYPERV` on the host, `AF_VSOCK` with `hv_sock` in the guest) | vhost-vsock (`AF_VSOCK`) |
| Folder shares with read-only enforcement | virtiofs (VZ shares) | **Plan 9 (9p) shares** over hvsock (what WSL2 uses), with read-only flags; or virtiofs where supported | virtiofs via `virtiofsd` (one per share or slot), read-only enforced by the daemon |
| Grant slots added at run time | replace one VZ device's share | hot-add a 9p share, or pre-allocated slots | pre-started `virtiofsd` per slot, pointed at the granted folder |
| Parent-death following | kqueue `NOTE_EXIT` | a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | `prctl(PR_SET_PDEATHSIG)` plus a pidfd |
| Signing | Developer ID + the virtualization entitlement | Authenticode; Hyper-V must be enabled (Windows features) | distribution packages; `/dev/kvm` access |
| Kernel + runtimes | arm64 (done) | **x86_64** and arm64 | x86_64 and arm64 |

### Guest-side work
- **Kernel:** an x86_64 build of the same pinned kernel with the same minimal config, plus `CONFIG_HYPERV`,
  `HYPERV_VSOCKETS` and `9P_FS`/`NET_9P_VIRTIO` for Windows.
- **`vmapp-init`:** abstract "mount the static share", "mount slot K" and "listen on port P" behind a transport
  layer (virtiofs/vsock, 9p/hvsock). The rest is unchanged.
- **Runtimes:** build each runtime for `linux/amd64` too (`tools/mkruntime --platform`). `node22` and `dotnet8`
  apps need no change.
- **Native apps:** the manifest needs an `arch` field (`arm64`, `x86_64`, or both via per-arch core files). This is
  a spec proposal, and it's the only format change multi-arch requires.

### The GPU capability (SPEC §8.6)
macOS only for now. The mechanism is portable (a loopback "host service" the launcher is given by name, and a server the loader runs
for the app), but each host needs its own server and sandbox: Metal on macOS (done, `gpu/`); on **Windows** llama.cpp's Vulkan or CUDA
backend in an AppContainer or job-object-limited process, or, for apps that need a real GPU API in the VM, Hyper-V GPU paravirtualisation
(GPU-PV, [VISION §4](VISION.md)); on **Linux** the same with the host's own sandbox (bubblewrap or seccomp). Not started on either.

## Suggested order

1. x86_64 kernel and runtimes, built and tested on Linux with QEMU/KVM. This unblocks both Windows and Linux.
2. The `arch` manifest field (spec proposal).
3. The Linux `vmapp-vm` with cloud-hypervisor, virtiofsd and vhost-vsock: the closest to the macOS design.
4. The Windows `vmapp-vm` with HCS, hvsock and 9p, plus the guest transport layer.
5. Loader packaging per OS: DMG on macOS, MSIX or NSIS on Windows, AppImage, deb and rpm on Linux.
