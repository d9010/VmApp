# Ollama's Vulkan backend (libggml-vulkan.so) for linux-arm64, for the Ollama (GPU) sample (apps/ollama-gpu).
#
# NOT meant to be run by hand: apps/ollama/vulkan/build-vulkan.sh passes the pins of pins.env as build arguments, puts the release's
# libggml-base.so.<version> into the build context (ref/) and exports the result (target `out`) into a folder. It needs Docker
# (BuildKit); nothing in this file runs on the host.
#
# Why this library, and why this way (read pins.env first):
#   - Ollama 0.35.0's linux-arm64 release has the CPU backend (eight variants) and CUDA, no Vulkan. Its Vulkan backend for other
#     platforms is `cmake -S llama/server --preset vulkan`: GGML_VULKAN=ON, GGML_BACKEND_DL=ON, BUILD_SHARED_LIBS=ON, GGML_NATIVE=OFF,
#     GGML_OPENMP=OFF, and the library is installed as lib/ollama/vulkan/libggml-vulkan.so. Ollama finds a GPU backend by looking for
#     `lib/ollama/*/*ggml-*` (discover/runner.go) and loads `libggml-vulkan.so` from that directory (discover/native_probe_platform.go).
#   - The library is a ggml backend module: it links libggml-base.so.0 (which the release already has, and which the process has loaded
#     by then), libvulkan.so.1 (runtime node22-gpu has it), libstdc++, libm and libc. It must be the same ggml as the release's
#     libggml-base: same llama.cpp tag (checked against Ollama's own LLAMA_CPP_VERSION at its tag commit) and, as a second check, the
#     same libggml-base.so.<version> file name and every ggml symbol it imports defined by the release's file (stage `check`).
#   - It is built on the base image and Debian snapshot of runtimes/node22-gpu (the FROM line and the snapshot date below are the
#     runtime's own; build-vulkan.sh checks that they still are), so it links against the glibc and libstdc++ it will find at run time.
#   - glslc (shaderc) compiles ggml's compute shaders at build time; the Vulkan headers are Debian's libvulkan-dev. Their versions are
#     pinned in pins.env.

# node:22-trixie-slim (linux/arm64, glibc), pinned by digest. The same digest and apt snapshot as runtimes/node22-gpu (INV-F2).
FROM node@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS base
ARG DEBIAN_FRONTEND=noninteractive
RUN sed -i \
      -e 's|^URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/20261005T000000Z|' \
      -e 's|^URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/20261005T000000Z|' \
      /etc/apt/sources.list.d/debian.sources \
 && test "$(grep -c '^URIs: http://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources)" = 2 \
 && printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\n' > /etc/apt/apt.conf.d/99vmapp-snapshot

# ---------------------------------------------------------------------------------------------- toolchain
FROM base AS buildbase
ARG DEBIAN_FRONTEND=noninteractive
ARG APT_BUILD_ESSENTIAL
ARG APT_CMAKE
ARG APT_NINJA_BUILD
ARG APT_GLSLC
ARG APT_LIBVULKAN_DEV
ARG APT_SPIRV_HEADERS
RUN set -eu; \
    for v in "${APT_BUILD_ESSENTIAL}" "${APT_CMAKE}" "${APT_NINJA_BUILD}" "${APT_GLSLC}" "${APT_LIBVULKAN_DEV}" "${APT_SPIRV_HEADERS}"; do \
        [ -n "$v" ] || { echo "a package version build argument is empty: run apps/ollama/vulkan/build-vulkan.sh" >&2; exit 2; }; \
    done; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "build-essential=${APT_BUILD_ESSENTIAL}" "cmake=${APT_CMAKE}" "ninja-build=${APT_NINJA_BUILD}" \
        "glslc=${APT_GLSLC}" "libvulkan-dev=${APT_LIBVULKAN_DEV}" "spirv-headers=${APT_SPIRV_HEADERS}" \
        git ca-certificates curl pkgconf; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------------------------- the sources, and the checks against Ollama
