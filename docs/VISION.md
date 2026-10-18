# Where D9010 VmApp can go: directions worth building toward

**For:** future contributors, companies evaluating D9010 VmApp, and anyone asking "what is this good for, beyond running
untrusted apps?" These are directions, not promises. Each one says what's already true, what's still needed, and
the limits.

---

## 1. In some ways, a safer place than the browser for serious apps

Browsers are the most battle-tested sandboxes we have. D9010 VmApp doesn't replace that: its UI layer *is* Chromium. But
for an installed app, D9010 VmApp changes several things the browser can't:

| | A web app in a browser | A D9010 VmApp app |
|---|---|---|
| Where the logic runs | in the page's JavaScript, visible and modifiable by anything that can run script in the page: extensions, injected scripts, XSS, compromised npm packages in the bundle | in the **core, inside a VM**. Page script can only *ask* it through channels the developer chose. |
| Who else shares the environment | one browser profile: cookies, history, cache, storage and extensions shared across every site you visit | **nothing shared**: every app has its own storage partition, its own VM and its own data folder. No extensions run in app windows. |
| What the UI can reach | network, cookies of its origin, browser storage, sometimes devices | **only `window.vmapp`**: no network, no cookies to steal, no devices |
| Where secrets live | in the page (tokens in memory, localStorage) or on a server | **in the core**. The UI never needs to hold them. |
| What a script injection can do | act as the user: read the DOM, call APIs with the user's session, exfiltrate | call the app's own channels, nothing more. **No network to exfiltrate to.** |

**Example: a banking or finance app.**
- **Core** (Rust, C#, any language): it holds the credentials or keys, signs requests, enforces business rules,
  and keeps the transaction cache in `/data`.
- **UI:** it only renders and sends intents ("transfer 50 to account X").
- **An injected script or a malicious dependency in the UI:**
  - can't read the session token (it isn't there);
  - can't open a connection to an attacker (the UI has no network);
  - can only call the channels the core exposes, and the core can require a native confirmation for sensitive ones.

**The honest limits:**
- **The rendering engine is still Chromium.** A renderer exploit plus a sandbox escape is the same risk as in a
  browser. D9010 VmApp is *as strong as* the browser there, not stronger. Keep the loader updated.
- **Malicious UI script can still call the core's channels.** So design core APIs narrowly ("transfer requires
  confirmation", not "run arbitrary query"). That's a design guideline to document for app developers:
  **capability-shaped core APIs**.
- **Compiled cores aren't secret.** D9010 VmApp protects users from apps, not apps' code from users (see SECURITY.md).
  What compiled cores give you is **integrity from page scripts**, not confidentiality from the device owner.

**What it would take:**
- a guide on capability-shaped core APIs;
- a native "confirm this action" request op (spec proposal), for sensitive operations initiated from the UI;
- publisher signatures, so users know the banking app really comes from the bank.

## 2. Local backends: less server compute

Many small services exist only because developers don't want logic in client-side JavaScript: they rent a domain
and a server for work that could run on the user's machine. With D9010 VmApp, that logic runs **in the core, on the user's
machine, in a VM**, in C#, C++, Rust or anything else, with no server and no domain.

Good fits:
- **per-user processing:** document conversion, media processing, analysis, local search;
- **privacy-sensitive computing:** data that should never leave the device;
- **tools** that only needed a server to hide implementation details from page scripts.

**The honest limits:**
- Anything running on the user's machine is **controlled by the user**. A server can't trust results computed
  there. Authoritative state (balances, entitlements, anti-cheat, data shared across users) and secrets shared
  across users must stay on servers.
- The core has no GPU of its own, so heavy ML needs a server, or the GPU permission (llama.cpp RPC remoting, §4 phase B), or
  later Vulkan in the VM.

## 3. Offline-first apps that sync

The core is a natural **local server**:
- **Offline:** the app works fully against its local backend in the VM, with its data in `/data`.
- **Online:** the core syncs with the company's servers.

The developer writes the backend once, and the UI doesn't care whether it's online. The pattern already works for
the offline half: see `examples/convert-webapp`, where an Express server runs unchanged inside the VM.

**What it needs:** the **network permission** (milestone 2). The app declares the hosts it syncs with
(`api.example.com`), the user grants them, and the host proxies only those. The Inspector can show sync traffic
volume.

**Compliance:** this *helps*, but doesn't automatically satisfy rules. Data stays on the device by default, and
access is explicit, granted and inspectable, which supports data-residency and least-privilege requirements. Whether
an app is compliant still depends on what it does with the data and where it syncs it.

