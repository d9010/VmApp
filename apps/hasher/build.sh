#!/usr/bin/env bash
# Builds the Hasher core (static aarch64 musl) and copies it to core/hasher, which `vmapp pack` turns into core.cpio.
#
# Uses the same Rust toolchain rules as tools/build.sh (tools/lib/rust-env.sh): RUSTUP_HOME/CARGO_HOME if you set
# them, else a sibling workspace toolchain, else cargo from PATH; the target aarch64-unknown-linux-musl must be
# installed (rustup target add aarch64-unknown-linux-musl). CARGO_TARGET_DIR defaults to $VMAPP_WORK/target (VMAPP_WORK
# defaults to vmapp/out/work). Set CARGO_NET_OFFLINE=true to make cargo use only its local crate cache.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
TARGET=aarch64-unknown-linux-musl

# shellcheck source=../../tools/lib/rust-env.sh
. "$VMAPP/tools/lib/rust-env.sh"
vmapp_rust_env

cd "$HERE"
cargo build --release --target "$TARGET"
mkdir -p core
cp "$CARGO_TARGET_DIR/$TARGET/release/hasher" core/hasher
chmod 755 core/hasher
echo "built $HERE/core/hasher ($(wc -c < core/hasher | tr -d ' ') bytes)"
