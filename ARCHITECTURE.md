# Architecture

How `sera-agents` is laid out. For setup and usage, see [`README.md`](README.md). For threat model and the x402 hardening posture, see [`SECURITY-MODEL.md`](SECURITY-MODEL.md). For the core MCP it depends on, see [Josh-sera/sera-mcp](https://github.com/Josh-sera/sera-mcp).

## What this repo is

This repo is the public companion to `sera-mcp`. It contains everything someone needs to actually use Sera's MCP layer in real agent products — but no engine code lives here. Engine code lives in `sera-mcp`.

```
┌──────────────────┐                       ┌─────────────────┐
│  sera-agents     │                       │   sera-mcp      │
│  (this repo)     │  consumes via stdio   │  (engine, npm)  │
│                  │ ────────────────────▶ │                 │
│  site + docs     │                       │  32 MCP tools   │
│  templates       │                       │  signer + policy│
│  examples        │                       │  Sera REST      │
│  x402-service    │                       │                 │
│  integrations    │                       │                 │
└──────────────────┘                       └─────────────────┘
```

## Folder map

```
sera-agents/
├── README.md
├── ARCHITECTURE.md             this file
├── SECURITY-MODEL.md           threat model + hardening posture
├── CHANGELOG.md
├── SECURITY.md                 vulnerability reporting
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── package.json                workspace root (npm workspaces)
├── tsconfig.base.json          shared TS config for all packages
│
├── index.html                  Landing page (single file, GitHub Pages)
├── og-template.html            OpenGraph template
├── logo.png, og-image.png, favicons, apple-touch-icon
├── CNAME                       agents.sera.cx
├── robots.txt, sitemap.xml
│
├── docs/                       Public docs site (HTML, served by Pages)
│   ├── index.html
│   ├── architecture.html
│   ├── concepts.html
│   ├── recipes.html
│   ├── api/index.html
│   └── tutorials/
│       ├── index.html
│       ├── ai-agent.html
│       ├── cross-border-payment-widget.html
│       ├── fx-trading-dashboard.html
│       ├── prediction-market.html
│       ├── treasury-rebalancer.html
│       └── x402-paid-api.html
│
├── sera-agent/                 PATH C — bundled CLI agent
│   ├── agent.ts                Single-file interactive REPL
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
│
├── templates/                  PATH B — copy-and-customize starters
│   ├── README.md
│   ├── chat-cli/               Terminal REPL template
│   ├── web-chat/               Express + browser chat UI
│   └── webhook-agent/          HTTP endpoint that triggers an agent task
│
├── examples/                   Reference flows (programmatic, single-task)
│   ├── invoice-payer/          Cross-currency invoice settlement
│   └── treasury-rebalancer/    Multi-wallet rebalance to target weights
│
├── x402-service/               PATH D — protocol-level paid endpoint
│   ├── server.ts               Hono server. Implements 402 → pay → 200.
│   ├── package.json
│   └── README.md
│
├── x402/sera-x402.md           Original x402 design notes
│
├── integrations/               Per-host integration guides
│   ├── README.md
│   ├── openclaw/               OpenClaw (3 paths: MCP, clawhub, plugin)
│   ├── hermes/                 Hermes (native MCP + skill wrapper)
│   ├── nanoclaw/               NanoClaw (.mcp.json)
│   └── standard-mcp-hosts/     Claude Code, Desktop, ChatGPT, Cursor, Cline
│
└── .github/
    ├── workflows/ci.yml        typecheck + audit + gitleaks + CodeQL
    ├── ISSUE_TEMPLATE/
    └── PULL_REQUEST_TEMPLATE.md
```

## Workspaces

This repo is an `npm` workspace. Root `package.json` declares 7 packages:

```
sera-agent
x402-service
templates/chat-cli
templates/web-chat
templates/webhook-agent
examples/invoice-payer
examples/treasury-rebalancer
```

Each package has its own `package.json`, `tsconfig.json` (extending `../tsconfig.base.json`), and dependency set. Root scripts run across all packages:

```bash
npm install              # install all workspaces
npm run typecheck        # tsc --noEmit per package
npm run audit            # npm audit per package
npm run check            # typecheck + audit
```

Root `overrides` block forces `qs ^6.15.2` and `ws ^8.21.0` across the dependency tree to clear known moderate audits.

## Path A — install the MCP

External — uses `sera-mcp` directly, no code in this repo. See `README.md` Path A.

## Path B — build from a template

`templates/{chat-cli, web-chat, webhook-agent}` are each:

- A single-file `agent.ts` or `server.ts` (the entire template body).
- Uses [`@openai/agents`](https://www.npmjs.com/package/@openai/agents) (the OpenAI Agents SDK for JS/TS).
- Spawns `sera-mcp` as a stdio subprocess via `MCPServerStdio`.
- Defines a system prompt + agent role; the agent decides which `sera.*` tools to call.

Each template exposes one shape:

| Template | Shape | Auth |
|---|---|---|
| `chat-cli` | Terminal REPL | none |
| `web-chat` | Express + plain-HTML chat UI | none (intended for local dev) |
| `webhook-agent` | HTTP `POST /webhook` → run agent → return result | HMAC (Stripe / GitHub / generic) |

Templates do not bundle production-grade auth, rate limiting, or persistence. They are starters.

## Path C — the bundled `sera-agent/` CLI

A single-file interactive CLI built on the same OpenAI Agents SDK + stdio MCP pattern as the templates. Lower-friction than Path B because it's ready to run; higher-ceiling than running raw MCP tools by hand because the system prompt is pre-tuned for Sera workflows.

## Path D — the x402 service

`x402-service/server.ts` is a Hono server implementing the [x402](https://github.com/coinbase/x402) flow: initial `POST /x402/swap` returns 402 with payment requirements, client supplies `X-PAYMENT`, server verifies → reserves → executes Sera swap → returns 200 + settlement metadata.

**Two modes:**

- `X402_MODE=demo` (default) — self-contained. `verifyPayment` short-circuits to accept any `<payment_id>:authorization` shape. Safe to run locally.
- `X402_MODE=live` — **not production-complete**. `verifyPayment` returns `"live verification not yet implemented"`. Replacing this with the official Coinbase CDP facilitator (`@coinbase/x402`) is on the roadmap.

State machine (simplified):

```
pending  ─verify→  verified  ─execute→  executing  ─settle→  delivered
   │                  │                                          │
   └─expires─→ 410    └─verify fails─→ 402                       └─swap fails─→ failed_refundable
```

Persistence: SQLite via `better-sqlite3`, keyed by `payment_id`. The DB lives next to `server.ts` and is created on first run.

## Examples

Programmatic single-task agents, not interactive:

- `examples/invoice-payer/` — given `--owner`, `--recipient`, `--amount`, `--currency`, picks the cheapest source asset from the owner's holdings and executes the swap.
- `examples/treasury-rebalancer/` — given multiple wallet addresses and target weights, plans and executes the trades to reach the target.

Both use `MCPServerStdio` to spawn `sera-mcp` and call `sera.*` tools.

## Integrations

`integrations/{openclaw, hermes, nanoclaw, standard-mcp-hosts}` each contains a `README.md` plus per-host config snippets. These are documentation, not code — copy-paste recipes for wiring `sera-mcp` into each host's MCP config.

## Site & docs

`index.html` is the landing page at [agents.sera.cx](https://agents.sera.cx). The `docs/` tree is the public documentation site, served as static HTML via GitHub Pages.

GitHub Pages config:

- Source: `main` branch, root.
- `CNAME` → `agents.sera.cx`.
- `og-template.html` is the source for the OpenGraph card image; `og-image.png` is the rendered output.

## Dependency on `sera-mcp`

This repo does **not** vendor or duplicate `sera-mcp`. Every code path that invokes Sera goes through the published `sera-mcp` package (or a local clone at the user's path). The contract between repos:

- `sera-agents` consumes `sera-mcp` via stdio (`MCPServerStdio` from `@openai/agents`).
- `sera-agents` does not import `sera-mcp` symbols or types.
- `sera-mcp` does not depend on `sera-agents` for anything.
- Both repos target the same MCP compatibility surface (stdio today; Streamable HTTP planned upstream first).

If you find a bug in Sera tool behavior, file it against `sera-mcp`. If you find a bug in a template, agent, or x402 service, file it here.
