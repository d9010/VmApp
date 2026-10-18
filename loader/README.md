# D9010 VmApp Launcher

The user's app manager and renderer host for D9010 VmApp packages (SPEC sections 1, 7, 8). Electron 44.4.5, no other runtime
dependencies. The loader is the only host-side code that ever runs for an app: the app's core runs in a VM
(`vmapp-vm`, driven by `hostlib/AppSession`), its UI runs in a sandboxed renderer served by `vmapp-ui://`.

## Run it (dev)

```sh
cd vmapp/loader
export ELECTRON_CACHE=$PWD/../out/work/electron-cache npm_config_cache=$PWD/../out/work/cache/npm   # optional: keeps the caches out of your home
npm install                      # electron 44.4.5 (exact); node_modules is git-ignored
unset ELECTRON_RUN_AS_NODE       # some harnesses set it; electron would then run as plain node
npm start                        # = electron .   (add --inspector to open the bridge inspector too)
npm test                         # = node test/loader-cdp.mjs  (real VMs, see "Tests")
```

- **Data root:** `$VMAPP_HOME`, default `$VMAPP_WORK/vmapp-home` (`VMAPP_WORK` defaults to `out/work` in the
  repository, git-ignored). Chromium's own
  state (`userData`) lives in `<home>/electron`, so partitions never touch the user's real profile.
- **Binaries (dev):** `vmapp/out/{vmapp-vm,Image,initramfs.cpio}`; override with `VMAPP_VM`, `VMAPP_KERNEL`,
  `VMAPP_INITRAMFS`.
- **Runtimes:** at start, every `vmapp/out/runtimes/<name>.img` that is missing from `$VMAPP_HOME/runtimes` (or differs
  in size or mtime) is installed with `Store.installRuntime` (an APFS clone, so it is instant).
- Install `.vmapp` files with *Install from file…* (or `tools/vmapp install`); run a project folder with *Run project folder…*.

## What you get

- **Library window:** one card per installed app: name, version, publisher, runtime, short package id, a summary of the
  requested permissions and of *your* choices, a "Sandboxed VM" marker and the running state. Buttons: **Launch**,
  **Stop**, **Permissions**, **Inspect**, **Logs**, **Publish…**, **Reset...**, **Uninstall...** (with "also delete app
  data"); a developer build also has **Rebuild & run** and a "Developer build from <folder>" badge (see below).
  *Reset* (SPEC 2.2 "Future") empties `data/<id>/`, forgets `grants/<id>.json` and clears the app's UI storage; it is
  disabled while the app runs, like Permissions and Uninstall. Errors appear inline and never crash the loader.
- **Install review:** *Install from file…* opens a native file dialog, verifies the package, and shows the manifest, the full
  package id, sizes, runtime/command and every permission with its purpose ("no reason given" when empty) before it
  installs. Downgrades and missing runtimes are refused with a reason.
- **Load examples** (SPEC 8.1; `src/examples.js` (pure), `Library.examplesInfo/examplesList/installExamples` in `src/library.js`, the
  sheet in `ui/library.js`): the sample apps that came with the loader, from `<Resources>/vmapp/examples/` when packaged
  (`tools/package-mac.sh --with-examples`, see [PACKAGING.md](PACKAGING.md)) or `vmapp/out/examples/` (`tools/pack-examples`) in
  development; `VMAPP_EXAMPLES_DIR` points a development loader at another folder and a packaged loader ignores it. An empty library
  offers **Load examples** (primary) and **Install from file…**; **File → Load examples…** (⇧⌘E) is always there when the loader has
  examples. A development loader with none says to run `tools/pack-examples`; a packaged one hides the button and the menu entry.
  The sheet lists each `.vmapp` as the package itself describes itself (the manifest is read from the first tar entry: name,
  description, version, size, and badges **Network: hosts**, **GPU**, **Control of your computer**, **Microphone**), with the
  "What to allow" hint from the folder's `README.md` table row for that file (else derived from the manifest), a checkbox each (all
  checked; a file that is no package is shown with its problem and cannot be chosen), and the note "Installing doesn't grant
  anything: each app asks for its permissions the first time you launch it." **Install selected** runs `lib:examplesInstall`: for each
  chosen file, one after the other, *verify* (`hostlib/package.js` `read`) then *install* through `Library._installFile`, the same
  path as *Install from file…* (verify again, refuse a running app, `Store.install`); progress reaches the page as
  `lib:examplesProgress`. A version that is already installed, or older than the installed one, is skipped with a note; a newer one
  updates; a failure (a tampered package: the verification's own message) is reported and the rest still install; a summary line
  ends the run. The page names examples by file name only and the main process checks each name against the folder; nothing is
  ever granted (no grants file is written) and nothing is launched.
- **Browse registry** (`Library.registryBrowse` / `lib:registryBrowse` in `src/library.js`, `Updates.browseRegistry` in
  `../hostlib/updates.js`, the sheet in `ui/library.js`; the **Browse registry…** header button and **File → Browse registry…**
  (⇧⌘B)): search the app list of a registry the user names (`GET /api/apps?sort=&q=&limit=&offset=`) and install from a card.
  The registry is asked only when the sheet opens, or the user presses **Search**, changes the sort (most downloaded, newest,
  recently updated, name) or presses **Show more** (20 per page); never at start-up, and a reopened sheet shows what it had.
  The request carries the search text, the sort and the page, nothing else. It runs in the main process (the page has no network,
  CSP `connect-src 'none'`): 4 MiB cap, 10 s total deadline, no redirects, plain `http://` to another computer flagged. The answer is
  untrusted (publishers write names and descriptions): only a fixed set of fields survives (id and version matching the manifest
  patterns, text with controls and direction overrides removed and capped, whole numbers), the publisher label is the registry's
  own `label`/`level`, and the page inserts everything as text nodes. There is no icon endpoint in the registry API, so a card shows
  a placeholder. **Install** on a card is `lib:registryFetch` with that card's id and the registry the list came from: the same
  download, checksum and package checks, then the ordinary install review; an app already in the library shows
  "Installed <version>" and has no button. Tests: `tests/unit/updates-browse.test.js` (against a real local registry and
  stand-in servers) and the CDP run L.
- **Permission sheet (SPEC 8.2):** shown on first launch, when a folder request has no decision yet (for example after
  an update that adds one), or when *Ask every time I launch* is on. Per manifest folder: the purpose, the requested
  access, **Choose folder...** / **Skip**, and the access it may be downgraded to (`readwrite` -> `read`; `read` and
  `writeonly` stay as requested). The loader re-validates the choices against the manifest before saving them with
  `Store.saveGrants`.
- **Bridge inspector** (DevTools-like, read-only; WHY.md "Bridge inspector"): pick a running (or last-run) app, then
  - *Traffic*: a live table of every bridge message in both directions (time, direction arrow, type, channel/op, win,
    bytes, duration, with `result` matched to its `invoke` and `reply` to its `request`; dialog grants appear as
    `grant` rows), a filter box, Pause / Clear, and a side pane with the selected message's preview (the first 200
    characters of the JSON, never the full payload);
  - *Core log*: the log events plus a tail of `$VMAPP_HOME/logs/<id>.console.log`;
  - *Delivered files*: the write-only deliveries (`exported` events).
  Open it from a card (Inspect / Logs), the *Bridge Inspector* button or the Window menu. It reads only what passes
  through the loader.

