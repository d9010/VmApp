#!/usr/bin/env bash
# Builds Code - OSS (dev.vmapp.vscode) from the pinned VS Code source, for linux-arm64 (the VM) and the window.
#
#   core/vscode/           the VS Code Server for the web (reh-web) of VS Code 1.142.0, compiled from the tag commit WITH patches/: its own
#                          Node 24.21.0 (as upstream ships it), out/ (the server's bundles), extensions/ (the built-in extensions, compiled, and the
#                          pinned marketplace built-ins of product.json), node_modules/ (the server's dependencies with their native modules
#                          compiled for that Node on linux-arm64), bin/ (code-oss, browser.sh), product.json, package.json, licences
#   core/git/              git from Debian bookworm (the runtime's release), the programs the runtime has libraries for
#   core/bin/              node -> ../vscode/node, git -> ../git/bin/git (the PATH of the server, its terminals and tasks)
#   core/http-bridge.js    sdk/node/http-bridge.js, the core half of the streamed HTTP bridge
#   ui/                    the web workbench of the same build at ui/static/ (the server's /static/ layout, VS Code's own WebAssembly
#                          Oniguruma included), the images and fonts of the built-in extensions, shim/index.html,
#                          shim/vscode-vmapp-shim.js, sdk/web/vmapp-fetch.js, shim/exthost/* (at ui/vmapp-exthost/…: the web worker
#                          extension host's page, shown in an isolated frame)
#
# Everything is built in Docker from pinned inputs (pins.env): the Node build image by digest, VS Code by tag AND commit (the clone is
# verified), its npm dependencies by its own lockfiles (npm ci), the server's Node by the checksum in VS Code's build/checksums/nodejs.txt,
# the marketplace built-ins by product.json's sha256, git from a Debian snapshot.
# Caches (npm, node-gyp headers) and all build products live under $VMAPP_WORK; nothing is written elsewhere except core/ and ui/.
#
#   apps/vscode/build.sh [--force] [--only install|compile|package|git] [--min-free-gb N] [--check]
#     --force            build every stage again even if its inputs are unchanged
#     --only STAGE       run just one stage and do not assemble core/ and ui/
#     --min-free-gb N    refuse to start a Docker stage with less than N GB free on the volume of Docker's disk image (default 8; 0 = off);
#                        that volume is the internal disk's (Docker Desktop) unless VMAPP_DOCKER_DATA names another engine's data folder
#     --check            read and verify the pins (and that the VS Code clone is at the pinned commit), print the plan, run nothing
# Needs: Docker (linux/arm64), git, tar, patch, node (the UI check). The stages need network access (npm, GitHub, nodejs.org, Debian).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VMAPP="$(cd "$HERE/../.." && pwd)"
PINS="$HERE/pins.env"
die() { echo "vscode/build.sh: $*" >&2; exit 1; }
need() { echo "vscode/build.sh: $*" >&2; exit 2; } # a prerequisite is missing: exit status 2, with the fix in the message

FORCE=0 ONLY="" MIN_FREE_GB=8 CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --only) ONLY="${2:?--only needs a stage}"; shift ;;
    --min-free-gb) MIN_FREE_GB="${2:?--min-free-gb needs a number}"; shift ;;
    --check) CHECK=1 ;;
    -h | --help) sed -n '2,/^set -euo pipefail/{/^#/p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
