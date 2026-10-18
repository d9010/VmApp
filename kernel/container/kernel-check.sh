#!/bin/sh
# kernel-check.sh - fail unless the final kernel .config satisfies the vmapp required/forbidden option lists.
# Runs INSIDE the kernel build container, in the stage after kernel-config.sh (it needs the Kconfig tree to verify
# that every symbol named in the lists exists).
#
# Adapted from d9010-native/tools/build-rootfs/container/kernel-check.sh
#
# usage: kernel-check.sh KERNEL_VERSION OUT_DIR
# inputs: OUT_DIR/kernel.config, /ctx/{kconfig-required.txt,kconfig-forbidden.txt,check-kconfig.sh}
# output: OUT_DIR/kconfig-check.txt (kept as build evidence whether or not the check passes)
# Exit status is non-zero (the build fails) on any deviation.

set -eu

if [ $# -ne 2 ]; then
    echo "usage: kernel-check.sh KERNEL_VERSION OUT_DIR" >&2
    exit 2
fi
version=$1
out=$2
src=/build/linux-${version}

echo "kernel-check: checking the final .config against the required/forbidden lists"
if bash /ctx/check-kconfig.sh --source-tree "$src" "$out/kernel.config" /ctx/kconfig-required.txt /ctx/kconfig-forbidden.txt >"$out/kconfig-check.txt" 2>&1; then
    cat "$out/kconfig-check.txt"
else
    cat "$out/kconfig-check.txt" >&2
    echo "kernel-check: FATAL: final kernel configuration deviates from the D9010 VmApp contract" >&2
    exit 1
fi
