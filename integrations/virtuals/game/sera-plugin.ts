/**
 * Sera FX plugin for the Virtuals GAME SDK (@virtuals-protocol/game).
 *
 * Wraps the public agents.sera.cx gateway as GAME functions so any GAME agent —
 * including the X/Twitter agents you build on GAME Cloud — can quote and settle
 * cross-border stablecoin FX with no wallet, API key, or local sera-mcp install.
 *
 * The gateway is keyless and read-/prepare-only: `fx_settle` returns *unsigned*
 * EIP-712 typed data. The agent (or the human behind it) signs and submits that
 * itself — this plugin never holds keys or moves funds.
 *
 * Install:  npm i @virtuals-protocol/game
 * Usage:    import { seraFxWorker } from "./sera-plugin";  // add to a GameAgent
 *
 * API shapes below follow the game-node docs; pin your SDK version and adjust if
 * the SDK's exported names drift.
 */
import {
  GameFunction,
  GameWorker,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";

/** Public gateway base. Override for a self-hosted gateway or sepolia stack. */
const SERA_GATEWAY_URL = process.env.SERA_GATEWAY_URL ?? "https://agents.sera.cx";

async function seraFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${SERA_GATEWAY_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", ...init?.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // The gateway returns 429 + Retry-After on upstream throttles — surface it so
    // the agent can back off rather than treating it as a hard failure.
    const retry = res.headers.get("retry-after");
    const suffix = retry ? ` (retry after ${retry}s)` : "";
    throw new Error(`sera ${path} → ${res.status}${suffix}: ${(data as any)?.error ?? text}`);
  }
  return data;
}

const ok = (payload: unknown) =>
  new ExecutableGameFunctionResponse(
    ExecutableGameFunctionStatus.Done,
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );

const fail = (message: string) =>
  new ExecutableGameFunctionResponse(ExecutableGameFunctionStatus.Failed, message);

export const getRatesFunction = new GameFunction({
  name: "sera_get_fx_rates",
  description:
    "Get live FX reference rates between supported stablecoins. Pass one or more BASE/QUOTE pairs.",
  args: [
    {
      name: "pairs",
      description: 'Comma-separated BASE/QUOTE pairs, e.g. "USDC/BRLA,XSGD/IDRX" (max 20).',
    },
  ] as const,
  executable: async (args, _logger) => {
    try {
      if (!args.pairs) return fail("`pairs` is required, e.g. USDC/BRLA");
      const data = await seraFetch(`/rates?pairs=${encodeURIComponent(args.pairs)}`);
      return ok(data);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
});

export const getCorridorsFunction = new GameFunction({
  name: "sera_list_corridors",
  description: "List supported FX corridors (currency pairs) and their liquidity depth.",
  args: [] as const,
  executable: async (_args, _logger) => {
    try {
      return ok(await seraFetch(`/corridors`));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
});

export const getQuoteFunction = new GameFunction({
  name: "sera_fx_quote",
  description:
    "Get a live quote to convert one stablecoin into another. Returns amount_out, mid_rate and a quote_id that sera_fx_settle consumes.",
  args: [
    { name: "from_token", description: "Source token / currency code, e.g. XSGD" },
    { name: "to_token", description: "Destination token / currency code, e.g. IDRX" },
    { name: "amount", description: "Amount of from_token in human units, e.g. 100" },
  ] as const,
  executable: async (args, _logger) => {
    try {
      const { from_token, to_token, amount } = args;
      if (!from_token || !to_token || !amount) {
        return fail("from_token, to_token and amount are all required");
      }
      const data = await seraFetch(`/quote`, {
        method: "POST",
        body: JSON.stringify({ from_token, to_token, amount }),
      });
      return ok(data);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
});

export const settleFunction = new GameFunction({
  name: "sera_fx_settle",
  description:
    "Build an UNSIGNED EIP-712 settlement intent from a quote_id. Returns typed_data for the signer to sign in their own wallet — this does not move funds.",
  args: [
    { name: "quote_id", description: "quote_id returned by sera_fx_quote" },
    { name: "signer", description: "Caller wallet address, 0x-prefixed 40-hex" },
  ] as const,
  executable: async (args, _logger) => {
    try {
      const { quote_id, signer } = args;
      if (!quote_id || !signer) return fail("quote_id and signer are both required");
      if (!/^0x[0-9a-fA-F]{40}$/.test(signer)) return fail("signer must be a 0x-prefixed 40-hex address");
      const data = await seraFetch(`/settle`, {
        method: "POST",
        body: JSON.stringify({ quote_id, signer }),
      });
      return ok(data);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
});

/**
 * A ready-to-use GAME worker bundling all four Sera FX functions. Drop it into a
 * GameAgent's `workers` array.
 */
export const seraFxWorker = new GameWorker({
  id: "sera_fx",
  name: "Sera FX",
  description:
    "Cross-border stablecoin FX via Sera (agents.sera.cx): live rates, corridors, quotes, and unsigned EIP-712 settlement intents. Keyless and non-custodial.",
  functions: [getRatesFunction, getCorridorsFunction, getQuoteFunction, settleFunction],
});

export const seraFxFunctions = [
  getRatesFunction,
  getCorridorsFunction,
  getQuoteFunction,
  settleFunction,
];
