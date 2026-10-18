#!/bin/sh
# Runs INSIDE the build container (apps/ollama-desktop/build.sh starts it): compiles Ollama's own Go programs for linux-arm64.
#
#   /src                    the patched Ollama source tree (read-write: go:embed needs app/ui/app/dist)
#   /go/pkg/mod, /root/.cache/go-build   bind-mounted caches ($VMAPP_WORK/cache/go-mod, go-build)
#   /out                    receives bin/ollama, bin/vmapp-ui, lib/ollama/GO_LICENSE, go-stage.txt
#   OLLAMA_VERSION          the version string to stamp (0.35.0), as Ollama's scripts/env.sh does
#
# The flags are Ollama's own (Dockerfile: `go build -trimpath -buildmode=pie`, scripts/env.sh: -w -s and the two -X settings), nothing
# more; go.sum is enforced (GOFLAGS=-mod=readonly), so a module that does not match the checksums fails the build.
set -eu
: "${OLLAMA_VERSION:?OLLAMA_VERSION is not set}"
mkdir -p /out/bin /out/lib/ollama
cd /src

go mod download
go mod verify

# app/ui embeds app/ui/app/dist (go:embed). The window is served by the vmapp loader from ui/, not by this binary, so the embedded
# copy is a one-line stub: the binary does not carry the React app a second time.
if [ ! -f app/ui/app/dist/index.html ]; then
    mkdir -p app/ui/app/dist
    printf '%s\n' '<!doctype html><title>Ollama</title><p>The Ollama window is served by the D9010 VmApp Launcher; this is the API of its backend.</p>' > app/ui/app/dist/index.html
fi

echo "== go build ollama ${OLLAMA_VERSION}"
go build -trimpath -buildmode=pie \
    -ldflags "-w -s -X=github.com/ollama/ollama/version.Version=${OLLAMA_VERSION} -X=github.com/ollama/ollama/server.mode=release" \
    -o /out/bin/ollama .

echo "== go build vmapp-ui (app/ui + app/server + app/store, headless)"
go build -trimpath -buildmode=pie \
    -ldflags "-w -s -X=github.com/ollama/ollama/app/version.Version=${OLLAMA_VERSION}" \
    -o /out/bin/vmapp-ui ./app/cmd/vmapp-ui

echo "== go test the packages the patches touch"
go test ./transfer/ ./app/store/ 2>&1 | tail -n 20

# Ollama's own licence file for the Go standard library, as its Dockerfile produces it (target ollama-go-license).
cmake -S . -B /tmp/go-license -DOLLAMA_LLAMA_BACKENDS= -DOLLAMA_MLX_BACKENDS= >/dev/null
cmake --build /tmp/go-license --target ollama-go-license >/dev/null
cp /tmp/go-license/lib/ollama/GO_LICENSE /out/lib/ollama/GO_LICENSE

{
    echo "go: $(go version)"
    echo "ollama: ${OLLAMA_VERSION} ($(sha256sum /out/bin/ollama | cut -d' ' -f1))"
    echo "vmapp-ui: ${OLLAMA_VERSION} ($(sha256sum /out/bin/vmapp-ui | cut -d' ' -f1))"
    echo "linked libraries of ollama:"
    ldd /out/bin/ollama | sed 's/^/  /'
    echo "linked libraries of vmapp-ui:"
    ldd /out/bin/vmapp-ui | sed 's/^/  /'
} > /out/go-stage.txt
cat /out/go-stage.txt
