# Security Policy

## Reporting a Vulnerability

Please don't open a public issue for security findings.

Use [GitHub's private security advisory](https://github.com/Josh-sera/sera-agents/security/advisories/new) or contact the maintainer (see profile).

We aim to acknowledge reports within 48 hours and ship fixes for verified high/critical findings within 7 days.

## Supported Versions

Only the latest release on `main` is supported. Past tags are not patched in place.

## Scope

This repository ships **starter templates**, a **bundled agent**, **integration docs**, and an **x402 service**. None of it is intended to be run in production without operator review. Defaults are conservative for distribution safety; production hardening is the operator's responsibility.

## Threat Model

- HTTP templates (web-chat, webhook-agent, x402-service) may be deployed publicly. They refuse to start in unsafe configurations (no auth + non-loopback bind) and require explicit opt-ins.
- Agent natural-language inputs (chat messages, webhook payloads) are treated as **untrusted** and pass through allowlist mappers / Zod validation before becoming agent instructions.
- The Sera MCP child process treats every tool argument as agent-influenced. Schema validation happens upstream in sera-mcp itself.
- x402-service in `live` mode performs real on-chain settlement and requires a vault wallet. The current build refuses to start in live mode without `X402_FACILITATOR_URL` to avoid users losing funds against the stub verifier.

## Hardening Posture

### x402-service
- Demo mode bound to localhost unless `X402_DEMO_PUBLIC=true`
- Demo responses include `demo: true`, `tx_hash: null`, and `X-Sera-Demo-Mode: true` header so artifacts can never be confused with real settlement
- Live mode refuses to start without `X402_FACILITATOR_URL`
- Payment state machine: `pending → verified → executing → delivered | failed_refundable`. Idempotent retries by `payment_id`; replay returns cached success body
- SQLite persistence (optional via `X402_STATE_DB`) — payment state survives restart
- Zod schemas at HTTP boundary (recipient must be 0x-prefixed 40-hex; amount bounded; supported currencies enforced)
- Per-IP rate limit (only honored when `X402_TRUST_PROXY=true` — default off)
- Body cap 4kb; payment ID validated as UUID before Map lookup
- Concurrency cap on swap execution (`X402_MAX_CONCURRENT_SWAPS`, default 8)

### web-chat
- Auth required for non-loopback bind (`WEB_CHAT_AUTH_TOKEN`)
- Helmet headers including CSP, HSTS, X-Content-Type-Options, frame protection
- Constant-time bearer comparison
- Trust-proxy off by default (`WEB_CHAT_TRUST_PROXY=true` to opt in, single hop only)
- Sessions LRU-capped, server-derived session IDs (HMAC of client-supplied id) — clients can't impersonate each other
- Browser bearer token in **memory only** by default; `window.SERA_WEB_CHAT_PERSIST_TOKEN=true` or localStorage flag to opt into persistence
- Concurrency cap on agent runs (`WEB_CHAT_MAX_CONCURRENT`, default 4)
- Body cap 32kb; per-request rate limit before auth check (saves CPU on attacker traffic)

### webhook-agent
- Auth required for non-loopback bind (`WEBHOOK_SECRET`)
- Constant-time bearer comparison
- Optional provider HMAC verification (Stripe, GitHub, generic) with timestamp tolerance + nonce LRU for replay defense
- Allowlisted task mapper — default rejects free-form JSON (prevents prompt injection from upstream payload fields)
- Helmet headers
- Trust-proxy off by default (`WEBHOOK_TRUST_PROXY=true` to opt in, single hop only)
- Concurrency cap on agent runs (`WEBHOOK_MAX_CONCURRENT`, default 4)
- Body cap 32kb (raw body captured for HMAC verification)

### CLI examples (invoice-payer, treasury-rebalancer)
- All arguments validated with strict regexes (EVM address, fiat code, symbol) before substitution into agent instructions
- Bad input fails closed with a clear error before any LLM call

## CI

Each package runs `npm ci`, typecheck, build, and `npm audit --audit-level=high` on every push. Gitleaks secret scanning + CodeQL on the top-level repo.

## Known Out-of-Scope Items

- The x402-service `live` mode payment verification is intentionally a stub; operators must wire a facilitator before live deployment.
- We do not implement encrypted transport between MCP host and the MCP server (stdio is treated as a trust boundary at the host).
- Smart contract security is Sera Protocol's responsibility, not this repo.
