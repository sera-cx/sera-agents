# Template: web-chat

Express server + a single-page chat UI in the browser. Backend uses the OpenAI Agents SDK against the Sera MCP. Per-session in-memory history (LRU-capped, server-derived session IDs).

## Run

```bash
npm install
export OPENAI_API_KEY=sk-...

# REQUIRED for any non-loopback deployment — auth token
export WEB_CHAT_AUTH_TOKEN=$(openssl rand -hex 32)

npm start
# server listens on 127.0.0.1:3000 by default
# open http://localhost:3000 — UI will prompt once for the token, caches in localStorage
```

To connect to a Streamable HTTP MCP instead of spawning a local process, set:

```bash
export SERA_MCP_URL=https://agents.sera.cx/mcp
```

The hosted endpoint is keyless and exposes the public gateway tool set. For an
authenticated self-hosted `sera-mcp` endpoint, configure its Bearer token on
the server (never in browser code):

```bash
export SERA_MCP_URL=https://mcp.example.com/mcp
export SERA_MCP_TOKEN=... # keep this secret out of source control
```

`SERA_MCP_TOKEN` requires an `https://` `SERA_MCP_URL`, or an explicit
`localhost` / `127.0.0.1` / `::1` URL for local development — plaintext
`http://` to any other host is rejected at startup so the token can't leak
on the wire.

For pure local development with no auth (loopback only):

```bash
export HOST=127.0.0.1
export WEB_CHAT_ALLOW_NO_AUTH=true
```

For public deploy behind a proxy:

```bash
export HOST=0.0.0.0
export WEB_CHAT_AUTH_TOKEN=...    # required
```

The server refuses to start in unsafe configurations (no token + non-loopback) with a clear error.

## Built-in safety

- **Auth required by default** on any non-loopback bind
- **Body size capped** at 32kb per request
- **Rate limit** 30 requests/minute per IP (override via `WEB_CHAT_RATE_LIMIT_PER_MIN`)
- **Sessions LRU-capped** at 1,000 (override via `WEB_CHAT_SESSIONS_MAX`)
- **Session IDs HMAC-derived** server-side so clients can't impersonate each other by guessing IDs
- **Constant-time** bearer comparison

## What's in the box

- `server.ts` — Express app with `/api/chat` (POST) and `/api/health`.
- `public/index.html` — chat UI (vanilla JS, no framework).

## Customize

- **Agent persona** — `SYSTEM_PROMPT` in `server.ts`.
- **Auth** — wrap `/api/chat` in your own session middleware before going public.
- **Persistence** — sessions are in-memory; swap for a real store before scaling.
- **UI** — `public/index.html` is intentionally one file. Replace with your framework of choice.
- **MCP transport** — `SERA_MCP_URL` selects Streamable HTTP and takes precedence over the local stdio configuration. If set, `SERA_MCP_TOKEN` is sent as its Bearer token.
