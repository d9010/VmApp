#!/usr/bin/env bash
# Builds, packs, installs, grants and runs the sample apps (apps/notes, hasher, todo, computer-use, terminal, local-llm, ollama,
# gpu-demo; ollama-desktop and vscode when their source builds exist)
# headless in REAL VMs, and asserts their behaviour with tests/apps/*.mjs. Prints PASS/FAIL per test; exits non-zero on any
# failure.
#
# Needs: out/ built by tools/build.sh, runtime images in out/runtimes/{native,node22,dotnet8}.img, the Rust musl
# toolchain (apps/hasher/build.sh, apps/terminal/build.sh), Docker (apps/todo/build.sh, apps/local-llm/build.sh; the smoke test of
# apps/ollama/build.sh) and, for apps/terminal/build.sh, node and npm with access to the npm registry (the checks of the Terminal
# that need the internet are skipped when generativelanguage.googleapis.com cannot be reached). The Local LLM test needs a model:
# it takes the smallest one from $VMAPP_WORK/cache/models (never committed) or downloads it from huggingface.co (about 470 MiB,
# once), and is skipped when neither is possible. Its GPU phase runs only when the `gpu` host capability is built
# (hostlib/capabilities.js and out/gpu/rpc-server).
# apps/ollama/build.sh downloads Ollama's release (1.5 GB, once, into $VMAPP_WORK/cache/ollama; needs curl, tar and zstd). The
# Ollama test pulls qwen2.5:0.5b (about 380 MiB) from registry.ollama.ai, keeps a copy under $VMAPP_WORK/cache/ollama-models
# (never committed) for runs without internet, and is skipped when neither is possible. Its GPU phase is another script,
# tests/apps/ollama-gpu.sh (the experimental Vulkan backend; apps/ollama/build.sh --with-vulkan first).
#   SKIP_BUILD=1  reuse apps/hasher/core, apps/todo/core, apps/terminal (core/bin, core/node_modules, ui/vendor),
#                 apps/local-llm/core/bin and apps/ollama/core/{bin,lib} from an earlier build
#   LOCAL_LLM_MODELS  Local LLM catalog ids to measure, comma separated (default qwen2.5-0.5b; add qwen2.5-1.5b, qwen2.5-7b for
#                 a CPU/GPU comparison that matters: the 0.5B model is too small to gain from the GPU)
#   VMAPP_KERNEL  boot another kernel Image (for example a candidate build) instead of out/Image
# Ollama (Desktop) (apps/ollama-desktop; Ollama and its React window built from source by apps/ollama-desktop/build.sh, Docker) is part of
# this run only when that build exists (and out/runtimes/node22-gpu.img): its two runs (ollama-desktop-main, ollama-desktop-persist)
# pull qwen2.5:0.5b through Ollama's own downloader. Its GPU phase is tests/apps/ollama-desktop-gpu.sh, its window test (the real loader
# over CDP) tests/apps/ollama-desktop-ui.mjs.
# Everything else lives under $VMAPP_WORK/apps (VMAPP_WORK defaults to vmapp/out/work, git-ignored).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
WORK="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)"
export VMAPP_HOME="$WORK/apps/home"
FIX="$WORK/apps/fixtures"
PKG="$WORK/apps/pkgs"
LOGS="$WORK/apps/logs"
export APPS_FIX="$FIX"

PASSES=0
FAILS=0
mkdir -p "$VMAPP_HOME" "$PKG" "$LOGS"

die() { echo "run-all: $*" >&2; exit 2; }

# ---- runtimes -------------------------------------------------------------------------------------------
for rt in native node22 dotnet8; do
  [ -f "$VMAPP/out/runtimes/$rt.img" ] || die "missing $VMAPP/out/runtimes/$rt.img (tools/mkruntime)"
  # reinstall when the built image changed (e.g. node22 after the SDK got `host`), not only when it is missing
  [ -f "$VMAPP_HOME/runtimes/$rt.img" ] && cmp -s "$VMAPP/out/runtimes/$rt.img" "$VMAPP_HOME/runtimes/$rt.img" && continue
  "$CLI" runtime-install "$rt" "$VMAPP/out/runtimes/$rt.img" || die "runtime-install $rt failed"
done

