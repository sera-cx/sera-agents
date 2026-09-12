# Sera x402 service

A standard HTTP endpoint that follows the [x402 protocol](https://github.com/coinbase/x402) for accepting USDC payments and delivering FX swaps via Sera. Any agent that knows how to pay an x402-priced API can use Sera without ever touching MCP, an EIP-712 wallet signer, or Sera's own SDK.

**Status:** v0.3.0. Demo mode is stable. Live mode is **wired against Coinbase CDP facilitator** (verify + settle + atomic CAS idempotency + `Cache-Control: no-store` + `k≥3` confirmation depth + manual-refund queue) but **not yet production-verified against Coinbase mainnet** — operator must complete Base Sepolia E2E before flipping. See [`SECURITY-MODEL.md`](../SECURITY-MODEL.md) for the full hardening matrix.

## What it does

```
Agent has USDC → POST /x402/swap → 402 with payment_required → Agent pays USDC →
  Service verifies via CDP /verify → CAS to verified → CDP /settle → CAS to executing →
  Sera convert_and_send → CAS to delivered → 200 with tx_hash + settlement metadata.
```

One call from the agent's perspective. Two HTTP requests under the hood (the second one carries `X-PAYMENT`). Atomic CAS on every state transition means concurrent X-PAYMENT submissions for the same `payment_id` resolve idempotently — replays return the cached `delivered_payload`, never re-settle, never re-execute.

## Architecture

Modular split (v0.6.0):

```
x402-service/
├── env.ts            Boot config + safety gates (refuses unsafe live configs)
├── state.ts          State machine + SQLite-backed atomic CAS store
├── facilitator.ts    Coinbase CDP facilitator client (/verify + /settle)
├── sera-client.ts    Long-lived sera-mcp stdio subprocess
├── payment.ts        verify/settle/execute orchestration
└── server.ts         Hono routes + rate-limit + concurrency cap + boot
```

## Run locally (demo mode)

```bash
npm install
npm run demo                # X402_MODE=demo, listens on 127.0.0.1:8402 only
```

Demo mode binds to **localhost** by default. To expose demo mode publicly (e.g. for a hosted demo), set `X402_DEMO_PUBLIC=true` AND `HOST=0.0.0.0`. Risky — demo mode mocks payment verification AND the swap leg. Demo settlements are self-identifying in the record itself: every demo `tx_hash` is `demo_<payment_id>`, which matches no live hash shape, and the persisted row carries `demo = 1`. The `X-Sera-Demo-Mode: true` response header remains, but it is no longer the only thing distinguishing demo from live.

Test from another terminal:

```bash
# 1. Initial request — get 402 with payment requirements
curl -i -X POST http://localhost:8402/x402/swap \
  -H 'Content-Type: application/json' \
  -d '{"from_currency":"USD","to_currency":"MYR","amount":100,"recipient":"0xVendor"}'

# Response is 402 with body containing payment_id and amount_usdc.

# 2. Retry with X-PAYMENT header
curl -i -X POST http://localhost:8402/x402/swap \
  -H 'Content-Type: application/json' \
  -H 'X-PAYMENT: <PAYMENT_ID>:demo-authorization' \
  -d '{"from_currency":"USD","to_currency":"MYR","amount":100,"recipient":"0xVendor"}'

# Response is 200 with mocked trade_id, tx_hash:"demo_<payment_id>", X-Sera-Demo-Mode header.
```

## Run live (Coinbase CDP facilitator)

Required env (boot refuses if any is missing):

```bash
export X402_MODE=live
export X402_NETWORK=base-sepolia                # start on testnet
export X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
export X402_CDP_API_KEY_ID=...                  # CDP API Key Identifier
export X402_CDP_API_KEY_SECRET=...              # CDP EC private key in PEM format (to sign ES256 JWTs)
export X402_VAULT_ADDRESS=0xYourVault            # where USDC lands
export X402_CONFIRMATION_DEPTH=3                 # ≥3 per arXiv:2605.11781 (mitigates revert-grant)
export X402_LIVE_ACK=true                        # operator acknowledges live wiring not yet
                                                  # production-tested against Coinbase mainnet

# Plus sera-mcp wiring (uses convert_and_send → needs local-signer mode):
export SERA_NETWORK=mainnet
export SERA_SIGNER_MODE=local
export SIGNER_PRIVATE_KEY=0x...                  # intentionally-funded wallet only
export SERA_API_KEY=sera_...
export SERA_API_SECRET=...

# Tight policy caps for the surface:
export POLICY_PRESET=starter
export POLICY_MAX_NOTIONAL_USD=500
export POLICY_DAILY_VOLUME_CAP_USD=5000

# Persistence:
export X402_STATE_DB=/var/lib/sera-x402/state.db

# Optional admin endpoint for manual-refund queue visibility:
export X402_ADMIN_TOKEN=...

npm start
```

After verifying end-to-end on Base Sepolia, switch `X402_NETWORK=base` for mainnet. Don't switch any other knobs.

## Run live (self-hosted facilitator — any EVM chain, incl. Ethereum Sepolia)

The facilitator backend is pluggable. Instead of Coinbase CDP you can run your
own x402 facilitator (e.g. the Apache-2.0 reference implementation from
[coinbase/x402](https://github.com/coinbase/x402)) against any EVM RPC and
point this service at it:

```bash
export X402_MODE=live
export X402_FACILITATOR_KIND=selfhosted
export X402_FACILITATOR_URL=https://your-facilitator.example/x402
export X402_FACILITATOR_TOKEN=...        # optional static bearer for YOUR facilitator
export X402_NETWORK=eip155:11155111      # e.g. Ethereum Sepolia
export X402_USDC_ADDRESS=0x...           # payment asset on that chain (required)
export X402_VAULT_ADDRESS=0x...
export X402_RPC_URL=https://...          # RPC YOU control on the payment chain
export X402_LIVE_ACK=true
```

This removes the Coinbase dependency entirely and lets the payment leg run on
the same chain as Sera settlement (Ethereum), eliminating the cross-chain
hand-off.

### Trust model: the facilitator is NOT trusted with delivery

**Self-host at your own risk — and read this before running live.** Whoever
operates this service custodies the vault; Sera does not host it.

A facilitator (CDP or your own) only *reports* verify/settle results. A
compromised facilitator could report success for a payment that never
happened — so this service **independently confirms the payment on-chain**
before executing any swap, and **binds that confirmation to the specific
payment**: it first **verifies the payer's EIP-3009 signature** — recovering the signer of
the `transferWithAuthorization` typed data and requiring it to equal `from`, so
a malicious facilitator cannot name a payer (or a victim) it doesn't hold the
key for. Then via `X402_RPC_URL` it checks the settle transaction succeeded and
emitted a USDC `Transfer` **from that verified payer**, of **exactly the
authorized value**, **to the vault address**, buried under ≥
`X402_CONFIRMATION_DEPTH` blocks. Each settle tx hash is then **consumed
single-use** (persisted to `X402_STATE_DB`, required in live mode), so one
on-chain payment can authorize at most one delivery — a facilitator pointing at someone else's
legitimate transfer, or replaying one deposit across many payment_ids, is
refused. Until the bound check passes the payment stays un-executed and
clients get `202 payment_not_confirmed_onchain`.

Consequences of a hacked self-hosted facilitator are therefore bounded: it can
censor/DoS payments and waste its own gas wallet, but it cannot trigger free
FX delivery from the vault (blocked by the on-chain gate) and it cannot steal
buyer funds (EIP-3009 signatures are scoped to exact amount/recipient). The
key that CAN drain the vault is the swap signer (`SIGNER_PRIVATE_KEY`) — keep
it off the facilitator host, ideally in a KMS/HSM, and fund the vault only to
operating float.

Opting out of the gate (`X402_SKIP_ONCHAIN_CONFIRM=true`) restores blind trust
in the facilitator and is not recommended for real funds.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Service-discovery JSON (name, supported corridors, mode, network) |
| `GET` | `/health` | Health check (mode, demo flag, pending count, swap concurrency, mcp_running, facilitator_configured) |
| `POST` | `/x402/quote` | Quote-only — no payment, no reservation |
| `POST` | `/x402/swap` | Main flow. Without `X-PAYMENT` returns 402; with it runs the verify→settle→execute state machine |
| `GET` | `/admin/refundables` | (Auth: `Bearer ${X402_ADMIN_TOKEN}`) List `failed_refundable` payments for manual operator refund |

All `/x402/*` responses carry `Cache-Control: no-store, no-cache, private` + `Pragma: no-cache` — mitigates Attack III (CDN cache leak).

## Environment

Selected vars (full list in `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8402` | Listen port |
| `HOST` | `127.0.0.1` | Bind host |
| `X402_MODE` | `demo` | `demo` (mocks payment + swap) or `live` (CDP facilitator + real Sera) |
| `X402_LIVE_ACK` | `false` | Required `true` to boot `X402_MODE=live` — operator ack of not-yet-mainnet-tested |
| `X402_NETWORK` | `base` | `base` / `base-sepolia` / `polygon` / `arbitrum` / `solana` |
| `X402_FACILITATOR_URL` | — | CDP facilitator endpoint (live mode only) |
| `X402_CDP_API_KEY_ID` | — | CDP API key identifier (live mode only) |
| `X402_CDP_API_KEY_SECRET` | — | CDP EC private key in PEM format used to sign ES256 JWTs (live mode only) |
| `X402_VAULT_ADDRESS` | — | Wallet that holds pooled USDC + signs Sera intents (live mode only) |
| `X402_CONFIRMATION_DEPTH` | `3` | Confirmation depth before release. Boot refuses < 3 in live mode. |
| `X402_STATE_DB` | — | SQLite path for payment state (recommended for live; memory-only otherwise) |
| `X402_ADMIN_TOKEN` | — | Bearer token gating `/admin/refundables` |
| `SERA_MCP_DIST` | _(required)_ | Path to the built Sera MCP (`…/sera-mcp/dist/index.js`) |
| `SERA_NETWORK` | `mainnet` | Passed to the MCP |
| `SERA_SIGNER_MODE` | (none) | Pass `local` for live mode; the embedded MCP signs Sera Intents |
| `SIGNER_PRIVATE_KEY` | — | Vault private key (live mode only) |
| `POLICY_PRESET` | `standard` | Passed to the MCP |
| `X402_SURCHARGE_BPS` | `0` | Optional service margin on top of the Sera quote |

## Threat model coverage (arXiv:2605.11781)

| Attack | Status (v0.6.0) |
|---|---|
| I-A — Revert-grant | **Mitigated** via `X402_CONFIRMATION_DEPTH ≥ 3` boot gate |
| I-B — Settlement preemption | **Mitigated** via CDP facilitator (bounds caller identity) |
| II — Replay / idempotency | **Mitigated** via atomic CAS on every state transition |
| III — CDN cache leak | **Mitigated** via `Cache-Control: no-store, no-cache, private` on /x402/* |
| IV — Server-selection | N/A (direct endpoint, no Bazaar registry use) |

## Remaining gate before mainnet flip

**Live testnet E2E verification** — see [`E2E-SEPOLIA.md`](./E2E-SEPOLIA.md) for the full runbook. Every payment check is fail-closed, so only a *real* payment that **succeeds** proves the EIP-712 USDC domain (`X402_USDC_NAME`/`_VERSION`) is right — a mismatch silently rejects every payment. Run:

```bash
npm run e2e:sepolia   # proofs 1 (succeeds), 2 (depth≥3), 4 (forged-from rejected); env-gated
```

against a running live-mode service + self-hosted facilitator on Ethereum Sepolia (`eip155:11155111`). Proof 3 (cross-payment `txHash` replay + restart persistence) is facilitator/restart-orchestrated in the runbook. The fragile client↔server crypto contract is also checked with no infra in CI (`test/e2e-client-contract.test.ts`). Keep `X402_RPC_URL` set and never `X402_SKIP_ONCHAIN_CONFIRM=true` in production. Then switch `X402_NETWORK`/`X402_CHAIN_ID` to your settlement mainnet.

## What's not built yet

- **Automated facilitator settlement-reversal** for the `failed_refundable` queue. Currently operator-driven via `/admin/refundables`; pending CDP-side support.
- **OAuth / token auth on /admin/refundables.** Current `X402_ADMIN_TOKEN` Bearer is fine for internal ops; not designed for multi-operator setups.
- **Multi-instance horizontal scale.** SQLite single-instance only; switching to Redis (or libSQL) for shared state is a straightforward `state.ts` refactor when needed.

## Deploy targets

Stateful platforms (Fly.io, Railway, EC2/VPS, your own k8s) work best — the sera-mcp subprocess pattern + SQLite persistence + long-lived facilitator client all want stable hosts. Pure FaaS (Cloudflare Workers, Vercel Functions) require swapping the MCP subprocess for a remote sera-mcp Streamable HTTP target and swapping SQLite for an external KV/DB.
