# Converting a classic Electron app: Markdown Viewer

A worked example. `original/` is a small, ordinary Electron app. `converted/` is the same app as a D9010 VmApp
(format 1, `node22` runtime). Read this top to bottom once; the tables are the part to keep open while you convert
your own app.

```
original/                         converted/
  package.json                      vmapp.json              <- replaces package.json
  main.js                           core/main.js            <- the main process (3 edits, 1 removal)
  preload.js                        ui/api.js               <- the preload, re-done as a plain page script
  renderer/index.html               ui/index.html           <- + 1 line (<script src="api.js">)
  renderer/renderer.js              ui/renderer.js          <- UNCHANGED, byte for byte
  renderer/style.css                ui/style.css            <- UNCHANGED, byte for byte
```

The app: open a `.md` file with the native dialog (`open-file`), render it with a small built-in converter, keep a
"recent files" list in `userData/recent.json` (`recent:list`, `recent:add`), and a File > Open menu.

Build and try it:

```sh
vmapp/tools/vmapp pack vmapp/examples/convert-electron/converted -o mdviewer.vmapp   # 18.5 KiB
vmapp/tools/vmapp install mdviewer.vmapp
vmapp/tools/vmapp run dev.vmapp.convert.mdviewer --headless --open some.md    # or run it from the Loader
```

`vmapp/tests/convert/run.sh` does this in a real VM and checks the behaviour (see the end of this document).

---

## 1. The model in one paragraph

Electron has a **main process** (Node, full access) and **renderers** (Chromium) joined by a preload script. D9010 VmApp
keeps the split but moves *main* into a VM and replaces the preload with a fixed one that the loader controls:

