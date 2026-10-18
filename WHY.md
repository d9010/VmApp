# Why D9010 VmApp?

**For:** anyone asking "why not just use Electron, Docker, or a virtual machine?" The short answer: in each of those, the app's
vendor, or you by hand, writes the safety rules. Here the platform writes them, the same way for every app, and you decide what each
app may reach.

---

## The problem

When you install an app, it runs as you: your files, your keys, your network. Developer tools are the worst case. A terminal runs any
program. An extension is code you didn't read. A `postinstall` script runs the moment you type `npm install`. AI agents now do all
of that for you. We trust them because we have no choice.

D9010 VmApp gives you a choice. Each app's engine runs in its own small virtual machine (VM). Its window renders natively on your
desktop, in a sandbox with no network and no file access. You decide which folders and which internet hosts each app may reach. The
default is nothing.

## At a glance

| Approach | If an app is compromised, what can it reach? | Who writes the safety rules? |
|---|---|---|
| **A plain desktop app (Electron)** | your files, keychain prompts, network and other programs: it runs with your user's rights | the vendor |
| **Electron with a container** | the vendor's host-side half can still do anything; the container covers only what the vendor put in it | the vendor (`docker run -v $HOME:/home` is one line away) |
| **One big Ubuntu VM** | everything in that VM, plus whatever you shared into it | you, by hand, for each VM |
| **D9010 VmApp** | **only the folders you granted** | **you, in the launcher, the same way for every app** |

And day to day:

- **Network:** none until you allow named hosts. Most alternatives are open by default.
- **The window:** native on your Mac, not a remote desktop.
- **Upkeep:** shared read-only runtimes, updated once. No operating system of your own to patch.
- **Footprint:** about 30 to 140 MB of memory per VM, and about 0.4 s to start.
- **After you quit:** each launch starts clean, and a VM can't outlive the launcher.

## Compared with Electron

An Electron app's main process runs on your Mac with all of your user rights: every file, the network, other programs. You have to
trust every vendor completely, and so does everything the vendor depends on.

D9010 VmApp keeps Electron's programming model: a window written in web technology, and a main process. It moves the main process,
which we call the engine, into a VM. No vendor code runs on your Mac with your rights. The only host-side code is the launcher, which
is the same for every app. If you already build Electron apps, converting one is mostly changing `require('electron')` to
`require('vmapp')`.

## Compared with Electron and a container

A container only isolates the part the vendor chose to put in it. The vendor's own Electron main process and its container flags
still run on your computer, and the vendor wrote them. D9010 VmApp moves the whole vendor side behind the boundary and makes the
boundary the platform's job, not the vendor's. It is the difference between installing software by hand and installing an app on a
phone: the technology is similar, but the platform enforces the rules.

On a Mac there are further differences:

| | A container (Docker Desktop and similar) | D9010 VmApp |
|---|---|---|
| **Isolation unit** | containers share one Linux kernel inside one VM, so an escape reaches every other container | **one VM per app**, so an escape reaches only that app's VM |
| **What the shared VM can see** | Docker Desktop shares `/Users` into its VM by default, for bind mounts | each app's VM sees only the folders granted to it |
| **Control from outside** | `docker exec`, `cp`, `export`, a root-equivalent socket | none exposed to apps or vendors |
| **Network by default** | full outbound | **none**; allowed per host through a host-enforced allowlist proxy, which also refuses any destination on your own network |
| **What an app ships** | layers including an operating system userland | only its own code, often a few kilobytes; the system and runtimes are shared |

## Compared with one big Ubuntu VM

An Ubuntu VM is a *place*. D9010 VmApp is a *contract*: a small, fixed set of rules that the platform, not the app, enforces. Two
reasons one big VM is not the answer:

- **You manage it forever.** A whole computer, for as long as you use it: patches, the guest's graphics and clipboard tools, a
  network setup, how much memory it gets, what you shared into it. It never stops needing you.
- **Many apps in one VM is a second host.** The VM still shields your Mac from what is inside it, but the apps inside don't protect
  each other: one bad dependency sees everything in there. Running everything in one VM is running everything on your Mac, one
  layer down. The protection comes from **one tiny VM per app**, with the same rules for every one, not from "a VM" as such.

An Ubuntu VM is still the right tool when you want a full Linux desktop, or need to run Linux GUI programs unmodified. D9010 VmApp is
for the other case: you want to run *an app*, possibly someone else's, with a clear answer to "what can it touch?"

## Why the window runs on your Mac and not in the VM

A user interface is more than pixels. It is keyboard, mouse, trackpad, touch, pen, input methods, clipboard, drag and drop, fonts,
scaling and screen readers, and the operating system already routes all of them to the browser. Doing that from inside a VM means
forwarding and emulating every one, and it never quite works. On the Mac, the window gets the Mac's own graphics and input stack, so
the platform builds and maintains none of it. A game or visualization in the window uses your Mac's GPU at full speed.

The window is locked down: a sandboxed Chromium with no Node, no network and no file access, and a single API, `window.vmapp`, that
talks to the app's own engine through the launcher.

## What it does not promise

It limits what an app can reach. It doesn't judge what you decide to grant.

- **Access you grant can be used.** An app with read-write access to a folder can change the files in it. Prefer read-only,
  write-only and a file picked in a dialog.
- **A folder plus a host is the pair to be careful with.** An app that can read a folder and reach a host can send what it reads
  there. The launcher warns you in words when you grant both.
- **The window is web content in Chromium, like a browser tab.** A serious Chromium flaw combined with a sandbox escape would reach
  your Mac, as it would from any browser tab. Keep the launcher on current releases. A hypervisor or kernel escape is rare, not
  impossible.
- **It protects users, not a vendor's secrets.** An app's engine files are readable in its package.

The complete model, with its threat table, is in [SECURITY.md](docs/SECURITY.md). The architecture behind all of this is in
[ARCHITECTURE.md](docs/ARCHITECTURE.md).
