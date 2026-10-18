# The Starter template

This file explains the Starter app you just copied (`vmapp new my-app`). It describes the template as shipped, so it
still says `com.example.starter` and `Starter` where your copy now has your own id and name. Read it once, then edit
the app freely. Delete this file whenever you like: nothing depends on it.

Line numbers below are for the shipped `core/main.js`; the code is also labelled `STEP 1` to `STEP 7`, so you can
search for those instead.

Contents: a) what it is, b) the two halves, c) file by file, d) every `vmapp.json` field, e) the life of this app,
f) build, pack, install, run, test, g) make it your own, h) common mistakes, i) where next.

---

## a) What the Starter is

A small, complete D9010 VmApp that shows every basic idea exactly once, as seven cards in one window:

| Card in the window | What it teaches | Channel in `core/main.js` |
|---|---|---|
| 1. Info | The core runs in a Linux VM, not on your Mac | `info` |
| 2. Your documents folder | A folder the user chose to share (and may refuse) | `documents:list` |
| 3. Counter | State that survives restarts (`/data`) | `counter:get`, `counter:increment` |
| 4. Open a file | A native open dialog; you only get the file the user picked | `file:open` |
| 5. Save a file | A native save dialog; you write, the host delivers | `file:save` |
| 6. Open a link | The only way out to the web: ask, and the user confirms | `link:open` |
| 7. Live events | The core pushing messages to the window | `tick` (core to UI) |

## b) The two halves, and where each one runs

A D9010 VmApp has two halves that never share memory, files or a network. They only exchange small JSON messages through a
bridge that the host controls.

```
 YOUR MAC (host)                                         A SMALL LINUX VM (one per running app)
+----------------------------------------------+       +-------------------------------------------+
| D9010 VmApp Launcher                         |       |  /app   <- core/  (read-only)             |
|                                              |       |  /data  <- the app's private folder       |
|  +----------------------------------------+  |       |  /host/f-documents  <- folder the user    |
|  | UI window (sandboxed Chromium)         |  |       |                        chose (maybe)      |
|  |   ui/index.html, app.js, style.css     |  | JSON  |                                           |
|  |   - no Node, no files, NO NETWORK      |<-+-bridge-+->  core/main.js   (Node 22 + 'vmapp')    |
|  |   - only window.vmapp                  |  | lines |   - ipcMain.handle('info', ...)           |
|  +----------------------------------------+  |       |   - reads files, keeps state, opens       |
|                                              |       |     dialogs, asks the host to open links  |
|  The host also: draws the native dialogs,    |       |   - NO NETWORK, sees only /app, /data and |
|  checks every permission, opens links        |       |     the folders the user granted          |
+----------------------------------------------+       +-------------------------------------------+
        the UI asks:  window.vmapp.invoke('info')   --->   ipcMain.handle('info', fn)  answers
        the UI hears: window.vmapp.on('tick', f)    <---   win.webContents.send('tick', n)
```

Why split it like this? The code that can touch files (the core) is locked in a VM that only contains what the user
allowed. The code that draws the screen (the UI) is locked in a browser sandbox with no network. A bug or a bad
actor in either half cannot reach the rest of your computer.

## c) File by file

```
vmapp.json              the manifest: who the app is, what it needs, what it may ask for
core/main.js            the core (Electron's "main process"): everything that is real work
ui/index.html           the page: seven cards, no logic
ui/app.js               the UI's logic: buttons call the core, results are shown with textContent
ui/style.css            looks (light and dark)
test/starter.test.mjs   headless test that plays "the window" and "the user"
test/run.sh             packs, installs, grants a folder, runs the test twice in real VMs
test/fixtures/          a folder to share and a file to open, used by the test
TEMPLATE.md             this file
```

Only `vmapp.json`, `ui/` and `core/` end up in the package. `test/`, `TEMPLATE.md` and `.gitignore` stay with your
source.

### core/main.js, step by step

