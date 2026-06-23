/**
 * Taker loop — watch a corridor, cross the spread when the rate is right.
 *
 * Where the maker POSTS resting orders and waits to be filled, the taker
 * CONSUMES liquidity: it polls for an executable edge and fires a conversion
 * the moment Sera's rate beats the external benchmark by enough basis points to
 * be worth taking. Same deterministic-loop shape as templates/market-maker — no
 * LLM in the hot path.
 *
 * Tool signatures below are reconciled against the sera-mcp SOURCE
 * (github.com/sera-cx/sera-mcp, src/tools/{deals,core,treasury}.ts), not just
 * the published summary:
 *
 *   sera.find_deals
 *     in:  { pairs:[{base,quote}], notional_per_quote, min_deviation_bps,
 *            use_multi_source, gas_mode? }
 *     out: { good_sell:[item], good_buy:[item], fair:[item], summary, ... }
 *          item = { pair, rate, base_fiat, quote_fiat, benchmark,
 *                   deviation_bps, status_label }
 *          good_buy  = Sera quote < benchmark → favorable to BUY base
 *          good_sell = Sera quote > benchmark → favorable to SELL base
 *
 *   sera.convert_and_send
 *     in:  { from, to, amount, owner_address, recipient, gas_mode }   (all req)
 *          gas_mode "receive_less" = spend exactly `amount` of `from`
 *          gas_mode "pay_more"     = deliver exactly `amount` of `to`
 *
 *   sera.get_balances
 *     in:  { owner_address }
 *     out: { balances:[{ symbol, wallet_balance, vault_available, decimals }] }
 *
 * One tick:
 *   1. find_deals on our pair → the directional bucket for our side.
 *   2. edge gate: hold unless deviation_bps >= TK_MIN_EDGE_BPS.
 *   3. inventory guard: hold if the vault can't fund the spend leg.
 *   4. take: convert_and_send (or log the intended call if DRY_RUN).
 */
import type { SeraMcpClient } from "./mcp-client.js";

export type TakeSide = "buy" | "sell";
export type GasMode = "receive_less" | "pay_more";

export interface TakerConfig {
  pair: string;            // "EURC/USDC" — base/quote
  side: TakeSide;          // "buy" = acquire base, "sell" = offload base
  notional: number;        // base units to take per fill
  notionalUsd: number;     // approx USD probe size (notional_per_quote)
  minEdgeBps: number;      // only take if Sera beats benchmark by >= this
  gasMode: GasMode;        // convert_and_send gas accounting
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
  rate: number;            // Sera executable rate, quote per base
  edgeBps: number;         // deviation_bps for our side (positive = favorable)
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
    // Step 1: best edge on our pair, on the side we want.
    const deal = await bestDeal(mcp, cfg, base, quote, log);
    if (!deal) {
      log(`no favorable ${cfg.side} deal on ${cfg.pair} — hold`);
      return;
    }
    log(`sera_rate=${deal.rate.toFixed(6)} edge=${deal.edgeBps.toFixed(0)}bps (${cfg.side})`);

    // Step 2: edge gate.
    if (deal.edgeBps < cfg.minEdgeBps) {
      log(`edge ${deal.edgeBps.toFixed(0)}bps < ${cfg.minEdgeBps}bps — hold`);
      return;
    }

    // Step 3: spend leg + amount (in `from` units, since gas_mode=receive_less).
    //   buy  base: spend QUOTE (~notional × rate), receive BASE
    //   sell base: spend BASE  (~notional),        receive QUOTE
    const from = cfg.side === "buy" ? quote : base;
    const to = cfg.side === "buy" ? base : quote;
    const spendAmount = cfg.side === "buy" ? cfg.notional * deal.rate : cfg.notional;

    if (!(await canFund(mcp, cfg, from, spendAmount, log))) {
      log(`inventory guard: vault can't fund ${spendAmount.toFixed(4)} ${from} — hold`);
      return;
    }

    // Step 4: take. convert_and_send quotes-signs-executes-transfers in one call;
    // the recipient receives `to` directly. sera-mcp signs (SERA_SIGNER_MODE=local).
    // It RE-QUOTES at execution — our edge gate is the only slippage guard, so
    // confirm the delivered rate via sera.settlement_status after each fill.
    const takeArgs = {
      from,
      to,
      amount: String(spendAmount),
      owner_address: cfg.ownerAddress,
      recipient: cfg.recipient,
      gas_mode: cfg.gasMode,
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
 * find_deals probes our pair and sorts each market into directional buckets
 * (good_buy / good_sell / fair). We read the bucket for our side and take the
 * best deviation_bps. Returns null (hold) if find_deals is unavailable or our
 * pair isn't favorable for our side — we never act on data we can't read.
 */
async function bestDeal(
  mcp: SeraMcpClient,
  cfg: TakerConfig,
  base: string,
  quote: string,
  log: (m: string) => void,
): Promise<Deal | null> {
  let r: any;
  try {
    r = await mcp.tool<any>("sera.find_deals", {
      pairs: [{ base, quote }],
      notional_per_quote: cfg.notionalUsd,
      min_deviation_bps: 0, // surface everything; our TK_MIN_EDGE_BPS is the gate
      use_multi_source: true,
    });
  } catch (e: any) {
    log(`  find_deals unavailable (${e?.message ?? String(e)}) — hold`);
    return null;
  }

  // good_buy = favorable to buy base; good_sell = favorable to sell base.
  const bucket: any[] = (cfg.side === "buy" ? r?.good_buy : r?.good_sell) ?? [];
  const candidates = bucket
    .filter((d) => pairMatches(d?.pair, base, quote))
    .map(normalizeDeal)
    .filter((d): d is Deal => d !== null)
    .sort((a, b) => b.edgeBps - a.edgeBps);
  return candidates[0] ?? null;
}

/** `pair` may be a "BASE/QUOTE" string or a { base, quote } object. */
function pairMatches(pair: unknown, base: string, quote: string): boolean {
  const want = `${base}/${quote}`.toUpperCase();
  if (typeof pair === "string") return pair.toUpperCase() === want;
  if (pair && typeof pair === "object") {
    const p = pair as { base?: string; quote?: string };
    return `${p.base ?? ""}/${p.quote ?? ""}`.toUpperCase() === want;
  }
  return false;
}

function normalizeDeal(d: any): Deal | null {
  const rate = num(d?.rate);
  const edge = num(d?.deviation_bps);
  if (rate === null || rate <= 0 || edge === null) return null;
  // Items already live in the directional bucket, so deviation_bps is the
  // favorable edge magnitude. Math.abs guards against a signed value.
  return { rate, edgeBps: Math.abs(edge) };
}

/**
 * Inventory guard against the VAULT balance (what convert_and_send can spend).
 * Best-effort: if get_balances is unavailable (no API key) we fail OPEN in
 * DRY_RUN (so you can still watch edges) and fail CLOSED when live.
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
    // Unknown balance → watch in dry-run, hold when live.
    if (!row) return cfg.dryRun;
    // vault_available is the tradeable balance; fall back to wallet_balance.
    // Values are RAW token units — scale by decimals to compare with `needed`.
    const raw = num(row.vault_available ?? row.wallet_balance ?? row.available);
    if (raw === null) return cfg.dryRun;
    const dec = num(row.decimals);
    const available = dec !== null ? raw / 10 ** dec : raw;
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
