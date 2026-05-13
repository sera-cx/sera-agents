# Sera for Agents

**Live site: [josh-sera.github.io/sera-agents](https://josh-sera.github.io/sera-agents/)**

Multi-currency settlement infrastructure for AI agents. Quote, convert, and settle across 40+ stablecoins and 20+ fiat currencies — USD, SGD, MYR, JPY, EUR, GBP, BRL, MXN, IDR, and more — through an open Model Context Protocol server, three starter templates, a complete bundled agent, and a protocol-level x402 endpoint.

## Four paths

| Path | For | Artifact |
|---|---|---|
| **A — Install** | Already have an agent stack (Claude, ChatGPT, Cursor, OpenAI Agents SDK, etc.) | `~/Desktop/sera-mcp` (the MCP) |
| **B — Build** | Engineering a new agent product | `templates/{chat-cli, web-chat, webhook-agent}` |
| **C — Run** | Want it ready out of the box | `sera-agent/` (interactive CLI) |
| **D — Protocol** | Agent doesn't know what Sera is, only x402 | `x402-service/` |

All four work today. Templates are copy-and-customize. The x402 service has a self-contained demo mode (no external deps); production mode requires a vault wallet.

## Repository contents

```
sera-agents/
├── README.md                     This file.
├── index.html                    Landing page (single file, host anywhere static).
│
├── sera-agent/                   PATH C — bundled CLI.
│   ├── agent.ts
│   ├── package.json
│   └── README.md
│
├── templates/                    PATH B — copy-and-customize starters.
│   ├── README.md
│   ├── chat-cli/                 Terminal REPL.
│   ├── web-chat/                 Express + browser chat UI.
│   └── webhook-agent/            HTTP endpoint that triggers an agent task.
│
├── x402-service/                 PATH D — protocol-level service.
│   ├── server.ts                 Hono server. Implements 402 → pay → 200.
│   ├── package.json
│   └── README.md
│
├── integrations/                 Per-host integration configs + READMEs.
│   ├── openclaw/                 Sera in OpenClaw (3 paths: MCP, clawhub, plugin).
│   ├── hermes/                   Sera in Hermes (native MCP + skill wrapper).
│   ├── nanoclaw/                 Sera in NanoClaw (.mcp.json).
│   └── standard-mcp-hosts/       Claude Code, Desktop, ChatGPT, Cursor, Cline, etc.
│
├── examples/                     Reference flows (programmatic, single-task agents).
│   ├── invoice-payer/
│   └── treasury-rebalancer/
│
└── x402/sera-x402.md             Original design notes for the x402 endpoint.
```

Plus repo-root files: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/` (issue + PR templates).

The MCP server itself lives at `~/Desktop/sera-mcp/` — separate package, distributed independently. v0.4.0, 32 tools.

## Path A — install the MCP

```bash
cd ~/Desktop/sera-mcp
npm install && npm run build

claude mcp add sera --scope user \
  --env SERA_NETWORK=mainnet \
  --env POLICY_PRESET=standard \
  -- node $(pwd)/dist/index.js
```

Verify in any agent session: `Call sera.doctor`.

## Path B — build from a template

```bash
# Pick chat-cli, web-chat, or webhook-agent
cp -r templates/web-chat ~/my-sera-agent
cd ~/my-sera-agent
npm install
export OPENAI_API_KEY=sk-...
npm start
```

Then customize `SYSTEM_PROMPT` in `agent.ts`/`server.ts` to make the agent yours. See [`templates/README.md`](templates/README.md) for what each template is shaped for.

## Path C — run the bundled agent

```bash
cd sera-agent
npm install
export OPENAI_API_KEY=sk-...
npm start
```

Interactive terminal chat. Try:
- "What stablecoins do you support for SGD?"
- "How much USDC to deliver exactly 5,000 MYR?"
- "Run sera.find_deals at 25 bps and rank the results."

## Path D — run the x402 service

```bash
cd x402-service
npm install
npm run demo                   # X402_MODE=demo, listens on :8402
```

In another terminal:

```bash
# Initial request → 402 with payment_required
curl -X POST http://localhost:8402/x402/swap \
  -H 'Content-Type: application/json' \
  -d '{"from_currency":"USD","to_currency":"MYR","amount":100,"recipient":"0xVendor"}'

# Retry with X-PAYMENT header → 200 with delivered
curl -X POST http://localhost:8402/x402/swap \
  -H 'Content-Type: application/json' \
  -H 'X-PAYMENT: <PAYMENT_ID>:demo-authorization' \
  -d '{"from_currency":"USD","to_currency":"MYR","amount":100,"recipient":"0xVendor"}'
```

Production mode (`X402_MODE=live`) needs a funded vault wallet, an RPC URL, and an x402 facilitator integration. See [`x402-service/README.md`](x402-service/README.md).

## Reference flows (programmatic, not interactive)

```bash
# Cross-currency invoice payer
cd examples/invoice-payer
npm install
OPENAI_API_KEY=sk-... npm run start -- \
  --owner 0xYou --recipient 0xVendor --amount 5000 --currency MYR

# Treasury rebalancer
cd examples/treasury-rebalancer
npm install
OPENAI_API_KEY=sk-... \
SERA_API_KEY=... SERA_API_SECRET=... \
npm run start -- \
  --wallets 0xA,0xB,0xC \
  --target USD:40,SGD:30,MYR:20,EUR:10
```

## Position

Sera complements single-currency agent rails rather than replacing them. Use any stablecoin as inflow. Use Sera for the FX leg whenever the counterparty needs settlement in a different currency.

| | Single-currency rails | Sera for Agents |
|---|---|---|
| Stablecoins | Typically one | 40+ across 20+ fiats |
| FX | Not supported | Atomic, smart-routed |
| Recipient settles in | Issuer's currency only | Any supported currency |
| Integration | Hosted SDK / API | Open MCP, four paths above |
| Custody | Centralized | Non-custodial, on-chain settlement |

## Roadmap

- **`x402.sera.cx`** — host the x402 service for real (vault wallet, monitoring, facilitator integration).
- **Hosted MCP transport** — SSE/HTTP for hosts that don't run stdio subprocesses.
- **`npx create-sera-agent`** — proper scaffolder once enough people use the templates.
- **Push subscriptions** — deal alerts and rate-threshold notifications instead of polling.

## License

MIT.
