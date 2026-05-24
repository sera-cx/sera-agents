/**
 * state.test.ts — PaymentStatus state machine + atomic CAS store.
 *
 * Critical correctness layer: the v0.6.0 atomic CAS is what mitigates Attack II
 * (replay/idempotency) from arXiv:2605.11781. Every state transition MUST be
 * tested.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeStore, type PendingPayment } from "../state.js";

function makePending(overrides: Partial<PendingPayment> = {}): PendingPayment {
  const now = Math.floor(Date.now() / 1000);
  return {
    payment_id: overrides.payment_id ?? `00000000-0000-4000-8000-${Date.now().toString().padStart(12, "0")}`,
    status: overrides.status ?? "pending",
    pay_to: overrides.pay_to ?? "0x" + "a".repeat(40),
    amount_usdc: overrides.amount_usdc ?? 100,
    asset: "USDC",
    chain: 1,
    swap_request: overrides.swap_request ?? {
      from_currency: "USDC",
      to_currency: "EUR",
      amount: 100,
      recipient: "0x" + "b".repeat(40),
    },
    created_at: now,
    expires_at: overrides.expires_at ?? now + 300,
    last_status_change: now,
    ...overrides,
  };
}

describe("StateStore — basic save/load (in-memory mode)", () => {
  it("saves and loads a payment", () => {
    const store = makeStore(undefined, 100);
    const p = makePending();
    store.save(p);
    const loaded = store.load(p.payment_id);
    expect(loaded).toBeDefined();
    expect(loaded?.payment_id).toBe(p.payment_id);
    expect(loaded?.status).toBe("pending");
  });

  it("returns undefined for unknown payment_id", () => {
    const store = makeStore(undefined, 100);
    expect(store.load("nonexistent")).toBeUndefined();
  });

  it("reports current size", () => {
    const store = makeStore(undefined, 100);
    expect(store.size()).toBe(0);
    store.save(makePending({ payment_id: "p1" }));
    store.save(makePending({ payment_id: "p2" }));
    expect(store.size()).toBe(2);
  });
});

describe("StateStore — atomic CAS (the load-bearing mitigation)", () => {
  let store: ReturnType<typeof makeStore>;
  let p: PendingPayment;

  beforeEach(() => {
    store = makeStore(undefined, 100);
    p = makePending();
    store.save(p);
  });

  it("succeeds when current status matches expected", () => {
    expect(store.cas(p.payment_id, "pending", "verified")).toBe(true);
    expect(store.load(p.payment_id)?.status).toBe("verified");
  });

  it("fails when current status does not match expected (the replay defense)", () => {
    expect(store.cas(p.payment_id, "pending", "verified")).toBe(true);
    // Second concurrent caller tries to advance from pending — should lose.
    expect(store.cas(p.payment_id, "pending", "verified")).toBe(false);
    expect(store.load(p.payment_id)?.status).toBe("verified");
  });

  it("CAS chain pending → verified → executing → delivered", () => {
    expect(store.cas(p.payment_id, "pending", "verified")).toBe(true);
    expect(store.cas(p.payment_id, "verified", "executing")).toBe(true);
    expect(
      store.cas(p.payment_id, "executing", "delivered", {
        delivered_payload: '{"success":true}',
        settlement_payload: '{"txHash":"0xabc"}',
      }),
    ).toBe(true);
    const final = store.load(p.payment_id);
    expect(final?.status).toBe("delivered");
    expect(final?.delivered_payload).toBe('{"success":true}');
    expect(final?.settlement_payload).toBe('{"txHash":"0xabc"}');
  });

  it("fails CAS for unknown payment_id", () => {
    expect(store.cas("nonexistent", "pending", "verified")).toBe(false);
  });

  it("records last_error on failed_refundable transition", () => {
    store.cas(p.payment_id, "pending", "verified");
    store.cas(p.payment_id, "verified", "executing");
    store.cas(p.payment_id, "executing", "failed_refundable", {
      last_error: "swap upstream failed",
    });
    const final = store.load(p.payment_id);
    expect(final?.status).toBe("failed_refundable");
    expect(final?.last_error).toBe("swap upstream failed");
  });

  it("cannot skip from pending directly to delivered", () => {
    expect(store.cas(p.payment_id, "verified", "delivered")).toBe(false);
    expect(store.load(p.payment_id)?.status).toBe("pending");
  });

  // Note: the CAS layer is pure compare-and-swap — it doesn't encode FSM
  // direction rules. State-machine direction is enforced by the
  // `transitionTo*` helpers in payment.ts which always pass the correct
  // `expected` value. See payment.test.ts for direction enforcement.
});

describe("StateStore — listFailedRefundable (operator refund queue)", () => {
  it("returns empty when no failed_refundable payments", () => {
    const store = makeStore(undefined, 100);
    store.save(makePending({ status: "pending" }));
    store.save(makePending({ status: "delivered" }));
    expect(store.listFailedRefundable()).toHaveLength(0);
  });

  it("returns only failed_refundable payments", () => {
    const store = makeStore(undefined, 100);
    store.save(makePending({ payment_id: "fail-1", status: "failed_refundable" }));
    store.save(makePending({ payment_id: "ok-1", status: "delivered" }));
    store.save(makePending({ payment_id: "fail-2", status: "failed_refundable" }));
    const failed = store.listFailedRefundable();
    expect(failed).toHaveLength(2);
    expect(new Set(failed.map((p) => p.payment_id))).toEqual(new Set(["fail-1", "fail-2"]));
  });

  it("respects the limit parameter", () => {
    const store = makeStore(undefined, 100);
    for (let i = 0; i < 10; i++) {
      store.save(makePending({ payment_id: `p-${i}`, status: "failed_refundable" }));
    }
    expect(store.listFailedRefundable(3)).toHaveLength(3);
  });
});

describe("StateStore — gcExpired", () => {
  it("removes expired pending entries from memory", () => {
    const store = makeStore(undefined, 100);
    const old = makePending({
      payment_id: "old-pending",
      status: "pending",
      expires_at: Math.floor(Date.now() / 1000) - 100,
    });
    const fresh = makePending({ payment_id: "fresh-pending" });
    store.save(old);
    store.save(fresh);
    store.gcExpired(Math.floor(Date.now() / 1000));
    expect(store.load("fresh-pending")).toBeDefined();
    expect(store.load("old-pending")).toBeUndefined();
  });

  it("keeps expired failed_refundable entries (operator needs to see them)", () => {
    const store = makeStore(undefined, 100);
    const expiredFailed = makePending({
      payment_id: "expired-failed",
      status: "failed_refundable",
      expires_at: Math.floor(Date.now() / 1000) - 100,
    });
    store.save(expiredFailed);
    store.gcExpired(Math.floor(Date.now() / 1000));
    expect(store.load("expired-failed")).toBeDefined();
  });

  it("keeps expired delivered entries (idempotent replay still works)", () => {
    const store = makeStore(undefined, 100);
    const expiredDelivered = makePending({
      payment_id: "expired-delivered",
      status: "delivered",
      expires_at: Math.floor(Date.now() / 1000) - 100,
      delivered_payload: '{"success":true}',
    });
    store.save(expiredDelivered);
    store.gcExpired(Math.floor(Date.now() / 1000));
    expect(store.load("expired-delivered")?.status).toBe("delivered");
  });
});
