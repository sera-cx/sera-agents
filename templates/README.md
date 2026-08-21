# Templates — build your own Sera agent

Seven starters for common shapes. Copy whichever matches what you're building, change the prompt + plumbing, ship.

| Template | Shape | Use when |
|---|---|---|
| [`chat-cli/`](chat-cli) | Interactive terminal chat | You want a CLI assistant for your team's treasury / FX work. |
| [`web-chat/`](web-chat) | Browser chat (Express + HTML, SSE streaming) | You want non-engineers to use a Sera agent through a web page. |
| [`webhook-agent/`](webhook-agent) | HTTP webhook responder | You want an agent that runs in response to external events (Stripe, cron, GitHub, etc.). |
| [`discord-agent/`](discord-agent) | Conversational Discord bot | You want a collaborative team assistant on Discord to handle FX settlement and balances. |
| [`slack-agent/`](slack-agent) | Slack bot worker (Bolt SDK, Socket Mode/HTTP) | You want a conversational Slack assistant that handles multi-currency actions inside channels or DMs. |
| [`market-maker/`](market-maker) | Deterministic two-sided spread bot | You want a Sepolia-safe cancel-before-place maker loop (no LLM in the inner loop). |
| [`withdraw-cli/`](withdraw-cli) | Dual-sig withdraw walkthrough | You want to exercise `withdraw_request` → `withdraw_build` → `withdraw_send` interactively. |

## Common scaffolding

Every template is:
- **TypeScript** + ES modules.
- Spawns the **Sera MCP** as a subprocess via `SERA_MCP_DIST` by default.
  `chat-cli`, `web-chat`, and `webhook-agent` additionally accept `SERA_MCP_URL`
  to skip `SERA_MCP_DIST` entirely and connect over Streamable HTTP instead —
  see "MCP transport" below. `slack-agent`, `market-maker`, and `withdraw-cli`
  are stdio-only for now: `SERA_MCP_DIST` is required and `SERA_MCP_URL` is
  not read. (`slack-agent` also falls back to a Desktop-relative default path
  when `SERA_MCP_DIST` is unset — override it explicitly rather than relying
  on that default.)
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

# Optional (chat-cli, web-chat, webhook-agent only): use the hosted keyless
# MCP instead of a local subprocess. It exposes the public gateway tool set.
export SERA_MCP_URL=https://agents.sera.cx/mcp

# For account-scoped or execution tools, self-host sera-mcp and configure its
# Bearer token. Keep the token in your deployment's secret store.
export SERA_MCP_URL=https://mcp.example.com/mcp
export SERA_MCP_TOKEN=...

# Run
npm start
```

`slack-agent`, `market-maker`, and `withdraw-cli` don't read `SERA_MCP_URL` /
`SERA_MCP_TOKEN` yet — only `SERA_MCP_DIST` applies to those three.

Then customize:
- **System prompt** in `agent.ts` — change what the agent does (LLM templates).
- **Triggers** — add HTTP endpoints, cron jobs, webhook routes as needed.
- **Tools** — add your own non-Sera MCP servers alongside `sera`. Each template wires Sera by default but accepts an array.

## MCP transport

All starters use stdio by default, spawning a local full `sera-mcp` process.
`chat-cli`, `web-chat`, and `webhook-agent` additionally support Streamable
HTTP: set `SERA_MCP_URL` to select it instead. The hosted
`https://agents.sera.cx/mcp` gateway is keyless and exposes its public tool set;
for the full account-scoped or execution surface, self-host `sera-mcp` over
Streamable HTTP and set `SERA_MCP_TOKEN`; those three templates send it as an
`Authorization: Bearer …` header only to that MCP connection, and refuse to
send it over plaintext `http://` to a non-loopback host. Keep it in a
server-side secret store. SSE is intentionally not used.

`slack-agent`, `market-maker`, and `withdraw-cli` have not been ported to this
transport-selection logic yet — they always spawn a local subprocess via
`SERA_MCP_DIST`.

## Why no `npx create-sera-agent` yet

Plain `cp -r` works today and avoids one more thing to maintain. We'll add an actual scaffolder once people ask for it.
