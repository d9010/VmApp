#!/usr/bin/env bash
# Runs one guest test in the spike VM (libkrun + Venus) and logs the console to $VMAPP_WORK/run/<name>.log
# (or to $SPIKE_RUN_DIR/<name>.log when that is set).
#
#   VMAPP_WORK=/abs/scratch gpu/venus-spike/run-guest.sh NAME TEST [key=value ...]
#
#   NAME   log file / run name
#   TEST   a script in guest/scripts/tests/ (info, vkpeak, llama, offscreen, vkinfo-json, cts, ...) or "shell"
#   key=value pairs become kernel cmdline words "spike.key=value" (mesa=stock|patched, model=..., mode=..., args=...,
#          vn=VN_DEBUG, dev=N, tag=...) except these launcher knobs:
#     cpus=N mem=MiB gpu=MiB (0 = no GPU device) timeout=SECONDS kernel=PATH noshare=1
#
# The VM mounts: root = rootfs.ext4 (vda, read-write copy-on-run is NOT made: the test scripts only write tmpfs and /work),
#                virtiofs "models" (read-only) = $VMAPP_WORK/cache/models, "work" (rw) = $VMAPP_WORK/run/work,
#                "cts" (ro) = $VMAPP_WORK/cts when present.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${VMAPP_WORK:?set VMAPP_WORK to an absolute scratch folder}"
P="$WORK/prefix"
NAME="${1:?name}"; TEST="${2:?test}"; shift 2

cpus=4; mem=6144; gpu=8192; tmo=900; kernel="$WORK/kernel-gs/out/Image"; words=""; kcmd=""; extra=()
for kv in "$@"; do
    k=${kv%%=*}; v=${kv#*=}
    case "$k" in
        vsock) extra+=(--vsock "$v") ;;     # vsock=PORT=SOCKPATH[:listen]
        disk2) extra+=(--disk "$v") ;;      # extra raw disk, PATH[:ro]
        xarg) extra+=("$v") ;;              # raw launcher argument
        cpus) cpus=$v ;; mem) mem=$v ;; gpu) gpu=$v ;; timeout) tmo=$v ;; kernel) kernel=$v ;;
        kcmd) kcmd="$kcmd $v" ;;    # extra raw kernel command line words, e.g. kcmd=virtio_gpu.blob_alignment=16384
        patchedkernel) kernel="$WORK/kernel-gs/out-patched/Image"; kcmd="$kcmd virtio_gpu.blob_alignment=16384" ;;
        *) words="$words spike.$k=$v" ;;
    esac
done
# SPIKE_RUN_DIR moves the logs and the "work" share out of $VMAPP_WORK/run, so that a build can be used read-only (bench/vulkan does).
RUN_DIR="${SPIKE_RUN_DIR:-$WORK/run}"
mkdir -p "$RUN_DIR/work"
LOG="$RUN_DIR/$NAME.log"
args=(--cpus "$cpus" --mem "$mem" --kernel "$kernel"
      --cmdline "console=hvc0 root=/dev/vda rootfstype=ext4 rw init=/spike/init panic=-1 loglevel=4$kcmd spike.test=$TEST$words"
      --disk "$WORK/guest/rootfs.ext4"
      --virtiofs "models=$WORK/cache/models:ro" --virtiofs "work=$RUN_DIR/work")
[ -d "$WORK/cts" ] && args+=(--virtiofs "cts=$WORK/cts:ro")
[ "${SPIKE_LIVE_SCRIPTS:-1}" = 1 ] && args+=(--virtiofs "spike=$HERE/guest/scripts:ro")
[ "$gpu" != "0" ] && args+=(--gpu="$gpu")
[ "${#extra[@]}" -gt 0 ] && args+=("${extra[@]}")

echo "==> $NAME: spike-vm ${args[*]}" | tee "$LOG"
export DYLD_LIBRARY_PATH="$P/lib"
# MoltenVK (in the VMM process) knobs. Argument buffers OFF is a REQUIRED workaround here: with Metal argument
# buffers on, llama.cpp's token generation dies with "kIOGPUCommandBufferCallbackErrorInvalidResource" (device lost,
# guest hangs). Set MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=1 to reproduce. See REPORT.md.
export MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS="${MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS:-0}"
export MVK_CONFIG_LOG_LEVEL="${MVK_CONFIG_LOG_LEVEL:-1}"
"$P/../bin/spike-vm" "${args[@]}" >>"$LOG" 2>&1 &
pid=$!
( sleep "$tmo"; kill "$pid" 2>/dev/null ) &
wd=$!
wait "$pid"; rc=$?
kill "$wd" 2>/dev/null
echo "==> $NAME: vm exited rc=$rc (log: $LOG)" | tee -a "$LOG"
