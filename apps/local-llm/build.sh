#!/usr/bin/env bash
# Builds everything the Local LLM app needs that is not source: llama-server for linux-arm64 (the VM), from the pinned llama.cpp
# commit, in a digest-pinned Debian bookworm Docker container (llama.Dockerfile).
#
#   core/bin/llama-server        CPU backend (NEON, -march=armv8.2-a+fp16+dotprod) plus the RPC backend client (-DGGML_RPC=ON)
#   core/bin/LICENSE.llama.cpp   llama.cpp's MIT licence (shipped with the binary)
#   core/bin/BUILD-INFO.txt      what was built from what
#
# glibc 2.36 like the node22 runtime (so it runs there), libstdc++ linked statically, no OpenMP: the binary needs only libc and
# libm. The app has no other native code: the core is Node (runtime node22) and the UI has no vendored libraries.
#
# The llama.cpp commit is read from vmapp/gpu/pins.env: the `gpu` host capability runs a ggml RPC server built from llama.cpp ON
# THE HOST, and the two sides must be the same llama.cpp version, so there is one pin for both. The build also checks that the
# source at that commit has the RPC protocol version gpu/pins.env records (RPC_PROTO_VERSION).
#
# Needs Docker (BuildKit). Downloads (the Debian packages from the pinned snapshot, llama.cpp from GitHub) happen inside the
# container and are cached by Docker's layer cache. Scratch space: $VMAPP_WORK/local-llm (VMAPP_WORK defaults to vmapp/out/work).
#   --no-cache      rebuild from scratch (no Docker layer cache)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
PINS="$HERE/pins.env"
DOCKERFILE="$HERE/llama.Dockerfile"
GPU_PINS="$VMAPP/gpu/pins.env"
ARM_ARCH='armv8.2-a+fp16+dotprod'

die() { echo "local-llm/build.sh: $*" >&2; exit 1; }

NO_CACHE=()
for a in "$@"; do
  case "$a" in
    --no-cache) NO_CACHE=(--no-cache) ;;
    *) die "unknown argument: $a" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker not found (it is needed to build llama-server for linux-arm64)"

# ---- pins ---------------------------------------------------------------------------------------------------------------
# Plain KEY=VALUE lines only; anything else in a pins file is an error.
check_pins_syntax() {
  local f=$1 line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*) ;;
      [A-Z][A-Z0-9_]*=*) case "${line#*=}" in *'$'* | *'`'* | *' '*) die "$f: values must be plain (no spaces, \$ or backticks): $line" ;; esac ;;
      *) die "$f: not a KEY=VALUE line: $line" ;;
    esac
  done <"$f"
}
parse_pin() { # parse_pin FILE KEY -> the value of the line KEY=VALUE
  local v
  v="$(sed -n "s/^$2=//p" "$1" | head -n 1)"
  [ -n "$v" ] || die "$1 has no $2"
  printf '%s' "$v"
}

check_pins_syntax "$PINS"
DEBIAN_IMAGE="$(parse_pin "$PINS" DEBIAN_IMAGE)"
DEBIAN_DIGEST="$(parse_pin "$PINS" DEBIAN_DIGEST)"
DEBIAN_SNAPSHOT="$(parse_pin "$PINS" DEBIAN_SNAPSHOT)"

# The Dockerfile repeats the base image literally (INV-F2); the two must agree.
grep -q "^FROM debian@$DEBIAN_DIGEST AS toolchain\$" "$DOCKERFILE" || die "llama.Dockerfile's base image is not $DEBIAN_IMAGE@$DEBIAN_DIGEST (pins.env)"

