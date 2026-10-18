#!/usr/bin/env bash
# The GPU capability against the real thing (SPEC 8.6): the sandboxed Metal rpc-server and a llama.cpp client from the same pinned
# commit, with a small model downloaded once. Needs an Apple-silicon Mac, Xcode's command-line tools and cmake (first run builds
# llama.cpp, a few minutes), network access for the first run only (the clone and the 369 MiB model).
#
#   tests/gpu/run.sh
#
# Builds what is missing:   gpu/build.sh --client       out/gpu/rpc-server, $VMAPP_WORK/gpu-client/bin/{llama-completion,llama-bench}
# Downloads the model once: $VMAPP_WORK/cache/models/   (checked against the pinned sha256 on every run)
# Then runs tests/gpu/host-rpc.mjs and prints PASS/FAIL lines plus the throughput numbers.
set -euo pipefail

VMAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
export VMAPP_WORK="$WORK"

# The test model: SmolLM2-360M-Instruct, Q8_0 (Apache-2.0), from HuggingFaceTB's own GGUF repository.
MODEL_URL="https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q8_0.gguf"
MODEL_SHA256="48ab3034d0dd401fbc721eb1df3217902fee7dab9078992d66431f09b7750201"
MODEL_SIZE=386404992
MODEL="$WORK/cache/models/smollm2-360m-instruct-q8_0.gguf"

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || { echo "SKIP: the GPU test needs an Apple-silicon Mac"; exit 0; }

if [ ! -x "$VMAPP/out/gpu/rpc-server" ] || [ ! -x "$WORK/gpu-client/bin/llama-completion" ] || [ ! -x "$WORK/gpu-client/bin/llama-bench" ]; then
  "$VMAPP/gpu/build.sh" --client
else
  "$VMAPP/gpu/build.sh" --check >/dev/null 2>&1 || echo "note: out/gpu is out of date for gpu/ (run gpu/build.sh to rebuild); testing what is there"
fi

sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }
if [ ! -f "$MODEL" ] || [ "$(wc -c <"$MODEL" | tr -d ' ')" != "$MODEL_SIZE" ]; then
  mkdir -p "$(dirname "$MODEL")"
  echo "downloading the test model ($MODEL_URL)"
  curl -fL --retry 3 -o "$MODEL.part.$$" "$MODEL_URL"
  mv -f "$MODEL.part.$$" "$MODEL"
fi
[ "$(sha256_of "$MODEL")" = "$MODEL_SHA256" ] || { echo "the model's sha256 is not the pinned $MODEL_SHA256: delete $MODEL and run again, or investigate"; exit 1; }

exec node "$VMAPP/tests/gpu/host-rpc.mjs"
