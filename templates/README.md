# Templates — build your own Sera agent

Starters for common shapes. Copy whichever matches what you're building, change the prompt + plumbing, ship.

**Conversational / event-driven** (LLM-in-the-loop, built on the OpenAI Agents SDK):

| Template | Shape | Use when |
|---|---|---|
| [`chat-cli/`](chat-cli) | Interactive terminal chat | You want a CLI assistant for your team's treasury / FX work. |
| [`web-chat/`](web-chat) | Browser chat (Express + HTML, SSE streaming) | You want non-engineers to use a Sera agent through a web page. |
| [`webhook-agent/`](webhook-agent) | HTTP webhook responder | You want an agent that runs in response to external events (Stripe, cron, GitHub, etc.). |

**Trading / settlement** (deterministic loops, no LLM in the hot path):

| Template | Shape | Use when |
|---|---|---|
| [`market-maker/`](market-maker) | **Deploy liquidity** — post two-sided quotes | You want to *provide* liquidity on a Sera pair and earn the spread. |
| [`taker/`](taker) | **Take liquidity** — cross the spread on edge | You want to *consume* liquidity / convert the moment the rate beats mid. |
| [`withdraw-cli/`](withdraw-cli) | Dual-sig instant-withdrawal walkthrough | You want to see Sera's 4-step withdrawal flow end to end. |

### Maker vs taker

`market-maker` and `taker` are a matched pair — the two sides of the same market. Both are deterministic loops, both default to a safe **dry-run** (they log the orders/takes they *would* make and change nothing), and both enforce `sera-mcp` policy caps (`POLICY_MAX_NOTIONAL_USD`, `POLICY_DAILY_VOLUME_CAP_USD`). Run both against the same wallet to make on one pair and take on another. Each has a **Production checklist** in its README — they're starters, not turnkey bots.

## Common scaffolding

Every template is:
- **TypeScript** + ES modules.
- Uses **`@openai/agents`** (the OpenAI Agents SDK) — speaks MCP natively. Swap to `@anthropic-ai/sdk` if you prefer Claude; the MCP tool surface is identical.
- Spawns the **Sera MCP** as a subprocess. No service to host.
- Reads `OPENAI_API_KEY` from env.

## How to use

```bash
# Pick a template, copy it
cp -r templates/web-chat ~/my-sera-agent
cd ~/my-sera-agent
npm install

# Set your env
export OPENAI_API_KEY=sk-...
# Optional: SERA_API_KEY + SERA_API_SECRET to unlock balances + treasury tools

# Run
npm start
```

Then customize:
- **System prompt** in `agent.ts` — change what the agent does.
- **Triggers** — add HTTP endpoints, cron jobs, webhook routes as needed.
- **Tools** — add your own non-Sera MCP servers alongside `sera`. Each template wires Sera by default but accepts an array.

## Why no `npx create-sera-agent` yet

Plain `cp -r` works today and avoids one more thing to maintain. We'll add an actual scaffolder once people ask for it.
