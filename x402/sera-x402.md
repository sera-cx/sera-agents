# Sera as an x402-payable service — design spec

## Why this matters

Coinbase's [x402](https://github.com/coinbase/x402) spec revives HTTP `402 Payment Required` as the standard for "agent pays API per call." Circle has built `agents.circle.com` on top of it, and is positioning USDC as **the** agent currency — `99.8% of x402 transaction volume is USDC` per their own marketing.

Circle has **no FX layer**. Every API in their catalog bills in USDC. This is a problem the moment your agent serves a user outside the dollar zone.

Sera should publish itself as an x402-payable service: agents pay USDC, Sera delivers any of 40+ stablecoins to a recipient address. This makes Sera a first-class citizen of the protocol Circle just legitimized — without competing with Circle's narrative.

## Endpoint design

### `POST /x402/swap`

Request (no payment yet):

```http
POST /x402/swap HTTP/1.1
Host: x402.sera.cx
Content-Type: application/json

{
  "from_currency": "USD",
  "to_currency":   "MYR",
  "amount":        100.00,        // in to_currency
  "recipient":     "0xVendor..."
}
```

Initial response (402 with payment requirements):

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Payment-Required: <x402-encoded-payment-requirements>

{
  "scheme": "exact",
  "asset":  "USDC",                 // Sera always settles inbound in USDC
  "amount": "26.42",                // computed from current FX + Sera fee
  "chain":  "1",
  "pay_to": "0xSeraVault...",
  "valid_until": 1778712345,
  "memo":   "swap-preview-<uuid>"   // ties to the quote we'll honor
}
```

Agent constructs payment authorization (per x402 spec), retries:

```http
POST /x402/swap HTTP/1.1
Host: x402.sera.cx
X-Payment: <signed-USDC-authorization>
Content-Type: application/json

{ /* same body as before */ }
```

Success response (200):

```json
{
  "success": true,
  "swap_uuid": "...",
  "trade_id":  "...",
  "delivered": {
    "currency": "MYR",
    "token":    "MYRT",
    "amount":   "100.00",
    "to":       "0xVendor...",
    "tx_hash":  "0x..."
  },
  "paid": {
    "currency": "USD",
    "token":    "USDC",
    "amount":   "26.42",
    "from":     "<x402-derived-payer>"
  },
  "fee_breakdown": {
    "sera_fee_usd":    "0.05",
    "gas_cost_usd":    "0.12",
    "fx_cost_usd":     "0.21"  // implicit spread
  }
}
```

## Why this is small to implement

The Sera MCP already has every primitive needed:

- `quote_recipient_amount` answers "how much USDC for X MYR?"
- `prepare_swap` produces the EIP-712 Intent
- `convert_and_send` with a hot vault wallet executes
- `settlement_status` polls for confirmation

The x402 service is essentially:
1. **Quote**: receive request → call `quote_recipient_amount` → encode as 402
2. **Verify payment**: per x402 spec — check signature, on-chain settlement of USDC payment authorization to the Sera vault
3. **Execute swap**: USDC in vault → swap to target token → deliver to recipient (uses Sera's existing infra, not the MCP)
4. **Confirm**: poll trade status, return success

## Why Sera, not Circle, ships this

Circle has zero incentive to do FX themselves — that's a different business and would dilute USDC. They want USDC outflow. **Sera giving them more reasons for agents to hold USDC is win-win.** A natural co-sell:

> "Top up your agent with USDC via Circle. When you need to settle in any other currency, Sera does the FX in one x402 call."

## Open questions

1. **Hosted vs self-hosted endpoint?** Sera hosting `x402.sera.cx` is the fast distribution play. Self-hostable artifact is the long-term openness play. Probably both — start hosted, open-source the server later.
2. **Pricing model?** Sera's existing swap fee + a small x402 service margin (5-10 bps?) covers ops. Or 0 markup as a loss-leader to drive Sera FX volume.
3. **Vault model?** The x402 endpoint needs a hot vault to receive USDC and execute outbound swaps atomically. This is the same vault model Sera already uses for `convert_and_send` in local-signer mode — production-tested.
4. **Catalog presence?** Get `x402.sera.cx` listed on `agents.circle.com` (they have a directory). Frame as complementary, not competitive.

## Suggested next steps

1. Build a thin Node service that wraps the existing Sera MCP's `quote_recipient_amount` + `convert_and_send` behind an x402 endpoint. ~200 LOC.
2. Deploy to a single endpoint (`x402.sera.cx`) on Cloudflare Workers / Fly / Railway.
3. Build a public demo: an agent that picks a non-USD-denominated paid API and uses Sera x402 to pay it.
4. Approach Circle to list it in their directory.
