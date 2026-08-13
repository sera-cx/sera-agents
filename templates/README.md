# Templates — build your own Sera agent

Six starters for common shapes. Copy whichever matches what you're building, change the prompt + plumbing, ship.

| Template | Shape | Use when |
|---|---|---|
| [`chat-cli/`](chat-cli) | Interactive terminal chat | You want a CLI assistant for your team's treasury / FX work. |
| [`web-chat/`](web-chat) | Browser chat (Express + HTML, SSE streaming) | You want non-engineers to use a Sera agent through a web page. |
| [`webhook-agent/`](webhook-agent) | HTTP webhook responder | You want an agent that runs in response to external events (Stripe, cron, GitHub, etc.). |
| [`slack-agent/`](slack-agent) | Slack bot worker (Bolt SDK, Socket Mode/HTTP) | You want a conversational Slack assistant that handles multi-currency actions inside channels or DMs. |
| [`market-maker/`](market-maker) | Deterministic two-sided spread bot | You want a Sepolia-safe cancel-before-place maker loop (no LLM in the inner loop). |
| [`withdraw-cli/`](withdraw-cli) | Dual-sig withdraw walkthrough | You want to exercise `withdraw_request` → `withdraw_build` → `withdraw_send` interactively. |

## Common scaffolding

Every template is:
- **TypeScript** + ES modules.
- Spawns the **Sera MCP** as a subprocess via `SERA_MCP_DIST` (required — no hardcoded Desktop path).
- Chat / webhook templates use **`@openai/agents`** (the OpenAI Agents SDK) — speaks MCP natively. Swap to `@anthropic-ai/sdk` if you prefer Claude; the MCP tool surface is identical.
- `market-maker` is rule-based (ethers + a thin MCP JSON-RPC client); no Agents SDK in the inner loop.
- Reads `OPENAI_API_KEY` from env where an LLM is used.

## How to use

```bash
# Pick a template, copy it
cp -r templates/web-chat ~/my-sera-agent
cd ~/my-sera-agent
npm install

# Set your env
export OPENAI_API_KEY=sk-...
export SERA_MCP_DIST=/path/to/sera-mcp/dist/index.js
# Optional: SERA_API_KEY + SERA_API_SECRET to unlock balances + treasury tools

# Run
npm start
```

Then customize:
- **System prompt** in `agent.ts` — change what the agent does (LLM templates).
- **Triggers** — add HTTP endpoints, cron jobs, webhook routes as needed.
- **Tools** — add your own non-Sera MCP servers alongside `sera`. Each template wires Sera by default but accepts an array.

## Why no `npx create-sera-agent` yet

Plain `cp -r` works today and avoids one more thing to maintain. We'll add an actual scaffolder once people ask for it.
