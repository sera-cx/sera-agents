# ── stage 1: build sera-mcp from source ────────────────────────────────
ARG SERA_MCP_REF=v0.8.2
FROM node:20-alpine AS sera-mcp-build
RUN apk add --no-cache git python3 make g++
WORKDIR /opt
RUN git clone --depth 1 --branch ${SERA_MCP_REF:-v0.8.2} https://github.com/sera-cx/sera-mcp.git sera-mcp
WORKDIR /opt/sera-mcp
RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev

# ── stage 2: build the gateway ─────────────────────────────────────────
FROM node:20-alpine AS gateway-build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY agents-gateway/package.json ./agents-gateway/
COPY agents-gateway/tsconfig.json ./agents-gateway/

RUN npm install --workspace=sera-agents-gateway --include-workspace-root --no-audit --no-fund

COPY agents-gateway/src ./agents-gateway/src
RUN npm run build --workspace=sera-agents-gateway

RUN npm prune --omit=dev --workspace=sera-agents-gateway --include-workspace-root

# ── stage 3: runtime ───────────────────────────────────────────────────
FROM node:20-alpine
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