# ---- build + pack + install -----------------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== building hasher core (rust, musl)"
  "$VMAPP/apps/hasher/build.sh" > "$LOGS/build-hasher.log" 2>&1 || { tail -20 "$LOGS/build-hasher.log"; die "hasher build failed"; }
  echo "== building todo core (dotnet publish in docker)"
  "$VMAPP/apps/todo/build.sh" > "$LOGS/build-todo.log" 2>&1 || { tail -20 "$LOGS/build-todo.log"; die "todo build failed"; }
  echo "== building terminal (ptyd in rust, Gemini CLI from npm, xterm.js)"
  "$VMAPP/apps/terminal/build.sh" > "$LOGS/build-terminal.log" 2>&1 || { tail -20 "$LOGS/build-terminal.log"; die "terminal build failed"; }
  echo "== building local-llm (llama-server for linux-arm64 in docker)"
  "$VMAPP/apps/local-llm/build.sh" > "$LOGS/build-local-llm.log" 2>&1 || { tail -20 "$LOGS/build-local-llm.log"; die "local-llm build failed"; }
  echo "== building ollama (Ollama's release binary for linux-arm64, checked against its published SHA-256)"
  "$VMAPP/apps/ollama/build.sh" > "$LOGS/build-ollama.log" 2>&1 || { tail -20 "$LOGS/build-ollama.log"; die "ollama build failed"; }
fi
[ -f "$VMAPP/apps/hasher/core/hasher" ] || die "apps/hasher/core/hasher is missing"
[ -f "$VMAPP/apps/todo/core/Todo.dll" ] || die "apps/todo/core/Todo.dll is missing"
[ -f "$VMAPP/apps/terminal/core/bin/ptyd" ] || die "apps/terminal/core/bin/ptyd is missing (apps/terminal/build.sh)"
[ -f "$VMAPP/apps/terminal/core/node_modules/@google/gemini-cli/package.json" ] || die "the Gemini CLI is not installed in apps/terminal/core (apps/terminal/build.sh)"
[ -f "$VMAPP/apps/terminal/ui/vendor/xterm.js" ] || die "apps/terminal/ui/vendor/xterm.js is missing (apps/terminal/build.sh)"
[ -f "$VMAPP/apps/local-llm/core/bin/llama-server" ] || die "apps/local-llm/core/bin/llama-server is missing (apps/local-llm/build.sh)"
[ -f "$VMAPP/apps/ollama/core/bin/ollama" ] || die "apps/ollama/core/bin/ollama is missing (apps/ollama/build.sh)"

declare -a IDS=(notes:dev.vmapp.notes hasher:dev.vmapp.hasher todo:dev.vmapp.todo computer-use:dev.vmapp.deskhelper terminal:dev.vmapp.terminal local-llm:dev.vmapp.localllm ollama:dev.vmapp.ollama gpu-demo:dev.vmapp.particles)
# Ollama (Desktop) is built by apps/ollama-desktop/build.sh (Docker, minutes to an hour: Ollama and llama.cpp from source, the React app).
# It is part of this run only when that build exists; it runs on runtime node22-gpu (the normal backend: no GPU).
OLLAMA_DESKTOP=0
if [ -x "$VMAPP/apps/ollama-desktop/core/bin/ollama" ] && [ -f "$VMAPP/apps/ollama-desktop/ui/index.html" ] && [ -f "$VMAPP/out/runtimes/node22-gpu.img" ]; then
  OLLAMA_DESKTOP=1
  IDS+=(ollama-desktop:dev.vmapp.ollama.desktop)
  rt=node22-gpu
  if ! { [ -f "$VMAPP_HOME/runtimes/$rt.img" ] && cmp -s "$VMAPP/out/runtimes/$rt.img" "$VMAPP_HOME/runtimes/$rt.img"; }; then
    "$CLI" runtime-install "$rt" "$VMAPP/out/runtimes/$rt.img" || die "runtime-install $rt failed"
  fi
else
  echo "(Ollama (Desktop) is not built here: apps/ollama-desktop/build.sh, and out/runtimes/node22-gpu.img; its test is skipped)"
