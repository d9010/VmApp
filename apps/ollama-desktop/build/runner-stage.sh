#!/bin/sh
# Runs INSIDE the build container (apps/ollama-desktop/build.sh starts it): builds Ollama's CPU runners for linux-arm64 the way Ollama's
# own Dockerfile does for the release (stage llama-server-cpu): `cmake -S llama/server --preset cpu`, build, install the component
# `llama-server`. That gives lib/ollama/llama-server (the helper that runs a model), libllama*, libggml-base, libmtmd and the CPU
# backend in one variant per CPU feature set (GGML_CPU_ALL_VARIANTS=ON, GGML_BACKEND_DL=ON: the best variant is picked at run time).
#
#   /src                  the patched Ollama source tree (read-only is enough; the build tree is in /tmp)
#   /out                  receives lib/ollama/*, runner-stage.txt
#   LLAMA_CPP_COMMIT      the commit that Ollama's LLAMA_CPP_VERSION tag must resolve to (checked after cmake has fetched it)
#   JOBS                  compiler jobs (default: the container's CPUs)
#
# llama.cpp is fetched by cmake's FetchContent at the tag in /src/LLAMA_CPP_VERSION and patched with Ollama's llama/compat patch; both
# are Ollama's own mechanism. The network is needed once (GitHub).
set -eu
: "${LLAMA_CPP_COMMIT:?LLAMA_CPP_COMMIT is not set}"
JOBS="${JOBS:-$(nproc)}"
mkdir -p /out/lib/ollama
cd /src

tag="$(tr -d '[:space:]' < LLAMA_CPP_VERSION)"
echo "== llama.cpp tag in Ollama's LLAMA_CPP_VERSION: ${tag}"

# The build tree lives in /tmp (inside the container): the source tree is not written to.
echo "== cmake configure (preset cpu)"
cmake -S llama/server --preset cpu -B /tmp/llama-server-cpu -DCMAKE_INSTALL_PREFIX=/tmp/dist \
    -DCMAKE_C_FLAGS="-ffile-prefix-map=/src=. -ffile-prefix-map=/tmp=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=/src=. -ffile-prefix-map=/tmp=."

got="$(git -C /tmp/llama-server-cpu/_deps/llama_cpp-src rev-parse HEAD 2>/dev/null || true)"
echo "== llama.cpp commit fetched: ${got} (pinned: ${LLAMA_CPP_COMMIT})"
[ "${got}" = "${LLAMA_CPP_COMMIT}" ] || { echo "the fetched llama.cpp is not the pinned commit" >&2; exit 1; }

echo "== cmake build (${JOBS} jobs)"
cmake --build /tmp/llama-server-cpu -j "${JOBS}"
cmake --install /tmp/llama-server-cpu --component llama-server --strip

cp -a /tmp/dist/lib/ollama/. /out/lib/ollama/
{
    echo "llama.cpp ${tag} (${got}) fetched by Ollama's llama/server/CMakeLists.txt, patched with llama/compat"
    echo "preset cpu: GGML_CPU_ALL_VARIANTS=ON GGML_BACKEND_DL=ON BUILD_SHARED_LIBS=ON GGML_NATIVE=OFF GGML_OPENMP=OFF Release"
    echo "compiler: $(gcc --version | head -n 1)"
    echo "cmake: $(cmake --version | head -n 1)"
    echo "files:"
    (cd /out/lib/ollama && ls -l | sed 's/^/  /')
    echo "unresolved libraries:"
    for f in /out/lib/ollama/llama-server /out/lib/ollama/*.so*; do
        LD_LIBRARY_PATH=/out/lib/ollama ldd "$f" 2>&1 | grep 'not found' | sed "s|^|  ${f}: |" || true
    done
} > /out/runner-stage.txt
cat /out/runner-stage.txt
