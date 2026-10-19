# Converting an existing app to D9010 VmApp

**For:** people and AI agents converting an existing desktop or web app into a D9010 VmApp package. It teaches the model,
the boundaries and a procedure that works for any language. It doesn't dictate how to structure code in each
language.
- Background reading: [BUILDING-APPS.md](BUILDING-APPS.md) (how D9010 VmApp apps work).
- The exact contract: [../SPEC.md](../SPEC.md).

**The principle.** An app that works in Electron works here **written the same way**. The page is Chromium; the app's main process is the core (`require('vmapp')`
instead of `require('electron')`, with the same names and the same behaviour); and what Electron's main process does for the page (answering requests for its
files, opening windows, dialogs, menus) the launcher does here, by Electron's own mechanism, not by a workaround you have to know about. If something that works in
Electron does not work here, that is a gap in the platform to report, not something to patch in the app: the list of what is the same, what differs on purpose
(and why) and what is still to come is [design/ELECTRON-PARITY.md](design/ELECTRON-PARITY.md); each of Electron's own test cases for it is mapped in
[../tests/electron-conformance/MAPPING.md](../tests/electron-conformance/MAPPING.md).

Three complete, tested conversions sit next to this guide (the first two with the original kept for comparison):

| Example | Before | After | What changed |
|---|---|---|---|
| [`examples/convert-electron`](../examples/convert-electron/CONVERSION.md) | a classic Electron app (main + preload + renderer + menu) | the same main process in the VM; the renderer unchanged | `require('electron')` → `require('vmapp')`; the preload becomes a 40-line `ui/api.js` shim; the menu moved into the UI. `renderer.js` and `style.css` are **byte-identical**. |
| [`examples/convert-webapp`](../examples/convert-webapp/CONVERSION.md) | a web app with an Express REST backend | the server runs unchanged inside the VM | a new `core/main.js` starts the server on the VM's localhost and forwards UI requests; `ui/bridge-fetch.js` makes `fetch('/api/…')` travel over the bridge. `server.js` and `app.js` are **unchanged**. |
| [`apps/ollama-desktop`](../apps/ollama-desktop/CONVERSION.md) | **Ollama's own desktop app**: a 59-component React 19 + Vite + Tailwind window, a Go backend (chats in SQLite, settings, cloud), a supervised `ollama serve`, a native webview shell | the same window and the same Go backend, headless in the VM; Ollama itself built from the pinned source | about 14,500 lines of UI and 7,100 lines of Go kept; 15 lines added and 180 removed in the UI (the inline script moves to a shim, three small fixes), 48 lines added in Ollama (blob downloads honour `HTTPS_PROXY`), 23 build tags widened. Streamed answers and uploads over the bridge (§5.3). Every patch is explained in [`patches/PATCHES.md`](../apps/ollama-desktop/patches/PATCHES.md). |

---

## 1. The model you are converting to

```
 HOST (user's computer)                              VM (one per app)
 ┌────────────────────────────┐   bridge   ┌──────────────────────────────────────┐
 │ UI: your HTML/CSS/JS       │◄──────────►│ core: your backend, any language     │
 │ sandboxed renderer:        │ JSON msgs  │ /app (your code, read-only)          │
 │  no Node, no network,      │ via the    │ /data (your app's storage, persists) │
 │  no files, no popups       │ loader     │ /host/... (only what the user grants)│
 │ API: window.vmapp only     │            │ network: allowed hosts only, uid 1000│
 └────────────────────────────┘            └──────────────────────────────────────┘
```

Everything a converted app does falls into one of three places:
1. **Pure UI work** (rendering, input, view state): stays in the UI.
2. **Anything privileged** (files, processes, computation, state, secrets, native libraries): moves to the core.
3. **Things the platform owns** (dialogs, opening links, windows): the core *asks* the host, through the SDK or
   bridge requests.

## 2. Hard boundaries: what is not possible in format 1

Check these first. If an app depends on one, it can't be fully converted yet; plan the gap.

