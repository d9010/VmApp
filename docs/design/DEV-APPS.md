# Design: what the platform adds for full developer apps (VS Code)

Status: **proposed on 2026-10-17 at the maintainer's request** (full VS Code support, with new platform support where needed, documented
clearly); implemented in the order of §11 on the branch `vscode-full` **for the maintainer's review**. Merging the branch is the
acceptance GOVERNANCE §4 asks for; until then nothing here is part of the platform. Each capability below is written the way GOVERNANCE §4 asks
for a spec change: what it adds, which invariants it touches, the threat analysis, and how the user consents. The normative text is in
[SPEC.md](../../SPEC.md) (sections named below); [GOVERNANCE.md](../../GOVERNANCE.md) is amended where an invariant changes.

## 1. Why

`apps/vscode` (Code - OSS 1.142.0) runs today with the platform as it was: editing, highlighting, TypeScript, terminal, git, search all
work. What a developer expects next is not possible without the platform, and every missing piece is a window or network rule, not a VS
Code problem ([apps/vscode/CONVERSION.md](../../apps/vscode/CONVERSION.md) §5):

| Missing | Because of |
|---|---|
| webviews: Markdown preview, extension pages, image preview, notebooks, Simple Browser | `frame-src 'none'` |
| web workers (tokenization, diff, links), WebAssembly (Oniguruma, tree-sitter, terminal images) | `script-src 'self'`, no `blob:` workers, no `wasm-unsafe-eval` |
| extensions from a marketplace, git push/pull, `npm install`, language servers that download | the manifest can only list named hosts |
| extension icons, README images, gallery queries from the page | the window has no network at all |
| running a dev server and opening it in the browser | no way into the VM, `shell.openExternal` is https only |
| menu Paste | `clipboard-read` is always denied |
| compilers, Python, `apt install` in the terminal | the runtimes are minimal and read-only |

The principle stays the same: **everything is off until declared by the app and allowed by the user, and everything the app does with it
is visible.** The window gets more powers *inside its sandbox*; access to anything of the user's still needs the user's grant.

## 2. C1 · Window features (`ui.features`) — SPEC 2.2, 7

```json
"ui": { "root": "ui", "features": ["workers", "wasm", "frames", "self-fetch"] }
```

| Feature | What changes for the app's windows | CSP difference from SPEC 7 |
|---|---|---|
| `workers` | dedicated and shared workers, also from `blob:` scripts the page builds | `worker-src 'self' blob:` |
| `wasm` | the page and its workers may compile WebAssembly | `script-src 'self' 'wasm-unsafe-eval'` |
| `self-fetch` | `fetch`/XHR of the app's **own package files** (`vmapp-ui://<id>/…`), from the page and from workers | `connect-src 'self'` |
| `frames` | isolated frames: `<iframe src="vmapp-frame://<label>/<path>">`, see below | `frame-src vmapp-frame:` |

**Isolated frames.** `vmapp-frame://<label>/<path>` serves the same verified package files as `vmapp-ui://<id>/<path>` (INV-B4: listed,
hashed), in the app's own partition, but every `<label>` is **its own origin**: a frame can neither read the app's page nor be read by it;
they talk only with `postMessage`. Frames get **no `window.vmapp`** (the loader's preload runs in the main frame only;
`nodeIntegrationInSubFrames` stays `false`), no permission (the microphone gate needs the main frame), no navigation outside
`vmapp-frame:`/`blob:`/`data:`/`about:`, and no network unless C3 is granted. Inside a frame the content may do what web content does
(VS Code webviews are extension-written HTML): the frame CSP allows inline scripts, `eval`, WebAssembly, `blob:`/`data:` resources and
**service workers** (the `vmapp-frame` scheme is registered with `allowServiceWorkers`; `vmapp-ui` is not):

