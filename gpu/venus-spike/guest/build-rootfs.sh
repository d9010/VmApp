#!/usr/bin/env bash
# Builds the spike guest root filesystem (Debian trixie arm64 + Mesa Venus + llama.cpp + vkpeak + test tools)
# as an ext4 image: $VMAPP_WORK/guest/rootfs.ext4.   Needs Docker (arm64 daemon). Research only.
#
#   VMAPP_WORK=/abs/path guest/build-rootfs.sh [--no-cache]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${VMAPP_WORK:?set VMAPP_WORK to an absolute scratch folder}"
OUT="$WORK/guest"
mkdir -p "$OUT" "$WORK/logs"
extra=(--pull=false)
[ "${1:-}" = "--no-cache" ] && extra+=(--no-cache)
echo "==> docker buildx build (log: $WORK/logs/guest-rootfs.log)"
docker buildx build --platform linux/arm64 --provenance=false --sbom=false --progress=plain "${extra[@]}" \
    -f "$HERE/Dockerfile" --target ext4-out --output "type=local,dest=$OUT" "$HERE" >"$WORK/logs/guest-rootfs.log" 2>&1 \
    || { tail -n 60 "$WORK/logs/guest-rootfs.log" >&2; echo "build failed" >&2; exit 1; }
ls -la "$OUT/rootfs.ext4"
