# Build toolchain for Ollama (Desktop): Go for Ollama's own programs, cmake + ninja + gcc for the llama.cpp runners.
#
# NOT meant to be run by hand: apps/ollama-desktop/build.sh builds this image (tag vmapp-ollama-desktop-build:<hash of this file and the pins>)
# and then runs the stage scripts of this folder (go-stage.sh, runner-stage.sh) in containers of it, with the sources and the caches
# bind-mounted from $VMAPP_WORK. Nothing in this file runs on the host.
#
# Why a golang image: Ollama v0.35.0's go.mod asks for Go 1.26.0 and its own Dockerfile downloads the Go release that go.mod names. The
# official golang image is the same compiler as a pinned, digest-addressed base. Why trixie: the app runs on runtime node22-gpu (Debian
# trixie), and the CPU runners need a compiler that knows -march=armv9.2-a (GCC 13 or newer: trixie has 14.2, bookworm's 12.2 stops
# the build at the armv9.2 variants). Everything built here links glibc 2.41, as the runtime has. golang:1.26.7 is the newest patch
# release that is at least 14 days old on 2026-10-15 (1.26.8 and 1.26.9 are younger).
#
# Reproducibility: the Debian packages come from snapshot.debian.org at the date this image itself documents in its apt sources
# (20260824T000000Z), at the exact versions of pins.env (passed as build arguments). The Ollama source is the tag commit of pins.env.
FROM golang@sha256:978084e7adea0904b6d76cbc9afcb9baeed6ee170eecdc8866566aaa9f22ad0c
ARG DEBIAN_FRONTEND=noninteractive
ARG APT_SNAPSHOT
ARG APT_CMAKE
ARG APT_NINJA_BUILD
RUN set -eu; \
    for v in "${APT_SNAPSHOT}" "${APT_CMAKE}" "${APT_NINJA_BUILD}"; do \
        [ -n "$v" ] || { echo "a build argument is empty: run apps/ollama-desktop/build.sh" >&2; exit 2; }; \
    done; \
    sed -i \
      -e "s|^URIs: http://deb.debian.org/debian-security\$|URIs: http://snapshot.debian.org/archive/debian-security/${APT_SNAPSHOT}|" \
      -e "s|^URIs: http://deb.debian.org/debian\$|URIs: http://snapshot.debian.org/archive/debian/${APT_SNAPSHOT}|" \
      /etc/apt/sources.list.d/debian.sources; \
    test "$(grep -c '^URIs: http://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources)" = 2; \
    printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\n' > /etc/apt/apt.conf.d/99vmapp-snapshot; \
    apt-get update; \
    apt-get install -y --no-install-recommends "cmake=${APT_CMAKE}" "ninja-build=${APT_NINJA_BUILD}"; \
    rm -rf /var/lib/apt/lists/*
ENV CGO_ENABLED=1 CMAKE_GENERATOR=Ninja GOFLAGS=-mod=readonly
WORKDIR /src
