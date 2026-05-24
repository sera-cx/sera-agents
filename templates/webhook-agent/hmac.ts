/**
 * HMAC verification helpers — extracted from server.ts so the verification
 * logic is pure-function and unit-testable without env-mutation gymnastics.
 *
 * Each `verifyHmac*` is provider-specific (Stripe / GitHub / generic). The
 * `verifyHmac` aggregator dispatches by provider name.
 *
 * Replay protection uses an injectable `nonceStore` interface — pass a
 * fresh `makeNonceStore()` per request handler in production, or a mock in
 * tests.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type HmacProvider = "none" | "stripe" | "github" | "generic";

export interface NonceStore {
  /** Returns true if the nonce was newly remembered; false if it's a replay. */
  remember(nonce: string): boolean;
  size(): number;
}

export function makeNonceStore(maxSize = 5_000, gcBatch = 1_000): NonceStore {
  const seen = new Map<string, number>();
  return {
    remember(nonce) {
      if (seen.has(nonce)) return false;
      if (seen.size > maxSize) {
        const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < gcBatch; i++) seen.delete(sorted[i][0]);
      }
      seen.set(nonce, Date.now());
      return true;
    },
    size() {
      return seen.size;
    },
  };
}

export interface HmacConfig {
  provider: HmacProvider;
  secret?: string;
  toleranceSeconds: number;
  nonceStore: NonceStore;
  /** Test seam: override "now" instead of using Date.now(). */
  now?: () => number;
}

export type HmacResult = { ok: true } | { ok: false; reason: string };

export function verifyHmac(
  cfg: HmacConfig,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): HmacResult {
  if (cfg.provider === "none") return { ok: true };
  if (!cfg.secret) return { ok: false, reason: "no_hmac_secret" };

  const now = cfg.now ? cfg.now() : Math.floor(Date.now() / 1000);

  if (cfg.provider === "stripe") {
    return verifyStripe(cfg, rawBody, headers, now);
  }
  if (cfg.provider === "github") {
    return verifyGitHub(cfg, rawBody, headers);
  }
  if (cfg.provider === "generic") {
    return verifyGeneric(cfg, rawBody, headers, now);
  }
  return { ok: false, reason: "unknown_hmac_provider" };
}

function verifyStripe(
  cfg: HmacConfig,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  now: number,
): HmacResult {
  const sig = headers["stripe-signature"];
  if (!sig) return { ok: false, reason: "missing_stripe_signature" };
  const parts = sig.split(",").reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split("=");
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed_stripe_signature" };
  if (Math.abs(now - t) > cfg.toleranceSeconds) return { ok: false, reason: "stale_signature" };
  const expected = createHmac("sha256", cfg.secret!).update(`${t}.${rawBody.toString()}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  if (!cfg.nonceStore.remember(`stripe:${t}:${v1.slice(0, 16)}`)) return { ok: false, reason: "replay" };
  return { ok: true };
}

function verifyGitHub(
  cfg: HmacConfig,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): HmacResult {
  const sig = headers["x-hub-signature-256"];
  if (!sig?.startsWith("sha256=")) return { ok: false, reason: "missing_github_signature" };
  const expected = "sha256=" + createHmac("sha256", cfg.secret!).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  const deliveryId = headers["x-github-delivery"];
  if (deliveryId && !cfg.nonceStore.remember(`github:${deliveryId}`)) return { ok: false, reason: "replay" };
  return { ok: true };
}

function verifyGeneric(
  cfg: HmacConfig,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  now: number,
): HmacResult {
  const sig = headers["x-webhook-signature"];
  const ts = Number(headers["x-webhook-timestamp"] ?? 0);
  const nonce = headers["x-webhook-nonce"];
  if (!sig || !ts || !nonce) return { ok: false, reason: "missing_signature_fields" };
  if (Math.abs(now - ts) > cfg.toleranceSeconds) return { ok: false, reason: "stale_signature" };
  const expected = createHmac("sha256", cfg.secret!).update(`${ts}.${nonce}.${rawBody.toString()}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  if (!cfg.nonceStore.remember(`generic:${nonce}`)) return { ok: false, reason: "replay" };
  return { ok: true };
}
