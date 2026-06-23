# Changelog

All notable changes to `sera-agents` are documented in this file.

## [Unreleased] — make the maker/taker (deploy-liquidity vs take) paths first-class

### Added — `templates/taker` (the mirror image of `market-maker`)
- New deterministic-loop template for **consuming** liquidity: inventory guard (`sera.get_balances`) → reference mid (`sera.multi_source_mid`) → best executable deal (`sera.find_deals`, falls back to `sera.get_quote`) → edge gate → take (`sera.convert_and_send`). No LLM in the hot path; shares the maker's stdio `lib/mcp-client.ts` shape.
- `TK_DRY_RUN=true` by default — logs the take it would fire and changes nothing. Refuses mainnet without `TK_MAINNET_ACK=true`; refuses live execution without `SIGNER_PRIVATE_KEY`. Defensive parsers refuse to act on unparseable tool responses. `max_slippage_bps` wired to `TK_MIN_EDGE_BPS` so a fill never beats the edge it gated on.
- Signing delegated to `sera-mcp`'s local signer (`SERA_SIGNER_MODE=local`) since conversions route across legs.
- README with a maker-vs-taker comparison and a Production checklist.

### Fixed — `templates/market-maker` (v0.2.0 → v0.3.0)
- `.env.example` ↔ code contradictions resolved: the template signs **client-side** (`SERA_SIGNER_MODE=external`, set by `agent.ts`) — `.env.example` previously claimed `local`/"server signs". The live switch is `MM_DRY_RUN` (default `true`); `.env.example` previously only set `POLICY_DRY_RUN`, which the loop ignored (silent dry-run). `POLICY_DRY_RUN=true` now *also* forces dry-run, belt-and-suspenders.
- Removed the hardcoded personal `~/Desktop/...` default MCP path; defaults to `../../sera-mcp/dist/index.js` (override with `SERA_MCP_DIST`).
- `.env.example` defaults to `SERA_NETWORK=sepolia` (was `mainnet`).
- Added a startup `cancel_all_orders` (restart safety — a crashed run no longer leaves stale quotes that the next run stacks on top of).
- Added an inventory-aware sizing **stub** (`fundableSides`) — skips a side the wallet can't fund instead of posting an unfillable quote.

### Fixed — hardcoded MCP path across all entry points
- The `~/Desktop/sera-mcp/dist/index.js` default leaked into `chat-cli`, `web-chat`, `webhook-agent`, `withdraw-cli`, `sera-agent`, `invoice-payer`, and `treasury-rebalancer`. All now default to `../../sera-mcp/dist/index.js` and honor `SERA_MCP_DIST`.

### Changed — docs surface the maker/taker paths
- `market-maker`, `taker`, and `withdraw-cli` were in the workspaces but absent from `README.md`, `templates/README.md`, and `ARCHITECTURE.md`. All three now appear in every index, with a "Maker vs taker" framing.
- New docs tutorial: `docs/tutorials/maker-vs-taker.html` (Tutorial 07), wired into the tutorials index and every tutorial sidebar.
- Root `package.json` workspaces 9 → 10 (`templates/taker`).

### Fixed — bugs caught in verification pass
- **market-maker inventory guard (regression):** `fundableSides` read a non-existent `.available` field on `get_balances` rows → `NaN`→`0` → skipped BOTH bid and ask on every live tick whenever balances loaded (maker silently posted nothing). Now reads `vault_available`/`wallet_balance`, scales RAW units by `decimals`, and fails OPEN on uncertainty.
- **taker inventory guard:** compared RAW balance units against human-unit amounts (no `decimals` scaling) → guard never blocked. Now scales by `decimals`.
- **both mcp-clients:** per-request `setTimeout` was never cleared on success → timers leaked across the poll loop. Now cleared when the request settles.
- **market-maker `toRaw`:** `(amount*price).toString()` could emit scientific notation (e.g. `"1e-7"`) that `BigInt()` can't parse; switched to `toFixed(decimals)` + a finite/non-negative guard.

### Tests
- Added `templates/taker/test/loop.test.ts` (6 tests) and `templates/market-maker/test/loop.test.ts` (3 tests) — mock-`sera-mcp` behavioral coverage for the take/hold/inventory paths and the regression above. Wired `test` scripts; CI already runs `npm test`.

### Verified
- `npm run typecheck` + `npm test` clean across all 10 workspace packages (9 tests pass).

## [0.7.3] — 2026-05-25