fi
# Code - OSS (VS Code 1.142.0) is built by apps/vscode/build.sh (Docker, about half an hour the first time: VS Code's server, its
# extensions and its web workbench from source). It is part of this run only when that build exists; it runs on runtime node22.
VSCODE=0
if [ -x "$VMAPP/apps/vscode/core/vscode/node" ] && [ -f "$VMAPP/apps/vscode/ui/index.html" ]; then
  VSCODE=1
  IDS+=(vscode:dev.vmapp.vscode)
else
  echo "(Code - OSS is not built here: apps/vscode/build.sh; its test is skipped)"
fi
for pair in "${IDS[@]}"; do
  app="${pair%%:*}"; id="${pair##*:}"
  "$CLI" pack "$VMAPP/apps/$app" -o "$PKG/$app.vmapp" > "$LOGS/pack-$app.log" 2>&1 || { cat "$LOGS/pack-$app.log"; die "pack $app failed"; }
  "$CLI" uninstall "$id" --purge > /dev/null 2>&1 || true # start from clean data and grants
  "$CLI" install "$PKG/$app.vmapp" > "$LOGS/install-$app.log" 2>&1 || { cat "$LOGS/install-$app.log"; die "install $app failed"; }
done

# ---- fixtures (fresh copies every run: the tests change them) --------------------------------------------
case "$FIX" in "$WORK"/apps/fixtures) ;; *) die "unexpected fixtures path $FIX" ;; esac
rm -rf "$FIX"
mkdir -p "$FIX/export" "$FIX/out" "$FIX/terminal-ws"
cp -R "$HERE/fixtures/notes" "$FIX/notes"
cp -R "$HERE/fixtures/import" "$FIX/import"
cp -R "$HERE/fixtures/hasher" "$FIX/hasher"
# the folder Code - OSS gets as "workspace": a README and a TypeScript file, as on a Mac
mkdir -p "$FIX/vscode-ws/src"
printf '# Hello\n\nA file from the Mac.\n' > "$FIX/vscode-ws/README.md"
printf 'export function greet(name: string): string {\n  const message = `Hello, ${name}!`;\n  return message;\n}\n' > "$FIX/vscode-ws/src/main.ts"

# ---- tests ------------------------------------------------------------------------------------------------
run_test() { # run_test NAME  vmapp-run-args...
  local name=$1; shift
  local log="$LOGS/$name.log"
  if "$CLI" run "$@" > "$log" 2>&1 && ! grep -q '^\[run\] failed' "$log"; then
    echo "PASS: $name"; PASSES=$((PASSES + 1))
  else
    echo "FAIL: $name  (log: $log)"; FAILS=$((FAILS + 1))
    tail -25 "$log" | sed 's/^/    | /'
  fi
}

echo "== notes"
"$CLI" grant dev.vmapp.notes notes "$FIX/notes" > /dev/null && \
"$CLI" grant dev.vmapp.notes export "$FIX/export" > /dev/null || die "grant failed"
run_test notes dev.vmapp.notes --headless --script "$HERE/notes.mjs" --open "$FIX/import/ideas.txt"

echo "== notes, folders declined (a fresh user: reset the app's data and grants first)"
"$CLI" uninstall dev.vmapp.notes --purge > /dev/null && "$CLI" install "$PKG/notes.vmapp" > /dev/null || die "reinstall notes failed"
"$CLI" grant dev.vmapp.notes notes --none > /dev/null && "$CLI" grant dev.vmapp.notes export --none > /dev/null || die "grant --none failed"
run_test notes-empty dev.vmapp.notes --headless --script "$HERE/notes-empty.mjs"

echo "== hasher"
run_test hasher dev.vmapp.hasher --headless --script "$HERE/hasher.mjs" --open "$FIX/hasher" --save "$FIX/out/hashes.txt"

echo "== todo (two runs)"
TODO_PHASE=1 run_test todo-run1 dev.vmapp.todo --headless --script "$HERE/todo.mjs"
TODO_PHASE=2 run_test todo-run2 dev.vmapp.todo --headless --script "$HERE/todo.mjs"