| Step | Lines | What and why |
|---|---|---|
| 1 | 22-31 | `require('vmapp')`: the SDK is pre-installed in the `node22` runtime, so no `npm install`. It copies Electron's API, so Electron code ports easily. `folders` is `{ documents: path or null }`. `WINDOW_TITLE` is a placeholder that `vmapp new` replaces. |
| 2 | 34-57 | `state.json` in `app.getPath('userData')` (`/data`). Only `/data` and granted folders survive a stop: the rest of the VM is read-only or in memory. Written via a temp file and a rename, so a stop mid-write cannot leave half a file. |
| 3 | 59-126 | The handlers. `ipcMain.handle('x', fn)` answers `window.vmapp.invoke('x')` in the UI. Results must be JSON. A thrown error reaches the UI as a rejected promise with the message only. Each of the six handlers is the smallest example of its idea. |
| 4 | 128-137 | `app.whenReady()` fires once the host sent its startup info (that is also when `folders` is filled). Only then create windows. `loadFile('index.html')` is relative to the UI folder. |
| 5 | 139-153 | The `tick` timer: `win.webContents.send('tick', n)` reaches `window.vmapp.on('tick', ...)`. The core can talk first, any time. |
| 6 | 156-163 | `before-quit`: the app is about to stop (window closed, user chose Stop, loader quitting). You have about 3 seconds to flush state. `lastTick` is only in memory until here. |
| 7 | 165-171 | `window-all-closed` calls `app.quit()`. That is also the default when you register no listener; it is spelled out so you see the choice. When the core exits, the VM powers off, so quitting really ends the app. |

### ui/ in short

- `index.html` loads `style.css` and `app.js` as separate files. The page is served with a strict Content-Security-Policy,
  so inline scripts, `onclick="..."` attributes and web links to scripts or styles do not work.
- `app.js` has one block per card. It uses only `window.vmapp.invoke` and `window.vmapp.on`, and shows results with
  `textContent` (never `innerHTML`), because file names and file contents come from outside and must never run as code.

## d) Every `vmapp.json` field

| Field | In the Starter | Meaning |
|---|---|---|
| `format` | `1` | The package format version. Always `1` for now. |
| `id` | `com.example.starter` | The app's permanent identity, in reverse-DNS style: lowercase letters, digits, `-`, and at least one dot (3 to 100 chars). Data, grants and updates are all keyed by it, so do not change it after you ship. |
| `name` | `Starter` | The name people see (1 to 60 chars). |
| `version` | `1.0.0` | `MAJOR.MINOR.PATCH`. The loader refuses to install an older version over a newer one (use `vmapp install --force` for that). Bump it for every release. |
| `publisher` | `Your Name` | Free text, up to 100 chars, shown in the loader. Optional. |
| `description` | one sentence | Up to 500 chars, shown in the loader. Optional. |
| `runtime` | `node22` | Which shared Linux image the core runs in: `node22` (Node), `dotnet8` (.NET) or `native` (static binaries: Rust, Go, C). Your app ships only its own code, never a runtime. |
| `core.command` | `["node", "main.js"]` | What to start. The first word is looked up in `PATH`, or is an absolute path, or `./x` relative to `workdir`. |
| `core.workdir` | `/app` | The folder the command runs in (default `/app`; it is where `core/` ends up). |
| `core.memoryMiB` | `256` | The memory you *recommend*, 64 to 32768. The user decides; their default is your recommendation, and they can lower it. |
| `core.cpus` | `1` | The vCPUs you *recommend*, 1 to 16. The user decides; their default is 1 vCPU, with a "Use recommended" button. |
| `core.env` | not set | Optional extra environment variables, e.g. `{ "NODE_ENV": "production" }`. Names must be upper case and must not start with `VMAPP_`. |
| `ui.root` | `ui` | The folder with your UI inside the project (default `ui`). It must not be `core`. |
| `permissions.folders[]` | one entry | Folders the user may share with the app. Up to 8. Each has a `name` (lowercase, becomes the key in `folders` in your code), an `access` and a `purpose`. |
| `...folders[].name` | `documents` | Your code reads `folders.documents`. It is `null` if the user declined, so always check. |
| `...folders[].access` | `read` | `read`, `readwrite` or `writeonly`. This is the most you can get; the user may grant less. |
| `...folders[].purpose` | a sentence | Shown to the user in the permission sheet next to the request (up to 200 chars). Say plainly why you need it; an empty one shows as "no reason given". |
| `permissions.dialogs` | `true` | May the core open native Open and Save dialogs? The user still picks every file. Default `true`. |
| `permissions.external` | `true` | May the core ask to open `https:` links in the user's browser? The user confirms each one. Default `false`. |
| `permissions.network[]` | not set | Optional. Internet hosts the core may reach, up to 32: `{ "host": "api.example.com", "ports": [443], "purpose": "…" }` (`host` is a lower-case name or `*.example.com`, never an IP address; `ports` defaults to `[443]`). The user allows each host separately and none is allowed by default. `fetch()` in the core then just works. See BUILDING-APPS.md §7. |
| `icon.png` (a file) | none | Optional; put it next to `vmapp.json` and `pack` includes it. |

