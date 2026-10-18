#!/usr/bin/env bash
# EXPERIMENTAL Vulkan backend (SPEC 8.7): real VMs with the real GPU. Boots the node22-gpu runtime with the gpu kernel flavour under
# `vmapp-vm-krun` (the VMM in its sandbox) and the test core tests/gpu-vulkan/core, then checks and measures:
#
#   1  vulkaninfo: the guest sees `Virtio-GPU Venus (<your Mac's GPU>)` through the standard loader, as uid 1000
#   2  an offscreen triangle on the real GPU, pixels verified (vk-offscreen-tri)
#   3  a compute dispatch (vk-spin) finishes and the device survives it
#   4  vkpeak: fp32 throughput and copy bandwidth (recorded)
#   5  llama.cpp's Vulkan backend (llama-bench, a model from a read-only share): prompt and generation tokens/s (recorded)
#   6  the GPU probe and the watchdog: the guest's probe reports to `hello`; a probe that stops answering gets the VM killed with
#      reason gpu-hang (the probe is a stub for this test: a Venus wedge cannot be made on demand, see SPEC 8.7)
#
# Every VM here runs the way the loader runs it: the VMM in the deny-by-default sandbox (no --dev-no-sandbox anywhere).
#
# Numbers go to $VMAPP_WORK/gpu-vulkan/results.txt and are printed at the end. The part of tests/e2e.sh that applies to this backend
# (shares, bridge, network proxy, host services, parent death, the control-port watchdog) is tests/gpu-vulkan/krun-e2e.sh (--e2e runs it too).
#
#   tests/gpu-vulkan/run.sh [--e2e] [--skip-llama] [--model FILE.gguf] [--quick]
#   tests/gpu-vulkan/run.sh --bench [--model FILE.gguf] [--runs N] [--no-native]
#
# Needs: out/krun (gpu/krun/build.sh), out/Image-gpu (kernel/build.sh --flavour gpu), out/initramfs.cpio (tools/build.sh), out/runtimes/node22-gpu.img
# (tools/mkruntime runtimes/node22-gpu ...), out/test/gpu-vulkan-core.cpio (tests/gpu-vulkan/build-core.sh) and, for llama, a GGUF model
# (--model, or $VMAPP_MODELS/<file>, default qwen2.5-0.5b-instruct-q4_k_m.gguf in $VMAPP_MODELS or out/work*/cache/models). Step 6 also needs the Rust
# toolchain of tools/build.sh to build a test guest init (it is skipped without it). Environment: VMAPP_WORK, VMAPP_MODELS.
#
# --bench (the hook of `tools/bench vulkan`, docs/BENCHMARKS.md section 8) replaces the checks above with a measurement of the same
# two things the spike's README rows quote, on this backend: vkpeak (fp32 GFLOPS, copy bandwidth) and llama-bench (pp512, tg128) of the
# model in bench/vulkan/models.json (Meta Llama 3.1 8B Instruct Q4_K_M), each in a real VM on the real GPU; then, for comparison, the same
# on the host: llama-bench on Metal and on MoltenVK and vkpeak on MoltenVK, from the Venus spike's host builds ($VMAPP_GS_WORK, default
# out/work-gs; see bench/vulkan/README.md) when they exist (--no-native skips them). It prints a table and, as the LAST line of stdout,
# one JSON object (tests/gpu-vulkan/bench-report.js; the fields are in BENCHMARKS section 8). Exit status: 0 it ran, 1 a VM run produced
# no numbers (the JSON then has "error"), 2 a prerequisite is missing (stderr names it and the command that fixes it; no JSON line).
#   --runs N      llama-bench repetitions (-r; default $BENCH_RUNS or 3)
#   --model FILE  another GGUF (default: the model of models.json, found in $VMAPP_MODELS, $BENCH_MODEL_CACHE, $BENCH_MODEL_DIRS,
#                 $VMAPP_WORK/cache/models or $VMAPP_GS_WORK/cache/models, and checked against its sha256)
# Environment of --bench: BENCH_RUNS, BENCH_VULKAN_MODEL (a file name in those folders), BENCH_NATIVE_FROM (a folder with the logs of
# bench/vulkan/run.sh, which tools/bench sets: those native numbers are reused instead of running the native commands again),
# BENCH_VM_CPUS, BENCH_VM_MEMORY, BENCH_GPU_WINDOW (MiB; defaults 8, 12288, 24576 for the 8B model as in the spike, 4, 4096, 8192 for a small one).
set -u

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTD="$VMAPP/out"
VM="${VMAPP_VM_KRUN:-$OUTD/krun/bin/vmapp-vm-krun}"
KERNEL="${VMAPP_KERNEL_GPU:-$OUTD/Image-gpu}"
INITRAMFS="${VMAPP_INITRAMFS:-$OUTD/initramfs.cpio}"
RUNTIME="${VMAPP_RUNTIME_GPU:-$OUTD/runtimes/node22-gpu.img}"
CORE="${VMAPP_GPU_TEST_CORE:-$OUTD/test/gpu-vulkan-core.cpio}"
mkdir -p "${VMAPP_WORK:-$OUTD/work}/gpu-vulkan"
W="$(cd "${VMAPP_WORK:-$OUTD/work}/gpu-vulkan" && pwd)"
# scratch (the padded core image, the VMM's run folder) lives under the work folder, not in the system temp folder
mkdir -p "$W/tmp"
export TMPDIR="$W/tmp"
RESULTS="$W/results.txt"
KRUN_FLAGS=()
[ -n "${VMAPP_KRUN_DIR:-}" ] && KRUN_FLAGS=(--krun-dir "$VMAPP_KRUN_DIR")

