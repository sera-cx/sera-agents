# X (Twitter) agents integration

Make Sera's cross-border FX callable **by agents that run on X** — so an X agent
can quote a conversion and hand its user an unsigned settlement intent in-thread.

X agents are typically built one of three ways; Sera plugs into all of them via
the same public, keyless gateway at **`https://agents.sera.cx`**.

| Your X agent is built with… | Use this |
|---|---|
| **GAME Cloud** (Virtuals' hosted X-agent builder) | Register the Sera functions as GAME custom functions → [§1](#1-game-cloud-x-agents) |
| **A GAME SDK bot** posting to X | Import the Sera worker → [`../virtuals/README.md`](../virtuals/README.md) |
| **Your own code / any MCP-aware runtime** | Point it at the remote MCP endpoint → [§2](#2-remote-mcp) or REST → [§3](#3-plain-rest) |

`fx_settle` returns **unsigned** EIP-712 typed data — the user signs in their own
wallet. Your X agent never takes custody or holds keys.

---

## 1. GAME Cloud X agents

GAME Cloud currently powers X/Twitter agents. Add four **custom functions** to
your worker, each an HTTP call to the gateway (name / description / args below —
identical to the GAME SDK plugin in [`../virtuals/game/sera-plugin.ts`](../virtuals/game/sera-plugin.ts)):

| Function | Method + path |
|---|---|
| `sera_get_fx_rates` | `GET https://agents.sera.cx/rates?pairs=USDC/BRLA,XSGD/IDRX` |
| `sera_list_corridors` | `GET https://agents.sera.cx/corridors` |
| `sera_fx_quote` | `POST https://agents.sera.cx/quote` `{from_token,to_token,amount}` |
| `sera_fx_settle` | `POST https://agents.sera.cx/settle` `{quote_id,signer}` |

No API key — the gateway is public. Give the worker a description like *"quote and
prepare cross-border stablecoin FX; never claim to have moved funds — you only
prepare intents the user signs."*

---

## 2. Remote MCP

The gateway speaks the **MCP Streamable HTTP transport**, so any MCP-aware X
tooling can consume it directly — no install, no stdio bridge:

```
https://agents.sera.cx/mcp
```

Tools exposed: `fx_quote`, `fx_settle`, `corridors`, `rates`. For a client that
reads a project `.mcp.json`:

```json
{
  "mcpServers": {
    "sera": { "type": "http", "url": "https://agents.sera.cx/mcp" }
  }
}
```

(This is the reverse direction from the X **API** MCP wired in the repo-root
`.mcp.json` / [`../../docs/x-mcp.md`](../../docs/x-mcp.md): that one lets *Sera
agents call X*; this one lets *X agents call Sera*.)

---

## 3. Plain REST

For a webhook bot or any HTTP client (see [`templates/webhook-agent`](../../templates/webhook-agent)):

```bash
curl -s 'https://agents.sera.cx/rates?pairs=XSGD/IDRX'
curl -sX POST https://agents.sera.cx/quote \
  -H 'content-type: application/json' \
  -d '{"from_token":"XSGD","to_token":"IDRX","amount":"100"}'
```

Full schema at `https://agents.sera.cx/openapi.json`.

---

## Notes

- **Keyless + non-custodial.** Read-/prepare-only; settlement is unsigned typed
  data signed downstream by the user.
- **Backoff.** On upstream throttles the gateway returns `429` + `Retry-After`
  (REST) or an `isError` result tagged `429: … (retry after Ns)` (MCP) — honor it.
- **Posting keys to X** (OAuth for the agent's own account) are your X app's
  concern and unrelated to Sera; keep them in your agent runtime, never in Sera.
