#!/bin/bash
# Vulkan compute throughput (nihui/vkpeak). SPIKE_DEV = device index (default 0).
. /spike/env.sh
dev=${SPIKE_DEV:-0}
echo "== vkpeak device list"
/opt/vkpeak/vkpeak 2>&1 | head -20
echo "== vkpeak on device $dev"
timeout 600 /opt/vkpeak/vkpeak "$dev" 2>&1
echo "[vkpeak] rc=$?"
