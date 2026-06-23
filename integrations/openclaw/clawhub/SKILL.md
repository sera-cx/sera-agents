---
name: sera
description: Multi-currency settlement for AI agents. Quote, swap, and settle across 40+ stablecoins (USDC, USDT, EURC, XSGD, JPYC, MYRT, TGBP, BRZ, MXNT, IDRT, AUDD, and more) and 20+ fiat currencies via Sera Protocol. 32 tools — quotes, swaps, treasury management, FX deal scanning, and a maker spread ladder.
metadata:
  openclaw:
    requires:
      env:
        - SERA_NETWORK
      bins:
        - node
    primaryEnv: SERA_NETWORK
    optionalEnv:
      - SERA_API_KEY        # required for treasury_value, balances, settlement_status
      - SERA_API_SECRET
      - SERA_HISTORY_DB     # enables fx_history, fx_volatility, corridor_pnl
      - POLICY_PRESET       # starter | standard | sg-retail | open
---

# Sera — multi-currency settlement skill

Multi-currency settlement infrastructure for AI agents. Connects OpenClaw to [Sera Protocol](https://docs.sera.cx) — stablecoin FX with on-chain non-custodial settlement.

## Setup

1. Build the Sera MCP locally (one-time):

   ```bash
   git clone https://github.com/sera-cx/sera-mcp
   cd sera-mcp && npm install && npm run build
   ```

2. Add Sera to your `openclaw.json` `mcpServers` block:

   ```json
   {
     "mcpServers": {
       "sera": {
         "command": "node",
         "args": ["/absolute/path/to/sera-mcp/dist/index.js"],
         "env": {
           "SERA_NETWORK": "mainnet",
           "POLICY_PRESET": "standard"
         }
       }
     }
   }
   ```

3. Restart your OpenClaw agent. 32 `sera.*` tools are now available.

## Verify

In any agent session:

```
@sera doctor
```

Expect `overall_ok: true` with checks for sera_health, network_sanity, tokens_registry, signer_mode, policy.

## Common patterns

- **Pay an invoice in any local currency**: `sera.pay_invoice` finds the cheapest source asset in your treasury.
- **Treasury value across multiple wallets**: `sera.treasury_value` aggregates and reports in any target currency.
- **Find FX deals**: `sera.find_deals` scans markets in parallel, diffs against external mid, ranks results.
- **Maker spread calculator**: `sera.maker_quote_ladder` shows earnings at 5/10/15/25/50/100/200 bps for any pair + notional.

## Source

- MCP: https://github.com/sera-cx/sera-mcp
- Suite (templates, x402, integrations): https://github.com/sera-cx/sera-agents
- Sera Protocol docs: https://docs.sera.cx

## License

MIT.
