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
  amount_out: string;
  mid_rate: string;
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
  fiat?: string;
  address?: string;
  decimals?: number;
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
}

function parsePair(pair: string): { base: string; quote: string } {
  const [base, quote] = pair.split("/").map((s) => s.trim());
  if (!base || !quote) throw new Error(`invalid pair "${pair}" — expected BASE/QUOTE`);
  return { base, quote };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
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
    const list = await mcp.callTool<{ currencies?: SeraCurrency[] } | SeraCurrency[]>(
      "sera.list_currencies",
      {},
    );
    const currencies = Array.isArray(list) ? list : (list.currencies ?? []);
    const symbols = currencies.map((c) => c.symbol).filter(Boolean);
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
    const rate = await mcp.callTool<SeraFxRate>("sera.get_fx_rate", {
      base: from_token,
      quote: to_token,
    });
    const mid = Number(rate.rate);
    const amt = Number(amount);
    if (!Number.isFinite(mid) || !Number.isFinite(amt)) {
      throw new Error("sera-mcp returned non-numeric rate or amount");
    }
    const amount_out = (amt * mid).toString();
    const reservation = cache.issue({ from_token, to_token, amount });
    return {
      amount_out,
      mid_rate: asString(rate.rate),
      network_cost: "0",
      quote_id: reservation.quote_id,
      expires_at: reservation.expires_at,
    };
  }

  async function settle(args: { quote_id: string; signer: string }): Promise<SettleResult> {
    const original = cache.lookup(args.quote_id);
    if (!original) {
      throw new Error(`quote_id ${args.quote_id} unknown or expired — call /quote again`);
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
