#!/usr/bin/env bash
# Builds Ollama (Desktop) (dev.vmapp.ollama.desktop) from the pinned Ollama source, for linux-arm64 (the VM) and the window.
#
#   core/bin/ollama        Ollama v0.35.0 itself (the server and the CLI), compiled from the tag commit WITH patches/go/0001 (the blob
#                          download honours HTTPS_PROXY) and patches/go/0002 (the desktop app's Go packages build on Linux)
#   core/bin/vmapp-ui      the desktop app's Go backend (app/ui, app/store, app/server) as a headless program: backend/vmapp-ui/main.go
#   core/lib/ollama/       the CPU runners, compiled from the same tag with Ollama's own cmake preset (llama-server, libllama*, ggml,
#                          the CPU backend in eight CPU-feature variants), the licences of the bundled code, and the Vulkan backend
#                          (lib/ollama/vulkan/libggml-vulkan.so, built by apps/ollama/vulkan/build-vulkan.sh: pass it with --vulkan-lib)
#   core/http-bridge.js    sdk/node/http-bridge.js, the core half of the streamed HTTP bridge
#   ui/                    the React app of the same tag (app/ui/app) built with its own lockfile (npm ci, tsc, vite) + patches/ui,
#                          the two vmapp scripts it loads first (sdk/web/vmapp-fetch.js, shim/ollama-desktop-shim.js), a licence list
#
# Everything is built in Docker from pinned inputs (pins.env): the Go toolchain image by digest, Debian packages from a snapshot, Ollama
# by tag AND commit (the clone is verified), llama.cpp by tag AND commit, the UI's npm packages by package-lock.json (npm ci, scripts off).
# Caches (Go modules and build cache, npm) and all build products live under $VMAPP_WORK; nothing is written elsewhere except core/ and ui/.
#
#   apps/ollama-desktop/build.sh [--vulkan-lib FILE] [--force] [--only go|runners|ui] [--jobs N] [--min-free-gb N] [--check]
#     --vulkan-lib FILE  the Vulkan backend library to bundle (default: $VMAPP_WORK/ollama/vulkan/out/libggml-vulkan.so, which
#                        apps/ollama/vulkan/build-vulkan.sh --no-sync leaves there). Without one the app runs on the CPU only.
#     --force            build every stage again even if its inputs are unchanged
#     --only STAGE       run just one stage (go, runners or ui) and do not assemble core/ and ui/
#     --jobs N           compiler jobs for the runners (default: the container's CPUs)
#     --min-free-gb N    refuse to start a Docker stage with less than N GB free on the volume of Docker's disk image (default 8; 0 = off)
#     --check            read and verify the pins (and that the Ollama clone is at the pinned commit), print the plan, run nothing
# Needs: Docker (BuildKit), git, tar, patch, curl (to clone Ollama the first time), node (the UI checks), network access in the containers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
PINS="$HERE/pins.env"
die() { echo "ollama-desktop/build.sh: $*" >&2; exit 1; }
need() { echo "ollama-desktop/build.sh: $*" >&2; exit 2; } # a prerequisite is missing: exit status 2, with the fix in the message

VULKAN_LIB="" FORCE=0 ONLY="" JOBS="" MIN_FREE_GB=8 CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vulkan-lib) VULKAN_LIB="${2:?--vulkan-lib needs a file}"; shift ;;
    --force) FORCE=1 ;;
    --only) ONLY="${2:?--only needs go, runners or ui}"; shift ;;
    --jobs) JOBS="${2:?--jobs needs a number}"; shift ;;
    --min-free-gb) MIN_FREE_GB="${2:?--min-free-gb needs a number}"; shift ;;
    --check) CHECK=1 ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
case "$ONLY" in '' | go | runners | ui) ;; *) die "--only takes go, runners or ui" ;; esac
case "$JOBS" in '' | [1-9] | [1-9][0-9]) ;; *) die "--jobs needs a number from 1 to 99" ;; esac
case "$MIN_FREE_GB" in '' | *[!0-9]*) die "--min-free-gb needs a whole number" ;; esac

