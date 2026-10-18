# D9010 VmApp governance: the invariants

**For:** every contributor, human or AI agent, and every reviewer. These rules define what D9010 VmApp *is*. A change that
breaks one isn't an improvement to D9010 VmApp; it's a different product. They can only be changed by the maintainer, in a
separate pull request that changes this file and [SPEC.md](SPEC.md) and states why.

Everything else is open: performance, refactoring inside a component, better tooling, new tests, docs, samples, new
SDKs for other languages, and protocol extensions that go through the spec process (§4).

- Reviewers follow [docs/REVIEWING.md](docs/REVIEWING.md).
- `tools/check-invariants` checks the mechanical parts automatically.

Each invariant has an ID, the rule, why it exists, and how to verify it. Cite IDs in reviews and commit messages.

---

## 1. The invariants

### A. The split: where code runs

**INV-A1 · App code never runs privileged on the host.**
- **Rule:** the only app-supplied code that runs on the host is the app's UI, in a sandboxed renderer.
- **Forbidden:** app-supplied preloads, main-process plugins, native addons loaded by the loader, `eval` of
  app-supplied strings in the loader, and host processes started with app-supplied paths or commands.
- **Host processes, exactly:** `hostlib/session.js` may start `vmapp-vm` or, for an app on the experimental Vulkan backend
  (SPEC 8.7, INV-H8), `vmapp-vm-krun` (and the OS opener for a confirmed link);
  `hostlib/hostproc.js` may start only `vmapp-hostctl`, user-registered tools and user-registered MCP servers
  (SPEC §8.2) and the loader's own bundled GPU server, always as `/usr/bin/sandbox-exec` with the bundled sandbox
  profile first (SPEC §8.6, INV-H7), with `spawn` and an argv array, never a shell (`shell:` unset or `false`),
  never `exec`/`execSync`.
  The command is the hostctl path, a catalog entry written by the user (INV-H1) or the bundled GPU server; app-supplied
  values reach a process only as arguments, after INV-H4's checks (nothing an app supplies reaches the GPU server's
  command line at all). No other file in `loader/` or `hostlib/` uses `child_process`.
- *Why:* this is the whole point of D9010 VmApp. *Verify:* nothing in `loader/` or `hostlib/` executes, `require`s or
  evals package content. Package content is only *served* to renderers (`vmapp-ui://`) or *passed* to the VM.

**INV-A2 · An app's core runs only inside that app's VM.**
- **Rule:** one VM per running app. VMs are never shared between apps, and a core never runs on the host, not even
  in "dev mode" in the loader.
- *Why:* isolation between apps, and from the host. *Verify:* `AppSession` spawns exactly one `vmapp-vm` per app;
  nothing else runs package content.

### B. The renderer (app UI on the host)

**INV-B1 · App windows are sandboxed.**
- **Rule:** every app `BrowserWindow` has these `webPreferences`:

  | Setting | Value |
  |---|---|
  | `contextIsolation` | `true` |
  | `sandbox` | `true` |
  | `nodeIntegration` | `false` |
  | `nodeIntegrationInWorker` | `false` |
  | `nodeIntegrationInSubFrames` | `false` |
  | `webSecurity` | `true` |
  | `webviewTag` | `false` |
  | `allowRunningInsecureContent` | `false` |
  | `partition` | `persist:vmapp-<id>` (its own partition) |
  | `preload` | **the loader's own** `preload-app.js` |
  | `devTools` | `params.devTools === true`: **exactly what the app's core asked for in that window's `window.create`** (SPEC §6, §7), default `false`, in dev and packaged builds. Never a constant, a build mode, an environment variable or anything the renderer says. |

