# vmapp runtime "node22": Node 22 plus the vmapp SDK, so `require('vmapp')` works. SPEC sections 3 and 9.
# mkruntime assembles the build context from context.json: sdk-node/ is a copy of ../../sdk/node.

# node:22-bookworm-slim (linux/arm64, glibc), pinned by digest. Same digest as agent-vm's example agent.
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# (No COPY --chmod: BuildKit also applies it to the folders COPY creates, which would make them untraversable.)
COPY sdk-node/vmapp.js /usr/lib/vmapp/node/node_modules/vmapp/index.js
RUN chmod 0755 /usr/lib/vmapp /usr/lib/vmapp/node /usr/lib/vmapp/node/node_modules /usr/lib/vmapp/node/node_modules/vmapp \
 && chmod 0644 /usr/lib/vmapp/node/node_modules/vmapp/index.js \
 && chown -R 0:0 /usr/lib/vmapp

# Reaches the core through /etc/vmapp/runtime.env, which mkruntime writes from the image's ENV.
ENV NODE_PATH=/usr/lib/vmapp/node/node_modules
