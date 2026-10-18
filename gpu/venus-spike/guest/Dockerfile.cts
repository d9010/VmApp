# Vulkan CTS (Khronos VK-GL-CTS, dEQP-VK) for linux-arm64, built in the same Debian trixie as the spike rootfs.
# The result is NOT put in the rootfs image (it is large); guest/build-cts.sh exports it to $VMAPP_WORK/cts/ and the
# launcher shares that folder read-only into the VM (virtiofs tag "cts"). Research only.
#
# Pinned: vulkan-cts-1.4.4.0 (same CTS version family MoltenVK 1.4.x was submitted against: the host reports
# conformanceVersion 1.4.4.0).

ARG DEBIAN_IMAGE=debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5

FROM ${DEBIAN_IMAGE} AS cts-build
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build git ca-certificates python3 pkgconf \
        libvulkan-dev zlib1g-dev libpng-dev libxcb1-dev libx11-dev libwayland-dev wayland-protocols \
    && rm -rf /var/lib/apt/lists/*
ARG CTS_TAG=vulkan-cts-1.4.4.0
# (annotated tag; tag object bdc1d69d2f56c9db24a34b5845d83319240e40dd peels to this commit)
ARG CTS_COMMIT=03c0746a55b78eab63c664a11948b52419e1f309
RUN git clone --depth 1 --branch ${CTS_TAG} https://github.com/KhronosGroup/VK-GL-CTS.git /src/cts \
    && test "$(git -C /src/cts rev-parse HEAD)" = "${CTS_COMMIT}"
# fetch_sources.py clones the pinned glslang / SPIRV-Tools / SPIRV-Headers / Vulkan-Docs / jsoncpp / ... revisions
RUN cd /src/cts && python3 external/fetch_sources.py
# vulkan_headless: Vulkan only, no window system / GL / EGL (the VM has none)
RUN cd /src/cts && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DDEQP_TARGET=vulkan_headless \
        -DSELECTED_BUILD_TARGETS="deqp-vk" \
    && cmake --build build --target deqp-vk -j"$(nproc)"
# Everything deqp-vk needs at run time: the binary + its data folders, plus the official mustpass lists.
RUN mkdir -p /out/cts && cp -a /src/cts/build/external/vulkancts/modules/vulkan/. /out/cts/ \
    && mkdir -p /out/cts/mustpass && cp -a /src/cts/external/vulkancts/mustpass/main/vk-default/. /out/cts/mustpass/ \
    && ls /out/cts | head -30

FROM scratch AS cts-out
COPY --from=cts-build /out/cts/ /
