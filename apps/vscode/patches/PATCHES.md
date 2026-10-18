# Patches to VS Code 1.142.0 (and what is deliberately not patched)

Everything here is applied by `apps/vscode/build.sh` to a fresh `git archive` of the tag commit `d956e8a6ac5d904486557eea07e1d6bd62a4d36f`
(the clone is verified against that commit and the tag), in this order, with `patch -p1`. A patch that does not apply stops the build.
The files are plain unified diffs with a short explanation on top; each can be read, re-applied by hand, or sent upstream as it is.

| # | File | Touches | Size | Needed because |
|---|---|---|---|---|
| 1 | `0001-web-embedder-options.patch` | `src/vs/code/browser/workbench/workbench.ts` | +6 | the page must give the workbench options that are functions (its socket factory, its resource URI provider, a command); the server's page can only give JSON |
| 2 | `0002-web-fetch-provider-for-page-scheme.patch` | `src/vs/workbench/services/extensions/browser/extensionService.ts` | +7 | a workbench served from `vmapp-ui://` cannot read its built-in extensions' resources (themes, grammars, snippets): only http(s) has a fetch provider |
| 3 | `0003-server-file-watcher-polling.patch` | `src/vs/platform/files/node/diskFileSystemProviderServer.ts` | +1 / -1 | an upstream bug: the server's `--file-watcher-polling` has no effect, so edits made on the Mac in a shared folder are never seen |
| 4 | `0004-web-respect-extensions-webworker-false.patch` | `src/vs/workbench/services/extensions/browser/extensionService.ts` | +9 / -2 | `extensions.webWorker` in a remote web window, as on the desktop: `false` never starts the web worker extension host, `'auto'` (the default here) starts it lazily, only when a browser-only extension needs it, taking its extensions from the registry; the web always started it eagerly |
| 6 | `0006-web-worker-exthost-origin-without-quality.patch` | `src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts` | +4 / -2 | the web worker host's iframe gets an origin of its own from `webEndpointUrlTemplate` only if the product has a quality; Code - OSS has none, so a D9010 VmApp window could not give it an isolated `vmapp-frame://` origin |
| 5 | `0005-web-embedder-native-menubar.patch` | `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`, new `…/titlebar/embedderMenubarControl.ts` | +229 / -4 (221 in the new file) | the web workbench can only draw its menu bar inside the page; an embedder that can show native menus (here the Mac menu bar, SPEC 7 "Menus") had no way to get the menus as data, as the desktop gives them to Electron |

