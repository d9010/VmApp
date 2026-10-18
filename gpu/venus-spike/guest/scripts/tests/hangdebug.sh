#!/bin/bash
# Run one CTS case that hangs and show what the guest process is blocked in (strace) - diagnosis helper.
#   spike.case = full dEQP case name
. /spike/env.sh
case_name=${SPIKE_CASE:-dEQP-VK.synchronization.basic.timeline_semaphore.chain}
cd /cts || exit 2
echo "$case_name" >/tmp/one.list
./deqp-vk --deqp-caselist-file=/tmp/one.list --deqp-vk-device-id=1 --deqp-log-filename=/tmp/one.qpa --deqp-shadercache=disable >/tmp/one.out 2>&1 &
pid=$!
sleep "${SPIKE_WAIT:-12}"
if kill -0 $pid 2>/dev/null; then
    echo "[hangdebug] still running after ${SPIKE_WAIT:-12}s: pid=$pid"
    for t in /proc/$pid/task/*; do echo "  task $(basename $t) $(cat $t/comm) wchan=$(cat $t/wchan 2>/dev/null) syscall=$(cat $t/syscall 2>/dev/null | cut -c1-60)"; done
    echo "[hangdebug] strace 4s:"
    timeout 4 strace -f -tt -p $pid 2>&1 | tail -n 40
else
    echo "[hangdebug] finished: $(tail -n 6 /tmp/one.out)"
fi
kill -9 $pid 2>/dev/null
