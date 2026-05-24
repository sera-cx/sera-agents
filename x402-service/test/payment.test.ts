/**
 * payment.test.ts — verify/settle/execute orchestration + state transitions.
 *
 * The facilitator client and Sera MCP client are both injectable function
 * shapes — mocked here to test the orchestration logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyPayment,
  settlePayment,
  executeSwap,
  transitionToVerified,
  transitionToExecuting,
  transitionToDelivered,
  transitionToFailedRefundable,
} from "../payment.js";
import { makeStore, type PendingPayment } from "../state.js";
import type { X402Config } from "../env.js";
import type { SeraMcpClient } from "../sera-client.js";

function demoConfig(): X402Config {
  return {
    port: 8402,
    host: "127.0.0.1",
    mode: "demo",
    demoPublicOk: false,
    trustProxy: false,
    pendingMax: 100,
    rateLimitPerMin: 30,
    maxConcurrentSwaps: 8,
    pendingTtlSeconds: 300,
    surchargeBps: 0,
    maxAmount: 1_000_000,
    seraMcpPath: "/tmp/dummy.js",
    cdpNetwork: "base",
    confirmationDepth: 3,
    liveAck: false,
  };
}

function liveConfig(): X402Config {
  return {
    ...demoConfig(),
    mode: "live",
    liveAck: true,
    facilitatorUrl: "https://test-facilitator",
    cdpApiKeyId: "id",
    cdpApiKeySecret: "secret",
    vaultAddress: "0x" + "a".repeat(40),
  };
}

function makePending(): PendingPayment {
  const now = Math.floor(Date.now() / 1000);
  return {
    payment_id: `00000000-0000-4000-8000-${now.toString().padStart(12, "0")}`,
    status: "pending",
    pay_to: "0x" + "a".repeat(40),
    amount_usdc: 100,
    asset: "USDC",
    chain: 1,
    swap_request: {
      from_currency: "USDC",
      to_currency: "EUR",
      amount: 100,
      recipient: "0x" + "b".repeat(40),
    },
    created_at: now,
    expires_at: now + 300,
    last_status_change: now,
  };
}

describe("verifyPayment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  it("demo mode: requires authorization header but short-circuits to ok", async () => {
    const result = await verifyPayment(demoConfig(), makePending(), "demo-auth");
    expect(result.ok).toBe(true);
  });

  it("demo mode: refuses when authorization header empty", async () => {
    const result = await verifyPayment(demoConfig(), makePending(), "");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/X-PAYMENT required/);
  });

  it("live mode: calls facilitator, returns ok when isValid:true", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ isValid: true }) });
    const result = await verifyPayment(liveConfig(), makePending(), "auth");
    expect(result.ok).toBe(true);
  });

  it("live mode: returns reason on facilitator rejection", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ isValid: false, invalidReason: "expired" }),
    });
    const result = await verifyPayment(liveConfig(), makePending(), "auth");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");
  });
});

describe("settlePayment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  it("demo mode: no-op success", async () => {
    const result = await settlePayment(demoConfig(), makePending(), "auth");
    expect(result.ok).toBe(true);
    expect(result.networkId).toBe("demo");
  });

  it("live mode: returns txHash + networkId on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, txHash: "0xabc", networkId: "base" }),
    });
    const result = await settlePayment(liveConfig(), makePending(), "auth");
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe("0xabc");
    expect(result.networkId).toBe("base");
  });

  it("live mode: returns reason on facilitator failure", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, error: "settle rejected" }),
    });
    const result = await settlePayment(liveConfig(), makePending(), "auth");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("settle rejected");
  });
});

describe("executeSwap", () => {
  const mcpMock: SeraMcpClient = {
    call: vi.fn(),
    running: () => true,
  };

  beforeEach(() => {
    (mcpMock.call as any).mockReset();
  });

  it("demo mode: returns mock result without calling MCP", async () => {
    const result = await executeSwap(demoConfig(), mcpMock, makePending());
    expect(result.demo).toBe(true);
    expect(result.tx_hash).toBeNull();
    expect(mcpMock.call).not.toHaveBeenCalled();
  });

  it("live mode: calls sera.convert_and_send with correct args", async () => {
    (mcpMock.call as any).mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            execution: { trade_id: "trade-1", tx_hash: "0xdeadbeef" },
            quote: { human: { min_output: 92.5 } },
          }),
        },
      ],
    });
    const result = await executeSwap(liveConfig(), mcpMock, makePending());
    expect(mcpMock.call).toHaveBeenCalledWith("tools/call", {
      name: "sera.convert_and_send",
      arguments: expect.objectContaining({
        from: "USDC",
        to: "EUR",
        amount: 100,
        gas_mode: "pay_more",
      }),
    });
    expect(result.trade_id).toBe("trade-1");
    expect(result.tx_hash).toBe("0xdeadbeef");
    expect(result.demo).toBe(false);
  });

  it("live mode: surfaces MCP isError result", async () => {
    (mcpMock.call as any).mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "policy: cap exceeded" }],
    });
    const result = await executeSwap(liveConfig(), mcpMock, makePending());
    expect(result.error).toBe("policy: cap exceeded");
  });

  it("live mode: catches mcp subprocess crash", async () => {
    (mcpMock.call as any).mockRejectedValue(new Error("mcp subprocess exited"));
    const result = await executeSwap(liveConfig(), mcpMock, makePending());
    expect(result.error).toMatch(/mcp subprocess exited/);
  });
});

describe("state transition helpers", () => {
  it("transitionToVerified moves pending → verified atomically", () => {
    const store = makeStore(undefined, 100);
    const p = makePending();
    store.save(p);
    expect(transitionToVerified(store, p)).toBe(true);
    expect(store.load(p.payment_id)?.status).toBe("verified");
  });

  it("transitionToExecuting fails if not in verified state", () => {
    const store = makeStore(undefined, 100);
    const p = makePending();
    store.save(p);
    expect(transitionToExecuting(store, p)).toBe(false);
    expect(store.load(p.payment_id)?.status).toBe("pending");
  });

  it("transitionToDelivered persists delivered_payload + settlement_payload", () => {
    const store = makeStore(undefined, 100);
    const p = makePending();
    store.save(p);
    transitionToVerified(store, p);
    transitionToExecuting(store, p);
    expect(
      transitionToDelivered(store, p, '{"success":true}', '{"txHash":"0xabc"}'),
    ).toBe(true);
    const final = store.load(p.payment_id);
    expect(final?.status).toBe("delivered");
    expect(final?.delivered_payload).toBe('{"success":true}');
    expect(final?.settlement_payload).toBe('{"txHash":"0xabc"}');
  });

  it("transitionToFailedRefundable persists last_error", () => {
    const store = makeStore(undefined, 100);
    const p = makePending();
    store.save(p);
    transitionToVerified(store, p);
    transitionToExecuting(store, p);
    expect(
      transitionToFailedRefundable(store, p, "swap reverted on chain"),
    ).toBe(true);
    expect(store.load(p.payment_id)?.last_error).toBe("swap reverted on chain");
  });

  it("two concurrent verify CAS attempts: first wins, second loses", () => {
    const store = makeStore(undefined, 100);
    const p = makePending();
    store.save(p);
    const first = transitionToVerified(store, p);
    const second = transitionToVerified(store, p);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
