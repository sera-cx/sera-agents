# Security Model

For vulnerability reporting, see [`SECURITY.md`](SECURITY.md). For architecture, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For the core MCP's threat model, see [`sera-mcp/SECURITY-MODEL.md`](https://github.com/sera-cx/sera-mcp/blob/main/SECURITY-MODEL.md).

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

### Current state (`live` mode) — v0.6.0

- **`verifyPayment` wired against the Coinbase CDP facilitator.** Calls `POST {X402_FACILITATOR_URL}/verify` with the EIP-3009 `paymentHeader` + `paymentRequirements`. Auth via Bearer `{X402_CDP_API_KEY_ID}:{X402_CDP_API_KEY_SECRET}` (refine to HMAC-SHA256 JWT during first Base Sepolia E2E if CDP requires it).
- **`settlePayment` wired.** Two-phase flow: verify → CAS to verified → settle → CAS to executing → execute Sera swap. Settle failure after verify success transitions to `failed_refundable`.
- **Atomic idempotency.** SQLite UPSERT plus `cas(payment_id, expected_status, next_status)` for every transition. Concurrent X-PAYMENT submissions for the same payment_id can't double-settle or double-execute — losing the CAS path falls back to the idempotent-replay branch.
- **`Cache-Control: no-store, no-cache, private`** + `Pragma: no-cache` on every `/x402/*` response. Mitigates Attack III (CDN cache leak).
- **`X402_CONFIRMATION_DEPTH=3` enforced at boot** (refuses to start if < 3). CDP facilitator honors this when broadcasting.
- **Refund policy: manual queue (default).** Failed swaps move to `failed_refundable`; operator queries `GET /admin/refundables` (gated by `X402_ADMIN_TOKEN` Bearer) for the list. Re-payment is operator-driven via off-server tooling. Automated refund via facilitator settlement-reversal is on the roadmap (requires CDP-side support).
- **Live mode requires explicit operator ack** via `X402_LIVE_ACK=true`. Boot refuses otherwise — wiring is in place but NOT YET production-tested against Coinbase mainnet. Per protocol: complete Base Sepolia E2E first.
- **All env required for live boot:** `X402_FACILITATOR_URL` + `X402_CDP_API_KEY_ID` + `X402_CDP_API_KEY_SECRET` + `X402_VAULT_ADDRESS` + `X402_LIVE_ACK=true` + `X402_CONFIRMATION_DEPTH≥3`. Missing any → boot fails with a clear message listing the missing vars.

### Known attack surface (per arXiv:2605.11781, "Five Attacks on x402") — v0.6.0 coverage

| Attack | Applies to this package? | Mitigation status (v0.6.0) |
|---|---|---|
| I-A — Revert-grant (grant before finality) | Yes in live mode | **Mitigated**. Boot enforces `X402_CONFIRMATION_DEPTH ≥ 3`; CDP facilitator honors this. |
| I-B — Settlement preemption (observer submits EIP-3009 auth before facilitator) | Yes if hand-rolled verify | **Mitigated**. Verify + settle both via Coinbase CDP facilitator — bounds caller identity. |
| II — Replay / idempotency (same X-PAYMENT triggers multiple grants) | Yes pre-v0.6.0 | **Mitigated**. Atomic `cas(payment_id, expected, next)` on every state transition. Replay returns cached `delivered_payload`; never re-settles, never re-executes. |
| III — Header / proxy confusion (CDN caches 200 with paid content) | Yes pre-v0.6.0 | **Mitigated**. `Cache-Control: no-store, no-cache, private` + `Pragma: no-cache` on every `/x402/*` route. |
| IV — Server-selection (Sybil / metadata in Bazaar) | Not applicable — endpoint is direct, no Bazaar registry use. | N/A |

### Hardening status (v0.6.0)

All six hardening items below are now CODE-COMPLETE. The single remaining gate is **operator-driven Base Sepolia E2E verification** before flipping mainnet:

1. ✅ `verifyPayment` calls Coinbase CDP facilitator `/verify`. The dynamic FX state machine is preserved (per [[x402-service-design-insight]] — never replaced with `x402-express` middleware).
2. ✅ Atomic idempotency via SQLite-backed `cas(payment_id, expected_status, next_status)`. Every state transition is CAS-gated. Concurrent X-PAYMENT submissions for the same payment_id resolve idempotently.
3. ✅ `Cache-Control: no-store, no-cache, private` on every `/x402/*` response.
4. ✅ `X402_CONFIRMATION_DEPTH ≥ 3` enforced at boot. Honored by CDP facilitator.
5. ✅ Refund policy: **manual queue (default)**. `failed_refundable` payments are surfaced via `GET /admin/refundables` (auth: `Bearer ${X402_ADMIN_TOKEN}`). Automated refund via facilitator settlement-reversal is on the roadmap pending CDP-side support.
6. ⚠️ **Base Sepolia E2E NOT YET COMPLETED.** Live mode boots only when `X402_LIVE_ACK=true` is also set — operator must acknowledge they've completed the testnet E2E and accept residual risk.

**Practical operator path to going live:**
1. Configure all live envs (see `.env.example`).
2. Set `X402_MODE=live` + `X402_NETWORK=base-sepolia` + `X402_LIVE_ACK=true`.
3. Run an end-to-end test: trigger 402 → pay USDC on Sepolia → confirm settle tx_hash + delivery via Sera Sepolia.
4. Inspect facilitator response shapes — refine `authHeader()` in `facilitator.ts` if CDP requires HMAC-SHA256 JWT instead of the current `Bearer ${id}:${secret}` form.
5. Once Sepolia E2E is green: switch `X402_NETWORK=base` for mainnet. Don't switch any other knobs.

Until Sepolia E2E is verified, **demo mode is the safe default**.

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
