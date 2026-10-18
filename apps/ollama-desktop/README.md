# Ollama (Desktop) (`dev.vmapp.ollama.desktop`, runtime `node22-gpu`)

**Ollama's own desktop app**, in a D9010 VmApp VM: its real React window (the same layout, components and options) and its real Go
backend, with the Ollama server compiled from the v0.35.0 source. You chat with models that run on your Mac, pull more from Ollama's
registry, and (if you allow `ollama.com`) sign in for cloud models and web search. Nothing about the app was rewritten: the window is
`app/ui/app` of the Ollama repository built with its own lockfile, the backend is `app/ui` + `app/store` + `app/server` of the same
tag, and `ollama serve` is the project's own server. What changed is listed, line by line, in
[`patches/PATCHES.md`](patches/PATCHES.md) and [`CONVERSION.md`](CONVERSION.md): five source files edited and one added, out of about
14,500 lines of UI source and 7,100 lines of Go in the app's packages.

It is the flagship conversion of the platform: a large, real, Go + React application converted by keeping its UI/backend split exactly,
with a streamed HTTP bridge between the sandboxed window and the server in the VM. The platform's guarantees hold for all of it: the
window has no network, no files and no Node (CSP `script-src 'self'`, `connect-src 'none'`); the only way out of the VM is the host's
allowlist proxy, with exactly the hosts this manifest lists.

## What you can do (all of Ollama's window)

- **Chat** with local models: streamed replies rendered as they arrive, Markdown with highlighted code and math, thinking blocks, a Stop
  button, editing and regenerating a message (the window's own code, unchanged), attachments (images and text files, up to 10 MB each,
  picked with the "+" button: a file chooser; tested), chats kept in a SQLite database in the app's data folder.
- **The model picker** with Ollama's recommended models; type a name (`qwen2.5:0.5b`) and any model of the registry is offered for
  download. Sending a message to a model that is not installed **pulls it first** with Ollama's own downloader (the window shows
  "Downloading model" with its progress), then answers.
- **Settings**: Ollama account (sign in, sign out), Cloud on/off, "Expose Ollama to the network" and "Allow browser access" (stored;
  moot in a VM, see "Limits"), **Model location** (Browse opens a native folder dialog), **Context length**, Agent and Tools modes.
- **Cloud models and web search** after you sign in at ollama.com (the sign-in link opens in your browser, after the platform asks you).
- **The CLI and the API.** The app is Ollama: `ollama` is in the VM next to the server, and Ollama's own HTTP API is reachable from the
  window at `/ollama/...` (see "Using it like Ollama").

## How it works

```
window (ui/: Ollama's React app, sandboxed: no network)                        the VM (runtime node22-gpu, /app read-only, /data persists)
  fetch('/api/v1/chat/…')  ──vmapp-fetch.js──► bridge ──► core/main.js + http-bridge.js ──► 127.0.0.1:11501  vmapp-ui   (app/ui, store, server)
  streamed answers, abort, uploads (sdk/web)         JSON lines          (sdk/node: pace, abort)                │ supervises, restarts on settings
  fetch('/ollama/api/…')   ──────────────────────────────────────────────────────────────────────► 127.0.0.1:11434  ollama serve (v0.35.0, patched)
  ollama-desktop-shim.js: files, folders, links, menu ──► core (dialog, shell.openExternal)                        │ models: registry.ollama.ai
                                                                                                                  ▼ via the allowlist proxy only
```

- `core/main.js` starts `vmapp-ui` (the desktop app's own backend, headless: [`backend/vmapp-ui/main.go`](backend/vmapp-ui/main.go) is
  `app/cmd/app/app.go` minus the webview, tray and updater), gives it its environment (`HOME=/data`, `PATH` with `/app/bin`, the proxy,
  a CA bundle, the Vulkan switches), opens the window, and carries the window's HTTP requests to the backend.
- **The backend supervises the server**, as in the desktop app: it starts `ollama serve`, restarts it when it dies or when a setting
  that the server reads at start changes (context length, model location, cloud), and reads its log for the compute devices.
