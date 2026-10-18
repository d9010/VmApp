#!/usr/bin/env bash
# EXPERIMENTAL backend (SPEC 8.7): the subset of tests/e2e.sh that applies to `vmapp-vm-krun`, run against the real launcher, the
# gpu kernel flavour (Image-gpu), the guest init and the native runtime with the test core tests/core-echo. Helper functions and
# many checks are adapted from tests/e2e.sh (same protocol, same expectations); what differs on this backend is said in the
# comments. Needs out/ built by tools/build.sh, out/krun (gpu/krun/build.sh), out/Image-gpu (kernel/build.sh --flavour gpu) and
# out/runtimes/native.img.
#
# Scenarios:
#   1  boot, one virtiofs device per static share, ro/rw/wo shares, appdata, live delivery, the render node's mode
#   2  runtime grants are refused: stdin `grant` answers an error line "not supported on the gpu backend"
#   4  core exit code            5  stdin shutdown (+ delivery of unsettled files)   6  parent death (kill -9) with piped stdio
#   7  stdin EOF                 8  SIGTERM                                          9  the VMM is a sandboxed child, gone at stop
#  10  network permission (SPEC 8.3) against local servers: allowed host, refusals, CONNECT tunnel, 1 MiB download, wildcard,
#      IP literal, LAN-resolving name, live revoke closing an open tunnel, net events
#  12  host services (SPEC 8.6): the tunnel over vsock 1022/1025, 64 MiB each way, revoke
#  13  the watchdog: a VMM that stops answering (SIGSTOP) is killed, `stopped` says reason gpu-hang
#
# Environment: VMAPP_WORK (scratch; default out/work, this test uses $VMAPP_WORK/krun-e2e), VMAPP_VM_KRUN, VMAPP_KERNEL_GPU,
# VMAPP_INITRAMFS, VMAPP_CORE_ECHO, VMAPP_KRUN_DIR (passed as --krun-dir; default: the folder above the launcher).
set -u

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTD="$VMAPP/out"
VM="${VMAPP_VM_KRUN:-$OUTD/krun/bin/vmapp-vm-krun}"
KERNEL="${VMAPP_KERNEL_GPU:-$OUTD/Image-gpu}"
INITRAMFS="${VMAPP_INITRAMFS:-$OUTD/initramfs.cpio}"
RUNTIME="$OUTD/runtimes/native.img"
CORE="${VMAPP_CORE_ECHO:-$OUTD/test/core-echo.cpio}"
mkdir -p "${VMAPP_WORK:-$OUTD/work}/krun-e2e"
W="$(cd "${VMAPP_WORK:-$OUTD/work}/krun-e2e" && pwd)"
# scratch (the padded core image, the VMM's run folder) lives under the work folder, not in the system temp folder
mkdir -p "$W/tmp"
export TMPDIR="$W/tmp"
START='{"command":["/app/core-echo"],"workdir":"/app","env":["X=1"]}'
KRUN_FLAGS=()
[ -n "${VMAPP_KRUN_DIR:-}" ] && KRUN_FLAGS=(--krun-dir "$VMAPP_KRUN_DIR")
FAILS=0
PASSES=0

for f in "$VM" "$KERNEL" "$INITRAMFS" "$RUNTIME" "$CORE"; do
  [ -f "$f" ] || { echo "missing $f (run tools/build.sh, gpu/krun/build.sh, kernel/build.sh --flavour gpu and tools/mkruntime first)"; exit 2; }
done

check() { # check NAME CONDITION-COMMAND...
  local name=$1; shift
  if "$@"; then echo "PASS: $name"; PASSES=$((PASSES + 1)); else echo "FAIL: $name"; FAILS=$((FAILS + 1)); fi
}
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
lacks() { case "$1" in *"$2"*) return 1 ;; *) return 0 ;; esac; }
wait_for() { # wait_for FILE FIXED-PATTERN TIMEOUT-SECONDS
  local i=0 max=$(( $3 * 10 ))
  while [ $i -lt $max ]; do grep -qF -- "$2" "$1" 2>/dev/null && return 0; sleep 0.1; i=$((i + 1)); done
  return 1
}
wait_file() { local i=0 max=$(( $2 * 10 )); while [ $i -lt $max ]; do [ -e "$1" ] && return 0; sleep 0.1; i=$((i + 1)); done; return 1; }
wait_gone() { local i=0 max=$(( $2 * 10 )); while [ $i -lt $max ]; do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; i=$((i + 1)); done; return 1; }
# The VMM processes of the libkrun backend: `vmapp-vm-krun __vmm <spec>`.
vmm_count() { pgrep -f 'vmapp-vm-krun __vmm' 2>/dev/null | wc -l | tr -d ' '; }
wait_vmm_count() { local i=0 max=$(( $2 * 10 )); while [ $i -lt $max ]; do [ "$(vmm_count)" -le "$1" ] && return 0; sleep 0.1; i=$((i + 1)); done; return 1; }

