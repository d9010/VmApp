# Converting a web app with a backend: Bookmarks

A worked example of the **HTTP-over-bridge** pattern. `original/` is a plain web app: an Express server
(`express@4.21.2`, pinned in `package.json` and `package-lock.json`) that serves `public/` and a REST API
(`GET/POST /api/bookmarks`, `DELETE /api/bookmarks/:id`), storing data in `$DATA_DIR/bookmarks.json`. `converted/`
is the same app as a D9010 VmApp, **with the server and the front-end code unchanged**.

```
original/                          converted/
  package.json, package-lock.json    core/package.json, core/package-lock.json   <- identical copies
  server.js                          core/server.js                              <- UNCHANGED, byte for byte
                                     core/node_modules/                          <- npm ci --omit=dev at build time
                                     core/main.js         <- NEW: the D9010 VmApp entry (starts server, bridge, window)
                                     vmapp.json           <- NEW: the manifest
  public/index.html                  ui/index.html        <- + 1 line (<script src="bridge-fetch.js">, first)
  public/app.js                      ui/app.js            <- UNCHANGED, byte for byte
  public/style.css                   ui/style.css         <- UNCHANGED, byte for byte
                                     ui/bridge-fetch.js   <- NEW: fetch() over the bridge
                                     (build.sh)           <- cmp + npm ci + vmapp pack
```

```sh
vmapp/examples/convert-webapp/build.sh out.vmapp      # 2.3 MiB: core.cpio 2.3 MiB (Express + 68 packages), ui 9.8 KiB
vmapp/tools/vmapp install out.vmapp
```

---

## 1. Why this shape

A D9010 VmApp UI cannot use the network at all: every page response carries `connect-src 'none'` (SPEC section 7), so
`fetch('http://127.0.0.1:3000/api/bookmarks')` would be blocked even if the server were reachable. And the server
cannot be reached from the host anyway: the VM has no network device in format 1.

What *is* available:

- **inside the VM**, loopback (`127.0.0.1`) works, so the original server can keep listening exactly as before, for
  the core process only;
- **the bridge** (`window.vmapp.invoke` <-> `ipcMain.handle`) joins the page to the core.

So the pattern is: the core starts the server on loopback, and forwards HTTP requests that the page hands it:

```
renderer (host)                          core (VM)                               server (VM)
 app.js: fetch('/api/bookmarks')
   -> bridge-fetch.js
   -> vmapp.invoke('http', {method,path,headers,body})
        ------- bridge (JSON lines over vsock) ------->
                                          ipcMain.handle('http') -> http.request ->  Express on 127.0.0.1:<port>
                                                         <-- {status, content-type, body} ----
        <---------------------------------------------
   <- Response (status, ok, headers.get, json(), text())
```

Nothing listens on the host. The server's port exists only on the VM's loopback and the page can reach only what
`main.js` chooses to forward.

---

## 2. File by file

### 2.1 `core/server.js`, `core/package.json`, `core/package-lock.json`, `core/node_modules/` - unchanged

`build.sh` first checks that `converted/core/server.js`, `converted/core/package.json`, `converted/ui/app.js` and
`converted/ui/style.css` are byte-identical to the originals (`cmp`), copies the lock file next to them, then runs

```sh
npm ci --omit=dev --ignore-scripts      # in converted/core
```

so exactly the pinned `express@4.21.2` and its 68 production dependencies are installed (3.9 MiB on disk; **no
compiler, no network at run time**). `node_modules` becomes part of `core.cpio` (read-only `/app/node_modules`).
Things that make this work without edits:

| Server code | Why it needs no change |
|---|---|
| `HOST = process.env.HOST \|\| '0.0.0.0'`, `PORT = process.env.PORT \|\| 3000` | the entry sets `HOST=127.0.0.1` and a free `PORT` in the child's environment |
| `DATA_DIR = process.env.DATA_DIR \|\| ./data` | the entry sets `DATA_DIR=/data`. **`/app` is read-only in the VM**, so the default (`./data` next to `server.js`) would fail with `EROFS`: this is the one thing an original must support already (a data dir that is configurable). `/data` is the app's private folder on the host and persists across runs. |
| `fs.mkdirSync(DATA_DIR, {recursive: true})`, tmp file + `renameSync` | works on `/data` as is (the tmp file is created beside the target, on the same mount) |
| `express.static(path.join(__dirname, 'public'))` | `public/` is **not** shipped in `core/`: the UI is served by the host from `ui/`. The route stays in the code and simply finds nothing (the test shows `GET /` -> 404). Left alone on purpose; delete it if you do not mind editing the server. |
| `app.listen(PORT, HOST, ...)` and `console.log` | the child's stdout/stderr are inherited, so the line appears in the loader's app log |

If your server cannot be configured by environment variables, the right move is usually still *not* to patch it
but to wrap the difference (a symlink, an env var, or a small config file generated by `main.js`).

### 2.2 `core/main.js` - new

It is the D9010 VmApp entry (`core.command: ["node", "main.js"]`) and does three things:

