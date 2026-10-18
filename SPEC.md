# D9010 VmApp specification, format 1

**D9010 VmApp** runs desktop apps from anywhere without trusting them:
- **The app's core** (its "main process": Node, .NET, Rust, any language) runs inside a small Linux VM.
- **The app's UI** (HTML/CSS/JS) renders on the host, in a sandboxed Chromium window that has no Node, no network and
  no file access.
- **The two halves talk only through a bridge** that the host controls.
- **The user decides** in a loader app what each app may reach: which folders, and how.

It's Electron's split, but with "main" moved into a VM. Apps ship only their own code; the Linux system and the
language runtimes are shared and never rebuilt per app.

This document is binding for every component. If code and spec disagree, the spec wins until it's changed here.

---

## 1. Components

| Folder | Component | Language |
|---|---|---|
| `guest/` | `vmapp-init`: the VM's `/init` (static aarch64 musl) | Rust |
| `host/` | `vmapp-vm`: one VM per running app (Apple Virtualization.framework), plus `libvmapp`; and `vmapp-vm-krun`, the **experimental** second launcher for the Vulkan GPU (libkrun, §8.7) | Rust + Objective-C shim |
| `runtimes/<name>/` | Dockerfiles of the shared runtime images (`native`, `node22`, `dotnet8`) | Dockerfile |
| `tools/mkruntime` | Builds a runtime image (EROFS) from `runtimes/<name>` | bash |
| `sdk/node/vmapp.js` | The core-side SDK for Node apps (Electron-like API); baked into the `node22` runtime | JavaScript |
| `sdk/node/http-bridge.js`, `sdk/web/vmapp-fetch.js` | "HTTP over the bridge" with streamed bodies (docs/CONVERTING.md 5.3): the core half and the page half. **Not part of the SDK contract and not baked into a runtime**: an app that converts a web app vendors the two files into its `core/` and `ui/`. They use only `window.vmapp` / `ipcMain` (§6, §9). | JavaScript |
| `hostlib/` | Host-side library: package reader/verifier, installer, VM session + bridge, window-manager interface | JavaScript (Node, no deps) |
| `tools/vmapp` | CLI: `pack`, `inspect`, `verify`, `install`, `list`, `uninstall`, `run --headless` | JavaScript (Node) |
| `loader/` | **D9010 VmApp Launcher**: the user's app manager and renderer host | Electron 44.4.5 |
| `gpu/` | The GPU capability's host server (§8.6): pinned llama.cpp commit (`pins.env`), `build.sh` (Metal RPC server into `out/gpu/`), the sandbox profile `rpc-server.sb` | bash + sandbox profile |
| `gpu/krun/` | The **experimental** Vulkan backend (§8.7): pinned build of its host libraries (libkrun, virglrenderer with Venus, MoltenVK, libepoxy; `pins.env`, `patches/`, `build-libs.sh`, `build.sh`) and the VMM's sandbox profile `vmm.sb` | bash + sandbox profile |
| `apps/` | Sample apps: `notes` (Node), `hasher` (Rust), `todo` (.NET) | various |
| `tests/` | End-to-end tests | bash / Node |

Some pieces were adapted from earlier projects of the author: `agent-vm` (guest init, host launcher, the runtime and
cpio tools) and `d9010-native` (the kernel build in `kernel/`, and `set_shares` in the VZ shim). Each such file carries
a header comment naming its source. Nothing in this repository depends on those projects being present.

**Kernel (milestone 1):** built by `kernel/build.sh` (Linux 6.18.56-vmapp, arm64, pinned in `kernel/pins.env`) to
`out/Image`. `tools/build.sh` runs it when the kernel is missing or its inputs changed. Every launcher passes
`--kernel` explicitly. The **`gpu` flavour** (`kernel/build.sh --flavour gpu` -> `out/Image-gpu`, §8.7) adds virtio-mmio, the
virtio-gpu DRM driver and a blob-alignment patch for the experimental Vulkan backend; the default kernel does not change.

**Dev data root:** `$VMAPP_HOME`, default `$VMAPP_WORK/vmapp-home`; `VMAPP_WORK` is the scratch and cache folder and
defaults to `out/work` in the repository (git-ignored). A packaged loader uses
`~/Library/Application Support/VMApp Loader`. Layout:
```
$VMAPP_HOME/
  runtimes/<name>.img            installed runtime images
  apps/<id>/<version>/           extracted, verified packages (vmapp.json, ui/, core.cpio or core.erofs)
  apps/<id>/current              text file: the active version
  data/<id>/                     the app's private data (shared to the VM as appdata → /data)
  grants/<id>.json               the user's saved permission choices (folders, host capabilities, network, devices)
  gpu/servers/<pid>.json         the GPU servers running now (§8.6), so a crashed loader's are stopped at the next start
```

---

## 2. Package format: `.vmapp`

A `.vmapp` file is an **uncompressed POSIX ustar tar archive**:
- **Entry order:**
  1. `vmapp.json` (first);
  2. `ui/` and everything below it, sorted by path;
  3. `core.cpio`, or `core.erofs` when the manifest's `core.image` is `"erofs"` (exactly the one the manifest names);
  4. optional `icon.png`.
- **Allowed entries:** only regular files and directories, with relative paths (no leading `/`, no `..` component,
  no empty components).
- **Ownership and times:** uid/gid 0, mtime 0, mode 0644 for files and 0755 for directories.
- **Path length:** at most 255 bytes, using the ustar prefix field.
- **No other entries:** readers reject anything else (links, devices, pax headers, duplicate paths) and any entry
  not listed in `files`, except `vmapp.json` and directories.
