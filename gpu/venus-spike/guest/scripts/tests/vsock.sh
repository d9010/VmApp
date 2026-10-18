#!/bin/bash
# vsock + virtiofs + read-only-disk behaviour of libkrun as seen from the guest (run by run-guest.sh vsock ... with the
# launcher mappings described in REPORT.md). Host driver: gpu/venus-spike/vsock-host-test.py-style inline script.
T=/opt/spike-tools/vsock-test
echo "== guest listens on vsock 1024 (host connects via unix socket, libkrun --vsock 1024=...:listen)"
timeout 40 $T echo 1024 &
echo "== guest listens on vsock 1025 as a sink (host sends bulk data)"
timeout 60 $T sink 1025 &
sleep 1
echo "== guest -> host: hello on port 2000 (libkrun connects to a host unix socket)"
$T hello 2000
echo "== guest -> host bulk: 256 MiB on port 2001"
$T source 2001 256
wait
echo "== read-only virtiofs share (models): write attempt must fail"
touch /models/should-not-exist && echo "WRITE SUCCEEDED (bad)" || echo "write refused (good)"
echo "== read-write virtiofs share (work): write works"
echo ok > /work/vsock-test-write && echo "write ok"
echo "== block devices"
lsblk 2>/dev/null || cat /proc/partitions
echo "== /proc/mounts (virtiofs)"
grep virtiofs /proc/mounts
echo "== clock"
date -u; cat /sys/class/rtc/rtc0/date /sys/class/rtc/rtc0/time 2>/dev/null
