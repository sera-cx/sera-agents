# Template: webhook-agent

HTTP endpoint that triggers a Sera-MCP-using agent on each request. Built for event-driven workflows: Stripe webhooks, GitHub events, cron triggers, internal eventing.

## Run

```bash
npm install
export OPENAI_API_KEY=sk-...

# REQUIRED — auth token. The endpoint runs an LLM agent with Sera tool
# access; without auth anyone hitting the URL can trigger tasks.
export WEBHOOK_SECRET=$(openssl rand -hex 32)

# Optional: Tool security profile (defaults to READ_ONLY for defense-in-depth)
# export TOOL_PROFILE=READ_ONLY

npm start
# server listens on 127.0.0.1:4000 by default
```

To connect to a Streamable HTTP MCP instead of spawning a local process, set:

```bash
export SERA_MCP_URL=https://agents.sera.cx/mcp
```

The hosted endpoint is keyless and exposes the public gateway tool set. For an
authenticated self-hosted `sera-mcp` endpoint, configure its Bearer token on
the server:

```bash
export SERA_MCP_URL=https://mcp.example.com/mcp
export SERA_MCP_TOKEN=... # keep this secret out of source control
```

`SERA_MCP_TOKEN` requires an `https://` `SERA_MCP_URL`, or an explicit
`localhost` / `127.0.0.1` / `::1` URL for local development — plaintext
`http://` to any other host is rejected at startup so the token can't leak
on the wire.

For exposing publicly behind a proxy (Cloudflare Tunnel, Fly, etc.):

```bash
export HOST=0.0.0.0           # bind to all interfaces (proxy-fronted)
export WEBHOOK_SECRET=...     # required for non-loopback
```

For pure local development with no auth (loopback only, single-user machine):

```bash
export HOST=127.0.0.1
export WEBHOOK_ALLOW_NO_AUTH=true
```

The server will refuse to start in unsafe configurations (no secret + non-loopback) with a clear error.

## Tool Security Profiles

To protect against prompt-injection attacks and inadvertent state changes, `webhook-agent` gates tool execution using strict profiles:

| Profile | Allowed Tools | Destructive Tools | Use Case |
|---|---|---|---|
| **`READ_ONLY`** *(default)* | 39 read-only discovery, pricing, order query, and treasury tools | ❌ Blocked | Public webhooks, customer inquiry bots |
| **`PLANNER`** | 45 tools (39 read-only + 6 unsigned builder tools) | ❌ Blocked | Route planning, quote generation, unsigned intent preparation |
| **`FULL_EXECUTION`** | All 55 tools | ✅ Allowed | Staging tests or operator-controlled automations |

### Destructive Tools (10)
Under `READ_ONLY` and `PLANNER`, the following 10 destructive tools are completely hidden from discovery and strictly rejected at runtime if invoked:
- `sera.execute_swap`
- `sera.convert_and_send`
- `sera.place_order`
- `sera.cancel_order`
- `sera.cancel_all_orders`
- `sera.place_vl_batch`
- `sera.cancel_vl_batch`
- `sera.send_tx`
- `sera.send_transfer`
- `sera.withdraw_send`

## Trigger it

```bash
curl -X POST http://localhost:4000/trigger \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"task":"Run sera.find_deals at 25bps and summarize the top 5 results."}'
```

The agent runs the task and returns its summary in the response.

## Customize

- **Mapping events to tasks** — edit `TASK_BUILDER` in `server.ts`. Examples included for Stripe `invoice.paid`, GitHub release events, cron ticks.
- **Auth** — `WEBHOOK_SECRET` env enables a bearer-token gate. For production add IP allowlisting or HMAC verification per upstream provider.
- **Long-running tasks** — if your tasks take >30s, return a 202 + run async, then deliver the result via your own callback URL.
- **MCP transport** — `SERA_MCP_URL` selects Streamable HTTP and takes precedence over the local stdio configuration. If set, `SERA_MCP_TOKEN` is sent as its Bearer token.
- **Tool Profile** — configure `TOOL_PROFILE=READ_ONLY`, `PLANNER`, or `FULL_EXECUTION` in your environment.
