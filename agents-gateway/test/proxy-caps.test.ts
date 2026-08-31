import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROXY_TOOLS } from "../src/proxy-tools.js";

function shapeOf(name: string) {
  const t = PROXY_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no proxy tool ${name}`);
  return z.object(t.shape as z.ZodRawShape);
}

// The gateway is keyless + unauthenticated, so uncapped array/limit params are a
// request-amplification vector (one HTTP call → N upstream RPCs). These caps are
// the edge ceiling mirroring the /rates MAX_PAIRS posture.
describe("proxy-tools — fan-out caps", () => {
  it("rejects oversized max_pairs / max_concurrency, accepts sane values", () => {
    const s = shapeOf("find_deals");
    expect(s.safeParse({ max_pairs: 999 }).success).toBe(false);
    expect(s.safeParse({ max_concurrency: 999 }).success).toBe(false);
    expect(s.safeParse({ max_pairs: 50, max_concurrency: 5 }).success).toBe(true);
  });

  it("rejects oversized explicit pair / currency / size lists", () => {
    const pairs = Array.from({ length: 60 }, () => ({ base: "A", quote: "B" }));
    expect(shapeOf("scan_markets").safeParse({ pairs }).success).toBe(false);
    const currencies = Array.from({ length: 40 }, (_, i) => `C${i}`);
    expect(shapeOf("spread_radar").safeParse({ currencies }).success).toBe(false);
    const sizes = Array.from({ length: 40 }, (_, i) => i + 1);
    expect(shapeOf("probe_depth").safeParse({ sizes }).success).toBe(false);
  });

  it("bounds compare_corridors sources", () => {
    const sources = Array.from({ length: 40 }, (_, i) => `S${i}`);
    expect(shapeOf("compare_corridors").safeParse({ target_amount: 1, sources }).success).toBe(
      false,
    );
  });
});
