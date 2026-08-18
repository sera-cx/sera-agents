# Template: chat-cli

Interactive terminal chat agent connected to the Sera MCP.

## Run

```bash
npm install
export OPENAI_API_KEY=sk-...
npm start
```

To use the hosted keyless MCP over Streamable HTTP instead of spawning a local
MCP process:

```bash
export SERA_MCP_URL=https://agents.sera.cx/mcp
npm start
```

For the full account-scoped or execution tool surface, point `SERA_MCP_URL` at
your own authenticated `sera-mcp` deployment and set its Bearer token:

```bash
export SERA_MCP_URL=https://mcp.example.com/mcp
export SERA_MCP_TOKEN=... # keep this secret out of source control
```

`SERA_MCP_TOKEN` requires an `https://` `SERA_MCP_URL`, or an explicit
`localhost` / `127.0.0.1` / `::1` URL for local development — plaintext
`http://` to any other host is rejected at startup so the token can't leak
on the wire.

## Customize

- **What the agent does** — edit `SYSTEM_PROMPT` in `agent.ts`.
- **MCP env** — change `SERA_NETWORK`, `POLICY_PRESET`, etc. in the `MCPServerStdio` env block.
- **MCP transport** — set `SERA_MCP_URL` to use `MCPServerStreamableHttp`; `SERA_MCP_TOKEN` is sent as a Bearer token only for that HTTP connection. The URL takes precedence over the local stdio configuration.
- **Add more MCPs** — pass additional `MCPServerStdio` instances into the agent's `mcpServers` array.