- **Size limits:** 2047 MiB per package (a package is read whole into memory, and Node reads at most 2 GiB in one go),
  `core.cpio` at most 256 MiB (it is copied into the VM's memory at boot), `core.erofs` up to the package limit (it is mounted,
  not copied), `ui/` at most 1 GiB. *(Until 2026-10-17: 512 MiB per package and 64 MiB of `ui/`; raised with `core.erofs`,
  [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C7.)*
- **Reproducible:** packing the same input twice gives byte-identical output.

### 2.1 `core.cpio` and `core.erofs`
This is the app's core files, which become `/app` in the VM. The manifest's `core.image` chooses how they are packed; the tree
rules are the same for both:
- **Allowed entries:** regular files, directories and *relative* symlinks that stay inside `/app`.
- **Ownership and times:** uid/gid 0, mtime 0, and modes as on disk masked to 0755/0644. The exec bit is kept.

`core.cpio` (`core.image` `"cpio"`, the default) is an uncompressed **newc** cpio, **sorted by path, ending with
`TRAILER!!!`**. The guest copies it into a tmpfs, so the files cost the VM their size in memory.

`core.erofs` (`core.image` `"erofs"`) is a read-only **EROFS** image (the Linux kernel's format, `fs/erofs/erofs_fs.h`), which
the guest mounts as it is: the files cost no memory but the page cache. Only this subset is valid:
- 4 KiB blocks, the superblock at byte 1024, no compression, no chunk-based files, no extended attributes or xattr prefixes, no
  extra devices, no superblock extension slots; compatible feature bits at most `SB_CHKSUM` and `MTIME`;
- inodes "compact" (32 bytes) or "extended" (64 bytes), data "flat plain" or "flat inline" (the tail in the inode's block, not
  crossing it);
- directories with `.` and `..`, entries sorted by name, link counts that match; a file has one link (no hard links); every
  inode is reached once from the root (no cycles); every block lies inside the image;
- a symlink's own mode bits are ignored (as by Linux) but may not have the setuid, setgid or sticky bit.

`hostlib/erofs.js` writes such images deterministically (the same tree gives the same bytes: inodes in path order, the
root at nid 36, the UUID derived from the content) and its reader checks every rule above at pack, verify and install. An
uncompressed image of `mkfs.erofs -T0 --all-root -x-1` from an export of the same tree also passes.

### 2.2 `vmapp.json` (the manifest)
```json
{
  "format": 1,
  "id": "com.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "publisher": "Example Inc.",
  "description": "Markdown notes in a folder you choose.",
  "runtime": "node22",
  "core": {
    "command": ["node", "main.js"],
    "workdir": "/app",
    "env": { "NODE_ENV": "production" },
    "memoryMiB": 256,
    "cpus": 1
  },
  "ui": { "root": "ui" },
  "permissions": {
    "folders": [
      { "name": "notes", "access": "readwrite", "purpose": "The folder where your notes are kept" },
      { "name": "export", "access": "writeonly", "purpose": "Where exported HTML files are saved" }
    ],
    "dialogs": true,
    "external": true
  },
  "files": {
    "core.cpio": "<sha256 hex>",
    "ui/index.html": "<sha256 hex>"
  }
}
```

Rules, all checked by `hostlib` on pack, verify and install:

| Field | Rule |
|---|---|
| `format` | `1` |
| `id` | `^[a-z0-9]+(\.[a-z0-9-]+)+$`, 3–100 chars (reverse-DNS) |
| `name` | 1–60 chars, no control chars |
| `version` | semver `MAJOR.MINOR.PATCH` (optional `-pre`) |
| `publisher`, `description` | strings, ≤100 and ≤500 chars |
| `runtime` | one of the installed runtime names: `native`, `node22`, `node22-gpu` (§8.7), `dotnet8` |
| `core.command` | non-empty array of strings. `command[0]` is resolved by `vmapp-init` in `PATH`, or is an absolute path, or is `./x` relative to workdir. |
| `core.workdir` | absolute path inside the VM; default `/app` |
| `core.env` | string→string map; names `^[A-Z_][A-Z0-9_]*$`; must not set `VMAPP_*` |
| `core.memoryMiB` | 64–32768, default 256. A **recommendation**: the memory the developer found the app needs. The user chooses the real size (§8.5). |
| `core.cpus` | 1–16, default 1. A **recommendation**, like `memoryMiB` (§8.5). |
| `core.image` | `"cpio"` (default) or `"erofs"`: how the core files are packed (§2.1), and so whether the package has `core.cpio` or `core.erofs`. Absent from the canonical form when `"cpio"`, so existing package ids are unchanged. Proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C7. |
| `ui.root` | a single folder name (default `ui`); the UI is stored under that name in the package. Where §2 says `ui/`, read `<ui.root>/`. |
| `ui.features` | optional array of unique strings from `workers`, `wasm`, `self-fetch`, `frames`, `network`: window features the app's windows may use (§7 "Window features"). Each adds exactly its own sources to the window's CSP; none reaches a file or a device, and only `network` reaches the network: the windows' data requests, through the app's own proxy and under the app's network grants (§8.3 "The app's windows"). `network` needs `permissions.network`. Absent means none (SPEC 7's CSP as it is). Proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C1 (`network`: C3). |
| `permissions.folders[]` | `name` `^[a-z][a-z0-9-]{0,30}$`, unique; `access` one of `read`, `readwrite`, `writeonly`; `purpose` ≤200 chars, optional; the loader shows "no reason given" when it's empty. At most 8 entries. |
| `permissions.host[]` | optional, at most 8 entries `{cap, api?, purpose?}`; `cap` is `screen`, `input`, `gpu`, `tool:<id>`, `tool:*`, `mcp:<id>` or `mcp:*` (ids `^[a-z0-9][a-z0-9-]{0,40}$`), unique; `purpose` ≤200 chars. `api` exists for `gpu` only, and its only value is `vulkan` (the **experimental** Vulkan GPU, §8.7; the app's `runtime` must then be `node22-gpu`); a plain `gpu` is the llama.cpp RPC service. See §8.2; `gpu` is §8.6 and §8.7. |
| `permissions.network[]` | optional, at most 32 entries `{host, ports?, purpose?}`; `host` is a lowercase ASCII host name (`api.example.com`), a wildcard (`*.example.com`) or `*` (any public host), unique; `ports` is 1-8 distinct integers 1-65535 or `"*"` (every port), default `[443]`; `purpose` ≤200 chars. IP literals, one-label names, `localhost` and the `.local`, `.internal`, `.localdomain`, `.home.arpa`, `.lan` names are rejected. See §8.3. |
| `permissions.devices[]` | optional, at most 4 entries `{device, purpose?}`; `device` is `microphone`, `clipboard` or `ports` (`camera` is **reserved** and rejected), unique; `purpose` ≤200 chars. The microphone: the app's **windows** (not its core) may use it; the clipboard: its windows and its core may read and write it; ports: its core may open its servers on this Mac's `localhost` (§8.8). Each only with the user's grant. See §8.4. |
| `permissions.dialogs` | bool, default `true`: may the core show native open/save dialogs (each grant chosen by the user) |
| `permissions.external` | bool, default `false`: may the core ask to open `https:` URLs in the user's browser (the user confirms each one) |
| `permissions.links` | bool, default `false` (absent from the canonical form when false): the app receives `vmapp://<its id>/…` links opened on the Mac, as `app.on('open-url')` (§8.9) |
| `files` | every entry of the package except `vmapp.json` and directories, mapped to its SHA-256 (lowercase hex). Extra or missing entries mean the package is invalid. |
| unknown keys | rejected (strict) |

The **package id** of a build is `sha256(vmapp.json bytes)`. It is shown in the loader and identifies exactly what
was reviewed.

*Reserved for milestone 2:* `signature` (publisher signature over the manifest) and the value `camera` of
`permissions.devices` (the manifest rejects it until a later spec change defines it). (`permissions.network` is defined in
§8.3 and `permissions.devices` with `microphone` in §8.4.)

*Future (owner notes, 2026-10-15):*
- **Reset.** Every launch already starts from a clean VM: the runtime and `/app` are read-only, and `/tmp` lives in
  memory. The only persistent state is `/data` and the granted folders. "Reset app" therefore means emptying
  `data/<id>/` and forgetting `grants/<id>.json`. A loader button does exactly this.
- **App groups** (`permissions.groups`, not in format 1). Several apps opt in, with the user's consent, to share
  one group data folder (mounted at `/shared/<group>`). This is for workflows where apps are meant to share context.
  Without it, apps never see each other's data.

---

## 3. Runtimes (shared, installed once)

A runtime is a **read-only EROFS image** of a Linux root filesystem (arm64). It becomes the VM's root, and the app's
core (`core.cpio` extracted, or `core.erofs` mounted) is `/app` inside it. Apps never contain the OS or the language runtime.

| Runtime | Built from | Contents |
|---|---|---|
| `native` | `FROM scratch` + CA certificates | nothing but the mount-point folders and `/etc/ssl/certs`. For static binaries (Rust musl, Go, Zig, C). |
| `node22` | `node:22-bookworm-slim` (pinned digest) | Node 22 + the SDK at `/usr/lib/vmapp/node/node_modules/vmapp/index.js` with `NODE_PATH=/usr/lib/vmapp/node/node_modules`, so `require('vmapp')` works |
| `dotnet8` | `mcr.microsoft.com/dotnet/runtime:8.0` (pinned digest) | the shared .NET 8 runtime; apps ship framework-dependent `dotnet publish` output and run `["dotnet", "App.dll"]` |
| `node22-gpu` | `node:22-trixie-slim` (pinned digest) | **experimental** (§8.7): everything `node22` has, on Debian trixie, plus Debian's Vulkan loader (`libvulkan1`) and Mesa 26.2.5's Venus driver (`libvulkan_virtio.so` and its ICD file, found by the loader without any variable), so a Vulkan program in the VM reaches the Mac's GPU when the app runs on the Vulkan backend. Without that backend it simply has no Vulkan device. |

Every runtime image **must contain these empty directories:** `app data host proc sys dev tmp run`.

`tools/mkruntime runtimes/<name> out/runtimes/<name>.img` builds an image:
1. `docker build --platform linux/arm64`;
2. `docker export`;
3. adds the mount points;
4. `mkfs.erofs -zlz4hc,12 -T0` with a fixed UUID, in a pinned helper container.

The output is reproducible. Docker is a build-time tool for runtime maintainers only. App developers never need it
for Node apps, and never at install or run time.

---

## 4. The VM (guest contract, `vmapp-init`)

**Boot:**
- **Kernel cmdline:** `console=hvc0 rdinit=/init panic=-1 quiet vmapp.id=<instance id>`
- **Initramfs:** a single newc cpio with `/init` = `vmapp-init` and `dev proc sys tmp`.
- **Disks**, both read-only:
  - `vda` = the runtime image (identifier `runtime`);
  - `vdb` = `core.cpio` or `core.erofs` as a raw block device (identifier `core`). A cpio is read sequentially; its
    trailer marks the end, and padding after it is ignored. The guest tells the two apart by the EROFS magic
    `0xE0F5E1E2` at byte 1024.
- **Static virtiofs device**, tag **`vmapp`**, always present and **never changed after boot**. It holds `appdata`
  and the launch-time folder shares (`f-<name>`); the directory names inside it are the share names in §5.
- **Grant slots:** 8 more virtiofs devices, tags **`vmapp-s0` … `vmapp-s7`**. At boot each shares an empty
  placeholder directory. A runtime grant (`pick-N`, `save-N`) replaces the share of **one free slot only**, so
  nothing else ever goes stale. *(Format 1 shipped with one device for everything at first. Replacing its share set
  made existing mounts such as `/data` go stale; slots fix that.)* At most 8 runtime grants exist at once; a revoke
  frees its slot.
- **The libkrun backend's variant (§8.7, experimental).** libkrun exposes one folder per virtiofs device and cannot re-point
  a share while the VM runs, so on that backend there are **no slot devices and no runtime grants**, and the static shares are
  one device each: the kernel command line carries `vmapp.fs=appdata,f-notes,...` (the share names) and the guest mounts a tmpfs
  at `/host`, then the device whose tag is the share name at `/host/<name>`. Everything after that is as above. The same command
  line carries `virtio_gpu.blob_alignment=16384` (the gpu kernel flavour's parameter) and, when the VM has a GPU, `vmapp.gpu=1`:
  the guest then waits (≤5 s) for the DRM render node `/dev/dri/renderD128` and gives it to group 1000 with mode 0660, so that
  the core (uid/gid 1000, no supplementary groups) can open it; the KMS node `card0` stays root-only. If the node does not
  appear the guest logs it and carries on (the core has no GPU).

**Setup (PID 1):**
1. **Base mounts:** devtmpfs on `/dev`, proc on `/proc`, sysfs on `/sys`, tmpfs on `/tmp`. Bring the loopback
   interface `lo` up.
2. **Root:** wait (≤5 s) for `/dev/vda` and `/dev/vdb`. Mount `vda` as erofs, read-only, at `/rt`.
3. **App files**, from `/dev/vdb`:
   - **`core.cpio`:** mount tmpfs at `/rt/app` (mode 0755). Extract the cpio into it:
     - regular files, directories and relative symlinks only;
     - reject absolute or `..` paths and symlinks escaping `/app`;
     - files owned by root, read-only to the app.

     Then remount `/rt/app` read-only, with `nosuid` and `nodev`.
   - **`core.erofs`:** mount `/dev/vdb` as erofs at `/rt/app`, read-only, `nosuid`, `nodev`. Then walk the mounted tree once
     with the same rules (regular files, directories and relative symlinks that stay inside `/app`; owner root; no setuid,
     setgid or sticky bit); any violation is fatal, as for the cpio. (The host's reader already checked the image, §2.1.)

   Either way `hello`'s `app` reports the regular files and their bytes.
4. **Host shares:** mount virtiofs `vmapp` at `/host` (nosuid, nodev).
5. **Mounts inside `/rt`:**
   - proc at `/rt/proc`, sysfs at `/rt/sys`;
   - a bind of `/dev` at `/rt/dev`, plus tmpfs at `/rt/dev/shm`;
   - **pseudo-terminals:** devpts at `/rt/dev/pts` (`newinstance,ptmxmode=0666,mode=0620,gid=G`, nosuid, noexec; `G` is the
     gid of the group `tty` in the runtime's `/etc/group`, normally 5, else 0) and `/rt/dev/ptmx` as a symlink to
     `pts/ptmx`, so that `openpty()`, `forkpty()` and `node-pty` work for the core. The instance belongs to the VM and
     adds no way out of it. If the mount fails, the guest logs it and carries on: the core just has no terminals;
   - tmpfs at `/rt/tmp` (1777) and at `/rt/run`, with `/rt/run/vmapp` owned by the app user (0700);
   - a bind of `/host` at `/rt/host`;
   - a bind of `/host/appdata` at `/rt/data`.

   Because `/rt/host` is a bind of the live virtiofs mount, folders the host adds later appear there too.

**The app user:** uid 1000, gid 1000. The core runs with `no_new_privs`, `setgroups([])`, and chroot `/rt`.

**vsock ports (the guest listens, the host connects):**

| Port | Use |
|---|---|
| 1022 | network control (§8.3): the host opens **one** persistent connection after boot, only when the app has network grants or a host service (§8.6); JSON lines |
| 1023 | control: one JSON object per line |
| 1024 | bridge: each connection is forwarded to a *new* connection to the core's Unix socket `/rt/run/vmapp/core.sock`, retrying the connect for up to 15 s. Bytes are copied both ways. |
| 1025 | network data (§8.3, §8.6): one host-opened connection per proxied TCP connection or service tunnel; first line `N\n`, then raw bytes |
| 1026 | port forwarding (§8.8): one host-opened connection per forwarded TCP connection; first line `P\n` (the VM port), then raw bytes. The guest connects to `127.0.0.1:P` inside the VM, and to nothing else |

**Control operations:**
- `{"op":"hello"}` returns
  `{"ok":true,"name":"vmapp-init","version":"0.1.0","id":"…","kernel":"…","app":{"files":N,"bytes":B},"core":{"running":false}}`.
  Once the core is started, `core` is `{"running":true,"pid":N}`, or `{"running":false,"exit":CODE}` after it
  exits. With `vmapp.gpu=1` on the command line (§8.7) `hello` has one more member, `"gpu":{"probe":false}` or
  `"gpu":{"probe":true,"stalledMs":N,"probes":M}`: whether the guest's GPU liveness probe runs, and how long the probe in
  flight has been waiting for the host's GPU worker (0 when none is). The launcher's watchdog reads it.
- `{"op":"start","command":[…],"workdir":"/app","env":["K=V",…]}` starts the core **once**.
  - Its environment is built in this precedence order:
    1. the given `env`;
    2. the runtime image's own environment (`/etc/vmapp/runtime.env`, written by `mkruntime` from the image's
       `ENV`; for example `NODE_PATH` and `DOTNET_*`), with any `VMAPP_*` lines ignored;
    3. the defaults: `HOME=/data`, `TMPDIR=/tmp`, `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
       and the network defaults of §8.3 (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and their lower-case forms,
       `NO_PROXY=localhost,127.0.0.1`, `NODE_USE_ENV_PROXY=1`, and `SSL_CERT_FILE` when the runtime has
       `/etc/ssl/certs/ca-certificates.crt`).

    `VMAPP_SOCKET=/run/vmapp/core.sock`, `VMAPP_ID=<instance id>` and `VMAPP_DATA=/data` are always set by the
    guest. `mkruntime` also writes a minimal `/etc/hosts` (localhost). `VMAPP_GPU_RPC=127.0.0.1:50052` is in the given `env`
    (the host's, never the manifest's: §8.6) exactly when the app was granted the GPU.
  - Resolving `command[0]`: if it contains a `/`, use it as is (relative to `workdir`). Otherwise search `PATH`
    inside `/rt`.
  - Returns `{"ok":true,"pid":N}`, or `{"ok":false,"error":"…"}`. A second `start` returns
    `{"ok":false,"error":"already started"}`.
- `{"op":"shutdown"}` returns `{"ok":true}`. The guest then sends SIGTERM to the core, waits up to 2 s, sends
  SIGKILL, syncs and powers off.
- `{"op":"mount","slot":K,"name":"pick-N"}` mounts virtiofs tag `vmapp-sK` at `/rt/host/<name>` (nosuid, nodev;
  read-only if `"ro":true`). It creates the mount point on a small tmpfs overlay: `/rt/host` is a tmpfs holding
  bind mounts of the static shares plus these slot mounts. Returns `{"ok":true}`. The name must match
  `^(pick|save)-[0-9]{1,4}$`.
- `{"op":"umount","name":"pick-N"}` lazily unmounts (`MNT_DETACH`) and removes the mount point. Returns
  `{"ok":true}`.
- `{"op":"service","name":"gpu"}` opens the guest's loopback listener of a host service (§8.6): `127.0.0.1:50052` for `gpu`.
  Returns `{"ok":true}` (also when it is already open) or `{"ok":false,"error":"unknown service …"}`. The host sends it
  before `start`, only for a service it was given. `{"op":"service-stop","name":"gpu"}` closes the listener again
  (connections that are open are closed by the host). Without `service`, nothing listens on the service ports and a
  connection to one is refused by the kernel.

**The network proxy (§8.3).** `vmapp-init` always listens on `127.0.0.1:3128` (an HTTP proxy), and on vsock ports 1022,
1025 and 1026 (all before port 1023 answers, so a `hello` means they are ready). The VM still has **no network device**:
the proxy is the only way out, and every connection goes to the host to be allowed or refused.

**The `/rt/host` layout** (replacing the earlier "bind of `/host`"): `/rt/host` is a tmpfs. At boot, the guest
bind-mounts each top-level directory of the static `/host` (`appdata`, `f-*`) into it. Runtime grants are mounted
there by the `mount` op. The core sees one `/host` folder either way.

The core's stdout and stderr go to the console log, one line each.

**When the core exits:** log its status, sync, power off. The VM is the app.

---

## 5. Host launcher contract (`vmapp-vm`)

```
vmapp-vm run --kernel IMAGE --initramfs CPIO --runtime RUNTIME.img --core CORE.cpio --appdata DIR
             [--share NAME:ACCESS:DIR]... --start JSON --socket PATH
             [--memory MiB] [--cpus N] [--console LOG] [--id HEX8] [--no-follow-parent]
             [--net RULE]... [--service NAME=127.0.0.1:PORT]... [--dev-allow-loopback] [--dev-resolve NAME=IP]...
```

**Size.** `--memory` and `--cpus` carry the **user's choice** of the VM's size, resolved by hostlib (§8.5): by default one vCPU
and the manifest's recommended memory, never above the Mac's cores or half of its memory. The manifest's `core.cpus` and
`core.memoryMiB` are only recommendations.

**Network rules.** `--net RULE` (repeatable) allows the app to reach one host (§8.3). `RULE` is `HOST[:PORT[,PORT]...]`
or `HOST:*` with `HOST` an exact name, `*.suffix` or `*` (any public host name), and the ports default to `443`; `*` as the
ports means every port. No `--net` means no network: the guest
proxy then answers every request with `403 network not granted`, and the host opens no network channel at all.
`--dev-allow-loopback` and `--dev-resolve` exist for tests and developer tools only (§8.3, INV-N3); the loader never
passes them.

**Host services.** `--service NAME=127.0.0.1:PORT` (repeatable, once per name) gives the app one **host service** (§8.6): a
loopback endpoint that the loader started, which the guest reaches by *name*. `NAME` is one of the services this launcher
knows (`gpu`); the endpoint must be the IPv4 literal `127.0.0.1` and a port from 1 to 65535, otherwise the launcher exits 2
before any VM starts. The flag comes from the loader's command line and from nowhere else: not from a manifest, the guest or
the bridge (GOVERNANCE INV-H7). With a service the launcher sends the guest `service` (§4) after `hello`, before `start`, and
opens the network channel (port 1022) even when there are no `--net` rules. No `--service`, no listener in the guest and no
channel.

**Shares.** `ACCESS` is `ro`, `rw` or `wo`.
- `appdata` is always shared read-write.
- Folder grants from the manifest are named **`f-<name>`**.
- Grants made at run time are named **`pick-<n>`** (open dialogs) and **`save-<n>`** (save dialogs).
- A `wo` share is a fresh staging directory, delivered live into `DIR` with **exactly agent-vm's rules**:
  - a file is delivered when it settles for two 500 ms polls in a row;
  - names starting with `.` or ending in `.partial` wait until stop;
  - a name clash becomes `name (1).ext`;
  - the guest never sees `DIR`.

  One exception: a `save-<n>` share delivers to its chosen *file* path and overwrites it, because the user already
  confirmed the overwrite in the save dialog.

**`--start`** is the JSON object for the control `start` op, minus `"op"`.

**Sequence:**
1. Boot.
2. Wait for `hello` (≤15 s).
3. Send `start`.
4. On success, print the ready line.

**stdout:** JSON lines. Writes ignore errors; never `println!`.
- `{"ready":true,"socket":"…","hello":{…},"pid":N}`
- `{"exported":{"share":"f-export","files":["a.html"]}}` for each live delivery batch.
- `{"granted":{"name":"pick-0","access":"ro"}}` or `{"revoked":{"name":"pick-0"}}`, in answer to stdin commands.
- `{"net":{"id":N,"host":"…","port":443,"allowed":true,"bytesUp":0,"bytesDown":0,"durationMs":0,"reason":"…"}}`
  for each proxied connection, printed when it closes or is refused (`reason` only when there is one; `"window":true` for a
  connection of the app's windows through the window endpoint). See §8.3.
- `{"net-allowed":{"rule":"…"}}` or `{"net-revoked":{"rule":"…","closed":N}}`, in answer to stdin commands.
- `{"window-proxy":{"port":N}}`, in answer to the stdin command `window-proxy` (§8.3 "The app's windows"). The secret is never
  printed.
- `{"forward":{"id":N,"port":P,"hostPort":H,"phase":"listen|conn|stop","bytesUp":0,"bytesDown":0,"durationMs":0,"reason":"…"}}`
  for port forwarding (§8.8): `listen` when a forward starts, `conn` when one forwarded connection ends (with its counts; `bytesUp`
  from the app's server, `bytesDown` to it), `stop` when the forward ends.
- `{"port-forwarded":{"port":P,"hostPort":H}}` and `{"port-closed":{"port":P,"closed":N}}`, in answer to stdin commands.
- `{"service":{"id":N,"name":"gpu","phase":"open|traffic|close","allowed":true,"bytesUp":0,"bytesDown":0,"durationMs":0,"reason":"…"}}`
  for each tunnel to a host service (§8.6): `open` when it is up, `traffic` about every half second while bytes moved (the
  counters are cumulative, and a newer `traffic` replaces one that was not printed yet), `close` when it ends or was
  refused (`allowed:false`, and `reason` says why: `service not granted`, `too many connections …`, …).
  `bytesUp` counts bytes from the app, `bytesDown` bytes to the app. Names and counts only, never contents.
- `{"service-revoked":{"name":"gpu","closed":N}}`, in answer to the stdin command `service-revoke`.
- `{"error":{"op":"grant","message":"…"}}`
- `{"stopped":true,"reason":"core-exited|shutdown|parent-exited|signal","exitCode":N|null,"exported":{"f-export":["…"]}}`,
  printed last. `vmapp-vm-krun` (§8.7) adds two reasons, `gpu-hang` (its watchdog killed the VMM because the guest or its GPU
  stopped answering) and `vmm-crashed` (the VMM died by itself), and then a `"detail":"…"` member that says what it saw.

**stdin:** JSON lines, commands from the parent.
- `{"op":"grant","name":"pick-0","access":"ro|rw|wo","path":"/abs/dir"}` adds a share to the running VM:
  1. Take a free slot K.
  2. `set_shares` on device `vmapp-sK` only. For a `wo` grant, share its staging folder.
  3. Send the guest control `{"op":"mount","slot":K,"name":…,"ro":…}`.
  4. Print `granted`.

  For `wo` with a *file* path, it is a save grant. If all 8 slots are in use, it fails with an `error` line.
- `{"op":"revoke","name":"pick-0"}`: control `umount`, then reset the slot's share to the placeholder and free the
  slot.
- `{"op":"net-allow","rule":"api.example.com:443"}` adds a network rule to the running VM (§8.3). A rule for the same
  host replaces the old one, and open connections the new rule no longer allows (fewer ports) are closed like a
  revoke. Answered with `net-allowed`, or an `error` line.
- `{"op":"net-revoke","rule":"api.example.com"}` removes the rule for that host (any ports part is ignored), then closes
  every open connection that no remaining rule allows. Answered with `net-revoked`.
- `{"op":"window-proxy","secret":"…"}` starts the window endpoint (§8.3 "The app's windows"): a `CONNECT` proxy on `127.0.0.1`
  for the app's windows, under the same rules as the guest, answering only clients that authenticate as `vmapp` with this secret
  (32 to 128 letters and digits; hostlib makes 64 hex characters per run). Once per run. Answered with `window-proxy`, or an
  `error` line. The secret comes on stdin only, never on the command line.
- `{"op":"port-forward","port":P}` forwards the VM's port P to this Mac (§8.8): listens on `127.0.0.1:P` when it is free, else on
  `127.0.0.1` at a port of the system's choice; a port already forwarded gives its port again. At most 16 forwards. Answered with
  `port-forwarded`, or an `error` line. The parent checks the user's grant first.
- `{"op":"port-close","port":P}` stops it and closes its open connections. Answered with `port-closed` (after the `stop` event).
- `{"op":"service-revoke","name":"gpu"}` takes a host service away (§8.6): no new tunnel opens, every open tunnel is closed
  at once (each reports a `close` with reason `revoked`), the guest is told `service-stop` (its port closes). Answered with
  `service-revoked` (`closed` = the tunnels it closed; 0 for a name the app was not started with).
- `{"op":"shutdown"}` is the graceful stop: control `shutdown`, wait 5 s, force stop, final delivery.
- **EOF on stdin** means the parent is gone, and leads to a graceful stop.

**Lifecycle:**
- Watch the parent (kqueue `NOTE_EXIT`). If the parent dies, or SIGINT, SIGTERM or SIGHUP arrives, do a graceful
  stop.
- If the guest powers off, do the final delivery and print the stopped line.
- The process exits 0 after printing the stopped line.

A Unix socket path must be shorter than 104 bytes. Launchers put it in `/tmp/vmapp-XXXXXX/b.sock`.

**The second launcher, `vmapp-vm-krun` (EXPERIMENTAL, §8.7).** It takes this command line and speaks this protocol unchanged,
for what its backend supports: the `--kernel` is the gpu flavour's `Image-gpu`; stdin `grant` and `revoke` are answered with
an `error` line, `not supported on the gpu backend`; `exported`, `net`, `net-allowed`/`net-revoked`, `window-proxy`,
`service`/`service-revoked`, `ready` and `stopped` are the same. Its extra flags: `--gpu-window MiB` (the guest's window of host GPU memory, 256 to 32768,
default 8192), `--watchdog SECS` (default 30, 0 = off), `--krun-dir DIR` (where `lib/` and `share/vmm.sb` are; default the folder
above the executable), `--no-gpu` (boot without the virtio-gpu device; tests) and `--dev-no-sandbox` (no sandbox profile;
development only, like `--dev-allow-loopback` never passed by the loader, INV-H8).

---

## 6. The bridge protocol (host ↔ core)

The host opens **one** connection to the bridge socket after the ready line and keeps it open for the app's
lifetime. Both directions send **JSON lines**: one object per `\n`, with `"t"` as the message type. The maximum line
is 16 MiB. Unknown `t` values are logged and ignored. Window ids (`win`) are integers assigned by the host. Request
ids (`id`) are integers unique per sender.

**The Inspector's view of the bridge.** Every message in both directions is an Inspector row with its type, channel or op,
size, timing and a **preview**: the first 200 characters of the message JSON, so a developer can watch their window talk to
their core. The Inspector appears on shared screens and in recordings, so a value that looks like a secret is shown as
`"[hidden]"`: a string under a field whose name suggests one (`apiKey`, `secret`, `password`, `token`, `authorization`,
`credential`, `cookie`, …), a string shaped like a well-known key or token (`sk-…`, `ghp_…`, a JWT, `Bearer …`, a PEM private
key), and the whole payload (`args`, `result`, `params`, `data`) of a message whose channel or op name suggests one
(`api-keys:set`). This is a best effort: the payloads are the app's own and the platform cannot know which are secret, so
a secret under an unremarkable name is shown. The host also reads only a bounded part of a message for the preview (a fixed
number of values, long strings cut). `host.*` and `clipboard.*` payloads are not shown at all (§8.2, §8.4).

### host → core
| `t` | Fields | Meaning |
|---|---|---|
| `init` | `app:{id,name,version}`, `platform:{os:"linux",arch:"arm64"}` (the VM's platform), `folders:{<name>: "/host/f-<name>" \| null}`, `data:"/data"` | first message; `null` = the user didn't grant that folder |
| `invoke` | `id`, `win`, `channel`, `args:[…]` | the renderer called `vmapp.invoke(channel, …args)`; the core must answer with `result` |
| `send` | `win`, `channel`, `args:[…]` | the renderer called `vmapp.send(channel, …args)`; no answer |
| `window` | `win`, `event:"closed"\|"focus"\|"blur"\|"resize"\|"menu"`, `data:{…}` | window events; `menu` carries `{id}`: the user chose that item of the menus the core set (`menu.set`, §7 "Menus") while window `win` was focused |
| `reply` | `id`, `result` **or** `error:{message}` | answer to a core `request` |
| `before-quit` | — | the host is stopping the app; the core has 3 s before the VM is stopped |
| `open-url` | `url` | a `vmapp://<this app's id>/…` link was opened on the Mac (§8.9); only with `permissions.links`. The SDK emits Electron's `app.on('open-url', (event, url))` |

### core → host
| `t` | Fields | Meaning |
|---|---|---|
| `ready` | — | the core finished starting; it must arrive within 30 s of `init`, or the host stops the app |
| `result` | `id`, `result` **or** `error:{message}` | answer to an `invoke` |
| `emit` | `win`, `channel`, `args:[…]` | deliver to the renderer's `vmapp.on(channel)` listeners in window `win` (`webContents.send`) |
| `request` | `id`, `op`, `params` | ask the host for something; answered by `reply` |
| `log` | `level:"debug"\|"info"\|"warn"\|"error"`, `message` | shown in the loader's app log |

### Request ops (core → host)
| `op` | `params` | `reply.result` |
|---|---|---|
| `window.create` | `{entry:"index.html", width, height, minWidth?, minHeight?, title?, resizable?, devTools?}`. `entry` is relative to `ui.root`, with no `..`. `devTools` is a boolean, default `false`: only `true` lets the user open DevTools on this window (§7) | `{win}` |
| `window.close` | `{win}` | `{}` |
| `window.setTitle` | `{win, title}` | `{}` |
| `window.focus` | `{win}` | `{}` |
| `menu.set` | `{template}` (§7 "Menus"; `null` removes the menus) | `{items, dropped}`: the app's menus in the Mac menu bar while one of its windows is focused (a window's own `vmapp.menu.set` wins for that window). An invalid template is refused with the path of the first problem; `dropped` lists the shortcuts the loader keeps. Clicks come back as the window event `menu` `{id}`. |
| `dialog.open` | `{win?, title?, directory:bool, multiple:bool, access?:"read"\|"readwrite"}` | `{canceled:true}` or `{canceled:false, paths:["/host/pick-0", …]}`. Needs `permissions.dialogs`. **Directory picks** share the folder with the requested access (default `read`); the dialog's prompt states it ("…will be able to change files in this folder"). **File picks** are always read-only and never expose sibling files. The host makes an instant APFS clone (`COPYFILE_FICLONE`, falling back to a copy) of each chosen file into a fresh `$VMAPP_HOME/picks/<id>/pick-N/` and shares that folder, returning `/host/pick-N/<file name>`. |
| `dialog.save` | `{win?, title?, defaultName}` | `{canceled:true}` or `{canceled:false, path:"/host/save-N/<name>"}`. Write the file there; the host delivers it to the chosen location when the write settles (write `<name>.partial`, then rename, for large files). Needs `permissions.dialogs`. |
| `dialog.message` | `{win?, type:"info"\|"warning"\|"error"\|"question", message, detail?, buttons?:[…]}` | `{response: index}` |
| `shell.openExternal` | `{url}` (`https:`, or `http(s)://localhost` / `127.0.0.1` on a port this app forwards now, §8.8) | `{opened:bool}`. The host asks the user first. Needs `permissions.external`. |
| `port.forward` | `{port}` (1-65535, a port of the VM) | `{port, hostPort, url}`: the app's server on `port` in the VM is reachable on this Mac at `http://localhost:<hostPort>/` (the same port when it is free). Needs the device `ports` (manifest and the user's allow, §8.4, §8.8), checked at every call. |
| `port.close` | `{port}` | `{closed}`: the forward ends and its open connections close. Needs no permission. |
| `port.list` | `{}` | `{ports:[{port, hostPort}]}`: the ports forwarded now. |
| `app.quit` | `{}` | `{}`, then the host stops the app |
| `clipboard.readText` | `{}` | `{text, truncated}`: the Mac's clipboard as plain text, at most 1 Mi characters. Needs the device `clipboard` (manifest and the user's allow, §8.4), checked at every call. The Inspector shows the op, never the text. |
| `clipboard.writeText` | `{text}` (a string of at most 1 Mi characters) | `{}`: the Mac's clipboard now holds `text`. Same permission as `clipboard.readText`. |

The host enforces every permission. A denied request gets `reply.error = {message:"permission denied: …"}`.

**Notes for cores that implement this protocol themselves** (without the Node SDK):
- **Never block the reading loop.** A core's own `request` is answered by a `reply` on the same connection, so an
  `invoke` handler that waits on a request (for example a dialog) must run off the reader: on a thread or task, or
  through an async continuation. Otherwise the reply can never be read.
- **Empty results:** a `reply.result` documented as `{}` may arrive as `null`. Treat both the same.
- **Quitting:** send `request app.quit` before exiting, for example on the last window's `closed`. Then the stop
  reason is reliably `core-exited` rather than racing with the host's own shutdown.

---

## 7. The renderer (host side)

- Each app window is a `BrowserWindow` in the loader, with:
  - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`;
  - its own session partition, `persist:vmapp-<id>` (storage isolated per app);
  - `devTools` = the `devTools` of that window's `window.create` request (§6), default `false`, in dev **and** packaged
    builds. This is the app's own choice for its own windows, made by its core, exactly like Electron's
    `webPreferences.devTools` (the Node SDK sends it for `new BrowserWindow({ webPreferences: { devTools: true } })`). It is
    not a manifest field, and the renderer can't change it.
- **DevTools:** the loader's View menu has one "Developer Tools" item (⌥⌘I). It opens DevTools only for the focused app
  window that was created with `devTools: true`; it does nothing for any other window. The loader's own windows (library,
  inspector, settings, badge, activity monitor) have DevTools in dev builds only. A packaged loader also closes DevTools the moment they open
  on a loader window or on an app window created with `devTools: false` (belt and braces), and it still refuses
  `--remote-debugging-*` and the other debugging switches (loader/PACKAGING.md).
- UI files are served from the installed package with the custom protocol `vmapp-ui://<id>/<path>`. Each file is
  checked against `files` before it is served. A missing or modified file gives 404.
- Every response carries this CSP header:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
  **The renderer has no network of its own.** The one way out is the window feature `network`: the windows' data requests leave
  through the app's own proxy, under the app's network grants (§8.3 "The app's windows").
- **Window features** (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C1). An app whose manifest declares
  `ui.features` (§2.2) gets the CSP above **plus exactly** these sources, per declared feature (a directive whose value is `'none'` is
  replaced, a missing one is added; the loader's table is `UI_FEATURE_CSP` in `loader/src/protocols.js`):

  | Feature | Adds | So that the window may |
  |---|---|---|
  | `workers` | `worker-src 'self' blob:` | run dedicated and shared workers, also from `blob:` scripts it builds |
  | `wasm` | `script-src 'wasm-unsafe-eval'` | compile WebAssembly |
  | `self-fetch` | `connect-src 'self'` | `fetch` its own package files (`vmapp-ui://<id>/…`), from the page and from workers; still no network |
  | `frames` | `frame-src vmapp-frame:` | show isolated frames (below) |
  | `network` | `connect-src https: wss:; img-src https:; media-src https:; font-src https:; style-src https:` | load data from the hosts the user allowed the app to reach: `fetch`, WebSockets, images, media, fonts and style sheets, through the app's proxy (§8.3 "The app's windows"); needs `permissions.network` |

  No feature adds `'unsafe-inline'` or `'unsafe-eval'` to the page. Only `network` adds network sources, and only these: never to
  `script-src`, `worker-src`, `frame-src`, `object-src` or `default-src`, so no code and no document ever comes from the network.
- **Isolated frames** (`frames`). `vmapp-frame://<label>/<path>`, in the app's own partition, serves the same files as
  `vmapp-ui://<id>/<path>` (listed in `files`, SHA-256 checked, INV-B4), and only for an app that declares `frames` (404 otherwise).
  `<label>` is 1-253 characters `[a-z0-9.-]` starting with a letter or digit; it carries no meaning but the origin: every label is its
  own origin, so a frame cannot read the app's page or another frame (they talk with `postMessage` only). Frames get no `window.vmapp`
  (the loader's preload runs in the main frame only; `nodeIntegrationInSubFrames` is `false`), no permission (the microphone gate needs
  the main frame), and no network of their own (the request filter below). `vmapp-frame` is the only scheme where **service workers** may run. Every `vmapp-frame` response
  carries this CSP:
  `default-src 'self' vmapp-frame: blob: data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: https:; style-src 'self' 'unsafe-inline' blob: data: https:; img-src 'self' blob: data: https:; media-src 'self' blob: data: https:; font-src 'self' blob: data: https:; connect-src 'self' blob: data: https:; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self' https:; form-action 'none'`
  The `https:` sources let web content **name** https URLs that the frame's own service worker answers (VS Code's webviews refer to
  their resources as `https://*.vscode-resource.vscode-cdn.net/…`, and set `<base href>` to such a URL); they are not network. For frames the network boundary is the
  app partition's request filter, as it always was for every app window: it cancels every request whose scheme is not
  `vmapp-ui:`, `vmapp-frame:`, `data:`, `blob:` or `devtools:`, so an `http(s)`/`ws(s)` request that leaves a frame fails, and only
  what the frame's service worker answers itself arrives. The filter's one exception, for an app that declares `network`
  (§8.3 "The app's windows"), holds for frames as for the page: `https` data requests (images, media, fonts, style sheets,
  `fetch`) leave through the app's proxy; a script, a frame or a worker from the network never does.
  A subframe of such an app may navigate to `vmapp-frame://`, `about:blank`, `about:srcdoc`, `blob:vmapp-frame://…` and `data:` URLs;
  the main frame stays on `vmapp-ui://<id>/`.
- Navigation outside `vmapp-ui://<id>/` is blocked and `window.open` is denied. **Every permission request is denied**
  (camera, notifications, geolocation, clipboard-read, screen sharing, …) **with exactly one exception, defined in §8.4**:
  `getUserMedia({audio})` for the microphone, only when the app's manifest asks for it **and** the user allowed it for that
  app. A request that includes video is denied as a whole. The loader's own windows get no permission at all.
- The loader's preload (never the app's own; apps can't ship a preload) exposes exactly:
  ```js
  window.vmapp = {
    invoke(channel, ...args) → Promise,      // → core ipcMain.handle
    send(channel, ...args),                  // → core ipcMain.on
    on(channel, listener) → unsubscribe(),   // ← core webContents.send
    menu: { set(template) → Promise, onClick(listener) → unsubscribe() },   // the window's menus ("Menus" below)
    app: { id, name, version },
  };
  window.vmapp.ipcRenderer = { invoke, send, on }   // alias that eases porting Electron renderers
  ```
  Arguments and results must be JSON-serialisable.
- The window title is `<window title> — <app name>`, set by the host. The loader marks app windows as sandboxed in
  its own UI (the app list); the app can't draw over that.
- **Leave this page?** (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) §11 step 18). When a page vetoes its
  own unload (a `beforeunload` handler that calls `preventDefault` or sets `returnValue`, on a reload, a navigation or the user
  closing the window), the loader asks with a native sheet on that window, in its own words: "Leave this page?", “`<app name>`” asks
  you to confirm: changes you made may not be saved, **Leave** / **Stay** (Stay is the default and the answer to Escape). The page's
  own text is never shown. Leave unloads; Stay keeps the page. A veto of the same window within 1 s after Stay stays without asking,
  so a page cannot pile up questions. A window the app's core or the loader closes (the op `window.close` of §6, Stop, quit) is never asked about.

### Menus (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C9)

An app may put its own menus in the Mac menu bar, with their keyboard shortcuts, from its **page**
(`vmapp.menu.set(template)`, clicks to `vmapp.menu.onClick(listener)` with the item's id) or from its **core** (the op
`menu.set`, §6; the Node SDK's Electron-compatible `Menu.buildFromTemplate` / `Menu.setApplicationMenu`, whose items' `click`
run in the core). A page's menus win for its own window; the core's apply to every other window of the app.
- **A template is data:** an array of at most 16 menus `{label, submenu:[item…]}`; an item is `{id, label, accelerator?, enabled?,
  visible?, checked?, type?: normal|separator|checkbox|radio|submenu, role?, submenu?}`, at most 4000 items, 5 levels, labels of
  120 characters, ids of 200 (unique). `role` is one of `undo redo cut copy paste pasteAndMatchStyle delete selectAll minimize zoom
  togglefullscreen`: Electron runs those itself on the focused window. Any other key, role or type is refused, and so is a
  shortcut that is not Electron's accelerator grammar (`hostlib/menus.js`).
- **The loader keeps** ⌘Q, ⌘H and ⌥⌘H whatever an app asks (such a shortcut is dropped from the item, which stays). It keeps its
  first menu (About, Hide, Quit) before the app's menus and its **Window** menu after them (its windows, without their ⌘1-⌘4
  shortcuts while an app with menus is focused, and Developer Tools). When the app's menus have no `copy` or `paste` role, the
  loader's Edit menu is added so that keyboard copy and paste keep working.