1. **Starts the original server** as a child process:
   `spawn(process.execPath, ['server.js'], { cwd: __dirname, env: {..., HOST: '127.0.0.1', PORT: <free port>, DATA_DIR: '/data'} })`.
   The port comes from binding port 0 and closing it (so two apps or a restart cannot collide). `main.js` then polls
   `GET /api/bookmarks` until any HTTP answer arrives (at most 15 s) **before** creating the window, so the page's
   first request never races the server. The bridge `ready` message is sent right after `init` by the SDK, not by
   this code, so a slow server does not hit the 30 s ready limit. If the server exits unexpectedly, the app quits;
   on `before-quit` it sends the child `SIGTERM`.
2. **Opens the window**: `new BrowserWindow({ width: 760, height: 620, title: 'Bookmarks' })` then
   `loadFile('index.html')`.
3. **Registers `ipcMain.handle('http', ...)`**: `{ method, path, headers, body }` -> `http.request` to
   `127.0.0.1:<port>` -> `{ status, headers: { 'content-type' }, body }`. Guards: method must be one of
   `GET HEAD POST PUT PATCH DELETE OPTIONS`; `path` must start with a single `/` (so the renderer cannot make the core
   connect anywhere else - the host is fixed, only the path is the page's); `host`, `connection`, `content-length`,
   `transfer-encoding` request headers are dropped (the core sets `content-length` itself); 15 s timeout. Only
   `content-type` comes back as a header; that is all `fetch` users normally read.

### 2.3 `ui/bridge-fetch.js` - new, loaded first

Replaces `window.fetch` for URLs that point at the page's own origin (`/api/x`, `api/x?y=1`, or the full
`vmapp-ui://<id>/api/x`); everything else falls through to the real `fetch` and is blocked by the CSP, which is the
honest result. It resolves the URL, normalises headers (a `Headers` object, an array or a plain object ->
lower-case plain object), accepts string and `URLSearchParams` bodies, honours `AbortSignal`, and builds a **real
`Response`** (`new Response(body, {status, headers})`: `status`, `ok`, `headers.get`, `json()`, `text()`, `clone()`
all as in a browser; 204/205/304 get a `null` body as the standard requires). A bridge failure becomes a
`TypeError("Failed to fetch: ...")`, like a network error. If a page had no global `Response`, a small stand-in class is
used (this is only unit-tested, never needed in Chromium).

`app.js` calls `fetch('/api/bookmarks', { method, headers, body })` and uses `res.ok`, `res.status`, `res.json()`:
all of it works unchanged.

It must be the first `<script>` so `fetch` is replaced before any app code runs. That is the one edit to
`index.html`:

```diff
--- original/public/index.html
+++ converted/ui/index.html
@@ -16,6 +16,7 @@
   <p id="error" role="alert" hidden></p>
   <ul id="list"></ul>
   <p id="empty" hidden>No bookmarks yet.</p>
+  <script src="bridge-fetch.js"></script>
   <script src="app.js"></script>
 </body>
 </html>
```

(The loader injects nothing into a page, and the app cannot ship a preload, so a script tag is the way to get code to
run first. It has to be a file: `script-src 'self'` forbids inline scripts.)

### 2.4 `vmapp.json` - new

```json
{
  "format": 1, "id": "dev.vmapp.convert.bookmarks", "name": "Bookmarks", "version": "1.0.0",
  "runtime": "node22",
  "core": { "command": ["node", "main.js"], "workdir": "/app", "env": { "NODE_ENV": "production" }, "memoryMiB": 256, "cpus": 1 },
  "ui": { "root": "ui" },
  "permissions": { "folders": [], "dialogs": false, "external": false }
}
```

No folders, no dialogs: the app's data is its own private `/data`. `NODE_ENV=production` makes Express skip its
development behaviour.

---

## 3. Everything, accounted for

| Original | Converted | Status |
|---|---|---|
| `server.js` | `core/server.js` | unchanged |
| `package.json`, `package-lock.json` | `core/package.json`, `core/package-lock.json` | unchanged (`cmp`-checked by `build.sh`) |
| `node_modules` (not committed) | `core/node_modules` | `npm ci --omit=dev` at build time |
| `public/index.html` | `ui/index.html` | one `<script>` line added |
| `public/app.js`, `public/style.css` | `ui/app.js`, `ui/style.css` | unchanged |
| (the listening port, `DATA_DIR`) | `core/main.js` + env | new |
| (nothing) | `ui/bridge-fetch.js`, `vmapp.json`, `build.sh` | new |

---

## 4. The pattern, in general

It works for **any backend that serves HTTP on localhost**, whatever the language. Only two things change:

