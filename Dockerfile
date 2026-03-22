# ── Stage 1: compile the knowledge-broker plugin ─────────────────────────────
FROM node:24-bookworm-slim AS plugin-builder

WORKDIR /build
COPY extensions/knowledge-broker/package.json ./
RUN npm install --ignore-scripts

COPY extensions/knowledge-broker/src ./src
COPY extensions/knowledge-broker/tsconfig.json ./
COPY extensions/knowledge-broker/openclaw.plugin.json ./

# Compile TypeScript → JavaScript (ESM) and copy plugin manifest to dist/
RUN npx tsc && cp openclaw.plugin.json dist/openclaw.plugin.json

# ── Stage 2: OpenClaw runtime ─────────────────────────────────────────────────
FROM ghcr.io/openclaw/openclaw:latest

# Docker named volumes are initialized owned by root. We need to pre-create
# the openclaw directory as root and chown it to the "node" user so the
# volume inherits the correct ownership on first start.
USER root
RUN mkdir -p \
      /home/node/.openclaw/extensions \
    && chown -R node:node /home/node/.openclaw

# Install the skill into /app/skills — the path OpenClaw scans at startup
COPY skills/cross-session-sync /app/skills/cross-session-sync

USER node

# Copy compiled plugin
COPY --from=plugin-builder /build/dist \
     /home/node/.openclaw/extensions/knowledge-broker/dist
COPY extensions/knowledge-broker/package.json \
     /home/node/.openclaw/extensions/knowledge-broker/package.json
COPY extensions/knowledge-broker/openclaw.plugin.json \
     /home/node/.openclaw/extensions/knowledge-broker/openclaw.plugin.json

# Seed config (not inside the volume path — copied to /tmp and applied at runtime)
COPY config/openclaw.json /tmp/openclaw-defaults.json

# Entrypoint
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 18789 18790
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
