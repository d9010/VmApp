# Host capabilities: screen, input, tools, MCP and the GPU

**For:** app developers and users. Normally a D9010 VmApp app can only reach the folders you granted. Host capabilities
are the exception: they let an app **see the screen, move the mouse, type, run programs you registered, use
MCP servers on your computer and run work on your Mac's GPU**. They exist for computer-use agents, automation and local
AI models. (The GPU works differently from the others: it is §9.)

- The exact rules: [SPEC §8.2](../SPEC.md) (and [§8.6](../SPEC.md) for the GPU) and [GOVERNANCE §H](../GOVERNANCE.md).
- A working sample: [apps/computer-use](../apps/computer-use/README.md) ("Desk Helper").
- The general app guide: [BUILDING-APPS.md](BUILDING-APPS.md).

---

## 1. What each capability lets an app do

| Capability | The app can… | Risk |
|---|---|---|
| `screen` | list your open windows (app, title, position) and take screenshots of **what you choose to share**: a display, a window or a region | it sees everything that is visible in what you pick |
| `input` | move the pointer, click, scroll, and type or press keys in whatever app is in front | it can do anything you can do with a mouse and keyboard |
| `tool:<id>` | run **one program you registered**, with arguments that match patterns you wrote | as strong as the program; a `shell` tool is a full shell |
| `mcp:<id>` | call the tools of **one MCP server you registered** | as strong as that server's tools |
| `tool:*`, `mcp:*` | "you pick which tools or servers" | the app can use only the ones you tick |
| `gpu` | run llama.cpp's heavy maths on **your Mac's GPU**, through a sandboxed helper the loader starts for it (§9) | the helper processes the app's requests, and the app can use as much GPU as macOS allows until you stop it |

An app never names a program or a command. It names a capability, and you map it onto your own catalog.

## 2. The trust model, honestly

A normal D9010 VmApp app is safe to try because the VM cannot reach your files or network. **Host capabilities
deliberately make a hole in that.**

- **Granting `input` or a shell tool means the app can act as you.** It can click "Send", approve a payment or
  delete things, in any app, with your accounts. The VM no longer protects you from what you granted.
- **Granting `screen` means the app can read whatever you share**, including other apps' windows. With *ask* you pick what
  each screenshot contains; with *session* (or after *Allow while the app runs*) the app takes pictures of what it asks for,
  anywhere on the screen, until it stops.
- The platform's job is then to keep this **explicit, visible and revocable**, not to make it safe:
  nothing is on by default, `ask` is the default mode, the badge is always on screen while an app controls your
  computer, you can stop it at once, every use is in the Inspector, and a package that asks for control of your
  computer is labelled so ("requests control of your computer") in the registry and the install review.
- What the platform keeps even so (GOVERNANCE §H): apps can't define tools or servers; the results go only to the
  app that asked; the VM has no network device, so a screenshot can only leave through a host you granted to that app
  under `permissions.network` (SPEC §8.3: **screen + network is the exfiltration pair**, and the loader's
  `riskSummary` warns about it) or through a tool or MCP server you granted, if that one has network access.
- **Only grant these to apps you would let sit at your desk.** An app from a stranger should get nothing, or `screen`
  at most, in `ask` mode.

## 3. For users: granting and staying in control

