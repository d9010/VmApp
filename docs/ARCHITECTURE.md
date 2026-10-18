# D9010 VmApp architecture

**For:** anyone who wants to understand how D9010 VmApp works and why it is built this way. To build an app, read
[BUILDING-APPS.md](BUILDING-APPS.md) instead. To change the platform, read [../CONTRIBUTING.md](../CONTRIBUTING.md)
after this. The normative contract is [../SPEC.md](../SPEC.md); this document explains it, and doesn't replace it.

---

## 1. The idea in one picture

```
┌───────────────────────────── your Mac (host) ──────────────────────────────┐
│                                                                            │
│  D9010 VmApp Launcher (Electron) ── trusted, the same for every app        │
│   ├─ Library, permission sheet, inspector       (loader's own UI)          │
│   ├─ App windows: sandboxed Chromium renderers  (the app's UI: HTML/CSS/JS)│
│   │     no Node · no network · only window.vmapp                           │
│   └─ hostlib: packages, grants, one AppSession per running app             │
│           │ spawns                         ▲ bridge (JSON lines, Unix sock)│
│           ▼                                │                               │
│      vmapp-vm (native, ~0.8 MB) ── one per running app ────────────────────┼──┐
│           │ Apple Virtualization.framework                                 │  │
└───────────┼────────────────────────────────────────────────────────────────┘  │
            ▼                                                                   │
   ┌──────────────────── Linux VM (one per app, ~0.4 s to start) ─────────────┐ │
   │ /init = vmapp-init                                                       │ │
   │ /      = shared runtime image (read-only): native | node22 | dotnet8     │ │
   │ /app   = the app's core files (read-only)                                │ │
   │ /data  = the app's private data          ◄── host folder per app         │ │
   │ /host/f-<name>, pick-N, save-N           ◄── only what the user granted  │ │
   │                                                                          │ │
   │ the app's core (its "main process"), uid 1000 ◄──── vsock ───────────────┼─┘
   │ no network device (granted hosts only, via the proxy: see below)         │
   └──────────────────────────────────────────────────────────────────────────┘
```

An app is split exactly where Electron splits it:
- The **UI** (renderer) runs on the host, so it gets native rendering, fonts, input, accessibility and HiDPI.
- The **core** (main process) runs in a VM, so everything powerful it does (files, processes, CPU) is confined.

The only connection between the two is a message bridge that passes through the loader.

---

## 2. Layers, from the bottom up

| # | Layer | Component | Trusted? | Where |
|---|---|---|---|---|
| 1 | Hypervisor | Apple Virtualization.framework | yes (OS) | macOS |
| 2 | VM launcher | `vmapp-vm` (Rust + Objective-C shim) | yes (platform) | host, one process per app |
| 3 | Kernel + init | Linux 6.18 + `vmapp-init` (Rust, static, ~530 KB) | yes (platform) | guest |
| 4 | Runtime | `native` / `node22` / `dotnet8` read-only images | yes (platform; pinned, reproducible) | guest root |
| 5 | **App core** | the app's code, any language | **no** | guest, uid 1000 |
| 6 | Host library | `hostlib` (packages, store, sessions, bridge client) | yes (platform) | host, inside the loader |
| 7 | Loader | Electron main + loader UI + dialogs | yes (platform) | host |
| 8 | **App UI** | the app's HTML/CSS/JS | **no** | host, sandboxed renderer |

The untrusted layers (5 and 8) never talk to each other directly, and never touch the host except through layers the
platform owns.

---

## 3. What happens when you click Launch

```
Loader            hostlib/AppSession        vmapp-vm               VM: vmapp-init           App core
  │ Launch            │                        │                        │                       │
  │──grants?─────────►│ (permission sheet if needed; saved in grants/<id>.json)                  │
  │                   │──spawn(args)──────────►│                        │                       │
  │                   │                        │─boot kernel+initramfs─►│ mount runtime as /rt  │
  │                   │                        │  disks: runtime, core   │ extract core.cpio→/app│
  │                   │                        │  virtiofs: appdata,f-*  │ mount /host,/data     │
  │                   │                        │◄──────hello (vsock 1023)│                       │
  │                   │                        │──start{command,env}────►│ fork→chroot→uid 1000 ─►│ exec
  │                   │◄─ready line {socket}───│                        │                       │ listen $VMAPP_SOCKET
  │                   │──connect bridge (Unix sock → vsock 1024 → core socket)──────────────────►│
  │                   │──init {app, folders, data}──────────────────────────────────────────────►│
  │                   │◄─ready──────────────────────────────────────────────────────────────────│
  │                   │◄─request window.create {entry:index.html}───────────────────────────────│
  │◄─create window────│                                                                         │
  │  vmapp-ui://<id>/index.html (hash-checked, CSP)                                             │
  │                   │──reply {win:1}──────────────────────────────────────────────────────────►│
```

