# vmapp-hostctl

The native macOS helper behind D9010 VmApp's host capabilities (SPEC §8.2, GOVERNANCE §H). The loader (Electron) spawns
it and talks to it over stdin/stdout. **Apps never talk to it**: the loader checks the app's grant (INV-H2), logs the
use, shows the control badge (INV-H3), and only then forwards the op. This helper does no policy; it is the
mechanism.

- Source: `hostctl.m` (one Objective-C file, ARC, ~700 lines). No Rust, no Swift, no third-party code.
- Build: `host/hostctl/build.sh [out]` (clang via Xcode, min macOS 13.0, ad-hoc signed, no entitlements).
  `tools/build.sh` calls it and writes `out/vmapp-hostctl` (~110 KB, arm64; `HOSTCTL_UNIVERSAL=1` adds x86_64).
- Tests: `node tests/hostctl/run.mjs` (safe on a live desktop; see "Verified" below).
- Packaged layout the loader should expect: `Contents/Resources/vmapp/vmapp-hostctl` (the loader build copies it from
  `out/vmapp-hostctl`, next to `vmapp-vm`).

## Lifecycle

- Start it with `stdio: ['pipe', 'pipe', 'inherit' | 'pipe']`. It prints **nothing** on stdout except protocol lines
  (stdout is re-pointed at stderr after the helper takes a private copy). Diagnostics go to stderr.
- There is no "ready" line: send `{"op":"ping"}`.
- It exits (status 0) on **stdin EOF**, and when its **parent process exits** (kqueue `NOTE_EXIT`, the same
  technique as `vmapp-vm`), so a crashed loader cannot leave it running. If the parent is already gone at start-up it
  exits at once.
- Requests are handled one at a time, in order. A malformed request gets an error reply and never ends the process.
  Request lines are limited to 8 MiB.

## Protocol

One JSON object per line.

```
request  {"id":N,"op":"…", …}
reply    {"id":N,"ok":true,"result":…}
         {"id":N,"ok":false,"error":{"code":"…","message":"…"}}
event    {"event":"panic"}          unsolicited; only after panic-hotkey {enable:true}
```

`id` may be a number or string and is echoed; if the line is not a JSON object the reply carries `"id":null`.

Error codes: `bad-request` (bad or missing argument, not valid JSON), `unknown-op`, `permission` (a macOS grant is
missing), `not-found` (window/display), `unavailable`, `timeout`, `failed`, `internal`.

Coordinates everywhere (windows, displays, mouse, regions) are **global desktop points, origin top-left of the main
display**, y down. A second display to the left has negative `x`.

| op | args | result |
|---|---|---|
| `ping` | | `{pong:true}` |
| `status` | | `{screenRecording, accessibility, macos:"15.7"}`. Never prompts (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrustedWithOptions` without prompt). |
| `request-permissions` | `{screenRecording?:bool, accessibility?:bool}` | the new `status`. Triggers the system prompts (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions` prompt). The loader must call this **only on an explicit user click**. |
| `windows` | `{all?:bool}` | `[{windowId, app, pid, title, bounds:{x,y,w,h}, onScreen, layer}]`. Default: on-screen windows with `layer == 0`. `all:true`: every window in every layer, including off-screen. `title` is `""` without Screen Recording. |
| `displays` | | `[{display, bounds, scale, main, name, builtin}]` (`name` is the user-facing name, e.g. "Built-in Retina Display"; empty list while every display is asleep) |
| `capture` | `{target:"display"\|"window"\|"region", display?, windowId?, region?:{x,y,w,h}, maxWidth?, excludePids?:[pid…]}` | `{png: base64, width, height, display, bounds:{x,y,w,h}}` |
| `mouse` | `{action:"move"\|"down"\|"up"\|"click"\|"scroll", x, y, button?:"left"\|"right"\|"middle", clicks?:1-3, dx?, dy?, dryRun?}` | `{posted, events}` |
| `keys` | `{text}` or `{key, modifiers?:["cmd","shift","alt","ctrl"]}`, `dryRun?` | `{posted, events}` |
| `panic-hotkey` | `{enable:bool}` | `{enabled}` |

### capture

- Sizes are in **points** (a 4x4 region is a 4x4 PNG, a 1920-point display is 1920 px wide even on a Retina panel).
  `native:true` asks for pixel resolution instead. `maxWidth` (1 to 16384) scales down, preserving aspect, never up.
- `display`: target display (default main). `region` is in global coordinates; if `display` is also given, the region
  is relative to that display's top-left. A region is clipped to the display holding most of it.
- `window`: needs `windowId` (from `windows`); captures that window alone (no overlapping windows).
- Uses `SCScreenshotManager` (ScreenCaptureKit) on macOS 14+. On macOS 13, or with the diagnostic flag `legacy:true`,
  it uses `CGWindowListCreateImage` (looked up at run time because the macOS 15 SDK marks it obsolete).
