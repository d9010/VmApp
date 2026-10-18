#!/usr/bin/env bash
# One command to produce the packaged macOS app:  vmapp/out/dist/D9010VmAppLauncher.app  +  D9010-VmApp-Launcher-<version>-mac-arm64.zip
#
#   tools/package-mac.sh                  build what is missing, package, fuse, sign (ad hoc), zip
#   tools/package-mac.sh --rebuild        run tools/build.sh even when out/ is complete
#   tools/package-mac.sh --with-krun      also bundle the EXPERIMENTAL Vulkan backend (krun launcher + libraries, Image-gpu,
#                                         runtimes/node22-gpu.img); apps only use it when the user turns it on in the loader
#   tools/package-mac.sh --with-examples  also bundle the sample apps of "Load examples" (out/examples/*.vmapp + README.md, about
#                                         360 MB more; tools/pack-examples --no-build makes them first if out/examples is missing)
#   SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" tools/package-mac.sh   real signing (see loader/PACKAGING.md)
#
# Environment:
#   VMAPP_WORK         scratch and cache folder (default: vmapp/out/work, git-ignored)
#   ELECTRON_CACHE     where the Electron download is cached (default: $VMAPP_WORK/electron-cache)
#   npm_config_cache   npm's cache (default: $VMAPP_WORK/cache/npm)
#
# Steps: tools/build.sh (only if out/vmapp-vm, Image or initramfs.cpio is missing, or --rebuild; host/hostctl/build.sh
# alone if just out/vmapp-hostctl is missing) -> runtimes
# (tools/mkruntime for any of native/node22/dotnet8 that is missing; needs Docker) -> npm ci in loader/ ->
# loader/build/package.mjs (packager + fuses + VM resources) -> loader/build/sign-mac.sh -> ditto zip -> summary.
set -euo pipefail

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$VMAPP/out"
DIST="$OUT/dist"
LOADER="$VMAPP/loader"
APP="$DIST/D9010VmAppLauncher.app"
REBUILD=0
WITH_KRUN=0
WITH_EXAMPLES=0
EXAMPLES_DIR=""   # --examples-dir=DIR: bundle the packages of DIR instead of out/examples (a folder made with: tools/pack-examples --out DIR)
for a in "$@"; do
  case "$a" in
    --examples-dir=*) EXAMPLES_DIR="${a#--examples-dir=}" ;;
    --rebuild) REBUILD=1 ;;
    --with-krun) WITH_KRUN=1 ;;   # also bundle the EXPERIMENTAL Vulkan backend (SPEC 8.7; off until the user enables it)
    --with-examples) WITH_EXAMPLES=1 ;;   # also bundle the sample apps of "Load examples" (data only; nothing runs until the user installs one)
    *) echo "package-mac: unknown option $a" >&2; exit 2 ;;
  esac
done

# Caches go to the scratch folder (default out/work, git-ignored), resolved to an absolute path like tools/build.sh does.
VMAPP_WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$VMAPP_WORK"
VMAPP_WORK="$(cd "$VMAPP_WORK" && pwd)"
export VMAPP_WORK
export ELECTRON_CACHE="${ELECTRON_CACHE:-$VMAPP_WORK/electron-cache}"
export npm_config_cache="${npm_config_cache:-$VMAPP_WORK/cache/npm}"
unset ELECTRON_RUN_AS_NODE
mkdir -p "$ELECTRON_CACHE" "$npm_config_cache"

step() { printf '\n== %s\n' "$*"; }
command -v node >/dev/null || { echo "package-mac: node (>= 22.12) is needed on PATH to run the packager" >&2; exit 1; }

# 1. host pieces
step "host pieces (out/vmapp-vm, Image, initramfs.cpio)"
if [ "$REBUILD" = 1 ] || [ ! -f "$OUT/vmapp-vm" ] || [ ! -f "$OUT/Image" ] || [ ! -f "$OUT/initramfs.cpio" ]; then
  "$VMAPP/tools/build.sh"
else
  echo "present, not rebuilding (use --rebuild)"
fi
# the host-capabilities helper (screen and input, SPEC 8.2) goes into the bundle too; build just it when it is missing
if [ ! -f "$OUT/vmapp-hostctl" ]; then
  echo "out/vmapp-hostctl is missing: building it (host/hostctl/build.sh)"
  bash "$VMAPP/host/hostctl/build.sh" "$OUT/vmapp-hostctl"
fi
[ -f "$OUT/vmapp-hostctl" ] || { echo "package-mac: out/vmapp-hostctl is missing" >&2; exit 1; }
# the GPU server (SPEC 8.6: llama.cpp's RPC server with Metal, from the commit pinned in gpu/pins.env) and its sandbox profile go into
# the bundle too; gpu/build.sh needs cmake and Xcode's command-line tools, no Docker, and rebuilds only when gpu/ changed
step "GPU server (out/gpu/rpc-server)"
if [ "$REBUILD" = 1 ] || ! "$VMAPP/gpu/build.sh" --check >/dev/null 2>&1; then
  "$VMAPP/gpu/build.sh"
else
  echo "present and up to date for gpu/ (use --rebuild)"
fi
[ -f "$OUT/gpu/rpc-server" ] && [ -f "$OUT/gpu/rpc-server.sb" ] || { echo "package-mac: out/gpu/rpc-server or rpc-server.sb is missing" >&2; exit 1; }

