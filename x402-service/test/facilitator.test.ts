/**
 * facilitator.test.ts — Coinbase CDP /verify + /settle wrapper.
 *
 * Mocks global fetch to validate request shape (URL, headers, body) and
 * response handling (success, network error, non-ok status).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  facilitatorVerify,
  facilitatorSettle,
  type FacilitatorConfig,
  type PaymentRequirements,
} from "../facilitator.js";

const CFG: FacilitatorConfig = {
  url: "https://api.cdp.coinbase.com/platform/v2/x402",
  apiKeyId: "test-id",
  apiKeySecret: "test-secret",
  network: "base",
  confirmationDepth: 3,
};

const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "100000000",
  resource: "https://test/x402/swap",
  description: "test",
  mimeType: "application/json",
  payTo: "0x" + "a".repeat(40),
  maxTimeoutSeconds: 300,
  asset: "0x" + "b".repeat(40),
  extra: { name: "USD Coin", version: "2" },
};

describe("facilitatorVerify", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  it("calls /verify with auth header + correct body shape", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ isValid: true }),
    });
    await facilitatorVerify(CFG, "base64payload", REQUIREMENTS);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/verify");
    expect(init.method).toBe("POST");
    expect((init.headers as any).authorization).toBe("Bearer test-id:test-secret");
    expect((init.headers as any)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.x402Version).toBe(1);
    expect(body.paymentHeader).toBe("base64payload");
    expect(body.paymentRequirements).toEqual(REQUIREMENTS);
  });

  it("returns isValid:true on facilitator success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ isValid: true }),
    });
    const result = await facilitatorVerify(CFG, "payload", REQUIREMENTS);
    expect(result.isValid).toBe(true);
  });

  it("returns isValid:false + invalidReason on facilitator rejection", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ isValid: false, invalidReason: "expired signature" }),
    });
    const result = await facilitatorVerify(CFG, "payload", REQUIREMENTS);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("expired signature");
  });

  it("returns isValid:false on facilitator HTTP error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });
    const result = await facilitatorVerify(CFG, "payload", REQUIREMENTS);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/facilitator 500/);
  });

  it("returns isValid:false when facilitator unreachable (network error)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await facilitatorVerify(CFG, "payload", REQUIREMENTS);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/facilitator unreachable/);
  });

  it("strips trailing slashes from facilitator URL", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ isValid: true }) });
    await facilitatorVerify({ ...CFG, url: CFG.url + "///" }, "p", REQUIREMENTS);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/verify");
  });
});

describe("facilitatorSettle", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  it("calls /settle with auth header + correct body shape", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, txHash: "0xdeadbeef", networkId: "base" }),
    });
    await facilitatorSettle(CFG, "base64payload", REQUIREMENTS);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/settle");
    expect(init.method).toBe("POST");
    expect((init.headers as any).authorization).toBe("Bearer test-id:test-secret");
  });

  it("returns txHash + networkId on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, txHash: "0xabc", networkId: "base" }),
    });
    const result = await facilitatorSettle(CFG, "p", REQUIREMENTS);
    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xabc");
    expect(result.networkId).toBe("base");
  });

  it("returns success:false on facilitator HTTP error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    });
    const result = await facilitatorSettle(CFG, "p", REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/facilitator 502/);
  });

  it("returns success:false when facilitator unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const result = await facilitatorSettle(CFG, "p", REQUIREMENTS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/facilitator unreachable/);
  });
});
