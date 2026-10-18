# Ollama (`dev.vmapp.ollama`, runtime `node22`)

The real **Ollama** server (the unmodified linux-arm64 release, 0.35.0) running **inside the app's VM**, with a chat window on top. You
pull a model from Ollama's registry, chat with it, and see how fast it answers. Your conversation never leaves your Mac: the only
thing the app asks the network for is the model files, and the app has no access to your folders.

It is the sample that shows how a real, existing server program (Go, with a helper process and a model store) is put in a D9010 VmApp VM
**without changing a line of it**, with real numbers. Its sibling [`apps/local-llm`](../local-llm/README.md) does the same with
llama.cpp's own server; this one has Ollama's model library and API instead. The conversion notes are in [CONVERSION.md](CONVERSION.md).

## What you can do

- **Pull a model** from a short curated list (`core/models.json`): Qwen2.5 0.5B, Gemma 3 1B, Llama 3.2 1B, Qwen2.5 1.5B and Qwen2.5 7B,
  or **any other model of `registry.ollama.ai`** by typing its name (`name:tag`). The download has a progress bar, can be cancelled
  and resumed, and every file is checked against the SHA-256 in the model's manifest before it is stored.
- **Delete** a model (its files leave the disk) and **Unload** it (its memory is freed; Ollama keeps a model loaded for 30 minutes).
- **Chat** with streaming replies, a Stop button, a system prompt, temperature, reply length and context size, and the generation
  speed in **tokens per second** (Ollama's own `eval_count / eval_duration`) under every reply and in the status line.
- See **where the model runs**: the status line is built from Ollama's `/api/ps` (`size_vram` is the part of the model in video
  memory) and from the "inference compute" lines of its log. In this app that is always the CPU; the sibling app Ollama (GPU) can say
  GPU (see "The GPU").
- Open the **Log** panel for Ollama's own log.

## The safety story

| What the app (or a model, or a hostile prompt) could do | What actually happens |
|---|---|
| Read your files | The app asks for **no folder** and no dialog. It sees only its own data (`/data`: the models and `settings.json`). |
| Send your conversation somewhere | The VM has no network device. The only way out is the host's allowlist proxy, and the app asks for exactly two hosts, both for model downloads: **`registry.ollama.ai`** and **`dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com`** (see "The network"). Ollama listens on the VM's `127.0.0.1:11434`; only the core reaches it, and the core sends the window's requests as fixed, validated calls (never an arbitrary path or body). The tests check that chatting opens no connection at all. |
| Phone home | `OLLAMA_NO_CLOUD=1` switches off Ollama's cloud features (`ollama.com`), and nothing but the two hosts above is reachable anyway: any other connection gets the proxy's `403` and shows up in the Inspector. |
| Run code through the model | The window can send only chat messages (roles, text, temperature and length within limits). Ollama's tool-calling features need a client that runs tools; this one does not. |
| Use your GPU behind your back | This app asks for no GPU permission. The sibling app Ollama (GPU, experimental) asks for the experimental Vulkan GPU (SPEC 8.7): off until you allow it, and only on the experimental backend, which you switch on in the loader (see "The GPU"). |
| Fill your disk | A pull checks the free space first; the models live in the app's data folder, and *Reset app* in the loader deletes them. |

What this does **not** protect against: a model is a program too. Ollama parses the model files you pull (GGUF) inside the VM; a
malicious file could crash it or, in the worst case, exploit it, and the VM is what contains that. Prefer the curated list. A host you
allow is a place the app *can* send data; these two serve public model files, but they are shared infrastructure (a Cloudflare R2
account endpoint), so the sheet shows them in full.

## How it works

```
chat window (ui/) ─────────────── core (node, in the VM) ──────────────────────────────── ollama serve (in the VM)
  ollama:pull ───────────────────► registry.js: GET manifest, GET blobs (follows the redirect), sha256, Range resume,
                                              writes /data/ollama/models/{blobs,manifests}      (through 127.0.0.1:3128)
  ollama:chat ───────────────────► ollama.js: POST 127.0.0.1:11434/api/chat (NDJSON stream) ──► llama-server helper ──► tokens
  ◄────────── ollama:token, done ─ tokens in batches of about 30 ms; tokens/s from the final eval_count / eval_duration
  ollama:ps, ollama:models ──────► GET /api/ps, /api/tags, DELETE /api/delete, POST /api/generate {keep_alive: 0} (Unload)
```