FROM buildbase AS source
ARG LLAMA_CPP_REPO
ARG LLAMA_CPP_TAG
ARG LLAMA_CPP_COMMIT
ARG OLLAMA_TAG_COMMIT
# llama.cpp: the tag, and the full commit it must be (a commit id covers the whole tree).
RUN set -eu; \
    for v in "${LLAMA_CPP_REPO}" "${LLAMA_CPP_TAG}" "${LLAMA_CPP_COMMIT}" "${OLLAMA_TAG_COMMIT}"; do [ -n "$v" ] || { echo "a pin build argument is empty" >&2; exit 2; }; done; \
    git clone --depth 1 --branch "${LLAMA_CPP_TAG}" "${LLAMA_CPP_REPO}" /src/llama.cpp; \
    [ "$(git -C /src/llama.cpp rev-parse HEAD)" = "${LLAMA_CPP_COMMIT}" ]
# Ollama's own files at its tag commit: (1) the llama.cpp it builds on, (2) its patch to llama.cpp touches no ggml file (so upstream
# ggml at that tag is what Ollama's Vulkan library is built from), (3) its Vulkan preset puts the backend in lib/ollama/vulkan.
RUN set -eu; \
    raw="https://raw.githubusercontent.com/ollama/ollama/${OLLAMA_TAG_COMMIT}"; \
    got="$(curl -fsSL "${raw}/LLAMA_CPP_VERSION" | tr -d '[:space:]')"; \
    echo "Ollama's LLAMA_CPP_VERSION: ${got} (pinned: ${LLAMA_CPP_TAG})"; \
    [ "${got}" = "${LLAMA_CPP_TAG}" ]; \
    curl -fsSL "${raw}/llama/compat/001-llama-cpp-hooks.patch" > /tmp/compat.patch; \
    files="$(sed -n 's|^+++ b/||p' /tmp/compat.patch)"; \
    echo "files that Ollama's compat patch touches: $(echo "${files}" | tr '\n' ' ')"; \
    [ -n "${files}" ]; \
    if echo "${files}" | grep -q '^ggml/'; then echo "Ollama's compat patch now touches ggml: the library cannot be built from upstream ggml alone" >&2; exit 1; fi; \
    curl -fsSL "${raw}/llama/server/CMakePresets.json" > /tmp/presets.json; \
    grep -q '"GGML_VULKAN": "ON"' /tmp/presets.json; \
    grep -q '"OLLAMA_RUNNER_DIR": "vulkan"' /tmp/presets.json; \
    grep -q '"GGML_BACKEND_DL": "ON"' /tmp/presets.json; \
    echo "the preset 'vulkan' of Ollama's llama/server/CMakePresets.json installs into lib/ollama/vulkan with GGML_BACKEND_DL=ON"

# ---------------------------------------------------------------------------------------------- the build
FROM source AS build
ARG JOBS=
ARG LLAMA_CPP_REPO
ARG LLAMA_CPP_TAG
ARG LLAMA_CPP_COMMIT
ARG OLLAMA_TAG_COMMIT
# Only the backend module and ggml-base (to read its version). No llama, no tools, no server: they are in the release already.
RUN set -eu; \
    cmake -S /src/llama.cpp -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_FLAGS="-ffile-prefix-map=/src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=/src=." \
        -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_VULKAN=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
        -DLLAMA_BUILD_COMMON=OFF -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF; \
    cmake --build /build --target ggml-vulkan ggml-base -j "${JOBS:-$(nproc)}"
