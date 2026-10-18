#!/usr/bin/env bash
# The network permission end to end (SPEC 8.3), whole stack: pack, install, `vmapp grant-net`, then `vmapp run --headless`
# in a REAL VM with a Node app on the node22 runtime (tests/net/app), against the REAL internet
# (https://registry.npmjs.org/left-pad). Assertions are in tests/net/net.mjs.
#
#   phase 1  granted, then revoked in the running app, then synced back
#   phase 2  no grant at all: the same fetch fails
#   phase 3  declined (grant-net --deny): the same fetch fails
#
# Needs: out/ built by tools/build.sh, out/runtimes/node22.img (tools/mkruntime) and a machine that can reach the npm
# registry (otherwise it prints SKIP and exits 0). Scratch space: $VMAPP_WORK/net (VMAPP_WORK defaults to vmapp/out/work).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
CLI="$VMAPP/tools/vmapp"
mkdir -p "${VMAPP_WORK:-$VMAPP/out/work}"
WORK="$(cd "${VMAPP_WORK:-$VMAPP/out/work}" && pwd)/net"
mkdir -p "$WORK"
export VMAPP_HOME="$WORK/home"
ID=dev.vmapp.nettest

die() { echo "net/run: $*" >&2; exit 2; }

[ -f "$VMAPP/out/runtimes/node22.img" ] || { echo "SKIP: no $VMAPP/out/runtimes/node22.img (tools/mkruntime)"; exit 0; }
curl -sS -m 8 -o /dev/null https://registry.npmjs.org/left-pad 2>/dev/null || { echo "SKIP: this machine cannot reach https://registry.npmjs.org"; exit 0; }

mkdir -p "$VMAPP_HOME"
"$CLI" runtime-install node22 "$VMAPP/out/runtimes/node22.img" > /dev/null || die "runtime-install failed"
"$CLI" pack "$HERE/app" -o "$WORK/nettest.vmapp" > "$WORK/pack.log" 2>&1 || { cat "$WORK/pack.log"; die "pack failed"; }
"$CLI" uninstall "$ID" --purge > /dev/null 2>&1 || true
"$CLI" install "$WORK/nettest.vmapp" > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; die "install failed"; }

echo "== the install review lists the request, and nothing is allowed yet"
"$CLI" inspect "$WORK/nettest.vmapp" | grep -F 'network registry.npmjs.org:443' || die "inspect does not list the network request"
"$CLI" grant-net "$ID" --list | grep -F 'not granted' > /dev/null || die "a fresh install must have nothing granted"

PASSES=0
FAILS=0
run_test() { # run_test NAME  vmapp-run-args...
  local name=$1; shift
  local log="$WORK/$name.log"
  if "$CLI" run "$@" > "$log" 2>&1 && ! grep -q '^\[run\] failed' "$log"; then
    echo "PASS: $name"; PASSES=$((PASSES + 1))
    grep -E '^\s+ok [0-9]+:|^\[net\]' "$log" | sed 's/^/    /'
  else
    echo "FAIL: $name  (log: $log)"; FAILS=$((FAILS + 1))
    tail -30 "$log" | sed 's/^/    | /'
  fi
}

echo "== phase 1: granted -> 200; refused host; revoked while running; synced back"
"$CLI" grant-net "$ID" registry.npmjs.org || die "grant-net failed"
NET_PHASE=granted run_test net-granted "$ID" --headless --script "$HERE/net.mjs" --timeout 60000

echo "== phase 2: no grant"
"$CLI" grant-net "$ID" registry.npmjs.org --revoke > /dev/null || die "grant-net --revoke failed"
NET_PHASE=none run_test net-none "$ID" --headless --script "$HERE/net.mjs" --timeout 60000

echo "== phase 3: declined"
"$CLI" grant-net "$ID" registry.npmjs.org --deny > /dev/null || die "grant-net --deny failed"
NET_PHASE=none run_test net-declined "$ID" --headless --script "$HERE/net.mjs" --timeout 60000

echo
echo "net: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
