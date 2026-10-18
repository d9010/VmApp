# Venus GPU spike: guest root filesystem (Debian trixie arm64) as an ext4 image.
#
# Research only (gpu/venus-spike). Not part of vmapp's product runtimes.
#
# Stages
#   base      debian:trixie pinned by digest
#   mesa      Mesa 26.2.5 (tag + commit pinned), Venus (virtio) Vulkan driver only, + the 16K blob alignment patch
#   llama     llama.cpp (tag + commit pinned): llama-bench with the Vulkan backend, and a CPU-only llama-bench
#   vkpeak    nihui/vkpeak (tag + commit pinned): Vulkan compute throughput (GFLOPS)
#   tools     our own offscreen Vulkan triangle test (graphics path), shaders compiled with glslc
#   rootfs    runtime tree: vulkan-tools, Debian's stock Mesa (for the "stock" comparison), the above, /spike scripts
#   ext4      rootfs packed into an ext4 image (exported by `docker buildx build --target ext4-out`)
#
# Built by guest/build-rootfs.sh. The apt package set is whatever the trixie mirrors serve on build day; the exact
# versions installed are recorded in /spike/dpkg-list.txt inside the image.

ARG DEBIAN_IMAGE=debian:trixie@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5

FROM ${DEBIAN_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C

FROM base AS buildbase
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake ninja-build git ca-certificates pkgconf python3 \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------------------------- Mesa (Venus)
FROM buildbase AS mesa-src
RUN apt-get update && apt-get install -y --no-install-recommends \
        meson python3-mako python3-yaml python3-packaging python3-ply bison flex glslang-tools \
        libdrm-dev libexpat1-dev zlib1g-dev libzstd-dev libvulkan-dev spirv-tools \
        libwayland-dev wayland-protocols libx11-dev libx11-xcb-dev libxcb1-dev libxcb-dri3-dev libxcb-present-dev \
        libxcb-sync-dev libxcb-xfixes0-dev libxcb-randr0-dev libxcb-shm0-dev libxshmfence-dev libxrandr-dev \
        libxxf86vm-dev libwayland-egl-backend-dev \
    && rm -rf /var/lib/apt/lists/*
ARG MESA_TAG=mesa-26.2.5
ARG MESA_COMMIT=ddaf85e353442d9d7f192fdcf1823e652e3f2ee3
RUN git clone --depth 1 --branch ${MESA_TAG} https://gitlab.freedesktop.org/mesa/mesa.git /src/mesa \
    && test "$(git -C /src/mesa rev-parse HEAD)" = "${MESA_COMMIT}"

# (a) UPSTREAM Mesa, unmodified: needs the guest KERNEL to report VIRTGPU_PARAM_BLOB_ALIGNMENT (kernel patch)
FROM mesa-src AS mesa-upstream
RUN cd /src/mesa && meson setup build --prefix=/opt/mesa-venus-upstream --buildtype=release \
        -Dvulkan-drivers=virtio -Dgallium-drivers= -Dplatforms=x11,wayland -Dllvm=disabled \
        -Dglx=disabled -Dgbm=disabled -Degl=disabled -Dgles1=disabled -Dgles2=disabled -Dopengl=false \
        -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled -Dvulkan-layers= \
    && ninja -C build install

# (b) Mesa + the userspace 16K hack: works on any guest kernel (the slp/mesa-libkrun-vulkan approach)
FROM mesa-src AS mesa
COPY patches/mesa-26.2.5-venus-16k-blob-alignment.patch /patches/
RUN cd /src/mesa && git apply --check /patches/mesa-26.2.5-venus-16k-blob-alignment.patch \
    && git apply /patches/mesa-26.2.5-venus-16k-blob-alignment.patch
RUN cd /src/mesa && meson setup build --prefix=/opt/mesa-venus --buildtype=release \
        -Dvulkan-drivers=virtio -Dgallium-drivers= -Dplatforms=x11,wayland -Dllvm=disabled \
        -Dglx=disabled -Dgbm=disabled -Degl=disabled -Dgles1=disabled -Dgles2=disabled -Dopengl=false \
        -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled -Dvulkan-layers= \
    && ninja -C build install

# ---------------------------------------------------------------------------------------------- llama.cpp
FROM buildbase AS llama
RUN apt-get update && apt-get install -y --no-install-recommends \
        libvulkan-dev glslc spirv-headers libgomp1 \
    && rm -rf /var/lib/apt/lists/*
ARG LLAMA_TAG=b11669
ARG LLAMA_COMMIT=620d2225cc436ab0b001e3200e590e3b286ef9ab
RUN git clone --depth 1 --branch ${LLAMA_TAG} https://github.com/ggml-org/llama.cpp.git /src/llama.cpp \
    && test "$(git -C /src/llama.cpp rev-parse HEAD)" = "${LLAMA_COMMIT}"
# One arm64 baseline for both builds: ARMv8.6-A with dotprod + i8mm (Apple M-series), no -march=native, so
# the Docker build host's CPU does not leak into the binary.
ARG CPU_FLAGS="-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.6-a+dotprod+i8mm+fp16"
RUN cd /src/llama.cpp \
    && cmake -S . -B build-vk -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON ${CPU_FLAGS} \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF \
    && cmake --build build-vk --target llama-bench -j"$(nproc)"
RUN cd /src/llama.cpp \
    && cmake -S . -B build-cpu -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=OFF ${CPU_FLAGS} \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF \
    && cmake --build build-cpu --target llama-bench -j"$(nproc)"

# ---------------------------------------------------------------------------------------------- vkpeak
FROM buildbase AS vkpeak
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan-dev \
    && rm -rf /var/lib/apt/lists/*
ARG VKPEAK_TAG=20260527
ARG VKPEAK_COMMIT=f108eb11d467eb3d5cdd472f8e080818a117a752
RUN git clone --branch ${VKPEAK_TAG} https://github.com/nihui/vkpeak.git /src/vkpeak \
    && cd /src/vkpeak && test "$(git rev-parse HEAD)" = "${VKPEAK_COMMIT}" \
    && git submodule update --init --recursive --depth 1
RUN cd /src/vkpeak && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)"

# ---------------------------------------------------------------------------------------------- our test tools
FROM buildbase AS tools
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan-dev glslc \
    && rm -rf /var/lib/apt/lists/*
COPY tools/ /src/tools/
RUN cd /src/tools && gcc -O2 -Wall -o vsock-test vsock-test.c \
    && gcc -O2 -Wall -o vk-offscreen-tri vk-offscreen-tri.c -lvulkan \
    && gcc -O2 -Wall -o vk-spin vk-spin.c -lvulkan \
    && glslc tri.vert -o tri.vert.spv && glslc tri.frag -o tri.frag.spv && glslc spin.comp -o spin.comp.spv

# ---------------------------------------------------------------------------------------------- runtime tree
FROM base AS rootfs
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash coreutils procps util-linux strace less kmod \
        libvulkan1 vulkan-tools mesa-vulkan-drivers libdrm2 libgomp1 libstdc++6 \
        libwayland-client0 libxcb1 libx11-xcb1 libxcb-dri3-0 libxcb-present0 libxcb-sync1 libxcb-xfixes0 \
        libxcb-randr0 libxcb-shm0 libxshmfence1 libxrandr2 libexpat1 zlib1g libzstd1 libpng16-16t64 \
    && dpkg -l > /spike-dpkg-list.txt \
    && rm -rf /var/lib/apt/lists/*
COPY --from=mesa /opt/mesa-venus /opt/mesa-venus
COPY --from=mesa-upstream /opt/mesa-venus-upstream /opt/mesa-venus-upstream
COPY --from=llama /src/llama.cpp/build-vk/bin/ /opt/llama-vk/
COPY --from=llama /src/llama.cpp/build-cpu/bin/ /opt/llama-cpu/
COPY --from=vkpeak /src/vkpeak/build/vkpeak /opt/vkpeak/vkpeak
COPY --from=tools /src/tools/vk-offscreen-tri /src/tools/vk-spin /src/tools/vsock-test /src/tools/tri.vert.spv /src/tools/tri.frag.spv /src/tools/spin.comp.spv /opt/spike-tools/
COPY scripts/ /spike/
RUN chmod 0755 /spike/init /spike/tests/*.sh && mkdir -p /models /proc /sys /dev /tmp /run \
    && mv /spike-dpkg-list.txt /spike/dpkg-list.txt

# ---------------------------------------------------------------------------------------------- ext4 image
FROM base AS ext4
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs && rm -rf /var/lib/apt/lists/*
COPY --from=rootfs / /tree/
# Device nodes that must exist on the root filesystem itself, before devtmpfs is mounted over /dev: the kernel opens
# /dev/console for PID 1, and early shell redirections to /dev/null must not create regular files there.
RUN rm -f /tree/dev/null /tree/dev/console && mknod -m 666 /tree/dev/null c 1 3 && mknod -m 600 /tree/dev/console c 5 1
ARG IMAGE_MIB=2560
RUN truncate -s ${IMAGE_MIB}M /rootfs.ext4 \
    && mke2fs -t ext4 -O ^has_journal -L spikeroot -E root_owner=0:0 -d /tree -F /rootfs.ext4 \
    && e2fsck -fn /rootfs.ext4 && du -sh /tree

FROM scratch AS ext4-out
COPY --from=ext4 /rootfs.ext4 /rootfs.ext4
