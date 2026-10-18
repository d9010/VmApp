#!/usr/bin/env bash
# Proves that the starter template works exactly as a developer gets it: `vmapp new demo` into a scratch folder, then
# run the COPIED app's own test/run.sh (pack, install, grant a folder, two headless runs in real VMs).
#
# Needs: out/ built (vmapp-vm, Image, initramfs) and out/runtimes/node22.img.
# Uses its own data root (default $VMAPP_WORK/template/home; VMAPP_WORK defaults to vmapp/out/work), so it never
# touches your real apps.
set -euo pipefail

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
WORK="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)"

export VMAPP_HOME="${VMAPP_HOME:-$WORK/template/home}"
export VMAPP_CLI="$CLI"

if [ ! -f "$VMAPP_HOME/runtimes/node22.img" ]; then
  [ -f "$VMAPP/out/runtimes/node22.img" ] || { echo "missing $VMAPP/out/runtimes/node22.img (build it with tools/mkruntime)" >&2; exit 2; }
  "$CLI" runtime-install node22 "$VMAPP/out/runtimes/node22.img"
fi

SCRATCH_PARENT="$WORK/scratch/template"
mkdir -p "$SCRATCH_PARENT"
SCRATCH="$(mktemp -d "$SCRATCH_PARENT/run-XXXXXX")"
echo "== scratch: $SCRATCH"

echo "== vmapp new demo"
(cd "$SCRATCH" && "$CLI" new demo)

APP="$SCRATCH/demo"
grep -q '"id": "com.example.demo"' "$APP/vmapp.json" || { echo "FAIL: id was not replaced in vmapp.json" >&2; exit 1; }
grep -q '"name": "Demo"' "$APP/vmapp.json" || { echo "FAIL: name was not replaced in vmapp.json" >&2; exit 1; }

echo "== run the copied app's own test"
OUTPUT="$("$APP/test/run.sh" 2>&1)" || { echo "$OUTPUT" | grep -v 'host: spawn ' | tail -40; echo "FAIL: the copied app's test/run.sh failed" >&2; exit 1; }
echo "$OUTPUT" | grep -v 'host: spawn ' | grep -E '^(==|ok - |STARTER-OK|PASS)' || true

case "$OUTPUT" in
  *"PASS: com.example.demo (both runs)"*) echo "PASS: template works as copied (com.example.demo)" ;;
  *) echo "FAIL: no PASS line from the copied app's test" >&2; exit 1 ;;
esac
