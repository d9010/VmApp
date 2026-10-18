#!/usr/bin/env bash
# Builds Ollama's Vulkan backend for the Ollama (GPU) sample, and assembles that app. (EXPERIMENTAL: SPEC 8.7.)
#
#   apps/ollama/vulkan/build-vulkan.sh [--force] [--no-cache] [--jobs N] [--no-sync] [--min-free-gb N] [--check]
#   apps/ollama/build.sh --with-vulkan          the same, after the release is unpacked
#
# The linux-arm64 release of Ollama (apps/ollama/build.sh) has no Vulkan backend. This builds the one library that is missing,
# libggml-vulkan.so, from the llama.cpp tag that Ollama's own tag builds on (pins.env), in a Docker container on the base image and
# Debian snapshot of runtime node22-gpu (Dockerfile; read its header for what is checked against Ollama's files and the release).
#
# Then it makes the app `apps/ollama-gpu` (id dev.vmapp.ollama.gpu, runtime node22-gpu, manifest permission {cap:gpu, api:vulkan}):
#   apps/ollama-gpu/core  = a copy of apps/ollama/core (the release, the Node core) + lib/ollama/vulkan/libggml-vulkan.so
#   apps/ollama-gpu/ui    = a copy of apps/ollama/ui
# Both are git-ignored and rebuilt every time, so the two apps share one source. The plain Ollama app is NOT touched: it stays on
# runtime node22 and does not carry the library. (Why a second app: a manifest with api:vulkan must name runtime node22-gpu, SPEC 2.2.)
#
# Cache: $VMAPP_WORK/ollama/vulkan/{out,context}. With the same pins, Dockerfile and release the Docker build is skipped.
# Needs: the release unpacked (apps/ollama/build.sh), Docker with BuildKit running, network access for the container (the Debian
# snapshot, GitHub), rsync (ships with macOS), and room: the build takes about 3 GB in Docker's disk image, which lives on the volume
# of $HOME (the script refuses to start with less than --min-free-gb free there, default 6; 0 turns the check off).
#   --force          build again even if the cache matches
#   --no-cache       also ignore Docker's layer cache (implies --force)
#   --jobs N         compiler jobs in the container (default: its CPUs; lower it when Docker has little memory)
#   --no-sync        only build into the cache; do not touch apps/ollama-gpu
#   --check          verify the pins and their agreement with the runtime and the release, print what would be built, run nothing
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA_APP="$(cd "$HERE/.." && pwd)"
VMAPP="$(cd "$OLLAMA_APP/../.." && pwd)"
GPU_APP="$VMAPP/apps/ollama-gpu"
PINS="$HERE/pins.env"
OLLAMA_PINS="$OLLAMA_APP/pins.env"
DOCKERFILE="$HERE/Dockerfile"
RUNTIME_DOCKERFILE="$VMAPP/runtimes/node22-gpu/Dockerfile"
CORE="$OLLAMA_APP/core"

die() { echo "ollama/vulkan/build-vulkan.sh: $*" >&2; exit 1; }
need() { echo "ollama/vulkan/build-vulkan.sh: $*" >&2; exit 2; } # a prerequisite is missing: exit status 2, with the fix in the message

FORCE=0 NO_CACHE=() JOBS="" SYNC=1 MIN_FREE_GB=6 CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --no-cache) FORCE=1; NO_CACHE=(--no-cache) ;;
    --jobs) JOBS="${2:?--jobs needs a number}"; shift ;;
    --no-sync) SYNC=0 ;;
    --min-free-gb) MIN_FREE_GB="${2:?--min-free-gb needs a number}"; shift ;;
    --check) CHECK=1 ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
case "$JOBS" in '' | [1-9] | [1-9][0-9]) ;; *) die "--jobs needs a number from 1 to 99" ;; esac
JOBS_ARG=()
[ -z "$JOBS" ] || JOBS_ARG=(--build-arg "JOBS=$JOBS")
case "$MIN_FREE_GB" in '' | *[!0-9]*) die "--min-free-gb needs a whole number" ;; esac