```
default-src 'self' vmapp-frame: blob: data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: https:;
style-src 'self' 'unsafe-inline' blob: data: https:; img-src 'self' blob: data: https:; media-src 'self' blob: data: https:;
font-src 'self' blob: data: https:; connect-src 'self' blob: data: https:; worker-src 'self' blob:; frame-src 'self' blob: data:;
object-src 'none'; base-uri 'self' https:; form-action 'none'
```
The `https:` sources are there because webview content names its resources as https URLs (`https://*.vscode-resource.vscode-cdn.net`)
that the frame's service worker answers, and sets `<base href>` to one. They are not network: the partition's request filter cancels
every http(s)/ws(s) request that leaves the frame (found while implementing; SPEC §7 has the final text). Real network for the window is
C3, which changes the request filter and the proxy, not this CSP.

**Threat analysis.** None of the four gives the window anything of the user's: no file, no device, no network (C3 is separate), no
bridge in frames. *Workers* and *wasm* are computation in the same origin that could already run any JavaScript. *self-fetch* reads files
the window can already load as scripts, styles or images. *Frames* run more permissive code, but in a separate origin with no API: the
worst a frame can do is compute, and send messages to the app's page, which decides what to do with them (exactly like a browser tab
without network). The app's page and core stay the only parties that can use the bridge. A malicious **app** gains nothing it did not
have (its own page already runs its code).

