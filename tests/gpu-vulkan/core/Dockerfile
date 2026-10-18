# Test core for the EXPERIMENTAL Vulkan GPU backend (tests/gpu-vulkan): the Vulkan test tools, built on the SAME Debian trixie base
# and apt snapshot as runtime "node22-gpu" (runtimes/node22-gpu), so their ABI matches the runtime's libraries. Only /app is
# exported (stage `app`); tests/gpu-vulkan/build-core.sh packs it into out/test/gpu-vulkan-core.cpio.
#
# Recipes follow gpu/venus-spike/guest/Dockerfile (pins and flags as tested there):
#   vulkaninfo   Vulkan-Tools v1.4.309 (same version as the loader in trixie), built WITHOUT X11/Wayland support (no extra libraries)
#   vkpeak       nihui/vkpeak 20260527, Vulkan compute throughput and copy bandwidth
#   llama-bench  llama.cpp b11669 with the Vulkan backend
#   vk-spin, vk-offscreen-tri   the spike's own tools (tools/*; INV-G4 headers in the sources)
#
# Layout of /app:
#   gpu-test.sh                   the entry (modes: info, vkpeak, llama, spin, tri)
#   bin/                          vulkaninfo vkpeak vk-spin vk-offscreen-tri and the shaders they load (*.spv)
#   llama/                        llama-bench and its shared libraries (libllama, libggml*); their RUNPATH is the build folder, so
#                                 gpu-test.sh runs llama-bench with LD_LIBRARY_PATH=/app/llama
# Everything links only against libraries the runtime has (libvulkan.so.1, libstdc++, libgcc_s, libgomp, libm, libc).

# node:22-trixie-slim (linux/arm64, glibc), pinned by digest. The same digest and apt snapshot as runtimes/node22-gpu.
FROM node@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS base
ARG DEBIAN_FRONTEND=noninteractive
RUN sed -i \
      -e 's|^URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/20261005T000000Z|' \
      -e 's|^URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/20261005T000000Z|' \
      /etc/apt/sources.list.d/debian.sources \
 && test "$(grep -c '^URIs: http://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources)" = 2 \
 && printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\n' > /etc/apt/apt.conf.d/99vmapp-snapshot