case "$ONLY" in '' | install | compile | package | git) ;; *) die "--only takes install, compile, package or git" ;; esac
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
VSCODE_VERSION="$(parse_pin "$PINS" VSCODE_VERSION)"
VSCODE_TAG="$(parse_pin "$PINS" VSCODE_TAG)"
VSCODE_TAG_COMMIT="$(parse_pin "$PINS" VSCODE_TAG_COMMIT)"
VSCODE_COMMIT_DATE="$(parse_pin "$PINS" VSCODE_COMMIT_DATE)"
VSCODE_REPO="$(parse_pin "$PINS" VSCODE_REPO)"
VSCODE_LICENSE_SHA256="$(parse_pin "$PINS" VSCODE_LICENSE_SHA256)"
NODE_BUILD_IMAGE="$(parse_pin "$PINS" NODE_BUILD_IMAGE)"
NODE_BUILD_IMAGE_DIGEST="$(parse_pin "$PINS" NODE_BUILD_IMAGE_DIGEST)"
SERVER_NODE_VERSION="$(parse_pin "$PINS" SERVER_NODE_VERSION)"
SERVER_NODE_SHA256="$(parse_pin "$PINS" SERVER_NODE_SHA256)"
APT_SNAPSHOT="$(parse_pin "$PINS" APT_SNAPSHOT)"
APT_GIT="$(parse_pin "$PINS" APT_GIT)"
EXCLUDED_EXTENSIONS="$(parse_pin "$PINS" EXCLUDED_EXTENSIONS)"
EXCLUDED_MODULES="$(parse_pin "$PINS" EXCLUDED_MODULES)"
case "$VSCODE_VERSION" in *[!0-9.]* | '') die "VSCODE_VERSION must be digits and dots" ;; esac
[ "$VSCODE_TAG" = "$VSCODE_VERSION" ] || die "VSCODE_TAG must be $VSCODE_VERSION"
case "$VSCODE_TAG_COMMIT" in *[!0-9a-f]* | '') die "VSCODE_TAG_COMMIT must be a full lower-case commit id" ;; esac
[ "${#VSCODE_TAG_COMMIT}" -eq 40 ] || die "VSCODE_TAG_COMMIT must be 40 hex digits"
case "$VSCODE_REPO" in https://github.com/microsoft/vscode.git) ;; *) die "VSCODE_REPO must be https://github.com/microsoft/vscode.git" ;; esac
case "$NODE_BUILD_IMAGE_DIGEST" in sha256:????????????????????????????????????????????????????????????????) ;; *) die "NODE_BUILD_IMAGE_DIGEST must be sha256:<64 hex>" ;; esac
case "$APT_SNAPSHOT" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) die "APT_SNAPSHOT must look like 20260901T000000Z" ;; esac
case "$EXCLUDED_EXTENSIONS$EXCLUDED_MODULES" in *[!A-Za-z0-9@/,._-]*) die "EXCLUDED_EXTENSIONS and EXCLUDED_MODULES must be comma-separated names" ;; esac
IMAGE="node@$NODE_BUILD_IMAGE_DIGEST"
NODE_BASE="$(sed -n 's/^FROM \(node@sha256:[0-9a-f]\{64\}\).*/\1/p' "$VMAPP/runtimes/node22/Dockerfile" | head -n 1)"
[ -n "$NODE_BASE" ] || die "cannot read the node base image from runtimes/node22/Dockerfile"

WORK="${VMAPP_WORK:-$VMAPP/out/work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
SRC="$WORK/src/vscode"
BUILD="$WORK/build/vscode"
CACHE="$WORK/cache"
# the user's git configuration may name filters (git-lfs) the build does not need; the archive and the checkout must not run them
GIT=(git -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false -c core.hooksPath=/dev/null)

# ---- the VS Code source at the pinned commit -----------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  [ "$CHECK" -eq 0 ] || die "no clone at $SRC (build.sh clones $VSCODE_REPO there)"
  command -v git >/dev/null 2>&1 || need "git not found"
  mkdir -p "$(dirname "$SRC")"
  echo "== cloning $VSCODE_REPO at $VSCODE_TAG into $SRC (shallow)"
  "${GIT[@]}" clone --quiet --depth 1 --no-checkout --branch "$VSCODE_TAG" "$VSCODE_REPO" "$SRC" || die "clone failed"
