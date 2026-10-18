#!/usr/bin/env bash
# Builds everything the Ollama app needs that is not source: Ollama's own release binary for linux-arm64 (the VM).
#
#   core/bin/ollama              the Go program (`ollama serve` is the server; the same file is the CLI)
#   core/lib/ollama/             its libraries, as the release lays them out: libggml-base, libggml, libllama*, llama-server (the helper
#                                that runs a model), the CPU backend in eight CPU-feature variants (the best one for the CPU is
#                                picked at run time), the licences of the bundled third-party code; and, if the release ships it,
#                                the Vulkan backend (lib/ollama/vulkan). The CUDA directories (3 GB, NVIDIA only) are NOT kept.
#   core/bin/LICENSE.ollama      Ollama's MIT licence (the tarball carries only the third-party ones)
#   core/bin/BUILD-INFO.txt      what was unpacked from what, and which backends the release contains
#
# Nothing is compiled. The release asset (ollama-linux-arm64.tar.zst, 1.5 GB) is downloaded once into
# $VMAPP_WORK/cache/ollama/<tag>/, and its SHA-256 must equal BOTH the value in the release's own sha256sum.txt AND the value pinned
# in pins.env. It links only against glibc (<= 2.36), libstdc++, libgcc_s and libm, so it runs in the node22 runtime (Debian bookworm);
# the smoke test at the end proves that in a container of the runtime's own base image.
#
# Needs: curl, tar, zstd (`brew install zstd`), shasum or sha256sum; Docker only for the smoke test (skipped with --no-smoke).
#   --force        unpack again even if core/ already holds this version (the old tree is moved aside, never deleted)
#   --no-smoke     do not run the smoke test in the node22 runtime's base image
#   --with-vulkan  then (EXPERIMENTAL, SPEC 8.7; needs Docker) build Ollama's Vulkan backend, which the arm64 release does not ship,
#                  and assemble the Ollama (GPU) app apps/ollama-gpu from this app's core and ui plus that library:
#                  vulkan/build-vulkan.sh (read its header; call it directly for its options). The plain app is not changed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
PINS="$HERE/pins.env"
CORE="$HERE/core"

die() { echo "ollama/build.sh: $*" >&2; exit 1; }

FORCE=0
SMOKE=1
WITH_VULKAN=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --no-smoke) SMOKE=0 ;;
    --with-vulkan) WITH_VULKAN=1 ;;
    *) die "unknown argument: $a" ;;
  esac
done
run_vulkan() { # the opt-in step: Ollama's Vulkan backend and apps/ollama-gpu
  [ "$WITH_VULKAN" -eq 1 ] || return 0
  echo
  echo "== Vulkan backend and the Ollama (GPU) app (apps/ollama/vulkan/build-vulkan.sh)"
  bash "$HERE/vulkan/build-vulkan.sh"
}

for tool in curl tar zstd; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found (needed to download and unpack the release; zstd: brew install zstd)"
done
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
check_pins_syntax "$PINS"
OLLAMA_VERSION="$(parse_pin "$PINS" OLLAMA_VERSION)"
OLLAMA_TAG="$(parse_pin "$PINS" OLLAMA_TAG)"
OLLAMA_TAG_COMMIT="$(parse_pin "$PINS" OLLAMA_TAG_COMMIT)"
OLLAMA_ASSET="$(parse_pin "$PINS" OLLAMA_ASSET)"
OLLAMA_ASSET_SHA256="$(parse_pin "$PINS" OLLAMA_ASSET_SHA256)"
OLLAMA_LICENSE_SHA256="$(parse_pin "$PINS" OLLAMA_LICENSE_SHA256)"
case "$OLLAMA_VERSION" in *[!0-9.]* | '') die "OLLAMA_VERSION must be digits and dots" ;; esac
[ "$OLLAMA_TAG" = "v$OLLAMA_VERSION" ] || die "OLLAMA_TAG must be v$OLLAMA_VERSION"
case "$OLLAMA_ASSET" in *[!A-Za-z0-9._-]* | '') die "OLLAMA_ASSET must be a plain file name" ;; esac
for h in "$OLLAMA_ASSET_SHA256" "$OLLAMA_LICENSE_SHA256"; do
  case "$h" in *[!0-9a-f]* | '') die "a SHA-256 pin must be lower-case hex" ;; esac
  [ "${#h}" -eq 64 ] || die "a SHA-256 pin must be 64 hex digits"
done