# Every library the module needs must resolve (ldd below): libggml-base.so.0 from the build tree, the rest from the system.
RUN set -eu; \
    mkdir -p /out; \
    vk="$(find /build -name libggml-vulkan.so -type f)"; \
    [ -n "${vk}" ] && [ "$(echo "${vk}" | wc -l)" = 1 ] || { echo "expected exactly one libggml-vulkan.so, found: ${vk}" >&2; exit 1; }; \
    base="$(find /build -name 'libggml-base.so.*.*.*' -type f -exec basename {} \;)"; \
    [ -n "${base}" ] && [ "$(echo "${base}" | wc -l)" = 1 ] || { echo "expected exactly one libggml-base.so.X.Y.Z, found: ${base}" >&2; exit 1; }; \
    strip --strip-unneeded -o /out/libggml-vulkan.so "${vk}"; \
    echo "${base}" > /out/ggml-base.name; \
    LD_LIBRARY_PATH="$(dirname "${vk}")" ldd /out/libggml-vulkan.so > /out/ldd.txt; \
    cat /out/ldd.txt; \
    if grep -q 'not found' /out/ldd.txt; then echo "libggml-vulkan.so needs a library that is not there" >&2; exit 1; fi; \
    readelf -d /out/libggml-vulkan.so | grep -E 'NEEDED|RUNPATH|RPATH|SONAME' > /out/dynamic.txt || true; \
    cat /out/dynamic.txt; \
    { \
        echo "llama.cpp ${LLAMA_CPP_TAG} (${LLAMA_CPP_COMMIT}) from ${LLAMA_CPP_REPO}"; \
        echo "ggml-base of this build: ${base}"; \
        echo "Ollama tag commit ${OLLAMA_TAG_COMMIT}: LLAMA_CPP_VERSION, compat patch (no ggml file) and Vulkan preset checked"; \
        echo "options: GGML_VULKAN=ON GGML_BACKEND_DL=ON BUILD_SHARED_LIBS=ON GGML_NATIVE=OFF GGML_OPENMP=OFF Release"; \
        echo "compiler: $(gcc --version | head -n 1)"; \
        echo "cmake: $(cmake --version | head -n 1)"; \
        echo "glslc: $(glslc --version | head -n 1)"; \
        echo "libvulkan-dev: $(dpkg-query -W -f='${Version}' libvulkan-dev); spirv-headers: $(dpkg-query -W -f='${Version}' spirv-headers)"; \
        echo "libggml-vulkan.so sha256: $(sha256sum /out/libggml-vulkan.so | cut -d' ' -f1)"; \
    } > /out/BUILD-INFO.txt

# ---------------------------------------------------------------------------------------------- the check against the release
# ref/ is the release's lib/ollama/libggml-base.so.<version> (build-vulkan.sh puts it in the build context). The module must be the
# same ggml version, and every ggml_ / gguf_ function it imports must be defined by the release's library.
FROM build AS check
COPY ref/ /ref/
RUN set -eu; \
    refbase="$(ls /ref | grep -E '^libggml-base\.so\.[0-9]+\.[0-9]+\.[0-9]+$')"; \
    [ "$(echo "${refbase}" | wc -l)" = 1 ] || { echo "ref/ must hold exactly one libggml-base.so.X.Y.Z: ${refbase}" >&2; exit 1; }; \
    built="$(cat /out/ggml-base.name)"; \
    echo "libggml-base: the release has ${refbase}, this build ${built}"; \
    [ "${refbase}" = "${built}" ] || { echo "ggml version mismatch: the release's ${refbase} is not ${built}" >&2; exit 1; }; \
    nm -D --undefined-only /out/libggml-vulkan.so | awk '$1 == "U" { print $2 }' | sed 's/@.*//' | grep -E '^(ggml|gguf)_' | sort -u > /tmp/need.txt; \
    nm -D --defined-only "/ref/${refbase}" | awk '{ print $3 }' | sed 's/@.*//' | sort -u > /tmp/have.txt; \
    [ -s /tmp/need.txt ] || { echo "found no ggml symbols that libggml-vulkan.so imports: the check is broken" >&2; exit 1; }; \
    missing="$(comm -23 /tmp/need.txt /tmp/have.txt)"; \
    [ -z "${missing}" ] || { echo "the release's ${refbase} does not define: ${missing}" >&2; exit 1; }; \
    echo "all $(wc -l < /tmp/need.txt) ggml symbols that libggml-vulkan.so imports are defined by the release's ${refbase}" | tee /out/abi-check.txt

FROM scratch AS out
COPY --from=check /out/ /
