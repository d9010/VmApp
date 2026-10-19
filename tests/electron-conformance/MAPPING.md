# Electron's own test cases, mapped onto this platform

Electron's specs (`spec/*.ts` in the Electron 44.4.5 source, the version the launcher ships) are the best list there is of what an Electron app can
rely on. They cannot be run as they are: they drive Electron's own objects (`BrowserWindow.loadURL`, `webContents.executeJavaScript`,
`nodeIntegration`, `net.fetch` in the main process), which this platform deliberately does not offer (docs/design/ELECTRON-PARITY.md section 4).
So each case is **read, translated into a test of ours, and recorded here**:

- **covered**: a test of ours checks the same behaviour (the test is named);
- **to do (stage N)**: the behaviour is wanted and not yet there or not yet tested (stages in ELECTRON-PARITY.md section 5);
- **n/a**: not applicable, with the reason (a boundary of the platform, or a feature of Electron's own internals).

Keep this file current: when a stage adds a feature, its Electron cases move from "to do" to "covered" in the same change. To read a case, open the
Electron source at the tag (`git clone --depth 1 --branch v44.4.5 --filter=blob:none --sparse https://github.com/electron/electron`, then
`git sparse-checkout set spec docs lib`) and look at the line given.

## spec/api-protocol-spec.ts: `protocol.handle` and privileged schemes (the model for serving the app's files to its page)

| Electron case (line) | Here | Status |
|---|---|---|
| receives requests to a custom scheme (1561) | the page's requests to `vmapp-ui://<app>/...` reach the launcher's handler | covered (every launch) |
| can send buffer body / stream body (1629, 1638) | a bridged answer is a streamed `Response` | covered: `tests/unit/http-bridge.test.js` (streamed answer; binary answers exact) |
| calls destroy on aborted body stream (1647); lets the client abort mid-body (2011) | the page aborts, the core destroys the server's request | covered: `http-bridge.test.js` (AbortSignal, `reader.cancel()`) |
| accepts urls with no hostname / port-like component; normalizes urls in standard schemes (1673 to 1734) | `vmapp-ui` is a standard scheme; the host is the app id; the page half compares protocol and host name, not the port | covered: `http-bridge.test.js` (window origin has no port) |
| can send errors; handles an invalid status, statusText, headers, body; a synchronous or an asynchronous error in the handler (1745 to 1813): the page gets a network error (`ERR_FAILED`, `ERR_UNEXPECTED`), never an invented HTTP status | a core that cannot answer (app not running, server down, too many waiting) gives `Response.error()`; the launcher keeps working | covered: `tests/unit/app-serve.test.js` (a failure is a network error; a server that is down; a core that cannot answer) |
| correctly sets statusCode; content-type and charset (1815, 1824) | status, status text and headers are the server's | covered: `app-serve.test.js` (status, headers and every byte; a 404 stays a 404; an empty 204), `http-bridge.test.js`; real window: `media-probe-ui.mjs` (both modes) |
| can forward to http, with headers (1836, 1853) | the native route forwards method, headers (incl. `Range`) and body to the core's server | covered: `app-serve.test.js` (a request with a body; Range reaches the server) |
| can forward to file (1872) | package files are answered first, by the existing handler | covered: `app-serve.test.js` (the package first; a tampered file is refused and never replaced), `loader-cdp` runs (every app UI) |
| relaying an untouched net.fetch response: small and large bodies byte for byte, slow upstream, encoded upstream, abort (1884 to 2011) | large and slow answers through the bridge, with flow control; a cancelled body gives its place back | covered: `http-bridge.test.js` (backpressure, binary exact, abort), `app-serve.test.js` (200 KB byte for byte; a cancelled body frees its place; at most 24 in flight), `media-probe-ui.mjs` (a 1 MB bitmap and a 1.2 MB font) |
| redirects: a 3xx with a Location becomes a real redirect (`ToResponseHead`, `StartLoading`: `IsRedirect`, `OnReceiveRedirect`) | the server's redirect is followed by the page | covered: `app-serve.test.js` (the 302 comes back as a 302), `media-probe-ui.mjs` (an image behind one and behind two redirects, native; page-side layer follows them too) |
| a missing Content-Type is `text/html`; the handler's Content-Type is authoritative; Chromium sniffs raster pictures (`ToResponseHead`) | the same: not repaired by the native route, so an SVG needs `image/svg+xml`; the page-side layer is more forgiving | covered: `media-probe-ui.mjs` (native: png without Content-Type shows, an SVG with a wrong type does not, as in Electron; fallback: both show) |
| can receive a simple, stream, multipart or streaming-fetch request body (2024 to 2226) | request bodies of the page reach the server | covered: `http-bridge.test.js` (request bodies: Blob, FormData, URLSearchParams, Request); the browser's own `<form>` posts: n/a (no navigation, `form-action 'none'`) |
| supports sniffing mime type (2309) | a missing or generic Content-Type is resolved from the bytes, then the extension | covered: `tests/unit/vmapp-fetch-media.test.js` (sniff, resolveMime), `tests/apps/media-probe-ui.mjs` (png without Content-Type; svg as octet-stream and as text) |
| does not emit undefined chunks into the request body stream; does forward Blob chunks (2339 to 2440) | upload pieces of exactly the bytes sent | covered: `http-bridge.test.js` (a large Blob goes in pieces and arrives exactly) |
| filters an illegal "origin: null" header (2413) | the core's bridge drops headers a page must not set | covered: `http-bridge.test.js` (the core refuses what a page must not do) |
| is fast (2465): an intercepted fetch is not much slower than a direct one | a 128 MB body through the launcher and the bridge | to do (stage 1: a throughput test; the bridge's flow control is 256 KiB in flight, a streamed answer is bounded by it) |
| registerSchemesAsPrivileged **standard**: relative URLs resolve (1037) | `vmapp-ui` is registered `standard`; a relative `<img src="a.png">` and a linked sheet's relative `url()` work | covered: `media-probe-ui.mjs` (linked sheet with relative urls) |
| registerSchemesAsPrivileged **stream**: `<video>` and `<audio>` over a streamed response, with Range (1400) | `vmapp-ui` is registered with `stream: true` | covered: `media-probe-ui.mjs` native (audio plays from a 206 answer; the server saw the Range requests); video: the sample in Electron's suite uses a generated WebM, ours uses audio (same element machinery), a video test is to do |
| registerSchemesAsPrivileged **corsEnabled / supportFetchAPI** only: cross-origin enforcement (1152) | `vmapp-ui` is `corsEnabled` + `supportFetchAPI`; another origin's page is never a page of this app | covered: `loader-cdp` (a frame of another origin has no access to the page) |
| registerSchemesAsPrivileged invalid scheme names (967) | the schemes are fixed in the launcher | n/a |
| registerSchemesAsPrivileged **cors-fetch** (1116) | `fetch()` to `vmapp-ui://` from the page; `connect-src 'none'` unless the app declares `self-fetch` | covered: `loader-cdp` (window features) |
| allowServiceWorkers (1006) | only `vmapp-frame://` (isolated frames) allow service workers | covered: `tests/apps/vscode-ui.mjs` (the webview's service worker) |
| codeCache (1506) | V8 code cache for the page's scripts | n/a (not used) |
| `handle` receives requests to the existing https or file scheme; intercept; `net.fetch` bypass (1587 to 1630, 2254 to 2309) | the loader never intercepts `https` or `file` | n/a (the window has no network) |

## spec/api-ipc-spec.ts, api-ipc-main-spec.ts, api-ipc-renderer-spec.ts: `ipcMain` and `ipcRenderer`

| Electron case (line) | Here | Status |
|---|---|---|
| invoke: a response from a synchronous and from an asynchronous handler (37, 52) | `ipcMain.handle` | covered: `tests/unit/session.test.js`, `sdk-probe` |
| invoke: an error from a synchronous and from an asynchronous handler (68, 82); the renderer's text is `Error invoking remote method '<channel>': <error.toString()>` (`lib/renderer/api/ipc-renderer.ts`, `lib/browser/ipc-dispatch.ts`) | the same text, with the handler's class name (`TypeError: bad type`) | covered: `bridge.test.js` ("a handler that throws"), `loader-cdp` run C ("Electron's contract") |
| invoke: no handler registered; a handler that was removed (97, 108) | `Error invoking remote method 'x': Error: No handler registered for 'x'` | covered: `bridge.test.js`, `loader-cdp` run C |
| invoke: multiple handlers are forbidden (121); a handler that is not a function (`ipc-main-impl.ts`) | `Attempted to register a second handler for '<channel>'`; `Expected handler to be a function, but found type '<type>'` | covered: `bridge.test.js` ("a second handler, a non-function, handleOnce, removeHandler") |
| invoke: the reply callback dropped (132) | n/a for a core handler (a promise that never settles is the app's own bug) | n/a |
| payloads: strings, typed arrays and nested objects of each size through invoke and send (183) | strings, `Uint8Array`, nested objects up to 3 MiB + 1 in both directions | covered: `ipc-codec.test.js` ("payload sizes"), `bridge.test.js` ("large payloads"); sendSync: n/a |
| ordering between send, sendSync and invoke (211 to 300) | `send` and `invoke` keep their order on one channel; `sendSync` does not exist | covered (send/invoke): `bridge.test.js` ("listeners run in the order…"), `loader-cdp`; sendSync: n/a by design |
| ipcRenderer.send: an object with an `id` property; `Date`; `Buffer`; objects that reference the same object (29 to 108) | the structured clone codec (`sdk/node/ipc-codec.js`), compared with Node's `structuredClone` | covered: `ipc-codec.test.js` (each case is named after Electron's); `loader-cdp` run C (page to core and back) |
| ipcRenderer.send: cyclic references (110) | cycles work between the launcher and the core; **not across the page's context bridge** (Electron's own `contextBridge` limit, "recursion depth exceeded") | covered: `ipc-codec.test.js`, `bridge.test.js` ("typed-self"); the limit: `loader-cdp` run C |
| ipcRenderer.send throws for DOM objects and functions (63, 72); does not crash for external objects (72) | `… could not be cloned.` (V8's text; Electron raises it in the renderer) | covered: `ipc-codec.test.js` (messages equal `structuredClone`'s), `loader-cdp` run C (send throws, invoke rejects), `bridge.test.js` (`webContents.send` throws) |
| ipcRenderer.sendSync with `event.returnValue` (131; ipc-main 17 to 55) | the page would block on a VM round trip | n/a by design: `ipcRenderer.sendSync` throws and names `invoke`; covered: `loader-cdp` run C |
| ipcMain.on can be replied to: `event.reply` (ipc-main 73) | `event.reply(channel, ...args)` on the event | covered: `bridge.test.js`, `loader-cdp` run C |
| `event` of ipcMain.on / handle: `type`, `processId`, `frameId`, `sender`, `ports`, `reply` (`structures/ipc-main-event.md`, `ipc-main-invoke-event.md`) | present; `senderFrame` (WebFrameMain) and `returnValue` are not | covered: `bridge.test.js` ("IpcMainEvent and IpcMainInvokeEvent have Electron's shape"); `senderFrame`: to do (stage 3) |
| ipcMain/ipcRenderer.removeAllListeners: only the given channel; all channels (ipc-main 100 to 125; ipc-renderer 153 to 186) | `ipcMain` is an `EventEmitter`; `ipcRenderer.removeAllListeners([channel])`, `eventNames()`, `listenerCount()` | covered: `loader-cdp` run C; `ipcMain`: `bridge.test.js` ("ipcMain is an EventEmitter") |
| ipcRenderer.once / off / removeListener / addListener (docs) | `once` and `addListener` yes (return the remover); `off` and `removeListener` throw: a listener cannot be matched by identity across a context bridge (Electron has the same limit; measured in a real Electron window) | covered: `loader-cdp` run C |
| `ipcMain.on` / `ipcRenderer.on` are not used for internals (ipc-main 57; ipc-renderer 144): `ipcMain.eventNames()` is `['error']`, `ipcRenderer.eventNames()` is `[]` | the platform's own channels are not visible to the app | covered: `bridge.test.js` (`error` only), `loader-cdp` run C (page `eventNames` has only the page's) |
| ipcRenderer after the context is released throws (187) | n/a (the page is destroyed with its window) | n/a |
| an async listener that rejects, a listener that throws (Electron: uncaught exception in the main process) | logged in the app log; the core stays up | covered: `bridge.test.js` (deliberately safer than Electron) |
| MessagePort, MessageChannelMain, `postMessage` with transfer (308 to 858) | | to do (stage 5) |
| `WebContents.ipc`, `WebFrameMain.ipc`, frame accessors (859 to 1170) | per-window and per-frame handlers that override `ipcMain` | to do (stage 3) |

## spec/api-context-bridge-spec.ts

n/a as a whole: apps cannot ship a preload (one platform preload exposes `window.vmapp`; ELECTRON-PARITY.md section 4, item 1). What a ported preload did is
turned into a page script by the conversion (docs/CONVERTING.md 5.2).

What the platform's own preload inherits from `contextBridge`, and the Electron case that fixes it:

| Electron case (line) | Here | Status |
|---|---|---|
| "should throw an error when recursion depth is exceeded": nesting of 999 works, 1000 throws (1027); there is no cycle detection, so a cyclic value throws the same | arguments and results of `window.vmapp.*` cross this bridge: a cyclic value or one nested 1000 deep throws "recursion depth exceeded" in the page. Between the launcher and the core, cycles work (`ipc-codec`), nesting is limited to 1000 as well | covered: `loader-cdp` run C (a cyclic argument and a cyclic result), `ipc-codec.test.js` (MAX_DEPTH) |
| a function passed to the bridge is proxied; the same function passed twice is two different proxies (no identity) | `ipcRenderer.off` / `removeListener` cannot find a listener again; they throw an error that says so. Measured in an Electron 44 window before the design was fixed | covered: `loader-cdp` run C |
| types: Date, Map, Set, typed arrays, BigInt, Error, RegExp, `undefined`, `-0` and `NaN` cross intact; a Symbol is dropped; a Promise resolves on the other side | the same, measured | covered for Date, Map, Set, typed arrays, BigInt, Error, `undefined`, `-0`, `NaN`: `loader-cdp` run C; RegExp and Symbol were only measured in a throwaway window |

## Still to read, with their stages

`api-menu-spec.ts`, `api-menu-item-spec.ts` (stage 2); `api-browser-window-spec.ts`, `api-web-contents-spec.ts`, `api-app-spec.ts` (stage 3);
`api-dialog-spec.ts`, `api-shell-spec.ts`, `api-clipboard-spec.ts`, `api-notification-spec.ts`, `api-tray-spec.ts`, `api-global-shortcut-spec.ts`,
`api-screen-spec.ts`, `api-native-theme-spec.ts`, `api-power-monitor-spec.ts`, `api-safe-storage-spec.ts` (stage 4); `chromium-spec.ts` (resource loading in the
renderer, checked against `media-probe` as it grows).
