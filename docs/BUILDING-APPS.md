# Building apps for D9010 VmApp

**For:** app developers. This is everything you need to build, test and ship an app, with no platform internals.
- How the platform works inside: [ARCHITECTURE.md](ARCHITECTURE.md).
- The exact rules: [../SPEC.md](../SPEC.md).
- Converting an existing app: [CONVERTING.md](CONVERTING.md).

---

## 1. What you are building

A D9010 VmApp app has two halves, exactly like an Electron app:

| Half | Electron calls it | In D9010 VmApp it runs… | Written in |
|---|---|---|---|
| **core** | the main process | inside a small Linux VM on the user's computer | **any language**: Node.js (with an Electron-like SDK), .NET, Rust, Go, Python, C… |
| **UI** | the renderer | in a sandboxed window on the user's desktop | HTML, CSS, JavaScript (any framework that builds to static files) |

The UI asks the core to do things with `window.vmapp.invoke('channel', …args)`. The core answers, and can push
messages to the UI at any time. That's the only link between them.

Why bother? Users can run your app **without trusting it**. The core can only reach the folders the user granted,
the network only to the hosts the user granted (none by default), and nothing runs on their computer with their
rights. That makes saying "yes, I'll try it" easy.

## 2. Quick start (5 minutes)

```sh
cd vmapp
tools/vmapp new my-app --id com.yourname.myapp     # copies the starter template into ./my-app
cd my-app
cat TEMPLATE.md                                     # a walkthrough of every file and of the app's life

../tools/vmapp pack . -o my-app.vmapp               # build the package (reproducible, a few KB)
../tools/vmapp install my-app.vmapp
../tools/vmapp run com.yourname.myapp --headless --duration 3000    # quick run without windows
```

To see it with real windows, open the **D9010 VmApp Launcher**. Your app is in its library; click **Launch**.
- **From source,** as a developer: `cd vmapp/loader && npm start`.
- **End users** get a normal Mac app instead. They need no Node.js or npm: Electron carries its own Node for the
  loader's trusted code, and the app runtimes ship inside the bundle. The packaged `.app` is still on the to-do
  list.

Your app's UI never gets Node in either case. Your backend only gets Node inside its VM, when it uses the
`node22` runtime.

The one-time setup is installing the runtime your app uses:
`tools/vmapp runtime-install node22 out/runtimes/node22.img`. The loader does this automatically.

## 3. Project layout

```
my-app/
  vmapp.json        the manifest: id, name, version, runtime, start command, permissions
  core/             everything the core needs; becomes /app in the VM (read-only)
    main.js
  ui/               the UI; served to the app's windows
    index.html
    app.js
    style.css
  test/             optional: headless tests (the template has one)
```

`vmapp pack` turns this into one `.vmapp` file. It adds a SHA-256 for every file to the manifest, so what users
install is exactly what you built.

## 4. The manifest (`vmapp.json`)

```json
{
  "format": 1,
  "id": "com.yourname.myapp",
  "name": "My App",
  "version": "1.0.0",
  "publisher": "Your Name",
  "description": "One sentence users will see before installing.",
  "runtime": "node22",
  "core": { "command": ["node", "main.js"], "memoryMiB": 256, "cpus": 1 },
  "ui": { "root": "ui" },
  "permissions": {
    "folders": [
      { "name": "documents", "access": "read", "purpose": "Shown to the user: why you need it" }
    ],
    "dialogs": true,
    "external": false
  }
}
```