sha256_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
sha256_stdin() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'; else sha256sum | awk '{print $1}'; fi; }

# ---- pins (plain KEY=VALUE lines only) --------------------------------------------------------------------------------------
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
parse_pin() {
  local v
  v="$(sed -n "s/^$2=//p" "$1" | head -n 1)"
  [ -n "$v" ] || die "$1 has no $2"
  printf '%s' "$v"
}
check_pins_syntax "$PINS"
OLLAMA_VERSION="$(parse_pin "$PINS" OLLAMA_VERSION)"
OLLAMA_TAG="$(parse_pin "$PINS" OLLAMA_TAG)"
OLLAMA_TAG_COMMIT="$(parse_pin "$PINS" OLLAMA_TAG_COMMIT)"
OLLAMA_REPO="$(parse_pin "$PINS" OLLAMA_REPO)"
OLLAMA_LICENSE_SHA256="$(parse_pin "$PINS" OLLAMA_LICENSE_SHA256)"
LLAMA_CPP_TAG="$(parse_pin "$PINS" LLAMA_CPP_TAG)"
LLAMA_CPP_COMMIT="$(parse_pin "$PINS" LLAMA_CPP_COMMIT)"
GOLANG_IMAGE_DIGEST="$(parse_pin "$PINS" GOLANG_IMAGE_DIGEST)"
APT_SNAPSHOT="$(parse_pin "$PINS" APT_SNAPSHOT)"
APT_CMAKE="$(parse_pin "$PINS" APT_CMAKE)"
APT_NINJA_BUILD="$(parse_pin "$PINS" APT_NINJA_BUILD)"
case "$OLLAMA_VERSION" in *[!0-9.]* | '') die "OLLAMA_VERSION must be digits and dots" ;; esac
[ "$OLLAMA_TAG" = "v$OLLAMA_VERSION" ] || die "OLLAMA_TAG must be v$OLLAMA_VERSION"
for h in "$OLLAMA_TAG_COMMIT" "$LLAMA_CPP_COMMIT"; do
  case "$h" in *[!0-9a-f]* | '') die "a commit pin must be a full lower-case commit id" ;; esac
  [ "${#h}" -eq 40 ] || die "a commit pin must be 40 hex digits"
done
case "$OLLAMA_REPO" in https://github.com/ollama/ollama.git) ;; *) die "OLLAMA_REPO must be https://github.com/ollama/ollama.git" ;; esac
case "$LLAMA_CPP_TAG" in b[0-9]*) ;; *) die "LLAMA_CPP_TAG must look like b11081" ;; esac
case "$GOLANG_IMAGE_DIGEST" in sha256:????????????????????????????????????????????????????????????????) ;; *) die "GOLANG_IMAGE_DIGEST must be sha256:<64 hex>" ;; esac
# the same Ollama commit and llama.cpp commit as the other Ollama apps' pins, and the Dockerfile's image is the pinned one
[ "$OLLAMA_TAG_COMMIT" = "$(parse_pin "$VMAPP/apps/ollama/pins.env" OLLAMA_TAG_COMMIT)" ] || die "OLLAMA_TAG_COMMIT differs from apps/ollama/pins.env"
[ "$LLAMA_CPP_COMMIT" = "$(parse_pin "$VMAPP/apps/ollama/vulkan/pins.env" LLAMA_CPP_COMMIT)" ] || die "LLAMA_CPP_COMMIT differs from apps/ollama/vulkan/pins.env"
grep -q "^FROM golang@$GOLANG_IMAGE_DIGEST\$" "$HERE/build/Dockerfile" || die "build/Dockerfile does not start from golang@$GOLANG_IMAGE_DIGEST (pins.env)"

WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
SRC="$WORK/src/ollama"
BUILD="$WORK/build/ollama-desktop"
CACHE="$WORK/cache"
[ -n "$VULKAN_LIB" ] || VULKAN_LIB="$WORK/ollama/vulkan/out/libggml-vulkan.so"

# ---- the Ollama source at the pinned commit ----------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  [ "$CHECK" -eq 0 ] || die "no clone at $SRC (build.sh clones $OLLAMA_REPO there)"
  command -v git >/dev/null 2>&1 || need "git not found"
  mkdir -p "$(dirname "$SRC")"
  echo "== cloning $OLLAMA_REPO at $OLLAMA_TAG into $SRC"
  git clone --quiet --branch "$OLLAMA_TAG" "$OLLAMA_REPO" "$SRC" || die "clone failed"
fi
[ "$(git -C "$SRC" rev-parse "$OLLAMA_TAG_COMMIT^{commit}" 2>/dev/null || true)" = "$OLLAMA_TAG_COMMIT" ] || die "$SRC does not contain the pinned commit $OLLAMA_TAG_COMMIT"
TAG_COMMIT="$(git -C "$SRC" rev-parse "refs/tags/$OLLAMA_TAG^{commit}" 2>/dev/null || true)"
[ "$TAG_COMMIT" = "$OLLAMA_TAG_COMMIT" ] || die "the tag $OLLAMA_TAG in $SRC is $TAG_COMMIT, not the pinned $OLLAMA_TAG_COMMIT"
LLAMA_FILE="$(git -C "$SRC" show "$OLLAMA_TAG_COMMIT:LLAMA_CPP_VERSION" | tr -d '[:space:]')"
[ "$LLAMA_FILE" = "$LLAMA_CPP_TAG" ] || die "Ollama's LLAMA_CPP_VERSION is $LLAMA_FILE, pins.env says $LLAMA_CPP_TAG"
LICENSE_SHA="$(git -C "$SRC" show "$OLLAMA_TAG_COMMIT:LICENSE" | sha256_stdin)"
[ "$LICENSE_SHA" = "$OLLAMA_LICENSE_SHA256" ] || die "Ollama's LICENSE does not match OLLAMA_LICENSE_SHA256"

