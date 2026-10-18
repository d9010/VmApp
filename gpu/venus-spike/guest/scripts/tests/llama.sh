#!/bin/bash
# llama.cpp llama-bench: Vulkan (Venus) vs CPU-only, same model, in the same VM.
#   spike.model=<file under /models>  spike.mode=vk|cpu|both  spike.args="extra llama-bench args"
. /spike/env.sh
model=/models/${SPIKE_MODEL:-qwen2.5-1.5b-instruct-q4_k_m.gguf}
mode=${SPIKE_MODE:-both}
# kernel command line words cannot hold spaces: spike.args uses commas instead (-p,512,-n,128)
args=${SPIKE_ARGS:--p,512,-n,128,-r,3}
args=${args//,/ }
ls -la "$model" || exit 1
echo "nproc=$(nproc) mem=$(grep MemTotal /proc/meminfo)"
if [ "$mode" = vk ] || [ "$mode" = both ]; then
    echo "===== llama-bench VULKAN (Venus) -ngl 99"
    LD_LIBRARY_PATH=/opt/llama-vk:$LD_LIBRARY_PATH /opt/llama-vk/llama-bench -m "$model" -ngl 99 $args 2>&1
    echo "[llama] vulkan rc=$?"
fi
if [ "$mode" = cpu ] || [ "$mode" = both ]; then
    echo "===== llama-bench CPU-only -ngl 0 -t $(nproc)"
    LD_LIBRARY_PATH=/opt/llama-cpu:$LD_LIBRARY_PATH /opt/llama-cpu/llama-bench -m "$model" -ngl 0 -t "$(nproc)" $args 2>&1
    echo "[llama] cpu rc=$?"
fi