RUN_E2E=0 SKIP_LLAMA=0 QUICK=0 MODEL="" BENCH=0 NO_NATIVE=0 BENCH_REPS="${BENCH_RUNS:-3}"
while [ $# -gt 0 ]; do
  case "$1" in
    --e2e) RUN_E2E=1 ;;
    --skip-llama) SKIP_LLAMA=1 ;;
    --quick) QUICK=1 ;;
    --bench) BENCH=1 ;;
    --no-native) NO_NATIVE=1 ;;
    --runs) BENCH_REPS="${2:?--runs needs a number}"; shift ;;
    --model) MODEL="${2:?--model needs a file}"; shift ;;
    -h | --help) sed -n '2,/^set -u/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$BENCH_REPS" in '' | *[!0-9]* | 0) echo "--runs / BENCH_RUNS must be a whole number >= 1, not '$BENCH_REPS'" >&2; exit 2 ;; esac
if [ "$BENCH" = 1 ]; then RESULTS="$W/bench-results.txt"; fi # the numbers of a normal run (results.txt) stay as they are

# Every prerequisite that is missing is named with the command that creates it (run them from vmapp/); exit status 2.
MISSING=0
need() { # need FILE FIX-COMMAND
  [ -f "$1" ] && return 0
  echo "missing ${1#"$VMAPP"/}" >&2
  echo "    fix: $2" >&2
  MISSING=1
}
need "$VM" "gpu/krun/build.sh   (builds out/krun: libkrun, virglrenderer, MoltenVK and the launcher; needs Xcode)"
need "$KERNEL" "kernel/build.sh --flavour gpu   (needs Docker)"
need "$INITRAMFS" "tools/build.sh"
need "$RUNTIME" "tools/mkruntime runtimes/node22-gpu out/runtimes/node22-gpu.img   (needs Docker)"
need "$CORE" "bash tests/gpu-vulkan/build-core.sh   (needs Docker)"
[ "$MISSING" = 0 ] || { echo "tests/gpu-vulkan/run.sh: nothing was run; create the files above first" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is needed (it ships with macOS 15; or: brew install jq)" >&2; exit 2; }
if [ "$BENCH" = 1 ]; then command -v node >/dev/null || { echo "node is needed (Node.js 22)" >&2; exit 2; }; fi

PASSES=0 FAILS=0
check() { local name=$1; shift; if "$@"; then echo "PASS: $name"; PASSES=$((PASSES + 1)); else echo "FAIL: $name"; FAILS=$((FAILS + 1)); fi; }
note() { echo "$*" | tee -a "$RESULTS"; }
: > "$RESULTS"

# run_core LABEL START-JSON [launcher args...]: boots one VM, waits for the stopped line (up to $TIMEOUT s, default 240), then
# sets OUT (stdout of the launcher), CON (the console log). The launcher gets a stdin that stays open.
TIMEOUT=240
run_core() {
  local label=$1 start=$2; shift 2
  OUT="$W/$label.out"; CON="$W/$label.console.log"; ERRF="$W/$label.err"
  rm -f "$OUT" "$CON" "$ERRF"
  local fifo; fifo="$(mktemp -u "$W/in-XXXXXX")"; mkfifo "$fifo"
  mkdir -p "$W/appdata-$label"
  "$VM" run --kernel "$KERNEL" --initramfs "${RUN_INITRAMFS:-$INITRAMFS}" --runtime "$RUNTIME" --core "${RUN_CORE:-$CORE}" --appdata "$W/appdata-$label" \
    --start "$start" --socket "$(mktemp -u /tmp/vmapp-XXXXXX).sock" --console "$CON" --memory "${MEMORY:-2048}" --cpus "${CPUS:-2}" \
    ${KRUN_FLAGS[@]+"${KRUN_FLAGS[@]}"} "$@" < "$fifo" > "$OUT" 2> "$ERRF" &
  RUN_PID=$!
  exec 4> "$fifo"
  local i=0
  while [ $i -lt $((TIMEOUT * 5)) ]; do
    grep -qF '"stopped"' "$OUT" 2>/dev/null && break
    kill -0 "$RUN_PID" 2>/dev/null || break
    sleep 0.2; i=$((i + 1))
  done
  if ! grep -qF '"stopped"' "$OUT" 2>/dev/null; then echo "  (timed out: stopping $label)"; kill -TERM "$RUN_PID" 2>/dev/null; fi
  exec 4>&-
  wait "$RUN_PID" 2>/dev/null
  rm -f "$fifo"
}
stopped() { grep -F '"stopped"' "$OUT" | tail -1; }
core_ok() { stopped | jq -e '.reason == "core-exited" and .exitCode == 0' >/dev/null 2>&1; }
con_has() { grep -qF -- "$1" "$CON"; }

GPUTEST='{"command":["/app/gpu-test.sh","%s"%s],"workdir":"/app","env":[]}'
start_of() { local mode=$1; shift; local extra=""; for a in "$@"; do extra="$extra,\"$a\""; done; printf "$GPUTEST" "$mode" "$extra"; }

# ---- --bench: the hook of `tools/bench vulkan` (docs/BENCHMARKS.md section 8) ----
bench_main() {
  local GS="${VMAPP_GS_WORK:-$OUTD/work-gs}" MODELS_JSON="$VMAPP/bench/vulkan/models.json"
  local def_file def_bytes def_sha def_url d extra cpus mem win
  json_field() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).models[0]; console.log(m[process.argv[2]])' "$MODELS_JSON" "$1"; }
  bench_fail() { # bench_fail LOG-MESSAGE JSON-ERROR (a fixed text without quotes)
    echo "tests/gpu-vulkan/run.sh --bench: $1" >&2
    printf '{"backend":"vmapp-vm-krun","error":"%s"}\n' "$2"
    exit 1
  }
  def_file="$(json_field file)"; def_bytes="$(json_field bytes)"; def_sha="$(json_field sha256)"; def_url="$(json_field url)"

  # ---- the model: a file name from models.json (or --model), searched in the usual folders, checked against its sha256 ----
  BM_DIR="" BM_FILE="" BM_DEFAULT=0
  if [ -n "$MODEL" ]; then
    [ -f "$MODEL" ] || { echo "tests/gpu-vulkan/run.sh --bench: --model $MODEL does not exist" >&2; exit 2; }
    BM_DIR="$(cd "$(dirname "$MODEL")" && pwd)"; BM_FILE="$(basename "$MODEL")"
  else
    BM_FILE="${BENCH_VULKAN_MODEL:-$def_file}"
    [ "$BM_FILE" = "$def_file" ] && BM_DEFAULT=1
    local dirs=("${VMAPP_MODELS:-}" "${BENCH_MODEL_CACHE:-}")
    IFS=: read -r -a extra <<< "${BENCH_MODEL_DIRS:-}"
    dirs+=(${extra[@]+"${extra[@]}"} "${VMAPP_WORK:-$OUTD/work}/cache/models" "$GS/cache/models")
    for d in "${dirs[@]}"; do
      [ -n "$d" ] && [ -f "$d/$BM_FILE" ] || continue
      # the model of models.json must be the whole file (a download that stopped halfway has another size)
      if [ "$BM_DEFAULT" = 1 ] && [ "$(stat -f%z "$d/$BM_FILE" 2>/dev/null || echo 0)" != "$def_bytes" ]; then continue; fi
      BM_DIR="$(cd "$d" && pwd)"; break
    done
    if [ -z "$BM_DIR" ]; then
      echo "missing the model $BM_FILE" >&2
      if [ "$BM_DEFAULT" = 1 ]; then
        echo "    fix: mkdir -p \"$GS/cache/models\" && curl -fL -o \"$GS/cache/models/$def_file\" '$def_url'   ($def_bytes bytes, sha256 $def_sha)" >&2
        echo "         (bench/vulkan/run.sh llama downloads it by itself; or pass --model FILE.gguf; BENCH_MODEL_DIRS names more folders to look in)" >&2
      else
        echo "    fix: put $BM_FILE into \$VMAPP_MODELS, \$BENCH_MODEL_CACHE or $GS/cache/models" >&2
      fi
      echo "tests/gpu-vulkan/run.sh --bench: nothing was run; create the files above first" >&2
      exit 2
    fi
  fi
  case "$BM_FILE" in *[!A-Za-z0-9._+-]*) echo "tests/gpu-vulkan/run.sh --bench: the model file name '$BM_FILE' may only use letters, digits and . _ + -" >&2; exit 2 ;; esac
  BM_BYTES="$(stat -f%z "$BM_DIR/$BM_FILE")"
  if [ "$BM_DEFAULT" = 1 ] && [ -z "$MODEL" ]; then
    echo "checking the sha256 of $BM_DIR/$BM_FILE"
    [ "$(shasum -a 256 "$BM_DIR/$BM_FILE" | awk '{ print $1 }')" = "$def_sha" ] || { echo "tests/gpu-vulkan/run.sh --bench: $BM_DIR/$BM_FILE has another sha256 than models.json says ($def_sha): delete it and fetch it again" >&2; exit 2; }
  fi

  # ---- the native baselines: reuse the logs of bench/vulkan/run.sh, or run the spike's host builds ----
  local P="$GS/prefix" NB="$W/bench" nat=() src=""
  mkdir -p "$NB"
  if [ "$NO_NATIVE" = 1 ]; then
    src=""
  elif [ -n "${BENCH_NATIVE_FROM:-}" ] && { [ -f "$BENCH_NATIVE_FROM/llama-native-metal.log" ] || [ -f "$BENCH_NATIVE_FROM/vkpeak-native.log" ]; }; then
    for f in vkpeak-native:--native-vkpeak llama-native-metal:--native-metal llama-native-moltenvk:--native-moltenvk; do
      [ -f "$BENCH_NATIVE_FROM/${f%%:*}.log" ] && nat+=("${f##*:}" "$BENCH_NATIVE_FROM/${f%%:*}.log")
    done
    src="reused from the spike run in $BENCH_NATIVE_FROM"
  else
    mvk() { VK_DRIVER_FILES="$P/share/vulkan/icd.d/MoltenVK_icd.json" DYLD_LIBRARY_PATH="$P/lib" MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0 "$@"; }
    if [ -x "$GS/build/llama-metal/bin/llama-bench" ]; then
      echo "== native: llama-bench on Metal"
      "$GS/build/llama-metal/bin/llama-bench" -m "$BM_DIR/$BM_FILE" -p 512 -n 128 -r "$BENCH_REPS" > "$NB/llama-native-metal.log" 2>&1 && nat+=(--native-metal "$NB/llama-native-metal.log")
    fi
    if [ -x "$GS/build/llama-vk/bin/llama-bench" ] && [ -f "$P/share/vulkan/icd.d/MoltenVK_icd.json" ]; then
      echo "== native: llama-bench on MoltenVK"
      mvk "$GS/build/llama-vk/bin/llama-bench" -m "$BM_DIR/$BM_FILE" -ngl 99 -p 512 -n 128 -r "$BENCH_REPS" > "$NB/llama-native-moltenvk.log" 2>&1 && nat+=(--native-moltenvk "$NB/llama-native-moltenvk.log")
    fi
    if [ -x "$GS/build/vkpeak/vkpeak" ] && [ -f "$P/share/vulkan/icd.d/MoltenVK_icd.json" ]; then
      echo "== native: vkpeak on MoltenVK"
      mvk "$GS/build/vkpeak/vkpeak" 0 > "$NB/vkpeak-native.log" 2>&1 && nat+=(--native-vkpeak "$NB/vkpeak-native.log")
    fi
    if [ "${#nat[@]}" -gt 0 ]; then src="run now with the spike's host builds in $GS"; else echo "(no native baselines: the Venus spike's host builds are not in $GS; see bench/vulkan/README.md)"; fi
  fi
  [ -n "$src" ] && nat+=(--native-source "$src")

  # ---- the VM side: the same VM the loader starts for an app, the VMM in its sandbox ----
  if [ "$BM_BYTES" -ge 3000000000 ]; then cpus=8 mem=12288 win=24576; else cpus=4 mem=4096 win=8192; fi # the spike's sizes for the 8B model
  cpus="${BENCH_VM_CPUS:-$cpus}" mem="${BENCH_VM_MEMORY:-$mem}" win="${BENCH_GPU_WINDOW:-$win}"
  echo "== 1/3 the guest sees the GPU (vulkaninfo)"
  run_core b-info "$(start_of info)"
  core_ok || bench_fail "vulkaninfo did not finish (see $CON)" "vulkaninfo in the VM did not finish"
  con_has 'Virtio-GPU Venus' || bench_fail "the guest does not see a Venus GPU (see $CON)" "the guest does not see a Venus GPU"
  echo "== 2/3 vkpeak in the VM"
  run_core b-vkpeak "$(start_of vkpeak)"
  core_ok || bench_fail "vkpeak did not finish (see $CON)" "vkpeak in the VM did not finish"
  echo "== 3/3 llama-bench in the VM ($BM_FILE, -r $BENCH_REPS; $cpus vCPUs, $mem MiB, GPU window $win MiB)"
  MEMORY=$mem CPUS=$cpus TIMEOUT=1800 run_core b-llama "$(start_of llama "$BM_FILE" -r "$BENCH_REPS")" --share "f-models:ro:$BM_DIR" --gpu-window "$win"
  core_ok || bench_fail "llama-bench did not finish (see $CON)" "llama-bench in the VM did not finish"

  echo
  node "$VMAPP/tests/gpu-vulkan/bench-report.js" --model "$BM_FILE" --reps "$BENCH_REPS" --cpus "$cpus" --memory "$mem" --window "$win" \
    --vm-info "$W/b-info.console.log" --vm-vkpeak "$W/b-vkpeak.console.log" --vm-llama "$W/b-llama.console.log" ${nat[@]+"${nat[@]}"} | tee -a "$RESULTS"
  exit "${PIPESTATUS[0]}"
}
if [ "$BENCH" = 1 ]; then bench_main; fi