| Field | What to put |
|---|---|
| `id` | reverse-DNS, stable forever. It identifies your app's data and the user's grants across updates. |
| `version` | semver. Users can install the same or a newer version over an old one. |
| `runtime` | `node22` (Node.js 22 + the D9010 VmApp SDK), `dotnet8` (the .NET 8 runtime; ship framework-dependent output), or `native` (nothing but CA certificates; ship a static Linux arm64 binary) |
| `core.command` | how to start your core, run in `/app`. Examples: `["node","main.js"]`, `["dotnet","MyApp.dll"]`, `["/app/myapp"]` |
| `core.memoryMiB`, `core.cpus` | your **recommendation** for the VM's size: 64–32768 MiB and 1–16 vCPUs (defaults 256 and 1). It decides nothing: **the user chooses** the real size at the first launch or on the app's card (default: **one vCPU** and the memory you recommend, never above the user's Mac: its cores, half of its memory). See [Recommended size](#recommended-size-memory-and-vcpus). |
| `permissions` | see §7 |

Every field and every limit is in [SPEC §2.2](../SPEC.md). The template's `TEMPLATE.md` section d) explains each
field in plain words.

### Recommended size: memory and vCPUs

`core.memoryMiB` and `core.cpus` are **recommendations**, not requests: the loader never starts your VM with more than the
user chose (SPEC §8.5), and the user can choose less than you recommend. What this means for you:

- **Recommend what the app needs to run well**, measured, not a round number: the install review shows it ("recommends 2
  vCPUs, 2048 MB"), the Resources row has a **Use recommended** button for it, and a size below it gets a warning.
- **A user who changes nothing gets one vCPU and your recommended memory.** If your app really needs several cores to be
  usable, say so in `description` and recommend them; the user opts in with one click. Don't rely on more than one core
  being there.
- **The VM can be smaller than you recommend**: handle low memory gracefully (`os.availableParallelism()` and `/proc/meminfo`
  tell you what the VM really has). The size is fixed while the app runs; a change applies at the next launch.
- Limits: vCPUs 1-16, memory 64-32768 MiB in the manifest. On the user's Mac the choice is capped at its logical cores and
  half of its memory, so a recommendation above that is lowered there.

## 5. Writing the core

### 5.1 The environment your core runs in

| Path / thing | What it is |
|---|---|
| `/app` | your `core/` files, read-only |
| `/data` (`$VMAPP_DATA`, `$HOME`, `app.getPath('userData')`) | your app's private storage. **Kept** across runs and updates. |
| `/host/f-<name>` | a folder the user granted for your manifest request `<name>`, or absent if they declined |
| `/host/pick-N/…`, `/host/save-N/…` | what the user chose in open and save dialogs |
| `/tmp` | scratch space in memory, gone when the app stops |
| everything else | read-only system files from the runtime |
| network | **none**, except the hosts the user granted (`permissions.network`, §7). They are reached through an HTTP proxy at `127.0.0.1:3128`, which the environment variables below point your HTTP client at. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and lower case), `NO_PROXY`, `NODE_USE_ENV_PROXY=1`, `SSL_CERT_FILE` | set for you (the same whether or not the user granted anything). `SSL_CERT_FILE` is the runtime's CA bundle, when it has one. |
| user | uid 1000, unprivileged |
| `$VMAPP_SOCKET` | the Unix socket your core listens on for the bridge (the Node SDK does this for you) |

The VM starts fresh on every launch. Only `/data` and the user's granted folders persist.

### 5.2 Node.js: the SDK (runtime `node22`)

`require('vmapp')` is built into the runtime, so there's nothing to install. It mirrors Electron's main-process API:

```js
const { app, BrowserWindow, ipcMain, dialog, shell, folders } = require('vmapp');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 640, title: 'My App' });
  await win.loadFile('index.html');                 // a file in ui/
  win.webContents.send('hello', { started: Date.now() });
});

ipcMain.handle('files:list', async () => {
  if (!folders.documents) return null;              // the user declined: handle it gracefully
  return require('fs').readdirSync(folders.documents);
});

app.on('window-all-closed', () => app.quit());      // also the default
```

| API | Members |
|---|---|
| `app` | `whenReady()`, `isReady()`, `on('ready' / 'window-all-closed' / 'before-quit')`, `quit()`, `getName()`, `getVersion()`, `getPath('userData' / 'temp' / 'home')` |
| `BrowserWindow` | `new BrowserWindow({width, height, minWidth, minHeight, title, resizable, webPreferences: {devTools}})`, `loadFile(entry)`, `webContents.send(channel, …args)`, `setTitle`, `focus`, `close`, `on('closed' / 'focus' / 'blur')`, `id`, `BrowserWindow.getAllWindows()`, `BrowserWindow.fromId(id)` |
| `ipcMain` | Electron's: an `EventEmitter` of channels (`on`, `once`, `off`, `removeAllListeners`, `eventNames`, …) plus `handle(channel, (event, …args) => result)`, `handleOnce`, `removeHandler`. `event.reply(channel, …args)` answers the window that sent the message |
| `dialog` | `showOpenDialog([win], {title, properties: ['openFile' / 'openDirectory' / 'multiSelections'], access: 'read' / 'readwrite'})`, `showSaveDialog([win], {title, defaultPath})`, `showMessageBox([win], {type, message, detail, buttons})` |
| `shell` | `openExternal(url)` (`https:` only; the user confirms) |
| `folders` | `{ <name>: path or null }` from the user's choices |

Arguments and return values can be anything Electron's IPC carries (the structured clone algorithm): strings, numbers,
objects, arrays, `Date`, `Map`, `Set`, typed arrays (a `Uint8Array` is how binary data crosses), `BigInt`, `Error`,
`undefined`. A function or a `Symbol` is refused with `… could not be cloned.`. An error thrown in a handler rejects the UI's
promise with `Error invoking remote method '<channel>': <error>` (for example `… 'files:list': Error: no such folder`), as in Electron.

**DevTools.** As in Electron, DevTools are off unless the window asks for them:
`new BrowserWindow({ …, webPreferences: { devTools: true } })`. The user can then open them from the **View** menu
(⌥⌘I; the **Window** menu while your app's own menus are shown), and only for that window. This works in the dev loader and in the packaged one, because *you* decide for your own
windows; the loader's own windows never get DevTools in a packaged build. Turn it on while you build and test, and
**turn it off for production builds** (for example `devTools: process.env.MYAPP_DEBUG === '1'`, or just remove it):
DevTools let anyone using the app read and change its page, its stored data and what it sends to the core. Every other
`webPreferences` key is ignored (the loader fixes them: no Node in the page, sandbox on, no network) and the SDK logs a
warning once. Other-language cores send `devTools: true` in `window.create` (SPEC §6).

Use npm packages normally: install them into `core/` (`npm install --omit=dev` inside `core/`) and they are packed
with your app. Packages with native addons must be built for **linux-arm64**.

### 5.3 Any other language

Your core speaks a small JSON-lines protocol on `$VMAPP_SOCKET`. The full table is in [SPEC §6](../SPEC.md). The
whole loop:

```
listen on $VMAPP_SOCKET; accept the host's connection; read JSON lines:
  {"t":"init", folders:{…}, data:"/data", …}  → remember the folders, send {"t":"ready"},
                                                then {"t":"request","id":1,"op":"window.create","params":{"entry":"index.html","width":800,"height":600}}
                                                (add "devTools":true while developing; the default is false)
  {"t":"invoke","id":7,"win":1,"channel":"x","args":[…]}  → do the work, send {"t":"result","id":7,"result":…}
  {"t":"reply","id":1,"result":{"win":1}}                  → the answer to your request
  {"t":"window","win":1,"event":"closed"}                  → usually: send {"t":"request","op":"app.quit"} and exit
push to the UI any time: {"t":"emit","win":1,"channel":"progress","args":[…]}
```

- **Rust:** see `apps/hasher` (runtime `native`, a static musl binary, `serde_json`). Build with
  `cargo build --release --target aarch64-unknown-linux-musl`.
- **.NET:** see `apps/todo` (runtime `dotnet8`, `System.Text.Json`). Build with
  `dotnet publish -c Release -r linux-arm64 --self-contained false`.

**The one rule that bites:** never block the reading loop while waiting for a reply to your own request (for
example a dialog). Handle each `invoke` on a thread or task.

## 6. Writing the UI

The UI is a normal static web page in `ui/`, with any framework that builds to files: React, Vue, Svelte, plain JS.

```js
const info = await window.vmapp.invoke('files:list');       // → ipcMain.handle in the core
window.vmapp.send('log', 'clicked');                          // → ipcMain.on, no answer
const stop = window.vmapp.on('progress', (n) => bar.value = n);   // ← webContents.send
window.vmapp.app;                                             // { id, name, version }
```

`window.vmapp.ipcRenderer` is Electron's `ipcRenderer` for porting renderer code: `invoke`, `send`, `on(channel, (event, …args) => …)`, `once`,
`addListener`, `removeAllListeners([channel])`, `eventNames()`, `listenerCount(channel)`. `on` and `once` return the function that removes the
listener (not the emitter). `off` and `removeListener` throw an error that says why: a function given again cannot be recognised across the
context bridge, in Electron either. `sendSync` throws, pointing to `invoke`: it would freeze the page while the VM answers.

**Rules the window enforces** (they exist to protect users):

| You can't… | Do this instead |
|---|---|
| `fetch()`, WebSocket or any network | ask the core (the core can reach only the hosts the user granted, §7); or, for **data** the page shows (pictures, an API's JSON, a WebSocket feed), declare the window feature `"network"` in `ui.features` (with `permissions.network`): then `https:`/`wss:` fetches, images, media, fonts and style sheets go to the hosts the user granted, through the app's own proxy, under the same grant as the core (SPEC 8.3 "The app's windows") |
| inline `<script>` or `onclick="…"` attributes | put JS in files: `<script src="app.js">`, `addEventListener` |
| load remote scripts, frames or workers (also with `"network"`) | bundle them into `ui/` |
| open popups or navigate to other sites | `shell.openExternal(url)` from the core (the user confirms) |
| let the user's browser reach a server your core runs (a dev server, a preview) | declare the device `ports`; once the user allows it, `const { ports } = require('vmapp'); await ports.forward(3000)` opens it at `http://localhost:<hostPort>` on the Mac (only the Mac can connect), and `shell.openExternal` accepts that link (SPEC 8.8) |
| use the camera, notifications or geolocation | not available |
| use the microphone | declare `permissions.devices` (§7); then `getUserMedia({ audio: true })` works **in the window**, once the user allows it. Video is always refused. |
| read or write the clipboard from code (a Paste button, a terminal) | declare the device `clipboard`; once the user allows it, `navigator.clipboard` works in the window and `clipboard.readText()` / `writeText()` in the core (`require('vmapp')`). Keyboard ⌘C/⌘V never need it. |
| access Node, `require` or files | ask the core |

`localStorage` and IndexedDB work and are private to your app. For anything important, keep it in the core's `/data`.

**Graphics need no permission.** The window is a normal hardware-accelerated Chromium page, so **WebGL2 and WebGPU work in it** at the
Mac's full GPU speed, and the CSP does not get in the way (shaders are not scripts). Draw in the window and keep the logic in the
core: send small state over the bridge (a few hundred bytes at 30 Hz is plenty) and interpolate in the page; never send frames.
Feature-detect (`navigator.gpu`, then `requestAdapter()`), and keep a WebGL2 path. The sample [apps/gpu-demo](../apps/gpu-demo/README.md)
(Particles) draws up to 2 million particles this way, with a WebGPU compute shader, a WebGL2 fallback and its measured numbers. This
is layer 1 of the GPU story ([VISION.md §4](VISION.md)); apps that must render or compute *inside the VM* need the later Vulkan layers.

## 7. Permissions: ask for little, explain why

| Need | Ask for | User experience |
|---|---|---|
| Work on a folder of the user's documents | `folders: [{name, access: "read"}]` | they pick the folder once, at first launch |
| Edit files in place | `access: "readwrite"` | the permission sheet says your app can change those files |
| Produce output files (exports, renders) | `access: "writeonly"` | your app can drop files there but can't see what's already in it |
| Open one file or folder now and then | `dialogs: true` + `dialog.showOpenDialog` | a native dialog that names your app; you get exactly what they chose |
| Save one file | `dialogs: true` + `dialog.showSaveDialog` | a native save dialog; write the file to the returned path and it's delivered |
| Open a web page | `external: true` + `shell.openExternal(url)` | the user confirms each URL |

**The network** (`permissions.network`, [SPEC §8.3](../SPEC.md)). Your core can call web APIs, but only the hosts you
name and the user allows:

```json
"permissions": {
  "network": [
    { "host": "api.example.com", "purpose": "Fetches the weather for the city you type" },
    { "host": "*.cdn.example.com", "ports": [443], "purpose": "Downloads the icons" }
  ]
}
```

- **Names, never addresses.** A `host` is a lower-case DNS name (`api.example.com`) or a wildcard for its subdomains
  (`*.example.com`, any depth, not `example.com` itself). IP addresses, `localhost`, `*.local`, `*.internal` and a bare
  `*` are rejected at `vmapp pack`, and the host refuses any name that resolves to an address on the user's own network.
  `ports` defaults to `[443]`; port 80 (plain HTTP) is marked "not encrypted" for the user. At most 32 entries.
- **Nothing in your code changes.** In the `node22` runtime `fetch()`, `http` and `https` just work (the environment points
  them at the proxy, `NODE_USE_ENV_PROXY=1`). Rust `reqwest`, Go `net/http`, Python `requests` and `urllib`, `curl` and .NET
  `HttpClient` read `HTTPS_PROXY` too. HTTPS stays end to end: the proxy only sees the host name, the port and the byte
  counts.
- **There is no DNS and no route in the VM.** Anything that opens its own socket (`net.connect`, `tls.connect`, a `ws`
  WebSocket without a proxy agent, a raw `getaddrinfo`) fails: give the name to a proxy-aware client instead.
- **Handle "no".** The user's default is **Don't allow** per host. A refused request fails like an unreachable proxy: for
  `fetch`, a rejected promise (`TypeError: fetch failed`; its `cause` is a generic connection error that varies with the
  Node version, so don't parse it); for plain HTTP, a `403` whose body says why (`D9010 VmApp network: not allowed: …` or
  `network not granted`). The reason is in the core's console log (`net: host:port refused (403): …`, the first 50 per run)
  and in the Inspector. Show a friendly state, keep working offline where you can, and don't retry in a loop.
- **Ask for the narrowest thing that works.** One exact host beats a wildcard; 443 beats 80. The loader shows every entry
  with your `purpose`, and **warns in its own words when the app can also read a folder or the screen** ("could read X and
  send what it reads to Y"). Don't pair a broad read grant with network unless you must.
- **Updates.** A new version that adds a host or a port always stops at the user's "asks for more" sheet, and the new access
  stays off until the user allows it (a host allowed on 443 does not become allowed on a new port by itself). The user can
  also change a host at any time in the card's **Network…** while your app runs: a host taken away is cut off at once, so
  treat every request as one that may be refused.
- **Test it:** `tools/vmapp grant-net <id> api.example.com`, then `tools/vmapp run <id> --headless` (it prints a `[net]` line
  per connection: host, port, allowed or denied, bytes, reason). In a headless script, `session.netRevoke(host)` and
  `session.syncNetwork()` change the running VM, and `session.on('traffic', ev => ev.kind === 'net' && …)` sees every
  connection. `tests/net/` has a complete example against the npm registry.

**The microphone** (`permissions.devices`, [SPEC §8.4](../SPEC.md)):

```json
"permissions": { "devices": [ { "device": "microphone", "purpose": "Records a voice note when you press the button" } ] }
```

- It is the only device. `camera` is reserved: a manifest that names it is rejected at `vmapp pack`.
- The **window** listens, not the core: call `navigator.mediaDevices.getUserMedia({ audio: true })` in your UI. Ask for audio
  only. A request that includes `video`, and `getDisplayMedia`, are refused (`NotAllowedError`).
- To use the sound in the core, send it over the bridge as JSON (for example, base64 chunks from a `MediaRecorder` or an
  `AudioWorklet` through `window.vmapp.send`). The CSP already allows `media-src 'self' blob:` and an `AudioWorklet` module
  loaded from your own `ui/` files.
- **Handle "no".** The user's default is **Don't allow**, and macOS asks again. `getUserMedia` then rejects with
  `NotAllowedError`: show a friendly state and a way to carry on without audio. Ask only when the user presses something, so
  the request has a visible reason.
- Say why in `purpose`: the loader quotes it in the install review and the permission sheet. While your window holds an audio
  stream, the loader shows "Using the microphone now" on your app's card and a pulsing pill in its activity monitor. **Stop the
  tracks** (`track.stop()`) when you are done.
- An update that newly asks for the microphone always stops at the user's "asks for more" sheet.
- To test without a real microphone, run the loader from source with `--use-fake-device-for-media-stream` (Chromium's fake
  microphone). Do not use `--use-fake-ui-for-media-stream`: it makes Chromium accept requests without asking the loader.

Apps that must see the screen, control the mouse and keyboard, run host tools or use MCP servers (computer-use
agents, automation) use `permissions.host`: see [HOST-CAPABILITIES.md](HOST-CAPABILITIES.md) and the sample
[apps/computer-use](../apps/computer-use/README.md).

**The GPU** (`{ "cap": "gpu" }` in `permissions.host`, [SPEC §8.6](../SPEC.md)): an app that runs llama.cpp (or Ollama) can have the
heavy maths run on the user's Mac. Once the user allows it, `127.0.0.1:50052` inside the VM speaks llama.cpp's RPC protocol to a sandboxed
Metal server on the host, and `$VMAPP_GPU_RPC` holds that address (unset when not allowed: fall back to the CPU). Build your llama.cpp
client from the commit in [`gpu/pins.env`](../gpu/pins.env). The details, a code sketch and the measured speed are in
[HOST-CAPABILITIES.md §9](HOST-CAPABILITIES.md).

Tips:
- **Users can decline any folder.** Check `folders.x` for `null` and show a friendly state.
- **Write-only output:** write `name.partial` and rename it when done, so the file is delivered at once and never
  half-written.
- **Prefer dialogs** over broad folder grants when the user works on one file at a time.

## 8. Your app's lifecycle

1. **Install:** the user installs your `.vmapp`. The loader shows your name, publisher, description and permissions,
   with your `purpose` texts.
2. **First launch:** the permission sheet. The user picks folders or declines them.
3. **Launch:**
   1. A fresh VM starts, with your runtime and your `/app`, in about 0.35 s (a Node core is answering after about 0.45 s; `tools/bench boot` measures it).
   2. Your core starts and gets `init` (the SDK fills `folders`).
   3. `app.whenReady()` resolves, and you open windows.
4. **Running:** UI ⇄ core messages; dialogs as needed.
5. **The user closes the last window** → `window-all-closed` → by default `app.quit()`.
6. **Quitting:** `before-quit` fires (you have about 2 s to save to `/data`), then the VM powers off. Write-only
   outputs are delivered.
7. **Stopped from the loader**, or the loader quits: you still get `before-quit` first.
8. **Update:** install a newer version with the same `id`. `/data` and the user's grants are kept.

## 9. Testing

- **Headless** (CI-friendly, real VM, no windows):
  ```sh
  tools/vmapp run <id> --headless --script test/my.test.mjs [--open PATH] [--save PATH]
  ```
  The script gets `{session, wm, dialogs, store}`:
  - `await wm.waitForWindows(1)`
  - `await wm.invoke(1, 'files:list')`
  - `await wm.waitForEmit('progress')`
  - `wm.userClose(1)`

  The starter template's `test/` is a complete example.
- **For real:** run it in the loader. Its **Inspector** shows every message between your UI and your core, with
  timing, plus your core's log and delivered files.
- **Logs:** your core's stdout and stderr go to `$VMAPP_HOME/logs/<id>.console.log`.

## 10. Shipping

```sh
tools/vmapp pack . -o my-app-1.0.0.vmapp
tools/vmapp verify my-app-1.0.0.vmapp        # what the loader checks at install time
tools/vmapp inspect my-app-1.0.0.vmapp       # manifest, package id, sizes
```

Share the `.vmapp` file any way you like. The **package id** (printed by `inspect`) identifies the exact build;
publish it next to your download link. Publisher signatures arrive in a later format.

Typical sizes: a Node app is tens of KB (only your code; Node itself is in the shared runtime). A Rust app is the
size of its binary. A .NET app is its DLLs.

## 11. What format 1 doesn't have yet

There's no network beyond the hosts the user allows (`permissions.network`, §7: TCP through the proxy, no UDP, no inbound
connections), no tray, no notifications, no camera (the microphone needs `permissions.devices`, §7), and no
GPU in the core. Menus work: from the core, Electron's `Menu.buildFromTemplate` / `Menu.setApplicationMenu` (`require('vmapp')`),
or from the page, `window.vmapp.menu.set(template)` with `window.vmapp.menu.onClick(id => …)`; they show in the Mac menu bar with
their shortcuts while your window is focused (SPEC §7 "Menus"; the loader keeps ⌘Q, ⌘H and ⌥⌘H).
Workarounds: show notifications inside your window, and bundle all data your app needs. These are planned as explicit permissions in
later formats.

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Window never opens | the core crashed at start. Read `logs/<id>.console.log`. Check `core.command` and the runtime. |
| `invoke` never resolves | no `ipcMain.handle` for that channel (SDK), or a non-SDK core that blocks its reading loop |
| Script or style doesn't load | an inline script or a remote URL (CSP); move it into `ui/` |
| `ENOENT` on `/host/f-x` | the user declined that folder (`folders.x === null`) |
| `fetch failed` / `ECONNREFUSED` / `403` from `127.0.0.1:3128` | the host isn't in `permissions.network`, the user hasn't allowed it (or revoked it), or the name resolves to a private address. The Inspector's `net` rows and `vmapp run --headless` (`[net] DENIED …`) give the reason. |
| `ENOTFOUND` / `EAI_AGAIN` / "no route" from a library | it opens its own socket or does its own DNS; the VM has none. Use `fetch`/`http`/`https`, or give the library a proxy agent for `$HTTPS_PROXY`. |
| A file in a write-only folder never arrives | it's still changing, or its name ends in `.partial`. Rename it when done. |
| `vmapp verify` fails | the package was changed after `pack`, or a file was added by hand. Re-pack. |
