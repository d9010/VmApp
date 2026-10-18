#!/usr/bin/env bash
# Builds the Vulkan GPU test core (EXPERIMENTAL; tests/gpu-vulkan/core) into out/test/gpu-vulkan-core.cpio.
#
#   tests/gpu-vulkan/build-core.sh [--no-cache]
#
# 1. docker build --platform linux/arm64 --target app of tests/gpu-vulkan/core/Dockerfile (pinned base, vulkaninfo, vkpeak, llama-bench
#    with Vulkan, vk-spin, vk-offscreen-tri; needs Docker and network access the first time, then the Docker layer cache), exporting
#    only /app to $VMAPP_WORK/gpu-vulkan-core/export.
# 2. mkcpio packs that folder as a core.cpio (the cpio root is /app inside the VM): /app/gpu-test.sh <mode>, see its header.
#
# The tools link only against libraries that runtime node22-gpu has (libvulkan.so.1, libstdc++, libgcc_s, libgomp, libm, libc), so
# the harness needs no LD_LIBRARY_PATH (gpu-test.sh sets one for llama-bench's own libraries in /app/llama).
# Build the runtime with:  tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img
#
# Environment: VMAPP_WORK (scratch folder, default vmapp/out/work), CARGO_TARGET_DIR (where mkcpio is built, default $VMAPP_WORK/target),
# and the Rust variables of tools/lib/rust-env.sh (only used when mkcpio has to be built).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$SELF_DIR/../.." && pwd)"
CORE="$SELF_DIR/core"
OUT="$VMAPP/out/test/gpu-vulkan-core.cpio"
PLATFORM="linux/arm64"
die() { printf 'build-core.sh: %s\n' "$*" >&2; exit 1; }
T0=$SECONDS

NOCACHE=()
for a in "$@"; do
  case "$a" in
    --no-cache) NOCACHE=(--no-cache) ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $a (see --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker not found (it is a build-time dependency of the test core)"
[ -f "$CORE/Dockerfile" ] || die "missing $CORE/Dockerfile"

# mkcpio: the cargo package tools/mkcpio, built the way tools/build.sh does it (step 2), unless it is already built.
VMAPP_WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$VMAPP_WORK"
VMAPP_WORK="$(cd "$VMAPP_WORK" && pwd)"
export VMAPP_WORK
MKCPIO="${CARGO_TARGET_DIR:-$VMAPP_WORK/target}/release/mkcpio"
if [ ! -x "$MKCPIO" ] || [ -n "$(find "$VMAPP/tools/mkcpio/src" "$VMAPP/tools/mkcpio/Cargo.toml" -newer "$MKCPIO" 2>/dev/null)" ]; then
  # shellcheck source=../../tools/lib/rust-env.sh
  . "$VMAPP/tools/lib/rust-env.sh"
  vmapp_rust_env
  echo "== mkcpio"
  cargo build --release --manifest-path "$VMAPP/tools/mkcpio/Cargo.toml"
  MKCPIO="$CARGO_TARGET_DIR/release/mkcpio"
fi
[ -x "$MKCPIO" ] || die "mkcpio was not built: $MKCPIO"

SCRATCH="$VMAPP_WORK/gpu-vulkan-core"
EXPORT="$SCRATCH/export"
mkdir -p "$SCRATCH"
# Empty the export folder (only ever the one under the scratch folder; a symlink is never followed).
if [ -d "$EXPORT" ] && [ ! -L "$EXPORT" ]; then find "$EXPORT" -depth -delete; fi
mkdir -p "$EXPORT"

echo "== docker build (core/Dockerfile, target app)"
LOG="$SCRATCH/docker-build.log"
if docker build --progress=plain ${NOCACHE[@]+"${NOCACHE[@]}"} --platform "$PLATFORM" --target app \
     --output "type=local,dest=$EXPORT" "$CORE" >"$LOG" 2>&1; then
  echo "docker build ok (log: $LOG)"
else
  tail -n 60 "$LOG" >&2
  die "docker build failed (full log: $LOG)"
fi
[ -x "$EXPORT/app/gpu-test.sh" ] || die "the export has no executable app/gpu-test.sh"

echo "== mkcpio"
mkdir -p "$(dirname "$OUT")"
"$MKCPIO" "$EXPORT/app" "$OUT"
SIZE="$(wc -c < "$OUT" | tr -d ' ')"
echo "build-core.sh: wrote $OUT ($SIZE bytes, $(( SECONDS - T0 )) s)"