### Changed — `templates/market-maker` rewritten as deterministic loop (v0.1.0 → v0.2.0)
- Dropped `@openai/agents` dependency. The maker loop is rule-based — wrapping it in an LLM tool-use harness adds latency and failure modes without value.
- Added `ethers` v6 for client-side EIP-712 Order signing.
- New `lib/` modules:
  - `lib/order-signer.ts` — EIP-712 OrderStruct (`user / expiration / feeBps / recipient / fromToken / toToken / fromAmount / toAmount / initialDepositAmount / uuid`), domain (`name: "Sera", version: "1", chainId, verifyingContract`), `signOrder` + `orderHash` helpers via `ethers.TypedDataEncoder`.
  - `lib/uuid-int.ts` — composite 256-bit `uuid_int` layout (`executor_id[4] | uuid_bits[128] | group_id[112] | leg_id[12]`). `makeOrderId` for standalone orders; `makeVlSibling` for VL batches.
  - `lib/mcp-client.ts` — minimal stdio JSON-RPC client. Spawns `sera-mcp` once, holds the subprocess, exposes `tool(name, args)` over MCP `tools/call`. No SDK wrapper.
  - `lib/loop.ts` — single-tick cancel → mid → drift-gate → sign+place. Spend-direction semantics for fromToken/toToken (bid spends quote / ask spends base). DRY-RUN logs order hash without submitting.
- `agent.ts` — refuses to start without `SIGNER_PRIVATE_KEY`. Refuses non-Sepolia networks unless `MM_MAINNET_ACK=true` is set explicitly. Boots sera-mcp, runs `sera.doctor` for boot sanity (chain_id match, contracts present, tokens loaded), looks up market via `sera.get_markets`, runs loop with SIGINT cancel-on-exit.
- `package.json` — added `dry-run` script (`MM_DRY_RUN=true tsx agent.ts`).
- `tsconfig.json` — include `lib/**/*.ts`.

### Verified
- `npm run typecheck` clean on `templates/market-maker`.
- DRY-RUN smoke-tested on mainnet EURC/USDC (previous session).
- Compatible with `sera-mcp` v0.8.3 testnet endpoint correction (`api-testnet.sera.cx`).

## [0.7.2] — 2026-05-24

### Added — test coverage across x402-service + webhook-agent (0 → 73 tests)

**x402-service (52 tests across 4 files):**
- `test/state.test.ts` (15 tests) — atomic CAS for every state transition (the load-bearing mitigation for Attack II from arXiv:2605.11781), idempotent replay, `listFailedRefundable` for operator queue, `gcExpired` keeps `failed_refundable` + `delivered` entries.
- `test/env.test.ts` (11 tests) — boot gates: defaults, demo-on-public refusal, live-mode required-env enforcement (X402_FACILITATOR_URL / CDP_API_KEY_ID / VAULT_ADDRESS / LIVE_ACK / CONFIRMATION_DEPTH ≥ 3), invalid mode rejection.
- `test/facilitator.test.ts` (10 tests) — CDP `/verify` + `/settle` request shape (URL, headers, body), success/failure path handling, network errors, trailing-slash normalization.
- `test/payment.test.ts` (16 tests) — verify/settle/execute orchestration with mocked facilitator + mocked MCP, demo short-circuit paths, MCP `isError` handling, MCP subprocess crash handling, state transition helpers including atomic two-concurrent-CAS test.

**webhook-agent (21 tests):**
- `test/hmac.test.ts` — HMAC verification across Stripe / GitHub / generic providers with replay protection. Tests valid signatures, missing/malformed headers, stale timestamps, wrong signatures, missing secret, nonce replay rejection. Bonus: `makeNonceStore` LRU GC behavior.
- Refactored `verifyHmac` + `rememberNonce` out of `server.ts` into testable `hmac.ts` module with injected dependencies (`HmacConfig` carries `nonceStore` + optional `now` test seam).

### Added — vitest scaffolding
- x402-service: vitest devDep + test script + vitest.config.ts.
- webhook-agent: vitest devDep + test script + vitest.config.ts.
- Root `npm run test` (`--workspaces --if-present`) now picks up both — workspace-wide test runs go from 0 → 73 tests.

### Notes
- All 73 tests pass in <500ms.
- No production behavior change. One refactor (HMAC extraction) for testability; behavior identical.

## [0.7.1] — 2026-05-24

### Fixed — docs out of sync with shipped reality (sera-agents v0.6.0+)
Public-repo credibility issue caught by audit pass: docs were saying "planned" / "stub" / "not built" for things that landed in v0.6.0. Reconciled across:

- **`README.md`**: Status table x402 row no longer says "Experimental — `verifyPayment` is intentional scaffold". Now says "Wired, not yet production-verified" with the actual v0.6.0 surface (CDP facilitator integration, atomic CAS, Cache-Control, k≥3 gate, operator ack). Roadmap entry rewritten from "replace verifyPayment stub" to "Base Sepolia E2E verification" — that's the actual remaining work.
- **`ARCHITECTURE.md`**: Path D section now documents the modular split (env / state / facilitator / sera-client / payment / server), the CAS-gated state machine diagram, atomic idempotency mitigation per arXiv:2605.11781, manual-refund queue + `/admin/refundables`, persistence shape. No longer says "live verification not yet implemented".
- **`x402-service/README.md`**: complete rewrite. Status banner at top reflects v0.3.0 state (live wired, not yet mainnet-verified). Live-mode run-instructions list all 5 required env vars with explanations. Threat-model coverage matrix. "Remaining gate before mainnet flip" section. "What's not built yet" trimmed to the actually-unbuilt: automated facilitator settlement-reversal, OAuth on /admin/refundables, multi-instance horizontal scale.