# ---- 1. vulkaninfo ----
echo "== 1. vulkaninfo through Venus"
run_core t-info "$(start_of info)"
check "1 the core finished with exit 0 (reason core-exited)" core_ok
check "1 the guest sees a Venus device named after the host GPU" con_has 'Virtio-GPU Venus (Apple'
check "1 the driver is Mesa's Venus (DRIVER_ID_MESA_VENUS)" con_has 'DRIVER_ID_MESA_VENUS'
check "1 the core ran as uid/gid 1000 with no other group" bash -c "grep -F 'GPUTEST-INFO uid=1000 gid=1000' '$CON' | grep -qF 'groups=1000'"
check "1 the render node is mode 0660, group 1000" bash -c "grep -F 'renderD128' '$CON' | grep -F GPUTEST-INFO | grep -qE 'crw-rw---- 1 0 1000'"
note "device: $(grep -m1 'deviceName' "$CON" | sed 's/^core: *//')"
note "apiVersion: $(grep -m1 'apiVersion' "$CON" | sed 's/^core: *//'), $(grep -m1 'driverVersion' "$CON" | sed 's/^core: *//')"

# ---- 2. offscreen triangle ----
echo "== 2. offscreen graphics"
run_core t-tri "$(start_of tri)"
check "2 the core finished" core_ok
check "2 the triangle's pixels are right (OFFSCREEN: PASS)" con_has 'OFFSCREEN: PASS'
note "tri: $(grep -m1 -E 'submit|round' "$CON" | sed 's/^core: *//')"