- **DevTools:** an app decides for its own windows, exactly like Electron's `webPreferences.devTools`. There is no
  manifest field for it. Everything else about DevTools stays closed: the loader's own windows get `devTools:
  !cfg.isPackaged` (never in a packaged build); the View-menu item (⌥⌘I) only acts on an app window created with
  `devTools: true`; a packaged loader closes DevTools the moment they open on any other window (the `devtools-opened`
  handler); and remote-debugging switches stay refused in packaged builds.
- *Verify:* `tools/check-invariants` (rule `b1-window-prefs`: the `devTools` form of every window, no other source of
  `devTools` anywhere in `loader/`, and the `devtools-opened` closer).

**INV-B2 · The renderer's only API is `window.vmapp`.**
- **Rule:** `preload-app.js` exposes exactly `invoke`, `send`, `on`, `menu` (`set`, `onClick`: the window's menus, data only;
  *proposed 2026-10-17, DEV-APPS C9, effective on merge*), `app` and the `ipcRenderer` alias (SPEC §7). Adding anything is a
  spec change.
- **IPC routing:** IPC from a renderer is routed by the sender's `webContents` id, never by a renderer-supplied
  app id or window id.

**INV-B3 · The renderer has no network of its own and no navigation.**
- **CSP:** every `vmapp-ui://` response carries SPEC §7's CSP, or a stricter one, **plus exactly the sources of the window
  features the installed manifest declares** (SPEC 2.2 `ui.features`, SPEC 7's table; *amendment proposed 2026-10-17 on the branch
  `vscode-full`, docs/design/DEV-APPS.md C1, effective when the maintainer merges it*). `connect-src` is `'none'`, or `'self'` with the
  feature `self-fetch` (the app's own package files, still no network). No feature adds `'unsafe-inline'` or `'unsafe-eval'` to the
  page. Only the feature `network` adds network sources, and only `https:` (with `wss:` for `connect-src`) to the data directives
  `connect-src`, `img-src`, `media-src`, `font-src`, `style-src`: never to `script-src`, `worker-src`, `frame-src`, `object-src` or
  `default-src` (*proposed 2026-10-17, DEV-APPS C3, effective on merge*).
- **Isolated frames:** `vmapp-frame://` exists only for an app that declares `frames`; it serves the same verified files (INV-B4) with
  SPEC 7's frame CSP; frames get no `window.vmapp` and no permission. Service workers run only there.
- **The network boundary:** every app partition cancels every request whose scheme is not `vmapp-ui:`, `vmapp-frame:`, `data:`,
  `blob:` or `devtools:` (the request filter). It is the boundary for frames, whose CSP may name `https:` only so that their service
  worker can answer such URLs. **One exception** (SPEC 8.3 "The app's windows", *proposed 2026-10-17, DEV-APPS C3, effective on
  merge*): for an app that declares `network`, while its run's window endpoint is set, `windowNetAllowed` (`loader/src/window-net.js`)
  lets out `https:`/`wss:` requests of the data kinds only (fetch/XHR, WebSocket, image, media, font, style sheet), to host names
  only (no address, no local name, no credentials in the URL), and the partition's proxy is that endpoint (`<-loopback>`), where
  `vmapp-vm` applies the app's network rules (INV-N1 to INV-N4). Never `http:`/`ws:`, a script, a frame, an object or a worker from
  the network. The loader answers a proxy authentication only for that endpoint and that app's own partition
  (`windowProxyCredentials`); it answers no other authentication. Only the window manager sets a partition's proxy.
- **Navigation and popups:** navigation outside the app's origin is blocked, and `window.open` is denied.
- **Device permissions:** all permission requests (camera, microphone, notifications, geolocation, screen sharing, …) are
  denied unless a SPEC-defined permission exists and the user granted it. Two exist: the **microphone** (SPEC 2.2
  `permissions.devices`, §8.4) and the **clipboard** (§8.4; `clipboard-read` and `clipboard-sanitized-write` only, through
  `clipboardRequestAllowed` / `clipboardCheckAllowed`, with the microphone gate's conditions: this app's own main frame, the
  manifest asking, the user's grant read at every request; *proposed 2026-10-17, DEV-APPS C5, effective on merge*; the checker
  verifies its gate the same way).
  - *The gate:* an app window's permission handlers answer `true` only through `microphoneRequestAllowed` /
    `microphoneCheckAllowed` (`loader/src/devices.js`). `true` needs all of: `getUserMedia` with `mediaTypes` exactly
    `["audio"]` (video, alone or with audio, is denied as a whole), the main frame of one of this app's own windows, the
    manifest asking for the microphone, **and** the user's saved grant. The grant is read at every request.
  - *Never:* the camera; a grant that comes from anything but the user (INV-D3); a handler that answers `true` any other way;
    any permission for a loader-owned window or the default session; either fake-media switch in a packaged build
    (`--use-fake-ui-for-media-stream` would skip the gate altogether, so no test of the gate may use it).
  - *Verify:* `tools/check-invariants` (rule `b3-csp-nav-perms` reads the handlers and the gate), `tests/unit/devices.test.js`
    (every denied path) and the loader's CDP run H (an app without a grant cannot open the microphone, video and screen sharing
    stay rejected, a hand-written grant for an app that never asked is ignored, revoking applies at once).
