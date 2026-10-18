# The D9010 VmApp bridge protocol, explained

**For:** people who want to know what happens between an app's UI and its core: to write an SDK for a new
language, optimise the bridge, extend it, or debug at the wire level.

**You don't need this to build apps.** With the Node SDK, the bridge looks exactly like Electron's IPC
(`ipcMain.handle` ↔ `window.vmapp.invoke`), and [BUILDING-APPS.md](BUILDING-APPS.md) is all you need. The normative
definition is [SPEC §6](../SPEC.md). This document explains it, shows real traffic, and says what is fixed and what
is extensible.

---

## 1. Is it Electron's IPC?

No. It's D9010 VmApp's own small protocol, deliberately designed so the Node SDK can present an Electron-shaped API on top
of it. Developers get Electron's familiar model, but the wire format is:
- **Language-neutral:** JSON lines, implementable from any language with no dependencies.
- **Explicit:** every message has a type (`t`), so the loader can route, check permissions and show the traffic in
  the Inspector.
- **Isolated:** it never carries code, only data.

## 2. The path of a message

```
App UI (renderer)          Loader (host)                                 VM                      App core
window.vmapp.invoke ──► Electron IPC ──► AppSession ──► Unix socket ──► vsock 1024 ──► init ──► $VMAPP_SOCKET
                       (loader's preload)  (permission    (vmapp-vm      (hypervisor)   (byte    (core's socket)
                                            checks,        bridge)                       forward)
                                            inspector)
```

- **The UI's side:** the loader's preload turns `invoke`, `send` and `on` into Electron IPC to the loader's main
  process. The UI never sees the wire format.
- **The routing:** `AppSession` finds the app by the sender window (never trusting the renderer), wraps the call in
  a protocol message, and writes it to the bridge socket.
- **The VM's side:** `vmapp-init` forwards the bytes to the core's own Unix socket. The core speaks the protocol
  directly, or through an SDK.

## 3. Wire format

- One persistent connection per running app, opened by the host after the VM is ready.
- **Framing:** UTF-8 JSON objects, one per line (`\n`). Maximum 16 MiB per line.
- **Type:** every object has `"t"`. Unknown types are logged and ignored, which is how new message types can be
  added compatibly.
- **Ids:** request ids are integers unique per sender, and window ids are integers assigned by the host.

### 3.1 A real session, as it appears on the wire

```jsonc
// host → core: start
{"t":"init","app":{"id":"dev.vmapp.notes","name":"Notes","version":"1.0.0"},
 "platform":{"os":"linux","arch":"arm64"},"folders":{"notes":"/host/f-notes","export":null},"data":"/data"}
// core → host
{"t":"ready"}
{"t":"request","id":1,"op":"window.create","params":{"entry":"index.html","width":980,"height":660,"title":"Notes","devTools":false}}
// host → core
{"t":"reply","id":1,"result":{"win":1}}

// the UI calls window.vmapp.invoke('notes:list')
{"t":"invoke","id":7,"win":1,"channel":"notes:list","args":[]}               // host → core
{"t":"result","id":7,"result":[{"name":"alpha.md","size":120}]}              // core → host

// the core pushes to the UI: win.webContents.send('notes:changed', …)
{"t":"emit","win":1,"channel":"notes:changed","args":[["alpha.md"]]}         // core → host

// the core asks for a native dialog
{"t":"request","id":2,"op":"dialog.open","params":{"directory":false,"multiple":false}}
{"t":"reply","id":2,"result":{"canceled":false,"paths":["/host/pick-0/ideas.txt"]}}

// the user closes the window
{"t":"window","win":1,"event":"closed","data":{}}
{"t":"request","id":3,"op":"app.quit","params":{}}
```

The loader's **Inspector** shows this traffic live, with timing, for every running app. Its preview of a message is the first 200
characters of the JSON, with values that look like secrets (an `apiKey` field, an `sk-…` key, the payload of an `api-keys:set`
channel) shown as `"[hidden]"` (SPEC §6).

## 4. What is fixed and what is extensible

| Layer | Who defines it | Extensible? |
|---|---|---|
| **Your channels**: channel names and payloads of `invoke`, `send` and `emit` | **you, the app** | **Completely, with no platform change.** Name channels as you like (`notes:list`, `rpc`, `v2/query`), and carry any JSON. You can build your own RPC, streaming, pub/sub or versioning scheme on top. |
| **Message types** (`t`): `init`, `invoke`, `send`, `window`, `reply`, `before-quit`, `ready`, `result`, `emit`, `request`, `log` | the spec | Adding types is backward-compatible (unknown types are ignored), but needs a spec change. |
| **Request ops** (`window.*`, `dialog.*`, `shell.openExternal`, `app.quit`) | the spec | Only through the spec process. Every op is a capability the host grants, so each one needs a permission model and a denied-path test ([../GOVERNANCE.md](../GOVERNANCE.md) INV-C2, §4). |
| **Framing** (JSON lines over a stream) | the spec | Changing it is a format change. |