# ---- 3. a compute dispatch ----
echo "== 3. compute (vk-spin)"
run_core t-spin "$(start_of spin 3000000 4096)"
check "3 the core finished" core_ok
check "3 the dispatch finished and the device survived" con_has '(finished)'
note "spin: $(grep -m1 'vkWaitForFences' "$CON" | sed 's/^core: *//')"

# ---- 4. vkpeak ----
if [ "$QUICK" = 0 ]; then
  echo "== 4. vkpeak"
  run_core t-vkpeak "$(start_of vkpeak)"
  check "4 the core finished" core_ok
  GF="$(grep -iE 'fp32|gflops' "$CON" | grep -oE '[0-9]+(\.[0-9]+)?' | sort -rn | head -1)"
  note "vkpeak (largest number printed, GFLOPS or GB/s): ${GF:-?}"
  check "4 vkpeak printed throughput numbers" test -n "${GF:-}"
  grep -E 'GFLOPS|GB/s|fp32|copy' "$CON" | sed 's/^core: */  /' | head -8 | tee -a "$RESULTS"
fi

# ---- 5. llama.cpp on the Vulkan backend ----
if [ "$SKIP_LLAMA" = 0 ]; then
  echo "== 5. llama.cpp Vulkan (llama-bench)"
  MODELS_DIR=""
  if [ -n "$MODEL" ]; then MODELS_DIR="$(cd "$(dirname "$MODEL")" && pwd)"; MODEL="$(basename "$MODEL")"; else
    MODEL="qwen2.5-0.5b-instruct-q4_k_m.gguf"
    for d in "${VMAPP_MODELS:-}" "$OUTD"/work*/cache/models; do [ -n "$d" ] && [ -f "$d/$MODEL" ] && { MODELS_DIR="$d"; break; }; done
  fi
  if [ -z "$MODELS_DIR" ] || [ ! -f "$MODELS_DIR/$MODEL" ]; then
    echo "SKIP: 5 (no model $MODEL; pass --model FILE or set VMAPP_MODELS)"
  else
    MEMORY=4096 CPUS=4 TIMEOUT=400 run_core t-llama "$(start_of llama "$MODEL")" --share "f-models:ro:$MODELS_DIR" --gpu-window 8192
    check "5 the core finished" core_ok
    check "5 llama.cpp found the Venus device" con_has 'ggml_vulkan: 0 = Virtio-GPU Venus (Apple'
    PP="$(grep -E '\|.*pp512' "$CON" | awk -F'|' '{print $(NF-1)}' | awk '{print $1}' | head -1)"
    TG="$(grep -E '\|.*tg128' "$CON" | awk -F'|' '{print $(NF-1)}' | awk '{print $1}' | head -1)"
    note "llama-bench $MODEL (Q4_K_M, -ngl 99, 4 vCPUs): pp512 ${PP:-?} t/s, tg128 ${TG:-?} t/s"
    check "5 prompt processing is on the GPU (pp512 > 1000 t/s)" bash -c "[ \"\$(echo '${PP:-0}' | cut -d. -f1)\" -gt 1000 ]"
    check "5 generation is on the GPU (tg128 > 50 t/s)" bash -c "[ \"\$(echo '${TG:-0}' | cut -d. -f1)\" -gt 50 ]"
  fi
