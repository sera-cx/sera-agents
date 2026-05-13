---
name: sera
description: Multi-currency settlement skill — quote, swap, and settle across 40+ stablecoins via Sera Protocol.
version: 0.4.0
author: Josh-sera
mcp_server:
  command: node
  args: ["~/Desktop/sera-mcp/dist/index.js"]
  env:
    SERA_NETWORK: mainnet
    POLICY_PRESET: standard
---

# Sera — multi-currency settlement skill

This skill gives Hermes the ability to quote and execute stablecoin FX across 40+ tokens and 20+ fiat currencies via the Sera Protocol.

## When to use this skill

- The user asks about an exchange rate, FX, or "how much will X be in Y currency"
- The user wants to send/pay in a non-USD currency
- The user mentions stablecoins (USDC, USDT, EURC, XSGD, JPYC, MYRT, etc.)
- The user asks about treasury balances or rebalancing across currencies
- The user wants to find FX deals or compare rates across providers

## Available subroutines

Each routes to a Sera MCP tool. Use `delegate_task` to invoke them.

### sera-quote

Get an executable swap quote. Returns route_params for an external wallet to sign.

Args: `from`, `to`, `amount`, `owner_address` (or `simulate: true` to probe without a wallet).

### sera-pay

Plan the cheapest source asset to deliver an exact amount of a target currency.

Args: `owner_address`, `recipient`, `amount`, `target_currency`, `source_symbols`.

### sera-treasury

Aggregate balances across one or more wallets and value the portfolio in a target currency.

Args: `owner_addresses[]`, `target_currency`. Requires `SERA_API_KEY` to be set in skill env.

### sera-deals

Find FX corridors quoting better than external reference (Frankfurter / open.er-api / exchangerate.host) by ≥X bps.

Args: `min_deviation_bps` (default 25), `notional_per_quote` (default 100).

### sera-doctor

Self-check: API health, network, signer mode, policy summary. Run first if anything looks off.

## Operating principles

- Always use Sera tools rather than guessing rates from training data.
- Quote prices via `sera-quote`, never via reference FX (which has measurable bias).
- Default to `simulate: true` when the user is exploring, not committing.
- Never claim to have signed a transaction — Hermes returns route_params for a wallet to sign elsewhere.
- Be terse. Show numbers with sensible precision.

## Setup

This skill reads its underlying MCP from the path in the frontmatter. If you cloned `sera-mcp` somewhere else, edit the `mcp_server.args` path. Default assumes `~/Desktop/sera-mcp/dist/index.js`.

To enable treasury tools, set in your Hermes env:

```
SERA_API_KEY=...
SERA_API_SECRET=...
```