| 8 | `0008-server-signature-verifier-module.patch` | `src/vs/platform/extensionManagement/node/extensionSignatureVerificationService.ts` | +2 / -1 | Code - OSS has no extension signature verifier (Microsoft's `@vscode/vsce-sign` is licensed to its own products): the embedder of a server may now name an open one (`VSCODE_SIGNATURE_VERIFIER`) |

Total: 7 source files (one new), +258 / -10 lines. No file of the server's logic, the editor, the extension host or any built-in extension changed.
The build itself is not patched: `build/compile-stage.sh` runs VS Code's own gulp tasks and esbuild bundler, and `build/package-server.ts` is
a new file (VS Code's packaging task, minus Copilot) copied into the tree as `build/vmapp-package-server.ts`.

## 1: non-JSON construction options for an embedding page (upstreamable)

The VS Code Server renders `workbench.html` with the workbench's options as JSON in a `<meta>` element, and `workbench.ts` passes them to
`create()`. Options that are functions or providers (`IWorkbenchConstructionOptions.webSocketFactory`, `resourceUriProvider`, `commands`)
cannot be JSON. A page that serves the same bundle itself, with its own transport to the server, has no way to supply them without
rebuilding the entry point, because the server-web build bundles `workbench.ts` and `workbench.web.main.internal` into one file.

The patch reads one optional global, `globalThis.vscodeWebEmbedderOptions` (a `Partial<IWorkbenchConstructionOptions>`), and applies it
last. The page the server renders never defines it, so nothing changes there. Here, `ui/vscode-vmapp-shim.js` defines:

* `webSocketFactory`: a socket over the bridge (`ws:*` channel) to `core/ws-bridge.js`, which opens the very same connection on the server
  in the VM. VS Code's protocol is unchanged; the server is asked for `skipWebSocketFrames=true`, its own option for raw sockets.
* `resourceUriProvider`: `vscode-remote://…/path` becomes `vmapp-ui://<app>/vscode-remote-resource?path=…` (fetched over the bridge by
  `vmapp-fetch.js`), and a picture or font of a built-in extension becomes `vmapp-ui://<app>/static/extensions/…`, a copy in the package
  (an `<img>` or `@font-face` cannot go over the bridge).
* `commands`: **Open Folder from Your Mac…** (Command Palette and the VM indicator's menu): the core shows the platform's folder dialog.

**To propose upstream** as "web: let an embedding page add non-JSON construction options". A test would load `workbench.html` with the
global defined and check that `create()` received it.

## 2: a fetch file system provider for the page's own scheme (upstreamable)

The web workbench reads its built-in extensions' resources (the default color theme, TextMate grammars, snippets, language configurations)
through the file service from URLs under `_VSCODE_FILE_ROOT`. The extension service registers `FetchFileSystemProvider` (read-only,
backed by `fetch`) for `http` and `https` only. A workbench served from any other scheme (an Electron host's custom protocol; here the
window's `vmapp-ui://`) gets `ENOPRO: No file system provider found` for each of them: the window starts without a color theme, without
highlighting and without bracket matching.

The patch registers the same provider for the page's own scheme when it is neither http nor https and has no provider yet. The resources
are then fetched from the page's origin; `vmapp-fetch.js` carries those fetches to the server in the VM (prefix `/static/`, the server's
own static route, which serves the same files) because the window's CSP has `connect-src 'none'`.

**To propose upstream** as "web: read extension resources from the page's origin when it is not served over http(s)".

## 3: `--file-watcher-polling` works again (an upstream bug)

`RemoteAgentFileSystemProviderChannel`'s `SessionFileWatcher` overrides `getRecursiveWatcherOptions()` to return the polling options of
`--file-watcher-polling`, but `AbstractSessionFileWatcher` never calls the method: it creates its `DiskFileSystemProvider` without options,
so the recursive watch requests never get a polling interval. The patch passes the method's result to the provider, which is what the
method exists for. Without the option the result is `undefined`, as before.

Why the app needs it: the folders the user shares from the Mac reach the VM over virtiofs, which delivers no change notifications for edits
made on the Mac (inotify only sees changes made inside the VM). `core/main.js` starts the server with `--file-watcher-polling 3000`; with
the patch the server's recursive watcher (the one watching the folders open in the window) scans them every 3 s, and a file created in
Finder appears in the explorer within that time (measured by `tests/apps/vscode.mjs`).

**To propose upstream** as "server: honour --file-watcher-polling". The existing test of the option (if any) did not catch it because it
constructs the watcher directly.

## 4: `extensions.webWorker: false` in a remote web window (upstreamable)

The setting `extensions.webWorker` is registered for every workbench; on the desktop, `false` means no web worker extension host is
started. The web workbench always creates one. In a remote window every extension that is installed on the server runs there; the web
worker host is only needed for browser-only extensions. A D9010 VmApp window cannot run it at all: the host is an iframe (`frame-src 'none'`)
or a worker started from a `blob:` URL (`script-src 'self'`), and each extension is evaluated with `new Function`. Without the patch it
fails on every start with a CSP violation and an "unknown error" in the log.

The patch makes the web workbench honour the setting **in a remote window**, as the desktop does; the page sets it to `false` as a
configuration default. The default value and a window without a remote are unchanged.

**To propose upstream** as "web: respect extensions.webWorker in a remote window".

## 5: a native menu bar given by the embedding page (upstreamable)

On the desktop, `NativeMenubarControl` (electron-browser) turns the workbench's menus into `IMenubarData` (labels, ids, checked and
enabled states, keybindings as Electron accelerators, Open Recent entries) and sends it to the main process, which builds the macOS menu
bar; a click comes back as the command id. The web workbench only has `CustomMenubarControl`, drawn in the page.

The patch adds one more non-JSON embedder option to patch 1's global: `vscodeWebEmbedderOptions.nativeMenubar`, an object with
`update(data: IMenubarData)` and `onDidRun(listener)`. When it is present, the title bar creates `EmbedderMenubarControl` (new file: the
desktop control's data building, unchanged, over the same `MenubarControl` base) instead of the custom menu bar, and leaves
`window.menuBarVisibility` to the embedder. A chosen id runs through `ICommandService`; an Open Recent entry opens through `IHostService`,
as the desktop's main process does. Without the global (the server's own page) nothing changes.

Here `shim/vscode-vmapp-shim.js` (`createNativeMenubar`) turns the data into a D9010 VmApp menu template (SPEC 7 "Menus"): `&&` mnemonics
dropped (macOS has none), separators, checkboxes, the accelerators (chords, which a native menu cannot show, are left out), and
**Cut / Copy / Paste as the native roles**, as VS Code's desktop menu does on macOS, so they work in every text field. The template ids
are generated (`m1`, `m2`, …) and mapped back to the command id on click. Tested by `tests/apps/vscode-ui.mjs` step 8c (the menus, their
shortcuts and edit roles in the menu bar; View → Command Palette… clicked from the menu bar opens it).

**To propose upstream** as "web: let an embedding page show the menu bar natively".

## 6: the web worker extension host's origin without a quality (upstreamable)

The webview endpoint already falls back when the product has no quality; this makes the web worker host's `webEndpointUrlTemplate`
work the same way when the template does not name `{{quality}}`. Here the shim sets `vmapp-frame://{{uuid}}.exthost/vmapp-exthost`,
so the host runs in an isolated frame `vmapp-frame://v--<hash>.exthost/` (SPEC 7: no `window.vmapp`, no permission; `eval` and the
`blob:` worker only there; the page's CSP is unchanged). Its host page is `shim/exthost/` (VS Code's page with its script external, the
worker loaded from the frame's own origin, the server's files fetched for it by the page over a MessagePort: GET of
`vscode-remote-resource` only). Browser-only extensions from a marketplace come through the window's network grant (SPEC 8.3).
Tested: `tests/apps/vscode-ui.mjs` 8b2 (NET), a web-only sample extension from Open VSX runs in that frame.

**To propose upstream** as "web: allow webEndpointUrlTemplate without product quality".

## 8: an open extension signature verifier (upstreamable)

VS Code verifies a marketplace extension's signature with `@vscode/vsce-sign`, a closed native module that Code - OSS does not ship,
so every install asks "cannot verify the extension signature; install anyway?". The patch reads one environment variable,
`VSCODE_SIGNATURE_VERIFIER` (an absolute path to a module with the same `verify(vsix, sigzip, verbose)` API); unset, nothing changes.
`core/main.js` sets it to `/app/sigverify.js`, open code with Node's built-ins only:
- **Open VSX** (the default marketplace): its `.sigzip` holds a raw Ed25519 signature over the whole `.vsix`, made with the registry's
  key; the key is pinned in `sigverify.js` (id `14ccb407-…`). Verified fully: a genuine extension installs without a question, a
  tampered one is refused (`SignatureIsInvalid`).
- **Visual Studio Marketplace:** a detached CMS signature over a manifest of file digests, by "Microsoft Corporation, OU=Visual Studio
  Marketplace", chained to a DigiCert root in Node's store. The signature, the chain and every file digest are checked; the RFC 3161
  timestamp is not yet, so a signature whose certificate has expired since is reported as not verified (VS Code asks, as before), and a
  package that does not match its signed manifest is refused.

**To propose upstream** as "server: let the embedder name the signature verifier".

## Not patched, and why

* **Web workers, WebAssembly, webviews.** Nothing in VS Code is changed for them: the manifest declares the window features `workers`,
  `wasm`, `self-fetch` and `frames` (SPEC §2.2, §7), so the editor and TextMate workers start from VS Code's own `blob:` bootstrap,
  `vscode-oniguruma` compiles its `onig.wasm`, the workers fetch the page's own files, and every webview runs VS Code's own host page
  (`pre/index.html` and its service worker) in an isolated `vmapp-frame://` origin (the page's `webviewEndpoint`).
* **The page.** `src/vs/code/browser/workbench/workbench.html` is not served: `shim/index.html` is the same page without its inline
  scripts and server placeholders.
* **Chat and Copilot.** The Copilot extension is not built and not shipped; the page sets `chat.disableAIFeatures: true` so that the
  Chat views stay hidden. A few Chat and voice features still ask for a GitHub session at start and log "Timed out waiting for
  authentication provider 'github'" once; nothing else follows from it.
* **The build.** VS Code's gulp tasks and esbuild bundler run unchanged. The Copilot extension's build is the one step left out
  (`compile-copilot-extension-build`); the packaging is a new file instead of a patched one.

## Diff statistics

See `apps/vscode/CONVERSION.md`, "Diff statistics".
