#!/bin/sh
# kernel-config.sh - produce the final vmapp guest kernel .config.
# Runs INSIDE the kernel build container (kernel/Dockerfile).
#
# Adapted from d9010-native/tools/build-rootfs/container/kernel-config.sh. Difference: the base is `allnoconfig`
# (everything off), not the arm64 defconfig, so the kernel contains only what vmapp-guest.config asks for.
#
#   arm64 allnoconfig + vmapp-guest.config  --merge_config.sh-->  make olddefconfig
#
# The result is checked against the required/forbidden lists by kernel-check.sh in a separate stage, which the
# exported targets depend on; the lists are deliberately not an input of this stage so that editing them never
# re-runs the kernel compile.
#
# usage: kernel-config.sh KERNEL_VERSION OUT_DIR
# input (from the build context): /ctx/vmapp-guest.config
# outputs: OUT_DIR/kernel.config, OUT_DIR/merge.log, OUT_DIR/olddefconfig.log

set -eu

if [ $# -ne 2 ]; then
    echo "usage: kernel-config.sh KERNEL_VERSION OUT_DIR" >&2
    exit 2
fi
version=$1
out=$2
src=/build/linux-${version}

mkdir -p "$out"
cd "$src"

export ARCH=arm64
export LC_ALL=C TZ=UTC

make mrproper >/dev/null
make allnoconfig >/dev/null

echo "kernel-config: merging /ctx/vmapp-guest.config over arm64 allnoconfig"
# -m: merge only (no make run inside the script); olddefconfig below resolves dependencies exactly like
# `make <fragment>.config` does in-tree.
scripts/kconfig/merge_config.sh -m -O "$src" "$src/.config" /ctx/vmapp-guest.config >"$out/merge.log" 2>&1 ||
    {
        cat "$out/merge.log" >&2
        echo "kernel-config: merge_config.sh failed" >&2
        exit 1
    }

echo "kernel-config: make olddefconfig"
make olddefconfig >"$out/olddefconfig.log" 2>&1 ||
    {
        cat "$out/olddefconfig.log" >&2
        echo "kernel-config: make olddefconfig failed" >&2
        exit 1
    }
if grep -q 'WARNING' "$out/olddefconfig.log"; then
    echo "kernel-config: olddefconfig reported warnings (unmet dependencies):" >&2
    grep -A3 'WARNING' "$out/olddefconfig.log" >&2 || true
fi

cp .config "$out/kernel.config"
echo "kernel-config: ok ($(grep -c '=y' .config) options built in, 0 modules)"
