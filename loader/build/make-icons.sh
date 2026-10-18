#!/usr/bin/env bash
# Regenerates the launcher's icon files from the two SVG masters in loader/build/icons/ (the D9010 logo). Run it when the logo changes;
# the results are committed, so building the launcher needs neither Chrome nor this script.
#
#   bash loader/build/make-icons.sh
#
# Writes:
#   loader/build/icon.icns            the app icon (Finder, Dock, Cmd-Tab, About): a 1024 master cut to the ten sizes macOS wants
#   loader/ui/icon.png                the same icon at 512 px (the library header, the About panel, the Dock of a development run)
#   loader/ui/trayTemplate.png        the menu-bar icon, 18 px, black on transparent (macOS tints a "Template" image)
#   loader/ui/trayTemplate@2x.png     and at 36 px for Retina screens
# Needs macOS (sips, iconutil) and Google Chrome (renders the SVG; override with CHROME=/path/to/chrome). Nothing is sent anywhere.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS="$HERE/icons"
UI="$HERE/../ui"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "make-icons: Google Chrome not found at $CHROME (set CHROME=...)" >&2; exit 1; }
command -v iconutil > /dev/null || { echo "make-icons: iconutil is part of macOS; run this on a Mac" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# render SVG PNG SIZE: a PNG with a transparent background
render() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$3,$3" --screenshot="$2" "file://$1" > /dev/null 2>&1
  [ -s "$2" ] || { echo "make-icons: rendering $1 failed" >&2; exit 1; }
}

echo "== the app icon"
render "$ICONS/app-icon.svg" "$WORK/icon-1024.png" 1024
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  set -- $spec
  sips -z "$1" "$1" "$WORK/icon-1024.png" --out "$ICONSET/$2.png" > /dev/null
done
iconutil -c icns "$ICONSET" -o "$HERE/icon.icns"
sips -z 512 512 "$WORK/icon-1024.png" --out "$UI/icon.png" > /dev/null

echo "== the menu-bar icon"
render "$ICONS/tray.svg" "$WORK/tray-1024.png" 1024
sips -z 36 36 "$WORK/tray-1024.png" --out "$UI/trayTemplate@2x.png" > /dev/null
sips -z 18 18 "$WORK/tray-1024.png" --out "$UI/trayTemplate.png" > /dev/null

ls -l "$HERE/icon.icns" "$UI/icon.png" "$UI/trayTemplate.png" "$UI/trayTemplate@2x.png" | awk '{print "  " $5 " bytes  " $9}'
