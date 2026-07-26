# Sera for Agents — distribution & discoverability

How Sera's MCP server + x402 endpoint get discovered and used across every AI-agent
channel, platform, open-source venue, and agentic-connectivity standard.

Two surfaces are being distributed:
- **`sera-cx/sera-mcp`** — the npm-installable MCP server (~55 tools, stdio + Streamable HTTP).
- **agents.sera.cx** — the hosted gateway: a keyless Streamable HTTP MCP at `/mcp` (17 tools) + an x402 HTTP service.

Legend: **[repo]** = a file/PR we land ourselves (no external account). **[account]** = needs one of our platform accounts / a manual portal submission. **[auto]** = ingested automatically once prerequisites exist.

---

## Rollout order (reach ÷ effort)

### Tier 0 — the roots everything else crawls (do first, mostly [repo])
Most directories ingest from the **official MCP Registry** and/or GitHub, so landing these cascades into many downstream listings.

| Item | Type | Asset / action |
|---|---|---|
| Official **MCP Registry** entry | [repo]+[account] | `server.json` in `sera-mcp` root → `mcp-publisher publish` |
| npm keywords + `mcpName` on `sera-mcp` | [repo] | `package.json` (see assets) |
| GitHub topics on both repos | [repo] | `gh repo edit … --add-topic` (see assets) |
| README one-click install buttons | [repo] | Cursor + VS Code deeplinks (see assets) |
| `.well-known/mcp.json` + `agent-card.json` | [repo] | shipped in this repo |

### Tier 1 — high-reach directories
| Venue | Type | Notes |
|---|---|---|
| **Smithery** | [repo]+[account] | `smithery.yaml` (`runtime: remote` → our hosted URL); then claim/verify in dashboard |
| **Awesome-MCP-Servers** (punkpeye) | [repo] | PR under Finance/Payments; put `🤖🤖🤖` in the PR **title** for the automated-agent fast-track |
| **Docker MCP Registry** | [repo]+[account] | PR to `docker/mcp-registry` (its own `server.yaml`; builds from our `Dockerfile`) |
| **PulseMCP / Glama / mcp.so** | [auto] | Auto-ingested once in the official registry + GitHub topics/npm keywords — just verify the listing |

### Tier 2 — host-app connectors
Most hosts "just work" via MCP once documented ([repo] docs). Two need real portals:

| Venue | Type | Notes |
|---|---|---|
| Claude Code/Desktop, Cursor, VS Code, Windsurf, Cline/Continue, Goose, Zed | [repo] | native MCP — ship config snippets + deeplinks |
| **ChatGPT** (Developer Mode → custom connector) | [repo] doc | users self-add our HTTPS `/mcp` URL; remote-only, no portal |
| **Anthropic Connectors Directory** | [account] | gatekept. **Hard reqs: public privacy-policy URL (missing = auto-reject), read-only/destructive annotations on all tools, a reviewer demo account, Team/Enterprise org + Owner role.** Plan deliberately. |

### Tier 3 — agent frameworks (pure [repo] docs — "it already works")
OpenAI Agents SDK, LangChain/LangGraph, LlamaIndex, Vercel AI SDK, Google ADK, CrewAI, AutoGen. "Available" = the remote URL / stdio package works out of the box. Config snippets live in [`integrations/frameworks.md`](integrations/frameworks.md).

### Tier 4 — agent-to-agent / payments connectivity
| Venue | Type | Notes |
|---|---|---|
| **A2A agent card** | [repo] | shipped at `/.well-known/agent-card.json` (v1.0 path) + legacy `/.well-known/agent.json`. Discovery card only — Sera isn't a full A2A JSON-RPC task agent. |
| **x402 Bazaar** (Coinbase CDP) | [account]/config | auto-indexes **only** if the x402 service settles through the **CDP facilitator** with the bazaar extension, and only after a real `settle`. Non-CDP facilitator → won't appear. Decision needed. |
| **awesome-x402** (`xpaysh/awesome-x402`) | [repo] | curated list PR — free referral |
| **AP2** (Agent Payments Protocol) | watch | emerging; no self-serve registry yet. Monitor. |

**Sequencing:** land all Tier 0 [repo] files → they cascade into Tier 1 auto-listings → then do the [account] submissions (Smithery claim, Docker PR, Anthropic Directory, x402/CDP facilitator decision).

---

## Ready-to-submit assets

