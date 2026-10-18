#!/usr/bin/env bash
# The GPU phase of the Ollama test (EXPERIMENTAL Vulkan backend, SPEC 8.7): packs, installs and grants the Ollama (GPU) app
# (apps/ollama-gpu, dev.vmapp.ollama.gpu) and runs tests/apps/ollama.mjs with OLLAMA_PHASE=gpu in a real VM on `vmapp-vm-krun`:
# Ollama must find the Venus GPU, run a model on it (size_vram > 0), measure tokens/s, then run the same model on the VM's CPUs.
# The CPU phase and the rest of the sample apps are tests/apps/run-all.sh.
#
#   bash tests/apps/ollama-gpu.sh
#
# Needs (a missing one is named with its fix command, exit status 2; nothing is built here):
#   out/krun/bin/vmapp-vm-krun   gpu/krun/build.sh                                  (libkrun, virglrenderer, MoltenVK, the launcher)
#   out/Image-gpu                kernel/build.sh --flavour gpu                       (Docker)
#   out/runtimes/node22-gpu.img  tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img   (Docker)
#   out/vmapp-vm, out/Image, out/initramfs.cpio   tools/build.sh
#   apps/ollama-gpu/core         apps/ollama/build.sh --with-vulkan                  (Docker; Ollama's release plus the Vulkan backend)
# The model (qwen2.5:0.5b, 380 MiB) comes from $VMAPP_WORK/cache/ollama-models if run-all.sh or an earlier run left it there, else it
# is pulled from registry.ollama.ai through the allowlist proxy (the test checks that only the manifest's two hosts are contacted).
# Environment: VMAPP_WORK (default out/work), OLLAMA_MODEL (another model, for example qwen2.5:7b with 8 GB of VM memory is fine).
# Results: $VMAPP_WORK/apps/ollama-gpu.json; the log of the run: $VMAPP_WORK/apps/logs/ollama-gpu.log.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
WORK="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)"
export VMAPP_HOME="$WORK/apps/home"
PKG="$WORK/apps/pkgs"
LOGS="$WORK/apps/logs"
ID=dev.vmapp.ollama.gpu
mkdir -p "$VMAPP_HOME" "$PKG" "$LOGS" "$WORK/apps/tmp" "$WORK/cache/ollama-models"
# the launcher puts a padded copy of the core image and the VMM's run folder here: not the system volume
export TMPDIR="$WORK/apps/tmp"

MISSING=0
need() { # need FILE FIX
  [ -e "$1" ] && return 0
  echo "missing ${1#"$VMAPP"/}" >&2
  echo "    fix: $2" >&2
  MISSING=1
}
need "$VMAPP/out/krun/bin/vmapp-vm-krun" "gpu/krun/build.sh"
need "$VMAPP/out/Image-gpu" "kernel/build.sh --flavour gpu   (needs Docker)"
need "$VMAPP/out/runtimes/node22-gpu.img" "tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img   (needs Docker)"
for f in vmapp-vm Image initramfs.cpio; do need "$VMAPP/out/$f" "tools/build.sh"; done
need "$VMAPP/apps/ollama-gpu/core/bin/ollama" "apps/ollama/build.sh --with-vulkan   (needs Docker)"
need "$VMAPP/apps/ollama-gpu/core/lib/ollama/vulkan/libggml-vulkan.so" "apps/ollama/build.sh --with-vulkan   (needs Docker; or apps/ollama/vulkan/build-vulkan.sh)"
[ "$MISSING" = 0 ] || { echo "tests/apps/ollama-gpu.sh: nothing was run; create the files above first" >&2; exit 2; }
command -v node >/dev/null || { echo "node is needed (Node.js 22)" >&2; exit 2; }

die() { echo "ollama-gpu: $*" >&2; exit 2; }

