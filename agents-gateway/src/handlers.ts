import type { SeraMcpClient } from "./sera-mcp-client.js";
import type { QuoteCache } from "./quote-cache.js";
import { GatewayError } from "./errors.js";

/**
 * Max currency pairs per `/rates` (and the MCP `rates` tool) request. Each pair
 * fans out to one upstream sera-mcp call, so an uncapped list on an
 * unauthenticated endpoint is a request-amplification / DoS vector (one HTTP
 * request → N upstream RPCs). 20 comfortably covers real agent use.
 */
const MAX_PAIRS = 20;

export interface RatesItem {
  pair: string;
  mid_rate: string;
  bid: string;
  ask: string;
  timestamp: string;
}

export interface CorridorsItem {
  from_currency: string;
  to_currency: string;
  liquidity_depth: string;
}

export interface QuoteResult {
  /** Guaranteed executable output (net of fees) — the swap's min output, not a gross mid estimate. */
  amount_out: string;
  /** Same guaranteed floor as amount_out, named explicitly for clarity. */
  min_output: string;
  /** Effective executable rate (amount_out / amount), display-only; amount_out is authoritative. */
  mid_rate: string;
  /** Real network/gas cost from the upstream fee breakdown (was previously hardcoded 0). */
  network_cost: string;
  quote_id: string;
  expires_at: string;
}

export interface SettleResult {
  typed_data: unknown;
}

interface SeraFxRate {
  base: string;
  quote: string;
  rate: string | number;
  bid?: string | number;
  ask?: string | number;
  source?: string;
  timestamp?: string;
}

interface SeraCurrency {
  symbol: string;
  fiat_currency?: string;
  fiat?: string;
  address?: string;
  decimals?: number;
  policy_allowed?: boolean;
}

interface SeraQuote {
  uuid: string;
  route_params: Record<string, unknown>;
  fee_breakdown?: { gas_cost_usd?: string; gas_cost_from_token?: string };
  expires_at?: number;
  permit?: unknown;
  amount_out?: string;
  min_output?: string;
  mid_rate?: string;
  /** get_quote / prepare_swap surface human-readable amounts here. */
  human?: { input?: string; min_output?: string; upstream_min_output?: string };
  simulated?: boolean;
}

