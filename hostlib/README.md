# hostlib

Host-side library for D9010 VmApp (SPEC sections 2, 5, 6, 8). CommonJS, Node 22, no dependencies.
`require('./hostlib')` re-exports every module plus `Store`, `AppSession`, `BridgeClient`, `FakeWindowManager`,
`FakeDialogs` and `pack`.

| Module | What |
|---|---|
| `tar.js` | Deterministic ustar writer (`writeTar`), strict reader (`readTar`), `validatePath`. Rejects links, devices, pax/GNU headers, absolute and `..` paths, duplicates, uid/gid/mtime/mode deviations. |
| `cpio.js` | `cpioFromDir(dir)`: deterministic newc archive (sorted, uid/gid/mtime 0, modes 0755/0644, relative in-tree symlinks only, zero-padded to 512 bytes). `readCpio(buf)`: validating reader. |
| `erofs.js` | `erofsFromDir(dir, {maxBytes})`: deterministic EROFS image of the same tree (SPEC 2.1: 4 KiB blocks, uncompressed, no xattrs, compact inodes, the cpio's owner/mode/symlink rules). `readErofs(buf, {data})`: validating reader of the subset (also accepts uncompressed `mkfs.erofs` images). `isErofs(buf)`. |
| `manifest.js` | `validateManifest(obj, {files:'required'\|'forbidden'\|'optional'})` returns a normalised manifest with defaults and canonical key order. `canonicalize`, `parseManifest(bytes)`, `compareVersions`. Errors are `ManifestError`: `invalid vmapp.json: <field> <problem>`, with `.field`. |
| `package.js` | `pack(projectDir, outFile)`, `read(file)`, `verify(file)`, `load(buffer)`. Verification covers entry order, entry types, `files` completeness, SHA-256 of every entry, size limits and the structure of `core.cpio` or `core.erofs` (the one `core.image` names; `coreEntryName(manifest)`). The package id is `sha256(vmapp.json bytes)`. |
| `store.js` | `new Store({home, skipRuntimeCheck})`: `install(file,{force,skipRuntimeCheck,source})`, `list()`, `get(id)`, `uninstall(id,{purge})`, `loadGrants/saveGrants`, `dataDir`, `runtimePath`, `installRuntime`, `verifyInstalled`, `consoleLogPath`, plus the version API below. `home` defaults to `$VMAPP_HOME` or `$VMAPP_WORK/vmapp-home` (`VMAPP_WORK` defaults to `out/work`). |
| `updates.js` | Registry versions and updates (SPEC 8.1), the one module with network code on the loader side. See [Versions and updates](#versions-and-updates). |
| `bridge.js` | `BridgeClient`: the host end of the SPEC 6 bridge protocol over a Unix socket (JSON lines, 16 MiB limit). Works without `vmapp-vm`. |
| `session.js` | `AppSession`: spawns `vmapp-vm`, connects the bridge, routes traffic, enforces permissions, stops the app. |
| `headless.js` | `FakeWindowManager`, `FakeDialogs`, `FakeCapabilitiesUi`, `FakeClipboard` (in-memory; `vmapp run --headless` seeds it from `VMAPP_HEADLESS_CLIPBOARD`): scripted stand-ins for tests and `vmapp run --headless`. `AppSession` takes `clipboard: {readText, writeText}` for the core's `clipboard.*` ops (SPEC 6, 8.4). |
| `capabilities.js` | Host capabilities (SPEC 8.2): `Catalog` (tools.json, mcp.json), grant helpers, and the broker `HostCapabilities`. See [Host capabilities](#host-capabilities-spec-82). |
| `resources.js` | The VM's size (SPEC 2.2, 8.5): the manifest recommends, the user chooses. See [The VM's size](#the-vms-size-spec-85-resourcesjs). |
| `hostproc.js` | The only host processes besides `vmapp-vm` (INV-A1): the `vmapp-hostctl` client `HostCtl`, `startProcess` for tools, `McpServer`, and the sandboxed `GpuServer` (SPEC 8.6). |
| `gpu.js` | The GPU capability (SPEC 8.6, INV-H7): the decision (`gpuAllowed`), the endpoint contract (`GUEST_ADDR`, `ENV_NAME`, `serviceArg`) and `GpuBroker`, which starts and stops the sandboxed server of each app run. See [The GPU](#the-gpu-spec-86-gpujs). |

## Versions and updates

**Store (SPEC 8.1).** `apps/<id>/<version>/` per installed version, `apps/<id>/current`, optional `source.json`
(`{registry, id, installedFrom}`, written by `install(file, {source: {registry}})`) and `policy.json`
(`{update: manual|compatible|latest}`, default `manual`).

| Method | What |
|---|---|
| `listVersions(id)` | installed versions, oldest first (only complete installs) |
| `getVersionManifest(id, version)` | the parsed manifest of an installed version, or `null` |
| `useVersion(id, version)` | makes an installed version current after re-checking its files against its manifest, then prunes. Whether the app may be switched while it runs is the caller's decision (the loader refuses) |
| `prune(id, keepPrevious=2)` | keeps current plus the 2 versions that were current most recently (folder mtime, set by `install` and `useVersion`), removes the rest. Runs after every `install` and `useVersion`. App data is never touched |
| `getSource(id)` / `setSource(id, {registry, installedFrom})` | `source.json` (registry must be `http(s)`, no credentials); `installedFrom` keeps the first version while the registry is unchanged |
| `getPolicy(id)` / `setPolicy(id, choice)` | `policy.json`; an unreadable or unknown value reads as `manual` |
| `getPackageFile(id, version?)` / `packagePath(id, version)` | `apps/<id>/pkg/<version>.vmapp`: the package exactly as `install` read it (the bytes that were verified), kept so the loader's Publish… can send it; `null` for an install made before packages were kept. Removed with its version by `prune` and `uninstall` |
| `install(file, {dev: {path}})` / `getDevSource(id)` / `setDevSource` / `clearDevSource` | developer build marker `dev.json` `{path}` (the project folder the loader's *Run project folder…* built it from); any `install` without `dev` clears it |

**`updates.js`**: `new Updates(store, {timeoutMs: 5000, downloadIdleMs: 15000})`.

- `check(id, {choice?, download?})` asks `GET {registry}/api/apps/:id/versions` and `/resolve?choice=&from=<installed
  version>` (5 s in total; `manual` counts as `compatible` for an explicit check). It returns
  `{current, candidate, latest, choice, policy, registry, withdrawnCurrent, permissionDiff, offline, error, noSource?, prepared?}`.
  It never throws for network problems (`offline: true`, `error`), never returns a candidate that is not newer, is
  withdrawn, or breaks the choice (the registry's answer is checked again; a registry without `/resolve` works from the
  version list). `permissionDiff` is only known once the package is in hand, so it is filled by
  `check(id, {download: true})` (which also fills `prepared`; a candidate that is already installed needs no download).
- `fetchAndVerify(id, version | 'latest', {registry?})` downloads to `$VMAPP_HOME/tmp/vmapp-dl-*.vmapp`, checks the file's
  sha256 against `X-Vmapp-Sha256`, `package.read` (all of SPEC 2), the package id against `X-Vmapp-Package-Id`, and that id
  and version are the ones asked for. Any failure deletes the file and throws `UpdateError` (`.offline` for connection
  problems). Redirects are refused, with one exception: the registry's `302` for a download (a registry that keeps packages in
  object storage) is followed once (`storageTarget`: http(s) only, never https to http, no password in the address, no second hop),
  and the sha256 and package id are taken from the registry's own response, never from the storage's.
- `apply(id, version, {prepared?, force?, registry?})` installs and makes current (a version that is already installed is
  switched to without network), writes `source.json`, deletes the download. `force` allows an older version than
  the current one: only for an explicit user action.
- `permissionDiff(oldManifest, newManifest)` returns `{added, raised, removed, dialogs, external, hostAdded, hostRemoved, devicesAdded, devicesRemoved, netAdded, netRemoved, any}`
  (`netAdded`: a new network host, a wider wildcard or more ports on a host, SPEC 8.3; it also makes `any` true);
  `any` is what forces a question: a new folder request, raised access (`read` or `writeonly` to `readwrite`; `read` to
  `writeonly` too, which gains the ability to write), `dialogs` or `external` turned on, or a **host capability**
  (SPEC 8.2) the old version did not ask for. `hostAdded` is `[{cap, purpose, control}]` (`control` is INV-H6's
  "requests control of your computer": `input`, `tool:*`, `mcp:*`); a narrower request is not news (`tool:echo` is covered by
  an old `tool:*`, `mcp:<id>` by `mcp:*`; the reverse is added). `hostRemoved` (the caps no longer asked for) is informational.
  An added capability is never granted by an update: it stays off until the user allows it in the permission sheet
  (INV-H2). `hostDiff(oldManifest, newManifest)` is the same computation on its own. A **device** (SPEC 2.2
  `permissions.devices`, §8.4: the microphone) the old version did not ask for is `devicesAdded` (`[{device, purpose}]`) and also
  forces the question (`devicesRemoved` is informational; `deviceDiff` is the same computation on its own). It is never granted
  by an update either.
- `browseRegistry(registry, {q, sort, offset, limit, deadlineMs})`: one page of a registry's app list for the loader's
  *Browse registry…* sheet. The request carries only the search text, sort and page (INV-G3). The answer is cut down to
  plain display data; installing a result goes through `fetchAndVerify` like any registry install.
- Also: `listRegistryVersions`, `discard(file)`, `cleanTmp()`, `parseAppRef(text, defaultRegistry)` (an id, or an app page
  address `<registry>/apps/<id>`), `pickCandidate`, `newestInstallable`, `sameLine`, `isInsecureRemote`.

**Publishing (the loader's *Publish…*)**, also in `updates.js`, also only on the user's say-so:
- `publish(file, {registry, token?, publisher?, direct?})` verifies the package, then asks `GET {registry}/api/info`: a registry that
  lists `presigned` gets `POST /api/publish/init`, a `PUT` of the file to the storage address it names, and
  `POST /api/publish/complete`; any other registry (or `direct: true`) gets the file streamed with `POST {registry}/api/publish`
  (`Authorization: Bearer <token>` when there is a token; otherwise `X-Vmapp-Publisher` from `publisher`
  `{name, company, email, url}`, ASCII-escaped). 201 resolves `{id, version, packageId, url, ownerToken|null, publisher, registry}`;
  anything else rejects with an `UpdateError` whose `status`/`code` come from the registry, whose message is
  `publishErrorText(status, {message, hadToken})` (docs/PUBLISHING.md 3.4 in plain words) and whose `detail` is the
  registry's own text; network problems reject with `offline: true`. Redirects are not followed, no timeout on the upload
  itself, 60 s without any traffic aborts it. A failed upload to the storage address rejects with `code: 'upload_failed'`.
- Owner tokens: `getPublishToken(home, registry, id)`, `savePublishToken(home, registry, id, token)` (mode 0600, atomic),
  `publishRegistriesFor(home, id)`, `publishTokensFile(home)`: `$VMAPP_HOME/publish-tokens.json`
  `{ "<registry url>": { "<app id>": "<token>" } }`, the file and format `vmapp publish` uses.

INV-G3: nothing here runs by itself. The callers (loader UI, CLI) invoke it only from what the user chose, and
requests carry only the app id, the installed version and the choice. This module decides nothing for the user: it
never installs without being told to, and never grants anything.

## Package layout consumed by `pack`

```
<project>/vmapp.json        manifest without "files"
<project>/<ui.root>/...     UI files (default "ui"; a single folder name)
<project>/core/...          becomes core.cpio, or core.erofs with "core": {"image": "erofs"} (the VM's /app)
<project>/icon.png          optional
```

`.DS_Store` files are ignored. Symlinks in the UI folder are refused; symlinks in `core/` must be relative and stay
inside it.

## AppSession

```js
const session = new AppSession({
  appId,                  // installed app id
  home,                   // VMAPP_HOME (or pass `store`)
  vmappVmPath,            // path of vmapp-vm; tests use [process.execPath, 'fake-vmapp-vm.js']
  kernel, initramfs,
  grants,                 // {folders:{name:{path,access}|null}, askEveryTime, resources?}; default: store.loadGrants(appId). `resources` is the VM size
  hostLimits,             // optional {cpus, memoryMiB} (tests): what this Mac allows; default its logical cores and half its RAM
  windowManager,          // see below
  dialogs,                // see below (optional; without it, dialog requests fail)
  onLog,                  // ({level, source: 'core'|'host'|'vmapp-vm', message}) => void
  openExternal,           // optional (url) => void, overrides dialogs.openExternal and the OS opener
  timeouts,               // {ready:20000, coreReady:30000, beforeQuit:3000, stop:10000, grant:10000}
});
await session.start();    // spawn, wait ready line, connect bridge, send init, wait core `ready`
await session.stop();     // before-quit (3 s) -> {"op":"shutdown"} -> wait <= 10 s -> SIGKILL; resolves with the stopped line
```

Events: `ready` (core ready), `exported` (`{share, files}`), `stopped` (the parsed `stopped` line; a synthetic one
with `synthetic:true` if `vmapp-vm` died without printing it), `log`.

Properties: `state` (`new|starting|running|stopping|stopped`), `windows` (Set of host window ids), `manifest`,
`stoppedInfo`, `whenStopped()`.

Host -> core calls (the window manager calls these):

```js
session.invoke(win, channel, args)      // -> Promise<result>; rejects with Error(message) if the core handler threw
session.send(win, channel, args)        // renderer called vmapp.send
session.windowEvent(win, event, data)   // event: 'closed' | 'focus' | 'blur' | 'resize'
```

The session also exposes `grant(name, 'ro'|'rw'|'wo', hostPath)` / `revoke(name)` (the stdin commands of SPEC 5).

### Window manager interface (implemented by the loader)

```js
{
  create(params) -> Promise<number>   // params: {entry, width, height, minWidth?, minHeight?, title?, resizable?, devTools?}
                                      // devTools (boolean) is the core's own request for DevTools on this window (SPEC 7); a window manager shows them only for true
                                      // entry is already validated: relative to ui.root, no "..", no empty parts.
                                      // Returns the new host window id (integer).
  close(win)                          // close the window
  setTitle(win, title)                // the loader shows "<title> — <app name>"
  focus(win)
  emit(win, channel, args)            // core -> renderer: webContents.send. args is an array of JSON values.
}
```

Rules for the implementer:
- All methods may return a Promise. A rejection becomes `reply.error = {message}` for the core's request.
- The session checks that `win` in `close/setTitle/focus` belongs to the app (it keeps the set of ids that `create`
  returned and that were not reported closed).
- **The window manager must report every close, whatever its cause** (user clicked the close button, or the core
  asked for it via `close`) with `session.windowEvent(win, 'closed', {})`. The core's `window-all-closed` logic relies on
  it. Reporting a close that the session itself caused while stopping is harmless: the call is ignored once the bridge
  is gone.
- Renderer calls: `vmapp.invoke(channel, ...args)` -> `session.invoke(win, channel, args)` and return/reject the result.
  `vmapp.send` -> `session.send(win, channel, args)`.
- When the session stops, it calls `windowManager.close(win)` for every window that is still open.
- The window network (SPEC 8.3 "The app's windows"): for an app that declares the window feature `network`, `session.windowProxy`
  is `{host: '127.0.0.1', port, username, password}` while the VM runs (null otherwise). A window manager with real windows points
  the app's partition at it before the run's first window loads, answers its proxy authentication for that partition only, and
  lets only what `loader/src/window-net.js` allows out; the headless fake ignores it. Never log the password.

### Dialogs interface (implemented by the loader)

```js
{
  open({win, title, directory, multiple, access, app}) -> Promise<string[] | string | null>   // host paths; null/[] = cancelled
                                        // access: 'read' | 'readwrite' (directory picks; file picks always get 'read'):
                                        // state it in the dialog ("... will be able to change files in this folder")
  save({win, title, defaultName, app})          -> Promise<string | null>              // host file path
  message({win, type, message, detail, buttons, app}) -> Promise<number>               // index of the clicked button
  confirmExternal(url, app)                     -> Promise<boolean>                    // https URL, show it to the user
  openExternal?(url)                            -> Promise<void>                       // optional; default is the OS opener
}
```

`app` is `{id, name}`: show it in the dialog so the user knows who asks. `win` is a host window id or `undefined`.
`type` is `info|warning|error|question`. The session has already checked `permissions.dialogs` (open/save) and
`permissions.external` before calling, and validated the URL (`https:` only).

How the session turns picks into shares (SPEC 6): `dialog.open` with `directory:true` shares each chosen directory as
`pick-N`, read-only by default or read-write when the request says `access:"readwrite"` (invalid values are refused),
through a `grant` command on `vmapp-vm`'s stdin; it waits for the `granted` line and returns `/host/pick-N`. File
picks never expose the parent folder: each chosen file is cloned (`COPYFILE_FICLONE`, plain copy as fallback) into a
fresh `$VMAPP_HOME/picks/<app id>/pick-N/`, that folder is granted read-only and `/host/pick-N/<file name>` is
returned (one folder per file). `picks/<app id>/` is removed when the session stops (and cleared at the next start).
`dialog.save` grants `save-N` write-only on the chosen *file* path and returns `/host/save-N/<name>`.

### Events

`ready`, `stopped`, `exported` (`{share, files}`), `log`, plus:
- `grant` `{name, access:'ro'|'rw'|'wo', path}`: a run-time share was added (picks and saves).
- `traffic`: one per bridge message, both directions (the bridge inspector's feed):
  `{ts, dir:'to-core'|'from-core', t, id?, win?, channel?, op?, event?, bytes, durationMs?, error?, preview}`.
  `result` events carry the `channel` and `durationMs` of their `invoke`, `reply` events the `op` and `durationMs` of
  their `request`; `event` is the window event or log level; `error:true` marks error results/replies. `preview` is
  the first 200 characters of the message JSON, never the full payload. Nothing is computed while nobody listens.
  Besides bridge messages the feed also carries `{kind:'host', ...}` events (host capabilities, SPEC 8.2) and
  `{kind:'net', ...}` events (one per proxied connection that closed or was refused, SPEC 8.3, see Network below).

`Store.resetApp(id)` (loader "Reset"): empties `data/<id>/`, deletes `grants/<id>.json`, clears `picks/<id>/`; the
package, the console log and the user's own folders are untouched. The caller makes sure the app is not running.

## Host capabilities (SPEC 8.2)

Screen capture, mouse and keyboard control, host tools and MCP servers for an app, only with the user's say-so. The
policy is in `capabilities.js`; the processes are in `hostproc.js`. **The loader builds one `HostCapabilities` and
passes it to every `AppSession`.**

```js
const { Store, Catalog, HostCapabilities, AppSession } = require('./hostlib');
const caps = new HostCapabilities({
  store,                // Store (grants are read from it at every call, so a change applies at once)
  ui,                   // the loader's capability UI, below
  hostctlPath,          // packaged loader: Contents/Resources/vmapp/vmapp-hostctl (dev: out/vmapp-hostctl is the default)
  // optional: catalog (default: new Catalog({home: store.home})), hostctl (an object or () => object with
  //   request(op,args) / on('panic') / close(), for tests), packaged, dryRun, panicHotkey (default true on macOS),
  //   inputMaxMs (default 600000), mcpRequestTimeoutMs (default 60000),
  //   excludePids (default [process.pid]: the loader; windows of these processes are left out of every screenshot and out of host.screen.windows)
});
new AppSession({ ..., capabilities: caps });     // without it every host.* op is refused
caps.on('panic', ({reason}) => ...);             // after stopAll(): everything was stopped
caps.on('active-changed', () => badge.update(caps.active()));
caps.on('traffic', (ev) => ...);                 // every host use of every app (also on session 'traffic', below)
caps.on('warning', (message) => ...);            // e.g. the panic hotkey could not be registered
await caps.close();                              // loader quit: stops everything and the vmapp-hostctl process
```

### Broker API (what the loader calls)

| Call | What |
|---|---|
| `caps.enablePanic()` | Registers the panic shortcut (and starts `vmapp-hostctl`) now, returning a promise. The loader calls it at startup so ⌃⌥⌘. works before any app asked for control; without it that happens at the first input session or tool run. A failure is a `'warning'`, not an exception to the caller. |
| `caps.stopAll(reason='panic')` | **Panic** and the badge's "Stop all": ends every input session, kills every running tool and MCP server of every app, forgets "allow for this session" answers, emits `'panic'`. Also called when `vmapp-hostctl` reports the hotkey ⌃⌥⌘. (registered on the first input session or tool run). |
| `caps.stopControl(appId, reason='user')` | The badge's "Stop" for one app: ends its input sessions and running tools/servers; the app keeps running. |
| `caps.stopApp(key, reason)` | Called by `AppSession` when the app stops. Also turns the app's `session` grants back into `ask`. The loader does not need to call it. |
| `caps.active()` | `[{kind:'input', key, appId, appName, sessionId, reason, since, expiresAt} \| {kind:'shell', key, appId, appName, runId, tool:{id,name}, since}]`: what the badge shows. Re-read it on `'active-changed'`. |
| `caps.requestOp(op, params, ctx)` | Used by `AppSession` for `host.*` requests. |

`ui` may define `attach(caps)`, which receives the broker so a badge button can call `caps.stopAll()`.

### Capability UI (implemented by the loader; `FakeCapabilitiesUi` in `headless.js` is the scripted version)

```js
{
  confirmUse({app:{id,name}, cap, op, detail, purpose, shell, params?}) -> Promise<boolean | 'session'>
      // mode `ask`: show a native loader dialog. `cap` is screen | input | tool:<id> | mcp:<id>; `op` the bridge op;
      // `detail` what exactly, clipped to one line (the command line, "start controlling the mouse and keyboard:
      // <reason>", the MCP method); `purpose` the app's stated reason (app-supplied text: show it as a quote); `shell`
      // true for a shell tool (red warning). `params` (optional) is the app's own arguments for this use, unclipped, so the
      // dialog can show them in full and word the question in plain language: `{target, windowId?, region?, display?}` for
      // a capture, `{reason}` for input control, `{id, args}` for a tool, `{server, method, params}` for MCP. It is untrusted
      // app data: show it as text, never as the loader's own words. Answer true (this once), false, or 'session' ("allow
      // for this session": the broker remembers it until the app stops, or panic). Throwing or no answer counts as no.
  chooseCapture?({app, cap, op, detail, purpose, params, suggestion}) -> Promise<false | {allow: true | 'session', target?}>
      // optional: the USER picks what a screenshot contains (SPEC 8.2). `suggestion` is the app's parameters, validated
      // ({target, display?|windowId?|region?, maxWidth?}); `params` is the raw request. The answer's `target` is
      // {kind:'display', display} | {kind:'window', windowId} | {kind:'region', region:{x,y,w,h}} (global points) and is
      // checked again by the broker (a bad target counts as "no" with a 'warning'). Without a target the app's suggestion is
      // used. `'session'` remembers the PERMISSION only (never a target): later captures of the run use the suggestion, or the main
      // display when it no longer exists. A UI without chooseCapture gets confirmUse() for screenshots (headless.js does).
  inputActivity?({app, sessionId, kind:'mouse', action, x?, y?, button, clicks, dx?, dy?} | {app, sessionId, kind:'keys', text} | {…, kind:'keys', key, modifiers})
      // optional, fire and forget (its failure never affects the input): what the app just did, accepted by the helper. The
      // loader draws it as the virtual-input overlay (ring, ripple, key caption). Never logged; x, y are global points.
  inputStarted({app, reason, sessionId, expiresAt})   // show the always-on-top badge "<App> is controlling your computer - Stop"
                                                      // (reject to refuse: the input session is not started)
  inputStopped({app, sessionId, reason})              // reason: stopped | expired | renewed | revoked | panic | user | app-stopping | app-stopped | closed
  shellStarted({app, tool:{id,name}, runId, detail})  // badge while a shell tool runs; called BEFORE the process starts
  shellStopped({app, tool:{id,name}, runId})
  attach?(caps)
}
```

Without `inputStarted` the broker refuses `host.input.start`; without `shellStarted` it refuses shell tools (INV-H3).
The Stop button calls `caps.stopControl(appId)` or `caps.stopAll()`; the badge reads `caps.active()`.

### What the broker checks (every call)

1. The manifest requests the capability: `permissions.host` has `cap`, or `tool:*` / `mcp:*` for `tool:<id>` / `mcp:<id>`.
2. A grant exists in `grants/<id>.json` under `host` (`tool:*` / `mcp:*` grants list the `tools` / `servers` the user picked).
3. Mode: `ask` calls `ui.confirmUse` (unless remembered for the session); `session` and `always` do not. `always` is treated
   as `ask` for `input` and shell tools. `session` grants return to `ask` when the app stops.
4. Then the op's own checks (below). Denials are `permission denied: ...` errors; each use emits a host event.

| Op | Behaviour |
|---|---|
| `host.screen.windows` | `vmapp-hostctl` `windows`, without the windows of `excludePids` (the loader's own). Allowing screenshots for the run also allows this; the reverse does not hold. |
| `host.screen.capture` | The params are a SUGGESTION (validated: `target`, `display` for a display, `windowId`, a global-points `region`, `maxWidth`). In mode `ask` the question is `ui.chooseCapture` (the user picks) or `ui.confirmUse` (suggestion kept); `session` / `always` and a remembered "allow while the app runs" use the suggestion, and the main display when the helper says `not-found` / `bad-request` for it. `vmapp-hostctl` `capture` gets only whitelisted fields plus `excludePids`; a capture over ~12 MiB is retried with `maxWidth` 1920, 1280, 800. The result is `{png, width, height, target:{kind, display?, windowId?, region?, bounds?, by:'user'\|'app'\|'default'}}`. |
| `host.input.start` | needs `ui.inputStarted`; registers the panic hotkey; one session per app (a new start renews: the old one ends with `renewed`); expires after 10 minutes (`expired`); returns `{sessionId}`. |
| `host.input.mouse` / `.keys` / `.stop` | validated and passed to hostctl; after it accepted a mouse or keys event `ui.inputActivity` is told (the overlay) (`dryRun:true` is added only when `dryRun` is set: option, or `VMAPP_HOSTCTL_DRYRUN=1` in a non-packaged build). A held button is released when the session ends. Typed text is not logged. |
| `host.tool.list` | tools both requested and granted: `{id, name, kind, description?, variadic?, args}`; no host path. |
| `host.tool.run` | arguments matched against the spec list (whole-argument regex; `optional`; `variadic` repeats the last spec); `mapPath` arguments map through the session's current shares (`AppSession.resolveHostPath`); `spawn(path, argv, {shell:false})` in its own process group, env `{PATH: /usr/bin:/bin:/usr/sbin:/sbin, HOME}`, cwd `tool.cwd` or home, `timeoutMs` kill, stdout+stderr limited to `maxOutputBytes` (`truncated:true`), `stdin` up to 1 MiB, at most 4 at a time per app. |
| `host.mcp.list` / `.call` | one server process per app per server (clean env plus the definition's `env`), started on first use, `initialize` + `notifications/initialized` automatic, newline-delimited JSON-RPC; `call` relays only `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`; killed when the app stops, on panic, or when it dies it restarts at the next call. |

### Events for the Inspector

Each use emits on the session (`session.on('traffic')`) and on the broker (`caps.on('traffic')`):
`{ts, dir:'from-core', t:'host', kind:'host', appId, cap, op, detail, allowed, durationMs, error?, message?, bytes:0, preview}`.
`detail` is short (tool arguments truncated, typed text replaced by its length, no screenshot bytes). The generic bridge
`traffic` event for a `host.*` request/reply has `preview: "[host.x: payload not shown]"`. Input sessions ending by
themselves (expiry, panic, revocation) produce a `host.input.stop` event with `detail: "input control ended: <reason>"`.

### Catalog, grants and the permission sheet (CLI and loader UI only)

```js
const catalog = new Catalog({ home });       // capabilities/tools.json, capabilities/mcp.json (JSON arrays)
catalog.tools() / tool(id) / mcpServers() / mcpServer(id)          // always re-read from disk
catalog.addTool(def) / removeTool(id) / addMcp(def) / removeMcp(id) / saveTools(list) / saveMcp(list)   // WRITE: CLI and loader settings UI only
catalog.readonly()                           // what the broker holds: no write methods

validateTool(def, {checkFs}) / validateMcp(def)   // throw CatalogError with a precise message
// tool: {id, name, path (absolute, executable), args:[{pattern, optional?, mapPath?: true|'read'|'write'}], variadic?,
//        timeoutMs (<= 600000, default 30000), maxOutputBytes (<= 16 MiB, default 1 MiB), kind:'tool'|'shell', description?, cwd?}
// mcp:  {id, name, command:[absolute path, ...args], env?:{NAME:'value'}, description?}
// pattern: must start with ^ and end with $; it is applied to the WHOLE argument (a top-level `a|b` cannot match a part).
// A shell tool is typically: {kind:'shell', path:'/bin/sh', args:[{pattern:'^-c$'},{pattern:'^[\\s\\S]{1,10000}$'}]}

hostRequestSummary(manifest, catalog, grants)  // [{cap, purpose, risk:'screen'|'input'|'tool'|'shell'|'mcp', control, grant|null, candidates:[{id,name,kind?}]}]
                                               // `control` is INV-H6's "requests control of your computer" (input, tool:*, mcp:*)
checkHostGrant(manifest, catalog, cap, spec)   // validates {mode, tools?, servers?}: the manifest requests it, no `always` for input
                                               // or shell tools, listed tools/servers exist
setHostGrant(store, catalog, app, cap, spec | null)   // validates and stores (null removes); app = store.get(id)
store.loadHostGrants(id) / saveHostGrants(id, host) / setHostGrant(id, cap, grant|null) / expireSessionHostGrants(id)
```

`store.saveGrants(id, {folders, askEveryTime})` keeps the existing host grants (pass `host: {}` to clear). A version update that adds
a `permissions.host` entry always stops and asks (SPEC 8.1): `updates.permissionDiff` reports it as `hostAdded`, and the loader's
"asks for more" sheet lists it.

### Devices (SPEC 2.2, §8.4)

`manifest.js` validates `permissions.devices: [{device, purpose?}]` (only `microphone`; `camera` is reserved and rejected with its
own message; at most 4 entries; the key is present in the normalised manifest only when the app asks). `store.js` keeps the user's
choice in `grants/<id>.json` as `devices: {microphone: {mode: 'allow'}}` (absent = Don't allow):
`store.loadDeviceGrants(id)` / `saveDeviceGrants(id, devices)` / `setDeviceGrant(id, device, grant|null)`; `saveGrants` and
`saveHostGrants` keep them (pass `devices: {}` to clear); Reset forgets them. `deviceAllowed(manifest, grants, device)` is the one
decision: the manifest asks **and** the grant allows. The loader's permission gate (`loader/src/devices.js`) and the CLI
(`vmapp grant-device`) use it. An app window's `getUserMedia` is allowed by the loader only through that gate.

### Network (SPEC 8.3, `network.js`)

`manifest.js` validates `permissions.network: [{host, ports?, purpose?}]` through `network.validateNetwork` (32 entries, hosts
are lower-case ASCII names or `*.suffix`, never IP literals; the key is present in the normalised manifest only when the app asks).
The user's choice is `grants/<id>.json` `network: {"<host as listed>": {allow, ports?}}` (absent = deny):
`store.loadNetGrants(id)` / `saveNetGrants(id, network)` / `setNetGrant(id, host, grant|null)`; `saveGrants` keeps them (pass
`network: {}` to clear) and installing or switching to a version drops the grants of hosts it no longer lists (`pruneNetGrants`),
and **pins** an `allow: true` without `ports` (which means "all the ports the manifest requests") to the ports the previous
version asked for, so an update that asks for more ports never widens a grant (INV-N2). `network.checkNetGrant(manifest, host,
{allow?, ports?})` is what a UI calls before saving: only listed hosts, never more ports than requested.

| Function (`require('./network')`) | What |
|---|---|
| `resolveNetwork(manifest, grants)` | `{rules:[{host,ports,arg}], args:['host:443',...], notes}`: the `--net` rules for `vmapp-vm`; nothing granted means `args: []` and no network channel |
| `netRequestSummary(manifest, grants)` | for the sheet and the install review: `[{host, ports, purpose, wildcard, insecure (port 80), odd (not 443), grant, allowed, allowedPorts}]` |
| `riskSummary(manifest, grants?)` | the exfiltration pair (INV-N4): `{requested, granted, atRisk, active, message, activeMessage}`, sentences like "This app could read the folder “notes” and send what it reads to api.example.com." The loader writes this itself, never the app |
| `netDiff(old, new)` | new hosts, wider wildcards, new ports: `{added:[{host, ports, newPorts, kind:'host'\|'ports', wildcard, insecure, purpose}], removed}`; `updates.permissionDiff` reports it as `netAdded` / `netRemoved`, and `netAdded` forces the "asks for more" sheet |
| `matchRule(entry, host, port)`, `parseHostPattern`, `hostnameProblem` | the matching and name rules, identical to `host/src/net.rs` (`tests/net/vectors.json` is tested by both) |

`AppSession`: the allowed rules go to `vmapp-vm` as `--net host[:ports]`. While the app runs, call `session.syncNetwork()` after the
user changes a grant (it compares the stored grants with what the VM has and issues `net-allow` / `net-revoke`; revoking closes the
host's open connections at once), or `netAllow(host, ports?)` / `netRevoke(host)` directly. Every `{"net":...}` line of `vmapp-vm`
becomes a `traffic` event for the Inspector: `{ts, dir:'from-core', t:'net', kind:'net', appId, id, host, port, allowed, bytesUp,
bytesDown, durationMs, reason?, bytes, preview}` (host names and byte counts only). Option `devNet: {allowLoopback, resolve}` is for
tests (it adds `--dev-allow-loopback` / `--dev-resolve`); the loader never sets it and `tools/check-invariants` fails if those
names appear anywhere in `loader/` or in `hostlib/` outside `session.js` (INV-N3).

### The VM's size (SPEC 8.5, `resources.js`)

`core.cpus` (1-16) and `core.memoryMiB` (64-32768) in the manifest are **recommendations**. The user's choice is
`grants/<id>.json` `resources: {cpus?, memoryMiB?}`; `AppSession` starts the VM with the resolved size (`--cpus`, `--memory`), logs
"VM size: ... (your choice | default); the app recommends ...", and exposes it as `session.vmSize`.

| Function (`require('./resources')`) | What |
|---|---|
| `hostLimits({cpus?, totalMemoryMiB?})` | `{cpus, memoryMiB}` this Mac allows: its logical cores, half of its RAM (at least 64 MiB). The options are for tests |
| `resolveResources(manifest, grants, limits?)` | `{cpus, memoryMiB, recommended, limits, chosen, custom, notes}`: the user's choice, else **1 vCPU and the recommended memory**; lowered to `limits` with a note |
| `checkResources({cpus?, memoryMiB?}, limits?)` | what a UI or the CLI calls before saving: whole numbers, vCPUs at most the cores, memory 64 MiB up to half the RAM; below the recommendation is allowed. Throws `ResourceError` |
| `resourceSummary(manifest, grants, limits?)` | for the sheet and the card: `{recommended, limits, current, custom, chosen, memoryChoices, below:{cpus, memoryMiB}, notes}` |
| `recommendedChoice(manifest, limits?)` | "Use recommended": the recommendation lowered to `limits` |
| `describeSize(size, unit?)` | "2 vCPUs, 512 MB" (pass `'MiB'` for logs and the CLI) |

`Store`: `loadResources(id)`, `saveResources(id, {cpus?, memoryMiB?} \| null)` (null forgets it); `saveGrants` keeps the choice
(`resources: null` clears it), updates keep it, Reset clears it. `store.hasDecided(id)` is true once the user decided anything
besides the size: a grants file that holds only `resources` (chosen on the card before the first launch) does not suppress the
first-launch permission sheet. CLI: `vmapp resources <id> [--cpus N] [--memory MiB] [--recommended] [--default]`.

### The GPU (SPEC 8.6, `gpu.js`)

`{cap:'gpu'}` in `permissions.host` plus the user's grant `host.gpu = {mode:'session'}` ("Allow while the app runs", the only mode;
`ask` and `always` are refused by `Store`, `checkHostGrant` and the CLI; the grant survives the app stopping, and is dropped when a
version stops asking for `gpu`). `AppSession` takes a `GpuBroker` (option `gpu`); the loader and `vmapp run --headless` build one.

| API (`require('./gpu')`) | What |
|---|---|
| `gpuRequest(manifest)`, `gpuAllowed(manifest, hostGrants)` | the manifest's `gpu` entry; the decision: asked **and** `session` granted |
| `GUEST_ADDR` = `127.0.0.1:50052`, `ENV_NAME` = `VMAPP_GPU_RPC`, `SERVICE` = `gpu`, `serviceArg(port)` = `gpu=127.0.0.1:PORT` | the contract (what the core sees; what `vmapp-vm --service` gets) |
| `new GpuBroker({binary, profile, home, metalCache?})` | `availability()`, `start(key, {appId, appName})` -> `{endpoint, port, pid}`, `stop(key, reason)`, `stopAll(reason)`, `active()`, `isRunning(key)`, `reapStale()`; events `started`, `stopped` (`reason`: what `stop` was given, or `crashed`), `active-changed`. `serverFactory` and `pickPort` options are for tests |

`AppSession`, when the app is allowed: starts the server **before** the VM, passes `--service gpu=127.0.0.1:PORT` and
`VMAPP_GPU_RPC=127.0.0.1:50052` in the start `env` (the loader's value, after the manifest's, which cannot set `VMAPP_*` anyway);
turns the launcher's `{"service":...}` lines into `traffic` events `{kind:'gpu', t:'gpu', phase:'connect'|'traffic'|'disconnect', ...}`
and logs the server's start/stop as `{kind:'gpu', phase:'server', op:'start'|'stop'}` rows; looks at the app's grant once a second
(`gpu.WATCH_MS`) and, when it is gone, calls `session.revokeGpu('revoked')` (stdin `service-revoke`, then stops the server); sends
`service-revoke` whenever the server ends for any reason (panic, a crash); stops the server when the app stops. An app that is not
allowed, or whose server cannot start, runs without a GPU and the log says why. `FAKE_VM_SERVICE_EVENTS` in
`tests/unit/fixtures/fake-vmapp-vm.js` plays `service` lines in tests.

### The experimental Vulkan backend (SPEC 8.7, `gpu.js`, `session.js`)

`{cap:'gpu', api:'vulkan'}` (manifest runtime `node22-gpu`) is another capability than the plain `gpu` above: the user's grant records the API
(`host.gpu = {mode:'session', api:'vulkan'}`; `checkHostGrant` adds it from the manifest, `hostRequestSummary` returns `api` and `experimental` and
shows a grant only if its API matches; `pruneGpuGrant` drops a grant when a version changes the API; `permissionDiff` reports the Vulkan form as
a new capability, key `gpu:vulkan`). `gpuAllowed` is the plain decision (and false for a Vulkan request), `vulkanAllowed` the Vulkan one,
`gpuApi(manifest)` the API. `chooseBackend({manifest, hostGrants, enabled, installed})` -> `{backend:'krun'|'vz', why}` is the only place the
backend is decided: Vulkan asked **and** allowed **and** the loader setting on **and** installed.

`AppSession` option `krun: {path, kernel, enabled: boolean | () => boolean, gpuWindowMiB?}` (the loader builds it from `loader/src/config.js`
`krunVm`/`krunKernel` and the preference `experimentalGpuVulkan`; `vmapp run --headless --experimental-gpu` from `out/krun/bin/vmapp-vm-krun`
and `out/Image-gpu`). A run on the backend starts `vmapp-vm-krun` with the gpu kernel and (if given) `--gpu-window`, logs "EXPERIMENTAL: the app runs
on the Vulkan GPU backend", adds a `{kind:'gpu', phase:'server', op:'start', backend:'krun', api:'vulkan'}` row, refuses `dialog.open` and
`dialog.save` with `not supported on the gpu backend` before the user is asked (`session.backend === 'krun'`), and logs the backend's own stop
verdicts (`gpu-hang`, `vmm-crashed`, with the stopped line's `detail`) as a warning plus a stop row. `FAKE_VM_REASON` in
`tests/unit/fixtures/fake-vmapp-vm.js` plays a verdict in tests. Tests: `tests/unit/gpu-vulkan.test.js`.

### Processes (`hostproc.js`)

`HostCtl({command, panicHotkey})` (lazy start, id-matched replies, `'panic'` / `'exit'` / `'warning'` events, restarts on the next
request), `startProcess(file, args, opts)`, `McpServer({command, env})`, `GpuServer({binary, profile, port, device?, metalCache?})`
(`/usr/bin/sandbox-exec -f <profile> -D BIN=… -D PORT=… <binary> --host 127.0.0.1 --port N --device MTL0`; `start()`, `stop(reason)`,
`argv()`, event `exit`), `metalCacheRoot()`, `resolveHostCtlCommand`, `hostDryRun`. In tests
`VMAPP_HOSTCTL` (a path or a JSON array like `["/path/node","fake-hostctl.js"]`) replaces the helper; both it and
`VMAPP_HOSTCTL_DRYRUN` are ignored when `packaged` (Electron, not `defaultApp`).

`AppSession` additions: option `capabilities`; `session.resolveHostPath(vmPath)` -> `{path, access:'ro'|'rw'|'wo', name}` (only shares
currently granted to the run: `f-<name>`, `pick-N`, `save-N`; refuses `..`, other names and symlinks leading out of the share).

## Headless helpers

```js
const wm = new FakeWindowManager();     // records windows; wm.attach(session)
const dialogs = new FakeDialogs({ open: ['/some/dir'], save: '/some/file', message: 0, confirmExternal: true });
wm.waitForWindows(1)                    // -> Promise<windowRecords>
wm.invoke(win, channel, ...args)        // acts as the renderer: -> session.invoke
wm.send(win, channel, ...args)
wm.waitForEmit(channel, {win, timeoutMs}) // -> Promise<args> of the next core emit
wm.userClose(win)                       // the user closes a window
wm.events                               // EventEmitter: window-created, window-closed, emit, title, focus

const ui = new FakeCapabilitiesUi({ allow: true });   // false (default) | true | 'session' | (request) => value
ui.calls                                // confirmUse requests; ui.badges: [{badge:'input'|'shell', state:'on'|'off', ...}]
ui.events                               // EventEmitter: 'confirm' (request, answer), 'badge' (entry)
```

`vmapp run --headless` builds a `HostCapabilities` with a `FakeCapabilitiesUi` (`--allow-host` answers yes, the default is no),
logs `[host] ...` and `[badge] ...` lines, and passes `{session, wm, dialogs, store, capabilities, capUi}` to `--script`.

`FakeWindowManager` is not an EventEmitter because `emit(win, channel, args)` is the interface method.

## Tests

`node --test vmapp/tests/unit/` (the directory has an `index.js` that loads every `*.test.js`; Node 22 resolves a
directory argument like `require(dir)`). The session tests use `tests/unit/fixtures/fake-vmapp-vm.js`, which speaks
the `vmapp-vm` protocol and runs the SDK app as a plain process.
