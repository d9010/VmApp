#!/usr/bin/env bash
# End-to-end test of the app registry with a REAL VM: start the registry, publish apps/notes, `vmapp get --install` it
# into a fresh VMAPP_HOME, install the node22 runtime and run it headless in a VM (Apple Virtualization via vmapp-vm).
#
# Needs: out/ built by tools/build.sh (vmapp-vm, Image, initramfs.cpio) and out/runtimes/node22.img (tools/mkruntime).
# Everything lives under $VMAPP_WORK/registry-e2e (VMAPP_WORK defaults to vmapp/out/work); the server is stopped at the end.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
W="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)/registry-e2e"
# The registry's storage is append-only (events and packages are never rewritten or removed), so every run starts in a
# data directory of its own instead of wiping the last one. Old ones are left for you to delete.
DATA="$W/data-$(date +%Y%m%d-%H%M%S)-$$"
export VMAPP_HOME="$W/home"
PKG="$W/notes.vmapp"
LOG="$W/server.log"
RUNLOG="$W/run.log"
PASSES=0
FAILS=0
SERVER_PID=""

check() { # check NAME CONDITION-COMMAND...
  local name=$1; shift
  if "$@"; then echo "PASS: $name"; PASSES=$((PASSES + 1)); else echo "FAIL: $name"; FAILS=$((FAILS + 1)); fi
}
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; } # has HAYSTACK NEEDLE
die() { echo "e2e: $*" >&2; exit 2; }

for f in "$VMAPP/out/vmapp-vm" "$VMAPP/out/Image" "$VMAPP/out/initramfs.cpio" "$VMAPP/out/runtimes/node22.img"; do
  [ -f "$f" ] || die "missing $f (run vmapp/tools/build.sh and vmapp/tools/mkruntime first)"
done

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null
    local i=0
    while kill -0 "$SERVER_PID" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
    kill -KILL "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}
trap stop_server EXIT

# ---- clean slate (exact files only) ------------------------------------------------------------
mkdir -p "$W" "$DATA" "$VMAPP_HOME"
rm -f "$VMAPP_HOME/publish-tokens.json" "$LOG" "$RUNLOG"

# ---- server --------------------------------------------------------------------------------------
node "$VMAPP/registry/server.js" --port 0 --data "$DATA" > "$LOG" 2>&1 &
SERVER_PID=$!
URL=""
for _ in $(seq 1 50); do
  URL=$(sed -n 's/^vmapp-registry listening on \(http[^ ]*\) .*/\1/p' "$LOG" 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 0.1
done
[ -n "$URL" ] || { cat "$LOG"; die "the registry did not start"; }
export VMAPP_REGISTRY="$URL"
echo "registry at $URL (data $DATA)"

# ---- publish -------------------------------------------------------------------------------------
PACKED=$("$CLI" pack "$VMAPP/apps/notes" -o "$PKG") || die "pack failed"
PKGID=$(printf '%s\n' "$PACKED" | sed -n 's/^package id: //p')
OUT=$("$CLI" publish "$PKG" --name "E2E Tester" --email tester@example.test 2>&1); RC=$?
check "publish apps/notes (exit 0)" test "$RC" -eq 0
check "publish prints an owner token" has "$OUT" 'owner token:'
check "token saved with mode 0600" test "$(stat -f %Lp "$VMAPP_HOME/publish-tokens.json" 2>/dev/null || stat -c %a "$VMAPP_HOME/publish-tokens.json")" = "600"
OUT=$("$CLI" publish "$PKG" 2>&1); RC=$?
check "publishing the same version again is refused" test "$RC" -ne 0
check "the registry lists the app" has "$("$CLI" search notes)" 'dev.vmapp.notes'
check "unverified publisher is shown as such" has "$("$CLI" search notes)" 'Unverified publisher'

# ---- get --install -------------------------------------------------------------------------------
"$CLI" uninstall dev.vmapp.notes --purge > /dev/null 2>&1 || true
[ -f "$VMAPP_HOME/runtimes/node22.img" ] || "$CLI" runtime-install node22 "$VMAPP/out/runtimes/node22.img" > /dev/null || die "runtime-install failed"
OUT=$("$CLI" get dev.vmapp.notes --install 2>&1); RC=$?
check "get --install (exit 0)" test "$RC" -eq 0
check "get reports the package id of the published file" has "$OUT" "package id $PKGID"
check "get installed it" has "$OUT" 'installed dev.vmapp.notes 1.0.0'
check "installed package id equals the published one" has "$("$CLI" list --json)" "$PKGID"

# ---- versions: resolve, withdraw, restore (SPEC 8.1) ---------------------------------------------
check "resolve: latest from 1.0.0 is 1.0.0" has "$(curl -s "$URL/api/apps/dev.vmapp.notes/resolve?choice=latest&from=1.0.0")" '"version":"1.0.0"'
OUT=$("$CLI" withdraw dev.vmapp.notes 1.0.0 --reason "e2e withdrawal" 2>&1); RC=$?
check "withdraw 1.0.0 with the saved owner token (exit 0)" test "$RC" -eq 0
check "resolve: a withdrawn version is not picked" has "$(curl -s "$URL/api/apps/dev.vmapp.notes/resolve?choice=compatible&from=1.0.0")" '"version":null'
check "the versions list shows the reason" has "$(curl -s "$URL/api/apps/dev.vmapp.notes/versions")" '"reason":"e2e withdrawal"'
OUT=$("$CLI" withdraw dev.vmapp.notes 1.0.0 --reason "x" --token "$(printf '%064d' 0)" 2>&1); RC=$?
check "withdraw with a wrong token is refused" test "$RC" -ne 0
OUT=$("$CLI" restore dev.vmapp.notes 1.0.0 2>&1); RC=$?
check "restore 1.0.0 (exit 0)" test "$RC" -eq 0
check "resolve: restored version is picked again" has "$(curl -s "$URL/api/apps/dev.vmapp.notes/resolve?choice=compatible&from=1.0.0")" '"version":"1.0.0"'

# ---- run it in a real VM -------------------------------------------------------------------------
"$CLI" run dev.vmapp.notes --headless --duration 3000 > "$RUNLOG" 2>&1; RC=$?
check "headless run exits 0" test "$RC" -eq 0
check "the VM started the app and it opened a window" grep -q '^\[window\] 1 created: index.html' "$RUNLOG"
check "run reports 1 window" grep -q '^\[run\] windows created: 1' "$RUNLOG"
check "no run failure" bash -c "! grep -q '^\[run\] failed' '$RUNLOG'"
check "the registry counted the download" has "$(curl -s "$URL/api/apps/dev.vmapp.notes")" '"downloads":1'

SP=$SERVER_PID
stop_server
check "server stopped" bash -c "! kill -0 $SP 2>/dev/null"

# ---- the storage the server left behind: an event log plus a content-addressed package ----------------
STORE="$DATA/store"
check "events were written (publisher + version + withdraw + restore + counters)" test "$(find "$STORE/events" -name '*.json' | wc -l | tr -d ' ')" -ge 5
check "the package is a blob named by its SHA-256" test "$(find "$STORE/blobs/sha256" -name '*.vmapp' | wc -l | tr -d ' ')" -eq 1
check "no database file and no packages/ folder" bash -c "! [ -e '$DATA/db.json' ] && ! [ -e '$DATA/packages' ]"
check "admin verify passes (re-hashes the package, replays the log)" node "$VMAPP/registry/admin.js" verify --data "$DATA"

echo
echo "registry e2e: $PASSES passed, $FAILS failed"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
tail -20 "$RUNLOG" 2>/dev/null | sed 's/^/    | /'
exit 1
