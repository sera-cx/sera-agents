# Cross-currency invoice payer

A minimal agent that demonstrates the headline Sera-for-Agents flow:

> *"I owe 5,000 MYR to a vendor at 0xabc... — what's the cheapest source asset in my treasury, and can you settle it for me?"*

Powered entirely by `sera.*` tools through the Sera MCP. The agent itself is ~100 lines.

## What it does

1. Calls `sera.list_currencies(fiat: 'MYR')` to find target stablecoins
2. Calls `sera.pay_invoice` with the user's source assets — Sera ranks them by USD-equivalent cost
3. Returns the cheapest path + the exact `sera.get_quote` invocation needed to execute
4. Optionally: with a wallet wired in, signs and submits via `sera.execute_swap`

## Run it

```bash
# 1. Install + build the Sera MCP first (see ../../README.md)

# 2. From this directory:
npm install
export OPENAI_API_KEY=sk-...
npm run start -- --owner 0xYourWallet --recipient 0xVendorWallet --amount 5000 --currency MYR
```

## Output (example)

```
[plan] cheapest source: USDC (estimated input: 1284.32 USDC, ≈ $1284.32)
[plan] runner-up:       USDT (estimated input: 1287.91 USDT, ≈ $1287.91)
[plan] failed sources:  EURC (no_liquidity)

To execute, call:
  sera.get_quote({
    from: "USDC",
    to:   "MYRT",
    amount: 1284.32,
    owner_address: "0xYourWallet",
    recipient:     "0xVendorWallet",
    gas_mode: "pay_more"
  })
then sign route_params with your wallet and call sera.execute_swap.
```

## Code

See `agent.ts`. Uses [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) — swap for the Anthropic SDK or any other host with two lines.