# The llama.cpp version comes from the GPU capability's pins, so the VM-side client and the host-side RPC server cannot drift apart.
[ -f "$GPU_PINS" ] || die "$GPU_PINS is missing: it holds the llama.cpp pin that this build and the host's RPC server share"
check_pins_syntax "$GPU_PINS"
LLAMA_CPP_REPO="$(parse_pin "$GPU_PINS" LLAMA_CPP_REPO)"
LLAMA_CPP_TAG="$(parse_pin "$GPU_PINS" LLAMA_CPP_TAG)"
LLAMA_CPP_COMMIT="$(parse_pin "$GPU_PINS" LLAMA_CPP_COMMIT)"
RPC_PROTO_VERSION="$(parse_pin "$GPU_PINS" RPC_PROTO_VERSION)"
case "$LLAMA_CPP_COMMIT" in *[!0-9a-f]* | '') die "LLAMA_CPP_COMMIT in gpu/pins.env must be a full lower-case commit id" ;; esac
[ "${#LLAMA_CPP_COMMIT}" -eq 40 ] || die "LLAMA_CPP_COMMIT in gpu/pins.env must be 40 hex digits"

# ---- build --------------------------------------------------------------------------------------------------------------
WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)/local-llm"
OUT="$WORK/out"
mkdir -p "$WORK/context" "$OUT" "$HERE/core/bin"

echo "== llama-server (-march=$ARM_ARCH) from llama.cpp $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT)"
docker build --platform linux/arm64 "${NO_CACHE[@]+"${NO_CACHE[@]}"}" \
  -f "$DOCKERFILE" --target out --output "type=local,dest=$OUT" \
  --build-arg "DEBIAN_SNAPSHOT=$DEBIAN_SNAPSHOT" \
  --build-arg "LLAMA_CPP_REPO=$LLAMA_CPP_REPO" --build-arg "LLAMA_CPP_COMMIT=$LLAMA_CPP_COMMIT" \
  --build-arg "RPC_PROTO_VERSION=$RPC_PROTO_VERSION" \
  --build-arg "ARM_ARCH=$ARM_ARCH" \
  "$WORK/context" || die "docker build failed"
[ -s "$OUT/llama-server" ] || die "the build produced no llama-server"
cp "$OUT/llama-server" "$HERE/core/bin/llama-server.tmp"
chmod 755 "$HERE/core/bin/llama-server.tmp"
mv -f "$HERE/core/bin/llama-server.tmp" "$HERE/core/bin/llama-server"
cp "$OUT/LICENSE.llama.cpp" "$HERE/core/bin/LICENSE.llama.cpp"
{
  echo "llama.cpp $LLAMA_CPP_TAG"
  echo "commit $LLAMA_CPP_COMMIT"
  echo "source $LLAMA_CPP_REPO"
  echo "rpc protocol $RPC_PROTO_VERSION"
  echo "build debian bookworm snapshot $DEBIAN_SNAPSHOT ($DEBIAN_IMAGE@$DEBIAN_DIGEST), -march=$ARM_ARCH"
  echo "options GGML_RPC=ON GGML_OPENMP=OFF GGML_NATIVE=OFF static libstdc++"
} >"$HERE/core/bin/BUILD-INFO.txt"
echo "built core/bin/llama-server ($(wc -c <"$HERE/core/bin/llama-server" | tr -d ' ') bytes)"
echo "   needs: $(awk '{print $1}' "$OUT/ldd.txt" | tr '\n' ' ')"

# ---- smoke test in the node22 runtime's base image (the same glibc as the VM) -----------------------------------------------
NODE_BASE="$(sed -n 's/^FROM \(node@sha256:[0-9a-f]*\).*/\1/p' "$VMAPP/runtimes/node22/Dockerfile" | head -n 1)"
if [ -n "$NODE_BASE" ]; then
  echo "== smoke test in the node22 runtime's base image"
  docker run --rm --platform linux/arm64 -v "$HERE/core/bin":/x:ro "$NODE_BASE" /x/llama-server --version 2>&1 | head -n 3 | sed 's/^/   /'
fi

echo
echo "done. Next: vmapp/tools/vmapp pack vmapp/apps/local-llm -o local-llm.vmapp"