- `core/ollama.js` starts and watches `ollama serve` and talks to its API. Its environment is built from scratch: `HOME=/data`,
  `OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_MODELS=/data/ollama/models`, `OLLAMA_NOHISTORY=1`, `OLLAMA_NO_CLOUD=1`,
  `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=30m`, `OLLAMA_CONTEXT_LENGTH=4096`, `OLLAMA_VULKAN=0|1`, the
  proxy variables the platform sets (`HTTPS_PROXY` and friends) and `SSL_CERT_FILE`.
- `core/registry.js` pulls models. `core/main.js` is the bridge (its header lists every channel). `core/models.json` is the curated list.
- `ui/` is plain HTML, CSS and JavaScript (adapted from the Local LLM sample): no libraries, no inline scripts, no remote resources,
  text built with DOM nodes (never `innerHTML`).
- `bin/ollama` and `lib/ollama/` are the release, unpacked by `build.sh`. Ollama starts a helper, `lib/ollama/llama-server` (llama.cpp's
  server, built into the release), for every model it loads, and that helper picks the best CPU variant for the VM's processor.

### Two things that had to be handled (found by running it in the VM)

1. **Ollama's own downloader cannot work in a VM that has no DNS and no route.** `POST /api/pull` fetches the manifest through
   `HTTPS_PROXY` (so that works), but the registry answers a blob request with a redirect to its storage host, and Ollama 0.35.0
   (`transfer/redirect.go`) then resolves that host with a local DNS lookup (to refuse private addresses) and downloads from it with its
   own `http.Transport`, which has a custom dialer and **no proxy setting**. In the VM the lookup fails (`redirect target not allowed:
   resolving …: lookup … connection refused`), and the direct connection could not work either. So the core does the pull itself, in
   `registry.js`: the same registry protocol (manifest, blobs, redirect), written into Ollama's own on-disk store, with SHA-256 checks and
   resume. `ollama serve` then serves what is in the store; it never downloads anything. The same download also fits the platform better:
   the core controls exactly which hosts are contacted, and the redirect is followed by hand, so a host that is not allowed is named in
   the error.
2. **The `node22` runtime has no CA certificate bundle** (Node carries its own), and Go needs one to verify `registry.ollama.ai`'s
   certificate. The core writes `/tmp/vmapp-ca-bundle.pem` at start from Node's built-in root certificates (`tls.rootCertificates`) and
   gives it to Ollama as `SSL_CERT_FILE`. Ollama then trusts the same roots as Node does.

## The network

| Host | Why | Verified |
|---|---|---|
| `registry.ollama.ai` | The registry: the manifest of the model (which files make it up), and the first answer to every file request, a redirect. | `curl` and the tests |
| `dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com` | Where the registry's redirect sends every file: Ollama's bucket on Cloudflare R2, a signed URL valid for 24 hours. | `curl -I` on a blob, and the test's traffic events |

`tests/apps/ollama.mjs` pulls a model and asserts, from the platform's traffic events, that **exactly these two hosts** were contacted,
on port 443, all allowed, and that nothing else was (chatting opens no connection). It also revokes the storage host while the app
runs and checks that a pull then fails with a sentence that names the host, and that the Inspector shows the refused connection.

The storage host is named by Ollama's registry. If Ollama one day serves files from another host, a pull fails with "Could not connect
to <host>…" and the manifest needs that host (an update that adds a host always stops at the user's "asks for more" sheet). Find it with
`vmapp run --headless` (it prints `[net] DENIED host:port`) or the Inspector's `net` rows. Models of other registries (a name with a
host in it) are refused by the core.

## Speed on the CPU