- **A click** only sends the item's id to the app (the page's listener, or the core's window event `menu`); it never runs loader
  code. While a loader window, or an app window without menus, is focused, the menu bar is the loader's own.
- **Threats:** an app's labels appear in native UI. They cannot imitate a loader decision: every loader question is a sheet or a
  native dialog of its own (INV-B5), the loader's own menus stay first and last, and choosing an app item only tells that app.

---

## 8. Lifecycle

1. **Install** (`vmapp install file.vmapp`, or *Install from file…* in the loader):
   - read and verify the package (§2), checking the runtime is installed and the version is newer than or equal to
     the installed one (downgrade only with `--force`);
   - extract it to `apps/<id>/<version>/`, keep the installed `.vmapp` itself as `apps/<id>/pkg/<version>.vmapp`
     (so *Publish…* sends exactly what was installed), and write `current`.

   App data and grants are kept across updates.

   **Developer build** (the loader's *Run project folder…* and *Rebuild & run*): the loader packs a project folder
   with the same `pack` as `vmapp pack`, installs the result with the downgrade rule lifted (the developer's folder wins)
   and records the folder in `apps/<id>/dev.json` (`{"path":"<absolute project folder>"}`). The card then says
   "Developer build from <folder>" and offers *Rebuild & run*. A developer build never asks a registry for updates; any
   other install of the id removes `dev.json`. Everything else (verification, permission sheet) is as for any install.

   **Load examples** (the loader's empty library, and *File → Load examples…*): the sample apps that came with this loader
   (`<Resources>/vmapp/examples/*.vmapp` when packaged, `out/examples/` or `$VMAPP_EXAMPLES_DIR` in development) are listed
   from the packages themselves (name, description, version, size, and badges for the network hosts, the GPU, control of the
   computer and the microphone they ask for) together with a "What to allow" hint (the folder's `README.md` row for the
   package, else derived from the manifest). The user chooses which to install; each goes through exactly the install above
   (full verification, then extraction), one after the other. A package that fails verification is reported with the
   precise message and does not stop the others; one whose version is already installed, or older than the installed one,
   is skipped with a note. Installing grants nothing and launches nothing: the permission sheet comes at each app's first
   launch (INV-B5, INV-D3). A packaged loader without examples hides the entry.
2. **Launch:**
   1. **Permission sheet:** shown on first launch, after an update that adds folder requests, or whenever the user
      chose "ask every time". It lists the manifest's requests with their purpose. The user picks a folder for each,
      or skips it, and can grant less than requested (`readwrite` can be downgraded to `read`). Choices are saved
      in `grants/<id>.json`, which holds folder paths and accesses, host-capability grants (§8.2), network
      grants (§8.3), device grants (§8.4) and the user's choice of the VM's size (§8.5), never file contents. A device entry (the microphone) starts on **Don't allow**. Every network entry is shown with its purpose and starts on **Don't allow**. The sheet also has a **Resources** row (§8.5): the VM's vCPUs and memory, which the manifest only recommends. An app that asks for network access, host capabilities or devices gets the sheet at its first launch even if it asks for no folder.
   2. Spawn `vmapp-vm` with the runtime, the core (`core.cpio` or `core.erofs`, as `--core`), appdata, the granted shares and the `start` command.
   3. Wait for the ready line.
   4. Connect the bridge and send `init`.
   5. The core sends `ready` and creates its windows with `window.create`.
3. **Run:** the host routes `invoke`, `send`, `emit` and `request` traffic, enforces permissions and logs.
4. **Stop**, in any of these ways:
   - **The core quits** (`app.quit` or a process exit): the VM powers off, the host closes the app's windows.
   - **The user stops it in the loader:** the host sends `before-quit`, waits up to 3 s, sends `{"op":"shutdown"}`
     on stdin, then closes the windows.
   - **The loader quits:** it does the same for every running app.
   - **The loader crashes:** every `vmapp-vm` sees its parent die and stops its VM.

   Write-only outputs are delivered on every path.
5. **Window closing:** when the last window of an app closes, the host sends `window closed`. Following Electron,
   the core decides what happens: the Node SDK default is `app.quit()` when all windows are closed.
6. **Uninstall:** removes `apps/<id>/`. App data is removed only on request (`--purge`).

### 8.1 Versions and update choices (format 1, loader and registry)

**What the store keeps:**
- `apps/<id>/<version>/` for each installed version. The store keeps the **current version plus the 2 previous
  ones**; older ones are removed after a successful switch.
- `apps/<id>/current`: the active version.
- `apps/<id>/source.json`, optional, written when the app was installed from a registry:
  `{"registry":"https://…","id":"<id>","installedFrom":"<version>"}`.
- `apps/<id>/policy.json`: `{"update":"manual"|"compatible"|"latest"}`. The default is `manual`.
- `apps/<id>/pkg/<version>.vmapp`: the package file as installed, removed with its version; `dev.json`: see §8 (developer build).
- `publish-tokens.json` in the data root (mode 0600): `{"<registry url>": {"<app id>": "<owner token>"}}`, written by
  `vmapp publish` and by the loader's *Publish…*.

**Update choices:**

| Value | Shown as | Picks |
|---|---|---|
| `manual` | Stay on this version | nothing, until the user chooses a version |
| `compatible` | Latest compatible | the highest non-withdrawn version with the **same major** as the current one (for `0.x`, the same minor). It never crosses a breaking change. |
| `latest` | Always latest | the highest non-withdrawn version |

**When the loader contacts a registry:** only for apps with a `source.json`, and only:
- at launch, if the choice isn't `manual`; or
- when the user clicks **Check for updates**.

Separately, and for any installed app, the loader's *Publish…* sheet makes one upload of the installed package when the
user presses **Publish** (the owner token is sent only if the user has one). That is a `GET /api/info`, then either one
`POST /api/publish` or the presigned form (`init`, a `PUT` to the storage address the registry named, `complete`).

The loader's *Browse registry…* sheet makes one `GET /api/apps` to the registry the user typed or configured each time the
user opens it with a registry set, searches, changes the sort or presses **Show more**. The request carries only the search text,
the sort and the page (`q`, `sort`, `limit`, `offset`): never the installed apps. Its answer is display data only;
**Install** on a result goes through the same download and verification as any registry install.

This is user-chosen network use (INV-G3). It has a 5 s timeout; if the registry is offline, the app launches the
current version.

**Applying an update:**
1. Download the package. A registry that keeps packages in object storage answers `…/download` with a `302` to the package on
   its public storage address (carrying the headers below); the client follows that one redirect (never from https to http,
   never a second hop) and takes the checksum and package id from the **registry's** response, not from the storage's.
2. Verify the `.vmapp` file's sha256 (against the registry's `X-Vmapp-Sha256`), the package (SPEC §2), the package id (against the
   registry's `X-Vmapp-Package-Id`), and that the id and version are the ones asked for. The storage is never trusted.
3. Compare permissions with the current version. If the new version adds a folder request, raises a folder's access
   (`read` → `readwrite`, `read` → `writeonly`, or `writeonly` → `readwrite`; any change that gains write or read
   ability), adds a host capability (§8.2), adds a network host or a port the old version could not already reach
   (§8.3), asks for a device it did not ask for before (the microphone, §8.4), or turns on `dialogs` or `external`, the
   update **always stops and asks**, whatever the choice. The loader shows what changed, and the user approves or keeps the current
   version.
4. Install it, set it current, and launch.

**Switching versions:**
- The user can switch to any installed version at any time ("Use version X"), or install a specific version from
  the registry.
- **Going to an older version** is an explicit user action; it's never chosen automatically. It also sets the
  app's update choice to `manual`, so the next launch doesn't jump forward again; the confirm dialog says so.
- **"The 2 previous versions"** means the 2 most recently current ones.
- **App data** (`/data`) is shared across versions of the same id. An app that changes its data format must handle
  older data, or migrate it; downgrades are at the user's risk, and the loader says so.

**Withdrawn versions:**
- **Publishing it:** a registry publisher can mark a version as *withdrawn*, with a reason.
- **Effect on choices:** a withdrawn version is never picked by `compatible` or `latest`.
- **Still available:** it stays downloadable by exact version, and the loader shows the reason.

**Registry endpoints for this:**
- `GET /api/apps/:id/versions` → `[{version, packageId, sha256, size, publishedAt, withdrawn:{reason,at}|null}]`
- `GET /api/apps/:id/resolve?choice=compatible|latest&from=<version>` → `{version}|{version:null}`.
  - **Never lower:** the result is never lower than `from`. It may equal `from`, or be `null` when nothing fits, so
    resolution never downgrades.
  - **Prereleases:** they are skipped, unless `from` is itself a prerelease of the same `x.y.z`.
  - **`from`:** required for `compatible`; for `latest`, it defaults to no lower bound.
  - **Withdrawn versions:** a withdrawn version downloaded by exact number carries `X-Vmapp-Withdrawn:
    <percent-encoded reason>`. Clients read reasons from `/versions`.
- `POST /api/apps/:id/:version/withdraw {reason}` and `…/restore` (owner token)
- `GET /api/apps/:id/:version/download` → the package (`200`), or `302` to it. Both carry `X-Vmapp-Sha256`, `X-Vmapp-Package-Id`,
  `X-Vmapp-Version` (and `X-Vmapp-Withdrawn` for a withdrawn version); a client verifies the bytes against these.
- `GET /api/info` → `{publishModes:["direct"]|["direct","presigned"], downloads:"direct"|"redirect", maxPackageBytes}`. With
  `presigned`, publishing may go `POST /api/publish/init {size, sha256}` → `{uploadId, method:"PUT", url, headers, expiresAt}`,
  `PUT` of exactly `size` bytes to `url` (valid 15 minutes), `POST /api/publish/complete {uploadId}` (same headers as a direct
  `POST /api/publish`; the registry fetches and verifies the package as for a direct upload). Clients use it when advertised
  and fall back to `POST /api/publish` otherwise. The registry's own storage design is in `registry/README.md`.

---

## 8.2 Host capabilities (accepted by the maintainer 2026-10-15; broker, helper and loader UI implemented)

Host capabilities let an app act on the host beyond files: see the screen, control the mouse and keyboard, run
host tools, and use host apps through MCP. They exist for computer-use agents and automation. **Granting one
deliberately lets that app act on your computer in that way.** The rules below keep that explicit, visible and
revocable. GOVERNANCE §H holds the invariants.

**Who defines capabilities.** Only the loader and the user, never an app.
- **The catalog** lives in the loader's data folder:
  - `capabilities/tools.json`: user-registered host tools;
  - `capabilities/mcp.json`: user-registered MCP servers;
  - the built-ins `screen` and `input`.
- **Where it can be edited:** only in loader-owned settings UI, or with the CLI on the host. Nothing reached through
  the bridge can read or change it, except asking for what is granted.

**Manifest:** an optional `permissions.host`, an array of at most 8 entries:
```json
"host": [
  { "cap": "screen",  "purpose": "Reads the screen to help you fill forms" },
  { "cap": "input",   "purpose": "Clicks and types for you when you ask" },
  { "cap": "tool:*",  "purpose": "Runs the tools you allow, like screencapture" },
  { "cap": "mcp:*",   "purpose": "Uses apps that offer MCP tools, like VS Code" }
]
```
- `cap` is one of `screen`, `input`, `gpu`, `tool:<id>`, `tool:*`, `mcp:<id>` or `mcp:*`.
- `tool:*` and `mcp:*` mean "the user picks which ones".
- `gpu` is not a bridge op: it gives the core a tunnel to a sandboxed GPU server on the host (§8.6). It has one mode,
  `session` ("Allow while the app runs"), because a stream of requests cannot be asked about call by call. With `"api":"vulkan"`
  it is instead the **experimental** Vulkan GPU in the VM (§8.7); its grant records the API.
- A manifest can't name a tool path or a command. The user maps requests onto their own catalog.

**Grants:** stored per app in `grants/<id>.json` under `host`. Each grant has a mode:
- `ask` (the default): a loader dialog for each use, or for each session of input control;
- `session`: allowed until the app stops;
- `always`: never the default.

`input` and full-shell tools can't be granted `always`.

**Bridge request ops** (SPEC §6 additions). All are denied unless granted, and every use is logged to the
Inspector:

| `op` | `params` | `result` |
|---|---|---|
| `host.screen.windows` | `{}` | `[{windowId, app, title, bounds}]`. Needs `permissions.host` (`screen`). |
| `host.screen.capture` | `{target:"display"\|"window"\|"region", windowId?, region?:{x,y,w,h}, display?, maxWidth?}`: a **suggestion** (below) | `{png: base64, width, height, target:{kind, display?, windowId?, region?, bounds?, by}}`: `target` is what was **actually** captured. Needs `permissions.host` (`screen`). |
| `host.input.start` | `{reason}` | `{sessionId}`. Shows the control badge. Needs `permissions.host` (`input`); the user may be asked. |
| `host.input.mouse` | `{sessionId, action:"move"\|"down"\|"up"\|"click"\|"scroll", x?, y?, button?, dx?, dy?, clicks?}` | `{}`. Needs `permissions.host` (`input`) and a running input session. |
| `host.input.keys` | `{sessionId, text?}` or `{sessionId, key, modifiers?}` | `{}`. Needs `permissions.host` (`input`) and a running input session. |
| `host.input.stop` | `{sessionId}` | `{}`. Needs `permissions.host` (`input`). |
| `host.tool.list` | `{}` | the tools granted to this app: `[{id, name, kind, description?, variadic?, args}]` (never the host path). Needs `permissions.host` (`tool:*` or `tool:<id>`). |
| `host.tool.run` | `{id, args:[…], stdin?}` | `{exitCode, stdout, stderr, truncated, timedOut, signal}`. Needs `permissions.host` (`tool:<id>`); args checked. |
| `host.mcp.list` | `{}` | the granted MCP servers and their tool lists: `[{id, name, tools, error?}]`. Needs `permissions.host` (`mcp:*` or `mcp:<id>`). |
| `host.mcp.call` | `{server, method, params}` | the MCP JSON-RPC result. Needs `permissions.host` (`mcp:<id>`); `method` is one of `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`. |

**Screenshots: the user chooses what is captured.** The parameters of `host.screen.capture` are only a *suggestion*; the
user's choice wins, and the app receives only what was picked.
- **The question (mode `ask`).** The loader shows a loader-owned modal window parented to the app's window (never app UI,
  INV-B5) with: each display (name, resolution, a small live thumbnail the loader captures itself; thumbnails stay in the
  loader and are never sent to the app); each window (app and title; titles need Screen Recording); and *Select a
  region…* per display, a full-screen dimmed selection window on that display where the user drags a rectangle (Esc
  cancels; shown only during the selection). Buttons: **Deny** (the default), **Allow once**, **Allow while the app runs**.
  The app's suggestion is preselected when it exists (else the main display), so one click confirms it.
- **What "Allow while the app runs" remembers.** The permission only, never a target. Later captures in that run (and mode
  `session` / `always`, which never ask) use the app's suggestion when it is valid (the display, window or area still
  exists), else the main display. Allowing screenshots for the run also allows `host.screen.windows`; allowing only the
  window list does not allow screenshots.
- **Parameters.** `target` is `display` (default), `window` (needs `windowId`) or `region`; `display` is a display id and
  applies to `target:"display"`; `region` is `{x,y,w,h}` in **global desktop points** (a display to the left of the main
  one has negative `x`) and the display holding most of it is used; `maxWidth` (1 to 16384) scales down, never up, and is
  the one parameter the app keeps full say over. A malformed request is an error and is never asked about.
- **The result's `target`** says what was really captured, which can differ from the suggestion:
  `kind` is `display`, `window` or `region`; `display` is the display id used; `windowId` for a window; `region` for a
  region, in global points and clipped to its display; `bounds` is the captured area `{x,y,w,h}` in global points, so a
  position in the picture maps to a position for `host.input.mouse` (`x = bounds.x + fx * bounds.w`); `by` is `"user"` (picked in
  the question), `"app"` (the app's own suggestion, because the permission was already given) or `"default"` (the
  suggestion no longer exists, so the main display was captured). An app can pass `target` back as its next suggestion.
- **The loader's own windows are never in a screenshot** and are not listed by `host.screen.windows`: the broker gives
  `vmapp-hostctl` `excludePids` (the loader's process), which leaves the badge, the input overlay and the pickers out of
  display and region pictures (ScreenCaptureKit `excludingWindows`; best effort on the legacy path) and refuses a
  window capture of one.

Details the table leaves out (the broker is `hostlib/capabilities.js`):
- **Two checks, always:** the manifest must request the capability (`tool:<id>` is covered by `tool:*`, `mcp:<id>` by
  `mcp:*`) **and** the user's grant must exist; a `tool:*` / `mcp:*` grant lists the tools / servers the user picked.
  Grants are read at every call, so revoking one applies at once.
- **`ask`:** the loader's confirm dialog answers yes, no, or "allow for this session" (remembered until the app stops).
  `session`: no further question while this run lasts; when the app stops, the grant goes back to `ask`.
  `always` is treated as `ask` for `input` and for shell tools even if a file says otherwise.
- **Input:** the loader is told when a session starts and ends (badge). A session ends after 10 minutes, when the app
  stops, on panic, on the badge's Stop, or when its grant is removed; buttons held down are released. A new
  `host.input.start` replaces the running session. What is typed is not written to the Inspector, only its length.
- **Tools:** `args` must match the definition (below); `stdin` is at most 1 MiB; output stdout+stderr share
  `maxOutputBytes`; a tool that runs longer than `timeoutMs` is killed with its children (`timedOut: true`).
- **MCP:** the host sends `initialize` and `notifications/initialized` itself on first use. Other methods are refused.
- **Inspector:** every call (allowed or not) produces a `{kind:"host", cap, op, detail, allowed, durationMs}` event;
  never screenshot bytes; arguments are truncated. The generic bridge trace shows no payload for `host.*`.

**Tool definitions** (`tools.json`, written by the user):
```json
{ "id": "screencapture", "name": "Screenshot tool", "path": "/usr/sbin/screencapture",
  "args": [ {"pattern": "^-x$"}, {"pattern": "^-R\\d+,\\d+,\\d+,\\d+$", "optional": true},
            {"pattern": "^/host/(save|pick)-\\d+/[\\w .-]+\\.png$", "mapPath": true} ],
  "timeoutMs": 30000, "maxOutputBytes": 1048576, "kind": "tool" }
```
- **`kind`:** `tool` (constrained), or `shell` (full shell: `path` is a shell, any args, red warning, never
  `always`).
- **`args`:** one spec per argument, in order. Each argument must match its `pattern` (an anchored regular expression,
  applied to the whole argument); a spec may be `optional`; extra arguments are refused unless `"variadic": true`,
  where they repeat the last spec.
- **`mapPath`:** maps a VM path under a share that is currently granted to the app (`/host/f-<name>`,
  `/host/pick-N`, `/host/save-N`) to the real host path. `..`, other shares and symlinks that lead out of the share
  are refused. A tool can only reach files the user already granted. `"read"` / `"write"` instead of `true` also
  require the share to be readable / writable.
- **`shell` tools:** the agent passes the arguments, so the definition allows them, typically
  `"args": [{"pattern": "^-c$"}, {"pattern": "^[\\s\\S]{1,10000}$"}]` for `/bin/sh`.
- **How it runs:** with no shell interpretation (`spawn` of the path with an argv array), a clean environment
  (`PATH`, `HOME`), the user's home as cwd unless set, killed on timeout, output truncated at `maxOutputBytes`.

**MCP servers** (`mcp.json`, written by the user):
- **Format:** `{ "id": "vscode", "name": "VS Code", "command": [...], "env": {...} }`. The loader starts the stdio
  server on the host on first use, relays JSON-RPC, and stops it when the app stops.
- **Isolation:** each app gets its own server process.

**Always visible and stoppable:**
- **The badge:** while `input` is active, or a `shell` tool runs, a loader-owned always-on-top badge shows
  "<App> is controlling your computer — Stop".
- **The panic shortcut:** ⌃⌥⌘. (Control-Option-Command-period) stops every input session and host tool
  immediately.
- **Time limits:** an input session ends after 10 minutes unless renewed through a new `host.input.start`.
- **The virtual-input overlay:** while an input session is active the loader draws, on every display, a coloured ring at
  the virtual pointer (it moves with each `host.input.mouse`), a ripple on a press or click, and a fading caption of what
  was pressed, near the bottom of the screen. **Typed text is masked by default:** the caption says `typing… (12 characters)`
  (`typing… (1 character)` for one), so a password an app types is never readable on the screen. Characters typed within the
  2.2 s the caption stays up are counted together, and a single printable key without ⌘, ⌃ or ⌥ (Shift only changes the
  letter) counts as typed text, so an app cannot get round the mask one key at a time. Key combinations and named keys are
  always shown (`⌘S`, `↩`, `⌃⌥⌘.`, `←`, `F5`). The loader setting **Show typed text in the overlay** (Host Capabilities window,
  off by default, kept in the loader's `loader-prefs.json`, never an app's choice and never a manifest field) shows the text
  instead (`Hello, wor…`: cut at 28 characters, newline and tab as `↩` and `⇥`); it is read at every keystroke, so turning it
  off masks again at once. It is one
  loader-owned window per display: transparent, frameless, **click-through** (`setIgnoreMouseEvents(true)`: it can never
  intercept a real click), not focusable, above full-screen apps on every Space, and excluded from captures (content
  protection, and `excludePids` above). It exists only while an input session is active (gone on stop, expiry, panic and
  when the app stops). The overlay is shown to the user only: typed text never reaches the Inspector, with or without the setting.

**The loader's UI** (all loader-owned, GOVERNANCE INV-B5):
- **Install review:** says **"This app requests control of your computer."** for `input`, `tool:*` and `mcp:*` (INV-H6),
  and lists every requested capability with its purpose. Installing allows nothing.
- **Permission sheet:** a red "Control of your computer" section, shown at first launch, with every capability on
  **Don't allow**; the user may choose `ask` or `session` (never `always`) and, for `tool:*` and `mcp:*`, picks entries
  of their own catalog. A `session` grant goes back to `ask` when the app stops. An update that adds a capability
  stops at the "asks for more" sheet and leaves the new capability off.
- **Host Capabilities window:** the macOS permissions (with *Ask macOS…* only on a click), the user's tools and MCP
  servers (the only editor of the catalog besides the CLI; presets only fill the form), and *Stop everything now*.
- **Confirmation:** for each use on `ask`, a native sheet on the app's window, worded by the loader (the app's name,
  its stated purpose and the exact arguments are quoted): Deny (the default), Allow once, Allow while the app runs. For a
  screenshot it is the picker described above (a loader window, not a native message box).
- **While active:** the badge (above), a red strip in the library with the same Stop, a red chip on the app's card; the
  Inspector shows every use as a `host` row.

**The native helper:** on macOS, screen and input are performed by `vmapp-hostctl`, which the loader spawns. Its
JSON-lines protocol is in `host/hostctl/README.md`. Coordinates are global desktop points, with the origin at the
top left of the main display. Apps never talk to it; only the loader does, after its own permission checks.

**macOS permissions:** screen capture needs *Screen Recording*, and synthetic input needs *Accessibility*, both
granted to the D9010 VmApp Launcher by the user in System Settings. The loader shows when they're missing. Apps can never
trigger those prompts silently.

**Not in this step:** generic AppleScript automation (use a tool definition), Windows and Linux providers (the
catalog format is OS-neutral; providers differ per OS).

---

## 8.3 Network (accepted by the maintainer 2026-10-15, milestone 2; launcher, guest proxy, hostlib, CLI, loader UI and registry page implemented)

An app's core may reach chosen internet hosts. **The VM still has no network device** (INV-D1) and never gets one: the
only way out is a **host-enforced allowlist proxy**. GOVERNANCE INV-N1 to INV-N4 hold the invariants.

```
core (HTTP client) ── 127.0.0.1:3128 ──► vmapp-init (guest proxy) ── vsock 1022 "may I open host:port?" ──► vmapp-vm
                                                       ▲                                                     │ rule check, DNS,
                                                       └─ vsock 1025 (one per connection, raw bytes) ◄───────┘ address check, connect
```

**What a malicious app could do with it, and the answer.**

| Attack | Answer |
|---|---|
| Send the user's files to its own server | Needs a granted host *and* a granted folder: the loader warns when both exist (`riskSummary`, INV-N4). Nothing is granted by default. A granted host can itself be an exfiltration route; the sheet says so. |
| Reach a host that was not granted (also through a redirect or a changed `Host` header) | Every new TCP connection is checked by the host against the current rules. Redirects open new connections. |
| Reach the user's LAN, router or this Mac (`localhost`, `192.168.x.x`, cloud metadata `169.254.169.254`) | No IP literals in rules. The host resolves the name itself and refuses if **any** answer is a non-public address (DNS rebinding included). It connects to the address it checked, not to a second lookup. |
| Wildcard abuse (`*.com`, `*.co.uk`) | A wildcard needs at least two labels after `*.`. There is no public-suffix list, so `*.co.uk` is accepted: the sheet marks every wildcard as covering many servers and the user decides. |
| Ask for everything (`"host": "*"`, `"ports": "*"`) | Allowed as a request, because some apps (a developer's editor, a terminal) genuinely reach arbitrary servers. It is its own entry, off until the user allows it, shown red as "any server on the internet" with the app's purpose, and the risk sentence says "send what it reads to any server on the internet". It still names hosts only: every answer goes through the address check, so the LAN and this Mac stay unreachable. *(Proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C2.)* |
| Exhaust the host (many connections, slow DNS, stuck sockets) | 64 concurrent connections per app, 10 s connect and DNS timeout, 5 min idle timeout, bounded request lines and an event queue that drops its oldest entries. |
| Keep talking after the user revokes | `net-revoke` closes every open connection that no remaining rule allows, at once. Stopping the app closes all. |
| Make the host read its traffic | TLS is end-to-end through a `CONNECT` tunnel: the host copies bytes and sees only host, port, byte counts and timing. |

### Manifest and grants

`permissions.network` (§2.2):
```json
"network": [
  { "host": "registry.npmjs.org", "purpose": "Looks up package versions" },
  { "host": "*.example.com", "ports": [443, 8443], "purpose": "Talks to the Example API" },
  { "host": "*", "ports": "*", "purpose": "Anything you reach from the terminal: git remotes, package managers" }
]
```
- `host`: ASCII only (an international name is written in its `xn--` form), lower case, at most 253 characters, labels of
  `[a-z0-9-]` (1-63 characters, no leading or trailing `-`), at least two labels, the last one starting with a letter
  (so no spelling of an IPv4 address passes). An exact name, `*.suffix` where `suffix` has at least two labels, or `*`
  alone: **any public host name**. Refused: IP literals (every form), `*.com`, `localhost`, and names ending in
  `.localhost`, `.local`, `.internal`, `.localdomain`, `.home.arpa` or `.lan`. *(`*` alone was refused until 2026-10-17;
  DEV-APPS C2.)*
- A wildcard covers the subdomains of `suffix` at any depth, never `suffix` itself. List both to get both. `*` covers every
  name, and nothing else: the request host is a name, never an address, and the address check below applies to it as to any.
- `ports`: default `[443]`, or `"*"`: every port 1-65535. Port 80 means unencrypted HTTP; the loader marks it (also inside `"*"`).

**Grants** are per app and per entry, in `grants/<id>.json`:
```json
"network": { "registry.npmjs.org": { "allow": true }, "*.example.com": { "allow": true, "ports": [443] } }
```
- Keyed by the entry's `host`. No grant means **deny**. `allow: false` records that the user declined.
- `ports` may only be a subset of the requested ports (a wider one is ignored): a list within the list, a list (or `"*"`)
  for an entry that asks for `"*"`. Missing means all requested ports.
- A grant for a host the manifest does not request is ignored. Only entries with `allow: true` reach the VM, as `--net`
  rules. An update never keeps a grant that no longer matches an entry.
- **An update never widens a grant.** An `allow: true` without `ports` means "all the ports the manifest requests *now*", so
  when a version becomes current (install, "Use version X") the store pins such a grant to the ports the previous version
  asked for (those the new version still asks for) before the new version uses it: a new port stays off until the user allows
  it in the sheet. If none of the old ports is still asked for, the grant is dropped.
- Grants come only from the user (INV-D3, INV-N2): the permission sheet, the card's **Network…** and `vmapp grant-net`.

### How a connection flows

1. The core makes an HTTP(S) request. Its environment (below) points the client at the guest proxy.
2. The guest proxy reads the first request: `CONNECT host:port` (HTTPS and anything else tunnelled), or an absolute-form
   `http://host[:port]/…` request (plain HTTP). Anything else gets `400`; `https://` in absolute form gets `400` (use
   `CONNECT`).
3. With no control connection (no grants), it answers `403 network not granted`. Otherwise it sends the host, on port
   1022: `{"op":"net-open","id":N,"host":"api.example.com","port":443}` (one JSON line; `id` unique per VM).
4. `vmapp-vm` checks the request (below). When it allows it, it resolves and connects to the target, opens a **new** vsock
   connection to guest port 1025, writes `N\n`, and only then answers on port 1022 `{"id":N,"ok":true}`.
5. A refusal is `{"id":N,"ok":false,"error":"…","status":403}`; `status` is 403 (not allowed), 502 (resolve or connect
   failed), 503 (too many connections) or 504 (timed out). The proxy returns that status with a one-line `text/plain`
   body `D9010 VmApp network: <error>` and closes.
6. On `ok` the proxy answers a `CONNECT` with `200 Connection Established`, or, for plain HTTP, sends the server the
   request head the way any forward proxy does (the target in origin form `/path?query`, the client's headers
   unchanged except that `Proxy-Connection` and `Proxy-Authorization` are dropped, a `Host` header added if the client
   sent none, and `Connection: close` set unless the request is an upgrade). Then it copies bytes both ways until
   either side closes. Bytes the core sent right behind its head go into the tunnel first.
7. The host closes the connection on EOF from either side, after 5 minutes without data in either direction, when the
   rule that allowed it is revoked, or when the VM stops.

### The host's decision (`vmapp-vm`)

In this order; the first failure refuses and is reported with `allowed:false` and its `reason`:
1. The line is at most 4 KiB; `host` is a valid lower-case ASCII name (a trailing dot is removed; an IP literal is
   refused with a clear message) and `port` is 1 to 65535.
2. **Allowlist.** Some rule has the exact host (or `*.suffix` covers it, or it is `*`; §8.3 Manifest) and lists the port
   (or allows every port).
3. **Caps.** Fewer than 64 connections are open or being opened.
4. **Resolve** on the host (10 s). If **any** address is non-public the request is refused (the app is told "resolves to a
   private or local address", never which one; the Inspector event names it). Non-public means:
   - IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`,
     `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4`.
   - IPv6: `::`, `::1`, `fc00::/7` (unique local), `fe80::/10`, `fec0::/10`, `ff00::/8`, `100::/64`, `2001::/23`,
     `2001:db8::/32`, `64:ff9b:1::/48`; and `::ffff:0:0/96` (IPv4-mapped), `::/96`, `64:ff9b::/96` and `2002::/16` are
     judged by the IPv4 address they carry.
5. **Connect** to one of the checked addresses, 10 s in total (DNS included). The address that was checked is the
   address that is used.

`--dev-allow-loopback` (tests and developer tools only) lets loopback addresses (`127/8`, `::1`) through step 4, and
nothing else. `--dev-resolve NAME=IP` answers a lookup from a table instead of DNS; the result still goes through step 4.
Neither is reachable from the loader, a manifest or the bridge (INV-N3).

### Limits

| Limit | Value |
|---|---|
| Concurrent connections per app | 64 |
| DNS plus connect timeout | 10 s |
| Idle timeout (no bytes in either direction) | 5 min |
| Entries in `permissions.network` | 32; at most 8 ports each |
| Held by the host for a target that is not reading yet | 1 MiB per connection (the guest's bytes are always read, so the virtio socket device is never left waiting; service tunnels hold up to 32 MiB, §8.6) |
| Request line on port 1022 | 4 KiB |
| Request head at the guest proxy | 16 KiB; 30 s to send it |
| Concurrent window connections per app ("The app's windows") | 64, apart from the core's |
| Request head at the window endpoint | 8 KiB; 10 s to send it; 32 clients still sending one |

### Environment for the core

The guest adds these to the core's environment as defaults (§4: an `env` of the manifest or the runtime image wins). The
same variables are set whether or not the app has any grant; without one every request is answered `403`.

| Variable | Value |
|---|---|
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and the lower-case forms | `http://127.0.0.1:3128` |
| `NO_PROXY`, `no_proxy` | `localhost,127.0.0.1` |
| `NODE_USE_ENV_PROXY` | `1` (Node 22.21 and later send `fetch`, `http` and `https` through the proxy) |
| `SSL_CERT_FILE` | `/etc/ssl/certs/ca-certificates.crt`, when the runtime image has it |

Anything that ignores these variables has no network at all. `curl`, Go, Python `requests`, Rust `reqwest`, .NET
`HttpClient` and Node 22.21+ honour them. There is no DNS and no route in the VM: a program must hand the name to the
proxy.

### The app's windows (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C3)

An app that declares the window feature `network` (`ui.features`, §2.2; it needs `permissions.network`) lets its windows
load **data** from the hosts the user allowed it to reach: what a web UI shows from the internet (extension icons, a README's
pictures, an API's JSON, a WebSocket). The windows get no network of their own: their requests go through the **same proxy
and the same grants** as the core's, so one grant covers both, a revoke cuts both, and without a grant everything is refused.

```
window (page, workers, frames) ── https/wss ──► request filter ──► partition proxy ── 127.0.0.1:P, Basic vmapp:<secret> ──► vmapp-vm
                                     │ data only, names only                                                window endpoint │ rule check,
                                     └ everything else cancelled                                                            │ DNS, address
                                                                                                                            ▼ check, connect
```

1. **The endpoint.** When the VM is ready and before the core starts, hostlib makes a fresh secret (32 random bytes, 64 hex
   characters) and sends `{"op":"window-proxy","secret":…}` on the launcher's stdin (§5). `vmapp-vm` listens on `127.0.0.1`
   at a port of the system's choice and answers `{"window-proxy":{"port":P}}`. The secret is never on a command line, in a
   file or in a log; the loader and `vmapp-vm` keep it in memory for the run. If the endpoint cannot start, the windows have
   no network and the app runs anyway.
2. **Who may use it.** The endpoint answers every request without `Proxy-Authorization: Basic base64("vmapp:" + secret)`
   (compared in constant time) with `407` and `Proxy-Authenticate: Basic realm="vmapp"`, and closes; no event, since it is
   not the app. The loader answers Electron's `login` event with these credentials **only** for a proxy authentication of
   `127.0.0.1:P` from that app's own partition (`windowProxyCredentials`); it cancels every other authentication.
3. **What it does.** It reads one request head (8 KiB, 10 s; nothing may follow it before the answer). Only `CONNECT
   host:port` is served; anything else gets `405`. The host's decision is the guest's (above): the name (no IP literal),
   the rules, the address check, connect to the checked address, 10 s. Window connections have their **own** cap of 64, so
   a window cannot use up the core's connections or the reverse. It answers `200 Connection Established` and copies bytes
   both ways (TLS end to end, never read), or the refusal's status (403, 502, 503, 504) with a short `text/plain` body (the
   window is never told which address a name resolved to). Revokes, the idle timeout and the stop close window tunnels as
   they close the guest's.
4. **The partition.** Before the run's first window loads, the loader sets the app partition's proxy to
   `http=127.0.0.1:P;https=127.0.0.1:P` with `<-loopback>` (no implicit bypass: even a loopback request would go to the
   endpoint, which refuses it). The partition's request filter keeps refusing everything but its own schemes, with one
   exception, `windowNetAllowed` (`loader/src/window-net.js`): while the run's endpoint is set, an `https:` or `wss:` request
   of a **data** kind (`fetch`/XHR, WebSocket, image, media, font, style sheet), to a host **name** (no IP address in any
   spelling, no single-label or local name: `localhost`, `.local`, `.internal`, `.localdomain`, `.lan`, `.home.arpa`), without
   credentials in the URL. Never `http:` or `ws:`, never a script, a frame, an object, a worker or a document. When the run
   ends the filter refuses at once, then the proxy setting and the cached proxy credentials are cleared.
5. **The CSP** gets the `network` row of §7's table: `https:` (and `wss:` for connections) on the data directives only.

**What a malicious app could do with it, and the answer.**

| Attack | Answer |
|---|---|
| Send what its window shows to a server | Only to a host the user allowed, exactly as its core could; every connection is an Inspector row. |
| Load code from the network into its page | Refused twice: no feature adds a network source to `script-src`, `worker-src`, `frame-src` or `object-src`, and the request filter cancels `script`, `subFrame`, `mainFrame` and `object` requests whatever the CSP says. |
| Reach the LAN or this Mac from the window | The filter refuses addresses and local names; the endpoint refuses them again and applies the address check to every answer. |
| Let another program on the Mac use the app's grants | The endpoint needs the run's secret; it is on loopback only, new every run, and never leaves the loader's and `vmapp-vm`'s memory. |
| Use the endpoint after the app stopped | It stops with the VM; the loader clears the proxy setting and the credentials. A new run has a new port and a new secret. |


### Traffic events

Every connection produces one event when it closes, or at once when it is refused:
`{"net":{"id","host","port","allowed","bytesUp","bytesDown","durationMs","reason"?,"window"?}}` (§5). `allowed` is the host's
decision; a connection that was allowed but failed (`connect failed`) has `allowed:true`, zero bytes and a `reason`.
`bytesUp` counts bytes from the app, `bytesDown` bytes to the app. `window: true` marks a connection of the app's windows
(above). Hostlib turns it into a `traffic` event for the Inspector: `{ts, dir:'from-core', t:'net', kind:'net', appId, host,
port, allowed, bytesUp, bytesDown, durationMs, reason?, window?, bytes, preview}`. Host names and byte counts are the only
things logged; contents never are.

### hostlib and the CLI

- `hostlib/network.js`: `validateNetwork` (used by `manifest.js`), `matchRule`, `resolveNetwork(manifest, grants)` (the
  rules for `--net` plus notes), `checkNetGrant(manifest, host, {allow, ports})` (what a UI calls before saving a grant:
  only listed hosts, never more ports than requested), `netRequestSummary(manifest, grants)` (what a sheet shows, like
  `hostRequestSummary`), `netDiff` (new hosts and ports, used by `permissionDiff` as `netAdded`), `riskSummary(manifest,
  grants)`. `tests/net/vectors.json` holds the name and matching cases that both this file and `host/src/net.rs` are
  tested with.
- `Store`: `loadNetGrants`, `saveNetGrants`, `setNetGrant`, `pruneNetGrants`. Saving folder grants keeps the network
  grants; a version that no longer lists a host (or a port) drops that grant when it becomes current, and one that asks for
  more ports does not widen it (above).
- `AppSession`: passes the granted rules as `--net`; `netAllow(host, ports)`, `netRevoke(host)` and `syncNetwork()` change a
  running VM; the VM's `net` lines become `traffic` events. `devNet: {allowLoopback, resolve}` is for tests only. For an app
  that declares `network` it starts the window endpoint and keeps `windowProxy` (`{host, port, username, password}`, null when
  the VM is not running), which the window manager reads ("The app's windows").
- CLI: `vmapp grant-net <id> <host> [--ports 443,80] [--deny] [--revoke]`, `vmapp grant-net <id> --list`; `inspect`
  lists the network requests and the exfiltration warning; `run --headless` honours grants and prints the `net` events.

### What the user sees (loader contract, GOVERNANCE INV-B5, INV-N4)

- **Install review** lists every requested host with its purpose and marks wildcards, ports other than 443, and port 80
  ("not encrypted"). Installing allows nothing.
- When an app requests `read`/`readwrite` access to a folder (or `screen`, §8.2) **and** a network host, the review and the
  permission sheet say so in words: "This app could read **<folders>** and send what it reads to **<hosts>**." The
  words come from `riskSummary`, never from the app.
- **Permission sheet:** a Network section, every entry on **Don't allow**, each with its purpose. A wildcard is marked
  and gets an explicit warning ("any address under example.com: it covers many servers"); port 80 is marked "not encrypted".
  Granting less than requested (fewer ports, one checkbox per port) is allowed, but at least one port must stay checked.
  The risk banner is **live**: it says "could" for what the app asks, and a solid red "Right now: this app **can** read the
  folder ... and send what it reads to ..." as soon as the choices on screen allow a readable folder (or the screen) **and**
  a host. The sentence comes from `riskSummary` through the loader, never from the app. An app that asks for network access
  gets the sheet at its first launch even if it asks for no folder.
- **The card** shows what was asked and what the user chose per host, an amber **Can reach the internet** chip while a host
  is allowed, the same red warning when a readable folder and a host are both allowed, and **Network…**, which works while the
  app runs. A change made there is saved and applied to the running app at once (`syncNetwork`): a host taken away is cut
  off, open connections included. While the app is starting or stopping the button is refused. The **monitor** has a
  `Network` pill for the allowed hosts (SPEC 8.4).
- **Updates** that add a host, a wider wildcard or a port always stop at the "asks for more" sheet (§8.1), which lists each
  `netAdded` entry ("More network ports on api.example.com: port 8443", "A new address to reach: *.example.org (port 443)",
  wildcards marked) and the new version's risk sentence. The new access stays off until the user allows it.
- **Inspector:** every connection is a `net` row (host, port, allowed or denied, bytes up and down, duration, reason), with a
  **Network** filter and a detail view; a window's connection reads `window <host>:<port>` and its detail says it came from
  the app's window.
- **Registry:** the app page and the listing show the hosts an app asks to reach (wildcards and port 80 marked) and, since
  INV-H6, control of the computer. The registry never allows anything; the user does, in the loader.

### Not in this step

UDP and anything that is not TCP through `CONNECT` or plain HTTP; plain `http:`/`ws:` from the windows; inbound connections; a user-visible allow-once dialog
for a denied request; per-host bandwidth limits; certificate inspection (the host does not look inside a tunnel, so an app
can send a different TLS server name or `Host` header to a granted server: a granted host that fronts many sites, such as
a CDN edge, can serve them all); DNS-over-anything inside the VM; Windows and Linux launchers (`docs/PLATFORMS.md`).

## 8.4 Devices (the microphone) and the live monitor (accepted by the maintainer 2026-10-15; implemented)

### The microphone

An app's **window** (the UI, on the host) may listen to the user's microphone, with `navigator.mediaDevices.getUserMedia({audio})`.
What it hears reaches the core only if the UI sends it over the bridge (§6, JSON), so the same rules as for any other data apply:
the VM has no network unless §8.3 grants hosts. The core itself never touches a host device. GOVERNANCE INV-B3 holds the
invariant: **the only permission an app window can ever be given is the microphone, and only with the user's grant.**

**Manifest** (§2.2): `"devices": [{ "device": "microphone", "purpose": "Records a voice note" }]`. `camera` is reserved and
rejected; so is every other name. There is no other field: a manifest names the device and why, nothing more.

**Grants** (INV-D3): `grants/<id>.json` has `"devices": { "microphone": { "mode": "allow" } }`. The mode `allow` is the sheet's
**Allow while the app runs**: no further question, on every run, until the user changes it. A missing entry is **Don't allow**,
the default. Grants come only from the user: the permission sheet and `vmapp grant-device <id> microphone [--revoke]`. Saving
folder, host or network grants keeps the device grants; Reset forgets them with the rest of `grants/<id>.json`. A grant does
not outlive the request: when the version that becomes current no longer asks for the microphone, its grant is dropped, so a
later version that asks again starts on **Don't allow**.

**The decision** (`loader/src/devices.js`, read at every request, so a revoked grant applies at once). An app window's
`getUserMedia` is allowed only when **all** of these hold:
1. the permission is `media` and `mediaTypes` is exactly `["audio"]` (video, or audio together with video, is refused as a whole);
2. the request comes from the **main frame** of a window of **this** app, at `vmapp-ui://<id>/`;
3. the installed manifest asks for the microphone, **and** the user's grant allows it (a hand-written grant for an app that did
   not ask is ignored).

The permission *check* (`navigator.permissions.query`, device labels) uses the same decision for `audio`. Everything else stays
denied, except the clipboard below: video, screen sharing, notifications, geolocation, HID/USB/serial, and every permission of the
loader's own windows. Every request, allowed or refused, is a `host` row (`cap` `microphone` or `camera`, op `media.audio` or `media.video`)
in the Inspector. The loader never records audio itself.

**What the user sees** (loader-owned, INV-B5):
- **Install review:** a "Devices" part naming the microphone with the app's purpose. Installing allows nothing.
- **Permission sheet:** a "Devices" section with **Don't allow** (default) and **Allow while the app runs**; it says the app's
  window can hear the microphone, that the loader shows a red label while it listens, and that macOS asks too.
- **Updates** that newly ask for the microphone always stop at the "asks for more" sheet (§8.1); it stays off until allowed.
- **Indicator:** a red chip "Can use the microphone" on the app's card while the grant stands (always accurate: it comes from
  the grant), and "Using the microphone now" plus a pulsing pill in the monitor while a window holds a live audio track. The
  second signal is **best effort**: Chromium gives the embedder no event for capture, so the loader looks at the window from the
  main process (DevTools `Runtime.queryObjects` for live `audio` `MediaStreamTrack`s, only while the window has been granted the
  microphone; the page gets no script, API or binding). A hostile page could hide a track from that view; it cannot hide the
  grant, the Inspector row, or macOS's own microphone indicator.
- **macOS:** the packaged loader has `NSMicrophoneUsageDescription` in Info.plist and the `com.apple.security.device.audio-input`
  entitlement on the app and its Electron helpers (the process that captures audio is a helper). macOS asks for consent the first
  time. The camera has no entitlement and no usage text of its own.

**Threats:** an app that asks for the microphone and is allowed can record the user's voice, and a core with network grants could
send it out (the review and the sheet say what the app asks for; INV-N4 already warns about data plus network). An app that was not
allowed cannot open the microphone by any route in the renderer: the gate is the only code that answers `true` to a permission, and
`tools/check-invariants` reads it. The dev tests use Chromium's fake microphone (`--use-fake-device-for-media-stream`); a packaged
loader refuses that switch and `--use-fake-ui-for-media-stream`, which would make Chromium accept requests without asking the gate.

### The clipboard (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C5)

Keyboard copy and paste (⌘C, ⌘X, ⌘V in an app window) always worked and still need nothing: they go through the loader's Edit
menu, and the page only sees what the user pastes. The device `clipboard` is for everything else: an app's **window** reading or
writing the clipboard from its own code (`navigator.clipboard.readText`/`read`, `writeText`/`write`: a Paste menu item, a terminal
pasting on ⌘V, a Copy button) and its **core** doing the same (`clipboard.readText`/`clipboard.writeText`, §6; the Node SDK's
`clipboard`).
- **Manifest:** `"devices": [{ "device": "clipboard", "purpose": "Paste from the Mac into the editor and its terminal" }]`.
- **Grants:** `"devices": { "clipboard": { "mode": "allow" } }`, from the permission sheet or `vmapp grant-device <id> clipboard`,
  with the microphone's rules (**Don't allow** by default, dropped when a version no longer asks, kept across other grant changes).
