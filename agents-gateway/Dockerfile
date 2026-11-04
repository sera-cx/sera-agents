# ── stage 1: build sera-mcp from source ────────────────────────────────
# Pinned to an immutable commit, not a tag. A tag can be moved to point at
# different code after review, so `--branch <tag>` is not a reproducible or
# trustworthy build input. This SHA is sera-mcp v0.8.2.
#
# NOTE: this previously defaulted to the tag `v0.8.3`, which was never pushed
# to sera-cx/sera-mcp (its latest tag is v0.8.2, though its package.json says
# 0.8.3). Every `publish agents-gateway image` run since 2026-08-31 failed with
# "fatal: Remote branch v0.8.3 not found in upstream origin". If 0.8.3 is meant
# to ship, tag it in sera-mcp and bump this SHA.
ARG SERA_MCP_REF=993dd2a25dd736cb123afd6c2f17f5d277912817
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS sera-mcp-build
RUN apk add --no-cache git python3 make g++
WORKDIR /opt
# Fetch exactly one commit by SHA (GitHub permits fetching a reachable SHA).
RUN git init sera-mcp \
 && cd sera-mcp \
 && git remote add origin https://github.com/sera-cx/sera-mcp.git \
 && git fetch --depth 1 origin "${SERA_MCP_REF}" \
 && git checkout --detach FETCH_HEAD
WORKDIR /opt/sera-mcp
RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev

# ── stage 2: build the gateway ─────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS gateway-build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY agents-gateway/package.json ./agents-gateway/
COPY agents-gateway/tsconfig.json ./agents-gateway/

RUN npm install --workspace=sera-agents-gateway --include-workspace-root --no-audit --no-fund

COPY agents-gateway/src ./agents-gateway/src
RUN npm run build --workspace=sera-agents-gateway

RUN npm prune --omit=dev --workspace=sera-agents-gateway --include-workspace-root

# ── stage 3: runtime ───────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
ENV NODE_ENV=production
ENV SERA_MCP_PATH=/opt/sera-mcp/dist/index.js

COPY --from=sera-mcp-build /opt/sera-mcp /opt/sera-mcp
COPY --from=gateway-build /app/node_modules ./node_modules
COPY --from=gateway-build /app/agents-gateway/node_modules ./agents-gateway/node_modules
COPY --from=gateway-build /app/agents-gateway/dist ./agents-gateway/dist
COPY --from=gateway-build /app/agents-gateway/package.json ./agents-gateway/package.json

USER node
WORKDIR /app/agents-gateway
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8787/health || exit 1

CMD ["node", "dist/server.js"]
