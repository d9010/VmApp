# vmapp runtime "native": nothing but the mount-point folders and the CA certificates, for static binaries
# (Rust musl, Go, Zig, C). SPEC section 3. mkruntime adds the mount points app data host proc sys dev tmp run.

# Build stage only: fetch the CA bundle. debian:bookworm-slim, pinned by digest (multi-arch index; built for
# linux/arm64). The bundle comes from Debian's ca-certificates package, so a build from scratch (no Docker layer
# cache) picks up the then-current package version; rebuilding with the same cache gives the same bytes.
FROM debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS certs
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt

FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
