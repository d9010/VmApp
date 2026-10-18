#!/usr/bin/env bash
# Builds, from pinned sources, the four host libraries of the EXPERIMENTAL Vulkan GPU backend (libkrun + virglrenderer
# with Venus + libepoxy + MoltenVK) into vmapp/out/krun/, relocatable and ad-hoc signed.
#
#   gpu/krun/build-libs.sh [--out DIR] [--clean | --clean-all | --clean-only] [--force] [--check] [--verbose]
#     --out DIR      output root (default: vmapp/out); the result is DIR/krun/
#     --clean        wipe the sources, build folders, install prefix and DIR/krun first, then build from scratch
#                    (the Rust toolchain, the venv and the download cache are kept)
#     --clean-all    like --clean, and also remove the Rust toolchain and the Python venv
#     --clean-only   wipe like --clean, then stop
#     --force        rebuild every component even when its inputs did not change
#     --check        build nothing: verify that DIR/krun is complete, up to date for pins.env + patches, signed and
#                    relocatable (install names, rpaths, no absolute path left); exit 0 when it is, 1 otherwise
#     --verbose      also stream the logs to the terminal (they are always written to $VMAPP_WORK/krun-build/logs/)
#
# Outputs (DIR/krun/):
#   lib/libkrun.1.dylib  lib/libvirglrenderer.1.dylib  lib/libepoxy.0.dylib  lib/libMoltenVK.dylib
#                                 arm64, install names @rpath/<name>, rpath @loader_path, ad-hoc signed
#   include/libkrun.h             the C API the launcher compiles against
#   licenses/                     each component's licence files, libkrun's Rust crates, NOTICES.txt
#   BUILD-INFO.txt                pins, patches, tool versions, sha256 and size of every output
#
# Environment:
#   VMAPP_WORK   absolute scratch folder (default: vmapp/out/work, git-ignored). Used (and only these):
#                  krun-src/       the shallow clones         krun-build/   build folders, logs, tool shims
#                  krun-prefix/    intermediate install       krun-rust/    cargo + rustup (the pinned toolchain)
#                  krun-venv/      pinned meson + ninja       cache/dl/     downloads (rustup-init, Debian packages)
#
# What it does, in order (each component is skipped when its inputs, pins + patches + recipe, did not change):
#   1. rustup-init (sha256-verified) installs the pinned Rust toolchain into krun-rust; pip installs meson + ninja
#      from gpu/krun/requirements.txt (hash-pinned wheels) into krun-venv. Nothing is taken from Homebrew except the
#      pre-existing build tools cmake and pkg-config (linked into a private PATH; every other tool comes from macOS/Xcode,
#      the venv or the toolchain). Nothing is installed anywhere else.
#   2. MoltenVK (Xcode, ~5 min), libepoxy (meson), virglrenderer slp fork + gpu/krun/patches/*.patch (meson), libkrun
#      (make + cargo, with a Debian sysroot built from pinned, sha256-verified packages for its init program).
#      Every clone is `git clone --depth 1 --branch <tag>` and is REFUSED unless HEAD is the pinned commit.
#   3. Assembly: copy the four libraries, rewrite install names to @rpath/<name>, inter-library references to
#      @rpath/<name>, rpath @loader_path, ad-hoc codesign, copy licences, write BUILD-INFO.txt, then verify.
#
# No absolute path of the build machine is kept in the load commands, and the build maps source and toolchain paths
# (-ffile-prefix-map, --remap-path-prefix) so they do not end up as strings in the binaries either.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
PINS_FILE="$HERE/pins.env"
PATCH_DIR="$HERE/patches"
REQ_FILE="$HERE/requirements.txt"

OUT="$VMAPP/out"
DO_CLEAN=0
DO_CLEAN_ALL=0
CLEAN_ONLY=0
FORCE=0
CHECK=0
VERBOSE=0

OUR_LIBS="libkrun.1.dylib libvirglrenderer.1.dylib libepoxy.0.dylib libMoltenVK.dylib"

# ---------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------
log() { printf '\n==> [%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'gpu/krun/build-libs.sh: %s\n' "$*" >&2
  exit 1
}
sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }
size_of() { wc -c <"$1" | tr -d ' '; }
is_ours() {
  case " $OUR_LIBS " in *" $1 "*) return 0 ;; esac
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die "--out needs a folder"
      OUT="$2"
      shift
      ;;
    --clean) DO_CLEAN=1 ;;
    --clean-all)
      DO_CLEAN=1
      DO_CLEAN_ALL=1
      ;;
    --clean-only)
      DO_CLEAN=1
      CLEAN_ONLY=1
      ;;
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    --verbose) VERBOSE=1 ;;
    -h | --help)
      sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
KOUT="$OUT/krun"
KLIB="$KOUT/lib"