PATCHES=("$HERE"/patches/go/*.patch "$HERE"/patches/ui/*.patch)
for p in "${PATCHES[@]}"; do [ -f "$p" ] || die "missing patch $p"; done
TREE_STAMP="$( { cat "$PINS" "${PATCHES[@]}" "$HERE/backend/vmapp-ui/main.go"; } | sha256_stdin | cut -c1-16)"
TREE="$BUILD/tree-$TREE_STAMP"
IMAGE_STAMP="$( { cat "$HERE/build/Dockerfile"; printf '%s\n' "$GOLANG_IMAGE_DIGEST" "$APT_SNAPSHOT" "$APT_CMAKE" "$APT_NINJA_BUILD"; } | sha256_stdin | cut -c1-12)"
IMAGE="vmapp-ollama-desktop-build:$IMAGE_STAMP"
NODE_BASE="$(sed -n 's/^FROM \(node@sha256:[0-9a-f]\{64\}\).*/\1/p' "$VMAPP/runtimes/node22/Dockerfile" | head -n 1)"
[ -n "$NODE_BASE" ] || die "cannot read the node base image from runtimes/node22/Dockerfile"

echo "== Ollama (Desktop): Ollama $OLLAMA_VERSION ($OLLAMA_TAG_COMMIT), llama.cpp $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT)"
echo "   Go image golang@${GOLANG_IMAGE_DIGEST:0:19}…, UI image ${NODE_BASE:0:24}…, source tree $TREE, caches $CACHE"
if [ "$CHECK" -eq 1 ]; then
  echo "   patches: $(for p in "${PATCHES[@]}"; do basename "$p"; done | tr '\n' ' ')"
  echo "   Vulkan library: $VULKAN_LIB ($([ -f "$VULKAN_LIB" ] && echo present || echo 'not found: the app would run on the CPU only'))"
  echo "pins are consistent and the clone is at the pinned commit (nothing was run)"
  exit 0
fi

command -v docker >/dev/null 2>&1 || need "docker not found (it is needed to build for linux-arm64)"
docker info >/dev/null 2>&1 || need "Docker is not running (start Docker Desktop and run this again)"
for t in git tar patch node; do command -v "$t" >/dev/null 2>&1 || need "$t not found"; done

free_check() { # refuses to start a Docker stage when the volume of Docker's disk image is nearly full
  [ "$MIN_FREE_GB" -gt 0 ] || return 0
  # Docker Desktop's disk image is on the internal disk; another engine says where its data lives with VMAPP_DOCKER_DATA
  local vol="${VMAPP_DOCKER_DATA:-/System/Volumes/Data}" free_kb
  [ -d "$vol" ] || vol="$HOME"
  free_kb="$(df -Pk "$vol" | awk 'NR == 2 { print $4 }')"
  [ $((free_kb / 1024 / 1024)) -ge "$MIN_FREE_GB" ] || need "only $((free_kb / 1024 / 1024)) GB are free on $vol, where Docker keeps its disk image (--min-free-gb $MIN_FREE_GB). Free space and run this again."
}

# ---- the patched source tree -------------------------------------------------------------------------------------------------
if [ ! -f "$TREE/.vmapp-tree-ok" ]; then
  echo "== source tree: git archive of $OLLAMA_TAG_COMMIT, patches, backend/vmapp-ui"
  mkdir -p "$BUILD"
  if [ -e "$TREE.part" ]; then mv "$TREE.part" "$TREE.part.$(date +%Y%m%d%H%M%S)"; fi # never deleted: moved aside
  mkdir -p "$TREE.part"
  git -C "$SRC" archive --format=tar "$OLLAMA_TAG_COMMIT" | tar -x -C "$TREE.part"
  for p in "${PATCHES[@]}"; do
    patch -p1 -d "$TREE.part" --dry-run -s <"$p" >/dev/null || die "patch does not apply: $(basename "$p")"
    patch -p1 -d "$TREE.part" -s <"$p" >/dev/null
    echo "   applied $(basename "$p")"
  done
  mkdir -p "$TREE.part/app/cmd/vmapp-ui"
  cp "$HERE/backend/vmapp-ui/main.go" "$TREE.part/app/cmd/vmapp-ui/main.go"
  : >"$TREE.part/.vmapp-tree-ok"
  if [ -e "$TREE" ]; then mv "$TREE" "$TREE.old.$(date +%Y%m%d%H%M%S)"; fi
  mv "$TREE.part" "$TREE"
fi

mkdir -p "$BUILD/stamps" "$BUILD/logs" "$BUILD/out-go" "$BUILD/out-runners" "$BUILD/out-ui" "$CACHE/go-mod" "$CACHE/go-build" "$CACHE/npm"

# ---- the toolchain image ------------------------------------------------------------------------------------------------------
ensure_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then return 0; fi
  free_check
  echo "== building the toolchain image $IMAGE"
  docker build --platform linux/arm64 -t "$IMAGE" \
    --build-arg "APT_SNAPSHOT=$APT_SNAPSHOT" --build-arg "APT_CMAKE=$APT_CMAKE" --build-arg "APT_NINJA_BUILD=$APT_NINJA_BUILD" \
    -f "$HERE/build/Dockerfile" "$HERE/build" >"$BUILD/logs/image.log" 2>&1 || { tail -n 30 "$BUILD/logs/image.log"; die "the toolchain image did not build (log: $BUILD/logs/image.log)"; }
}

stage_current() { # stage_current NAME STAMP: is the stage's output already built from these inputs?
  [ "$FORCE" -eq 0 ] && [ -f "$BUILD/stamps/$1" ] && [ "$(cat "$BUILD/stamps/$1")" = "$2" ]
}

