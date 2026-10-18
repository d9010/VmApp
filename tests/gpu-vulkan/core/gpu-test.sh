#!/bin/sh
# gpu-test.sh MODE [ARGS...]: the entry of the vmapp GPU test core (tests/gpu-vulkan). It runs inside the node22-gpu runtime
# (EXPERIMENTAL; runtimes/node22-gpu) as uid 1000, and prints marker lines on stdout so a harness can grep the console log:
#
#   GPUTEST-BEGIN <mode> [args]          first line of a run
#   GPUTEST-INFO  ...                    context lines (uid, /dev/dri, the model file)
#   ... the tool's own output (stdout and stderr merged) ...
#   GPUTEST-END <mode> rc=<n> secs=<s>   last line of a run; rc is the tool's exit code (124 = killed by the time limit)
#   GPUTEST-ERROR <message>              (only) when the run could not even start; rc is then 2 (bad mode) or 4 (no model)
#
# Modes:
#   info                      vulkaninfo --summary
#   vkpeak [SCENARIOS]        vkpeak on device $VK_DEVICE_INDEX (default 0); default SCENARIOS = fp32-scalar,copy-h2d,copy-d2d
#   llama [MODEL] [BENCH...]  llama-bench -m MODEL -p 512 -n 128 -r 3 -ngl 99 [BENCH...]. MODEL is a path, or a file name in
#                             $GPUTEST_MODELS (default /host/f-models); without it, the first *.gguf there
#   spin [ITERS [GROUPS]]     vk-spin: ONE compute dispatch, GROUPS workgroups of 256 invocations, ITERS dependent FMAs each
#                             (defaults 1000000 and 1024); reports whether the device survived
#   tri                       vk-offscreen-tri: offscreen triangle, pixels verified, then timed round trips (VK_FRAMES, default 300)
#
# Environment: GPUTEST_TIMEOUT = seconds before the tool is killed (0 = never; default per mode: info 120, tri 300, vkpeak 300,
# spin 600, llama 1800). No Vulkan variable is needed: the loader finds the Venus ICD on its own.
APP=$(cd "$(dirname "$0")" && pwd)
BIN=$APP/bin

mode=${1:-}
[ $# -gt 0 ] && shift

say() { printf '%s\n' "$*"; }

# run SECONDS CMD...: the command with stdout and stderr merged, under a time limit when `timeout` exists.
run() {
  limit=${GPUTEST_TIMEOUT:-$1}
  shift
  if [ "$limit" != 0 ] && command -v timeout >/dev/null 2>&1; then
    timeout -k 5 "$limit" "$@" 2>&1
  else
    "$@" 2>&1
  fi
}

start=$(date +%s)
say "GPUTEST-BEGIN $mode${*:+ $*}"
say "GPUTEST-INFO uid=$(id -u) gid=$(id -g) groups=$(id -G | tr ' ' ',') home=${HOME:-} tmpdir=${TMPDIR:-}"
say "GPUTEST-INFO dri=$(ls -ln /dev/dri 2>&1 | tail -n +2 | tr -s ' ' | tr '\n' ';')"

rc=0
case "$mode" in
  info)
    run 120 "$BIN/vulkaninfo" --summary
    rc=$?
    ;;
  vkpeak)
    run 300 "$BIN/vkpeak" "${VK_DEVICE_INDEX:-0}" "${1:-fp32-scalar,copy-h2d,copy-d2d}"
    rc=$?
    ;;
  llama)
    dir=${GPUTEST_MODELS:-/host/f-models}
    model=${1:-}
    [ $# -gt 0 ] && shift
    if [ -z "$model" ]; then
      model=$(ls "$dir"/*.gguf 2>/dev/null | head -n 1)
    else
      case "$model" in /*) ;; *) model=$dir/$model ;; esac
    fi
    if [ -z "$model" ] || [ ! -f "$model" ]; then
      say "GPUTEST-ERROR llama: no model file (looked in $dir)"
      rc=4
    else
      say "GPUTEST-INFO model=$model bytes=$(wc -c < "$model")"
      # llama-bench's libraries (libllama, libggml*) sit next to it; their RUNPATH is the build folder, so name this one.
      (
        LD_LIBRARY_PATH=$APP/llama${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
        export LD_LIBRARY_PATH
        run 1800 "$APP/llama/llama-bench" -m "$model" -p 512 -n 128 -r 3 -ngl 99 "$@"
      )
      rc=$?
    fi
    ;;
  spin)
    run 600 "$BIN/vk-spin" "${1:-1000000}" "${2:-1024}"
    rc=$?
    ;;
  tri)
    run 300 "$BIN/vk-offscreen-tri"
    rc=$?
    ;;
  *)
    say "GPUTEST-ERROR unknown mode '$mode' (info | vkpeak [SCENARIOS] | llama [MODEL] | spin [ITERS [GROUPS]] | tri)"
    rc=2
    ;;
esac

say "GPUTEST-END $mode rc=$rc secs=$(( $(date +%s) - start ))"
exit "$rc"