### Notes
- No code changes. This is purely a docs reconciliation release — the gap between "what shipped in v0.6.0" and "what the public docs claimed" was its own credibility risk.

## [0.7.0] — 2026-05-24

### Added — two new templates demonstrating the v0.6.0+ sera-mcp surface
- **`templates/market-maker/`** — two-sided spread market-making bot. Cancel-before-place loop, multi-source mid pricing, env-driven knobs (`MM_PAIR`, `MM_NOTIONAL`, `MM_SPREAD_BPS`, `MM_DRIFT_BPS`, `MM_POLL_SECONDS`, `MM_EXPIRATION_SECONDS`). Uses the maker tools (`sera.multi_source_mid`, `sera.cancel_all_orders`, `sera.place_order`). Includes a 10-item "Production checklist before deploying" — wallet isolation, dry-run first deploy, kill-switch, cancel cooldown handling, restart safety, observability.
- **`templates/withdraw-cli/`** — terminal walkthrough of Sera's 4-step dual-sig instant-withdrawal flow. Demonstrates `sera.withdraw_request` → (local sign) → `sera.withdraw_build` → (local sign) → `sera.withdraw_send`. Generates fresh `uuid` per run, echoes the recipient prominently before any signing step, prints the EIP-712 typed-data shape your wallet must sign.

Each template ships: `package.json`, `tsconfig.json`, `.env.example`, `README.md` (with status banner + production checklist), `agent.ts`.

### Updated
- Root workspace `package.json` includes the two new templates.

### Notes
- Both templates intentionally stop short of full execution (the wallet-side signing step needs ethers/viem and is left to the integrator). The README of each documents the production wiring path.
- Templates are labeled "Demo / starter" in their READMEs and require explicit operator action to wire real signing.

## [0.6.0] — 2026-05-24

### x402-service v0.3.0 — live mode wired

**Modular split** (audit recommendation): `server.ts` broken into 5 focused modules + a slim HTTP layer:
- `env.ts` — boot config + safety gates (refuses live without all required envs + `X402_LIVE_ACK=true` + `X402_CONFIRMATION_DEPTH ≥ 3`).
- `state.ts` — payment state machine (`pending → verified → executing → delivered | failed_refundable`) with SQLite persistence + atomic `cas(payment_id, expected, next, extra)` for every transition.
- `facilitator.ts` — Coinbase CDP facilitator client (`/verify` + `/settle`).
- `sera-client.ts` — sera-mcp stdio JSON-RPC client (long-lived subprocess).
- `payment.ts` — verify/settle/execute orchestration tying it all together.
- `server.ts` — HTTP routes + Hono + boot only (~430 lines, was 724).

**Live mode now actually wires the facilitator** (per arXiv:2605.11781 hardening checklist):
- `verifyPayment` calls `POST {X402_FACILITATOR_URL}/verify` with EIP-3009 paymentHeader + paymentRequirements.
- `settlePayment` calls `POST /settle` after the verify CAS succeeds. Two-phase flow.
- Atomic idempotency: every state transition is CAS-gated; replays return cached `delivered_payload`, never re-settle, never re-execute. Mitigates Attack II (replay/idempotency).
- `Cache-Control: no-store, no-cache, private` + `Pragma: no-cache` on every `/x402/*` route. Mitigates Attack III (CDN cache leak).
- `X402_CONFIRMATION_DEPTH ≥ 3` enforced at boot. Mitigates Attack I-A (revert-grant).
- Facilitator calls bound caller identity via `Bearer {api_key_id}:{api_secret}`. Mitigates Attack I-B (settlement preemption).
- Settle response (`tx_hash` + `networkId`) persisted alongside payment state for audit.

**Refund policy: manual queue (default).** Failed-after-settle payments transition to `failed_refundable`; operators query `GET /admin/refundables` (auth: `Bearer ${X402_ADMIN_TOKEN}`). Automated refund via facilitator settlement-reversal is on the roadmap pending CDP-side support.

**Live mode boot gates** — refuses to start without ALL of:
- `X402_FACILITATOR_URL`, `X402_CDP_API_KEY_ID`, `X402_CDP_API_KEY_SECRET`, `X402_VAULT_ADDRESS`
- `X402_LIVE_ACK=true` (operator acknowledges live wiring is NOT YET production-tested against Coinbase mainnet; complete Base Sepolia E2E first)
- `X402_CONFIRMATION_DEPTH ≥ 3`