## 4. GPU pass-through: a "proxy driver" for apps in the VM

**Goal:** an app that needs GPU acceleration (Ollama, llama.cpp, ML tools) shouldn't have to leave the VM to get
it. The VM offers a standard GPU API, and calls are forwarded to the host's GPU (Metal on macOS) with modest
overhead.

What can't work: exposing Metal itself inside Linux. Linux has no Metal, so nothing in the VM could call it. What
does work is **API remoting**, at two levels:

| Level | How | Effort | Covers |
|---|---|---|---|
| **A. Vulkan pass-through**, the true "driver" | **virtio-gpu Venus**: Linux Mesa's Venus driver serialises Vulkan, and the host replays it through **MoltenVK → Metal**. Precedent: Podman on Apple silicon (libkrun/krunkit), where llama.cpp's Vulkan backend runs at useful speed. | **Large.** Apple's Virtualization.framework has no 3D virtio-gpu, so GPU apps need a second VM backend: a libkrun-style VMM on Hypervisor.framework with virglrenderer, next to today's launcher. | anything using Vulkan: ML inference, compute, some graphics |
| **B. Compute remoting per framework** | **llama.cpp's RPC backend**: a user-approved host compute server (Metal), which the VM reaches through the host. Ollama or llama.cpp in the VM offloads the heavy maths to it. | small to medium | LLM inference |

**Rules** (same as other host capabilities, SPEC §8.2):
- **Opt-in:** an explicit per-app `gpu` capability, off by default, granted in the permission sheet, and shown in
  the Inspector.
- **Attack surface:** the host-side GPU stack now processes commands from untrusted VMs, and GPU drivers are a
  classic escape path. Keep the host component minimal and versioned, and keep it current.
- **API versions:** the VM sees the API version the host supports (for example the Vulkan version MoltenVK
  provides), so apps can check for features.

**The goal, stated plainly:**
- **What the platform makes available:** full GPU access inside the VM through standard APIs (Vulkan, plus
  framework-level remoting such as llama.cpp RPC), on macOS first and the same way on Windows (Hyper-V GPU-PV).
- **What apps may need:** a rebuild or a backend switch (for example llama.cpp's Vulkan or RPC backend instead of
  CUDA). That's a property of how each app is built, not a platform limit.
- **What developers get:** they can build GPU-heavy apps for D9010 VmApp, granted per app like any other capability.

**A general GPU interface, not one workload.** RPC remoting helps AI inference only. The real
interface is layered:

| Layer | What | Covers |
|---|---|---|
| 1 | **GPU in the UI window**: WebGPU and WebGL in the host Chromium renderer, hardware-accelerated; logic stays in the core | most 2D/3D games, visualisation, creative tools; available today |
| 2 | **Vulkan inside the VM**: virtio-gpu + Mesa Venus → virglrenderer → MoltenVK → Metal, through a second VM backend (libkrun, as in Podman), since Virtualization.framework has no 3D virtio-gpu | anything using Vulkan: compute, offscreen rendering, ML, video |
| 3 | **VM-rendered frames shown in the app window**, via shared memory (blob resources) | games or tools that must render inside the VM |