- **The window and the backend speak HTTP through the bridge** ([`sdk/web/vmapp-fetch.js`](../../sdk/web/vmapp-fetch.js),
  [`sdk/node/http-bridge.js`](../../sdk/node/http-bridge.js), documented in [docs/CONVERTING.md](../../docs/CONVERTING.md) §5.3):
  answers are streamed in pieces as the server writes them, with backpressure (the core sends at most 256 KiB that the window has not
  read), `AbortSignal` support (aborting a chat destroys the connection, which stops the generation), and request bodies of any size
  (FormData, files) in pieces.
- **The token** (`ui.Server.Token`) is a random value that only the core knows; it adds the `token` cookie the backend requires to each
  forwarded request. The window never sees it, and a cookie the window supplies is replaced.

## Using it like Ollama

Everything below is Ollama's own code answering: nothing is emulated.

- **The window** talks to the app's backend at `/api/...` (the UI's own API: chats, settings, cloud, `/api/tags`, `/api/show`,
  `/api/version`, ...). The UI pulls models through the chat endpoint (`POST /api/v1/chat/{id}`, which calls Ollama's pull and streams
  `download` events). `src/api.ts` has a `pullModel()` for `POST /api/v1/models/pull`; the v0.35.0 Go server has no such route and
  the React app never calls it (dead code upstream).
- **Ollama's API, unchanged**, for any code that runs in the window (another window of this app, an agent, a test): `fetch('/ollama/api/pull', …)`
  is `POST /api/pull` on the real server with its streamed progress; the same for `tags`, `show`, `ps`, `chat`, `generate`, `embed`,
  `embeddings`, `copy`, `delete`, and the OpenAI-compatible `/ollama/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`,
  `/v1/models`. (Not offered: `create`, `push` and blob uploads.) With `ollama-js`: `new Ollama({ host: location.origin + '/ollama' })`.
- **The CLI in the VM.** `ollama` is `/app/bin/ollama`, with `OLLAMA_HOST=127.0.0.1:11434` and the proxy in its environment, so it talks to the same
  server and pulls through the same allowlist. The core offers it as a channel, `ollama:cli {args}` → `{code, stdout, stderr}` for
  `list ls ps show pull rm cp stop run --version` (a fixed list; no shell). From a script:
  ```js
  // cli.mjs: tools/vmapp run dev.vmapp.ollama.desktop --headless --script cli.mjs
  export default async ({ wm }) => {
    await wm.waitForWindows(1, 60000);
    console.log((await wm.invoke(1, 'ollama:cli', { args: ['pull', 'qwen2.5:0.5b'] })).stderr);
    console.log((await wm.invoke(1, 'ollama:cli', { args: ['list'] })).stdout);
  };
  ```
  An interactive terminal is a different app: [`apps/terminal`](../terminal/README.md) is its own VM and does not see this server. To
  use the CLI interactively next to the window, the way is a Terminal profile that runs `ollama` against a server in *that* VM
  (its core would carry the same `bin/` and `lib/`), which is not built here.

## The network

| Host | Why | Verified by |
|---|---|---|
| `registry.ollama.ai` | the registry: a model's manifest, and the redirect of every file | the platform's traffic events in `tests/apps/ollama-desktop.mjs` |
| `dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com` | where the registry's redirect sends every file (Ollama's bucket on Cloudflare R2) | the same: it carries every model byte |
| `ollama.com` | your account (sign in, usage), cloud models, web search, the "is my model stale" check, the account refresh at start | `POST /api/me` through the proxy: 401 with the sign-in URL |

The window and the backend ask for nothing else. `ollama.com` is the one host with a privacy cost: while it is allowed, the app contacts
it when the app starts (a signed request to refresh the account, which is answered "not signed in" when you are not), when you type a
model name into the picker, and for cloud features. Refuse it in the permission sheet (or "Network…" on the card) and the app is a local
chat app: local models still work, the cloud entries fail with an error (`tests/apps/ollama-desktop.mjs` passes with `ollama.com` declined: the
connections it attempts are listed as refused in the Inspector). **Turn Cloud off in Settings** to stop the cloud calls with the host
still allowed. Prompts to a cloud model leave the Mac (to ollama.com): that is what choosing a cloud model means.

## The safety story