# 2. runtimes
step "runtimes"
mkdir -p "$OUT/runtimes"
for r in native node22 dotnet8; do
  if [ ! -f "$OUT/runtimes/$r.img" ]; then
    echo "building runtime $r (needs Docker)"
    "$VMAPP/tools/mkruntime" "$VMAPP/runtimes/$r" "$OUT/runtimes/$r.img"
  fi
  [ -f "$OUT/runtimes/$r.img" ] || { echo "package-mac: out/runtimes/$r.img is missing" >&2; exit 1; }
done

# 3. loader dependencies (exact, from the lockfile)
step "npm ci (loader)"
(cd "$LOADER" && npm ci --no-audit --no-fund)

# 3b. the sample apps (--with-examples): out/examples/*.vmapp, made by tools/pack-examples. Only what is already built is packed
# (--no-build: this script never starts the Docker builds of the big samples); whatever is there is bundled as it is.
if [ "$WITH_EXAMPLES" = 1 ]; then
  EX="${EXAMPLES_DIR:-$OUT/examples}"
  step "sample apps ($EX)"
  if ! ls "$EX"/*.vmapp >/dev/null 2>&1; then
    [ -z "$EXAMPLES_DIR" ] || { echo "package-mac: $EX has no .vmapp files" >&2; exit 1; }
    echo "out/examples has no .vmapp files: running tools/pack-examples --no-build"
    "$VMAPP/tools/pack-examples" --no-build
  else
    echo "present: $(ls "$EX"/*.vmapp | wc -l | tr -d ' ') package(s), $(du -sh "$EX" | cut -f1) (re-run tools/pack-examples to refresh them)"
  fi
  ls "$EX"/*.vmapp >/dev/null 2>&1 || { echo "package-mac: $EX has no .vmapp files" >&2; exit 1; }
fi

# 4. package + fuses + resources
step "package"
PKG_FLAGS=()
[ "$WITH_KRUN" = 1 ] && PKG_FLAGS+=(--with-krun)
[ "$WITH_EXAMPLES" = 1 ] && PKG_FLAGS+=(--with-examples)
[ -n "$EXAMPLES_DIR" ] && PKG_FLAGS+=(--examples-dir "$EXAMPLES_DIR")
(cd "$LOADER" && node build/package.mjs --out "$OUT" --dist "$DIST" ${PKG_FLAGS[@]+"${PKG_FLAGS[@]}"})

# 5. sign
step "sign"
"$LOADER/build/sign-mac.sh" "$APP"

# 6. zip
VERSION="$(node -p "require('$LOADER/package.json').version")"
ZIP="$DIST/D9010-VmApp-Launcher-$VERSION-mac-arm64.zip"
step "zip"
rm -f "$ZIP"
# --norsrc --noextattr: no "._" entries. macOS 15 puts com.apple.provenance on every file; ditto would store each as an AppleDouble "._" entry, and
# an extractor that cannot apply them to the frameworks' symlinks (Archive Utility on a downloaded zip) writes them out as real files, which
# breaks the framework's seal ("unsealed contents present in the root directory of an embedded framework"). The notarization ticket is a file
# (Contents/CodeResources), not an attribute, so nothing is lost.
ditto -c -k --norsrc --noextattr --keepParent "$APP" "$ZIP"

# 7. summary
step "summary"
echo "sizes:"
du -sh "$APP" | awk '{printf "  %-8s D9010VmAppLauncher.app\n", $1}'
du -sh "$APP/Contents/Resources/app.asar" | awk '{printf "  %-8s Resources/app.asar\n", $1}'
du -sh "$APP/Contents/Resources/vmapp" | awk '{printf "  %-8s Resources/vmapp\n", $1}'
if [ -d "$APP/Contents/Resources/vmapp/examples" ]; then
  du -sh "$APP/Contents/Resources/vmapp/examples" | awk '{printf "  %-8s Resources/vmapp/examples (--with-examples)\n", $1}'
fi
ls -l "$ZIP" | awk '{printf "  %-8s %s\n", $5, $NF}'
echo
echo "codesign -dv (app):"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "^(Identifier|Format|CodeDirectory|Signature|Authority|TeamIdentifier|Sealed Resources|Info.plist)" | sed 's/^/  /'
echo "codesign -dv (vmapp-vm):"
codesign -dv --verbose=2 "$APP/Contents/Resources/vmapp/vmapp-vm" 2>&1 | grep -E "^(Identifier|CodeDirectory|Signature)" | sed 's/^/  /'
codesign -d --entitlements - "$APP/Contents/Resources/vmapp/vmapp-vm" 2>/dev/null | grep -E "virtualization" | sed 's/^/  entitlement: /' || true
echo "codesign -dv (vmapp-hostctl):"
codesign -dv --verbose=2 "$APP/Contents/Resources/vmapp/vmapp-hostctl" 2>&1 | grep -E "^(Identifier|CodeDirectory|Signature|Format)" | sed 's/^/  /'
echo "codesign -dv (rpc-server, the GPU server):"
codesign -dv --verbose=2 "$APP/Contents/Resources/vmapp/gpu/rpc-server" 2>&1 | grep -E "^(Identifier|CodeDirectory|Signature|Format)" | sed 's/^/  /'
codesign --verify --strict "$APP/Contents/Resources/vmapp/gpu/rpc-server" && echo "  rpc-server: signature valid"
echo "fuses:"
(cd "$LOADER" && npx --no-install @electron/fuses read --app "$APP") | sed 's/^/  /'
echo
echo "done: $APP"
echo "      $ZIP"
