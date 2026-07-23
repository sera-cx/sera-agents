# Sera ↔ Hermes integration

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is the open-source CLI agent from Nous Research. As of v0.13.0 (May 2026), Hermes supports MCP directly — full docs at [hermes-agent.nousresearch.com/docs/user-guide/features/mcp](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp). For Sera you have two integration paths.

## Recommended — register Sera as an MCP server (native)

1. **Install Hermes** (one-time):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
   source ~/.bashrc
   ```

2. **Build the Sera MCP** (one-time):

   ```bash
   git clone https://github.com/sera-cx/sera-mcp
   cd sera-mcp && npm install && npm run build
   ```

3. **Register Sera in Hermes**. Hermes accepts the same MCP server config shape as Claude Desktop. Add to your Hermes MCP config:

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

4. **Restart `hermes`**. The 32 `sera.*` tools are now callable from any agent session. Verify:

   ```
   call sera.doctor
   ```

## Alternative — package Sera as a Hermes skill (for skill-first workflows)

If you prefer Hermes's skill model (skills live in `~/.hermes/skills/`), copy the `sera/` folder from this directory:

```bash
mkdir -p ~/.hermes/skills/sera
cp -r ./sera/* ~/.hermes/skills/sera/
```

The skill wraps the MCP and exposes `sera-quote`, `sera-pay`, `sera-treasury`, `sera-deals`, `sera-doctor` as agent-callable subroutines. Useful when you want one-line invocation without the agent having to discover MCP tool names.

You can use **both paths simultaneously** — the skill will delegate to the same MCP your `mcpServers` config registers.

## Hermes-specific notes

- **Co-author trailer**: Hermes commits use `Hermes Agent <agent@nousresearch.com>`. If your Sera workflows generate commits (e.g. via `webhook-agent`), this trailer will appear automatically.
- **OpenClaw skill imports**: Hermes can import OpenClaw skills from `~/.hermes/skills/openclaw-imports/`. If you've installed Sera as an OpenClaw plugin, it'll show up there too.
- **Messaging gateways**: Hermes supports Telegram, Discord, Slack, WhatsApp, Signal, Email. A Sera-aware Hermes agent reachable via Telegram is a one-config-line addition.
- **Tool name aliases**: Hermes uses `terminal`, `patch`, `read_file`, `delegate_task` (instead of Bash/Write/Read/Agent). MCP tool names are unaffected — `sera.*` works as-is.

## Status

The native MCP path is the canonical Hermes integration as of v0.13.0. The skill wrapper is provided for legacy workflows.