Unknown keys are rejected, so a typo fails at `pack` time instead of being silently ignored. JSON has no comments, which
is why the explanation lives here.

## e) The life of this app, step by step

1. **Install.** `vmapp install starter.vmapp` (or *Install...* in the loader) verifies the package (every file's
   SHA-256, the shape of `core.cpio`), checks that `node22` is installed, and unpacks it under
   `apps/com.example.starter/1.0.0/`.
2. **Permission sheet** (first launch, after an update that adds folders, or when the user chose "ask every time").
   The loader shows what `vmapp.json` asks for: the `documents` folder (read) with your `purpose`, native dialogs, and
   opening links. The user picks a folder or skips it, and may grant less than you asked. The choice is saved. Headless,
   `vmapp grant com.example.starter documents <folder>` does the same.
3. **VM boot.** The host starts one VM: the `node22` runtime as the root disk, `core/` as `/app`, a private folder as
   `/data`, and the granted folder as `/host/f-documents`. It runs `node main.js` in `/app`.
4. **`main.js` runs top to bottom** (STEPs 1 to 7 above). `require('vmapp')` makes the SDK listen for the host. The
   state is loaded and `launches` goes up by one (STEP 2). The six handlers are registered (STEP 3). The
   `whenReady`, `before-quit` and `window-all-closed` hooks are registered (STEPs 4, 6, 7). Then the process waits.
5. **Init and ready.** The host connects the bridge and sends `init` with the app info and
   `folders: { documents: "/host/f-documents" }` (or `null`). The SDK fills `folders`, calls `app.whenReady()`
   callbacks, and tells the host `ready`. The core has 30 seconds to get here.
6. **Window.** The `whenReady` callback (STEP 4, line 135) runs `new BrowserWindow(...)` and `loadFile('index.html')`. The
   host creates a sandboxed window showing `vmapp-ui://com.example.starter/index.html`. The page loads `style.css` and
   `app.js`; `app.js` immediately invokes `info` and `counter:get`. The `tick` timer (STEP 5) starts.
7. **Invokes.** Each click is `window.vmapp.invoke(channel)` in `ui/app.js` and the matching `ipcMain.handle` in
   `core/main.js`. `file:open` and `file:save` additionally make the host draw a native dialog and share exactly what the
   user picked (or where they chose to save) into the VM. `link:open` makes the host ask "open this link?".
8. **Close.** When the user closes the window the host tells the core. The SDK emits `window-all-closed`; STEP 7 calls
   `app.quit()`.
9. **Quit.** `app.quit()` runs the `before-quit` listener (STEP 6: save state), then asks the host to stop the app. If the
   user instead chooses *Stop* in the loader, the host sends `before-quit` first, waits up to 3 seconds, and then
   shuts the VM down.
10. **VM off.** The core exits and the VM powers off. Files written for a save dialog are delivered to the location the
    user chose, on every way of stopping. The next launch starts at step 3 again; `/data/state.json` is still there.

## f) Build, pack, install, run, test

There is no build step: the core and the UI are plain files.

```sh
# once: install the shared runtime image into the data root ($VMAPP_HOME, default $VMAPP_WORK/vmapp-home; see SPEC section 1)
vmapp runtime-install node22 path/to/node22.img

vmapp pack . -o starter.vmapp          # a reproducible package from vmapp.json, ui/ and core/
vmapp inspect starter.vmapp            # id, sizes, permissions, file list
vmapp install starter.vmapp            # verify and install (add --force to go back to an older version)
```

**With the loader.** Open the D9010 VmApp Launcher, choose *Install...*, pick `starter.vmapp`, then open the app. The
permission sheet appears.

