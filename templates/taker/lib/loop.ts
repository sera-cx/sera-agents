/**
 * Taker loop — watch a corridor, cross the spread when the price is right.
 *
 * Where the maker POSTS resting orders and waits to be filled, the taker
 * CONSUMES liquidity: it polls for an executable rate and fires a conversion
 * the moment the rate beats a reference mid by enough basis points to be worth
 * taking. Same deterministic-loop shape as templates/market-maker — no LLM in
 * the hot path.
 *
 * One tick:
 *   1. (inventory guard) read get_balances — skip if the source asset can't
 *      fund the configured notional.
 *   2. read multi_source_mid for the pair (the reference we measure edge against).
 *   3. discover the best executable rate via find_deals (falls back to get_quote).
 *   4. edge gate: only take if the executable rate beats mid by >= TK_MIN_EDGE_BPS.
 *   5. take: convert_and_send (or log the intended call if DRY_RUN).
 *   6. sleep until next tick.
 *
 * Tool field names (edge_bps, rate, deals[…]) vary by sera-mcp version — the
 * parsers below accept several shapes and REFUSE to act on anything they can't
 * read. Run `sera.doctor` and inspect a raw `sera.find_deals` response against
 * your installed version before flipping TK_DRY_RUN=false.
 */
import type { SeraMcpClient } from "./mcp-client.js";

export type TakeSide = "buy" | "sell";

export interface TakerConfig {
  pair: string;            // "EURC/USDC" — base/quote
  side: TakeSide;          // "buy" = acquire base, "sell" = offload base
  notional: number;        // base units to take per fill
  minEdgeBps: number;      // only take if executable rate beats mid by >= this
  pollSeconds: number;
  dryRun: boolean;
  ownerAddress: string;
  recipient: string;       // where converted funds land (defaults to owner)
}

export interface TakerState {
  lastMid: number | null;
  ticks: number;
  takesExecuted: number;
  takesFailed: number;
  errors: number;
}

/** A normalized executable opportunity, whatever shape the tool returned. */
interface Deal {
  rate: number;            // quote per base (price)
  edgeBps: number;         // how much better than mid, in bps (positive = good)
  route?: string;          // human label for logging, if the tool gave one
}

export async function runOneTick(
  mcp: SeraMcpClient,
  cfg: TakerConfig,
  state: TakerState,
): Promise<void> {
  state.ticks++;
  const tickStart = Date.now();
  const log = (msg: string) => console.log(`[tick ${state.ticks}] ${msg}`);
  const [base, quote] = cfg.pair.split("/");

  try {
    // Step 1: inventory guard. A buy spends QUOTE; a sell spends BASE.
    const spendSymbol = cfg.side === "buy" ? quote : base;
    const haveEnough = await hasBalanceFor(mcp, cfg, base, quote, log);
    if (!haveEnough) {
      log(`inventory guard: insufficient ${spendSymbol} to fund ${cfg.notional} ${base} — hold`);
      return;
    }

    // Step 2: reference mid.
    const mid = await readMid(mcp, base, quote);
    log(`mid=${mid.toFixed(6)} ${quote}/${base}`);
    state.lastMid = mid;

    // Step 3: best executable rate.
    const deal = await bestDeal(mcp, cfg, base, quote, mid, log);
    if (!deal) {
      log(`no executable deal returned — hold`);
      return;
    }
    log(
      `best rate=${deal.rate.toFixed(6)} edge=${deal.edgeBps.toFixed(2)}bps` +
        (deal.route ? ` route=${deal.route}` : ""),
    );

    // Step 4: edge gate.
    if (deal.edgeBps < cfg.minEdgeBps) {
      log(`edge ${deal.edgeBps.toFixed(2)}bps < ${cfg.minEdgeBps}bps — hold`);
      return;
    }

    // Step 5: take. convert_and_send semantics: spend `from` to deliver
    // `to_amount` of the target asset to `recipient`. We send the BASE/QUOTE
    // direction implied by side; sera-mcp handles routing + (server-side) signing.
    const from = cfg.side === "buy" ? quote : base;
    const to = cfg.side === "buy" ? base : quote;
    const takeArgs = {
      owner_address: cfg.ownerAddress,
      recipient: cfg.recipient,
      from_currency: from,
      to_currency: to,
      amount: String(cfg.notional),
      side: cfg.side,
      max_slippage_bps: cfg.minEdgeBps, // never accept worse than the edge we gated on
    };

    if (cfg.dryRun) {
      log(`  [DRY-RUN] would take: sera.convert_and_send ${JSON.stringify(takeArgs)}`);
      return;
    }

    try {
      const r = await mcp.tool<{ tx_hash?: string; order_id?: string; status?: string }>(
        "sera.convert_and_send",
        takeArgs,
      );
      state.takesExecuted++;
      log(`  TAKEN ${r.order_id ?? r.tx_hash ?? r.status ?? "ok"}`);
    } catch (e: any) {
      state.takesFailed++;
      log(`  take FAILED: ${e?.message ?? String(e)}`);
    }
  } catch (e: any) {
    state.errors++;
    log(`tick failed: ${e?.message ?? String(e)}`);
  } finally {
    log(`tick done in ${Date.now() - tickStart}ms`);
  }
}

