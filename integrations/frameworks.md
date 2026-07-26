# Sera in agent frameworks

Every modern agent framework speaks MCP, so "using Sera" is just pointing the
framework at Sera's MCP endpoint — no SDK, no submission, no account.

Two endpoints to choose from:

| Endpoint | Transport | Tools | Key |
|---|---|---|---|
| `https://agents.sera.cx/mcp` | Streamable HTTP (remote, hosted) | 17 keyless — quote/settle-intent, rates, corridors, deal-scanning + analytics | none |
| `npx -y sera-mcp` | stdio (local) | full ~55-tool server incl. treasury, orders, execution | your own signer/key |

The remote endpoint is the fastest start and needs no install. Use the local
stdio server when you need the account-scoped or execution tools.

## Remote (Streamable HTTP) — copy/paste per framework

```python
# OpenAI Agents SDK
from agents.mcp import MCPServerStreamableHttp
sera = MCPServerStreamableHttp(params={"url": "https://agents.sera.cx/mcp"})
```

```python
# LangChain / LangGraph (langchain-mcp-adapters)
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({
    "sera": {"transport": "streamable_http", "url": "https://agents.sera.cx/mcp"}
})
tools = await client.get_tools()
```

```python
# LlamaIndex
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec
sera = McpToolSpec(client=BasicMCPClient("https://agents.sera.cx/mcp"))
```

```python
# Google ADK
from google.adk.tools.mcp_tool import MCPToolset, StreamableHTTPConnectionParams
sera = MCPToolset(connection_params=StreamableHTTPConnectionParams(
    url="https://agents.sera.cx/mcp"))
```

```python
# CrewAI (crewai-tools)
from crewai_tools import MCPServerAdapter
with MCPServerAdapter({"url": "https://agents.sera.cx/mcp",
                       "transport": "streamable-http"}) as sera_tools:
    ...
```

```typescript
// Vercel AI SDK
import { experimental_createMCPClient as createMCPClient } from 'ai';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const sera = await createMCPClient({
  transport: new StreamableHTTPClientTransport(new URL('https://agents.sera.cx/mcp')),
});
const tools = await sera.tools();
```

## Local stdio (full server)

Swap the transport for a stdio launch of the npm package, e.g. OpenAI Agents SDK:

```python
from agents.mcp import MCPServerStdio
sera = MCPServerStdio(params={"command": "npx", "args": ["-y", "sera-mcp"]})
```

The account-scoped tools (balances, orders, treasury, execution) read
`SERA_API_KEY` / `SERA_API_SECRET` and a signer from the environment — see the
[sera-mcp README](https://github.com/sera-cx/sera-mcp).