# ---- stage: Go ------------------------------------------------------------------------------------------------------------------
if [ -z "$ONLY" ] || [ "$ONLY" = go ]; then
  GO_STAMP="$( { echo "$OLLAMA_TAG_COMMIT $IMAGE_STAMP"; cat "$HERE"/patches/go/*.patch "$HERE/backend/vmapp-ui/main.go" "$HERE/build/go-stage.sh"; } | sha256_stdin)"
  if stage_current go "$GO_STAMP" && [ -x "$BUILD/out-go/bin/ollama" ] && [ -x "$BUILD/out-go/bin/vmapp-ui" ]; then
    echo "== Go: up to date"
  else
    ensure_image
    free_check
    echo "== Go: ollama and vmapp-ui (go build -trimpath -buildmode=pie, go.sum enforced)"
    docker run --rm --platform linux/arm64 \
      -v "$TREE:/src" -v "$CACHE/go-mod:/go/pkg/mod" -v "$CACHE/go-build:/root/.cache/go-build" -v "$BUILD/out-go:/out" -v "$HERE/build:/stage:ro" \
      -e "OLLAMA_VERSION=$OLLAMA_VERSION" "$IMAGE" sh /stage/go-stage.sh >"$BUILD/logs/go.log" 2>&1 || { tail -n 40 "$BUILD/logs/go.log"; die "the Go stage failed (log: $BUILD/logs/go.log)"; }
    tail -n 12 "$BUILD/logs/go.log" | sed 's/^/   /'
    echo "$GO_STAMP" >"$BUILD/stamps/go"
  fi
fi

# ---- stage: the CPU runners -----------------------------------------------------------------------------------------------------
if [ -z "$ONLY" ] || [ "$ONLY" = runners ]; then
  RUN_STAMP="$( { echo "$OLLAMA_TAG_COMMIT $IMAGE_STAMP $LLAMA_CPP_COMMIT"; cat "$HERE/build/runner-stage.sh"; } | sha256_stdin)" # no patch touches llama/ or cmake/
  if stage_current runners "$RUN_STAMP" && [ -x "$BUILD/out-runners/lib/ollama/llama-server" ]; then
    echo "== runners: up to date"
  else
    ensure_image
    free_check
    echo "== runners: llama-server and the ggml CPU backends from llama.cpp $LLAMA_CPP_TAG (Ollama's preset cpu; takes a while)"
    docker run --rm --platform linux/arm64 \
      -v "$TREE:/src:ro" -v "$BUILD/out-runners:/out" -v "$HERE/build:/stage:ro" \
      -e "LLAMA_CPP_COMMIT=$LLAMA_CPP_COMMIT" ${JOBS:+-e "JOBS=$JOBS"} "$IMAGE" sh /stage/runner-stage.sh >"$BUILD/logs/runners.log" 2>&1 || { tail -n 40 "$BUILD/logs/runners.log"; die "the runner stage failed (log: $BUILD/logs/runners.log)"; }
    tail -n 12 "$BUILD/logs/runners.log" | sed 's/^/   /'
    echo "$RUN_STAMP" >"$BUILD/stamps/runners"
  fi
fi

