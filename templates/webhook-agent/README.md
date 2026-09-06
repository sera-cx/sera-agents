# Template: webhook-agent

HTTP endpoint that triggers a Sera-MCP-using agent on each request. Built for event-driven workflows: Stripe webhooks, GitHub events, cron triggers, internal eventing.

## Run

```bash
npm install
export OPENAI_API_KEY=sk-...

# REQUIRED — auth token. The endpoint runs an LLM agent with full Sera tool
# access; without auth anyone hitting the URL can trigger arbitrary swaps.
export WEBHOOK_SECRET=$(openssl rand -hex 32)

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

## Trigger it

```bash
curl -X POST http://localhost:4000/trigger \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"task":"Run sera.find_deals at 25bps and summarize the top 5 results."}'
```

The agent runs the task and returns its summary in the response.

## Rate limiting

The endpoint is protected by two `express-rate-limit` layers, both evaluated
**before** the request body is read or parsed — abusive traffic is rejected
without allocating buffers or spending CPU on JSON parsing / HMAC hashing:

| Tier | Scope | Default | Env var | Description |
| --- | --- | --- | --- | --- |
| 1. Per-client | each client IP across all routes | 60 req/min | `WEBHOOK_RATE_LIMIT_PER_MIN` | Evaluated first across all routes (`/health`, `/trigger`) to ensure a single abusive source cannot drain the global quota and lock out other clients |
| 2. Global burst | entire server, all clients combined | 300 req/min | `WEBHOOK_GLOBAL_RATE_LIMIT` | Server-wide aggregate ceiling protecting the event loop, socket backlog, and LLM spend from distributed floods |

- Every response carries standard `RateLimit-Limit`, `RateLimit-Remaining`,
  and `RateLimit-Reset` headers; rejected requests also include `Retry-After`.
- Client IPs come from the direct socket address. Set `WEBHOOK_TRUST_PROXY=true`
  only when running behind a reverse proxy you control — it then honors
  `X-Forwarded-For` from a single hop. On direct deployments leave it false,
  or clients can spoof their quota identity.
- Limit env vars must be finite positive integers; invalid values abort startup.
- **Counters are in-process.** Behind multiple replicas each instance enforces
  its own budget — attach a shared store such as
  [rate-limit-redis](https://github.com/express-rate-limit/rate-limit-redis)
  when you need exact limits across instances.

## Customize

- **Mapping events to tasks** — edit `TASK_BUILDER` in `server.ts`. Examples included for Stripe `invoice.paid`, GitHub release events, cron ticks.
- **Auth** — `WEBHOOK_SECRET` env enables a bearer-token gate. For production add IP allowlisting or HMAC verification per upstream provider.
- **Long-running tasks** — if your tasks take >30s, return a 202 + run async, then deliver the result via your own callback URL.
- **MCP transport** — `SERA_MCP_URL` selects Streamable HTTP and takes precedence over the local stdio configuration. If set, `SERA_MCP_TOKEN` is sent as its Bearer token.
