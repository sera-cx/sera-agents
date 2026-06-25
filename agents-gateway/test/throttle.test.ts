import { describe, it, expect } from "vitest";
import { GatewayError, rateLimitFromToolError } from "../src/errors.js";
import { interpretToolResult } from "../src/sera-mcp-client.js";

describe("rateLimitFromToolError", () => {
  it("reads structured _meta status + retryAfter", () => {
    const res = { isError: true, _meta: { "sera/httpStatus": 429, "sera/retryAfter": 12 } };
    expect(rateLimitFromToolError(res)).toEqual({ status: 429, retryAfter: 12 });
  });

  it("reads structuredContent error.code when _meta absent (numeric string coerced)", () => {
    const res = { isError: true, structuredContent: { error: { code: 503, retryAfter: "30" } } };
    expect(rateLimitFromToolError(res)).toEqual({ status: 503, retryAfter: 30 });
  });

  it("falls back to a 429 heuristic on the stringified text (no hint)", () => {
    const res = { isError: true, content: [{ type: "text", text: "sera api: 429 Too Many Requests" }] };
    expect(rateLimitFromToolError(res)).toEqual({ status: 429, retryAfter: undefined });
  });

  it("parses a Retry-After integer from 'rate limit' phrasing", () => {
    const res = { isError: true, content: [{ type: "text", text: "rate limit exceeded; Retry-After: 7" }] };
    expect(rateLimitFromToolError(res)).toEqual({ status: 429, retryAfter: 7 });
  });

  it("returns null for ordinary tool errors (→ 502)", () => {
    const res = { isError: true, content: [{ type: "text", text: "invalid token symbol" }] };
    expect(rateLimitFromToolError(res)).toBeNull();
  });

  it("does not false-positive on a 429 embedded in a larger number", () => {
    const res = { isError: true, content: [{ type: "text", text: "min output 1429000 too low" }] };
    expect(rateLimitFromToolError(res)).toBeNull();
  });
});

describe("interpretToolResult", () => {
  it("throws a GatewayError(429) with retryAfter on an upstream throttle", () => {
    const res = {
      isError: true,
      content: [{ type: "text", text: "429 Too Many Requests" }],
      _meta: { "sera/httpStatus": 429, "sera/retryAfter": 9 },
    };
    try {
      interpretToolResult("sera.get_fx_rate", res);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).status).toBe(429);
      expect((e as GatewayError).retryAfter).toBe(9);
    }
  });

  it("throws a plain Error (not GatewayError) for non-throttle tool errors", () => {
    const res = { isError: true, content: [{ type: "text", text: "invalid token symbol" }] };
    expect(() => interpretToolResult("sera.get_fx_rate", res)).toThrow(/invalid token symbol/);
    expect(() => interpretToolResult("sera.get_fx_rate", res)).not.toThrow(GatewayError);
  });

  it("parses the JSON content of a successful result", () => {
    const res = { content: [{ type: "text", text: JSON.stringify({ rate: "1.23" }) }] };
    expect(interpretToolResult<{ rate: string }>("sera.get_fx_rate", res)).toEqual({ rate: "1.23" });
  });
});
