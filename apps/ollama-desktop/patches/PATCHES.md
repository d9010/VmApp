# Patches to Ollama v0.35.0 (and what is deliberately not patched)

Everything here is applied by `apps/ollama-desktop/build.sh` to a fresh `git archive` of the tag commit
`cc4069396f3ad2c370c53eed2e4a42ac13adab84` (the clone is verified against that commit and the tag), in this order, with `patch -p1`.
A patch that does not apply stops the build. The files are plain unified diffs with a short explanation on top; they can be read,
re-applied by hand, or sent upstream.

| # | File | Touches | Size | Needed because |
|---|---|---|---|---|
| Go 1 | `go/0001-transfer-respect-proxy-environment.patch` | `transfer/redirect.go` | +48 lines | a model download cannot work behind a proxy without it (the whole point of building Ollama from source for this app) |
| Go 2 | `go/0002-app-packages-build-on-linux.patch` | 23 one-line build tags + 1 new 9-line file in `app/` | +32 / -23 | the desktop app's Go packages are tagged `windows \|\| darwin`; the headless backend is built for Linux |
| UI 1 | `ui/0001-index-html-no-inline-script.patch` | `app/ui/app/index.html` | +2 / -175 | the CSP of a D9010 VmApp window refuses inline scripts |
| UI 2 | `ui/0002-highlighter-javascript-regex-engine.patch` | `app/ui/app/src/lib/highlighter.ts` | +5 | the CSP refuses WebAssembly, which shiki's default engine needs |
| UI 3 | `ui/0003-settings-signout-no-reload.patch` | `app/ui/app/src/components/Settings.tsx` | +2 / -1 | `location.reload()` after signing out would ask the host for a path it does not serve |
| UI 4 | `ui/0004-onboarding-local-goes-to-chat.patch` | `components/Onboarding.tsx`, `routes/onboarding.tsx` | +6 / -4 | without a tray, the "Run Ollama" screen at the end of the first run is a dead end |

Total: 5 UI files with real edits (`index.html`, `highlighter.ts`, `Settings.tsx`, `Onboarding.tsx`, `onboarding.tsx`: +15 / -180 in all),
1 Go file edited (`transfer/redirect.go`, +48) and 1 Go file added (`updater_linux.go`, 9 lines), 23 Go files with a one-word build-tag change.
No Go file of the server (`server/`, `llm/`, `llama/`), of the UI backend's logic (`app/ui/ui.go` apart from its first line) or of the
other React components changed.

## Go 1: blob downloads respect `HTTPS_PROXY` (upstreamable)

**Problem.** A model pull has two network phases. The manifest and tokens go through `http.DefaultTransport`-derived clients, which honour
`HTTPS_PROXY`. The blobs do not: the registry answers a blob request with a redirect to a storage host, and then

1. `transfer.ValidateRedirectTarget` resolves that host with the local resolver, to refuse non-public addresses;
2. `transfer.NewRedirectClient` downloads from it with a transport whose `DialContext` is `checkedDialer` (resolve, refuse non-public
   addresses, dial a pinned IP) and which has **no `Proxy`**.

On a machine whose only way out is a proxy and which has no DNS (a corporate network, a sandbox, a VM) the pull fails after the manifest
with `redirect target not allowed: resolving <host>: lookup <host>: ...`, and could not work even if the lookup passed: the dial goes
straight to the host. In a D9010 VmApp VM there is no network device and no DNS; the platform's allowlist proxy is the only way out
(SPEC 8.3).

**Change** (all in `transfer/redirect.go`; used by `server/download.go` for ordinary models and by `transfer.Download`/`Upload`):

* `ValidateRedirectTarget` still checks the scheme and IP literals, and skips only the DNS lookup when the target is reached through a
  proxy (`viaProxy`, i.e. `http.ProxyFromEnvironment` returns one for that URL, so `NO_PROXY` is respected).
* `checkedClient`'s transport gets `Proxy: ProxyFromEnvironment`. Its `DialContext` dials the **address of a proxy that the environment
  named** as it is, and still sends every other address through `checkedDialer`. The transport remembers the proxy addresses
  `ProxyFromEnvironment` returned (`proxyAddrs`), so a host supplied by a registry is never exempt.

**Why this keeps the protection that the check was for.** The checks exist so that a hostile registry cannot make the client connect to a
private address (SSRF, DNS rebinding). Behind a proxy the client neither resolves nor dials the target; it sends `CONNECT host:443` to the
proxy and the proxy resolves and connects. So the address policy is the proxy's, and a lookup in the client can only fail (no DNS) or
disagree with the proxy's own. In D9010 VmApp the proxy is the platform's allowlist proxy (`vmapp-vm`, SPEC 8.3), which: only opens hosts that
the user allowed for the app, refuses IP literals in rules, resolves the name itself, **refuses if any answer is a non-public address**
(loopback, private, link-local, CGNAT, ULA, ...), and connects to the address it checked. A redirect to `http://169.254.169.254/` is still
refused in the client (an IP literal is still checked here); a redirect to a name that resolves to it is refused by the proxy. Without a
proxy in the environment nothing changes at all: no address is recorded, the lookup and the dialer run as before.

