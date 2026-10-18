#!/bin/bash
# Device discovery: kernel side (DRM/virtio-gpu) and user side (Vulkan loader + Venus ICD).
. /spike/env.sh
echo "== uname";            uname -a
echo "== cmdline";          cat /proc/cmdline
echo "== dmesg (virtio/drm/gpu)"; dmesg | grep -i -E "virtio|drm|gpu|venus|krun|blob|host.visible" | head -60
echo "== /dev/dri";         ls -la /dev/dri 2>&1
echo "== /sys/class/drm";   ls /sys/class/drm 2>&1
echo "== loader/ICD";       ls -la /usr/lib/*-linux-gnu/libvulkan.so.1 "$VK_ICD_FILENAMES"; cat "$VK_ICD_FILENAMES"
echo "== vulkaninfo --summary"
vulkaninfo --summary 2>&1 | head -120
