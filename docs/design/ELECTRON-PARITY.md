# Electron parity: one surface for ported apps, and for the agents that write them

**Status:** design and plan (2026-10-19). Written after reading Electron 44.4.5's own source and API documentation (the version the launcher
ships) and comparing it with what the platform offers today. Nothing here changes the format; it lists what to build, in what order, and why.

## 1. The model, and the rule that follows from it

An Electron app has three parts. D9010 VmApp keeps the same three, with the middle one in a different place:

| In Electron | In D9010 VmApp | Where it runs |
|---|---|---|
| **Renderer**: a Chromium page with a `preload` script and `contextBridge` | the same Chromium page; one platform preload (apps cannot ship their own) exposes `window.vmapp` | the Mac, sandboxed |
| **Main process**: Node.js with `require('electron')`: windows, menus, dialogs, files, `ipcMain`, protocols | **two halves**: the app's *core* (Node.js, or another language) with `require('vmapp')`, in a small VM; and the *launcher*, which owns the native windows, menus, dialogs, grants and protocols | the VM, and the Mac |
| **The system** (files, network, GPU, clipboard, ...) | reached only through what the user granted | the Mac |

So the launcher is the part of Electron's main process that touches the Mac, and the core is the part that holds the app's own logic. The
**bridge** (SPEC 6) is the IPC between renderer and core, with the launcher in the middle.

**The rule.** Anything an Electron app does or expects, in either process, should work here the same way, written the same way, **unless a
security boundary says no**. Where Electron solves a problem with a mechanism (a custom protocol handler, `event.reply`, `webContents.send`,
structured clone), we use the same mechanism with the same contract, found in Electron's source and not guessed. A difference is allowed only
when it is a deliberate boundary, and then it is written down (section 4) with the reason and the alternative. The payoff: a ported app is
a mechanical change (`require('electron')` to `require('vmapp')`), and an AI agent that knows Electron can build or convert an app without
learning how the platform works underneath.

## 2. What Electron's contract is (the parts everything else rests on)

From `docs/tutorial/ipc.md`, `docs/api/ipc-main.md`, `ipc-renderer.md`, `context-bridge.md`, `protocol.md` and `lib/browser/ipc-dispatch.ts`:

- **Channels** are arbitrary strings, bidirectional. Renderer to main: `ipcRenderer.send` (one way, `ipcMain.on`) and `ipcRenderer.invoke`
  (two way, `ipcMain.handle`, returns a Promise). Main to renderer: `webContents.send(channel, ...args)` and `ipcRenderer.on`. There is no
  main-to-renderer `invoke`: the renderer answers with a separate `send`. Renderer to renderer goes through main (or a `MessagePort`).
- **The event** given to a main-process listener: `sender` (the `WebContents`), `senderFrame`, `processId`, `frameId`; for `on` also
  `reply(channel, ...args)` and `returnValue` (for `sendSync`). `handle` listeners get the invoke event.
- **`handle` semantics** (`ipc-main-impl.ts`, `ipc-dispatch.ts`): one handler per channel (a second one throws `Attempted to register a
  second handler for '<channel>'`); `handleOnce`, `removeHandler`; no handler rejects the caller with `No handler registered for
  '<channel>'`; a thrown error reaches the renderer **as its message only** (`Error invoking remote method '<channel>': <error>`).
- **Serialisation** is the HTML *structured clone*, not JSON: typed arrays, `Date`, `Map`, `Set`, `BigInt`, `Error`, `ArrayBuffer`,
  `RegExp` and cycles survive; functions, DOM nodes and Electron objects throw.
- **Preload and `contextBridge`**: the page gets only what the preload exposes; the page never gets `ipcRenderer` itself.
- **Custom protocols** (`protocol.registerSchemesAsPrivileged` before `ready`, then `protocol.handle(scheme, handler)`): the handler gets a
  standard web `Request` (URL, method, headers including `Range`, body stream) and returns a standard web `Response` whose body is a stream.
  Privileges that matter: `standard` (relative URLs resolve), `secure`, `supportFetchAPI`, `corsEnabled`, `stream` (needed for `<video>` and
  `<audio>`), `bypassCSP` (we never set it). Electron's own example for an API is exactly a handler that proxies `app://api/...` to a
  server and returns its response. Everything the page loads under that scheme (images, CSS, fonts, scripts, media, `@import`) then works
  natively, with no change to the page.

## 3. Inventory: what the platform has today against Electron

Legend: **yes** same contract; **part** exists, differs or is incomplete; **no** missing; **by design** deliberately different (section 4);
**n/a** does not apply to an app in a VM. "Stage" is the order in section 5.

### 3.1 IPC (the heart of porting)

