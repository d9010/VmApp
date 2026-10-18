# Converting Ollama's desktop app

A worked conversion of a **large, real** application, following [docs/CONVERTING.md](../../docs/CONVERTING.md) §3. `original` is
Ollama v0.35.0 (tag commit `cc4069396f3ad2c370c53eed2e4a42ac13adab84`): the desktop app of `app/` (a native webview + tray shell,
`app/cmd/app`; a Go UI server with a SQLite store, `app/ui`, `app/store`; a supervisor of `ollama serve`, `app/server`; a React 19 +
Vite + Tailwind single-page app with 59 components, `app/ui/app`) and the Ollama server itself. `converted` is this folder. The
original is not copied here: `build.sh` takes it from the pinned tag, and [`patches/`](patches/) are the differences.

```
original (ollama/ollama @ v0.35.0)                    converted (this folder; build.sh assembles core/ and ui/)
  app/ui/app/        React window            ──►        ui/                 the same app, built with its own lockfile (npm ci, tsc, vite)
                                                        + ui/vmapp-fetch.js, ui/ollama-desktop-shim.js, licence files
  app/ui/*.go, app/store, app/server, app/tools ──►     core/bin/vmapp-ui   the same Go packages, a headless main (backend/vmapp-ui/main.go)
  app/cmd/app/*      native shell (webview, tray) ──►   core/main.js        a D9010 VmApp core: window, bridge, dialogs, links
  main.go, server/, llm/, llama/, transfer/ …   ──►     core/bin/ollama, core/lib/ollama/   built from the same tag, with one patch
  cmd/ (the CLI is the same binary)             ──►     `ollama` in /app/bin, reachable from the core (ollama:cli)
```

Following the guide's advice, **the original UI/backend split is kept exactly**: the React app keeps calling `fetch('/api/v1/…')`
and the Go backend keeps serving it; what moved is the transport between them (a streamed bridge instead of the loopback of a
desktop) and the host-side duties of the native shell.

---

## 1. Inventory and classification (guide §3 steps 1 and 2)

✅ maps directly, 🔁 needs an adapter, ❌ is a format 1 gap.