sha256_of() { # sha256_of FILE -> the lower-case hex digest
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

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
for f in "$PINS" "$OLLAMA_PINS"; do [ -f "$f" ] || die "missing $f"; check_pins_syntax "$f"; done
OLLAMA_TAG_COMMIT="$(parse_pin "$PINS" OLLAMA_TAG_COMMIT)"
LLAMA_CPP_REPO="$(parse_pin "$PINS" LLAMA_CPP_REPO)"
LLAMA_CPP_TAG="$(parse_pin "$PINS" LLAMA_CPP_TAG)"
LLAMA_CPP_COMMIT="$(parse_pin "$PINS" LLAMA_CPP_COMMIT)"
APT_BUILD_ESSENTIAL="$(parse_pin "$PINS" APT_BUILD_ESSENTIAL)"
APT_CMAKE="$(parse_pin "$PINS" APT_CMAKE)"
APT_NINJA_BUILD="$(parse_pin "$PINS" APT_NINJA_BUILD)"
APT_GLSLC="$(parse_pin "$PINS" APT_GLSLC)"
APT_LIBVULKAN_DEV="$(parse_pin "$PINS" APT_LIBVULKAN_DEV)"
APT_SPIRV_HEADERS="$(parse_pin "$PINS" APT_SPIRV_HEADERS)"
for h in "$OLLAMA_TAG_COMMIT" "$LLAMA_CPP_COMMIT"; do
  case "$h" in *[!0-9a-f]* | '') die "a commit pin must be a full lower-case commit id" ;; esac
  [ "${#h}" -eq 40 ] || die "a commit pin must be 40 hex digits"
done
case "$LLAMA_CPP_REPO" in https://github.com/ggml-org/llama.cpp.git) ;; *) die "LLAMA_CPP_REPO must be https://github.com/ggml-org/llama.cpp.git" ;; esac
case "$LLAMA_CPP_TAG" in b[0-9]*) ;; *) die "LLAMA_CPP_TAG must look like b11081" ;; esac
[ "$OLLAMA_TAG_COMMIT" = "$(parse_pin "$OLLAMA_PINS" OLLAMA_TAG_COMMIT)" ] || die "OLLAMA_TAG_COMMIT in pins.env here and in ../pins.env differ: the Vulkan library must be built for the release the app ships"

# The build container is the runtime's own base image and snapshot: the library then links against what it will find.
[ -f "$DOCKERFILE" ] && [ -f "$RUNTIME_DOCKERFILE" ] || die "missing $DOCKERFILE or $RUNTIME_DOCKERFILE"
from_of() { sed -n 's/^FROM \(node@sha256:[0-9a-f]\{64\}\) AS base$/\1/p' "$1" | head -n 1; }
snap_of() { sed -n 's#.*archive/debian-security/\([0-9]\{8\}T[0-9]\{6\}Z\).*#\1#p' "$1" | head -n 1; }
[ -n "$(from_of "$RUNTIME_DOCKERFILE")" ] && [ "$(from_of "$DOCKERFILE")" = "$(from_of "$RUNTIME_DOCKERFILE")" ] \
  || die "the base image of Dockerfile is not the one of runtimes/node22-gpu/Dockerfile ($(from_of "$RUNTIME_DOCKERFILE")): keep them equal"
[ -n "$(snap_of "$RUNTIME_DOCKERFILE")" ] && [ "$(snap_of "$DOCKERFILE")" = "$(snap_of "$RUNTIME_DOCKERFILE")" ] \
  || die "the Debian snapshot of Dockerfile is not the one of runtimes/node22-gpu/Dockerfile ($(snap_of "$RUNTIME_DOCKERFILE")): keep them equal"

# ---- the release (its libggml-base is the ABI the library must fit) ----------------------------------------------------------
[ -x "$CORE/bin/ollama" ] && [ -f "$CORE/bin/BUILD-INFO.txt" ] || need "Ollama's release is not unpacked in apps/ollama/core. Fix: apps/ollama/build.sh"
REF=""
for f in "$CORE"/lib/ollama/libggml-base.so.*.*.*; do
  [ -f "$f" ] || continue
  [ -z "$REF" ] || die "more than one libggml-base.so.X.Y.Z in apps/ollama/core/lib/ollama"
  REF="$f"
