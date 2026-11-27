/**
 * Demo settlements must be identifiable from the persisted record alone.
 *
 * The threat these cover is not an attacker — it is a demo settlement quietly
 * entering a downstream ledger under the same schema as a live one, after the
 * `X-Sera-Demo-Mode` response header that marked it has been dropped by a proxy,
 * a retry, or an agent that recorded the body and discarded the headers. Every
 * assertion below therefore reads the value or the row, never the header.
 *
 * See sera-cx/sera-agents#69.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { X402Config } from "../env.js";
import { DEMO_TX_PREFIX, demoTxHash, isDemoTxHash, settlePayment } from "../payment.js";
import { makeStore, MixedModeStateError, type PendingPayment } from "../state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x402-demo-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makePending(overrides: Partial<PendingPayment> = {}): PendingPayment {
  const now = Math.floor(Date.now() / 1000);
  return {
    payment_id: "11111111-1111-4111-8111-111111111111",
    status: "pending",
    pay_to: `0x${"a".repeat(40)}`,
    amount_usdc: 100,
    asset: "USDC",
    chain: 1,
    swap_request: {
      from_currency: "USDC",
      to_currency: "EUR",
      amount: 100,
      recipient: `0x${"b".repeat(40)}`,
    },
    demo: false,
    created_at: now,
    expires_at: now + 300,
    last_status_change: now,
    ...overrides,
  };
}

const demoConfig = () => ({ mode: "demo" }) as unknown as X402Config;

describe("a demo tx hash names itself", () => {
  it("cannot be confused with a live settle hash", () => {
    const hash = demoTxHash("11111111-1111-4111-8111-111111111111");
    expect(hash.startsWith(DEMO_TX_PREFIX)).toBe(true);
    // Live hashes are 0x-prefixed 32-byte hex. A demo value matches neither the
    // prefix nor the length, so even a consumer doing a shallow check rejects it.
    expect(hash).not.toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(isDemoTxHash(hash)).toBe(true);
  });

  it("is deterministic per payment, so retries stay idempotent", () => {
    expect(demoTxHash("abc")).toBe(demoTxHash("abc"));
    expect(demoTxHash("abc")).not.toBe(demoTxHash("abd"));
  });

  it("does not classify a real settle hash as demo", () => {
    expect(isDemoTxHash(`0x${"e".repeat(64)}`)).toBe(false);
    expect(isDemoTxHash(null)).toBe(false);
    expect(isDemoTxHash(undefined)).toBe(false);
  });

  it("settle returns a marked hash rather than an absent one", async () => {
    const pending = makePending({ demo: true });
    const result = await settlePayment(demoConfig(), pending, "");
    expect(result.ok).toBe(true);
    // The regression this locks: `txHash: undefined` is the shape a downstream
    // reconciler is most likely to backfill from another source.
    expect(result.txHash).toBeDefined();
    expect(isDemoTxHash(result.txHash)).toBe(true);
    expect(result.networkId).toBe("demo");
  });
});

describe("the persisted row carries the mode", () => {
  it("survives a round trip through SQLite, not just through memory", () => {
    const path = join(dir, "state.db");
    const store = makeStore(path, 100, true);
    store.save(makePending({ demo: true }));

    // A second store over the same file reads from disk with no memory cache —
    // this is what a reconciler or a restarted process actually sees.
    const reopened = makeStore(path, 100, true);
    const row = reopened.load("11111111-1111-4111-8111-111111111111");
    expect(row?.demo).toBe(true);
  });

  it("keeps live rows marked live", () => {
    const path = join(dir, "state.db");
    makeStore(path, 100, false).save(makePending({ demo: false }));
    expect(makeStore(path, 100, false).load("11111111-1111-4111-8111-111111111111")?.demo).toBe(false);
  });

  it("still reports the mode after a CAS transition", () => {
    const path = join(dir, "state.db");
    const store = makeStore(path, 100, true);
    store.save(makePending({ demo: true, status: "verified" }));
    expect(store.cas("11111111-1111-4111-8111-111111111111", "verified", "delivered")).toBe(true);
    const row = makeStore(path, 100, true).load("11111111-1111-4111-8111-111111111111");
    expect(row?.status).toBe("delivered");
    expect(row?.demo).toBe(true);
  });

  it("marks a demo row in listFailedRefundable, which operators read directly", () => {
    const path = join(dir, "state.db");
    const store = makeStore(path, 100, true);
    store.save(makePending({ demo: true, status: "failed_refundable" }));
    const [row] = makeStore(path, 100, true).listFailedRefundable();
    expect(row.demo).toBe(true);
  });
});

describe("one state file belongs to one mode", () => {
  it("refuses to open a demo store in live mode", () => {
    const path = join(dir, "state.db");
    makeStore(path, 100, true).save(makePending({ demo: true }));
    expect(() => makeStore(path, 100, false)).toThrow(MixedModeStateError);
  });

  it("refuses to open a live store in demo mode", () => {
    const path = join(dir, "state.db");
    makeStore(path, 100, false).save(makePending({ demo: false }));
    expect(() => makeStore(path, 100, true)).toThrow(MixedModeStateError);
  });

  it("reopens its own mode without complaint", () => {
    const path = join(dir, "state.db");
    makeStore(path, 100, true).save(makePending({ demo: true }));
    expect(() => makeStore(path, 100, true)).not.toThrow();
  });

  it("opens an empty store in either mode", () => {
    const path = join(dir, "state.db");
    makeStore(path, 100, true);
    expect(() => makeStore(path, 100, false)).not.toThrow();
  });

  it("stops the process rather than silently degrading to memory", () => {
    // The catch around store construction falls back to a memory store on any
    // open failure. That fallback must not swallow a mode collision: a live
    // deploy running on memory-only state loses the durable anti-replay ledger.
    const path = join(dir, "state.db");
    makeStore(path, 100, true).save(makePending({ demo: true }));
    let thrown: unknown;
    try {
      makeStore(path, 100, false);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MixedModeStateError);
    expect(String((thrown as Error).message)).toContain("refusing to start");
  });
});

describe("migrating a store written before the demo column existed", () => {
  it("adds the column and keeps existing rows readable", async () => {
    const path = join(dir, "state.db");
    const Database = (await import("better-sqlite3")).default;

    // Recreate the pre-migration schema exactly: no `demo` column.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE payments (
        payment_id TEXT PRIMARY KEY, status TEXT NOT NULL, pay_to TEXT NOT NULL,
        amount_usdc REAL NOT NULL, chain INTEGER NOT NULL, from_currency TEXT NOT NULL,
        to_currency TEXT NOT NULL, amount REAL NOT NULL, recipient TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, delivered_payload TEXT,
        settlement_payload TEXT, last_error TEXT, last_status_change INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO payments VALUES ('legacy-1','delivered','0x0',1,1,'USDC','EUR',1,'0x0',1,2,NULL,NULL,NULL,3)`,
      )
      .run();
    legacy.close();

    const store = makeStore(path, 100, false);
    const row = store.load("legacy-1");
    expect(row).toBeDefined();
    // Pre-migration rows default to live. Stated, not assumed: the mode guard
    // is what stops a demo file being reused under live, since these rows
    // carry no evidence either way.
    expect(row?.demo).toBe(false);
  });
});
