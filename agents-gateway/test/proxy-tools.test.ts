import { describe, it, expect } from "vitest";
import { z } from "zod";
import { makeHandlers } from "../src/handlers.js";
import { makeQuoteCache } from "../src/quote-cache.js";
import { PROXY_TOOLS } from "../src/proxy-tools.js";

function recordingMcp() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const mcp = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { ok: true, name } as any;
    },
    running: () => true,
    shutdown: () => {},
  } as any;
  return { mcp, calls };
}

describe("proxy handler — forwards verbatim to the upstream sera-mcp tool", () => {
  it("passes the tool name and args through unchanged", async () => {
    const { mcp, calls } = recordingMcp();
    const h = makeHandlers(mcp, makeQuoteCache());
    const res = await h.proxy("sera.find_deals", { max_pairs: 5, gas_mode: "receive_less" });
    expect(calls).toEqual([{ name: "sera.find_deals", args: { max_pairs: 5, gas_mode: "receive_less" } }]);
    expect(res).toEqual({ ok: true, name: "sera.find_deals" });
  });
});

describe("PROXY_TOOLS registry — invariants", () => {
  it("every tool targets a sera.* upstream and has a unique, url-safe name", () => {
    const names = new Set<string>();
    for (const t of PROXY_TOOLS) {
      expect(t.upstream).toMatch(/^sera\.[a-z_]+$/);
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
  });

  it("names never collide with the four bespoke gateway tools", () => {
    const reserved = new Set(["quote", "settle", "corridors", "rates"]);
    for (const t of PROXY_TOOLS) expect(reserved.has(t.name)).toBe(false);
  });

  it("exposes NO account-scoped / key-coupled tools (keyless-gateway invariant)", () => {
    // These upstream tools require SERA_API_KEY or move funds / act on an account
    // and must never be reachable on the keyless public gateway.
    const forbidden = [
      "get_balances", "get_order", "list_orders", "get_fills", "get_fills_for_order",
      "treasury_value", "exposure_report", "rebalance_plan", "pay_invoice", "settlement_status",
      "build_approve", "build_deposit", "build_transfer", "send_tx", "send_transfer",
      "withdraw_request", "withdraw_build", "withdraw_send", "place_order", "execute_swap",
      "cancel_order", "cancel_all_orders", "convert_and_send",
    ].map((n) => `sera.${n}`);
    const exposed = new Set(PROXY_TOOLS.map((t) => t.upstream));
    for (const f of forbidden) expect(exposed.has(f)).toBe(false);
  });

  it("each declared shape is a valid Zod raw shape (compiles to an object schema)", () => {
    for (const t of PROXY_TOOLS) {
      const schema = z.object(t.shape);
      // A no-arg parse should succeed for tools whose fields are all optional,
      // and produce a ZodError (not throw) for required-field tools.
      expect(() => schema.safeParse({})).not.toThrow();
    }
  });
});