- **The decision** (window: `loader/src/devices.js`; core: `hostlib/session.js`; both at every use, so a revoke applies at once): the
  permission is `clipboard-read` or `clipboard-sanitized-write` (Chromium's names), the request comes from the main frame of a
  window of **this** app at `vmapp-ui://<id>/` (window only), the installed manifest asks for `clipboard`, **and** the user allowed
  it. Plain text for the core, at most 1 Mi characters each way.
- **Visible:** every window request is a `host` row in the Inspector (`cap` `clipboard`, op `clipboard.read` or `clipboard.write`);
  every core request is a request row whose payload is **not** shown (the clipboard may hold a password).
- **Threats:** an allowed app can read whatever the user copied, at any time it runs, and with network grants send it out; it can
  replace the clipboard's content. That is why it is a device the user allows per app, named in the sheet ("can read and change
  what you copy"), and never part of keyboard copy and paste, which needs no grant.

### The live monitor

A menu-bar (Tray) icon owned by the loader opens a small popover (a loader page, INV-B5) that lists the **running** apps. Each app
has **pills** for what it can reach right now, taken from the user's grants (never from the manifest alone): **Folders** (count;
the names and access in the hover text; dialog picks of this run count too), **Screen**, **Input**, **Microphone**, **Tools**,
**MCP**, **Network** (a granted host; hover text lists them). An app that can reach none of these says so.