Measured by `tests/apps/ollama.mjs` in a real VM on an Apple M4 Max Mac (16 cores, 128 GB): **8 vCPUs, 8 GB, context 4096**, greedy
sampling, tokens per second as reported by Ollama itself (generation: median of 5 runs of 128 tokens; prompt: a new 500-token prompt,
nothing cached), October 2026.

| Model (curated list) | Download | Generation | Prompt processing | Load (first question) |
|---|---|---|---|---|
| Qwen2.5 0.5B, Q4_K_M, 398 MB | 16 s | **276 tok/s** | 791 tok/s | 1.1 s |
| Gemma 3 1B, Q4_K_M, 806 MB | 28 s | 124 tok/s | 424 tok/s | 1.3 s |
| Llama 3.2 1B, Q8_0, 1.3 GB | 44 s | 165 tok/s | 1,125 tok/s | 1.8 s |
| Qwen2.5 1.5B, Q4_K_M, 986 MB | 40 s | 111 tok/s | 449 tok/s | 2.3 s |
| Qwen2.5 7B, Q4_K_M, 4.7 GB (8 GB VM) | 164 s | 45 tok/s | 140 tok/s | 6.1 s |

(The Mac's one-minute load average was 6 to 9 while these ran: other jobs were using its cores. The download times are the whole pull,
including a cancel and a resume, at about 25 MB/s.)

How to read it:

- A Mac's CPU cores in a VM with 8 vCPUs are fast enough for all of the list: even the 7B model generates at 45 tokens per second,
  several times faster than anyone reads. What a long prompt costs is the wait before the first word: 500 tokens take about 3.5
  seconds with the 7B model and under one second with the small ones. The first question also pays the model's load time (the last column).
- The numbers move by 10 to 40% from run to run, mostly with what else the Mac is doing (the 1.5B model measured 49 tokens/s in a run
  while the Mac's load average was above 25, and 111 at a load of 6; `tests/apps/ollama.mjs` records the load in its results).
- Virtualization.framework does not expose the M2+'s int8 matrix-multiply instructions to the guest, so the CPU backend runs a variant
  without them (Ollama picks it by itself from the CPU features the guest reports). The release has eight CPU variants.
- **vCPUs matter.** The manifest recommends 8, but a user who changes nothing gets one vCPU (SPEC 8.5), which is slow for this app.
  Ollama uses every vCPU the VM has (`n_threads` in its log equals the VM's CPU count).

## The GPU

**Status (2026-10-15): built and run.** Ollama (GPU) finds the Venus GPU on the experimental backend, runs three models on it with
correct answers (`size_vram` = the whole model) and is faster than the same VM's CPUs for the two bigger ones; the numbers and the
one bug found on the way (the async path, below) are under "Measured". This app (`dev.vmapp.ollama`, runtime `node22`) always runs on the CPU. The GPU is the job of a sibling app,
**Ollama (GPU, experimental)** (`apps/ollama-gpu`, id `dev.vmapp.ollama.gpu`), which has the same core and window (copied from this
app by the build) and differs in three things:

1. **Its runtime is `node22-gpu`**: the manifest form for the experimental Vulkan GPU, `{"cap": "gpu", "api": "vulkan"}` (SPEC 2.2, 8.7),
   is only valid on a runtime that carries the Vulkan loader and Mesa's Venus driver. A manifest cannot be "node22 unless the GPU is
   on", so the GPU variant is a separate app; this one stays small, on `node22`, and unchanged. (Without the three switches of SPEC 8.7
   the GPU app still starts, on the normal backend, without a GPU, and runs on the CPU like this one.) The plain `gpu` capability of
   SPEC 8.6 is the llama.cpp RPC service, **which Ollama cannot use** (its llama-server has no RPC backend and Ollama gives no way to
   pass `--rpc`), so neither app asks for it.
2. **Its package carries `lib/ollama/vulkan/libggml-vulkan.so`**, the one library the linux-arm64 release does not ship (its backends
   are CPU, eight variants, and CUDA 12/13, which `build.sh` drops). `vulkan/build-vulkan.sh` builds it from the llama.cpp tag that
   Ollama's own tag builds on (`b11081`, commit `161755f2…`, from Ollama's `LLAMA_CPP_VERSION`), with `GGML_VULKAN=ON`,
   `GGML_BACKEND_DL=ON`, `GGML_NATIVE=OFF`, `GGML_OPENMP=OFF` as Ollama's own `vulkan` preset, in a container on the base image and
   Debian snapshot of the `node22-gpu` runtime (glslc 2025.2, Vulkan headers 1.4.309, see `vulkan/pins.env`). The Dockerfile checks the
   result against Ollama and against the release: Ollama's `LLAMA_CPP_VERSION`, that its compat patch touches no `ggml/` file (so
   upstream ggml is what Ollama's Vulkan library is built from), that its `vulkan` preset installs into `lib/ollama/vulkan`, that the
   built `libggml-base.so.<version>` is the release's (0.24.0), and that every `ggml_*` function the module imports is defined by the
   release's `libggml-base.so.0.24.0`.