done
[ -n "$REF" ] || need "apps/ollama/core/lib/ollama/libggml-base.so.X.Y.Z is missing (the release is not unpacked). Fix: apps/ollama/build.sh --force"
OLLAMA_VERSION="$(sed -n 's/^ollama \([0-9.]*\) asset-sha256.*/\1/p' "$CORE/bin/BUILD-INFO.txt" | head -n 1)"
[ -n "$OLLAMA_VERSION" ] || die "cannot read the Ollama version from apps/ollama/core/bin/BUILD-INFO.txt"
[ "$OLLAMA_VERSION" = "$(parse_pin "$OLLAMA_PINS" OLLAMA_VERSION)" ] || need "apps/ollama/core holds Ollama $OLLAMA_VERSION, pins.env says $(parse_pin "$OLLAMA_PINS" OLLAMA_VERSION). Fix: apps/ollama/build.sh --force"

WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)/ollama/vulkan"
OUT="$WORK/out"
CTX="$WORK/context"
STAMP_FILE="$WORK/stamp"
STAMP="$( { cat "$PINS" "$DOCKERFILE"; echo "ref $(basename "$REF") $(sha256_of "$REF")"; } | shasum -a 256 | awk '{print $1}')"

echo "== Ollama's Vulkan backend: libggml-vulkan.so from llama.cpp $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT) for Ollama $OLLAMA_VERSION ($(basename "$REF"))"
echo "   build container: $(from_of "$DOCKERFILE") with the Debian snapshot $(snap_of "$DOCKERFILE"); cache $WORK"
if [ "$CHECK" -eq 1 ]; then
  echo "pins are consistent with runtimes/node22-gpu and with the unpacked release (nothing was run)"
  exit 0
fi

# ---- build (Docker), unless the cache holds this exact build -----------------------------------------------------------------
if [ "$FORCE" -eq 0 ] && [ -s "$OUT/libggml-vulkan.so" ] && [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$STAMP" ]; then
  echo "== the cache holds this build already ($OUT/libggml-vulkan.so); --force builds again"
else
  command -v docker >/dev/null 2>&1 || need "docker not found (it is needed to build for linux-arm64)"
  docker info >/dev/null 2>&1 || need "Docker is not running (start Docker Desktop and run this again)"
  if [ "$MIN_FREE_GB" -gt 0 ]; then
    free_kb="$(df -Pk "$HOME" | awk 'NR == 2 { print $4 }')"
    free_gb=$((free_kb / 1024 / 1024))
    [ "$free_gb" -ge "$MIN_FREE_GB" ] || need "only $free_gb GB are free on the volume of \$HOME, where Docker keeps its disk image; the build needs about 3 GB (--min-free-gb $MIN_FREE_GB). Free space (docker system prune, caches) and run this again, or pass --min-free-gb 0"
  fi
  case "$CTX" in /*/ollama/vulkan/context) ;; *) die "unexpected context path $CTX" ;; esac
  case "$OUT" in /*/ollama/vulkan/out) ;; *) die "unexpected output path $OUT" ;; esac
  mkdir -p "$CTX/ref" "$OUT"
  find "$CTX/ref" -mindepth 1 -delete
  cp "$REF" "$CTX/ref/$(basename "$REF")"
  find "$OUT" -mindepth 1 -delete
  rm -f "$STAMP_FILE"

  echo "== docker build (first time: 10 to 30 minutes, ggml's Vulkan shaders are compiled)"
  docker build --platform linux/arm64 "${NO_CACHE[@]+"${NO_CACHE[@]}"}" \
    -f "$DOCKERFILE" --target out --output "type=local,dest=$OUT" \
    --build-arg "LLAMA_CPP_REPO=$LLAMA_CPP_REPO" --build-arg "LLAMA_CPP_TAG=$LLAMA_CPP_TAG" --build-arg "LLAMA_CPP_COMMIT=$LLAMA_CPP_COMMIT" \
    --build-arg "OLLAMA_TAG_COMMIT=$OLLAMA_TAG_COMMIT" \
    --build-arg "APT_BUILD_ESSENTIAL=$APT_BUILD_ESSENTIAL" --build-arg "APT_CMAKE=$APT_CMAKE" --build-arg "APT_NINJA_BUILD=$APT_NINJA_BUILD" \
    --build-arg "APT_GLSLC=$APT_GLSLC" --build-arg "APT_LIBVULKAN_DEV=$APT_LIBVULKAN_DEV" --build-arg "APT_SPIRV_HEADERS=$APT_SPIRV_HEADERS" \
    ${JOBS_ARG[@]+"${JOBS_ARG[@]}"} \
    "$CTX" || die "docker build failed"
  [ -s "$OUT/libggml-vulkan.so" ] || die "the build produced no libggml-vulkan.so"
  [ -s "$OUT/abi-check.txt" ] || die "the build did not run the check against the release's libggml-base"
  # an aarch64 ELF? (bytes 0-3 = 7f 45 4c 46, e_machine at offset 18 = 0xb7)
  [ "$(od -An -tx1 -N4 "$OUT/libggml-vulkan.so" | tr -d ' \n')" = "7f454c46" ] || die "libggml-vulkan.so is not an ELF file"
  [ "$(od -An -tx1 -j18 -N2 "$OUT/libggml-vulkan.so" | tr -d ' \n')" = "b700" ] || die "libggml-vulkan.so is not for aarch64"
  printf '%s' "$STAMP" >"$STAMP_FILE"
  echo "built $OUT/libggml-vulkan.so ($(wc -c <"$OUT/libggml-vulkan.so" | tr -d ' ') bytes)"
  sed 's/^/   /' "$OUT/abi-check.txt" "$OUT/dynamic.txt"
