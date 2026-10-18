# The vmapp registry as a container. The build context is the vmapp/ folder (the registry uses hostlib/ to verify
# packages), so build from there:
#
#   docker build -f registry/Dockerfile -t vmapp-registry .        (compose.yaml does this: cd registry && docker compose up -d --build)
#
# Node 22 built-ins only: there is nothing to install. Settings come from environment variables (registry/.env.example);
# the only writable place is /data (a volume): the root file system can be read-only.

# node:22-bookworm-slim, pinned by digest. This is the image INDEX (linux/amd64 and linux/arm64), so the same pin builds
# on an x86 EC2 instance, a Graviton one, or an Apple-silicon Mac.
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=production \
    REGISTRY_DATA=/data \
    REGISTRY_HOST=0.0.0.0 \
    REGISTRY_PORT=8790

WORKDIR /app
COPY hostlib/ /app/hostlib/
COPY registry/ /app/registry/

# /data: scratch space for uploads in flight (and, with REGISTRY_STORAGE=local, the whole store). The unprivileged
# "node" user (uid 1000) that the base image provides owns it.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
VOLUME ["/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.REGISTRY_PORT||8790)+'/api/stats').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# exec form: node is pid 1 and receives SIGTERM directly (it finishes in-flight requests, writes the download counters and a
# snapshot, and releases the writer lease before it exits)
CMD ["node", "/app/registry/server.js"]
