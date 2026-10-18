#!/usr/bin/env bash
# Builds the vmapp guest kernel from the pinned, verified Linux source in a digest-pinned Docker container.
#
#   kernel/build.sh                  build out/Image if it is missing or out of date (needs Docker)
#   kernel/build.sh --force          rebuild (Docker layer cache allowed)
#   kernel/build.sh --no-cache       rebuild from scratch (no Docker layer cache; the host download cache stays)
#   kernel/build.sh --config-only    only merge the config and run the required/forbidden check (fast)
#   kernel/build.sh --check          exit 0 if out/Image is up to date for kernel/ (pins, config, lists, scripts)
#   kernel/build.sh --check-pins     validate kernel/pins.env and that kernel/Dockerfile repeats the same base image
#   kernel/build.sh --from IMAGE     install a prebuilt Image instead of building (a release, another checkout);
#                                    it is trusted as is and recorded as "prebuilt"
#   --flavour NAME                   which kernel (default: "default", the one every app VM boots under
#                                    Virtualization.framework). Any other name is a folder kernel/flavours/NAME/ (see
#                                    its README.md); every command above works per flavour, and each flavour has its
#                                    own outputs, stamp and scratch folder. Currently: gpu (experimental).
#   --out DIR                        output folder (default: vmapp/out)
#   --verbose                        stream the Docker log (default: write it to $VMAPP_WORK/kernel/logs/)
#
# Outputs, in OUT (default vmapp/out). A flavour other than "default" adds -NAME to every name (Image-gpu, ...):
#   Image                        the uncompressed arm64 kernel (what VZLinuxBootLoader boots)
#   kernel.config                the final .config
#   kernel.release               e.g. 6.18.56-vmapp
#   kernel-info/                 source verification evidence, kconfig check report, BUILD-INFO.txt,
#                                SOURCE-OFFER.md (GPL), licenses/linux/ (COPYING, LICENSES/), inputs.stamp; for a
#                                flavour also the effective config fragment and lists and the applied patches
#
# Environment:
#   VMAPP_WORK   scratch and cache folder (default: vmapp/out/work, git-ignored). The kernel tarball, its
#                signatures and the signing keys are cached in $VMAPP_WORK/cache/kernel/ (verified in the build
#                container on every build, so a tampered cache cannot produce a kernel).
#
# Reproducible: the base image is pinned by digest, apt reads a dated Ubuntu snapshot, the source tarball is
# checked against its pinned sha256 and kernel.org's PGP signatures, and the build identity and timestamp are fixed
# (kernel/pins.env). The same inputs give the same Image bytes. The same holds per flavour, whose own inputs
# (overlay config, list additions, patches) are part of that flavour's up-to-date stamp.
#
# Adapted from d9010-native/tools/build-rootfs/build.sh (kernel part).
set -euo pipefail

KDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$KDIR/.." && pwd)"
OUT="$VMAPP/out"
WORK="${VMAPP_WORK:-$VMAPP/out/work}"
PINS_FILE="$KDIR/pins.env"
DOCKERFILE="$KDIR/Dockerfile"

# Which kernel: "default" or a folder kernel/flavours/NAME/ (set up by setup_flavour once the arguments are parsed).
FLAVOUR=default
FDIR=""            # kernel/flavours/NAME ("" for the default flavour)
SUF=""             # "" or -NAME: added to every output name
KWORK=""           # scratch folder of this flavour: $WORK/kernel or $WORK/kernel-NAME
IMAGE="Image"      # output names in OUT
CONFIG_NAME="kernel.config"
RELEASE_NAME="kernel.release"
INFO_NAME="kernel-info"

