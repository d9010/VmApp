#!/usr/bin/env bash
# The Vulkan benchmarks of the README: a Linux VM that reaches the Mac's GPU through Vulkan (libkrun + virglrenderer's Venus +
# MoltenVK), against the same Mac running the same programs natively. It drives the Venus spike of gpu/venus-spike with the exact
# commands of its report, and only runs what the spike build already contains; it builds nothing (see README.md next to this file).
#
#   bench/vulkan/run.sh [info|vkpeak|llama|all]        (default all)
#
#   info    the guest's `vulkaninfo --summary`: proves that the VM sees "Virtio-GPU Venus (<your GPU>)"
#   vkpeak  nihui/vkpeak compute throughput, in the VM (Venus) and natively (MoltenVK)         -> README: GPU compute
#   llama   llama.cpp llama-bench -p 512 -n 128, in the VM (Vulkan through Venus), natively on Metal and natively on MoltenVK
#                                                                                              -> README: Local LLM, Vulkan
#
# Environment:
#   VMAPP_GS_WORK        the spike build (BUILD.md calls it $W). Default: <vmapp>/out/work-gs. It is used read-only: nothing is written there
#                        except a model download into cache/models when the model is missing (checked against bench/vulkan/models.json).
#   BENCH_OUT            where the logs go. Default: ${VMAPP_WORK:-<vmapp>/out/work}/bench/vulkan
#   BENCH_RUNS           llama-bench repetitions (-r), default 3
#   BENCH_VULKAN_MODEL   file name of the GGUF in $VMAPP_GS_WORK/cache/models, default the Llama 3.1 8B Q4_K_M of models.json
#
# Output: one log per command in $BENCH_OUT (vkpeak-vm.log, vkpeak-native.log, llama-vm-venus.log, llama-native-metal.log,
# llama-native-moltenvk.log, info.log); `tools/bench vulkan` parses them (bench/vulkan/parse.js). Exit status: 0 when every command ran,
# 2 when a prerequisite is missing (with the command to fix it), 1 when a command failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
GS="${VMAPP_GS_WORK:-$VMAPP/out/work-gs}"
OUT="${BENCH_OUT:-${VMAPP_WORK:-$VMAPP/out/work}/bench/vulkan}"
REPS="${BENCH_RUNS:-3}"
WHAT="${1:-all}"
SPIKE="$VMAPP/gpu/venus-spike"
MODELS_JSON="$HERE/models.json"

die() { echo "bench/vulkan: $*" >&2; exit 2; }
case "$WHAT" in info | vkpeak | llama | all) ;; *) die "unknown target '$WHAT' (info, vkpeak, llama or all)" ;; esac
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || die "needs an Apple-silicon Mac"

# ---- prerequisites: the spike build ---------------------------------------------------------------------------------------------
P="$GS/prefix"
missing=()
for f in "$GS/bin/spike-vm" "$GS/kernel-gs/out/Image" "$GS/guest/rootfs.ext4" "$P/lib/libkrun.1.dylib" "$P/lib/libvirglrenderer.1.dylib" \
         "$P/lib/libMoltenVK.dylib" "$P/share/vulkan/icd.d/MoltenVK_icd.json"; do
  [ -e "$f" ] || missing+=("$f")
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing from the spike build %s:\n' "$GS" >&2
  printf '  %s\n' "${missing[@]}" >&2
  die "build it first: follow gpu/venus-spike/BUILD.md (host stack, then gpu/venus-spike/kernel/build.sh and guest/build-rootfs.sh) with VMAPP_WORK=$GS; or point VMAPP_GS_WORK at an existing build"
fi
need_native() { [ -x "$1" ] || die "missing $1 (the native baseline): build it as described under 'Host tools used for baselines' in gpu/venus-spike/BUILD.md"; }
[ "$WHAT" = "llama" ] || [ "$WHAT" = "all" ] && { need_native "$GS/build/llama-metal/bin/llama-bench"; need_native "$GS/build/llama-vk/bin/llama-bench"; }
[ "$WHAT" = "vkpeak" ] || [ "$WHAT" = "all" ] && need_native "$GS/build/vkpeak/vkpeak"

