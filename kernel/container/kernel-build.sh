#!/bin/sh
# kernel-build.sh - build the uncompressed arm64 Image from an already configured tree (see kernel-config.sh).
# Runs INSIDE the kernel build container.
#
# Adapted from d9010-native/tools/build-rootfs/container/kernel-build.sh
#
# usage: kernel-build.sh KERNEL_VERSION OUT_DIR
# env:   SOURCE_DATE_EPOCH KBUILD_BUILD_USER KBUILD_BUILD_HOST (reproducible build identity)
# outputs: OUT_DIR/Image OUT_DIR/kernel.release OUT_DIR/licenses/linux/{COPYING,LICENSES/}
#
# VZLinuxBootLoader needs the plain, uncompressed arm64 `Image` (not Image.gz, not vmlinuz/zboot); this script
# verifies the arm64 boot-protocol magic.

set -eu

if [ $# -ne 2 ]; then
    echo "usage: kernel-build.sh KERNEL_VERSION OUT_DIR" >&2
    exit 2
fi
version=$1
out=$2
src=/build/linux-${version}

: "${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be set}"
: "${KBUILD_BUILD_USER:?KBUILD_BUILD_USER must be set}"
: "${KBUILD_BUILD_HOST:?KBUILD_BUILD_HOST must be set}"

export ARCH=arm64
export LC_ALL=C TZ=UTC
export KBUILD_BUILD_USER KBUILD_BUILD_HOST
export KBUILD_BUILD_VERSION=1
KBUILD_BUILD_TIMESTAMP=$(date -u -d "@${SOURCE_DATE_EPOCH}" '+%a %b %e %H:%M:%S UTC %Y')
export KBUILD_BUILD_TIMESTAMP
export SOURCE_DATE_EPOCH

mkdir -p "$out"
cd "$src"

jobs=$(nproc)
echo "kernel-build: make -j${jobs} Image (timestamp: ${KBUILD_BUILD_TIMESTAMP})"
make -j"$jobs" Image >"$out/build.log" 2>&1 ||
    {
        tail -n 80 "$out/build.log" >&2
        echo "kernel-build: FATAL: kernel build failed" >&2
        exit 1
    }

image=arch/arm64/boot/Image
[ -s "$image" ] || {
    echo "kernel-build: FATAL: $image missing" >&2
    exit 1
}
# arm64 boot protocol (Documentation/arch/arm64/booting.rst): magic "ARM\x64" at offset 56.
magic=$(dd if="$image" bs=1 skip=56 count=4 2>/dev/null)
if [ "$magic" != "ARMd" ]; then
    echo "kernel-build: FATAL: $image lacks the arm64 Image magic (got '$magic')" >&2
    exit 1
fi
# Never ship a compressed image by mistake.
first=$(dd if="$image" bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' ')
if [ "$first" = "1f8b" ]; then
    echo "kernel-build: FATAL: $image is gzip-compressed" >&2
    exit 1
fi

cp "$image" "$out/Image"
tr -d '\n' <include/config/kernel.release >"$out/kernel.release"

# Licence texts for the notice bundle (GPL-2.0 + Linux-syscall-note).
mkdir -p "$out/licenses/linux"
cp COPYING "$out/licenses/linux/COPYING"
cp -R LICENSES "$out/licenses/linux/LICENSES"

echo "kernel-build: ok: Image $(wc -c <"$out/Image") bytes, release $(cat "$out/kernel.release")"
