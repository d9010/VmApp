#!/bin/sh
# fetch-kernel.sh - obtain and cryptographically verify a Linux release tarball, then extract it.
# Runs INSIDE the kernel build container.
#
# Adapted from d9010-native/tools/build-rootfs/container/fetch-kernel.sh. Difference: the tarball, its signatures
# and the signing keys may be supplied from a host-side cache (/ctx/dl, staged by kernel/build.sh); anything that
# is missing there is downloaded. The verification is identical either way.
#
# usage: fetch-kernel.sh VERSION URL_BASE SHA256 FPR_AUTOSIGNER FPR_GREGKH FPR_TORVALDS DEST EVIDENCE
#
# Verification chain (any failure aborts the build):
#   1. The OpenPGP keys (from the cache, else kernel.org's Web Key Directory) must form a keyring with exactly the
#      three pinned primary-key fingerprints (pins.env), nothing else.
#   2. sha256sums.asc must carry a valid signature by the pinned autosigner key.
#   3. The signed checksum line for linux-VERSION.tar.xz must equal both the sha256 pinned in pins.env and the
#      sha256 of the tarball.
#   4. linux-VERSION.tar.sign (detached, over the uncompressed tar) must verify against the decompressed tarball,
#      signed by gregkh or torvalds.
# Trust root: the three fingerprints committed in pins.env. The cache, WKD and HTTPS are only transports for the
# key material and the files; a substituted key or file would not match.
#
# Outputs: DEST/linux-VERSION/ (the source), EVIDENCE (a report), and next to EVIDENCE kernel-keys.gpg (the verified
# public keys, so that kernel/build.sh can cache them).

set -eu

if [ $# -ne 8 ]; then
    echo "usage: fetch-kernel.sh VERSION URL_BASE SHA256 FPR_AUTOSIGNER FPR_GREGKH FPR_TORVALDS DEST EVIDENCE" >&2
    exit 2
fi
version=$1
url_base=$2
want_sha=$3
fpr_auto=$4
fpr_greg=$5
fpr_linus=$6
dest=$7
evidence=$8
cache=/ctx/dl

case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
        echo "fetch-kernel: bad version: $version" >&2
        exit 2
        ;;
esac

work=$(mktemp -d /tmp/fetch-kernel.XXXXXX)
cleanup() {
    case "$work" in
        /tmp/fetch-kernel.*) rm -rf -- "$work" ;;
    esac
}
trap cleanup EXIT
cd "$work"
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"

tarball="linux-${version}.tar.xz"
log() { printf 'fetch-kernel: %s\n' "$*"; }
die() {
    printf 'fetch-kernel: FATAL: %s\n' "$*" >&2
    exit 1
}

# fetch NAME [OUTNAME]: from the cache when present, else from the mirror.
fetch() {
    name=$1
    out=${2:-$1}
    if [ -s "$cache/$name" ]; then
        cp "$cache/$name" "$out"
        log "using cached $name"
    else
        log "downloading $name"
        curl -fsSL --retry 5 --retry-delay 3 -o "$out" "${url_base}/${name}"
    fi
}

fetch "$tarball"
fetch "linux-${version}.tar.sign"
fetch sha256sums.asc

# --- 1. keys -----------------------------------------------------------------
if [ -s "$cache/keys.gpg" ]; then
    log "importing the cached signing keys"
    gpg --batch --quiet --import "$cache/keys.gpg" 2>"$work/import.err" ||
        {
            cat "$work/import.err" >&2
            die "could not import the cached signing keys"
        }
else
    log "fetching signing keys via kernel.org WKD"
    gpg --batch --quiet --auto-key-locate clear,nodefault,wkd --locate-keys \
        autosigner@kernel.org gregkh@kernel.org torvalds@kernel.org >/dev/null 2>"$work/locate.err" ||
        {
            cat "$work/locate.err" >&2
            die "could not fetch signing keys"
        }
fi
gpg --batch --with-colons --list-keys |
    awk -F: '/^pub:/ { p = 1; next } /^fpr:/ && p { print $10; p = 0 }' | sort >"$work/have.fprs"