# ---- the model ------------------------------------------------------------------------------------------------------------------
json_field() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).models[0]; console.log(m[process.argv[2]])' "$MODELS_JSON" "$1"; }
MODEL_FILE="${BENCH_VULKAN_MODEL:-$(json_field file)}"
MODEL="$GS/cache/models/$MODEL_FILE"
sha_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }
if [ "$WHAT" = "llama" ] || [ "$WHAT" = "all" ]; then
  if [ "$MODEL_FILE" = "$(json_field file)" ]; then
    want_sha="$(json_field sha256)"
    if [ ! -f "$MODEL" ]; then
      echo "downloading $MODEL_FILE ($(json_field url))"
      mkdir -p "$GS/cache/models"
      curl -fL --retry 3 -o "$MODEL.part.$$" "$(json_field url)" || die "download failed; fetch it yourself into $GS/cache/models/"
      mv -f "$MODEL.part.$$" "$MODEL"
    fi
    [ "$(sha_of "$MODEL")" = "$want_sha" ] || die "$MODEL has the wrong sha256 (want $want_sha); delete it and run again"
  else
    [ -f "$MODEL" ] || die "$MODEL does not exist (BENCH_VULKAN_MODEL names a file in $GS/cache/models)"
  fi
fi

mkdir -p "$OUT"
FAIL=0
echo "bench/vulkan: spike build $GS, logs in $OUT, llama-bench -r $REPS, model $MODEL_FILE"

# ---- the VM side ----------------------------------------------------------------------------------------------------------------
# run-guest.sh boots libkrun with the spike kernel and a Debian root disk, runs one test script from
# gpu/venus-spike/guest/scripts/tests and powers off. SPIKE_RUN_DIR keeps its logs out of the spike build.
guest() { # guest NAME TEST key=value...
  local name=$1; shift
  echo "== VM: $name ($*)"
  SPIKE_RUN_DIR="$OUT" VMAPP_WORK="$GS" "$SPIKE/run-guest.sh" "$name" "$@" > "$OUT/$name.stdout" 2>&1
  if ! grep -q 'SPIKE-DONE rc=0' "$OUT/$name.log"; then
    echo "FAILED: $name did not finish cleanly (see $OUT/$name.log)" >&2
    FAIL=1
  fi
}

# ---- the native side ------------------------------------------------------------------------------------------------------------
# MoltenVK is run the way the spike ran it: its ICD file and libraries from the prefix, and Metal argument buffers off (the VM needs
# that setting; the native baseline uses the same one so the two are comparable: REPORT.md section 3).
mvk() { VK_DRIVER_FILES="$P/share/vulkan/icd.d/MoltenVK_icd.json" DYLD_LIBRARY_PATH="$P/lib" MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0 "$@"; }
native() { # native NAME command...   (output to $OUT/NAME.log)
  local name=$1; shift
  echo "== native: $name"
  "$@" > "$OUT/$name.log" 2>&1 || { echo "FAILED: $name (see $OUT/$name.log)" >&2; FAIL=1; }
}

if [ "$WHAT" = "info" ] || [ "$WHAT" = "all" ]; then
  guest info info gpu=8192 mem=4096 cpus=2
  grep -q 'Virtio-GPU Venus' "$OUT/info.log" || { echo "FAILED: the guest does not see a Venus GPU (see $OUT/info.log)" >&2; FAIL=1; }
fi

if [ "$WHAT" = "vkpeak" ] || [ "$WHAT" = "all" ]; then
  guest vkpeak-vm vkpeak gpu=8192 mem=4096 cpus=2
  native vkpeak-native mvk "$GS/build/vkpeak/vkpeak" 0
fi

if [ "$WHAT" = "llama" ] || [ "$WHAT" = "all" ]; then
  # Same arguments as the spike's report: prompt 512 tokens, generate 128, REPS repetitions. The VM gets 8 vCPUs, 12 GiB and a 24 GiB GPU window.
  guest llama-vm-venus llama gpu=24576 mem=12288 cpus=8 "model=$MODEL_FILE" mode=vk "args=-p,512,-n,128,-r,$REPS"
  native llama-native-metal "$GS/build/llama-metal/bin/llama-bench" -m "$MODEL" -p 512 -n 128 -r "$REPS"
  native llama-native-moltenvk mvk "$GS/build/llama-vk/bin/llama-bench" -m "$MODEL" -ngl 99 -p 512 -n 128 -r "$REPS"
fi

[ "$FAIL" = 0 ] && echo "bench/vulkan: done" || echo "bench/vulkan: some commands failed" >&2
exit "$FAIL"
