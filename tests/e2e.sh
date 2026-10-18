#!/usr/bin/env bash
# End-to-end test of the host launcher (vmapp-vm) with the guest (vmapp-init), the native runtime and the
# test core tests/core-echo. Needs out/ built by tools/build.sh and out/runtimes/native.img (tools/mkruntime).
#
# Scenarios:
#   1 boot + shares: sandbox facts, pseudo-terminals (devpts), ro/rw/wo shares, appdata, live delivery, name clash
#   2 stdin grant/revoke (live set_shares)
#   3 save grant (single file, exact path, overwrite)
#   4 core exit code      5 stdin shutdown (+ delivery of unsettled files at stop)
#   6 parent death with piped stdio (kill -9)   7 stdin EOF   8 SIGTERM
#   9 grant slots: regression for "a runtime grant makes /data and the other mounts go stale", slot isolation,
#     slot re-use, 8 concurrent grants and the 9th refused
#  10 network permission (SPEC 8.3) against local servers (tests/net/server.js, reached with --dev-allow-loopback and
#     --dev-resolve): allowed host, refused host with reason, wildcard, IP literal, name resolving to a LAN address,
#     CONNECT tunnel, plain HTTP in origin form, byte counters in the net events, stdin net-revoke closing an open
#     tunnel, stdin net-allow, no grants (403, no channel), loopback refused without the test switch
#  11 network from a Node app in the node22 runtime against the REAL internet (https://registry.npmjs.org/left-pad):
#     granted -> 200; a host that was not granted -> refused; revoked while running -> fails; no grant -> fails.
#     Skipped (not failed) when node22.img is missing or the machine is offline.
#  12 host services (SPEC 8.6, the GPU tunnel) against a dummy TCP echo service on the host: the guest listens on
#     127.0.0.1:50052 only when the host was given --service gpu=..., bytes (including 64 MiB at once) go through the host's
#     loopback endpoint and back, `service` events with byte counters, a long-lived tunnel closed by stdin service-revoke
#     (the port is then closed), no service -> connection refused, a network rule change leaves the tunnel alone, the
#     network proxy cannot reach a service, and --service refuses everything but 127.0.0.1:PORT
# The grant mechanism (SPEC section 4): a static virtiofs device `vmapp` (appdata + f-*) that never changes
# after boot, plus 8 slot devices `vmapp-s0`..`s7`; a grant replaces one free slot's share only.
#
# Environment: VMAPP_WORK (scratch folder, default vmapp/out/work; this test uses $VMAPP_WORK/e2e),
#              VMAPP_KERNEL (boot another kernel Image, for example a candidate build; default out/Image),
#              VMAPP_VM, VMAPP_INITRAMFS, VMAPP_CORE_ECHO (test another build of the launcher, the guest init or the test
#              core, for example one built into $VMAPP_WORK; defaults out/vmapp-vm, out/initramfs.cpio, out/test/core-echo.cpio).
set -u

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTD="$VMAPP/out"
VM="${VMAPP_VM:-$OUTD/vmapp-vm}"
KERNEL="${VMAPP_KERNEL:-$OUTD/Image}"
INITRAMFS="${VMAPP_INITRAMFS:-$OUTD/initramfs.cpio}"
RUNTIME="$OUTD/runtimes/native.img"
CORE="${VMAPP_CORE_ECHO:-$OUTD/test/core-echo.cpio}"
mkdir -p "${VMAPP_WORK:-$OUTD/work}/e2e"
W="$(cd "${VMAPP_WORK:-$OUTD/work}/e2e" && pwd)"
START='{"command":["/app/core-echo"],"workdir":"/app","env":["X=1"]}'
FAILS=0
PASSES=0

# Build the runtime image if it is missing (needs Docker).
if [ ! -f "$RUNTIME" ] && [ -x "$VMAPP/tools/mkruntime" ]; then
  echo "building $RUNTIME"
  "$VMAPP/tools/mkruntime" "$VMAPP/runtimes/native" "$RUNTIME" || true
fi
for f in "$VM" "$KERNEL" "$INITRAMFS" "$RUNTIME" "$CORE"; do
  [ -f "$f" ] || { echo "missing $f (run vmapp/tools/build.sh and vmapp/tools/mkruntime first)"; exit 2; }
done

check() { # check NAME CONDITION-COMMAND...
  local name=$1; shift
  if "$@"; then echo "PASS: $name"; PASSES=$((PASSES + 1)); else echo "FAIL: $name"; FAILS=$((FAILS + 1)); fi
}
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; } # has HAYSTACK NEEDLE
lacks() { case "$1" in *"$2"*) return 1 ;; *) return 0 ;; esac; } # lacks HAYSTACK NEEDLE

