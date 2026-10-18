# vmapp runtime "node22-gpu" (EXPERIMENTAL, SPEC section 3 and 8.6/GPU plan): Node 22 plus the vmapp SDK, exactly like
# runtime "node22", but on Debian trixie and carrying the Vulkan loader plus Mesa's Venus ICD, so a core can use the virtio-gpu
# device (libkrun + virglrenderer Venus + MoltenVK on the host) through the standard Vulkan ABI, with no environment variables.
# mkruntime assembles the build context from context.json: sdk-node/ is a copy of ../../sdk/node.
#
# The Mesa here is UNMODIFIED upstream (tag mesa-26.2.5, pinned by commit). It needs the guest kernel to report
# VIRTGPU_PARAM_BLOB_ALIGNMENT (the kernel is started with virtio_gpu.blob_alignment=16384), so no userspace 16K patch.
# See gpu/venus-spike/REPORT.md section 6 (B1) and section 11 item 5. Built headless: no X11 and no Wayland libraries.
#
# Reproducibility (INV-F2): the base image is pinned by digest (the multi-arch index, as runtimes/node22 does), and apt
# reads the Debian snapshot of the base image's own build day (20261005), so the same inputs give the same packages.
# Layout of what this adds:
#   /usr/lib/aarch64-linux-gnu/libvulkan.so.1                      Khronos loader (Debian libvulkan1)
#   /usr/lib/aarch64-linux-gnu/libvulkan_virtio.so                 Mesa Venus ICD (stripped)
#   /usr/share/vulkan/icd.d/virtio_icd.aarch64.json                the ICD manifest, on the loader's default search path
#   /usr/share/drirc.d/00-{mesa,venus}-defaults.conf               Mesa's and Venus's per-application workarounds (read by the ICD)

# node:22-trixie-slim (linux/arm64, glibc), pinned by digest.
FROM node@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS base
ARG DEBIAN_FRONTEND=noninteractive
RUN sed -i \
      -e 's|^URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/20261005T000000Z|' \
      -e 's|^URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/20261005T000000Z|' \
      /etc/apt/sources.list.d/debian.sources \
 && test "$(grep -c '^URIs: http://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources)" = 2 \
 && printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\n' > /etc/apt/apt.conf.d/99vmapp-snapshot

# ---------------------------------------------------------------------------------------------- Mesa (Venus only)
FROM base AS mesa
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ninja-build git ca-certificates pkgconf python3 \
        meson python3-mako python3-yaml python3-packaging python3-ply bison flex glslang-tools \
        libdrm-dev libexpat1-dev zlib1g-dev libzstd-dev libvulkan-dev spirv-tools \
    && rm -rf /var/lib/apt/lists/*
ARG MESA_TAG=mesa-26.2.5
ARG MESA_COMMIT=ddaf85e353442d9d7f192fdcf1823e652e3f2ee3
RUN git clone --depth 1 --branch ${MESA_TAG} https://gitlab.freedesktop.org/mesa/mesa.git /src/mesa \
    && test "$(git -C /src/mesa rev-parse HEAD)" = "${MESA_COMMIT}"
# Only the Venus (virtio) Vulkan driver; no Gallium, no GL/EGL/GBM; no window-system platform (compute and offscreen only).
RUN cd /src/mesa && meson setup build --prefix=/usr --libdir=lib/aarch64-linux-gnu --buildtype=release -Dstrip=true \
        -Dvulkan-drivers=virtio -Dgallium-drivers= -Dplatforms= -Dllvm=disabled \
        -Dglx=disabled -Dgbm=disabled -Degl=disabled -Dgles1=disabled -Dgles2=disabled -Dopengl=false \
        -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled -Dvulkan-layers= \
    && DESTDIR=/stage ninja -C build install \
    && find /stage -type f -o -type l | sort && cat /stage/usr/share/vulkan/icd.d/*.json

# ---------------------------------------------------------------------------------------------- the GPU liveness probe
# gpu-probe/gpu-probe.c (SPEC 8.7): vmapp-init starts it in a VM that has a GPU; the launcher's watchdog reads from it whether the
# host's GPU worker still answers.
FROM base AS probe
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libvulkan-dev && rm -rf /var/lib/apt/lists/*
COPY gpu-probe/gpu-probe.c /src/gpu-probe.c
RUN gcc -O2 -Wall -Werror -o /gpu-probe /src/gpu-probe.c -lvulkan && strip /gpu-probe

# ---------------------------------------------------------------------------------------------- the runtime
FROM base
ARG DEBIAN_FRONTEND=noninteractive
# libvulkan1 = the Khronos loader. libdrm2 = what the ICD uses to find and open the render node. libgomp1 = OpenMP for
# llama.cpp's CPU side. libexpat1 = Mesa's drirc parser. zlib1g, libzstd1 and libstdc++6 already come with the base.
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 libdrm2 libgomp1 libexpat1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mesa /stage/usr/lib/aarch64-linux-gnu/libvulkan_virtio.so /usr/lib/aarch64-linux-gnu/libvulkan_virtio.so
COPY --from=mesa /stage/usr/share/vulkan/icd.d/virtio_icd.aarch64.json /usr/share/vulkan/icd.d/virtio_icd.aarch64.json
COPY --from=mesa /stage/usr/share/drirc.d/00-mesa-defaults.conf /usr/share/drirc.d/00-mesa-defaults.conf
COPY --from=mesa /stage/usr/share/drirc.d/00-venus-defaults.conf /usr/share/drirc.d/00-venus-defaults.conf
RUN chmod 0755 /usr/share/vulkan /usr/share/vulkan/icd.d /usr/share/drirc.d \
 && chmod 0755 /usr/lib/aarch64-linux-gnu/libvulkan_virtio.so \
 && chmod 0644 /usr/share/vulkan/icd.d/virtio_icd.aarch64.json /usr/share/drirc.d/00-mesa-defaults.conf /usr/share/drirc.d/00-venus-defaults.conf \
 && chown -R 0:0 /usr/share/vulkan /usr/share/drirc.d /usr/lib/aarch64-linux-gnu/libvulkan_virtio.so

COPY --from=probe /gpu-probe /usr/lib/vmapp/gpu-probe

# (No COPY --chmod: BuildKit also applies it to the folders COPY creates, which would make them untraversable.)
COPY sdk-node/vmapp.js /usr/lib/vmapp/node/node_modules/vmapp/index.js
RUN chmod 0755 /usr/lib/vmapp /usr/lib/vmapp/node /usr/lib/vmapp/node/node_modules /usr/lib/vmapp/node/node_modules/vmapp \
 && chmod 0644 /usr/lib/vmapp/node/node_modules/vmapp/index.js \
 && chmod 0755 /usr/lib/vmapp/gpu-probe \
 && chown -R 0:0 /usr/lib/vmapp

# Reaches the core through /etc/vmapp/runtime.env, which mkruntime writes from the image's ENV.
ENV NODE_PATH=/usr/lib/vmapp/node/node_modules
