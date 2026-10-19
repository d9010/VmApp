# Converting VS Code (Code - OSS)

A conversion of a **large, real** application, following [docs/CONVERTING.md](../../docs/CONVERTING.md) §3 and §7.1. `original` is
VS Code 1.142.0 (`microsoft/vscode`, tag `1.142.0`, commit `d956e8a6ac5d904486557eea07e1d6bd62a4d36f`), built as **Code - OSS**, the MIT
build of the repository (no Microsoft branding, marketplace, telemetry or proprietary extensions; those exist only in Microsoft's own
product build). `converted` is this folder. The original is not copied here: `build.sh` takes it from the pinned tag, and
[`patches/`](patches/) are the differences.

VS Code ships three front ends from the same source: the Electron desktop app, the browser workbench that talks to a **VS Code Server**
(`vscode-reh-web`, what `code serve-web`, Codespaces and every "VS Code in a browser" product use), and vscode.dev. The desktop app cannot
be the model here: its renderer needs Electron's preload (`vscode.ipcRenderer`, `webFrame`, MessagePorts to the main and shared
processes), which a D9010 VmApp page cannot have (CONVERTING §2). The server split is exactly D9010 VmApp's split, and Microsoft maintains it:

```
original (microsoft/vscode @ 1.142.0, target vscode-reh-web-linux-arm64)     converted (this folder; build.sh assembles core/ and ui/)
  out/vs/code/browser/workbench/* + out/vs/workbench/**  web workbench   ──►   ui/static/out/        the same bundle, unchanged
  workbench.html (rendered by the server, two inline scripts)            ──►   ui/index.html + ui/vscode-vmapp-shim.js
  out/server-main.js + out/vs/server/**  the VS Code Server              ──►   core/vscode/          the same server, its own Node 24.21.0
  extensions/*  built-in extensions (run in the server's extension host) ──►   core/vscode/extensions
  node_modules  server dependencies (node-pty, ripgrep, parcel watcher…)  ──►   core/vscode/node_modules (built for linux-arm64)
  the browser's WebSocket to the server                                   ──►   a WebSocket over the bridge (shim + core/ws-bridge.js)
```

Following the guide's advice, **the original UI/backend split is kept exactly**: the workbench keeps opening its WebSocket to the server
and the server keeps serving it; what changed is the transport between them (the bridge instead of the loopback of a browser), and the
duties of the page that the server would have rendered.

---

## 1. Inventory and classification (guide §3 steps 1 and 2)

✅ maps directly, 🔁 needs an adapter, ❌ is a format 1 gap.