**Consent.** None needed beyond the install review: the features are listed there and on the card in plain words ("Runs web workers,
WebAssembly and isolated frames inside its window"). They are not grants: they do not reach the user's resources.

**Invariants.** INV-B3 is amended: the CSP is SPEC 7's **or SPEC 7 plus exactly the features the manifest declares**; `connect-src`
gains `'self'` only with `self-fetch` (still no network), and network sources only with C3. INV-B1 is unchanged (frames are not
`<webview>` tags; `nodeIntegrationInSubFrames` stays `false`).

**Tests.** `tests/unit` (CSP builder: every feature alone, none → exactly SPEC 7; unknown features rejected at pack), the loader CDP run
(a frame has no `window.vmapp` and cannot read its parent; a page without `frames` cannot frame; a `vmapp-ui` page cannot register a
service worker), and VS Code's webviews in `tests/apps/vscode-ui.mjs`.

## 3. C2 · Network to any internet host — SPEC 8.3

```json
"network": [ { "host": "*", "ports": "*", "purpose": "Extensions, git remotes, package managers: anything you reach from a terminal" } ]
```

`"host": "*"` means **any public internet host**; `"ports": "*"` any port. Everything else of §8.3 stays: the VM has no network device,
every connection goes through the host's proxy, the host resolves names and **refuses private, loopback, link-local and other non-public
addresses** (the LAN and the Mac stay unreachable), 64 connections, timeouts, events for every connection, revocable at once.

**Threat analysis.** An app granted `*` can send anything it reads to any server. That is the reason it is a separate, loud grant: the
sheet says "can reach any server on the internet", and if the app can also read folders the risk sentence names them ("could read X and
send it anywhere on the internet"). Nothing about the user's network (LAN, the Mac's own services) opens.

**Consent.** Off by default like every host; the sheet shows it as its own row, red, with the purpose; never allowed by an update without
the "asks for more" sheet; `vmapp grant-net <id> '*'` in the CLI.

**Invariants.** INV-N2/N3 amended: a rule is an exact host, `*.suffix`, **or `*` (any public host)**; the address check is unchanged.
INV-N4: the Inspector shows every connection as before.

**Tests.** `cargo test` (rule `*` and `*` ports; LAN/loopback still refused under `*`), `tests/unit/network.test.js` (validation, risk
sentence), `tests/e2e.sh` scenario 10 additions (a `*` grant reaches a public name, refuses a LAN name, revoke closes).

## 4. C3 · The window's own network, through the app's proxy — SPEC 7, 8.3 (implemented)

With `ui.features` `"network"` **and** a network grant, the app's windows (page, workers, frames) may load **data** over `https:`
and `wss:`: fetch/XHR, WebSockets, images, media, fonts and style sheets. Never `http:`/`ws:`, and never code or documents (scripts,
frames, objects, workers) from the network. They do not get a network of their own: the loader points the app's partition at a
**loopback endpoint of the app's `vmapp-vm`** (stdin op `window-proxy`, an HTTP `CONNECT` proxy on `127.0.0.1`), which applies **the
same rules, the same address check, the same limits and the same events** as the guest's proxy (window connections have a cap of
their own). A connection from the window is an Inspector row like any other, marked `window`. The endpoint needs a per-run secret
(hostlib makes it, gives it on stdin, keeps it in memory; the loader answers the proxy authentication for that app's partition only),
so no other process can use the app's grants. As built, in SPEC 8.3 "The app's windows":
- `host/src/net.rs` `NetProxy::serve_window`: the endpoint; `connect_target` is now the one place both paths connect from.
- `hostlib/session.js` `_startWindowProxy`, `windowProxy`; `loader/src/window-net.js` (the request filter's one exception, a
  self-contained decision the invariant checker evaluates), `loader/src/window-manager.js` (`openWindowNet` / `closeWindowNet`,
  `windowProxyCredentials`), `loader/main.js` (the one `login` handler), `loader/src/protocols.js` (`UI_FEATURE_CSP.network`).

**Threat analysis.** The window could exfiltrate exactly where the core could: to granted hosts. It cannot reach the LAN or the Mac
(the filter refuses addresses and local names; the endpoint's address check refuses them again) and it is visible. It cannot load
code from the network (the CSP names no network source for scripts, workers, frames or objects, and the filter refuses those request
kinds whatever the CSP says). Without a grant every request reaches only the endpoint and is refused there (a `window` row).

**Invariants.** INV-B3 amended (the CSP's data-only network sources; the filter's one exception; the `login` handler; only the window
manager sets a partition's proxy); INV-N1 holds (only `vmapp-vm` connects; Chromium only reaches the loopback endpoint, which listens
on `127.0.0.1` only); INV-N3 and INV-N4 extended to the window path.

**Tests.** `cargo test` in `host/` (the endpoint: the secret, the same refusals as the guest, revoke, stop, its own cap),
`tests/unit/window-net.test.js`, `tests/unit/ui-features.test.js`, `tests/unit/network.test.js` (the session; the secret never logged),
18 real-tree mutations in `tests/invariants/real-mutations.test.js`, the loader's CDP run W (a real VM, the real internet), and
`VSCODE_UI_NET=1 tests/apps/vscode-ui.mjs` (extension icons in VS Code's window).

**Known limit.** A `net` row is printed when a connection closes; a browser keeps a few tunnels open in its pool, so a row can come
minutes after the request (or when a revoke cuts the tunnel). Live rows for open connections are part of T1 (§10).

## 5. C4 · Ports: the VM's servers on the Mac — SPEC 6 (`port.forward`), 8.8 (implemented)

A core may ask `port.forward {port}`; the host (after the user allows the device `ports` for the app: "Open its servers on this Mac
(localhost)", default Don't allow) listens on the Mac's `127.0.0.1:<port>` (the same port when free, else one the system picks), and
each connection is carried over vsock 1026 to `127.0.0.1:<port>` inside the VM. `shell.openExternal` also accepts
`http://localhost:<a forwarded port>/…` (the user still confirms). As built:
- `host/src/net.rs` `NetProxy::forward` / `forward_close` (stdin `port-forward` / `port-close`, `forward` events), `guest/src/portfwd.rs`
  (the guest's one loopback connect), `hostlib/session.js` (`port.forward`, `port.close`, `port.list`, `syncPorts`, the grant looked at
  once a second while forwards exist), the SDK's `ports`, the loader's chip, monitor pill and Inspector rows, `vmapp grant-device <id> ports`.
- *Not yet:* frames loading forwarded ports (VS Code's Simple Browser inside the window); a forwarded port opens in the user's browser.

**Threat analysis.** The listener is loopback-only (nothing from the network), named in the Inspector and on the card, stoppable. Any
local process of the user can connect to a forwarded port while it exists: the sheet says so.

**Invariants.** INV-N1: the guest connects only to its own loopback, on a port the host names (a narrow exception in
`n1-no-guest-egress`, one connect of one shape in one file). INV-C2: new ops with their permission check and denied-path tests.

**Tests.** `cargo test` in `host/` (a forward carries a connection, a taken port gets another, close and stop end it, network rules never
touch it, the caps), `tests/guest-net` (the guest side), `tests/unit/session.test.js` (the grant, the localhost link, a revoke closes the
forwards), `tests/apps/sdk-probe.mjs` (a real VM: a server in the VM fetched from the Mac).

## 6. C5 · The clipboard — SPEC 6, 7, 8.4 (implemented)

`permissions.devices` gains `clipboard`: an app's **windows** may then read and write the clipboard from their own code
(`navigator.clipboard`; Chromium's `clipboard-read` and `clipboard-sanitized-write`, which the platform refused until now: in VS Code
that broke the Paste menu item and pasting into the terminal), and its **core** may too (`clipboard.readText` / `clipboard.writeText`,
two new ops of §6; the Node SDK's `clipboard`), for any app's VM-side code. Keyboard copy and paste never needed it.
- **Gate:** the window side has its own functions (`clipboardRequestAllowed` / `clipboardCheckAllowed` in `loader/src/devices.js`),
  shaped exactly like the microphone's and checked by `tools/check-invariants` the same way (every answer `false` except the last,
  which asks `DeviceGate._why(..., 'clipboard')`; only the two clipboard permissions; nothing about media). The conditions are the
  microphone's: this app's own window, its main frame, the manifest asks, the user allowed it, read at every request. The core side
  checks the same grant in `hostlib/session.js` at every call.
- **Visible:** window requests are `host` rows (`clipboard.read`, `clipboard.write`); core requests are request rows whose payload is
  not shown; a card chip "Can use the clipboard" and a monitor pill while the grant stands.
- **Threat analysis:** an allowed app can read what the user copies (passwords included) and change it; with a network grant it could
  send it out. So it is a per-app device grant with loader words that say exactly that, off by default; the text never reaches the
  Inspector. No other window permission opens.
- **Tests:** `tests/unit/devices.test.js` (the gate, every denied path), `tests/unit/session.test.js` (the core ops, the revoke, the
  hidden payload), `tests/invariants` (five mutations of the gate), `tests/apps/vscode-ui.mjs` (refused without the grant, allowed with
  it, in the real loader). The core ops reach a real VM after the next runtime build (the SDK ships in the runtime image; Docker).

## 7. C6 · A developer runtime and a writable system layer — SPEC 3

A runtime `node22-dev` (Debian bookworm, the same Node 22 and SDK, plus build-essential, python3 + venv, git, openssh-client, curl,
unzip, jq, ripgrep), built by `tools/mkruntime`, pinned by digest. And [RESET.md](RESET.md)'s *system changes* layer (a per-app
writable overlay over the read-only runtime, kept in the app's data, "Undo system changes" resets it) so that `apt install` and
`npm -g` work without a privileged core: INV-D4 amended (the root is the read-only runtime **plus** the app's own overlay; the core
stays uid 1000 without new privileges; `sudo` is not provided).

## 7b. C9 · Menus in the Mac menu bar — SPEC 6, 7 "Menus" (implemented)

*Asked for by the maintainer on 2026-10-17: Mac users reach most features through the menu bar and its shortcuts.*

An app gives its menus as **data** and the loader builds the native menu itself: from the **page** (`window.vmapp.menu.set(template)`,
clicks to `window.vmapp.menu.onClick`; one new key of `window.vmapp`, INV-B2 amended) or from the **core** (op `menu.set`; the Node
SDK's Electron-compatible `Menu.buildFromTemplate` / `Menu.setApplicationMenu`, whose `click` handlers run in the core, so an Electron
app keeps its menu code). `hostlib/menus.js` validates every template: known keys, types and a short list of Electron roles (edit
and window ones), Electron's accelerator grammar, unique ids, limits on size and depth. While the app's window is focused (or, while
the loader is not the active app, was focused or created last) the menu bar is the loader's first menu, the app's menus, the loader's
Edit menu when the app has no copy/paste, and the loader's Window menu (its own ⌘1-⌘4 left to the app; Developer Tools).
- **Threat analysis:** a click only sends an id to the app that set the menu; no role can reach a loader action (quit, close, about,
  devtools are not in the list); ⌘Q, ⌘H, ⌥⌘H stay the loader's; the loader's own menus stay first and last; app labels cannot pose as
  a loader decision because every decision is a sheet or a native dialog of the loader's (INV-B5).
- **Tests:** `tests/unit/menus.test.js` (validation, accelerators, the kept shortcuts), `tests/unit/session.test.js` (the SDK's `Menu`
  with the fake VM: roles mapped, clicks run, checkboxes toggle), `tests/invariants` (B2 with `menu`), and the loader's run M (a real
  app: page menus, core menus, clicks both ways, the loader's menu bar for its own window).

## 8. C7 · Large cores: `core.erofs`, and the size limits — SPEC 2, 2.1, 4

*Added 2026-10-17 at the maintainer's request ("no corner cutting": the full VS Code, nothing left out for size).*

**The problem.** The guest copies `core.cpio` into a tmpfs at boot (SPEC §4 step 3), so every MiB of the core is a MiB of the VM's
memory for as long as the app runs, and the copy is boot time. That is why the core was limited to 256 MiB. The full VS Code
(every built-in extension and server module) is over that, and paid for its 199 MiB core with 199 MiB of RAM.

**The change.** A manifest may say `"core": {"image": "erofs"}`. The package then carries `core.erofs`, an EROFS image of the same
tree, and the guest **mounts** `/dev/vdb` read-only at `/app` instead of copying it. The guest kernel already has EROFS (the runtime is
an EROFS image), so the kernel and the launcher do not change: `vmapp-vm` attaches whatever file it gets as the read-only `vdb`.
- **Writer and reader** in `hostlib/erofs.js`, plain JavaScript (no Docker, no `mkfs.erofs` needed to pack): deterministic, so
  `vmapp pack` stays reproducible; the reader enforces the subset of SPEC §2.1 (no compression, no xattrs, no devices, no hard links,
  root-owned, the cpio's mode and symlink rules) at pack, verify and install. Checked against the reference tools: `fsck.erofs` accepts
  the images and `fsck.erofs --extract` gives back the exact tree; the reader accepts `mkfs.erofs` images of the same tree.
- **The guest** recognises the image by its magic, mounts it `ro,nosuid,nodev`, then walks it once with the cpio's rules (owner root,
  no setuid/setgid/sticky bits, only files, directories and relative symlinks that stay inside `/app`); a violation stops the boot.
- **Limits.** `core.cpio` keeps 256 MiB (it is memory). `core.erofs` may be as large as the package; the package limit goes from
  512 MiB to 2047 MiB (a package is read whole into memory at install and Node reads at most 2 GiB at once; streaming the reader is
  the way past that, not needed yet), and `ui/` from 64 MiB to 1 GiB (the loader hashes each file when it serves it; nothing else
  depends on the total).

**Threat analysis.** The image is input to the guest kernel's EROFS driver, where the cpio was input to `vmapp-init`'s parser. Both run
inside the app's own VM, and the VM is the boundary: a driver bug reached by a hostile image gives root **in that VM**, which holds only
what the app already has (its data, its granted folders; the network rules live in the host's proxy, not in the VM). Before any of that,
the host's reader has rejected every image outside the subset (SPEC §2.1), and the SHA-256 in the manifest pins the exact bytes
(INV-F1). The mount is read-only, `nosuid` and `nodev`, and the walk at boot applies the same tree rules as the cpio extraction.

**Invariants.** INV-F1 gains one line (the core is `core.cpio` or `core.erofs`, checked entry by entry); INV-D4 holds as it is (`/app`
is read-only either way). `core.image` is absent from the canonical form when it is `"cpio"`, so every existing package keeps its id.

**Tests.** `tests/unit/erofs.test.js` (the writer, the reader and the damaged images it refuses, pack/verify/install), and `tests/e2e.sh`
run whole with the test core packed as `core.erofs` (`VMAPP_CORE_ECHO=…/core-echo.erofs`: 264 of 264 checks in a real VM).

## 9. What the VS Code app does with them

`ui.features: ["workers","wasm","frames","self-fetch","network"]`, `network: [{host:"*",ports:"*"}]` (the user decides), `ports`
forwarding, the clipboard, runtime `node22-dev`. The app keeps the real `vscode-oniguruma` (WebAssembly) and runs tokenization in a
worker, serves webviews from `vmapp-frame://{{uuid}}.webview/…`, uses Open VSX as its marketplace (the server and the window reach it
through the proxy), forwards ports through VS Code's own Ports view (`tunnelProvider`), and saves downloads through the core's save dialog.

## 10. Planned, not built: full transparency of an app's traffic (requested 2026-10-17)

The maintainer asked for this to be planned now and built later. It fits the platform unusually well: **the VM has no network device**,
so every byte an app's core sends already passes through one place, the host's proxy in `vmapp-vm` (§8.3); with C3 the window's traffic
passes through the same place. No driver-level capture is needed.

**T1 · Domains, live.** A per-app list of every domain the app (core and window) contacted, with counts and the last time, and a checkbox
per domain to block or allow it from then on. Most of it exists: every connection is already a `net` event (host, port, bytes, allowed
or refused), and the card's **Network…** already changes grants on a running app (`syncNetwork`). Missing: a domain view that groups the
events, and a per-domain *block* under an `*` grant (a deny rule that wins over `*`, checked by `net.rs` before the allow rules).

**T2 · Full inspection (opt-in per app, "Inspect traffic").** URLs, query parameters, headers and bodies of requests and responses,
browsable in the Inspector and savable as a HAR file. How: the host proxy terminates TLS for that app with a **per-app certificate
authority** generated on the Mac, whose certificate is placed only in that app's VM trust (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`,
the runtime's CA bundle path; the window's partition trusts it through Electron's `setCertificateVerifyProc` for that partition only),
records the decrypted exchange, and opens its own TLS connection to the real server (verifying it normally).
- *Limits:* certificate pinning, programs with their own trust store, HTTP/3 (UDP is not carried anyway), and non-HTTP protocols over a
  tunnel (ssh, databases) show only host, port and bytes.
- *Invariants:* INV-N4 says today that the host never reads contents. T2 changes that **only for an app the user switched to Inspect
  traffic**, shown permanently on its card and in the monitor; logs stay on the Mac, in the app's folder, never sent anywhere (INV-G3),
  and are deleted with Reset. Secrets (tokens, passwords) will be in the log: the UI says so and masks `Authorization`/`Cookie` headers
  by default.
- *Consent:* a loader-owned switch per app, off by default; not available to the app itself (INV-B5, INV-D3).

**T3 · The user's own firewall: domains and URLs** (requested 2026-10-17; planned with T1/T2). The maintainer asked for D9010 VmApp to act as
the router and firewall of every app: the user decides which domains and URLs any app may reach, below the app, whatever the app asks.
The seam exists: the VM has no network device and the window's network goes through the same endpoint (C3), so `vmapp-vm` is already
the one router for both.
- *Domains:* the user's rules, global (all apps) and per app, `deny` winning over every grant (a deny list checked by `net.rs` before the
  allow rules; the same matcher as `permissions.network`). Works for the core and the window alike, without reading any traffic.
- *URLs, window:* the loader sees every full URL before encryption (the partition's request filter): URL rules (prefix or pattern,
  deny-first) apply there exactly, without inspection.
- *URLs, core:* inside TLS the host sees only the name. URL rules for the core need T2's opt-in inspection of that app; without it they
  apply to plain HTTP only, and the UI says so. No DNS in the VM, so there is no DNS path around the rules.
- *Invariants:* INV-N2 gains "the user's deny rules win over every grant"; the rules come only from the loader's own UI (INV-D3).

## 10b. Planned, not built: a file access log at the OS level (requested 2026-10-17)

The maintainer asked for a log of every file an app touches: when, which process, which exact binary, read or write, whatever the
caller, kept in a ring of a size the user picks. A VM makes this possible where macOS does not: **the kernel and `init` are ours**.
- *How:* `vmapp-init` marks the app's file systems with **fanotify** (`FAN_MARK_FILESYSTEM`; events `FAN_OPEN`, `FAN_ACCESS`,
  `FAN_MODIFY`, `FAN_CLOSE_WRITE`, `FAN_OPEN_EXEC`, with `FAN_REPORT_DFID_NAME` for names). Each event carries the pid; the guest adds
  the binary (`/proc/<pid>/exe`) and the command line. Default scope: the folder grants (`/host/*`) and `/data`; the app's own read-only
  `/app` image and the runtime are left out unless the user asks (noise). The app cannot hide from it: it reaches the Mac's files only
  through these mounts.
- *Lightweight:* events are coalesced in the guest (one entry per pid, file and kind per second, with a count), batched, and sent over a
  vsock port of their own to `vmapp-vm`, which appends compact segments (one per hour, compressed) under the app's data folder on the
  Mac. **Retention is the user's choice** (1 h, 5 h, 24 h, 1 week, 2 weeks): whole old segments are deleted, so the log never grows past
  its window; a size cap is the second bound.
- *What the user sees:* an Inspector "Files" tab (time, process, binary, file, read/write/exec, with filters such as "which binaries
  touched this folder?"), and totals on the card.
- *Later, the same mechanism can block:* `FAN_OPEN_PERM` lets the guest refuse an open before it happens (a per-folder "only these
  binaries" rule). Not part of the first step.
- *Seams:* the guest kernel needs `CONFIG_FANOTIFY` (and `CONFIG_FANOTIFY_ACCESS_PERMISSIONS` for the later block): neither is in
  `kernel/vmapp-guest.config` today; a vsock port is reserved in SPEC 4 when it is built; the event format follows the `net` events
  (names and counts, never contents).

## 11. Build order and status

Every capability is generic (any app may declare it) and lands with its SPEC/GOVERNANCE text and tests; "App" rows are VS Code.
Priorities as the maintainer set them on 2026-10-17: the platform's core abilities first (clipboard, menus and shortcuts, network,
ports, links), the marketplace kept to Open VSX for now. **Order set on 2026-10-17 after step 10:** first tier C4 ports (11), C8 links
(12), C6 developer runtime (17), the web worker extension host (14), signature verification (15), downloads/new window/leave page (18);
then sign-in and Settings Sync (13), Copilot (16); then T1/T2 with T3 (19) and the test gaps (20); the file access log (21) later.

| # | Step | Status |
|---|---|---|
| 1 | C1 window features: workers, WebAssembly, self-fetch, isolated frames (webviews) | done |
| 2 | App: webviews, workers, WebAssembly in VS Code | done |
| 3 | C7 `core.erofs` and the size limits | done |
| 4 | App: VS Code with nothing left out (all but Copilot) | done |
| 5 | C2 network `*`: any public host, any port | done |
| 6 | App: VS Code asks for `*`; the network test phase | done |
| 7 | App: marketplaces (Open VSX by default, the Visual Studio Marketplace by a command) | done (icons since step 10) |
| 8 | **C5 the clipboard**: windows and cores, per-app device grant | done |
| 9 | C9 native menus: an app's menus in the Mac menu bar with their shortcuts (`menu.set`, data only) | done (VS Code: patch 0005, its whole menu bar) |
| 10 | C3 the window's own network through the app's proxy (icons, README images, web content in webviews) | done |
| 11 | C4 port forwarding: the VM's servers on the Mac's localhost; `http://localhost` links | done (VS Code: Ports view; in-window Simple Browser not yet) |
| 12 | C8 links and sign-in callbacks: `vmapp://` app links; loopback redirects forwarded for a sign-in | done (SPEC 8.9; loopback redirects through C4); a loader CDP run for links still to add |
| 13 | App: sign-in (GitHub, Microsoft), Settings Sync | planned |
| 14 | App: the web worker extension host in an isolated frame | done (patches 4, 6; `shim/exthost/`) |
| 15 | App: extension signature verification with open code | Open VSX done (patch 8, `core/sigverify.js`); Microsoft's: timestamp, revocation and key usage still to do |
| 16 | App: Copilot; git over HTTPS (`core/git`) | git over HTTPS done; Copilot planned |
| 17 | C6 developer runtime and a writable system layer | planned |
| 18 | App: Download to the Mac, New Window; loader: "leave page?" parity | done (loader "leave page?": SPEC 7, run U; VS Code: Download… and New Window, `vscode-ui.mjs` 9a/9b) |
| 19 | T1 domains live with a per-domain block; T2 full inspection with HAR export; T3 the user's domain and URL firewall (§10) | planned |
| 20 | Test gaps: language detection, tree-sitter, debugging | planned |
| 21 | The file access log at the OS level, with the user's retention (§10b) | planned (later) |