A pill **pulses** while that thing is in use: an event within the last 2 seconds (a `host` row of that capability, a `net` traffic
row, a dialog grant or a delivered file), or continuously (an input session, a shell tool, a live microphone track). Events are
matched by kind only; the monitor never reads or keeps their contents. Reads and writes on a granted folder are not observable by
the host, so the Folders pill pulses on dialog grants and deliveries only.

Per app: **Stop**, **Inspect** (the Bridge Inspector for that app) and **Show app data in Finder** (the loader's own
`data/<id>`). The popover can name only an app the loader lists, and the loader checks again. The library has a compact **Activity**
section at the top with the same rows (Stop only). `--monitor` opens the popover pinned (developers, tests).

**Not in this step:** the camera, a per-use "ask" mode for the microphone, audio capture of the system output, and recording the
microphone in the loader.

## 8.5 The VM's size: the manifest recommends, the user chooses (accepted by the maintainer 2026-10-15; implemented)

How many vCPUs and how much memory an app's VM gets is a decision about the user's computer, so it is the user's (INV-D3).
The manifest's `core.cpus` (1-16) and `core.memoryMiB` (64-32768) are **recommendations**: what the developer found the app
needs to run well. They allow nothing.

**The choice** is stored per app in `grants/<id>.json`:
```json
"resources": { "cpus": 2, "memoryMiB": 768 }
```
- Either key may be missing: it then means its default. The stored values are whole numbers (`cpus` at least 1, `memoryMiB` at
  least 64); the Mac's limits are applied when a VM starts (below), so a grants file copied to a smaller Mac still runs.