| Piece | Node (this example) | Any other backend |
|---|---|---|
| runtime in `vmapp.json` | `node22` | `native` (Go, Rust, C, Zig: one static binary), `dotnet8` (needs the app's `dotnet publish` output), or a future runtime (Python/Flask needs a Python runtime image) |
| the core | `main.js` using the D9010 VmApp SDK | **the backend itself can be the core**, if it speaks SPEC section 6 (JSON lines on `$VMAPP_SOCKET`); more simply, keep the server as it is and add the small bridge process: `core.command` can start any program, and the program that owns the bridge socket forwards `http` invokes to `127.0.0.1:<port>` |
| the HTTP server | Express | ASP.NET Core Kestrel, Flask/Gunicorn, Go `net/http`, Rails/Puma, ... bound to `127.0.0.1` and a port from the environment |
| the UI | `ui/bridge-fetch.js` (unchanged for all) | the same file |

Notes for each family:

- **ASP.NET Core (Kestrel).** Set `ASPNETCORE_URLS=http://127.0.0.1:<port>` and `ASPNETCORE_ENVIRONMENT=Production`,
  point its content/data paths at `/data`, and ship the `dotnet publish` output as `core/`. Note that Kestrel needs
  the **ASP.NET Core shared framework**, which the `dotnet8` runtime image (`dotnet/runtime:8.0`) does **not**
  contain: format 1 ships no `aspnet` runtime image yet. Until it does, either build a self-contained publish
  (large), or add an `aspnet8` runtime (`mcr.microsoft.com/dotnet/aspnet:8.0`) to `runtimes/`. The bridge side
  needs no ASP.NET at all (`apps/todo` shows a minimal plain-.NET bridge); `main.js`'s role would be played by a
  small hosted service, or by a wrapper that spawns Kestrel and speaks the bridge.
- **Flask / Python.** There is no Python runtime image in format 1. A Python backend would need a `python3` runtime
  (a new Dockerfile in `runtimes/`) and the app's `site-packages` shipped in `core/` (pure-Python wheels only).
- **Go / Rust.** Static binary + `native` runtime; compile the HTTP server and the bridge into one executable, or
  keep the server and run it as a child of a small bridge binary.
- **Databases.** SQLite works as a file under `/data`. A separate database server (Postgres, ...) would be one more
  child process in the VM with its data directory in `/data`; mind the memory (`core.memoryMiB`).

**Streamed variant.** The two limits below (text only, no streaming) are those of this minimal `bridge-fetch.js`, which is kept as it is.
`build.sh --streaming` builds the same app on the streamed adapter ([docs/CONVERTING.md](../../docs/CONVERTING.md) §5.3, "Streamed bodies"):
a staged copy of `converted/` in which `core/http-bridge.js` (`sdk/node/http-bridge.js`) is added, `ui/bridge-fetch.js` is replaced by
`ui/vmapp-fetch.js` (`sdk/web/vmapp-fetch.js`) in `index.html`, and `converted/` itself is not touched. `core/main.js` has four more lines for
it (a `require('./http-bridge')` that does nothing when the file is not there, so the default build is unchanged and keeps its `http`
channel). `app.js` and `server.js` stay byte-identical either way. `tests/convert/run.sh` builds and runs both (`bookmarks-streaming`).

Limits of the bridge approach (documented in `bridge-fetch.js`):

- **Text only.** `body` is a UTF-8 string both ways. Binary responses (images, PDFs, downloads) and `FormData` / `Blob`
  uploads need a `base64` field on both sides: not implemented here (the streamed variant has them). For images specifically,
  the page can also use `data:` / `blob:` URLs (`img-src 'self' data: blob:`).
- **No streaming, SSE or WebSocket.** One request, one reply; the whole reply is one bridge line (limit 16 MiB). Use
  `webContents.send` + `vmapp.on` for server-pushed events, or the streamed variant (streamed `fetch`, server-sent events as a stream).
- **No cookies / redirects / `XMLHttpRequest` / `<form action>` navigation.** `form-action 'none'` and no navigation
  mean forms must be submitted with `fetch`. Single-page apps work; server-rendered multi-page sites do not
  (every link is a navigation, which the loader blocks).
- **Security.** The renderer is untrusted. The core must validate what it forwards, as `main.js` does (method
  allow-list, fixed host, path check). If your server has admin endpoints you do not want the page to reach,
  allow-list paths in the `http` handler; the server itself can no longer assume "only my own page calls me".
- **`fetch('/relative')` on `vmapp-ui://`.** The page's origin is `vmapp-ui://<id>`; URL resolution of a relative URL
  against it is what `bridge-fetch.js` relies on. It is covered by the Node unit test using the same scheme, not yet
  by a test in the real Chromium loader.

---

## 5. Test

`vmapp/tests/convert/run.sh` (shared with the Electron example):

- `bridge-fetch.test.mjs`: 16 unit checks of `ui/bridge-fetch.js` in Node, against a fake `window.vmapp`, with both
  the native `Response` and the stand-in class.
- `bookmarks.mjs`, in a **real VM**, twice: the window opens after the server answers; `invoke('http', GET
  /api/bookmarks)` -> `200 []`; `POST` -> `201`; `GET` -> 1; `bookmarks.json` is in the app's data dir **on the host**;
  invalid POSTs -> `400` with the server's JSON error; `DELETE` -> `204`, again -> `404`; unknown methods and non-path
  targets are rejected by the `http` handler; the real `bridge-fetch.js` is exercised against the real server; a bookmark
  is left behind and, in the **second run** (a new VM and a new server process), is still there.
