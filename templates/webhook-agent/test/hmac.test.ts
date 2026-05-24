/**
 * hmac.test.ts — HMAC verification across Stripe, GitHub, and generic
 * providers + replay protection via nonce store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHmac, makeNonceStore, type HmacConfig } from "../hmac.js";

const SECRET = "whsec_test_secret_dont_use_in_prod";
const NOW = 1_750_000_000;

function makeCfg(overrides: Partial<HmacConfig> = {}): HmacConfig {
  return {
    provider: "stripe",
    secret: SECRET,
    toleranceSeconds: 300,
    nonceStore: makeNonceStore(),
    now: () => NOW,
    ...overrides,
  };
}

describe("verifyHmac — provider: none", () => {
  it("always returns ok when provider is none", () => {
    const cfg = makeCfg({ provider: "none" });
    expect(verifyHmac(cfg, Buffer.from("anything"), {})).toEqual({ ok: true });
  });
});

describe("verifyHmac — provider: stripe", () => {
  function signStripe(body: string, t = NOW): string {
    const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }

  it("accepts a valid signature", () => {
    const body = JSON.stringify({ event: "payment_intent.succeeded" });
    const cfg = makeCfg();
    const result = verifyHmac(cfg, Buffer.from(body), {
      "stripe-signature": signStripe(body),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when signature header missing", () => {
    const cfg = makeCfg();
    const r = verifyHmac(cfg, Buffer.from("body"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_stripe_signature");
  });

  it("rejects malformed signature (no t or no v1)", () => {
    const cfg = makeCfg();
    const r = verifyHmac(cfg, Buffer.from("body"), { "stripe-signature": "garbage" });
    expect(r.ok).toBe(false);
  });

  it("rejects stale signature (t outside tolerance)", () => {
    const body = JSON.stringify({ event: "x" });
    const cfg = makeCfg({ toleranceSeconds: 60 });
    const staleT = NOW - 3_600; // 1h ago > 60s tolerance
    const r = verifyHmac(cfg, Buffer.from(body), {
      "stripe-signature": signStripe(body, staleT),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_signature");
  });

  it("rejects wrong signature", () => {
    const cfg = makeCfg();
    // Forge: correct t but wrong v1.
    const r = verifyHmac(cfg, Buffer.from("body"), {
      "stripe-signature": `t=${NOW},v1=${"deadbeef".repeat(8)}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("rejects when secret missing", () => {
    const cfg = makeCfg({ secret: undefined });
    const r = verifyHmac(cfg, Buffer.from("body"), { "stripe-signature": signStripe("body") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_hmac_secret");
  });

  it("nonce replay rejected on second identical request", () => {
    const body = JSON.stringify({ event: "x" });
    const cfg = makeCfg();
    const sig = signStripe(body);
    expect(verifyHmac(cfg, Buffer.from(body), { "stripe-signature": sig }).ok).toBe(true);
    const second = verifyHmac(cfg, Buffer.from(body), { "stripe-signature": sig });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replay");
  });
});

describe("verifyHmac — provider: github", () => {
  function signGitHub(body: string): string {
    return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  }

  it("accepts valid sha256= signature", () => {
    const cfg = makeCfg({ provider: "github" });
    const body = JSON.stringify({ action: "opened" });
    const r = verifyHmac(cfg, Buffer.from(body), {
      "x-hub-signature-256": signGitHub(body),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing signature", () => {
    const cfg = makeCfg({ provider: "github" });
    const r = verifyHmac(cfg, Buffer.from("body"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_github_signature");
  });

  it("rejects signature without sha256= prefix", () => {
    const cfg = makeCfg({ provider: "github" });
    const r = verifyHmac(cfg, Buffer.from("body"), {
      "x-hub-signature-256": "md5=abc",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects wrong signature", () => {
    const cfg = makeCfg({ provider: "github" });
    const r = verifyHmac(cfg, Buffer.from("body"), {
      "x-hub-signature-256": "sha256=" + "00".repeat(32),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("nonce replay rejected when x-github-delivery present", () => {
    const cfg = makeCfg({ provider: "github" });
    const body = JSON.stringify({ action: "opened" });
    const headers = {
      "x-hub-signature-256": signGitHub(body),
      "x-github-delivery": "delivery-uuid-123",
    };
    expect(verifyHmac(cfg, Buffer.from(body), headers).ok).toBe(true);
    const second = verifyHmac(cfg, Buffer.from(body), headers);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replay");
  });

  it("no nonce replay check when x-github-delivery absent (lossy by design)", () => {
    const cfg = makeCfg({ provider: "github" });
    const body = "x";
    const headers = { "x-hub-signature-256": signGitHub(body) };
    expect(verifyHmac(cfg, Buffer.from(body), headers).ok).toBe(true);
    expect(verifyHmac(cfg, Buffer.from(body), headers).ok).toBe(true);
  });
});

describe("verifyHmac — provider: generic", () => {
  function signGeneric(body: string, ts = NOW, nonce = "nonce-1"): string {
    return createHmac("sha256", SECRET).update(`${ts}.${nonce}.${body}`).digest("hex");
  }

  it("accepts valid sig + ts + nonce", () => {
    const cfg = makeCfg({ provider: "generic" });
    const body = "{}";
    const headers = {
      "x-webhook-signature": signGeneric(body),
      "x-webhook-timestamp": String(NOW),
      "x-webhook-nonce": "nonce-1",
    };
    expect(verifyHmac(cfg, Buffer.from(body), headers).ok).toBe(true);
  });

  it("rejects missing any field", () => {
    const cfg = makeCfg({ provider: "generic" });
    const r = verifyHmac(cfg, Buffer.from("{}"), {
      "x-webhook-signature": "abc",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_signature_fields");
  });

  it("rejects stale timestamp", () => {
    const cfg = makeCfg({ provider: "generic", toleranceSeconds: 60 });
    const body = "{}";
    const oldTs = NOW - 3_600;
    const r = verifyHmac(cfg, Buffer.from(body), {
      "x-webhook-signature": signGeneric(body, oldTs),
      "x-webhook-timestamp": String(oldTs),
      "x-webhook-nonce": "n",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_signature");
  });

  it("nonce replay rejected on second identical request", () => {
    const cfg = makeCfg({ provider: "generic" });
    const body = "{}";
    const nonce = "n-1";
    const headers = {
      "x-webhook-signature": signGeneric(body, NOW, nonce),
      "x-webhook-timestamp": String(NOW),
      "x-webhook-nonce": nonce,
    };
    expect(verifyHmac(cfg, Buffer.from(body), headers).ok).toBe(true);
    const second = verifyHmac(cfg, Buffer.from(body), headers);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replay");
  });
});

describe("verifyHmac — unknown provider", () => {
  it("returns unknown_hmac_provider", () => {
    const cfg = makeCfg({ provider: "made_up" as any });
    const r = verifyHmac(cfg, Buffer.from(""), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_hmac_provider");
  });
});

describe("makeNonceStore", () => {
  it("remembers first occurrence, rejects second", () => {
    const store = makeNonceStore();
    expect(store.remember("a")).toBe(true);
    expect(store.remember("a")).toBe(false);
    expect(store.remember("b")).toBe(true);
  });

  it("GCs after maxSize crossed", () => {
    const store = makeNonceStore(10, 5); // 10 max, GC 5 at a time
    for (let i = 0; i < 15; i++) {
      store.remember(`n-${i}`);
    }
    expect(store.size()).toBeLessThanOrEqual(15);
    expect(store.size()).toBeLessThan(15);
  });
});
