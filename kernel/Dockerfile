# vmapp guest kernel: Linux 6.18.y for macOS arm64 (Virtualization.framework).
#
# Adapted from d9010-native/guest/distro/kernel/Dockerfile
#
# Native linux/arm64 build (no cross compiler) FROM the digest-pinned Ubuntu.
# Not meant to be run by hand: kernel/build.sh stages the build context (container/*.sh, the config fragment, the
# required/forbidden lists, check-kconfig.sh, patches/, the cached downloads in dl/) and passes the pins from
# kernel/pins.env as build args. For a kernel flavour (kernel/flavours/NAME/) the fragment and the lists are the
# common ones plus the flavour's additions, and patches/ holds the flavour's source patches; otherwise patches/ is empty.
#
# Targets:
#   kernel-config-raw  config only, no check: allnoconfig + fragment, olddefconfig (kernel.config and its logs)
#   kernel-config-out  the same plus the check (fast; fails on any deviation from the required/forbidden lists)
#   kernel-out         full build: Image, kernel.config, kernel.release, licences, plus the passing
#                      kconfig-check.txt and the source-verification evidence
#
# No `# syntax=` directive on purpose: the BuildKit-bundled frontend is used, so the build does not pull an
# unpinned frontend image.

# The base image is repeated literally here (INV-F2: pinned by digest, mechanically checked by
# tools/check-invariants). It must equal UBUNTU_IMAGE@UBUNTU_DIGEST of pins.env; kernel/build.sh fails if the two
# ever disagree.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS kernel-toolchain
ARG UBUNTU_SNAPSHOT
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C TZ=UTC
COPY container/apt-snapshot.sh /opt/vmapp-build/apt-snapshot.sh
RUN sh /opt/vmapp-build/apt-snapshot.sh "${UBUNTU_SNAPSHOT}" "main" \
 && apt-get install -y --no-install-recommends \
        build-essential bc bison flex libssl-dev libelf-dev gawk python3 \
        xz-utils curl ca-certificates gnupg dirmngr \
 && rm -rf /var/lib/apt/lists/*

# Download (or take from the host cache in dl/) + verify (sha256, PGP chain) + extract. Fails the build on any
# mismatch.
FROM kernel-toolchain AS kernel-source
ARG KERNEL_VERSION
ARG KERNEL_URL_BASE
ARG KERNEL_SHA256
ARG KERNEL_FPR_AUTOSIGNER
ARG KERNEL_FPR_GREGKH
ARG KERNEL_FPR_TORVALDS
COPY container/fetch-kernel.sh /opt/vmapp-build/fetch-kernel.sh
RUN --mount=type=bind,source=dl,target=/ctx/dl \
    sh /opt/vmapp-build/fetch-kernel.sh \
        "${KERNEL_VERSION}" "${KERNEL_URL_BASE}" "${KERNEL_SHA256}" \
        "${KERNEL_FPR_AUTOSIGNER}" "${KERNEL_FPR_GREGKH}" "${KERNEL_FPR_TORVALDS}" \
        /build /out/kernel-source-verification.txt

# A kernel flavour's patches (kernel/flavours/NAME/patches/*.patch, which kernel/build.sh stages as patches/ in the
# build context) are applied to the verified source before the config is made. The default flavour has none: the
# folder is empty, this stage changes nothing, and the kernel is built from the source exactly as released.
FROM kernel-source AS kernel-patched
ARG KERNEL_VERSION
COPY container/apply-patches.sh /opt/vmapp-build/apply-patches.sh
COPY patches/ /ctx/patches/
RUN sh /opt/vmapp-build/apply-patches.sh "${KERNEL_VERSION}" /ctx/patches /out/kernel-patches.txt

# allnoconfig + fragment -> olddefconfig. The fragment is the only input of the compile.
FROM kernel-patched AS kernel-config
ARG KERNEL_VERSION
COPY container/kernel-config.sh /opt/vmapp-build/kernel-config.sh
COPY vmapp-guest.config /ctx/vmapp-guest.config
RUN sh /opt/vmapp-build/kernel-config.sh "${KERNEL_VERSION}" /out

# Required/forbidden check of the final .config (build fails on any deviation). It is deliberately NOT a parent of
# kernel-build, so editing the lists never re-runs the compile; both exported targets below copy its report, so
# they cannot be produced without it passing.
FROM kernel-config AS kernel-check
ARG KERNEL_VERSION
COPY container/kernel-check.sh /opt/vmapp-build/kernel-check.sh
COPY kconfig-required.txt kconfig-forbidden.txt check-kconfig.sh /ctx/
RUN sh /opt/vmapp-build/kernel-check.sh "${KERNEL_VERSION}" /out

FROM kernel-config AS kernel-build
ARG KERNEL_VERSION
ARG SOURCE_DATE_EPOCH
ARG KBUILD_BUILD_USER
ARG KBUILD_BUILD_HOST
COPY container/kernel-build.sh /opt/vmapp-build/kernel-build.sh
RUN sh /opt/vmapp-build/kernel-build.sh "${KERNEL_VERSION}" /out

# The merged config and its logs, without the check (for looking at a config that fails it).
FROM scratch AS kernel-config-raw
COPY --from=kernel-config /out/ /

FROM scratch AS kernel-config-out
COPY --from=kernel-config /out/ /
COPY --from=kernel-check /out/kconfig-check.txt /kconfig-check.txt

FROM scratch AS kernel-out
COPY --from=kernel-build /out/ /
COPY --from=kernel-check /out/kconfig-check.txt /kconfig-check.txt
