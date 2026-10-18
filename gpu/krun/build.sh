#!/usr/bin/env bash
# Builds the whole EXPERIMENTAL Vulkan GPU backend (SPEC 8.7) into vmapp/out/krun/:
#
#   gpu/krun/build.sh [--out DIR] [--libs-only] [--check] [build-libs.sh options: --clean --clean-all --force --verbose]
#
#   out/krun/lib/*.dylib        libkrun, virglrenderer (Venus), libepoxy, MoltenVK: pinned, relocatable, ad-hoc signed
#                               (gpu/krun/build-libs.sh; gpu/krun/pins.env and gpu/krun/patches/)
#   out/krun/bin/vmapp-vm-krun  the launcher (host/src/bin/vmapp-vm-krun.rs), ad-hoc signed with
#                               com.apple.security.hypervisor (host/krun.entitlements). It loads ../lib/libkrun.1.dylib with
#                               dlopen in its sandboxed VMM child, so it links no GPU library.
#   out/krun/share/vmm.sb       the VMM's sandbox profile (gpu/krun/vmm.sb)
#   out/krun/include, licenses/, BUILD-INFO.txt   from build-libs.sh
#
# The guest side is separate: the gpu kernel flavour (kernel/build.sh --flavour gpu -> out/Image-gpu) and the runtime
# `node22-gpu` (tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img).
#
#   --check      build nothing: verify the libraries (build-libs.sh --check) and that the launcher and the profile are in place,
#                signed with the hypervisor entitlement, and current for host/ and gpu/krun/vmm.sb; exit 0 when they are
#   --libs-only  only run build-libs.sh
#
# Environment: VMAPP_WORK (scratch, default out/work). The launcher is built with the Rust toolchain build-libs.sh installed
# in $VMAPP_WORK/krun-rust (pinned in gpu/krun/pins.env); cargo needs network access to fetch the crates of host/Cargo.lock
# (`--locked`) the first time. Build folder: $VMAPP_WORK/krun-target.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
OUT="$VMAPP/out"
CHECK=0
LIBS_ONLY=0
PASS=()

die() { printf 'gpu/krun/build.sh: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> [%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a folder"; OUT="$(cd "$2" && pwd)"; PASS+=(--out "$OUT"); shift ;;
    --check) CHECK=1 ;;
    --libs-only) LIBS_ONLY=1 ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --clean | --clean-all | --force | --verbose) PASS+=("$1") ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || die "this builds for macOS on Apple silicon"
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
export VMAPP_WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$VMAPP_WORK"
VMAPP_WORK="$(cd "$VMAPP_WORK" && pwd)"
export VMAPP_WORK

K="$OUT/krun"
BIN="$K/bin/vmapp-vm-krun"
PROFILE="$K/share/vmm.sb"
STAMP="$K/bin/.launcher.stamp"

# What the launcher binary depends on: host/ (sources, manifest, lock, entitlements) and the profile.
inputs_hash() {
  (cd "$VMAPP" && find host/src host/Cargo.toml host/Cargo.lock host/build.rs host/krun.entitlements gpu/krun/vmm.sb -type f -not -name '.DS_Store' | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | awk '{ print $1 }'
}

if [ "$CHECK" = 1 ]; then
  bash "$HERE/build-libs.sh" ${PASS[@]+"${PASS[@]}"} --check || die "the libraries are missing or out of date (run gpu/krun/build.sh)"
  [ -x "$BIN" ] || die "$BIN is missing"
  [ -f "$PROFILE" ] && cmp -s "$PROFILE" "$HERE/vmm.sb" || die "$PROFILE is missing or differs from gpu/krun/vmm.sb"
  codesign --verify --strict "$BIN" 2>/dev/null || die "$BIN is not validly signed"
  codesign -d --entitlements - "$BIN" 2>&1 | grep -q 'com.apple.security.hypervisor' || die "$BIN lacks the hypervisor entitlement"
  [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(inputs_hash)" ] || die "$BIN is out of date for host/ or gpu/krun/vmm.sb (run gpu/krun/build.sh)"
  echo "ok: $K is complete and current"
  exit 0
fi

log "host libraries (gpu/krun/build-libs.sh)"
bash "$HERE/build-libs.sh" ${PASS[@]+"${PASS[@]}"}
[ "$LIBS_ONLY" = 1 ] && exit 0

# The toolchain build-libs.sh installed (pinned in pins.env); nothing from the user's own Rust installation.
export RUSTUP_HOME="$VMAPP_WORK/krun-rust/rustup"
export CARGO_HOME="$VMAPP_WORK/krun-rust/cargo"
[ -x "$CARGO_HOME/bin/cargo" ] || die "the pinned Rust toolchain is missing in $VMAPP_WORK/krun-rust (build-libs.sh installs it)"
export PATH="$CARGO_HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CARGO_TARGET_DIR="$VMAPP_WORK/krun-target"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"

NEW="$(inputs_hash)"
if [ -x "$BIN" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$NEW" ] && [ -f "$PROFILE" ] && cmp -s "$PROFILE" "$HERE/vmm.sb"; then
  log "launcher is current (host/ and the profile did not change)"
else
  log "launcher (host/ -> vmapp-vm-krun)"
  cargo build --release --locked --manifest-path "$VMAPP/host/Cargo.toml" --bin vmapp-vm-krun
  mkdir -p "$K/bin" "$K/share"
  # Copy file CONTENT only (no xattrs), atomically.
  cat "$CARGO_TARGET_DIR/release/vmapp-vm-krun" >"$BIN.tmp.$$"
  chmod 0755 "$BIN.tmp.$$"
  mv -f "$BIN.tmp.$$" "$BIN"
  # Ad hoc, with the hypervisor entitlement (and no networking entitlement: INV-D1). A Developer ID build needs the hardened
  # runtime and the libraries signed by the same identity (library validation); see gpu/krun/README.md.
  codesign --force --sign - --entitlements "$VMAPP/host/krun.entitlements" "$BIN"
  cat "$HERE/vmm.sb" >"$PROFILE.tmp.$$"
  mv -f "$PROFILE.tmp.$$" "$PROFILE"
  printf '%s\n' "$NEW" >"$STAMP"
fi

log "sizes"
ls -l "$K/lib/"*.dylib "$BIN" "$PROFILE" | awk '{printf "%10d  %s\n", $5, $NF}'
echo
echo "built: $K"
echo "run an app on it:  $BIN run --kernel $OUT/Image-gpu --initramfs $OUT/initramfs.cpio ...   (SPEC 8.7)"