| Where in the original | What it does | After conversion | |
|---|---|---|---|
| `app/ui/app/src/**` (React) | rendering, state (TanStack Query/Router), markdown (Streamdown, KaTeX, shiki), the chat form | **unchanged**, in the sandboxed window | ✅ |
| `app/ui/app/index.html` inline `<script>` | wiring to the native webview: file picker callbacks, key/mouse/drag guards, context-menu bridge | `ui/ollama-desktop-shim.js` (same guards; callbacks rebuilt on `window.vmapp`) | 🔁 |
| `fetch('/api/…')` everywhere in `src/api.ts`, streamed NDJSON in `useChats` | HTTP to the UI server on loopback | `vmapp-fetch.js` → bridge → `http-bridge.js` → `127.0.0.1:11501` | 🔁 |
| `ollama-js` client (`ollama.list()`, `show()`) | HTTP to `window.location.origin` | the same fetch; the page half ignores the `:80` the library adds | 🔁 |
| `app/ui/ui.go`, `app.go`, `extract.go`, `app/store`, `app/tools`, `app/updater`, `app/version` | the UI server, chats and settings in SQLite, tools (web search/fetch), PDF text extraction | **unchanged**, built for Linux (tag widened) | ✅ |
| `app/server/server.go` | starts and supervises `ollama serve`, reads its log for the compute devices, restarts it on settings | **unchanged**, driven by `vmapp-ui` | ✅ |
| `app/cmd/app/app.go` `main()` | wiring: store, `server.New`, `ui.Server{…}`, the HTTP server, first-run flag, `UserData` refresh | `backend/vmapp-ui/main.go`, the same lines | 🔁 |
| `app/cmd/app/webview.go`: window, cookie `token`, sizes, zoom, `ready`, `drag`, `close` | the native window | `BrowserWindow` (1360×960, min 900×660); the cookie added by the core; the rest is the host's | 🔁 |
| `webview.go` `selectFiles` | native open dialog, extension filter, 10 MB limit, files read by Go | `<input type=file>` in the window (same filter and limit) | 🔁 |
| `webview.go` `selectModelsDirectory`, `selectWorkingDirectory` | native folder dialog | `dialog.showOpenDialog` in the core, folder shared read-write | 🔁 |
| `webview.go` `setContextMenuItems` + `menu_handle_selection` | native context menu on a chat | a menu drawn by the shim, same `window.menu(items)` promise | 🔁 |
| `window.open(url)`, links in messages | opens the system browser | core `shell.openExternal` (https, the platform asks) | 🔁 |
| `openInBrowser`, `ollama://` URL scheme, `maybeMoveAndRestart`, `installSymlink`, login item, single instance | desktop integration | dropped: no equivalent, nothing to integrate with | ❌ (dropped) |
| tray icon and menu, dock, `UpdateAvailable` | the app's presence | dropped: no tray/menu in format 1; the window is the app | ❌ (dropped) |
| `app/updater` (`checkForUpdate`, download, `DoUpgrade`) | auto-update | not started: the D9010 VmApp package is the unit of update | ❌ (dropped) |
| `app/cmd/app/*_darwin.go`, `claude_desktop*`, `codex_app*`, `desktop_models*` | configure Claude Desktop and ChatGPT's desktop app on the Mac | not ported; their settings sections are hidden (`OLLAMA_PLATFORM=windows`) | ❌ (cannot work from a VM) |
| `ollama serve` (Go, cgo-free, plus `llama-server` and ggml in C++) | the model server | built from the same tag; runs in the VM; models in `/data` | ✅ |
| model downloads (`transfer/redirect.go`) | resolve the redirect target locally, dial it directly | patched to honour `HTTPS_PROXY` (patches/go/0001) | 🔁 |
| `~/.ollama` (models, key pair, `server.json`, logs, `app/db.sqlite`) | persistent state | `HOME=/data` | ✅ |
| network: `registry.ollama.ai`, its R2 storage host, `ollama.com` | models, account, cloud, web search, updates | three hosts in `permissions.network`, each with a purpose (updates dropped) | ✅ |
| GPU (Metal on a Mac; CUDA/ROCm/Vulkan on Linux) | acceleration | Vulkan through the experimental backend; CPU otherwise | ✅ (experimental) |
| file attachments (images, text, PDF) | read natively, sent base64 in the chat request | read by the window, sent in pieces through the bridge | ✅ |
| localStorage / IndexedDB | TanStack Query cache and small UI state | unchanged (private to the app) | ✅ |
| remote scripts/fonts | none (everything is bundled by Vite) | `check-ui.mjs` verifies | ✅ |

**Decisions on the ❌ rows** (guide step 2): none affects a core feature. The tray, menu bar, login item, update checks and
the Claude Desktop/ChatGPT mappings are desktop-shell features of macOS and Windows; the chat, the model management, the account and the cloud
features are the product, and they all work.

## 2. Hard boundaries met (guide §2)

| Boundary | Here |
|---|---|
| internet access | from the core's processes only, three hosts; the window has none. Ollama's blob downloader needed a patch to honour the proxy (PATCHES.md, Go 1) |
| menus, tray, dock, global shortcuts, notifications | not available; dropped |
| a local HTTP server as backend | ✅ the whole design (two servers: the UI backend and `ollama serve`) |
| native Linux code | the Go programs and the C++ runners are built for linux-arm64 in Docker; no cgo UI |
| GPU | experimental Vulkan only; `dialog.open` is not available on that backend (SPEC 8.7), so "Model location → Browse" says so |
| multiple windows | one window |
| browser sign-in | Ollama's sign-in opens ollama.com in the user's browser and then **polls** `/api/me` from the server: no callback to the VM is needed, so it converts. (The `ollama://` URL scheme that the desktop uses to come back to the app is dropped; the polling does the job.) |

## 3. What was kept, patched, mapped

