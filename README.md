# Sera for Agents

**Templates, examples, docs, and x402 integrations built on top of [`sera-mcp`](https://github.com/Josh-sera/sera-mcp).**

**Live site: [agents.sera.cx](https://agents.sera.cx)** · **Core MCP: [Josh-sera/sera-mcp](https://github.com/Josh-sera/sera-mcp)**

**Who this is for:** developers integrating Sera into an existing agent product, picking up a template to ship fast, or wiring up a protocol-level x402 endpoint for agent-to-agent FX delivery.

Multi-currency settlement infrastructure for AI agents. Quote, convert, and settle across 40+ stablecoins and 20+ fiat currencies — USD, SGD, MYR, JPY, EUR, GBP, BRL, MXN, IDR, and more — through an open Model Context Protocol server, three starter templates, a complete bundled agent, and a protocol-level x402 endpoint.

For deeper reading, see [`ARCHITECTURE.md`](ARCHITECTURE.md), [`SECURITY-MODEL.md`](SECURITY-MODEL.md), and [`CHANGELOG.md`](CHANGELOG.md).

## Four paths

| Path | For | Artifact |
|---|---|---|
| **A — Install** | Already have an agent stack (Claude, ChatGPT, Cursor, OpenAI Agents SDK, etc.) | [`sera-mcp`](https://github.com/Josh-sera/sera-mcp) (the MCP) |
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

The MCP server itself lives in a separate repo: [Josh-sera/sera-mcp](https://github.com/Josh-sera/sera-mcp) — distributed independently. v0.5.0, 32 tools.

## Path A — install the MCP

```bash
git clone https://github.com/Josh-sera/sera-mcp
cd sera-mcp
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

## Status

Honest read of what's solid vs what's still moving:

| Surface | Status | Notes |
|---|---|---|
| Docs site ([agents.sera.cx](https://agents.sera.cx)) | **Stable** | Static, served via GitHub Pages |
| Integration guides (OpenClaw, Hermes, NanoClaw, standard MCP hosts) | **Stable** | Config snippets verified against current host versions |
| Templates (`chat-cli`, `web-chat`, `webhook-agent`) | **Demo / starter** | Copy-and-customize; not maintained as products |
| Examples (`invoice-payer`, `treasury-rebalancer`) | **Demo / starter** | Reference flows; not turnkey services |
| `sera-agent/` bundled CLI | **Demo / starter** | Interactive REPL for quick exploration |
| `x402-service/` demo mode | **Experimental** | Self-contained; no facilitator needed; safe to run locally |
| `x402-service/` live mode | **Wired, not yet production-verified** (v0.6.0) | Coinbase CDP facilitator integration shipped (`verifyPayment` + `settlePayment` call `/verify` and `/settle`). Atomic CAS idempotency, `Cache-Control: no-store`, `X402_CONFIRMATION_DEPTH ≥ 3` enforced. Operator-gated behind `X402_LIVE_ACK=true` — boot refuses without it, pending Base Sepolia E2E verification. See [`x402-service/README.md`](x402-service/README.md) + [`SECURITY-MODEL.md`](SECURITY-MODEL.md). |
| Streamable HTTP MCP usage in templates | **Planned** | Templates currently use stdio (`MCPServerStdio`). |
| `npx create-sera-agent` scaffolder | **Planned** | After more template adoption. |

## Roadmap

- **`x402-service` live mode — Base Sepolia E2E verification.** v0.6.0 wired the Coinbase CDP facilitator integration end-to-end (verify + settle + atomic CAS idempotency + cache-control + k≥3 confirmation gate + manual-refund queue). Operator needs to run one full payment cycle on Base Sepolia, refine `authHeader()` if CDP requires HMAC-SHA256 JWT instead of the current `Bearer ${id}:${secret}` form, then switch `X402_NETWORK=base` for mainnet.
- **Streamable HTTP templates** — alongside stdio examples; for ChatGPT connectors and hosted/remote agents. No SSE work planned (deprecated upstream).
- **`npx create-sera-agent`** — proper scaffolder once enough people use the templates.
- **Push subscriptions** — deal alerts and rate-threshold notifications instead of polling.

## Development

```bash
# install all workspace packages
npm install

# run typecheck across every package
npm run typecheck

# run audit across every package (high+)
npm run audit

# both
npm run check
```

CI runs the same checks on every PR — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

MIT.
