# Template: chat-cli

Interactive terminal chat agent connected to the Sera MCP.

## Run

```bash
npm install
export OPENAI_API_KEY=sk-...
npm start
```

## Customize

- **What the agent does** — edit `SYSTEM_PROMPT` in `agent.ts`.
- **MCP env** — change `SERA_NETWORK`, `POLICY_PRESET`, etc. in the `MCPServerStdio` env block.
- **Add more MCPs** — pass additional `MCPServerStdio` instances into the agent's `mcpServers` array.