**Tested.** `go test ./transfer/` (the existing tests, including those that type-assert the client's transport) passes with the patch;
the end-to-end test is `tests/apps/ollama-desktop.mjs`: a real pull of qwen2.5:0.5b through the allowlist proxy, cancelled and resumed,
SHA-256 recomputed on the host, with the platform's traffic events showing exactly the manifest's hosts.

**To propose upstream** as "transfer: respect the proxy environment for blob downloads". The unit test that is missing here is one for
`proxyAddrs` and `viaProxy` with a fake proxy; it is not in the patch because `http.ProxyFromEnvironment` caches the environment for the
process, which makes a test that sets `HTTPS_PROXY` order-dependent in the package's test binary (it needs a subprocess or an injectable
proxy function).

## Go 2: the app's Go packages build on Linux

`app/ui`, `app/ui/responses`, `app/store`, `app/server`, `app/tools`, `app/types/not`, `app/updater`, `app/version`, `app/logrotate` carry
`//go:build windows || darwin` (and `app/server/server_unix.go` `//go:build darwin`) because the only front ends are the macOS and
Windows apps. These packages are a web server, a SQLite store, tool plumbing and a supervisor of `ollama serve`; none of them needs the
desktop. The patch widens each tag by `|| linux` (`darwin || linux` for the unix file) and adds `app/updater/updater_linux.go`, one
function (`IsUpdatePending() bool { return false }`) that `app/ui` calls and that otherwise only the macOS/Windows files define.

Not changed: `app/cmd/app` (the desktop entry, with the webview and the tray), `app/updater/updater_{darwin,windows}.go`, `app/dialog`,
`app/webview`, `app/wintray`, `app/auth`, `app/assets`, `app/format`: the headless backend does not import them.

## `backend/vmapp-ui/main.go` (new code, not a patch)

The headless entry point, built inside the Ollama tree as `app/cmd/vmapp-ui`. It is `app/cmd/app/app.go` (v0.35.0) with only what needs a
desktop removed: the webview, the tray and menus, the single-instance and move-to-Applications logic, the update checker, the URL schemes
and the macOS/Windows installers. It keeps, line for line: `server.New(st, devMode)` and the `Run` loop that supervises `ollama serve`,
the `ui.Server` literal (token, the `Restart` closure that restarts the server when the settings change, the store, the tool registry),
`http.Server{Handler: uiServer.Handler()}`, the first-run flag, and the `UserData` refresh after the server answers. Differences, all
because there is no desktop:

* it listens on `VMAPP_OLLAMA_UI_ADDR` (loopback only; the program refuses anything else), token from `VMAPP_OLLAMA_UI_TOKEN`;
* the store's database path is explicit (`VMAPP_OLLAMA_DB`, default `$HOME/.ollama/app/db.sqlite`): on Linux `onboarding.AppDatabasePath()`
  has no default and returns an empty path;
* `IntegrationModels` (the Claude Desktop and Codex Desktop model settings, from `app/cmd/app/desktop_models_darwin.go`) is not set, so
  `GET /api/v1/integrations/{id}/models` is not routed (these integrations configure macOS desktop apps of the host; they cannot work from
  a VM);
* no `Updater`: `ui.Server` handles a nil one.

## UI 1: `index.html` without the inline script

`app/ui/app/index.html` ends with one inline `<script>` that wires the page to the native webview. A D9010 VmApp window runs under
`script-src 'self'` (SPEC 7), which refuses inline scripts. The patch removes the block and loads two files first (not bundled; build.sh
copies them next to `index.html`):

* `/vmapp-fetch.js` (`sdk/web`): `fetch('/api/…')` goes to the backend over the bridge, with streamed answers. `data-route="/ollama/:raw"`
  adds Ollama's own API at `/ollama/…` on the same origin.
* `/ollama-desktop-shim.js` (`apps/ollama-desktop/shim`): everything the inline script and the native shell gave the page:

