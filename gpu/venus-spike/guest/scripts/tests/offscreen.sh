#!/bin/bash
# Graphics (not only compute): offscreen triangle rendered on the Venus device, read back and verified.
. /spike/env.sh
cd /opt/spike-tools || exit 1
echo "== vk-offscreen-tri"
./vk-offscreen-tri 2>&1
echo "[offscreen] rc=$?"
echo "== vkcube --headless (if supported by this vulkan-tools)"
timeout 30 vkcube --wsi headless --c 120 2>&1 | tail -5
echo "[vkcube] rc=${PIPESTATUS[0]}"
