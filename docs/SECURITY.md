# D9010 VmApp security model

**For:** security reviewers, and anyone deciding whether to trust D9010 VmApp. To learn how it fits together, read
[ARCHITECTURE.md](ARCHITECTURE.md). For the comparison with Electron and container backends, read
[../WHY.md](../WHY.md).

## What D9010 VmApp promises (format 1)

When you run an app in the D9010 VmApp Launcher:

1. **The app's code can only touch files you gave it.**
   - **Where it runs:** its core runs in its own Linux VM.
   - **Your folders:** only the ones you granted exist inside it, with the access you chose (read, read-write or
     write-only). They are enforced by the hypervisor, outside the VM.
   - **Its own data:** each app has one private data folder.
   - **Picked files:** a file you pick in a dialog is shared as a copy-on-write clone; its neighbours are never
     visible.
2. **The app has no network, unless you allow named hosts.**
   - **Never a network device:** there is none in the VM, and the app's UI has `connect-src 'none'`.
   - **The only way out** is a proxy run by the host. It lets a connection through only to a host (and port) you
     granted for that app, and nothing is granted by default. A new version that asks for another host or port stops
     and asks you again.
   - **Your own network stays out of reach:** the host looks the name up itself and refuses it if any answer is a
     private, loopback, link-local or similar address (your router, this Mac, cloud metadata, DNS tricks included).
     An app can't ask for an IP address, only a name.
   - **Encryption stays the app's:** HTTPS goes through as an end-to-end tunnel. The host sees which host and port,
     how many bytes and when, never the content. Every connection, allowed or refused, is reported to the Inspector
     as a `net` row.
   - **You can revoke it at any time** (the card's **Network…**, or `vmapp grant-net --revoke`), and the connections that
     were open close at once, also while the app runs.
   - **The loader says it in words** when an app can read a folder or the screen *and* reach a host, at install and in the
     permission sheet (live, as you choose).
   - **An update never widens a grant:** a new host, a wider wildcard or a new port stops at "asks for more" and stays off;
     a grant for 443 does not become a grant for the 8443 a new version adds.
   - **Your Mac's size is yours too:** the manifest only recommends vCPUs and memory; you choose (default one vCPU), up to
     your Mac's cores and half of its memory (SPEC §8.5).
   - **The input overlay hides typed text** by default ("typing… (12 characters)"), so a password an app types is not
     readable on your screen unless you turn that on (SPEC §8.2).
3. **No vendor code runs on your Mac with your rights.**
   - **The only host-side code is the loader**, which is the same for every app.
   - **The app's UI** runs in a sandboxed Chromium renderer with no Node, no file access and no device permissions,
     **except the microphone**, and only when the app asks for it and you allow it (below). Its only API is
     `window.vmapp`, which talks to the app's own core.
4. **The app can't outlive the loader.** Each VM stops when the loader quits, crashes or is killed.
5. **What you install is what you reviewed.**
   - **Install:** every file in a package carries a SHA-256 in the manifest. Install checks them all.
   - **Serving the UI:** the loader checks each UI file again before serving it.
   - **The package id** (the hash of the manifest) identifies exactly what you approved.
6. **Each launch starts clean.**
   - **Read-only:** the operating system, the runtime and the app's code.
   - **In memory:** temporary files, gone when the app stops.
   - **What persists:** only the app's data folder and the folders you granted.
7. **The app has no GPU unless you allow it.**
   - **Opt-in, per app:** the manifest must ask and you choose "Allow while the app runs" (default Don't allow); an update that asks
     for it stops and asks again.
   - **A sandboxed helper, not your Mac:** the GPU work is done by llama.cpp's RPC server in a deny-by-default macOS sandbox, one per
     app run (SPEC §8.6). The VM can reach only that helper, by name, through the tunnel the network permission uses.
   - **Stoppable:** revoke it (a running app loses it within a second), use the panic shortcut, or stop the app. Every connection is an
     Inspector row. The residual risks are listed below.

## Threat model

| Attacker | Goal | Stopped by |
|---|---|---|
| A malicious app core | read or encrypt your files | the VM boundary; only granted folders exist |
| A malicious app core | phone home or exfiltrate | no network device; the only way out is the host's allowlist proxy: nothing is reachable until you grant a host, one app at a time, and every connection is logged. **The pair that matters is "folder + network"**: an app that can read a folder and reach a host can send what it reads there. The warning is written by the loader (`riskSummary`), not the app: the CLI shows it now, and the loader's install review and permission sheet must show it (SPEC §8.3). Grant the pair only to apps you trust. |
| A malicious app core | reach your LAN, your router, this Mac or a cloud metadata address through the proxy | rules name hosts, never addresses; the host resolves the name itself and refuses if **any** answer is private, loopback, link-local, CGNAT, unique-local, multicast or reserved (DNS rebinding included), and connects to the address it checked |
| A malicious app core | use a granted host as a relay (a wildcard like `*.example.com`, a host that serves anyone's content) | the sheet marks wildcards and port 80; grant the narrowest host that works. A granted host is a trust decision about that host. |
| A malicious app core | keep talking after you revoke, or exhaust the host with connections | revoke closes the open connections at once; at most 64 connections per app, 10 s to connect, 5 min idle, bounded request sizes |
| A malicious app core | persist, or attack other apps | a read-only OS and runtime; one VM per app; each app's data folder is separate |
| A malicious app core | escape the VM | the hypervisor (Apple Virtualization.framework) and a small Linux guest. **A VM escape is the residual risk** of the core side. |
| A malicious app core | attack the GPU server, or use the GPU when it is not allowed | off unless the manifest asks **and** you allow it per app ("Allow while the app runs"; default Don't allow). The server is llama.cpp's RPC server, which upstream calls "proof-of-concept … fragile and insecure" and which **is not hardened for untrusted input**, so it runs **per app, in a deny-by-default macOS sandbox** (one loopback port, the GPU, no files, no programs, no outbound connections; the one writable place is your Metal shader cache) and **only when you opt in**. The VM reaches it by name through the existing tunnel (the launcher maps the name to the one endpoint it was started with and trusts nothing else the guest says). It stops with the app, on revoke, on panic and at quit (SPEC §8.6). |
| A malicious app UI | access files, network or devices | the Chromium sandbox, no Node, a strict CSP, denied permissions, blocked navigation and popups |
| A malicious app UI | listen to you (microphone) | off unless the manifest asks **and** you allow it per app (loader sheet; default Don't allow). One gate (`loader/src/devices.js`) answers every permission request: only `getUserMedia({audio})` from the app's own main page; video, screen sharing and every other permission stay denied. Each request is logged in the Inspector; the card, the activity monitor and macOS show it. |
| A malicious app UI | trick you with a fake prompt | real decisions are native dialogs or loader windows, which name the app |
| A tampered package | swap code after review | per-file SHA-256 at install and at serve time |
| A compromised runtime image | backdoor every app | runtimes are platform components: pinned base digests, reproducible builds, built by the platform (not by app vendors) |

## What D9010 VmApp does not protect against

- **Misuse of access you granted.** An app with read-write access to a folder can change or delete files in it.
  Prefer `read`, `writeonly` and dialog picks.
- **Misuse of an allowed microphone.** An app you allowed to listen can record what it hears. The loader's "using the
  microphone now" signal is best effort (a hostile window could hide a track from it); the permission label, the
  Inspector row of every request, and macOS's own microphone indicator can't be hidden by an app.
- **Misuse of the GPU you allowed.** An allowed app can use as much of the Mac's GPU time and memory as macOS gives it, and can send
  the server any RPC messages: if the server has a memory-safety bug, the app can try to exploit it. What it would get is the
  sandbox (no files, no network, no programs), not your account. Three things remain true even so, and are written down rather than hidden:
  - **Any program on your Mac can connect to the server's loopback port while it runs.** The port is random and chosen per app run, but
    llama.cpp's RPC server has no authentication and cannot listen on a Unix socket at the pinned version, so a local process (another
    user's, or another app of yours) that finds the port can allocate GPU memory and run the server's operations. A VM cannot (it reaches
    only its own server through its own tunnel).
  - **The shader cache is shared.** To start in a fraction of a second instead of 10 to 15, the sandbox lets the server write your
    `com.apple.metal` cache folder, which every Metal program of yours reuses. A server taken over by a hostile app could poison the compiled
    shaders other Metal programs load from it. The alternative (a precompiled Metal library, no cache access) is a planned
    follow-up; until then, only allow apps you trust with your GPU.
  - **No quota.** The loader does not limit the GPU memory or time an allowed app uses; revoke it, or stop the app, to end it.
- **Misuse of a host you allowed.** An app that may reach `api.example.com` can send that host anything it can read,
  and the host is a third party. If it also holds a folder (or screen) grant, **that is the exfiltration pair**:
  D9010 VmApp warns, it can't stop you from granting it. Wildcards and port 80 (unencrypted HTTP) widen the exposure, and
  the host doesn't look inside the encrypted tunnel: a granted server that fronts many sites (a CDN edge) can be asked
  for any of them.
  D9010 VmApp shows where data goes (host, port, bytes), not what it is: TLS is end to end by design.
- **A secret under an unremarkable name, in the Inspector.** The Inspector shows a preview of each bridge message and hides what looks like
  a secret (a field named `apiKey` or `password`, a string shaped like an API key or token, the payload of a channel named
  `api-keys:set`; SPEC §6). The payloads are the app's own, so a secret under an unremarkable name is shown. Close the
  Inspector, or use an app that names its secret fields plainly, before you share your screen.
- **Chromium 0-days.** The app's UI is web content in the loader's Chromium. A renderer exploit combined with a
  sandbox escape reaches the host, the same risk as a browser tab. Keep the loader on current Electron releases.
- **Hypervisor or kernel escapes** from the VM. They're rare and valuable, but not impossible.
- **The vendor's own IP.** `core.cpio` is readable in the package. D9010 VmApp protects users, not vendors' secrets.
- **Not yet in format 1:**
  - publisher signatures, so you can't yet verify *who* made a package;
  - network beyond TCP to granted hosts (no UDP, no inbound connections, no per-host bandwidth limits);
  - device permissions other than the microphone (the camera is reserved and refused);
  - per-app resource accounting beyond the memory and CPU limits.

## Rules for platform contributors

Every change to the platform keeps these true:
1. No new path from an app (core or UI) to the host that the user hasn't granted.
2. No vendor-supplied code runs in the loader's main process or preload. Apps can't ship a preload.
3. Every new request op in the bridge is permission-checked in `hostlib/session.js`, and denied by default.
4. The renderer stays sandboxed, with `contextIsolation` on, no Node and the SPEC §7 CSP.
5. Launchers never panic on closed pipes, and they always stop their VM when the parent dies.
6. Runtime base images are pinned by digest and built reproducibly.
7. App windows get no permission except the user-granted microphone, answered only by `loader/src/devices.js`
   (GOVERNANCE INV-B3). Never test with `--use-fake-ui-for-media-stream`: it makes Chromium accept requests without the gate.

8. Network stays a proxy (GOVERNANCE INV-N1 to INV-N4): the VM never gets a network device; only `vmapp-vm` opens
   sockets for an app, only to granted hosts, only after it has checked every address the name resolves to; nothing
   in the loader or the guest connects on an app's behalf; the test switches `--dev-allow-loopback` and
   `--dev-resolve` never appear in `loader/` or a manifest.

9. A host service stays a loopback endpoint the loader started (GOVERNANCE INV-H7): `--service` only from the loader's command
   line and only `127.0.0.1:PORT`, the guest names a service and nothing else, `sandbox-exec` with the bundled profile is the only way
   the GPU server starts, and `gpu/rpc-server.sb` only grows through a reviewed change of the `h7-gpu-service` rule.

The full checklist is in [../CONTRIBUTING.md](../CONTRIBUTING.md).

## Reporting a vulnerability

Please report privately, not in a public issue, using GitHub's private vulnerability reporting. The process is in the
[security policy](../SECURITY.md). Include the D9010 VmApp version, the package that shows the issue (or a minimal one) and the
steps to reproduce.