| The app needs | Format 1 | Usual path |
|---|---|---|
| Internet access (APIs, sync, updates) | ✅ from the core only, to hosts the app lists and the user allows (SPEC §8.3); the UI never has network | list each host in `permissions.network` with a purpose; standard proxy env vars are set (Node's `fetch` works) |
| Menus (the Mac menu bar, with shortcuts) | ✅ (SPEC §7 "Menus") | keep Electron's `Menu.buildFromTemplate` / `setApplicationMenu` in the core (`require('vmapp')`), or set them from the page with `window.vmapp.menu.set` |
| Tray, dock, global shortcuts | ❌ | move into the UI (buttons, keyboard handlers in the page) |
| Native notifications | ❌ | show them inside the window |
| Microphone | ✅ with the user's permission (SPEC §8.4) | `permissions.devices`; `getUserMedia` in the UI |
| Screen capture, mouse and keyboard control, host tools, MCP | ✅ as host capabilities the user approves (SPEC §8.2) | `permissions.host`; [HOST-CAPABILITIES.md](HOST-CAPABILITIES.md), sample `apps/computer-use` |
| Camera | ❌ | not convertible yet |
| GPU compute in the backend | ✅ **experimental**: Vulkan inside the VM (runtime `node22-gpu`, `{cap:"gpu", api:"vulkan"}`, SPEC §8.7; the user turns it on). llama.cpp/ggml can also use the GPU over RPC (SPEC §8.6). ❌ Metal, CUDA and ROCm directly. | use the app's Vulkan backend if it has one (sample `apps/ollama-gpu`); otherwise CPU, and list the GPU as a gap |
| Rendering with WebGL / WebGPU in the UI | ✅ | unchanged (sample `apps/gpu-demo`) |
| A backend language with no shared runtime (Python, Java, Ruby…) | ⚠️ the runtimes are `node22`, `dotnet8`, `native` (static binaries) and `node22-gpu` | ship the interpreter and its packages in `core/`, built for linux-arm64 (`node22` is Debian bookworm, glibc), or report it: a new shared runtime is a platform change ([GOVERNANCE.md](../GOVERNANCE.md)) |
| macOS- or Windows-only native code in the backend | ❌; the core is Linux | rebuild for linux-arm64, or move the logic |
| An app-supplied preload or main-process code on the host | ❌ by design | the preload becomes a page script on top of `window.vmapp` (§5.2) |
| Multiple windows | ✅ | `new BrowserWindow` per window |
| Reading and writing user files | ✅ through grants | manifest folders, or open/save dialogs |
| A local HTTP server as backend | ✅ inside the VM | the HTTP-over-bridge pattern (§5.3) |
| npm, NuGet or Cargo dependencies | ✅ packed into `core/` | native addons must target linux-arm64 |

## 3. The procedure (follow in order)

**Step 1: Inventory.** List every place the app touches the outside world:
- file system calls;
- child processes;
- network calls;
- OS APIs (dialogs, shell, clipboard, notifications, menus, tray);
- IPC between UI and backend;
- storage (localStorage, files next to the app, a database);
- native modules.

Write it down as a table: *where in the code → what it does → which side owns it after conversion*.

**Step 2: Check §2.** Mark each inventory row ✅ (maps directly), 🔁 (needs an adapter) or ❌ (a format 1 gap).
Decide what happens to each ❌ before writing code.

**Step 3: Decide the split.** Everything privileged goes into `core/`, and the UI keeps only rendering. If the app
already has a clean UI/backend split (Electron main/renderer, frontend/REST API), **keep it exactly**: that's the
cheapest and safest conversion.

**Step 4: Map file access.**
- **Stored next to the app or in a user-data folder:** → `/data` (`app.getPath('userData')`, `$VMAPP_DATA`).
  `/app` is read-only.
- **A folder the app always works on** → a manifest folder permission (`read`, `readwrite` or `writeonly`) with a
  clear `purpose`. The path is `folders.<name>` in the SDK, or `/host/f-<name>`.
- **"Open a file" / "Save as"** → `dialog.showOpenDialog` / `dialog.showSaveDialog` (`permissions.dialogs`). Picked
  paths are only valid for the current run, so don't store them for later. Copy the content into `/data`, or use a
  folder grant.
- **Exports and outputs** → a `writeonly` folder. Write `name.partial`, then rename it.

**Step 5: Map IPC.** Pick the adapter that keeps the most original code unchanged:
- **Electron** → §5.1 and §5.2;
- **an HTTP backend** → §5.3;
- **anything else** → §5.4.

**Step 6: Write `vmapp.json`.**
- **Choose the runtime:** `node22`, `dotnet8`, `native` for static binaries, or `node22-gpu` (experimental, for Vulkan).
- **Write `core.command`:** how to start the backend from `/app`.
- **Declare only the permissions the inventory needs.**

**Step 7: Build and pack.** Install production dependencies into `core/`, build binaries for linux-arm64, then run
`tools/vmapp pack . -o app.vmapp` and `tools/vmapp verify app.vmapp`.

**Step 8: Test.** Write a headless test (`tools/vmapp run <id> --headless --script t.mjs`, see
[BUILDING-APPS.md §9](BUILDING-APPS.md)) covering every row of the inventory. Then run it in the loader and watch the
**Inspector**: every UI ↔ core message should be one you expect.

**Step 9: Write a CONVERSION.md** in your app, like the examples': every changed line with its reason, and every
removed thing with where it went. A reviewer, or the maintainer of the original, can then check the conversion
quickly.

## 4. Mapping table: common patterns

| In the original | In the D9010 VmApp version |
|---|---|
| `require('electron')` in main | `require('vmapp')` (same names: `app`, `BrowserWindow`, `ipcMain`, `dialog`, `shell`) |
| `new BrowserWindow({webPreferences:{preload,…}})` | `new BrowserWindow({width, height, title})`; the loader sets webPreferences, and apps can't |
| `win.loadFile(path.join(__dirname, 'renderer/index.html'))` | `win.loadFile('index.html')` (relative to `ui/`) |
| `win.loadURL('http://localhost:3000')` | not possible; build the UI to static files in `ui/` |
| `contextBridge.exposeInMainWorld('api', …)` in preload | `ui/api.js` recreating `window.api` on `window.vmapp.ipcRenderer` (§5.2) |
| `ipcRenderer.invoke / send / on / once / removeAllListeners / eventNames / listenerCount` | `window.vmapp.invoke / send / on` (or the same names on `window.vmapp.ipcRenderer`; `on` and `once` return the function that removes the listener). Arguments and results are Electron's: anything the structured clone algorithm copies |
| `ipcRenderer.off / removeListener (channel, fn)` | keep the function `on()` returned and call it, or `removeAllListeners(channel)`: a function cannot be matched by identity across the context bridge (Electron has the same limit under `contextIsolation`) |
| `ipcRenderer.sendSync`, `event.returnValue` | `await ipcRenderer.invoke(…)` with `ipcMain.handle`: a synchronous call would freeze the page while the VM answers |
| `ipcMain.handle / on / once / removeAllListeners`, `event.reply`, `webContents.send` | unchanged (`ipcMain` is an `EventEmitter`, as in Electron) |
| `app.getPath('userData')` | unchanged (it's `/data`) |
| `fs` on user documents | a grant (`folders.x`) or a dialog pick |
| `dialog.showOpenDialog / showSaveDialog / showMessageBox` | unchanged (`filters` are ignored in format 1) |
| `shell.openExternal(url)` | unchanged (`https:` only; set `permissions.external`; the user confirms) |
| `Menu`, `MenuItem` | unchanged for the application menu (`Menu.setApplicationMenu`); roles the loader owns (`appMenu`, `quit`, `about`, `hide`, `services`) and developer roles (`reload`, `toggleDevTools`) are left out, `editMenu`/`windowMenu`/`viewMenu` are expanded; per-window `win.setMenu` and context menus (`menu.popup`) are not available |
| `Tray`, `globalShortcut`, `Notification`, `autoUpdater` | not available; move into the UI or drop |
| `child_process` | works **inside the VM**: a program present in the runtime image, or shipped in `core/` (linux-arm64) |
| `fetch` / `axios` in the UI to the app's own backend | the HTTP-over-bridge adapter (§5.3) |
| `<img src>`, CSS `url()`, `@font-face`, `<video>`, `<audio>`, `<link rel=stylesheet>` or an icon set from script, for files **the app's own server serves** (`/api/avatar/7`, `/assets/logo.svg`) | **unchanged**, with `vmapp-fetch.js` first in the page (§5.3.1); there is nothing to write |
| `protocol.handle('app', …)` / `protocol.registerSchemesAsPrivileged` in main, loading the window from a custom scheme | not available yet (stage 5 of [design/ELECTRON-PARITY.md](design/ELECTRON-PARITY.md)); serve the files from a local server (§5.3) or put them in `ui/` |
| `fetch` to the internet | from the **core** only, to hosts listed in `permissions.network` that the user allows (SPEC §8.3; the proxy variables are set). Never from the UI. |
| `localStorage` / IndexedDB | works, private to the app; keep important data in the core's `/data` |
| a native Node addon (`.node`) | rebuild for linux-arm64 (`npm rebuild` in a linux-arm64 container), or replace it |
| inline `<script>` or `onclick=` | move into `.js` files (CSP) |
| remote CDN scripts or fonts | bundle into `ui/` |

## 5. Adapters (copy these patterns)

### 5.1 Electron main process
Change the `require`, delete `webPreferences` and preload paths, make `loadFile` relative to `ui/`, keep the application
menu (`Menu`), and remove tray and other unsupported APIs (§2). Keep all `ipcMain` handlers as they are.
→ `examples/convert-electron/converted/core/main.js` and its CONVERSION.md §2.2.

### 5.2 The preload becomes a page script
Apps can't ship a preload, because it would run with privileges on the host. Recreate the API it exposed as a plain
script loaded **first** in `index.html`, built on `window.vmapp.ipcRenderer`:
```js
// ui/api.js  (loaded with <script src="api.js"> before the app's scripts)
(function () {
  const ipc = window.vmapp.ipcRenderer;
  window.api = Object.freeze({
    openFile: () => ipc.invoke('open-file'),
    onUpdate: (fn) => ipc.on('update', fn),      // returns an unsubscribe function (Electron returns the emitter; keep the remover, off()/removeListener() cannot match a function across the bridge)
  });
})();
```
The rest of the renderer stays unchanged. → `examples/convert-electron/converted/ui/api.js`.

### 5.3 HTTP-over-bridge (web apps with a local server, any language)
The UI has no network, but the VM has a loopback interface:
1. `core/main.js` starts the **original server unchanged** on `127.0.0.1:<free port>` inside the VM, with its data
   directory pointed at `/data`.
2. It registers `ipcMain.handle('http', …)` to forward requests to that server, with an allow-list of methods and a
   fixed host.
3. `ui/bridge-fetch.js`, loaded first, replaces `fetch` for same-origin relative URLs with
   `window.vmapp.invoke('http', {method, path, headers, body})`, and returns a real `Response`.

Nothing outside the VM can reach the server. → `examples/convert-webapp/` (Express). The pattern works for any
backend that serves HTTP on localhost (ASP.NET Kestrel, Flask, Go net/http), once a runtime with that language
exists. Format 1 ships `node22`, `dotnet8` (no ASP.NET yet), `native` and the experimental `node22-gpu`.

Limits of this minimal adapter (`examples/convert-webapp/converted/ui/bridge-fetch.js`):
- text bodies only, answered whole (no streaming);
- no `XMLHttpRequest` shim;
- no page navigation or form posts: single-page apps convert, multi-page server-rendered apps don't.

#### Streamed bodies (use this one when the app streams, uploads or downloads)

A server that answers with **a stream** (a chat that sends tokens as they are generated, newline-delimited JSON, server-sent events, a
progress feed, a download), or takes **a big or binary request body** (`FormData`, files), needs the streamed adapter. It is two small
files, vendored into the app (they are not part of any runtime), documented in their headers and unit-tested without a VM
(`tests/unit/http-bridge.test.js`) and in real VMs (`tests/apps/ollama-desktop.mjs`, `tests/convert/bookmarks-streaming.mjs`):

| File | Where | What it does |
|---|---|---|
| [`sdk/web/vmapp-fetch.js`](../sdk/web/vmapp-fetch.js) | `ui/`, the first `<script>`: `<script src="vmapp-fetch.js" data-prefix="/api/"></script>` | replaces `window.fetch` for the page's own origin and the listed prefixes; returns a real `Response` whose `body` is a `ReadableStream` fed by the core; sends any request body `fetch` accepts (string, `URLSearchParams`, `Blob`/`File`, `ArrayBuffer`, `FormData` with its boundary, a `Request`) in pieces of at most 768 KiB; honours `AbortSignal` and `reader.cancel()`; routes several servers, one channel each (`data-route="/ollama/:raw"`); also announces those paths to the launcher so pictures, fonts, sounds and style sheets under them load natively (§5.3.1), and does the same from the page when the launcher cannot |
| [`sdk/node/http-bridge.js`](../sdk/node/http-bridge.js) | `core/`: `require('./http-bridge').attach(ipcMain, { port: () => port, prefixes: ['/api/'], headers: () => ({ cookie: '…' }) })` | forwards with `http.request` to a server on `127.0.0.1`, streams the answer back as it is written, and refuses what a page must not do: another host (the server is fixed and must be on the loopback), a path outside `prefixes`, a method outside the list, a pair your `allow(method, path)` refuses, hop-by-hop and credential request headers (`cookie` is yours to set), too many requests at once, an oversized body |

How it works (the wire protocol is in the header of `http-bridge.js`): the page calls `invoke('fetch:open', {id, method, path,
headers, length, text|b64})` (and `fetch:part` for the rest of a big body, each after the core wrote the previous piece); the core answers
with events on one channel, `fetch:ev`: `head` (status and headers), `data` pieces, `end` or `error`. Text answers (JSON, NDJSON,
event streams) travel as UTF-8 strings, split only at character boundaries; other answers as base64.

- **Backpressure.** The core may have at most 256 KiB of the answer sent and not yet read by the page. The page acknowledges a piece
  when its `ReadableStream` hands it to the reader, so a page that stops reading stops the core, which pauses the socket, and the
  server blocks in its own write. Nothing is buffered without bound on either side.
- **Abort.** `controller.abort()` or a cancelled reader makes the core destroy the connection to the server: a server that generates for
  the connection (a chat) stops. A closed window does the same.
- **What it does not do:** cookies, redirects (the core returns the server's own 3xx), `credentials`/`mode`/`cache`, request bodies that are
  streams (read them first), `XMLHttpRequest`, WebSocket and `EventSource` (a streamed `fetch` covers server-sent events).
- **The window's origin has no port**, and HTTP client libraries add one (`ollama-js` turns `vmapp-ui://app` into `vmapp-ui://app:80`):
  the page half compares protocol and host name, not the port.
- **One more server** next to the app's own (for example the raw API of a program the app wraps): attach a second bridge with its own
  `channel`, a mount point (`strip: '/ollama'`) and an `allow` list, and give the page `data-route="/ollama/:raw"`.

→ `apps/ollama-desktop` (Ollama's own desktop app: a streamed chat, model downloads with progress, file attachments) and
`examples/convert-webapp` (`build.sh --streaming` builds the Bookmarks app on this adapter).

#### 5.3.1 Pictures, fonts, sounds and style sheets that the server serves: nothing to write

A web app's server serves more than JSON: avatars, icons, fonts, downloads, audio, a theme's CSS. In a browser or in Electron the page just names them
(`<img src="/avatar/7">`, `url(/fonts/x.woff2)`) and they load. Here the window has no network and loads only its own package, so those names must be
answered by the launcher on the app's behalf. **They are, with no code in the app**, as long as the page loads `vmapp-fetch.js` first and its
`data-prefix` / `data-route` name the server's paths (the same attributes that make `fetch()` work):

```html
<script src="vmapp-fetch.js" data-prefix="/api/,/assets/"></script>   <!-- first; the rest of the page is unchanged -->
```

How it works, in the order it is tried (SPEC §7 "Files the app's server serves"):

1. **The launcher answers, the way Electron does.** The page tells the launcher the paths (`vmapp.serve`); the launcher's `vmapp-ui://` handler answers a
   request under them with a standard `Response`, by asking the core over the bridge (it is Electron's `protocol.handle`, with the core as the server).
   Everything the page loads under those paths works natively: `<img>`, `srcset`, `<picture>`, CSS `url()` in any form, `@font-face`, `<video>` and
   `<audio>` with `Range`, `<link rel=stylesheet>`, `@import`, scripts, `fetch()` with the `self-fetch` window feature. The server's redirects are
   followed. A file of the package always wins over the server's.
2. **If the launcher cannot** (an older launcher; the first run of a package built before), `vmapp-fetch.js` does it from the page: it fetches the
   file over the bridge and puts a `data:` or `blob:` URL in its place, in every place a page can show a picture (SPEC lists them, `tests/apps/media-probe-ui.mjs`
   tests each one in a real window). It sniffs a missing or generic `Content-Type` and follows redirects.

What to check in a conversion:
- the server sends a correct `Content-Type` (**an SVG needs `image/svg+xml`**: as in Electron and every browser, a wrong type does not show when the launcher
  serves it; the page-side fallback is more forgiving and hides this, so test on a current launcher);
- the console shows no `vmapp-fetch: … could not be shown` warning (it names the file and why: too large, a font above 16 MiB in the fallback, a 404);
- the vendored `core/http-bridge.js` is the current one (an old copy corrupts binary answers that have no `Content-Type`).

Not covered by either layer, so give the page the bytes itself (`fetch(...).then(r => r.arrayBuffer())`): `new FontFace(name, "url(...)")`,
`<svg><use href="sprite.svg#id">` (inline the sprite), `<object>`, `<embed>`, `<iframe>`.
Options on the script tag: `data-native="off"` (use the page-side layer only), `data-media="off"` (no page-side layer), `data-media="/avatars/"` (only these
paths), `data-media-max-data` and `data-media-max-blob` (limits in bytes).

### 5.4 Any other backend (a CLI tool, a Python, Go or Rust service)
Write a small core that speaks the bridge protocol (SPEC §6) and calls the existing code: as a library, or as a child
process inside the VM. See `apps/hasher` (Rust) and `apps/todo` (.NET) for complete minimal bridge loops. The one
rule: never block the reading loop while waiting for a reply to your own request.

## 6. Checklist before you call it done

- [ ] Every inventory row is converted, adapted or listed as a known gap in your CONVERSION.md
- [ ] Nothing writes into `/app`; all state lives in `/data` or granted folders
- [ ] No inline scripts, remote resources or `fetch` to the internet in `ui/`
- [ ] Permissions are minimal, and each `purpose` explains the need in user terms
- [ ] Declined folders (`null`) are handled with a friendly message
- [ ] `tools/vmapp verify` passes; the headless test covers every inventory row
- [ ] Every picture, icon, font and sound the original shows shows here too (look at every screen, the toolbars and the extension or plugin icons included), and the
      console has no `Refused to load` and no `vmapp-fetch: … could not be shown` (§5.3.1)
- [ ] The Inspector shows only expected messages during a normal session
- [ ] CONVERSION.md lists changed, removed and unchanged files

## 7. Prompt template for an AI agent doing a conversion

> Convert the app in `<path>` to a D9010 VmApp package, following `vmapp/docs/CONVERTING.md` exactly.
> 1. Produce the inventory table (step 1) and the ✅/🔁/❌ classification (step 2). Stop and report if any ❌ affects
>    a core feature.
> 2. Keep the original UI/backend split. Change as few original lines as possible, and use the adapters in §5.
> 3. Write `vmapp.json` with minimal permissions and clear purposes.
> 4. Build, pack and verify. Write a headless test covering every inventory row, and run it in a real VM.
> 5. Write `CONVERSION.md` (changed / removed / unchanged files, with reasons) and the checklist in §6 with each item
>    ticked or explained.
>
> Never put privileged code in `ui/`, never add a preload, and never relax permissions to make something work. Report
> gaps instead.

### 7.1 Porting a large app from its source repository

A large app (its own build system, native code, a frontend bundler, thousands of files) is converted the way
[`apps/ollama-desktop`](../apps/ollama-desktop/) was. Read that folder before starting: its `CONVERSION.md`,
`patches/PATCHES.md`, `pins.env`, `build.sh`, and its tests `tests/apps/ollama-desktop.mjs` and `ollama-desktop-ui.mjs`.

| Piece | Rule |
|---|---|
| `apps/<name>/pins.env` | The upstream repository, **tag and commit**, the licence file's SHA-256, and every other build input (base images by digest, toolchain versions). The build checks the commit; it never builds an unpinned branch. |
| `apps/<name>/build.sh` | Clones the pinned source (into `$VMAPP_WORK`, never into the repository), applies `patches/`, and builds the core for **linux-arm64** in Docker and the UI to static files. Caches and intermediate files go to `$VMAPP_WORK`; the outputs are only `core/` and `ui/`. Re-runs skip unchanged stages; `--check` verifies the pins and runs nothing. Refuse to start a Docker stage with under 8 GB free. |
| `apps/<name>/patches/` + `PATCHES.md` | The **only** changes to upstream code, as patch files: each one small, explained (why, what breaks without it) and written so the upstream project could accept it. Prefer adding a file (a shim, a D9010 VmApp entry point) to changing one. |
| `apps/<name>/shim/`, `backend/` | New code that adapts the app (the preload replacement, a headless entry point for the backend, the bridge wiring of §5). |
| `vmapp.json` | Minimal permissions, each with a purpose. `core.memoryMiB` must cover the app's working memory **plus the size of `core/`**, which the guest holds in memory ([design/STORAGE.md](design/STORAGE.md), edge case 2); measure it, don't guess. |
| `CONVERSION.md` | Inventory (§3 steps 1 and 2), what was kept, patched, mapped and removed, known gaps, diff statistics (lines kept and changed), the §6 checklist, and how to reproduce and update to a newer upstream tag. |
| `tests/apps/<name>.mjs` | A headless real-VM test covering every inventory row: the app's main flows, persistence across a restart, refused things staying refused (network to unlisted hosts, folders not granted). Add it to `tests/apps/run-all.sh`, skipped when the build is missing. |

**Do not change the platform to make the app work.** That means `hostlib/`, `loader/`, `host/`, `guest/`, `kernel/`,
`runtimes/`, `sdk/` and `SPEC.md`. If the app needs something the platform lacks, find the smallest workaround inside
the app, and write the need under "Platform gaps" in `CONVERSION.md`. A platform change is its own reviewed change
([GOVERNANCE.md](../GOVERNANCE.md)).

## 8. AI CLIs (Gemini CLI, Codex, Claude Code…) as Terminal profiles

An AI command-line tool is the case D9010 VmApp exists for: it reads and writes files, runs commands and talks to a model, and
you would rather not give it your whole Mac. The sample [`apps/terminal`](../apps/terminal/README.md) runs the **Gemini CLI**
and a shell in the VM, on a real pseudo-terminal (the guest mounts devpts, SPEC §4), and shows the pattern. Another CLI is
a *profile*: three changes, no new platform feature.

| Step | What to do | Why |
|---|---|---|
| 1. Install it | Add the tool to `apps/terminal/core/package.json` with an **exact** version (and commit the lock file), or put a static linux-arm64 binary in `core/bin/`. `build.sh` installs it with `npm ci --ignore-scripts`, so no install script runs. | The core is read-only and has no package manager at run time. The tool must run on linux-arm64, so check any native addon. |
| 2. Add the profile | An entry in `core/profiles.js`: `id`, `label`, `command()` (the argv), `env`, and optionally `secret` (the API key's environment variable) and `prepare()`. | The key is typed in Settings, stored in `/data/settings.json` (mode 0600) and handed to that profile's process only. |
| 3. Declare the hosts | In `vmapp.json` `permissions.network`: the API host **by name**, with a `purpose`. Nothing else. | The tool can then reach exactly those hosts, once the user allows them; every other connection gets the proxy's `403`. |

**Finding the hosts.** Allow only the model's API host, run the profile, and read the denied connections: the Inspector's `net`
rows, or `vmapp run --headless`, which prints `[net] DENIED host:port` for each one. A host that matters (the tool's one API)
becomes an entry; telemetry, update checks and the like are better switched off in the tool's own settings (`prepare()` can
write them, as the Gemini profile does) than allowed. The Gemini CLI with an API key needs `generativelanguage.googleapis.com` and
nothing else. As a guide, API-key mode of Codex is expected to need `api.openai.com` and of Claude Code `api.anthropic.com`
(neither is shipped; verify with the Inspector before listing them).

**What does not convert.**
- *Browser sign-in.* "Sign in with Google/ChatGPT/Claude" opens a browser and waits for a callback on `localhost`. The VM cannot
  receive it. Use the tool's API-key mode, as the Gemini profile does.
- *Tools that fetch arbitrary sites* (web search, `git clone`, `npm install` in the shell) fail with `403` unless you list those hosts.
  Listing many hosts is a decision for the user at install time, and each one is a place the tool can send what it reads.
- *Anything that ignores `HTTPS_PROXY`.* The VM has no DNS and no route; programs must use the proxy (SPEC §8.3).

**What to tell the user** (the sample's README does): the tool sees only the folder they grant, it can send what it reads to the
hosts they allow, and the key can be read by whatever runs in the same VM, so grant the narrowest folder and the fewest hosts.
Test it like the sample does: `tests/apps/terminal.mjs` starts each profile in a real VM, checks that the key reaches only its
process, and that a revoked host answers `403`; use a dummy key, never a real one.