# ---- the runtime, the package, the grants ------------------------------------------------------------------------------------
RT="$VMAPP/out/runtimes/node22-gpu.img"
if ! { [ -f "$VMAPP_HOME/runtimes/node22-gpu.img" ] && cmp -s "$RT" "$VMAPP_HOME/runtimes/node22-gpu.img"; }; then
  "$CLI" runtime-install node22-gpu "$RT" || die "runtime-install node22-gpu failed"
fi
"$CLI" pack "$VMAPP/apps/ollama-gpu" -o "$PKG/ollama-gpu.vmapp" > "$LOGS/pack-ollama-gpu.log" 2>&1 || { cat "$LOGS/pack-ollama-gpu.log"; die "pack failed"; }
"$CLI" uninstall "$ID" --purge > /dev/null 2>&1 || true # start from clean data and grants
"$CLI" install "$PKG/ollama-gpu.vmapp" > "$LOGS/install-ollama-gpu.log" 2>&1 || { cat "$LOGS/install-ollama-gpu.log"; die "install failed"; }
"$CLI" resources "$ID" --cpus 8 --memory 8192 > /dev/null || die "resources failed"
"$CLI" grant-net "$ID" registry.ollama.ai > /dev/null && "$CLI" grant-net "$ID" dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com > /dev/null || die "grant-net failed"
# SPEC 8.7 switch 2: the user allows the experimental Vulkan GPU for this app ("Allow while the app runs"); the grant records api vulkan.
"$CLI" grant-host "$ID" gpu --mode session > /dev/null || die "grant-host gpu failed"

OLLAMA_ONLINE=1
if ! curl -sS -m 8 -o /dev/null https://registry.ollama.ai/ 2>/dev/null; then
  OLLAMA_ONLINE=0
  echo "(this machine cannot reach registry.ollama.ai: a model that is not in $WORK/cache/ollama-models cannot be pulled)"
fi
export OLLAMA_ONLINE OLLAMA_CACHE="$WORK/cache/ollama-models"

# ---- the run: switch 3 is --experimental-gpu (the loader setting "Experimental GPU (Vulkan)") --------------------------------------
echo "== ollama (GPU) in a real VM on the Vulkan backend"
LOG="$LOGS/ollama-gpu.log"
rm -f "$WORK/apps/ollama-gpu.json"
OLLAMA_PHASE=gpu OLLAMA_RESULTS="$WORK/apps/ollama-gpu.json" \
  "$CLI" run "$ID" --headless --experimental-gpu --script "$HERE/ollama.mjs" --timeout 3600000 > "$LOG" 2>&1
RC=$?
if [ "$RC" -eq 0 ] && ! grep -q '^\[run\] failed' "$LOG" && grep -q 'EXPERIMENTAL: the app runs on the Vulkan GPU backend' "$LOG"; then
  echo "PASS: ollama-gpu"
  [ -f "$WORK/apps/ollama-gpu.json" ] && node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const f = (x) => (x && x.tps ? x.tps.toFixed(1) : "?");
    console.log(`  ${r.model}: GPU ${f(r.gpu)} tokens/s, CPU ${f(r.cpu)} tokens/s in the same VM; prompt ${r.gpu && r.gpu.promptTps ? r.gpu.promptTps.toFixed(0) : "?"} vs ${r.cpu && r.cpu.promptTps ? r.cpu.promptTps.toFixed(0) : "?"} tokens/s; device ${r.gpu && r.gpu.device ? r.gpu.device.name : "?"}; host load ${r.hostLoadAtStart}`);
  ' "$WORK/apps/ollama-gpu.json"
  exit 0
fi
echo "FAIL: ollama-gpu  (log: $LOG)"
if [ "$RC" -eq 0 ] && ! grep -q 'EXPERIMENTAL: the app runs on the Vulkan GPU backend' "$LOG"; then
  echo "    the run did not use the Vulkan backend. Its log says why:"
  grep -E 'asks for the Vulkan GPU|not found|not installed' "$LOG" | head -5 | sed 's/^/    | /'
fi
tail -25 "$LOG" | sed 's/^/    | /'
exit 1