Demo mode unchanged — boots on `127.0.0.1` by default, short-circuits verify+settle, returns `demo:true` + `tx_hash:null` + `X-Sera-Demo-Mode` header so consumers can't confuse it with real settlement.

### Updated
- `SECURITY-MODEL.md`: x402 attack-surface coverage matrix now reflects v0.6.0 mitigations (all four applicable attacks have status: Mitigated). "Hardening status" section shows 5 of 6 items code-complete; the remaining gate is operator-driven Base Sepolia E2E.

### Notes
- Live mode wiring is in place but NOT yet production-verified against Coinbase mainnet. Per SECURITY-MODEL.md, complete Base Sepolia E2E before flipping `X402_NETWORK=base`.
- Demo mode safe to run locally as before.

## [0.5.2] — 2026-05-24

### Added
- `.env.example` files at:
  - `sera-agents/.env.example` (shared defaults)
  - `templates/web-chat/.env.example`
  - `templates/webhook-agent/.env.example` (HMAC config + safe-default `SERA_ENABLE_EXECUTION_TOOLS=false`)
  - `x402-service/.env.example` (demo vs live mode + Sera execution wiring)

Public-repo polish: every install starts with "what env vars do I set?". These files document the safe-copyable defaults inline.

## [0.5.1] — 2026-05-24

### Fixed
- **CI now uses `npm ci`** (lockfile-reproducible) instead of `npm install` (which mutates the lockfile). Previous CI could pass on a PR that would fail after merge if any sub-dep version float was triggered by `install` rewrites.

### Added
- Root `npm run build` (`--workspaces --if-present`) and `npm run test` (`--workspaces --if-present`) scripts.
- Root `npm run ci` aggregator: `npm ci && typecheck && build && test && audit` — one command for the full quality gate locally.
- CI workflow now runs `npm test` step (no-op until packages add test scripts in v0.6.0).

## [0.5.0] — 2026-05-24

### Added
- `ARCHITECTURE.md` — repo layout, workspace structure, per-path framing, x402 state machine, dependency contract with `sera-mcp`.
- `SECURITY-MODEL.md` — per-package threat model framing, x402 attack surface (mapped against arXiv:2605.11781 "Five Attacks on x402"), template hardening expectations, hardening checklist for x402 live mode.
- `CHANGELOG.md` (this file).
- Root `package.json` with `npm` workspaces declaring all 7 packages (`sera-agent`, `x402-service`, `templates/*`, `examples/*`).
- Root `tsconfig.base.json` — shared TS config extended by each package's `tsconfig.json`.
- Per-package `tsconfig.json` + `typecheck` script + `audit` script in all 7 packages.
- Root `npm run typecheck`, `npm run audit`, `npm run check` for workspace-wide quality gates.
- README **Status** section with Stable / Demo / Experimental / Planned labels.
- README **Development** section with workspace commands.

### Changed
- CI workflow rewritten: now runs `npm run typecheck` (was missing entirely — only `npm audit` ran), then audit + gitleaks + CodeQL. Single workspace install instead of per-package matrix.
- Root `overrides` block forces `qs ^6.15.2` and `ws ^8.21.0` across the dependency tree.
- README positioning paragraph at top — explicit "Templates, examples, docs, and x402 integrations built on top of [`sera-mcp`](https://github.com/Josh-sera/sera-mcp)".
- README references `sera-mcp` via GitHub URL instead of local Desktop path.

### Fixed
- Audit: 0 vulnerabilities across all workspaces (was 1 moderate `qs` per package).
- Path A install snippet now `git clone`s `sera-mcp` instead of referencing local `~/Desktop` path.

### Notes
- Folder reorg (move x402-service into `services/`, site into `site/`) deferred — would break GitHub Pages deploy without coordinated `CNAME` + Pages config changes.
- `x402-service` live mode remains intentional scaffold. See `SECURITY-MODEL.md` for the hardening checklist required before flipping to production.

## [0.4.0] — 2026-05-13/17

- Full `/docs` section with tutorials (AI agent, cross-border payment widget, FX trading dashboard, prediction market, treasury rebalancer, x402 paid API).
- Architecture, concepts, recipes pages.
- API reference page.
- Branding pass: logo, favicons, OG image, sitemap.
- DNS to Cloudflare; live at agents.sera.cx.

## [0.3.0]

- 12-card "Build with Sera" carousel on landing page.
- 6 tutorial templates.
- Integration guides for OpenClaw, Hermes, NanoClaw, standard MCP hosts.

## [0.2.0]

- First public-facing release. Landing page, MCP integration guides, three templates, x402-service demo.

## [0.1.0]

- Initial commit. Templates + examples.