| Electron | D9010 VmApp |
|---|---|
| main process | **core**: the same Node code, in the VM. `require('electron')` becomes `require('vmapp')`. |
| `preload.js` + `contextBridge` | **gone**. The loader's own preload exposes `window.vmapp` to every page. Apps cannot ship a preload. |
| `ipcMain.handle` / `ipcRenderer.invoke` | the same, with the same channel names: `ipcMain.handle(ch, fn)` / `window.vmapp.invoke(ch, ...args)` |
| `webContents.send` / `ipcRenderer.on` | the same: `win.webContents.send(ch, ...)` / `window.vmapp.on(ch, fn)` |
| renderer files | **ui/**, served by the loader from the installed package with a strict CSP (no network, no inline script) |
| `app.getPath('userData')` | `/data`, which is the app's private folder on the host |
| the user's whole disk | **nothing** except what the user grants (folders in the manifest, or one file at a time through the open dialog) |

---

## 2. File by file

### 2.1 `package.json` -> `vmapp.json` (new file)

`package.json` is not needed by the converted app (it has no dependencies; Electron itself was only a
devDependency). Its job is done by the manifest:

```json
{
  "format": 1,
  "id": "dev.vmapp.convert.mdviewer",
  "name": "Markdown Viewer",
  "version": "1.0.0",
  "publisher": "D9010 VmApp examples",
  "description": "...",
  "runtime": "node22",
  "core": { "command": ["node", "main.js"], "workdir": "/app", "memoryMiB": 256, "cpus": 1 },
  "ui": { "root": "ui" },
  "permissions": { "folders": [], "dialogs": true, "external": false }
}
```

| Manifest field | Where it comes from / why |
|---|---|
| `id` | new: reverse-DNS, lowercase (`^[a-z0-9]+(\.[a-z0-9-]+)+$`). Electron's `appId` in electron-builder is the closest thing. |
| `name`, `version`, `description` | `productName` / `version` / `description` of `package.json` |
| `runtime: "node22"` | the app is a Node app. The VM brings Node 22 and the D9010 VmApp SDK; nothing is bundled. |
| `core.command` | `package.json` `"main": "main.js"` + `electron .` -> `node main.js` (cwd `/app`) |
| `ui.root` | the folder that held the renderer (`renderer/`), now `ui/` |
| `permissions.dialogs: true` | the app uses `dialog.showOpenDialog`. Without this flag the host denies the request. |
| `permissions.folders: []` | none needed: the app only reads files the user picks one by one through the dialog. A viewer of a *whole folder* would list it here. |
| `permissions.external: false` | the app never opens web links (see "Links" below). |
| `electron` devDependency | dropped. There is no Electron in the core; the shared `node22` runtime image provides `require('vmapp')`. |

### 2.2 `main.js` -> `core/main.js` (the main process)

The whole diff (`diff -u original/main.js converted/core/main.js`):

```diff
--- original/main.js
+++ converted/core/main.js
@@ -1,6 +1,6 @@
 'use strict';
 // Markdown Viewer: main process.
-const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
+const { app, BrowserWindow, ipcMain, dialog } = require('vmapp');
 const path = require('path');
 const fs = require('fs/promises');
 
@@ -57,29 +57,6 @@
   return trimmed;
 });
 
-// ---- application menu --------------------------------------------------------------------------------------
-
-function buildMenu() {
-  const template = [
-    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
-    {
-      label: 'File',
-      submenu: [
-        {
-          label: 'Open…',
-          accelerator: 'CmdOrCtrl+O',
-          click: () => mainWindow && mainWindow.webContents.send('menu:open'),
-        },
-        { type: 'separator' },
-        { role: 'quit' },
-      ],
-    },
-    { role: 'editMenu' },
-    { role: 'viewMenu' },
-  ];
-  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
-}
-
 // ---- window ------------------------------------------------------------------------------------------------
 
 function createWindow() {
@@ -89,21 +66,14 @@
     minWidth: 480,
     minHeight: 320,
     title: 'Markdown Viewer',
-    webPreferences: {
-      preload: path.join(__dirname, 'preload.js'),
-      contextIsolation: true,
-      nodeIntegration: false,
-      sandbox: true,
-    },
   });
-  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
+  mainWindow.loadFile('index.html');
   mainWindow.on('closed', () => {
     mainWindow = null;
   });
 }
 
 app.whenReady().then(() => {
-  buildMenu();
   createWindow();
   app.on('activate', () => {
     if (BrowserWindow.getAllWindows().length === 0) createWindow();
```

Every change, with its reason:

| # | Change | Reason |
|---|---|---|
| 1 | `require('electron')` -> `require('vmapp')` | The SDK mirrors the Electron main-process API (`app`, `BrowserWindow`, `ipcMain`, `dialog`, `shell`). This is the one-line port the rest of the file relies on. |
| 2 | `Menu` removed from the destructuring | D9010 VmApp has no `Menu`. **Format 1 has no application menus** (SPEC section 7: the only app-controlled surface is the sandboxed page; the bridge has no menu operation). |
| 3 | the whole `buildMenu()` function and its call removed | see 2. Where its three jobs went: **File > Open...** (`Cmd/Ctrl+O`) is now handled in the UI: the `Open...` button already existed in `index.html`, and the accelerator lives in `ui/api.js` (`onMenuOpen`). **Quit**: the user closes the window; with `window-all-closed` the core quits (see below). **Edit / View roles** (copy, paste, zoom, devtools): not provided by the app any more; the page's own text selection and copy are whatever the loader's window gives it. If you need zoom or similar, build it into the UI. |
| 4 | `webPreferences: { preload, contextIsolation, nodeIntegration, sandbox }` removed | The loader always creates windows with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and its own fixed preload. `BrowserWindow` options other than `width, height, minWidth, minHeight, title, resizable` are not available. |
| 5 | `loadFile(path.join(__dirname, 'renderer', 'index.html'))` -> `loadFile('index.html')` | The window is created on the **host**, not in the VM, so there is no filesystem path to load. The argument is relative to `ui.root` in the manifest; the loader serves it from the installed package. |

What stayed, and works as is:

| Code | Why it needs no change |
|---|---|
| `ipcMain.handle('open-file' / 'recent:list' / 'recent:add', ...)` | Same API, same channels. Handlers may be async; a thrown `Error` reaches the renderer as a rejected promise (message only, no stack). |
| `dialog.showOpenDialog(mainWindow, { title, properties: ['openFile'] })` | Same call. It reaches the host as a native macOS open panel. The result is **not** the file's real path but a read-only clone: `/host/pick-0/<name>`. See "Dialogs" below. `filters` is accepted and ignored in format 1. |
| `fs.readFile(filePath, 'utf8')` | Ordinary Node `fs`, inside the VM, on the clone. |
| `app.getPath('userData')` + `fs.mkdir(..., {recursive: true})` + `writeFile` for `recent.json` | `userData` is `/data`, a folder on the host that persists across runs and updates (`$VMAPP_HOME/data/<id>/`). |
| `app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); })` | Unchanged **and it still does the right thing**: `process.platform` is `linux` in the VM, so closing the window quits the app on every host OS. (The D9010 VmApp default with no listener is also `app.quit()`.) |
| `app.on('activate', ...)` | Accepted, never fires (nothing re-activates a VM app). Harmless; delete it if you like. |
| `app.whenReady()`, `BrowserWindow#on('closed')`, `BrowserWindow.getAllWindows()` | Supported by the SDK. |

### 2.3 `preload.js` -> `ui/api.js` (the pattern worth copying)

The preload is gone, but the renderer still wants `window.api.openFile()`, `window.api.recent()`. Instead of editing
the renderer, `ui/api.js` recreates `window.api` on top of `window.vmapp`, as a plain page script loaded **before**
`renderer.js`:

| `original/preload.js` | `converted/ui/api.js` |
|---|---|
| `const { contextBridge, ipcRenderer } = require('electron')` | `var ipcRenderer = window.vmapp.ipcRenderer` (the loader provides this alias `{ invoke, send, on }` for exactly this purpose) |
| `contextBridge.exposeInMainWorld('api', { ... })` | `window.api = Object.freeze({ ... })` |
| `openFile: (p) => ipcRenderer.invoke('open-file', p)` | same body (it omits the argument when it is `undefined`: bridge arguments are JSON, and `undefined` would arrive as `null`) |
| `recent`, `addRecent` | same bodies, same channels |
| `onMenuOpen(cb)`: `ipcRenderer.on('menu:open', ...)` + `removeListener` | `ipcRenderer.on('menu:open', ...)` (returns its own unsubscribe, so no `removeListener`) **plus** a `keydown` listener for `Cmd/Ctrl+O`: the menu accelerator, now in the UI |

Why a shim and not a renderer edit: the preload is the *only* place that knew about IPC channel names, so it is the
only place that has to change. The rest of the renderer (here ~100 lines) keeps calling `window.api.*` and is
identical to the original. The same shim shape works for any contextBridge API.

The shim is 2 KiB and has no dependencies. It must be a separate file (`script-src 'self'`: **no inline
scripts** are allowed by the loader's CSP).

### 2.4 `renderer/` -> `ui/`

| File | Change |
|---|---|
| `renderer.js` | **none** (byte-identical) |
| `style.css` | **none** (byte-identical) |
| `index.html` | **one line added**: `<script src="api.js"></script>`, before `<script src="renderer.js"></script>` |

The original `index.html` already had its own CSP `<meta>` and an external script file, so it was already
compatible with the loader's CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ...;
connect-src 'none'`). If your page has inline `<script>`, inline event handlers (`onclick="..."`), remote fonts, CDN
scripts or `fetch` to the network, those are the real conversion work: move them into files, vendor them, or route the
network access through the core (see the `convert-webapp` example).

`diff -ru original/renderer converted/ui`:

```diff
Only in converted/ui: api.js
diff -ru original/renderer/index.html converted/ui/index.html
--- original/renderer/index.html
+++ converted/ui/index.html
@@ -16,6 +16,7 @@
     <p id="status" role="status"></p>
     <article id="content"><p class="hint">Open a Markdown file to read it here.</p></article>
   </main>
+  <script src="api.js"></script>
   <script src="renderer.js"></script>
 </body>
 </html>
```

---

## 3. Everything, accounted for

| Original | Converted | Status |
|---|---|---|
| `package.json` | `vmapp.json` | replaced by the manifest (section 2.1) |
| `main.js` | `core/main.js` | 5 edits (section 2.2) |
| `preload.js` | `ui/api.js` | re-implemented as a page script (section 2.3) |
| `renderer/index.html` | `ui/index.html` | 1 line added |
| `renderer/renderer.js` | `ui/renderer.js` | unchanged |
| `renderer/style.css` | `ui/style.css` | unchanged |
| `Menu` / `buildMenu()` | `Open...` button + `Cmd/Ctrl+O` in `ui/api.js` | moved into the UI |
| `webPreferences` | nothing | the loader fixes them |
| `electron` (devDependency) | nothing | replaced by the shared runtime |

The plain `diff -ru original converted` output is just the layout move (the folder structure changed, so it shows
no line diffs):

```
Only in converted: core
Only in original: main.js
Only in original: package.json
Only in original: preload.js
Only in original: renderer
Only in converted: ui
Only in converted: vmapp.json
```

so use the per-pair diffs above (`main.js` -> `core/main.js`, `renderer/` -> `ui/`).

---

## 4. What behaves differently (read before you convert your own app)

**Dialogs and file paths.** `showOpenDialog` returns a path inside the VM: `/host/pick-<n>/<file name>`, a
private read-only *clone* of the file the user chose (an instant APFS clone, no copy of the data). Consequences:

- The core never learns where the file really is, and never sees its siblings.
- The path is **valid for this run only**. `pick-0` is reused on the next run for whatever the user picks then.
  In this example the recent list therefore stores `{path, name, openedAt}` as in the original, but a click on an
  old entry calls `open-file` with a stale path: it fails with `ENOENT` (which the renderer shows in its status line)
  or, in the worst case, re-opens a different file of the same name. The test shows the list *persists*; it does not
  pretend old entries stay openable. To keep reopening files across runs a real conversion would copy the content
  into `/data` on first open, or ask for a *folder* grant (`permissions.folders`) and store paths relative to it.
- Save dialogs work the other way: `showSaveDialog` returns `/host/save-<n>/<name>`; write the file there and the host
  delivers it to the place the user chose.

**Links.** The renderer cannot navigate away and `window.open` is denied. `renderer.js` already calls
`preventDefault()` on link clicks (a good idea in Electron too). To open a link in the user's browser, the core
would call `shell.openExternal(url)` and the manifest needs `"external": true`; the user confirms each URL.

**No menus, no tray, no native notifications, no `webPreferences`.** Design them into the UI or drop them.

**`process.platform`** is `linux` inside the VM, whatever the host is. Code that branches on it (as the
`window-all-closed` handler does) runs its Linux branch.

**Native Node addons / `electron.*` modules the SDK lacks** (`screen`, `clipboard`, `Tray`, `session`, `protocol`,
`autoUpdater`, `powerMonitor`, ...) have no equivalent in format 1. Grep the original for
`require('electron')` and check every name against SPEC section 9.

---

## 5. Test

`vmapp/tests/convert/run.sh` packs `converted/`, installs it into a private data root (`out/work/convert/home`), and runs it twice in
real VMs with a scripted renderer (`tests/convert/mdviewer.mjs`):

1. the window opens (`index.html`, title "Markdown Viewer");
2. `invoke('open-file')` with `--open tests/convert/fixtures/sample.md` returns `{path: '/host/pick-0/sample.md',
   name, content}` with the exact file content; a missing path rejects with `ENOENT`;
3. `recent:add` / `recent:list` work and `recent.json` appears in the app's data folder on the host;
4. in a second run (a new VM), `recent:list` still has the entry, and the list is newest-first and de-duplicated.