Measured on an M-series Mac: from spawn to the window's first message is under a second. A minimal app ran a full
launch → window → calls → quit cycle in 0.64 s.

## 4. How a click in the UI reaches the core

```
App UI (renderer)        preload-app.js (loader)    Loader main / AppSession          App core (VM)
window.vmapp.invoke('notes:list')
   │──ipc──────────────────►│──ipc────────────────────►│ (window → app lookup by webContents id)
   │                        │                          │──{"t":"invoke","id":7,"win":1,"channel":"notes:list"}──►│ ipcMain.handle
   │                        │                          │◄─{"t":"result","id":7,"result":[…]}──────────────────────│
   │◄─Promise resolves──────│◄─────────────────────────│   (also shown in the bridge inspector)
```

The other directions:
- **`window.vmapp.send`** works the same way, with no reply.
- **`webContents.send` in the core** becomes `{"t":"emit"}`, which the loader delivers to that one window.
- **Requests from the core** (`window.create`, `dialog.open`, …) go to the loader. The loader enforces the
  manifest's permissions and shows native dialogs. If a dialog grants a folder, it tells `vmapp-vm` to add a share
  to the *running* VM, and the folder appears as `/host/pick-N`.

---

## 5. Files and folders: how access is enforced

| Inside the VM | Comes from | Access enforced by |
|---|---|---|
| `/` | the runtime image (EROFS) | read-only block device |
| `/app` | `core.cpio`, extracted to tmpfs; or `core.erofs`, mounted as it is | remounted read-only; or a read-only block device |
| `/data` | `$VMAPP_HOME/data/<id>/` on the host | per-app folder; nothing else is shared |
| `/host/f-<name>` | a folder the user chose for the manifest request `<name>` | read-only / read-write by the hypervisor's share flag; write-only by a staging folder |
| `/host/pick-N` | a folder or file chosen in an open dialog | read-only by default; file picks are APFS clones, so siblings are never visible |
| `/host/save-N` | a save dialog's target | staging folder; the finished file is moved to the chosen path |
| `/tmp`, `/run` | memory | gone when the app stops |

**Write-only** never shares the destination. The core writes into an empty staging folder, and the host moves each
finished file out: a file is finished once it has stopped changing for about a second, or when it is renamed from
`*.partial`. The core can never see what the destination already contains.

**The network (SPEC §8.3)** follows the same idea: the host decides, and the VM has no device to go around it.

```
core ──HTTPS_PROXY──► 127.0.0.1:3128 (vmapp-init) ──vsock 1022: "open api.example.com:443?"──► vmapp-vm
                                       ▲                                                        │ rules, DNS, address check,
                                       └────────── vsock 1025: one per connection, raw bytes ◄──┘ connect to the checked address
```

- The core's HTTP client reaches a small HTTP proxy inside the VM through environment variables. For each connection
  the proxy asks the host over one vsock control connection, which the host opens only when the app has a grant.
- `vmapp-vm` checks the host and port against the user's grants, resolves the name itself, refuses it if any answer is
  a private or local address, connects, and opens a fresh vsock connection for the bytes. TLS passes through a
  `CONNECT` tunnel untouched.
- It reports each connection (host, port, bytes, time) to the loader as a `net` event. Revoking a host closes its open
  connections immediately.

**The GPU (SPEC §8.6)** reuses that tunnel for one more thing, a *host service*. Linux has no Metal, so the VM is not given a GPU API;
it is given llama.cpp's RPC protocol, forwarded to a Metal server on the Mac.

```
core ── 127.0.0.1:50052 ──► vmapp-init ──vsock 1022: "service-open gpu"──► vmapp-vm ──► 127.0.0.1:PORT ──► rpc-server (Metal)
 ($VMAPP_GPU_RPC)                       ◄── vsock 1025: raw bytes ◄──────────┘          (sandbox-exec, one per app run)
```

- Only an app that asked for `gpu` and was allowed gets any of it. The loader (not the app, not the guest) starts the server, inside a
  deny-by-default macOS sandbox, on a loopback port it picked, and hands that endpoint to `vmapp-vm` on its command line.
- The guest names a *service*; `vmapp-vm` maps the name to the one endpoint it was started with. The guest never supplies an address.
- Everything stops together: the app, a revoke, the panic shortcut and the loader quitting end the server and its tunnels.

---

## 6. Lifecycle and process ownership

- The loader owns every `AppSession`, and each session owns exactly one `vmapp-vm` child, which owns exactly one VM.
- **The core exits** → the VM powers off → `vmapp-vm` prints `stopped` → the session closes the app's windows.
- **The user presses Stop** → `before-quit` goes to the core, which gets 3 s → shutdown → write-only files are
  delivered.