**Headless (no window, no human).** Useful for tests and scripts:

```sh
vmapp grant com.example.starter documents ~/Documents          # what the permission sheet does
vmapp run com.example.starter --headless --duration 3000        # boot, wait, shut down, print the log
vmapp run com.example.starter --headless --script my.test.mjs \  # drive the app from a script
     --open some/file.txt --save out/saved.txt --allow-external
```

`--open FILE` and `--save FILE` are the answers the fake user gives to Open and Save dialogs; `--allow-external` says
yes to "open this link?".

**Test.** `test/run.sh` does all of the above for you (pack, purge old data, install, grant the fixture folder, run
`test/starter.test.mjs`, twice) and prints `PASS`. It needs the `vmapp` CLI on your `PATH` (or `VMAPP_CLI=...`) and the
`node22` runtime installed (set `VMAPP_HOME` for a custom data root). The second run proves the counter survived a
restart. `test/starter.test.mjs` is a good model for your own tests: its top comment lists the fake window manager's
calls (`wm.invoke`, `wm.waitForEmit`, `wm.userClose`, ...).

## g) Make it your own

`vmapp new my-app` already did the renaming for you. By hand, change these places:

1. `vmapp.json`: `id` (your own reverse-DNS id, never `com.example.*` for a real app), `name`, `publisher`, `description`.
2. `ui/index.html`: the `<title>` and the `<h1>`.
3. `core/main.js`: `WINDOW_TITLE`.
4. **Permissions.** Ask for the least you need. Remove the `documents` folder entry if you do not use it, or rename it:
   the folder's `name` in `vmapp.json` is the key you read in code (`folders.documents` becomes `folders.photos`).
   Set `dialogs` and `external` to `false` when unused. Every permission is shown to your users.
5. Delete the cards and handlers you do not need: each handler is independent. Keep `before-quit`, the `null` check on
   folders, and `textContent`.
6. Update `test/starter.test.mjs` to match, or delete what no longer applies. Keep `test/run.sh`; it reads the id from
   `vmapp.json`.
7. Bump `version` for every release you hand out.

## h) Common mistakes

- **Inline scripts do nothing.** The page's Content-Security-Policy is `script-src 'self'`: use `<script src="app.js">`,
  never `<script>...</script>` or `onclick="..."`. Add listeners with `addEventListener` in `app.js`.
- **`fetch()` from the UI fails.** The UI has no network (`connect-src 'none'`). Anything that needs the web has to be a
  request through the core. The core has no network either unless the manifest lists the host under
  `permissions.network` and the user allows it (BUILDING-APPS.md §7); `shell.openExternal` opens the user's browser after
  they confirm.
- **Writing outside `/data` or a granted folder.** The VM's disk is read-only apart from `/tmp` (memory, gone after
  a stop) and the shares. Writing to `/app`, `/home`, or `~` fails or vanishes. Use `app.getPath('userData')` for app
  state, a granted folder for user files, or a save dialog.
- **Assuming a folder was granted.** `folders.documents` is `null` when the user said no. Handle it (see `documents:list`).
- **Arguments or results that are not JSON.** `invoke`, `send` and `webContents.send` carry JSON only: no functions,
  `Buffer`s, `Map`s, `Date`s or class instances (convert them first). One message may be at most 16 MiB; send big
  files through a granted folder or a dialog, not through the bridge.
- **Forgetting that the UI can be reloaded.** Keep the truth in the core; the UI should ask for it again on load,
  like `app.js` does with `counter:get`.
- **Using `innerHTML` with outside data.** File names and contents can contain markup. Use `textContent`.
- **Reading a whole big file into one reply.** `file:open` reads only the first 2 KB on purpose.

## i) Where to go next

- `docs/BUILDING-APPS.md`: the guide for app developers (packaging, updating, debugging, the other runtimes).
- `SPEC.md`: the binding specification: the manifest (section 2.2), the bridge messages (section 6), `window.vmapp`
  (section 7), the lifecycle (section 8) and the Node SDK (section 9).
- `docs/SECURITY.md`: what the sandbox does and does not protect against.
- The sample apps in `apps/` (`notes`, `hasher`, `todo`) for larger examples, including Rust and .NET cores.