fi
[ "$("${GIT[@]}" -C "$SRC" rev-parse "$VSCODE_TAG_COMMIT^{commit}" 2>/dev/null || true)" = "$VSCODE_TAG_COMMIT" ] || die "$SRC does not contain the pinned commit $VSCODE_TAG_COMMIT"
TAG_COMMIT="$("${GIT[@]}" -C "$SRC" rev-parse "refs/tags/$VSCODE_TAG^{commit}" 2>/dev/null || true)"
[ "$TAG_COMMIT" = "$VSCODE_TAG_COMMIT" ] || die "the tag $VSCODE_TAG in $SRC is $TAG_COMMIT, not the pinned $VSCODE_TAG_COMMIT"
[ "$("${GIT[@]}" -C "$SRC" show -s --format=%cI "$VSCODE_TAG_COMMIT")" = "$VSCODE_COMMIT_DATE" ] || die "the commit's date is not VSCODE_COMMIT_DATE"
[ "$("${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:LICENSE.txt" | sha256_stdin)" = "$VSCODE_LICENSE_SHA256" ] || die "VS Code's LICENSE.txt does not match VSCODE_LICENSE_SHA256"
[ "$("${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:.nvmrc" | tr -d '[:space:]')" = "${NODE_BUILD_IMAGE#node:}" ] || [ "$("${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:.nvmrc" | tr -d '[:space:]')-bookworm" = "${NODE_BUILD_IMAGE#node:}" ] || die "VS Code's .nvmrc does not name the Node of NODE_BUILD_IMAGE ($NODE_BUILD_IMAGE)"
grep -q "^target=\"$SERVER_NODE_VERSION\"\$" <("${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:remote/.npmrc") || die "remote/.npmrc's target is not SERVER_NODE_VERSION $SERVER_NODE_VERSION"
grep -q "^$SERVER_NODE_SHA256  node-v$SERVER_NODE_VERSION-linux-arm64.tar.gz\$" <("${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:build/checksums/nodejs.txt") || die "build/checksums/nodejs.txt does not have SERVER_NODE_SHA256 for node-v$SERVER_NODE_VERSION-linux-arm64.tar.gz"

PATCHES=("$HERE"/patches/*.patch)
for p in "${PATCHES[@]}"; do [ -f "$p" ] || die "missing patch $p"; done
TREE_STAMP="$( { echo "$VSCODE_TAG_COMMIT"; cat "${PATCHES[@]}" "$HERE/build/package-server.ts"; } | sha256_stdin | cut -c1-16)"
TREE="$BUILD/tree-$TREE_STAMP"

echo "== Code - OSS: VS Code $VSCODE_VERSION ($VSCODE_TAG_COMMIT), server Node $SERVER_NODE_VERSION, git $APT_GIT"
echo "   build image $NODE_BUILD_IMAGE ($IMAGE), git image ${NODE_BASE:0:24}…, source tree $TREE, caches $CACHE"
if [ "$CHECK" -eq 1 ]; then
  echo "   patches: $(for p in "${PATCHES[@]}"; do basename "$p"; done | tr '\n' ' ')"
  echo "   left out: extensions $EXCLUDED_EXTENSIONS; modules $EXCLUDED_MODULES"
  echo "pins are consistent and the clone is at the pinned commit (nothing was run)"
  exit 0
fi

command -v docker >/dev/null 2>&1 || need "docker not found (it is needed to build for linux-arm64)"
docker info >/dev/null 2>&1 || need "Docker is not running (start Docker Desktop and run this again)"
for t in git tar patch node; do command -v "$t" >/dev/null 2>&1 || need "$t not found"; done

free_check() { # refuses to start a Docker stage when the volume of Docker's disk image is nearly full
  [ "$MIN_FREE_GB" -gt 0 ] || return 0
  # Docker Desktop keeps its disk image on the internal disk; another engine (Lima, Colima, a remote DOCKER_HOST) says where its
  # data lives with VMAPP_DOCKER_DATA
  local vol="${VMAPP_DOCKER_DATA:-/System/Volumes/Data}" free_kb
  [ -d "$vol" ] || vol="$HOME"
  free_kb="$(df -Pk "$vol" | awk 'NR == 2 { print $4 }')"
  [ $((free_kb / 1024 / 1024)) -ge "$MIN_FREE_GB" ] || need "only $((free_kb / 1024 / 1024)) GB are free on $vol, where Docker keeps its disk image (--min-free-gb $MIN_FREE_GB). Free space and run this again."
}
ensure_image() { # the build image, pulled by digest when it is not there (never removed)
  local ref=$1
  if docker image inspect "$ref" >/dev/null 2>&1; then return 0; fi
  free_check
  echo "== pulling $ref"
  docker pull --platform linux/arm64 "$ref" >/dev/null || die "cannot pull $ref"
}

# ---- the patched source tree -------------------------------------------------------------------------------------------------
if [ ! -f "$TREE/.vmapp-tree-ok" ]; then
  echo "== source tree: git archive of $VSCODE_TAG_COMMIT, patches, build/vmapp-package-server.ts"
  mkdir -p "$BUILD"
  if [ -e "$TREE.part" ]; then mv "$TREE.part" "$TREE.part.$(date +%Y%m%d%H%M%S)"; fi # never deleted: moved aside
  mkdir -p "$TREE.part"
  "${GIT[@]}" -C "$SRC" archive --format=tar "$VSCODE_TAG_COMMIT" | tar -x -C "$TREE.part"
  for p in "${PATCHES[@]}"; do
    patch -p1 -d "$TREE.part" --dry-run -s <"$p" >/dev/null || die "patch does not apply: $(basename "$p")"
    patch -p1 -d "$TREE.part" -s <"$p" >/dev/null
    echo "   applied $(basename "$p")"
  done
  cp "$HERE/build/package-server.ts" "$TREE.part/build/vmapp-package-server.ts"
  : >"$TREE.part/.vmapp-tree-ok"
  if [ -e "$TREE" ]; then mv "$TREE" "$TREE.old.$(date +%Y%m%d%H%M%S)"; fi
  mv "$TREE.part" "$TREE"
fi

mkdir -p "$BUILD/stamps" "$BUILD/logs" "$BUILD/out-server" "$BUILD/out-git" "$CACHE/npm" "$CACHE/node-gyp"

stage_current() { # stage_current NAME STAMP: is the stage's output already built from these inputs?
  [ "$FORCE" -eq 0 ] && [ -f "$BUILD/stamps/$1" ] && [ "$(cat "$BUILD/stamps/$1")" = "$2" ]
}
run_stage() { # run_stage NAME LOG docker-args...: runs a stage container, keeps its log, stops the build with its tail on failure
  local name=$1 log="$BUILD/logs/$2.log"
  shift 2
  free_check
  docker run --rm --platform linux/arm64 "$@" >"$log" 2>&1 || { tail -n 40 "$log"; die "the $name stage failed (log: $log)"; }
  tail -n 8 "$log" | sed 's/^/   /'
}
DOCKER_SRC=(-v "$TREE:/src" -v "$CACHE/npm:/root/.npm" -v "$HERE/build:/stage:ro" -e "BUILD_SOURCEVERSION=$VSCODE_TAG_COMMIT")

# ---- stage: npm dependencies --------------------------------------------------------------------------------------------------------
INSTALL_STAMP="$( { echo "$TREE_STAMP $IMAGE $SERVER_NODE_VERSION"; cat "$HERE/build/install-stage.sh"; } | sha256_stdin)"
if [ -z "$ONLY" ] || [ "$ONLY" = install ]; then
  if stage_current install "$INSTALL_STAMP"; then
    echo "== install: up to date"
  else
    ensure_image "$IMAGE"
    echo "== install: npm ci (VS Code's lockfiles; native modules of the server for Node $SERVER_NODE_VERSION, linux-arm64)"
    run_stage install install "${DOCKER_SRC[@]}" -v "$CACHE/node-gyp:/root/.cache/node-gyp" -e "SERVER_NODE_VERSION=$SERVER_NODE_VERSION" "$IMAGE" sh /stage/install-stage.sh
    echo "$INSTALL_STAMP" >"$BUILD/stamps/install"
  fi
fi

# ---- stage: compile ------------------------------------------------------------------------------------------------------------------
COMPILE_STAMP="$( { echo "$INSTALL_STAMP $VSCODE_COMMIT_DATE $EXCLUDED_EXTENSIONS"; cat "$HERE/build/compile-stage.sh"; } | sha256_stdin)"
if [ -z "$ONLY" ] || [ "$ONLY" = compile ]; then
  if stage_current compile "$COMPILE_STAMP"; then
    echo "== compile: up to date"
  else
    stage_current install "$INSTALL_STAMP" || die "the install stage is not current: run build.sh without --only"
    ensure_image "$IMAGE"
    echo "== compile: built-in extensions, the server-web bundle (esbuild, minified)"
    run_stage compile compile "${DOCKER_SRC[@]}" -e "VSCODE_COMMIT_DATE=$VSCODE_COMMIT_DATE" -e "EXCLUDED_EXTENSIONS=$EXCLUDED_EXTENSIONS" "$IMAGE" sh /stage/compile-stage.sh
    echo "$COMPILE_STAMP" >"$BUILD/stamps/compile"
  fi
fi

# ---- stage: package the server ------------------------------------------------------------------------------------------------------
PACKAGE_STAMP="$( { echo "$COMPILE_STAMP $EXCLUDED_EXTENSIONS $EXCLUDED_MODULES"; cat "$HERE/build/package-stage.sh"; } | sha256_stdin)"
if [ -z "$ONLY" ] || [ "$ONLY" = package ]; then
  if stage_current package "$PACKAGE_STAMP" && [ -x "$BUILD/out-server/server/node" ] && [ -f "$BUILD/out-server/web/static/out/vs/code/browser/workbench/workbench.js" ]; then
    echo "== package: up to date"
  else
    stage_current compile "$COMPILE_STAMP" || die "the compile stage is not current: run build.sh without --only"
    ensure_image "$IMAGE"
    echo "== package: the server (core/vscode) and the web workbench (ui/static)"
    run_stage package package "${DOCKER_SRC[@]}" -v "$BUILD/out-server:/out" -e "EXCLUDED_EXTENSIONS=$EXCLUDED_EXTENSIONS" -e "EXCLUDED_MODULES=$EXCLUDED_MODULES" "$IMAGE" sh /stage/package-stage.sh
    echo "$PACKAGE_STAMP" >"$BUILD/stamps/package"
  fi
fi

# ---- stage: git -------------------------------------------------------------------------------------------------------------------------
GIT_STAMP="$( { echo "$NODE_BASE $APT_SNAPSHOT $APT_GIT"; cat "$HERE/build/git-stage.sh"; } | sha256_stdin)"
if [ -z "$ONLY" ] || [ "$ONLY" = git ]; then
  if stage_current git "$GIT_STAMP" && [ -e "$BUILD/out-git/git/bin/git" ]; then
    echo "== git: up to date"
  else
    ensure_image "$NODE_BASE"
    echo "== git: Debian bookworm's git $APT_GIT"
    run_stage git git -v "$BUILD/out-git:/out" -v "$HERE/build:/stage:ro" -e "APT_SNAPSHOT=$APT_SNAPSHOT" -e "APT_GIT=$APT_GIT" "$NODE_BASE" sh /stage/git-stage.sh
    echo "$GIT_STAMP" >"$BUILD/stamps/git"
  fi
fi

if [ -n "$ONLY" ]; then echo "done ($ONLY only; core/ and ui/ not assembled)"; exit 0; fi

# ---- assemble core/ and ui/ -----------------------------------------------------------------------------------------------------------
echo "== assembling core/ and ui/"
OUTSRV="$BUILD/out-server/server" OUTWEB="$BUILD/out-server/web" OUTGIT="$BUILD/out-git/git"
[ -x "$OUTSRV/node" ] && [ -f "$OUTWEB/static/out/vs/code/browser/workbench/workbench.js" ] && [ -e "$OUTGIT/bin/git" ] || die "a stage output is missing: run build.sh without --only"

aside() { # moves a folder out of the way (never deletes it): aside DIR
  if [ -e "$1" ] || [ -L "$1" ]; then
    mkdir -p "$BUILD/old"
    mv "$1" "$BUILD/old/$(basename "$1").$(date +%Y%m%d%H%M%S)"
  fi
}
STAGEDIR="$BUILD/assemble"
aside "$STAGEDIR"
mkdir -p "$STAGEDIR/core/bin" "$STAGEDIR/ui"
cp -R "$OUTSRV" "$STAGEDIR/core/vscode"
cp -R "$OUTGIT" "$STAGEDIR/core/git"
ln -s ../vscode/node "$STAGEDIR/core/bin/node"
ln -s ../git/bin/git "$STAGEDIR/core/bin/git"
cp "$VMAPP/sdk/node/http-bridge.js" "$STAGEDIR/core/http-bridge.js"

cp -R "$OUTWEB/static" "$STAGEDIR/ui/static"
cp "$HERE/shim/index.html" "$HERE/shim/vscode-vmapp-shim.js" "$STAGEDIR/ui/"
# the web worker extension host's page, in its isolated frame: at the path the workbench appends to webEndpointUrlTemplate (step 14)
mkdir -p "$STAGEDIR/ui/vmapp-exthost/out/vs/workbench/services/extensions/worker"
cp "$HERE/shim/exthost/webWorkerExtensionHostIframe.html" "$HERE/shim/exthost/exthost-frame.js" "$STAGEDIR/ui/vmapp-exthost/out/vs/workbench/services/extensions/worker/"
cp "$VMAPP/sdk/web/vmapp-fetch.js" "$STAGEDIR/ui/vmapp-fetch.js"
"${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:LICENSE.txt" >"$STAGEDIR/ui/LICENSE.vscode.txt"
"${GIT[@]}" -C "$SRC" show "$VSCODE_TAG_COMMIT:ThirdPartyNotices.txt" >"$STAGEDIR/ui/ThirdPartyNotices.vscode.txt"
node "$HERE/build/check-ui.mjs" "$STAGEDIR/ui" "$HERE/vmapp.json" || die "the UI does not meet the Content-Security-Policy (see above)"

{
  echo "VS Code $VSCODE_VERSION (tag $VSCODE_TAG, commit $VSCODE_TAG_COMMIT, $VSCODE_COMMIT_DATE), reh-web for linux-arm64, built from source"
  echo "patches: $(for p in "${PATCHES[@]}"; do printf '%s %s; ' "$(basename "$p")" "$(sha256_of "$p" | cut -c1-12)"; done)"
  echo "build image: $NODE_BUILD_IMAGE ($IMAGE); server Node $SERVER_NODE_VERSION (tarball sha256 $SERVER_NODE_SHA256)"
  echo "left out: extensions $EXCLUDED_EXTENSIONS; modules $EXCLUDED_MODULES"
  echo "node sha256 $(sha256_of "$STAGEDIR/core/vscode/node"); server-main.js sha256 $(sha256_of "$STAGEDIR/core/vscode/out/server-main.js"); workbench.js sha256 $(sha256_of "$STAGEDIR/ui/static/out/vs/code/browser/workbench/workbench.js")"
  cat "$BUILD/out-git/git-stage.txt"
} >"$STAGEDIR/core/vscode/BUILD-INFO.txt"

# core/main.js and core/ws-bridge.js are source; the generated parts of core/ and the whole ui/ are replaced (the old ones are moved aside)
mkdir -p "$HERE/core"
aside "$HERE/core/vscode"
aside "$HERE/core/git"
aside "$HERE/core/bin"
aside "$HERE/core/http-bridge.js"
aside "$HERE/ui"
mv "$STAGEDIR/core/vscode" "$HERE/core/vscode"
mv "$STAGEDIR/core/git" "$HERE/core/git"
mv "$STAGEDIR/core/bin" "$HERE/core/bin"
mv "$STAGEDIR/core/http-bridge.js" "$HERE/core/http-bridge.js"
mv "$STAGEDIR/ui" "$HERE/ui"

echo
echo "done. core/: $(du -sk "$HERE/core" | awk '{print int($1 / 1024)}') MiB, ui/: $(du -sk "$HERE/ui" | awk '{print int($1 / 1024)}') MiB, $(find "$HERE/ui" -type f | wc -l | tr -d ' ') UI files."
echo "Next: tools/vmapp pack apps/vscode -o vscode.vmapp"
