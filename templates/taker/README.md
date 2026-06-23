# taker

Template: a **taker** bot on Sera — the mirror image of [`market-maker`](../market-maker). Where the maker posts resting quotes and waits to be filled, the taker **crosses the spread**: it watches a corridor and fires a conversion the moment the executable rate beats a reference mid by enough basis points.

**Status:** **Demo / starter.** Educational scaffold, not a production taker. `TK_DRY_RUN=true` by default — it prints the take it *would* make and changes nothing. Read the [Production checklist](#production-checklist-before-going-live) before flipping it off.

## Maker vs taker — which do I want?

| | [`market-maker`](../market-maker) | `taker` (this one) |
|---|---|---|
| Role | **Provides** liquidity | **Consumes** liquidity |
| Action | `place_order` (resting bid + ask) | `convert_and_send` (immediate fill) |
| Earns | The spread (if filled) | The edge vs mid (right now) |
| Risk | Inventory / adverse selection | Slippage / missing the move |
| Signs | Order structs, client-side (ethers) | Delegated to sera-mcp's local signer |

Run both against the same wallet if you want to make on one pair and take on another.

## What it does

```
loop every TK_POLL_SECONDS:
  1. find_deals { pairs:[{base,quote}] }   (probe TK_PAIR vs external benchmark)
  2. edge gate     (read the good_buy / good_sell bucket for your side; take if deviation_bps ≥ TK_MIN_EDGE_BPS)
  3. get_balances  (inventory guard — skip if the vault can't fund the spend leg)
  4. convert_and_send { from, to, amount, owner_address, recipient, gas_mode }
  5. sleep TK_POLL_SECONDS
```

`find_deals` sorts each probed market into directional buckets — `good_buy` (Sera cheaper than benchmark, favorable to buy base) and `good_sell` (Sera richer, favorable to sell) — each item carrying `rate` + `deviation_bps`. The loop reads the bucket for your side, so the edge is already directional. Signatures are reconciled against the **sera-mcp source** (`src/tools/{deals,maker_orders,treasury}.ts`):

| Tool | Input | Output (fields the loop reads) |
|---|---|---|
| `find_deals` | `{ pairs:[{base,quote}], notional_per_quote, min_deviation_bps, use_multi_source }` | `{ good_buy:[…], good_sell:[…], fair:[…] }`, item `{ pair, rate, deviation_bps }` |
| `convert_and_send` | `{ from, to, amount, owner_address, recipient, gas_mode }` (all required) | `{ trade_id, tx_hash, status }` |
| `get_balances` | `{ owner_address }` | `{ balances:[{ symbol, vault_available, wallet_balance, decimals }] }` |

## Run

```bash
cp .env.example .env
# Edit .env: set SERA_OWNER_ADDRESS, SERA_API_KEY/SECRET. Leave TK_DRY_RUN=true.
npm install
npm start
```

You'll see each tick print the mid, the best rate, the computed edge, and — when the edge clears `TK_MIN_EDGE_BPS` — the exact `convert_and_send` it *would* fire. Watch it for a while. Only set `TK_DRY_RUN=false` (and add `SIGNER_PRIVATE_KEY`) once you trust the edges.

## Tool-shape caveat

Signatures here are reconciled against the sera-mcp source (see table above), but field names can still drift across versions. `lib/loop.ts` reads responses loosely (`vault_available`/`wallet_balance`, `pair` as string or `{base,quote}`) and **refuses to act on anything it can't parse** — it holds instead of guessing. Before going live, run `sera.doctor` and eyeball a raw `sera.find_deals` response against your installed version, then adjust `normalizeDeal()` / `canFund()` if the shape differs.

## How it differs from a real production taker

This template intentionally omits:
- Smart order routing across multiple fills / partial fills.
- TWAP / iceberg execution for large notionals (it takes the whole `TK_NOTIONAL` at once).
- Latency-aware quote staleness checks.
- Re-quote-on-reject retry with backoff.
- Per-pair inventory targets (it doesn't decide *what* to hold, only *when* to take).
- Persistence of fill history across restarts.

## Production checklist before going live

- [ ] **Wallet isolation.** `SIGNER_PRIVATE_KEY` is a dedicated, hard-capped wallet — not a hot wallet of value.
- [ ] **`POLICY_PRESET=starter` (or stricter).** `POLICY_MAX_NOTIONAL_USD` caps a single take; `POLICY_DAILY_VOLUME_CAP_USD` is your kill switch.
- [ ] **`TK_DRY_RUN=true` first.** Watch the logs until the edges and takes look right.
- [ ] **Verify tool shapes.** Confirm `find_deals`/`get_quote` parse on your sera-mcp version (see caveat above).
- [ ] **Slippage.** `convert_and_send` re-quotes at execution; the loop's `TK_MIN_EDGE_BPS` gate is your only edge protection. Keep it well above round-trip cost (`sera.round_trip_cost`) and confirm the delivered rate via `sera.settlement_status` after each take.
- [ ] **Rate limits.** Sera enforces per-wallet trade limits (5/s). Keep `TK_POLL_SECONDS` sane.
- [ ] **Observability.** Log every fill (`sera.get_fills`) to a sink you watch.
- [ ] **Mainnet ack.** Live mainnet requires `TK_MAINNET_ACK=true` — the bot refuses otherwise.

## License

MIT. Use at your own risk. This is a starter, not a turnkey product.
