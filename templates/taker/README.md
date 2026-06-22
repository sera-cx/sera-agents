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
  1. get_balances            (inventory guard — skip if you can't fund the take)
  2. multi_source_mid        (reference mid for the pair)
  3. find_deals              (best executable rate; falls back to get_quote)
  4. edge gate               (only take if rate beats mid by ≥ TK_MIN_EDGE_BPS)
  5. convert_and_send        (take it — or just log it if TK_DRY_RUN)
  6. sleep TK_POLL_SECONDS
```

Uses sera-mcp tools: `sera.get_balances`, `sera.multi_source_mid`, `sera.find_deals` (or `sera.get_quote`), `sera.convert_and_send`, `sera.doctor`.

## Run

```bash
cp .env.example .env
# Edit .env: set SERA_OWNER_ADDRESS, SERA_API_KEY/SECRET. Leave TK_DRY_RUN=true.
npm install
npm start
```

You'll see each tick print the mid, the best rate, the computed edge, and — when the edge clears `TK_MIN_EDGE_BPS` — the exact `convert_and_send` it *would* fire. Watch it for a while. Only set `TK_DRY_RUN=false` (and add `SIGNER_PRIVATE_KEY`) once you trust the edges.

## Tool-shape caveat

`find_deals` / `get_quote` field names (`edge_bps`, `rate`, `deals[…]`) vary by sera-mcp version. `lib/loop.ts` accepts several shapes and **refuses to act on anything it can't parse** (it holds instead). Before going live, run `sera.doctor` and eyeball a raw `sera.find_deals` response against your installed version, then adjust the parsers in `bestDeal()` / `parseRate()` if needed.

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
- [ ] **Slippage = edge.** `max_slippage_bps` is wired to `TK_MIN_EDGE_BPS` so you never fill worse than you gated on. Keep it tight.
- [ ] **Rate limits.** Sera enforces per-wallet trade limits (5/s). Keep `TK_POLL_SECONDS` sane.
- [ ] **Observability.** Log every fill (`sera.get_fills`) to a sink you watch.
- [ ] **Mainnet ack.** Live mainnet requires `TK_MAINNET_ACK=true` — the bot refuses otherwise.

## License

MIT. Use at your own risk. This is a starter, not a turnkey product.
