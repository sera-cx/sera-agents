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

`x402-service/` is a Hono server implementing the [x402](https://github.com/coinbase/x402) flow: `POST /x402/swap` → 402 with payment requirements → client supplies `X-PAYMENT` → server verifies → atomic CAS reserves → settles → executes Sera swap → returns 200 + settlement metadata.

**Modular layout (v0.6.0):**

```
x402-service/
├── env.ts            Boot config + safety gates (refuses unsafe configs)
├── state.ts          PaymentStatus state machine + SQLite-backed atomic CAS store
├── facilitator.ts    Coinbase CDP facilitator client (/verify + /settle)
├── sera-client.ts    Long-lived sera-mcp stdio subprocess + JSON-RPC wrapper
├── payment.ts        verify/settle/execute orchestration + state transitions
└── server.ts         Hono routes + rate-limit + concurrency cap + boot
```

**Two modes:**

- `X402_MODE=demo` (default, `127.0.0.1` only) — self-contained. `verifyPayment` short-circuits; `settlePayment` is a no-op; `executeSwap` returns a mock. Safe to run locally.
- `X402_MODE=live` — Coinbase CDP facilitator integration. `verifyPayment` → `POST {X402_FACILITATOR_URL}/verify` (returns `isValid`). `settlePayment` → `POST /settle` (returns `txHash`, `networkId`). `executeSwap` → `sera.convert_and_send` via MCP. Operator-gated behind `X402_LIVE_ACK=true` + `X402_CONFIRMATION_DEPTH ≥ 3` + full CDP env (`X402_FACILITATOR_URL` + `X402_CDP_API_KEY_ID` + `X402_CDP_API_KEY_SECRET` + `X402_VAULT_ADDRESS`) — boot refuses without all of these, pending Base Sepolia E2E verification.

**State machine** (CAS-gated at every transition):

```
pending  ─cas(verify ok)→  verified  ─cas→  executing  ─cas(swap ok)→  delivered
   │                          │                            │
   ├─expires────────→ 410     ├─verify fail─→ 402          ├─settle fail──→ failed_refundable
   │                          │                            ├─swap fail────→ failed_refundable
   └─unknown────────→ 410     └─concurrent retry rejected
                              with 202 still_executing
```

Every transition is an atomic `cas(payment_id, expected_status, next_status)` in SQLite. Concurrent X-PAYMENT retries for a single `payment_id` collapse safely: replay after `delivered` returns the cached `delivered_payload`; replay during `executing` returns 202.

**Idempotency / replay protection** — mitigates Attack II from arXiv:2605.11781 (replay/idempotency: the live testbed observed 248 grants per single payment against a non-atomic implementation).

**Refund policy:** manual queue (default). `failed_refundable` payments surface via `GET /admin/refundables` (auth: `Bearer ${X402_ADMIN_TOKEN}`). Automated facilitator settlement-reversal is on the roadmap.

**Persistence:** SQLite via `better-sqlite3`, schema in `state.ts`. Path via `X402_STATE_DB`. Memory store mirrors for cache; SQLite is authoritative on restart.

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
