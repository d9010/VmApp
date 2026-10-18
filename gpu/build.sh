#!/usr/bin/env bash
# Builds the HOST side of the GPU capability (SPEC 8.6): llama.cpp's RPC server with the Metal backend, from the pinned
# commit in gpu/pins.env, into vmapp/out/gpu/:
#   rpc-server            arm64, Metal + RPC, statically linked ggml, ad-hoc signed (the loader re-signs it when packaging)
#   rpc-server.sb         the sandbox profile it runs under (a copy of gpu/rpc-server.sb, so out/gpu is self-contained)
#   BUILD-INFO.txt        tag, commit, RPC protocol version, flags, toolchain, sha256 of the binary
#   LICENSE-llama.cpp.txt the upstream licence (MIT)
#
#   gpu/build.sh [--out DIR] [--client] [--force] [--check]
#     --out DIR   output folder (default: vmapp/out/gpu)
#     --client    ALSO build a CPU-only llama.cpp client from the same commit (llama-completion, llama-bench) into
#                 $VMAPP_WORK/gpu-client/bin: what tests/gpu/run.sh connects to the sandboxed server with
#     --force     rebuild even when out/gpu is up to date for gpu/pins.env
#     --check     exit 0 when out/gpu/rpc-server is up to date for the pins, 1 otherwise
#
# Environment:
#   VMAPP_WORK   scratch and cache folder (default: vmapp/out/work, git-ignored). The source is cloned to
#                $VMAPP_WORK/cache/llama.cpp-<tag>/ and the build happens in $VMAPP_WORK/gpu-build/.
#   DEVELOPER_DIR  Xcode to use (default: /Applications/Xcode.app when present)
#
# The source is fetched with `git clone --depth 1 --branch <tag>` and the checkout is REFUSED unless its commit equals
# LLAMA_CPP_COMMIT of the pins (a tag can be moved; a commit hash cannot). The RPC protocol version in the source must
# equal RPC_PROTO_VERSION of the pins.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/.." && pwd)"
PINS_FILE="$HERE/pins.env"
OUT="$VMAPP/out/gpu"
WITH_CLIENT=0
FORCE=0
CHECK=0

log() { printf '\n==> [%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf 'gpu/build.sh: %s\n' "$*" >&2
  exit 1
}
sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a folder"; OUT="$2"; shift ;;
    --client) WITH_CLIENT=1 ;;
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------------------
# pins
# ---------------------------------------------------------------------------------------
PIN_VALUE_RE='^[-A-Za-z0-9 ._:/@=,+%]*$'
PIN_KEYS="LLAMA_CPP_REPO LLAMA_CPP_TAG LLAMA_CPP_COMMIT LLAMA_CPP_TAG_DATE RPC_PROTO_VERSION RPC_SERVER_TARGET RPC_SERVER_NAME MACOS_DEPLOYMENT_TARGET"

