# Sera REST API Reference (docs.testnet.sera.cx)

> Source: https://docs.testnet.sera.cx/api-reference/ (fetched 2026-07-08). This is the
> **current, actively-documented integration surface** for Sera — it sits on top of the v2
> contracts (`Sera.sol` / `Vault.sol` / `SeraSOR.sol` / `SeraBatcher.sol`, see
> `references/orderbook-v2.md`) and is what both the official `sera-mcp` server and SeraPay
> (`references/sera-pay.md`) build on. **For new integrations, prefer this REST API over raw
> contract calls or the v1 GraphQL subgraph** — it handles matching, routing, and signature
> plumbing for you. This sample repo's own `tutorial/`, `frontend/`, and local `mcp-server/`
> still target the older v1 Router/GraphQL flow (`references/smart-contracts.md`,
> `references/graphql-api.md`) and haven't been migrated — don't assume their code reflects
> this API.

**Base URL**: `https://api.testnet.sera.cx/api/v1` (testnet) / `https://api.sera.cx/api/v1` (mainnet)
**Format**: JSON request/response bodies throughout.

## Table of Contents
1. [Authentication](#auth)
2. [Rate Limits & Errors](#rate-limits)
3. [System Endpoints](#system)
4. [Order Endpoints](#orders)
5. [Swap Endpoints](#swaps)
6. [Account / Funds Endpoints](#account)
7. [Virtual Liquidity Batches](#vl)
8. [Order Lifecycle (End-to-End)](#lifecycle)
9. [Market Maker Guide](#market-maker)
10. [Deployed Addresses](#addresses)

---

## Authentication {#auth}

Two mechanisms, used for different things:

| Mechanism | Used for | Header / field |
|---|---|---|
| **API Key** | Reads, transaction builders | `Authorization: Bearer {api_key}:{api_secret}` |
| **EIP-712 signature** | Trading, cancellation, withdrawal, key management | signature field in the request body |

### API key lifecycle

```
POST   /api-keys              # create — body signed as EIP-712 "ManageApiKey" {owner, action:"create", timestamp}
GET/POST /api-keys            # list
DELETE /api-keys              # revoke one
POST   /api-keys/revoke-all   # revoke all
POST   /api-keys/self-revoke  # revoke the key used for this request (Bearer auth only)
POST   /api-keys/verify       # no auth — verify an api_key:api_secret pair
```

`api_secret` is returned **once**, at creation. Max 10 active API keys per wallet.

### EIP-712 domain

Don't hardcode chain id / contract addresses — fetch them:

```
GET /config → { chain_id, sera_address, vault_address, sor_address, domain_separator, eip712_domain: { name, version, chainId, verifyingContract }, limits: { vl_batch: { min, max } } }
```

Domain is `name: "Sera", version: "1"`. The `Order` struct signed for limit orders matches
`SeraLib.Order` exactly (see `references/orderbook-v2.md`): `user, expiration, feeBps,
recipient, fromToken, toToken, fromAmount, toAmount, initialDepositAmount, uuid`. Swaps sign an
`Intent` struct instead (`taker, inputToken, outputToken, maxInputAmount, minOutputAmount,
recipient, initialDepositAmount, uuid, deadline`) — **sign `route_params` exactly as returned**
by `POST /swap/quote`, don't reconstruct it client-side.

### order_id / uuid_int binding

Every order has both an `order_id` (UUID4, human-facing) and a `uuid_int` (uint256, what's
actually signed/on-chain). The API rejects requests where `uuid_int` doesn't match the composite
encoding of `order_id`. Bit layout:

```
[255:252] Executor | [251:124] Order ID | [123:12] Group ID | [11:0] Leg ID
```

For a standalone order: `group_id = order_id >> 16`, `leg_id = 0`. Virtual Liquidity batch legs
share one `group_id` and increment `leg_id` per sibling.

### Practical notes

- Timestamps must be within 5 minutes of server time — call `GET /system/time` before signing.
- `expiration`/`deadline` must be in the future and ≤ 365 days out (API enforces `now <
  expiration ≤ now + 365 days - 300s`).
- **Address casing**: read endpoints treat `owner_address` as case-sensitive — pass **lowercase**.
  Signed payloads accept EIP-55 **checksummed** addresses. Don't mix these up.
- Deposits can use ERC-2612 `Permit` for supported tokens (USDC, EURC, EURT).
- Verified wallets: MetaMask, Rabby, Frame, Coinbase Wallet, Trust, Rainbow; Safe multisig via
  EIP-1271. Verified client libraries: Python `eth_account >= 0.10`, TypeScript `ethers` v6.
- Public, no-auth endpoints: `/health`, `/system/time`, `/tokens`, `/markets`, `/config`,
  `/swap/quote`, `/swap/quote/batch`, `/verify-signature`, `/orders/preview`.

## Rate Limits & Errors {#rate-limits}

| Group | Endpoints | Limit |
|---|---|---|
| read | `GET /orders`, `/balances`, `/fills` | 10 req/s |
| trade | `POST /orders`, `/swap` | 5 req/s |
| cancel | `POST /orders/cancel`, `DELETE /orders/cancel-all` | 2 req/s |
| transfer | deposits, approvals, withdrawals | 2 req/s |

Error bodies carry a `detail` (human-readable) and, for typed trading errors, an `error_code` —
**branch on `error_code`, not on the `detail` string**. 5xx failures map to `503` with a generic
message and a `Retry-After: 1` header.

Common `error_code` values across orders/swaps:

| Code | Meaning |
|---|---|
| `INSUFFICIENT_EQUITY` | Vault balance too low — reduce size or deposit more |
| `STP_BLOCKED` | Self-trade prevention — you have a resting order that would cross this one; cancel it first |
| `QUOTE_STALE` | Quote snapshot expired — request a fresh one |
| `INTENT_DEADLINE_EXPIRED` | Signed deadline already passed |
| `SLIPPAGE_EXCEEDED` | No crossing liquidity at the signed price |
| `NO_LIQUIDITY` | No executable depth for this route |
| `AMOUNT_BELOW_MIN` | Below the pair's minimum size |
| `INVALID_PRECISION` / `INVALID_DECIMAL_FORMAT` | Amount/price isn't canonical for the pair's `tick_precision`/`quantity_precision` |
| `ALLOWANCE_INSUFFICIENT` | Token allowance/permit invalid |
| `PAIR_INACTIVE` | Trading pair currently disabled |
| `TRANSIENT_SETTLEMENT_FAILURE` | Catch-all infra error — safe to retry |
| `429` (HTTP status, not a body code) | Rate limit or cancel cooldown (5 min per order) hit |

## System Endpoints {#system}

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{status: "healthy"\|"degraded", version, timestamp, executor_id, relayer_executor_id, signature_ready}` |
| `GET /system/time` | none | `{timestamp}` — use this, not local clock, before signing expirations |
| `GET /tokens` | none | `{tokens: [{currency, symbol, address, decimals, min_trade_amount_raw, min_trade_amount}]}` |
| `GET /markets` | none | `{markets: [{symbol, base_symbol, quote_symbol, base_address, quote_address, tick_precision, quantity_precision, amount_step, price_step, rounding_mode, base_decimals, quote_decimals, min_ask_amount_raw, min_ask_amount, min_bid_quote_amount_raw, min_bid_quote_amount}]}` |
| `GET /fx/rate?base=USD&quote=SGD` | none | `{pair, rate, as_of, rate_24h_ago, as_of_24h_ago, change_pct}` |
| `GET /permit/metadata?token=&owner=&spender=` | API key | Checks whether ERC-2612 permit is usable for a token/owner/spender, returns the domain to sign |
| `GET /config` | none | Live chain id + contract addresses + EIP-712 domain + `limits.vl_batch` — **always read from here, never hardcode** |
| `POST /verify-signature` | none | Verify an order signature offline before submitting; returns `{valid, recovered_address, expected_address, error}` |

`markets[].rounding_mode` is `"reject_extra_precision"` — the API rejects amounts/prices with
more decimal places than `tick_precision`/`quantity_precision` allow, and rejects non-canonical
numeric strings, **before** even checking the signature.

## Order Endpoints {#orders}

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /orders/preview` | none | Pass pair-natural fields (`owner_address, side, amount, price, order_type:"limit", from_address, to_address, order_id, uuid_int, expiration`) → returns the exact EIP-712 payload to sign |
| `POST /orders` | EIP-712 `Order` sig | Same fields + `signature` → `{order_id}`, HTTP 201 |
| `POST /orders/cancel` | EIP-712 `CancelOrder` sig | `{owner_address, order_id, uuid_int, signature}` → `{status:"ok"}`. 5-min cooldown after placement (429 if violated) |
| `DELETE /orders/cancel-all` | API key | `?owner_address=` → `{cancelled:[...], failed:[...], skipped_cooldown:[...], total}` |
| `GET /orders/{order_id}` | API key | Full state: `status, filled_base_amount, filled_quote_amount, remaining_amount, notional, settlement_summary, settlement_economics, error_code, uuid_int, vl_batch_id, ...` |
| `GET /orders` | API key | List with filters: `owner_address` (required), `limit`(≤500)/`offset`, `status`, `type` (`swap`\|`limit`), `symbol`/`side`/`from_token`/`to_token`, price/amount/notional range filters, `created_after`/`created_before`, `sort_by`, `order` |
| `POST /orders/vl/batch` | EIP-712 sig per order | See [Virtual Liquidity](#vl) |
| `POST /orders/vl/cancel` | EIP-712 `CancelVLBatch` sig | `{owner_address, vl_batch_id, signature}` — cancels the whole batch and unfreezes remaining budget |
| `GET /fills/{order_id}` | API key | Per-order fills: `maker_order_id, taker_order_id, quantity, price, settlement_status (pending\|confirming\|settled\|failed\|reverted), tx_hash, failure_reason, settlement_economics` |
| `GET /fills` | API key | Cross-order fill list, filterable by `owner_address`, `order_status`, `settlement_status` |

`Order.side` is `"bid"` (buy base with quote — spends `fromToken = quote`) or `"ask"` (sell base
for quote — spends `fromToken = base`).

## Swap Endpoints {#swaps}

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /swap/quote` | none | `{from_token, to_token, from_amount, owner_address, recipient, expiration, gas_mode?}` → `{uuid, route_params, quote_breakdown, permit?, expires_at}` |
| `POST /swap/quote/batch` | none | `{quotes: [...]}`, up to 50 → `{items: [{quote}\|{error}]}` per input order |
| `POST /swap` | EIP-712 `Intent` sig | `{uuid, signature, permit_signature?, permit_deadline?}` → `{success, trade_id, status, fee_breakdown}` |

`gas_mode` is `"receive_less"` (cost deducted from output) or `"pay_more"` (cost added to input)
— gas is **always** factored into the quote, so a swap never requires the taker to hold ETH.
Swaps are fill-or-kill and resistant to MEV/sandwiching because the signed `Intent` binds exact
`maxInputAmount`/`minOutputAmount`, a one-time `uuid`, and a `deadline` — there's no public
mempool order to front-run. Multi-hop routes (e.g. GBP→USD→SGD) execute atomically as one signed
Intent via `SeraSOR.executeIntent()` under the hood.

HTTP status codes on `/swap`: `400` invalid request/signature, `409` quote stale (retry
available), `410` quote consumed/expired, `429` rate limited, `503` unavailable.

## Account / Funds Endpoints {#account}

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /balances?owner_address=&include_zero=` | API key | Per-token `{wallet_balance, vault_available, vault_frozen, vault_total, total}` — all raw uint256 decimal strings |
| `POST /deposit` | API key | Build an unsigned deposit tx: `{token, owner, amount, permit_signature?, permit_deadline?, permit_amount?}` → `{tx: {...}}` |
| `POST /approve` | API key | Build an unsigned approve tx: `{token, owner, spender, amount}` — `spender` must be the **live** Vault or SOR address from `GET /config` |
| `POST /tx/send` | API key | Broadcast a signed approve/deposit tx: `{raw_tx}` → `{tx_hash}` |
| `POST /withdraw` | optional | Step 1 of instant withdrawal — request executor co-signature: `{intent: {user, tokens[1-20], amounts[], recipient, deadline, uuid}, user_signature}` → `{success, executor_address, executor_signature}` |
| `POST /withdraw/build` | optional | Step 2 — build the unsigned `executeInstantWithdrawDualSig` tx from both signatures |
| `POST /withdraw/send` | optional | Step 3 — broadcast: `{raw_tx}` → `{tx_hash}` |
| `POST /transfer` | API key | Build a plain ERC-20 transfer tx: `{token, to, amount, from_address}` |
| `POST /transfer/send` | API key | Broadcast: `{raw_tx}` → `{tx_hash}` |

Balances are always raw uint256 strings — divide by `10^decimals` for a human-readable amount.
If the API is unavailable, the on-chain fallback is calling `emergencyWithdraw()` directly on the
Sera contract (~24h delay, no counterparty needed — see `references/orderbook-v2.md`).

## Virtual Liquidity Batches {#vl}

A **VL batch** groups 2–50 limit orders across **distinct markets** under one shared collateral
budget, so a market maker quoting N pairs only needs to fund the single largest order, not the
sum of all of them — since siblings target different markets, at most one can match at a time.

Rules:
- All siblings must share the same `owner_address` and resolve to the same `fromToken` (bids
  spend the quote token, asks spend the base token — mixed bid/ask batches are fine as long as
  the spent token matches).
- Exact duplicate pairs or inverse pairs (e.g. `XSGD/USDC` and `USDC/XSGD`) count as the same
  market and are rejected.
- Batch size 2–50 — read the live limit from `GET /config` → `limits.vl_batch`, don't hardcode.
- All `uuid_int` values in a batch share one VL group id; `leg_id` increments sequentially
  (0, 1, 2, …) — see the [uuid_int bit layout](#auth).

```
POST /orders/vl/batch
{ orders: [ { owner_address, side, amount, price, from_address, to_address, order_id, uuid_int, signature, expiration }, ... ] }  // 2-50 entries

→ { order_ids: [...], amendments: [{order_id, original_amount, actual_amount, reason}],
    cancelled: [...], fills: [{order_id, trades, remaining}],
    vl_group: {primary_id, max_budget, budget_consumed, spent_token} }
```

```
POST /orders/vl/cancel
{ owner_address, vl_batch_id, signature }   // cancels the whole batch, unfreezes remaining budget
```

**Amendment example** — starting budget 1,500 USDC across 3 siblings:
1. Sibling 1 fills 500 EURC @ 1.08 → consumes 540 USDC → 960 USDC remaining
2. Sibling 2 (500 GBPC @ 1.27) is amended down to `floor(960/1.27)` = 755 units
3. Sibling 3 (2000 XSGD @ 0.75) is amended down to `floor(960/0.75)` = 1,280 units

Cancelling one sibling individually (via `POST /orders/cancel`) leaves the shared budget frozen
for the rest of the batch — cancel the **whole batch** via `/orders/vl/cancel` to release it.

## Order Lifecycle (End-to-End) {#lifecycle}

**States**: `pending` (resting/partially filled, cancellable) → `matched` (crossed, settling,
not cancellable) → `settled` (chain-confirmed) — or `cancelled` / `failed` (settlement reverted).

**Seven steps**:
1. `GET /system/time` — sync before signing any expiration
2. `GET /tokens` — discover token addresses/decimals
3. `POST /orders/preview` → sign the returned EIP-712 payload → `POST /orders` → get `order_id`
4. `GET /orders/{order_id}` — poll `status`/`filled_amount`
5. `GET /balances?owner_address=` — settled proceeds land in `vault_available`
6. (optional) `POST /orders/cancel` — respecting the 5-minute cooldown
7. (optional) withdraw via the 3-step `/withdraw` → `/withdraw/build` → `/withdraw/send` flow, or
   `emergencyWithdraw()` on-chain if the API is down

## Market Maker Guide {#market-maker}

Progressive workflow from the docs, in order:

1. **Single order**: preview → sign → submit → confirm.
2. **Cancellation**: sign `{owner, orderId}` as `CancelOrder`, submit to `/orders/cancel`.
3. **Automated two-sided quoting** — poll a price feed and requote both sides:
   ```
   while true:
     mid ← fetch_from_pricing_feed()
     if abs(mid - last_quoted_mid) > drift_bps:
       cancel(previous_bid, previous_ask)          # cancel BEFORE placing — avoids STP_BLOCKED
       bid_price ← mid * (1 - spread_bps/10000)
       ask_price ← mid * (1 + spread_bps/10000)
       place(bid); place(ask)
     sleep(poll_seconds)
   ```
   `spread_bps` = half-spread per side, `drift_bps` = requote threshold (avoid churn),
   `poll_seconds` = loop cadence (typically 1–5s).
4. **Multi-pair batching** via Virtual Liquidity — quote N pairs from one collateral pool
   (`POST /orders/vl/batch`), sizing legs so the engine only ever freezes the largest one.

Best practices called out explicitly:
- Persist both `order_id` and `uuid_int` — both are required for cancellation.
- Reuse the same client-generated `order_id` on retry after a network failure — the server
  dedupes, making retries idempotent.
- Poll `settlement_summary` before clearing local state — an HTTP 200 on cancel doesn't
  guarantee on-chain finality.
- Never hardcode `MAX_BATCH_SIZE`/VL limits — read `GET /config` at startup.

## Deployed Addresses {#addresses}

Always prefer `GET /config` over hardcoding — this table is a convenience snapshot as of the
2026-07-08 docs fetch:

| Contract | Mainnet | Sepolia (testnet) |
|---|---|---|
| Sera | `0xB5C50C5D5f038404F85970b7f5B7259C4AC0E198` | `0x83475A1bD98a8DC2DCd507A747e4DC85da241D6e` |
| Vault | `0xC7d4Fd2638e6630C8C61329878676b88A8A24D43` | `0x3c7945840bAE0d7e7f3824Ebccef1962629250F0` |
| SeraSOR | `0xa7A0cf7cd6f043fCA23f29d8ae5aae6b46e11c18` | `0x83c1368110B640A729f3810De5FBe94b99aa5668` |
| SeraBatcher | `0x1f4b366f4145A92978df4bEeb6BdE71bC652F034` | `0x29F99C5dc36D555933700BE3dffEa6e721a27f0a` |

Audit reports (findings, severity, remediations) are published at
https://github.com/sera-cx/orderbook-contract-v2/tree/audit/audits — see `references/orderbook-v2.md`
for the CertiK audit summary.

Testnet supports **43 fiat currencies** worth of stablecoin pairs (e.g. `EURC/USDC`,
`GBPA/USDC`, `XSGD/USDC`, `GYEN/USDC`, plus corridors across the Americas, Europe/Middle East,
and Asia-Pacific) — query `GET /tokens` and `GET /markets` for the live, current list rather than
trusting a hardcoded one.
