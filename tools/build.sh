#!/usr/bin/env bash
# Builds the vmapp host-side pieces into vmapp/out/:
#   out/initramfs.cpio        the guest's initramfs (/init = vmapp-init)
#   out/vmapp-vm              the host launcher, ad-hoc signed with host/vmapp.entitlements
#   out/vmapp-hostctl         the host-capabilities helper (screen/input), ad-hoc signed (host/hostctl/)
#   out/Image                 the guest kernel, built from pinned source by kernel/build.sh (needs Docker), or a
#                             prebuilt one given with --kernel-from. Also out/kernel.config, out/kernel.release,
#                             out/kernel-info/ (source verification, GPL source offer, licences).
#   out/test/core-echo.cpio   the test core used by tests/e2e.sh
#   out/gpu/                  the GPU capability's host server (SPEC 8.6): llama.cpp's RPC server with Metal, built by gpu/build.sh from
#                             the commit pinned in gpu/pins.env (needs cmake and Xcode's tools, no Docker); skipped with a hint when
#                             cmake is missing, or with --no-gpu
# Runtimes are built separately with tools/mkruntime (needs Docker).
#
#   out/krun/                 (only with --with-krun) the EXPERIMENTAL Vulkan backend (SPEC 8.7): gpu/krun/build.sh builds the pinned
#                             host libraries and the launcher vmapp-vm-krun; out/Image-gpu is the gpu kernel flavour
#                             (kernel/build.sh --flavour gpu, needs Docker); the runtime node22-gpu is built with tools/mkruntime
#
#   tools/build.sh [--kernel-from IMAGE] [--rebuild-kernel] [--offline] [--no-gpu] [--with-krun]
#     --kernel-from IMAGE   use this prebuilt arm64 Image instead of building the kernel (no Docker needed)
#     --rebuild-kernel      rebuild the kernel even if out/Image is up to date for kernel/
#     --offline             cargo works from its local cache only (CARGO_NET_OFFLINE=true)
#     --no-gpu              do not build the GPU server (out/gpu); apps that ask for the GPU then run without one
#     --with-krun           also build the experimental Vulkan backend (out/krun, out/Image-gpu): about 10 minutes the first time, needs
#                           Xcode, cmake, Docker and network access; off by default
#
# Environment:
#   RUSTUP_HOME, CARGO_HOME   your Rust toolchain. If neither is set and a sibling workspace toolchain exists
#                             (../_toolchains/{rustup,cargo}), that one is used; otherwise cargo and rustc come from PATH.
#                             Needs the target aarch64-unknown-linux-musl:  rustup target add aarch64-unknown-linux-musl
#   CARGO_TARGET_DIR          cargo build folder (default: $VMAPP_WORK/target)
#   VMAPP_WORK                scratch and cache folder (default: vmapp/out/work, git-ignored)
#   DEVELOPER_DIR             Xcode to use (default: /Applications/Xcode.app when present, else xcode-select's)
set -euo pipefail

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$VMAPP/out"
step() { printf '\n== %s\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

KERNEL_FROM=""
REBUILD_KERNEL=0
NO_GPU=0
WITH_KRUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kernel-from) [ $# -ge 2 ] || die "--kernel-from needs a path to an Image"; KERNEL_FROM="$2"; shift ;;
    --rebuild-kernel) REBUILD_KERNEL=1 ;;
    --no-gpu) NO_GPU=1 ;;
    --with-krun) WITH_KRUN=1 ;;
    --offline) export CARGO_NET_OFFLINE=true ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || die "this builds the macOS host launcher (Virtualization.framework); it needs macOS on Apple silicon"

# The Rust toolchain (RUSTUP_HOME/CARGO_HOME, else a sibling workspace toolchain, else PATH), the musl target and
# linker checks, CARGO_TARGET_DIR and VMAPP_WORK. Exits with a clear message when something is missing.
# shellcheck source=lib/rust-env.sh
. "$VMAPP/tools/lib/rust-env.sh"
vmapp_rust_env
MUSL="$VMAPP_MUSL"

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
command -v codesign >/dev/null 2>&1 || die "codesign not found (install the Xcode command-line tools: xcode-select --install)"
xcrun --find clang >/dev/null 2>&1 || die "clang not found (install the Xcode command-line tools: xcode-select --install)"

echo "toolchain: $(rustc -V), $VMAPP_TOOLCHAIN_NOTE"
echo "cargo target dir: $CARGO_TARGET_DIR"
echo "work dir: $VMAPP_WORK"

mkdir -p "$OUT/test"

# 1. guest: vmapp-init (static aarch64 musl)
step "guest (vmapp-init)"
cargo build --release --target "$MUSL" --manifest-path "$VMAPP/guest/Cargo.toml"
INIT="$CARGO_TARGET_DIR/$MUSL/release/vmapp-init"

