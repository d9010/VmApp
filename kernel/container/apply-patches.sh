#!/bin/sh
# apply-patches.sh - apply a kernel flavour's patches to the verified kernel source.
# Runs INSIDE the kernel build container (kernel/Dockerfile, stage kernel-patched).
#
# usage: apply-patches.sh KERNEL_VERSION PATCH_DIR EVIDENCE_FILE
#   PATCH_DIR      /ctx/patches: the flavour's patches/*.patch, staged by kernel/build.sh (an empty folder for the
#                  default flavour)
#   EVIDENCE_FILE  /out/kernel-patches.txt: what was applied (sha256 and patch(1) output); written only when there
#                  is at least one patch
#
# With no patches this changes nothing and writes nothing, so the default kernel is built from the unmodified,
# verified source exactly as before this stage existed.
#
# Each patch is applied in name order with `patch -p1 --fuzz=0` (a hunk whose context does not match exactly is an
# error, so a kernel version bump that moves the code fails loudly instead of patching the wrong place). Any failure
# aborts the build. The source tree was verified (sha256 + PGP) by fetch-kernel.sh just before.

set -eu

if [ $# -ne 3 ]; then
    echo "usage: apply-patches.sh KERNEL_VERSION PATCH_DIR EVIDENCE_FILE" >&2
    exit 2
fi
version=$1
dir=$2
evidence=$3
src=/build/linux-${version}

count=0
for p in "$dir"/*.patch; do
    [ -f "$p" ] || continue
    count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
    echo "apply-patches: no patches (the kernel source stays as released)"
    exit 0
fi

command -v patch >/dev/null 2>&1 || {
    echo "apply-patches: FATAL: patch(1) is missing in the build container" >&2
    exit 1
}
[ -d "$src" ] || {
    echo "apply-patches: FATAL: no kernel source at $src" >&2
    exit 1
}

mkdir -p "$(dirname "$evidence")"
printf 'kernel source patches, applied to linux-%s in this order with patch -p1 --fuzz=0:\n' "$version" >"$evidence"
log=$(mktemp /tmp/apply-patches.XXXXXX)
trap 'rm -f "$log"' EXIT
cd "$src"
for p in "$dir"/*.patch; do
    [ -f "$p" ] || continue
    name=$(basename "$p")
    echo "apply-patches: applying $name"
    if ! patch -p1 --fuzz=0 --no-backup-if-mismatch --batch <"$p" >"$log" 2>&1; then
        cat "$log" >&2
        echo "apply-patches: FATAL: $name does not apply to linux-$version" >&2
        exit 1
    fi
    cat "$log"
    {
        printf '\n%s  %s\n' "$(sha256sum "$p" | cut -d' ' -f1)" "$name"
        cat "$log"
    } >>"$evidence"
done
echo "apply-patches: ok: $count patch(es) applied"