**Unchanged (byte for byte):** the whole React app but four files (`index.html`, `highlighter.ts`, `Settings.tsx`, `Onboarding.tsx` +
`routes/onboarding.tsx`); every Go file but the 23 build tags and `transfer/redirect.go`; the server, the runner, the CLI, the store schema,
the cloud logic, the tools. Statistics in section 6.

**Patched** (explained one by one, with the reasoning for each, in [patches/PATCHES.md](patches/PATCHES.md)):

| Patch | Why it is needed |
|---|---|
| Go 1: `transfer/redirect.go`, +48 | a pull cannot work behind a proxy without DNS otherwise; upstreamable |
| Go 2: 23 build tags + `updater_linux.go` | the app's Go packages are tagged for macOS/Windows |
| UI 1: `index.html` | no inline scripts under the window's CSP |
| UI 2: `highlighter.ts` | no WebAssembly under the window's CSP (shiki's JavaScript engine) |
| UI 3: `Settings.tsx` | the sign-out's `location.reload()` would ask the host for a path it does not serve |
| UI 4: `Onboarding.tsx`, `onboarding.tsx` | without a tray, "No thanks, I'll use Ollama locally" must lead to the chat, not to a screen with a terminal command |

**Mapped** (nothing in the original changed): the native bindings (table in PATCHES.md, "UI 1"), the transport (`vmapp-fetch.js`), the
token cookie, the model folder and attachment pickers, links, the context menu, the process supervision, the proxy and CA environment.

**Added:** `core/main.js`, `backend/vmapp-ui/main.go`, `shim/ollama-desktop-shim.js`, `build.sh`, `build/*`, `pins.env`, `vmapp.json`,
`patches/*`, this file, the README; in the platform: `sdk/web/vmapp-fetch.js`, `sdk/node/http-bridge.js`, their unit test, the app's
tests.

**Removed** (not ported; where it went): the native shell (`app/cmd/app`, `app/webview`, `app/dialog`, `app/wintray`, `app/darwin`) → the
platform's window, dialogs and links; the updater's behaviour → the package; the Claude/Codex desktop integrations → nothing.

## 4. The cloud and sign-in features (guide step 2, "decide what happens")

They work, with `ollama.com` allowed in the manifest (a host the user may refuse at install time, or later under "Network…"):

- **Sign in** (onboarding and Settings → "Sign In"): the window asks `POST /api/me`, which the server answers with `401` and a sign-in URL
  (`https://ollama.com/connect?…`, signed with the key pair in `/data/.ollama`); the window opens it with `window.open`, which the shim
  turns into `shell.openExternal` (the platform asks the user first); the window then polls `/api/me` until the browser sign-in has completed.
  Verified up to the URL (`tests/apps/ollama-desktop.mjs` against the real ollama.com) and the platform call (`ollama-desktop-ui.mjs`); a real
  sign-in needs an account and was not exercised.
- **Cloud models and web search**: Ollama's own code (`server/cloud_proxy.go`, `app/tools`) talks to `ollama.com` through the proxy; the
  Settings → Cloud switch (`server.json`) turns them off. Not exercised with an account.
- **Without the host**: local chat and local model management work; the cloud entries of the picker and the account fail with an error.
- **The upstream freshness check** (`/api/v1/model/upstream`, `HEAD https://ollama.com/v2/…`) and typing a model name into the picker use the
  same host: with it refused, only installed and recommended models are offered.
