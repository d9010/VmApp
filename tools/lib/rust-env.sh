# Sourced by tools/build.sh and apps/*/build.sh (not run on its own).
#
#   VMAPP=/path/to/vmapp
#   . "$VMAPP/tools/lib/rust-env.sh"
#   vmapp_rust_env            # exits with a clear message when the toolchain is not usable
#
# Picks the Rust toolchain and checks it can build the guest-side crates (static aarch64 musl):
#   1. RUSTUP_HOME / CARGO_HOME set by the caller: used as is (CARGO_HOME/bin is put on PATH).
#   2. else a sibling workspace toolchain, if there is one (../_toolchains/{rustup,cargo}); this keeps the
#      d9010 workspace working.
#   3. else cargo and rustc from PATH.
# Then it checks the target aarch64-unknown-linux-musl and the linker (rust-lld, or the one named by
# CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER), and sets CARGO_TARGET_DIR (default $VMAPP_WORK/target, where
# VMAPP_WORK defaults to vmapp/out/work, git-ignored).
#
# Sets: VMAPP_MUSL, VMAPP_WORK, VMAPP_TOOLCHAIN_NOTE; exports CARGO_TARGET_DIR and the linker variable.

vmapp_rust_env() {
  VMAPP_MUSL=aarch64-unknown-linux-musl
  local vm sibling sysroot host_triple linker
  vm="${VMAPP:?vmapp_rust_env needs VMAPP}"

  VMAPP_WORK="${VMAPP_WORK:-$vm/out/work}"
  mkdir -p "$VMAPP_WORK"
  VMAPP_WORK="$(cd "$VMAPP_WORK" && pwd)"
  export VMAPP_WORK

  sibling="$(cd "$vm/.." && pwd)/_toolchains"
  if [ -n "${RUSTUP_HOME:-}" ] || [ -n "${CARGO_HOME:-}" ]; then
    if [ -n "${CARGO_HOME:-}" ]; then
      export PATH="$CARGO_HOME/bin:$PATH"
    fi
    VMAPP_TOOLCHAIN_NOTE="the toolchain from RUSTUP_HOME/CARGO_HOME (${RUSTUP_HOME:-default}, ${CARGO_HOME:-default})"
  elif [ -d "$sibling/rustup" ] && [ -d "$sibling/cargo" ]; then
    export RUSTUP_HOME="$sibling/rustup"
    export CARGO_HOME="$sibling/cargo"
    export PATH="$sibling/bin:$CARGO_HOME/bin:$PATH"
    VMAPP_TOOLCHAIN_NOTE="the sibling workspace toolchain in $sibling"
  else
    VMAPP_TOOLCHAIN_NOTE="cargo and rustc from PATH"
  fi

  command -v cargo >/dev/null 2>&1 || { echo "vmapp: cargo not found. Install Rust (https://rustup.rs), then:  rustup target add $VMAPP_MUSL" >&2; exit 1; }
  command -v rustc >/dev/null 2>&1 || { echo "vmapp: rustc not found. Install Rust (https://rustup.rs), then:  rustup target add $VMAPP_MUSL" >&2; exit 1; }
  sysroot="$(rustc --print sysroot)"
  if [ ! -d "$sysroot/lib/rustlib/$VMAPP_MUSL/lib" ]; then
    echo "vmapp: the Rust target $VMAPP_MUSL is not installed for $(rustc -V) ($VMAPP_TOOLCHAIN_NOTE). Install it with:" >&2
    echo "  rustup target add $VMAPP_MUSL" >&2
    exit 1
  fi

  export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER:-rust-lld}"
  linker="$CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER"
  if [ "$linker" = "rust-lld" ]; then
    host_triple="$(rustc -vV | sed -n 's/^host: //p')"
    if [ ! -x "$sysroot/lib/rustlib/$host_triple/bin/rust-lld" ] && ! command -v rust-lld >/dev/null 2>&1; then
      echo "vmapp: the linker rust-lld was not found (expected $sysroot/lib/rustlib/$host_triple/bin/rust-lld; it ships with rustup toolchains)." >&2
      echo "  Use a rustup toolchain, or set CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER to another linker for $VMAPP_MUSL." >&2
      exit 1
    fi
  elif ! command -v "$linker" >/dev/null 2>&1; then
    echo "vmapp: the linker '$linker' (CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER) was not found" >&2
    exit 1
  fi

  mkdir -p "${CARGO_TARGET_DIR:-$VMAPP_WORK/target}"
  CARGO_TARGET_DIR="$(cd "${CARGO_TARGET_DIR:-$VMAPP_WORK/target}" && pwd)"
  export CARGO_TARGET_DIR
}
