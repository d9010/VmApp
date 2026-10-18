#!/usr/bin/env bash
# Builds the converted Bookmarks app:
#   1. checks that converted/core/{server.js,package.json} and converted/ui/{app.js,style.css} are byte-identical to
#      the original (that is the whole point of the conversion), and copies package-lock.json next to them;
#   2. `npm ci --omit=dev` in converted/core (installs the pinned Express into converted/core/node_modules);
#   3. `vmapp pack converted -o <output>`.
#
# usage: build.sh [--streaming] [output.vmapp]     (default: dist/bookmarks.vmapp next to this script)
#   --streaming   the same app on the STREAMED bridge (docs/CONVERTING.md 5.3): packs a staged copy of converted/ in which
#                 core/http-bridge.js (sdk/node/http-bridge.js) is added and ui/bridge-fetch.js is replaced by ui/vmapp-fetch.js
#                 (sdk/web/vmapp-fetch.js) in index.html. converted/ itself is not touched. Default output: dist/bookmarks-streaming.vmapp.
# env:   NPM_CONFIG_CACHE  npm cache directory (optional)
#        VMAPP_WORK        where the staged copy lives (default out/work, git-ignored)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
STREAMING=0
if [ "${1:-}" = "--streaming" ]; then STREAMING=1; shift; fi
if [ "$STREAMING" -eq 1 ]; then OUT="${1:-$HERE/dist/bookmarks-streaming.vmapp}"; else OUT="${1:-$HERE/dist/bookmarks.vmapp}"; fi
mkdir -p "$(dirname "$OUT")"

for pair in server.js:core/server.js package.json:core/package.json public/app.js:ui/app.js public/style.css:ui/style.css; do
  orig="${pair%%:*}"; conv="${pair##*:}"
  cmp -s "$HERE/original/$orig" "$HERE/converted/$conv" || { echo "build: converted/$conv differs from original/$orig" >&2; exit 1; }
done
cp "$HERE/original/package-lock.json" "$HERE/converted/core/package-lock.json"

echo "== npm ci --omit=dev (converted/core)"
(cd "$HERE/converted/core" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline)

SRC="$HERE/converted"
if [ "$STREAMING" -eq 1 ]; then
  WORK="${VMAPP_WORK:-$VMAPP/out/work}"
  mkdir -p "$WORK/convert"
  STAGE="$(cd "$WORK/convert" && pwd)/bookmarks-streaming-$(date +%Y%m%d%H%M%S)" # a new folder each time; old ones are left
  echo "== staging the streaming variant in $STAGE"
  mkdir -p "$STAGE"
  cp -R "$HERE/converted/." "$STAGE/"
  cp "$VMAPP/sdk/node/http-bridge.js" "$STAGE/core/http-bridge.js"
  cp "$VMAPP/sdk/web/vmapp-fetch.js" "$STAGE/ui/vmapp-fetch.js"
  rm -f "$STAGE/ui/bridge-fetch.js"
  sed 's|<script src="bridge-fetch.js"></script>|<script src="vmapp-fetch.js" data-prefix="/api/"></script>|' "$HERE/converted/ui/index.html" > "$STAGE/ui/index.html"
  grep -q 'vmapp-fetch.js' "$STAGE/ui/index.html" || { echo "build: the script tag of index.html was not replaced" >&2; exit 1; }
  SRC="$STAGE"
fi

echo "== vmapp pack"
"$VMAPP/tools/vmapp" pack "$SRC" -o "$OUT"