| Electron | Here | Stage |
|---|---|---|
| `ipcMain` as an `EventEmitter`; `handle/handleOnce/removeHandler` and their error texts | **yes** (stage 1, 2026-10-19; `sdk/node/vmapp.js`) | |
| `ipcMain` event: `type`, `processId`, `frameId`, `sender`, `ports`, `reply(channel, ...args)` | **yes** (stage 1); `senderWindow` is ours. Not yet `senderFrame` (WebFrameMain) | 3 |
| `event.returnValue` / `ipcRenderer.sendSync` | **by design**: it would block the page on a VM round trip; `ipcRenderer.sendSync` throws and names `invoke` | |
| `ipcMain.handle` error text `Error invoking remote method '<channel>': <error.toString()>` | **yes** (stage 1) | |
| `ipcRenderer.invoke/send/on/once/addListener/removeAllListeners/eventNames/listenerCount` | **yes** (stage 1), as `window.vmapp.ipcRenderer.*`; `on`/`once` return the remover | |
| `ipcRenderer.off/removeListener` | **limit, same as Electron**: a function given again is a new proxy across a context bridge (measured in a real Electron window), so the methods throw an error that says so; the remover or `removeAllListeners(channel)` does the job | |
| `ipcRenderer.postMessage`, `MessageChannelMain`, `MessagePort` | **no** | 5 |
| Structured clone of arguments and results | **yes** (stage 1): `sdk/node/ipc-codec.js`, tested against Node's `structuredClone`; cycles cannot cross the page's context bridge (Electron's limit) | |
| `webContents.send(channel, ...args)` | **yes**, structured clone; throws at the call for a value that cannot be cloned | |
| `webContents.ipc`, per-frame `ipc` | **no** | 3 |
| `contextBridge.exposeInMainWorld` for the app's own preload | **by design**: one platform preload; converters turn a preload into a page script (CONVERTING.md 5.2) | |

### 3.2 Resources served to the page (what started this document)

| Electron | Here | Stage |
|---|---|---|
| Page loads images, CSS, fonts, media from files or a protocol handler | **yes** (stage 1, 2026-10-19): the package files, and the files the app's own server serves, natively (`<img>`, CSS `url()` in any form, fonts, `<video>`/`<audio>` with Range, `<link>`, redirects); SPEC §7 "Files the app's server serves"; `tests/apps/media-probe-ui.mjs` | |
| `protocol.handle` with streaming `Response`, Request in, `Response` out | **yes** for the `vmapp-ui://` scheme (the launcher's handler: package first, then the app's core over the bridge); `stream`, `standard`, `secure`, `supportFetchAPI`, `corsEnabled` privileges. **not for apps**: an app cannot register its own scheme or handler | 5 |
| `session.webRequest`, cookies | **by design**: the window has no network of its own (SPEC 7, 8.3) | |

### 3.3 `app`

| Electron | Here | Stage |
|---|---|---|
| `whenReady`, `isReady`, `getName`, `getVersion`, `getPath`, `quit`, `exit`, `before-quit`, `window-all-closed` | **yes** | |
| `getAppPath`, `isPackaged`, `setName`, `getLocale`, `relaunch`, `focus`, `requestSingleInstanceLock`, `second-instance`, `activate` | **no** | 3 |
| `open-url`, `setAsDefaultProtocolClient` (app links) | **part**: `vmapp://<app id>/...` links are delivered (SPEC 8.9); no Electron-shaped event | 3 |
| `dock`, `setBadgeCount`, `getGPUInfo`, command-line switches | **n/a** or **by design** (the launcher owns them) | 4 |

### 3.4 `BrowserWindow` and `webContents`

| Electron | Here | Stage |
|---|---|---|
| `new BrowserWindow({width, height, minWidth, minHeight, title, resizable})`, `loadFile`, `setTitle`, `getTitle`, `focus`, `close`, `isDestroyed`, `getAllWindows`, `fromId`, `closed`, `resize`, `focus`, `blur` events | **yes** | |
| `loadURL` | **by design**: refused; a window shows only the app's own package | |
| `show`, `hide`, `minimize`, `maximize`, `restore`, `setSize/getSize`, `setPosition`, `getBounds/setBounds`, `center`, `setFullScreen`, `isFocused`, `isVisible`, `setAlwaysOnTop`, `setMinimumSize`, `setProgressBar`, `ready-to-show`, `close` with `preventDefault` | **no** | 3 |
| `webContents`: `getURL`, `reload`, `setZoomFactor`, `findInPage`, `print`, `printToPDF`, `capturePage`, `openDevTools`, `insertText`, `setWindowOpenHandler`, `will-navigate`, `did-finish-load`, `before-input-event` | **part**: only `send`, `id`, `isDestroyed`, `getOwnerBrowserWindow`; `devTools` option only | 3 |
| `webContents.executeJavaScript`, `session`, `debugger`, `webPreferences.nodeIntegration` and friends | **by design**: no code injection from the core into the page, no Node in the page | |

### 3.5 Native services

| Electron | Here | Stage |
|---|---|---|
| `dialog.showOpenDialog`, `showSaveDialog`, `showMessageBox` | **yes** (granted folders only) | |
| `dialog.showErrorBox`, `*Sync` variants, `showCertificateTrustDialog` | **no** (the Sync forms: **by design**, they would block the core) | 4 |
| `shell.openExternal` | **yes** (asks the user; https only) | |
| `shell.openPath`, `showItemInFolder`, `trashItem`, `beep` | **no** | 4 |
| `clipboard.readText/writeText` | **yes** (device grant "clipboard") | |
| `clipboard.readHTML/writeHTML/readImage/writeImage/readRTF/availableFormats/clear` | **no** | 4 |
| `Menu`, `MenuItem`, `Menu.buildFromTemplate`, `setApplicationMenu`, roles | **part**: application menu and the common roles | **2** |
| `Menu.popup` (context menus), `menu-item` `accelerator`/`registerAccelerator`, `before-input-event` | **part / no** | **2** |
| `Notification`, `Tray`, `globalShortcut`, `powerMonitor`, `powerSaveBlocker`, `screen`, `nativeTheme`, `nativeImage`, `safeStorage`, `systemPreferences` | **no** (some are launcher features today: tray, panic shortcut, host screen capability) | 4 |
| `net.fetch/request` in the core | **yes**, as Node's own `http`/`fetch` in the VM, under the app's network grants | |
| `desktopCapturer`, `webview`, `BrowserView`, `WebContentsView`, `TouchBar`, `autoUpdater`, `crashReporter`, `inAppPurchase`, `pushNotifications` | **n/a** or **by design** | |

## 4. Deliberate differences (each is a security boundary, and stays)

1. **No Node.js and no `ipcRenderer` object in the page.** The page gets `window.vmapp`, which can only invoke, send and listen.
2. **No `loadURL`, no navigation away, no remote content.** A window shows the app's verified package. The CSP has `connect-src 'none'`.
3. **No `executeJavaScript`, `session` or `debugger` from the core into the page.**
4. **The core is in a VM.** It reaches the Mac only through grants (folders, hosts, devices, host capabilities), never through the filesystem
   or the network of the Mac directly.
5. **No `sendSync` and no `*Sync` dialogs**, because the other end is a VM and a blocked page or core is a hang.

Everything else in section 3 marked **no** or **part** is a gap to close, not a decision.

## 5. Plan, in stages (each one: Electron's contract read first; unit tests; a real-window test with the real CSP; the conversion guide; the
converter checklist)

