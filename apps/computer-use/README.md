# Desk Helper (`dev.vmapp.deskhelper`, runtime `node22`)

A small computer-use demo. It shows every host capability of [SPEC §8.2](../../SPEC.md) through the SDK's `host` object, and how an app should behave when the user says no.
The guide for developers and users is [docs/HOST-CAPABILITIES.md](../../docs/HOST-CAPABILITIES.md).

## What it demonstrates

| Card | SDK calls | Needs |
|---|---|---|
| 1. **Look at my screen** | `host.screen.capture({target:'display', maxWidth:1024})` and `host.screen.windows()`. **The parameters are only a suggestion: you choose** what the loader shares (a display, a window or a region) in the loader's question, and Desk Helper shows **what was actually captured** (`result.target`: kind, display or window id, the area in global points, and whether you chose it, or it used its suggestion, or fell back to the main display). Next time it suggests what you picked before. The PNG goes to the UI as base64 and is shown through a `blob:` URL (the UI CSP allows `img-src blob:`). | `screen` |
| 2. **Point and click** | Click the screenshot to choose a point. The UI maps it to **global desktop points** with `result.target.bounds` (so it is right for another display, a window or a region, not only the main display), then the core runs `host.input.start(reason)` → `session.mouse({action:'move'})` → `session.mouse({action:'click'})` → `session.stop()`. While it runs you see the loader's red ring and key captions on screen (the overlay). | `input` |
| 3. **Type text** | A 3 second countdown in the UI (so you can focus a target app), then `session.keys({text})` into the focused app. | `input` |
| 4. **Run a tool** | `host.tool.list()` → pick a tool → one argument per line → `host.tool.run(id, args, {stdin})` → exit code, stdout, stderr. | `tool:<id>` via `tool:*` |
| 5. **Use an app's MCP tools** | `host.mcp.list()` → pick a server and tool → JSON arguments → `host.mcp.call(server, 'tools/call', {name, arguments})` → the result. | `mcp:<id>` via `mcp:*` |

Every card says which permission it requires. Every handler in `core/main.js` goes through one `attempt()` helper:
a denied call (`permission denied: ...` because nothing was granted, or because you answered no) comes back as
`{ok:false, denied:true, cap, error}`, and the UI shows a clear "Not allowed" line with what to grant. Input
sessions are always stopped in a `finally`, so the control badge disappears even if a step fails.

The manifest asks for `screen`, `input`, `tool:*` and `mcp:*` (each with a `purpose` text), no folders, and
`dialogs: false`. It names no tool path or command: you map `tool:*` and `mcp:*` onto your own catalog.

## The risks, plainly

- **Granting `input` lets this app act as you.** The clicks and key presses of the demo are real, they go to
  whatever is under the pointer or has the keyboard focus. The VM does not protect you from what you granted. Pick a
  harmless spot, and keep a text editor focused for card 3.
- **Granting `screen` lets it see what you choose to share** (passwords in other windows, private chats, if they are in
  what you pick). You pick a display, a window or a region each time you answer *Allow once*; *Allow while the app runs* lets it
  take more screenshots without asking, of what it suggests (your last pick, here) or your main display. The picture is only
  sent to this app's window, but the app sees it.
- **A tool is as powerful as the one you registered.** The presets below are narrow on purpose. A `shell` tool
  would run anything the app types.
- **An MCP server is a program on your Mac** that the host starts for this app and that may do whatever its tools do.
- You stay in control: the red badge and the overlay (ring, ripples, key captions) while input is active, **⌃⌥⌘.** stops
  everything, an `ask` grant asks for each use, and revoking a grant applies at once.

## Set up the catalog (once, on the host)

