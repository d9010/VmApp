# D9010 VmApp FAQ: design questions and their answers

**For:** anyone who asks "why is it like this?" Each answer links to the document with the details.

---

### What is D9010 VmApp, in one paragraph?
A standard, and an open-source implementation, for running desktop apps you don't trust:
- **The app's core** (its "backend", in any language) runs inside a small Linux VM on your computer.
- **The app's UI** renders natively on your desktop, in a sandbox with no network and no file access.
- **A loader app** lets you choose which apps to run and what each one may reach.

Developers get Electron's programming model, with "main" moved into a VM. → [ARCHITECTURE.md](ARCHITECTURE.md)

### Why not just Electron?
An Electron app's main process runs on your machine with your full user rights: every file, the network, child
processes. You have to trust every vendor completely. In D9010 VmApp, no vendor code runs on your computer with your
rights. → [../WHY.md](../WHY.md)

### Why not Electron with a container backend?
The container only isolates the part the vendor *chose* to put in it. The vendor's Electron main process and its
container flags still run on your computer, and they're written by the vendor. D9010 VmApp moves the entire vendor side
behind the boundary and lets **you** decide the rules.
- **On a Mac:** containers also share one Linux kernel in one VM, and Docker Desktop shares `/Users` into that VM by
  default.
- **Where containers are better:** D9010 VmApp is honest about it in WHY.md (maturity, platforms, deep OS integration,
  high-throughput IPC).

→ [../WHY.md](../WHY.md)

### Why not run each app's UI inside the VM too?
Rendering inside VMs is hard to do well:
- weak GPU acceleration in macOS VMs;
- HiDPI, resizing and multiple monitors;
- input methods (IME), clipboard, drag and drop, fonts and accessibility all crossing a VM boundary;
- extra latency.

X11 or Wayland forwarding works, but it's heavy and fragile. Rendering on the host gives native quality. The cost is
that UI code runs in a Chromium renderer on the host, which is locked down: sandboxed, no Node, no network, a strict
CSP, and only the `window.vmapp` API. A "render inside the VM" mode could come later for existing Linux GUI apps.
→ [ARCHITECTURE.md §7](ARCHITECTURE.md)

### Does a user's computer need Node.js or npm?
**No.** There are three different "Nodes", and only one is the app's:

| Which | Where | For | Can an app's UI reach it? |
|---|---|---|---|
| developer tools (`npm start`, `tools/vmapp`) | the developer's machine | building and running from source | no; users don't have it |
| Electron's built-in Node | inside the loader app, main process only | the loader's own trusted code | **no.** App windows run with `nodeIntegration: false`, `sandbox: true` and `contextIsolation: true`; their only API is `window.vmapp`. |
| Node in the `node22` runtime | inside each app's VM | app backends written in Node | it *is* the app's backend, confined to the VM |

End users install one packaged app, the D9010 VmApp Launcher, which carries everything. `npm start` is only for running the
loader from source. → [PRODUCTION.md](PRODUCTION.md)

### Is the VM shipped with every app?
**No. The VM ships once, inside the loader.** The loader download contains:
- the VM launcher for your OS;
- a tiny Linux kernel and init (about 8 MB);
- the shared language runtimes: `native` 0.2 MB, `node22` about 120 MB, `dotnet8` about 110 MB. `dotnet8` could
  instead download on first use, signed and hash-pinned.

Apps are separate, small files (KB to a few MB) with only their own code. Updating the loader updates the kernel and
runtimes for every app at once. → [PRODUCTION.md](PRODUCTION.md)

### How do people come to trust the loader?
- **It is open source.**
- **Its builds are reproducible.** The init, the kernel, the runtimes and app packages rebuild to identical bytes, so
  anyone can rebuild and compare.
- **Releases are signed and notarized,** with checksums and an SBOM.
- **The Linux kernel's source is offered,** as its GPL licence requires.
- **The rules can't be broken quietly.** They're numbered in [../GOVERNANCE.md](../GOVERNANCE.md), every
  contribution is reviewed against them, and protected parts need the maintainer's sign-off.

### Where are apps hosted? Is there a store?
Apps are ordinary files: host them anywhere (your website, GitHub Releases, email). Each build has a **package id**
(the hash of its manifest), which identifies exactly what was reviewed. The loader's own releases and runtime images
start on GitHub Releases, with a signed runtime index. An app catalog can come later; nothing requires one.
→ [PRODUCTION.md](PRODUCTION.md)

