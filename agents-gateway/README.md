# agents-gateway

Public HTTP + MCP gateway for [`agents.sera.cx`](https://agents.sera.cx). Wraps [`sera-mcp`](https://github.com/sera-cx/sera-mcp) and exposes a **keyless** surface for agent hosts:

| Endpoint | Method | Purpose |
|---|---|---|
| `/openapi.json` | GET | OpenAPI 3.1 description of the gateway |
| `/health` | GET | Liveness probe |
| `/rates` | GET | Live FX reference rates (multi-pair) |
| `/corridors` | GET | Supported FX corridors |
| `/quote` | POST | Live quote between two stablecoins |
| `/settle` | POST | Build an unsigned EIP-712 settlement intent |
| `/mcp` | POST/GET/DELETE | Streamable HTTP MCP transport (**17 tools**) |
| `POST /<proxy-tool>` | POST | Same 13 analytics tools as on `/mcp` (see below) |

## MCP tools (17, keyless)

The `/mcp` endpoint advertises **17** tools so any MCP-aware agent can use Sera without a wallet, an API key, or installing sera-mcp locally.

**Core (4)** — also available as REST `/quote`, `/settle`, `/corridors`, `/rates`:

| MCP tool | Role |
|---|---|
| `fx_quote` | Live quote between two assets |
| `fx_settle` | Build an unsigned EIP-712 settlement intent |
| `corridors` | Supported FX corridors |
| `rates` | Live FX reference rates |

**Analytics / planning (13)** — proxied to sera-mcp (see [`src/proxy-tools.ts`](./src/proxy-tools.ts)); also available as `POST /<name>`:

`markets` · `mid` · `compare_fx` · `market_health` · `spread_radar` · `find_deals` · `scan_markets` · `probe_depth` · `round_trip_cost` · `fx_quote_diff` · `compare_corridors` · `maker_quote_ladder` · `quote_recipient_amount`

Source of truth for the public catalog: [`.well-known/mcp.json`](../.well-known/mcp.json).

Account-scoped tools (balances, orders, withdraw, execution) are **not** exposed on this keyless gateway.

## How it works

`sera-mcp` is spawned as a stdio subprocess at startup. Each REST and MCP call translates to a `tools/call` against the relevant sera-mcp tool:

| Gateway route | sera-mcp tool |
|---|---|
| `GET /rates` | `sera.get_fx_rate` (fanned out per pair) |
| `GET /corridors` | `sera.list_currencies` (cross-product) |
| `POST /quote` | `sera.get_fx_rate` + local quote reservation |
| `POST /settle` | `sera.prepare_swap` |
| `POST /<proxy>` | matching `sera.*` tool from `PROXY_TOOLS` |

Quote reservations are kept in an in-memory map for 5 minutes — long enough for an agent to call `/quote` then `/settle`. No persistence; restarts invalidate outstanding `quote_id`s.

## Configuration

See [.env.example](./.env.example). All env vars optional except `PORT` / `SERA_MCP_PATH` for local runs.

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | TCP port to bind |
| `HOST` | `0.0.0.0` | Bind address |
| `SERA_NETWORK` | `mainnet` | `mainnet` or `sepolia` |
| `SERA_API_KEY` | _(unset)_ | Optional. Required only if you want Sera's account-level rate-limit/quota. All **17** keyless tools work without it. |
| `SERA_API_SECRET` | _(unset)_ | Optional, paired with `SERA_API_KEY`. |
| `SERA_MCP_PATH` | **required** (local) | Path to a built `sera-mcp/dist/index.js`. Baked at `/opt/sera-mcp/dist/index.js` in the Docker image. |

## Run locally

The gateway spawns `sera-mcp` as a subprocess, so you need a built copy on disk. One-time setup:

```bash
# Clone & build sera-mcp anywhere (pinned tag recommended)
git clone --branch v0.8.3 https://github.com/sera-cx/sera-mcp.git ~/code/sera-mcp
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

(Docker users don't need any of this — the image clones and builds sera-mcp at `v0.8.3` itself.)

In another terminal:

```bash
curl http://127.0.0.1:8787/health
curl 'http://127.0.0.1:8787/rates?pairs=USDC/BRLA,XSGD/IDRX'
curl http://127.0.0.1:8787/corridors
curl -X POST http://127.0.0.1:8787/quote \
  -H 'content-type: application/json' \
  -d '{"from_token":"XSGD","to_token":"IDRX","amount":"100"}'
curl -X POST http://127.0.0.1:8787/find_deals \
  -H 'content-type: application/json' \
  -d '{"min_deviation_bps":25}'
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

Detection lives in `src/errors.ts` (`rateLimitFromToolError`), called from `interpretToolResult` in `src/sera-mcp-client.ts`: it reads structured `_meta`/`structuredContent` first, then a text heuristic. See [docs/sera-mcp-error-contract.md](./docs/sera-mcp-error-contract.md) for the upstream sera-mcp change that makes this precise.

For an optional per-IP brake at the proxy, see the `rate_limit` template at the bottom of [`deploy/Caddyfile`](./deploy/Caddyfile) — it needs `caddy-ratelimit` via `xcaddy`.

## OpenAPI

The full OpenAPI 3.1 document is served at `GET /openapi.json` and source-of-truth-defined in [src/openapi.ts](./src/openapi.ts).

## MCP transport

`/mcp` implements the [MCP Streamable HTTP transport](https://spec.modelcontextprotocol.io/specification/basic/transports/) statelessly — every POST is a self-contained JSON-RPC exchange. Tools registered: the **17** listed above. Use any MCP-aware client (Claude, Cursor, OpenAI Agents SDK, etc.) by pointing it at `https://agents.sera.cx/mcp`.

## What's intentionally not here

- **No persistence.** Quote reservations live in process memory. Restarts drop outstanding `quote_id`s.
- **No execution path.** `/settle` / `fx_settle` return unsigned typed data — the caller signs and submits to Sera directly. The gateway never moves money.
- **No auth on the MCP endpoint.** The 17 exposed tools are read/analytics or signature-gated downstream. If you front this with anything other than Caddy + TLS, review the security model before exposing it.
