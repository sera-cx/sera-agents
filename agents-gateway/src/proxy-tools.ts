import { z } from "zod";

/**
 * Declarative registry of *keyless* sera-mcp tools the gateway re-exposes, over
 * both the REST surface (POST /<name>) and the MCP endpoint. Each entry forwards
 * its validated args verbatim to the upstream sera-mcp tool via the subprocess
 * client — the gateway adds no logic, so upstream stays the single source of
 * truth for behavior.
 *
 * SECURITY — why only these tools:
 *   Every tool here is read/analytics/quote-planning that needs NO SERA_API_KEY
 *   and touches NO account-scoped state. The account- and owner-coupled tools
 *   (balances, orders, treasury, build_approve/deposit/transfer, send_tx,
 *   withdraw_*) are deliberately NOT exposed: on a keyless public gateway an
 *   anonymous caller must never be able to act under the gateway's key-owner.
 *   The one external-signed write path stays `POST /settle` (build an unsigned
 *   EIP-712 intent the caller signs in their own wallet).
 *
 * The input `shape`s mirror sera-mcp's Zod schemas (src/tools/schemas.ts) so the
 * MCP-advertised inputSchema and the OpenAPI doc match what upstream validates.
 */

const gasMode = z
  .enum(["receive_less", "pay_more"])
  .optional()
  .describe("Whether fees are absorbed into the output (receive_less) or added on top (pay_more).");
const ccy = z.string().min(1).describe("ISO fiat code (e.g. 'USD') or a Sera token symbol (e.g. 'USDC').");
const pairList = z
  .array(z.object({ base: z.string(), quote: z.string() }))
  .optional()
  .describe("Explicit pair list. If omitted, enumerates from /markets and applies max_pairs.");

export interface ProxyTool {
  /** Gateway tool name + REST path segment (POST /<name>). */
  name: string;
  /** Upstream sera-mcp tool this forwards to. */
  upstream: string;
  /** One-line summary for MCP + OpenAPI. */
  summary: string;
  /** Zod raw shape describing the input (empty object = no input). */
  shape: z.ZodRawShape;
}

export const PROXY_TOOLS: ProxyTool[] = [
  {
    name: "markets",
    upstream: "sera.get_markets",
    summary: "List active FX markets — the tradeable stablecoin pairs.",
    shape: {},
  },
  {
    name: "mid",
    upstream: "sera.multi_source_mid",
    summary: "Median external mid rate for a pair across three free FX providers.",
    shape: { base: ccy, quote: ccy },
  },
  {
    name: "compare_fx",
    upstream: "sera.compare_to_external_fx",
    summary: "Diff Sera's reference rate against Frankfurter (ECB) to surface bias.",
    shape: { base: ccy, quote: ccy },
  },
  {
    name: "market_health",
    upstream: "sera.market_health",
    summary: "Quotability check for a corridor — can it be traded right now?",
    shape: { from: ccy, to: ccy, gas_mode: gasMode },
  },
  {
    name: "spread_radar",
    upstream: "sera.spread_radar",
    summary: "Flag pair asymmetry and triangular drift across a fiat basket. No liquidity needed.",
    shape: {
      currencies: z.array(z.string()).optional().describe("ISO fiat codes to scan. Default USD/SGD/MYR/EUR/GBP/JPY."),
      spread_alert_bps: z.number().nonnegative().optional(),
      triangular_alert_bps: z.number().nonnegative().optional(),
      include_triangles: z.boolean().optional(),
    },
  },
  {
    name: "find_deals",
    upstream: "sera.find_deals",
    summary: "Scan markets in parallel, diff each against external mid, rank the deals.",
    shape: {
      pairs: pairList,
      notional_per_quote: z.number().positive().optional(),
      max_pairs: z.number().int().positive().optional(),
      max_concurrency: z.number().int().positive().optional(),
      only_policy_allowed: z.boolean().optional(),
      min_deviation_bps: z.number().nonnegative().optional(),
      gas_mode: gasMode,
      use_multi_source: z.boolean().optional(),
    },
  },
  {
    name: "scan_markets",
    upstream: "sera.scan_markets",
    summary: "Probe pairs for quotability + executable price at a notional.",
    shape: {
      pairs: pairList,
      notional_per_quote: z.number().positive().optional(),
      max_pairs: z.number().int().positive().optional(),
      max_concurrency: z.number().int().positive().optional(),
    },
  },
  {
    name: "probe_depth",
    upstream: "sera.probe_depth",
    summary: "Characterize price impact across a size ladder for one pair.",
    shape: {
      from: ccy,
      to: ccy,
      sizes: z.array(z.number().positive()).optional().describe("Human input sizes. Default [100,1000,10000,100000]."),
      gas_mode: gasMode,
      max_concurrency: z.number().int().positive().optional(),
    },
  },
  {
    name: "round_trip_cost",
    upstream: "sera.round_trip_cost",
    summary: "Cost of A→B→A — reveals the maker hedge floor for a pair.",
    shape: { from: ccy, to: ccy, amount: z.number().positive(), gas_mode: gasMode },
  },
  {
    name: "fx_quote_diff",
    upstream: "sera.fx_quote_diff",
    summary: "Gap between the reference rate and the executable quote for a pair.",
    shape: { from: ccy, to: ccy, notional: z.number().positive().optional(), gas_mode: gasMode },
  },
  {
    name: "compare_corridors",
    upstream: "sera.compare_corridors",
    summary: "Rank candidate source tokens by cost to deliver an exact target amount.",
    shape: {
      target: ccy,
      target_amount: z.number().positive(),
      sources: z.array(z.string()).min(1).describe("Candidate source token symbols to compare."),
      max_concurrency: z.number().int().positive().max(10).optional(),
      gas_mode: gasMode,
    },
  },
  {
    name: "maker_quote_ladder",
    upstream: "sera.maker_quote_ladder",
    summary: "Project maker earnings across a 5→200 bps spread ladder for a pair.",
    shape: {
      base: ccy,
      quote: ccy,
      notional: z.number().positive().describe("Amount in the SELL leg."),
      role: z.enum(["maker_sell_base", "maker_buy_base"]).optional(),
      mid: z.number().positive().optional(),
      mid_source: z.enum(["multi_source", "sera"]).optional(),
      spreads_bps: z.array(z.number().positive()).optional(),
    },
  },
  {
    name: "quote_recipient_amount",
    upstream: "sera.quote_recipient_amount",
    summary: "Inverse quote — the input required to deliver an exact recipient amount.",
    shape: {
      from: ccy,
      to: ccy,
      recipient_amount: z
        .union([z.string(), z.number()])
        .describe("How much the recipient should end up with, in `to` human units."),
      owner_address: z.string(),
      recipient: z.string().optional(),
    },
  },
];
