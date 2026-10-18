# Local LLM (`dev.vmapp.localllm`, runtime `node22`)

A chat window for a language model that runs **inside the app's VM**: llama.cpp's `llama-server`, started by a small Node core.
Your conversation never leaves your Mac. The only thing the app asks the network for is the model file, and it can optionally
hand the heavy maths to **the Mac's GPU** through the `gpu` host capability.

It is the sample that shows the "local backend" idea of [docs/VISION.md](../../docs/VISION.md) (sections 2 and 4) with real numbers.

## What you can do

- **Download a model** from a short curated list (`core/models.json`): Qwen2.5 0.5B, Llama 3.2 1B, Qwen2.5 1.5B and Qwen2.5 7B, all
  Q4_K_M. Every entry has its exact URL (pinned to a commit of the Hugging Face repository), size and SHA-256. The download goes
  through the allowlist proxy, can be cancelled and resumed, and is stored only if the size and the SHA-256 match.
- **Import a model file** you already have (`Import a model file…`, a native open dialog): the file is checked for the GGUF
  magic number and copied into the app's private data (`/data/models`). Drop in any GGUF that llama.cpp can load.
- **Chat** with streaming replies, a Stop button, a system prompt, temperature, reply length and context size, and the generation
  speed in **tokens per second** (from llama-server's own timings) under every reply and in the status line.
- **Use the Mac's GPU**: a switch that is disabled, with the reason, until the app has the GPU permission.

## The safety story

| What the app (or the model, or a hostile prompt) could do | What actually happens |
|---|---|
| Read your files | The app asks for **no folder**. It sees only its own data (`/data`: the models and `settings.json`) and, through the open dialog, the one file you pick. |
| Send your conversation somewhere | The VM has no network device. The only way out is the host's allowlist proxy, and the app asks for exactly two hosts, both for the model download: **`huggingface.co`** and **`us.aws.cdn.hf.co`** (where Hugging Face redirects the file; see "The network" below). `llama-server` itself uses no network: it listens on the VM's `127.0.0.1:8080` (only the core reaches it) and, only with the GPU switched on, connects to the GPU tunnel on `127.0.0.1:50052`. |
| Run code through the model | `llama-server` starts without tools, MCP and the web UI (`--tools` is off by default). The window can send only a fixed, validated chat request (roles, strings, temperature and length within limits) to it, never an arbitrary path or body. |
| Use your GPU behind your back | Needs the `gpu` host capability: off until you grant it, and used only while "Use the Mac's GPU" is on. |
| Fill your disk | Models are stored in the app's data folder; a download or import checks the free space first, and *Reset app* in the loader deletes them. |

What this does **not** protect against: a model is a program too. A GGUF file you import is parsed by `llama-server` inside the VM
(a malicious file could crash it, or, in the worst case, exploit it, and the VM is what contains that). Prefer the curated list.

## The GPU path, and its honest limits

```
chat window ──► core (node) ──HTTP──► llama-server (VM, CPU backend + RPC client)
                                              │  ggml RPC over 127.0.0.1:50052   ($VMAPP_GPU_RPC, set only when granted)
                                              ▼
                              the guest's host-service tunnel ──► the host's rpc-server (Metal) ──► the Mac's GPU
```

With the grant and the switch on, the core starts `llama-server --rpc $VMAPP_GPU_RPC -ngl 99`: the weights and the KV cache live
in the **host's** memory on the Mac's GPU, and the VM sends tensors and a compute graph for every token. Linux has no Metal, so
nothing in the VM could call the GPU directly: this is API remoting at the framework level (VISION.md section 4, option B).

What you should know before relying on it:

- **It only works with software that speaks ggml RPC.** `llama-server` does; **Ollama does not** (it has its own runner and no
  RPC backend), so an Ollama-based app cannot use this path unless it is rebuilt around llama.cpp's server.
- **The VM and the host must run the same llama.cpp.** The RPC protocol is versioned. `build.sh` reads the pin from
  `vmapp/gpu/pins.env` (one commit for the host's `rpc-server` and for this app's `llama-server`) and checks the protocol version of
  the source it builds.
- **RPC has a per-token cost.** Every generated token is a round trip through the VM, the tunnel and the host (and the token's
  logits, hundreds of kilobytes, come back to the VM, because sampling runs in `llama-server`: the Inspector's `gpu` rows count the
  bytes). That puts a floor of several milliseconds under each token. A small model that the VM's 4 vCPUs already run fast gains
  nothing from the GPU (see the numbers below). The GPU pays off when the model is big, which gives it more maths per token to hide the
  round trip in, and for long prompts, which are processed in large batches.
- **Model size against memory.** On the CPU the weights are mapped into the VM's memory, so a model must fit in it (this app
  recommends 4096 MB). With the GPU the weights live on the Mac instead, so a 4.7 GB model runs in a 4 GB VM, but the Mac must have the
  memory for it (Metal allows about 75% of unified memory).
