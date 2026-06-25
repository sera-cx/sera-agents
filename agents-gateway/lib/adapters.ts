/**
 * agents.sera.cx gateway adapters.
 *
 * The ONLY place the curated public contract (fx_quote / fx_settle / corridors
 * / rates) meets sera-mcp's tool surface. Every field mapping is documented and
 * reconciled against sera-mcp v0.8.3 SOURCE:
 *   - sera.get_quote / sera.prepare_swap  → src/tools/core.ts (getQuote)
 *   - swap Intent EIP-712 struct          → src/signer/signer.ts (INTENT_TYPES)
 *   - sera.get_markets / sera.get_fx_rate → src/tools/core.ts
 *
 * Where a sera response field name could not be verified against a LIVE API
 * from the build environment (egress-restricted), the adapter reads it
 * DEFENSIVELY — first-present of a small candidate set — rather than assuming a
 * single name. Confirm against a live sera-mcp before production.
 */
import type { SeraMcpClient } from "./mcp-client.js";
import type { QuoteStore } from "./store.js";
import { GatewayError } from "./errors.js";

// Re-exported so existing `import { GatewayError } from "./adapters.js"` sites
// (server, mcp-http, tests) keep working after the move to ./errors.js.
export { GatewayError };

const SYMBOL_RE = /^[A-Za-z0-9._-]{1,32}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Subset of sera.get_quote's response we depend on. */
interface SeraQuote {
  uuid?: string;
  expires_at?: string;
  fee_breakdown?: unknown;
  route_params?: Record<string, unknown>;
  human?: { input?: string | number; min_output?: string | number };
}

// ───────────────────────── /quote  (operationId fx_quote) ─────────────────────
export interface QuoteRequest {
  from_token: string;
  to_token: string;
  amount: string;
}
export interface QuoteResponse {
  amount_out: string;
  mid_rate: string;
  network_cost: string;
  quote_id: string;
  expires_at: string;
}

export async function fxQuote(
  mcp: SeraMcpClient,
  store: QuoteStore,
  req: QuoteRequest,
): Promise<QuoteResponse> {
  const from = String(req?.from_token ?? "").trim();
  const to = String(req?.to_token ?? "").trim();
  const amount = String(req?.amount ?? "").trim();
  if (!SYMBOL_RE.test(from) || !SYMBOL_RE.test(to))
    throw new GatewayError(400, "from_token and to_token must be token symbols");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0)
    throw new GatewayError(400, "amount must be a positive number string");

  // simulate=true prices with the burn address — no wallet required, and the
  // returned route_params are explicitly NOT executable. /settle re-quotes with
  // the caller's real signer to mint the signable intent.
  const q = await mcp.tool<SeraQuote>("sera.get_quote", {
    from,
    to,
    amount,
    simulate: true,
    gas_mode: "receive_less",
  });

  const inputHuman = Number(q.human?.input);
  const outHuman = Number(q.human?.min_output);
  const mid = inputHuman > 0 && Number.isFinite(outHuman) ? outHuman / inputHuman : NaN;

  // Mint our own opaque id and remember the inputs for /settle.
  const quote_id = store.put({ from, to, amount }, q.expires_at);

  return {
    amount_out: q.human?.min_output != null ? String(q.human.min_output) : "",
    mid_rate: Number.isFinite(mid) ? mid.toFixed(8) : "",
    network_cost: networkCost(q.fee_breakdown),
    quote_id,
    expires_at: q.expires_at ?? "",
  };
}

function networkCost(fee: unknown): string {
  if (fee == null) return "";
  if (typeof fee === "string" || typeof fee === "number") return String(fee);
  const f = fee as Record<string, unknown>;
  const total = f.total ?? f.network_cost ?? f.gas ?? f.total_fee;
  return total != null ? String(total) : JSON.stringify(fee);
}

// ───────────────────────── /settle  (operationId fx_settle) ───────────────────
export interface SettleRequest {
  quote_id: string;
  signer: string;
}
export interface Eip712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: "Intent";
  message: Record<string, unknown>;
}
export interface SettleResponse {
  typed_data: Eip712TypedData;
}
export interface SeraDomainInfo {
  chainId: number;
  verifyingContract?: string;
}

