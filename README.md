# D9010 VmApp: run desktop apps you don't have to trust

**Install a developer tool and you hand it your whole Mac: your files, your SSH keys, your network. D9010 VmApp takes that back.**

- **The engine** (the app's backend, in Node.js, .NET, Rust or anything else) runs inside its own small Linux VM. One VM per app, about 0.4 s to start.
- **The window** (the app's UI) renders natively on your desktop, in a sandboxed Chromium with no network and no file access.
- **You decide**, in the **D9010 VmApp Launcher**, which folders each app may read or write and which internet hosts it may reach. Nothing by default.

For developers it's Electron's model with the main process moved into a VM. Apps ship only their own code (often a
few KB), because the operating system and language runtimes are shared.

```
 your desktop                                   one VM per app (~0.4 s to start)
 ┌──────────────────────┐   bridge (JSON)   ┌────────────────────────────────┐
 │ app window (sandbox) │◄─────────────────►│ app engine: any language       │
 │ no Node, no network  │  via the launcher │ only the folders you granted   │
 └──────────────────────┘                   └────────────────────────────────┘
```

## See it in a minute

```sh
tools/pack-examples          # packs the sample apps into out/examples/ (builds what is missing; needs Docker for the big ones)
cd loader && npm start       # the launcher: File → Load examples… → Install selected
```

Launch **Code - OSS** (VS Code, built from its MIT source) and share it one folder. Then open its terminal:

```sh
uname -a                     # Linux: this is the VM, not your Mac
ls /host                     # only the folder you granted exists here
curl -I https://example.com  # reaches the internet only because you allowed it
npm run dev                  # a server in the VM; Ports → Open in Browser, on your Mac's localhost
```

The terminal can run any program, install any package and load any extension, and none of it can see the rest of your
Mac. Open **Inspect** to watch every message between the window and the engine, and every network connection, live.

## Why not just run everything in an Ubuntu VM?

An Ubuntu VM is a *place*. D9010 VmApp is a *contract*: a small, fixed set of rules that the platform, not the app,
enforces. Two reasons one big VM is not the answer:

- **You manage it forever.** A whole OS to patch, a guest graphics and clipboard setup, network rules, memory and shared
  folders: all by hand, for as long as you use it. D9010 VmApp shares read-only runtimes that are updated once, and the
  platform sets the rules.
- **Many apps in one VM is a second host.** The VM still shields your Mac from what is inside it, but the apps inside
  don't protect each other: one compromised dependency reaches everything in that VM. The protection comes from **one
  tiny VM per app**, not from "a VM" as such.

| | One Ubuntu VM, apps installed inside | A container (Docker) | A plain desktop app (Electron) | **D9010 VmApp** |
|---|---|---|---|---|
| **Isolation unit** | one VM for everything you put in it: one bad dependency sees it all | containers share one kernel (an escape reaches every container) | none: runs with your user's rights | **one VM per app**: an escape reaches only that app's VM |
| **What a compromised tool can reach** | everything in the VM, plus whatever you shared into it | the shared folders, often `/Users` for bind mounts | your files, keychain prompts, network, child processes | **only the folders you granted** |
| **Who writes the rules** | you, by hand, per VM | the vendor (`docker run -v …` is one line away) | the vendor's main process | **you, in the launcher**, for every app the same way |
| **Network** | typically open | typically open | open | **none** until you allow named hosts, through a host-enforced allowlist proxy; your own network is never reachable |
| **The app's UI** | a remote desktop or forwarded display: weaker clipboard, input methods and scaling | n/a | native | **native** Chromium on your desktop |
| **Footprint** | a whole OS, long-lived, to patch and look after | images with an OS userland | the app | KBs per app; shared read-only runtimes; each VM about 30 to 140 MB and 0.4 s to start |
| **After you quit** | the VM keeps its state, and whatever got into it | containers can outlive the app | the app is gone | each launch starts clean; the VM can't outlive the launcher |

An Ubuntu VM is still the right tool when you want a full Linux desktop or need to run Linux GUI programs unmodified.
D9010 VmApp is for the other case: you want to run *an app*, possibly someone else's, with a clear answer to "what can
it touch?". [WHY.md](WHY.md) compares it with Electron and Electron-plus-container backends in detail, including where those are
better.

## How the window talks to the engine

1. The window runs in the launcher's Chromium. It has **no Node, no network and no file access**, a strict content-security
   policy, and one API: `window.vmapp`. Its files are served from a private scheme (`vmapp-ui://`) and each file is
   checked against its SHA-256 before it is served. Because it renders on the host, graphics, fonts, scaling, the GPU and
   every input path (keyboard, mouse, trackpad, touch, pen, input methods, screen readers) come from your Mac, with nothing to
   emulate in the VM: the [Particles](apps/gpu-demo/README.md) sample draws up
   to two million particles with WebGPU at the Mac's full GPU speed.
2. A call from the window (`window.vmapp.invoke('notes:list')`) goes to the launcher, which finds the app it belongs to
   and forwards it as a JSON line over a Unix socket. The socket is bridged into the VM over `vsock`.
3. The engine answers over the same path. It can also push events to its window, or ask the launcher for things a VM
   can't do itself: open a native dialog, create a window, share a folder.
4. **Every request is checked by the launcher**, not by the app, and real decisions (a folder, a file, a permission)
   happen in native dialogs the app can't draw or fake.

A round trip costs about 0.05 ms. Apps that already speak HTTP or WebSocket, like VS Code Server, ride the same bridge. The
**Inspector** shows all of it, with anything that looks like a secret hidden. The window half is a web standard, so the
launcher is tested by driving it over the Chrome DevTools Protocol, and a Windows or Linux port needs a new VM launcher, not a
new UI ([docs/PLATFORMS.md](docs/PLATFORMS.md)). macOS on Apple silicon is the only host built today. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Built for tools that run code

Editors, terminals, AI agents and build tools are the hardest apps to trust: they exist to run arbitrary executables
and read your files. A shell, a `postinstall` script, a git hook, an extension or an AI CLI is code you didn't write,
running with your rights. Inside D9010 VmApp the same things happen in a VM whose operating system is read-only, whose
only shared files are the folders you granted, and whose only way out is the allowlist you set.

| Sample app | What it shows |
|---|---|
| **VS Code (Code - OSS)** | the full editor, terminal, search, git and extensions in the VM; ports forwarded to your Mac's localhost |
| **Terminal + Gemini CLI** | an AI CLI that can work on one folder and nothing else |
| **Ollama, Ollama Desktop, Local LLM** | language models in the VM, optionally on the Mac's GPU |
| **Computer use** | an agent with screen, mouse, keyboard and tools, each one a permission you give |
| **Notes, Hasher, Todo, Particles** | the same model in Node.js, Rust, .NET and WebGPU |

## What it promises, and what it doesn't

**Promises** (format 1; the full model is [docs/SECURITY.md](docs/SECURITY.md)):
- The app's code can only touch **files you gave it**, enforced by the hypervisor from outside the VM.
- It has **no network** unless you allow named hosts. The VM has no network device, and the host refuses any destination on
  your own network. A new version that asks for more stops and asks again.
- **No vendor code runs on your Mac with your rights.** The only host-side code is the launcher, the same for every app.
- A VM **can't outlive the launcher**: kill it, and the VM is gone in about 0.2 s.
- **What you install is what you reviewed**: every file is hashed, checked at install and again when served.
- **Each launch starts clean**: the system and the app's code are read-only, temporary files live in memory.

**It does not protect you from:**
- **What you grant.** An app with read-write access to a folder can change that folder. Prefer `read`, write-only and dialog picks.
- **A folder plus a host.** An app that can read a folder and reach a host can send what it reads there. The launcher says
  so in plain words before you grant the pair.
- **Hypervisor, kernel or Chromium escapes.** Rare, but not impossible. The window is web content, like a browser tab.
- **Vendors' secrets.** It protects users, not a vendor's code: `core.cpio` is readable in the package.

## By the numbers

Measured on an Apple M4 Max (macOS 15.7), October 2026. Every figure comes from a test or benchmark in this repository,
and the **Verify** column gives the command that reproduces it on your Mac.

| | Result | Verify |
|---|---|---|
| **VM start** (boot to the app's core answering) | VM ready in **~0.35 s**; a Node app's core answers after **~0.45 s**; the VM takes **~30 MB** of the Mac's memory (minimal) to **~140 MB** (a Node app) | `tools/bench boot` |
| **Kernel + init** | Linux 6.18.56, **7.6 MB** kernel, ~530 KB init; built reproducibly from pinned, signature-checked source | `tools/bench boot` (the `sizes` line) |
| **App size** | a Node app is **tens of KB** (the OS and runtime are shared, not shipped); Notes sample: 27 KB | `tools/vmapp pack apps/notes -o /tmp/notes.vmapp` |
| **UI ↔ VM bridge** | **~0.05 ms** median round trip (0.05 to 0.07 between runs) · **~390,000 calls/s** · **~105 MiB/s** bulk · ~565,000 events/s | `tools/bench bridge` |
| **GPU compute inside the VM** (experimental Vulkan pass-through) | **15.75 to 15.78 TFLOPS fp32, same as native** (within 0.3%): no measurable loss | `tools/bench vulkan` (needs the Venus spike build) |
| **Local LLM in the VM, Vulkan** (llama.cpp, Llama 3.1 8B Q4) | **73.3 tokens/s** generation, **85%** of native Metal (86.4); prompt 685 tok/s, 76% of Metal (four runs) | `tools/bench vulkan` |
| **Ollama in the VM, Vulkan GPU** (experimental backend, Qwen2.5 7B Q4, 8 vCPUs) | generation **46 → 73 tok/s**, prompt **142 → 644 tok/s** vs the VM's CPUs; Llama 3.2 1B 170 → 239 and 1,154 → 3,402; Qwen2.5 0.5B generation is faster on the CPU (310 vs 254). Answers checked ("Paris") | `apps/ollama/build.sh --with-vulkan` then `bash tests/apps/ollama-gpu.sh` (`OLLAMA_MODEL=qwen2.5:7b`) |
| **Local LLM in the VM, GPU over RPC** (shipping path, Qwen2.5 7B Q4, 4 vCPUs) | generation **30 → 76 tok/s**, prompt **53 → 860 tok/s** vs CPU only; a 7B model runs in a 4 GB VM because its weights live on the host GPU | `tools/bench llm` |
| **Isolation proven by tests** | an app sees only granted folders; no network unless you allow named hosts; a VM can't outlive the loader (`kill -9` → VM gone in ~0.2 s) | `tests/e2e.sh`; `tools/bench boot` (the `kill -9` row) |
| **Test suites** | 300+ unit, 270+ invariant, 260+ real-VM end-to-end checks, plus loader UI runs A–L, all green | `node --test tests/unit/ tests/invariants/`; `tests/e2e.sh` |

**Reproduce: `tools/bench all`** (see [docs/BENCHMARKS.md](docs/BENCHMARKS.md): what each row measures, the exact method, the
prerequisites, our results and how to compare with the same thing running natively). The two Vulkan rows are the
experimental spike's numbers; the spike's own report is [`gpu/venus-spike/REPORT.md`](gpu/venus-spike/REPORT.md), and
`tools/bench vulkan` also runs D9010 VmApp's own Vulkan backend (`tests/gpu-vulkan/run.sh --bench`, BENCHMARKS section 8): 73.0 tok/s
generation and 15.73 TFLOPS, the same as the spike's. Other benchmark pages:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) §5 (bridge), [`apps/local-llm/README.md`](apps/local-llm/README.md) (more models).
Experimental features are labelled; see Status.

## Start here: pick your role

| I want to… | Read |
|---|---|
| **learn it step by step**: understand → run → build → test → package → share → publish | [docs/START-HERE.md](docs/START-HERE.md) |
| **try it right now**: play, build a first app, give a demo | [docs/TRY-IT.md](docs/TRY-IT.md) |
| **set up your machine**: every tool, its tested version, what is inside the build containers | [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md), `bash tools/doctor <part>` |
| **try every example**: one folder of ready-to-install apps (notes, Rust, .NET, WebGPU graphics, terminal + Gemini CLI, computer use, local LLMs, Ollama and Ollama's own desktop app, VS Code) | `tools/pack-examples` → `out/examples/` (its `README.md` says what to allow for each and links each app's source, here and upstream); in the launcher, **Load examples** (empty library, or *File → Load examples…*) installs the ones you choose; `tools/package-mac.sh --with-examples` bundles them into the app |
| **run apps** safely (including **browse and search a registry** from the launcher: *File → Browse registry…*) | [docs/USING.md](docs/USING.md) |
| **build an app** | [docs/BUILDING-APPS.md](docs/BUILDING-APPS.md), then `tools/vmapp new my-app` ([templates/starter](templates/starter/TEMPLATE.md)) |
| **build a computer-use agent / automation** (screen, mouse and keyboard, host tools, MCP) | [docs/HOST-CAPABILITIES.md](docs/HOST-CAPABILITIES.md), sample [apps/computer-use](apps/computer-use/README.md) |
| **run an AI CLI** (Gemini CLI, Codex, Claude Code…) without giving it your Mac | sample [apps/terminal](apps/terminal/README.md), [docs/CONVERTING.md §8](docs/CONVERTING.md) |
| **run VS Code** with a terminal that can't touch the rest of your Mac | sample [apps/vscode](apps/vscode/README.md) |
| **run a language model on your own Mac** (llama.cpp inside the VM, optionally on the Mac's GPU) | sample [apps/local-llm](apps/local-llm/README.md) |
| **run Ollama's own desktop app** (its real window and backend, built from source, models pulled through the allowlist proxy) | flagship conversion [apps/ollama-desktop](apps/ollama-desktop/README.md), [CONVERSION.md](apps/ollama-desktop/CONVERSION.md), [patches](apps/ollama-desktop/patches/PATCHES.md) |
| **convert an existing app** (Electron, a web app with a backend, …) | [docs/CONVERTING.md](docs/CONVERTING.md) and [examples/](examples/) |
| **publish** an app (launcher, website, CLI, or HTTP API for agents) | [docs/PUBLISHING.md](docs/PUBLISHING.md) |
| **distribution, trust and verified publishers** | [docs/DISTRIBUTING.md](docs/DISTRIBUTING.md), [registry/](registry/) |
| **understand how it works** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **know the exact rules** of the format and protocol | [SPEC.md](SPEC.md) |
| **go deep on the bridge** (SDKs, optimisation) | [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| **reproduce the performance numbers** on your Mac | [docs/BENCHMARKS.md](docs/BENCHMARKS.md), `tools/bench all` |
| **review security** | [docs/SECURITY.md](docs/SECURITY.md), [WHY.md](WHY.md) |
| **contribute to the platform** | [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md) |
| **review a contribution** (person or AI) | [docs/REVIEWING.md](docs/REVIEWING.md) |
| **build releases and ship the launcher** | [docs/PRODUCTION.md](docs/PRODUCTION.md) |
| **port to Windows or Linux** | [docs/PLATFORMS.md](docs/PLATFORMS.md) |
| **see where it's going** | [docs/VISION.md](docs/VISION.md) |
| **get quick answers** | [docs/FAQ.md](docs/FAQ.md) |
| (an AI agent) find the right document | [AGENTS.md](AGENTS.md) |

## Contributing: set up only the part you work on

You do not need the whole toolchain. Pick the part you will change: each needs different tools, and most of the project needs only
Node.js. Check your machine for a part, and get the exact command for anything that is missing (it only looks: it installs nothing and leaves nothing behind):

```sh
bash tools/doctor launcher       # or: kernel, vm, apps, gpu, all
```

| Part | You change | You need | Free disk | Proof that it works |
|---|---|---|---|---|
| **`launcher`** | the D9010 VmApp Launcher (`loader/`), the host library (`hostlib/`), the SDK, the CLI, the registry, the docs | Node.js 22 | about 1 GB | `node --test tests/unit/ tests/invariants/ tests/registry/`: no VM, Docker or Rust |
| **`kernel`** | the guest Linux kernel (`kernel/`) | Docker, to build it | about 5 GB | `kernel/build.sh` (1 to 4 minutes); to boot it, also the `vm` part: `VMAPP_KERNEL=out/Image tests/e2e.sh` |
| **`vm`** | the VM launcher (`host/`), the VM init (`guest/`), the runtimes, the real-VM tests | a Mac with Apple silicon, Xcode tools, Rust with the musl target, Node.js 22, Docker | about 6 GB | `tools/build.sh && tests/e2e.sh` |
| **`apps`** | apps, the SDK, the starter template, the examples | Node.js 22; Rust for the Rust sample; Docker for the .NET, Ollama, local LLM and VS Code samples | 10 GB (VS Code: 25 GB) | `tools/vmapp new my-app` |
| **`gpu`** | the experimental GPU support (`gpu/`) | cmake, git, Xcode tools; Docker for the Vulkan backend | about 6 GB | `gpu/build.sh --check` |

The toolchain is small. A clean build from nothing used 808 MB in `out/`; the Rust toolchain is about
0.6 GB; Docker holds the base images it pulls. Nothing here needs the Chromium sources or anything else from the wider workspace. Every tool, the version we tested and what is
inside each build container (every base image is pinned by digest) is in [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md).

Setting up a fresh Mac for each part:

```sh
# launcher, apps: Node.js only
brew install node@22 && echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
# kernel: Docker only
brew install --cask docker && open -a Docker
# vm: adds the Xcode tools and Rust (with the kernel's Docker and the Node.js above)
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.90.0 && . "$HOME/.cargo/env" && rustup target add aarch64-unknown-linux-musl
```

Short of room for Docker's data on your Mac's disk? [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) explains how to run the Docker engine on another disk with Lima, what it is,
how to use it day to day and what to size it at.

Parts depend on each other only where you run things: the launcher and the examples need the VM pieces built to start a VM, and the
kernel needs them to boot. Nothing is downloaded prebuilt yet, but the build accepts a kernel someone else built
(`tools/build.sh --kernel-from /path/to/Image`).

## What's in this repository

| Folder | What |
|---|---|
| `loader/` | the D9010 VmApp Launcher (Electron): library, permission sheet, app windows, Bridge Inspector |
| `hostlib/` | host library: packages, installs, grants, app sessions, the bridge |
| `host/` | `vmapp-vm`: the per-app VM launcher (Rust + Apple Virtualization.framework) |
| `guest/` | `vmapp-init`: the VM's init (Rust, static) |
| `kernel/` | the guest Linux kernel: a pinned, verified, reproducible build in Docker (config, checks, GPL source offer) |
| `runtimes/` | the shared runtime images: `native`, `node22`, `dotnet8` |
| `sdk/node/` | the Electron-like SDK for Node cores |
| `tools/` | `vmapp` CLI, `build.sh`, `mkruntime`, `mkcpio`, `check-invariants`, `package-mac.sh`, `bench` |
| `bench/` | the benchmarks behind "By the numbers" (run them with `tools/bench`; [docs/BENCHMARKS.md](docs/BENCHMARKS.md)) |
| `registry/` | a simple public app registry (publish, browse, download) |
| `apps/` | samples: Notes (Node), Hasher (Rust), Todo (.NET), and the large conversions: VS Code (Code - OSS), and Ollama (Desktop) (Ollama's own Go + React desktop app, built from its source) |
| `templates/starter/` | the commented starter app (`vmapp new`) |
| `examples/` | conversions of an Electron app and an Express web app |
| `tests/` | unit, real-VM end-to-end, apps, template, conversion, registry, invariant tests |

## Status (format 1, October 2026)

macOS on Apple silicon works end to end, tested in real VMs at every layer. Network access for apps (named hosts the
user allows, through a host-enforced proxy; the VM still has no network device) works in the launcher, the guest, hostlib,
the CLI (`vmapp grant-net`, `docs/BUILDING-APPS.md` §7, SPEC §8.3) and the launcher (the permission sheet, the card's
**Network…** that applies to a running app at once, the Inspector's `net` rows). The size of an app's VM is the user's choice
(the manifest only recommends it, SPEC §8.5). Not in format 1 yet:
- the camera (the microphone works, with the user's permission: [docs/USING.md](docs/USING.md));
- publisher signatures;
- Windows and Linux hosts.

See [docs/FAQ.md](docs/FAQ.md) and [docs/VISION.md](docs/VISION.md).

## Building from a clone

Everything needed to build and test is in this repository, apart from the tools you install yourself; no sibling
folder is needed. See
[CONTRIBUTING.md](CONTRIBUTING.md) §1–2 for the prerequisites (macOS on Apple silicon, Xcode command-line tools, Rust
with the `aarch64-unknown-linux-musl` target, Node.js 22, Docker, git, and cmake for the optional GPU server). In short:

```sh
tools/build.sh                         # launcher, guest init, initramfs, the guest kernel (built from pinned source in Docker) and the GPU server (needs cmake and git; --no-gpu skips it)
tools/mkruntime runtimes/native out/runtimes/native.img      # also node22, dotnet8
tools/vmapp runtime-install node22 out/runtimes/node22.img   # only to run apps from the command line: the launcher installs the runtimes itself
node --test tests/unit/ && tests/e2e.sh
```

The first build needs the network: it downloads the Linux source (checksum and signature checked), the pinned llama.cpp source for
the GPU server and the Docker base images. The first `npm start` in `loader/` downloads the Electron binary.

Build outputs go to `out/`; scratch files and caches (cargo target, the kernel source download, test data) go to
`out/work/`, or to `$VMAPP_WORK` if you set it. Both are git-ignored.

Some pieces are adapted from earlier projects of the same author (`agent-vm`, `d9010-native`); each such file says so
in its header. The guest kernel is Linux, built from unmodified upstream source with our configuration (the experimental GPU flavour adds one
patch, `kernel/flavours/gpu/patches/`): see [kernel/SOURCE-OFFER.md](kernel/SOURCE-OFFER.md).

## Licence

The D9010 VmApp code in this repository is released under the **[MIT licence](LICENSE)**, Copyright (c) 2026 D9010 Inc.

Software this project builds or ships keeps its own licence: the Linux kernel is GPL-2.0-only ([kernel/SOURCE-OFFER.md](kernel/SOURCE-OFFER.md)), and the runtime
images carry Node.js (MIT), .NET (MIT) and Debian packages' licences ([docs/PRODUCTION.md](docs/PRODUCTION.md) §3). A few files in the repository have a different
licence of their own (the patch to the Linux kernel, a handful of GPU spike tools). All of it is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Disclaimer

D9010 VmApp is provided "as is", without warranty of any kind, express or implied, including but not limited to the
warranties of merchantability, fitness for a particular purpose and non-infringement. In no event shall D9010 Inc. or
the contributors be liable for any claim, damages or other liability, whether in an action of contract, tort or
otherwise, arising from, out of or in connection with the software or its use.

© D9010 Inc. · [https://d9010.com](https://d9010.com)
