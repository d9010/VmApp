#!/usr/bin/env bash
# Builds everything the Terminal app needs that is not source, in three steps:
#
#   1. core/bin/ptyd            the PTY bridge (ptyd/, static aarch64 musl Rust).
#   2. core/node_modules/       the Gemini CLI, exactly the version pinned in core/package.json and core/package-lock.json:
#                               `npm ci --omit=dev --ignore-scripts` for linux-arm64 (glibc), so the platform packages the
#                               VM needs (the prebuilt PTY addon) are installed and the macOS/Windows ones are not.
#                               Install scripts of dependencies never run.
#   3. ui/vendor/               xterm.js and its fit addon, exactly the versions pinned in vendor-src/package-lock.json,
#                               copied as built files (the window has no network and no CDN).
#
# Uses the Rust toolchain rules of tools/lib/rust-env.sh (RUSTUP_HOME/CARGO_HOME, else a sibling workspace toolchain, else
# cargo from PATH; the target aarch64-unknown-linux-musl must be installed) and needs node and npm. Downloads are cached in
# $VMAPP_WORK/cache/npm (VMAPP_WORK defaults to vmapp/out/work). Set CARGO_NET_OFFLINE=true or NPM_OFFLINE=1 to use only
# the local caches.
#
# To move to another Gemini CLI version, change core/package.json, then run `npm install --package-lock-only --omit=dev
# --ignore-scripts` inside core/ and review the lock file. Pick a release at least 14 days old.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
TARGET=aarch64-unknown-linux-musl

# shellcheck source=../../tools/lib/rust-env.sh
. "$VMAPP/tools/lib/rust-env.sh"
vmapp_rust_env

command -v node >/dev/null 2>&1 || { echo "terminal/build.sh: node not found (install Node.js 20 or later)" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "terminal/build.sh: npm not found (install Node.js 20 or later)" >&2; exit 1; }
NPM_CACHE="$VMAPP_WORK/cache/npm"
mkdir -p "$NPM_CACHE"
NPM_FLAGS=(--no-audit --no-fund --no-update-notifier --cache "$NPM_CACHE")
[ "${NPM_OFFLINE:-0}" = "1" ] && NPM_FLAGS+=(--offline)

echo "== 1/3 ptyd (static $TARGET)"
cargo build --release --target "$TARGET" --manifest-path "$HERE/ptyd/Cargo.toml"
mkdir -p "$HERE/core/bin"
cp "$CARGO_TARGET_DIR/$TARGET/release/ptyd" "$HERE/core/bin/ptyd"
chmod 755 "$HERE/core/bin/ptyd"
echo "built core/bin/ptyd ($(wc -c < "$HERE/core/bin/ptyd" | tr -d ' ') bytes)"

echo "== 2/3 Gemini CLI (npm ci, linux-arm64, no install scripts)"
(cd "$HERE/core" && npm ci --omit=dev --ignore-scripts --os=linux --cpu=arm64 --libc=glibc "${NPM_FLAGS[@]}")
# The VM is Linux: the macOS and Windows prebuilt binaries that some npm packages carry (keytar's) never run in it. Apple's notary service opens
# the .vmapp inside a release app and rejects unsigned ones, so they are removed (a new Linux package is unaffected).
find "$HERE/core/node_modules" -type d \( -path '*/prebuilds/darwin-*' -o -path '*/prebuilds/win32-*' \) -prune -exec rm -rf {} +
GEMINI_JS="$HERE/core/node_modules/@google/gemini-cli/bundle/gemini.js"
[ -f "$GEMINI_JS" ] || { echo "terminal/build.sh: $GEMINI_JS is missing after npm ci" >&2; exit 1; }
[ -f "$HERE/core/node_modules/@lydell/node-pty-linux-arm64/package.json" ] \
  || echo "note: the linux-arm64 PTY addon was not installed; Gemini CLI will run its shell tool without a terminal"
echo "installed @google/gemini-cli $(node -p "require('$HERE/core/node_modules/@google/gemini-cli/package.json').version") ($(du -sk "$HERE/core/node_modules" | cut -f1) KiB in core/node_modules)"

echo "== 3/3 xterm.js (vendored into ui/vendor/)"
SCRATCH="$VMAPP_WORK/terminal-vendor"
mkdir -p "$SCRATCH"
cp "$HERE/vendor-src/package.json" "$HERE/vendor-src/package-lock.json" "$SCRATCH/"
(cd "$SCRATCH" && npm ci --omit=dev --ignore-scripts "${NPM_FLAGS[@]}")
mkdir -p "$HERE/ui/vendor"
cp "$SCRATCH/node_modules/@xterm/xterm/lib/xterm.js" "$HERE/ui/vendor/xterm.js"
cp "$SCRATCH/node_modules/@xterm/xterm/css/xterm.css" "$HERE/ui/vendor/xterm.css"
cp "$SCRATCH/node_modules/@xterm/xterm/LICENSE" "$HERE/ui/vendor/xterm.LICENSE"
cp "$SCRATCH/node_modules/@xterm/addon-fit/lib/addon-fit.js" "$HERE/ui/vendor/addon-fit.js"
cp "$SCRATCH/node_modules/@xterm/addon-fit/LICENSE" "$HERE/ui/vendor/addon-fit.LICENSE"
echo "vendored: $(ls "$HERE/ui/vendor" | tr '\n' ' ')"

echo
echo "done. Next: vmapp/tools/vmapp pack vmapp/apps/terminal -o terminal.vmapp"
