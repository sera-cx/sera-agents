/**
 * facilitator.test.ts — Coinbase CDP /verify + /settle wrapper.
 *
 * Mocks global fetch to validate request shape (URL, headers, body) and
 * response handling (success, network error, non-ok status). Validates
 * that outgoing Authorization headers carry cryptographically valid
 * ES256 JWTs with request-specific claims.
 */

import { verify as cryptoVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCdpJwt,
  type FacilitatorConfig,
  facilitatorSettle,
  facilitatorVerify,
  type PaymentRequirements,
} from "../facilitator.js";

const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = generateKeyPairSync(
  "ec",
  {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  },
);

const CFG: FacilitatorConfig = {
  url: "https://api.cdp.coinbase.com/platform/v2/x402",
  apiKeyId: "test-id",
  apiKeySecret: TEST_PRIVATE_KEY_PEM,
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

function verifyAndDecodeJwt(authHeaderValue: string) {
  expect(authHeaderValue).toMatch(/^Bearer ey/);
  const token = authHeaderValue.slice("Bearer ".length);
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  const signature = Buffer.from(sigB64, "base64url");
  const data = Buffer.from(`${headerB64}.${payloadB64}`);
  const isValidSig = cryptoVerify(
    "SHA256",
    data,
    { key: TEST_PUBLIC_KEY_PEM, dsaEncoding: "ieee-p1363" },
    signature,
  );
  expect(isValidSig).toBe(true);
  return { header, payload, isValidSig };
}

describe("buildCdpJwt", () => {
  it("generates a valid ES256 JWT with correct headers, claims, and nonce", () => {
    const jwt = buildCdpJwt(
      "test-id",
      TEST_PRIVATE_KEY_PEM,
      "POST",
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    );
    const { header, payload } = verifyAndDecodeJwt(`Bearer ${jwt}`);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("test-id");
    expect(typeof header.nonce).toBe("string");
    expect(header.nonce.length).toBeGreaterThan(0);
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe("test-id");
    expect(payload.uri).toBe("POST api.cdp.coinbase.com/platform/v2/x402/verify");
    const now = Math.floor(Date.now() / 1000);
    expect(payload.nbf).toBeGreaterThanOrEqual(now - 5);
    expect(payload.nbf).toBeLessThanOrEqual(now + 5);
    expect(payload.exp).toBe(payload.nbf + 120);
  });

  it("generates distinct nonces for separate JWT invocations", () => {
    const jwt1 = buildCdpJwt(
      "test-id",
      TEST_PRIVATE_KEY_PEM,
      "POST",
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    );
    const jwt2 = buildCdpJwt(
      "test-id",
      TEST_PRIVATE_KEY_PEM,
      "POST",
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    );
    const { header: h1 } = verifyAndDecodeJwt(`Bearer ${jwt1}`);
    const { header: h2 } = verifyAndDecodeJwt(`Bearer ${jwt2}`);
    expect(typeof h1.nonce).toBe("string");
    expect(typeof h2.nonce).toBe("string");
    expect(h1.nonce.length).toBe(32); // 16 bytes hex
    expect(h2.nonce.length).toBe(32);
    expect(h1.nonce).not.toBe(h2.nonce);
  });

  it("handles escaped \\n in private key PEM", () => {
    const escapedPem = TEST_PRIVATE_KEY_PEM.replace(/\n/g, "\\n");
    const jwt = buildCdpJwt(
      "test-id",
      escapedPem,
      "POST",
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
    );
    const { isValidSig } = verifyAndDecodeJwt(`Bearer ${jwt}`);
    expect(isValidSig).toBe(true);
  });
});

describe("facilitatorVerify", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  it("calls /verify with ES256 JWT auth header containing nonce + correct body shape", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ isValid: true }),
    });
    await facilitatorVerify(CFG, "base64payload", REQUIREMENTS);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/verify");
    expect(init.method).toBe("POST");

    const { header, payload } = verifyAndDecodeJwt((init.headers as any).authorization);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("test-id");
    expect(typeof header.nonce).toBe("string");
    expect(header.nonce.length).toBe(32);
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe("test-id");
    expect(payload.uri).toBe("POST api.cdp.coinbase.com/platform/v2/x402/verify");
    const now = Math.floor(Date.now() / 1000);
    expect(payload.nbf).toBeGreaterThanOrEqual(now - 5);
    expect(payload.nbf).toBeLessThanOrEqual(now + 5);
    expect(payload.exp).toBe(payload.nbf + 120);

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

  it("calls /settle with ES256 JWT auth header containing nonce + correct body shape", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, txHash: "0xdeadbeef", networkId: "base" }),
    });
    await facilitatorSettle(CFG, "base64payload", REQUIREMENTS);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/settle");
    expect(init.method).toBe("POST");

    const { header, payload } = verifyAndDecodeJwt((init.headers as any).authorization);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("test-id");
    expect(typeof header.nonce).toBe("string");
    expect(header.nonce.length).toBe(32);
    expect(payload.iss).toBe("cdp");
    expect(payload.sub).toBe("test-id");
    expect(payload.uri).toBe("POST api.cdp.coinbase.com/platform/v2/x402/settle");
    const now = Math.floor(Date.now() / 1000);
    expect(payload.nbf).toBeGreaterThanOrEqual(now - 5);
    expect(payload.nbf).toBeLessThanOrEqual(now + 5);
    expect(payload.exp).toBe(payload.nbf + 120);
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