# Particles (apps/gpu-demo): the VM's half of the graphics showcase (scene stream at 30 Hz, deterministic physics, presets in /data,
# the CPU benchmark). No grants, no build step. Three runs share one app data folder. The window's half (WebGPU, frame rate) opens
# real windows and lives in apps/gpu-demo/test/webgpu-cdp.mjs, which this script does not run.
echo "== gpu-demo (three runs: scene stream and presets, persistence in a fresh VM, a corrupt presets file)"
GPU_DEMO_PHASE=1 run_test gpu-demo-run1 dev.vmapp.particles --headless --script "$HERE/gpu-demo.mjs"
GPU_DEMO_PHASE=2 run_test gpu-demo-run2 dev.vmapp.particles --headless --script "$HERE/gpu-demo.mjs"
GPU_DEMO_PHASE=3 run_test gpu-demo-run3 dev.vmapp.particles --headless --script "$HERE/gpu-demo.mjs"

# Desk Helper uses the host capabilities (SPEC 8.2). The host side is real (CLI catalog + grants, broker, /bin/echo, the
# fake MCP server) but vmapp-hostctl is replaced by a fake script and input is a dry run (VMAPP_HOSTCTL and
# VMAPP_HOSTCTL_DRYRUN are honoured only by unpackaged dev/test builds), so nothing touches the real desktop.
echo "== computer-use (fake hostctl, dry-run input; three runs: granted, declined, revoked)"
CU=dev.vmapp.deskhelper
NODE_BIN="$(command -v node)" || die "node not found"
CU_CTL_JSON="[\"$NODE_BIN\",\"$VMAPP/tests/unit/fixtures/fake-hostctl.js\"]"
"$CLI" tool remove echo > /dev/null 2>&1 || true
"$CLI" mcp remove fakemcp > /dev/null 2>&1 || true
"$CLI" tool add echo --name Echo --path /bin/echo --arg '^[\s\S]{0,200}$' --variadic > /dev/null && \
"$CLI" mcp add fakemcp --name "Fake MCP" -- "$NODE_BIN" "$VMAPP/tests/unit/fixtures/fake-mcp-server.js" > /dev/null && \
"$CLI" grant-host "$CU" screen > /dev/null && \
"$CLI" grant-host "$CU" input > /dev/null && \
"$CLI" grant-host "$CU" 'tool:*' --tools echo > /dev/null && \
"$CLI" grant-host "$CU" 'mcp:*' --servers fakemcp > /dev/null || die "computer-use catalog/grant setup failed"
rm -f "$LOGS/cu-ctl-granted.log" "$LOGS/cu-ctl-declined.log" "$LOGS/cu-ctl-revoked.log"
VMAPP_HOSTCTL="$CU_CTL_JSON" VMAPP_HOSTCTL_DRYRUN=1 CU_PHASE=granted FAKE_HOSTCTL_LOG="$LOGS/cu-ctl-granted.log" \
  run_test computer-use-granted "$CU" --headless --script "$HERE/computer-use.mjs" --allow-host
VMAPP_HOSTCTL="$CU_CTL_JSON" VMAPP_HOSTCTL_DRYRUN=1 CU_PHASE=declined FAKE_HOSTCTL_LOG="$LOGS/cu-ctl-declined.log" \
  run_test computer-use-declined "$CU" --headless --script "$HERE/computer-use.mjs"
"$CLI" grant-host "$CU" screen --revoke > /dev/null && "$CLI" grant-host "$CU" input --revoke > /dev/null && \
"$CLI" grant-host "$CU" 'tool:*' --revoke > /dev/null && "$CLI" grant-host "$CU" 'mcp:*' --revoke > /dev/null || die "computer-use revoke failed"
VMAPP_HOSTCTL="$CU_CTL_JSON" VMAPP_HOSTCTL_DRYRUN=1 CU_PHASE=revoked FAKE_HOSTCTL_LOG="$LOGS/cu-ctl-revoked.log" \
  run_test computer-use-revoked "$CU" --headless --script "$HERE/computer-use.mjs" --allow-host
"$CLI" tool remove echo > /dev/null 2>&1 || true
"$CLI" mcp remove fakemcp > /dev/null 2>&1 || true

# Terminal: a real shell and the real Gemini CLI on pseudo-terminals in the VM, the folder grant, the key's storage and the
# network allowlist against the real Google API host. Three runs share one app data folder: a fresh app without a key, the
# shell (which saves a dummy key), then the Gemini CLI with that key. No real API key is ever used.
echo "== terminal (three runs: fresh app without a key, shell + network, Gemini CLI with a dummy key)"
TERM_APP=dev.vmapp.terminal
TERMINAL_ONLINE=1
if ! curl -sS -m 8 -o /dev/null https://generativelanguage.googleapis.com/ 2>/dev/null; then
  TERMINAL_ONLINE=0
  echo "   (this machine cannot reach generativelanguage.googleapis.com: the checks that need the internet are skipped)"
