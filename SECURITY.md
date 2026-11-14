# Security Policy

## Reporting a Vulnerability

Please don't open a public issue for security findings.

Use [GitHub's private security advisory](https://github.com/sera-cx/sera-agents/security/advisories/new) or contact the maintainer (see profile).

We aim to acknowledge reports within 48 hours and ship fixes for verified high/critical findings within 7 days.

## Supported Versions

Only the latest release on `main` is supported. Past tags are not patched in place.

## Scope

This repository ships **starter templates**, a **bundled agent**, **integration docs**, and an **x402 service**. None of it is intended to be run in production without operator review. Defaults are conservative for distribution safety; production hardening is the operator's responsibility.

## Threat Model

- HTTP templates (web-chat, webhook-agent, x402-service) may be deployed publicly. They refuse to start in unsafe configurations (no auth + non-loopback bind) and require explicit opt-ins.
- Agent natural-language inputs (chat messages, webhook payloads) are treated as **untrusted** and pass through allowlist mappers / Zod validation before becoming agent instructions.
- The Sera MCP child process treats every tool argument as agent-influenced. Schema validation happens upstream in sera-mcp itself.
- x402-service in `live` mode performs real on-chain settlement and requires a vault wallet. The current build is wired to the Coinbase CDP facilitator and refuses live boot without facilitator credentials, a vault address, confirmation-depth safeguards, and an explicit operator acknowledgement (`X402_LIVE_ACK=true`). It is not production-verified: complete the Base Sepolia E2E before any live deployment (see [`SECURITY-MODEL.md`](SECURITY-MODEL.md)).

## Hardening Posture

### x402-service
- Demo mode bound to localhost unless `X402_DEMO_PUBLIC=true`
- Demo responses include `demo: true`, a self-identifying `tx_hash` of the form `demo_<payment_id>`, and the `X-Sera-Demo-Mode: true` header, so an artifact stays identifiable as demo even when the header is dropped in transit. The persisted state row carries `demo = 1`, and a state file is refused at startup if it holds rows from the other mode
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

### CI/CD supply chain

A workflow file can read every secret the repository can see, so the CI
configuration is treated as privileged code:

- **Actions are pinned to commit SHAs**, not tags, with the tag kept in a
  trailing comment. A tag is mutable — whoever controls the action's repo can
  repoint it at new code after review. Dependabot keeps the SHAs current.
- **`persist-credentials: false`** on every checkout, so the job's token is not
  left in `.git/config` for a later step to pick up.
- **Least-privilege `permissions:`** at the workflow level (`contents: read`),
  widened per-job only where required (`packages: write` to push the gateway
  image, `security-events: write` for CodeQL).
- **Third-party binaries are checksum-verified.** The gitleaks CLI is
  downloaded, verified against a pinned sha256, then extracted.
- **Base images are pinned by digest** in all three Dockerfiles, and the
  gateway builds sera-mcp from a **pinned commit SHA** fetched by SHA rather
  than from a mutable tag.
- **`.github/CODEOWNERS`** routes CI, deployment, and x402 changes to admin
  review. This is only advisory until branch protection on `main` enables
  "Require a pull request before merging" + "Require review from Code Owners".

### 2026-09-05 credential-exfiltration incident

On 2026-09-05 a workflow named `Github Actions Security`
(`.github/workflows/github_actions_security.yml`) was pushed directly to `main`
in this and 12 other `sera-cx` repositories. Its single job, `send-secrets`,
POSTed `DEPLOY_PATH`, `GITLEAKS_LICENSE`, `SSH_HOST`, `SSH_PORT`,
`SSH_PRIVATE_KEY` and `SSH_USER` to a hard-coded IP over plaintext HTTP, and
triggered itself with `on: push`. It was reverted here the next day, and the
file is gone from every affected repository.

It succeeded because nothing stopped it: `main` had no branch protection, so a
workflow change reached it as a direct push with no review. The mitigations in
the section above exist to close that path. Enabling branch protection and
Code Owners review on `main` is the part that must be done in repository
settings rather than in this tree.

## Known Out-of-Scope Items

- The x402-service `live` mode is wired to a CDP facilitator but has not completed its required Base Sepolia end-to-end verification. Operators must set `X402_LIVE_ACK=true`, complete that E2E, and approve their own deployment before enabling live settlement (see [`SECURITY-MODEL.md`](SECURITY-MODEL.md)).
- We do not implement encrypted transport between MCP host and the MCP server (stdio is treated as a trust boundary at the host).
- Smart contract security is Sera Protocol's responsibility, not this repo.