# ---- stage: the UI ----------------------------------------------------------------------------------------------------------------
if [ -z "$ONLY" ] || [ "$ONLY" = ui ]; then
  UI_STAMP="$( { echo "$OLLAMA_TAG_COMMIT $NODE_BASE"; cat "$HERE"/patches/ui/*.patch "$HERE/build/ui-stage.sh" "$HERE/build/licenses.mjs"; } | sha256_stdin)"
  if stage_current ui "$UI_STAMP" && [ -f "$BUILD/out-ui/dist/index.html" ]; then
    echo "== UI: up to date"
  else
    free_check
    echo "== UI: npm ci (lockfile, no install scripts), tsc, vite build"
    docker run --rm --platform linux/arm64 \
      -v "$TREE/app/ui/app:/ui" -v "$CACHE/npm:/npmcache" -v "$BUILD/out-ui:/out" -v "$HERE/build:/stage:ro" \
      -e npm_config_cache=/npmcache "$NODE_BASE" sh /stage/ui-stage.sh >"$BUILD/logs/ui.log" 2>&1 || { tail -n 40 "$BUILD/logs/ui.log"; die "the UI stage failed (log: $BUILD/logs/ui.log)"; }
    tail -n 8 "$BUILD/logs/ui.log" | sed 's/^/   /'
    echo "$UI_STAMP" >"$BUILD/stamps/ui"
  fi
fi

if [ -n "$ONLY" ]; then echo "done ($ONLY only; core/ and ui/ not assembled)"; exit 0; fi

# ---- assemble core/ and ui/ -----------------------------------------------------------------------------------------------------------
echo "== assembling core/ and ui/"
OUTGO="$BUILD/out-go" OUTRUN="$BUILD/out-runners" OUTUI="$BUILD/out-ui/dist"
[ -x "$OUTGO/bin/ollama" ] && [ -x "$OUTRUN/lib/ollama/llama-server" ] && [ -f "$OUTUI/index.html" ] || die "a stage output is missing: run build.sh without --only"

aside() { # moves a folder out of the way (never deletes it): aside DIR
  if [ -e "$1" ]; then
    mkdir -p "$BUILD/old"
    mv "$1" "$BUILD/old/$(basename "$1").$(date +%Y%m%d%H%M%S)"
  fi
}
STAGEDIR="$BUILD/assemble"
aside "$STAGEDIR"
mkdir -p "$STAGEDIR/core/bin" "$STAGEDIR/core/lib" "$STAGEDIR/ui"
cp "$OUTGO/bin/ollama" "$OUTGO/bin/vmapp-ui" "$STAGEDIR/core/bin/"
cp -R "$OUTRUN/lib/ollama" "$STAGEDIR/core/lib/ollama"
cp "$OUTGO/lib/ollama/GO_LICENSE" "$STAGEDIR/core/lib/ollama/GO_LICENSE"
git -C "$SRC" show "$OLLAMA_TAG_COMMIT:LICENSE" >"$STAGEDIR/core/bin/LICENSE.ollama"
chmod 755 "$STAGEDIR/core/bin/ollama" "$STAGEDIR/core/bin/vmapp-ui" "$STAGEDIR/core/lib/ollama/llama-server"
cp "$VMAPP/sdk/node/http-bridge.js" "$STAGEDIR/core/http-bridge.js"

VULKAN_INFO="not bundled (the app runs on the CPU only)"
if [ -f "$VULKAN_LIB" ]; then
  mkdir -p "$STAGEDIR/core/lib/ollama/vulkan"
  cp "$VULKAN_LIB" "$STAGEDIR/core/lib/ollama/vulkan/libggml-vulkan.so"
  chmod 644 "$STAGEDIR/core/lib/ollama/vulkan/libggml-vulkan.so"
  # the module must find every ggml function it imports in the libggml-base that is built here
  docker run --rm --platform linux/arm64 -v "$STAGEDIR/core/lib/ollama:/l:ro" "$IMAGE" sh -c '
    nm -D --undefined-only /l/vulkan/libggml-vulkan.so | awk "\$2 ~ /^ggml_/ {print \$2}" | sort -u > /tmp/need
    nm -D --defined-only /l/libggml-base.so.0.24.0 | awk "{print \$3}" | sort -u > /tmp/have
    missing=$(comm -23 /tmp/need /tmp/have)
    [ -z "$missing" ] || { echo "libggml-vulkan.so needs ggml symbols that libggml-base.so.0.24.0 lacks: $missing" >&2; exit 1; }
    echo "all $(wc -l < /tmp/need | tr -d " ") ggml symbols that libggml-vulkan.so imports are defined by this build of libggml-base.so.0.24.0"' >"$BUILD/logs/vulkan-check.log" 2>&1 \
    || { cat "$BUILD/logs/vulkan-check.log"; die "the Vulkan library does not fit this build of ggml"; }
  VULKAN_INFO="$(basename "$VULKAN_LIB") sha256 $(sha256_of "$VULKAN_LIB"); $(tail -n 1 "$BUILD/logs/vulkan-check.log")"