- **Load time.** The weights travel to the host once, at load; the first load of a big model takes a while.
- **The attack surface is on the host.** The host's `rpc-server` processes commands from an untrusted VM. llama.cpp itself calls the
  RPC server a proof of concept: "fragile and insecure". That is why the capability is opt-in, why the server is the loader's own
  process, one per app run, inside a macOS sandbox that allows one loopback port and the GPU, and why it must be kept current (SPEC
  8.6, docs/HOST-CAPABILITIES.md). There is no cap on GPU memory or time: an allowed app can use as much as macOS allows, which is
  the whole point and the whole risk. Revoking the permission, or stopping the app, stops the server.
- **CPU build.** `llama-server` is built for `armv8.2-a+fp16+dotprod`. Virtualization.framework does not expose the M2+'s int8
  matrix-multiply instructions to the guest, so a build that needs them would not be correct to run there.

### Numbers

Measured by `tests/apps/local-llm.mjs` in a real VM on an Apple M4 Max Mac (16 cores, 128 GB) on 2026-10-15: 4 vCPUs, context 4096,
greedy sampling, tokens per second as reported by llama-server's own timings (generation: median of 5 runs of 128 tokens, 2 runs of
64 for the 7B model; prompt: a new 500-token prompt, nothing cached). CPU and GPU of one model were measured in the same VM.

**Reproduce them:** `tools/bench llm --models qwen2.5-0.5b,qwen2.5-1.5b,qwen2.5-7b` ([docs/BENCHMARKS.md](../../docs/BENCHMARKS.md) §6;
it downloads the models by the URLs and SHA-256 of `core/models.json`). Re-measured that way the same evening (median of 5 runs,
the Mac not idle): the CPU rows and the GPU prompt-processing rows came out within about 10% of this table, the 0.5B and 1.5B GPU
generation rows were 184 and 157 tok/s, and the 7B GPU generation rows were 66, 77, 75 and 79 tok/s in four runs (this table's 78.1
is near the top of that range).

| Model (Q4_K_M) | Where it runs | Generation | Prompt processing | Load |
|---|---|---|---|---|
| Qwen2.5 0.5B (0.5 GB) | VM CPU, 4 vCPUs | 183 tok/s | 322 tok/s | 0.6 s |
| | Mac GPU through RPC | 201 tok/s | 8,530 tok/s | 2.1 s |
| Qwen2.5 1.5B (1.1 GB) | VM CPU, 4 vCPUs | 120 tok/s | 237 tok/s | 1.3 s |
| | Mac GPU through RPC | 162 tok/s | 3,541 tok/s | 3.6 s |
| Qwen2.5 7B (4.7 GB) | VM CPU, 4 vCPUs, **8 GB** VM | 29.9 tok/s | 53 tok/s | 5.0 s |
| | Mac GPU through RPC, 4 GB VM | 78.1 tok/s | 855 tok/s | 17.9 s |

What to read from it:

- **Generation:** the GPU is no faster for the 0.5B model (the CPU does 183 tok/s and each token waits for an RPC round trip), about
  1.3 to 1.6 times faster for the 1.5B model, and **2.6 times** faster for the 7B model. GPU generation varies by about 20% from run
  to run (the round trips); the CPU's is steadier.
- **Prompt processing** is where the GPU wins most: 26 times for the 0.5B model, 15 times for the 1.5B, 16 times for the 7B. A long
  prompt (a document, a long conversation) is where you feel it.- **The 7B model needs 8 GB on the CPU** (the row above uses an 8 GB VM) and does not fit the 4 GB the app recommends; on the GPU it
  runs in the default 4 GB VM because the weights live on the Mac.
- These are one Mac's numbers: a base M1 has fewer cores and less memory bandwidth, on both sides of the comparison.

## How it works

```
window (ui/)                      core (node, in the VM)                          llama-server (in the VM)
  llm:download ───────────────────► models.js: fetch via the proxy, resume, sha256
  llm:import ─────dialog──────────► models.js: copy /host/pick-N/x.gguf → /data/models
  llm:load ───────────────────────► llama.js: spawn llama-server -m … --threads N -c ctx [--rpc … -ngl 99]
  ◄─────────────── llm:status ───── waits for /health; reads the load log: is a model buffer on an RPC device?
  llm:chat ───────────────────────► llama.js: POST /v1/chat/completions (stream) ──► tokens
  ◄───────── llm:token, llm:done ── SSE → batches of about 30 ms; tokens per second from the final `timings`
```

