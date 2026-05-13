# Sera Agent — the bundled stack

For teams without an existing agent. One repository, one command, end-to-end:

- The Sera MCP (32 tools) pre-wired
- Your choice of LLM provider (OpenAI by default, Anthropic supported)
- Interactive CLI chat surface
- Reference flows (invoice payer, treasury rebalancer) callable in-conversation
- x402 endpoint integration coming next

## Run it

```bash
cd sera-agent
npm install
export OPENAI_API_KEY=sk-...
# Optional: SERA_API_KEY + SERA_API_SECRET to unlock balances and treasury tools
npm start
```

You'll get an interactive prompt connected to the Sera MCP. Try:

```
> What stablecoins do you support for SGD?
> How much would I need to send in USDC to pay my vendor exactly 5,000 MYR?
> Find me FX corridors quoting better than ECB mid by 25bps
> Show me the maker spread ladder for USDT/JPYC at 30k notional
```

## Architecture

```
┌────────────┐   chat    ┌────────────────┐   MCP    ┌──────────┐   REST   ┌──────┐
│   You      │ ────────▶ │   Sera Agent   │ ───────▶ │ Sera MCP │ ───────▶ │ Sera │
│ (terminal) │           │  (OpenAI/      │ stdio    │ (32      │          │  API │
│            │ ◀──────── │   Anthropic)   │ ◀─────── │  tools)  │ ◀─────── │      │
└────────────┘           └────────────────┘          └──────────┘          └──────┘
```

The Sera MCP is run as a subprocess; the agent SDK auto-discovers all 32 tools. No separate service to host.

## What's next in the bundle

- **x402 endpoint integration** — when a counterparty API responds with HTTP 402, the agent automatically routes the payment through Sera FX. Spec at [`../x402/sera-x402.md`](../x402/sera-x402.md).
- **Hosted UI** — web chat surface (no terminal required).
- **Webhook flows** — agent triggered by external events instead of human chat.
