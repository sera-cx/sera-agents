# Treasury rebalancer

A lights-out agent that values a multi-wallet stablecoin treasury, computes drift from a target weight allocation, and emits the swap list needed to rebalance.

Powered by `sera.treasury_value` + `sera.rebalance_plan`. Optionally executes via `sera.execute_swap` when given a signing wallet.

## Use case

Treasury target: **40% USD / 30% SGD / 20% MYR / 10% EUR**, valued in USD.
Across 3 of your wallets.

Run it and the agent:

1. Pulls balances across all 3 wallets via `sera.treasury_value`
2. Computes drift from target weights
3. Emits a list of swaps to bring you back to target
4. (optional) Hands you the exact `sera.get_quote` calls to execute

## Run it

```bash
npm install
export OPENAI_API_KEY=sk-...

# Plan only (no execution):
npm run start -- \
  --wallets 0xA,0xB,0xC \
  --target USD:40,SGD:30,MYR:20,EUR:10 \
  --reporting-currency USD
```

Requires `SERA_API_KEY` + `SERA_API_SECRET` on the Sera MCP for `treasury_value` (balances endpoint is auth-gated).

## Output (example)

```
Treasury value: $128,440.32 USD across 3 wallets

Current exposure:
  USD  $74,001.10  (57.6%)   target 40%   ↑ +17.6pp
  SGD  $14,201.00  (11.1%)   target 30%   ↓ -18.9pp
  MYR  $26,302.18  (20.5%)   target 20%   ↑  +0.5pp
  EUR  $13,936.04  (10.8%)   target 10%   ↑  +0.8pp

Suggested trades (3):
  1. Move ~$24,295 USD-equivalent  USDC → XSGD   (close SGD underweight)
  2. Skip MYR rebalance (within 1pp)
  3. Skip EUR rebalance (within 1pp)
```