| Where in the original | What it does | After conversion | |
|---|---|---|---|
| `src/vs/workbench/**`, `src/vs/editor/**` (bundled into `out/vs/code/browser/workbench/workbench.js` + `.css`, `out/nls.messages.js`, codicons) | the whole UI: editor, explorer, views, panels, command palette, settings and keybindings editors, themes, menus (the web workbench draws its own menu bar) | **unchanged**, served from `ui/static/out/` in the sandboxed window | ✅ |
| `src/vs/code/browser/workbench/workbench.html` | the page, rendered by the server: configuration in a `<meta>`, two inline `<script>`s, the NLS and workbench module scripts | `ui/index.html` (no inline script) and `ui/vscode-vmapp-shim.js`, which asks the core for the configuration and then loads the same module scripts | 🔁 |
| `src/vs/code/browser/workbench/workbench.ts` (`create(document.body, {...config, workspaceProvider, …})`) | starts the workbench with options parsed from JSON | unchanged but for a hook that lets the page add the options that are functions (patch 1) | 🔁 |
| `BrowserSocketFactory` (`new WebSocket('ws://<authority>/?reconnectionToken=…')`, `src/vs/platform/remote/browser/browserSocketFactory.ts`) | the one connection to the server: remote file system, extension host, terminals, search, everything | `webSocketFactory` option: a socket over the bridge (`ws:*` channel) to `core/ws-bridge.js`, which opens the server's upgrade on `127.0.0.1` | 🔁 |
| `RemoteAuthorities.rewrite` → `http://<authority>/vscode-remote-resource?path=…` (`src/vs/base/common/network.ts`), used by `fetch` in `extensionResourceLoaderService` and by `<img>`/`@font-face` | extension resources: grammars, themes, snippets (fetched), icons and icon fonts (loaded by the page) | `resourceUriProvider` option: the page's own origin. `fetch` → `vmapp-fetch.js` → bridge → `http-bridge.js` → the server; images and fonts of built-in extensions → copies in `ui/static/extensions/`; those of installed extensions (activity bar and tab icons: CSS `mask`/`background-image`, inline `style`, `<img>`, icon fonts) are asked for at `/vscode-remote-resource` by the browser, so `vmapp-fetch.js` (`data-media="/vscode-remote-resource"`) announces that prefix to the launcher, which answers it from the server in the VM like any file the app's server serves (SPEC 7, "Files the app's server serves"); an older launcher gets the same result from the page-side layer of `vmapp-fetch.js`. Nothing of this is in the shim | 🔁 |
| `FetchFileSystemProvider` for `http`/`https` (`src/vs/workbench/services/extensions/browser/extensionService.ts`) | the built-in web extensions' files (the default theme, grammars, snippets) are read from the page's origin | registered for the page's own scheme too (patch 2); the fetches go to the server's `/static/` route over the bridge | 🔁 |
| same-origin `fetch` of static files (`/static/…`, e.g. `vscode-oniguruma/release/onig.wasm`) | | the window feature `self-fetch` (`connect-src 'self'`): the page and its workers read the package's own files directly | ✅ (window feature) |
| `textMateTokenizationFeatureImpl.ts`, `textMateTokenizationWorker.worker.ts` + `vscode-oniguruma` (WebAssembly) | syntax highlighting (TextMate grammars) | **unchanged**: the window features `workers` and `wasm`; the tokenization worker compiles VS Code's own `onig.wasm` (tested: the TextMate worker runs, 11 token colours) | ✅ (window feature) |
| `@xterm/addon-image` (sixel and iTerm images in the terminal, WebAssembly decoder) | pictures printed by programs in the terminal | WebAssembly is allowed (`wasm`); the add-on ships with the web workbench | ✅ (window feature) |
| web workers (`editorWebWorkerMain`, `outputLinkComputerMain`, `notebookWebWorkerMain`, `localFileSearchMain`) via `webWorkerServiceImpl.ts` | diff, links, word completions off the main thread | **unchanged**: the window feature `workers` (`worker-src 'self' blob:`) lets VS Code's `blob:` bootstrap start them (tested: the editor worker runs) | ✅ (window feature) |
| `languageDetectionWebWorkerMain` (`@vscode/vscode-languagedetection`, a TensorFlow model fetched by the worker) | guess the language of an untitled file | on (VS Code's default): the worker can run (`workers`) and read its model, which ships in `ui/static/node_modules` (`self-fetch`); not exercised by the tests yet | ✅ (window feature; not tested) |
| `@vscode/tree-sitter-wasm` | experimental tree-sitter highlighting, terminal command parsing for chat | shipped in `ui/` (WebAssembly is allowed) and in the server; off by default upstream, not exercised by the tests | ✅ (window feature; not tested) |
| webviews (`src/vs/workbench/contrib/webview/browser/pre/index.html` in an `<iframe>`) | Markdown preview, extension details (README), release notes, image/audio/video preview (custom editors), notebook outputs, Simple Browser, walkthrough media | **unchanged**: the window feature `frames`; each webview is VS Code's own host page and service worker in an isolated `vmapp-frame://<id>/` origin (the page's `webviewEndpoint`), with no `window.vmapp` and no access to the page (tested: the Markdown preview renders README.md) | ✅ (window feature) |
| web worker extension host (`webWorkerExtensionHostIframe.html`, `new Function` in `extHostExtensionService.ts`) | runs browser-only extensions in the page | browser-only extensions run in VS Code's web worker extension host, started lazily (`extensions.webWorker: 'auto'`, patch 4) in an isolated frame `vmapp-frame://v--<hash>.exthost/` (patch 6, `shim/exthost/`); `eval` and the `blob:` worker happen only there, the page's CSP is unchanged. Their code comes from the marketplace through the window's network grant, or from the server through the page (MessagePort, GET of `vscode-remote-resource` only). Every other extension still runs in the server's extension host in the VM. Tested: `tests/apps/vscode-ui.mjs` 8b2 (NET) | ✅ (window feature `frames`) |
| `out/server-main.js`, `src/vs/server/node/**` (the VS Code Server) | the backend: files, extension management, settings, the extension host process, the terminal's pty host, search, file watching, logs | **unchanged**, started by `core/main.js` on `127.0.0.1` with its own Node 24.21.0 (`core/vscode/node`: the server's native modules are built for that Node, and the runtime `node22` has Node 22) | ✅ |
| `out/vs/workbench/api/node/extensionHostProcess.js` + `extensions/*` | language features (TypeScript/JavaScript, JSON, CSS, HTML, Markdown, PHP, Emmet), npm scripts, merge conflicts, references, search results, debugging (js-debug, a pinned built-in) | **unchanged**, in the VM (the built-ins that could also run in the page are pinned to it: `remote.extensionKind`, a configuration default). Debugging is not exercised by the tests | ✅ |
| `node-pty`, `ptyHostMain` | the integrated terminal | **unchanged**, in the VM (devpts, SPEC §4); the shell is the runtime's `bash` | ✅ |
| `@vscode/ripgrep` (`rg`) | search in files | **unchanged**, linux-arm64 `rg` in the VM | ✅ |
| `@parcel/watcher` (`watcherMain`) | file watching | in the VM; virtiofs delivers no notifications for edits made **on the Mac**, so the server polls the open folders every 3 s (`--file-watcher-polling 3000`, which needs patch 3, an upstream bug fix) | 🔁 |
| `extensions/git` + the `git` program | source control | the extension is unchanged; `git` is not in the runtime: Debian bookworm's git (the runtime's release, pinned by a snapshot) in `core/git`, with its HTTP transports (libcurl and the libraries the runtime lacks, from the same Debian snapshot, in `core/git/lib`, found through an `$ORIGIN` RUNPATH). Tested: `git ls-remote` of github.com over HTTPS through the network grant (`tests/apps/vscode.mjs`, phase `network`) | 🔁 |
| `DiskFileSystemProvider` on the server, `File > Open Folder…` (the web workbench's own file dialog over the server's files) | which folder you work on | a manifest folder `workspace` (read-write, opened by default, `/host/f-workspace`); **Open Folder from Your Mac…** → `dialog.showOpenDialog` (read-write, `/host/pick-N`, this run only); the built-in dialog browses the VM (`/data`, `/host/…`) | 🔁 |
| `--server-data-dir` (machine settings, global storage, secrets kept by the server, installed extensions, logs) | persistent state of the server | `/data/vscode-server` (`HOME=/data`: the terminal's dotfiles too) | ✅ |
| IndexedDB / localStorage of the page (`vscode-userdata` user settings and keybindings, UI state, workspace state) | persistent state of the window | **unchanged**: the app's own partition (`persist:vmapp-<id>`), kept across runs | ✅ |
| `window.open`, links (`IOpenerService`, `windowOpenNoOpener`) | open a link in the browser | shim: `https:` links → core → `shell.openExternal` (the platform asks the user) | 🔁 |
| `workspaceProvider.open(…, {reuse:false})` → `window.open` | New Window, open a folder or workspace in a new window | the shim sees VS Code's `window.open(<page>?ew=true\|folder=\|workspace=…)` and asks the core (`vscode:new-window`), which opens another app window on the same page; the query reaches it through `vscode:config` (`location`) and the page applies it with `history.replaceState` before the workbench starts. Each window is its own workbench with its own WebSockets to the one server (`ws-bridge.js` keys sockets by window); closing a window keeps the app running, closing the last one quits. Tested: `tests/apps/vscode-ui.mjs` 9b | 🔁 |
| `navigator.clipboard` (`BrowserClipboardService`) | Copy, Cut, Paste commands, pasting into the terminal | the manifest asks for the device `clipboard` (SPEC 8.4, DEV-APPS C5); once the user allows it the page reads and writes the clipboard (tested: refused without the grant, a read with it). Keyboard copy and paste in the editor work without it (the loader's Edit menu) | ✅ (device grant) |
| File System Access API (`showOpenFilePicker`, `showSaveFilePicker`), `<a download>` | Open Local File, Download | **Download…** in the Explorer: the shim replaces `explorer.download` with an embedder command; the core copies the selection from the VM to where the user chooses in the platform's save dialog (`dialog.save`, `/host/save-N`, written as `.partial` then renamed): one file as it is, folders or several items as one `.tar` (`core/download.js`). Tested: `vscode-ui.mjs` 9a (a file byte for byte, a folder as a tar). Open Local File (`showOpenFilePicker`) is still not available; dragging files from Finder into the explorer goes through the page's own drop handling (not exercised by the tests) | 🔁 (Download); ❌ (Open Local File) |
| `github-authentication`, `microsoft-authentication` + `urlCallbackProvider` | sign in (Settings Sync, Copilot, GitHub features) | shipped; signing in needs network hosts and a way back to the page (the network step, DEV-APPS C2/C3) | ❌ (shipped; not usable without network) |
| `extensions/copilot`, `@github/copilot-sdk`, `@vscode/copilot-api` | Chat / Copilot | not shipped yet: upstream builds it apart (its own install and compile step) and it needs a GitHub account and network; it comes with the network step. The agent host itself ships. The Chat views are hidden (`chat.disableAIFeatures`) | ❌ (pending) |
| `out/server-main.js` `getMac()` (a machine id for telemetry) | | the VM has no network interface: the server logs "Unable to retrieve mac address" once and uses a random id; there is no telemetry | ✅ (harmless) |
| extension gallery (`product.json` `extensionsGallery`) | install extensions | none in Code - OSS: the page passes one as its `productConfiguration` (`core/main.js` GALLERIES: Open VSX by default, the Visual Studio Marketplace by a command, kept in `/data`), and the workbench hands it to the server (its `extensionGalleryManifest` channel), which downloads into the VM through the network grant. The window's own requests (the gallery queries, extension icons) go through the app's proxy under the same grant (window feature `network`, SPEC 8.3 "The app's windows", DEV-APPS C3). Signatures cannot be verified (Microsoft's `vsce-sign` is licensed to its own products): the user is asked, as upstream. Tested: search on both, switching, icons loaded in the window (`VSCODE_UI_NET=1 tests/apps/vscode-ui.mjs`); install by hand | ✅ |
| `@vscode/proxy-agent`, `HTTPS_PROXY` | the server's and extensions' HTTP | the platform's proxy variables; the manifest asks for `*` on any port (off until the user allows it). Allowed: the server's request channel and programs in the terminal reach the internet; a LAN address and `localhost` stay refused (`tests/apps/vscode.mjs`, phase `network`) | ✅ |
| telemetry, update checks, experiments (`tas-client`) | | none configured in Code - OSS | ✅ (as upstream) |
| port forwarding, the Ports view, "Open in Browser" for a dev server | | the page's `tunnelProvider` (shim) asks the core (`vscode:forward-port`), which uses the platform's port forwarding (SPEC 8.8, the device `ports`): VS Code's own port detection forwards a server started in the terminal to this Mac's localhost, "Open in Browser" opens it (the platform accepts the forwarded localhost link). Tested: refused without the grant, fetched from the Mac with it (`tests/apps/vscode-ui.mjs` 8d). Not yet: Simple Browser inside the window | ✅ (browser on the Mac) |
| `NativeMenubarControl` (desktop: the menu bar as `IMenubarData` to Electron) | the menu bar (File, Edit, Selection, View, Go, Run, Terminal, Help) and the shortcuts shown in it | patch 0005: the web workbench gives the same data to the page (`nativeMenubar`), which sets it as the window's menus in the Mac menu bar (SPEC 7 "Menus", DEV-APPS C9) while the window is focused; Cut/Copy/Paste are the native roles, a click runs the command in the workbench. Tested: the menus, their shortcuts and roles, View → Command Palette… clicked (`tests/apps/vscode-ui.mjs` 8c) | ✅ |
| keyboard shortcuts the host takes (⌘Q, ⌘H, ⌥⌘H) | | the loader keeps these three whatever an app asks (SPEC 7 "Menus"); every other shortcut in VS Code's menus is VS Code's, and the loader's ⌘1-⌘4 are left to it. The tests send keys to the page directly (CDP) | ✅ (three kept by the platform) |
| fonts | | system fonts by name; codicons bundled | ✅ |

**Decisions on the ❌ rows** (guide step 2): none affects a core feature. Editing, highlighting, TypeScript IntelliSense and diagnostics,
the explorer, Quick Open, search, the terminal, source control, Workspace Trust, settings and themes all work, and the tests show each of
them. Webviews, web workers and WebAssembly, the gaps of the first version, work through the window features the manifest declares
(`ui.features`, SPEC §2.2 and §7; proposed in [docs/design/DEV-APPS.md](../../docs/design/DEV-APPS.md) C1). Every built-in
extension but Copilot ships; sign-in, Chat/Copilot and a marketplace (Open VSX) need network hosts, which are the next platform
step (DEV-APPS C2, C3).

## 2. Hard boundaries met (guide §2)

| Boundary | Here |
|---|---|
| internet access | the manifest asks for any public host on any port (`*`, DEV-APPS C2), off until the user allows it: without the grant everything gets the proxy's `403` (tested), with it the server, the extensions and the terminal reach the internet through the host's proxy, never the LAN or the Mac (tested) |
| menus, tray, dock, notifications | VS Code's menu bar is in the Mac menu bar (patch 0005 + SPEC 7 "Menus"); notifications stay in the window, as in the web workbench; no tray or dock menu |
| a local HTTP server as backend | ✅ the whole design: the VS Code Server on `127.0.0.1:8000` in the VM, reached through two bridges (a WebSocket for its protocol, the streamed HTTP bridge for resources) |
| native Linux code | the server's native modules (node-pty, @parcel/watcher, spdlog, kerberos, native-watchdog, deviceid) are compiled for its Node 24.21.0 on linux-arm64 in Docker; ripgrep is the linux-arm64 binary of `@vscode/ripgrep-universal` |
| a backend language with no shared runtime | the runtime is `node22`, the server needs Node 24 (its native modules are built against it): the server's own Node ships in `core/vscode/node`, as VS Code ships it in its server builds; the core itself runs on the runtime's Node 22 |
| WebAssembly, iframes, `blob:` workers, `eval` in the window | the page declares `workers`, `wasm`, `self-fetch`, `frames`; `eval` and inline scripts stay refused in the page and are allowed only inside the isolated frames (SPEC 7) |
| multiple windows | New Window and "open in a new window" open another app window (the core's `BrowserWindow`), each its own workbench on the one server |
| browser sign-in | not shipped (GitHub and Microsoft sign-in redirect back to the page; the window cannot receive that and has no network) |

## 3. What was kept, patched, mapped

**Unchanged:** every file of the server (`src/vs/server/**`), the editor, the workbench but `workbench.ts` and the web extension service,
the extension host, every built-in extension that ships, the build tools. VS Code's own gulp tasks and esbuild bundler build it.

**Patched** (four patches, +23 / -3 lines, explained one by one in [patches/PATCHES.md](patches/PATCHES.md)):

| Patch | Why it is needed |
|---|---|
| 1 `workbench.ts` | the page gives the workbench its socket factory, resource URI provider and a command (non-JSON options) |
| 2 `extensionService.ts` | built-in extensions' resources are read from a page served over `vmapp-ui://`, not only http(s) |
| 3 `diskFileSystemProviderServer.ts` | `--file-watcher-polling` had no effect (an upstream bug): edits made on the Mac are seen |
| 4 `extensionService.ts` | `extensions.webWorker: false` is honoured in a remote web window, as on the desktop: no web worker host the window cannot run |

**Mapped** (nothing in VS Code changed): the server-rendered page (`shim/index.html`, `shim/vscode-vmapp-shim.js`), the WebSocket
(`core/ws-bridge.js`), HTTP resources of the server (`sdk/web/vmapp-fetch.js`, `sdk/node/http-bridge.js`), webviews (`webviewEndpoint`
on `vmapp-frame://`), links (`window.open` → `shell.openExternal`), a folder of the Mac (`dialog.showOpenDialog`), git (`core/git`), the
configuration defaults the page sets (`extensions.webWorker`, `remote.extensionKind`, `chat.disableAIFeatures`,
`extensions.autoCheckUpdates`, `extensions.autoUpdate`; the user's own settings win).

**Added:** `core/main.js` (the core: starts the server, the bridges, the page's configuration, links, the folder dialog, diagnostics),
`core/ws-bridge.js`, `shim/*`, `build.sh`, `build/*` (the stages, `package-server.ts`, `check-ui.mjs`), `pins.env`,
`patches/*`, `vmapp.json`, this file, the README; `tests/apps/vscode.mjs`, `tests/apps/vscode-remote.mjs`, `tests/apps/vscode-ui.mjs`,
and the app's block in `tests/apps/run-all.sh`. In the platform: the window features (`ui.features`) and isolated frames
([docs/design/DEV-APPS.md](../../docs/design/DEV-APPS.md) C1).

**Removed** (not shipped; where it went):

| Removed | Why |
|---|---|
| extension `copilot`, server modules `@github/copilot-sdk*`, `@vscode/copilot-api` | not yet: built apart upstream, and useless without GitHub sign-in and network; they come with the network step |
| `out/` split | the server keeps its bundles, the window gets the web workbench (both halves complete; the web worker extension host's files ship with the window, the host is not started) |

Nothing else is left out: every other built-in extension (94, including the webview ones: Mermaid, Markdown Math, media preview,
notebook renderers, Simple Browser, the profile table; sign-in, GitHub, port forwarding, the js-debug companion), every other server
module of upstream's reh-web (the agent host's, Dev Containers', tree-sitter, and the browser packages the server lists), the server's
Node as upstream ships it (not stripped), and every browser package of `remote/web` with upstream's filter (no source maps, lock files
or tests). The core is a `core.erofs` image (SPEC §2.1, DEV-APPS C7): it is mounted in the VM, not copied into its memory.

## 4. Sizes, memory, start-up (measured)

| | |
|---|---|
| package | **383.9 MiB** (`core.erofs` 299.2 MiB, mounted read-only; `ui/` 82.5 MiB, 2296 UI files). *(The first version, with a stripped Node and 12 extensions and 25 modules left out: 237.0 MiB, its `core.cpio` 194.7 MiB held in the VM's memory.)* |
| memory (2 vCPUs, 3072 MiB VM; `MemAvailable` in the VM) | the server idle: 2826 MiB of 2940 available; with the window connected, the extension host and tsserver running (`tests/apps/vscode-ui.mjs`): **2549 MiB available, ~0.4 GiB in use**. The core costs no memory but the page cache (`core.erofs`); with the old `core.cpio` the same moment had 2376 MiB available. The recommendation of **3072 MiB** leaves room for tsserver on bigger projects and for builds in the terminal |
| start-up | headless (`vmapp run`): the VM is up and the core ready **~0.76 s** after the command, the server listens **~55 ms** after the core starts, the window opens ~50 ms later. In the loader: **~4.3 s** from a click on Launch to the workbench listing the shared folder (first start and after a restart alike; the loader's own launch path takes most of it). Measured with a load average of 25-29 on the Mac (not a quiet machine) |
| first highlighting, TypeScript | 11 token colours as soon as the editor opens; TypeScript's diagnostic ~0.46 s after a type error is typed |
| build | `build.sh` from a clean checkout: ~3 minutes with a fast network (Docker, cold caches); it produced a byte-identical package (the same package id) as the build that was tested |

## 5. Known gaps, and what is not portable

| | Why | Where it would go |
|---|---|---|
| Open Local File | the page has no `showOpenFilePicker`; the platform's open dialog is not wired to it | an adapter like Download's |
| sign-in, Settings Sync, Chat/Copilot, the marketplace | accounts, redirects to the page, network hosts; Code - OSS has no marketplace | network hosts in the manifest (the user allows each), and a callback mechanism for sign-in |
| git over ssh (`git@github.com:…`) | the runtime has no ssh client | DEV-APPS C6, the developer runtime (HTTPS remotes work: `core/git` ships its HTTP transport) |
| downloads: about 8 per run | each download uses a runtime save slot that the platform frees only at the end of the run (8 slots, shared with folders picked in dialogs) | platform: release a save grant once its file is delivered |
| Simple Browser inside the window for a forwarded port | the window cannot load `http://localhost` (forwarded ports open in the Mac's browser) | DEV-APPS C4 "not yet" |
| a folder picked with **Open Folder from Your Mac…** is valid for that run only | runtime grants (`pick-N`) end with the run; Recent shows a path that is gone after a restart | the manifest folder `workspace` is the persistent one |
| watcher polling scans each open folder every 3 s | virtiofs has no host-side notifications; VS Code's option polls exact paths or everything | CPU on very large folders; see PM |
| debugging | js-debug is shipped and runs in the VM; not exercised by the tests | a test |
| terminal tools | the runtime's Debian has no compilers, Python or package manager at run time (the root is read-only) | a bigger runtime, or tools shipped in `core/` |

### Platform gaps

Needs that cannot be met inside the app. Each is a platform change under [GOVERNANCE.md](../../GOVERNANCE.md), proposed in
[docs/design/DEV-APPS.md](../../docs/design/DEV-APPS.md); the window features (frames for webviews, workers, WebAssembly, the page's own
files) and the clipboard (C5) are implemented; the rest is in its roadmap (§11).

## 6. Diff statistics

| | Total in the original | Changed |
|---|---|---|
| `src/vs` (TypeScript, without tests) | 7,234 files, about 2.04 million lines (the server alone: 5,761 lines in `src/vs/server`) | 5 files: `workbench.ts` +6, `extensionService.ts` +16 / -2 (two patches), `diskFileSystemProviderServer.ts` +1 / -1, `titlebarPart.ts` +8 / -4, and one new file, `titlebar/embedderMenubarControl.ts` (221 lines) |
| built-in extensions (TypeScript, without Copilot and tests) | about 201,800 lines | none (Copilot not shipped yet) |
| build | `build/` (gulp tasks, esbuild bundler) | none; one file added to the tree (`build/vmapp-package-server.ts`) |
| added code | | `core/main.js` 331 lines, `core/ws-bridge.js` 171, `shim/vscode-vmapp-shim.js` 415, `shim/index.html` 73, `build.sh` 311, `build/*` 574 |

In files: 4 VS Code source files edited (5 patches), 1 added to `src/`, 1 added to `build/`; the Copilot extension and its 2 runtime
modules not shipped yet.

## 7. Checklist (guide §6)

- [x] Every inventory row is converted, adapted or listed as a known gap (§1 and §5)
- [x] Nothing writes into `/app`; all state lives in `/data` (`HOME=/data`, `--server-data-dir /data/vscode-server`) or in the shared
      folder; the window's state is in its own partition (the terminal test checks that `/app` is read-only)
- [x] No inline scripts, remote resources or `fetch` to the internet in `ui/` (`build/check-ui.mjs` at build time; in the real run there
      is no CSP refusal at all, `tests/apps/vscode-ui.mjs`)
- [x] Permissions are minimal, and each `purpose` explains the need in user terms (one folder, read-write; dialogs; links; any internet server, off until allowed, with a purpose that names what it is for)
- [x] Declined folders are handled: without the `workspace` folder the server starts as usual, `vscode:config` reports `folder: null`
      (the window opens with no folder, as VS Code does), nothing of the Mac is under `/host`, and **Open Folder from Your Mac…** and the
      built-in Open Folder (the VM's own files) remain (`tests/apps/vscode.mjs`, phase `declined`)
- [x] `tools/vmapp verify` passes; the headless test covers every inventory row that has a testable behaviour (`tests/apps/vscode.mjs`:
      24 checks, and 19 in the persist run), the UI test the window's rows (`tests/apps/vscode-ui.mjs`: 17 checks)
- [x] The Inspector shows only expected messages during a normal session: `vscode:config`, `vscode:open-external`, `vscode:pick-folder`,
      `ws:open/data/ack/close/ev`, `fetch:open/ack/ev`, `window.create`, `shell.openExternal`, `dialog.open` and its `grant pick-0`; no
      network row (checked by `tests/apps/vscode-ui.mjs`)
- [x] CONVERSION.md lists changed, removed and unchanged files

## 8. Reproducing and updating

`apps/vscode/build.sh --check` verifies the pins and the clone without building; `build.sh` builds everything (Docker, linux/arm64; caches
and the clone in `$VMAPP_WORK`; it refuses to start a Docker stage with less than 8 GB free). To move to a newer VS Code:

1. change `VSCODE_VERSION`, `VSCODE_TAG`, `VSCODE_TAG_COMMIT` and `VSCODE_COMMIT_DATE` in `pins.env` (`git ls-remote --tags` and
   `git show -s --format=%cI <commit>`), and `VSCODE_LICENSE_SHA256` if the licence changed;
2. if `.nvmrc` or `remote/.npmrc` name another Node: `NODE_BUILD_IMAGE` and its digest, `SERVER_NODE_VERSION` and `SERVER_NODE_SHA256`
   (from VS Code's `build/checksums/nodejs.txt`); `build.sh` checks all of them against the clone;
3. run `build.sh`: a patch that no longer applies stops it (fix the hunk; patch 3 should disappear once upstream fixes the bug), a new
   server dependency that is only for the agent host or the browser goes into `EXCLUDED_MODULES`, and `check-ui.mjs` reports anything the
   window's CSP would refuse;
4. run `tests/apps/vscode.mjs` (through `tests/apps/run-all.sh`) and `tests/apps/vscode-ui.mjs`, and bump `version` in `vmapp.json`.
