# Converting Ollama to a D9010 VmApp (following docs/CONVERTING.md)

Ollama is a Go server (`ollama serve`) with a command-line client in the same file, a model store on disk and, per loaded model, a helper
process (`llama-server`, llama.cpp). Nothing of it was changed: the app ships the official linux-arm64 release and adds a core (Node) that
starts it and a window. There is no original UI to compare with; the window is adapted from the Local LLM sample.

## 1. Inventory (CONVERTING.md step 1) and 2. classification (step 2)

✅ maps directly, 🔁 needs an adapter, ❌ is a format 1 gap.

| Where in Ollama | What it does | After conversion | |
|---|---|---|---|
| `ollama serve` listens on TCP `OLLAMA_HOST` | the local HTTP API | the VM's `127.0.0.1:11434`; only the core talks to it, with fixed requests (CONVERTING 5.3 without a generic forwarder) | 🔁 |
| `$OLLAMA_MODELS` (`~/.ollama/models`): `blobs/`, `manifests/` | the model store | `/data/ollama/models` (app data, persistent) | ✅ |
| `~/.ollama/id_ed25519` | key pair for ollama.com sign-in and push | `HOME=/data`, so it is created in `/data/.ollama`; unused (cloud is off) | ✅ |
| `ollama` spawns `lib/ollama/llama-server` per model | child process | works inside the VM; the binary and libraries are in `/app` (read-only); Ollama finds `../lib/ollama` relative to its own executable | ✅ |
| `server/download.go`, `transfer/redirect.go`: pull from `registry.ollama.ai` | manifest, then blobs via a redirect to a storage host | manifest OK through `HTTPS_PROXY`; **blobs not**: a local DNS lookup of the redirect host and a direct dial with no proxy setting | ❌ → 🔁 the core pulls (see README "Two things that had to be handled") |
| Go TLS roots (`/etc/ssl/certs`, `SSL_CERT_FILE`) | verifies `registry.ollama.ai` | the `node22` image has no bundle; the core writes one from Node's roots and sets `SSL_CERT_FILE` | 🔁 |
| `OLLAMA_NO_CLOUD`, `OLLAMA_REMOTES` (`ollama.com`) | cloud models, web search | `OLLAMA_NO_CLOUD=1`; `ollama.com` is not in `permissions.network` | ✅ |
| `OLLAMA_NOHISTORY` | the CLI's prompt history | `=1`; the CLI is not used | ✅ |
| `OLLAMA_KEEP_ALIVE`, `NUM_PARALLEL`, `MAX_LOADED_MODELS`, `CONTEXT_LENGTH` | memory behaviour | set for a VM that serves one conversation (30 min, 1, 1, 4096) | ✅ |
| CPU backend: eight `libggml-cpu-*.so` variants | picks one from the CPU features | the runner's log shows what the guest has (`NEON`, `FP16_VA`, `DOTPROD`, no int8 matrix multiply); Ollama picks accordingly | ✅ |
| CUDA 12 / 13 backends in the release | NVIDIA GPUs | dropped by `build.sh` (3 GB, useless in the VM) | ✅ |
| Vulkan backend (`OLLAMA_VULKAN`) | GPU | not shipped for arm64; the VM has no GPU yet | ❌ (pending, README "The GPU") |
| Update checks, telemetry | none in the server | verified: the tests allow two hosts and assert no other connection | ✅ |
| Files outside the store (user documents) | `ollama create` from a Modelfile or a GGUF path | not offered: no folder, no dialog | ✅ (by design) |
| UI | none (the CLI and other clients) | new: `ui/`, adapted from `apps/local-llm/ui` | new |

## 3. Decisions (steps 3 to 6)

- **Split:** privileged work (the server, the store, the pull, the proxy) in `core/`; the window only renders. The app has no folder,
  no dialog, no external link.
- **Runtime:** `node22` (the core is Node; the Go binary and the helper need only glibc 2.36, libstdc++, libgcc_s and libm, all in the
  runtime, checked by `build.sh`'s smoke test in the runtime's own base image).
- **Network:** two hosts, found by running the pull (see README "The network"): the registry and its storage host. Nothing else.
- **Host capability:** the plain `gpu` entry is a placeholder until the Vulkan form is defined; it is optional and does nothing for Ollama
  today (README "The GPU").
- **Size recommended:** 8 vCPUs, 8192 MB (the 7B model needs the memory; the vCPUs are the speed).

## 4. Changed, removed, unchanged

| | |
|---|---|
| **Unchanged** | `bin/ollama`, `lib/ollama/*`: the official release, byte for byte (verified against the release's SHA-256 by `build.sh`). |
| **Removed** | `lib/ollama/cuda_v12/`, `lib/ollama/cuda_v13/` (NVIDIA only); Ollama's own `/api/pull` is not used (reason above). |
| **Added** | `core/main.js`, `core/ollama.js`, `core/registry.js`, `core/models.json`, `ui/*`, `build.sh`, `pins.env`, `vmapp.json`, `README.md`, this file, `tests/apps/ollama.mjs`. |

## 6. Checklist

- [x] Every inventory row is converted, adapted or listed as a known gap (above)
- [x] Nothing writes into `/app`; all state lives in `/data` (`ollama/models`, `ollama/downloads`, `settings.json`, `.ollama/`) and `/tmp` (the CA bundle)
- [x] No inline scripts, remote resources or `fetch` to the internet in `ui/`
- [x] Permissions are minimal, and each `purpose` says why: two hosts and an optional `gpu`; no folders, dialogs or external links
- [x] Declined folders: not applicable (no folders)
- [x] `tools/vmapp verify` passes; the headless test covers every row that is ✅ or 🔁 (the Vulkan row is the documented gap)
- [x] The Inspector shows only expected traffic: the tests assert the host list and that chatting makes no connection
- [x] This file lists changed, removed and unchanged files
