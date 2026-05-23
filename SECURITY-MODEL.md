# Security Model

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md). For architecture, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For the core MCP's threat model, see [`sera-mcp/SECURITY-MODEL.md`](https://github.com/Josh-sera/sera-mcp/blob/main/SECURITY-MODEL.md).

## Threat model

`sera-agents` is a showroom + starter kit. The packages here are **not** drop-in production deployments. Each package has a specific threat-model framing:

| Package | Treat as |
|---|---|
| `sera-agent/` (bundled CLI) | Local single-user tool |
| `templates/{chat-cli, web-chat, webhook-agent}` | Starter code you fork and harden |
| `examples/{invoice-payer, treasury-rebalancer}` | Reference flows for reading, not deploying |
| `x402-service/` (`demo` mode) | Safe to run locally |
| `x402-service/` (`live` mode) | **Not production-complete — see below** |
| Site / docs HTML | Static content, served by GitHub Pages |

## Safe defaults

| Path | Safe by default? | Why |
|---|---|---|
| Path A — install the MCP | Yes | `sera-mcp` defaults to `external` signer mode; no key in the MCP. |
| Path B — templates | Yes | Templates require explicit `OPENAI_API_KEY`; never expose execution tools without local-signer wiring. |
| Path C — bundled CLI | Yes | Interactive; user confirms tool calls as they happen. |
| Path D — x402 service (demo mode) | Yes | `verifyPayment` short-circuits; no real money. |
| Path D — x402 service (live mode) | **No — see x402-service section** | |

## x402-service threat surface

This is the highest-risk surface in the repo. It implements a payment flow and is the most likely package to be promoted from "experimental" to "production." The hardening posture is intentionally explicit:

### Current state (`live` mode)

- `verifyPayment` at `server.ts` is **scaffold**. It returns `"live verification not yet implemented"` and **does not call any facilitator**.
- The state machine (`pending → verified → executing → delivered | failed_refundable`) is wired and correct in shape.
- Idempotency is partial: payments are keyed by `payment_id` in SQLite, but there is no atomic "reserve before release" guard.
- No `Cache-Control: no-store` headers on `/x402/swap` responses.
- No confirmation-depth check on settlement.
- No refund implementation for `failed_refundable` — manual operator action required.

### Known attack surface (per arXiv:2605.11781, "Five Attacks on x402")

| Attack | Applies to this package? | Mitigation status |
|---|---|---|
| I-A — Revert-grant (grant before finality) | Yes (if live-mode is enabled without confirmations) | Not implemented — confirmation depth must be `k≥3` on Base before release. |
| I-B — Settlement preemption (observer submits EIP-3009 auth before facilitator) | Yes (if hand-rolled verify is enabled) | Mitigated by using official `@coinbase/x402` facilitator client; planned. |
| II — Replay / idempotency (same X-PAYMENT triggers multiple grants) | Yes (current SQLite reserve is non-atomic) | Atomic "reserve before release" + idempotency store with TTL planned. |
| III — Header / proxy confusion (CDN caches 200 with paid content) | Yes (no Cache-Control today) | `Cache-Control: no-store, no-cache, private` planned on all `/x402/*` routes. |
| IV — Server-selection (Sybil / metadata in Bazaar) | Not applicable — endpoint is direct, no Bazaar registry use. | N/A |

### Hardening required before going live

The path to "live-mode is production-complete" is:

1. Replace `verifyPayment` stub with calls to Coinbase CDP facilitator endpoints (`https://api.cdp.coinbase.com/platform/v2/x402/verify` and `/settle`). Use the `@coinbase/x402` package as a facilitator client; **do not** replace the dynamic FX state machine with `x402-express` middleware — the shape is wrong for FX delivery.
2. Add atomic idempotency: `(payment_id, resource_id)` upsert in SQLite (or Redis for multi-instance) **before** moving to `executing`. TTL = `maxTimeoutSeconds + 60`.
3. Set `Cache-Control: no-store, no-cache, private` on all `/x402/*` responses.
4. Set confirmation depth `k≥3` on Base mainnet before transitioning `verified → delivered`.
5. Define refund behavior for `failed_refundable`:
   - **Option A** (recommended for v0.1): automatic refund via facilitator's settlement-reversal if it exists, else queue for manual operator action.
   - **Option B**: never settle until execution is confirmed (escrow-until-ready).
   - This is a product decision, not a code one.
6. Test the full pipeline on Base Sepolia end-to-end before flipping mainnet.

Until all six land, **do not run `X402_MODE=live` against real money**. The demo mode is safe.

## Template security expectations

`templates/chat-cli/`, `templates/web-chat/`, and `templates/webhook-agent/` are intentionally minimal starters. They are **not** production-hardened.

What they DO ship safely:

- HMAC verification on `webhook-agent` (Stripe, GitHub, generic providers).
- Nonce replay protection in the HMAC verifier.
- Helmet on Express servers (`web-chat`, `webhook-agent`).
- No execution tools enabled by default — they consume `sera-mcp` in `external` signer mode.

What they do NOT ship:

- Persistent session storage.
- Rate limiting (per-user, per-IP, or global).
- TLS termination (assumed to be handled by reverse proxy).
- Token-based auth or OAuth (besides the optional HMAC).
- Tool filtering (every `sera.*` tool is exposed to the agent by default).
- Audit logging beyond stdout.

If you fork a template into production:

- Add a tool filter to expose only the tools your agent actually needs.
- Add rate limiting at the reverse-proxy or middleware layer.
- Add session persistence if your agent needs memory across requests.
- Run `sera-mcp` with the tightest `POLICY_PRESET` your workflow allows.
- Never expose `execute_swap` or `convert_and_send` via a webhook without an explicit per-call user confirmation step.

## Example security expectations

`examples/invoice-payer/` and `examples/treasury-rebalancer/` are programmatic single-task agents. They:

- Require `OPENAI_API_KEY` and (for treasury) `SERA_API_KEY` / `SERA_API_SECRET`.
- Spawn `sera-mcp` locally as a subprocess.
- Are run from the command line, not exposed as a service.

They are reference flows. If you deploy one as a service, wrap it the same way you'd wrap a template — auth, rate limiting, confirmation UX.

## Site & docs

Static HTML, served via GitHub Pages from `main`. No backend, no API keys, no user input handled by JavaScript on these pages. Risks are limited to standard static-site supply chain (e.g., the Tailwind CDN script tag in `index.html` and `docs/`). For agent-related documentation pages, no credentials or sensitive data are collected.

## Dependency-chain audits

CI runs on every PR (`.github/workflows/ci.yml`):

- `npm install` across all workspaces.
- `npm run typecheck` per package.
- `npm audit --audit-level=high`.
- `gitleaks` secret scan.
- CodeQL static analysis.

Root `package.json` declares `overrides` for `qs ^6.15.2` and `ws ^8.21.0` to clear known moderate audits via the dependency tree without waiting on upstream bumps.

## Reporting vulnerabilities

See [`SECURITY.md`](SECURITY.md).