## Microphone and the live monitor (SPEC 8.4, GOVERNANCE INV-B3; docs/USING.md)

- **The microphone** (`permissions.devices`, `src/devices.js`): the only permission an app window can ever be given.
  `lockPartition` (`src/window-manager.js`) answers every permission request and check of an app partition through
  `microphoneRequestAllowed` / `microphoneCheckAllowed`: `true` only for `getUserMedia` with `mediaTypes` exactly `["audio"]`,
  from the main frame of one of this app's own windows, when the manifest asks for the microphone and the user's saved grant
  (`grants/<id>.json` `devices.microphone`, set in the permission sheet's **Devices** section or by
  `vmapp grant-device`) allows it. Read at every request, so revoking applies at once. Video, screen sharing and everything else
  stay denied; the loader's own windows and the default session get nothing. Every request is a `host` row in the Inspector
  (`microphone media.audio` / `camera media.video`, allowed or denied). `DeviceGate` (the loader's one gate) is built in
  `main.js` and handed to the `Runner`.
- **"Using the microphone now"** (`MicWatch` in `src/devices.js`): while a window has been granted the microphone, the main
  process looks every second for live audio tracks (DevTools `Runtime.queryObjects` through `webContents.debugger`; nothing is
  injected into the page) and stops looking after a few idle seconds. Best effort and informational; the card's "Can use the
  microphone" label comes from the grant and is always accurate.
- **The activity monitor** (`src/monitor.js`, `src/monitor-model.js` (pure), `ui/monitor.*`, `ui/activity.*`): a menu-bar `Tray`
  icon (drawn in code, a template image; its title is the number of running apps) opens a popover window, a loader page. Rows per
  running app with pills (folders, screen, input, microphone, tools, MCP, network) from the user's grants; a pill pulses for 2 s
  after an event of its kind (runner `inspect` events) and while it is live (input session, shell tool, live microphone track).
  Buttons: **Stop**, **Inspect**, **Show app data in Finder** (`NativeDialogs.showInFolder`, the loader's own `data/<id>`).
  The library has the same list at the top (**Activity**, Stop only). Window menu, **Activity Monitor** (⌘4), or `--monitor` (opens
  the popover pinned) show it without the tray. Every IPC handler checks that the sender is the popover page.
- Dev tests use Chromium's fake microphone (`--use-fake-device-for-media-stream`, never `--use-fake-ui-for-media-stream`, which
  makes Chromium accept requests without asking the gate); a packaged loader refuses both (`src/hardening.js`).

## Host capabilities (SPEC 8.2, GOVERNANCE INV-H1 to H6; docs/HOST-CAPABILITIES.md, docs/USING.md)

The policy and the broker are `../hostlib/capabilities.js` (one `HostCapabilities` for the whole loader, handed to every
`AppSession`); the processes are `../hostlib/hostproc.js`; the macOS helper is `vmapp-hostctl` (`../host/hostctl/`). The
loader adds only loader-owned UI (INV-B5): none of it is reachable from an app window, and every IPC handler checks that
the sender is the right loader page.

- **Host Capabilities window** (`src/settings.js`, `ui/settings.*`; header button, Window menu, ⌘3, `--host-settings`):
  - *macOS permissions*: Screen Recording and Accessibility status from `vmapp-hostctl status`, **Ask macOS…** (sends
    `request-permissions`, only on this click) and **Open System Settings** (the two fixed privacy-pane addresses; no
    confirmation needed because an app cannot name them);
  - *Stop everything*: who controls the computer now, a Stop button per app, **Stop everything now**, and the shortcut
    ⌃⌥⌘.;
  - *Tools* and *MCP servers*: the user's catalog (`capabilities/tools.json`, `mcp.json`), the only place besides the CLI that
    writes it (INV-H1). The form shows the `Catalog` validation messages verbatim, fixes the id of an existing entry, and
    marks a `shell` tool in red. The presets (Screenshot tool, Open an app, Terminal shell) only fill the form.
- **Install review** (`hostReview` in `ui/library.js`): for an app with `permissions.host` it adds a red "Control of your
  computer" part, with **"This app requests control of your computer."** when it asks for `input`, `tool:*` or `mcp:*`
  (INV-H6). Installing allows nothing.
- **Permission sheet**: a red *Control of your computer* section when the manifest has `permissions.host` (the sheet comes at
  first launch even for an app with no folders). Each capability starts at **Don't allow**; modes **Ask every time** and
  **Allow while the app runs** only (`always` is never offered; `lib:savePermissions` / `lib:launchWithGrants` re-validate
  against the manifest and the catalog and refuse anything else); `tool:*` / `mcp:*` list the user's catalog entries as
  checkboxes (at least one must be ticked). A `session` grant returns to `ask` when the app stops.
- **Library**: a red chip on a card for what was allowed ("Can control your computer", "Can see your screen"), a pulsing chip
  while it is active, and a red strip at the top ("<App> is controlling your computer", **Stop**) while an input session or a
  shell tool is active.
- **Confirmation** (`HostUi.confirmUse`, `src/host-text.js`, `NativeDialogs.confirmHostUse`): a native sheet on the app's
  window for every use on `ask`, worded by the loader (the app name, its stated reason, the exact tool arguments, the
  window title for a capture are quoted text only): **Deny** (default, also Escape), **Allow once**, **Allow while the app
  runs**. A shell tool gets the red wording.
- **Screenshot picker** (`src/capture-picker.js`, `src/region-select.js`, `src/capture-logic.js` for the pure parts,
  `ui/picker.*`, `ui/region.*`; `HostUi.chooseCapture`): for a screenshot on `ask` the USER picks what is captured; the
  app's parameters are only the suggestion (preselected). A loader window, modal on the app's window (named after the app,
  `contextIsolation`, `sandbox`, the loader CSP), lists each display (name, size, a live thumbnail the loader captures through
  `vmapp-hostctl` and shows only here), each window (app and title; the loader's own and tiny ones are not offered) and
  **Select a region…** per display (a full-screen dimmed transparent selection window on that display, shown only during the
  drag; Esc, a right click or two minutes cancel). Buttons **Deny** (default, Esc, closing the window), **Allow once**, **Allow
  while the app runs** (the permission only, never a target). The page can only answer with a choice it was offered, and the
  main process checks it again (`targetFromChoice`); the broker checks the target a third time. Panic cancels an open question.
- **Virtual-input overlay** (`src/overlay.js`, `ui/overlay.*`; `ui.inputActivity`, `ui.inputStarted/inputStopped`): while an
  input session is active, one window per display (transparent, frameless, `setIgnoreMouseEvents(true)`, not focusable, always
  on top at `screen-saver`, on every Space, `setContentProtection(true)`) draws a ring at the virtual pointer, ripples on
  presses and clicks and a fading key caption (`host-text.keyCaption`). **Typed text is masked by default**
  ("typing… (12 characters)", counted over the 2.2 s the caption stays up; `⌘S`, Return and arrows are always shown); the
  loader setting "Show typed text in the overlay" (Host Capabilities window, `overlayShowTyped` in `src/prefs.js`, saved in
  `<data root>/loader-prefs.json`, off by default, read at every keystroke) shows the first 28 characters instead. It exists only
  while an input session does, and its failure never refuses input (the badge is what INV-H3 requires). Screenshots exclude it
  (and the badge, and the pickers) through `excludePids`, which the broker gives `vmapp-hostctl`.
- **The badge** (`src/badge.js`, `ui/badge.*`): a small always-on-top window (not focusable, above full-screen apps, on every
  Space), created when the first input session or shell tool starts and destroyed with the last. It shows "<App> is
  controlling your computer" or "<App> is running a shell command" with **Stop** (`caps.stopControl`); its page can only
  press Stop.
- **Panic** ⌃⌥⌘.: `vmapp-hostctl` registers the shortcut (the loader asks for it at startup with `caps.enablePanic()`) and
  reports `panic`; the broker runs `stopAll()` (input sessions, tools, MCP servers, remembered "while the app runs"
  answers) and the loader posts a system notification and a banner.
- **Inspector**: `{kind:'host'}` events appear as rows (capability, operation, duration, **allowed** or **denied**), with a
  **Host** filter button; never screenshot bytes or typed text. `{kind:'net'}` events (SPEC 8.3) are rows too (`host:port`,
  bytes up and down, duration, the reason of a refusal, **allowed** or **denied**) with a **Network** filter button.

### Network and the VM's size (SPEC 8.3, 8.5; `src/library.js`, `ui/library.js`)

- **Network**: the install review lists every requested host (wildcard and port 80 marked) and the loader's own "could read the
  folder … and send it out" banner (`riskSummary`); the permission sheet has a **Network** section (every host on Don't allow, a
  checkbox per port, at least one), a live risk banner (`lib:riskPreview`: "could", and a solid red "Right now: … can …" once a
  readable folder or the screen AND a host are allowed) and the same section appears alone in the card's **Network…** sheet,
  which works while the app runs: `lib:saveNetwork` saves the choices and calls `session.syncNetwork()`, so a host taken away is
  cut off at once. The card shows the choices, an amber chip and the red warning; the monitor's `Network` pill comes from the
  grants. The "asks for more" sheet lists `netAdded`. What the renderer sends is re-validated (`normalizeNetChoices`: only
  listed hosts, never more ports than requested, nothing saved if any part is invalid).
- **Resources**: the manifest's `core.cpus` and `core.memoryMiB` are recommendations; the sheet and the card have a **Resources**
  row (vCPUs stepper, memory menu, **Use recommended**, a warning below the recommendation), saved into `grants/<id>.json`
  `resources` (`lib:setResources` for the card, the sheet's `extra.resources` only when the user changed it), refused above the
  Mac's cores / half of its memory, locked while the app runs. `Runner` starts the VM with the user's size (`AppSession`).
  A grants file holding only the size does not suppress the first-launch sheet (`store.hasDecided`).
- **Update that asks for more**: `permissionDiff` reports `hostAdded`; the "asks for more" sheet lists each added
  capability (in red for control). Nothing is granted by the update.
- **Menu**: View, Developer Tools (⌥⌘I) only for an app window its core created with `devTools: true` (SPEC 7).

The loader's tests never touch the real desktop: they run with the fake helper `tests/unit/fixtures/fake-hostctl.js`
(`VMAPP_HOSTCTL`), `VMAPP_HOSTCTL_DRYRUN=1` and scripted confirmations (`VMAPP_TEST_DIALOGS.host`); a real test with
the real helper is a separate, supervised run.

## Developer builds and publishing (SPEC 8, 8.1; docs/START-HERE.md levels 2 and 6, docs/PUBLISHING.md 3.1)

Both are user actions and work in packaged builds too. All the code that talks to a registry stays in
[`../hostlib/updates.js`](../hostlib/README.md) (INV-G3); the loader's `src/library.js` only calls it.

- **Run project folder…** (header button; the picker is `NativeDialogs.pickProjectFolder`, so `VMAPP_TEST_DIALOGS.open`
  answers it): checks the folder has a `vmapp.json`, packs it with `hostlib/package.js` `pack` into
  `$VMAPP_HOME/tmp/<id>-dev.vmapp` (packing errors, such as a missing `core/` or a bad manifest field, are shown
  verbatim as a banner and nothing is installed), installs it with the downgrade rule lifted
  (`Store.install(file, {force: true, dev: {path}})`; `apps/<id>/dev.json` records the folder), deletes the build file and
  launches the app (the permission sheet comes first, as usual). A running copy of the id is stopped first.
- **Developer build** card: the badge "Developer build from <folder name>" (tooltip: the full path) and **Rebuild &
  run**, which repeats pack, install and launch from the recorded folder (a missing folder, or a changed app id, is
  reported instead). Grants and app data are kept. A developer build never checks a registry for updates at launch, and
  any other install of the id (file, registry, update) removes `dev.json`.
- **Publish…** (every card): a loader-owned sheet with the registry address (the app's registry, else one this Mac has a
  token for, else `cfg.registry`), the owner token (a password field filled from `$VMAPP_HOME/publish-tokens.json`,
  `{ "<registry url>": { "<app id>": "<token>" } }`, mode 0600, the file `vmapp publish` uses; empty means a first
  publish) and, only without a token, the publisher fields (name, company, email, url: sent as `X-Vmapp-Publisher`).
  *Publish* streams the package file the store kept (`apps/<id>/pkg/<version>.vmapp`, written by `Store.install`)
  through `updates.publish(file, {registry, token, publisher})`. 201 shows the app page address (**Open app page…**
  asks first, and only addresses a publish just returned can be opened) and, on a first publish, the owner token once
  with **Copy token**, saved to the token file before it is shown. Errors use `updates.publishErrorText` (PUBLISHING.md
  3.4's table in plain words) and keep the sheet open. A plain `http://` registry that is not this computer gets a
  development-only warning. An app installed by an older loader has no kept package and says so.

## Registry, versions and updates (SPEC 8.1)

All of this is loader UI (INV-B5); the network code is one module, [`../hostlib/updates.js`](../hostlib/README.md)
(INV-G3: it runs only when the user clicked, or launched an app whose update choice they set to *Latest compatible* or
*Always latest*; requests carry the app id, the installed version and the choice, nothing else; 5 s timeout; no
redirects). The loader itself has no network API, so `tools/check-invariants` has nothing to flag.

- **Install from registry...** (header button): a dialog asks for the registry address (prefilled from
  `$VMAPP_REGISTRY`; dev builds fall back to the local dev registry, packaged builds have no default) and an app id or
  a pasted app-page address (`<registry>/apps/<id>`, which also sets the registry). The loader fetches the newest
  non-withdrawn version, verifies it (sha256 header, package, package id header, id and version) and shows the normal
  install review with a "Source: from <registry>" row. Nothing is installed until *Install*; then `source.json` is written.
  Plain `http` to anything but this computer gets a warning line in the review.
- **Per card:** *Updates:* a choice (*Stay on this version* / *Latest compatible* / *Always latest*; disabled for an app
  installed from a file, which shows "installed from a file"), **Versions...** and **Check for updates**.
  - **Versions...** lists the installed versions (**Use this version**; going to an older one asks first, saying that app
    data is shared and an older version may not read data written by a newer one, and sets the choice to *Stay on this
    version*). **Show versions from the registry** is the only thing in that dialog that contacts the registry; it lists
    versions with the publisher's withdrawal reason, and **Install this version** for ones not installed.
  - **Check for updates** downloads and verifies the candidate, then shows the install review, or the "asks for more"
    sheet when it needs more permissions.
- **Launch** of an app with a source and a choice other than *Stay*: check (5 s). No candidate, offline or any error:
  launch the current version with an inline note on the card ("Could not check for updates ..."). A candidate that adds
  no permission is downloaded, verified, installed and launched, with an "Updated to X" banner and card note. A candidate
  that adds a folder request, raises a folder's access (read or write-only to read & write; read to write-only counts too),
  or turns on `dialogs` / `external` stops at the loader sheet **"Version X asks for more:"** with
  **Update and review permissions** (installs, then opens the permission sheet) or **Keep version Y and launch**.
  Escape cancels and launches nothing. The loader never installs an older version by itself.
- A withdrawn *current* version shows its reason on the card after any contact with the registry.
- Downloads go to `$VMAPP_HOME/tmp/vmapp-dl-*.vmapp`, are deleted after install or cancel, and leftovers are swept at start.

## Security settings

| Surface | Settings |
|---|---|
| App windows | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no webview, `safeDialogs`, own partition `persist:vmapp-<id>`, preload `preload-app.js` only (exactly SPEC 7's `window.vmapp`); `devTools` = what the app's core asked for in that `window.create` (the SDK's `webPreferences.devTools`, default false; dev and packaged alike), and View, Developer Tools (⌥⌘I) works only for such a window |
| `vmapp-ui://<id>/<path>` | registered once as a privileged standard+secure scheme; per-partition handler; only files listed in `manifest.files`, SHA-256 checked (hash cached per session by size+mtime), anything else 404; the SPEC 7 CSP on every response, 404s included |
| Network | CSP `connect-src 'none'`, plus a per-partition `webRequest` filter that cancels everything but `vmapp-ui:`, `data:`, `blob:`, `devtools:` |
| Navigation | `will-navigate`, `will-frame-navigate`, `will-redirect` blocked outside `vmapp-ui://<id>/` (loader windows: outside `vmapp-loader://ui/`); `window.open` denied; webviews refused |
| Permissions | every request and check denied (camera, mic, geolocation, notifications, clipboard-read, ...), also device permissions |
| Renderer IPC | the app is identified by the sender's `webContents` id (never by anything the page sends); only the main frame; channel/args validated; `emit` goes to that window only, queued until the page finished loading |
| Dialogs | native `showOpenDialog` / `showSaveDialog` / `showMessageBox`, parented to the app window, with loader-owned wording: "“App” wants to open a folder (read only)", "... (it will be able to change files in this folder)", "... wants to open a file", "... wants to save a file"; `shell.openExternal` is confirmed with "“App” wants to open <url> in your browser" first. App-supplied titles are only appended after the loader's sentence |
| Loader's own windows | `vmapp-loader://ui/...`, CSP `default-src 'none'; script-src 'self'; style-src 'self'; ...; connect-src 'none'`, sandbox + context isolation, a narrow per-page preload API, every IPC call re-checks the sender window; manifest text is only ever inserted as text |
| Packaging | `app.isPackaged` turns the test hooks and the binary overrides off, refuses debugging switches, and gives DevTools only to app windows whose core asked for them (never to the loader's own windows); production fuses and hardened-runtime signing: see [PACKAGING.md](PACKAGING.md) (`tools/package-mac.sh`) |
| Folders | the disk root and the loader's data dir are never shared; home, `/Volumes/<disk>`, system folders and any folder containing the data dir need a second confirmation (permission sheet and `dialog.open` folders) |

`dialog.open` on files: the host clones the chosen file (APFS `COPYFILE_FICLONE`, copy as fallback) into
`$VMAPP_HOME/picks/<app id>/pick-N/` and shares that folder read-only, so the app never sees the file's siblings.
The clones are removed when the session stops, and `picks/` is swept at loader start.

## Lifecycle

- *Stop* -> `session.stop()` (before-quit, 3 s, shutdown, SIGKILL as last resort); the app's windows are closed.
- The app quits by itself -> `stopped` -> windows closed, the card updates.
- Quitting the loader (Cmd+Q, SIGTERM) stops every running app first (at most 10 s, then the VMs are killed), then
  exits. If the loader dies (crash, `kill -9`) every `vmapp-vm` sees its parent die and stops its VM.

## The GPU (SPEC 8.6, GOVERNANCE INV-H7; docs/HOST-CAPABILITIES.md §9)

An app whose manifest asks for `gpu` and that the user allowed ("Allow while the app runs") gets llama.cpp's RPC server, run by the
loader in a macOS sandbox, one per app run. `main.js` builds one `GpuBroker` (`../hostlib/gpu.js`) from `cfg.gpuServer` /
`cfg.gpuProfile` (`src/config.js`: `out/gpu/` in dev, `Contents/Resources/vmapp/gpu/` packaged; the dev-only overrides
`VMAPP_GPU_SERVER` / `VMAPP_GPU_PROFILE` are ignored when packaged), hands it to the `Runner` (and so to every `AppSession`), stops a
server a crashed loader left behind at startup (`reapStale`), stops every server on **panic** (`hostCaps` `'panic'`) and when the
loader quits. The loader's UI, all loader-owned (INV-B5):

- **Permission sheet and install review:** the `gpu` entry in the **Control of your computer** section, with the loader's own text
  and only *Don't allow* / *Allow while the app runs* (`ui/library.js` `hostRow`; `src/library.js` `normalizeHostChoices` refuses
  anything else). It is not labelled "requests control of your computer".
- **Card:** the amber chip **Can use your GPU** (`hostChips`). **Monitor:** a **GPU** pill (`src/monitor-model.js`), pulsing on
  `gpu` tunnel events but not on the server starting. **Inspector:** a **GPU** filter and `gpu` rows (`ui/inspector.js`).
- **GPU…** on the card (`lib:saveGpu`, works while the app runs, like **Network…**): Don't allow / Allow while the app runs. Taking the
  GPU away calls `session.revokeGpu('revoked')` at once (its tunnels close, its helper stops); allowing it for a running app starts at
  the next launch. The permission sheet (app stopped) and `vmapp grant-host … --revoke` reach a running app within a second (the
  session looks at its grant).

## Test hooks (only when `!app.isPackaged`)

| Env | Meaning |
|---|---|
| `VMAPP_TEST_DIALOGS` | JSON `{open:[path \| [paths] \| null, ...], save: path, message: index, external: bool}`: auto-answers the native dialogs. `open` is a queue consumed by every open dialog in order (the loader's own package and folder pickers included); an empty queue cancels. `openExternal` never launches a browser in this mode |
| `VMAPP_TEST_DIALOGS.broad` | (inside the JSON above) queue of booleans answering the "share this very large folder?" warning; empty queue declines |
| `VMAPP_TEST_DIALOG_LOG` | file; the hooks append one JSON line per dialog (kind, title, message, answer) so tests can check the wording. Publish adds `open-page` (the confirmation), `openExternal` (when `external` is true; no browser is ever launched) and `copy` (the Copy token button; the system clipboard is not touched) |
| `VMAPP_TEST_DIALOGS.host` | (inside the JSON above) queue of answers to the host-capability confirmations: `'deny' \| 'once' \| 'session'`; an empty queue denies. Each confirmation is logged as a `host-confirm` line (wording, buttons, answer); `openSystemSettings` logs `openExternal` and never opens System Settings; panic notifications log `notice` |
| `VMAPP_TEST_DIALOGS.capture` | (inside the JSON above) queue for the screenshot picker: `'ui'` shows the REAL picker window (the test drives it over CDP; logged as `capture-picker` and, with the window's `modal`/`hasParent`/`title`, `capture-window`; the answer as `capture-pick`); `'deny' \| 'once' \| 'session'` or `{answer, target:{kind, display? \| windowId? \| region?}}` answer without a window. When this queue is empty a screenshot takes the next `host` answer (the app's suggestion is kept) |
| `VMAPP_TEST_DIALOGS.region` | (inside the JSON above) queue of rectangles `{x,y,w,h}` (global points) or `null` (cancel) for *Select a region…*; an empty queue cancels. No selection window is shown while the hook is on; each use is logged as `region-select` |
| `VMAPP_TEST_OVERLAY_LOG` | file; one JSON line per overlay window created (`display`, `bounds`, `ignoreMouseEvents`, `focusable`, `alwaysOnTop`, `contentProtected`), per window destroyed, and per input activity (`global` position, each window's local position and whether it is inside, `down`, or the key caption) |
| `VMAPP_TEST_GRANTS` | JSON `{<appId>: {<folder>: {path, access} \| null}}`: pre-seeds (and saves) the grants and skips the permission sheet |
| `VMAPP_HOSTCTL`, `VMAPP_HOSTCTL_DRYRUN` | the host helper replaced by a fake (a path or a JSON array such as `["/path/node","tests/unit/fixtures/fake-hostctl.js"]`), and `1` to make every mouse/keyboard request a dry run (`hostlib/hostproc.js`; both ignored when packaged). **Every loader test uses both.** The fake logs requests to `FAKE_HOSTCTL_LOG=<file>` and presses the "hotkey" when `FAKE_HOSTCTL_PANIC_FILE=<file>` appears |
| `VMAPP_GPU_SERVER`, `VMAPP_GPU_PROFILE` | the GPU server and its sandbox profile (SPEC 8.6) replaced by another build or a fake (`src/config.js`; both ignored when packaged, like `VMAPP_VM`) |
| `VMAPP_VM_KRUN`, `VMAPP_KERNEL_GPU` | the experimental Vulkan backend's launcher and gpu kernel (SPEC 8.7; defaults `out/krun/bin/vmapp-vm-krun`, `out/Image-gpu`; `src/config.js`; ignored when packaged). Used only for an app that asks for `{cap:"gpu", api:"vulkan"}`, was allowed it, and while the setting "Experimental GPU (Vulkan)" is on |
| `VMAPP_TEST_DEVTOOLS_LOG` | file; every window that finishes loading is probed once (the View-menu path, then a direct `openDevTools()`) and one JSON line `{kind, appId, win, requested, viaMenu, openAfterMenu, directEvent, openAfterDirect}` is appended. It also turns on the packaged-mode `devtools-opened` closer so the test can see it work (run F) |
| `VMAPP_EXAMPLES_DIR` | the folder "Load examples" reads (`*.vmapp` and `README.md`; default `out/examples`; `src/config.js`; ignored when packaged, which reads `<Resources>/vmapp/examples`). Run K points it at fixture apps |
| `VMAPP_TEST_MENU_DIR` | a folder; the loader writes `menu.json` (every menu and item: id, label, enabled, visible, accelerator) when the menu is built, and every 100 ms looks for `click.txt` holding a menu item id, deletes it, clicks that item as a user would and appends `{id, found, enabled}` to `clicked.jsonl` (the menu cannot be reached over CDP). Ignored when packaged |
| `VMAPP_REGISTRY` | (not a test hook: honoured in packaged builds too) the address prefilled in *Install from registry...* |
| `--remote-debugging-port=N` | passed through to Chromium (use `127.0.0.1`); the CDP test uses 9250 (`CDP_PORT=<port>` changes it, with `VMAPP_WORK=<absolute dir>` for the scratch space, so two runs can coexist) |
| `VMAPP_LOADER_DEBUG=1` | also print debug log lines |

## Tests

`npm test` runs `test/loader-cdp.mjs`, which needs the real `vmapp/out` binaries. It works under
`$VMAPP_WORK/loader-test/` (default `out/work/loader-test/`; fresh `VMAPP_HOME`, screenshots in `shots/`, loader logs
`loader-*.log`):

1. protocol checks without Electron (`src/protocols.js`): the SPEC 7 CSP, 404 for unlisted/`..`/encoded paths, a
   tampered file is refused, the loader scheme;
2. **run A** (no `VMAPP_TEST_GRANTS`): packs `test/fixture-app`, installs it through the library UI (review sheet),
   launches it (permission sheet, folder chosen through `VMAPP_TEST_DIALOGS`), then on the app window over CDP:
   `window.vmapp` surface, no `require`/`process`, `fetch` and XHR rejected, inline script blocked, navigation and
   `window.open` blocked, permissions denied, the CSP header on the real responses, invoke round trip and rejection,
   emit from the core, the granted folder, `dialog.open` (directory ro/rw, file clone without siblings), save, message
   and external with their wording; the inspector rows, filter, preview, pause, clear, log and files tabs; Stop
   (vmapp-vm gone, Virtualization VM count back to baseline, picks removed); Reset; launch again (sheet again,
   downgrade, ask every time); the app quitting itself; uninstall confirmation;
3. **run A2**: quitting the loader with a running app stops it;
4. **run B** (`VMAPP_TEST_GRANTS`, no sheet): `kill -9` the loader and assert the VM is gone;
5. **run C** (versions and updates, against the REAL `registry/server.js` on a free port, data under `$VMAPP_WORK/loader-test/`): publishes
   1.0.0 of the fixture and installs it through *Install from registry...* (pasted page address, review "from
   <registry>", `source.json`); sets *Latest compatible*; publishes 1.1.0 and 2.0.0; Launch runs 1.1.0 and not 2.0.0;
   publishes 1.2.0 with an extra folder: Launch shows "asks for more", *Keep* launches 1.1.0; a withdrawn current
   version shows its reason; *Check for updates* + *Update and review permissions*; Versions... (registry list is
   fetched only on request, *Use this version* with the older-version confirmation, which also sets *Stay*), *Install
   this version*; and with the registry killed, Launch runs the current version with the offline notice.

6. **run D** (developer and publishing, against the REAL `registry/server.js`; `CDP_ONLY=D npm test` runs only this):
   *Run project folder…* with a folder that is not a project and one that cannot be packed (errors verbatim, nothing
   installed, no files left in `tmp/`), then `test/fixture-project` copied to a scratch folder: the permission sheet, the
   "Developer build from my-dev-app" badge, the app runs (invoke round trip), an edit of the scratch copy and *Rebuild &
   run* (the old VM is stopped, the new build runs, grants are kept); *Publish…* as a first publish (publisher fields, owner
   token shown once, `publish-tokens.json` mode 0600, the token never in the loader log, Copy and Open app page through the
   hooks), a version bump + *Rebuild & run* + *Publish…* with the saved token (no new token, 201), the friendly 409, 401 and
   403 texts, the plain-http warning, a restart of the loader (the badge stays) and a vanished project folder.

7. **run E** (host capabilities; `CDP_ONLY=E npm test`; fixture `test/fixture-hostcaps`, a REAL registry for the update, the
   FAKE helper, dry-run input, scripted confirmations): startup registers the panic shortcut and asks the helper for
   nothing else; the Host Capabilities window (macOS status, *Ask macOS…* only on the click, the two System Settings
   addresses, the tools catalog with validation messages, presets, edit and remove, MCP servers); the install review's
   "requests control of your computer"; the permission sheet (default Don't allow, no `always`, the user's catalog as
   checkboxes, "pick at least one", the refusal of a mode the sheet does not offer); the app's calls through the SDK
   (`host.screen`, input, tools, MCP) with the confirmation wording and answers (a screenshot's `target` and the loader's own
   window hidden from `host.screen.windows`); the badge (its page can only press Stop),
   Stop from the badge and from the library strip, further input refused; a shell tool shows the badge while it runs;
   the Inspector's Host rows and filter (no typed text, no screenshot bytes); panic (everything stops, MCP server killed,
   "while the app runs" forgotten); stopping the app returns `session` to `ask`; the "asks for more" sheet for an update that
   adds host capabilities;
8. **run F** (DevTools per window; `CDP_ONLY=F npm test`; fixture `test/fixture-devtools`): the core creates a window
   without `devTools` and one with `webPreferences.devTools: true`. The first never gets DevTools (not even a direct
   `openDevTools()`: no `devtools-opened` event), the second opens them from the menu path, a loader window never keeps them
   (the closer), and the SDK warned once about the other `webPreferences` key.
9. **run G** (the user picks what a screenshot contains, and the overlay; `CDP_ONLY=G npm test`; fixture `test/fixture-hostcaps`
   pre-installed with `screen: ask` and `input: session`; the FAKE helper has two displays and three windows, one of them the
   loader's; `VMAPP_TEST_DIALOGS.capture: ['ui', …]` shows the real picker): the picker is a modal window parented to the app's
   window and named after the app; it lists both displays (name, resolution, a thumbnail the loader captured, `excludePids` in
   every capture), the windows (the loader's own is not offered) and a *Select a region…* button per display; the app's
   suggestion is preselected, Deny is the default button, and a refused answer (a display or window that was not offered) leaves it
   open; choosing display 2 gives the app display 2 (`target` in the result, the helper's log) and not the window it suggested;
   Deny, Esc and closing the window are "permission denied"; a suggested region is preselected; *Select a region…* through
   `VMAPP_TEST_DIALOGS.region` (a cancel selects nothing, a rectangle selects a region on display 2, preview captured);
   "Allow while the app runs" remembers the permission only (the next captures use the suggestion, `by: 'app'`, or the main
   display, `by: 'default'`, and open no picker). Then input control: one overlay window per display, each `ignoreMouseEvents`,
   not focusable, always on top and content-protected (the `VMAPP_TEST_OVERLAY_LOG` probe); the ring is at the position of each
   `host.input.mouse` (read from the page and from the probe), ripples on a click, the pressed state on down/up, captions for
   typed text (masked: "typing… (50 characters)"; a single key counts as typed text), `⌘S`, scroll and Return; the Host
   Capabilities window's "Show typed text in the overlay" (off by default, saved in `loader-prefs.json`) shows the first 28
   characters and masks again at once; the overlay is gone after Stop, after panic and after the app stops.

10. **run H** (the microphone and the live monitor; `CDP_ONLY=H npm test`; fixture `test/fixture-mic`, plus the host-capabilities
   and loader-test fixtures; Chromium's fake microphone, no real audio): the install review and the sheet list the microphone
   (default Don't allow); without a grant `getUserMedia` for audio, video and both is rejected, `getDisplayMedia`, notifications
   and geolocation too; with the grant audio gives a live track, video and audio+video are still rejected, the card chip "Can use
   the microphone" and "Using the microphone now" and the monitor's pulsing pill show it and go away when the track stops;
   the Inspector logs allowed and denied requests (`camera media.video`); removing the grant file applies at once; a hand-written
   grant does not help an app that did not ask. The popover (`--monitor`) lists three running apps with the right pills
   (folders with names on hover, screen, input, tools, MCP, microphone), pulses on an input session, and Stop, Inspect and
   "Show app data in Finder" work; the library's Activity section shows the same apps.
11. **run I** (the network UI and the VM's size; `CDP_ONLY=I npm test`; fixture `test/fixture-net`, a REAL VM, a real registry
   for the update; no internet needed): the install review lists the hosts and the loader's "could read … and send it out"
   banner; the sheet's Network section (default Don't allow, wildcard and port 80 warnings, ports can be narrowed, at least
   one), the live risk banner, the Resources section; the card's Resources row (default 1 vCPU and the recommended memory,
   stepper, memory menu, Use recommended, the warning, saved at once, capped at the Mac's cores and half its memory, locked
   while the app runs); the VM really has the chosen vCPUs and memory; the chip, the warning and the monitor pill; the
   Inspector's `net` rows (denied with the reason, allowed, bytes up and down, duration) and the Network filter; "Network…" on
   the running app (revoking cuts it off at once, allowing again works, taking everything away removes the chip and the pill);
   Reset forgets everything; an update that asks for more ports and a new wildcard host stops at "asks for more" and the old
   grant is pinned to its port.

12. **run K** (Load examples and long text; `CDP_ONLY=K npm test`; no VM is started, nothing is launched or allowed; fixture apps are
   packed by the run into the folder `VMAPP_EXAMPLES_DIR` names): the empty library offers **Load examples** (primary) and **Install
   from file…**; without examples a development loader says to run `tools/pack-examples` (also for an empty folder); with them the
   sheet lists each package as it describes itself (name, description, version, size, badges, README hint or the derived one,
   a damaged file shown and not selectable), Select none / Select all, Esc and Cancel install nothing; **Install selected** shows
   verifying, installing and the result per app, a package changed after packing fails with the verification message while the
   others install, and the summary and the cards follow; no grants file exists and no VM ran; **File → Load examples…** and
   **File → Install from file…** work through the menu hook; again: installed versions are skipped with a note and not touched; a
   newer example updates, an older one is skipped. The same run installs an app with a 60-character name, a 100-character id, a
   400-character granted folder, 200-character hosts and a long version and asserts that no element of any card or sheet (permission
   sheet, Network…, GPU…, Versions, Publish…, Uninstall, install review, Load examples), of the Host Capabilities window (a tool and
   an MCP server with long names, paths and patterns), of the monitor popover or of the Inspector's detail pane has `scrollWidth >
   clientWidth + 1`, and that no card is wider than its column; with `ui/wrap.css` switched off the same check finds the overflow
   (`2x-wrap-*-before` and `-after` screenshots).

Long unbroken text (folder paths, package ids and hashes, hosts, URLs, versions) wraps inside its box in every loader page that links
`ui/wrap.css` (library, Host Capabilities, activity monitor, Inspector): `overflow-wrap: anywhere` plus `min-width: 0` / `minmax(0, 1fr)`
on the flex and grid children that would not shrink; buttons keep their labels and never shrink (the library's header buttons wrap
into a second row instead).

Screenshots: `01-library-empty`, `02-install-review`, `03-library`, `04-permission-sheet`, `05-app-window`,
`06-inspector`, `07-inspector-log`, `08-inspector-files`, `09-library-stopped`, `10-reset-confirm`, and from run C
`10-registry-dialog`, `11-registry-review`, `12-updated`, `13-asks-for-more`, `14-versions`, `15-offline-notice`, and from
run D `16-run-folder-error`, `17-dev-permission-sheet`, `18-dev-build-card`, `19-publish-sheet`, `20-published`,
`21-publish-sheet-second`, `22-publish-409`, and from run E the 2x images `2x-settings-host-capabilities`,
`2x-settings-shell-preset`, `2x-install-review-host`, `2x-permission-sheet-host`, `2x-control-badge`, `2x-library-controlling`,
`2x-inspector-host`, `2x-asks-for-more-host`, and from run G `2x-capture-picker`, `2x-capture-picker-region`, `2x-input-overlay`,
and from run I `2x-install-review-network`, `2x-card-resources-network`, `2x-permission-sheet-network`,
`2x-permission-sheet-network-risk`, `2x-card-running-network`, `2x-inspector-network`, `2x-network-sheet-running`,
`2x-asks-for-more-network`, and from run K `2x-examples-empty-state-missing`, `2x-examples-empty-state`, `2x-examples-sheet`,
`2x-examples-result`, `2x-examples-library-after`, `2x-wrap-card-before` / `-after` / `-granted-after`, `2x-wrap-permission-sheet-before` /
`-after`, `2x-wrap-network-sheet-after`, `2x-wrap-versions-after`, `2x-wrap-install-review-after`, `2x-wrap-examples-sheet-before` /
`-after`, `2x-wrap-settings-before` / `-after`, `2x-wrap-monitor-before` / `-after` and `2x-wrap-inspector-after`.

## Layout

```
main.js              entry: schemes, protocols, IPC for app windows, quit handling, menu
preload-app.js       the only preload of app windows (SPEC 7)
preload-loader.js    narrow API of the library and inspector pages
src/config.js        paths and binaries        src/runtimes.js   runtime sync
src/protocols.js     vmapp-ui:// and vmapp-loader://
src/window-manager.js  real window manager     src/dialogs.js    native dialogs + test hook
src/runner.js        one AppSession per app, inspector buffers
src/library.js       library IPC (install, sheet, launch, stop, uninstall, reset, developer builds, publish, host choices)
src/inspector.js     inspector window + IPC
src/settings.js      Host Capabilities window + IPC (catalog, macOS permissions, Stop everything)
src/host-ui.js       the capability UI handed to the broker (confirmation, badge)   src/host-text.js   its wording (pure)
src/badge.js         the control badge window     src/devtools.js   who may have DevTools (pure)
src/devices.js       the microphone gate + live-track watch     src/monitor.js, monitor-model.js   menu-bar monitor (model is pure)
src/capture-picker.js  the screenshot picker (the user chooses)   src/region-select.js  "Select a region…" window
src/capture-logic.js   their pure parts (offers, preselection, clipping, answer check)   src/overlay.js  virtual-input overlay
src/prefs.js           the loader's own switches (loader-prefs.json): "Show typed text in the overlay", "Experimental GPU (Vulkan)" (SPEC 8.7)
src/examples.js        Load examples: the folder, the manifest peek, the README hints, badges, the install loop (pure)
ui/                  library.*, inspector.*, settings.*, badge.*, monitor.*, activity.*, picker.*, region.*, overlay.*, dom.js, common.css,
                     wrap.css (long text wraps inside its box; linked last by library, settings, monitor and inspector)
test/                loader-cdp.mjs, fixture-app/, fixture-project/ (run D), fixture-hostcaps/ (run E, G, H), fixture-devtools/ (run F),
                     fixture-mic/ (run H); run K makes its own fixture apps; unit tests of Load examples: ../tests/unit/loader-examples.test.js
```
