# Integrations

The Sera MCP works with any agent host that speaks the Model Context Protocol. This folder has copy-pasteable configs and notes for each host we've documented.

| Host | Type | Notes |
|---|---|---|
| [Claude Code](standard-mcp-hosts/README.md#claude-code) | CLI | Native MCP. One-line install. |
| [Claude Desktop](standard-mcp-hosts/README.md#claude-desktop) | Desktop app | Native MCP. JSON config. |
| [ChatGPT](standard-mcp-hosts/README.md#chatgpt) | Hosted | MCP via Settings → Connectors. |
| [OpenAI Agents SDK](standard-mcp-hosts/README.md#openai-agents-sdk) | Library | First-class MCP server consumption. |
| [Cursor](standard-mcp-hosts/README.md#cursor) | IDE | Settings → MCP. |
| [Cline / Continue](standard-mcp-hosts/README.md#cline--continue) | VS Code extensions | Native MCP. |
| [Windsurf · Zed · Goose](standard-mcp-hosts/README.md) | IDE / agent runtime | Native MCP. |
| [**OpenClaw**](openclaw/README.md) | Agent runtime + plugin system | Sera as an OpenClaw plugin. |
| [**Hermes** (Nous Research)](hermes/README.md) | Agent runtime with skills | Sera as a Hermes skill that delegates to the MCP. |
| [**NanoClaw**](nanoclaw/README.md) | Lightweight Docker-isolated agent runtime | Sera via `.mcp.json` config. |

Three of those (OpenClaw, Hermes, NanoClaw) get their own folder because the integration shape is non-standard. Everything else uses the same MCP stdio pattern documented in [`standard-mcp-hosts/`](standard-mcp-hosts/README.md).