So app developers can extend the protocol freely *inside* their channels, and only the platform-facing surface is
governed.

## 5. Performance (measured)

Measured on an Apple M4 Max (macOS 15.7.7), from `hostlib` to the Node SDK inside the VM and back, as the median of 4 runs
of `tools/bench bridge` (each run is 5 rounds after a warm-up; October 2026, load average 3 to 10 on 16 cores). The loader
adds one Electron IPC hop on top, typically a fraction of a millisecond.

| Measurement | Result |
|---|---|
| Sequential small `invoke` round trip | median **0.049 ms** (0.048 to 0.066 ms between runs), p95 0.064 ms, p99 0.11 ms |
| 1,000 concurrent small `invoke`s | about **390,000 calls/s** (2.6 ms for the 1,000) |
| A 1 KiB reply | 0.06 ms |
| A 100 KiB reply | 0.88 ms |
| A 1 MiB reply | 9.4 ms (about 106 MiB/s) |
| An 8 MiB reply | 76.7 ms (about **104 MiB/s**; 111 MiB/s in the fastest run) |
| core → UI `emit` stream (100 B messages) | about **565,000 messages/s** |

What this means:
- UI-scale traffic (clicks, lists, documents, progress) is effectively instant.
- Bulk data of a few MB per second is fine.
- Video frames or sustained hundreds of MB/s are not a good fit for format 1. See §6.

You can reproduce these numbers with `tools/bench bridge`; method, the benchmark app and what to expect are in
[BENCHMARKS.md](BENCHMARKS.md) §3. It times `wm.invoke` calls with `process.hrtime.bigint()` against an app with an `echo`,
a `blob(n)` and a `burst(n)` handler (`bench/bridge/app`). Earlier versions of this page quoted 0.075 ms, 134,000 calls/s,
136 MiB/s and 70,000 messages/s from a one-off scratch run. That run timed one cold batch of concurrent calls (no JIT
warm-up) and awaited each emitted message in a loop, which explains the lower concurrent and event rates. The other two
differ the other way (single calls were slower, 8 MiB replies faster) and the reason was not investigated; the Mac was
not idle during our measurements either (load average 5 to 6 on 16 cores).

## 6. Where the bridge could get faster (ideas for contributors)

These are spec-level changes (proposal first, see GOVERNANCE §4). They're listed so contributors know where the
headroom is:
1. **Binary frames:** a length-prefixed binary message type, for payloads now sent as base64 or strings. That
   removes JSON encoding, about 2× for blobs.
2. **Streams:** a `stream` message family (`open`, `chunk`, `end`, `cancel`) with flow control, for large files and
   progress. It avoids 16 MiB single messages.
3. **Shared buffers:** zero-copy transfer through a shared-memory region, for media apps. This needs careful
   isolation design (INV-C1).
4. **Batching:** coalescing many small `emit`s per frame on the host side. It's transparent to apps.
5. **Compression** for large text payloads. It's rarely worth it at 100 MiB/s.

Optimisations *inside* a component that keep the wire format (faster parsing, fewer copies, better buffering) need no
spec change. They're always welcome.

## 7. Writing an SDK for another language

A complete core-side implementation needs:
1. **Listen and accept:** listen on the Unix socket at `$VMAPP_SOCKET` and accept one connection; a newer
   connection replaces the old one.
2. **Read lines:** read JSON lines, and dispatch on `t`.
3. **On `init`:** store `folders` and `data`, run the app's start-up, and send `{"t":"ready"}` within 30 s.
4. **Open windows:** with `request window.create`. Keep a map of pending request ids, resolved by `reply`.
5. **On `invoke`:** call the handler and send `result` with the same `id` (or `error:{message}`). **Handle invokes
   off the reading loop:** a handler may itself wait for a `reply`.
6. **On `send`:** call listeners, with no answer.
7. **To push to the UI:** send `{"t":"emit","win":…,"channel":…,"args":[…]}`.
8. **On window `closed`:** apply your app's policy, usually `request app.quit`.
9. **On `before-quit`:** save state quickly; the VM stops about 3 s later.
10. **On EOF:** exit.

Reference implementations:
- the Node SDK, `sdk/node/vmapp.js`, which is Electron-shaped;
- minimal loops in Rust (`apps/hasher/src/main.rs`) and C# (`apps/todo/Program.cs`).