- Not worked around: the account **avatar** (an image from ollama.com; the window's CSP blocks images from other origins).

## 5. Known gaps, and what is not portable

| | Why | Where it would go |
|---|---|---|
| tray, menu bar, dock, login item, global shortcut | no such API in format 1 | n/a |
| auto-update | the package is the unit of update | the platform's update flow (SPEC 8.1) |
| Claude Desktop / ChatGPT model mappings | they configure other apps on the Mac | a host capability, if ever |
| "Expose Ollama to the network", "Allow browser access" | stored, moot: the VM has no network device and no one can reach its loopback | n/a |
| zoom shortcuts, onboarding window size, window size memory | window chrome belongs to the host (no `setSize`, no zoom in the SDK) | an SDK addition |
| Model location: a path is valid for the current run only | `dialog.open` gives `/host/pick-N`; a later run may name another folder `pick-N`; the app falls back to its own folder when the path is gone | a persistent folder grant in the manifest (`permissions.folders`) |
| Model location on the experimental GPU backend | no runtime folder grants (SPEC 8.7, B8) | a manifest folder |
| avatar images | CSP | proxy images through the core |
| image generation, MLX, CUDA/ROCm | macOS or NVIDIA/AMD only | n/a |
| a real terminal for the CLI | `ollama:cli` runs commands; an interactive terminal is a separate app/VM | a Terminal profile with the same `bin/` and `lib/` |
| the GPU on the normal backend | Virtualization.framework has no GPU device | the experimental Vulkan backend (SPEC 8.7) |

## 6. Diff statistics

Measured with `diff -ru` of the pinned source against the patched tree that `build.sh` builds (node_modules and build output excluded):

| | Total in the original | Changed |
|---|---|---|
| UI source (`app/ui/app/src`, 46 `.tsx` components plus hooks, utilities, API) | about 14,500 lines of `.ts`/`.tsx` without tests | `Settings.tsx` +2 −1, `highlighter.ts` +5, `Onboarding.tsx` +1 −2, `onboarding.tsx` +5 −2; `index.html` +2 −175 (the inline script moved to a file). Total +15 −180 |
| Go: `app/ui`, `app/store`, `app/server`, `app/tools`, … | about 7,100 non-blank lines in `app/ui`, `app/store`, `app/server` alone | the first line of 23 files (build tag) and one new 9-line file (`updater_linux.go`) |
| Go: Ollama proper | the server, runner glue, CLI, `transfer/` | `transfer/redirect.go` +48 |
| Added code | | `backend/vmapp-ui/main.go` 155 lines (an excerpt of `app/cmd/app/app.go`), `shim/ollama-desktop-shim.js` 313, `core/main.js` 329, `sdk/web/vmapp-fetch.js` 329, `sdk/node/http-bridge.js` 334 |

In files: 5 UI files with real edits, 1 Go file edited, 1 Go file added, 23 Go files with a one-word tag change, 1 Go entry point added.

## 7. Checklist (guide §6)

- [x] Every inventory row is converted, adapted or listed as a known gap (section 1 and 5)
- [x] Nothing writes into `/app`; all state lives in `/data` (`HOME=/data`: models, chats, key pair, logs, settings)
- [x] No inline scripts, remote resources or `fetch` to the internet in `ui/` (`build/check-ui.mjs` at build time; no CSP violation in the real run over CDP)
- [x] Permissions are minimal, and each `purpose` explains the need in user terms (three hosts, the experimental GPU, dialogs for the folder, external links)
- [x] Declined folders are handled with a friendly message (the model-location dialog on the GPU backend answers "not supported" and the window shows it as a notice)
- [x] `tools/vmapp verify` passes; the headless tests cover every inventory row that has a testable behaviour (tests/apps/ollama-desktop.mjs)
- [x] The Inspector shows only expected messages during a normal session: `fetch:*`, `raw:*`, `ollama:open-external`, `ollama:pick-directory` (and `ollama:diag`, `ollama:cli` from scripts)
- [x] CONVERSION.md lists changed, removed and unchanged files

## 8. Reproducing and updating

`apps/ollama-desktop/build.sh --check` verifies the pins and the clone without building. To move to a newer Ollama: change the five Ollama pins and
the two llama.cpp pins in `pins.env` (and `apps/ollama/pins.env`, `apps/ollama/vulkan/pins.env`, which the Vulkan build and this build check
against each other), run `build.sh` (a patch that no longer applies stops it: fix the hunk), run the tests, bump the version in `vmapp.json`.
The Go patch 1 should disappear when Ollama's own downloader honours the proxy.