fi

# ---- the app: a copy of the Ollama app's core and ui, plus the library ---------------------------------------------------------
if [ "$SYNC" -eq 0 ]; then
  echo "(--no-sync: apps/ollama-gpu was not touched)"
  exit 0
fi
command -v rsync >/dev/null 2>&1 || need "rsync not found (it ships with macOS)"
[ -f "$GPU_APP/vmapp.json" ] || die "$GPU_APP/vmapp.json is missing (it is part of the repository)"
[ -d "$OLLAMA_APP/ui" ] || die "$OLLAMA_APP/ui is missing"
mkdir -p "$GPU_APP/core" "$GPU_APP/ui"
# --delete only inside the two generated folders of the GPU app (both are git-ignored)
rsync -a --delete "$CORE/" "$GPU_APP/core/"
rsync -a --delete "$OLLAMA_APP/ui/" "$GPU_APP/ui/"
mkdir -p "$GPU_APP/core/lib/ollama/vulkan"
cp "$OUT/libggml-vulkan.so" "$GPU_APP/core/lib/ollama/vulkan/libggml-vulkan.so.tmp"
chmod 755 "$GPU_APP/core/lib/ollama/vulkan/libggml-vulkan.so.tmp"
mv -f "$GPU_APP/core/lib/ollama/vulkan/libggml-vulkan.so.tmp" "$GPU_APP/core/lib/ollama/vulkan/libggml-vulkan.so"
{
  echo "vulkan backend (lib/ollama/vulkan/libggml-vulkan.so): built by apps/ollama/vulkan/build-vulkan.sh from llama.cpp $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT)"
  sed 's/^/vulkan build: /' "$OUT/BUILD-INFO.txt"
  sed 's/^/vulkan build: /' "$OUT/abi-check.txt"
} >>"$GPU_APP/core/bin/BUILD-INFO.txt"
echo "assembled apps/ollama-gpu: core ($(du -sk "$GPU_APP/core" | awk '{print $1}') KiB, with lib/ollama/vulkan/libggml-vulkan.so) and ui"
echo
echo "done. Next: vmapp/tests/apps/ollama-gpu.sh   (packs, installs and tests dev.vmapp.ollama.gpu on the Vulkan backend)"
