# gpu/: the host side of the GPU capability (phase B, llama.cpp RPC remoting)

The rules are [SPEC §8.6](../SPEC.md) and [GOVERNANCE INV-H7](../GOVERNANCE.md); for users and app developers, read
[docs/HOST-CAPABILITIES.md §9](../docs/HOST-CAPABILITIES.md). This folder holds what builds and confines the server.

| File | What |
|---|---|
| `pins.env` | **The single source of truth for the llama.cpp version**: tag, commit, release date, RPC protocol version, the CMake target. The host server is built from it, and an app's llama.cpp client (in the VM) must be built from **the same commit**. Plain `KEY=VALUE` lines; read it, never `source` it. |
| `build.sh` | `gpu/build.sh [--client] [--force] [--check]`: shallow-clones the pinned tag into `$VMAPP_WORK/cache/`, **refuses a checkout whose commit is not the pinned one** (and a source whose protocol version differs from `RPC_PROTO_VERSION`), builds `ggml-rpc-server` with Metal and RPC, writes `out/gpu/{rpc-server, rpc-server.sb, BUILD-INFO.txt, LICENSE-llama.cpp.txt}`. `--client` also builds a CPU-only `llama-completion` and `llama-bench` from the same commit into `$VMAPP_WORK/gpu-client/bin` (what `tests/gpu/` connects with). Needs cmake and Xcode's command-line tools, no Docker. |
| `rpc-server.sb` | The sandbox profile the server runs under (`sandbox-exec`). A closed list of rules; `tools/check-invariants` (rule `h7-gpu-service`) fails on any other. |
| `krun/` | **Not part of this capability:** the EXPERIMENTAL Vulkan backend (SPEC §8.7, INV-H8): pinned host libraries (libkrun, virglrenderer/Venus, MoltenVK, libepoxy), the VMM's sandbox profile and the build of the launcher `vmapp-vm-krun`. Opt-in, per app, behind a loader setting. See [krun/README.md](krun/README.md). |
| `venus-spike/` | The research behind `krun/`: the phase A prototype, its report ([REPORT.md](venus-spike/REPORT.md)) and evidence. Research only. |

## Updating the pin

1. Choose a release tag at least 14 days old; read the commit with `git ls-remote https://github.com/ggml-org/llama.cpp.git refs/tags/<tag>`.
2. Set `LLAMA_CPP_TAG`, `LLAMA_CPP_COMMIT`, `LLAMA_CPP_TAG_DATE` and `RPC_PROTO_VERSION` (from `ggml/include/ggml-rpc.h`) in `pins.env`,
   and `RPC_SERVER_TARGET` if upstream renamed it.
3. `gpu/build.sh --client` then `tests/gpu/run.sh` and `node --test tests/gpu/vm-rpc.test.js`.
4. If the protocol **major** version changed, every app's client must move to the new commit: say so in the change.

## The sandbox, in one paragraph

`sandbox-exec -f rpc-server.sb -D BIN=… -D BINDIR=… -D PORT=… [-D METAL_CACHE=…] rpc-server --host 127.0.0.1 --port PORT --device MTL0`.
Deny by default; the program, its folder (read-only); one loopback TCP port; the GPU's IOKit user clients; the Metal shader compiler;
and (only when `METAL_CACHE` is given) read-write on `<cache>/com.apple.metal`. `tests/gpu/host-rpc.mjs` checks, with this same profile, that
a program in it cannot write a file, read the user's files, start another program, connect out or bind another port.

Why the shader cache: the server embeds its Metal shaders as source and macOS compiles them when it starts (10 to 15 seconds). Compiled
results are cached in the user's `com.apple.metal` folder, which makes later starts take a fraction of a second, but writing it needs
write access there (a read-only view does not work, measured). A private cache would need a precompiled `.metallib`
(`-DGGML_METAL_EMBED_LIBRARY=OFF` plus Apple's offline Metal compiler); that is the documented follow-up.
