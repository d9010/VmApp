#!/usr/bin/env bash
# Conversion examples, in REAL VMs: packs examples/convert-electron/converted and examples/convert-webapp/converted,
# installs them into a private VMAPP_HOME, runs each headless twice, and prints PASS/FAIL per test. Exits non-zero on
# any failure.
#
#   bridge-fetch       unit checks of ui/bridge-fetch.js in Node (no VM)
#   mdviewer-run1/2    Markdown Viewer: window, open-file via the dialog, recent list persisted across two runs
#   bookmarks-run1/2   Bookmarks: GET/POST/DELETE through the 'http' bridge, data file on the host, persisted in run 2
#
# Needs: out/ built (tools/build.sh), out/runtimes/node22.img, node + npm (npm ci pulls the pinned Express from the
# cache $NPM_CONFIG_CACHE, default $VMAPP_WORK/cache/npm).
# Everything else lives under $VMAPP_WORK/convert (VMAPP_WORK defaults to vmapp/out/work, git-ignored).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
WORK="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)"
export VMAPP_HOME="$WORK/convert/home"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$WORK/cache/npm}"
export CONVERT_FIXTURES="$HERE/fixtures"
PKG="$WORK/convert/pkgs"
LOGS="$WORK/convert/logs"

PASSES=0
FAILS=0
mkdir -p "$VMAPP_HOME" "$PKG" "$LOGS"
die() { echo "run.sh: $*" >&2; exit 2; }

pass() { echo "PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL: $1  (log: $2)"; FAILS=$((FAILS + 1)); tail -25 "$2" | sed 's/^/    | /'; }

# ---- unit checks (no VM) ----------------------------------------------------------------------------------
echo "== bridge-fetch (unit)"
if node "$HERE/bridge-fetch.test.mjs" > "$LOGS/bridge-fetch.log" 2>&1; then
  pass "bridge-fetch ($(grep -c '^PASS' "$LOGS/bridge-fetch.log") checks)"
else
  fail bridge-fetch "$LOGS/bridge-fetch.log"
fi

# ---- runtime, build, pack, install ------------------------------------------------------------------------
if [ ! -f "$VMAPP_HOME/runtimes/node22.img" ]; then
  [ -f "$VMAPP/out/runtimes/node22.img" ] || die "missing $VMAPP/out/runtimes/node22.img (tools/mkruntime)"
  "$CLI" runtime-install node22 "$VMAPP/out/runtimes/node22.img" || die "runtime-install node22 failed"
fi

echo "== pack + install"
"$CLI" pack "$VMAPP/examples/convert-electron/converted" -o "$PKG/mdviewer.vmapp" > "$LOGS/pack-mdviewer.log" 2>&1 \
  || { cat "$LOGS/pack-mdviewer.log"; die "pack mdviewer failed"; }
"$VMAPP/examples/convert-webapp/build.sh" "$PKG/bookmarks.vmapp" > "$LOGS/build-bookmarks.log" 2>&1 \
  || { cat "$LOGS/build-bookmarks.log"; die "build bookmarks failed"; }
"$VMAPP/examples/convert-webapp/build.sh" --streaming "$PKG/bookmarks-streaming.vmapp" > "$LOGS/build-bookmarks-streaming.log" 2>&1 \
  || { cat "$LOGS/build-bookmarks-streaming.log"; die "build bookmarks (streaming) failed"; }
for pair in mdviewer:dev.vmapp.convert.mdviewer bookmarks:dev.vmapp.convert.bookmarks; do
  app="${pair%%:*}"; id="${pair##*:}"
  "$CLI" uninstall "$id" --purge > /dev/null 2>&1 || true # start from clean data and grants
  "$CLI" install "$PKG/$app.vmapp" > "$LOGS/install-$app.log" 2>&1 || { cat "$LOGS/install-$app.log"; die "install $app failed"; }
done

# ---- VM tests ---------------------------------------------------------------------------------------------
run_test() { # run_test NAME  vmapp-run-args...
  local name=$1; shift
  local log="$LOGS/$name.log"
  if "$CLI" run "$@" > "$log" 2>&1 && ! grep -q '^\[run\] failed' "$log"; then
    pass "$name"
  else
    fail "$name" "$log"
  fi
}

echo "== mdviewer (two runs)"
PHASE=1 run_test mdviewer-run1 dev.vmapp.convert.mdviewer --headless --script "$HERE/mdviewer.mjs" --open "$HERE/fixtures/sample.md"
PHASE=2 run_test mdviewer-run2 dev.vmapp.convert.mdviewer --headless --script "$HERE/mdviewer.mjs" --open "$HERE/fixtures/sample.md"

echo "== bookmarks (two runs)"
PHASE=1 run_test bookmarks-run1 dev.vmapp.convert.bookmarks --headless --script "$HERE/bookmarks.mjs"
PHASE=2 run_test bookmarks-run2 dev.vmapp.convert.bookmarks --headless --script "$HERE/bookmarks.mjs"

echo "== bookmarks on the streamed bridge (the same app with core/http-bridge.js and ui/vmapp-fetch.js; one run)"
"$CLI" uninstall dev.vmapp.convert.bookmarks --purge > /dev/null 2>&1 || true
"$CLI" install "$PKG/bookmarks-streaming.vmapp" > "$LOGS/install-bookmarks-streaming.log" 2>&1 || { cat "$LOGS/install-bookmarks-streaming.log"; die "install bookmarks-streaming failed"; }
run_test bookmarks-streaming dev.vmapp.convert.bookmarks --headless --script "$HERE/bookmarks-streaming.mjs"

# ---- package sizes ----------------------------------------------------------------------------------------
echo "== packages"
for app in mdviewer bookmarks; do
  echo "-- $app ($(wc -c < "$PKG/$app.vmapp" | tr -d ' ') bytes)"
  "$CLI" inspect "$PKG/$app.vmapp" | grep -E '^(package id|sizes)' | sed 's/^/   /'
done

echo
echo "convert: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