fi
export TERMINAL_ONLINE
"$CLI" resources "$TERM_APP" --recommended > /dev/null || die "terminal: resources failed"
"$CLI" grant "$TERM_APP" workspace "$FIX/terminal-ws" > /dev/null || die "terminal: grant failed"
TERMINAL_PHASE=nokey run_test terminal-nokey "$TERM_APP" --headless --script "$HERE/terminal.mjs" --timeout 300000
"$CLI" grant-net "$TERM_APP" generativelanguage.googleapis.com > /dev/null || die "terminal: grant-net failed"
TERMINAL_PHASE=shell run_test terminal-shell "$TERM_APP" --headless --script "$HERE/terminal.mjs" --timeout 300000
TERMINAL_PHASE=key run_test terminal-key "$TERM_APP" --headless --script "$HERE/terminal.mjs" --timeout 400000

# Local LLM: llama.cpp's llama-server in a real VM, the model download through the allowlist proxy (or an import from the host's
# model cache), streamed chat and tokens/s on 4 vCPUs; then, when the `gpu` host capability exists, the same model on the Mac's
# GPU (ggml RPC) against the CPU in the same VM. Models are cached in $VMAPP_WORK/cache/models and are never committed.
echo "== local-llm (CPU in a real VM; then the Mac's GPU when the gpu capability is available)"
LLM_APP=dev.vmapp.localllm
LLM_CACHE="$WORK/cache/models"
mkdir -p "$LLM_CACHE"
LOCAL_LLM_ONLINE=1
if ! curl -sS -m 8 -o /dev/null https://huggingface.co/ 2>/dev/null; then
  LOCAL_LLM_ONLINE=0
  echo "   (this machine cannot reach huggingface.co: a model that is not in $LLM_CACHE cannot be downloaded, and the test is skipped)"
fi
export LOCAL_LLM_ONLINE LOCAL_LLM_CACHE="$LLM_CACHE"
"$CLI" resources "$LLM_APP" --cpus 4 --memory 4096 > /dev/null || die "local-llm: resources failed"
"$CLI" grant-net "$LLM_APP" huggingface.co > /dev/null && "$CLI" grant-net "$LLM_APP" us.aws.cdn.hf.co > /dev/null || die "local-llm: grant-net failed"
LOCAL_LLM_PHASE=cpu LOCAL_LLM_RESULTS="$WORK/apps/local-llm-cpu.json" \
  run_test local-llm-cpu "$LLM_APP" --headless --script "$HERE/local-llm.mjs" --timeout 3600000
if grep -qi gpu "$VMAPP/hostlib/capabilities.js" && [ -x "$VMAPP/out/gpu/rpc-server" ]; then
  "$CLI" grant-host "$LLM_APP" gpu > /dev/null || die "local-llm: grant-host gpu failed" # the GPU's only mode: allowed while the app runs
  LOCAL_LLM_PHASE=gpu LOCAL_LLM_RESULTS="$WORK/apps/local-llm-gpu.json" \
    run_test local-llm-gpu "$LLM_APP" --headless --script "$HERE/local-llm.mjs" --timeout 3600000
  "$CLI" grant-host "$LLM_APP" gpu --revoke > /dev/null || true
else
  echo "   (the gpu host capability is not built here: hostlib/capabilities.js and out/gpu/rpc-server; the GPU phase is skipped)"
fi

# Ollama: the real `ollama serve` in a real VM, pulling qwen2.5:0.5b from registry.ollama.ai through the allowlist proxy (cancelled,
# resumed, verified), the revoked-host path, streamed chat and tokens/s on 8 vCPUs. The pulled model is copied to
# $VMAPP_WORK/cache/ollama-models (never committed) so that a later run without internet can still chat.
echo "== ollama (CPU in a real VM; the GPU phase is tests/apps/ollama-gpu.sh)"
OLLAMA_APP=dev.vmapp.ollama
OLLAMA_CACHE="$WORK/cache/ollama-models"
mkdir -p "$OLLAMA_CACHE"
OLLAMA_ONLINE=1
if ! curl -sS -m 8 -o /dev/null https://registry.ollama.ai/ 2>/dev/null; then
  OLLAMA_ONLINE=0
  echo "   (this machine cannot reach registry.ollama.ai: a model that is not in $OLLAMA_CACHE cannot be pulled, and the test is skipped)"