**The seam: "GPU backends".** Model formats (GGUF, MLX), engines (llama.cpp, Ollama, LM
Studio, MLX, PyTorch) and compute backends (Metal, CUDA, ROCm, Vulkan) are different levels. The platform offers two
kinds of GPU backend, declared by the app and granted by the user:
1. **Device APIs inside the VM.** Vulkan first: the llama.cpp family (Ollama, LM Studio's llama.cpp engine) and
   wgpu/WebGPU-based software run on it through their existing Vulkan backends. CUDA and ROCm come later, on hosts that
   have those GPUs (Windows Hyper-V GPU-PV, Linux passthrough), through the same seam.
2. **Host compute services.** These serve frameworks that exist only on the host: MLX, Metal, Core ML, PyTorch MPS.
   Each is a narrow, versioned, permission-gated service the app in the VM calls. llama.cpp RPC is the first one.

Manifest sketch (a future spec proposal): `"gpu": { "api": ["vulkan"] }` or `"gpu": { "service": ["mlx"] }`. The
platform reports what each host can provide. CUDA and ROCm can never run on a Mac (there is no such GPU); MLX's GPU
path is Metal-only, so on D9010 VmApp it's a host service.

**What layer 2 is:** a stable, well-defined GPU layer that apps are ported or refactored to. It isn't a
native driver in the pure sense, but it should be as complete as possible. Vulkan is the target because porting to it
also works on Linux, Windows and Android. Conformance numbers tell developers exactly how complete each release is.

**The bar for layer 2: production, OS-level driver quality, not "works for a demo".**
- **Conformance:** Khronos Vulkan CTS (dEQP-VK) runs inside the VM, with pass rates tracked per release.
- **ABI:** a standard Linux Vulkan stack (the `libvulkan` loader plus an ICD), so unmodified binaries run.
- **A published profile:** a versioned "D9010 VmApp GPU profile" listing the exposed API version, extensions, features and
  limits.
- **Configuration:** per-app grant, memory limits, device report.
- **Robustness:** a sandboxed host renderer process, GPU faults isolated to the app, and command-stream fuzzing.
- **Choice of host translator:** decided by conformance numbers (MoltenVK vs LunarG's KosmicKrisp).

llama.cpp RPC (phase B) stays as a shortcut for inference. Layer 2 is being proven by a spike in
`gpu/venus-spike/` before any product design.

**The general model: host services.** The VM calls a function, and the function *executes on
the host*, in the loader or a host service it starts, with full access to macOS frameworks (Metal, Core ML,
Accelerate, Vision, Speech). Nothing macOS-specific is ported into Linux. The deciding rule: the call boundary must
sit at an API the VM-side app actually calls.

| Kind | Example | App changes |
|---|---|---|
| **The app already speaks a remotable API** | llama.cpp / Ollama RPC backend, Vulkan via Venus | none |
| **A host service the app calls on purpose** | transcribe with Speech, run a Core ML model, OCR with Vision | the app calls the service |

The plumbing for the second kind exists: host capabilities (`tool:`, `mcp:`, SPEC §8.2) let the user register a
native host service, and apps call it through the bridge, permission-checked and logged. GPU work adds a fast channel
for bulk data (tensors, weights). Each host service must stay **narrow**: specific functions, granted per app, and
kept current. The host now executes work an untrusted app drives.

**Status of phase B: implemented** ([SPEC §8.6](../SPEC.md), [HOST-CAPABILITIES.md §9](HOST-CAPABILITIES.md), GOVERNANCE INV-H7).
- **What exists:** the `gpu` capability. Granted (and only then), an app's VM has `127.0.0.1:50052` and `VMAPP_GPU_RPC`, speaking
  llama.cpp's RPC protocol to a Metal-backed `rpc-server` that the loader runs on the host, **in a macOS sandbox, one per app run**.
  The pinned llama.cpp commit and protocol version are in `gpu/pins.env`; the server is built by `gpu/build.sh` and shipped, signed,
  in the loader. The tunnel is a generic *host service* (`vmapp-vm --service NAME=127.0.0.1:PORT`) that other services can reuse.
- **Measured** (M4 Max, SmolLM2-360M Q8_0): generation about 270 to 340 tokens/s and prompt processing 10 800 to 14 400 tokens/s through the
  sandboxed server from the host; from inside a VM, one RPC round trip ≈ 70 to 105 µs.
- **Honest limits:** the RPC server is upstream's proof of concept and is not hardened for untrusted input (hence per-app, sandboxed,
  opt-in); any local process can reach its loopback port while it runs; the sandbox lets it write the shared Metal shader cache; no GPU
  memory or time quota; llama.cpp only (phase A is still open); the app's llama.cpp client must be built from the pinned commit.
- **Still to do for the plan above:** the Ollama conversion (it needs only the address and a build on the pin), and phase A.

**Order:**
1. **B**, with the Ollama conversion.
2. **A** as a design doc and prototype backend: the flagship contributor project.
3. Windows, through Hyper-V GPU paravirtualisation (GPU-PV).

## 5. Smaller directions already visible

- **App groups:** apps share one context folder with consent (SPEC §2.2 Future).
- **Reset and ephemeral runs:** "run this app once, keep nothing", for trying unknown apps.
- **Per-app resource accounting** in the loader: CPU, memory, disk.
- **Network permission** with a per-app traffic view in the Inspector.
- **Render-in-VM mode** for existing Linux GUI apps (a separate, optional path).
- **Windows and Linux hosts**, so the same `.vmapp` runs everywhere ([PLATFORMS.md](PLATFORMS.md)).
- **A registry with publisher identity and signatures**, building on today's simple registry
  ([DISTRIBUTING.md](DISTRIBUTING.md)).

## How to help

Each direction above needs a spec proposal before code ([../GOVERNANCE.md](../GOVERNANCE.md) §4). The most valuable
first steps:
1. the network permission design (host-side allowlist proxy, consent UI, Inspector view);
2. a confirm-action request op;
3. publisher signatures.