### Which platforms?
| Host | Status |
|---|---|
| macOS on Apple silicon | built (Virtualization.framework) |
| Windows (x64 and ARM) | designed: Hyper-V's Host Compute Service, the API WSL2 and Docker use; needs an x86_64 kernel and runtimes |
| Linux | later: KVM through a small VMM (cloud-hypervisor or Firecracker) |

The app format, the bridge, the SDK and app packages are the same everywhere. → [PLATFORMS.md](PLATFORMS.md)

### Can an app be written in anything other than JavaScript?
Yes. The core is any program that speaks a small JSON-lines protocol on a Unix socket. The samples include Rust
(`apps/hasher`, a static binary on the `native` runtime) and .NET (`apps/todo`, on `dotnet8`). Companies can ship
compiled binaries, and users don't need to trust them because they run in the VM.
→ [BUILDING-APPS.md §5.3](BUILDING-APPS.md)

### Does D9010 VmApp hide a vendor's code from users?
**No.** D9010 VmApp protects users, not vendors' secrets. An app's core files are readable inside its package. Sealing
code (encrypted images) is the separate agent-vm project's planned work. → [SECURITY.md](SECURITY.md)

### What about resetting an app between uses?
Every launch already starts from a clean VM: the OS, the runtime and the app's code are read-only, and temporary
files live in memory. Only the app's own data folder and the folders you granted persist. "Reset" therefore means
emptying the app's data folder and forgetting its grants: the loader's **Reset** button, or
`vmapp uninstall --purge`.

### Can two apps share data?
Not in format 1: apps never see each other's data. A future **app groups** permission will let several apps share
one folder when you consent, for workflows where apps are meant to work together. → [../SPEC.md §2.2](../SPEC.md)

### Can I see what an app is doing?
Yes. The loader's **Inspector** works like a browser's DevTools for the bridge. It shows every message between an
app's UI and its core, with timing, plus the core's log and files it delivered. → [USING.md](USING.md)

### Can an app use the internet?
Yes, but only the hosts you allow, one app and one host at a time, and nothing is allowed by default. The app's
manifest lists the hosts it wants (`api.example.com`, or `*.example.com`) and why; you grant each one, or none. The VM
still has **no network device**: a proxy on your Mac is the only way out. It resolves the name itself, refuses any
address on your own network (your router, this Mac, cloud metadata, DNS tricks included), and reports every connection
(host, port, bytes) to the Inspector. HTTPS stays end to end, so the loader sees where data goes, not what it is.
**Folder access plus a host is the combination to think about**: an app that can read your files and reach a server can
send them there, so the loader warns you in its own words. An update that asks for another host or port stops and
asks you again, and revoking a host closes its open connections at once. → [../SPEC.md §8.3](../SPEC.md),
[SECURITY.md](SECURITY.md), [BUILDING-APPS.md §7](BUILDING-APPS.md)

### Is D9010 VmApp safer than a browser?
For installed apps, in several ways:
- the app's logic and secrets live in a VM instead of the page;
- nothing is shared between apps: no common cookies, history or extensions;
- an injected script has no network to send data to (the UI has none at all; the core reaches only hosts you granted).

But the UI renders in Chromium, so against rendering-engine exploits D9010 VmApp is as strong as a browser, not stronger.
→ [VISION.md §1](VISION.md)

### Can apps replace small servers, or work offline and sync?
Per-user logic can move from rented servers into the app's core, on the user's machine. Authoritative and shared
state must stay server-side. Offline-first with sync works naturally with the network permission (the app names the
sync host; you allow it).
→ [VISION.md §2–3](VISION.md)

### Can an existing app be converted?
Usually, yes:
- **Electron apps:** mostly `require('electron')` → `require('vmapp')`, plus a small renderer shim.
- **Web apps with a local HTTP backend:** the backend runs unchanged in the VM, and API calls travel over the
  bridge, streamed answers and uploads included (Ollama's own desktop app, a Go backend and a React window with
  streamed chat and model downloads, is converted this way: [apps/ollama-desktop](../apps/ollama-desktop/CONVERSION.md)).

→ [CONVERTING.md](CONVERTING.md)