fi

# ---- 6. the GPU probe and the watchdog ----
echo "== 6. GPU probe and watchdog (probe stub)"
# shellcheck source=../../tools/lib/rust-env.sh
. "$VMAPP/tools/lib/rust-env.sh"
rm -f "$W/stub-core.cpio" "$W/initramfs-probe-stub.cpio"
( VMAPP_GPU_PROBE_PATH=/app/gpu-probe-stub.sh; export VMAPP_GPU_PROBE_PATH
    # the toolchain of tools/build.sh (RUSTUP_HOME/CARGO_HOME, or the sibling workspace's, or PATH)
    VMAPP_WORK="${VMAPP_WORK:-$OUTD/work}"; export VMAPP_WORK
    vmapp_rust_env >/dev/null 2>"$W/probe-init-build.log" || exit 1
    export CARGO_TARGET_DIR="$W/target-probe-stub"
    cargo build --release --target "$VMAPP_MUSL" --manifest-path "$VMAPP/guest/Cargo.toml" >"$W/probe-init-build.log" 2>&1 || exit 1
    MKCPIO="$VMAPP_WORK/target/release/mkcpio"
    [ -x "$MKCPIO" ] || { cargo build --release --manifest-path "$VMAPP/tools/mkcpio/Cargo.toml" >>"$W/probe-init-build.log" 2>&1 || exit 1; MKCPIO="$CARGO_TARGET_DIR/release/mkcpio"; }
    "$MKCPIO" --init "$CARGO_TARGET_DIR/$VMAPP_MUSL/release/vmapp-init" "$W/initramfs-probe-stub.cpio" >>"$W/probe-init-build.log" 2>&1
    mkdir -p "$W/stub-core" && find "$W/stub-core" -mindepth 1 -delete
    cp "$VMAPP/tests/gpu-vulkan/core/gpu-probe-stub.sh" "$W/stub-core/gpu-probe-stub.sh" && chmod 755 "$W/stub-core/gpu-probe-stub.sh"
    "$MKCPIO" "$W/stub-core" "$W/stub-core.cpio" >>"$W/probe-init-build.log" 2>&1
)
if [ ! -s "$W/stub-core.cpio" ] || [ ! -s "$W/initramfs-probe-stub.cpio" ]; then
  echo "SKIP: 6 (could not build the test guest init, which needs the Rust toolchain of tools/build.sh; see $W/probe-init-build.log)"
