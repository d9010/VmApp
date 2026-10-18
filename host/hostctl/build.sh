#!/usr/bin/env bash
# Builds vmapp-hostctl (pure Objective-C, one file) with clang and ad-hoc signs it.
#   usage: host/hostctl/build.sh [output-path]      default: vmapp/out/vmapp-hostctl
# Minimum macOS 13.0 (ScreenCaptureKit screenshots are used when the OS is 14+, with a legacy
# CGWindowList fallback on 13). A higher MACOSX_DEPLOYMENT_TARGET in the environment is respected.
# HOSTCTL_UNIVERSAL=1 builds arm64+x86_64.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$VMAPP/out/vmapp-hostctl}"
# Prefer a full Xcode when there is one (DEVELOPER_DIR overrides); otherwise xcode-select's choice is used.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

MIN="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
ARCHS=()
if [ "${HOSTCTL_UNIVERSAL:-0}" = "1" ]; then ARCHS=(-arch arm64 -arch x86_64); fi

mkdir -p "$(dirname "$OUT")"
xcrun clang -fobjc-arc -fobjc-exceptions -O2 \
  -mmacosx-version-min="$MIN" ${ARCHS[@]+"${ARCHS[@]}"} \
  -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations -Wunguarded-availability \
  -framework Foundation -framework AppKit -framework ApplicationServices -framework Carbon \
  -framework ImageIO -framework ScreenCaptureKit -framework CoreGraphics \
  -o "$OUT" "$HERE/hostctl.m"
strip -x "$OUT"
# Ad-hoc signature, no entitlements needed. macOS (TCC) attributes Screen Recording / Accessibility
# to the responsible app (the loader when it spawns this helper), not to this binary.
codesign --force --sign - --identifier com.vmapp.hostctl "$OUT"