| In the inline script / native shell (`app/cmd/app/webview.go`) | In the shim |
|---|---|
| `window.selectFiles()` + `__selectFilesCallback` → `window.webview.selectFile/selectMultipleFiles` (native open dialog, extension filter, 10 MB limit, files read by Go) | `window.webview.selectFile/selectMultipleFiles` with an `<input type=file>`; the same extension list and limit; the page reads the bytes the user picked |
| `selectModelsDirectory`, `selectWorkingDirectory` (native folder dialog) | `window.webview.selectModelsDirectory/selectWorkingDirectory` → core → `dialog.showOpenDialog` (folder shared read-write). Not available on the experimental GPU backend (SPEC 8.7): a message is shown |
| `setContextMenuItems` + `menu_handle_selection` → `window.menu(items)` (native context menu on a chat in the sidebar) | `window.menu(items)` draws a menu in the page, at the pointer; same promise, same labels |
| `window.open(url, '_blank')` (sign in, account links) and links in messages | `window.open` and link clicks → core → `shell.openExternal` (https only; the platform asks the user) |
| `document.cookie = "token=…"` (the backend's cookie) | the core adds the cookie to every forwarded request; the page never has it |
| `window.OLLAMA_PLATFORM = runtime.GOOS`, `window.OLLAMA_WEBSEARCH = true` | set by the shim; the platform is **`windows`** on every host: the page's variant for a window with a standard title bar and without the macOS desktop integrations (the sidebar toggle at the left edge, and no "Show apps in menu" or Claude Desktop / ChatGPT model mappings, which configure other apps of a Mac and cannot work from a VM) |
| keyboard guards (Backspace, Cmd/Ctrl+arrows, Alt+arrows, F5, Ctrl+Shift+R), mouse back/forward buttons, dragover/drop | the same handlers, unchanged |
| `contextmenu` guard (only `.allow-context-menu` keeps the menu) | the same |
| `window.ready`, `window.resize`, `close`, `drag`, `doubleClick`, `zoomIn/Out/Reset`, `setOnboardingWindow`, `activateOllama`, `setContextMenuItems` | not mapped: window chrome belongs to the host (the page calls each of them only if it exists); `setContextMenuItems`/`handleContextMenuResult` are no-ops |
| the Claude Desktop and Codex Desktop bindings (`getClaudeDesktop…`, `installCodexDesktop`, …) | not mapped: they configure other macOS apps; the page checks for them and hides the controls when absent |
| the first URL (`http://127.0.0.1:<port>/`) | the window opens `index.html`; the shim rewrites the location to `/` before the router starts |

## UI 2: highlighter

`src/lib/highlighter.ts` builds its shiki highlighter with the default engine, Oniguruma compiled to WebAssembly, which a page without
`'wasm-unsafe-eval'` in its CSP cannot instantiate. The patch passes shiki's JavaScript regex engine (`shiki/engine/javascript`, the engine
that Streamdown already uses for the code blocks of messages). Themes and languages are unchanged. The WebAssembly loader stays in the
bundle as dead code; the run in the loader checks over CDP that no CSP violation is reported.

## UI 3: sign out without `reload()`

Settings > Disconnect signs out and calls `window.location.reload()`. The desktop app serves every path with `index.html`, so a reload of
`/` works; a D9010 VmApp window serves only the files of its package, and its location is `/` only because the shim rewrote it. The patch calls
`window.location.assign("/index.html")`, the same fresh start, valid in both. Nothing else in the page reloads or reads
`location.pathname` in a way that matters: `useDeleteChat` reads `/c/<id>`, which the rewritten location keeps.

## UI 4: the first-run flow without a tray

Welcome > "Create an account" > "No thanks, I'll use Ollama locally" saves the onboarding and used to show a last screen, "Run Ollama" (a
command to copy into a terminal). In the desktop app that screen leads on through the tray icon; a D9010 VmApp window has no tray, so the screen
had no way out. The patch navigates to the chat (`/`) once the choice is saved (`finishSetup`), and `onLocal` no longer switches to the
unreachable step. Signing in (the other way out) is unchanged and still lands on the Apps page (`/connect`).

## Deliberately not patched

* **The pull path.** Pulling is Ollama's: `POST /api/pull` for clients, and for the window `POST /api/v1/chat/{id}` (when the model is
  missing the chat endpoint calls `api.Client.Pull` on the server and streams `download` events). Both end in the patched downloader of
  Go 1. `apps/ollama/core/registry.js` is not used. `src/api.ts` has a `pullModel()` for `POST /api/v1/models/pull`, but **v0.35.0's Go
  server has no such route and the React app never calls the function** (dead code upstream); `ollamaClient` (`ollama/browser`) is
  unused too.
* **Cloud and account.** `OLLAMA_NO_CLOUD` is not set, so the "Cloud" switch and the account section of the settings page work (they need
  `ollama.com`, a host in the manifest the user may refuse). `/api/me`, `/api/signout`, `/api/v1/models/cloud`, web search and the upstream
  freshness check are Ollama's code, unchanged.
* **Avatar images** come from `ollama.com`; the window's CSP (`img-src 'self' data: blob:`) refuses them, so the account avatar shows the
  broken-image fallback. Not worked around (it would mean a proxy for images in the core).
* **Auto-update, tray, login item, "Expose Ollama to the network" and "Allow browser access" in the settings**: the switches stay visible
  and are stored, but there is nothing to update (the D9010 VmApp package is the unit of update), no tray, and the VM has no network device, so
  exposing the port reaches nobody.

## Diff statistics

`diff -ru` of the UI source, upstream against built tree: see `apps/ollama-desktop/CONVERSION.md` ("Diff statistics").
