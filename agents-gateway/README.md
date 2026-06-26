# agents-gateway

Public HTTP + MCP gateway for `agents.sera.cx`. Wraps [`sera-mcp`](https://github.com/sera-cx/sera-mcp) and exposes the four agent-discoverable endpoints advertised by the marketing site:

| Endpoint | Method | Purpose |
|---|---|---|
| `/openapi.json` | GET | OpenAPI 3.1 description of the gateway |
| `/health` | GET | Liveness probe |
| `/rates` | GET | Live FX reference rates (multi-pair) |
| `/corridors` | GET | Supported FX corridors |
| `/quote` | POST | Live quote between two stablecoins |
| `/settle` | POST | Build an unsigned EIP-712 settlement intent |
| `/mcp` | POST/GET/DELETE | Streamable HTTP MCP transport (4 tools) |

The MCP `/mcp` endpoint exposes the same four operations as MCP tools — `fx_quote`, `fx_settle`, `corridors`, `rates` — so any MCP-aware agent can use Sera without a wallet, an API key, or installing sera-mcp locally.

## How it works

`sera-mcp` is spawned as a stdio subprocess at startup. Each REST and MCP call translates to a `tools/call` against the relevant sera-mcp tool:

| Gateway route | sera-mcp tool |
|---|---|
| `GET /rates` | `sera.get_fx_rate` (fanned out per pair) |
| `GET /corridors` | `sera.list_currencies` (cross-product) |
| `POST /quote` | `sera.get_fx_rate` + local quote reservation |
| `POST /settle` | `sera.prepare_swap` |

Quote reservations are kept in an in-memory map for 5 minutes — long enough for an agent to call `/quote` then `/settle`. No persistence; restarts invalidate outstanding `quote_id`s.

## Configuration

See [.env.example](./.env.example). All env vars optional except `PORT`.

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | TCP port to bind |
| `HOST` | `0.0.0.0` | Bind address |
| `SERA_NETWORK` | `mainnet` | `mainnet` or `sepolia` |
| `SERA_API_KEY` | _(unset)_ | Optional. Required only if you want Sera's account-level rate-limit/quota. The 4 public tools work keyless. |
| `SERA_API_SECRET` | _(unset)_ | Optional, paired with `SERA_API_KEY`. |
| `SERA_MCP_PATH` | **required** | Path to a built `sera-mcp/dist/index.js`. Baked at `/opt/sera-mcp/dist/index.js` in the Docker image. |
| `TRUST_PROXY` | `1` | Set when behind Caddy / a reverse proxy. |

## Run locally

The gateway spawns `sera-mcp` as a subprocess, so you need a built copy on disk. One-time setup:

```bash
# Clone & build sera-mcp anywhere (pinned tag recommended)
git clone --branch v0.8.2 https://github.com/sera-cx/sera-mcp.git ~/code/sera-mcp
cd ~/code/sera-mcp && npm ci && npm run build
```

Then from the `sera-agents` repo root:

```bash
npm install
SERA_MCP_PATH=~/code/sera-mcp/dist/index.js \
  npm run dev --workspace=sera-agents-gateway
```

Or to run the compiled build:

```bash
npm run build --workspace=sera-agents-gateway
SERA_MCP_PATH=~/code/sera-mcp/dist/index.js \
  npm run start --workspace=sera-agents-gateway
```

(Docker users don't need any of this — the image clones and builds sera-mcp at `v0.8.2` itself.)

In another terminal:

```bash
curl http://127.0.0.1:8787/health
curl 'http://127.0.0.1:8787/rates?pairs=USDC/BRLA,XSGD/IDRX'
curl http://127.0.0.1:8787/corridors
curl -X POST http://127.0.0.1:8787/quote \
  -H 'content-type: application/json' \
  -d '{"from_token":"XSGD","to_token":"IDRX","amount":"100"}'
```

## Docker

The Dockerfile is multi-stage and runs from the **repo root** as build context (workspace install needs the root `package.json`):

```bash
# From the sera-agents repo root:
docker build -f agents-gateway/Dockerfile -t sera-agents-gateway:latest .
docker run --rm -p 8787:8787 \
  -e SERA_NETWORK=mainnet \
  sera-agents-gateway:latest
```

The image is non-root, runs `node dist/server.js`, and includes a `HEALTHCHECK` against `/health`.

## Deploy

The full agents.sera.cx stack — Caddy + this gateway + the static landing — is wired up in the repo root [`docker-compose.yml`](../docker-compose.yml), with Caddy config at [`deploy/Caddyfile`](./deploy/Caddyfile). Step-by-step setup, DNS, and rollout instructions live in [`DEPLOY.md`](../DEPLOY.md).

The image is published to `ghcr.io/sera-cx/sera-agents-gateway:latest` on every push to main that touches gateway code, via [`.github/workflows/publish-gateway.yml`](../.github/workflows/publish-gateway.yml).

### Throttle behavior

There is **no auth and no rate limiter inside the gateway** — rate limiting is owned by the Sera API (keyed to `SERA_API_KEY`). When Sera throttles, the gateway surfaces it honestly instead of a generic 502:

- **REST** → `429` with a `Retry-After` header.
- **`/mcp`** → an `isError` tool result tagged `429: … (retry after Ns)`.

Detection is in `src/sera-mcp-client.ts` (`interpretToolResult` / `rateLimitFromToolError`): it reads structured `_meta`/`structuredContent` first, then a text heuristic. See [docs/sera-mcp-error-contract.md](./docs/sera-mcp-error-contract.md) for the upstream sera-mcp change that makes this precise.

For an optional per-IP brake at the proxy, see the `rate_limit` template at the bottom of [`deploy/Caddyfile`](./deploy/Caddyfile) — it needs `caddy-ratelimit` via `xcaddy`.

## OpenAPI

The full OpenAPI 3.1 document is served at `GET /openapi.json` and source-of-truth-defined in [src/openapi.ts](./src/openapi.ts).

## MCP transport

`/mcp` implements the [MCP Streamable HTTP transport](https://spec.modelcontextprotocol.io/specification/basic/transports/) statelessly — every POST is a self-contained JSON-RPC exchange. Tools registered: `fx_quote`, `fx_settle`, `corridors`, `rates`. Use any MCP-aware client (Claude, Cursor, OpenAI Agents SDK, etc.) by pointing it at `https://agents.sera.cx/mcp`.

## What's intentionally not here

- **No persistence.** Quote reservations live in process memory. Restarts drop outstanding `quote_id`s.
- **No execution path.** `/settle` returns unsigned typed data — the caller signs and submits to Sera directly. The gateway never moves money.
- **No auth on the MCP endpoint.** The four exposed tools are read-only or signature-gated downstream. If you front this with anything other than Caddy + TLS, review §5 of [`agents-handoff.md`](../../Sera v1 Mainnet/agents-handoff.md) before exposing it.