else
  echo "   (no Vulkan library at $VULKAN_LIB: pass --vulkan-lib FILE; the app is built without the GPU backend)"
fi

cp -R "$OUTUI/." "$STAGEDIR/ui/"
cp "$VMAPP/sdk/web/vmapp-fetch.js" "$STAGEDIR/ui/vmapp-fetch.js"
cp "$HERE/shim/ollama-desktop-shim.js" "$STAGEDIR/ui/ollama-desktop-shim.js"
cp "$BUILD/out-ui/THIRD-PARTY-LICENSES.txt" "$STAGEDIR/ui/THIRD-PARTY-LICENSES.txt"
cp "$STAGEDIR/core/bin/LICENSE.ollama" "$STAGEDIR/ui/LICENSE.ollama"
node "$HERE/build/check-ui.mjs" "$STAGEDIR/ui" || die "the UI does not meet the Content-Security-Policy (see above)"

{
  echo "ollama $OLLAMA_VERSION (tag $OLLAMA_TAG, commit $OLLAMA_TAG_COMMIT), built from source for linux-arm64"
  echo "patches: $(for p in "${PATCHES[@]}"; do printf '%s %s; ' "$(basename "$p")" "$(sha256_of "$p" | cut -c1-12)"; done)"
  echo "backend/vmapp-ui/main.go sha256 $(sha256_of "$HERE/backend/vmapp-ui/main.go")"
  echo "llama.cpp $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT) via Ollama's llama/server CMake, preset cpu"
  echo "toolchain: golang@$GOLANG_IMAGE_DIGEST, Debian snapshot $APT_SNAPSHOT, cmake $APT_CMAKE, ninja $APT_NINJA_BUILD"
  echo "ui: Ollama's app/ui/app at the same commit, npm ci with its package-lock.json, node image $NODE_BASE"
  echo "vulkan backend: $VULKAN_INFO"
  echo "ollama sha256 $(sha256_of "$STAGEDIR/core/bin/ollama"); vmapp-ui sha256 $(sha256_of "$STAGEDIR/core/bin/vmapp-ui"); llama-server sha256 $(sha256_of "$STAGEDIR/core/lib/ollama/llama-server")"
  echo "--- go stage"; cat "$OUTGO/go-stage.txt"
  echo "--- runner stage"; cat "$OUTRUN/runner-stage.txt"
} >"$STAGEDIR/core/bin/BUILD-INFO.txt"

# core/main.js is source; the generated parts of core/ and the whole ui/ are replaced (the old ones are moved aside)
mkdir -p "$HERE/core"
aside "$HERE/core/bin"
aside "$HERE/core/lib"
aside "$HERE/ui"
mv "$STAGEDIR/core/bin" "$HERE/core/bin"
mv "$STAGEDIR/core/lib" "$HERE/core/lib"
mv "$STAGEDIR/core/http-bridge.js" "$HERE/core/http-bridge.js"
mv "$STAGEDIR/ui" "$HERE/ui"

echo
echo "done. core/: $(du -sk "$HERE/core" | awk '{print int($1 / 1024)}') MiB, ui/: $(du -sk "$HERE/ui" | awk '{print int($1 / 1024)}') MiB, $(find "$HERE/ui" -type f | wc -l | tr -d ' ') UI files."
echo "Next: tools/vmapp pack apps/ollama-desktop -o ollama-desktop.vmapp"