else
  RUN_INITRAMFS="$W/initramfs-probe-stub.cpio" RUN_CORE="$W/stub-core.cpio" TIMEOUT=60 \
    run_core t-watchdog '{"command":["sleep","300"],"workdir":"/app","env":[]}' --watchdog 6
  check "6 the guest started the probe" con_has 'GPU probe running (/app/gpu-probe-stub.sh)'
  check "6 the launcher killed the VM: reason gpu-hang" bash -c "grep -F '\"stopped\"' '$OUT' | tail -1 | jq -e '.reason == \"gpu-hang\"' >/dev/null"
  check "6 the detail names the GPU worker" bash -c "grep -F '\"stopped\"' '$OUT' | tail -1 | jq -e '.detail | test(\"GPU worker\")' >/dev/null"
  check "6 the stopped line is the last line" bash -c "[ \"\$(tail -1 '$OUT')\" = \"\$(grep -F '\"stopped\"' '$OUT' | tail -1)\" ]"
fi

# ---- the part of tests/e2e.sh that applies ----
if [ "$RUN_E2E" = 1 ]; then
  echo "== krun-e2e.sh"
  bash "$VMAPP/tests/gpu-vulkan/krun-e2e.sh" || FAILS=$((FAILS + 1))
fi

echo
echo "---- numbers ($RESULTS) ----"
cat "$RESULTS"
echo
echo "$PASSES passed, $FAILS failed"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
exit 1