WORK="${VMAPP_WORK:-$VMAPP/out/work}"
case "$WORK" in
  /*) ;;
  *) die "VMAPP_WORK must be an absolute path (got: $WORK)" ;;
esac
case "$WORK" in
  *[[:space:]]*) die "VMAPP_WORK must not contain whitespace (the Makefile of libkrun cannot handle it): $WORK" ;;
esac
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
SRC="$WORK/krun-src"
BUILD="$WORK/krun-build"
PREFIX="$WORK/krun-prefix"
RUSTD="$WORK/krun-rust"
VENV="$WORK/krun-venv"
DL="$WORK/cache/dl"
LOGS="$BUILD/logs"
TOOLBIN="$BUILD/tools-bin"
CARGO_HOME="$RUSTD/cargo"
RUSTUP_HOME="$RUSTD/rustup"

# Empty a folder that this script owns (refuses anything else, and symlinks).
clear_dir() {
  local d=$1
  case "$d" in
    "$WORK"/krun-* | "$KOUT" | "$KOUT"/*) ;;
    *) die "refusing to clear $d (not one of the krun-* folders of $WORK, nor $KOUT)" ;;
  esac
  [ "$d" != "$WORK/krun-" ] || die "refusing to clear $d"
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
PIN_KEYS="MOLTENVK_REPO MOLTENVK_TAG MOLTENVK_COMMIT MOLTENVK_LICENSE
EPOXY_REPO EPOXY_TAG EPOXY_COMMIT EPOXY_LICENSE
VIRGL_REPO VIRGL_TAG VIRGL_COMMIT VIRGL_LICENSE
KRUN_REPO KRUN_TAG KRUN_COMMIT KRUN_LICENSE KRUN_MAKE_FLAGS
RUST_VERSION RUSTUP_INIT_VERSION RUSTUP_INIT_URL RUSTUP_INIT_SHA256 MESON_VERSION NINJA_VERSION
DEBIAN_SNAPSHOT_URL SYSROOT_GCC_VERSION
SYSROOT_LIBC6_PATH SYSROOT_LIBC6_SHA256 SYSROOT_LIBC6_DEV_PATH SYSROOT_LIBC6_DEV_SHA256
SYSROOT_LIBGCC_DEV_PATH SYSROOT_LIBGCC_DEV_SHA256 SYSROOT_LINUX_LIBC_DEV_PATH SYSROOT_LINUX_LIBC_DEV_SHA256
SYSROOT_GCC_BASE_PATH SYSROOT_GCC_BASE_SHA256
MACOS_DEPLOYMENT_TARGET"
PIN_KEYS=$(printf '%s ' $PIN_KEYS) # one line, single spaces

pin_match() { # NAME VALUE REGEX
  local re=$3
  [[ $2 =~ $re ]] || die "pins.env: $1 has an invalid value: $2"
}

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
  local url_re='^https://[A-Za-z0-9./_-]+$' commit_re='^[0-9a-f]{40}$' tag_re='^[A-Za-z0-9._-]+$'
  local sha_re='^[0-9a-f]{64}$' ver_re='^[0-9]+\.[0-9]+\.[0-9]+$' deb_re='^pool/[A-Za-z0-9./_+-]+_arm64\.deb$'
  pin_match MOLTENVK_REPO "$MOLTENVK_REPO" "$url_re"
  pin_match EPOXY_REPO "$EPOXY_REPO" "$url_re"
  pin_match VIRGL_REPO "$VIRGL_REPO" "$url_re"
  pin_match KRUN_REPO "$KRUN_REPO" "$url_re"
  pin_match MOLTENVK_TAG "$MOLTENVK_TAG" "$tag_re"
  pin_match EPOXY_TAG "$EPOXY_TAG" "$tag_re"
  pin_match VIRGL_TAG "$VIRGL_TAG" "$tag_re"
  pin_match KRUN_TAG "$KRUN_TAG" "$tag_re"
  pin_match MOLTENVK_COMMIT "$MOLTENVK_COMMIT" "$commit_re"
  pin_match EPOXY_COMMIT "$EPOXY_COMMIT" "$commit_re"
  pin_match VIRGL_COMMIT "$VIRGL_COMMIT" "$commit_re"
  pin_match KRUN_COMMIT "$KRUN_COMMIT" "$commit_re"
  pin_match KRUN_MAKE_FLAGS "$KRUN_MAKE_FLAGS" '^[A-Z_]+=[01]( [A-Z_]+=[01])*$'
  pin_match RUST_VERSION "$RUST_VERSION" "$ver_re"
  pin_match RUSTUP_INIT_VERSION "$RUSTUP_INIT_VERSION" "$ver_re"
  pin_match RUSTUP_INIT_URL "$RUSTUP_INIT_URL" '^https://static\.rust-lang\.org/[A-Za-z0-9./_-]+$'
  pin_match RUSTUP_INIT_SHA256 "$RUSTUP_INIT_SHA256" "$sha_re"
  pin_match MESON_VERSION "$MESON_VERSION" "$ver_re"
  pin_match NINJA_VERSION "$NINJA_VERSION" "$ver_re"
  pin_match DEBIAN_SNAPSHOT_URL "$DEBIAN_SNAPSHOT_URL" '^https://snapshot\.debian\.org/archive/debian/[0-9]{8}T[0-9]{6}Z$'
  pin_match SYSROOT_GCC_VERSION "$SYSROOT_GCC_VERSION" '^[0-9]+$'
  pin_match SYSROOT_LIBC6_PATH "$SYSROOT_LIBC6_PATH" "$deb_re"
  pin_match SYSROOT_LIBC6_DEV_PATH "$SYSROOT_LIBC6_DEV_PATH" "$deb_re"
  pin_match SYSROOT_LIBGCC_DEV_PATH "$SYSROOT_LIBGCC_DEV_PATH" "$deb_re"
  pin_match SYSROOT_LINUX_LIBC_DEV_PATH "$SYSROOT_LINUX_LIBC_DEV_PATH" "$deb_re"
  pin_match SYSROOT_GCC_BASE_PATH "$SYSROOT_GCC_BASE_PATH" "$deb_re"
  pin_match SYSROOT_GCC_BASE_SHA256 "$SYSROOT_GCC_BASE_SHA256" "$sha_re"
  pin_match SYSROOT_LIBC6_SHA256 "$SYSROOT_LIBC6_SHA256" "$sha_re"
  pin_match SYSROOT_LIBC6_DEV_SHA256 "$SYSROOT_LIBC6_DEV_SHA256" "$sha_re"
  pin_match SYSROOT_LIBGCC_DEV_SHA256 "$SYSROOT_LIBGCC_DEV_SHA256" "$sha_re"
  pin_match SYSROOT_LINUX_LIBC_DEV_SHA256 "$SYSROOT_LINUX_LIBC_DEV_SHA256" "$sha_re"
  pin_match MACOS_DEPLOYMENT_TARGET "$MACOS_DEPLOYMENT_TARGET" '^[0-9]+\.[0-9]+$'
  # requirements.txt pins the same versions (by hash).
  grep -q "^meson==$MESON_VERSION " "$REQ_FILE" || die "requirements.txt does not pin meson==$MESON_VERSION (pins.env)"
  grep -q "^ninja==$NINJA_VERSION " "$REQ_FILE" || die "requirements.txt does not pin ninja==$NINJA_VERSION (pins.env)"
}

# ---------------------------------------------------------------------------------------
# component inputs (what decides whether a component is rebuilt)
# ---------------------------------------------------------------------------------------
# The inputs of a component: its pins, its patches, the text of its build function and of the shared helpers, and the
# inputs of what it links against. A change in any of them rebuilds the component (and what depends on it).
comp_pin_regex() {
  case "$1" in
    moltenvk) echo '^MOLTENVK_' ;;
    epoxy) echo '^(EPOXY_|MACOS_DEPLOYMENT_TARGET=)' ;;
    virgl) echo '^(VIRGL_|MACOS_DEPLOYMENT_TARGET=)' ;;
    krun) echo '^(KRUN_|RUST_|RUSTUP_INIT_|SYSROOT_|DEBIAN_|MACOS_DEPLOYMENT_TARGET=)' ;;
    *) die "internal: unknown component $1" ;;
  esac
}
comp_patch_dir() {
  case "$1" in
    moltenvk) echo "$PATCH_DIR/moltenvk" ;;
    epoxy) echo "$PATCH_DIR/libepoxy" ;;
    virgl) echo "$PATCH_DIR" ;; # gpu/krun/patches/*.patch are the virglrenderer patches
    krun) echo "$PATCH_DIR/libkrun" ;;
  esac
}
comp_inputs() {
  local c=$1 d p
  {
    grep -E "$(comp_pin_regex "$c")" "$PINS_FILE" || true
    d=$(comp_patch_dir "$c")
    for p in "$d"/*.patch; do
      if [ -f "$p" ]; then cat "$p"; fi
    done
    declare -f "build_$c" fetch_src apply_patches with_env
    case "$c" in
      virgl)
        comp_inputs epoxy
        comp_inputs moltenvk
        ;;
      krun)
        comp_inputs virgl
        comp_inputs epoxy
        declare -f build_sysroot
        ;;
    esac
  } | shasum -a 256 | awk '{ print $1 }'
}
all_inputs() {
  {
    for c in moltenvk epoxy virgl krun; do comp_inputs "$c"; done
    declare -f assemble fix_dylib verify_outputs write_build_info write_licenses
  } | shasum -a 256 | awk '{ print $1 }'
}

# ---------------------------------------------------------------------------------------
# verification of the output folder (also what --check runs)
# ---------------------------------------------------------------------------------------
VERIFY_BAD=0
LIB_BAD=0
vfail() {
  printf '  FAIL: %s\n' "$*"
  VERIFY_BAD=1
  LIB_BAD=1
}
vok() { printf '  ok:   %s\n' "$*"; }

verify_outputs() {
  local n f id deps dep rps rp needle has_rpath_dep line h s rel
  VERIFY_BAD=0
  for n in $OUR_LIBS; do
    f="$KLIB/$n"
    LIB_BAD=0
    if [ ! -f "$f" ]; then
      vfail "missing $f"
      continue
    fi
    if [ "$(lipo -archs "$f" 2>/dev/null)" != "arm64" ]; then
      vfail "$n is not a thin arm64 library ($(lipo -archs "$f" 2>/dev/null))"
    fi
    id=$(otool -D "$f" | tail -n 1)
    [ "$id" = "@rpath/$n" ] || vfail "$n install name is '$id', want '@rpath/$n'"
    has_rpath_dep=0
    deps=$(otool -L "$f" | awk 'NR>1 {print $1}')
    for dep in $deps; do
      case "$dep" in
        "@rpath/$n") ;;
        /usr/lib/* | /System/Library/*) ;;
        @rpath/*)
          is_ours "${dep#@rpath/}" || vfail "$n links $dep, which is not one of ours"
          has_rpath_dep=1
          ;;
        *) vfail "$n has an absolute or foreign dependency: $dep" ;;
      esac
    done
    rps=$(otool -l "$f" | awk '/cmd LC_RPATH/ {getline; getline; print $2}')
    for rp in $rps; do
      [ "$rp" = "@loader_path" ] || vfail "$n has an LC_RPATH other than @loader_path: $rp"
    done
    if [ "$has_rpath_dep" = 1 ] && [ "$rps" != "@loader_path" ]; then
      vfail "$n links sibling libraries via @rpath but its rpath is '$rps' (want @loader_path)"
    fi
    for needle in "/opt/homebrew" "$VMAPP" "$WORK" "$HOME"; do
      if LC_ALL=C grep -a -q -F -- "$needle" "$f"; then
        vfail "$n contains the build-machine path '$needle'"
      fi
    done
    codesign --verify --strict "$f" 2>/dev/null || vfail "$n: code signature is missing or invalid"
    if [ "$LIB_BAD" = 0 ]; then
      vok "$n: arm64, @rpath id, deps only system or @rpath siblings, rpath [${rps:-none}], signed, no build path"
    fi
  done
  [ -f "$KOUT/include/libkrun.h" ] || vfail "missing include/libkrun.h"
  [ -f "$KOUT/licenses/NOTICES.txt" ] || vfail "missing licenses/NOTICES.txt"
  [ -f "$KOUT/BUILD-INFO.txt" ] || vfail "missing BUILD-INFO.txt"
  if [ -f "$KOUT/BUILD-INFO.txt" ]; then
    while IFS= read -r line; do
      h=${line%% *}
      rel=${line#*  }
      rel=${rel#*  }
      if [ -f "$KOUT/$rel" ]; then
        s=$(sha256_of "$KOUT/$rel")
        [ "$s" = "$h" ] || vfail "$rel differs from BUILD-INFO.txt (sha256 $s)"
      else
        vfail "$rel listed in BUILD-INFO.txt is missing"
      fi
    done < <(grep -E '^[0-9a-f]{64}  [0-9]+  ' "$KOUT/BUILD-INFO.txt")
  fi
  return "$VERIFY_BAD"
}

check_mode() {
  local rc=0
  log "checking $KOUT"
  verify_outputs || rc=1
  if [ -f "$KOUT/.inputs-stamp" ]; then
    if [ "$(cat "$KOUT/.inputs-stamp")" = "$(all_inputs)" ]; then
      vok "up to date for pins.env + patches + recipe"
    else
      vfail "built from other inputs than the current pins.env / patches / recipe: run gpu/krun/build-libs.sh"
      rc=1
    fi
  else
    vfail "no .inputs-stamp: not built by this script"
    rc=1
  fi
  if [ "$rc" = 0 ]; then echo "check: OK"; else echo "check: FAILED"; fi
  return "$rc"
}

# ---------------------------------------------------------------------------------------
# environment and tools
# ---------------------------------------------------------------------------------------
BASE_ENV=()
TOOL_PATH=""
PY=""

setup_env() {
  local t p v
  mkdir -p "$TOOLBIN" "$LOGS" "$DL" "$PREFIX/lib" "$PREFIX/.stamps"
  # The only Homebrew tools used: cmake (MoltenVK's SPIRV-Tools) and pkg-config (virglrenderer, libkrun). They are
  # linked into a private folder so that nothing else from /opt/homebrew can end up on the PATH.
  for t in cmake pkg-config; do
    p=$(command -v "$t" || true)
    if [ -z "$p" ] && [ "$t" = pkg-config ]; then
      p=$(command -v pkgconf || true)
    fi
    if [ -z "$p" ]; then
      die "missing build tool: $t (cmake and pkg-config must already be installed; nothing is installed for you)"
    fi
    ln -sf "$p" "$TOOLBIN/$t"
  done
  for t in git curl clang make ar tar lipo otool install_name_tool codesign shasum awk sed find xcodebuild python3 grep; do
    command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
  done
  xcodebuild -version >/dev/null 2>&1 || die "xcodebuild does not work: install Xcode (the full app, not only the command line tools) and select it with xcode-select"
  PY=$(python3 -c 'import sys; print(sys.executable)')
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || die "python3 >= 3.8 is needed to create the venv"
  TOOL_PATH="$VENV/bin:$CARGO_HOME/bin:$TOOLBIN:/usr/bin:/bin:/usr/sbin:/sbin"
  BASE_ENV=(HOME="$HOME" PATH="$TOOL_PATH" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
    GIT_TERMINAL_PROMPT=0 CARGO_HOME="$CARGO_HOME" RUSTUP_HOME="$RUSTUP_HOME")
  for v in USER LOGNAME DEVELOPER_DIR http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY SSL_CERT_FILE; do
    if [ -n "${!v:-}" ]; then BASE_ENV+=("$v=${!v}"); fi
  done
}

# Run a command in a clean environment (only BASE_ENV + the NAME=value words given before the command).
with_env() { env -i "${BASE_ENV[@]}" "$@"; }

# step_run NAME DIR CMD...: run CMD in DIR, log to $LOGS/NAME.log, show the tail and stop when it fails.
step_run() {
  local name=$1 dir=$2 lf rc=0
  shift 2
  mkdir -p "$LOGS"
  lf="$LOGS/$name.log"
  info "$name (log: $lf)"
  printf '$ cd %s && %s\n' "$dir" "$*" >"$lf"
  if [ "$VERBOSE" = 1 ]; then
    set +e
    (cd "$dir" && "$@") 2>&1 | tee -a "$lf"
    rc=${PIPESTATUS[0]}
    set -e
  else
    (cd "$dir" && "$@") >>"$lf" 2>&1 || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    tail -n 40 "$lf" >&2
    die "$name failed (exit $rc); full log: $lf"
  fi
}

download_verified() { # URL DEST SHA256
  local url=$1 dest=$2 want=$3 tmp got
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  tmp="$dest.part.$$"
  info "downloading $url"
  curl -fL --proto '=https' --tlsv1.2 --retry 3 --silent --show-error -o "$tmp" "$url" || {
    rm -f "$tmp"
    die "download failed: $url"
  }
  got=$(sha256_of "$tmp")
  if [ "$got" != "$want" ]; then
    rm -f "$tmp"
    die "sha256 mismatch for $url: got $got, pinned $want"
  fi
  mv -f "$tmp" "$dest"
}

# fetch_src NAME REPO TAG COMMIT: a fresh shallow clone of TAG into $SRC/NAME; refuses a HEAD that is not COMMIT.
fetch_src() {
  local name=$1 repo=$2 tag=$3 commit=$4 d head
  d="$SRC/$name"
  clear_dir "$d"
  step_run "clone-$name" "$SRC" git clone --quiet --depth 1 --branch "$tag" -c advice.detachedHead=false "$repo" "$d"
  head=$(git -C "$d" rev-parse HEAD)
  if [ "$head" != "$commit" ]; then
    die "$name: the checkout of $tag is commit $head, but the pin is $commit. Refusing to build from it (a tag was moved?)."
  fi
  info "$name $tag = $commit"
}

# apply_patches DIR SRC: apply every DIR/*.patch with `git apply`, in name order; a patch that does not apply is fatal.
apply_patches() {
  local d=$1 src=$2 p n=0
  for p in "$d"/*.patch; do
    [ -f "$p" ] || continue
    git -C "$src" apply --check "$p" || die "patch does not apply to $(basename "$src"): $p"
    git -C "$src" apply "$p"
    info "applied $(basename "$p")"
    n=$((n + 1))
  done
  info "$n patch(es) applied to $(basename "$src")"
}

# ---------------------------------------------------------------------------------------
# toolchain: Rust (rustup-init, pinned) and meson + ninja (pip, pinned by hash)
# ---------------------------------------------------------------------------------------
ensure_rust() {
  local cur ri
  mkdir -p "$CARGO_HOME" "$RUSTUP_HOME"
  cur=$(with_env RUSTUP_TOOLCHAIN="$RUST_VERSION" "$CARGO_HOME/bin/rustc" --version 2>/dev/null || true)
  case "$cur" in
    "rustc $RUST_VERSION "*)
      info "rust $RUST_VERSION is installed in $RUSTD"
      return 0
      ;;
  esac
  ri="$DL/rustup-init-$RUSTUP_INIT_VERSION-aarch64-apple-darwin"
  download_verified "$RUSTUP_INIT_URL" "$ri" "$RUSTUP_INIT_SHA256"
  chmod 755 "$ri"
  step_run rustup-init "$WORK" with_env "$ri" -y --no-modify-path --profile minimal \
    --default-host aarch64-apple-darwin --default-toolchain "$RUST_VERSION"
  cur=$(with_env RUSTUP_TOOLCHAIN="$RUST_VERSION" "$CARGO_HOME/bin/rustc" --version 2>/dev/null || true)
  case "$cur" in "rustc $RUST_VERSION "*) ;; *) die "the installed Rust is '$cur', want $RUST_VERSION" ;; esac
}

ensure_venv() {
  local mm nn
  mm=$("$VENV/bin/meson" --version 2>/dev/null || true)
  nn=$("$VENV/bin/ninja" --version 2>/dev/null || true)
  if [ "$mm" = "$MESON_VERSION" ] && [ "${nn%%.git*}" = "$NINJA_VERSION" ]; then
    info "meson $mm and ninja ${nn%%.git*} are installed in $VENV"
    return 0
  fi
  clear_dir "$VENV"
  step_run venv-create "$WORK" with_env "$PY" -m venv "$VENV"
  step_run venv-pip "$WORK" with_env "$VENV/bin/python3" -m pip install --isolated --disable-pip-version-check \
    --no-cache-dir --require-hashes --only-binary=:all: -r "$REQ_FILE"
  mm=$("$VENV/bin/meson" --version 2>/dev/null || true)
  [ "$mm" = "$MESON_VERSION" ] || die "venv meson is '$mm', want $MESON_VERSION"
}

# ---------------------------------------------------------------------------------------
# components
# ---------------------------------------------------------------------------------------
MAP_FLAGS_C=""  # set in main once WORK is known
RUST_PATH_REMAP=""

build_moltenvk() {
  local s="$SRC/MoltenVK" dd="$BUILD/moltenvk-dd" built a
  fetch_src MoltenVK "$MOLTENVK_REPO" "$MOLTENVK_TAG" "$MOLTENVK_COMMIT"
  apply_patches "$(comp_patch_dir moltenvk)" "$s"
  clear_dir "$dd"
  # Pinned external dependencies (revisions in ExternalRevisions/), SPIRV-Tools through cmake + ninja.
  step_run moltenvk-deps "$s" with_env ./fetchDependencies --macos
  step_run moltenvk-xcodebuild "$s" with_env xcodebuild build -project MoltenVKPackaging.xcodeproj \
    -scheme "MoltenVK Package (macOS only)" -destination "generic/platform=macOS" -derivedDataPath "$dd" -quiet \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=NO
  built="$s/Package/Release/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib"
  [ -f "$built" ] || die "MoltenVK build produced no $built"
  a=$(lipo -archs "$built")
  mkdir -p "$PREFIX/lib"
  case "$a" in
    arm64) cp "$built" "$PREFIX/lib/libMoltenVK.dylib" ;;
    *arm64*)
      info "MoltenVK is a universal binary ($a): keeping the arm64 slice"
      lipo "$built" -thin arm64 -output "$PREFIX/lib/libMoltenVK.dylib"
      ;;
    *) die "MoltenVK has no arm64 slice ($a)" ;;
  esac
  # The Vulkan headers that belong to this MoltenVK (vulkan/, vk_video/, MoltenVK/): virglrenderer's Venus headers
  # include vk_video/*.h and the fork does not ship them (patch 0002 adds the meson option that points here).
  clear_dir "$PREFIX/libexec/molten-vk/include"
  cp -R "$s/Package/Release/MoltenVK/include/." "$PREFIX/libexec/molten-vk/include/"
}

build_epoxy() {
  local s="$SRC/libepoxy" b="$BUILD/epoxy"
  fetch_src libepoxy "$EPOXY_REPO" "$EPOXY_TAG" "$EPOXY_COMMIT"
  apply_patches "$(comp_patch_dir epoxy)" "$s"
  clear_dir "$b"
  step_run epoxy-setup "$BUILD" with_env CFLAGS="$MAP_FLAGS_C" LDFLAGS="-Wl,-headerpad_max_install_names" \
    MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" \
    meson setup "$b" "$s" --prefix="$PREFIX" --libdir=lib --buildtype=release --wrap-mode=nodownload \
    -Degl=no -Dglx=no -Dx11=false -Dtests=false -Ddocs=false
  step_run epoxy-compile "$BUILD" with_env MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" meson compile -C "$b"
  step_run epoxy-install "$BUILD" with_env MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" meson install -C "$b"
}

build_virgl() {
  local s="$SRC/virglrenderer" b="$BUILD/virglrenderer"
  [ -f "$PREFIX/lib/libMoltenVK.dylib" ] || die "internal: MoltenVK must be built before virglrenderer"
  [ -f "$PREFIX/lib/pkgconfig/epoxy.pc" ] || die "internal: libepoxy must be built before virglrenderer"
  fetch_src virglrenderer "$VIRGL_REPO" "$VIRGL_TAG" "$VIRGL_COMMIT"
  apply_patches "$(comp_patch_dir virgl)" "$s"
  clear_dir "$b"
  # venus in-process, no render server (macOS cannot export GPU buffers as fds), links -lMoltenVK directly.
  step_run virgl-setup "$BUILD" with_env CFLAGS="$MAP_FLAGS_C" LDFLAGS="-L$PREFIX/lib -Wl,-headerpad_max_install_names" \
    PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" \
    meson setup "$b" "$s" --prefix="$PREFIX" --libdir=lib --buildtype=release --wrap-mode=nodownload \
    -Dvenus=true -Drender-server=false -Dtests=false -Dmoltenvk-include-dir="$PREFIX/libexec/molten-vk/include"
  step_run virgl-compile "$BUILD" with_env PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" \
    MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" meson compile -C "$b"
  step_run virgl-install "$BUILD" with_env PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" \
    MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" meson install -C "$b"
}

# The Debian bookworm sysroot libkrun's init program is cross-compiled against: the same 4 packages the Makefile
# would download, but at pinned versions from snapshot.debian.org and verified by sha256.
build_sysroot() {
  local sr="$BUILD/linux-sysroot" tmpd="$BUILD/sysroot-tmp" i path sha deb data
  clear_dir "$sr"
  for i in LIBC6 LIBC6_DEV LIBGCC_DEV LINUX_LIBC_DEV GCC_BASE; do
    eval "path=\$SYSROOT_${i}_PATH sha=\$SYSROOT_${i}_SHA256"
    deb="$DL/$(basename "$path")"
    download_verified "$DEBIAN_SNAPSHOT_URL/$path" "$deb" "$sha"
    clear_dir "$tmpd"
    step_run "sysroot-ar-$i" "$tmpd" ar x "$deb"
    data=$(find "$tmpd" -maxdepth 1 -name 'data.tar.*' | head -n 1)
    [ -n "$data" ] || die "$deb has no data.tar.*"
    step_run "sysroot-tar-$i" "$sr" tar -xf "$data" -C "$sr"
  done
  clear_dir "$tmpd"
  [ -f "$sr/usr/lib/gcc/aarch64-linux-gnu/$SYSROOT_GCC_VERSION/libgcc.a" ] || die "sysroot incomplete: no libgcc.a for gcc $SYSROOT_GCC_VERSION"
  [ -f "$sr/usr/lib/aarch64-linux-gnu/libc.a" ] || die "sysroot incomplete: no libc.a"
}

build_krun() {
  local s="$SRC/libkrun" sr="$BUILD/linux-sysroot" gccld
  [ -f "$PREFIX/lib/libvirglrenderer.1.dylib" ] || die "internal: virglrenderer must be built before libkrun"
  gccld="$RUSTUP_HOME/toolchains/$RUST_VERSION-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/gcc-ld"
  [ -x "$gccld/ld.lld" ] || die "the Rust toolchain has no rust-lld wrapper at $gccld/ld.lld"
  build_sysroot
  fetch_src libkrun "$KRUN_REPO" "$KRUN_TAG" "$KRUN_COMMIT"
  apply_patches "$(comp_patch_dir krun)" "$s"
  # shellcheck disable=SC2086
  step_run krun-make "$s" with_env PATH="$gccld:$TOOL_PATH" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" \
    RUSTUP_TOOLCHAIN="$RUST_VERSION" MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" \
    RUSTFLAGS="$RUST_PATH_REMAP -C link-arg=-Wl,-headerpad_max_install_names" \
    make $KRUN_MAKE_FLAGS PREFIX="$PREFIX" SYSROOT_LINUX="$sr" GCC_VERSION="$SYSROOT_GCC_VERSION" \
    CLANG="/usr/bin/clang -ffile-prefix-map=$WORK=/vmapp-work"
  # shellcheck disable=SC2086
  step_run krun-install "$s" with_env PATH="$gccld:$TOOL_PATH" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" \
    RUSTUP_TOOLCHAIN="$RUST_VERSION" MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET" \
    RUSTFLAGS="$RUST_PATH_REMAP -C link-arg=-Wl,-headerpad_max_install_names" \
    make $KRUN_MAKE_FLAGS PREFIX="$PREFIX" SYSROOT_LINUX="$sr" GCC_VERSION="$SYSROOT_GCC_VERSION" \
    CLANG="/usr/bin/clang -ffile-prefix-map=$WORK=/vmapp-work" install
  # The pinned Cargo.lock must have been used as is (cargo updates it silently when a dependency is missing from it).
  git -C "$s" diff --quiet -- Cargo.lock || die "libkrun's Cargo.lock was modified by the build: the dependency set is not the pinned one"
  [ -f "$PREFIX/lib/libkrun.$(sed -n 's/^FULL_VERSION=//p' "$s/Makefile").dylib" ] || die "libkrun build produced no dylib"
}

comp_out_ok() {
  case "$1" in
    moltenvk) [ -f "$PREFIX/lib/libMoltenVK.dylib" ] && [ -f "$PREFIX/libexec/molten-vk/include/vk_video/vulkan_video_codecs_common.h" ] ;;
    epoxy) [ -f "$PREFIX/lib/libepoxy.0.dylib" ] && [ -f "$PREFIX/lib/pkgconfig/epoxy.pc" ] ;;
    virgl) [ -f "$PREFIX/lib/libvirglrenderer.1.dylib" ] ;;
    krun) [ -f "$PREFIX/lib/libkrun.1.dylib" ] && [ -f "$PREFIX/include/libkrun.h" ] ;;
  esac
}

run_component() {
  local c=$1 want have=""
  want=$(comp_inputs "$c")
  if [ -f "$PREFIX/.stamps/$c" ]; then have=$(cat "$PREFIX/.stamps/$c"); fi
  if [ "$FORCE" = 0 ] && [ "$have" = "$want" ] && comp_out_ok "$c"; then
    log "$c: up to date"
    return 0
  fi
  log "$c: building"
  rm -f "$PREFIX/.stamps/$c"
  "build_$c"
  comp_out_ok "$c" || die "$c: the build finished but its outputs are missing"
  printf '%s\n' "$want" >"$PREFIX/.stamps/$c"
}

# ---------------------------------------------------------------------------------------
# assembly: relocatable, signed outputs, licences, build info
# ---------------------------------------------------------------------------------------
# Rewrite install name, sibling references and rpath so that the library loads from wherever its folder is, then sign.
fix_dylib() { # FILE
  local f=$1 n dep deps rps rp has_rpath_dep=0 lf="$LOGS/fix-dylib.log"
  n=$(basename "$f")
  chmod u+w "$f"
  install_name_tool -id "@rpath/$n" "$f" 2>>"$lf"
  deps=$(otool -L "$f" | awk 'NR>1 {print $1}')
  for dep in $deps; do
    case "$dep" in
      "@rpath/$n") ;;
      /usr/lib/* | /System/Library/*) ;;
      @rpath/*)
        is_ours "${dep#@rpath/}" || die "$n links $dep, which is not one of ours"
        has_rpath_dep=1
        ;;
      *)
        is_ours "$(basename "$dep")" || die "$n depends on $dep, which is neither a system library nor one of ours"
        install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$f" 2>>"$lf"
        has_rpath_dep=1
        ;;
    esac
  done
  rps=$(otool -l "$f" | awk '/cmd LC_RPATH/ {getline; getline; print $2}')
  for rp in $rps; do
    install_name_tool -delete_rpath "$rp" "$f" 2>>"$lf"
  done
  if [ "$has_rpath_dep" = 1 ]; then
    install_name_tool -add_rpath @loader_path "$f" 2>>"$lf"
  fi
  codesign --force --sign - "$f" 2>>"$lf"
}

copy_license_files() { # SRC_DIR DEST_DIR   (top-level licence/notice files, and an SPDX LICENSES/ folder)
  local src=$1 dest=$2 f
  [ -d "$src" ] || return 0
  mkdir -p "$dest"
  while IFS= read -r f; do
    cp -L "$f" "$dest/$(basename "$f")"
  done < <(find "$src" -maxdepth 1 \( -type f -o -type l \) \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' -o -iname 'UNLICENSE*' \) | sort)
  if [ -d "$src/LICENSES" ]; then
    mkdir -p "$dest/LICENSES"
    cp -R "$src/LICENSES/." "$dest/LICENSES/"
  fi
}

write_licenses() {
  local L="$KOUT/licenses" d b lic sr tc rev name
  mkdir -p "$L"
  copy_license_files "$SRC/libkrun" "$L/libkrun"
  copy_license_files "$SRC/libkrun/src/rutabaga_gfx" "$L/libkrun/rutabaga_gfx"
  copy_license_files "$SRC/virglrenderer" "$L/virglrenderer"
  copy_license_files "$SRC/libepoxy" "$L/libepoxy"
  copy_license_files "$SRC/MoltenVK" "$L/MoltenVK"
  for d in SPIRV-Cross SPIRV-Tools Vulkan-Headers Volk cereal Vulkan-Tools; do
    copy_license_files "$SRC/MoltenVK/External/$d" "$L/MoltenVK/bundled/$d"
  done
  # Rust crates statically linked into libkrun: the ones cargo downloaded for this build (a superset of what is linked).
  mkdir -p "$L/libkrun-crates"
  for d in "$CARGO_HOME"/registry/src/*/*; do
    [ -d "$d" ] || continue
    b=$(basename "$d")
    lic=$(awk -F'"' '/^license[ ]*=/ {print $2; exit}' "$d/Cargo.toml" 2>/dev/null || true)
    [ -n "$lic" ] || lic="(see the licence files)"
    printf '%s\t%s\n' "$b" "$lic"
    copy_license_files "$d" "$L/libkrun-crates/$b"
  done >"$L/libkrun-crates.txt"
  # Rust standard library (statically linked into libkrun).
  tc="$RUSTUP_HOME/toolchains/$RUST_VERSION-aarch64-apple-darwin/share/doc/rust"
  if [ -d "$tc" ]; then
    mkdir -p "$L/rust"
    # The standard library's notices and the licence texts it refers to (not the compiler's 14 MB COPYRIGHT.html).
    for b in COPYRIGHT-library.html licenses/Apache-2.0.txt licenses/MIT.txt licenses/BSD-2-Clause.txt licenses/ISC.txt \
      licenses/NCSA.txt licenses/Unicode-3.0.txt; do
      if [ -f "$tc/$b" ]; then cp "$tc/$b" "$L/rust/$(basename "$b")"; fi
    done
  fi
  # glibc and libgcc are statically linked into libkrun's embedded init program: the Debian copyright files
  # (libgcc-12-dev's doc folder is a symlink to gcc-12-base).
  sr="$BUILD/linux-sysroot"
  for name in libc6 libc6-dev gcc-$SYSROOT_GCC_VERSION-base linux-libc-dev; do
    if [ -f "$sr/usr/share/doc/$name/copyright" ]; then
      mkdir -p "$L/debian"
      cp "$sr/usr/share/doc/$name/copyright" "$L/debian/$name.copyright"
    fi
  done
  {
    printf 'D9010 VmApp krun libraries: third-party components and licences\n'
    printf '=========================================================\n\n'
    printf 'The four libraries in lib/ are built from the sources below by gpu/krun/build-libs.sh. Licence texts are in\n'
    printf 'this folder (one subfolder per component). The pins live in gpu/krun/pins.env; patches in gpu/krun/patches/.\n\n'
    printf '%-26s %-16s %-42s %-24s %s\n' 'component' 'version' 'commit' 'licence' 'source'
    printf '%-26s %-16s %-42s %-24s %s\n' 'libkrun' "$KRUN_TAG" "$KRUN_COMMIT" "$KRUN_LICENSE" "$KRUN_REPO"
    printf '%-26s %-16s %-42s %-24s %s\n' 'virglrenderer (slp fork)' "$VIRGL_TAG" "$VIRGL_COMMIT" "$VIRGL_LICENSE" "$VIRGL_REPO"
    printf '%-26s %-16s %-42s %-24s %s\n' 'libepoxy' "$EPOXY_TAG" "$EPOXY_COMMIT" "$EPOXY_LICENSE" "$EPOXY_REPO"
    printf '%-26s %-16s %-42s %-24s %s\n' 'MoltenVK' "$MOLTENVK_TAG" "$MOLTENVK_COMMIT" "$MOLTENVK_LICENSE" "$MOLTENVK_REPO"
    printf '\nLinked into those libraries, from other projects:\n\n'
    printf '* libMoltenVK.dylib bundles the dependencies MoltenVK pins in ExternalRevisions/ (licences in MoltenVK/bundled/):\n'
    if [ -d "$SRC/MoltenVK/ExternalRevisions" ]; then
      for rev in "$SRC"/MoltenVK/ExternalRevisions/*_repo_revision; do
        [ -f "$rev" ] || continue
        printf '    %-18s %s\n' "$(basename "$rev" _repo_revision)" "$(cat "$rev")"
      done
    fi
    printf '    (SPIRV-Cross, SPIRV-Tools, Vulkan-Headers: Apache-2.0 and MIT; cereal: BSD-3-Clause; Volk: MIT.)\n'
    printf '* libkrun.1.dylib statically links Rust crates: libkrun-crates.txt lists the ones cargo downloaded for this build\n'
    printf '  (a superset of what is linked; licences in libkrun-crates/), and the Rust standard library of rustc %s\n' "$RUST_VERSION"
    printf '  (MIT OR Apache-2.0, notices in rust/).\n'
    printf '* libkrun.1.dylib embeds libkrun'"'"'s init program for the guest (src/init_blob, a static Linux arm64 program).\n'
    printf '  It is linked statically against Debian bookworm packages, whose licences apply to that embedded binary:\n'
    printf '    libc6 / libc6-dev  %s  (GNU C Library, LGPL-2.1-or-later; debian/libc6.copyright)\n' "$(basename "$SYSROOT_LIBC6_PATH" | sed 's/^libc6_//; s/_arm64.deb$//')"
    printf '    libgcc-%s-dev       %s  (libgcc.a: GPL-3.0-or-later with the GCC Runtime Library Exception; debian/gcc-%s-base.copyright)\n' "$SYSROOT_GCC_VERSION" "$(basename "$SYSROOT_LIBGCC_DEV_PATH" | sed "s/^libgcc-$SYSROOT_GCC_VERSION-dev_//; s/_arm64.deb\$//")" "$SYSROOT_GCC_VERSION"
    printf '    linux-libc-dev     %s  (kernel UAPI headers only: GPL-2.0 with the Linux syscall note)\n' "$(basename "$SYSROOT_LINUX_LIBC_DEV_PATH" | sed 's/^linux-libc-dev_//; s/_arm64.deb$//')"
    printf '  The exact binary packages come from %s/ ; Debian source packages for the same versions are on snapshot.debian.org.\n' "$DEBIAN_SNAPSHOT_URL"
    printf '  The build recipe is public (gpu/krun/build-libs.sh), so libkrun can be rebuilt against another glibc sysroot.\n\n'
    printf 'Patches applied to the virglrenderer fork (all MIT, same as the project): see gpu/krun/PATCHES.md.\n'
    printf 'The Linux guest kernel (GPL-2.0) is not part of these libraries; its source offer is handled elsewhere.\n'
  } >"$L/NOTICES.txt"
}

write_build_info() {
  local f n p
  {
    printf 'D9010 VmApp krun libraries: build info\n'
    printf '================================\n'
    printf 'built (UTC)        %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'inputs stamp       %s\n' "$(all_inputs)"
    printf 'host               %s, %s\n' "$(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion))" "$(uname -m)"
    printf 'xcode              %s\n' "$(with_env xcodebuild -version | tr '\n' ' ')"
    printf 'clang              %s\n' "$(/usr/bin/clang --version | head -n 1)"
    printf 'rust               %s (rustup-init %s, sha256 %s)\n' "$(with_env RUSTUP_TOOLCHAIN="$RUST_VERSION" "$CARGO_HOME/bin/rustc" --version)" "$RUSTUP_INIT_VERSION" "$RUSTUP_INIT_SHA256"
    printf 'cargo              %s\n' "$(with_env RUSTUP_TOOLCHAIN="$RUST_VERSION" "$CARGO_HOME/bin/cargo" --version)"
    printf 'meson / ninja      %s / %s (pip, hash-pinned wheels)\n' "$("$VENV/bin/meson" --version)" "$("$VENV/bin/ninja" --version)"
    printf 'cmake              %s (pre-installed, used by MoltenVK fetchDependencies)\n' "$(with_env cmake --version | head -n 1)"
    printf 'pkg-config         %s (pre-installed)\n' "$(with_env pkg-config --version)"
    printf 'python             %s\n' "$("$VENV/bin/python3" --version 2>&1)"
    printf '\npins (gpu/krun/pins.env)\n'
    printf '  libkrun          %s %s  features: %s (NET is not built in)\n' "$KRUN_TAG" "$KRUN_COMMIT" "$KRUN_MAKE_FLAGS"
    printf '  virglrenderer    %s %s\n' "$VIRGL_TAG" "$VIRGL_COMMIT"
    printf '  libepoxy         %s %s\n' "$EPOXY_TAG" "$EPOXY_COMMIT"
    printf '  MoltenVK         %s %s\n' "$MOLTENVK_TAG" "$MOLTENVK_COMMIT"
    printf '  MACOSX_DEPLOYMENT_TARGET (meson + cargo builds)  %s\n' "$MACOS_DEPLOYMENT_TARGET"
    printf '  init sysroot     Debian bookworm via %s\n' "$DEBIAN_SNAPSHOT_URL"
    for p in "$SYSROOT_LIBC6_PATH:$SYSROOT_LIBC6_SHA256" "$SYSROOT_LIBC6_DEV_PATH:$SYSROOT_LIBC6_DEV_SHA256" \
      "$SYSROOT_LIBGCC_DEV_PATH:$SYSROOT_LIBGCC_DEV_SHA256" "$SYSROOT_LINUX_LIBC_DEV_PATH:$SYSROOT_LINUX_LIBC_DEV_SHA256"; do
      printf '                   %s  sha256 %s\n' "$(basename "${p%%:*}")" "${p##*:}"
    done
    printf '\npatches (gpu/krun/patches/, applied on virglrenderer in this order)\n'
    for p in "$PATCH_DIR"/*.patch; do
      if [ -f "$p" ]; then printf '  %s  %s\n' "$(sha256_of "$p")" "$(basename "$p")"; fi
    done
    printf '\ndeployment target (LC_BUILD_VERSION minos)\n'
    for n in $OUR_LIBS; do
      printf '  %-24s %s\n' "$n" "$(otool -l "$KLIB/$n" | awk '/LC_BUILD_VERSION/ {f=1} f && /minos/ {print $2; exit}')"
    done
    printf '\noutputs: sha256, size, path (relative to this folder)\n'
    for f in lib/libkrun.1.dylib lib/libvirglrenderer.1.dylib lib/libepoxy.0.dylib lib/libMoltenVK.dylib include/libkrun.h licenses/NOTICES.txt; do
      printf '%s  %s  %s\n' "$(sha256_of "$KOUT/$f")" "$(size_of "$KOUT/$f")" "$f"
    done
  } >"$KOUT/BUILD-INFO.txt"
}

assemble() {
  local n src
  clear_dir "$KOUT"
  mkdir -p "$KLIB" "$KOUT/include"
  cp "$PREFIX/include/libkrun.h" "$KOUT/include/libkrun.h"
  for n in $OUR_LIBS; do
    case "$n" in
      libkrun.1.dylib) src="$PREFIX/lib/libkrun.1.dylib" ;;
      *) src="$PREFIX/lib/$n" ;;
    esac
    # cp -L: libkrun.1.dylib and libepoxy.0.dylib may be symlinks in the prefix; the output has real files only.
    cp -L "$src" "$KLIB/$n"
  done
  for n in $OUR_LIBS; do
    fix_dylib "$KLIB/$n"
  done
  write_licenses
  write_build_info
  all_inputs >"$KOUT/.inputs-stamp"
}

# ---------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------
load_pins
MAP_FLAGS_C="-ffile-prefix-map=$WORK=/vmapp-work"
RUST_PATH_REMAP="--remap-path-prefix=$WORK=/vmapp-work --remap-path-prefix=$CARGO_HOME=/cargo"

if [ "$CHECK" = 1 ]; then
  rc=0
  check_mode || rc=1
  exit "$rc"
fi

if [ "$DO_CLEAN" = 1 ]; then
  log "cleaning"
  for d in "$SRC" "$BUILD" "$PREFIX" "$KOUT"; do
    clear_dir "$d"
  done
  if [ "$DO_CLEAN_ALL" = 1 ]; then
    clear_dir "$RUSTD"
    clear_dir "$VENV"
  fi
  if [ "$CLEAN_ONLY" = 1 ]; then exit 0; fi
fi

mkdir -p "$SRC" "$BUILD" "$PREFIX"
want_all=$(all_inputs)
if [ "$FORCE" = 0 ] && [ -f "$KOUT/.inputs-stamp" ] && [ "$(cat "$KOUT/.inputs-stamp")" = "$want_all" ]; then
  if verify_outputs >/dev/null 2>&1; then
    log "$KOUT is up to date for pins.env + patches + recipe (use --force to rebuild)"
    exit 0
  fi
fi

setup_env
log "toolchain"
ensure_rust
ensure_venv

for c in moltenvk epoxy virgl krun; do
  run_component "$c"
done

log "assembling $KOUT"
assemble
if ! verify_outputs; then
  die "the assembled output failed verification (see above)"
fi
log "done: $KLIB"
ls -l "$KLIB" | sed 's/^/    /'