- **Defaults**, when the user has not chosen: **one vCPU** and the **recommended memory**. (A bigger default would let any
  manifest take more of the Mac than the user decided; the sheet offers **Use recommended** for the rest.)
- **Caps:** vCPUs at most the Mac's logical cores (`os.cpus().length`) and memory at most **half of its RAM**, at least 64 MiB. A
  choice above either is refused when it is saved (sheet, card, CLI) and lowered, with a note in the app's log, when a VM starts.
  A recommendation above the cap is lowered the same way.
- A value **below the recommendation is allowed**, with a warning ("less memory than the app recommends: it may run slowly or
  fail"; for vCPUs a lighter note).
- The choice **survives updates** (the user's decision outlives a version: a new, bigger recommendation does not change it, and
  the sheet then warns); **Reset** and `uninstall --purge` forget it; uninstalling without `--purge` keeps it, like every grant.
- A VM cannot change size while it runs: the choice is **locked while the app runs** and applies at the next launch.
- A grants file that holds only the size (chosen on the card before the first launch) is **not** a decision about
  permissions: the permission sheet still comes first (`Store.hasDecided`).

**Where it is chosen** (loader UI, INV-B5; the app only recommends):
- the **permission sheet**: a *Resources* section with a vCPU stepper (1 to the Mac's cores), a memory menu (usual steps up to
  the cap, plus the recommendation and the current value), **Use recommended (N vCPUs, M MB)** (lowered to the Mac's limits)
  and the warnings. "MB" in the loader's words is MiB. An untouched row saves nothing (the defaults keep following the
  recommendation);
- the **card**: the same row, saved at once, disabled while the app runs;
- the **CLI**: `vmapp resources <id> [--cpus N] [--memory MiB] [--recommended] [--default]`; `vmapp run --headless` and the loader
  start the VM with the user's choice (`AppSession` passes it as `--cpus` and `--memory`; its log says
  "VM size: 2 vCPUs, 768 MiB (your choice); the app recommends ...").
- `inspect` and the install review say "recommends", never "uses".

**hostlib:** `hostlib/resources.js` (`hostLimits`, `resolveResources`, `checkResources`, `resourceSummary`, `recommendedChoice`);
`Store.loadResources`, `saveResources`, `hasDecided`; `saveGrants` keeps the choice (`resources: null` forgets it).

## 8.6 GPU: llama.cpp RPC remoting (accepted by the maintainer 2026-10-15, docs/VISION.md §4 phase B; implemented)

An app that runs a language model (llama.cpp, Ollama) inside its VM can have the heavy maths run on the Mac's GPU. Linux has no
Metal, so nothing in the VM could call it; what works is **remoting at the API the app already speaks**: llama.cpp's RPC backend
(`ggml-rpc`). The loader starts llama.cpp's own RPC server, built with the Metal backend, **in a macOS sandbox, one per app run**,
and the VM reaches it through the same host-controlled tunnel as §8.3. The VM still has no network device (INV-D1) and no new
channel to the host (INV-H5); the GPU is a *service* the host offers by name.

```
llama.cpp client (in the VM) ── 127.0.0.1:50052 ──► vmapp-init (guest listener) ── vsock 1022 "service-open gpu" ──► vmapp-vm
   $VMAPP_GPU_RPC                                              ▲                                                  │ the name maps to the
                                                               └─ vsock 1025 (one per connection, raw bytes) ◄───┘ endpoint it was started with
                                          vmapp-vm ── TCP ──► 127.0.0.1:PORT ── sandbox-exec ──► rpc-server (Metal) ──► the GPU
```

**The contract** (fixed; apps rely on it):
- When the app has the `gpu` capability **granted**: inside its VM a TCP endpoint is reachable at `127.0.0.1:50052`, the core's
  environment has `VMAPP_GPU_RPC=127.0.0.1:50052`, and the endpoint speaks **llama.cpp's ggml RPC protocol** to a Metal-backed
  `rpc-server` on the host. The server serves one device, the Mac's GPU (`MTL0`).
- **Without the grant**: `VMAPP_GPU_RPC` is not set and connections to `127.0.0.1:50052` are refused (nothing listens).
- **The version.** The RPC protocol is versioned, and the server refuses a client whose major version differs. The platform's server
  is built from the llama.cpp commit pinned in `gpu/pins.env` (tag, commit and `RPC_PROTO_VERSION`; the build record is
  `BUILD-INFO.txt` next to the binary). An app builds its llama.cpp client **from that same commit** (or at least the same
  protocol major version) and checks `RPC_PROTO_VERSION` when it updates llama.cpp.
- It is an **opt-in, per-app capability**: off by default, granted in the permission sheet or with the CLI, visible in the
  Inspector and the monitor, revocable at any moment (below).

### Manifest and grants

`permissions.host` (§8.2) with `{"cap":"gpu","purpose":"…"}`. `gpu` has no id and no wildcard. A grant in `grants/<id>.json` is
`"host": {"gpu": {"mode": "session"}}`:
- `session` is the sheet's **Allow while the app runs**. It is the **only** mode: a stream of requests cannot be asked about
  call by call, so there is no `ask`, and no `always` (a hand-written `ask` or `always` for `gpu` is refused by the store and
  ignored by the decision). Not allowing it is having no grant, which is the default.
- Unlike the `session` grants of §8.2, it does **not** go back to `ask` when the app stops: it is a decision about this app that
  holds on every run until the user changes it, like the microphone's (§8.4).
- A grant does not outlive the request: when the version that becomes current no longer asks for `gpu`, the grant is dropped,
  so a later version that asks again starts on **Don't allow** (an update never grants anything, §8.1). An update that adds
  `gpu` always stops at the "asks for more" sheet (`hostAdded`, with `control:false`).
- Grants come only from the user (INV-D3): the permission sheet and `vmapp grant-host <id> gpu --mode session`.

### What a malicious app could do with it, and the answer

| Attack | Answer |
|---|---|
| Use the GPU without being allowed | The grant is checked when the run starts: no grant, no server, no `--service`, no variable, no listener. A hand-written grant for an app that did not ask is ignored. |
| Reach anything on the Mac's loopback or LAN through the tunnel | The guest names a service, never an address. `vmapp-vm` maps the name to the one endpoint it was started with (`127.0.0.1:PORT` only; `ServiceSpec::parse`), looks nothing up and checks nothing the guest says. A network rule cannot name a service and `net-open` cannot reach one (`service:gpu` is not a host name). |
| Attack the RPC server itself (upstream says it is "proof-of-concept … fragile and insecure": it trusts the shapes and graphs a client sends) | It runs in a macOS sandbox (below) as a process of its own, per app; a compromise gets the sandbox, not the user's files, network or other programs. Other local processes can still connect to its loopback port while it runs (§10). The user is told in the sheet: only allow apps you trust with your GPU. |
| Keep the GPU after the user revokes | The running app is checked once a second: a revoked grant closes every tunnel at once (`service-revoke`), closes the guest's port and stops the server. |
| Exhaust the host | At most 8 tunnels per app, 32 MiB held per tunnel for a server that is not reading yet, 20 s to wait for a server that is still starting. **There is no cap on GPU memory or GPU time**: an allowed app can use as much of the Mac's GPU and unified memory as macOS allows until it is stopped or revoked. That is what allowing it means. |
| Persist a server after the app, or after the loader | The server stops with the app, on revoke, on panic and when the loader quits; a server a crashed loader left behind is stopped at the next start (pid files, checked against the command line). |
| Poison what other Metal programs use | The one writable place in the sandbox is the user's shader cache (`com.apple.metal`), so the compiled shaders are reused (start in a fraction of a second instead of 10 to 15 s). See §10 and `docs/SECURITY.md`. |

### How it works

1. **At launch** (`hostlib/session.js`, `hostlib/gpu.js`): if the manifest asks for `gpu` **and** the grant exists, `GpuBroker.start`
   picks a free port and starts the server through `hostlib/hostproc.js` (the only place that spawns it):
   `/usr/bin/sandbox-exec -f <bundled profile> -D BIN=… -D BINDIR=… -D PORT=… [-D METAL_CACHE=…] <bundled rpc-server> --host 127.0.0.1
   --port PORT --device MTL0`. Both files are the loader's own (`Contents/Resources/vmapp/gpu/` packaged, `out/gpu/` in development);
   no path or argument comes from a manifest or an app. The server starts **before** the VM, so it can compile its shaders while the VM boots.
2. `vmapp-vm` is started with `--service gpu=127.0.0.1:PORT` (§5) and the core's start `env` gets `VMAPP_GPU_RPC=127.0.0.1:50052`.
   The launcher asks the guest to open its listener (`service`, §4) and the network channel.
3. **A connection** from the core to `127.0.0.1:50052` makes the guest send `{"op":"service-open","id":N,"name":"gpu"}` on vsock
   1022. `vmapp-vm` answers `{"id":N,"ok":true}` after it connected to the endpoint and opened a vsock connection to guest port 1025 whose
   first line is `N\n`; a refusal is `{"id":N,"ok":false,"error":"…","status":403|502|503}`. Then bytes are copied both ways. If
   nothing listens on the endpoint yet (the server is still compiling its shaders), the launcher retries for up to 20 s before it
   answers 502.
4. **No idle timeout** (a model stays loaded while the user thinks); a write that makes no progress for 5 minutes ends the tunnel.
   The guest's bytes always go through a queue (up to 32 MiB per tunnel) written to the server by another thread: the virtio
   socket device behind the vsock serves every connection of the VM from one place, and a launcher that stops reading it while it
   waits for a peer that is itself waiting leaves the VM's vsock, the bridge included, stuck (found with an echo server;
   `tests/e2e.sh` scenario 12 moves 64 MiB each way at once).