### `sera-cx/sera-mcp` repo root — `server.json` (official MCP Registry)
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.sera-cx/sera-mcp",
  "title": "Sera FX",
  "description": "Multi-currency stablecoin FX settlement for AI agents: live rates, corridors, quotes, and non-custodial EIP-712 settlement intents. ~55 tools. Keyless subset on the hosted gateway.",
  "version": "0.8.3",
  "websiteUrl": "https://agents.sera.cx",
  "repository": { "url": "https://github.com/sera-cx/sera-mcp", "source": "github" },
  "packages": [
    { "registryType": "npm", "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "sera-mcp", "version": "0.8.3", "transport": { "type": "stdio" } }
  ],
  "remotes": [ { "type": "streamable-http", "url": "https://agents.sera.cx/mcp" } ]
}
```
> `io.github.sera-cx/...` verifies instantly via GitHub org-owner OAuth (fastest). Alternatively `cx.sera/...` needs a DNS TXT record on `sera.cx`. Pick one — it's the permanent registry identity.

### `sera-cx/sera-mcp` repo root — `smithery.yaml`
```yaml
runtime: "remote"
remote:
  url: "https://agents.sera.cx/mcp"
  transport: "streamable-http"
startCommand:
  type: "http"
  configSchema: { type: "object", properties: {}, required: [] }
```

### `sera-cx/sera-mcp` — `package.json` additions
```json
{
  "keywords": ["mcp", "mcp-server", "model-context-protocol", "modelcontextprotocol",
    "ai-agents", "agent-tools", "x402", "stablecoin", "fx", "foreign-exchange",
    "cross-border-payments", "settlement", "eip-712", "streamable-http", "sera"],
  "homepage": "https://agents.sera.cx",
  "mcpName": "io.github.sera-cx/sera-mcp"
}
```

### README install buttons (both repos)
```markdown
[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-000?style=flat-square&logo=cursor)](cursor://anysphere.cursor-deeplink/mcp/install?name=sera&config=eyJ1cmwiOiJodHRwczovL2FnZW50cy5zZXJhLmN4L21jcCJ9)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22sera%22%2C%22url%22%3A%22https%3A//agents.sera.cx/mcp%22%7D)
```
Regenerate: Cursor `config` = base64 of `{"url":"https://agents.sera.cx/mcp"}`; VS Code query = URL-encoded `{"name":"sera","url":"https://agents.sera.cx/mcp"}`.

### GitHub topics
```bash
gh repo edit sera-cx/sera-mcp    --add-topic mcp --add-topic mcp-server --add-topic model-context-protocol --add-topic ai-agents --add-topic x402 --add-topic stablecoin --add-topic fx --add-topic payments
gh repo edit sera-cx/sera-agents --add-topic mcp --add-topic ai-agents --add-topic x402 --add-topic a2a --add-topic stablecoin --add-topic agent-payments
```

### Awesome-MCP-Servers PR line (Finance/Payments)
```markdown
- [sera-cx/sera-mcp](https://github.com/sera-cx/sera-mcp) 🎖️ 📇 ☁️ - Multi-currency stablecoin FX settlement for AI agents: live rates, corridors, quotes, and non-custodial EIP-712 settlement intents. Open MCP, x402-payable, hosted keyless gateway.
```

---

## Verify before submitting (spec churn / open decisions)
1. **npm package name** — confirm `sera-mcp` vs `@sera-cx/sera-mcp` on npm; it must match `server.json` `identifier`, `package.json` name, `mcpName`, and the deeplinks.
2. **MCP registry namespace** — `io.github.sera-cx/...` (GitHub OAuth) vs `cx.sera/...` (DNS TXT). Permanent identity.
3. **A2A card** — path is `/.well-known/agent-card.json` (v1.0); we also keep legacy `agent.json`. Confirm `HTTP+JSON` is the right transport enum for a REST-only agent, and that advertising an A2A card (without the JSON-RPC task lifecycle) is acceptable as discovery-only.
4. **x402 Bazaar** — only auto-indexes via the **CDP facilitator** + bazaar extension, after a real `settle`. Check `x402-service` facilitator config; non-CDP → rely on `awesome-x402` + our `.well-known` instead.
5. **Anthropic Directory** — needs a live public **privacy-policy URL**, tool annotations, a demo account, Team/Enterprise Owner. Confirm before submitting.
6. **Smithery `runtime: remote`** — validate the `smithery.yaml` shape against smithery.ai/docs at submission (schema churns).
7. **Docker MCP Registry** — uses its own `server.yaml` format (read `docker/mcp-registry` CONTRIBUTING).
8. **VS Code deeplink** — ship both `vscode:` and `vscode-insiders:` buttons.