# 2. mkcpio (host tool). tools/mkcpio is either a cargo package (directory) or a ready-made executable.
step "mkcpio"
if [ -f "$VMAPP/tools/mkcpio/Cargo.toml" ]; then
  cargo build --release --manifest-path "$VMAPP/tools/mkcpio/Cargo.toml"
  MKCPIO="$CARGO_TARGET_DIR/release/mkcpio"
elif [ -x "$VMAPP/tools/mkcpio" ] && [ -f "$VMAPP/tools/mkcpio" ]; then
  MKCPIO="$VMAPP/tools/mkcpio"
else
  die "tools/mkcpio not found (expected a cargo package or an executable)"
fi

# 3. initramfs
step "initramfs"
"$MKCPIO" --init "$INIT" "$OUT/initramfs.cpio"

# 4. host launcher, signed ad hoc with the virtualization entitlement
step "host (vmapp-vm)"
cargo build --release --manifest-path "$VMAPP/host/Cargo.toml"
cp "$CARGO_TARGET_DIR/release/vmapp-vm" "$OUT/vmapp-vm"
codesign --force --sign - --entitlements "$VMAPP/host/vmapp.entitlements" "$OUT/vmapp-vm"

# 4b. vmapp-hostctl: native helper for host capabilities (screen/input; SPEC 8.2). Pure Objective-C
#     built with clang, ad-hoc signed, no entitlements (TCC attributes to the responsible app = the loader).
step "host capabilities helper (vmapp-hostctl)"
bash "$VMAPP/host/hostctl/build.sh" "$OUT/vmapp-hostctl"

# 5. test core (core-echo), packed as a core.cpio containing /core-echo
step "test core (core-echo)"
cargo build --release --target "$MUSL" --manifest-path "$VMAPP/tests/core-echo/Cargo.toml"
STAGE="$OUT/test/core-echo.dir"
mkdir -p "$STAGE"
cp "$CARGO_TARGET_DIR/$MUSL/release/core-echo" "$STAGE/core-echo"
"$MKCPIO" "$STAGE" "$OUT/test/core-echo.cpio"

# 6. kernel: --kernel-from IMAGE, else out/Image if it is up to date for kernel/, else build it (kernel/build.sh;
#    needs Docker; the downloads are cached in $VMAPP_WORK/cache/kernel).
step "kernel"
if [ -n "$KERNEL_FROM" ]; then
  "$VMAPP/kernel/build.sh" --out "$OUT" --from "$KERNEL_FROM"
else
  KERNEL_ARGS=(--out "$OUT")
  [ "$REBUILD_KERNEL" = "1" ] && KERNEL_ARGS+=(--force)
  "$VMAPP/kernel/build.sh" "${KERNEL_ARGS[@]}" || die "the kernel build failed (no Docker? use: tools/build.sh --kernel-from /path/to/Image)"
fi
[ -s "$OUT/Image" ] || die "out/Image is missing"

# 7. the GPU capability's host server (SPEC 8.6): llama.cpp's RPC server with Metal, from the pinned commit; rebuilt only when gpu/
#    changed. Needs cmake and Xcode's command-line tools (and, the first time, network access for the pinned source).
step "GPU server (out/gpu/rpc-server)"
if [ "$NO_GPU" = "1" ]; then
  echo "skipped (--no-gpu)"
elif ! command -v cmake >/dev/null 2>&1; then
  echo "hint: cmake not found, so the GPU server (out/gpu/rpc-server) was not built. Install cmake and run gpu/build.sh, or pass --no-gpu."
else
  "$VMAPP/gpu/build.sh" || die "the GPU server build failed (see above; --no-gpu skips it)"
fi

# 8. The experimental Vulkan backend (SPEC 8.7), only on request: the pinned host libraries + the launcher, and the gpu kernel flavour.
if [ "$WITH_KRUN" = "1" ]; then
  step "experimental Vulkan backend (out/krun, out/Image-gpu)"
  bash "$VMAPP/gpu/krun/build.sh" || die "the Vulkan backend build failed (see above)"
  "$VMAPP/kernel/build.sh" --flavour gpu --out "$OUT" || die "the gpu kernel build failed (needs Docker)"
  [ -s "$OUT/Image-gpu" ] || die "out/Image-gpu is missing"
  if [ ! -f "$OUT/runtimes/node22-gpu.img" ]; then
    echo "hint: out/runtimes/node22-gpu.img is missing; build it with: $VMAPP/tools/mkruntime $VMAPP/runtimes/node22-gpu $OUT/runtimes/node22-gpu.img"
  fi
fi

step "sizes"
ls -l "$OUT/initramfs.cpio" "$OUT/vmapp-vm" "$OUT/vmapp-hostctl" "$OUT/Image" "$OUT/test/core-echo.cpio" | awk '{printf "%10d  %s\n", $5, $NF}'

if [ ! -f "$OUT/runtimes/native.img" ]; then
  echo
  echo "hint: out/runtimes/native.img is missing; build it with: $VMAPP/tools/mkruntime $VMAPP/runtimes/native $OUT/runtimes/native.img"
fi