5. **Stopping.** The server stops when the app stops, when the grant is taken away (looked at once a second, so the CLI and the
   sheet work on a running app), on **panic** (the shortcut and *Stop everything now* stop every server), when the loader quits,
   and the launcher is told `service-revoke` whenever the server ends for any reason (a crash included), so tunnels never outlive it.
   The app keeps running without a GPU.
6. If the server cannot start (not built, not Apple silicon, the sandbox refuses), the app starts **without** a GPU: no variable, no
   service; the log and the Inspector say why.

### The sandbox (`gpu/rpc-server.sb`)

`(deny default)`, then exactly: the system's standard rules for a program (`system.sb`, `system-graphics`); executing the one
binary and reading its folder; **one loopback TCP port** (bind and accept `localhost:PORT`, nothing else, no outbound connection
at all); the GPU's IOKit user clients (the list Apple's own sandboxed GPU services use) and the shader compiler service
`com.apple.MTLCompilerService`; and, only when the loader names the user's cache folder, read-write access to its `com.apple.metal`
folder. No other file is readable or writable, no program can be started, no other service can be looked up. The rule set is
closed: `tools/check-invariants` (rule `h7-gpu-service`) fails on any other rule, so a change to what the server may do is a
maintainer-reviewed change of the rule (GOVERNANCE INV-H7). The binary is signed with the hardened runtime and **no
entitlements** (Metal needs none; checked on the signed binary by `tests/gpu/`).

### Environment for the core

| Variable | Value |
|---|---|
| `VMAPP_GPU_RPC` | `127.0.0.1:50052`, only while the GPU is granted and its server started |

### Service events

`{"service":{...}}` (§5) becomes a `traffic` event for the Inspector: `{ts, dir:'from-core', t:'gpu', kind:'gpu', appId, id,
phase:'connect'|'traffic'|'disconnect', allowed, bytesUp, bytesDown, durationMs, reason?, bytes, preview}`, and the loader adds
`{dir:'host', t:'gpu', kind:'gpu', phase:'server', op:'start'|'stop', port?, pid?, reason?, error?}` rows when the server starts
(or cannot) and stops (`reason`: `app-stopped`, `revoked`, `panic`, `loader-quit`, `crashed`). Byte counts and names only; what
the app sends the GPU is never read.

### What the user sees (loader contract, INV-B5)

- **Install review and permission sheet:** the entry sits under **Control of your computer** with the app's purpose and the
  loader's own words: *"Lets this app run work on your Mac's GPU (Metal) through a sandboxed helper. The helper processes the
  app's requests, so only allow apps you trust with your GPU."* Two choices only: **Don't allow** (default) and **Allow while the app
  runs**. It is not labelled "requests control of your computer" (INV-H6): it is neither input nor a shell.
- **The card:** an amber chip **Can use your GPU** while the grant stands, and a **GPU…** button that works while the app runs
  (like **Network…**): taking the GPU away stops the app's helper and closes its tunnels at once; allowing it for a running app
  starts at the next launch.
- **The monitor:** a **GPU** pill for a running app that was allowed it; it pulses while a tunnel opens, moves bytes or closes.
- **The Inspector:** a **GPU** filter; `gpu` rows for the server and for every tunnel, with bytes up and down.
- **The registry:** the app page and listing say the app asks to run work on the GPU through a sandboxed helper.
- **Updates** that add `gpu` stop at the "asks for more" sheet and leave it off.

### hostlib and the CLI

- `hostlib/gpu.js`: `gpuRequest`, `gpuAllowed(manifest, hostGrants)`, `serviceArg`, `GpuBroker` (`start`, `stop`, `stopAll`,
  `active`, `reapStale`, events `started` / `stopped`); `hostlib/hostproc.js`: `GpuServer`, `metalCacheRoot`.
- `AppSession` takes the broker (`gpu` option), passes `--service` and the variable, turns `service` lines into rows, watches the
  grant, `revokeGpu(reason)`.
- CLI: `vmapp grant-host <id> gpu --mode session` (the default mode for `gpu`), `--revoke`, `--list`; `ask` and `always` are refused;
  `vmapp run --headless` starts the server like the loader does (`out/gpu/`, or `VMAPP_GPU_SERVER` / `VMAPP_GPU_PROFILE`).

### Building the server

`gpu/build.sh` fetches the pinned commit (`git clone --depth 1 --branch <tag>`, then refuses a checkout whose commit is not the
pinned one or whose RPC protocol version is not `RPC_PROTO_VERSION`) into `$VMAPP_WORK/cache/` and builds
`ggml-rpc-server` with `-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_RPC=ON -DGGML_RPC_RDMA=OFF -DBUILD_SHARED_LIBS=OFF` for
arm64 into `out/gpu/` (`rpc-server`, `rpc-server.sb`, `BUILD-INFO.txt`, `LICENSE-llama.cpp.txt`, MIT). It needs cmake and Xcode's
command-line tools, no Docker. `tools/build.sh` calls it (`--no-gpu` skips it); the packaged loader carries the files in
`Contents/Resources/vmapp/gpu/`.

### Not in this step

Vulkan inside the VM (docs/VISION.md §4 phase A; the experimental form of it is §8.7); Ollama's own conversion (an app that already uses llama.cpp's RPC client
needs only the address); choosing a device or limiting GPU memory and time; several GPUs; a server that survives the app (a model
that stays loaded between runs); the user's cache folder as a private one (needs a precompiled Metal library instead of runtime
compilation); Windows (Hyper-V GPU-PV, `docs/PLATFORMS.md`).

## 8.7 Experimental Vulkan backend: the GPU through Vulkan inside the VM (maintainer decision 2026-10-15, option 2 of gpu/venus-spike/REPORT.md §11; implemented, EXPERIMENTAL)

> **Experimental, opt-in, compute-first, not a production driver.** The research spike (`gpu/venus-spike/REPORT.md`) showed that
> Vulkan from a Linux VM reaches the Apple GPU at 92 to 115 % of native speed, and also that the stack is not yet safe to trust
> (below: B2 to B7). So it ships behind three switches, all of which must be on, and the shipping GPU path stays §8.6.

An app can run its core in a VM that has a **virtio-gpu (Venus) device**: a standard Vulkan driver (`libvulkan.so.1` with Mesa's Venus
ICD) inside the VM, whose commands the host executes with MoltenVK on Metal. Unmodified Vulkan programs (vulkaninfo, vkpeak, llama.cpp's
Vulkan backend) run. This needs a different VM implementation than Virtualization.framework, which has no GPU device: libkrun on
Hypervisor.framework, run by a second launcher, `vmapp-vm-krun`, with the same command line and protocol as `vmapp-vm` (§5).

### Switches

An app runs on this backend only when **all three** hold; otherwise it runs on the normal backend, without a GPU, and its log says which one was missing:

1. **The app asks:** `permissions.host` has `{"cap":"gpu","api":"vulkan","purpose":"…"}` (§2.2) and its `runtime` is `node22-gpu` (§3). A plain
   `{"cap":"gpu"}` is the llama.cpp RPC service (§8.6) and never uses this backend. An app lists at most one `gpu` entry.
2. **The user allowed it, per app:** the permission sheet line (labelled **Experimental**), or `vmapp grant-host <id> gpu`. Like §8.6, the
   only mode is `session` ("Allow while the app runs", on every run until revoked). The grant records the API:
   `"host":{"gpu":{"mode":"session","api":"vulkan"}}`. A grant made for the plain `gpu` does not allow `vulkan` and the other way round; an
   update that adds `api`, or changes it, stops at the "asks for more" sheet (§8.1, `permissionDiff` reports `{cap:"gpu", api:"vulkan"}` in
   `hostAdded`) and the old grant is dropped when the version becomes current.
3. **The loader setting is on:** Host Capabilities window, **Experimental GPU (Vulkan)** (`experimentalGpuVulkan` in `loader-prefs.json`,
   off by default; `vmapp run --headless --experimental-gpu` for the CLI). Also required: `out/krun/` and the gpu kernel (`Image-gpu`) are installed.

`hostlib/gpu.js` `chooseBackend` is the one place this is decided, and `hostlib/session.js` the one place that acts on it. A manifest, the
guest and the bridge cannot choose the backend.

### What is supported and what is not

| | On the Vulkan backend |
|---|---|
| Kernel, runtime, `/app`, `/data`, folder grants made at launch (`f-<name>`, all three accesses), write-only delivery | **same as §4/§5** (the static shares are one virtiofs device each; ownership is simplified so the app user can use a share whatever uid the Mac user has) |
| Bridge, windows, dialogs that need no folder (`dialog.message`, `shell.openExternal`), host capabilities (§8.2) | same |
| Network allowlist proxy (§8.3), host services (§8.6) | same (vsock ports 1022 to 1025 are libkrun Unix sockets in a private folder; a tunnel is closed in both directions when its target is done, because libkrun cannot pass a host-side half-close on) |
| **Runtime folder grants** (`dialog.open` directory or file, `dialog.save`; stdin `grant`) | **not supported** (B8): libkrun cannot re-point a virtiofs share while the VM runs. The session answers the core `not supported on the gpu backend` before the user is asked, and the launcher answers a stdin `grant` with `{"error":{"op":"grant","message":"not supported on the gpu backend"}}` |
| Presenting frames in the app window | **not supported**: compute and offscreen rendering only; no swapchain to the host window |
| Memory balloon | free-page reporting only (B9) |
| The GPU | one virtual device, **Vulkan profile `vmapp-gpu-0.1`** (below) |

**Profile `vmapp-gpu-0.1`** (what the spike measured; `results/vkinfo-venus-guest.json`; the profile is bumped with each host-stack change): one
integrated UMA device `Virtio-GPU Venus (<host GPU>)`, device API 1.3 (the host offers 1.4; the guest is capped by the old Venus protocol), instance
1.4.309; all 15 Vulkan 1.3 features, but no geometry shaders, wide lines, float64, logicOp, depth bounds, pipeline statistics, cull distance,
variable multisample rate or sparse; 88 device extensions (the host has 129; among the missing: `KHR_maintenance5` to `9`,
`EXT_host_image_copy`, `EXT_memory_budget`, `KHR_portability_subset`); limits equal to the host's except nine per-stage and per-set limits that
are about half; four queue families with graphics, compute and transfer; presentation advertised but unusable. Known undeclared deviations
(B5): `samplerMipLodBias`, `pointPolygons`, `tessellationIsolines`/`PointMode` and triangle fans behave as the host lacks them. An app that
needs conformance beyond this must not use the backend.

### Known problems of the stack (spike REPORT §6), and what this backend does about them