load_pins() {
  local line key val seen=" "
  [ -f "$PINS_FILE" ] || die "missing $PINS_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    case "$line" in *=*) ;; *) die "pins.env: not KEY=VALUE: $line" ;; esac
    key=${line%%=*}
    val=${line#*=}
    case " $PIN_KEYS " in *" $key "*) ;; *) die "pins.env: unknown key: $key" ;; esac
    [[ $val =~ $PIN_VALUE_RE ]] || die "pins.env: forbidden character in the value of $key"
    printf -v "$key" '%s' "$val"
    seen="$seen$key "
  done <"$PINS_FILE"
  for key in $PIN_KEYS; do
    case "$seen" in *" $key "*) ;; *) die "pins.env: missing key: $key" ;; esac
  done
  [[ $LLAMA_CPP_REPO =~ ^https://[A-Za-z0-9./_-]+$ ]] || die "pins.env: LLAMA_CPP_REPO must be an https URL"
  [[ $LLAMA_CPP_TAG =~ ^b[0-9]+$ ]] || die "pins.env: LLAMA_CPP_TAG format (b<number>)"
  [[ $LLAMA_CPP_COMMIT =~ ^[0-9a-f]{40}$ ]] || die "pins.env: LLAMA_CPP_COMMIT must be a 40-character commit hash"
  [[ $LLAMA_CPP_TAG_DATE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "pins.env: LLAMA_CPP_TAG_DATE format"
  [[ $RPC_PROTO_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "pins.env: RPC_PROTO_VERSION format"
  [[ $RPC_SERVER_TARGET =~ ^[A-Za-z0-9_-]+$ ]] || die "pins.env: RPC_SERVER_TARGET format"
  [[ $RPC_SERVER_NAME =~ ^[A-Za-z0-9_-]+$ ]] || die "pins.env: RPC_SERVER_NAME format"
  [[ $MACOS_DEPLOYMENT_TARGET =~ ^[0-9]+\.[0-9]+$ ]] || die "pins.env: MACOS_DEPLOYMENT_TARGET format"
}
load_pins

WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
SRC="$WORK/cache/llama.cpp-$LLAMA_CPP_TAG"
BUILD="$WORK/gpu-build/server"
CLIENT_BUILD="$WORK/gpu-build/client"
CLIENT_BIN="$WORK/gpu-client/bin"

# Everything the output bytes depend on, as one hash (recorded in BUILD-INFO.txt, compared by --check).
inputs_hash() {
  { cat "$PINS_FILE" "$HERE/build.sh" "$HERE/rpc-server.sb"; } | shasum -a 256 | awk '{ print $1 }'
}

stamp_value() { [ -f "$OUT/BUILD-INFO.txt" ] && sed -n "s/^inputs: //p" "$OUT/BUILD-INFO.txt" | head -1 || true; }

if [ "$CHECK" = "1" ]; then
  if [ -x "$OUT/$RPC_SERVER_NAME" ] && [ "$(stamp_value)" = "$(inputs_hash)" ]; then
    echo "up to date ($LLAMA_CPP_TAG, $(stamp_value | cut -c1-12))"
    exit 0
  fi
  echo "out/gpu is missing or out of date for gpu/"
  exit 1
fi

[ "$(uname -s)" = "Darwin" ] || die "this builds the macOS Metal server; it needs macOS on Apple silicon"
[ "$(uname -m)" = "arm64" ] || die "this builds for Apple silicon (arm64); this machine is $(uname -m)"
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
for t in git cmake codesign xcrun shasum; do
  command -v "$t" >/dev/null 2>&1 || die "$t not found"
done
xcrun --find clang >/dev/null 2>&1 || die "clang not found (install Xcode or the command-line tools: xcode-select --install)"
xcrun --find metal >/dev/null 2>&1 || info "note: the Metal shader compiler (xcrun metal) was not found; the shaders are embedded as source and compiled by macOS when the server starts"

# ---------------------------------------------------------------------------------------
# source: shallow clone at the tag, verified against the pinned commit
# ---------------------------------------------------------------------------------------
log "source $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT)"
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$WORK/cache"
  git clone --quiet --depth 1 --branch "$LLAMA_CPP_TAG" -c advice.detachedHead=false "$LLAMA_CPP_REPO" "$SRC.partial.$$" ||
    die "git clone failed ($LLAMA_CPP_REPO at $LLAMA_CPP_TAG)"
  mv "$SRC.partial.$$" "$SRC"
fi
HEAD_SHA="$(git -C "$SRC" rev-parse HEAD)"
[ "$HEAD_SHA" = "$LLAMA_CPP_COMMIT" ] ||
  die "the checkout in $SRC is at $HEAD_SHA, not the pinned $LLAMA_CPP_COMMIT. If the tag $LLAMA_CPP_TAG was moved upstream, that is a supply-chain red flag: do NOT update the pin without a look. To start over, remove $SRC yourself and rerun."
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  die "the checkout in $SRC has local changes; remove it yourself and rerun"
fi
info "commit $HEAD_SHA ($(git -C "$SRC" log -1 --format=%cs))"

# The RPC protocol version of that source must be the one the pins promise (apps build their client against it).
proto_of() { sed -n "s/^#define RPC_PROTO_$1_VERSION[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$SRC/ggml/include/ggml-rpc.h" | head -1; }
PROTO="$(proto_of MAJOR).$(proto_of MINOR).$(proto_of PATCH)"
[ "$PROTO" = "$RPC_PROTO_VERSION" ] || die "the source speaks RPC protocol $PROTO but gpu/pins.env says $RPC_PROTO_VERSION"
info "RPC protocol $PROTO"

if [ "$FORCE" != "1" ] && [ "$WITH_CLIENT" != "1" ] && [ -x "$OUT/$RPC_SERVER_NAME" ] && [ "$(stamp_value)" = "$(inputs_hash)" ]; then
  log "out/gpu is up to date (use --force to rebuild)"
  exit 0
fi

NCPU="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
COMMON_FLAGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_ARCHITECTURES=arm64
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=$MACOS_DEPLOYMENT_TARGET"
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF
  -DGGML_RPC=ON
  -DGGML_RPC_RDMA=OFF
  -DLLAMA_CURL=OFF
  -DLLAMA_OPENSSL=OFF
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_BUILD_SERVER=OFF
  -DLLAMA_BUILD_APP=OFF
  -DLLAMA_BUILD_TOOLS=ON
  -DLLAMA_BUILD_UI=OFF
)
SERVER_FLAGS=("${COMMON_FLAGS[@]}" -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)

# ---------------------------------------------------------------------------------------
# build the server
# ---------------------------------------------------------------------------------------
log "configure the server (Metal + RPC, arm64, macOS >= $MACOS_DEPLOYMENT_TARGET)"
cmake -S "$SRC" -B "$BUILD" "${SERVER_FLAGS[@]}" >"$WORK/gpu-build-server-configure.log" 2>&1 ||
  { tail -30 "$WORK/gpu-build-server-configure.log" >&2; die "cmake configure failed (log: $WORK/gpu-build-server-configure.log)"; }
log "build $RPC_SERVER_TARGET (-j$NCPU)"
cmake --build "$BUILD" --config Release --target "$RPC_SERVER_TARGET" -j "$NCPU" >"$WORK/gpu-build-server.log" 2>&1 ||
  { tail -40 "$WORK/gpu-build-server.log" >&2; die "build failed (log: $WORK/gpu-build-server.log)"; }

BIN="$(find "$BUILD" -type f -name "$RPC_SERVER_TARGET" -perm -u+x | head -1)"
[ -n "$BIN" ] && [ -f "$BIN" ] || die "the build produced no $RPC_SERVER_TARGET"
file "$BIN" | grep -q "arm64" || die "$BIN is not an arm64 executable"

# ---------------------------------------------------------------------------------------
# install into OUT
# ---------------------------------------------------------------------------------------
log "install into $OUT"
mkdir -p "$OUT"
cat "$BIN" >"$OUT/$RPC_SERVER_NAME.tmp.$$"
chmod 755 "$OUT/$RPC_SERVER_NAME.tmp.$$"
mv -f "$OUT/$RPC_SERVER_NAME.tmp.$$" "$OUT/$RPC_SERVER_NAME"
strip -x "$OUT/$RPC_SERVER_NAME"
# Ad hoc signature (the arm64 kernel will not run an unsigned binary). The loader's packaging re-signs it with its own
# identity and the hardened runtime; the identifier stays the same.
codesign --force --sign - --identifier com.vmapp.rpc-server "$OUT/$RPC_SERVER_NAME"
codesign --verify --strict "$OUT/$RPC_SERVER_NAME"
cat "$HERE/rpc-server.sb" >"$OUT/rpc-server.sb.tmp.$$"
mv -f "$OUT/rpc-server.sb.tmp.$$" "$OUT/rpc-server.sb"
cat "$SRC/LICENSE" >"$OUT/LICENSE-llama.cpp.txt"

# Third-party code inside the binary: ggml and the RPC backend are all MIT, from the same tree (see the licence above).
LINKED="$(otool -L "$OUT/$RPC_SERVER_NAME" | tail -n +2 | awk '{ print $1 }' | tr '\n' ' ')"
{
  echo "D9010 VmApp GPU capability: host RPC server (SPEC 8.6)"
  echo "built: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "llama.cpp tag: $LLAMA_CPP_TAG ($LLAMA_CPP_TAG_DATE)"
  echo "llama.cpp commit: $LLAMA_CPP_COMMIT"
  echo "repository: $LLAMA_CPP_REPO"
  echo "RPC protocol: $RPC_PROTO_VERSION (ggml-rpc.h: RPC_PROTO_{MAJOR,MINOR,PATCH}_VERSION)"
  echo "cmake target: $RPC_SERVER_TARGET -> $RPC_SERVER_NAME"
  echo "cmake flags: ${SERVER_FLAGS[*]}"
  echo "cmake: $(cmake --version | head -1)"
  echo "compiler: $(xcrun clang --version | head -1)"
  echo "sdk: $(xcrun --show-sdk-path)"
  echo "host: $(sw_vers -productName) $(sw_vers -productVersion) $(uname -m)"
  echo "linked libraries: $LINKED"
  echo "binary sha256: $(sha256_of "$OUT/$RPC_SERVER_NAME")"
  echo "binary size: $(wc -c <"$OUT/$RPC_SERVER_NAME" | tr -d ' ')"
  echo "licence: MIT (LICENSE-llama.cpp.txt)"
  echo "inputs: $(inputs_hash)"
} >"$OUT/BUILD-INFO.txt.tmp.$$"
mv -f "$OUT/BUILD-INFO.txt.tmp.$$" "$OUT/BUILD-INFO.txt"
info "$(wc -c <"$OUT/$RPC_SERVER_NAME" | tr -d ' ') bytes, sha256 $(sha256_of "$OUT/$RPC_SERVER_NAME" | cut -c1-16)"

# ---------------------------------------------------------------------------------------
# optional: a CPU-only client from the same commit, for tests/gpu/host-rpc.sh
# ---------------------------------------------------------------------------------------
if [ "$WITH_CLIENT" = "1" ]; then
  log "configure the test client (CPU only, RPC client; same commit)"
  cmake -S "$SRC" -B "$CLIENT_BUILD" "${COMMON_FLAGS[@]}" -DGGML_METAL=OFF >"$WORK/gpu-build-client-configure.log" 2>&1 ||
    { tail -30 "$WORK/gpu-build-client-configure.log" >&2; die "client configure failed (log: $WORK/gpu-build-client-configure.log)"; }
  log "build llama-completion and llama-bench (-j$NCPU)"
  cmake --build "$CLIENT_BUILD" --config Release --target llama-completion llama-bench -j "$NCPU" >"$WORK/gpu-build-client.log" 2>&1 ||
    { tail -40 "$WORK/gpu-build-client.log" >&2; die "client build failed (log: $WORK/gpu-build-client.log)"; }
  mkdir -p "$CLIENT_BIN"
  for t in llama-completion llama-bench; do
    f="$(find "$CLIENT_BUILD" -type f -name "$t" -perm -u+x | head -1)"
    [ -n "$f" ] || die "the client build produced no $t"
    cat "$f" >"$CLIENT_BIN/$t.tmp.$$"
    chmod 755 "$CLIENT_BIN/$t.tmp.$$"
    mv -f "$CLIENT_BIN/$t.tmp.$$" "$CLIENT_BIN/$t"
    codesign --force --sign - "$CLIENT_BIN/$t"
  done
  info "client binaries in $CLIENT_BIN"
fi

log "done: $OUT/$RPC_SERVER_NAME"
