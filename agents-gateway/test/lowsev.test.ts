import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors.js";
import { makeHandlers, mulDecimal } from "../src/handlers.js";
import { makeQuoteCache } from "../src/quote-cache.js";
import type { SeraMcpClient } from "../src/sera-mcp-client.js";

describe("mulDecimal — exact decimal product (no float artifacts)", () => {
  it("computes precise products", () => {
    expect(mulDecimal("0.1", "3")).toBe("0.3"); // float would give 0.30000000000000004
    expect(mulDecimal("100", "1.5")).toBe("150");
    expect(mulDecimal("0.000001", "1000000")).toBe("1");
    expect(mulDecimal("2", "3")).toBe("6");
    expect(mulDecimal("1.25", "1.25")).toBe("1.5625");
  });
  it("trims trailing zeros and handles zero", () => {
    expect(mulDecimal("2.50", "2")).toBe("5");
    expect(mulDecimal("0", "999")).toBe("0");
  });
  it("stays exact for large values", () => {
    expect(mulDecimal("123456789.123456789", "1000000000")).toBe("123456789123456789");
  });
});

describe("handlers — error status classification", () => {
  // quote() calls sera.get_quote (executable, simulated); settle() calls prepare_swap.
  // Pass an Error as quoteResp to simulate get_quote throwing (e.g. no_liquidity).
  function make(quoteResp: unknown = { human: { min_output: "1" }, fee_breakdown: {} }) {
    const mcp = {
      async callTool(name: string) {
        if (name === "sera.get_quote") {
          if (quoteResp instanceof Error) throw quoteResp;
          return quoteResp as any;
        }
        if (name === "sera.prepare_swap") return { route_params: { ok: true } } as any;
        return {} as any;
      },
      running: () => true,
      shutdown: () => {},
    } as any;
    return makeHandlers(mcp, makeQuoteCache());
  }
  const signer = `0x${"a".repeat(40)}`;
  it("quote returns the executable min_output as amount_out (+ cost, effective rate)", async () => {
    const q = await make({
      human: { min_output: "0.3" },
      fee_breakdown: { gas_cost_from_token: "0.002" },
    }).quote({ from_token: "A", to_token: "B", amount: "0.2" });
    expect(q.amount_out).toBe("0.3");
    expect(q.min_output).toBe("0.3");
    expect(q.network_cost).toBe("0.002");
    expect(q.mid_rate).toBe("1.5"); // 0.3 / 0.2
    expect(q.quote_id).toBeTruthy();
  });

  it("quote → 400 GatewayError on a non-decimal amount (caller input)", async () => {
    const err = await make()
      .quote({ from_token: "A", to_token: "B", amount: "abc" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
  });

  it("quote → 400 GatewayError on a negative amount (caller input)", async () => {
    const err = await make()
      .quote({ from_token: "A", to_token: "B", amount: "-5" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
  });

  it("quote → 400 GatewayError on a zero amount (caller input)", async () => {
    const err = await make()
      .quote({ from_token: "A", to_token: "B", amount: "0" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
  });

  it("quote validates the amount before any upstream call (no RPC on bad input)", async () => {
    const calls: string[] = [];
    const mcp: SeraMcpClient = {
      async callTool<T>(name: string): Promise<T> {
        calls.push(name);
        return { rate: "1.5" } as T;
      },
      running: () => true,
      shutdown: () => {},
    };
    const h = makeHandlers(mcp, makeQuoteCache());
    const err = await h.quote({ from_token: "A", to_token: "B", amount: "abc" }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
    expect(calls).toEqual([]); // rejected before any upstream RPC
  });

  it("quote → plain Error (→502) when the upstream quote has no usable output", async () => {
    const err = await make({ human: {} })
      .quote({ from_token: "A", to_token: "B", amount: "1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GatewayError);
  });

  it("quote → 422 GatewayError when the upstream reports no_liquidity", async () => {
    const err = await make(new Error('sera 400 (no_liquidity): {"success":false}'))
      .quote({ from_token: "A", to_token: "B", amount: "1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(422);
  });

  it("settle → 404 GatewayError on unknown/expired quote_id", async () => {
    const err = await make()
      .settle({ quote_id: "nope", signer })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(404);
  });

  it("rates → 400 GatewayError on a malformed pair", async () => {
    const err = await make()
      .rates(["BADPAIR"])
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
  });

  it("quote → settle round-trips a reserved quote_id", async () => {
    const h = make({ human: { min_output: "20" } });
    const q = await h.quote({ from_token: "A", to_token: "B", amount: "10" });
    expect(q.amount_out).toBe("20");
    const s = await h.settle({ quote_id: q.quote_id, signer });
    expect(s.typed_data).toEqual({ ok: true });
  });
});
