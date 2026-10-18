#!/bin/sh
# apt-snapshot.sh - point apt at a pinned Ubuntu archive snapshot, then `apt-get update`.
# Runs INSIDE the build container only (never on the host).
#
# Adapted from d9010-native/tools/build-rootfs/container/apt-snapshot.sh
#
# usage: apt-snapshot.sh SNAPSHOT_TIMESTAMP "COMPONENTS"
#   SNAPSHOT_TIMESTAMP  e.g. 20261010T000000Z (UBUNTU_SNAPSHOT in kernel/pins.env)
#   COMPONENTS          e.g. "main" or "main universe"
#
# Why a snapshot: `apt-get install` against the live archive changes over time, which would make the build
# toolchain (and so the kernel bytes) unreproducible. snapshot.ubuntu.com serves the archive exactly as it was at
# the timestamp, including noble-updates and noble-security, with the original archive-signed InRelease files,
# which apt still verifies against ubuntu-archive-keyring.
#
# TLS note: the pristine ubuntu:24.04 image has no CA bundle, and the snapshot service redirects http to https. The
# first update therefore runs without TLS peer verification purely as a bootstrap for the ca-certificates package;
# this does not weaken integrity because apt authenticates the signed Release/Packages indexes (GPG) and every .deb
# (SHA-256 from the signed index) independently of the transport. Every later apt call verifies TLS normally.

set -eu

if [ $# -ne 2 ]; then
    echo "usage: apt-snapshot.sh SNAPSHOT_TIMESTAMP COMPONENTS" >&2
    exit 2
fi
snapshot=$1
components=$2

case "$snapshot" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *)
        echo "apt-snapshot: bad snapshot timestamp: $snapshot" >&2
        exit 2
        ;;
esac
case "$components" in
    *[!a-z\ ]* | '')
        echo "apt-snapshot: bad component list: $components" >&2
        exit 2
        ;;
esac

export DEBIAN_FRONTEND=noninteractive

cat >/etc/apt/sources.list.d/ubuntu.sources <<EOF
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/${snapshot}
Suites: noble noble-updates noble-security
Components: ${components}
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

# A snapshot is frozen by definition: its Release files may be "expired".
cat >/etc/apt/apt.conf.d/99vmapp-build <<'EOF'
Acquire::Retries "5";
Acquire::Check-Valid-Until "false";
APT::Install-Recommends "false";
APT::Install-Suggests "false";
EOF

# Bootstrap CA certificates (see TLS note above).
if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
    apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update
    apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false \
        install -y --no-install-recommends ca-certificates
    rm -rf /var/lib/apt/lists/*
fi

apt-get update
