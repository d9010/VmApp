# Pinned helper image used by tools/mkruntime: unpacks a `docker export` tar and packs it with mkfs.erofs.
# Build-time tool only; it never ships and never runs on a user's machine.
# Adapted from agent-vm/tools/mkerofs.Dockerfile (commit 8f0c069).
# debian:bookworm-slim, pinned by digest (the multi-arch index; mkruntime builds it for linux/arm64).
FROM debian@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
 && apt-get install -y --no-install-recommends erofs-utils tar \
 && rm -rf /var/lib/apt/lists/* \
 && mkfs.erofs --help 2>&1 | head -n 1 || true