FROM base AS buildbase
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build git ca-certificates pkgconf python3 \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------------------------- vulkaninfo
FROM buildbase AS vulkaninfo
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan-dev \
    && rm -rf /var/lib/apt/lists/*
# volk (the loader shim Vulkan-Tools requires), the release that matches the Vulkan headers in trixie (1.4.309).
ARG VOLK_TAG=vulkan-sdk-1.4.309.0
ARG VOLK_COMMIT=58689c063427f5bad4f133625049b1a3c5dd8287
RUN git clone --depth 1 --branch ${VOLK_TAG} https://github.com/zeux/volk.git /src/volk \
    && test "$(git -C /src/volk rev-parse HEAD)" = "${VOLK_COMMIT}" \
    && cmake -S /src/volk -B /src/volk/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DVOLK_INSTALL=ON -DVOLK_PULL_IN_VULKAN=OFF \
        -DCMAKE_INSTALL_PREFIX=/opt/volk \
    && cmake --build /src/volk/build && cmake --install /src/volk/build
ARG VKTOOLS_TAG=v1.4.309
ARG VKTOOLS_COMMIT=176fef0bccaba8bdf51de54ab4eed8d5d9aaac77
RUN git clone --depth 1 --branch ${VKTOOLS_TAG} https://github.com/KhronosGroup/Vulkan-Tools.git /src/vulkan-tools \
    && test "$(git -C /src/vulkan-tools rev-parse HEAD)" = "${VKTOOLS_COMMIT}"
RUN cmake -S /src/vulkan-tools -B /src/vulkan-tools/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/opt/volk \
        -DBUILD_CUBE=OFF -DBUILD_ICD=OFF -DBUILD_TESTS=OFF \
        -DBUILD_WSI_XCB_SUPPORT=OFF -DBUILD_WSI_XLIB_SUPPORT=OFF -DBUILD_WSI_WAYLAND_SUPPORT=OFF \
    && cmake --build /src/vulkan-tools/build -j"$(nproc)" \
    && strip /src/vulkan-tools/build/vulkaninfo/vulkaninfo

# ---------------------------------------------------------------------------------------------- llama.cpp
FROM buildbase AS llama
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        libvulkan-dev glslc spirv-headers libgomp1 \
    && rm -rf /var/lib/apt/lists/*
ARG LLAMA_TAG=b11669
ARG LLAMA_COMMIT=620d2225cc436ab0b001e3200e590e3b286ef9ab
RUN git clone --depth 1 --branch ${LLAMA_TAG} https://github.com/ggml-org/llama.cpp.git /src/llama.cpp \
    && test "$(git -C /src/llama.cpp rev-parse HEAD)" = "${LLAMA_COMMIT}"
# One arm64 baseline: ARMv8.6-A with dotprod + i8mm (Apple M-series), no -march=native, so the Docker build host's CPU does not leak
# into the binary (the spike's flags).
ARG CPU_FLAGS="-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.6-a+dotprod+i8mm+fp16"
RUN cd /src/llama.cpp \
    && cmake -S . -B build-vk -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON ${CPU_FLAGS} \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF \
    && cmake --build build-vk --target llama-bench -j"$(nproc)" \
    && find build-vk/bin -type f -exec strip --strip-unneeded {} +

# ---------------------------------------------------------------------------------------------- vkpeak
FROM buildbase AS vkpeak
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan-dev \
    && rm -rf /var/lib/apt/lists/*
ARG VKPEAK_TAG=20260527
ARG VKPEAK_COMMIT=f108eb11d467eb3d5cdd472f8e080818a117a752
RUN git clone --branch ${VKPEAK_TAG} https://github.com/nihui/vkpeak.git /src/vkpeak \
    && cd /src/vkpeak && test "$(git rev-parse HEAD)" = "${VKPEAK_COMMIT}" \
    && git submodule update --init --recursive --depth 1
RUN cd /src/vkpeak && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)" \
    && strip build/vkpeak

# ---------------------------------------------------------------------------------------------- our test tools
FROM buildbase AS tools
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan-dev glslc \
    && rm -rf /var/lib/apt/lists/*
COPY tools/ /src/tools/
RUN cd /src/tools \
    && gcc -O2 -Wall -o vk-offscreen-tri vk-offscreen-tri.c -lvulkan \
    && gcc -O2 -Wall -o vk-spin vk-spin.c -lvulkan \
    && glslc tri.vert -o tri.vert.spv && glslc tri.frag -o tri.frag.spv && glslc spin.comp -o spin.comp.spv \
    && strip vk-offscreen-tri vk-spin

# ---------------------------------------------------------------------------------------------- /app
# Assembled in a stage that has chmod; the exported stage below is empty but for /app.
FROM base AS assemble
RUN mkdir -p /app/bin /app/llama
COPY gpu-test.sh /app/gpu-test.sh
COPY --from=vulkaninfo /src/vulkan-tools/build/vulkaninfo/vulkaninfo /app/bin/vulkaninfo
COPY --from=vkpeak /src/vkpeak/build/vkpeak /app/bin/vkpeak
COPY --from=tools /src/tools/vk-offscreen-tri /src/tools/vk-spin /src/tools/tri.vert.spv /src/tools/tri.frag.spv /src/tools/spin.comp.spv /app/bin/
COPY --from=llama /src/llama.cpp/build-vk/bin/ /app/llama/
RUN find /app -type d -exec chmod 0755 {} + \
 && find /app -type f -exec chmod 0644 {} + \
 && chmod 0755 /app/gpu-test.sh /app/bin/vulkaninfo /app/bin/vkpeak /app/bin/vk-offscreen-tri /app/bin/vk-spin \
 && find /app/llama -type f \( -name 'llama-*' -o -name '*.so*' \) -exec chmod 0755 {} + \
 && chown -R 0:0 /app

FROM scratch AS app
COPY --from=assemble /app /app