# One request line through the bridge socket (q.mjs keeps the connection open until the reply: see its header).
q() { node "$VMAPP/tests/gpu-vulkan/q.mjs" "$SOCK" "$1" 2>/dev/null | head -1; }

T="" SOCK="" OUT="" ERR="" VMPID=""
start_vm() { # start_vm LABEL [extra launcher args...]  -> sets T SOCK OUT ERR VMPID, fd 3 = the VM's stdin
  local label=$1; shift
  T=$(mktemp -d /tmp/vmapp-XXXXXX)
  SOCK="$T/b.sock"; OUT="$T/out"; ERR="$T/err"
  mkfifo "$T/in"
  "$VM" run --kernel "$KERNEL" --initramfs "$INITRAMFS" --runtime "${E2E_RUNTIME:-$RUNTIME}" --core "${E2E_CORE:-$CORE}" \
    --appdata "$W/appdata" --start "${E2E_START:-$START}" --socket "$SOCK" --console "$W/$label.console.log" ${KRUN_FLAGS[@]+"${KRUN_FLAGS[@]}"} "$@" \
    < "$T/in" > "$OUT" 2> "$ERR" &
  VMPID=$!
  exec 3> "$T/in"
  if ! wait_for "$OUT" '"ready":true' 40; then
    echo "FAIL: $label did not become ready"; FAILS=$((FAILS + 1))
    tail -5 "$OUT" "$ERR" "$W/$label.console.log" 2>/dev/null
  fi
}
check_vm_exit0() { local rc=0; wait "$VMPID" || rc=$?; check "$1" test "$rc" -eq 0; }
send() { printf '%s\n' "$1" >&3; }
end_vm() { exec 3>&-; rm -f "$T/in" "$T/out" "$T/err" "$T/b.sock"; rmdir "$T" 2>/dev/null; }
stopped_line() { grep -F '"stopped"' "$OUT" | tail -1; }

