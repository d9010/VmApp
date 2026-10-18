#!/bin/bash
# GPU watchdog / long-kernel probe: one compute dispatch of a chosen length (spike.iters, spike.groups).
# After it returns (or not), a second tiny dispatch shows whether the device is still usable.
. /spike/env.sh
iters=${SPIKE_ITERS:-1000000}
groups=${SPIKE_GROUPS:-65536}
echo "== long dispatch (iters=$iters groups=$groups)"
timeout "${SPIKE_TMO:-150}" /opt/spike-tools/vk-spin "$iters" "$groups"
echo "[spin] rc=$?"
echo "== follow-up tiny dispatch (is the device still alive?)"
timeout 60 /opt/spike-tools/vk-spin 10 16
echo "[spin] follow-up rc=$?"