/**
 * Inventory guard. Best-effort: if get_balances is unavailable (no API key) we
 * fail OPEN in DRY_RUN (so you can still watch edges) and fail CLOSED when live.
 */
async function hasBalanceFor(
  mcp: SeraMcpClient,
  cfg: TakerConfig,
  base: string,
  quote: string,
  log: (m: string) => void,
): Promise<boolean> {
  const spendSymbol = cfg.side === "buy" ? quote : base;
  try {
    const r = await mcp.tool<{ balances?: Array<{ symbol?: string; available?: string | number }> }>(
      "sera.get_balances",
      { owner_address: cfg.ownerAddress },
    );
    const row = r.balances?.find((b) => b.symbol?.toUpperCase() === spendSymbol.toUpperCase());
    const available = row ? Number(row.available) : 0;
    // For a buy, we spend ~notional*mid of quote; for a sell, ~notional of base.
    // Use notional as a conservative floor (refined per-side once mid is known).
    return Number.isFinite(available) && available > 0;
  } catch (e: any) {
    log(`  get_balances unavailable (${e?.message ?? String(e)})`);
    return cfg.dryRun; // open in dry-run, closed when live
  }
}

async function readMid(mcp: SeraMcpClient, base: string, quote: string): Promise<number> {
  const r = await mcp.tool<{ median?: string | number; rate?: string | number }>(
    "sera.multi_source_mid",
    { base, quote },
  );
  const v = r.median ?? r.rate;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new Error(`multi_source_mid returned unparseable value: ${JSON.stringify(r)}`);
  }
  return n;
}

/**
 * Ask sera.find_deals for ranked opportunities; fall back to a single
 * get_quote if find_deals isn't present. Returns the single best executable
 * deal, or null if nothing parseable came back.
 */
async function bestDeal(
  mcp: SeraMcpClient,
  cfg: TakerConfig,
  base: string,
  quote: string,
  mid: number,
  log: (m: string) => void,
): Promise<Deal | null> {
  try {
    const r = await mcp.tool<any>("sera.find_deals", {
      base,
      quote,
      side: cfg.side,
      amount: String(cfg.notional),
      min_edge_bps: cfg.minEdgeBps,
    });
    const rows: any[] = r?.deals ?? r?.results ?? (Array.isArray(r) ? r : []);
    const deals = rows
      .map((d) => normalizeDeal(d, mid, cfg.side))
      .filter((d): d is Deal => d !== null)
      .sort((a, b) => b.edgeBps - a.edgeBps);
    if (deals.length > 0) return deals[0];
  } catch (e: any) {
    log(`  find_deals unavailable (${e?.message ?? String(e)}) — falling back to get_quote`);
  }

  // Fallback: a single executable quote.
  try {
    const q = await mcp.tool<any>("sera.get_quote", {
      from_currency: cfg.side === "buy" ? quote : base,
      to_currency: cfg.side === "buy" ? base : quote,
      amount: String(cfg.notional),
    });
    const rate = parseRate(q);
    if (rate === null) return null;
    return { rate, edgeBps: edgeBpsFor(rate, mid, cfg.side), route: "get_quote" };
  } catch {
    return null;
  }
}

function normalizeDeal(d: any, mid: number, side: TakeSide): Deal | null {
  const rate = parseRate(d);
  if (rate === null) return null;
  const rawEdge = d?.edge_bps ?? d?.edgeBps ?? d?.edge;
  const edgeBps =
    rawEdge !== undefined && Number.isFinite(Number(rawEdge))
      ? Number(rawEdge)
      : edgeBpsFor(rate, mid, side);
  return { rate, edgeBps, route: d?.route ?? d?.source ?? d?.venue };
}

function parseRate(o: any): number | null {
  const v = o?.rate ?? o?.price ?? o?.executable_rate ?? o?.median;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Edge in bps of an executable rate vs mid, from the taker's perspective.
 * Buying base: a LOWER rate is better. Selling base: a HIGHER rate is better.
 */
function edgeBpsFor(rate: number, mid: number, side: TakeSide): number {
  const rel = side === "buy" ? (mid - rate) / mid : (rate - mid) / mid;
  return rel * 10_000;
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}
