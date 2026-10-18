#!/bin/sh
# Test stub for the GPU liveness probe (SPEC 8.7, runtimes/node22-gpu/gpu-probe): it answers like the real probe for a few cycles and
# then gets stuck inside a cycle for ever, which is what a wedged host GPU worker looks like to the guest (see
# tests/gpu-vulkan/run.sh, step 6; a Venus wedge cannot be made on demand). Only a test build of the guest init
# (VMAPP_GPU_PROBE_PATH=/app/gpu-probe-stub.sh at compile time) runs it; the shipped init never does.
echo B
echo E
sleep 1
echo B
echo E
sleep 1
echo B
# no E: stuck
exec sleep 3600