/**
 * Sera swap-intent EIP-712 struct. MUST match sera-mcp src/signer/signer.ts
 * INTENT_TYPES exactly — the route_params returned by prepare_swap is the
 * `message` for this type, signed under domain
 * { name:"Sera", version:"1", chainId, verifyingContract: sera_address }.
 */
export const INTENT_TYPES: Record<string, ReadonlyArray<{ name: string; type: string }>> = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
};

export async function fxSettle(
  mcp: SeraMcpClient,
  store: QuoteStore,
  domain: SeraDomainInfo,
  req: SettleRequest,
): Promise<SettleResponse> {
  const quoteId = String(req?.quote_id ?? "").trim();
  const signer = String(req?.signer ?? "").trim();
  if (!ADDRESS_RE.test(signer))
    throw new GatewayError(400, "signer must be a 0x EVM address");
  const rec = store.get(quoteId);
  if (!rec)
    throw new GatewayError(404, "unknown or expired quote_id — request a fresh /quote first");

  // prepare_swap == get_quote, but with the caller's REAL address as owner, so
  // route_params is the executable Intent for THIS signer to sign.
  const q = await mcp.tool<SeraQuote>("sera.prepare_swap", {
    from: rec.from,
    to: rec.to,
    amount: rec.amount,
    owner_address: signer,
    gas_mode: "receive_less",
  });
  const message = q.route_params;
  if (!message || typeof message !== "object")
    throw new GatewayError(502, "engine returned no route_params for settlement");

  return {
    typed_data: {
      domain: {
        name: "Sera",
        version: "1",
        chainId: domain.chainId,
        ...(domain.verifyingContract ? { verifyingContract: domain.verifyingContract } : {}),
      },
      types: INTENT_TYPES,
      primaryType: "Intent",
      message: message as Record<string, unknown>,
    },
  };
}

// ───────────────────────── /corridors ─────────────────────────────────────────
export interface Corridor {
  from_currency: string;
  to_currency: string;
  liquidity_depth: string;
}

export async function corridors(mcp: SeraMcpClient): Promise<Corridor[]> {
  const r = await mcp.tool<{ markets?: unknown[] }>("sera.get_markets", {});
  const markets = Array.isArray(r?.markets) ? r.markets : [];
  return markets
    .map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      return {
        from_currency: String(m.base ?? m.base_symbol ?? m.from ?? m.from_currency ?? ""),
        to_currency: String(m.quote ?? m.quote_symbol ?? m.to ?? m.to_currency ?? ""),
        liquidity_depth:
          m.liquidity_depth != null ? String(m.liquidity_depth) : m.depth != null ? String(m.depth) : "",
      };
    })
    .filter((c) => c.from_currency && c.to_currency);
}

// ───────────────────────── /rates ─────────────────────────────────────────────
export interface Rate {
  pair: string;
  mid_rate: string;
  bid: string;
  ask: string;
  timestamp: string;
}

export async function rates(
  mcp: SeraMcpClient,
  pairsParam: string | undefined,
  nowIso: string,
): Promise<Rate[]> {
  const pairs = (pairsParam ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length === 0)
    throw new GatewayError(400, "query param 'pairs' is required, e.g. ?pairs=USDC/BRLA,XSGD/IDRX");
  if (pairs.length > 25) throw new GatewayError(400, "too many pairs (max 25)");

  const out: Rate[] = [];
  for (const pair of pairs) {
    const [base, quote] = pair.split("/").map((s) => s.trim());
    if (!base || !quote) throw new GatewayError(400, `invalid pair '${pair}' — use BASE/QUOTE`);
    const r = await mcp.tool<Record<string, unknown>>("sera.get_fx_rate", { base, quote });
    out.push({
      pair: `${base.toUpperCase()}/${quote.toUpperCase()}`,
      mid_rate: pick(r, ["mid_rate", "mid", "rate"]),
      bid: pick(r, ["bid", "bid_rate"]),
      ask: pick(r, ["ask", "ask_rate"]),
      timestamp: pick(r, ["timestamp", "as_of", "time"]) || nowIso,
    });
  }
  return out;
}

function pick(o: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (o == null) return "";
  for (const k of keys) if (o[k] != null) return String(o[k]);
  return "";
}