fi
export OLLAMA_ONLINE OLLAMA_CACHE
"$CLI" resources "$OLLAMA_APP" --cpus 8 --memory 8192 > /dev/null || die "ollama: resources failed"
"$CLI" grant-net "$OLLAMA_APP" registry.ollama.ai > /dev/null && "$CLI" grant-net "$OLLAMA_APP" dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com > /dev/null || die "ollama: grant-net failed"
OLLAMA_PHASE=cpu OLLAMA_RESULTS="$WORK/apps/ollama-cpu.json" \
  run_test ollama-cpu "$OLLAMA_APP" --headless --script "$HERE/ollama.mjs" --timeout 3600000
# The GPU phase is a different app (apps/ollama-gpu: runtime node22-gpu, {cap:gpu, api:vulkan}, Ollama's Vulkan library) on the
# experimental backend: tests/apps/ollama-gpu.sh, which needs `apps/ollama/build.sh --with-vulkan` (Docker) first.
if [ -x "$VMAPP/out/krun/bin/vmapp-vm-krun" ] && [ -f "$VMAPP/out/runtimes/node22-gpu.img" ] && [ -f "$VMAPP/apps/ollama-gpu/core/lib/ollama/vulkan/libggml-vulkan.so" ]; then
  echo "   (the GPU phase is not part of this script: bash tests/apps/ollama-gpu.sh; everything it needs is built here)"
else
  echo "   (GPU phase: bash tests/apps/ollama-gpu.sh, after apps/ollama/build.sh --with-vulkan, gpu/krun/build.sh and the node22-gpu runtime; see apps/ollama/README.md, 'The GPU')"
fi

# Ollama (Desktop): Ollama's own desktop app (its Go backend and the React window) with Ollama v0.35.0 built from source; the streamed
# HTTP bridge; models pulled through Ollama's OWN downloader (cancel, resume, SHA-256) with exactly the three hosts of the manifest.
# Two runs share one app data folder: the first does everything, the second (a new VM) checks that chats, settings and the model persist.
if [ "$OLLAMA_DESKTOP" = 1 ]; then
  echo "== ollama-desktop (CPU in a real VM, runtime node22-gpu on the normal backend; two runs)"
  OD_APP=dev.vmapp.ollama.desktop
  OD_ONLINE_COM=1
  curl -sS -m 8 -o /dev/null https://ollama.com/ 2>/dev/null || OD_ONLINE_COM=0
  export OLLAMA_ONLINE OLLAMA_CACHE OLLAMA_COM_ONLINE="$OD_ONLINE_COM"
  "$CLI" resources "$OD_APP" --cpus 8 --memory 8192 > /dev/null || die "ollama-desktop: resources failed"
  "$CLI" grant-net "$OD_APP" registry.ollama.ai > /dev/null && "$CLI" grant-net "$OD_APP" dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com > /dev/null && \
    "$CLI" grant-net "$OD_APP" ollama.com > /dev/null || die "ollama-desktop: grant-net failed"
  OLLAMA_DESKTOP_PHASE=main OLLAMA_DESKTOP_RESULTS="$WORK/apps/ollama-desktop" \
    run_test ollama-desktop-main "$OD_APP" --headless --script "$HERE/ollama-desktop.mjs" --timeout 3600000
  OLLAMA_DESKTOP_PHASE=persist OLLAMA_DESKTOP_RESULTS="$WORK/apps/ollama-desktop" \
    run_test ollama-desktop-persist "$OD_APP" --headless --script "$HERE/ollama-desktop.mjs" --timeout 900000
fi