3. **Its core turns the GPU on by default** where there is one to use (`gpuSupport().eligible`: `/dev/dri/renderD128` and the library).

How Ollama 0.35.0 finds the library (read at tag `v0.35.0`): `ml/path.go` takes `lib/ollama` next to the binary; `discover/runner.go`
globs `lib/ollama/*/*ggml-*` and runs GPU discovery once per directory it finds, passing `OLLAMA_LIBRARY_PATH=lib/ollama:lib/ollama/vulkan`
to the `llama-server` helper (skipped when `OLLAMA_VULKAN=0`); `discover/native_probe_platform.go` names the file, `libggml-vulkan.so`.
Two details matter here: the core passes `OLLAMA_VULKAN` explicitly (0 or 1), because this Ollama turns Vulkan on by itself when the
library exists; and **`OLLAMA_IGPU_ENABLE=1` is set with it**, because the Venus device is an integrated (UMA) GPU as the Mac's own is
(ggml prints `uma: 1`) and `filterIntegratedGPUs` drops integrated GPUs on Linux unless that variable is set (without it the backend
loads and its only device is silently thrown away).

Build, install, test (each step names what it needs when something is missing, exit status 2; the first two need Docker, and the
build about 3 GB of room on the volume of `$HOME`, where Docker keeps its disk image):

```
tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img     # once; the image in out/ may predate the GPU probe (SPEC 8.7)
apps/ollama/build.sh --with-vulkan     # the release (as above), then vulkan/build-vulkan.sh: libggml-vulkan.so and apps/ollama-gpu/{core,ui}
bash tests/apps/ollama-gpu.sh          # pack, install, grant the GPU, run OLLAMA_PHASE=gpu in a real VM on vmapp-vm-krun
```

By hand: `tools/vmapp pack apps/ollama-gpu -o ollama-gpu.vmapp`, `tools/vmapp install ollama-gpu.vmapp`, `tools/vmapp grant-host
dev.vmapp.ollama.gpu gpu` (switch 2 of SPEC 8.7), then `tools/vmapp run dev.vmapp.ollama.gpu --headless --experimental-gpu` (switch 3;
in the loader: Host Capabilities, "Experimental GPU (Vulkan)"). The GPU phase of `tests/apps/ollama.mjs` expects a non-CPU compute device
at start, `size_vram > 0` in `/api/ps`, and records tokens per second next to the CPU's, in the same VM, on the same model.

Also verified: the manifest validates and packs; the grant records `api: vulkan`; **a corrupt `libggml-vulkan.so` is ignored: Ollama
starts and lists only the CPU**, so a library that does not load cannot break the app.

### Measured

`bash tests/apps/ollama-gpu.sh` (`OLLAMA_MODEL=...` for the others), M4 Max, 8 vCPUs and 8 GiB in the VM, GPU window 8192 MiB (the
default), context 4096, greedy, median of 5 generations of 128 tokens, load average 1.6 to 2.8, 2026-10-15. Each run measures the GPU,
then restarts Ollama with the GPU off and measures the CPUs of the same VM; the model must answer "Paris" on the GPU or the test fails.
Ollama's log: `inference compute ... name=Vulkan0 description="Virtio-GPU Venus (Apple M4 Max)"`, and `/api/ps` says `size_vram` equals
the model size (100% of the model on the GPU) for all three.