Apps never define tools or servers. You do, with the CLI (or the loader's settings). `vmapp` below is `vmapp/tools/vmapp`.

**A tool that takes a screenshot** (it writes to one fixed file, no argument can change that):

```sh
vmapp tool add screencapture --name "Screenshot to a file" --path /usr/sbin/screencapture \
  --arg '^-x$' --arg '^/tmp/deskhelper-shot\.png$' \
  --description "Silent screenshot of the whole screen into /tmp/deskhelper-shot.png"
```

In the app: tool `screencapture`, arguments `-x` and `/tmp/deskhelper-shot.png` on two lines. (Desk Helper has no
folders, so it cannot use `mapPath`; an app with a save dialog or a granted folder would register
`--arg '^/host/(save|pick)-\d+/[\w .-]+\.png$' --map-path-arg 1` so the tool writes into a folder the user already
granted.)

**A tool that opens an app** (`open -a`, limited to three apps):

```sh
vmapp tool add open-app --name "Open an app" --path /usr/bin/open \
  --arg '^-a$' --arg '^(Calculator|TextEdit|Notes)$'
```

In the app: tool `open-app`, arguments `-a` and `TextEdit`.

**An MCP server.** Use any stdio MCP server you already have. The command must start with an absolute path:

```sh
vmapp mcp add notes-mcp --name "My notes server" -- /usr/local/bin/node /Users/me/mcp/notes-server.js
```

**To try it with no real server,** use the fake MCP server the tests use. It has the tools `echo`, `pid`, `env`:

```sh
vmapp mcp add fakemcp --name "Fake MCP" -- "$(command -v node)" "$PWD/vmapp/tests/unit/fixtures/fake-mcp-server.js"
```

In the app: server `fakemcp`, tool `echo`, arguments `{"hello": "world"}`.

## Build, pack, install

```sh
vmapp pack vmapp/apps/computer-use -o deskhelper.vmapp
vmapp install deskhelper.vmapp
vmapp grant-host dev.vmapp.deskhelper --list          # what it requests and what is granted (nothing yet)
```

## Run it in the loader

Open the D9010 VmApp Launcher and choose *Install...* with the `.vmapp` (or *Run project folder...* on `apps/computer-use`).
The permission sheet has a **host access** part: each request is shown with its purpose, and the ones that request
control of your computer (`input`, `tool:*`, `mcp:*`) are marked. For each one choose a mode (*ask* is the default and
the right one here) and, for `tool:*` / `mcp:*`, tick which of your tools and servers this app may use.
The same can be done from the CLI:

```sh
vmapp grant-host dev.vmapp.deskhelper screen
vmapp grant-host dev.vmapp.deskhelper input
vmapp grant-host dev.vmapp.deskhelper 'tool:*' --tools screencapture,open-app
vmapp grant-host dev.vmapp.deskhelper 'mcp:*' --servers fakemcp
```

macOS also needs **Screen Recording** (for screen) and **Accessibility** (for input) granted to the D9010 VmApp Launcher in
System Settings > Privacy & Security. Without them the call fails with a message that says which one is missing.
The Inspector lists every host call, but never screenshot bytes and never typed text (only its length).

## Run it headless

Headless runs have no clicking user: a script plays the UI by calling the core's channels (`desk:look`,
`desk:click`, ...), and the "ask" questions are answered by `--allow-host` (yes) or its absence (no).
A headless run **with the real helper would really capture your screen and drive your mouse**, so the automated test
never does that: it replaces the native helper with a fake script and makes input a dry run
(`VMAPP_HOSTCTL=<fake>`, `VMAPP_HOSTCTL_DRYRUN=1`, honoured only by unpackaged dev and test builds):

```sh
SKIP_BUILD=1 vmapp/tests/apps/run-all.sh       # includes computer-use-granted / -declined / -revoked
```

[tests/apps/computer-use.mjs](../../tests/apps/computer-use.mjs) is the example script. Three runs prove: every
action works when granted (fake PNG arrives, dry-run input, tool output, MCP result), every action is denied cleanly
when you answer no, and when nothing is granted.

## Files

- `vmapp.json`: the manifest (`permissions.host`).
- `core/main.js`: the `host` calls, one `ipcMain.handle` per button, all through `attempt()`.
- `ui/`: the five cards; `app.js` builds the `blob:` URL, scales clicks back to points, and shows denials.