**Granting.** The permission sheet (at install, and again from the app's *Permissions* in the loader) has a host
access part. Each request shows the app's stated reason, and the risky ones are marked "requests control of your
computer". For each you choose a mode:

| Mode | Meaning |
|---|---|
| **ask** (default) | a question for each use, or for each input session; you can answer *Deny*, *Allow once* or *Allow while the app runs*. For a screenshot the question is the picker below |
| **session** | no more questions until the app stops; then it goes back to *ask* |
| **always** | never asks. **Not available for `input` or shell tools** (they always ask) |

For `tool:*` and `mcp:*` you also tick which tools or servers this app may use. Revoking a grant applies at once; a
running input session ends. The CLI does the same:

```sh
vmapp grant-host <app-id> --list                              # what it requests, what you granted
vmapp grant-host <app-id> screen --mode ask
vmapp grant-host <app-id> input
vmapp grant-host <app-id> 'tool:*' --tools screencapture      # only that tool
vmapp grant-host <app-id> 'mcp:*' --servers my-server
vmapp grant-host <app-id> input --revoke
```

**You choose what a screenshot shows.** When an app on *ask* wants a screenshot, the loader opens a window on the app's
window (it is the loader's, never the app's) with:
- each **display**, with its name, its resolution and a small live preview that only you and the loader see;
- each open **window** (the app and its title; titles need Screen Recording for the D9010 VmApp Launcher);
- **Select a region…**, which dims the screen you pick and lets you drag a rectangle (Esc cancels).

The app's own idea ("the window X", "display 2") is only a suggestion and comes preselected, so one click confirms it; **what you pick wins**,
and the app receives only that. Then **Deny** (the default), **Allow once** or **Allow while the app runs**. The last one
remembers only that screenshots are allowed, **not what you picked**: later screenshots of that run need no question and show
what the app asks for then (or your main display if that no longer exists). If you want to choose each time, use **Allow once**.
The D9010 VmApp Launcher's own windows (the red badge, the overlay, these questions) are never in a screenshot an app gets, and an
app cannot see them in its window list.

**While it controls your computer.** A loader-owned, always-on-top badge shows "<App> is controlling your computer
— Stop" while an input session or a shell tool is active. **⌃⌥⌘.** (Control-Option-Command-period) stops every input
session, tool and MCP server of every app at once. An input session also ends by itself after 10 minutes.

**The overlay shows what the app does.** While an app controls the mouse and keyboard, a coloured ring follows its virtual pointer
on whichever screen it is on, a ripple flashes on each click, and a caption at the bottom of the screen shows the keys it presses
(`⌘S`, `↩`, `←`). **Typed text is hidden by default:** the caption only says `typing… (12 characters)`, so a password an app
types is not readable on the screen. (Characters typed within about two seconds are counted together, and a single plain key such
as `p` counts as typed text too: an app cannot get round the mask one key at a time. A key with ⌘, ⌃ or ⌥ is a shortcut and is
shown.) If you want to see the start of the text instead (`Hello, wor…`, cut at 28 characters), turn on **Show typed text in the
overlay** in the **Host Capabilities…** window; it is off by default, lives in the loader (never an app's choice) and turning it
off masks the text again at once. The overlay is click-through (it cannot block or catch a click of yours), never takes the keyboard
focus, and is left out of screenshots. It is only on screen while an input session is active. Typed text never reaches the
Inspector, with or without the setting.

**macOS permissions.** Besides your grant, macOS must allow the **D9010 VmApp Launcher** in System Settings > Privacy &
Security: **Screen Recording** for `screen` and **Accessibility** for `input`. The loader shows when one is missing,
and an app can never trigger those prompts silently.

**Looking afterwards.** The Inspector shows every host use (allowed or not): which capability, what exactly (the
command line, the MCP method, "typed 12 characters"), and how long it took. It never records screenshots, and
never what was typed.

**Registering tools and servers.** Only you can (the loader's settings, or the CLI on this Mac): see §5 and §6.

## 4. For developers: requesting and using capabilities

### 4.1 In the manifest

```json
"permissions": {
  "dialogs": false,
  "host": [
    { "cap": "screen", "purpose": "Reads the screen to help you fill forms" },
    { "cap": "input",  "purpose": "Clicks and types for you when you ask" },
    { "cap": "tool:*", "purpose": "Runs the tools you allow, like screencapture" },
    { "cap": "mcp:*",  "purpose": "Uses apps that offer MCP tools" }
  ]
}
```

- At most 8 entries. `cap` is `screen`, `input`, `gpu`, `tool:<id>`, `tool:*`, `mcp:<id>` or `mcp:*` (ids match
  `^[a-z0-9][a-z0-9-]{0,40}$`). `purpose` is up to 200 characters and is shown to the user: say what *you* will do with it.
- Ask for the least. `tool:*` means "the user picks"; `tool:screencapture` asks for one tool by id, and only works
  if the user has registered a tool with that id.
- Adding a host capability in an update **always** stops and asks the user again.

### 4.2 In the core (`node22` runtime)

Everything is on the SDK's `host` object. Each call is denied unless the manifest asks **and** the user granted it.

```js
const { host } = require('vmapp');
```

**Screen.** Coordinates are global desktop points, origin top left of the main display (a display to its left has negative `x`).

```js
const windows = await host.screen.windows();
// [{windowId, app, title, bounds:{x,y,w,h}}]   (never the loader's own windows)

const shot = await host.screen.capture({ target: 'display', maxWidth: 1024 });
// {png: Buffer, width, height, target}; width and height are of the (scaled) image, in points
//   target 'window':  host.screen.capture({target:'window', windowId: windows[0].windowId})
//   target 'region':  host.screen.capture({target:'region', region:{x:0, y:0, w:400, h:300}})   // global points
//   optional: display (a display id, for target 'display'), maxWidth (1..16384; scales down, keeps the aspect ratio, never up)
```

**What you pass is only a suggestion; the user picks.** With `ask` the loader shows the picker described in §3 and your parameters
come preselected. Whatever the user chose is what you get, and **`shot.target` says what that was**, so never assume it is the
display you asked for:

```js
shot.target
// { kind: 'display' | 'window' | 'region',
//   display?: 2,                          // the display id used
//   windowId?: 8,                         // for a window
//   region?: {x, y, w, h},                // for a region: global points, clipped to its display
//   bounds: {x, y, w, h},                 // the captured area in GLOBAL points (when the loader says)
//   by: 'user' | 'app' | 'default' }      // user: picked in the question; app: your suggestion (the permission was already given
//                                         // for this run); default: your suggestion no longer exists, so the main display
```

- **Mapping a click.** A position in the picture is a position in `shot.target.bounds`: with `fx = px / displayedWidth` and
  `fy = py / displayedHeight`, `x = bounds.x + fx * bounds.w` and `y = bounds.y + fy * bounds.h`. That is right for a display, a
  window or a region, scaled by `maxWidth` or not. (Without `bounds`, an older loader: assume the main display, origin 0, 0.)
- **Keep the user's choice.** After the first screenshot, suggest what the user picked: `{target: t.kind, display: t.display}`,
  `{target:'window', windowId: t.windowId}` or `{target:'region', region: t.region}`. In `ask` mode it comes preselected, in `session`
  mode (no question) it is what gets captured, and if it is gone you get the main display and `by: 'default'`.
- **A denied screenshot is normal** (§4.3). "Allow while the app runs" lets you take more screenshots without asking, but
  of your suggestion, not of a new choice by the user: if you need them to choose again, say so in your UI.

Send `shot.png.toString('base64')` to your UI and show it with a `blob:` URL (the UI's CSP allows `img-src blob:`
and `data:`). Ask for a smaller `maxWidth` or a region when you can: pictures travel over the bridge (16 MiB limit,
the host retries at smaller sizes if a capture is too big). **A screenshot is scaled by `maxWidth`, but input
coordinates are always in real points**: use `target.bounds` as above.

**Input.** Start a session, use it, stop it. Starting is what shows the badge (and may ask the user).

```js
const s = await host.input.start('Fill in the form you opened');   // the reason is shown to the user (<= 200 chars)
try {
  await s.mouse({ action: 'move', x: 640, y: 360 });
  await s.mouse({ action: 'click', x: 640, y: 360 });                       // button 'left', clicks 1 by default
  await s.mouse({ action: 'click', x: 640, y: 360, button: 'right' });
  await s.mouse({ action: 'scroll', x: 640, y: 360, dy: 300 });             // DOM convention: positive dy scrolls down
  await s.keys({ text: 'Hello, world\n' });                                 // typed as text; \n = Return, \t = Tab
  await s.keys({ key: 'a', modifiers: ['cmd'] });                           // key names: a-z, 0-9, return, tab, escape, f1..f12 ...
} finally {
  await s.stop();                                                           // always stop: it removes the badge
}
```

- `mouse` actions: `move`, `down`, `up`, `click`, `scroll`. A `move` while a button is held is a drag; buttons still
  held are released when the session ends.
- `keys` takes `{text}` (up to 10 000 characters) **or** `{key, modifiers}` (`cmd`, `shift`, `alt`, `ctrl`).
- **A session ends** after 10 minutes, when you call `stop()`, when the user presses Stop or the panic keys, or when
  the grant is removed. After that, calls fail with "no such input session"; call `host.input.start` again to continue
  (the user may be asked again). A new `start` replaces a running session.

**Tools.**

```js
const tools = await host.tool.list();
// [{id, name, kind, description?, variadic?, args:[{pattern, optional?, mapPath?}]}]  (never the program's path)

const r = await host.tool.run('screencapture', ['-x', '/tmp/shot.png']);
// {exitCode, stdout, stderr, truncated, timedOut, signal}
await host.tool.run('wc', ['-c'], { stdin: 'some text' });                  // stdin up to 1 MiB
```

**MCP.**

```js
const servers = await host.mcp.list();          // [{id, name, tools:[{name, description, inputSchema}], error?}]
const tools   = await host.mcp.call('my-server', 'tools/list', {});
const result  = await host.mcp.call('my-server', 'tools/call', { name: 'echo', arguments: { text: 'hi' } });
```

### 4.3 When you are denied

Treat denial as a normal state, never a crash. A denied or declined call rejects with an `Error` whose message
starts with **`permission denied:`**, for example `permission denied: "input" is not granted by the user` or
`permission denied: declined by the user`.

```js
async function attempt(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) {
    return { ok: false, denied: /^permission denied/.test(e.message), error: e.message };
  }
}
const r = await attempt(() => host.screen.capture({ maxWidth: 1024 }));
if (!r.ok && r.denied) { /* tell the user what to grant and why; offer to continue without it */ }
```

Other errors you should expect: `macOS permission missing: ...` (the Mac's own Screen Recording or Accessibility is
not allowed yet), `no such input session ...` (it ended; start again), `tool "x": argument 1: ...` (an argument
doesn't match the user's patterns), `tool "x" was stopped (...)`, and `host.mcp.list()` entries with an `error`
(that one server was declined or failed to start; the list still comes back). Sensible habits:
- call `host.tool.list()` / `host.mcp.list()` first and offer only what is there;
- put each use behind a user action, never at startup;
- say before you act ("I will click 'Save' at (640, 360)"), and `stop()` the session as soon as you are done.

## 5. Tools

**Users register them**, with the CLI or the loader's settings. The registration is the safety:

```sh
vmapp tool add open-app --name "Open an app" --path /usr/bin/open \
  --arg '^-a$' --arg '^(Calculator|TextEdit|Notes)$'
vmapp tool list
vmapp tool remove open-app
```

- `--path` is an absolute path. Each `--arg <regex>` is the pattern for the argument at that position. It must start
  with `^` and end with `$`, and is applied to the **whole** argument. `--optional-arg i` marks an argument as optional,
  `--variadic` lets the last pattern repeat. Defaults: 30 s timeout, 1 MiB of output (`--timeout`, `--max-output`).
- **No shell is involved.** The host starts the program with an argument list, in a clean environment (`PATH`
  and `HOME` only), kills it and its children at the timeout. `;`, `|`, `$(...)` or `*` in an argument are plain
  text. The safest patterns are narrow ones: an exact set of words, not `.*`.
- **`mapPath`** (`--map-path-arg i`) is for arguments that are file paths. The app passes a VM path under a
  share the user granted this run (`/host/f-<name>`, `/host/pick-N`, `/host/save-N`) and the host maps it to the real
  file. `..`, other shares and symlinks leading out are refused, so the tool reaches only what the user already
  gave the app. Example, a screenshot into a folder the user granted:

  ```sh
  vmapp tool add screencapture-save --name "Screenshot into a folder" --path /usr/sbin/screencapture \
    --arg '^-x$' --arg '^/host/(save|pick)-\d+/[\w .-]+\.png$' --map-path-arg 1
  ```
  ```js
  // needs "dialogs": true in the manifest
  const file = await dialog.showSaveDialog({ defaultPath: 'shot.png' });   // -> /host/save-0/shot.png
  await host.tool.run('screencapture-save', ['-x', file.filePath]);
  ```
- **Shell tools** (`--kind shell`, for example `/bin/sh` with `-c <anything>`) are the one unconstrained kind. They are
  marked with a red warning, always ask, never "always", and show the badge while running. Register one only
  for an app you trust like yourself.
- One caveat on `mapPath`: the host checks the path and then the program opens it, so a file replaced in
  between (a symlink swapped by something else on your Mac) could point elsewhere. This is a small time-of-check
  to time-of-use window; granting only folders you control, and keeping tools narrow, is the mitigation.

## 6. MCP servers

[MCP](https://modelcontextprotocol.io) servers give an AI agent tools. Servers run on the host, so an agent
inside the VM can use them only through the broker.

- **Users register servers:** `vmapp mcp add <id> --name N [--env NAME=VALUE] -- /abs/path/to/server args...`
  (stdio servers; the first word must be an absolute path). `mcp list` and `mcp remove <id>` work as for tools.
- **The host runs them.** On first use it starts one process per app per server, sends `initialize` and
  `notifications/initialized` itself, and stops the server when the app stops (or on panic).
- **What the agent may call:** only `tools/list`, `tools/call`, `resources/list`, `resources/read`,
  `prompts/list` and `prompts/get` (the **method allowlist**). Any other method is refused.
- **Agents in the VM** (any language, not only Node) use the same bridge ops as the SDK: `host.mcp.list` and
  `host.mcp.call` ([SPEC §8.2](../SPEC.md) has the exact messages). An agent framework asks for `tools/list`, shows the
  tools to its model and sends the model's choice as `tools/call`.

## 7. Building a computer-use agent

The loop is: **capture → decide → act → verify**.

1. **Capture.** `host.screen.capture({maxWidth: 1024})` (and `host.screen.windows()` for text hints). The user picks what is
   shared; the result's `target` tells your agent what the picture covers.
2. **Decide.** Your agent's model looks at the picture and the goal and names the next action ("click at (412, 230)").
3. **Act.** `host.input.start(reason)` once, then `mouse`/`keys` calls; or a registered tool or MCP call when one fits
   better (a tool is more reliable than clicking). Convert coordinates from the picture to global points with
   `target.bounds` (§4.2): that is also right when the user shared a window or another display.
4. **Verify.** Capture again, check that the screen changed as expected, then continue or stop. Stop the session when
   the task ends, and give the user a way to stop you in your own UI too.

**The model needs a place to run, and format 1 gives the VM no network.** Say this plainly to yourself and to your
users: a hosted LLM (Claude, GPT, ...) **cannot be called from inside the VM today**. A computer-use agent therefore
needs either

- **a local model** that fits in the VM's memory (up to 4 GiB) or, better, **an MCP server on the host** that wraps the
  model, which the agent calls with `host.mcp.call`; or
- **the future network permission** (planned, not in format 1), which would let the core call an API with the
  user's explicit consent and a visible indicator.

Until then, the model may live in an MCP server or a tool that you register (it is then the *tool's* network
access, outside the VM, and you chose it). Desk Helper does not include a model: it shows the plumbing
(capture, act, tools, MCP), and an agent would plug its decision step into that.

Design for the user's safety: act in small steps, state the next action in your UI before you do it, prefer
`ask` mode so the user sees each session, never type secrets, and stop when anything unexpected is on screen.

## 8. Limits

- **macOS only.** The screen and input providers are macOS (`vmapp-hostctl`). The catalog format is
  OS-neutral; Windows and Linux providers are not built yet.
- **The overlay is for the user, not for the agent.** It shows where the virtual pointer is and how much is typed (the text
  itself only if the user turned that on), but it is left out of screenshots on purpose, so your agent never sees it in a picture
  and cannot use it to read its own position.
- **You may not get the display you asked for.** The user picks what a screenshot shows (§3); read `shot.target`.
- **No generic AppleScript.** Automating other apps goes through a tool definition that you write.
- **Points, not pixels.** Coordinates are global desktop points (origin: top left of the main display; a second display
  to the left has negative `x`). Retina scaling is already applied, a screenshot's `width`/`height` are in points
  before `maxWidth` scales it down.
- **Size and time:** screenshots must fit the bridge (the host reduces them if needed); input sessions end after
  10 minutes; a tool runs at most its `timeoutMs` (30 s by default), at most 4 tools at a time per app.
- **Permissions can be missing even when granted.** macOS's own Screen Recording and Accessibility are separate,
  and macOS may ask you to confirm Screen Recording again from time to time.
- **TOCTOU on `mapPath`:** see §5.
- **Updates:** a version that adds a host capability always stops and asks again (SPEC §8.1).

## 9. The GPU: `gpu` (llama.cpp RPC remoting)

An app that runs a language model in its VM (llama.cpp, or anything that speaks llama.cpp's RPC protocol) can have the heavy
maths run on your Mac's GPU. There is no Metal inside Linux, so the platform does not pretend to offer one: it **forwards llama.cpp's
own RPC protocol** to a Metal-backed `rpc-server` on your Mac. This is "phase B" of [VISION §4](VISION.md); the rules are
[SPEC §8.6](../SPEC.md) and [GOVERNANCE INV-H7](../GOVERNANCE.md).

### 9.1 For users

- In the permission sheet, under **Control of your computer**, the entry reads: *"Lets this app run work on your Mac's GPU (Metal)
  through a sandboxed helper. The helper processes the app's requests, so only allow apps you trust with your GPU."* The choices are
  **Don't allow** (the default) and **Allow while the app runs**. There is no "ask every time": a model sends thousands of requests a
  second, so there is nothing to ask about. The choice stays until you change it, also from the card's **GPU…** button, which works
  while the app runs (taking the GPU away stops the helper at once). From the terminal:

  ```sh
  vmapp grant-host <app-id> gpu --mode session      # allow while the app runs (the only mode)
  vmapp grant-host <app-id> gpu --revoke            # a running app loses it within about a second
  ```
- **What starts.** When you launch an app you allowed, the loader starts one helper for that run. The helper is llama.cpp's RPC server,
  inside a macOS sandbox that lets it do three things: use the GPU, listen on one loopback port the loader chose, and keep the compiled
  shaders in your Metal cache. It cannot read your files, write anywhere else, start programs or connect out. It stops when the app
  stops, when you take the grant away, on the panic shortcut (⌃⌥⌘.) and when you quit the loader.
- **What you see.** An amber chip **Can use your GPU** on the card; a **GPU** pill in the menu-bar monitor that pulses while the app
  is using it; and in the Bridge Inspector a **GPU** filter with a row for the helper starting and stopping and for every connection,
  with the bytes up and down (never the contents).
- **What it can't do.** An app with the GPU can't reach your files, the screen or the network through it; the helper takes only
  llama.cpp's RPC messages from that one app's VM. **What it can do** is use as much GPU and memory as macOS gives it until it is
  stopped (a model is big), and, if the helper had a bug, try to exploit it: llama.cpp's own documentation calls the RPC server
  "proof-of-concept … fragile and insecure". The sandbox is the second wall. Only allow apps you trust with your GPU.
- **The first start of a new build of the helper is slow** (about 10 to 15 seconds while macOS compiles its shaders); later starts
  take a fraction of a second. The app's first connection waits for it.

### 9.2 For developers

1. Ask in the manifest: `{ "cap": "gpu", "purpose": "Runs the language model on the GPU" }` (SPEC §2.2). Say what *you* use it for.
2. In the core, check for it and fall back to the CPU:

   ```js
   const rpc = process.env.VMAPP_GPU_RPC;        // "127.0.0.1:50052" when the user allowed the GPU, otherwise unset
   const args = ['-m', model, '--host', '127.0.0.1', '--port', '8080', ...(rpc ? ['--rpc', rpc, '-ngl', '99'] : [])];
   spawn('llama-server', args);                  // your llama.cpp build (-DGGML_RPC=ON), shipped in the app's core
   ```
   `llama-server`, `llama-cli` and `llama-bench` take `--rpc HOST:PORT`; the log shows `RPC0[127.0.0.1:50052] model buffer size`
   when layers went to the GPU.
3. **Build llama.cpp from the commit the platform's server is built from**, `gpu/pins.env` (`LLAMA_CPP_TAG`, `LLAMA_CPP_COMMIT`,
   `RPC_PROTO_VERSION`). The RPC protocol has a version, and the server refuses a client with another major version; keep your client
   on the same commit, and update it when the pin moves (`BUILD-INFO.txt` next to the server records the version it speaks). The client needs
   `-DGGML_RPC=ON` and no GPU backend: in the VM the GPU backend is the RPC one.
4. The connection to `127.0.0.1:50052` is plain TCP inside the VM (you may open several; at most 8 at once). If the user revokes
   the GPU while you run, your connections close and new ones are refused; handle that like a dropped server.
5. **Test with a real VM** (`tests/gpu/vm-rpc.test.js` is an example of the protocol by hand) and without the grant: the app must
   work, slower, when `VMAPP_GPU_RPC` is not set.

### 9.3 What it does today (measured)

On an Apple M4 Max, with llama.cpp `b11299` and SmolLM2-360M-Instruct Q8_0 (369 MiB), a client on the same Mac against the sandboxed
Metal server over loopback (`tests/gpu/run.sh`, five runs): prompt processing (512 tokens) ≈ 10 800 to 14 400 tokens/s, generation (128
tokens) ≈ 270 to 340 tokens/s; a 47-token `llama-completion` run generates ≈ 160 to 365 tokens/s. From inside a VM through the tunnel,
one RPC round trip takes ≈ 70 to 105 µs and the tunnel moves 64 MiB each way in about a fifth of a second (`tests/e2e.sh` scenario 12,
`tests/gpu/vm-rpc.test.js`). A llama.cpp
generation step is a few round trips, so for models that run at tens to hundreds of tokens per second the tunnel is a small part of
the cost; the model's weights cross it once, at load.

### 9.4 Limits

- macOS on Apple silicon only. Windows needs a different route (Hyper-V GPU paravirtualisation, [PLATFORMS.md](PLATFORMS.md)).
- Only llama.cpp's RPC protocol. Other frameworks (PyTorch, Vulkan compute) need the VM to offer a GPU API; that is VISION §4 phase A.
- One GPU (`MTL0`), no quota: the loader does not limit the GPU memory or the time an allowed app uses.
- Any program on this Mac can connect to the helper's loopback port while it runs (the port is random and per app run; llama.cpp's
  RPC server has no authentication and no Unix-socket mode). SECURITY.md lists it.

## 10. The Vulkan GPU: `gpu` with `"api": "vulkan"` (EXPERIMENTAL)

> **Experimental.** This is "phase A" of [VISION §4](VISION.md): a real Vulkan driver inside the app's VM, so unmodified Vulkan programs
> (llama.cpp's Vulkan backend, compute tools, your own shaders) use the Mac's GPU. It works and is fast (92 to 115 % of native on llama.cpp
> generation), and it is **not** a production driver: see the limits below and [gpu/venus-spike/REPORT.md](../gpu/venus-spike/REPORT.md). The rules
> are [SPEC §8.7](../SPEC.md) and [GOVERNANCE INV-H8](../GOVERNANCE.md). The shipping GPU route stays §9.

### 10.1 For users

Three things must all be true; otherwise the app starts normally, without a Vulkan GPU, and its log says which was missing:

1. the app asks for it (install review: **"EXPERIMENTAL: Use your Mac's GPU through Vulkan, inside the app's virtual machine"**);
2. you allowed it for that app (permission sheet: **Don't allow** by default, or **Allow while the app runs**; from the terminal
   `vmapp grant-host <app-id> gpu --mode session`);
3. **Host Capabilities -> Experimental GPU (Vulkan)** is on (off by default; `vmapp run <id> --headless --experimental-gpu` for the CLI).

What changes for an app on this backend: it runs on a different, less proven virtual machine implementation (libkrun instead of Apple's
Virtualization framework). Everything else (its files, windows, network permission, other capabilities) works as before, with two
differences: the app **cannot be given folders while it runs** (open and save dialogs that share a folder or file are refused; the folders you chose at
launch work), and it cannot draw into its window with the GPU (compute and offscreen rendering only). The part of the stack that talks to the GPU
runs in its own process in a macOS sandbox with no network and no access to your files except the app's own; a watchdog stops an app whose GPU stops answering
(the card says so). An allowed app can use as much GPU and memory as macOS gives it. Only allow apps you trust.

### 10.2 For developers

1. Manifest: `"runtime": "node22-gpu"` and `{ "cap": "gpu", "api": "vulkan", "purpose": "…" }` in `permissions.host` (one `gpu` entry per app).
   The `node22-gpu` runtime is `node22` on Debian trixie with Vulkan's loader and Mesa's Venus driver; a Vulkan program finds the GPU with no
   environment variable (`vkEnumeratePhysicalDevices` shows `Virtio-GPU Venus (Apple …)`). Without the grant (or with the switch off) there is simply no
   Vulkan device: fall back to the CPU.
2. Vulkan **1.3 at most**, the profile `vmapp-gpu-0.1` ([SPEC §8.7](../SPEC.md)): 88 extensions, no geometry shaders or float64 (Apple GPUs have none),
   no `KHR_portability_subset`, no timeline-semaphore guarantees (they crash or hang the VMM in the conformance tests), no swapchain. Ship shaders
   and a llama.cpp (or other) build compiled for it: the test core in `tests/gpu-vulkan/core` builds `llama-bench` with `-DGGML_VULKAN=ON` and `vkpeak`.
3. Memory: the guest sees host GPU memory through a window (`--gpu-window`, 8 GiB by default; the loader passes none). Allocations are
   rounded to the Mac's 16 KiB pages by the guest kernel; use the usual `vkAllocateMemory` and map what you need.
4. Test it with a real VM: `bash tests/gpu-vulkan/run.sh` is an example (vulkaninfo, a dispatch, vkpeak, llama-bench as uid 1000 in the runtime).

### 10.3 What it does today (measured)

Apple M4 Max, macOS 15.7, 4 vCPUs, the VMM in its sandbox, `tests/gpu-vulkan/run.sh`: vkpeak fp32 ≈ 15.6 TFLOPS (native MoltenVK: 15.8), device-to-device copy ≈ 186 GB/s,
host-to-device ≈ 57 GB/s; an offscreen 512×512 draw with readback ≈ 2.7 ms per round trip. llama.cpp `llama-bench` (Q4_K_M, all layers on the GPU),
prompt / generation tokens per second: Qwen2.5-0.5B 9 100 to 9 700 / 360 to 370, 1.5B 3 265 / 222, 3B 1 560 / 134 (the spike's table in
[REPORT §3](../gpu/venus-spike/REPORT.md) has the 8B and the native comparison: generation at 92 to 97 % of native Metal). `run.sh` records its run in
`$VMAPP_WORK/gpu-vulkan/results.txt`. A Mac that is short of memory or shares its GPU with other work measures far less.

### 10.4 Limits

- Experimental: crashes of the VMM are possible (timeline semaphores, REPORT B3); the loader reports them (`vmm-crashed`) and ends only that app.
- No runtime folder grants; no windowed presentation; Vulkan 1.3 profile; no conformance gate yet.
- The Venus decoder and the macOS sharing path are not audited or fuzzed. The sandbox is the wall.
- Not limited: GPU memory and time. The watchdog only fires when the GPU stops *answering* for 30 s, not when a dispatch is merely long.
- The watchdog's probe runs with the app's identity inside the VM, so a malicious app can silence it: it is robustness against accidents, not a defence.
- macOS 15 on Apple silicon only (MoltenVK); the KosmicKrisp route needs macOS 26 (REPORT §7).