- *Verify (the network boundary):* `tools/check-invariants` (rule `b3-csp-nav-perms`: the filter's exact form; it evaluates
  `loader/src/window-net.js`, a self-contained module, and runs its own refused vectors against it, with and without an endpoint;
  `windowProxyCredentials`, the one `login` handler, `setProxy` only in the window manager and only to the endpoint or direct, and
  no log line with the secret), `tests/unit/window-net.test.js`, `cargo test` in `host/` (the endpoint's tests) and the loader's
  CDP run W (a real app window: refused without the grant, allowed with it, a script from the network refused, a revoke at once).

**INV-B4 · UI files are verified before they are served.**
- **Rule:** the `vmapp-ui://<id>/` handler serves only files listed in the installed manifest, with matching
  SHA-256, from inside that package's UI root.
- **Paths:** after decoding and normalising, the path must be inside the UI root, with no `..`, no absolute paths
  and no symlinks.

**INV-B5 · Real decisions are never made in app UI.**
- **Where:** permission sheets, grants, install review, reset and uninstall happen in loader-owned windows or native
  dialogs that name the app.
- **What app windows can't do:** draw loader chrome or set a title without the app-name suffix.

### C. The bridge

**INV-C1 · All UI ↔ core traffic goes through the host session.**
- **Rule:** no direct channel between a renderer and a VM: no network ports, shared files used as channels, or
  shared memory.
- *Verify:* the only connection to a VM is `vmapp-vm`'s bridge socket, used only by `hostlib/bridge.js` and
  `hostlib/session.js`.

**INV-C2 · Every core → host request is in the spec and checked.**
- **Rule:** the request ops in `hostlib/session.js` are exactly SPEC §6's table.
- **Checks:** each one is permission-checked against the manifest and the user's choices, and denied by default.
  Unknown ops get an error reply.
- **New ops:** a new op needs a SPEC change (§4), a permission check, and a test of the denied path.

**INV-C3 · The bridge carries only data.**
- **Rule:** messages are JSON. The host never interprets message content as code, paths to execute, or host file
  paths.
- **Paths from the core:** these are VM paths, and have no meaning on the host.

### D. The VM and its boundary

**INV-D1 · The VM has no network device**, now and with the network permission (amended 2026-10-15).
- **Rule:** no NAT, bridged or file-handle network attachment in the VM configuration. This does not change when an
  app is granted network access.
- **How network exists:** as the SPEC §8.3 permission, through the host-controlled allowlist proxy (guest listener on
  `127.0.0.1:3128`, vsock ports 1022 and 1025, `vmapp-vm` as the only party that opens sockets to the internet). It is
  never a raw device. The rules for that proxy are INV-N1 to INV-N4.
- *Verify:* `tools/check-invariants` (rule `d1-no-vm-network` is unchanged and still fails on any network device; rules
  `n1-no-guest-egress` and `n3-address-check` cover the proxy side).

**INV-D2 · Only user-granted host paths are shared, and the host enforces their access.**
- **What may be shared:** the app's own data folder, folders the user granted at launch, and dialog grants.
- **Enforcement:** read-only is enforced by the hypervisor's share flag. Write-only is enforced by a staging folder,
  and **the destination is never shared**.
- **File picks:** shared as clones in a fresh folder, never with their siblings.
- **Never:** a share created from a manifest field or a core request without a user decision.

**INV-D3 · Grants come only from the user.**
- **Where they come from:** the permission sheet, open or save dialogs, or the CLI's explicit `grant` and `grant-net`
  commands.
- **Storage:** they're stored per app id, and can be revoked or reset.
- **Never:** an auto-grant because an app asked.

**INV-D4 · Inside the VM, the core is unprivileged and the system is read-only.**
- **The core:** uid and gid 1000, `setgroups([])`, `no_new_privs`, and chroot to the runtime root.
- **The system:** the runtime root and `/app` are read-only.
- **Writable places:** only `/data` (the app's own), granted shares, `/tmp` and `/run`. The core may also open
  pseudo-terminals in its own devpts instance at `/dev/pts` (`newinstance`, nosuid, noexec).

**INV-D5 · Grants never disturb existing mounts.** A runtime grant uses its own device slot (SPEC §4). A grant or
revoke must never change the static share device or other slots.

### E. Lifecycle and the launcher

**INV-E1 · A VM never outlives its loader.**
- **How:** `vmapp-vm` stops its VM when its parent dies (kqueue), on stdin EOF, and on SIGINT, SIGTERM or SIGHUP.
- **On every stop path:** write-only outputs are delivered.

**INV-E2 · The launcher and init never panic.**
- **Launcher:** `vmapp-vm` uses no `println!`, `eprintln!` or `print!` (they panic on closed pipes; a crashed
  parent would leave a VM running).
- **Init:** `vmapp-init` (PID 1) has no `unwrap`, `expect` or panicking index outside tests.

**INV-E3 · The launcher keeps its protocol.**
- **Rule:** its CLI, stdout lines and stdin ops (SPEC §5) change only through the spec.
- **Stopped line:** `stopped` is always the last line.

### F. Packages and runtimes

**INV-F1 · Packages are strict and fully hashed.**
- **What gets rejected:** the reader rejects anything outside SPEC §2: links, devices, pax headers, duplicates,
  unknown entries, unknown manifest keys, and a wrong order.
- **Hashes:** every file is in `files` with a SHA-256, checked at install **and** at serve time.
- **The core:** `core.cpio` or `core.erofs`, exactly the one `core.image` names; the reader checks every entry of either
  against SPEC §2.1 at pack, verify and install, and the guest applies the same tree rules again at boot (it extracts the cpio,
  or walks the mounted image). *(`core.erofs`: proposed 2026-10-17, docs/design/DEV-APPS.md C7; effective on merge.)*
- **Compatibility:** breaking format changes bump `format`.

**INV-F2 · Runtimes are platform components.**
- **Rule:** runtime images are built only by `tools/mkruntime` from `runtimes/*/Dockerfile`, with base images
  pinned by digest, reproducibly.
- **Never:** an app supplies or modifies a runtime.

### H. Host capabilities (SPEC §8.2, accepted 2026-10-15)

**INV-H1 · Capabilities come from the loader and the user, never from apps.**
- **Who defines them:** built-ins, plus the user's `tools.json` and `mcp.json`, edited only in loader-owned UI or
  with the host CLI.
- **What apps can't do:** no package field, bridge message or renderer call can add, define or change a tool, an
  MCP server or a grant.
- **Manifests:** they name capabilities, never paths or commands.

**INV-H2 · Every host capability is off until the user grants it, per app.**
- **Default mode:** `ask`.
- **Never `always`:** `input` and `shell` tools can't be granted `always`.
- **The GPU is the exception to `ask`:** `gpu` (SPEC §8.6) is a stream of requests, so its only mode is `session`
  ("Allow while the app runs"); there is no `ask` and no `always` for it, and not allowing it is having no grant.
- **Updates:** a version update that adds a host capability always stops and asks (SPEC §8.1).

**INV-H3 · Control is always visible and stoppable.**
- **Visible:** while input control or a shell tool is active, the loader-owned badge is on screen. During input
  control, the click-through overlay shows the virtual cursor and key activity (typed text masked by default). The
  overlay never intercepts real input and is excluded from captures.
- **Stoppable:** the panic shortcut stops everything at once.
- **Time-limited:** input sessions expire.
- **Logged:** every use appears in the Inspector.

**INV-H4 · Tools run constrained.**
- **No shell interpretation:** `execFile` with checked arguments, a clean environment, timeouts and output limits.
- **Path arguments:** they map only to host paths the user already granted (`/host/...`).
- **Shell tools:** the only unconstrained kind, explicitly labelled.

**INV-H5 · Nothing moves through host capabilities except what the op returns.**
- **What the core gets back:** screenshots, tool output and MCP results go only to the requesting app's core.
- **No new channels:** no new channel opens between the VM and the host, and the VM still has no network device
  (INV-D1). (A host service, INV-H7, rides the network channel of §8.3: the same two vsock ports.)

**INV-H6 · Registry honesty.** Packages requesting `input`, `shell`-capable tools (`tool:*`) or `mcp:*` are labelled
"requests control of your computer" on the registry and in the loader's install review.

**INV-H7 · A host service is a loopback endpoint the loader started, named by the guest, and its server is sandboxed.**
(SPEC §8.6, the GPU.)
- **The launcher:** `vmapp-vm --service NAME=127.0.0.1:PORT` is the only way it learns of a service, and the endpoint must be
  the IPv4 loopback literal with a port. The flag is built in `hostlib/session.js` from the GPU broker's own endpoint, never
  from a manifest, a grant, the guest or the bridge. The guest names a service (`service-open`, a fixed list of known names);
  the launcher maps the name to the endpoint it was started with and to nothing else. No address, host name or port from
  the guest reaches a socket call on the service path, and the network path cannot reach a service (`net-open` of
  `service:gpu` is not a host name; no rule can name one).
- **The server:** the bundled `rpc-server` runs only as `/usr/bin/sandbox-exec -f <bundled profile> …`, one per app run, on a
  port the loader picked, and the profile is a closed list: deny by default; one loopback TCP port; the GPU's user clients;
  the shader compiler; the one writable place is the user's Metal shader cache. Anything else needs a change of the rule
  that checks it, which is a protected-path change.
- **Off until granted, stoppable at once:** the `gpu` capability follows INV-H1 to INV-H3 (the user's grant, per app, mode
  `session` only); revoking, panic, the app stopping and the loader quitting stop the server and close every tunnel; a server
  a crashed loader left behind is stopped at the next start.
- **Visible and private:** every server start/stop and every tunnel is an Inspector row with byte counts (INV-N4's rule:
  names and counts, never contents).
- *Verify:* `tools/check-invariants` (rule `h7-gpu-service`: `ServiceSpec::parse` accepts only the loopback literal, the
  service path makes one socket call to the address from the service table, `--service` is parsed and built in one place
  each, `sandbox-exec` is started in `hostlib/hostproc.js` only, and `gpu/rpc-server.sb` is exactly the reviewed profile),
  `cargo test` in `host/` (the service tests of `net.rs`), `tests/unit/gpu.test.js`, `tests/e2e.sh` scenario 12 (the denied
  paths) and `tests/gpu/` (the real sandbox on a real GPU, including what the sandbox refuses).

**INV-H8 · The experimental Vulkan backend runs only when asked for, allowed and enabled, and its VMM is sandboxed.** (SPEC 8.7, the Vulkan GPU in the VM.)
- **Three switches, all required:** the manifest asks for `{cap:"gpu", api:"vulkan"}` (runtime `node22-gpu`), the user's saved grant for `gpu`
  records `api:"vulkan"` (a grant for the plain `gpu`, the llama.cpp RPC service, is not one), **and** the loader setting "Experimental GPU
  (Vulkan)" is on. `hostlib/gpu.js` `chooseBackend` decides, `hostlib/session.js` acts; a manifest, the guest or the bridge cannot choose the
  backend. Off by default, labelled **Experimental** wherever the user decides.
- **The VMM is a separate, sandboxed process.** `vmapp-vm-krun` (the launcher: bridge, shares, network proxy, watchdog) never loads the GPU stack.
  Its child, the VMM, loads libkrun (virtio devices, the Venus decoder, MoltenVK, Metal) and enters the deny-by-default profile `gpu/krun/vmm.sb`
  before it creates the VM: no network, no program to start, no signals to others, files only as parameters the launcher built from its own command
  line (the VM's kernel, images and shares), Unix sockets only in the VMM's run folder. A change to what the VMM may do is a maintainer-reviewed
  change of the rule that checks it (`h8-krun-sandbox`).
- **No new channel, no network device (INV-D1, INV-H5):** libkrun is built without its network code; the VM gets a plain vsock device (no socket
  hijacking); the network is still only §8.3.
- **The same invariants hold:** INV-D2 (only granted folders; runtime grants are refused on this backend), INV-D3, INV-D4, INV-E1 to INV-E3
  (the VMM follows the launcher; the launcher keeps the protocol; the stopped line is last; its extra reasons `gpu-hang` and `vmm-crashed` are in SPEC 5),
  INV-N1 to INV-N4 (the proxy code is shared).
- **Test switch:** `--dev-no-sandbox` leaves the profile out. It is parsed by the launcher's command line only and is never passed by the loader, a manifest or the bridge.
- *Verify:* `tools/check-invariants` (rule `h8-krun-sandbox`), `cargo test` in `host/`, `tests/unit/gpu.test.js`, `tests/gpu-vulkan/krun-e2e.sh` (scenario 9: the VMM is a
  child that holds the GPU libraries and no inet socket; scenario 2: the refused grants) and `tests/gpu-vulkan/run.sh` (a real GPU in the sandbox).

### N. Network (SPEC §8.3, accepted 2026-10-15)

**INV-N1 · The only way out is the allowlist proxy.**
- **Rule:** an app's core reaches the internet only through the guest proxy and `vmapp-vm`. The VM has no network
  device (INV-D1), no route and no DNS. The guest never opens an outbound socket of its own: `vmapp-init` only
  listens on loopback and on vsock.
- **Who opens sockets:** only `vmapp-vm`, in `host/src/net.rs`, after the checks of INV-N3. Nothing in `loader/`
  or `hostlib/` connects on behalf of an app.
- **The app's windows** (SPEC 8.3 "The app's windows", *proposed 2026-10-17, DEV-APPS C3, effective on merge*): an app that
  declares the window feature `network` gets a second door into the same proxy, `vmapp-vm`'s window endpoint, a `CONNECT`
  proxy on `127.0.0.1` that needs the run's secret. Chromium connects to that endpoint only; the internet connection is still
  opened by `vmapp-vm`, after the same checks. The endpoint listens on the IPv4 loopback address only.
- **Port forwarding** (SPEC 8.8, *proposed 2026-10-17, DEV-APPS C4, effective on merge*): with the device `ports` allowed,
  `vmapp-vm` listens on the Mac's `127.0.0.1` for a port of the VM and carries each connection **into** the VM. The guest's one
  outbound connect is there, in `guest/src/portfwd.rs`: to `127.0.0.1` inside the VM (its own loopback, an address fixed in the
  code), on the port the host names. A forward never carries anything out of the VM.
- *Verify:* `tools/check-invariants` (rule `n1-no-guest-egress`: the guest contains no outbound `TcpStream::connect`,
  `UdpSocket` or `connect(2)` except the one in `portfwd.rs`, of exactly that shape, and listens on no wildcard address; rule
  `n3-address-check`: every `TcpListener::bind` of the launcher is on `Ipv4Addr::LOCALHOST`).

**INV-N2 · Network is off until the user grants it, per app and per host.**
- **Default:** deny. A manifest request allows nothing; the user's grant, per entry and per port, does.
- **Never:** an auto-grant because an app asked, a grant for a host the manifest does not list, a grant wider than the
  request, or a wildcard the user did not see. `*` (any public host) and `"ports": "*"` are requests like any other: their
  own entry, off until allowed, shown as "any server on the internet" in words the loader writes. *(Proposed 2026-10-17,
  docs/design/DEV-APPS.md C2; effective on merge.)*
- **Updates:** a new version that adds a host or a port always stops and asks (SPEC §8.1). Revoking applies at once,
  to open connections too.
- **Where grants come from:** the permission sheet and `vmapp grant-net` only (INV-D3). Nothing reachable from an app
  can add one.

**INV-N3 · The host decides, and trusts nothing the guest says.**
- **Every connection:** checked by `vmapp-vm` against the current rules: exact host, `*.suffix` or `*`, and the port (or
  every port). Names only: no IP-literal destinations, under `*` too.
- **Addresses:** the host resolves the name and refuses the connection if **any** answer is private, loopback,
  link-local, CGNAT, unique-local, multicast, reserved or an IPv4-mapped or embedded one of those. It connects to the
  address it checked (no second lookup). A rule can never name an address, so the app cannot reach the LAN or the Mac,
  whatever the rules allow (`*` included: `tests/e2e.sh` 10e/10f).
- **Bounds:** at most 64 connections per app, 10 s to resolve and connect, 5 min idle, bounded line and event sizes. The
  windows' connections have a cap of their own (64), so neither side can starve the other.
- **The windows too:** a window's `CONNECT` gets the very same decision (the name, the rules, the address check, the connect
  to the checked address), and a revoke closes window tunnels as it closes the core's.
- **Test switches:** `--dev-allow-loopback` and `--dev-resolve` exist for tests and developer tools. They are never
  passed by the loader, any code under `loader/`, a manifest, a grant or a bridge request.
- *Verify:* `tools/check-invariants` (rule `n3-address-check`: only `host/src/net.rs` connects, and only after
  `check_addresses`; the test switches appear nowhere in `loader/` and only in `hostlib/session.js`), the unit tests of
  the matcher and the address classes (`cargo test` in `host/`, `tests/unit/network.test.js`), and `tests/e2e.sh`
  scenario 10 (the denied paths).

**INV-N4 · Network use is visible, and the host never reads it.**
- **Visible:** every connection, allowed or refused, becomes a `net` event for the Inspector with host, port, bytes and
  timing. Refusals say why. A window's connection is marked `window` (only a client without the run's secret, which is not the
  app, gets no event).
- **Private:** TLS stays end to end through `CONNECT`. The host logs names, ports and byte counts, never contents.
- **Honest:** where an app can read folders (or the screen) **and** reach hosts, the loader says so in words it
  writes itself (`riskSummary`), at install review and in the permission sheet. Wildcards and port 80 are marked.
- **Not telemetry (INV-G3):** this is the app's traffic, started by the app after the user's grant. The loader's own
  network use is unchanged and confined to one module.

### G. Project hygiene

**INV-G1 · The spec is normative.**
- **Rule:** a change to observable behaviour (format, lifecycle, protocol, guest contract, launcher contract) updates
  `SPEC.md` in the same pull request, with tests.
- **Review:** code and spec disagreeing is a review failure.

**INV-G2 · Security changes prove the denied path.** Any change touching a protected path (§2) adds or keeps a test
that the forbidden thing is still refused.

**INV-G3 · No secrets, no telemetry.**
- **No secrets:** none in the repository, logs or command lines.
- **No telemetry:** the loader makes no network requests, except user-initiated ones and, later, signed updates the
  user can turn off.
- **User-initiated network, defined exactly:** installing from a registry the user named; browsing or searching
  that registry in *Browse registry…*; publishing with *Publish…*; "Check for updates"; and launch-time checks for an
  app whose update choice the user set to *Latest compatible* or *Always latest* (SPEC §8.1).
- **What those requests may carry:** the app id and version only; for browsing, only the search text, sort and page;
  for publishing, the package and the owner token. No identifiers, no usage data, no list of other installed apps.
- **Where the code lives:** that network code is confined to one module.
- **Apps are separate:** an app's own traffic (SPEC §8.3, INV-N1 to INV-N4) is not loader network use. It exists only
  after the user's grant and runs in `vmapp-vm`, never in the loader.

**INV-G4 · Self-contained repository.** Changes stay inside this repository: nothing outside it is modified or
required to build, run or test it. Code copied from other projects carries a header naming its source.

---

## 2. Protected paths (maintainer review required)

A pull request touching any of these is **Class A**: it needs the maintainer's approval, whatever the reviewer
says.

| Path | Invariants it carries |
|---|---|
| `SPEC.md`, `GOVERNANCE.md` | all |
| `loader/` window creation, `webPreferences`, protocol handler, CSP, permission handlers and the microphone gate (`loader/src/devices.js`), navigation guards, `preload-app.js` | A1, B1–B5 |
| `loader/` permission sheet, install review, dialogs wording, reset/uninstall | B5, D3 |
| `hostlib/session.js` (request ops, permission checks, grants, dialogs), `hostlib/bridge.js` | A1, C1–C3, D2, D3 |
| `hostlib/package.js`, `manifest.js`, `tar.js`, `cpio.js`, `erofs.js`, `store.js` (verification, install, grants storage) | F1, D3 |
| `hostlib/network.js` (network validation, rules for the launcher, grants, risk summary) | D3, N2, N4 |
| `host/` (shim device config, shares, slots, staging and delivery, parent watch, stdin ops, the network proxy and service tunnel `net.rs`, the command line and main loop `cli.rs`, the experimental libkrun backend `krun.rs`), `host/vmapp.entitlements`, `host/krun.entitlements` | D1, D2, D5, E1–E3, N1, N3, N4, H7, H8 |
| `guest/` (mounts, extraction, privilege drop, control ops, the proxy and service listener `netproxy.rs`) | D4, D5, E2, N1, H7 |
| `gpu/` (`rpc-server.sb` the sandbox profile, `pins.env` the pinned llama.cpp commit, `build.sh`; `krun/`: the experimental Vulkan backend's `vmm.sb` sandbox profile, `pins.env`, `patches/`, `build-libs.sh`, `build.sh`), `hostlib/gpu.js`, the GPU server in `hostlib/hostproc.js` | H7, H8, A1 |
| `kernel/` (the guest kernel build: `build.sh`, `Dockerfile`, `pins.env`, `kconfig-required.txt`, `kconfig-forbidden.txt`, `vmapp-guest.config`, `container/`, `flavours/`: the `gpu` flavour's overlay, lists and patch) | D1, D4, F2 |
| `runtimes/`, `tools/mkruntime`, `tools/mkerofs.Dockerfile` | F2 |
| host capabilities: `hostlib/capabilities*`, `loader/src/capabilities*`, the control badge and panic shortcut, the capability settings UI, `host/` `vmapp-hostctl` | H1–H6 |
| `tools/check-invariants`, `docs/REVIEWING.md` | the review system itself |

**Class B** is everything else: samples, templates, docs (other than the two above), CLI conveniences, SDK
conveniences that map onto existing protocol, tests, refactors and optimizations *inside* a protected file that
provably keep behaviour. The reviewer may approve Class B on its own when every check passes.

---

## 3. Always allowed (encouraged)

- **Performance:** faster boot, faster delivery, smaller images.
- **Refactors** that keep the contracts and pass all tests.
- **Coverage:** more tests, especially of denied paths.
- **SDKs** for other languages that implement SPEC §6.
- **Docs, samples and templates.**
- **Tooling:** better errors and diagnostics, and inspector improvements (they're read-only views).

## 4. Changing the spec (protocol extensions, new permissions)

1. Open a proposal: an issue or a pull request containing only `SPEC.md` changes. It states:
   - what it adds;
   - which invariants it touches;
   - the threat analysis: what a malicious app could do with it;
   - how the user consents.
2. The maintainer accepts or rejects it.
3. The implementation follows in a separate pull request that references the accepted spec change and includes
   denied-path tests.

New capabilities (network, devices, clipboard, notifications, app groups) **always** arrive as explicit, user-granted
permissions, denied by default.