# ---------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------
log() { printf '\n==> [%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'kernel/build.sh: %s\n' "$*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}
size_of() { wc -c <"$1" | tr -d ' '; }

# Copy file CONTENT only (no xattrs, resource forks or ACLs from macOS), atomically.
install_file() {
  mkdir -p "$(dirname "$2")"
  cat "$1" >"$2.tmp.$$"
  mv -f "$2.tmp.$$" "$2"
}

# Empty a folder that lives under $WORK or $OUT (refuses anything else, and symlinks).
clear_dir() {
  local d=$1
  case "$d" in
    "$WORK"/* | "$OUT"/*) ;;
    *) die "refusing to clear $d (not under $WORK or $OUT)" ;;
  esac
  [ ! -L "$d" ] || die "refusing to clear a symlink: $d"
  if [ -d "$d" ]; then
    find "$d" -mindepth 1 -delete
  else
    mkdir -p "$d"
  fi
}

# ---------------------------------------------------------------------------------------
# pins
# ---------------------------------------------------------------------------------------
PIN_VALUE_RE='^[-A-Za-z0-9 ._:/@=,+%]*$'
PIN_KEYS="UBUNTU_IMAGE UBUNTU_DIGEST UBUNTU_SNAPSHOT KERNEL_VERSION KERNEL_URL_BASE KERNEL_SHA256 KERNEL_LOCALVERSION KERNEL_FPR_AUTOSIGNER KERNEL_FPR_GREGKH KERNEL_FPR_TORVALDS KBUILD_BUILD_USER KBUILD_BUILD_HOST SOURCE_DATE_EPOCH"

load_pins() {
  local line key val seen=" "
  [ -f "$PINS_FILE" ] || die "missing $PINS_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    case "$line" in *=*) ;; *) die "pins.env: not KEY=VALUE: $line" ;; esac
    key=${line%%=*}
    val=${line#*=}
    case " $PIN_KEYS " in *" $key "*) ;; *) die "pins.env: unknown key: $key" ;; esac
    [[ $val =~ $PIN_VALUE_RE ]] || die "pins.env: forbidden character in the value of $key (allowed: letters, digits, space and . _ : / @ = , + % -)"
    printf -v "$key" '%s' "$val"
    seen="$seen$key "
  done <"$PINS_FILE"
  for key in $PIN_KEYS; do
    case "$seen" in *" $key "*) ;; *) die "pins.env: missing key: $key" ;; esac
  done
  [[ $UBUNTU_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "pins.env: UBUNTU_DIGEST is not a sha256 digest"
  [[ $UBUNTU_SNAPSHOT =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "pins.env: UBUNTU_SNAPSHOT format"
  [[ $KERNEL_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "pins.env: KERNEL_VERSION format"
  [[ $KERNEL_URL_BASE =~ ^https://[A-Za-z0-9./_-]+$ ]] || die "pins.env: KERNEL_URL_BASE must be an https URL"
  [[ $KERNEL_SHA256 =~ ^[0-9a-f]{64}$ ]] || die "pins.env: KERNEL_SHA256 format"
  [[ $KERNEL_FPR_AUTOSIGNER =~ ^[0-9A-F]{40}$ ]] || die "pins.env: KERNEL_FPR_AUTOSIGNER format"
  [[ $KERNEL_FPR_GREGKH =~ ^[0-9A-F]{40}$ ]] || die "pins.env: KERNEL_FPR_GREGKH format"
  [[ $KERNEL_FPR_TORVALDS =~ ^[0-9A-F]{40}$ ]] || die "pins.env: KERNEL_FPR_TORVALDS format"
  [[ $SOURCE_DATE_EPOCH =~ ^[0-9]+$ ]] || die "pins.env: SOURCE_DATE_EPOCH format"
  UBUNTU_REF="$UBUNTU_IMAGE@$UBUNTU_DIGEST"
}

# The Dockerfile repeats the base image reference literally in its first FROM line.
check_pins() {
  load_pins
  local want="FROM $UBUNTU_REF AS kernel-toolchain"
  grep -qxF "$want" "$DOCKERFILE" || die "kernel/Dockerfile does not contain the line '$want' (it must repeat UBUNTU_IMAGE@UBUNTU_DIGEST of pins.env)"
  [ -f "$KDIR/vmapp-guest.config" ] || die "missing kernel/vmapp-guest.config"
  [ -f "$KDIR/kconfig-required.txt" ] || die "missing kernel/kconfig-required.txt"
  [ -f "$KDIR/kconfig-forbidden.txt" ] || die "missing kernel/kconfig-forbidden.txt"
  check_flavour
}

# ---------------------------------------------------------------------------------------
# flavours (kernel/flavours/NAME/): a second kernel built from the same pinned source, container and common config
# ---------------------------------------------------------------------------------------
# The flavour folder holds exactly these inputs (all but the overlay are optional):
#   overlay.config         appended to kernel/vmapp-guest.config (later lines win)
#   kconfig-required.txt   appended to the common kconfig-required.txt (more required options)
#   kconfig-forbidden.txt  appended to the common kconfig-forbidden.txt: "!NAME" exemptions (each with a reason) and/or
#                          extra forbidden patterns. This is the ONLY way a flavour relaxes the common list.
#   patches/NNNN-*.patch   applied in name order to the verified source (patch -p1 --fuzz=0) before configuring
# README.md and anything else in the folder is documentation, not a build input.

setup_flavour() {
  case "$FLAVOUR" in
    default)
      FDIR=""
      SUF=""
      ;;
    *)
      [[ $FLAVOUR =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] || die "bad flavour name '$FLAVOUR' (lower case letters, digits and -)"
      FDIR="$KDIR/flavours/$FLAVOUR"
      [ -d "$FDIR" ] || die "unknown flavour '$FLAVOUR' (there is no kernel/flavours/$FLAVOUR/)"
      SUF="-$FLAVOUR"
      ;;
  esac
  KWORK="$WORK/kernel$SUF"
  IMAGE="Image$SUF"
  CONFIG_NAME="kernel$SUF.config"
  RELEASE_NAME="kernel$SUF.release"
  INFO_NAME="kernel-info$SUF"
}

# The build inputs of the flavour, relative to its folder, one per line, in a fixed order (empty for "default").
flavour_input_files() {
  [ -n "$FDIR" ] || return 0
  local f
  (
    cd "$FDIR"
    for f in overlay.config kconfig-required.txt kconfig-forbidden.txt; do
      if [ -f "$f" ]; then echo "$f"; fi
    done
    export LC_ALL=C
    for f in patches/*.patch; do
      if [ -f "$f" ]; then echo "$f"; fi
    done
  )
}

check_flavour() {
  [ -n "$FDIR" ] || return 0
  local f p
  [ -f "$FDIR/overlay.config" ] || die "flavour '$FLAVOUR': missing kernel/flavours/$FLAVOUR/overlay.config"
  if [ -d "$FDIR/patches" ]; then
    for p in "$FDIR"/patches/*; do
      [ -e "$p" ] || continue
      f="$(basename "$p")"
      [[ $f =~ ^[0-9]{4}-[A-Za-z0-9._+-]+\.patch$ ]] || die "flavour '$FLAVOUR': patches/$f is not named NNNN-name.patch"
      [ -f "$p" ] && [ ! -L "$p" ] || die "flavour '$FLAVOUR': patches/$f is not a regular file"
    done
  fi
}

# Everything the kernel bytes depend on, as one hash (the "inputs" in out/kernel-info/inputs.stamp). For the default
# flavour it covers exactly the common inputs; a flavour adds its own files.
inputs_hash() {
  (
    cd "$KDIR"
    for f in pins.env Dockerfile vmapp-guest.config kconfig-required.txt kconfig-forbidden.txt check-kconfig.sh container/*.sh; do
      printf '%s  %s\n' "$(sha256_of "$f")" "$f"
    done
    if [ -n "$FDIR" ]; then
      for f in $(flavour_input_files); do
        printf '%s  %s\n' "$(sha256_of "$FDIR/$f")" "flavours/$FLAVOUR/$f"
      done
    fi
  ) | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | awk '{ print $1 }'
}

stamp_value() { # stamp_value KEY -> value from out/kernel-info/inputs.stamp (kernel-info-NAME for a flavour)
  [ -f "$OUT/$INFO_NAME/inputs.stamp" ] || return 0
  sed -n "s/^$1=//p" "$OUT/$INFO_NAME/inputs.stamp" | head -1
}

# 0 = out/Image is up to date (and says why on stdout), 1 = it is not.
cmd_check() {
  check_pins
  if [ ! -s "$OUT/$IMAGE" ]; then
    echo "no $OUT/$IMAGE"
    return 1
  fi
  local have kind
  have="$(sha256_of "$OUT/$IMAGE")"
  kind="$(stamp_value kind)"
  if [ -z "$kind" ]; then
    echo "$OUT/$IMAGE has no $INFO_NAME/inputs.stamp (unknown origin)"
    return 1
  fi
  if [ "$(stamp_value image)" != "$have" ]; then
    echo "$OUT/$IMAGE changed since it was stamped"
    return 1
  fi
  case "$kind" in
    built)
      if [ "$(stamp_value inputs)" != "$(inputs_hash)" ]; then
        echo "kernel/ changed since $OUT/$IMAGE was built (pins, config, lists, patches or scripts)"
        return 1
      fi
      echo "up to date (built from kernel/ inputs $(stamp_value inputs | cut -c1-12), release $(cat "$OUT/$RELEASE_NAME" 2>/dev/null || echo '?'))"
      ;;
    prebuilt)
      echo "prebuilt Image installed with --from (not built from kernel/ here; sha256 $(echo "$have" | cut -c1-12))"
      ;;
    *)
      echo "unknown stamp kind '$kind'"
      return 1
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------------------
# download cache (the build container verifies everything again)
# ---------------------------------------------------------------------------------------
CACHE="$WORK/cache/kernel"

fetch_cached() { # fetch_cached NAME
  local name=$1
  if [ -s "$CACHE/$name" ]; then
    return 0
  fi
  mkdir -p "$CACHE"
  info "downloading $name"
  curl -fsSL --retry 5 --retry-delay 3 -o "$CACHE/$name.part.$$" "$KERNEL_URL_BASE/$name" || {
    rm -f "$CACHE/$name.part.$$"
    die "download failed: $KERNEL_URL_BASE/$name"
  }
  mv -f "$CACHE/$name.part.$$" "$CACHE/$name"
}

prepare_downloads() {
  local tb="linux-$KERNEL_VERSION.tar.xz"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  # kernel.org's signed checksum list changes with every release: a cached copy that predates this version is stale.
  if [ -s "$CACHE/sha256sums.asc" ] && ! grep -q "  $tb\$" "$CACHE/sha256sums.asc"; then
    rm -f "$CACHE/sha256sums.asc"
  fi
  fetch_cached "$tb"
  fetch_cached "linux-$KERNEL_VERSION.tar.sign"
  fetch_cached sha256sums.asc
  local got
  got="$(sha256_of "$CACHE/$tb")"
  if [ "$got" != "$KERNEL_SHA256" ]; then
    # A corrupt or substituted cache entry: drop it so the next run downloads again, and stop.
    rm -f "$CACHE/$tb"
    die "$tb in the cache has sha256 $got, pins.env says $KERNEL_SHA256 (cache entry removed; run again)"
  fi
  info "$tb sha256 ok (pinned): $got"
}

# ---------------------------------------------------------------------------------------
# docker
# ---------------------------------------------------------------------------------------
require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is required to build the kernel (it is not needed at run time). Install Docker Desktop (macOS) or Docker Engine, or use: kernel/build.sh --from /path/to/Image"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running (start Docker Desktop), or use: kernel/build.sh --from /path/to/Image"
  docker buildx version >/dev/null 2>&1 || die "docker buildx is required"
  case "$(docker info --format '{{.Architecture}}' 2>/dev/null)" in
    aarch64 | arm64) ;;
    *) warn "the Docker daemon is not arm64: the arm64 kernel will build under emulation, which can take hours" ;;
  esac
}

NO_CACHE=0
VERBOSE=0

# install_composed DEST BASE [EXTRA]: DEST = BASE, and for a flavour with an EXTRA file also a divider line and EXTRA.
# The default flavour has no EXTRA, so DEST is then a plain copy of BASE.
install_composed() {
  local dest=$1 base=$2 extra=${3:-}
  if [ -z "$extra" ] || [ ! -f "$extra" ]; then
    install_file "$base" "$dest"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  {
    cat "$base"
    printf '\n# ---------------------------------------------------------------------------\n'
    printf '# flavour %s: %s\n' "$FLAVOUR" "$(basename "$extra")"
    printf '# ---------------------------------------------------------------------------\n'
    cat "$extra"
  } >"$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
}

stage_ctx() {
  local ctx=$KWORK/ctx f
  clear_dir "$ctx"
  mkdir -p "$ctx/container" "$ctx/dl" "$ctx/patches"
  for f in "$KDIR"/container/*.sh; do
    install_file "$f" "$ctx/container/$(basename "$f")"
  done
  # The three files of the build are the common ones plus (for a flavour) the flavour's additions; the Dockerfile
  # and the container scripts see only the composed result under the usual names.
  install_composed "$ctx/vmapp-guest.config" "$KDIR/vmapp-guest.config" "${FDIR:+$FDIR/overlay.config}"
  install_composed "$ctx/kconfig-required.txt" "$KDIR/kconfig-required.txt" "${FDIR:+$FDIR/kconfig-required.txt}"
  install_composed "$ctx/kconfig-forbidden.txt" "$KDIR/kconfig-forbidden.txt" "${FDIR:+$FDIR/kconfig-forbidden.txt}"
  install_file "$KDIR/check-kconfig.sh" "$ctx/check-kconfig.sh"
  # The flavour's source patches (the folder stays empty for the default flavour).
  if [ -n "$FDIR" ]; then
    for f in "$FDIR"/patches/*.patch; do
      [ -f "$f" ] || continue
      install_file "$f" "$ctx/patches/$(basename "$f")"
    done
  fi
  # The download cache: hard links (fast, no second copy), else copies.
  for f in "$CACHE"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.part.*) continue ;; esac
    ln -f "$f" "$ctx/dl/$(basename "$f")" 2>/dev/null || cp "$f" "$ctx/dl/$(basename "$f")"
  done
  CTX="$ctx"
}

docker_build() { # docker_build TARGET DEST LOGNAME
  local target=$1 dest=$2 name=$3
  local log_file="$KWORK/logs/$name.log"
  local -a args=(buildx build --platform linux/arm64 --provenance=false --sbom=false --progress=plain
    -f "$DOCKERFILE" --target "$target" --output "type=local,dest=$dest"
    --build-arg "UBUNTU_SNAPSHOT=$UBUNTU_SNAPSHOT"
    --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
    --build-arg "KERNEL_VERSION=$KERNEL_VERSION" --build-arg "KERNEL_URL_BASE=$KERNEL_URL_BASE"
    --build-arg "KERNEL_SHA256=$KERNEL_SHA256" --build-arg "KERNEL_FPR_AUTOSIGNER=$KERNEL_FPR_AUTOSIGNER"
    --build-arg "KERNEL_FPR_GREGKH=$KERNEL_FPR_GREGKH" --build-arg "KERNEL_FPR_TORVALDS=$KERNEL_FPR_TORVALDS"
    --build-arg "KBUILD_BUILD_USER=$KBUILD_BUILD_USER" --build-arg "KBUILD_BUILD_HOST=$KBUILD_BUILD_HOST")
  if [ "$NO_CACHE" = "1" ]; then
    args+=(--no-cache)
  fi
  args+=("$CTX")
  mkdir -p "$KWORK/logs"
  info "docker buildx build --target $target; log: $log_file"
  if [ "$VERBOSE" = "1" ]; then
    if ! docker "${args[@]}" 2>&1 | tee "$log_file"; then
      die "docker build failed (log: $log_file)"
    fi
  elif ! docker "${args[@]}" >"$log_file" 2>&1; then
    tail -n 70 "$log_file" >&2
    die "docker build failed (full log: $log_file)"
  fi
}

# ---------------------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------------------
cmd_config_only() {
  check_pins
  require_docker
  prepare_downloads
  local dest=$KWORK/config-out
  log "kernel config only ($FLAVOUR flavour): allnoconfig + fragment + olddefconfig + required/forbidden check"
  stage_ctx
  # First the merged config without the check, so it can be read even when the check fails.
  clear_dir "$dest"
  docker_build kernel-config-raw "$dest" config-raw
  info "merged config: $dest/kernel.config (logs: merge.log, olddefconfig.log)"
  if grep -q 'WARNING' "$dest/olddefconfig.log"; then
    warn "olddefconfig reported unmet dependencies:"
    grep -A3 'WARNING' "$dest/olddefconfig.log" >&2 || true
  fi
  docker_build kernel-config-out "$KWORK/config-checked" config
  cat "$KWORK/config-checked/kconfig-check.txt"
}

cmd_build() {
  check_pins
  require_docker
  prepare_downloads
  local dest=$KWORK/out t0=$SECONDS
  log "kernel $KERNEL_VERSION$KERNEL_LOCALVERSION ($FLAVOUR flavour): verified source, allnoconfig + D9010 VmApp fragment, make Image"
  stage_ctx
  clear_dir "$dest"
  docker_build kernel-out "$dest" kernel
  [ -s "$dest/Image" ] || die "the kernel build produced no Image"

  local info_dir=$OUT/$INFO_NAME f
  mkdir -p "$OUT" "$info_dir"
  install_file "$dest/Image" "$OUT/$IMAGE"
  install_file "$dest/kernel.config" "$OUT/$CONFIG_NAME"
  install_file "$dest/kernel.release" "$OUT/$RELEASE_NAME"
  install_file "$dest/kernel-source-verification.txt" "$info_dir/kernel-source-verification.txt"
  install_file "$dest/kconfig-check.txt" "$info_dir/kconfig-check.txt"
  install_file "$KDIR/SOURCE-OFFER.md" "$info_dir/SOURCE-OFFER.md"
  clear_dir "$info_dir/licenses"
  cp -R "$dest/licenses/linux" "$info_dir/licenses/linux"
  if [ -n "$FDIR" ]; then
    # Evidence of what a flavour changed: the effective fragment and lists the build used, and the patches applied.
    # Together with the pinned source and the build scripts they are the corresponding source (SOURCE-OFFER.md).
    install_file "$KWORK/ctx/vmapp-guest.config" "$info_dir/vmapp-guest.effective.config"
    install_file "$KWORK/ctx/kconfig-required.txt" "$info_dir/kconfig-required.effective.txt"
    install_file "$KWORK/ctx/kconfig-forbidden.txt" "$info_dir/kconfig-forbidden.effective.txt"
    clear_dir "$info_dir/patches"
    for f in "$KWORK"/ctx/patches/*.patch; do
      [ -f "$f" ] || continue
      install_file "$f" "$info_dir/patches/$(basename "$f")"
    done
    if [ -s "$dest/kernel-patches.txt" ]; then
      install_file "$dest/kernel-patches.txt" "$info_dir/kernel-patches.txt"
    else
      rm -f "$info_dir/kernel-patches.txt"
    fi
  fi
  # The verified signing keys join the host cache, so the next build needs no key lookup.
  if [ ! -s "$CACHE/keys.gpg" ] && [ -s "$dest/kernel-keys.gpg" ]; then
    install_file "$dest/kernel-keys.gpg" "$CACHE/keys.gpg"
  fi
  {
    echo "D9010 VmApp guest kernel build"
    [ -z "$FDIR" ] || echo "flavour:          $FLAVOUR (kernel/flavours/$FLAVOUR/)"
    echo "release:          $(cat "$OUT/$RELEASE_NAME")"
    echo "image:            $IMAGE, $(size_of "$OUT/$IMAGE") bytes, sha256 $(sha256_of "$OUT/$IMAGE")"
    echo "config:           $CONFIG_NAME, sha256 $(sha256_of "$OUT/$CONFIG_NAME")"
    echo "source tarball:   $KERNEL_URL_BASE/linux-$KERNEL_VERSION.tar.xz"
    echo "source sha256:    $KERNEL_SHA256 (verified against kernel.org's signed sha256sums.asc)"
    echo "config fragment:  kernel/vmapp-guest.config, sha256 $(sha256_of "$KDIR/vmapp-guest.config")"
    if [ -n "$FDIR" ]; then
      echo "flavour overlay:  kernel/flavours/$FLAVOUR/overlay.config, sha256 $(sha256_of "$FDIR/overlay.config")"
      for f in "$KWORK"/ctx/patches/*.patch; do
        [ -f "$f" ] || continue
        echo "kernel patch:     $(basename "$f"), sha256 $(sha256_of "$f")"
      done
    fi
    echo "build container:  $UBUNTU_REF, apt snapshot $UBUNTU_SNAPSHOT"
    echo "build identity:   $KBUILD_BUILD_USER@$KBUILD_BUILD_HOST, SOURCE_DATE_EPOCH $SOURCE_DATE_EPOCH"
    echo "kernel/ inputs:   $(inputs_hash)"
    echo "build seconds:    $((SECONDS - t0))"
  } >"$info_dir/BUILD-INFO.txt.tmp.$$"
  mv -f "$info_dir/BUILD-INFO.txt.tmp.$$" "$info_dir/BUILD-INFO.txt"
  {
    echo "kind=built"
    echo "inputs=$(inputs_hash)"
    echo "image=$(sha256_of "$OUT/$IMAGE")"
  } >"$info_dir/inputs.stamp.tmp.$$"
  mv -f "$info_dir/inputs.stamp.tmp.$$" "$info_dir/inputs.stamp"

  info "$IMAGE: $(size_of "$OUT/$IMAGE") bytes, sha256 $(sha256_of "$OUT/$IMAGE"), release $(cat "$OUT/$RELEASE_NAME")"
  info "built in $((SECONDS - t0)) s"
  cat "$info_dir/kconfig-check.txt"
}

cmd_from() { # cmd_from IMAGE
  local src=$1
  [ -s "$src" ] || die "--from: not a file: $src"
  check_pins
  # arm64 boot protocol: magic "ARM\x64" at offset 56; never a compressed image.
  [ "$(dd if="$src" bs=1 skip=56 count=4 2>/dev/null)" = "ARMd" ] || die "--from: $src is not an uncompressed arm64 Image (no ARM\\x64 magic at offset 56)"
  local info_dir=$OUT/$INFO_NAME sibling
  mkdir -p "$OUT" "$info_dir"
  if [ "$(cd "$(dirname "$src")" && pwd)/$(basename "$src")" != "$OUT/$IMAGE" ]; then
    install_file "$src" "$OUT/$IMAGE"
  fi
  # kernel.config and kernel.release (kernel-NAME.* for a flavour): take the ones next to the Image, else remove
  # stale ones of another kernel.
  for sibling in "$CONFIG_NAME" "$RELEASE_NAME"; do
    if [ -f "$(dirname "$src")/$sibling" ] && [ "$(cd "$(dirname "$src")" && pwd)/$sibling" != "$OUT/$sibling" ]; then
      install_file "$(dirname "$src")/$sibling" "$OUT/$sibling"
    elif [ ! -f "$(dirname "$src")/$sibling" ]; then
      rm -f "$OUT/$sibling"
    fi
  done
  install_file "$KDIR/SOURCE-OFFER.md" "$info_dir/SOURCE-OFFER.md"
  {
    echo "kind=prebuilt"
    echo "image=$(sha256_of "$OUT/$IMAGE")"
  } >"$info_dir/inputs.stamp.tmp.$$"
  mv -f "$info_dir/inputs.stamp.tmp.$$" "$info_dir/inputs.stamp"
  info "installed the prebuilt kernel $src as $OUT/$IMAGE ($(size_of "$OUT/$IMAGE") bytes, sha256 $(sha256_of "$OUT/$IMAGE"))"
  warn "a prebuilt kernel is trusted as is; build it from source with kernel/build.sh to get the verified, reproducible one"
}

usage() { sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; }

MODE=build
FORCE=0
FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --no-cache) NO_CACHE=1; FORCE=1 ;;
    --config-only) MODE=config ;;
    --check) MODE=check ;;
    --check-pins) MODE=pins ;;
    --from) [ $# -ge 2 ] || die "--from needs a path"; MODE=from; FROM=$2; shift ;;
    --flavour) [ $# -ge 2 ] || die "--flavour needs a name (default or a folder of kernel/flavours/)"; FLAVOUR=$2; shift ;;
    --out) [ $# -ge 2 ] || die "--out needs a folder"; OUT="$(mkdir -p "$2" && cd "$2" && pwd)"; shift ;;
    --verbose) VERBOSE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
CACHE="$WORK/cache/kernel"
setup_flavour

# "kernel:" for the default flavour, "kernel (gpu):" for another.
TAG="kernel${FDIR:+ ($FLAVOUR)}"

case "$MODE" in
  pins) check_pins; echo "pins ok: $UBUNTU_REF, Linux $KERNEL_VERSION$KERNEL_LOCALVERSION, snapshot $UBUNTU_SNAPSHOT${FDIR:+, flavour $FLAVOUR}" ;;
  check) cmd_check ;;
  config) cmd_config_only ;;
  from) cmd_from "$FROM" ;;
  build)
    if [ "$FORCE" != "1" ] && why="$(cmd_check)"; then
      echo "$TAG: $why"
    else
      [ "$FORCE" = "1" ] || echo "$TAG: rebuilding because ${why:-out of date}"
      cmd_build
    fi
    ;;
esac