function parsePair(pair: string): { base: string; quote: string } {
  const [base, quote] = pair.split("/").map((s) => s.trim());
  // A malformed pair is caller input, not an upstream fault → 400, not 502.
  if (!base || !quote) throw new GatewayError(400, `invalid pair "${pair}" — expected BASE/QUOTE`);
  return { base, quote };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Exact product of two decimal strings via BigInt — avoids float artifacts like
 * `0.1 * 3 = 0.30000000000000004` in the quoted amount_out. Inputs must match
 * DECIMAL; callers validate first.
 */
export function mulDecimal(a: string, b: string): string {
  const parse = (s: string) => {
    const neg = s.startsWith("-");
    const [int, frac = ""] = s.replace(/^[+-]/, "").split(".");
    return { digits: BigInt((int + frac) || "0"), scale: frac.length, neg };
  };
  const x = parse(a.trim());
  const y = parse(b.trim());
  const product = x.digits * y.digits;
  const negative = x.neg !== y.neg && product !== 0n;
  const scale = x.scale + y.scale;
  let s = product.toString();
  if (scale > 0) {
    s = s.padStart(scale + 1, "0");
    const int = s.slice(0, s.length - scale);
    const frac = s.slice(s.length - scale).replace(/0+$/, "");
    s = frac ? `${int}.${frac}` : int;
  }
  return (negative ? "-" : "") + s;
}

export function makeHandlers(mcp: SeraMcpClient, cache: QuoteCache) {
  async function rates(pairs: string[]): Promise<RatesItem[]> {
    // Normalize, drop blanks, and dedupe before we fan out to the upstream.
    const unique = [...new Set(pairs.map((p) => p.trim()).filter(Boolean))];
    if (unique.length === 0) throw new GatewayError(400, "at least one pair is required");
    if (unique.length > MAX_PAIRS) {
      throw new GatewayError(400, `too many pairs (max ${MAX_PAIRS}); received ${unique.length}`);
    }
    const out = await Promise.all(
      unique.map(async (p) => {
        const { base, quote } = parsePair(p);
        const r = await mcp.callTool<SeraFxRate>("sera.get_fx_rate", { base, quote });
        const mid = asString(r.rate);
        return {
          pair: `${base}/${quote}`,
          mid_rate: mid,
          bid: asString(r.bid ?? r.rate),
          ask: asString(r.ask ?? r.rate),
          timestamp: r.timestamp ?? new Date().toISOString(),
        };
      }),
    );
    return out;
  }

  async function corridors(): Promise<CorridorsItem[]> {
    // sera-mcp `list_currencies` returns
    //   { count, policy_allowed_symbols, tokens: [{ symbol, fiat_currency, … }] }
    // — the list is under `tokens`. Read that; fall back to `currencies` / a bare
    // array defensively so a future shape change doesn't silently empty this out.
    const list = await mcp.callTool<Record<string, unknown> | SeraCurrency[]>(
      "sera.list_currencies",
      {},
    );
    const items = (
      Array.isArray(list) ? list : ((list?.tokens ?? list?.currencies ?? []) as SeraCurrency[])
    ) as SeraCurrency[];
    const symbols = [...new Set(items.map((c) => c?.symbol).filter(Boolean))];
    const out: CorridorsItem[] = [];
    for (const from of symbols) {
      for (const to of symbols) {
        if (from === to) continue;
        out.push({ from_currency: from, to_currency: to, liquidity_depth: "available" });
      }
    }
    return out;
  }

  async function quote(args: {
    from_token: string;
    to_token: string;
    amount: string;
  }): Promise<QuoteResult> {
    const { from_token, to_token, amount } = args;
    // A bad amount is caller input (400) — reject before hitting the upstream.
    if (!DECIMAL.test(amount.trim())) {
      throw new GatewayError(400, "amount must be a decimal number");
    }
    // Executable price, not a reference mid: simulate a swap quote (keyless, burn
    // address) with fees absorbed into the output (gas_mode "receive_less").
    // sera-mcp's own get_fx_rate says to use get_quote for execution price.
    const q = await mcp.callTool<SeraQuote>("sera.get_quote", {
      from: from_token,
      to: to_token,
      amount,
      simulate: true,
      gas_mode: "receive_less",
    });
    const amount_out = asString(q.human?.min_output ?? q.min_output ?? "").trim();
    if (!DECIMAL.test(amount_out)) {
      throw new Error("sera-mcp get_quote returned no usable output amount");
    }
    const network_cost = asString(
      q.fee_breakdown?.gas_cost_from_token ?? q.fee_breakdown?.gas_cost_usd ?? "0",
    );
    // Effective executable rate for display; amount_out is the authoritative value.
    const amt = Number(amount);
    const out = Number(amount_out);
    // Display-only; trim float noise (0.3/0.2 → 1.4999… → 1.5). amount_out is authoritative.
    const mid_rate =
      amt > 0 && Number.isFinite(amt) && Number.isFinite(out)
        ? String(Number((out / amt).toPrecision(12)))
        : "";
    const reservation = cache.issue({ from_token, to_token, amount });
    return {
      amount_out,
      min_output: amount_out,
      mid_rate,
      network_cost,
      quote_id: reservation.quote_id,
      expires_at: reservation.expires_at,
    };
  }

  async function settle(args: { quote_id: string; signer: string }): Promise<SettleResult> {
    const original = cache.lookup(args.quote_id);
    if (!original) {
      // Unknown/expired quote is a caller-recoverable condition → 404, not 502.
      throw new GatewayError(404, `quote_id ${args.quote_id} unknown or expired — call /quote again`);
    }
    const prepared = await mcp.callTool<SeraQuote>("sera.prepare_swap", {
      from: original.from_token,
      to: original.to_token,
      from_amount: original.amount,
      owner_address: args.signer,
      recipient: args.signer,
    });
    return { typed_data: prepared.route_params };
  }

  return { rates, corridors, quote, settle };
}

export type Handlers = ReturnType<typeof makeHandlers>;
