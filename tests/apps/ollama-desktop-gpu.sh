#!/usr/bin/env bash
# The GPU phase of the Ollama (Desktop) test (EXPERIMENTAL Vulkan backend, SPEC 8.7): the same app, dev.vmapp.ollama.desktop (runtime
# node22-gpu, {cap:gpu, api:vulkan}), in a real VM on `vmapp-vm-krun`. Ollama (built from source for this app) must find the Venus GPU,
# run a model on it (size_vram > 0) and ANSWER CORRECTLY, through Ollama's API and through the UI backend's chat endpoint.
# The CPU phases and the other sample apps are tests/apps/run-all.sh.
#
#   bash tests/apps/ollama-desktop-gpu.sh
#
# Needs (a missing one is named with its fix command, exit status 2; nothing is built here): the same as tests/apps/ollama-gpu.sh
# (out/krun, out/Image-gpu, out/runtimes/node22-gpu.img, out/vmapp-vm, out/Image, out/initramfs.cpio) and apps/ollama-desktop built by
# apps/ollama-desktop/build.sh (with --vulkan-lib). The model (qwen2.5:0.5b) comes from $VMAPP_WORK/cache/ollama-models or is pulled.
# Results: $VMAPP_WORK/apps/ollama-desktop.gpu.json; the log: $VMAPP_WORK/apps/logs/ollama-desktop-gpu.log.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
WORK="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)"
export VMAPP_HOME="$WORK/apps/home"
export APPS_FIX="$WORK/apps/fixtures"
PKG="$WORK/apps/pkgs"
LOGS="$WORK/apps/logs"
ID=dev.vmapp.ollama.desktop
mkdir -p "$VMAPP_HOME" "$PKG" "$LOGS" "$APPS_FIX" "$WORK/apps/tmp" "$WORK/cache/ollama-models"
export TMPDIR="$WORK/apps/tmp" # the launcher puts a padded copy of the core image and the VMM's run folder here

MISSING=0
need() {
  [ -e "$1" ] && return 0
  echo "missing ${1#"$VMAPP"/}" >&2
  echo "    fix: $2" >&2
  MISSING=1
}
need "$VMAPP/out/krun/bin/vmapp-vm-krun" "gpu/krun/build.sh"
need "$VMAPP/out/Image-gpu" "kernel/build.sh --flavour gpu   (needs Docker)"
need "$VMAPP/out/runtimes/node22-gpu.img" "tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img   (needs Docker)"
for f in vmapp-vm Image initramfs.cpio; do need "$VMAPP/out/$f" "tools/build.sh"; done
need "$VMAPP/apps/ollama-desktop/core/bin/ollama" "apps/ollama-desktop/build.sh --vulkan-lib FILE   (needs Docker)"
need "$VMAPP/apps/ollama-desktop/core/lib/ollama/vulkan/libggml-vulkan.so" "apps/ollama-desktop/build.sh --vulkan-lib FILE   (the library comes from apps/ollama/vulkan/build-vulkan.sh)"
[ "$MISSING" = 0 ] || { echo "tests/apps/ollama-desktop-gpu.sh: nothing was run; create the files above first" >&2; exit 2; }
command -v node >/dev/null || { echo "node is needed (Node.js 22)" >&2; exit 2; }
die() { echo "ollama-desktop-gpu: $*" >&2; exit 2; }

RT="$VMAPP/out/runtimes/node22-gpu.img"
if ! { [ -f "$VMAPP_HOME/runtimes/node22-gpu.img" ] && cmp -s "$RT" "$VMAPP_HOME/runtimes/node22-gpu.img"; }; then
  "$CLI" runtime-install node22-gpu "$RT" || die "runtime-install node22-gpu failed"
fi
"$CLI" pack "$VMAPP/apps/ollama-desktop" -o "$PKG/ollama-desktop.vmapp" > "$LOGS/pack-ollama-desktop.log" 2>&1 || { cat "$LOGS/pack-ollama-desktop.log"; die "pack failed"; }
"$CLI" uninstall "$ID" --purge > /dev/null 2>&1 || true
"$CLI" install "$PKG/ollama-desktop.vmapp" > "$LOGS/install-ollama-desktop.log" 2>&1 || { cat "$LOGS/install-ollama-desktop.log"; die "install failed"; }
"$CLI" resources "$ID" --cpus 8 --memory 8192 > /dev/null || die "resources failed"
for h in registry.ollama.ai dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com ollama.com; do "$CLI" grant-net "$ID" "$h" > /dev/null || die "grant-net $h failed"; done
"$CLI" grant-host "$ID" gpu --mode session > /dev/null || die "grant-host gpu failed" # SPEC 8.7 switch 2

OLLAMA_ONLINE=1
curl -sS -m 8 -o /dev/null https://registry.ollama.ai/ 2>/dev/null || OLLAMA_ONLINE=0
export OLLAMA_ONLINE OLLAMA_CACHE="$WORK/cache/ollama-models" OLLAMA_COM_ONLINE=0

echo "== ollama-desktop on the Vulkan backend (real VM)"
LOG="$LOGS/ollama-desktop-gpu.log"
OLLAMA_DESKTOP_PHASE=gpu OLLAMA_DESKTOP_RESULTS="$WORK/apps/ollama-desktop" \
  "$CLI" run "$ID" --headless --experimental-gpu --script "$HERE/ollama-desktop.mjs" --timeout 3600000 > "$LOG" 2>&1
RC=$?
if [ "$RC" -eq 0 ] && ! grep -q '^\[run\] failed' "$LOG" && grep -q 'EXPERIMENTAL: the app runs on the Vulkan GPU backend' "$LOG"; then
  echo "PASS: ollama-desktop-gpu"
  grep -E '^  ok' "$LOG" | cut -c1-240 | sed 's/^/  /'
  exit 0
fi
echo "FAIL: ollama-desktop-gpu  (log: $LOG)"
if [ "$RC" -eq 0 ] && ! grep -q 'EXPERIMENTAL: the app runs on the Vulkan GPU backend' "$LOG"; then
  echo "    the run did not use the Vulkan backend. Its log says why:"
  grep -E 'asks for the Vulkan GPU|not found|not installed' "$LOG" | head -5 | sed 's/^/    | /'
fi
grep -v '\[emit\]' "$LOG" | tail -25 | cut -c1-300 | sed 's/^/    | /'
exit 1
