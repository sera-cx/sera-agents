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
  1. find_deals              (scan all markets, diff Sera vs external mid; filter to TK_PAIR)
  2. edge gate               (only take if the directional edge ≥ TK_MIN_EDGE_BPS)
  3. get_balances            (inventory guard — skip if you can't fund the spend leg)
  4. convert_and_send        (take it — or just log it if TK_DRY_RUN)
  5. sleep TK_POLL_SECONDS
```

`find_deals` already diffs Sera's rate against external mid per market, so the loop reads `sera_rate` + `external_mid` straight off each deal and computes the **directional** edge for your side (buy wants Sera cheaper than mid; sell wants it richer). Uses sera-mcp tools: `sera.find_deals`, `sera.get_balances`, `sera.convert_and_send`, `sera.doctor`. Signatures follow the [API reference](https://agents.sera.cx/docs/api/) (`find_deals { min_bps, notional_usd }` → `{ deals:[{ pair, edge_bps, sera_rate, external_mid }] }`; `get_quote`/`convert_and_send` use `from`/`to`/`amount`).

## Run

```bash
cp .env.example .env
# Edit .env: set SERA_OWNER_ADDRESS, SERA_API_KEY/SECRET. Leave TK_DRY_RUN=true.
npm install
npm start
```

You'll see each tick print the mid, the best rate, the computed edge, and — when the edge clears `TK_MIN_EDGE_BPS` — the exact `convert_and_send` it *would* fire. Watch it for a while. Only set `TK_DRY_RUN=false` (and add `SIGNER_PRIVATE_KEY`) once you trust the edges.

## Tool-shape caveat

Tool field names can drift across sera-mcp versions. `lib/loop.ts` reads `find_deals` results loosely (`sera_rate`/`rate`, `external_mid`/`mid`, `deals[…]`) and **refuses to act on anything it can't parse** — it holds instead of guessing. Before going live, run `sera.doctor` and eyeball a raw `sera.find_deals` response against your installed version, then adjust `normalizeDeal()` if the shape differs. The execution call (`convert_and_send`) isn't fully specified in the public reference beyond `from`/`to`/`amount` — verify its exact params on your install and dry-run first.

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