# ---- already built? -------------------------------------------------------------------------------------------------------
STAMP="ollama $OLLAMA_VERSION asset-sha256 $OLLAMA_ASSET_SHA256"
if [ "$FORCE" -eq 0 ] && [ -x "$CORE/bin/ollama" ] && [ -f "$CORE/bin/BUILD-INFO.txt" ] && grep -qxF "$STAMP" "$CORE/bin/BUILD-INFO.txt"; then
  echo "core/ already holds $STAMP (use --force to unpack again)"
  run_vulkan
  exit 0
fi

# ---- download and verify ------------------------------------------------------------------------------------------------
WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
CACHE="$WORK/cache/ollama/$OLLAMA_TAG"
mkdir -p "$CACHE"
BASE="https://github.com/ollama/ollama/releases/download/$OLLAMA_TAG"

echo "== release $OLLAMA_TAG (tag commit $OLLAMA_TAG_COMMIT)"
curl -fsSL --retry 3 -o "$CACHE/sha256sum.txt.tmp" "$BASE/sha256sum.txt" || die "could not download $BASE/sha256sum.txt"
mv -f "$CACHE/sha256sum.txt.tmp" "$CACHE/sha256sum.txt"
PUBLISHED="$(awk -v f="./$OLLAMA_ASSET" '$2 == f {print $1}' "$CACHE/sha256sum.txt")"
[ -n "$PUBLISHED" ] || die "the release's sha256sum.txt does not list $OLLAMA_ASSET"
[ "$PUBLISHED" = "$OLLAMA_ASSET_SHA256" ] || die "the release publishes $PUBLISHED for $OLLAMA_ASSET but pins.env pins $OLLAMA_ASSET_SHA256"

ASSET="$CACHE/$OLLAMA_ASSET"
if [ -f "$ASSET" ] && [ "$(sha256_of "$ASSET")" = "$OLLAMA_ASSET_SHA256" ]; then
  echo "== $OLLAMA_ASSET is in the cache and its SHA-256 matches"
else
  echo "== downloading $OLLAMA_ASSET (about 1.5 GB) into $CACHE"
  curl -fL --retry 3 -C - -o "$ASSET.part" "$BASE/$OLLAMA_ASSET" || die "download failed"
  GOT="$(sha256_of "$ASSET.part")"
  [ "$GOT" = "$OLLAMA_ASSET_SHA256" ] || die "SHA-256 of the download is $GOT, expected $OLLAMA_ASSET_SHA256 (the partial file is left at $ASSET.part)"
  mv -f "$ASSET.part" "$ASSET"
  echo "   SHA-256 verified: $GOT"
fi

LICENSE_FILE="$CACHE/LICENSE"
curl -fsSL --retry 3 -o "$LICENSE_FILE.tmp" "https://raw.githubusercontent.com/ollama/ollama/$OLLAMA_TAG/LICENSE" || die "could not download Ollama's LICENSE"
mv -f "$LICENSE_FILE.tmp" "$LICENSE_FILE"
[ "$(sha256_of "$LICENSE_FILE")" = "$OLLAMA_LICENSE_SHA256" ] || die "LICENSE does not match OLLAMA_LICENSE_SHA256"

# ---- what is in the release ---------------------------------------------------------------------------------------------
LISTING="$CACHE/contents.txt"
zstd -dc "$ASSET" | tar -tf - >"$LISTING.tmp" || die "could not list $ASSET"
mv -f "$LISTING.tmp" "$LISTING"
grep -qx 'bin/ollama' "$LISTING" || die "the release has no bin/ollama"
# Anything but regular-looking relative paths would be a surprise in a release that passed its checksum: refuse it.
if grep -qE '(^/|(^|/)\.\.(/|$))' "$LISTING"; then die "the release lists an absolute or parent path"; fi

cpu_variants="$(sed -n 's#^lib/ollama/libggml-cpu-\(.*\)\.so$#\1#p' "$LISTING" | sort | tr '\n' ' ' | sed 's/ $//')"
gpu_dirs="$(sed -n 's#^lib/ollama/\([a-z0-9_]*\)/$#\1#p' "$LISTING" | sort | tr '\n' ' ' | sed 's/ $//')"
has_vulkan=0
grep -q '^lib/ollama/vulkan/' "$LISTING" && has_vulkan=1
echo "== backends in the release: cpu ($cpu_variants); directories: ${gpu_dirs:-none}; vulkan: $([ "$has_vulkan" = 1 ] && echo shipped || echo "NOT shipped")"