| | Problem | What the backend does |
|---|---|---|
| **B2** | MoltenVK's Metal argument buffers and Venus lose the device ("Invalid Resource") during llama.cpp generation, and the loss is never reported to the guest | the VMM runs with `MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0` (also faster) and `MVK_CONFIG_LOG_LEVEL=1`, set by the launcher |
| **B3** | timeline semaphores crash or hang the VMM | **not fixed.** A crash is detected (`vmm-crashed`); a hang is the watchdog's (below) |
| **B4** | a failed pipeline creation hangs Venus (the fork lacks upstream's fatal-wait check); some unimplemented virtio-gpu commands `panic!()` in libkrun | upstream's "stop waiting when the context is fatal" commits are back-ported (`gpu/krun/patches/0003`, built and booted, not yet exercised against a failing pipeline); the libkrun panics remain; the watchdog |
| **B5** | `VK_KHR_portability_subset` is not exposed to the guest | **not fixed** (profile above) |
| **B6** | virglrenderer is an old fork (0.10.4 plus eleven macOS commits) | pinned by commit, patched in `gpu/krun/patches/`; rebasing on upstream 1.x is the first condition of REPORT §11 |
| **B7** | no GPU time limit: a 43 s dispatch ran unpre-empted | no limit on a dispatch; the watchdog kills a VM whose GPU worker stops answering for 30 s |
| **B8** | shares are fixed at boot | see the table above |
| **B9** | RAM plus the GPU window must fit the guest address space | `--gpu-window MiB` (256 to 32768, default 8192); the loader passes none |

### The launcher `vmapp-vm-krun`, the VMM and the sandbox

`vmapp-vm-krun` (host/src/krun.rs, host/src/bin/vmapp-vm-krun.rs; built into `out/krun/bin/` by `gpu/krun/build.sh` with the pinned host
libraries in `out/krun/lib/`) is **two processes of one executable**:

- the **launcher** is what the loader starts. It owns everything §5 lists (ready line, bridge socket, shares and delivery, network proxy and
  service tunnels, stdin protocol, parent watch, signals) and never loads libkrun, MoltenVK or Metal;
- the **VMM** is its child (`vmapp-vm-krun __vmm <spec>`; the spec is a file in the launcher's private run folder `$TMPDIR/vmapp-<id>-k/`, mode
  0700). It loads `out/krun/lib/libkrun.1.dylib` with `dlopen`, **enters a deny-by-default macOS sandbox**, and runs the VM; libkrun ends the process
  when the guest powers off. The virtio devices, the Venus decoder, MoltenVK and Metal are all in this one process, so it is the process a hostile guest
  attacks, and it is the one that is sandboxed. It follows the launcher (kqueue `NOTE_EXIT`; it exits when the launcher does, INV-E1), has no core
  dumps and a raised descriptor limit.

The sandbox (`gpu/krun/vmm.sb`, applied with `sandbox_init_with_parameters`; GOVERNANCE INV-H8): `(deny default)`, then the system's standard rules and
`system-graphics`, the folder of the executable and the existence of the home folder (Core Foundation and Metal's device discovery crash without them),
read access to the kernel, the initramfs, the two images and the read-only shares, read and write access to the run folder, the console log and the
read-write shares (appdata, the folders the user granted at launch, the staging folders of write-only shares), **Unix sockets only in the run folder**, the GPU's
IOKit user clients, the shader compiler service, and the user's Metal shader cache. **No network of any kind, no program can be started, no
other file is readable or writable.** Every path in it is a parameter built by the launcher from its own command line. `--dev-no-sandbox` (tests and
development) leaves the profile out; the loader never passes it.

**Entitlement:** `vmapp-vm-krun` is signed with `com.apple.security.hypervisor` (`host/krun.entitlements`) and nothing else (in particular no networking
entitlement; the VM has no network device, INV-D1: libkrun is built without its network code, and the launcher uses a plain vsock device without socket
hijacking). Ad-hoc signing is what the build does; a Developer ID release needs the hardened runtime and the four libraries signed with the same identity.

### The guest

- **Kernel:** the `gpu` flavour (`kernel/build.sh --flavour gpu` -> `out/Image-gpu`, `kernel/flavours/gpu/`): the default config plus `VIRTIO_MMIO` (libkrun's
  devices are MMIO), `DRM`, `DRM_VIRTIO_GPU`, `DRM_VIRTIO_GPU_KMS`, `SYNC_FILE`, and the blob-alignment patch (module parameter `virtio_gpu.blob_alignment`;
  Apple's hypervisor maps 16 KiB pages and the guest has 4 KiB, B1). The launcher passes `virtio_gpu.blob_alignment=16384`. The forbidden list of the
  default kernel is split per flavour: this flavour relaxes exactly the DRM family and nothing else (no modules, namespaces, cgroups, eBPF, USB, sound or
  network device); the default kernel is byte-identical to before.
- **Runtime `node22-gpu`** (§3). Mesa is the unmodified upstream 26.2.5, which needs the kernel above (no userspace workaround).
- **`vmapp-init`** (§4): mounts one virtiofs device per share (`vmapp.fs=`), makes the render node openable by the core (`vmapp.gpu=1`), and runs the GPU
  liveness probe (below). The core finds the GPU through the standard Vulkan loader; no variable is set.
- **Console and exit code:** the console log is written by the VMM to the same file `--console` names; the core's exit status is read from it as on the normal backend.

### The watchdog (`gpu-hang`)

Every second the launcher asks the guest `hello` on the control port and tells the backend what came back. The backend kills the VMM (SIGKILL) and
`stopped` says `"reason":"gpu-hang"` with a `detail` when either holds for `--watchdog` seconds (default 30; 0 = off):

- the control port gave no answer (the VMM or the guest kernel is wedged), or
- the guest's GPU probe has been stuck: `vmapp-init` starts `/usr/lib/vmapp/gpu-probe` from the runtime with the core's restrictions (uid/gid 1000, chroot, no
  privileges); every half second it allocates, maps and frees a block of host-visible GPU memory, a request the host's virtio-gpu worker must answer. A worker
  wedged by a Venus wait (REPORT B3/B4) leaves it stuck while every other process in the guest runs on, and `hello` reports it as `gpu.stalledMs`. Without the
  probe program in the runtime, or when its Vulkan setup fails, the watchdog uses the control port alone.

A VMM that dies by itself is reported as `"reason":"vmm-crashed"` with the signal or status. A graceful stop (stdin `shutdown`, EOF, a signal, the core exiting)
is unchanged. The watchdog does not limit how long an honest dispatch may run; it only fires when the GPU stops *answering*. Treat the limit as: an app that
keeps the host's worker busy for longer than `--watchdog` seconds is stopped.

### What a malicious app could do with it, and the answer

| Attack | Answer |
|---|---|
| Use the Vulkan GPU without being allowed | The backend is chosen only when the manifest asks, the grant exists and records the API, and the loader setting is on; the launcher is started with the backend's own command line. A hand-written grant for the other API is ignored. |
| Attack the host through the virtio-gpu protocol, the Venus decoder, MoltenVK or the Metal driver (an app sends arbitrary commands) | The VMM is a separate process in the sandbox above; a compromise gets the sandbox: no network, no other files, no programs. **The Venus decoder and the macOS sharing path are unaudited and unfuzzed (REPORT §8)**; this is why the backend is experimental and why the user is told so in the sheet. |
| Take the user's GPU or memory | **Not limited**: GPU memory (bounded by `--gpu-window` for what the guest can map) and time are not capped, only the hang watchdog above. An allowed app can slow the Mac. |
| Crash or hang the VMM | Only this app's VM is affected (two VMs ran at once in the spike; a crash killed one). The launcher reports `vmm-crashed` / `gpu-hang`; the loader shows it in the app's log and the Inspector. |
| Reach the network, the LAN or the Mac through the VM | The VM still has no network device (INV-D1); the only way out is §8.3 through the launcher. |
| Escape through a share | The shares are virtiofs from libkrun's passthrough code, in the sandbox: it can read and write only the folders it was given, so a path traversal bug in the passthrough code meets the sandbox. Read-only is enforced by libkrun's read-only flag. |
| Leave a VM running after the loader | The VMM follows the launcher, the launcher follows the loader (INV-E1). |

### What the user sees (loader contract, INV-B5)

- **Settings:** Host Capabilities window, a section **Experimental GPU (Vulkan)** with the switch and the limits in the loader's words.
- **Install review and permission sheet:** the entry reads **"EXPERIMENTAL: Use your Mac's GPU through Vulkan, inside the app's virtual machine"**, with an amber
  *experimental* chip, the loader's note (different and less proven backend, no runtime folder grants, the drivers process what the app sends, only works while the setting is on),
  and the two choices **Don't allow** (default) and **Allow while the app runs**. Like §8.6 it is not "control of your computer".
- **The card:** the amber chip and **GPU…** button of §8.6 (they act on whichever GPU request the app has). **Inspector:** a `gpu` row when the backend starts (`backend:"krun"`)
  and when it stops with a verdict; the app's log says that it runs on the experimental backend, or why it does not.

### Building and testing

`gpu/krun/build.sh` (pins in `gpu/krun/pins.env`, patches in `gpu/krun/patches/`, notes in `gpu/krun/PATCHES.md`; about 10 minutes the first time, reproducible: two clean
builds give byte-identical libraries), `kernel/build.sh --flavour gpu`, `tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img`, `tests/gpu-vulkan/build-core.sh`
(the test core: `vulkaninfo`, `vkpeak`, `llama-bench`, `vk-spin`, `vk-offscreen-tri`). Tests: `tests/gpu-vulkan/run.sh` (real VMs: Venus device, compute, llama.cpp, the watchdog),
`tests/gpu-vulkan/krun-e2e.sh` (the part of `tests/e2e.sh` that applies, against the real launcher), `cargo test` in `host/`, `tests/unit/`.

### Not in this step

Windowed presentation; runtime folder grants; the REPORT §11 conditions 1 to 4 and 6 (rebase on virglrenderer 1.x, a non-blocking control-queue worker with device-loss
propagation, a conformance gate and the portability-subset mask, fuzzing and per-VM GPU/RAM budgets, KosmicKrisp on macOS 26); a Windows or Linux backend.

## 8.8 Ports: the app's servers on this Mac's localhost (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C4)

An app's core may run a server in its VM (a dev server, a documentation preview, a notebook) and open it on this Mac, so that the
user's own browser reaches it at `http://localhost:<port>`. The VM still has no network device: the Mac's side is a loopback
listener of `vmapp-vm`, and each connection is carried over vsock to the VM's own loopback.

```
the user's browser ── 127.0.0.1:H ──► vmapp-vm (listener of the forward) ── vsock 1026, "P\n" ──► vmapp-init ── 127.0.0.1:P ──► the app's server
```

- **Permission.** The device `ports` (`permissions.devices`, §2.2, §8.4): the manifest asks with a purpose; the user allows it per
  app in the permission sheet (default **Don't allow**) or with `vmapp grant-device <id> ports`. Checked at every `port.forward`. When
  the user takes it away, every open forward closes at once (the loader calls `syncPorts`).
- **Ops** (§6): `port.forward {port}` → `{port, hostPort, url}`, `port.close {port}`, `port.list`. The Mac's port is the VM's port when
  that is free on the Mac, else one the system picks. The SDK: `const { ports } = require('vmapp')`, `ports.forward(3000)`.
- **Links.** `shell.openExternal` accepts `http(s)://localhost:<hostPort>/…` and `http(s)://127.0.0.1:<hostPort>/…` while that port is
  forwarded by this app (the user still confirms, as for any link).
- **The launcher** (§5 `port-forward`, `port-close`, `forward` events): listens on `127.0.0.1` only; at most 16 forwards and 64
  forwarded connections per app; no idle timeout (a dev server keeps its live-reload socket open). Network rules and revokes never
  touch a forward; `port-close`, the grant taken away and the VM's stop end it.
- **The guest** (§4 vsock 1026): reads the port, connects to `127.0.0.1:P` inside the VM (that address only, fixed in its code), copies
  bytes. If nothing listens there the connection ends at once.

**What a malicious app could do with it, and the answer.**

| Attack | Answer |
|---|---|
| Expose a server to the user's network | The listener is on `127.0.0.1` only: nothing from the LAN reaches it (GOVERNANCE INV-N1 rule for host listeners). |
| Reach the Mac or the LAN from the VM through a forward | A forward carries connections **into** the VM only; the guest connects to its own loopback, never anywhere else. |
| Serve something to other programs on this Mac | Any local process can connect to a forwarded port while it exists, as to any local dev server: the sheet says so ("other programs on this Mac can connect to them while they are open"). Forwards are shown on the card and in the Inspector, and close with the app. |
| Open many ports or connections | 16 forwards, 64 connections per app. |
| Trick the user with a localhost link | `shell.openExternal` still asks, and accepts only ports this app forwards now. |

**Visible:** every forward's start and stop and every forwarded connection (with bytes) is an Inspector row (`port`); the monitor shows
a **Ports** pill while the device is allowed.

### Not in this step

Forwarding into the app's windows (VS Code's Simple Browser showing a forwarded port inside the app); UDP; a forward that other machines
may reach.

## 8.9 App links and sign-in callbacks (proposed 2026-10-17, [docs/design/DEV-APPS.md](docs/design/DEV-APPS.md) C8)

A link can lead back into an app: a sign-in page in the user's browser that redirects to the app, a link in a mail or a document.

- **`vmapp://<app id>/<path>?<query>`.** The loader is the Mac's handler of the `vmapp:` scheme (packaged: `Info.plist`
  `CFBundleURLTypes` and `app.setAsDefaultProtocolClient`). A link goes to the app named by its host part, only when that app is
  installed and its manifest has `permissions.links` (§2.2); any other link is ignored (logged).
  - *Running:* the core gets `{"t":"open-url","url":…}` (§6), in the SDK Electron's `app.on('open-url', (event, url))`.
  - *Not running:* the loader asks (its own words: “Open this link in “<app>”? … is not running. Start it to open the link.”, Start /
    Cancel). A link never starts an app by itself. Start launches it the usual way (the permission sheet first if needed) and the link
    is delivered once the app runs (within 2 minutes).
  - *Visible, not readable:* the Inspector row shows `vmapp://<id>/<path>` and never the query or fragment (a sign-in code or token).
- **Loopback redirects** (RFC 8252: `http://127.0.0.1:<port>/callback`, what most command-line and desktop sign-ins use) need no
  scheme: the app listens in its VM, forwards that port (§8.8, the device `ports`) and gives the forwarded port in its redirect URI; the
  browser's redirect reaches the app through the forward.

**What a malicious party could do with it, and the answer.**

| Attack | Answer |
|---|---|
| A web page sends crafted links at an app | Only apps that ask for links get them; the app must treat a link like any other untrusted input (as in Electron). The link cannot pick another app: the host part names the one app it reaches. |
| A link starts an app the user did not mean to run | Never without the loader's question; the permission sheet still comes first when it is needed. |
| A sign-in code leaks into logs | The Inspector and the loader's log show the link without its query and fragment. |

### Not in this step

Links with other schemes (`myapp://`); a link that opens a particular window of the app (the app decides from the path).

## 8.10 Launcher updates (format 1, loader)

How the launcher learns that a newer launcher exists, shows what changed, and, if the user says so, installs it. Governed by INV-U1
(and INV-G3: "signed updates the user can turn off"). It is about the launcher itself; app updates are §8.1.

### The feed

One small JSON file at one fixed address, `https://vmapp.dev/updates/mac-arm64/latest.json`. The same file is the feed of Electron's
updater (Squirrel.Mac: `url`, `name`, `notes`, `pub_date`) and carries the extra fields the launcher reads. Whatever else it holds is ignored.

| Field | Meaning |
|---|---|
| `version` | the newest launcher, semver (required) |
| `url` | the update's zip: an `https` address on `github.com` or `vmapp.dev`, ending in `.zip`, no credentials, no port (required) |
| `sha256`, `size` | of that zip (required; shown and checked by the release tooling, not trusted for the install) |
| `name`, `notes` | a title and a few plain sentences (cut to 80 and 1500 characters) |
| `changes` | up to 12 short lines for the update card (240 characters each) |
| `pub_date`, `tag`, `commit` | when it was released, the tag and the full commit it was built from |
| `changelogUrl`, `pageUrl` | pages on `vmapp.dev` the card may offer to open |
| `minimumOS` | the oldest macOS it needs (a launcher that needs more than the Mac has is not offered) |

All text is cleaned like a registry's text (no control or direction-changing characters) and shown as text, never as markup.
Anything that is not valid (a `version` that is not semver, a download address that is not https or not on a known host, a missing
checksum) makes the whole file unusable: nothing is offered.

### When the launcher asks

- A little after it starts (and at most once every 6 hours across launches), then once a day while it runs, **unless the user turned
  "Check for launcher updates" off** (Host Capabilities window; the preference `checkForUpdates`, on by default).
- Whenever the user chooses **Check for Updates…** in the launcher's first menu. That always asks, and always shows an answer.

The request is a plain `GET`: no query (not even the running version), no identifier, no cookie, no custom user agent, no list of
apps. A redirect is not followed. A failed automatic check is only logged; a failed manual one is explained. **The server never says
whether an update is newer: the launcher compares the versions itself** (semver; a pre-release is older than its release; a launcher
newer than the feed, as in a development build, is "ahead" and offered nothing).

### What the user sees and does

A card at the top of the library: *Launcher 0.2.0 is available*, what the user has, when it was released, the size, **What's new**
(the `changes` lines and a link to the full changelog) and the buttons:

| Button | What it does |
|---|---|
| **Update now** | hands the feed to Electron's updater, which downloads the zip and checks the new app (below). The card says it is downloading and that nothing restarts until the user says so. |
| **Restart to update** (after the download) | asks, in the loader's own words, before stopping any running apps, then restarts into the new version |
| **Later** | closes the card; the next check offers it again |
| **Skip this version** | not offered again by the automatic checks (kept in `launcher-update.json`); a newer version is; a manual check still shows it |
| **Download** (instead of Update now) | on a copy that cannot update itself (a development build, or one signed ad hoc): opens the download page after asking |

Nothing is downloaded before **Update now**, and nothing restarts before **Restart to update**.

### What is trusted, and what a lying server could do

| Attack | Answer |
|---|---|
| The server, or the network, serves a feed pointing at a malicious zip | The updater installs a new app only if it is signed by the same developer identity as the running launcher. Any other zip is refused. |
| A feed with hostile text or addresses | Every field is cut down to the table above; addresses must be https on known hosts; text is shown as text. |
| The feed hides a newer version, or offers none | The user stays on the version they have. Nothing is lost; downloads stay available on the website and GitHub. |
| A feed offers an older version (a downgrade) | The launcher compares the versions itself and offers nothing that is not newer. |
| The update request identifies the user | It carries nothing: no query, no identifier, no version, no cookie. The server learns only that some launcher asked. |

### hostlib and the loader

`hostlib/updates.js` (`fetchLauncherFeed`, `cleanLauncherFeed`, `launcherUpdateState`) is the only code that asks. `loader/src/updater.js`
is the state machine (`idle`, `checking`, `available`, `downloading`, `ready`, `upToDate`, `error`) and the only code that names Electron's
updater; `loader/main.js` wires it to the library window through channels (`upd:*`) that refuse every sender but the library window.
`loader/ui/update.js` is the card; it can only press buttons.

### Not in this step

Delta updates (each update is the whole zip); release channels (beta, stable); rollback; updating while an app runs without a restart;
other platforms (the feed is per platform: `mac-arm64` today).

## 9. The Node SDK (`require('vmapp')`, inside the `node22` runtime)

It mirrors the Electron main-process API that real apps use, so porting is mostly
`require('electron')` → `require('vmapp')`:

```js
const { app, BrowserWindow, ipcMain, dialog, shell, folders } = require('vmapp');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 640, title: 'Notes' });
  win.loadFile('index.html');                        // relative to ui.root
});
ipcMain.handle('notes:list', async (event, dir) => …);   // ← window.vmapp.invoke('notes:list', dir)
ipcMain.on('log', (event, msg) => …);                    // ← window.vmapp.send('log', msg)
win.webContents.send('notes:changed', names);            // → window.vmapp.on('notes:changed', …)
app.on('window-all-closed', () => app.quit());           // the default when no listener is registered
```

| Export | Members |
|---|---|
| `app` | `whenReady()`, `isReady()`, `on('ready' \| 'window-all-closed' \| 'before-quit')`, `quit()`, `getName()`, `getVersion()`, `getPath('userData' \| 'temp' \| 'home')` (→ `/data`, `/tmp`, `/data`) |
| `BrowserWindow` | `new BrowserWindow({width,height,minWidth,minHeight,title,resizable,webPreferences:{devTools}})` (`devTools` is a boolean, default `false`, sent as `devTools` in `window.create` (§6, §7); every other `webPreferences` key is ignored, with one warning in the core log per run); `loadFile(entry)` (creates the window on the host; returns a Promise); `webContents.send(channel, …args)`; `setTitle`, `focus`, `close`; `on('closed' \| 'focus' \| 'blur')`; `id`; static `getAllWindows()`, `fromId(id)` |
| `ipcMain` | `handle(channel, fn)`, `handleOnce`, `removeHandler`, `on(channel, fn)`, `off`. `event = {sender: win.webContents, senderWindow: win}` |
| `dialog` | `showOpenDialog([win], {title, properties:['openFile'\|'openDirectory'\|'multiSelections']})` → `{canceled, filePaths}`; `showSaveDialog([win], {title, defaultPath})` → `{canceled, filePath}`; `showMessageBox([win], {type, message, detail, buttons})` → `{response}` |
| `shell` | `openExternal(url)` → Promise<bool> |
| `folders` | `{<name>: path \| null}` from the user's grants (filled before `ready`) |
| `host` | host capabilities (§8.2), each denied unless the manifest asks and the user grants: `host.screen.windows()`, `host.screen.capture({target,windowId,region,display,maxWidth})` (a suggestion: the user picks) → `{png: Buffer, width, height, target:{kind, display?, windowId?, region?, bounds?, by}}`, `host.input.start(reason)` → session `{id, mouse(params), keys(params \| text), stop()}`, `host.tool.list()`, `host.tool.run(id, args, {stdin})` → `{exitCode, stdout, stderr, truncated, ...}`, `host.mcp.list()`, `host.mcp.call(server, method, params)` |

The SDK connects to `$VMAPP_SOCKET`. It is a **server**: it listens there, and the host's bridge connection arrives
through the guest's port 1024. One connection per app run. Errors thrown in `handle` reach the renderer as rejected
promises with the message only (no stack).

**Network needs no SDK call.** `fetch()`, `http` and `https` in the core go through the proxy of §8.3 by themselves
(`NODE_USE_ENV_PROXY=1`), for the hosts the user granted; every other host fails with a `403` from the proxy.

Rust and .NET apps speak §6 directly. The samples in `apps/hasher` and `apps/todo` show minimal implementations
(listen on `$VMAPP_SOCKET`, JSON lines).

---

## 10. Security model (format 1)

| Threat | Mitigation |
|---|---|
| App code reading or changing the user's files | The core runs in a VM. Only granted folders exist, and their access is enforced by the host (Virtualization.framework). |
| App code using the network | The VM has no network device. The core's only way out is the allowlist proxy of §8.3: nothing is reachable until the user grants a host, the host checks every connection, refuses non-public addresses and can cut a connection at once. The renderer has `connect-src 'none'`. |
| App code sending the user's data out | The loader warns when an app can read folders or the screen **and** reach hosts (`riskSummary`). TLS is end-to-end, so the host can show where data goes (host, port, bytes) but not what. |
| App UI escaping into the host | Sandboxed Chromium renderer, no Node, a strict CSP, no navigation or popups, no device permissions except the microphone when the app asks for it and the user allowed it (§8.4). The only API is `window.vmapp`. |
| App using the Mac's GPU through Vulkan (experimental, §8.7) | Off unless the manifest asks for `{cap:"gpu", api:"vulkan"}`, the user allows exactly that per app **and** the loader setting "Experimental GPU (Vulkan)" is on. The app's VM then runs on libkrun, whose virtio-gpu device, Venus decoder, MoltenVK and Metal all live in one VMM process that sits in a deny-by-default sandbox (no network, no programs, only the VM's own files); a watchdog kills a VM whose GPU stops answering. The decoder is not audited or fuzzed: that is why it is experimental. |
| App using the Mac's GPU | Off unless the manifest asks **and** the user allows it per app (loader sheet; default Don't allow). The work runs in llama.cpp's RPC server, which upstream does not harden against hostile clients, so it runs in a deny-by-default macOS sandbox (one loopback port, the GPU, nothing writable but the shader cache), one per app run, stopped with the app, on revoke, on panic and at quit. The guest can name the service and nothing else (§8.6, INV-H7). Not limited: how much GPU memory and time an allowed app uses. |
| App listening to the user | The microphone is off unless the manifest asks and the user allows it, per app, in loader UI. Only audio, only the app's own main page; video and screen sharing stay refused. Every request is logged; the card, the activity monitor and macOS show when it listens (§8.4). |
| A fake system prompt drawn by the app | Real decisions are native dialogs or loader UI, never app UI. |
| A tampered package | SHA-256 of every file, checked at install and when UI files are served. Publisher signatures arrive in milestone 2. |
| App survives the loader | `vmapp-vm` follows its parent. A VM can't outlive the loader. |

**Not in format 1:**
- network beyond the allowlist proxy of §8.3 (no UDP, no inbound);
- the GPU beyond llama.cpp RPC remoting (§8.6) and the experimental, opt-in Vulkan backend (§8.7: sandboxed VMM, no runtime folder grants, no
  conformance guarantee): no Metal API in the VM, no limits on GPU memory or time;
- the camera (the microphone is §8.4);
- clipboard beyond the renderer's own;
- notifications;
- publisher signatures;
- per-app CPU and memory accounting beyond the size the user chose (§8.5);
- x86_64 hosts or guests;
- Windows and Linux hosts.
