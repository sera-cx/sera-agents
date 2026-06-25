# agents.sera.cx gateway

A thin Node origin that turns the **embedded `sera-mcp` engine** into the public,
agent-facing surface specified for `agents.sera.cx`: a curated REST API, an
OpenAPI 3.1 contract, and a **curated Streamable HTTP MCP endpoint** — plus the
discovery headers, CORS, and `robots.txt` that agent crawlers and LLM tool
registries key on.

It is deliberately **read-mostly and key-less**: it can quote and return
*unsigned* EIP-712 typed data, and it can **never** sign, execute, or withdraw.

## Why a server (and not the static site)

`agents.sera.cx` currently ships as a **static GitHub Pages site** (the docs +
landing page in this repo). Pages can serve `/openapi.json` and `robots.txt`,
but it **cannot** serve `POST /mcp`, `POST /quote`, `POST /settle`, or set the
`Link:`/CORS response headers. Those need a real origin — this gateway. Run it
behind a TLS reverse proxy on the `agents.sera.cx` hostname (or a subpath), with
Pages continuing to serve the static docs.

## Endpoints

| Method | Path | Maps to (sera-mcp) | Notes |
|--------|------|--------------------|-------|
| `GET`  | `/openapi.json` | — | OpenAPI 3.1 (same file the static site serves) |
| `GET`  | `/corridors` | `sera.get_markets` | supported FX corridors |
| `GET`  | `/rates?pairs=A/B,C/D` | `sera.get_fx_rate` | reference rates per pair |
| `POST` | `/quote` | `sera.get_quote` (`simulate`) | live quote → `quote_id` |
| `POST` | `/settle` | `sera.prepare_swap` | unsigned EIP-712 `Intent` for `signer` |
| `POST` | `/mcp` | curated 4 tools | Streamable HTTP MCP (stateless JSON) |
| `GET`  | `/health` | — | liveness |
| `GET`  | `/robots.txt` | — | crawler policy |

The MCP tools are exactly `fx_quote`, `fx_settle`, `corridors`, `rates` — the
names the marketing copy and `.well-known` files reference. **sera-mcp's own
50+ tools (including `execute_swap`, `convert_and_send`, `withdraw_*`) are NOT
exposed** — `/mcp` is a curated re-implementation, not a passthrough.

## The quote → settle flow

`/quote` prices with a burn-address `simulate` call (no wallet needed), mints an
opaque `quote_id`, and remembers `{from,to,amount}`. `/settle` looks that up and
re-quotes with the caller's **real** `signer` as owner, returning the executable
`Intent` typed data for the wallet to sign. The caller then submits the signed
intent to Sera directly (or via a sera-mcp they control) — the gateway never
holds a key.

> EIP-712: `domain = { name:"Sera", version:"1", chainId, verifyingContract }`,
> `primaryType = "Intent"`, types mirrored from sera-mcp `src/signer/signer.ts`.
> `chainId` is `1` (mainnet) / `11155111` (sepolia); `verifyingContract` is read
> from `sera.doctor` at boot.

## Run locally

```bash
# 1. Build the engine next to this repo
git clone https://github.com/sera-cx/sera-mcp && (cd sera-mcp && npm i && npm run build)

# 2. Start the gateway (defaults: 127.0.0.1:8787, mainnet)
cd sera-agents/agents-gateway
cp .env.example .env        # adjust SERA_NETWORK / SERA_MCP_DIST as needed
npm install
npm start

# 3. Smoke test
curl localhost:8787/health
curl 'localhost:8787/rates?pairs=USDC/BRLA'
curl -X POST localhost:8787/quote -H 'content-type: application/json' \
  -d '{"from_token":"USDC","to_token":"BRLA","amount":"100"}'
```

`npm test` runs the adapter + MCP unit tests (mocked engine — no network).

## Security posture

- **No key custody, no execution.** sera-mcp is booted with
  `SERA_SIGNER_MODE=readonly` and `SERA_ENABLE_EXECUTION_TOOLS=false` (set by
  `server.ts`). Do not set `SIGNER_PRIVATE_KEY` for this process.
- **No built-in auth.** The read endpoints are public by design; `/settle`
  returns unsigned data only. Bind to localhost and **front with a TLS reverse
  proxy** that owns the `agents.sera.cx` host. Never expose the raw port.
- **Input validation** at the adapter boundary (symbols, addresses, pair count).

## Deploy checklist (from the infra hand-off)

- [x] `GET /openapi.json` → OpenAPI 3.1
- [x] `GET /corridors`, `GET /rates`
- [x] `POST /quote`, `POST /settle` (unsigned EIP-712)
- [x] `POST /mcp` curated Streamable HTTP MCP
- [x] `Link:` headers + open CORS on every response
- [x] `robots.txt`
- [ ] **DNS TXT** at `_agent.sera.cx` (registrar — not code):
      `"v=agent1; endpoint=https://agents.sera.cx/mcp; openapi=https://agents.sera.cx/openapi.json; card=https://sera.cx/.well-known/agent.json"`
- [ ] Reverse proxy: TLS + `agents.sera.cx` Host → this gateway; keep GitHub
      Pages serving the static docs (e.g. proxy only the API paths).
- [ ] Confirm the defensive response-field mappings (`/rates`, `/corridors`,
      `network_cost`) against a **live** sera-mcp — they were reconciled against
      v0.8.3 source, not a live API (build env is egress-restricted).

## Caveats

- **Single instance.** The quote store is in-memory; a multi-replica deploy
  needs a shared store (Redis) so `/settle` can find a `/quote` from another
  replica.
- **Stateless MCP.** `/mcp` does request→response JSON only (no server-initiated
  SSE), which is the recommended mode for serverless/multi-instance hosts.