# ---- unpack into a fresh staging folder, then move into core/ -------------------------------------------------------------
mkdir -p "$WORK/ollama"
STAGE="$(mktemp -d "$WORK/ollama/stage.XXXXXX")"
zstd -dc "$ASSET" | tar -xf - -C "$STAGE" --exclude 'lib/ollama/cuda_*' --exclude 'lib/ollama/rocm*' || die "unpacking failed"
[ -f "$STAGE/bin/ollama" ] || die "bin/ollama is missing after unpacking"

# an aarch64 ELF? (bytes 0-3 = 7f 45 4c 46, e_machine at offset 18 = 0xb7)
MAGIC="$(od -An -tx1 -N4 "$STAGE/bin/ollama" | tr -d ' \n')"
MACHINE="$(od -An -tx1 -j18 -N2 "$STAGE/bin/ollama" | tr -d ' \n')"
[ "$MAGIC" = "7f454c46" ] || die "bin/ollama is not an ELF file"
[ "$MACHINE" = "b700" ] || die "bin/ollama is not for aarch64 (e_machine $MACHINE)"
chmod 755 "$STAGE/bin/ollama" "$STAGE/lib/ollama/llama-server" 2>/dev/null || true

# move any earlier unpack aside (renamed, never deleted), then put the new one in place
mkdir -p "$CORE"
ASIDE="$WORK/ollama/old.$(date +%Y%m%d%H%M%S)"
for d in bin lib; do
  if [ -e "$CORE/$d" ]; then
    mkdir -p "$ASIDE"
    mv "$CORE/$d" "$ASIDE/$d"
  fi
done
mv "$STAGE/bin" "$CORE/bin"
mv "$STAGE/lib" "$CORE/lib"
cp "$LICENSE_FILE" "$CORE/bin/LICENSE.ollama"
rmdir "$STAGE" 2>/dev/null || true

{
  echo "$STAMP"
  echo "source https://github.com/ollama/ollama/releases/tag/$OLLAMA_TAG (tag commit $OLLAMA_TAG_COMMIT)"
  echo "asset $OLLAMA_ASSET, verified against the release's sha256sum.txt and the pin in pins.env"
  echo "backends in the release asset: cpu ($cpu_variants); other directories: ${gpu_dirs:-none}"
  echo "vulkan backend (lib/ollama/vulkan): $([ "$has_vulkan" = 1 ] && echo 'shipped and kept' || echo 'NOT shipped in the linux-arm64 release')"
  echo "kept: bin/ollama, lib/ollama (cpu variants, libggml*, libllama*, llama-server, licences)"
  echo "dropped: lib/ollama/cuda_* (NVIDIA only)"
  echo "ollama licence: MIT (LICENSE.ollama); third-party licences are in lib/ollama/*LICENSE*"
} >"$CORE/bin/BUILD-INFO.txt"
echo "unpacked: core/bin/ollama ($(wc -c <"$CORE/bin/ollama" | tr -d ' ') bytes), core/lib/ollama ($(du -sk "$CORE/lib/ollama" | awk '{print $1}') KiB)"

# ---- smoke test in the node22 runtime's base image (the same glibc as the VM) ---------------------------------------------------
if [ "$SMOKE" -eq 1 ]; then
  NODE_BASE="$(sed -n 's/^FROM \(node@sha256:[0-9a-f]*\).*/\1/p' "$VMAPP/runtimes/node22/Dockerfile" | head -n 1)"
  if [ -n "$NODE_BASE" ] && command -v docker >/dev/null 2>&1; then
    echo "== smoke test in the node22 runtime's base image ($NODE_BASE)"
    OUT="$(docker run --rm --platform linux/arm64 -v "$CORE":/x:ro "$NODE_BASE" sh -c '
      ldd --version | head -n 1
      missing=$(for f in /x/bin/ollama /x/lib/ollama/*.so*; do ldd "$f" 2>&1 | grep "not found"; done)
      if [ -n "$missing" ]; then echo "MISSING LIBRARIES:"; echo "$missing"; exit 3; fi
      echo "all libraries resolve"
      /x/bin/ollama --version 2>&1 | head -n 2
      /x/lib/ollama/llama-server --version 2>&1 | grep -E "^(version|built)" ' 2>&1)" || { echo "$OUT" | sed 's/^/   /'; die "the smoke test failed"; }
    echo "$OUT" | sed 's/^/   /'
  else
    echo "(skipping the smoke test: Docker or the node22 base image digest is not available)"
  fi
fi

run_vulkan

echo
echo "done. Next: vmapp/tools/vmapp pack vmapp/apps/ollama -o ollama.vmapp"