| What the app (or a model, or a hostile message) could do | What actually happens |
|---|---|
| Read your files | No folder is granted. A file you attach is read by the window from the file you picked (a file chooser, like a browser). The "Model location" folder is shared only when you pick it, read-write, in a native dialog. |
| Send your chats somewhere | The VM has no network device. The only way out is the allowlist proxy and the three hosts above; chats go to `ollama.com` only when you use a cloud model. The backend and the server listen on the VM's loopback; only the core reaches them, with fixed ports and a token. |
| Run code through the window | The window has no Node, no network and one API (`window.vmapp`). The core handlers it can call: the HTTP bridge to the two loopback servers (paths and methods listed), open a link (https, you confirm), pick a folder, a read-only diagnostic, and the `ollama` CLI (fixed subcommands). |
| A malicious model file | Ollama parses GGUF files in the VM; a bug there is contained by the VM (the same caveat as every Ollama app here). |
| Use your GPU behind your back | The GPU is off unless you allow the app's experimental Vulkan request **and** the loader's "Experimental GPU (Vulkan)" switch is on. |
| Fill your disk | Models live in the app's data folder; *Reset app* in the loader deletes them. |

## The GPU

One app, one runtime (`node22-gpu`), one manifest line `{cap: gpu, api: vulkan}` (SPEC 8.7). On the normal backend (the default) the app
has no GPU and runs on the VM's CPUs: Ollama picks the best of eight CPU-feature variants. With the three switches of SPEC 8.7 on
(manifest line allowed for this app, the loader setting, the backend installed) the VM has the Venus device, the core sets
`OLLAMA_VULKAN=1`, `OLLAMA_IGPU_ENABLE=1` and `GGML_VK_DISABLE_ASYNC=1` (the asynchronous path of ggml-vulkan computes wrong results on
this device: [apps/ollama/README.md](../ollama/README.md#the-async-path-computes-wrong-results-on-venus-found-here)) and Ollama runs
models on it. The Vulkan library is built by `apps/ollama/vulkan/build-vulkan.sh` and bundled by `build.sh --vulkan-lib`. Two
limits of that backend apply to this app: **no runtime folder grants** (the "Model location → Browse" dialog answers "not supported on
the gpu backend" and the window shows it), and no presenting of frames (irrelevant here).

## Build, pack, run

```
apps/ollama-desktop/build.sh --vulkan-lib out/work/ollama/vulkan/out/libggml-vulkan.so   # Docker; see "What the build does"
tools/vmapp pack apps/ollama-desktop -o ollama-desktop.vmapp
tools/vmapp install ollama-desktop.vmapp           # then the D9010 VmApp Launcher: Launch; allow the hosts; 8 vCPUs and 8 GB are recommended
bash tests/apps/run-all.sh                         # runs ollama-desktop-main and ollama-desktop-persist when the build exists
bash tests/apps/ollama-desktop-gpu.sh              # the experimental Vulkan backend
node tests/apps/ollama-desktop-ui.mjs              # the real loader over CDP: screenshots, the real window (opens windows)
node --test tests/unit/http-bridge.test.js         # the streamed bridge, no VM
```

**What the build does** ([`build.sh`](build.sh), read its header; every input is pinned in [`pins.env`](pins.env)):

1. checks that the Ollama clone is at tag `v0.35.0` = commit `cc40693…`, makes a clean `git archive` of it and applies `patches/` with
   `patch -p1` (a patch that does not apply stops the build);
2. **Go** (Docker, `golang:1.26.7-trixie` by digest): `go build -trimpath -buildmode=pie` of `ollama` and of `vmapp-ui`, `go.sum`
   enforced, `go test ./transfer/ ./app/store/`;
3. **runners** (same image): Ollama's own `cmake --preset cpu` build of `llama-server` and the CPU backends from llama.cpp b11081
   (fetched by Ollama's CMake, checked against its commit). Why trixie: the eight CPU variants include `-march=armv9.2-a`, which needs
   GCC 13 or newer (bookworm's GCC 12 stops there), and what GCC 14 builds needs **glibc 2.38 and libstdc++ 3.4.32**: the runners run on
   `node22-gpu` (trixie) and **not on `node22`** (bookworm, glibc 2.36). The Go programs (`ollama`, `vmapp-ui`) need only glibc 2.34 and
   run on both. (Ollama's own release is built on AlmaLinux 8 with clang for glibc 2.28, which is why it runs everywhere.) Measured: the
   same model generates at 286 tokens/s here against 276 for the release's runners (Qwen2.5 0.5B, 8 vCPUs, `apps/ollama/README.md`);
4. **UI** (the node22 runtime's base image): `npm ci --ignore-scripts` with Ollama's `package-lock.json`, `tsc -b`, `vite build`;
   `build/check-ui.mjs` then checks the result against the window's CSP (no inline script, no remote address, no `eval`);
5. assembles `core/` (git-ignored) and `ui/` (git-ignored): `bin/ollama`, `bin/vmapp-ui`, `lib/ollama/…`, `http-bridge.js`, the shims and
   the licence files. The first build takes a while (the toolchain image, the Go modules, llama.cpp); the next ones skip every stage whose
   inputs did not change.

The package is 111 MiB (`core.cpio` 96 MiB, `ui` 15 MiB, 422 files). It needs 8 GB of VM memory only for larger models; the 0.5B model runs
in far less.

## Tests

- `tests/unit/http-bridge.test.js` (no VM): the streamed bridge against a real HTTP server: streaming, multi-byte characters across
  writes, binary answers, backpressure, abort, large and multipart request bodies, mount points and allow lists, what the core refuses.
- `tests/apps/ollama-desktop.mjs` (a real VM; two runs): the server and its environment, the UI backend's endpoints, **a real pull of
  qwen2.5:0.5b through Ollama's own downloader** (progress streamed, cancelled at 40 MiB, resumed, SHA-256 checked by Ollama and again on
  the host), the traffic (exactly the manifest's hosts), Ollama's API (tags, show, ps, chat and generate, the OpenAI-compatible stream, copy,
  delete), the UI's chat endpoint (events, an attachment, the model deleted and pulled again through the chat), the CLI (list, show, run,
  rm, a real pull), settings that restart the server, the account check against ollama.com, and a second run in a new VM that finds the
  chats, settings and model again.
- `tests/apps/ollama-desktop-ui.mjs` (the loader over CDP, own port 9311): onboarding, the model picker, typing a model that is not
  installed, the download shown in the window, streamed rendering, Settings (the Cloud switch, Model location → Browse), links through the
  platform, no CSP violation in the session, and a restart with the chat still there. Screenshots: `$VMAPP_WORK/shots/ollama-desktop-*.png`.
- `tests/apps/ollama-desktop-gpu.sh`: the Vulkan backend; Ollama finds the Venus device, the model is in video memory and answers correctly.

## Limits and known differences from the desktop app

See [CONVERSION.md](CONVERSION.md) for the full list. The ones you will notice: no tray, menu bar, dock, login item or auto-update
(the platform has none; the app is updated as a package); no Claude Desktop / Codex integrations (they configure other macOS apps);
"Expose Ollama to the network" and "Allow browser access" are stored but moot (a VM without a network device); the window's zoom keys and
the onboarding window resize are not mapped; the account avatar does not load (the window's CSP refuses images from `ollama.com`);
"Model location → Browse" gives a folder that is valid for the current run only (a different pick may get the same `/host/pick-N` name next
time, and the app falls back to its own folder when the path is gone); images are generated nowhere (Ollama's image generation is
macOS-only).

## Licences

Ollama is MIT-licensed ([`core/bin/LICENSE.ollama`](https://github.com/ollama/ollama/blob/v0.35.0/LICENSE); copied into the package next to
the binary and into `ui/`). `core/lib/ollama/` carries the licences of the code Ollama bundles: llama.cpp (`LLAMA_CPP_LICENSE`,
`LLAMA_CPP_VENDORS_LICENSE`), cpp-httplib (`CPP_HTTPLIB_LICENSE`) and Go (`GO_LICENSE`). The window is built from 341 npm packages, listed
with their licences in `ui/THIRD-PARTY-LICENSES.txt`. The patches, the backend entry point, the shims and the bridge are the D9010 VmApp
project's. The Ollama name and logo belong to their owners; this is a conversion of the open-source project for demonstration, not an
official Ollama release.
