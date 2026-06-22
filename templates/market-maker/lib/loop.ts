/**
 * Maker loop — cancel-before-place quote refresh.
 *
 * One tick:
 *   1. (optional) cancel_all_orders for the wallet
 *   2. read multi_source_mid for the configured pair
 *   3. drift gate: bail if mid hasn't moved ≥ MM_DRIFT_BPS since last quote
 *   4. construct + sign bid + ask Order structs at mid ± MM_SPREAD_BPS
 *   5. submit via sera.place_order (or log + skip if DRY_RUN)
 *   6. sleep until next tick (POLL_SECONDS or cron-style)
 */
import { Wallet } from "ethers";
import type { SeraMcpClient } from "./mcp-client.js";
import { makeOrderId, DEFAULT_EXECUTOR_ID } from "./uuid-int.js";
import { seraDomain, signOrder, orderHash, type OrderStruct } from "./order-signer.js";

export interface MarketInfo {
  symbol: string;          // e.g. "EURC/USDC"
  base_address: string;
  quote_address: string;
  base_symbol: string;
  quote_symbol: string;
  base_decimals: number;
  quote_decimals: number;
}

export interface LoopConfig {
  pair: string;
  notional: number;         // human units of base (or quote — see usage)
  spreadBps: number;        // conventional bps (denom 10^4), each side
  driftBps: number;         // requote threshold
  pollSeconds: number;
  expirationSeconds: number;
  dryRun: boolean;
  wallet: Wallet;
  ownerAddress: string;
  chainId: number;
  seraAddress: string;
  executorId: bigint;
}

export interface LoopState {
  lastMid: number | null;
  ticks: number;
  ordersPosted: number;
  ordersFailed: number;
  errors: number;
}

export async function runOneTick(
  mcp: SeraMcpClient,
  market: MarketInfo,
  cfg: LoopConfig,
  state: LoopState,
): Promise<void> {
  state.ticks++;
  const tickStart = Date.now();
  const log = (msg: string) => console.log(`[tick ${state.ticks}] ${msg}`);

  try {
    // Step 1: kill stale quotes. Sera's per-order 5-min cancel cooldown
    // applies — if we requote more often than that we'll start seeing 429s.
    log(`cancel_all_orders (${cfg.ownerAddress.slice(0, 8)}…)`);
    try {
      const c = await mcp.tool<{ total: number }>("sera.cancel_all_orders", {
        owner_address: cfg.ownerAddress,
      });
      log(`  cancelled=${c.total ?? 0}`);
    } catch (e: any) {
      log(`  cancel_all_orders warning: ${e?.message ?? String(e)}`);
    }

    // Step 2: read mid.
    const [base, quote] = cfg.pair.split("/");
    const mid = await readMid(mcp, base, quote);
    log(`mid=${mid.toFixed(6)} ${quote}/${base}`);

    // Step 3: drift gate.
    if (state.lastMid !== null) {
      const driftBps = Math.abs((mid - state.lastMid) / state.lastMid) * 10_000;
      if (driftBps < cfg.driftBps) {
        log(`drift=${driftBps.toFixed(2)}bps < ${cfg.driftBps}bps — hold`);
        return;
      }
    }
    state.lastMid = mid;

    // Step 4: construct + sign bid and ask.
    const bidPrice = mid * (1 - cfg.spreadBps / 10_000);
    const askPrice = mid * (1 + cfg.spreadBps / 10_000);
    log(`bid=${bidPrice.toFixed(6)} ask=${askPrice.toFixed(6)} (±${cfg.spreadBps}bps)`);

    const now = Math.floor(Date.now() / 1000);
    const expiration = now + cfg.expirationSeconds;
    const domain = seraDomain(cfg.chainId, cfg.seraAddress);

    const bidOrder = buildOrder({
      side: "bid",
      market,
      price: bidPrice,
      amount: cfg.notional,
      owner: cfg.ownerAddress,
      expiration,
      executorId: cfg.executorId,
    });
    const askOrder = buildOrder({
      side: "ask",
      market,
      price: askPrice,
      amount: cfg.notional,
      owner: cfg.ownerAddress,
      expiration,
      executorId: cfg.executorId,
    });

    // Inventory-aware sizing (stub). A real maker skews quotes and sizes by
    // current position; here we do the minimum honest thing — don't post a side
    // the wallet can't fund. Best-effort: if get_balances is unavailable we post
    // both sides (the policy caps + on-chain checks are the real backstop).
    //
    // TODO (production): replace the skip with a skew — widen/shrink each side's
    // price and size as inventory drifts from your target, and pull one side
    // entirely past a hard band. See README "Inventory monitoring".
    const fundable = await fundableSides(mcp, cfg, market, bidPrice, log);

    // Step 5: submit (or dry-run log).
    for (const { side, body, struct } of [bidOrder, askOrder]) {
      if (!fundable[side]) {
        log(`  ${side.toUpperCase()} skipped — inventory can't fund this side`);
        continue;
      }
      if (cfg.dryRun) {
        log(`  [DRY-RUN] ${side.toUpperCase()} order_id=${body.order_id} hash=${orderHash(domain, struct).slice(0, 18)}…`);
        continue;
      }
      const signature = await signOrder(cfg.wallet, domain, struct);
      try {
        const r = await mcp.tool<{ order_id: string }>("sera.place_order", {
          owner_address: cfg.ownerAddress,
          side,
          amount: String(cfg.notional),
          price: String(side === "bid" ? bidPrice : askPrice),
          order_type: "limit",
          from_address: market.base_address,
          to_address: market.quote_address,
          order_id: body.order_id,
          uuid_int: body.uuid_int,
          signature,
          expiration,
        });
        state.ordersPosted++;
        log(`  ${side.toUpperCase()} placed order_id=${r.order_id}`);
      } catch (e: any) {
        state.ordersFailed++;
        log(`  ${side.toUpperCase()} place_order FAILED: ${e?.message ?? String(e)}`);
      }
    }
  } catch (e: any) {
    state.errors++;
    log(`tick failed: ${e?.message ?? String(e)}`);
  } finally {
    log(`tick done in ${Date.now() - tickStart}ms`);
  }
}

