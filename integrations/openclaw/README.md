# Sera ↔ OpenClaw integration

[OpenClaw](https://github.com/openclaw/openclaw) is an open-source agent runtime from the OpenClaw org. The org also publishes [`clawhub`](https://github.com/openclaw/clawhub) — the public skill directory for OpenClaw — and [`docs`](https://github.com/openclaw/docs) for documentation/translations.

There are three ways to add Sera to OpenClaw, in order of effort:

## Path 1 — register Sera as an MCP server (recommended, ~2 minutes)

OpenClaw supports MCP servers via its agent config. Add Sera to your `openclaw.json`:

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

See `openclaw.example.json` in this folder for a copy-pasteable starting point.

Restart your OpenClaw agent. The 32 `sera.*` tools are available to any model that can call MCP tools.

Verify (depending on which agent UI you use):

```
@sera doctor
```

## Path 2 — list Sera in `clawhub` (the public skill directory)

OpenClaw's [`clawhub`](https://github.com/openclaw/clawhub) is the public discovery surface for OpenClaw skills. Submit a Sera skill entry there so OpenClaw users can find Sera without needing to know about the MCP. The skill points to the same MCP underneath.

Status: not yet submitted. Open a PR to clawhub once Sera positioning is stable. The skill manifest would point at `sera-cx/sera-mcp` for installation.

## Path 3 — full plugin: `@openclaw/sera`

For first-class agent UX (slash commands like `/sera-quote`, `/sera-pay-invoice`, agent-aware policy, channel-side surfaces), package Sera as an OpenClaw plugin. The plugin wraps the MCP and exposes higher-level commands per OpenClaw's plugin SDK (`openclaw/plugin-sdk/*`).

Skeleton:

```
@openclaw/sera/
├── openclaw.plugin.json    # plugin manifest (id: sera, channel: sera, capabilities)
├── package.json            # @openclaw/sera, dep: @josh-sera/sera-mcp
├── src/
│   ├── index.ts            # plugin entry — wires MCP + slash commands
│   ├── commands/           # /sera-quote, /sera-pay, etc.
│   └── policy/             # mirrors POLICY_PRESET options
└── README.md
```

`openclaw.plugin.json` shape (matches OpenClaw's invariant naming):

```json
{
  "id": "sera",
  "name": "Sera Multi-Currency Settlement",
  "description": "Quote, swap, treasury, FX analytics across 40+ stablecoins.",
  "version": "0.4.0",
  "channel": { "id": "sera" },
  "install": { "npmSpec": "@openclaw/sera" },
  "capabilities": ["mcp-tool-provider", "policy-aware"],
  "manifest": {
    "mcpServer": {
      "command": "node",
      "args": ["./node_modules/@josh-sera/sera-mcp/dist/index.js"]
    }
  }
}
```

**Status of this plugin**: not yet published to npm. The skeleton above is a spec; build it when there's demand from OpenClaw users. Path 1 works today and covers most use cases.

## OpenClaw-specific tips

- **Tool name conflicts**: OpenClaw scopes MCP tool names by server id. The `sera.` prefix is preserved.
- **Policy presets**: pass `POLICY_PRESET=starter|standard|sg-retail` via the env block to match the agent's risk profile.
- **Subagents**: per `openclaw.json` `subagents` config, Sera tools propagate to children unless you scope them.
- **History persistence**: set `SERA_HISTORY_DB` to a per-workspace path so each agent has its own price-feed log.
- **Cross-host**: the OpenClaw runtime, Hermes, NanoClaw — all three accept the same MCP config shape, so once you've cloned `sera-mcp` once, the same `dist/index.js` works everywhere.
