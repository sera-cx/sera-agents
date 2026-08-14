# Templates — build your own Sera agent

Three starters for common shapes. Copy whichever matches what you're building, change the prompt + plumbing, ship.

| Template | Shape | Use when |
|---|---|---|
| [`chat-cli/`](chat-cli) | Interactive terminal chat | You want a CLI assistant for your team's treasury / FX work. |
| [`web-chat/`](web-chat) | Browser chat (Express + HTML, SSE streaming) | You want non-engineers to use a Sera agent through a web page. |
| [`webhook-agent/`](webhook-agent) | HTTP webhook responder | You want an agent that runs in response to external events (Stripe, cron, GitHub, etc.). |
| [`slack-agent/`](slack-agent) | Slack bot worker (Bolt SDK, Socket Mode/HTTP) | You want a conversational Slack assistant that handles multi-currency actions inside channels or DMs. |

## Common scaffolding

Every template is:
- **TypeScript** + ES modules.
- Uses **`@openai/agents`** (the OpenAI Agents SDK) — speaks MCP natively. Swap to `@anthropic-ai/sdk` if you prefer Claude; the MCP tool surface is identical.
- Defaults to a local **Sera MCP** subprocess, or connects to a Streamable HTTP MCP endpoint when `SERA_MCP_URL` is set.
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

# Optional: use the hosted keyless MCP instead of a local subprocess.
# It exposes the public gateway tool set.
export SERA_MCP_URL=https://agents.sera.cx/mcp

# For account-scoped or execution tools, self-host sera-mcp and configure its
# Bearer token. Keep the token in your deployment's secret store.
export SERA_MCP_URL=https://mcp.example.com/mcp
export SERA_MCP_TOKEN=...

# Run
npm start
```

Then customize:
- **System prompt** in `agent.ts` — change what the agent does.
- **Triggers** — add HTTP endpoints, cron jobs, webhook routes as needed.
- **Tools** — add your own non-Sera MCP servers alongside `sera`. Each template wires Sera by default but accepts an array.

## MCP transport

The starters use stdio by default, spawning a local full `sera-mcp` process. Set
`SERA_MCP_URL` to select Streamable HTTP instead. The hosted
`https://agents.sera.cx/mcp` gateway is keyless and exposes its public tool set;
for the full account-scoped or execution surface, self-host `sera-mcp` over
Streamable HTTP and set `SERA_MCP_TOKEN`; the templates send it as an
`Authorization: Bearer …` header only to that MCP connection. Keep it in a
server-side secret store. SSE is intentionally not used.

## Why no `npx create-sera-agent` yet

Plain `cp -r` works today and avoids one more thing to maintain. We'll add an actual scaffolder once people ask for it.