SRVPID=""
cleanup() { [ -n "$VMPID" ] && kill "$VMPID" 2>/dev/null; [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null; return 0; }
trap cleanup EXIT

# ---- fixtures ----
mkdir -p "$W/appdata" "$W/f-ro" "$W/f-rw" "$W/f-out" "$W/pick" "$W/out5" "$W/out6" "$W/out7"
rm -f "$W/appdata/x.txt" "$W/f-rw/w.txt" "$W/f-ro/denied.txt" "$W/f-out/r.txt" "$W/f-out/r (1).txt" "$W/out5/.late" "$W/out5/late.partial" "$W/out6/.dot" "$W/out7/z.txt"
printf 'hello-ro' > "$W/f-ro/hello.txt"
BASE=$(vmm_count)

# ---- 1. boot + shares ----
echo "== 1. boot and shares (one virtiofs device per share)"
start_vm s1 --share "f-ro:ro:$W/f-ro" --share "f-rw:rw:$W/f-rw" --share "f-out:wo:$W/f-out"
check "1 ready line with pid" bash -c "grep -F '\"ready\":true' '$OUT' | grep -Eq '\"pid\":[0-9]+'"
check "1 ready line has socket and hello" bash -c "grep -F '\"ready\":true' '$OUT' | grep -F '\"socket\"' | grep -qF '\"hello\"'"
check "1 console: the 4 share devices probed" grep -qF 'virtiofs devices probed (4): appdata f-out f-ro f-rw' "$W/s1.console.log"
check "1 console: no grant slot devices" bash -c "! grep -qF 'vmapp-s0' '$W/s1.console.log'"
check "1 console: the render node is usable by the core" grep -qF 'GPU render node /dev/dri/renderD128 is usable by the core' "$W/s1.console.log"
r=$(q ENV)
check "1 ENV uid/gid 1000" bash -c "echo '$r' | jq -e '.uid == 1000 and .gid == 1000' >/dev/null"
check "1 ENV VMAPP_DATA=/data and HOME=/data" bash -c "echo '$r' | jq -e '.VMAPP_DATA == \"/data\" and .HOME == \"/data\"' >/dev/null"
r=$(q 'LS /host')
check "1 LS /host = appdata f-out f-ro f-rw" bash -c "[ \"\$(echo '$r' | jq -c .names)\" = '[\"appdata\",\"f-out\",\"f-ro\",\"f-rw\"]' ]"
r=$(q 'LS /dev/dri');  check "1 the render node is there for the core" has "$r" 'renderD128'
r=$(q 'READ /host/f-ro/hello.txt');           check "1 READ ro file" has "$r" 'hello-ro'
r=$(q 'WRITE /host/f-ro/denied.txt nope');    check "1 WRITE to ro refused" has "$r" '"ok":false'
check "1 ro file not created on host" test ! -e "$W/f-ro/denied.txt"
r=$(q 'WRITE /host/f-rw/w.txt rw-data');      check "1 WRITE to rw ok" has "$r" '"ok":true'
check "1 rw file on host" bash -c "[ \"\$(cat '$W/f-rw/w.txt' 2>/dev/null)\" = 'rw-data' ]"
r=$(q 'WRITE /data/x.txt app-data');          check "1 WRITE /data ok (the app user can write a share owned by the Mac user)" has "$r" '"ok":true'
check "1 appdata file on host" bash -c "[ \"\$(cat '$W/appdata/x.txt' 2>/dev/null)\" = 'app-data' ]"
r=$(q 'WRITE /host/f-out/r.txt out-data');    check "1 WRITE to wo ok" has "$r" '"ok":true'
check "1 wo file delivered live" wait_file "$W/f-out/r.txt" 6
check "1 exported line" wait_for "$OUT" '"exported":{"files":["r.txt"],"share":"f-out"}' 3
r=$(q 'LS /host/f-out');                      check "1 guest no longer sees the delivered file" bash -c "[ \"\$(echo '$r' | jq -c .names)\" = '[]' ]"

# ---- 2. runtime grants are not supported on this backend (B8) ----
echo "== 2. grants are refused"
send "{\"op\":\"grant\",\"name\":\"pick-0\",\"access\":\"ro\",\"path\":\"$W/pick\"}"
check "2 grant: error line says not supported on the gpu backend" wait_for "$OUT" 'not supported on the gpu backend' 5
check "2 grant: no granted line" bash -c "! grep -qF '\"granted\"' '$OUT'"
r=$(q 'LS /host/pick-0');                     check "2 nothing was mounted" has "$r" '"ok":false'
send '{"op":"revoke","name":"pick-0"}'
sleep 0.5
check "2 revoke of a grant that never existed: an error line, no crash" bash -c "grep -c '\"error\"' '$OUT' | grep -q '^[2-9]'"
r=$(q 'READ /data/x.txt');                    check "2 the VM is unaffected" has "$r" 'app-data'

# ---- 4. core exits ----
echo "== 4. core exit"
q 'EXIT 3' >/dev/null
check "4 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "4 reason core-exited" has "$(stopped_line)" '"reason":"core-exited"'
check "4 exitCode 3" has "$(stopped_line)" '"exitCode":3'
check "4 stopped exported map has f-out" has "$(stopped_line)" '"f-out":["r.txt"'
check "4 stopped line is last" bash -c "[ \"\$(tail -1 '$OUT')\" = \"\$(grep -F '\"stopped\"' '$OUT' | tail -1)\" ]"
check_vm_exit0 "4 vmapp-vm-krun exited 0"
check "4 socket removed" test ! -e "$SOCK"
check "4 VMM process gone" wait_vmm_count "$BASE" 8
end_vm; VMPID=""

# ---- 5. stdin shutdown ----
echo "== 5. shutdown via stdin"
start_vm s5 --share "f-out:wo:$W/out5"
q 'WRITE /host/f-out/.late hidden-until-stop' >/dev/null
q 'WRITE /host/f-out/late.partial partial-until-stop' >/dev/null
send '{"op":"shutdown"}'
check "5 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "5 reason shutdown" has "$(stopped_line)" '"reason":"shutdown"'
check "5 unsettled files delivered at stop" bash -c "test -e '$W/out5/.late' && test -e '$W/out5/late.partial'"
check_vm_exit0 "5 vmapp-vm-krun exited 0"
check "5 VMM process gone" wait_vmm_count "$BASE" 8
end_vm; VMPID=""

# ---- 6. parent death with piped stdio ----
echo "== 6. parent killed -9 (piped stdio)"
T6=$(mktemp -d /tmp/vmapp-XXXXXX)
SOCK="$T6/b.sock"; OUT="$T6/out"; : > "$OUT"
node -e '
const { spawn } = require("child_process"), fs = require("fs");
const [vm, outf, pidf, ...args] = process.argv.slice(1);
const p = spawn(vm, args, { stdio: ["pipe", "pipe", "pipe"] });
fs.writeFileSync(pidf, String(p.pid));
p.stdout.on("data", (d) => fs.appendFileSync(outf, d));
p.stderr.on("data", () => {});
setInterval(() => {}, 1000);
' "$VM" "$OUT" "$T6/vm.pid" run --kernel "$KERNEL" --initramfs "$INITRAMFS" --runtime "$RUNTIME" --core "$CORE" \
  --appdata "$W/appdata" --start "$START" --socket "$SOCK" --console "$W/s6.console.log" --share "f-out:wo:$W/out6" ${KRUN_FLAGS[@]+"${KRUN_FLAGS[@]}"} &
PARENT=$!
disown "$PARENT" 2>/dev/null
check "6 ready line" wait_for "$OUT" '"ready":true' 40
wait_file "$T6/vm.pid" 5
VM6=$(cat "$T6/vm.pid" 2>/dev/null || echo 0)
q 'WRITE /host/f-out/.dot delivered-on-parent-death' >/dev/null
sleep 0.3
kill -9 "$PARENT" 2>/dev/null
T0=$SECONDS
check "6 vmapp-vm-krun exits within 8 s of the parent's death" wait_gone "$VM6" 8
echo "     (took $((SECONDS - T0)) s)"
check "6 the VMM child is gone too" wait_vmm_count "$BASE" 8
check "6 wo output delivered" wait_file "$W/out6/.dot" 3
rm -f "$T6/vm.pid" "$OUT" "$SOCK"; rmdir "$T6" 2>/dev/null

# ---- 7. stdin EOF ----
echo "== 7. stdin EOF"
start_vm s7 --share "f-out:wo:$W/out7"
q 'WRITE /host/f-out/z.txt zz' >/dev/null
exec 3>&-
check "7 stopped line printed after EOF" wait_for "$OUT" '"stopped":true' 20
check "7 reason parent-exited" has "$(stopped_line)" '"reason":"parent-exited"'
check "7 wo output delivered" test -e "$W/out7/z.txt"
check_vm_exit0 "7 vmapp-vm-krun exited 0"
check "7 VMM process gone" wait_vmm_count "$BASE" 8
end_vm; VMPID=""

# ---- 8. SIGTERM ----
echo "== 8. SIGTERM"
start_vm s8
kill -TERM "$VMPID"
check "8 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "8 reason signal" has "$(stopped_line)" '"reason":"signal"'
check_vm_exit0 "8 vmapp-vm-krun exited 0"
check "8 VMM process gone" wait_vmm_count "$BASE" 8
end_vm; VMPID=""

# ---- 9. the VMM is a sandboxed child ----
echo "== 9. the sandboxed VMM"
start_vm s9 --id e2e9krun
VMM_PID=$(pgrep -P "$VMPID" -f '__vmm' | head -1)
check "9 a VMM child process exists" test -n "$VMM_PID"
check "9 its parent is the launcher" bash -c "[ \"\$(ps -o ppid= -p '$VMM_PID' | tr -d ' ')\" = '$VMPID' ]"
check "9 the launcher itself loaded no GPU stack" bash -c "! /usr/bin/vmmap '$VMPID' 2>/dev/null | grep -qE 'libMoltenVK|libvirglrenderer|libkrun'"
check "9 the VMM has no network: it holds no inet socket" bash -c "! lsof -a -p '$VMM_PID' -i 2>/dev/null | grep -q ."
send '{"op":"shutdown"}'
check "9 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "9 vmapp-vm-krun exited 0"
check "9 no run folder left behind" test ! -e "${TMPDIR%/}/vmapp-e2e9krun-k"
end_vm; VMPID=""

# ---- 10. network permission (SPEC 8.3) ----
echo "== 10. network (allowlist proxy)"
NETD="$W/net10"; mkdir -p "$NETD"; rm -f "$NETD/server.out"
node "$VMAPP/tests/net/server.js" < /dev/null > "$NETD/server.out" &
SRVPID=$!
check "10 local test servers started" wait_for "$NETD/server.out" '"http"' 10
P_HTTP=$(jq -r .http "$NETD/server.out" 2>/dev/null); P_ECHO=$(jq -r .echo "$NETD/server.out" 2>/dev/null)
DEVNET=(--dev-allow-loopback --dev-resolve ok.example.test=127.0.0.1 --dev-resolve other.example.test=127.0.0.1
        --dev-resolve a.wild.example.test=127.0.0.1 --dev-resolve rebind.example.test=192.168.1.10)
start_vm s10 --net "ok.example.test:$P_HTTP,$P_ECHO" --net "*.wild.example.test:$P_HTTP" --net "rebind.example.test:$P_HTTP" "${DEVNET[@]}"
CON10="$W/s10.console.log"
r=$(q ENV); check "10 core env HTTPS_PROXY" has "$r" '"HTTPS_PROXY":"http://127.0.0.1:3128"'
check "10 console: the host opened the network channel" wait_for "$CON10" 'net: the host opened the network channel' 5
r=$(q "HTTPGET ok.example.test $P_HTTP /hello")
check "10 allowed host, plain HTTP: 200" has "$r" '"status":200'
check "10 allowed host: the host server's body arrives" has "$r" 'hello from the host server'
r=$(q "HTTPGET a.wild.example.test $P_HTTP /hello"); check "10 wildcard rule covers a subdomain" has "$r" '"status":200'
r=$(q "CONNECT ok.example.test $P_ECHO ping-123")
check "10 CONNECT tunnel: 200 and the echo" bash -c "echo '$r' | jq -e '.status == 200 and .text == \"ping-123\"' >/dev/null"
r=$(q "HTTPGET ok.example.test $P_HTTP /big");        check "10 1 MiB download through the tunnel" has "$r" '"bytes":1048576'
r=$(q "HTTPGET other.example.test $P_HTTP /hello");   check "10 host not in the rules: 403" has "$r" '"status":403'
r=$(q "HTTPGET ok.example.test 1 /hello");            check "10 port not in the rules: 403" has "$r" '"status":403'
r=$(q "HTTPGET wild.example.test $P_HTTP /hello");    check "10 a wildcard does not cover the bare suffix" has "$r" '"status":403'
r=$(q "HTTPGET 127.0.0.1 $P_HTTP /hello");            check "10 IP literal: refused" has "$r" 'IP addresses are not allowed'
r=$(q "HTTPGET rebind.example.test $P_HTTP /hello");  check "10 name that resolves to a LAN address: 403" has "$r" '"status":403'
r=$(q "TUNNEL ok.example.test $P_ECHO");              check "10 long-lived tunnel opened" has "$r" '"ok":true'
TID=$(echo "$r" | jq -r .id)
r=$(q "PING $TID");                                   check "10 the tunnel carries data" has "$r" '"ok":true'
send '{"op":"net-revoke","rule":"ok.example.test"}'
check "10 net-revoked line says one connection closed" wait_for "$OUT" '"net-revoked":{"closed":1,"rule":"ok.example.test"}' 5
echo "     (net-revoked line: $(grep -F '"net-revoked"' "$OUT" | head -1))"
r=$(q "PING $TID");                                   check "10 the open tunnel was closed by the revoke" has "$r" '"ok":false'
send "{\"op\":\"net-allow\",\"rule\":\"ok.example.test:$P_HTTP\"}"
check "10 net-allowed line" wait_for "$OUT" "\"net-allowed\":{\"rule\":\"ok.example.test:$P_HTTP\"}" 5
r=$(q "HTTPGET ok.example.test $P_HTTP /hello");      check "10 after net-allow: access again" has "$r" '"status":200'
send '{"op":"shutdown"}'
check "10 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "10 event: allowed request with bytes both ways" bash -c "grep -F '\"net\":{' '$OUT' | grep -F '\"host\":\"ok.example.test\"' | grep -F '\"allowed\":true' | grep -Eq '\"bytesDown\":[1-9][0-9]*,\"bytesUp\":[1-9][0-9]*'"
check "10 event: refused host is allowed:false" bash -c "grep -F '\"net\":{' '$OUT' | grep -F '\"host\":\"other.example.test\"' | grep -qF '\"allowed\":false'"
check "10 event: stopped line is last" bash -c "[ \"\$(tail -1 '$OUT')\" = \"\$(grep -F '\"stopped\"' '$OUT' | tail -1)\" ]"
check_vm_exit0 "10 vmapp-vm-krun exited 0"
end_vm; VMPID=""
kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null; SRVPID=""

# ---- 12. host services (SPEC 8.6) over the libkrun vsock ----
echo "== 12. host service (the GPU tunnel)"
SVCD="$W/svc12"; mkdir -p "$SVCD"; rm -f "$SVCD/server.out"
node "$VMAPP/tests/net/server.js" < /dev/null > "$SVCD/server.out" &
SRVPID=$!
check "12 the dummy service started" wait_for "$SVCD/server.out" '"echo"' 10
P_SVC=$(jq -r .echo "$SVCD/server.out" 2>/dev/null)
start_vm s12 --service "gpu=127.0.0.1:$P_SVC"
check "12 console: the guest listens on 127.0.0.1:50052" wait_for "$W/s12.console.log" 'service: gpu listening on 127.0.0.1:50052' 5
r=$(q 'SVC 50052 hello-gpu')
check "12 bytes go to the host service and come back" bash -c "echo '$r' | jq -e '.ok == true and .text == \"hello-gpu\"' >/dev/null"
r=$(q 'SVCBIG 50052 67108864')
check "12 64 MiB each way through the tunnel, unchanged" bash -c "echo '$r' | jq -e '.ok == true and .bytes == 67108864' >/dev/null"
echo "  info: 64 MiB there and back took $(echo "$r" | jq -r '.ms // "?"') ms"
r=$(q 'SVCOPEN 50052'); SID=$(echo "$r" | jq -r .id)
r=$(q "PING $SID");                          check "12 a long-lived connection carries data" has "$r" '"ok":true'
send '{"op":"service-revoke","name":"gpu"}'
check "12 service-revoked line: the open tunnel was closed" wait_for "$OUT" '"service-revoked":{"closed":1,"name":"gpu"}' 5
r=$(q "PING $SID");                          check "12 the long-lived connection is closed by the revoke" has "$r" '"ok":false'
send '{"op":"shutdown"}'
check "12 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "12 vmapp-vm-krun exited 0"
end_vm; VMPID=""
kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null; SRVPID=""

# ---- 13. the watchdog ----
echo "== 13. watchdog: a VMM that stops answering is killed"
start_vm s13 --watchdog 4
r=$(q 'READ /data/x.txt'); check "13 the VM answers before" has "$r" 'app-data'
VMM_PID=$(pgrep -P "$VMPID" -f '__vmm' | head -1)
kill -STOP "$VMM_PID"
T0=$SECONDS
check "13 stopped line printed (the VMM is frozen, the launcher kills it)" wait_for "$OUT" '"stopped":true' 30
echo "     (took $((SECONDS - T0)) s with --watchdog 4)"
check "13 reason gpu-hang" has "$(stopped_line)" '"reason":"gpu-hang"'
check "13 detail says what was seen" has "$(stopped_line)" 'detail'
check_vm_exit0 "13 vmapp-vm-krun exited 0"
check "13 VMM process gone" wait_vmm_count "$BASE" 8
end_vm; VMPID=""

echo
echo "$PASSES passed, $FAILS failed"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
exit 1