/**
 * Inventory-aware sizing stub. Returns which sides the wallet can fund:
 *   - bid spends QUOTE (need ~notional × price of quote)
 *   - ask spends BASE  (need ~notional of base)
 * Best-effort: if get_balances isn't available (no API key), allow both — the
 * sera-mcp policy caps and on-chain balance checks remain the hard backstop.
 */
async function fundableSides(
  mcp: SeraMcpClient,
  cfg: LoopConfig,
  market: MarketInfo,
  bidPrice: number,
  log: (m: string) => void,
): Promise<{ bid: boolean; ask: boolean }> {
  try {
    const r = await mcp.tool<{ balances?: Array<{ symbol?: string; available?: string | number }> }>(
      "sera.get_balances",
      { owner_address: cfg.ownerAddress },
    );
    const avail = (symbol: string): number => {
      const row = r.balances?.find((b) => b.symbol?.toUpperCase() === symbol.toUpperCase());
      const n = row ? Number(row.available) : 0;
      return Number.isFinite(n) ? n : 0;
    };
    return {
      bid: avail(market.quote_symbol) >= cfg.notional * bidPrice,
      ask: avail(market.base_symbol) >= cfg.notional,
    };
  } catch (e: any) {
    log(`  get_balances unavailable (${e?.message ?? String(e)}) — posting both sides`);
    return { bid: true, ask: true };
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

interface BuildOrderArgs {
  side: "bid" | "ask";
  market: MarketInfo;
  price: number;
  amount: number;
  owner: string;
  expiration: number;
  executorId: bigint;
}

interface BuiltOrder {
  side: "bid" | "ask";
  body: { order_id: string; uuid_int: string };
  struct: OrderStruct;
}

function buildOrder(a: BuildOrderArgs): BuiltOrder {
  const { side, market, price, amount, owner, expiration, executorId } = a;
  const ids = makeOrderId(executorId);

  // Bid: buy `base` paying `quote`. fromToken/toToken on the Order struct
  // represent the SPEND direction in Sera's conventions: fromAmount is what
  // the user gives up; toAmount is what they receive.
  //
  //   side=bid: spend QUOTE  →  receive BASE → fromToken=QUOTE, toToken=BASE
  //   side=ask: spend BASE   →  receive QUOTE → fromToken=BASE,  toToken=QUOTE
  //
  // (Note: the wire payload to POST /orders separately uses from_address /
  // to_address = MARKET base/quote, regardless of side. The on-chain Order
  // struct uses spend-direction semantics. The MCP layer reconciles both.)
  const isBid = side === "bid";
  const fromToken = isBid ? market.quote_address : market.base_address;
  const toToken   = isBid ? market.base_address  : market.quote_address;
  const fromDecimals = isBid ? market.quote_decimals : market.base_decimals;
  const toDecimals   = isBid ? market.base_decimals  : market.quote_decimals;

  // amount is in BASE units. fromAmount/toAmount are raw token units.
  const baseRaw = toRaw(amount, market.base_decimals);
  const quoteRaw = toRaw(amount * price, market.quote_decimals);

  const fromAmount = isBid ? quoteRaw : baseRaw;
  const toAmount   = isBid ? baseRaw  : quoteRaw;

  void fromDecimals; void toDecimals; // unused; logged via baseRaw/quoteRaw

  return {
    side,
    body: ids,
    struct: {
      user: owner,
      expiration,
      feeBps: 0,                                // makers: no fee in struct
      recipient: "0x0000000000000000000000000000000000000000",
      fromToken,
      toToken,
      fromAmount,
      toAmount,
      initialDepositAmount: 0n,
      uuid: BigInt(ids.uuid_int),
    },
  };
}

function toRaw(human: number, decimals: number): bigint {
  // Avoid floating-point loss: split integer + fractional, multiply 10^d.
  const [intPart, fracPart = ""] = human.toString().split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}
