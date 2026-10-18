#!/usr/bin/env bash
# Signs "D9010VmAppLauncher.app" inside-out (never --deep for signing; --deep is only used to VERIFY).
#
#   build/sign-mac.sh <path to D9010VmAppLauncher.app>
#   SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" build/sign-mac.sh <app>   # real signing, see PACKAGING.md
#
# SIGN_IDENTITY defaults to "-" (ad hoc). Every Mach-O gets the hardened runtime (--options runtime). With a real
# identity a secure timestamp is added (required for notarization). Order:
#   1. Contents/Resources/vmapp/vmapp-vm       host/vmapp.entitlements (com.apple.security.virtualization) + runtime
#   1b. Contents/Resources/vmapp/vmapp-hostctl  identifier com.vmapp.hostctl, hardened runtime, NO entitlements
#       (screen capture and synthetic input need the user's Screen Recording / Accessibility consent, not an entitlement)
#   1c. Contents/Resources/vmapp/gpu/rpc-server  identifier com.vmapp.rpc-server, hardened runtime, NO entitlements
#       (the GPU server of SPEC 8.6: Metal needs neither allow-jit nor any other entitlement, checked by tests/gpu/ on the signed
#       binary: macOS compiles the shaders in its own service, so this process never maps executable memory)
#   2. loose Mach-O inside the frameworks  (dylibs, crashpad handler, Squirrel's ShipIt)
#   3. the frameworks
#   4. the four Electron helper apps       build/entitlements.mac.plist (allow-jit, allow-unsigned-executable-memory)
#   5. the app itself                      same entitlements
#   (ad hoc only: entitlements.mac.adhoc.plist for 4 and 5 = the same + disable-library-validation, see that file)
# The virtualization entitlement goes ONLY to vmapp-vm; the Electron processes and vmapp-hostctl never get it.
set -euo pipefail

APP="${1:?usage: sign-mac.sh <D9010VmAppLauncher.app>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
IDENTITY="${SIGN_IDENTITY:--}"
ENT_ELECTRON="$HERE/entitlements.mac.plist"
# ad hoc has no Team ID, so the hardened runtime's library validation would refuse Electron Framework (see the file)
if [ "$IDENTITY" = "-" ]; then ENT_ELECTRON="$HERE/entitlements.mac.adhoc.plist"; fi
ENT_VM="$VMAPP/host/vmapp.entitlements"
VM="$APP/Contents/Resources/vmapp/vmapp-vm"
HOSTCTL="$APP/Contents/Resources/vmapp/vmapp-hostctl"
GPUSRV="$APP/Contents/Resources/vmapp/gpu/rpc-server"

[ -d "$APP" ] || { echo "sign-mac: not an app bundle: $APP" >&2; exit 2; }
[ -f "$VM" ] || { echo "sign-mac: $VM is missing (run build/package.mjs first)" >&2; exit 2; }
[ -f "$HOSTCTL" ] || { echo "sign-mac: $HOSTCTL is missing (run build/package.mjs first)" >&2; exit 2; }
[ -f "$GPUSRV" ] || { echo "sign-mac: $GPUSRV is missing (run gpu/build.sh, then build/package.mjs)" >&2; exit 2; }

TS=()
if [ "$IDENTITY" != "-" ]; then TS=(--timestamp); fi
sign() { codesign --force --sign "$IDENTITY" --options runtime ${TS[@]+"${TS[@]}"} "$@"; }

echo "signing with identity: $([ "$IDENTITY" = "-" ] && echo 'ad hoc (-)' || echo "$IDENTITY")"

echo "-- vmapp-vm (virtualization entitlement)"
sign --identifier com.vmapp.loader.vmapp-vm --entitlements "$ENT_VM" "$VM"

echo "-- vmapp-hostctl (host capabilities helper: hardened runtime, no entitlements)"
sign --identifier com.vmapp.hostctl "$HOSTCTL"

echo "-- rpc-server (the GPU server, SPEC 8.6: hardened runtime, no entitlements)"
sign --identifier com.vmapp.rpc-server "$GPUSRV"

KRUN="$APP/Contents/Resources/vmapp/krun"
if [ -d "$KRUN" ]; then
  # The EXPERIMENTAL Vulkan backend (SPEC 8.7), bundled only by package.mjs --with-krun: its libraries first, then the
  # launcher with the Hypervisor entitlement (host/krun.entitlements). Ad hoc: the launcher is signed WITHOUT the
  # hardened runtime, as tested (an ad hoc hardened launcher could refuse its separately signed libraries through library
  # validation). A real identity signs everything with the same Team ID and the hardened runtime.
  echo "-- experimental Vulkan backend: libraries"
  find "$KRUN/lib" -type f -name '*.dylib' -print0 | while IFS= read -r -d '' f; do sign "$f"; done
  echo "-- experimental Vulkan backend: vmapp-vm-krun (hypervisor entitlement)"
  if [ "$IDENTITY" = "-" ]; then
    codesign --force --sign - --identifier com.vmapp.loader.vmapp-vm-krun --entitlements "$VMAPP/host/krun.entitlements" "$KRUN/bin/vmapp-vm-krun"
  else
    sign --identifier com.vmapp.loader.vmapp-vm-krun --entitlements "$VMAPP/host/krun.entitlements" "$KRUN/bin/vmapp-vm-krun"
  fi
fi

echo "-- Mach-O inside frameworks"
find "$APP/Contents/Frameworks" -type f \( -name '*.dylib' -o -path '*/Helpers/*' -o -name ShipIt \) -print0 |
  while IFS= read -r -d '' f; do sign "$f"; done

echo "-- frameworks"
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0 |
  while IFS= read -r -d '' f; do sign "$f"; done

echo "-- helper apps"
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -print0 |
  while IFS= read -r -d '' f; do sign --entitlements "$ENT_ELECTRON" "$f"; done

echo "-- app"
sign --entitlements "$ENT_ELECTRON" "$APP"

echo "-- verify"
codesign --verify --deep --strict --verbose=2 "$APP"