- The cursor is not captured. Nothing is written to disk by the helper; the PNG only exists in the reply.
- Without Screen Recording: `error.code == "permission"`.
- The reply says what was really captured: `display` (the display used; for a window, the one holding most of it) and
  `bounds`, the captured area in global points (a region after clipping to its display, a window's own bounds). The loader
  turns them into the app's `target` (SPEC 8.2).

#### excludePids: the loader's own windows are never in a picture

`excludePids` (at most 64 integers from 1 to 2147483647; anything else is `bad-request`, checked before Screen Recording)
lists processes whose windows must not appear. The loader always passes its own pid, so its control badge, the virtual-input
overlay and the screenshot pickers stay out of the pictures an app receives (and out of the previews the picker shows).
- **ScreenCaptureKit path (macOS 14+, the normal one):** a display or region capture uses
  `SCContentFilter(display:excludingWindows:)` with every `SCWindow` whose `owningApplication.processID` is listed, whatever
  its level or sharing type. This is the exact path; it matters because macOS 15's ScreenCaptureKit no longer honours
  `NSWindowSharingNone`, which the overlay also sets (belt and braces).
- **Legacy path (macOS 13, or `legacy:true`), best effort:** the on-screen window list is built without the excluded
  processes and composited with `CGWindowListCreateImageFromArray` (both symbols looked up at run time). If that call is not
  there the plain call is used and the exclusion does not apply.
- **A window target** whose owner is excluded is `not-found`, however its id was learned (the loader's own windows cannot be
  captured one by one either).

Manual check (needs Screen Recording for the process that runs it; the automated suites use the fake helper, whose
`capture` models the same rules, and `tests/hostctl/run.mjs` checks the validation and, when Screen Recording is granted,
the window refusal): start the loader, run Desk Helper, start input control (the overlay and the red badge are on screen)
and take a screenshot: neither the ring, the caption nor the badge appears in the picture, while they are visible on the
screen itself.

### mouse

- `move` / `down` / `up` need `x`,`y`. `click` = move, then `clicks` down/up pairs with the click-state field set (so
  double clicks register). `scroll`: `x`,`y` optional (omitted = at the cursor); `dx`,`dy` are in pixels with the
  **DOM wheel convention** (positive `dy` scrolls down, positive `dx` scrolls right).
- A `move` while a button is held (after `down`) is posted as a drag.
- Posted with `CGEventPost(kCGHIDEventTap, …)`. Without Accessibility: `permission`.

### keys

- `text`: typed as Unicode (`CGEventKeyboardSetUnicodeString`), up to 10 000 characters, chunked so a character is
  never split; `\n` becomes Return and `\t` becomes Tab.
- `key`: `a`-`z`, `0`-`9`, punctuation (`- = [ ] \ ; ' , . / \``), `return`/`enter`, `tab`, `space`, `escape`/`esc`,
  `delete`/`backspace`, `forwarddelete`, `home`, `end`, `pageup`, `pagedown`, `left`/`right`/`up`/`down`, `f1`-`f12`.
  The map is US-ANSI virtual key codes. `modifiers` set the event flags (`cmd`, `shift`, `alt`, `ctrl`).
- Exactly one of `text` / `key` must be given.

### dryRun

With `dryRun:true`, `mouse` and `keys` validate the request and **build** every CGEvent exactly as they would for real
but do not post them (`posted:false`, `events:<count>`). They also skip the Accessibility check, so a dry run works
without the grant. This is what the tests use.

### panic-hotkey

`{enable:true}` registers **⌃⌥⌘.** (Control-Option-Command-period) with Carbon `RegisterEventHotKey`, which needs no
Accessibility. Pressing it emits `{"event":"panic"}` on stdout; the loader then stops every input session and tool
(INV-H3). Idempotent. `failed` if the combination is already registered by another process. The helper runs an
accessory-policy `NSApplication` loop on its main thread for this (no Dock icon, no windows).

## TCC (macOS privacy) model

- Screen Recording and Accessibility are granted in System Settings > Privacy & Security **to an app**, not to this
  binary. For a process spawned by another process, macOS attributes the request to the **responsible process**: the
  app at the top of the chain. When the loader (D9010VmAppLauncher.app) spawns the helper, the loader is the one that
  appears in the Screen Recording and Accessibility lists, and one grant covers the helper.
- Ad-hoc signing needs no entitlements and does not change this. The helper carries the identifier
  `com.vmapp.hostctl`; it does not request any permission on its own.
- Granting either permission is a **user action in System Settings**. `status` reports it, `request-permissions`
  only opens the system prompt. The helper never tries to work around TCC, and there is no code that edits the TCC
  database.
- macOS may need the loader restarted after Screen Recording is granted, and macOS 15 shows its periodic "allow
  <app> to continue recording your screen" prompt on the first ScreenCaptureKit use after a while.
- When developing, the responsible app is whatever runs the helper (Terminal, iTerm, VS Code, Claude Code). The tests
  report which grants that process has.

## Verified here vs needs the owner's grants

Verified (no grants needed, nothing touches the real desktop): build and ad-hoc signature; `ping`; `status` (without
prompting); `displays`; `windows` (titles are empty without Screen Recording); every `mouse` / `keys` path in
`dryRun` (events built, not posted); argument validation and error codes; malformed JSON and unknown ops (process
survives); stdout carries only protocol lines; EOF exit; parent `kill -9` exit within 3 s (with stdin held open, so
only the kqueue path can explain the exit); `panic-hotkey` register / unregister.

**Needs the process running the tests (later: the loader) to hold the grants**, and so is verified only when the tests
run in such a process:
- **Screen Recording:** a real 4x4 capture (`run.mjs` checks the PNG IHDR and CRC when granted; otherwise it checks
  for `permission`), window titles in `windows`, `maxWidth` scaling, the `legacy` path, window capture.
- **Accessibility:** posting real mouse and keyboard events (never exercised by the tests: they would drive the
  owner's desktop).
- **Panic hotkey firing:** needs a physical key press.