| Model | Generation, GPU | Generation, CPU | GPU / CPU | Prompt, GPU | Prompt, CPU |
|---|---|---|---|---|---|
| Qwen2.5 0.5B, Q4_K_M | 254 tok/s | 310 tok/s | 0.8x | 6,093 tok/s | 816 tok/s |
| Llama 3.2 1B, Q8_0 | 239 tok/s | 170 tok/s | 1.4x | 3,402 tok/s | 1,154 tok/s |
| Qwen2.5 7B, Q4_K_M | 72.5 tok/s | 45.8 tok/s | 1.6x | 644 tok/s | 142 tok/s |

Read it this way: prompt processing is 4 to 7.5 times faster on the GPU for every size; generation is only faster for the larger
models, and for the 0.5B model the CPUs win (each token pays the GPU round trip through the paravirtual device, as the RPC path
of the Local LLM sample does). For the 7B model Ollama on Vulkan (72.5 tok/s) is close to the Local LLM sample's llama-server on the
RPC GPU path (76 tok/s) and to llama-bench on the same Vulkan backend (73 tok/s for Llama 3.1 8B, `docs/BENCHMARKS.md` section 8).
Numbers move 10 to 20% between runs with what else the Mac is doing.

### The async path computes wrong results on Venus (found here)

The first GPU runs of the two larger models "worked": the device was found, `size_vram` was full, and the speeds looked great (Llama 3.2
1B: 203 to 274 tok/s; Qwen2.5 7B: 77 tok/s). **The answers were garbage** (`?Tags?`; `BusinessException0.1........ disadvalusalus`), while
Qwen2.5 0.5B on the same stack and every model on the CPU were right. Switching off flash attention (`OLLAMA_FLASH_ATTENTION=0`) did not
help. Bisecting ggml-vulkan's switches in a VM (Llama 3.2 1B, three prompts each): disabling async, integer dot product, fp16, MMVQ,
fusion, graph optimisation and multi-add together gave correct answers (60 tok/s); `GGML_VK_DISABLE_ASYNC=1` plus
`GGML_VK_SERIALIZE_SUBMISSIONS=1` correct (80 tok/s); **`GGML_VK_DISABLE_ASYNC=1` alone correct, at full speed (231 to 353 tok/s)**.
So ggml-vulkan's asynchronous path (compute and transfers submitted so that they overlap) is not synchronised properly through
Venus/MoltenVK, probably the same family as the open B3 item (timeline semaphores, `gpu/krun/README.md`); it has not been narrowed
further. The core therefore sets `GGML_VK_DISABLE_ASYNC=1` whenever it turns Vulkan on (`core/ollama.js`; a manifest `core.env`
entry can still override it, and `GGML_VK_*`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE` and `OLLAMA_DEBUG` set there are passed
to Ollama, for experiments). The cost, measured with llama-bench on Llama 3.1 8B in the VM, is 3.6% of generation (73.3 to 70.7 tok/s,
prompt 687 to 681), the same as native MoltenVK gets (70.8).

**What this means for the other Vulkan numbers:** `llama-bench` does not check its output, so the Vulkan rows of the README prove
speed, not correctness. The same device ran Ollama's b11081 llama-server wrongly with the async path on; whether b11669's `llama-bench`
build computes right with it on is not known (open item in PM.md: run a real completion in the VM with the same build, with and
without `GGML_VK_DISABLE_ASYNC`).

Another quirk: Ollama labels the Venus device `library=Metal` (and the window says "100% on Metal: Vulkan0") (why was not
investigated; probably its mapping for Apple GPUs); the device name `Vulkan0` and the description `Virtio-GPU Venus` are the truth (the guest is
Linux, it has no Metal).

## Limits

- Chat models only in the window (a pulled embedding or decision model loads, but the window sends chat requests). One conversation
  at a time (`OLLAMA_NUM_PARALLEL=1`), one model in memory (`OLLAMA_MAX_LOADED_MODELS=1`).
- The window does not do images, tools or thinking-mode controls (a model's `thinking` output is shown as grey text if it sends it).
- The whole model is read into the VM's memory on the CPU (this Ollama turns mmap off for CPU loads): a model needs about its size plus
  15% plus 300 MB. The 7B model needs the 8 GB VM; the window warns when a model will not fit.
- The core pulls with one connection per file. A pull ran at about 25 MB/s here; Ollama's own downloader uses four parallel parts.
- Pulling a model for which a newer Ollama is needed fails when it loads; update the pin (below).

## Build, pack, run

```
vmapp/apps/ollama/build.sh                       # Ollama's release for linux-arm64, checked against its published SHA-256
vmapp/tools/vmapp pack vmapp/apps/ollama -o ollama.vmapp
vmapp/tools/vmapp install ollama.vmapp           # then open the D9010 VmApp Launcher, Launch; set the VM to 8 vCPUs on the card
vmapp/tests/apps/run-all.sh                      # builds everything and runs the tests of all sample apps, Ollama included
vmapp/apps/ollama/build.sh --with-vulkan         # opt-in, experimental, needs Docker: also Ollama's Vulkan backend and apps/ollama-gpu (see "The GPU")
```

`build.sh` needs `curl`, `tar` and `zstd` (`brew install zstd`), and Docker only for a smoke test. It downloads
`ollama-linux-arm64.tar.zst` (1.5 GB, once, into `$VMAPP_WORK/cache/ollama/<tag>/`), checks its SHA-256 against **both** the release's
`sha256sum.txt` and the value pinned in `pins.env`, unpacks `bin/ollama` and `lib/ollama` (without the CUDA directories), and records what
the release contains in `core/bin/BUILD-INFO.txt`. The smoke test runs `ollama --version` and `ldd` in the node22 runtime's own base image
(glibc 2.36: the binary needs nothing newer). The result is 48 MiB of `core/` (git-ignored), packed into a 48 MiB `.vmapp`; `/app` lives in
the VM's memory.

**Updating Ollama:** change `OLLAMA_VERSION`, `OLLAMA_TAG`, `OLLAMA_TAG_COMMIT` and `OLLAMA_ASSET_SHA256` in `pins.env` (the checksum from the
release's `sha256sum.txt`), run `build.sh`, run the test, bump the app's version, and check the network table above (a new Ollama may use
other hosts). The pinned release is the newest one that is at least 14 days old by every date GitHub shows. The Vulkan backend follows the
release: `vulkan/pins.env` names the same Ollama tag commit and the llama.cpp tag of that release's `LLAMA_CPP_VERSION`; change them
together (`vulkan/build-vulkan.sh --check` verifies, without Docker, that the pins agree with each other, with `runtimes/node22-gpu` and with
the unpacked release; the build itself checks `LLAMA_CPP_TAG` against Ollama's `LLAMA_CPP_VERSION`).

## Tests

`vmapp/tests/apps/ollama.mjs` runs in a real VM (`OLLAMA_PHASE=cpu`; started by `tests/apps/run-all.sh`, which also grants the two hosts and
sets 8 vCPUs and 8 GB):

- the server: pinned version, listening on loopback, the environment it prints, a compute device, the CPU variants in the build;
- the guards: path traversal, a registry host in a model name, over-long and missing names, models that are not installed;
- a model that does not exist (the registry's 404 as a sentence), a **real pull** cancelled halfway (the partial file stays), **resumed**,
  and verified (every blob's SHA-256 recomputed on the host), the traffic events (exactly the two hosts), and a **revoked storage host**;
- chat: a streamed reply, five measured generations (median tokens/s), prompt processing, `/api/ps` (CPU, `size_vram` 0, every vCPU
  used), no connection during chats, Stop, malformed requests, the GPU switch on a VM without a GPU, Unload, Delete;
- a copy of the pulled model is kept in `$VMAPP_WORK/cache/ollama-models`, so that a run without internet still chats. Without internet
  and without that copy the test prints `SKIP` and passes. `OLLAMA_MODEL=qwen2.5:7b` measures another model.