- **The loader quits** → it stops every session.
- **The loader crashes or is killed** → each `vmapp-vm` sees its parent die (kqueue, plus EOF on stdin) and shuts
  its VM down. A VM can't outlive the loader.

---

## 7. Why it is built this way: choices and rejected alternatives

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Where the UI renders | **On the host**, in Chromium | *In the VM* (X11/Wayland forwarding, virtio-gpu): weak GPU support on macOS VMs, HiDPI and resize issues, broken IME, clipboard, accessibility (screen readers), and every input path (keyboard, mouse, trackpad, touch, pen, scrolling devices) would have to be forwarded and emulated, higher latency. On the host, Chromium gets all of these from the OS, and the window is a web standard the launcher can be tested against over the Chrome DevTools Protocol. Possible later as a separate mode for legacy Linux GUI apps. |
| Isolation unit | **One VM per app** | *Containers*: they share one kernel, so an escape reaches every app. Docker Desktop also shares `/Users` into its VM. *One shared VM*: same problem. |
| Programming model | **Electron's main/renderer split** with an Electron-like SDK | *A new UI toolkit*: nobody would port apps to it. *Remote desktop*: see "UI renders" above. |
| What an app ships | **Only its own code** (`core.cpio` + UI) on shared runtimes | *A full image per app*, like containers or agent-vm: MBs to GBs per app, every app rebuilds Linux, and slow updates. |
| Runtime images | Read-only EROFS, built reproducibly from pinned Docker images | *Building root filesystems by hand*: hard to keep current. Docker is a build-time tool only. |
| App core format | **cpio extracted to tmpfs** (default), or **an EROFS image mounted as it is** (`core.image: "erofs"`, for large cores) | The cpio costs the VM its size in memory and boot time, so it stays under 256 MiB. *EROFS with erofs-utils* would need Docker to pack; `hostlib/erofs.js` writes the image in plain JavaScript instead, so packing stays something anyone can run. |
| Package format | **ustar tar** + a strict manifest with a SHA-256 for every file | *zip*: more complex to read strictly. *Signed bundles*: signatures come in milestone 2, reserved in the manifest. |
| Bridge | **JSON lines over one socket** (vsock in the guest) | *gRPC or protobuf*: heavier, and harder to implement from any language with no dependencies. *HTTP*: needs a server in every core. |
| Permissions | **Granted by the user at launch**, plus dialog picks at run time (a "powerbox") | *Granted by the vendor's code* (Electron + containers): the vendor writes its own rules. |
| Network | **None until the user allows named hosts** (SPEC §8.3), through a host-enforced allowlist proxy; the VM never has a network device | *Open by default*: the exfiltration risk is too high. *A NAT or bridged device*: the guest could then reach the LAN and bypass any check. |
| VM size | **The user chooses** vCPUs and memory (default 1 vCPU and the recommended memory, capped at the Mac's cores and half its RAM, SPEC §8.5); the manifest only recommends | *The manifest decides*: any app could take most of the Mac. |
| Host side of the app | **None**: no vendor code on the host except UI in a sandboxed renderer | *An app-provided preload or main process* (plain Electron): gives the vendor full user rights. |

[../WHY.md](../WHY.md) compares D9010 VmApp with Electron and with Electron + container backends in detail, including where
those are still better.

---

## 8. Component map (where the code is)

| Concern | Code |
|---|---|
| Package read/write/verify, manifest rules | `hostlib/package.js`, `hostlib/manifest.js`, `hostlib/tar.js`, `hostlib/cpio.js`, `hostlib/erofs.js` |
| Installs, grants, data folders | `hostlib/store.js` |
| A running app (spawn, bridge, requests, permissions, traffic events) | `hostlib/session.js`, `hostlib/bridge.js` |
| The VM launcher, shares, live delivery, grants | `host/src/lib.rs`, `host/src/cli.rs` (command line and main loop, shared), `host/src/bin/vmapp-vm.rs`, `host/src/shim/vz_shim.m` |
| The experimental Vulkan backend (libkrun, sandboxed VMM, watchdog; SPEC 8.7) | `host/src/krun.rs`, `host/src/bin/vmapp-vm-krun.rs`, `gpu/krun/` |
| The VM's init: mounts, extraction, start, bridge forwarding | `guest/src/main.rs`, `guest/src/appcore.rs`, `guest/src/cpio.rs`, `guest/src/erofs.rs` |
| Runtimes | `runtimes/<name>/Dockerfile`, `tools/mkruntime` |
| Electron-like SDK | `sdk/node/vmapp.js` |
| Loader: windows, `vmapp-ui://` protocol, dialogs, inspector | `loader/` |
| CLI | `tools/vmapp` |
