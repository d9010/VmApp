#!/usr/bin/env bash
# test/run.sh: pack the app, install it, grant it a folder, and run test/starter.test.mjs against a real VM, twice.
#
# Why twice? The second run proves that the counter written by the first run is still there: app data survives a
# restart. The first run starts from a clean slate (the app's data is purged), so the result is repeatable.
#
# Needs:
#   * the `vmapp` CLI. Put it on your PATH, or point VMAPP_CLI at it:  VMAPP_CLI=/path/to/vmapp/tools/vmapp
#   * the node22 runtime installed into the data root:  vmapp runtime-install node22 <path to node22.img>
#     (set VMAPP_HOME to use a data root other than the default; it is where apps, grants and data are kept)
#
# Usage:  test/run.sh        (from anywhere)
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the app folder (the one holding vmapp.json)
OUT="$APP/test/.out"                                      # scratch output; ignored by git
FIXTURES="$APP/test/fixtures"

VMAPP="${VMAPP_CLI:-$(command -v vmapp || true)}"
if [ -z "$VMAPP" ] || [ ! -x "$VMAPP" ]; then
  echo "vmapp CLI not found. Put it on PATH or set VMAPP_CLI=/path/to/vmapp/tools/vmapp" >&2
  exit 2
fi

# The id comes from vmapp.json, so this script keeps working after you rename the app.
ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).id)' "$APP/vmapp.json")"

mkdir -p "$OUT"
PKG="$OUT/app.vmapp"
SAVED="$OUT/saved.txt"

echo "== pack"
"$VMAPP" pack "$APP" -o "$PKG"

echo "== install ($ID), starting from a clean data folder"
"$VMAPP" uninstall "$ID" --purge >/dev/null 2>&1 || true
"$VMAPP" install "$PKG"

echo "== grant the 'documents' folder (what the permission sheet does in the loader)"
"$VMAPP" grant "$ID" documents "$FIXTURES/documents"

for RUN in 1 2; do
  echo "== headless run $RUN"
  rm -f -- "$SAVED"
  STARTER_RUN="$RUN" \
  STARTER_DOCS="$FIXTURES/documents" \
  STARTER_OPEN_FILE="$FIXTURES/sample.txt" \
  STARTER_SAVE_FILE="$SAVED" \
    "$VMAPP" run "$ID" --headless \
      --script "$APP/test/starter.test.mjs" \
      --open "$FIXTURES/sample.txt" \
      --save "$SAVED" \
      --allow-external
done

echo "PASS: $ID (both runs)"