wait_for() { # wait_for FILE FIXED-PATTERN TIMEOUT-SECONDS
  local i=0 max=$(( $3 * 10 ))
  while [ $i -lt $max ]; do
    grep -qF -- "$2" "$1" 2>/dev/null && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
wait_file() { # wait_file PATH TIMEOUT-SECONDS
  local i=0 max=$(( $2 * 10 ))
  while [ $i -lt $max ]; do
    [ -e "$1" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
wait_gone() { # wait_gone PID TIMEOUT-SECONDS
  local i=0 max=$(( $2 * 10 ))
  while [ $i -lt $max ]; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
vm_count() { pgrep -f com.apple.Virtualization.VirtualMachine 2>/dev/null | wc -l | tr -d ' '; }
wait_vm_count() { # wait_vm_count N TIMEOUT-SECONDS: until at most N VM processes exist
  local i=0 max=$(( $2 * 10 ))
  while [ $i -lt $max ]; do
    [ "$(vm_count)" -le "$1" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

# The core's reply to one request line through the bridge socket.
q() { printf '%s\n' "$1" | nc -U -w 8 "$SOCK" 2>/dev/null | head -1; }

T="" SOCK="" OUT="" ERR="" VMPID=""
# E2E_RUNTIME, E2E_CORE and E2E_START replace the defaults (the native runtime with core-echo) for one start_vm call.
start_vm() { # start_vm LABEL [extra vmapp-vm args...]  -> sets T SOCK OUT ERR VMPID, fd 3 = the VM's stdin
  local label=$1; shift
  T=$(mktemp -d /tmp/vmapp-XXXXXX)
  SOCK="$T/b.sock"; OUT="$T/out"; ERR="$T/err"
  mkfifo "$T/in"
  "$VM" run --kernel "$KERNEL" --initramfs "$INITRAMFS" --runtime "${E2E_RUNTIME:-$RUNTIME}" --core "${E2E_CORE:-$CORE}" \
    --appdata "$W/appdata" --start "${E2E_START:-$START}" --socket "$SOCK" --console "$W/$label.console.log" "$@" \
    < "$T/in" > "$OUT" 2> "$ERR" &
  VMPID=$!
  exec 3> "$T/in"
  if ! wait_for "$OUT" '"ready":true' 40; then
    echo "FAIL: $label did not become ready"; FAILS=$((FAILS + 1))
    tail -5 "$OUT" "$ERR" "$W/$label.console.log" 2>/dev/null
  fi
}
check_vm_exit0() { # waits for the current VM process (a child of this shell) and checks its exit status
  local rc=0
  wait "$VMPID" || rc=$?
  check "$1" test "$rc" -eq 0
}
send() { printf '%s\n' "$1" >&3; } # a JSON command line to the VM's stdin
# The regression for the stale-mount bug: after a runtime grant the core must still read and write /data
# (a bind of the static appdata share) and list a launch-time share, now and later.
core_mounts_ok() { # core_mounts_ok LABEL   (needs /data/x.txt = app-data and f-rw/w.txt from scenario 1)
  local r
  r=$(q 'READ /data/x.txt');                         check "$1: READ /data/x.txt" has "$r" 'app-data'
  r=$(q 'WRITE /data/x.txt app-data');               check "$1: WRITE /data/x.txt" has "$r" '"ok":true'
  r=$(q 'LS /host/f-rw');                            check "$1: LS /host/f-rw" has "$r" 'w.txt'
  r=$(q 'WRITE /host/f-rw/w2.txt still-writable');   check "$1: WRITE /host/f-rw" has "$r" '"ok":true'
}
count_lines() { grep -cF -- "$2" "$1" 2>/dev/null || true; } # count_lines FILE FIXED-PATTERN
end_vm() { # remove the temp files of the current VM
  exec 3>&-
  rm -f "$T/in" "$T/out" "$T/err" "$T/b.sock"
  rmdir "$T" 2>/dev/null
}
stopped_line() { grep -F '"stopped"' "$OUT" | tail -1; }

SRVPID=""
cleanup() {
  [ -n "$VMPID" ] && kill "$VMPID" 2>/dev/null
  [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# ---- fixtures ----------------------------------------------------------------------------------
mkdir -p "$W/appdata" "$W/f-ro" "$W/f-rw" "$W/f-out" "$W/pick" "$W/pick2" "$W/saved" "$W/saved2" "$W/out5" "$W/out6" "$W/out7"
rm -f "$W/appdata/x.txt" "$W/f-rw/w.txt" "$W/f-rw/w2.txt" "$W/f-ro/denied.txt" "$W/f-out/r.txt" "$W/f-out/r (1).txt" \
  "$W/saved/doc.txt" "$W/saved2/existing.txt" "$W/saved2/other.txt" "$W/pick2/w1.txt" \
  "$W/out5/.late" "$W/out5/late.partial" "$W/out5/a.txt" "$W/out6/.dot" "$W/out7/z.txt"
printf 'hello-ro' > "$W/f-ro/hello.txt"
printf 'picked' > "$W/pick/p1.txt"
printf 'picked-two' > "$W/pick2/p2.txt"
printf 'old' > "$W/saved2/existing.txt"

BASE=$(vm_count)

# ---- 1. boot + shares --------------------------------------------------------------------------
echo "== 1. boot and shares"
start_vm s1 --share "f-ro:ro:$W/f-ro" --share "f-rw:rw:$W/f-rw" --share "f-out:wo:$W/f-out"
check "1 ready line with pid" bash -c "grep -F '\"ready\":true' '$OUT' | grep -Eq '\"pid\":[0-9]+'"
check "1 ready line has socket and hello" bash -c "grep -F '\"ready\":true' '$OUT' | grep -F '\"socket\"' | grep -qF '\"hello\"'"

check "1 console: all 9 virtiofs devices probed" \
  grep -qF 'virtiofs devices probed (9): vmapp vmapp-s0 vmapp-s1 vmapp-s2 vmapp-s3 vmapp-s4 vmapp-s5 vmapp-s6 vmapp-s7' "$W/s1.console.log"

r=$(q ENV)
check "1 ENV VMAPP_ID" bash -c "echo '$r' | jq -e '.VMAPP_ID | length > 0' >/dev/null"
check "1 ENV VMAPP_DATA=/data" has "$r" '"VMAPP_DATA":"/data"'
check "1 ENV HOME=/data" has "$r" '"HOME":"/data"'
check "1 ENV uid 1000" has "$r" '"uid":1000'
check "1 ENV gid 1000" has "$r" '"gid":1000'
check "1 ENV cwd /app" has "$r" '"cwd":"/app"'
check "1 ENV X=1" has "$r" '"X":"1"'

# Pseudo-terminals (SPEC section 4: devpts at /dev/pts, /dev/ptmx -> pts/ptmx): the core opens one, resizes it and
# reads back what it wrote on the slave.
r=$(q PTY)
check "1 PTY: a core can open a pseudo-terminal through /dev/ptmx" has "$r" '"ok":true'
check "1 PTY: /dev/ptmx is a symlink to pts/ptmx" has "$r" '"ptmx":"pts/ptmx"'
check "1 PTY: the slave lives in /dev/pts" bash -c "echo '$r' | jq -e '.slave | test(\"^/dev/pts/[0-9]+\$\")' >/dev/null"
# (the native image has no /etc/group, so the group falls back to 0; a Debian image has `tty` = 5, see tests/apps/terminal.mjs)
check "1 PTY: slave owned by the app user, mode 0620" bash -c "echo '$r' | jq -e '.uid == 1000 and .gid == 0 and .mode == \"0620\"' >/dev/null"
check "1 PTY: what is written on the slave comes out of the master (LF -> CRLF)" bash -c "echo '$r' | jq -e '.text == \"pty-ok\\r\\n\"' >/dev/null"
check "1 PTY: the window size set on the master is read on the slave" bash -c "echo '$r' | jq -e '.rows == 7 and .cols == 40' >/dev/null"
check "1 console: devpts mounted" grep -qF 'devpts mounted at /rt/dev/pts' "$W/s1.console.log"

r=$(q 'LS /host')
check "1 LS /host = appdata f-out f-ro f-rw" bash -c "[ \"\$(echo '$r' | jq -c .names)\" = '[\"appdata\",\"f-out\",\"f-ro\",\"f-rw\"]' ]"
r=$(q 'READ /host/f-ro/hello.txt')
check "1 READ ro file" has "$r" 'hello-ro'
r=$(q 'WRITE /host/f-ro/denied.txt nope')
check "1 WRITE to ro refused" has "$r" '"ok":false'
check "1 ro file not created on host" test ! -e "$W/f-ro/denied.txt"
r=$(q 'WRITE /host/f-rw/w.txt rw-data')
check "1 WRITE to rw ok" has "$r" '"ok":true'
check "1 rw file on host" bash -c "[ \"\$(cat '$W/f-rw/w.txt' 2>/dev/null)\" = 'rw-data' ]"
r=$(q 'WRITE /data/x.txt app-data')
check "1 WRITE /data ok" has "$r" '"ok":true'
check "1 appdata file on host" bash -c "[ \"\$(cat '$W/appdata/x.txt' 2>/dev/null)\" = 'app-data' ]"

r=$(q 'WRITE /host/f-out/r.txt out-data')
check "1 WRITE to wo ok" has "$r" '"ok":true'
check "1 wo file delivered live" wait_file "$W/f-out/r.txt" 6
check "1 exported line" wait_for "$OUT" '"exported":{"files":["r.txt"],"share":"f-out"}' 3
r=$(q 'LS /host/f-out')
check "1 guest no longer sees delivered file" bash -c "[ \"\$(echo '$r' | jq -c .names)\" = '[]' ]"
# Known virtiofs behaviour: re-creating a name the host just moved away fails with ENOENT in the guest
# for a short while (stale cached directory entry); retrying works.
for _ in 1 2 3 4 5 6; do
  r=$(q 'WRITE /host/f-out/r.txt again')
  case "$r" in *'"ok":true'*) break ;; esac
  sleep 0.5
done
check "1 WRITE of the same name again ok (after the guest's stale entry expires)" has "$r" '"ok":true'
wait_for "$OUT" '"files":["r (1).txt"]' 6
check "1 name clash becomes 'r (1).txt'" test -e "$W/f-out/r (1).txt"
check "1 first delivery not overwritten" bash -c "[ \"\$(cat '$W/f-out/r.txt')\" = 'out-data' ]"

# ---- 2. stdin grant / revoke -------------------------------------------------------------------
echo "== 2. grant and revoke"
send "{\"op\":\"grant\",\"name\":\"pick-0\",\"access\":\"ro\",\"path\":\"$W/pick\"}"
check "2 granted line" wait_for "$OUT" '"granted":{"access":"ro","name":"pick-0"}' 5
r=$(q 'LS /host/pick-0')
check "2 guest sees granted folder (live set_shares)" has "$r" 'p1.txt'
r=$(q 'READ /host/pick-0/p1.txt')
check "2 granted file readable" has "$r" 'picked'
core_mounts_ok "2 after pick grant (immediately)"
sleep 2
core_mounts_ok "2 after pick grant (2 s later)"
r=$(q 'WRITE /host/pick-0/n.txt x')
check "2 granted ro folder not writable" has "$r" '"ok":false'
r=$(q 'LS /host')
check "2 LS /host lists pick-0" has "$r" 'pick-0'
send '{"op":"revoke","name":"pick-0"}'
check "2 revoked line" wait_for "$OUT" '"revoked":{"name":"pick-0"}' 5
r=$(q 'LS /host')
check "2 LS /host no longer lists pick-0" bash -c "! echo '$r' | grep -qF pick-0"
r=$(q 'LS /host/pick-0')
check "2 revoked folder gone" has "$r" '"ok":false'
send '{"op":"grant","name":"pick-1","access":"ro","path":"/nonexistent-dir-xyz"}'
check "2 bad grant gives error line" wait_for "$OUT" '"error":{"message"' 5
send '{"op":"grant","name":"appdata","access":"ro","path":"/tmp"}'
sleep 0.5
check "2 reserved name rejected" bash -c "grep -F 'reserved' '$OUT' | grep -qF '\"error\"'"

# ---- 3. save grants ----------------------------------------------------------------------------
echo "== 3. save grants"
send "{\"op\":\"grant\",\"name\":\"save-0\",\"access\":\"wo\",\"path\":\"$W/saved/doc.txt\"}"
check "3 save grant (new file path) granted" wait_for "$OUT" '"granted":{"access":"wo","name":"save-0"}' 5
core_mounts_ok "3 after save grant (immediately)"
sleep 2
core_mounts_ok "3 after save grant (2 s later)"
r=$(q 'WRITE /host/save-0/doc.txt saved-v1')
check "3 WRITE to save share ok" has "$r" '"ok":true'
check "3 delivered to the exact path" wait_file "$W/saved/doc.txt" 6
check "3 saved content" bash -c "[ \"\$(cat '$W/saved/doc.txt')\" = 'saved-v1' ]"
check "3 exported line for save-0" wait_for "$OUT" '"share":"save-0"' 3
send "{\"op\":\"grant\",\"name\":\"save-1\",\"access\":\"wo\",\"path\":\"$W/saved2/existing.txt\"}"
check "3 save grant (existing file) granted" wait_for "$OUT" '"granted":{"access":"wo","name":"save-1"}' 5
q 'WRITE /host/save-1/other.txt ignored' >/dev/null
q 'WRITE /host/save-1/existing.txt overwritten' >/dev/null
check "3 existing file overwritten" bash -c "
  for i in \$(seq 1 60); do [ \"\$(cat '$W/saved2/existing.txt')\" = 'overwritten' ] && exit 0; sleep 0.1; done; exit 1"
sleep 1.2
check "3 other names not delivered" test ! -e "$W/saved2/other.txt"
check "3 no stray files next to the saved file" bash -c "[ \"\$(ls -A '$W/saved2' | wc -l | tr -d ' ')\" = '1' ]"

# ---- 4. core exits -----------------------------------------------------------------------------
echo "== 4. core exit"
q 'EXIT 3' >/dev/null
check "4 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "4 reason core-exited" has "$(stopped_line)" '"reason":"core-exited"'
check "4 exitCode 3" has "$(stopped_line)" '"exitCode":3'
check "4 stopped exported map has f-out" has "$(stopped_line)" '"f-out":["r.txt","r (1).txt"]'
check "4 stopped line is last" bash -c "[ \"\$(tail -1 '$OUT')\" = \"\$(grep -F '\"stopped\"' '$OUT' | tail -1)\" ]"
check_vm_exit0 "4 vmapp-vm exited 0"
check "4 socket removed" test ! -e "$SOCK"
check "4 VM process gone" wait_vm_count "$BASE" 8
end_vm; VMPID=""

# ---- 5. stdin shutdown -------------------------------------------------------------------------
echo "== 5. shutdown via stdin"
start_vm s5 --share "f-out:wo:$W/out5"
q 'WRITE /host/f-out/.late hidden-until-stop' >/dev/null
q 'WRITE /host/f-out/late.partial partial-until-stop' >/dev/null
send '{"op":"shutdown"}'
check "5 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "5 reason shutdown" has "$(stopped_line)" '"reason":"shutdown"'
check "5 unsettled files delivered at stop" bash -c "test -e '$W/out5/.late' && test -e '$W/out5/late.partial'"
check_vm_exit0 "5 vmapp-vm exited 0"
check "5 VM process gone" wait_vm_count "$BASE" 8
end_vm; VMPID=""

# ---- 6. parent death with piped stdio ----------------------------------------------------------
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
  --appdata "$W/appdata" --start "$START" --socket "$SOCK" --console "$W/s6.console.log" --share "f-out:wo:$W/out6" &
PARENT=$!
disown "$PARENT" 2>/dev/null # no "Killed" job message when it is killed below
check "6 ready line" wait_for "$OUT" '"ready":true' 40
wait_file "$T6/vm.pid" 5
VM6=$(cat "$T6/vm.pid" 2>/dev/null || echo 0)
SOCK="$T6/b.sock" q 'WRITE /host/f-out/.dot delivered-on-parent-death' >/dev/null
sleep 0.3
kill -9 "$PARENT" 2>/dev/null
T0=$SECONDS
check "6 vmapp-vm exits within 8 s of the parent's death" wait_gone "$VM6" 8
echo "     (took $((SECONDS - T0)) s)"
check "6 VM process count back to baseline" wait_vm_count "$BASE" 8
check "6 wo output delivered" wait_file "$W/out6/.dot" 3
rm -f "$T6/vm.pid" "$OUT" "$SOCK"; rmdir "$T6" 2>/dev/null

# ---- 7. stdin EOF ------------------------------------------------------------------------------
echo "== 7. stdin EOF"
start_vm s7 --share "f-out:wo:$W/out7"
q 'WRITE /host/f-out/z.txt zz' >/dev/null
exec 3>&-
check "7 stopped line printed after EOF" wait_for "$OUT" '"stopped":true' 20
check "7 reason parent-exited" has "$(stopped_line)" '"reason":"parent-exited"'
check "7 wo output delivered" test -e "$W/out7/z.txt"
check_vm_exit0 "7 vmapp-vm exited 0"
check "7 VM process gone" wait_vm_count "$BASE" 8
end_vm; VMPID=""

# ---- 8. SIGTERM --------------------------------------------------------------------------------
echo "== 8. SIGTERM"
start_vm s8
kill -TERM "$VMPID"
check "8 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "8 reason signal" has "$(stopped_line)" '"reason":"signal"'
check_vm_exit0 "8 vmapp-vm exited 0"
check "8 VM process gone" wait_vm_count "$BASE" 8
end_vm; VMPID=""

# ---- 9. grant slots ----------------------------------------------------------------------------
echo "== 9. grant slots"
CON9="$W/s9.console.log"
grant() { send "{\"op\":\"grant\",\"name\":\"$1\",\"access\":\"$2\",\"path\":\"$3\"}"; } # grant NAME ACCESS PATH
start_vm s9 --share "f-rw:rw:$W/f-rw"
printf 'app-data' > "$W/appdata/x.txt"
printf 'rw' > "$W/f-rw/w.txt"
ID9=$(q ENV | jq -r .VMAPP_ID)
# The launcher puts the placeholder in std::env::temp_dir(): $TMPDIR, or on macOS without it the per-user temp folder.
TMPD="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp)}"
PH9="${TMPD%/}/vmapp-$ID9-placeholder"
check "9 placeholder folder exists while running" test -d "$PH9"

# slot isolation: a second grant leaves the first one (and /data, /host/f-rw) untouched
grant pick-0 ro "$W/pick"
check "9 pick-0 granted" wait_for "$OUT" '"granted":{"access":"ro","name":"pick-0"}' 5
r=$(q 'READ /host/pick-0/p1.txt'); check "9 pick-0 readable" has "$r" 'picked'
grant pick-1 rw "$W/pick2"
check "9 pick-1 granted" wait_for "$OUT" '"granted":{"access":"rw","name":"pick-1"}' 5
check "9 pick-0 on slot 0, pick-1 on slot 1" bash -c "grep -qF 'mounted slot 0 at /rt/host/pick-0 (read-only)' '$CON9' && grep -qF 'mounted slot 1 at /rt/host/pick-1' '$CON9'"
r=$(q 'READ /host/pick-0/p1.txt'); check "9 pick-0 still readable after granting pick-1" has "$r" 'picked'
r=$(q 'READ /host/pick-1/p2.txt'); check "9 pick-1 readable" has "$r" 'picked-two'
r=$(q 'WRITE /host/pick-1/w1.txt rw-in-slot'); check "9 pick-1 (rw) writable" has "$r" '"ok":true'
check "9 pick-1 write reached the host folder" bash -c "[ \"\$(cat '$W/pick2/w1.txt' 2>/dev/null)\" = 'rw-in-slot' ]"
r=$(q 'WRITE /host/pick-0/n.txt x'); check "9 pick-0 (ro) not writable" has "$r" '"ok":false'
core_mounts_ok "9 after two grants"

# revoke -> grant again re-uses the freed slot, and a fresh share root shows the new folder
send '{"op":"revoke","name":"pick-0"}'
check "9 pick-0 revoked" wait_for "$OUT" '"revoked":{"name":"pick-0"}' 5
r=$(q 'LS /host/pick-0'); check "9 revoked pick-0 is gone" has "$r" '"ok":false'
r=$(q 'READ /host/pick-1/p2.txt'); check "9 pick-1 unaffected by revoking pick-0" has "$r" 'picked-two'
grant pick-0 ro "$W/pick2"
check "9 pick-0 granted again" bash -c "for i in \$(seq 1 50); do [ \"\$(grep -cF '\"granted\":{\"access\":\"ro\",\"name\":\"pick-0\"}' '$OUT')\" = 2 ] && exit 0; sleep 0.1; done; exit 1"
check "9 pick-0 re-used slot 0" bash -c "[ \"\$(grep -cF 'mounted slot 0 at /rt/host/pick-0' '$CON9')\" = 2 ]"
r=$(q 'LS /host/pick-0'); check "9 re-granted slot shows the new folder (p2.txt, not p1.txt)" bash -c "[ \"\$(echo '$r' | jq -c .names)\" = '[\"p2.txt\",\"w1.txt\"]' ]"
core_mounts_ok "9 after revoke and re-grant"

# 8 grants at once fill every slot, the 9th is refused with an error line
send '{"op":"revoke","name":"pick-0"}'
send '{"op":"revoke","name":"pick-1"}'
check "9 both revoked" bash -c "for i in \$(seq 1 50); do [ \"\$(grep -cF '\"revoked\"' '$OUT')\" = 3 ] && exit 0; sleep 0.1; done; exit 1"
for n in 10 11 12 13 14 15 16 17; do grant "pick-$n" ro "$W/pick"; done
check "9 8 grants all answered" bash -c "for i in \$(seq 1 100); do [ \"\$(grep -cF '\"granted\":{\"access\":\"ro\",\"name\":\"pick-1' '$OUT')\" = 8 ]  && exit 0; sleep 0.1; done; exit 1"
ok8=0
for n in 10 11 12 13 14 15 16 17; do
  r=$(q "READ /host/pick-$n/p1.txt"); case "$r" in *picked*) ok8=$((ok8 + 1)) ;; esac
done
check "9 all 8 slot mounts readable" test "$ok8" = 8
check "9 8 grants used 8 different slots" bash -c "[ \"\$(grep -oE 'mounted slot [0-7] at /rt/host/pick-1[0-7]' '$CON9' | sed -E 's/ at .*//' | sort -u | wc -l | tr -d ' ')\" = 8 ]"
grant pick-18 ro "$W/pick"
check "9 9th grant yields an error line" wait_for "$OUT" 'slots are in use' 5
check "9 9th grant was not announced" bash -c "! grep -qF '\"name\":\"pick-18\"' '$OUT'"
r=$(q 'LS /host/pick-18'); check "9 9th grant not mounted" has "$r" '"ok":false'
core_mounts_ok "9 with all slots in use"
send '{"op":"revoke","name":"pick-13"}'
check "9 pick-13 revoked" wait_for "$OUT" '"revoked":{"name":"pick-13"}' 5
grant pick-18 ro "$W/pick"
check "9 a freed slot takes the next grant" wait_for "$OUT" '"granted":{"access":"ro","name":"pick-18"}' 5
r=$(q 'READ /host/pick-18/p1.txt'); check "9 pick-18 readable" has "$r" 'picked'
r=$(q 'READ /host/pick-17/p1.txt'); check "9 pick-17 still readable" has "$r" 'picked'
sleep 2
core_mounts_ok "9 after all grants (2 s later)"
send '{"op":"shutdown"}'
check "9 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "9 vmapp-vm exited 0"
check "9 VM process gone" wait_vm_count "$BASE" 8
check "9 placeholder folder removed" test ! -e "$PH9"
end_vm; VMPID=""

# ---- 10. network permission (SPEC 8.3) ---------------------------------------------------------
# The core is core-echo; it talks to the proxy in the guest (127.0.0.1:3128) exactly like an HTTP client would. The host
# side runs for real (rules, DNS table, address checks, tunnels); the servers are tests/net/server.js on 127.0.0.1,
# reachable only because of --dev-allow-loopback, and the .test names resolve through --dev-resolve (no DNS needed).
echo "== 10. network (allowlist proxy)"
NETD="$W/net10"
mkdir -p "$NETD"
rm -f "$NETD/server.out"
node "$VMAPP/tests/net/server.js" < /dev/null > "$NETD/server.out" &
SRVPID=$!
check "10 local test servers started" wait_for "$NETD/server.out" '"http"' 10
P_HTTP=$(jq -r .http "$NETD/server.out" 2>/dev/null); P_ECHO=$(jq -r .echo "$NETD/server.out" 2>/dev/null)
DEVNET=(--dev-allow-loopback --dev-resolve ok.example.test=127.0.0.1 --dev-resolve other.example.test=127.0.0.1
        --dev-resolve a.wild.example.test=127.0.0.1 --dev-resolve rebind.example.test=192.168.1.10)

start_vm s10 --net "ok.example.test:$P_HTTP,$P_ECHO" --net "*.wild.example.test:$P_HTTP" --net "rebind.example.test:$P_HTTP" "${DEVNET[@]}"
CON10="$W/s10.console.log"
r=$(q ENV)
check "10 core env HTTPS_PROXY" has "$r" '"HTTPS_PROXY":"http://127.0.0.1:3128"'
check "10 core env HTTP_PROXY and ALL_PROXY" bash -c "echo '$r' | jq -e '.env | .HTTP_PROXY == \"http://127.0.0.1:3128\" and .ALL_PROXY == \"http://127.0.0.1:3128\" and .https_proxy == \"http://127.0.0.1:3128\"' >/dev/null"
check "10 core env NO_PROXY" has "$r" '"NO_PROXY":"localhost,127.0.0.1"'
check "10 core env NODE_USE_ENV_PROXY=1" has "$r" '"NODE_USE_ENV_PROXY":"1"'
check "10 core env SSL_CERT_FILE (the runtime's CA bundle)" has "$r" '"SSL_CERT_FILE":"/etc/ssl/certs/ca-certificates.crt"'
check "10 console: proxy listening" grep -qF 'net: proxy listening on 127.0.0.1:3128' "$CON10"
check "10 console: the host opened the network channel" wait_for "$CON10" 'net: the host opened the network channel' 5

r=$(q "HTTPGET ok.example.test $P_HTTP /hello")
check "10 allowed host, plain HTTP: 200" has "$r" '"status":200'
check "10 allowed host: the host server's body arrives" has "$r" 'hello from the host server'
r=$(q "HTTPGET ok.example.test $P_HTTP /headers")
check "10 plain HTTP: target forwarded in origin form" has "$r" '\"url\":\"/headers\"'
check "10 plain HTTP: Connection: close was set" has "$r" 'connection\":\"close'
check "10 plain HTTP: no Proxy-Connection header reached the server" lacks "$r" 'proxy-connection'
r=$(q "HTTPGET a.wild.example.test $P_HTTP /hello");  check "10 wildcard rule covers a subdomain" has "$r" '"status":200'
r=$(q "CONNECT ok.example.test $P_ECHO ping-123")
check "10 CONNECT tunnel: 200 and the echo" bash -c "echo '$r' | jq -e '.status == 200 and .text == \"ping-123\"' >/dev/null"
r=$(q "HTTPGET ok.example.test $P_HTTP /big");        check "10 1 MiB download through the tunnel" has "$r" '"bytes":1048576'

r=$(q "HTTPGET other.example.test $P_HTTP /hello")
check "10 host not in the rules: 403" has "$r" '"status":403'
check "10 the refusal says why" has "$r" 'not allowed: other.example.test:'
r=$(q "HTTPGET ok.example.test 1 /hello");            check "10 port not in the rules: 403" has "$r" '"status":403'
r=$(q "HTTPGET wild.example.test $P_HTTP /hello");    check "10 a wildcard does not cover the bare suffix" has "$r" '"status":403'
r=$(q "HTTPGET 127.0.0.1 $P_HTTP /hello");            check "10 IP literal: refused, use a host name" has "$r" 'IP addresses are not allowed'
r=$(q "HTTPGET rebind.example.test $P_HTTP /hello")
check "10 allowed name that resolves to a LAN address: 403" has "$r" '"status":403'
check "10 the app is told the reason but not the address" bash -c "echo '$r' | jq -e '(.text | contains(\"resolves to a private or local address\")) and (.text | contains(\"192.168\") | not)' >/dev/null"
r=$(q "CONNECT other.example.test $P_ECHO x");         check "10 CONNECT to a host not in the rules: 403" has "$r" '"status":403'

# a long-lived tunnel, then a live revoke closes it; a live net-allow brings access back
r=$(q "TUNNEL ok.example.test $P_ECHO");  check "10 long-lived tunnel opened" has "$r" '"ok":true'
TID=$(echo "$r" | jq -r .id)
r=$(q "PING $TID");                        check "10 the tunnel carries data" has "$r" '"ok":true'
send '{"op":"net-revoke","rule":"ok.example.test"}'
check "10 net-revoked line says one connection closed" wait_for "$OUT" '"net-revoked":{"closed":1,"rule":"ok.example.test"}' 5
r=$(q "PING $TID");                        check "10 the open tunnel was closed by the revoke" has "$r" '"ok":false'
r=$(q "HTTPGET ok.example.test $P_HTTP /hello"); check "10 after the revoke: new connections are refused" has "$r" '"status":403'
send "{\"op\":\"net-allow\",\"rule\":\"ok.example.test:$P_HTTP\"}"
check "10 net-allowed line" wait_for "$OUT" "\"net-allowed\":{\"rule\":\"ok.example.test:$P_HTTP\"}" 5
r=$(q "HTTPGET ok.example.test $P_HTTP /hello"); check "10 after net-allow: access again" has "$r" '"status":200'
send '{"op":"net-allow","rule":"10.0.0.1"}'
check "10 net-allow of an IP literal is refused" wait_for "$OUT" '"error":{"message":"network rule' 5
send '{"op":"shutdown"}'
check "10 stopped line printed" wait_for "$OUT" '"stopped":true' 20
net_ev() { grep -F '"net":{' "$OUT" | grep -F "$1" | grep -F "$2"; } # net_ev HOST-FRAGMENT OTHER-FRAGMENT
check "10 event: allowed request with bytes both ways" bash -c "grep -F '\"net\":{' '$OUT' | grep -F '\"host\":\"ok.example.test\"' | grep -F '\"allowed\":true' | grep -Eq '\"bytesDown\":[1-9][0-9]*,\"bytesUp\":[1-9][0-9]*'"
check "10 event: the 1 MiB download was counted" bash -c "grep -F '\"net\":{' '$OUT' | grep -Eq '\"bytesDown\":(104[89][0-9]{3}|105[0-9]{4})'"
check "10 event: refused host is allowed:false with its reason" net_ev '"host":"other.example.test"' '"allowed":false'
check "10 event: the refusal carries the reason text" bash -c "grep -F '\"net\":{' '$OUT' | grep -F '\"host\":\"other.example.test\"' | grep -qF 'not allowed'"
check "10 event: LAN-resolving name refused (allowed:false)" net_ev '"host":"rebind.example.test"' '"allowed":false'
check "10 event: the Inspector's reason names the address" net_ev '"host":"rebind.example.test"' 'resolves to 192.168.1.10, a private or local address'
check "10 event: the revoked tunnel reports reason revoked" net_ev '"reason":"revoked"' '"host":"ok.example.test"'
check "10 event: stopped line is last" bash -c "[ \"\$(tail -1 '$OUT')\" = \"\$(grep -F '\"stopped\"' '$OUT' | tail -1)\" ]"
check_vm_exit0 "10 vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 10b. no grants"
start_vm s10b
r=$(q "HTTPGET ok.example.test 80 /")
check "10b no grants: 403 network not granted" bash -c "echo '$r' | jq -e '.status == 403 and (.text | contains(\"network not granted\"))' >/dev/null"
r=$(q ENV); check "10b the proxy environment is set anyway" has "$r" '"HTTPS_PROXY":"http://127.0.0.1:3128"'
check "10b no network channel was opened" bash -c "! grep -qF 'the host opened the network channel' '$W/s10b.console.log'"
check "10b no net events" bash -c "! grep -qF '\"net\":{' '$OUT'"
send '{"op":"net-revoke","rule":"nothing.example.test"}'
check "10b revoking a rule that does not exist is harmless" wait_for "$OUT" '"net-revoked":{"closed":0' 5
send '{"op":"shutdown"}'
check "10b stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "10b vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 10c. a name that resolves to loopback is refused unless the test switch is on"
start_vm s10c --net "ok.example.test:$P_HTTP" --dev-resolve ok.example.test=127.0.0.1
r=$(q "HTTPGET ok.example.test $P_HTTP /hello")
check "10c loopback answer: 403" has "$r" '"status":403'
check "10c the refusal says private or local address" has "$r" 'resolves to a private or local address'
check "10c ... without naming the address" lacks "$r" '127.0.0.1'
check "10c the host server's body did not arrive" lacks "$r" 'hello from the host server'
send '{"op":"shutdown"}'
check "10c stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "10c vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 10d. the first rule arrives over stdin (the channel opens on demand)"
start_vm s10d --dev-allow-loopback --dev-resolve ok.example.test=127.0.0.1
r=$(q "HTTPGET ok.example.test $P_HTTP /hello"); check "10d before net-allow: not granted" has "$r" 'network not granted'
send "{\"op\":\"net-allow\",\"rule\":\"ok.example.test:$P_HTTP\"}"
check "10d net-allowed line" wait_for "$OUT" '"net-allowed"' 5
r=$(q "HTTPGET ok.example.test $P_HTTP /hello"); check "10d after net-allow: 200" has "$r" '"status":200'
send '{"op":"shutdown"}'
check "10d stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "10d vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 10e. any public host on any port (\"*:*\", DEV-APPS C2): every name, every port; the address check still refuses the LAN"
start_vm s10e --net "*:*" "${DEVNET[@]}"
r=$(q "HTTPGET ok.example.test $P_HTTP /hello");    check "10e * : a name on its port" has "$r" '"status":200'
r=$(q "HTTPGET other.example.test $P_HTTP /hello"); check "10e * : another name (listed in no rule)" has "$r" '"status":200'
r=$(q "CONNECT a.wild.example.test $P_ECHO pong-7"); check "10e * : a CONNECT tunnel on another port" bash -c "echo '$r' | jq -e '.status == 200 and .text == \"pong-7\"' >/dev/null"
r=$(q "HTTPGET rebind.example.test $P_HTTP /hello"); check "10e * : a name that resolves to a LAN address is still refused" has "$r" '"status":403'
check "10e ... with the reason" has "$r" 'resolves to a private or local address'
r=$(q "HTTPGET 127.0.0.1 $P_HTTP /hello");           check "10e * : an IP literal is still refused" has "$r" 'IP addresses are not allowed'
r=$(q "HTTPGET localhost $P_HTTP /hello");           check "10e * : a local name is still refused" has "$r" '"status":403'
send '{"op":"net-revoke","rule":"*"}'
check "10e net-revoked *" wait_for "$OUT" '"net-revoked":{"closed":0,"rule":"*"}' 5
r=$(q "HTTPGET other.example.test $P_HTTP /hello"); check "10e after revoking *: refused" has "$r" '"status":403'
send '{"op":"net-allow","rule":"*:443"}'
check "10e net-allowed *:443" wait_for "$OUT" '"net-allowed":{"rule":"*:443"}' 5
r=$(q "HTTPGET other.example.test $P_HTTP /hello"); check "10e *:443 does not cover another port" has "$r" '"status":403'
send '{"op":"shutdown"}'
check "10e stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "10e event: a * connection is an Inspector row like any other" net_ev '"host":"other.example.test"' '"allowed":true'
check_vm_exit0 "10e vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 10f. \"*\" without the test switch: a name that resolves to loopback (this Mac) is refused"
start_vm s10f --net "*:*" --dev-resolve ok.example.test=127.0.0.1
r=$(q "HTTPGET ok.example.test $P_HTTP /hello")
check "10f * : loopback answer refused" has "$r" 'resolves to a private or local address'
check "10f ... the host server's body did not arrive" lacks "$r" 'hello from the host server'
send '{"op":"shutdown"}'
check "10f stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "10f vmapp-vm exited 0"
end_vm; VMPID=""
kill "$SRVPID" 2>/dev/null
wait "$SRVPID" 2>/dev/null
check "10 the local test servers are stopped" bash -c "! kill -0 $SRVPID 2>/dev/null"
SRVPID=""

# ---- 11. a Node app in the node22 runtime, the real internet ------------------------------------
echo "== 11. network from Node (real internet)"
NODE_IMG="$OUTD/runtimes/node22.img"
if [ ! -f "$NODE_IMG" ]; then
  echo "SKIP: 11 (no $NODE_IMG; build it with tools/mkruntime)"
elif ! curl -sS -m 8 -o /dev/null https://registry.npmjs.org/left-pad 2>/dev/null; then
  echo "SKIP: 11 (this machine cannot reach https://registry.npmjs.org)"
else
  node -e 'const c = require(process.argv[1] + "/hostlib/cpio"); require("fs").writeFileSync(process.argv[3], c.cpioFromDir(process.argv[2]));' \
    "$VMAPP" "$VMAPP/tests/net/node-core" "$W/netnode.cpio"
  export E2E_RUNTIME="$NODE_IMG" E2E_CORE="$W/netnode.cpio" E2E_START='{"command":["node","/app/main.js"],"workdir":"/app","env":[]}'
  CON11="$W/s11.console.log"
  start_vm s11 --net registry.npmjs.org --memory 512
  check "11 Node sees the proxy variables" wait_for "$CON11" 'NODE_USE_ENV_PROXY=1' 30
  check "11 fetch of a granted host: 200 (TLS through the tunnel)" wait_for "$CON11" 'registry.npmjs.org status=200' 60
  check "11 the response is real (more than a kilobyte)" bash -c "grep -E 'registry.npmjs.org status=200 bytes=[0-9]{4,}' '$CON11' >/dev/null"
  check "11 fetch of a host that was not granted fails" wait_for "$CON11" 'example.com error=' 30
  check "11 ... and never succeeds" bash -c "! grep -qE 'example.com status=' '$CON11'"
  send '{"op":"net-revoke","rule":"registry.npmjs.org"}'
  check "11 net-revoked line" wait_for "$OUT" '"net-revoked":{"closed":' 5
  check "11 after the revoke, the same fetch fails" wait_for "$CON11" 'registry.npmjs.org error=' 30
  send '{"op":"shutdown"}'
  check "11 stopped line printed" wait_for "$OUT" '"stopped":true' 30
  check "11 event: registry.npmjs.org allowed, bytes counted" bash -c "grep -F '\"net\":{' '$OUT' | grep -F '\"host\":\"registry.npmjs.org\"' | grep -F '\"allowed\":true' | grep -Eq '\"bytesDown\":[1-9][0-9]{3,}'"
  check "11 event: example.com refused" bash -c "grep -F '\"net\":{' '$OUT' | grep -F '\"host\":\"example.com\"' | grep -qF '\"allowed\":false'"
  check_vm_exit0 "11 vmapp-vm exited 0"
  end_vm; VMPID=""

  echo "-- 11b. the same app without any grant"
  start_vm s11b --memory 512
  CON11B="$W/s11b.console.log"
  check "11b fetch fails without a grant" wait_for "$CON11B" 'registry.npmjs.org error=' 60
  check "11b ... and never succeeds" bash -c "! grep -qE 'registry.npmjs.org status=' '$CON11B'"
  send '{"op":"shutdown"}'
  check "11b stopped line printed" wait_for "$OUT" '"stopped":true' 30
  check_vm_exit0 "11b vmapp-vm exited 0"
  check "11b VM process gone" wait_vm_count "$BASE" 8
  end_vm; VMPID=""
  unset E2E_RUNTIME E2E_CORE E2E_START
fi

# ---- 12. host services (SPEC 8.6): the GPU tunnel, against a dummy echo service -----------------------
# The "host service" is a plain TCP echo server on 127.0.0.1 (tests/net/server.js), standing in for the sandboxed rpc-server
# the loader starts. `--service gpu=127.0.0.1:PORT` is the only way vmapp-vm learns about it; the guest then listens on
# 127.0.0.1:50052 and tunnels each connection to it by NAME. The loopback test switch (--dev-allow-loopback) is NOT used here:
# a service does not go through the network address check.
echo "== 12. host service (the GPU tunnel)"
SVCD="$W/svc12"
mkdir -p "$SVCD"
rm -f "$SVCD/server.out"
node "$VMAPP/tests/net/server.js" < /dev/null > "$SVCD/server.out" &
SRVPID=$!
check "12 the dummy service started" wait_for "$SVCD/server.out" '"echo"' 10
P_SVC=$(jq -r .echo "$SVCD/server.out" 2>/dev/null); P_HTTP12=$(jq -r .http "$SVCD/server.out" 2>/dev/null)

start_vm s12 --service "gpu=127.0.0.1:$P_SVC"
CON12="$W/s12.console.log"
check "12 console: the guest listens on 127.0.0.1:50052" wait_for "$CON12" 'service: gpu listening on 127.0.0.1:50052' 5
check "12 console: the host opened the control channel" wait_for "$CON12" 'net: the host opened the network channel' 5
r=$(q 'SVC 50052 hello-gpu')
check "12 bytes go to the host service and come back" bash -c "echo '$r' | jq -e '.ok == true and .text == \"hello-gpu\"' >/dev/null"
r=$(q 'SVCBIG 50052 67108864')
check "12 64 MiB each way through the tunnel, unchanged" bash -c "echo '$r' | jq -e '.ok == true and .bytes == 67108864' >/dev/null"
echo "  info: 64 MiB there and back took $(echo "$r" | jq -r '.ms // "?"') ms"
r=$(q 'SVCOPEN 50052');                      check "12 a long-lived connection opens" has "$r" '"ok":true'
SID=$(echo "$r" | jq -r .id)
r=$(q "PING $SID");                          check "12 ... and carries data" has "$r" '"ok":true'
r=$(q 'CONNECT service:gpu 50052 x')
check "12 the network proxy cannot reach a service (403)" bash -c "echo '$r' | jq -e '.status == 403' >/dev/null"
check "12 the refused CONNECT is reported as a network event" wait_for "$OUT" '"net":{' 5
check "12 a service tunnel is no network connection (no allowed net event; the only one is the refusal)" bash -c "[ \"\$(grep -F '\"net\":{' '$OUT' | grep -cF '\"allowed\":true')\" = 0 ] && grep -F '\"net\":{' '$OUT' | grep -qF '\"allowed\":false'"
check "12 event: open" bash -c "jq -e 'select(.service.phase == \"open\" and .service.name == \"gpu\" and .service.allowed == true)' '$OUT' >/dev/null"
traffic_seen() { jq -e 'select(.service.phase == "traffic" and .service.bytesUp == 4 and .service.bytesDown == 4)' "$OUT" >/dev/null 2>&1; } # the PING above: "ping" there and back
ok=0; for _ in $(seq 1 60); do traffic_seen && { ok=1; break; }; sleep 0.1; done
check "12 event: traffic with counters while the long-lived tunnel is open" test "$ok" -eq 1
send '{"op":"service-revoke","name":"gpu"}'
check "12 service-revoked line: the open tunnel was closed" wait_for "$OUT" '"service-revoked":{"closed":1,"name":"gpu"}' 5
r=$(q "PING $SID");                          check "12 the long-lived connection is closed by the revoke" has "$r" '"ok":false'
refused=0
for _ in $(seq 1 40); do
  r=$(q 'SVC 50052 again')
  if has "$r" '"ok":false' && has "$r" 'efused'; then refused=1; break; fi
  sleep 0.1
done
check "12 after the revoke the guest port is closed: connection refused" test "$refused" -eq 1
send '{"op":"shutdown"}'
check "12 stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "12 event: the 64 MiB tunnel closed with its counters" bash -c "jq -e 'select(.service.phase == \"close\" and .service.bytesUp >= 67108864 and .service.bytesDown >= 67108864)' '$OUT' >/dev/null"
check "12 event: the revoked tunnel closed with reason revoked" bash -c "jq -e 'select(.service.phase == \"close\" and .service.reason == \"revoked\")' '$OUT' >/dev/null"
check "12 event: stopped line is last" bash -c "[ \"\$(tail -1 '$OUT')\" = \"\$(grep -F '\"stopped\"' '$OUT' | tail -1)\" ]"
check_vm_exit0 "12 vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 12b. no --service: the port is closed and no channel is opened"
start_vm s12b
r=$(q 'SVC 50052 hello')
check "12b connecting to 50052: connection refused" bash -c "echo '$r' | jq -e '.ok == false and (.error | test(\"efused\"))' >/dev/null"
check "12b console: no service listener" bash -c "! grep -qF 'service: gpu listening' '$W/s12b.console.log'"
check "12b console: no control channel" bash -c "! grep -qF 'the host opened the network channel' '$W/s12b.console.log'"
check "12b no service events" bash -c "! grep -qF '\"service\":{' '$OUT'"
send '{"op":"service-revoke","name":"gpu"}'
check "12b revoking a service that was never given closes nothing" wait_for "$OUT" '"service-revoked":{"closed":0,"name":"gpu"}' 5
send '{"op":"shutdown"}'
check "12b stopped line printed" wait_for "$OUT" '"stopped":true' 20
check_vm_exit0 "12b vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 12c. a network rule change leaves the service tunnel alone"
start_vm s12c --net "ok.example.test:$P_HTTP12" --service "gpu=127.0.0.1:$P_SVC" --dev-allow-loopback --dev-resolve ok.example.test=127.0.0.1
r=$(q 'SVCOPEN 50052'); SID=$(echo "$r" | jq -r .id)
r=$(q "PING $SID");                          check "12c the service tunnel carries data" has "$r" '"ok":true'
r=$(q "HTTPGET ok.example.test $P_HTTP12 /hello"); check "12c the network rule works beside it" has "$r" '"status":200'
send '{"op":"net-revoke","rule":"ok.example.test"}'
check "12c net-revoked: no network connection was open to close" wait_for "$OUT" '"net-revoked":{"closed":0' 5
r=$(q "PING $SID");                          check "12c the service tunnel is still up after the network revoke" has "$r" '"ok":true'
send '{"op":"shutdown"}'
check "12c stopped line printed" wait_for "$OUT" '"stopped":true' 20
check "12c event: the tunnel reported its close when the VM stopped" bash -c "jq -e 'select(.service.phase == \"close\" and .service.allowed == true and .service.bytesUp > 0)' '$OUT' >/dev/null"
check_vm_exit0 "12c vmapp-vm exited 0"
end_vm; VMPID=""

echo "-- 12d. --service accepts nothing but 127.0.0.1:PORT of a known service"
for bad in "gpu=192.168.1.10:80" "gpu=169.254.169.254:80" "gpu=localhost:80" "gpu=0.0.0.0:80" "gpu=127.0.0.2:80" "gpu=127.0.0.1:0" "gpu=[::1]:80" "gpu=example.com:443" "tools=127.0.0.1:80" "gpu"; do
  "$VM" run --service "$bad" > /dev/null 2> "$SVCD/bad.err"; rc=$?
  check "12d --service $bad refused before any VM starts (exit 2)" test "$rc" -eq 2
done
"$VM" run --service gpu=127.0.0.1:1 --service gpu=127.0.0.1:2 > /dev/null 2> "$SVCD/bad.err"; rc=$?
check "12d --service given twice for one name: refused (exit 2)" test "$rc" -eq 2
check "12d ... with a clear message" grep -q 'given twice' "$SVCD/bad.err"
kill "$SRVPID" 2>/dev/null
wait "$SRVPID" 2>/dev/null
SRVPID=""
check "12 no VM process left behind" wait_vm_count "$BASE" 8

echo
echo "$PASSES passed, $FAILS failed"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
exit 1