**Stage 1: resources and the IPC contract.** The page-side SDK layer is built as the fallback for older launchers and published packages.
The primary mechanism is Electron's own: the launcher's `vmapp-ui://` protocol handler answers requests under the app's declared paths
by asking the core over the bridge, and returns a streaming `Response` (with `Range` for media, and the `stream` privilege). Package files
win; only paths the package does not have go to the core. IPC: `event.reply`, `ipcRenderer.once/removeAllListeners/eventNames/listenerCount`,
the `Error invoking remote method` message, and a structured-clone-compatible codec for the bridge (typed arrays, `Date`, `Map`, `Set`, `Error`,
`BigInt`, cycles) so results and arguments behave as in Electron. **Done 2026-10-19** (resources: the native route and its page-side fallback;
IPC: `ipcMain` rebuilt on `EventEmitter`, the codec, the preload's `ipcRenderer`), with the conformance cases of `tests/electron-conformance/MAPPING.md`.
The IPC half needs the runtime images rebuilt (the codec is in `node22` and `node22-gpu`) and ships with the launcher.

**Stage 2: menus.** The application menu, roles, accelerators and context menus (`Menu.popup`) to Electron's contract; VS Code's menu bar
patch then becomes the standard path.

**Stage 3: windows and web contents.** The `BrowserWindow` methods and events and the `webContents` methods and events of the table above,
`app` extras, `webContents.ipc`, `setWindowOpenHandler`, find, zoom, print.

**Stage 4: native services.** `dialog` and `shell` completions, the full `clipboard`, `Notification`, `Tray`, `globalShortcut`, `screen`,
`powerMonitor`, `nativeTheme`, `nativeImage`, `safeStorage`; each one a grant the user can see and revoke.

**Stage 5: messaging between windows** (`MessageChannel`, `postMessage`) and the remaining session-level pieces that can exist without a network.

**How a stage is done.** (1) Read the Electron source and docs for the exact version; write the contract in the stage's section of the spec.
(2) Implement it where Electron does (launcher for what touches the Mac, core SDK for what the app's main code calls, preload for what the page
calls). (3) Keep a tested fallback where an older launcher could meet a newer package. (4) Test every route a page or core can use, in a real
window with the real CSP, for every combination (native path, fallback path). (5) Say in `docs/CONVERTING.md` what an agent should write, in Electron's
own words. (6) Record any deviation in section 4 with its reason.
