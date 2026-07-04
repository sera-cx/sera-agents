import { describe, it, expect } from "vitest";
import { makeQuoteCache } from "../src/quote-cache.js";
import { makeHandlers } from "../src/handlers.js";
import { GatewayError } from "../src/errors.js";
import { handleMcpRequest } from "../src/mcp.js";

describe("quote cache — max-entry cap", () => {
  it("evicts oldest-first once maxEntries is reached", () => {
    const cache = makeQuoteCache({ maxEntries: 3 });
    const ids = Array.from({ length: 5 }, (_, i) =>
      cache.issue({ from_token: "A", to_token: "B", amount: String(i) }).quote_id,
    );
    // With cap 3, the two oldest reservations are evicted.
    expect(cache.lookup(ids[0])).toBeNull();
    expect(cache.lookup(ids[1])).toBeNull();
    // The three most-recent survive and round-trip their args.
    expect(cache.lookup(ids[2])).not.toBeNull();
    expect(cache.lookup(ids[3])).not.toBeNull();
    expect(cache.lookup(ids[4])?.amount).toBe("4");
  });

  it("never exceeds the cap no matter how many are issued", () => {
    const cache = makeQuoteCache({ maxEntries: 10 });
    let survivors = 0;
    const ids = Array.from({ length: 1000 }, (_, i) =>
      cache.issue({ from_token: "A", to_token: "B", amount: String(i) }).quote_id,
    );
    for (const id of ids) if (cache.lookup(id)) survivors++;
    expect(survivors).toBe(10);
  });
});

describe("handlers.rates — pair cap + dedupe", () => {
  // Minimal fake sera-mcp client that records how many upstream calls happen.
  function fakeMcp() {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcp = {
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { rate: "1.5", timestamp: "2026-01-01T00:00:00Z" } as any;
      },
      running: () => true,
      shutdown: () => {},
    };
    return { mcp, calls };
  }
  const fakeCache = { issue: () => ({ quote_id: "x", expires_at: "" }), lookup: () => null } as any;

  it("rejects more than 20 pairs with a 400 GatewayError", async () => {
    const { mcp, calls } = fakeMcp();
    const handlers = makeHandlers(mcp as any, fakeCache);
    const pairs = Array.from({ length: 21 }, (_, i) => `T${i}/USDC`);
    const err = await handlers.rates(pairs).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
    // Nothing was fanned out to the upstream — rejected before any call.
    expect(calls.length).toBe(0);
  });

  it("rejects an all-blank / empty list with a 400", async () => {
    const { mcp } = fakeMcp();
    const handlers = makeHandlers(mcp as any, fakeCache);
    await expect(handlers.rates(["", "  "])).rejects.toBeInstanceOf(GatewayError);
  });

  it("dedupes repeated pairs so each hits the upstream once", async () => {
    const { mcp, calls } = fakeMcp();
    const handlers = makeHandlers(mcp as any, fakeCache);
    const out = await handlers.rates(["USDC/BRLA", "USDC/BRLA", " USDC/BRLA "]);
    expect(out).toHaveLength(1);
    expect(calls.length).toBe(1);
  });
});

describe("handleMcpRequest — request body cap", () => {
  function fakeReq(chunks: Buffer[], headers: Record<string, string> = {}) {
    return {
      method: "POST",
      headers,
      destroy() {},
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    } as any;
  }
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: undefined as string | undefined,
      headersSent: false,
      setHeader(k: string, v: string) {
        this.headers[k.toLowerCase()] = v;
      },
      end(b?: string) {
        this.body = b;
      },
      on() {},
    } as any;
  }

  it("returns 413 when the streamed body exceeds the cap", async () => {
    const big = Buffer.alloc(256 * 1024 + 1, 0x61);
    const res = fakeRes();
    await handleMcpRequest({} as any, fakeReq([big]), res);
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: "request body too large" });
  });

  it("fast-rejects 413 on an oversized Content-Length without reading the body", async () => {
    const res = fakeRes();
    let read = false;
    const req = {
      method: "POST",
      headers: { "content-length": String(256 * 1024 + 1) },
      destroy() {},
      async *[Symbol.asyncIterator]() {
        read = true;
        yield Buffer.from("{}");
      },
    } as any;
    await handleMcpRequest({} as any, req, res);
    expect(res.statusCode).toBe(413);
    expect(read).toBe(false);
  });
});