# Code - OSS: the VS Code Server and its built-in extensions in the VM, the window's WebSocket and HTTP bridges, VS Code's own protocol
# over them (tests/apps/vscode-remote.mjs), the terminal, git, the shared folder and its watcher, an extension from a VSIX, the refused
# network. Two runs share one app data folder and one shared folder: the second (a new VM) checks what the first left; a third runs with
# the folder declined. The window itself (the real loader over CDP) is tests/apps/vscode-ui.mjs.
if [ "$VSCODE" = 1 ]; then
  echo "== vscode (two runs)"
  "$CLI" resources dev.vmapp.vscode --cpus 2 --memory 3072 > /dev/null || die "vscode: resources failed"
  "$CLI" grant dev.vmapp.vscode workspace "$FIX/vscode-ws" > /dev/null || die "vscode: grant failed"
  VSCODE_PHASE=main VSCODE_WS="$FIX/vscode-ws" VSCODE_RESULTS="$WORK/apps/vscode" \
    run_test vscode-main dev.vmapp.vscode --headless --script "$HERE/vscode.mjs" --timeout 900000
  VSCODE_PHASE=persist VSCODE_WS="$FIX/vscode-ws" VSCODE_RESULTS="$WORK/apps/vscode" \
    run_test vscode-persist dev.vmapp.vscode --headless --script "$HERE/vscode.mjs" --timeout 600000
  # the network phase needs the internet (example.com, github.com): skipped when this Mac cannot reach them
  if curl -s -o /dev/null --max-time 10 https://github.com; then
    "$CLI" grant-net dev.vmapp.vscode '*' > /dev/null || die "vscode: grant-net failed"
    VSCODE_PHASE=network VSCODE_WS="$FIX/vscode-ws" VSCODE_RESULTS="$WORK/apps/vscode" \
      run_test vscode-network dev.vmapp.vscode --headless --script "$HERE/vscode.mjs" --timeout 600000
    "$CLI" grant-net dev.vmapp.vscode '*' --revoke > /dev/null || die "vscode: grant-net --revoke failed"
  else
    echo "(no internet: the vscode network phase is skipped)"
  fi
  "$CLI" grant dev.vmapp.vscode workspace --none > /dev/null || die "vscode: grant --none failed"
  VSCODE_PHASE=declined VSCODE_RESULTS="$WORK/apps/vscode" \
    run_test vscode-declined dev.vmapp.vscode --headless --script "$HERE/vscode.mjs" --timeout 300000
fi

# ---- the Node SDK's platform calls (tests/apps/sdk-probe: a test app, not a sample) --------------------------------------------
echo "== sdk-probe (the clipboard and port forwarding: allowed, then revoked)"
"$CLI" pack "$HERE/sdk-probe" -o "$PKG/sdk-probe.vmapp" > "$LOGS/pack-sdk-probe.log" 2>&1 || die "pack sdk-probe failed"
"$CLI" uninstall dev.vmapp.sdkprobe --purge > /dev/null 2>&1 || true
"$CLI" install "$PKG/sdk-probe.vmapp" > /dev/null || die "install sdk-probe failed"
"$CLI" grant-device dev.vmapp.sdkprobe clipboard > /dev/null || die "grant-device failed"
"$CLI" grant-device dev.vmapp.sdkprobe ports > /dev/null || die "grant-device ports failed"
VMAPP_HEADLESS_CLIPBOARD='copied on the Mac' SDK_PROBE_PHASE=allowed run_test sdk-probe-allowed dev.vmapp.sdkprobe --headless --script "$HERE/sdk-probe.mjs"
"$CLI" grant-device dev.vmapp.sdkprobe clipboard --revoke > /dev/null || die "grant-device --revoke failed"
"$CLI" grant-device dev.vmapp.sdkprobe ports --revoke > /dev/null || die "grant-device ports --revoke failed"
VMAPP_HEADLESS_CLIPBOARD='copied on the Mac' SDK_PROBE_PHASE=denied run_test sdk-probe-denied dev.vmapp.sdkprobe --headless --script "$HERE/sdk-probe.mjs"

# ---- package sizes ----------------------------------------------------------------------------------------
echo "== packages"
for pair in "${IDS[@]}"; do
  app="${pair%%:*}"
  echo "-- $app ($(wc -c < "$PKG/$app.vmapp" | tr -d ' ') bytes)"
  "$CLI" inspect "$PKG/$app.vmapp" | sed '/^manifest:/,$d' | sed 's/^/   /'
done

echo
echo "apps: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