- `core/models.js` is the model store (catalog, downloads, imports). `core/llama.js` runs and talks to llama-server.
  `core/main.js` is the bridge (its header lists every channel).
- `ui/` is plain HTML, CSS and JavaScript: no libraries, no inline scripts, text built with DOM nodes (never `innerHTML`).
- llama-server is started with `-np 1` (the whole context is for one conversation), `--cache-ram 256` and `-lv 4`: this llama.cpp
  prints the devices and buffers (the proof of where the model runs) only at verbosity 4.
- The core decides what the window may do; for example `llm:delete` refuses the model that is loaded, and a model name is looked up
  in `/data/models`, never used as a path.

## The network

| Host | Why |
|---|---|
| `huggingface.co` | The model's download address. It answers with a redirect. |
| `us.aws.cdn.hf.co` | Where Hugging Face's redirect sends the file (checked on 2026-10-15 for all four catalog files: one redirect, to this host). |

The download follows the redirect by hand, so a host that is not allowed is named in the error ("Could not connect to <host>…"). If
Hugging Face one day serves a file from another host, a download fails that way and the manifest needs that host (an update that adds
a host always stops at the user's "asks for more" sheet). Find the host with `vmapp run --headless` (it prints a `[net] DENIED
host:port` line) or the Inspector's `net` rows, and add it with its purpose. Other model sources are not supported: import a file
you downloaded yourself.

## Adding models

1. Pick a GGUF on Hugging Face (a single file; split files are not supported). Use the **commit-pinned** URL
   (`https://huggingface.co/<repo>/resolve/<commit>/<file>`): the file at that URL can never change.
2. Get its size and SHA-256 from `https://huggingface.co/api/models/<repo>/tree/<commit>` (`size` and `lfs.oid`).
3. Add an entry to `core/models.json` (`id`, `name`, `quant`, `file`, `bytes`, `sha256`, `url`, `license`, `note`). A model whose
   file is served from a host other than `us.aws.cdn.hf.co` needs that host in `vmapp.json` too (bump the app version).
4. Or skip all that: **Import a model file…** takes any GGUF llama.cpp can load.

## Build, pack, run

```
vmapp/apps/local-llm/build.sh                     # llama-server for linux-arm64, in a digest-pinned Debian bookworm container
vmapp/tools/vmapp pack vmapp/apps/local-llm -o local-llm.vmapp
vmapp/tools/vmapp install local-llm.vmapp         # then open the D9010 VmApp Launcher, Launch; set the VM to 4 vCPUs on the card
vmapp/tests/apps/run-all.sh                       # builds everything and runs the tests of all sample apps, Local LLM included
```

`build.sh` needs Docker only. It builds llama.cpp at the commit in `gpu/pins.env` (a commit id is verified, not a tag), with the
Debian archive pinned by snapshot date (`pins.env`), static libstdc++ and no OpenMP, so the binary needs only `libc` and `libm`
(the node22 runtime is Debian bookworm too). The result is `core/bin/llama-server` (12 MB, git-ignored) plus llama.cpp's licence
and a `BUILD-INFO.txt`. A rebuild from scratch (`build.sh --no-cache`) gives the same binary, byte for byte. The package is about 12 MiB,
almost all of it `llama-server`; `/app` lives in the VM's memory.

The VM size is the user's choice (SPEC 8.5): the manifest recommends 4 vCPUs and 4096 MB, and a user who changes nothing gets one
vCPU, which is slow for this app. `llama-server` uses every vCPU the VM has.

## Tests

`vmapp/tests/apps/local-llm.mjs` runs in a real VM (`LOCAL_LLM_PHASE=cpu`, then `gpu` when the capability exists; started by
`tests/apps/run-all.sh`):

- the catalog, the guards (path traversal in load/delete, bad chat messages, a non-GGUF import, a cancelled dialog);
- getting the model: from `$VMAPP_WORK/cache/models` through the import path (fast, repeatable) or, the first time, a real
  download through the proxy that is cancelled halfway, **resumed**, and verified (size and SHA-256 computed on the host, and the
  hosts contacted must be exactly the two in the manifest). Models are never committed;
- loading, a streamed reply, three measured generations (median tokens/s), the Stop button, Unload;
- the GPU phase: the log shows the RPC device and the weights on it, the same model on the CPU in the same VM, and the speed ratio.

Without internet and without a cached model the test prints `SKIP` and passes. `LOCAL_LLM_MODELS=qwen2.5-0.5b,qwen2.5-1.5b,qwen2.5-7b`
measures more models (the first one is also used for the download, Stop and guard checks).
