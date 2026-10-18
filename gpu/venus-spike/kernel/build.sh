#!/usr/bin/env bash
# Builds the SPIKE guest kernel: vmapp's pinned kernel/ inputs (same Dockerfile, container scripts, pins,
# verified source) with kernel/vmapp-guest.config + gpu/venus-spike/kernel/spike-gpu.config merged, and the spike's own
# required/forbidden lists (DRM allowed). Output goes to $VMAPP_WORK/kernel-gs/out, NEVER to vmapp/out/Image.
#
#   VMAPP_WORK=/abs/scratch gpu/venus-spike/kernel/build.sh [--config-only]
#
# Needs Docker. Reuses the verified kernel tarball from the main build's cache when present (it is verified again
# inside the build container against the pinned sha256 and kernel.org's PGP signatures).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KDIR="$(cd "$HERE/../../../kernel" && pwd)"
WORK="${VMAPP_WORK:?set VMAPP_WORK to an absolute scratch folder}"
BASE="$WORK/kernel-gs"
CTX="$BASE/ctx"
OUT="$BASE/out"
CACHE="$WORK/cache/kernel"
MAIN_CACHE="${VMAPP_MAIN_KERNEL_CACHE:-$KDIR/../out/work/cache/kernel}"
CONFIG_ONLY=0
PATCHED=0
for a in "$@"; do
    case "$a" in
        --config-only) CONFIG_ONLY=1 ;;
        --patched) PATCHED=1; OUT="$BASE/out-patched" ;;   # apply kernel/patches/*.patch (Dockerfile.patched)
        *) echo "usage: build.sh [--config-only] [--patched]" >&2; exit 2 ;;
    esac
done

die() { echo "gpu/venus-spike/kernel/build.sh: $*" >&2; exit 1; }

# pins.env is plain KEY=VALUE (no expansion): parse without sourcing.
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}; val=${line#*=}
    [[ $key =~ ^[A-Z_0-9]+$ ]] || die "bad pins.env line: $line"
    printf -v "$key" '%s' "$val"
done <"$KDIR/pins.env"

mkdir -p "$CTX/container" "$CTX/dl" "$OUT" "$CACHE" "$BASE/logs"
for f in tar.xz tar.sign; do
    src="$MAIN_CACHE/linux-$KERNEL_VERSION.$f"
    [ -s "$CACHE/linux-$KERNEL_VERSION.$f" ] || { [ -s "$src" ] && cp -c "$src" "$CACHE/" ; } || true
done
[ -s "$MAIN_CACHE/sha256sums.asc" ] && [ ! -s "$CACHE/sha256sums.asc" ] && cp -c "$MAIN_CACHE/sha256sums.asc" "$CACHE/" || true
[ -s "$MAIN_CACHE/keys.gpg" ] && [ ! -s "$CACHE/keys.gpg" ] && cp -c "$MAIN_CACHE/keys.gpg" "$CACHE/" || true
if [ ! -s "$CACHE/linux-$KERNEL_VERSION.tar.xz" ]; then
    for f in "linux-$KERNEL_VERSION.tar.xz" "linux-$KERNEL_VERSION.tar.sign" sha256sums.asc; do
        curl -fsSL --retry 5 -o "$CACHE/$f" "$KERNEL_URL_BASE/$f"
    done
fi
got=$(shasum -a 256 "$CACHE/linux-$KERNEL_VERSION.tar.xz" | awk '{print $1}')
[ "$got" = "$KERNEL_SHA256" ] || die "kernel tarball sha256 $got != pinned $KERNEL_SHA256"

# build context = exactly what kernel/build.sh stages, except the config (+ spike overlay) and the two lists
cp "$KDIR"/container/*.sh "$CTX/container/"
cat "$KDIR/vmapp-guest.config" "$HERE/spike-gpu.config" >"$CTX/vmapp-guest.config"
cp "$HERE/kconfig-required.txt" "$HERE/kconfig-forbidden.txt" "$CTX/"
cp "$KDIR/check-kconfig.sh" "$CTX/"
for f in "$CACHE"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.part.*) continue ;; esac
    ln -f "$f" "$CTX/dl/$(basename "$f")" 2>/dev/null || cp "$f" "$CTX/dl/$(basename "$f")"
done

target=kernel-out
[ "$CONFIG_ONLY" = 1 ] && target=kernel-config-out
dockerfile="$KDIR/Dockerfile"
if [ "$PATCHED" = 1 ]; then
    dockerfile="$HERE/Dockerfile.patched"
    mkdir -p "$CTX/patches" "$OUT"
    cp "$HERE"/patches/*.patch "$CTX/patches/"
fi
args=(buildx build --platform linux/arm64 --provenance=false --sbom=false --progress=plain
    -f "$dockerfile" --target "$target" --output "type=local,dest=$OUT"
    --build-arg "UBUNTU_SNAPSHOT=$UBUNTU_SNAPSHOT" --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
    --build-arg "KERNEL_VERSION=$KERNEL_VERSION" --build-arg "KERNEL_URL_BASE=$KERNEL_URL_BASE"
    --build-arg "KERNEL_SHA256=$KERNEL_SHA256" --build-arg "KERNEL_FPR_AUTOSIGNER=$KERNEL_FPR_AUTOSIGNER"
    --build-arg "KERNEL_FPR_GREGKH=$KERNEL_FPR_GREGKH" --build-arg "KERNEL_FPR_TORVALDS=$KERNEL_FPR_TORVALDS"
    --build-arg "KBUILD_BUILD_USER=$KBUILD_BUILD_USER" --build-arg "KBUILD_BUILD_HOST=$KBUILD_BUILD_HOST" "$CTX")
echo "==> spike kernel $KERNEL_VERSION$KERNEL_LOCALVERSION, target $target (log: $BASE/logs/kernel.log)"
docker "${args[@]}" >"$BASE/logs/kernel.log" 2>&1 || { tail -n 70 "$BASE/logs/kernel.log" >&2; die "docker build failed"; }
ls -la "$OUT"
[ -f "$OUT/kconfig-check.txt" ] && tail -n 12 "$OUT/kconfig-check.txt"
true
