#!/bin/bash
# Vulkan CTS (dEQP-VK 1.4.4.0) on the Venus device. Runs a deterministic selection of the official mustpass list:
#   spike.group = list file under /cts/mustpass without .txt (api, memory, compute, synchronization, pipeline/..., ...)
#   spike.prefix = case-name prefix filter inside that list (default: dEQP-VK.<group>.)
#   spike.nth   = take every Nth case of the filtered list (default 1 = all)
#   spike.max   = stop after this many cases (default: all)
#   spike.tag   = result file name (default: <group>)
# Results: /work/cts-<tag>.log (deqp stdout), /work/cts-<tag>.qpa (full log), /work/cts-<tag>.list (cases run).
. /spike/env.sh
export LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}
group=${SPIKE_GROUP:-api}
prefix=${SPIKE_PREFIX:-dEQP-VK.}
nth=${SPIKE_NTH:-1}
max=${SPIKE_MAX:-0}
tag=${SPIKE_TAG:-$(echo "$group" | tr / -)}
list=/cts/mustpass/$group.txt
[ -f "$list" ] || { echo "no mustpass list $list"; ls /cts/mustpass | head -50; exit 2; }

# spike.exclude = awk regex of case names to drop before sampling (commas in the cmdline word stand for '|')
ex=${SPIKE_EXCLUDE//,/|}
awk -v p="$prefix" -v n="$nth" -v m="$max" -v ex="$ex" 'index($0,p)==1 && (ex=="" || $0 !~ ex) { c++; if (c % n == 0) { print; k++; if (m>0 && k>=m) exit } }' "$list" >/work/cts-$tag.list
echo "[cts] group=$group prefix=$prefix nth=$nth cases=$(wc -l </work/cts-$tag.list)"
cd /cts || exit 2
export TMPDIR=/tmp
dev=${SPIKE_DEV:-1}
stdbuf -oL ./deqp-vk \
    --deqp-caselist-file=/work/cts-$tag.list \
    --deqp-vk-device-id=$dev \
    --deqp-log-filename=/work/cts-$tag.qpa \
    --deqp-log-flush=enable --deqp-log-images=disable --deqp-log-shader-sources=disable \
    --deqp-shadercache=disable \
    --deqp-crashhandler=enable 2>&1 | tee /work/cts-$tag.log | tail -n 25
echo "[cts] rc=${PIPESTATUS[0]}"
