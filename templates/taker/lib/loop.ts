/**
 * Taker loop — watch a corridor, cross the spread when the rate is right.
 *
 * Where the maker POSTS resting orders and waits to be filled, the taker
 * CONSUMES liquidity: it polls for an executable edge and fires a conversion
 * the moment Sera's rate beats external mid by enough basis points to be worth
 * taking. Same deterministic-loop shape as templates/market-maker — no LLM in
 * the hot path.
 *
 * Tool signatures below follow the published reference at
 * agents.sera.cx/docs/api (mirrored in this repo at docs/api/index.html):
 *   - sera.find_deals { min_bps, notional_usd } -> { deals:[{ pair, edge_bps,
 *     sera_rate, external_mid, notional }] }   (scans ALL markets; we filter to ours)
 *   - sera.multi_source_mid { base, quote }    -> { median, sources, spread_bps }
 *   - sera.get_quote { from, to, amount, simulate } -> { uuid, expected_out, ... }
 *   - sera.convert_and_send { from, to, amount, recipient, owner_address }
 *   - sera.get_balances { owner_address }      -> token balances (raw units)
 *
 * One tick:
 *   1. find_deals -> best edge on our pair (directional, vs the deal's own mid).
 *   2. edge gate: hold unless edge >= TK_MIN_EDGE_BPS.
 *   3. inventory guard: hold if the wallet can't fund the spend leg.
 *   4. take: convert_and_send (or log the intended call if DRY_RUN).
 */
import type { SeraMcpClient } from "./mcp-client.js";

export type TakeSide = "buy" | "sell";

export interface TakerConfig {
  pair: string;            // "EURC/USDC" — base/quote
  side: TakeSide;          // "buy" = acquire base, "sell" = offload base
  notional: number;        // base units to take per fill
  notionalUsd: number;     // approx USD probe size for find_deals
  minEdgeBps: number;      // only take if executable rate beats mid by >= this
  pollSeconds: number;
  dryRun: boolean;
  ownerAddress: string;
  recipient: string;       // where converted funds land (defaults to owner)
}

export interface TakerState {
  ticks: number;
  takesExecuted: number;
  takesFailed: number;
  errors: number;
}

/** A normalized, directional opportunity on our pair. */
interface Deal {
  rate: number;            // sera_rate, quote per base
  edgeBps: number;         // directional edge for our side, in bps (positive = good)
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
    // Step 1: best edge on our pair (find_deals already diffs Sera vs external mid).
    const deal = await bestDeal(mcp, cfg, log);
    if (!deal) {
      log(`no executable deal on ${cfg.pair} — hold`);
      return;
    }
    log(`sera_rate=${deal.rate.toFixed(6)} edge=${deal.edgeBps.toFixed(2)}bps (${cfg.side})`);

    // Step 2: edge gate.
    if (deal.edgeBps < cfg.minEdgeBps) {
      log(`edge ${deal.edgeBps.toFixed(2)}bps < ${cfg.minEdgeBps}bps — hold`);
      return;
    }

    // Step 3: figure out the spend leg + amount, then check we can fund it.
    //   buy  base: spend QUOTE (~notional × rate), receive BASE
    //   sell base: spend BASE  (~notional),        receive QUOTE
    const from = cfg.side === "buy" ? quote : base;
    const to = cfg.side === "buy" ? base : quote;
    const spendAmount = cfg.side === "buy" ? cfg.notional * deal.rate : cfg.notional;

    if (!(await canFund(mcp, cfg, from, spendAmount, log))) {
      log(`inventory guard: insufficient ${from} to fund ${spendAmount.toFixed(4)} — hold`);
      return;
    }

    // Step 4: take. convert_and_send quotes-signs-executes-transfers in one call;
    // the recipient receives `to` directly. sera-mcp signs (SERA_SIGNER_MODE=local).
    // Our edge gate above is the slippage protection — convert_and_send re-quotes
    // at execution, so confirm the delivered rate in logs / sera.settlement_status.
    const takeArgs = {
      owner_address: cfg.ownerAddress,
      recipient: cfg.recipient,
      from,
      to,
      amount: String(spendAmount),
    };

    if (cfg.dryRun) {
      log(`  [DRY-RUN] would take: sera.convert_and_send ${JSON.stringify(takeArgs)}`);
      return;
    }

    try {
      const r = await mcp.tool<{ trade_id?: string; tx_hash?: string; status?: string }>(
        "sera.convert_and_send",
        takeArgs,
      );
      state.takesExecuted++;
      log(`  TAKEN ${r.trade_id ?? r.tx_hash ?? r.status ?? "ok"}`);
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
 * find_deals scans every market and ranks Sera rate vs external mid. We filter
 * to our pair and compute the DIRECTIONAL edge for our side from the deal's own
 * sera_rate + external_mid (don't trust an abs edge_bps sign). Returns null
 * (hold) if find_deals is unavailable or our pair isn't in the results — we
 * never act on data we can't read.
 */
async function bestDeal(
  mcp: SeraMcpClient,
  cfg: TakerConfig,
  log: (m: string) => void,
): Promise<Deal | null> {
  let r: any;
  try {
    r = await mcp.tool<any>("sera.find_deals", {
      min_bps: 1, // surface thin edges too; our own TK_MIN_EDGE_BPS is the gate
      notional_usd: cfg.notionalUsd,
    });
  } catch (e: any) {
    log(`  find_deals unavailable (${e?.message ?? String(e)}) — hold`);
    return null;
  }

  const rows: any[] = r?.deals ?? (Array.isArray(r) ? r : []);
  const target = cfg.pair.toUpperCase();
  const candidates = rows
    .filter((d) => String(d?.pair ?? "").toUpperCase() === target)
    .map((d) => normalizeDeal(d, cfg.side))
    .filter((d): d is Deal => d !== null)
    .sort((a, b) => b.edgeBps - a.edgeBps);
  return candidates[0] ?? null;
}

function normalizeDeal(d: any, side: TakeSide): Deal | null {
  const rate = num(d?.sera_rate ?? d?.rate);
  const mid = num(d?.external_mid ?? d?.mid);
  if (rate === null || rate <= 0 || mid === null || mid <= 0) return null;
  // Buying base: a LOWER Sera rate than mid is the edge.
  // Selling base: a HIGHER Sera rate than mid is the edge.
  const rel = side === "buy" ? (mid - rate) / mid : (rate - mid) / mid;
  return { rate, edgeBps: rel * 10_000 };
}

/**
 * Inventory guard. Best-effort: if get_balances is unavailable (no API key) we
 * fail OPEN in DRY_RUN (so you can still watch edges) and fail CLOSED when live.
 * Response shape is "balances across N wallets in raw units" — we read it
 * loosely and treat unparseable as zero.
 */
async function canFund(
  mcp: SeraMcpClient,
  cfg: TakerConfig,
  spendSymbol: string,
  needed: number,
  log: (m: string) => void,
): Promise<boolean> {
  try {
    const r = await mcp.tool<any>("sera.get_balances", { owner_address: cfg.ownerAddress });
    const rows: any[] = r?.balances ?? (Array.isArray(r) ? r : []);
    const row = rows.find((b) => String(b?.symbol ?? "").toUpperCase() === spendSymbol.toUpperCase());
    const available = num(row?.available ?? row?.balance ?? row?.amount) ?? 0;
    return available >= needed;
  } catch (e: any) {
    log(`  get_balances unavailable (${e?.message ?? String(e)})`);
    return cfg.dryRun; // open in dry-run, closed when live
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}
