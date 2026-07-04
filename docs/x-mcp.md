# X (Twitter) MCP servers

Project-scoped config for X's official MCP servers lives in the repo-root
[`.mcp.json`](../.mcp.json). Any MCP-aware client that reads project config
(Claude Code, Cursor, …) will pick it up when opened at the repo root and
prompt you to approve the servers.

X shipped its official MCP servers on 2026-06-30. There are two, and they have
very different setup requirements:

| Server (`.mcp.json` key) | URL | Auth | Purpose |
|---|---|---|---|
| `x-docs` | `https://docs.x.com/mcp` | **OAuth (one-time authorization in your client)** | Search and read the X API documentation |
| `x-api` | `http://127.0.0.1:8000/mcp` | **your X developer OAuth** | 200+ X API operations as tools (post, search, users, …) |

## `x-docs` — one-time authorization

This is a read-only documentation server (no data written to your X account),
but it still requires a **one-time OAuth authorization** the first time your
client connects — approve it interactively via `/mcp` (Claude Code) or your
client's connector settings, then you can search/read the X API docs. It can't
be authorized from a non-interactive/headless session.

> This was originally documented as no-auth (X's `docs.x.com/tools/mcp` page is
> bot-blocked, so that came from secondhand sources). When the config was loaded
> into a live client, `x-docs` prompted for authorization — so it needs the
> one-time consent above.

## `x-api` — needs your credentials (templated)

This one talks to the live X API on your behalf, so it requires a X developer
app and an OAuth consent. **No tokens are committed to this repo** — the
`.mcp.json` entry is a placeholder pointing at a local server you run yourself.

### Recommended: self-host X's official server

Per X's official repo, [`xdevplatform/xmcp`](https://github.com/xdevplatform/xmcp),
the API MCP server runs locally and handles the OAuth1 browser-consent flow at
startup, then serves `http://127.0.0.1:8000/mcp` — which is exactly what the
`x-api` entry in `.mcp.json` points at:

```bash
git clone https://github.com/xdevplatform/xmcp.git
cd xmcp
# follow the repo README to install deps and set your X developer app keys,
# then start it — it opens a browser for OAuth consent and binds 127.0.0.1:8000
```

Once it's running, approve `x-api` in your client. If it isn't running, that
server will simply show as unavailable — harmless; `x-docs` is unaffected.

### Alternative: X's hosted endpoint

X also documents a hosted API MCP endpoint (`https://api.x.com/mcp`) at
<https://docs.x.com/tools/mcp>. Because X's OAuth doesn't support dynamic client
registration, the hosted path is routed through the open-source `xurl` bridge,
which handles OAuth and injects a fresh bearer token per call. If you'd rather
use the hosted endpoint, swap the `x-api` `url` and follow the bridge setup on
that docs page.

> Note: `docs.x.com/tools/mcp` blocks automated fetches, so the hosted-endpoint
> details above are drawn from X's announcement and the `xdevplatform/xmcp`
> repo rather than the page itself. Confirm the exact URL and auth steps there
> before relying on the hosted variant.

## Security

- Never commit X API keys, OAuth tokens, or `.env` files. Keep them in the local
  `xmcp` process (self-host) or in `xurl`'s local config (hosted bridge).
- `x-docs` is read-only docs — it needs a one-time OAuth authorization but
  writes nothing to your account and stores no secrets in the repo.
