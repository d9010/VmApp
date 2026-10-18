#!/usr/bin/env bash
# Builds the Vulkan CTS (deqp-vk) for linux-arm64 into $VMAPP_WORK/cts/ (shared into the VM read-only as /cts).
#   VMAPP_WORK=/abs/path guest/build-cts.sh [--no-cache]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${VMAPP_WORK:?set VMAPP_WORK to an absolute scratch folder}"
OUT="$WORK/cts"
mkdir -p "$OUT" "$WORK/logs"
extra=(--pull=false)
[ "${1:-}" = "--no-cache" ] && extra+=(--no-cache)
echo "==> docker buildx build CTS (log: $WORK/logs/cts-build.log)"
docker buildx build --platform linux/arm64 --provenance=false --sbom=false --progress=plain "${extra[@]}" \
    -f "$HERE/Dockerfile.cts" --target cts-out --output "type=local,dest=$OUT" "$HERE" >"$WORK/logs/cts-build.log" 2>&1 \
    || { tail -n 60 "$WORK/logs/cts-build.log" >&2; echo "build failed" >&2; exit 1; }
ls -la "$OUT" | head -20
