# Standard MCP host integrations

Every host below speaks MCP natively. The Sera MCP install pattern is the same: register a stdio server pointing at the built `dist/index.js`. Only the config file shape differs.

## Prerequisites (once per machine)

```bash
git clone https://github.com/sera-cx/sera-mcp
cd sera-mcp
npm install && npm run build
```

Note the absolute path to `dist/index.js` — you'll need it below.

## Common env (recommended for all hosts)

```
SERA_NETWORK=mainnet
POLICY_PRESET=standard
```

Optional:

```
SERA_API_KEY=...        # only required for treasury_value, balances, settlement_status
SERA_API_SECRET=...
SERA_HISTORY_DB=/path/to/sera-history.db   # enables fx_history, fx_volatility, corridor_pnl
LOG_LEVEL=info
```

---

## Claude Code

```bash
claude mcp add sera --scope user \
  --env SERA_NETWORK=mainnet \
  --env POLICY_PRESET=standard \
  -- node /absolute/path/to/sera-mcp/dist/index.js
```

Verify in any session: `Call sera.doctor`.

---

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sera": {
      "command": "node",
      "args": ["/absolute/path/to/sera-mcp/dist/index.js"],
      "env": {
        "SERA_NETWORK": "mainnet",
        "POLICY_PRESET": "standard"
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop. The hammer icon should show `sera` with 32 tools.

---

## ChatGPT

Settings → Connectors → Add Custom Connector. ChatGPT supports remote MCP servers (HTTP/SSE), not stdio. The Sera MCP is currently stdio only — a hosted SSE endpoint at `mcp.sera.cx` is on the roadmap. Until then, run the MCP through a local SSE bridge (e.g. [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)) and point ChatGPT at the bridge URL.

---

## OpenAI Agents SDK

```ts
import { Agent, run, MCPServerStdio } from "@openai/agents";

const sera = new MCPServerStdio({
  command: "node",
  args: ["/absolute/path/to/sera-mcp/dist/index.js"],
  env: {
    SERA_NETWORK: "mainnet",
    POLICY_PRESET: "standard",
  },
  name: "sera",
});
await sera.connect();

const agent = new Agent({
  name: "My Agent",
  instructions: "...",
  mcpServers: [sera],
});
```

See `examples/invoice-payer/agent.ts` and `templates/web-chat/server.ts` in the `sera-agents` repo for full examples.

---

## Cursor

Settings (Cmd+,) → MCP → Add Server. Use the JSON form:

```json
{
  "sera": {
    "command": "node",
    "args": ["/absolute/path/to/sera-mcp/dist/index.js"],
    "env": {
      "SERA_NETWORK": "mainnet",
      "POLICY_PRESET": "standard"
    }
  }
}
```

Restart Cursor. Tools appear under the MCP indicator.

---

## Cline / Continue

Cline (VS Code extension): edit `cline_mcp_settings.json` with the same JSON shape as Claude Desktop above.

Continue: edit `~/.continue/config.json`, add an `mcpServers` block in the same JSON shape.

---

## Windsurf · Zed · Goose

All three accept the standard MCP stdio config. Per-host config locations:

- **Windsurf**: Settings → Cascade → MCP Servers
- **Zed**: `~/.config/zed/settings.json` → `context_servers` block
- **Goose**: `~/.config/goose/config.yaml` → `extensions` section

Same `command + args + env` shape as everywhere else. Sera surfaces 32 tools regardless of host.

---

## Verify (any host)

```
Call sera.doctor
```

Returns `{overall_ok: true, checks: [...]}` if wired correctly.
