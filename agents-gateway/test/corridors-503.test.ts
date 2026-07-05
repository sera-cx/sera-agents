import { describe, it, expect } from "vitest";
import { makeHandlers } from "../src/handlers.js";
import { makeQuoteCache } from "../src/quote-cache.js";
import { rateLimitFromToolError } from "../src/errors.js";

function mcpReturning(list: unknown) {
  return {
    async callTool(name: string) {
      if (name === "sera.list_currencies") return list as any;
      return {} as any;
    },
    running: () => true,
    shutdown: () => {},
  } as any;
}

describe("corridors — reads the real list_currencies shape", () => {
  const expectPair = (from: string, to: string) => ({
    from_currency: from,
    to_currency: to,
    liquidity_depth: "available",
  });

  it("reads `tokens` (the actual sera-mcp shape) — not `currencies`", async () => {
    const h = makeHandlers(
      mcpReturning({ count: 2, policy_allowed_symbols: ["AEDZ", "BRZ"], tokens: [{ symbol: "AEDZ" }, { symbol: "BRZ" }] }),
      makeQuoteCache(),
    );
    const c = await h.corridors();
    expect(c).toHaveLength(2);
    expect(c).toEqual(expect.arrayContaining([expectPair("AEDZ", "BRZ"), expectPair("BRZ", "AEDZ")]));
  });

  it("still handles a bare array and a {currencies:[…]} shape", async () => {
    const arr = await makeHandlers(mcpReturning([{ symbol: "A" }, { symbol: "B" }]), makeQuoteCache()).corridors();
    expect(arr).toHaveLength(2);
    const wrapped = await makeHandlers(mcpReturning({ currencies: [{ symbol: "A" }, { symbol: "B" }] }), makeQuoteCache()).corridors();
    expect(wrapped).toHaveLength(2);
  });

  it("dedupes symbols and returns [] for an empty token list", async () => {
    const dup = await makeHandlers(mcpReturning({ tokens: [{ symbol: "A" }, { symbol: "A" }] }), makeQuoteCache()).corridors();
    expect(dup).toHaveLength(0); // only one unique symbol → no from≠to pairs
    const empty = await makeHandlers(mcpReturning({ count: 0, tokens: [] }), makeQuoteCache()).corridors();
    expect(empty).toEqual([]);
  });
});

describe("rateLimitFromToolError — 503 transient passthrough", () => {
  const err = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

  it("maps a 503 / service-unavailable message to status 503", () => {
    expect(rateLimitFromToolError(err("sera api error: 503 Service temporarily unavailable; please retry"))).toEqual({
      status: 503,
      retryAfter: undefined,
    });
    expect(rateLimitFromToolError(err("upstream service unavailable"))).toEqual({ status: 503, retryAfter: undefined });
  });

  it("parses Retry-After on a 503", () => {
    expect(rateLimitFromToolError(err("503 service unavailable; Retry-After: 5"))).toEqual({ status: 503, retryAfter: 5 });
  });

  it("still prefers 429 when both-ish, and ignores ordinary errors", () => {
    expect(rateLimitFromToolError(err("429 too many requests"))).toEqual({ status: 429, retryAfter: undefined });
    expect(rateLimitFromToolError(err("invalid token symbol"))).toBeNull();
  });
});
