# Sera x402 service

A standard HTTP endpoint that follows the [x402 protocol](https://github.com/coinbase/x402) for accepting USDC payments and delivering FX swaps via Sera. Any agent that knows how to pay an x402-priced API can use Sera without ever touching MCP, an EIP-712 wallet signer, or Sera's own SDK.

## What it does

```
Agent has USDC → POST /x402/swap → 402 with payment_required → Agent pays USDC →
  Service verifies payment → Calls Sera MCP for swap → Recipient receives target currency.
```

In one call from the agent's perspective. Two HTTP requests under the hood (the second one carries `X-PAYMENT`).

## Run locally

```bash
npm install
npm run demo                # X402_MODE=demo, listens on 127.0.0.1:8402 only
```

Demo mode binds to **localhost** by default. To expose demo mode publicly (e.g. for a hosted demo), you must explicitly set `X402_DEMO_PUBLIC=true` AND `HOST=0.0.0.0`. Doing so is risky — demo mode mocks payment verification AND the swap leg, returning a fake `tx_hash` indistinguishable from a real one.

For production (live mode):

```bash
export X402_MODE=live
export X402_FACILITATOR_URL=https://...   # required, refuses to start without it
export X402_VAULT_ADDRESS=0x...
export SIGNER_PRIVATE_KEY=0x...           # the vault key
npm start
```

The server refuses to start if `X402_MODE=live` is set without `X402_FACILITATOR_URL`.

Test from another terminal:

```bash
# 1. Initial request — get 402 with payment requirements
curl -i -X POST http://localhost:8402/x402/swap \
  -H 'Content-Type: application/json' \
  -d '{"from_currency":"USD","to_currency":"MYR","amount":100,"recipient":"0xVendor"}'

# Response is 402 with body containing payment_id and amount_usdc.
# Note the payment_id from the response.

# 2. Retry with X-PAYMENT header
curl -i -X POST http://localhost:8402/x402/swap \
  -H 'Content-Type: application/json' \
  -H 'X-PAYMENT: <PAYMENT_ID>:demo-authorization' \
  -d '{"from_currency":"USD","to_currency":"MYR","amount":100,"recipient":"0xVendor"}'

# Response is 200 with mocked trade_id, tx_hash, and delivered details.
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Service-discovery JSON (name, supported corridors, mode) |
| `GET` | `/health` | Health check |
| `POST` | `/x402/quote` | Quote-only — no payment, no reservation |
| `POST` | `/x402/swap` | Main flow. Without `X-PAYMENT` returns 402; with it executes the swap |

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8402` | Listen port |
| `X402_MODE` | `demo` | `demo` (mocks payment + swap) or `live` (real x402 + real Sera) |
| `SERA_MCP_DIST` | `~/Desktop/sera-mcp/dist/index.js` | Path to the built Sera MCP |
| `SERA_NETWORK` | `mainnet` | Passed to the MCP |
| `POLICY_PRESET` | `standard` | Passed to the MCP |
| `X402_VAULT_ADDRESS` | burn address | Wallet that holds pooled USDC + signs Sera intents (live mode only) |
| `X402_SURCHARGE_BPS` | `0` | Optional service margin on top of the Sera quote |
| `SIGNER_PRIVATE_KEY` | — | Vault private key (live mode only — Sera MCP runs in `local` signer mode) |
| `RPC_URL` | — | Ethereum RPC for on-chain payment verification (live mode only) |

## Production deployment

To run in `live` mode you need:

1. **A funded vault wallet** holding USDC for the swaps. The address goes in `X402_VAULT_ADDRESS`; the key in `SIGNER_PRIVATE_KEY`.
2. **An x402 payment facilitator** to verify/submit the EIP-3009 authorizations. Coinbase publishes one; the verification stub in this service is intentionally minimal.
3. **The Sera MCP in local signer mode**: set `SERA_SIGNER_MODE=local` in the env passed to the MCP subprocess. The vault key is what signs Sera Intents.
4. **Tight policy**: `POLICY_DAILY_VOLUME_CAP_USD`, `POLICY_MAX_NOTIONAL_USD`, `POLICY_ALLOWED_RECIPIENTS` if you want to constrain destinations.

Deploy targets that work well for this shape: Cloudflare Workers (with the Workers-compatible Hono build), Fly.io, Railway, Vercel functions, or a small VPS. The Sera MCP subprocess pattern means stateful platforms work better than pure FaaS.

## What's not built yet

- Real EIP-3009 verification (pluggable; see `verifyPayment` in `server.ts`)
- Coinbase facilitator integration
- Rate limiting per requesting IP
- Persistent payment-id storage (currently in-memory; restart drops pending payments)
