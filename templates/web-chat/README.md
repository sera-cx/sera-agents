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