printf '%s\n%s\n%s\n' "$fpr_auto" "$fpr_greg" "$fpr_linus" | sort >"$work/want.fprs"
if ! cmp -s "$work/have.fprs" "$work/want.fprs"; then
    echo "expected primary fingerprints:" >&2
    cat "$work/want.fprs" >&2
    echo "fetched primary fingerprints:" >&2
    cat "$work/have.fprs" >&2
    die "key set does not match the pinned fingerprints"
fi
log "keyring matches the 3 pinned fingerprints"

# Return success if the status file shows exactly one good, valid signature made
# by one of the given primary-key fingerprints.
check_status() {
    status=$1
    shift
    if grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY)' "$status"; then
        return 1
    fi
    grep -q '^\[GNUPG:\] GOODSIG ' "$status" || return 1
    primary=$(awk '$2 == "VALIDSIG" { print $NF }' "$status")
    [ -n "$primary" ] || return 1
    for allowed in "$@"; do
        if [ "$primary" = "$allowed" ]; then
            printf '%s\n' "$primary"
            return 0
        fi
    done
    return 1
}

# --- 2. signed checksum list ---------------------------------------------------
gpg --batch --status-fd 3 --verify sha256sums.asc 3>"$work/sums.status" 2>"$work/sums.err" ||
    {
        cat "$work/sums.err" >&2
        die "sha256sums.asc signature verification failed"
    }
signer_sums=$(check_status "$work/sums.status" "$fpr_auto") ||
    die "sha256sums.asc is not signed by the pinned autosigner key"
log "sha256sums.asc: valid signature by ${signer_sums}"

# Use the verified plaintext only (not the raw clearsigned file).
gpg --batch --yes --output sha256sums.verified --decrypt sha256sums.asc 2>/dev/null ||
    die "could not extract the verified checksum list"
signed_line=$(awk -v f="$tarball" '$2 == f { print $1 }' sha256sums.verified)
[ -n "$signed_line" ] || die "no signed checksum for $tarball"
if [ "$(printf '%s\n' "$signed_line" | wc -l | tr -d ' ')" != "1" ]; then
    die "multiple signed checksums for $tarball"
fi

# --- 3. checksum ----------------------------------------------------------------
got_sha=$(sha256sum "$tarball" | awk '{ print $1 }')
[ "$signed_line" = "$want_sha" ] ||
    die "pinned sha256 ($want_sha) differs from the signed checksum list ($signed_line)"
[ "$got_sha" = "$want_sha" ] ||
    die "$tarball has sha256 $got_sha, expected $want_sha"
log "$tarball sha256 ok: $got_sha"

# --- 4. detached signature over the uncompressed tar ------------------------------
xz -dc "$tarball" >"linux-${version}.tar"
gpg --batch --status-fd 3 --verify "linux-${version}.tar.sign" "linux-${version}.tar" \
    3>"$work/tar.status" 2>"$work/tar.err" ||
    {
        cat "$work/tar.err" >&2
        die "linux-${version}.tar.sign verification failed"
    }
signer_tar=$(check_status "$work/tar.status" "$fpr_greg" "$fpr_linus") ||
    die "linux-${version}.tar is not signed by a pinned kernel release key"
log "linux-${version}.tar.sign: valid signature by ${signer_tar}"

# --- extract ------------------------------------------------------------------------
mkdir -p "$dest"
tar -xf "linux-${version}.tar" -C "$dest" --no-same-owner --no-same-permissions
[ -f "$dest/linux-${version}/Makefile" ] || die "unexpected tarball layout"

mkdir -p "$(dirname "$evidence")"
gpg --batch --export >"$(dirname "$evidence")/kernel-keys.gpg"
{
    echo "kernel source verification (container/fetch-kernel.sh)"
    echo "version:               ${version}"
    echo "tarball:               ${url_base}/${tarball}"
    echo "tarball sha256:        ${got_sha}"
    echo "pinned sha256:         ${want_sha}"
    echo "signed sha256 line:    ${signed_line}  ${tarball}"
    echo "sha256sums.asc signer: ${signer_sums}"
    echo "tar.sign signer:       ${signer_tar}"
    echo "pinned fingerprints:   autosigner=${fpr_auto} gregkh=${fpr_greg} torvalds=${fpr_linus}"
} >"$evidence"
log "verified and extracted to $dest/linux-${version}"
