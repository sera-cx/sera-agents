# market-maker

Template: simple two-sided spread market-making bot on Sera. Cancel-before-place loop, multi-source mid pricing, tight policy caps. The **maker** half of the pair — for the mirror image that *consumes* liquidity, see [`../taker`](../taker).

**Status:** **Demo / starter.** Educational scaffold, not a production maker. `MM_DRY_RUN=true` by default — it logs the orders it *would* post and submits nothing. Read the [Production checklist](#production-checklist-before-deploying) before deploying.

## What it does

```
loop every MM_POLL_SECONDS:
  1. cancel_all_orders            (kill stale quotes — 5-min cooldown applies per order)
  2. multi_source_mid             (median of 3 external FX sources)
  3. only requote if mid moved by ≥ MM_DRIFT_BPS since last loop
  4. place_order  (bid at mid × (1 − MM_SPREAD_BPS/10000))
     place_order  (ask at mid × (1 + MM_SPREAD_BPS/10000))
  5. sleep MM_POLL_SECONDS
```

Uses sera-mcp v0.7.0+ maker tools: `sera.multi_source_mid`, `sera.cancel_all_orders`, `sera.place_order`, `sera.get_balances`.

## Run

```bash
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, SIGNER_PRIVATE_KEY (DEDICATED wallet), SERA_API_KEY/SECRET.
# Leave MM_DRY_RUN=true for the first runs.
npm install
npm start
```

The agent prints each loop tick to stdout. `MM_DRY_RUN=true` (the default) logs the bid/ask it would post and submits nothing — flip it to `false` only once the loop looks right. When live, the bot runs a `cancel_all_orders` at **startup** (clears stale quotes from a crashed prior run) and attempts a final `cancel_all_orders` on Ctrl-C. If either is interrupted, cancel from another session or let the per-order `MM_EXPIRATION_SECONDS` expire them.

> **Signing:** this template signs Order structs **client-side** with ethers (it sets `SERA_SIGNER_MODE=external` for you). Your `SIGNER_PRIVATE_KEY` never leaves the process.

## How it differs from a real production maker

This template intentionally omits:
- Inventory rebalancing. There's a **stub** (`fundableSides` in `lib/loop.ts`) that skips a side the wallet can't fund — a real maker would *skew* price and size as inventory drifts and pull one side past a hard band, not just skip.
- Adverse-selection protection (no order-flow toxicity detection).
- Cross-venue arb hedging.
- Persistence of position state across restarts.
- Health-check / dead-man-switch loops.
- Variable spread by depth / volatility.
- Cancel cooldown handling (5-min per-order; bursts of fresh quotes can trigger 429).
- Position-aware order sizing.

## Production checklist before deploying

If you fork this template into something real, complete ALL of these:

- [ ] Wallet isolation. `SIGNER_PRIVATE_KEY` is a wallet you've intentionally funded for THIS bot, not a hot wallet of value. Hard cap balance to the maximum you're comfortable losing.
- [ ] Tight `POLICY_PRESET=starter` (or stricter). `POLICY_MAX_NOTIONAL_USD` = the most you'll let a single quote risk. `POLICY_DAILY_VOLUME_CAP_USD` = your kill-switch.
- [ ] `MM_DRY_RUN=true` on first ever deploy (the default). Watch logs for a few hours. Only flip to `false` after you've verified the loop behaves. (`POLICY_DRY_RUN=true` also forces dry-run, as a second switch.)
- [ ] Inventory monitoring. Cron job that reads `sera.get_balances` every minute and pages you if inventory drifts beyond a band you set.
- [ ] Kill-switch endpoint. A separate process / button that can run `sera.cancel_all_orders` if the bot misbehaves.
- [ ] Spread-vs-cost reality check. Run `sera.maker_quote_ladder` for your pair before launch. Confirm `MM_SPREAD_BPS` is larger than the round-trip cost on the pair (`sera.round_trip_cost`).
- [ ] Cancel cooldown respected. If `MM_POLL_SECONDS` × loops within 5 minutes > N for one order, cancel will 429. The current template trusts `cancel_all_orders` to be called sparingly; don't accidentally hammer it.
- [ ] Restart safety. The template has no on-disk position state. If you crash mid-loop with orders out, restarting will issue MORE orders. Add startup `cancel_all_orders` AND a stale-order audit if you're going to run unattended.
- [ ] Observability. Log every fill via `sera.get_fills` to a file or sink you watch.
- [ ] Idempotency / rate limits. Sera enforces per-wallet trade/cancel limits (5/s / 2/s). Loop budget should fit.

## License

MIT. Use at your own risk. This is a starter, not a turnkey product.
