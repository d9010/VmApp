# llama-server for the Local LLM app: linux/arm64, glibc 2.36, CPU backend (NEON) plus the RPC backend client.
#
# Not meant to be run by hand: apps/local-llm/build.sh passes the pins from pins.env and gpu/pins.env as build arguments and
# exports the result (target `out`) into a folder. ARM_ARCH is armv8.2-a+fp16+dotprod: NEON with the dot-product and half-precision
# instructions that every Apple Silicon Mac has (M1 and later) and that the guest kernel reports in /proc/cpuinfo (asimddp,
# asimdhp). Virtualization.framework does NOT expose the int8 matrix-multiply (i8mm) instructions of the M2 and later to a guest,
# so a build that needs them would be wrong to run there: there is one build.
#
# Why these choices:
#   - Debian bookworm, like the node22 runtime (node:22-bookworm-slim), so the glibc the binary needs is the glibc it finds.
#   - Static libstdc++ and libgcc, no OpenMP (ggml has its own thread pool): the binary needs only libc, libm, libpthread, libdl.
#   - -DGGML_RPC=ON: `--rpc host:port` offloads work to a ggml RPC server (the `gpu` host capability).
#   - No libcurl and no OpenSSL: the app's core downloads models, llama-server never touches the network.
#   - No embedded web UI (the app has its own), no tools, no tests, no examples.
#
# The base image is pinned by digest (INV-F2). It must equal DEBIAN_IMAGE@DEBIAN_DIGEST of pins.env; build.sh checks that.
FROM debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS toolchain
ARG DEBIAN_SNAPSHOT
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C TZ=UTC
# apt reads a dated snapshot of the Debian archive. The pristine image has no CA bundle, so the first update (only to fetch
# ca-certificates) skips TLS peer verification; apt still verifies the archive's GPG signatures and every package hash.
RUN set -eu; \
    case "${DEBIAN_SNAPSHOT}" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) echo "bad DEBIAN_SNAPSHOT" >&2; exit 2 ;; esac; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*; \
    printf 'Types: deb\nURIs: https://snapshot.debian.org/archive/debian/%s/\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: https://snapshot.debian.org/archive/debian-security/%s/\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
        "${DEBIAN_SNAPSHOT}" "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources; \
    printf 'Acquire::Retries "5";\nAcquire::Check-Valid-Until "false";\nAPT::Install-Recommends "false";\nAPT::Install-Suggests "false";\n' > /etc/apt/apt.conf.d/99vmapp-build; \
    apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false update; \
    apt-get -o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false install -y --no-install-recommends ca-certificates; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential cmake git; \
    rm -rf /var/lib/apt/lists/*

# The exact llama.cpp commit (a git commit id covers the whole tree, so fetching it by id is verifying it).
FROM toolchain AS source
ARG LLAMA_CPP_REPO
ARG LLAMA_CPP_COMMIT
ARG RPC_PROTO_VERSION
# The RPC protocol version of the source must be the one the host's RPC server was pinned with (gpu/pins.env).
RUN set -eu; \
    git init -q /src; cd /src; \
    git remote add origin "${LLAMA_CPP_REPO}"; \
    git fetch -q --depth 1 origin "${LLAMA_CPP_COMMIT}"; \
    git checkout -q FETCH_HEAD; \
    [ "$(git rev-parse HEAD)" = "${LLAMA_CPP_COMMIT}" ]; \
    v="$(for p in MAJOR MINOR PATCH; do sed -n "s/^#define RPC_PROTO_${p}_VERSION[[:space:]]*\([0-9]*\).*/\1/p" ggml/include/ggml-rpc.h; done | paste -sd. -)"; \
    echo "RPC protocol of the source: $v (gpu/pins.env: ${RPC_PROTO_VERSION})"; \
    [ "$v" = "${RPC_PROTO_VERSION}" ]

FROM source AS build
ARG ARM_ARCH
RUN set -eu; \
    cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_FLAGS="-ffile-prefix-map=/src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=/src=." \
        -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH="${ARM_ARCH}" -DGGML_OPENMP=OFF -DGGML_CPU_KLEIDIAI=OFF \
        -DGGML_RPC=ON \
        -DLLAMA_BUILD_COMMON=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON \
        -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
        -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
        -DLLAMA_OPENSSL=OFF -DLLAMA_CURL=OFF \
    && cmake --build /build --target llama-server -j "$(nproc)" \
    && mkdir -p /out \
    && strip -o /out/llama-server /build/bin/llama-server \
    && cp /src/LICENSE /out/LICENSE.llama.cpp \
    && { /out/llama-server --version 2>&1 || true; } | head -5 > /out/version.txt \
    && ldd /out/llama-server > /out/ldd.txt

FROM scratch AS out
COPY --from=build /out/ /
