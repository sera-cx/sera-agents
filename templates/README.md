# Templates — build your own Sera agent

Three starters for common shapes. Copy whichever matches what you're building, change the prompt + plumbing, ship.

| Template | Shape | Use when |
|---|---|---|
| [`chat-cli/`](chat-cli) | Interactive terminal chat | You want a CLI assistant for your team's treasury / FX work. |
| [`web-chat/`](web-chat) | Browser chat (Express + HTML, SSE streaming) | You want non-engineers to use a Sera agent through a web page. |
| [`webhook-agent/`](webhook-agent) | HTTP webhook responder | You want an agent that runs in response to external events (Stripe, cron, GitHub, etc.). |

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
