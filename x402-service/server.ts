/**
 * Sera x402 service — HTTP layer.
 *
 * Dynamic FX delivery flow:
 *   1. Client → POST /x402/swap with target {to_currency, amount, recipient}.
 *   2. Service quotes recipient amount via sera-mcp, returns 402 Payment Required
 *      with the USDC amount the client must pay and a payment_id.
 *   3. Client signs EIP-3009 transferWithAuthorization for USDC; re-POSTs with
 *      X-PAYMENT: <payment_id>:<authorization>.
 *   4. Service:
 *        a. Loads pending state by payment_id (atomic).
 *        b. Calls facilitator /verify (live) or short-circuits (demo).
 *        c. CAS: pending → verified. If already moved, idempotent path.
 *        d. Calls facilitator /settle to broadcast the payment tx.
 *        e. CAS: verified → executing.
 *        f. Calls sera.convert_and_send via MCP subprocess.
 *        g. CAS: executing → delivered (or failed_refundable on swap fail).
 *   5. Response includes settlement metadata (tx_hash, networkId).
 *
 * Idempotency: the CAS-based store ensures a re-submitted X-PAYMENT for a
 * payment_id already in `delivered` returns the cached success body. This
 * mitigates Attack II (replay/idempotency) from arXiv:2605.11781.
 *
 * Cache-Control: no-store on every /x402/* route to prevent the CDN-cache
 * leak (Attack III).
 *
 * See SECURITY-MODEL.md for the full hardening checklist + threat-model
 * coverage matrix.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";

import { loadConfig } from "./env.js";
import {
  confirmPayment,
  executeSwap,
  settlePayment,
  transitionToDelivered,
  transitionToExecuting,
  transitionToFailedRefundable,
  transitionToSettleFailed,
  transitionToVerified,
  verifyPayment,
} from "./payment.js";
import { makeSeraMcpClient } from "./sera-client.js";
import { makeStore, type PendingPayment } from "./state.js";

const cfg = loadConfig();
const store = makeStore(cfg.stateDb);
const mcp = makeSeraMcpClient({
  mcpPath: cfg.seraMcpPath,
  network: process.env.SERA_NETWORK,
  policyPreset: process.env.POLICY_PRESET,
  signerMode: process.env.SERA_SIGNER_MODE,
  apiKey: process.env.SERA_API_KEY,
  apiSecret: process.env.SERA_API_SECRET,
  signerPrivateKey: process.env.SIGNER_PRIVATE_KEY,
});

// ── Concurrency limiter for swap execution ──────────────────────────────
let activeSwaps = 0;
async function withSwapSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeSwaps >= cfg.maxConcurrentSwaps) return null;
  activeSwaps++;
  try {
    return await fn();
  } finally {
    activeSwaps--;
  }
}

// ── Per-IP rate limit ───────────────────────────────────────────────────
const ipBuckets = new Map<string, { count: number; windowStart: number }>();
function ipRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > 60_000) {
    ipBuckets.set(ip, { count: 1, windowStart: now });
    if (ipBuckets.size > 10_000) {
      for (const [k, v] of ipBuckets) {
        if (now - v.windowStart > 60_000) ipBuckets.delete(k);
      }
    }
    return true;
  }
  bucket.count++;
  return bucket.count <= cfg.rateLimitPerMin;
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  if (!cfg.trustProxy) return "untrusted-proxy";
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────
/** Strip CR/LF so upstream-controlled text can't forge log lines. */
function sanitizeForLog(text: string): string {
  return text.replace(/[\r\n]+/g, " ").slice(0, 300);
}

async function quoteRecipientAmountViaMcp(
  to: string,
  recipient_amount: number,
  recipient: string,
): Promise<{ estimated_input_human: number } | { error: string }> {
  try {
    const r = await mcp.call("tools/call", {
      name: "sera.quote_recipient_amount",
      arguments: {
        from: "USDC",
        to,
        recipient_amount,
        owner_address: cfg.vaultAddress ?? "0x000000000000000000000000000000000000dEaD",
        recipient,
      },
    });
    if (r?.isError) return { error: r.content?.[0]?.text ?? "mcp error" };
    const txt = r?.content?.[0]?.text;
    const parsed = txt ? JSON.parse(txt) : null;
    if (!parsed) return { error: "mcp returned no content" };
    return parsed;
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

const MOCK_RATES_USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  USDC: 1,
  USDT: 1,
  EUR: 1.08,
  EURC: 1.08,
  GBP: 1.27,
  TGBP: 1.27,
  SGD: 0.74,
  XSGD: 0.74,
  JPY: 0.0064,
  JPYC: 0.0064,
  MYR: 0.21,
  MYRT: 0.21,
};
function mockUsdcForTarget(target: string, amount: number): number {
  return amount * (MOCK_RATES_USD_PER_UNIT[target.toUpperCase()] ?? 1);
}

// ── Schemas ────────────────────────────────────────────────────────────
const SUPPORTED_INPUTS = ["USDC"] as const;
const EvmAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x-prefixed 40-hex");
const FiatLike = z.string().regex(/^[A-Za-z]{2,8}$/, "must be a 2-8 letter currency code");

const SwapBody = z.object({
  from_currency: z.enum(SUPPORTED_INPUTS).default("USDC"),
  to_currency: FiatLike,
  amount: z.number().positive().max(cfg.maxAmount),
  recipient: EvmAddr,
});

const QuoteBody = z.object({
  to_currency: FiatLike,
  amount: z.number().positive().max(cfg.maxAmount),
  recipient: EvmAddr,
});

const PAYMENT_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── Service info ───────────────────────────────────────────────────────
const SERVICE_INFO = {
  name: "Sera x402",
  version: "0.3.0",
  description:
    "Dynamic FX delivery via x402. Pay USDC, deliver in any of 40+ stablecoins across 20+ fiats.",
  supported_inputs: ["USDC"],
  supported_outputs: [
    "USDC",
    "USDT",
    "EURC",
    "XSGD",
    "JPYC",
    "MYRT",
    "TGBP",
    "BRZ",
    "BRLV",
    "MXNT",
    "IDRT",
    "AUDD",
    "CADC",
    "NZDD",
    "ZARP",
  ],
  protocol: "x402",
  mode: cfg.mode,
  demo: cfg.mode === "demo",
  network: cfg.cdpNetwork,
};

// ── HTTP ───────────────────────────────────────────────────────────────
const app = new Hono();

// Demo-mode banner header so consumers can't confuse demo with real settlement.
app.use("*", async (c, next) => {
  await next();
  if (cfg.mode === "demo") c.header("X-Sera-Demo-Mode", "true");
});

// Cache-Control: no-store on every /x402/* route. Mitigates Attack III
// (CDN cache leak) from arXiv:2605.11781 — proxies/CDNs would otherwise
// cache the 200 paid-content response and serve it to subsequent unpaid clients.
app.use("/x402/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, no-cache, private");
  c.header("Pragma", "no-cache");
});

app.get("/", (c) => c.json(SERVICE_INFO));

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    mode: cfg.mode,
    demo: cfg.mode === "demo",
    pending_payments: store.size(),
    active_swaps: activeSwaps,
    mcp_running: mcp.running(),
    persistence: cfg.stateDb ? "enabled" : "memory-only",
    facilitator_configured: !!cfg.facilitatorUrl,
  }),
);

// Constant-time string compare (SHA-256 then timingSafeEqual on equal-length
// digests) so a token check can't leak match length via response timing.
function timingSafeStrEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

// Operator-only: list payments stuck in failed_refundable. Gate behind a
// simple bearer header so this isn't public.
app.get("/admin/refundables", (c) => {
  const adminToken = process.env.X402_ADMIN_TOKEN;
  if (!adminToken) return c.json({ error: "admin disabled (X402_ADMIN_TOKEN not set)" }, 503);
  const auth = c.req.header("authorization") ?? "";
  if (!timingSafeStrEqual(auth, `Bearer ${adminToken}`)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  return c.json({ items: store.listFailedRefundable(limit) });
});

// POST /x402/swap — main flow.
app.post("/x402/swap", async (c) => {
  const ip = clientIp(c);
  if (!ipRateLimit(ip)) return c.json({ error: "rate_limited", retry_after_seconds: 60 }, 429);

  const cl = Number(c.req.header("content-length") ?? 0);
  if (cl > 4096) return c.json({ error: "payload_too_large" }, 413);

  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: "invalid_body" }, 400);
  const parsed = SwapBody.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const { from_currency, to_currency, amount, recipient } = parsed.data;
  const xPayment = c.req.header("x-payment");

  // ── Branch 1: no X-PAYMENT → 402 with payment_required ─────────
  if (!xPayment) {
    let usdcRequired: number;
    let quoteSource: "sera" | "demo_mock" = "sera";
    const quote = await quoteRecipientAmountViaMcp(to_currency, amount, recipient);
    if ("error" in quote) {
      if (cfg.mode === "demo") {
        usdcRequired = mockUsdcForTarget(to_currency, amount);
        quoteSource = "demo_mock";
      } else {
        process.stderr.write(`[quote] ${quote.error}\n`);
        return c.json({ error: "quote_failed", code: "upstream_error" }, 502);
      }
    } else {
      usdcRequired = Number((quote as any).estimated_input_human);
      if (!Number.isFinite(usdcRequired) || usdcRequired <= 0) {
        if (cfg.mode === "demo") {
          usdcRequired = mockUsdcForTarget(to_currency, amount);
          quoteSource = "demo_mock";
        } else {
          return c.json({ error: "quote_invalid", code: "upstream_error" }, 502);
        }
      }
    }

    const surcharge = cfg.surchargeBps / 10_000;
    const totalUsdc = usdcRequired * (1 + surcharge);
    const paymentId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const payTo = cfg.vaultAddress ?? "0x000000000000000000000000000000000000dEaD";

    store.gcExpired(now);
    if (store.size() >= cfg.pendingMax) {
      return c.json({ error: "service_busy", retry_after_seconds: 30 }, 503);
    }

    const pending: PendingPayment = {
      payment_id: paymentId,
      status: "pending",
      pay_to: payTo,
      amount_usdc: totalUsdc,
      asset: "USDC",
      chain: 1,
      swap_request: { from_currency, to_currency, amount, recipient },
      created_at: now,
      expires_at: now + cfg.pendingTtlSeconds,
      last_status_change: now,
    };
    store.save(pending);

    return c.json(
      {
        payment_required: {
          scheme: "exact",
          asset: "USDC",
          amount: totalUsdc.toFixed(6),
          chain: 1,
          network: cfg.cdpNetwork,
          pay_to: payTo,
          payment_id: paymentId,
          expires_at: now + cfg.pendingTtlSeconds,
        },
        quote_preview: {
          target_currency: to_currency,
          target_amount: amount,
          recipient,
          estimated_usdc_in: usdcRequired,
          surcharge_bps: cfg.surchargeBps,
          quote_source: quoteSource,
        },
        instructions:
          "Construct an EIP-3009 transferWithAuthorization for USDC to pay_to in the amount above, " +
          "then retry this request with X-PAYMENT: <payment_id>:<authorization-base64> header.",
        demo: cfg.mode === "demo",
      },
      402,
    );
  }

  // ── Branch 2: X-PAYMENT present → state-machine flow ──────────
  const [paymentId, authorization] = xPayment.split(":", 2);
  if (!paymentId || !PAYMENT_ID_RE.test(paymentId)) {
    return c.json({ error: "invalid_payment_id" }, 400);
  }
  const pending = store.load(paymentId);
  if (!pending) return c.json({ error: "unknown_payment_id" }, 410);

  // Idempotent paths based on current state:
  if (pending.status === "delivered" && pending.delivered_payload) {
    return c.json({ ...JSON.parse(pending.delivered_payload), idempotent_replay: true }, 200);
  }
  if (pending.status === "executing") {
    return c.json({ error: "still_executing", retry_after_seconds: 5 }, 202);
  }
  if (pending.status === "settle_failed") {
    // Terminal: facilitator /settle failed, no USDC was charged. Idempotent
    // clean response on retry (not a 500, not a refund case).
    return c.json({ error: "settle_failed", payment_id: pending.payment_id, charged: false }, 409);
  }
  if (pending.status === "failed_refundable") {
    // Failure is terminal at the HTTP layer. Operators see these via
    // /admin/refundables. We do NOT auto-revert to executing — the swap
    // failed for a reason; manual investigation required.
    return c.json(
      {
        error: "swap_failed_refundable",
        payment_id: pending.payment_id,
        message: "Swap failed after payment settled. Contact operator for refund.",
        last_error: pending.last_error,
      },
      502,
    );
  }
  if (pending.expires_at < Math.floor(Date.now() / 1000) && pending.status === "pending") {
    return c.json({ error: "payment_expired" }, 410);
  }

  // ── pending → verified (verify + settle BEFORE releasing service) ──
  if (pending.status === "pending") {
    const verifyResult = await verifyPayment(cfg, pending, authorization ?? "");
    if (!verifyResult.ok) {
      process.stderr.write(`[verify] ${pending.payment_id}: ${verifyResult.reason}\n`);
      return c.json({ error: "payment_verification_failed", reason: verifyResult.reason }, 402);
    }
    // Atomic state transition. ONLY the request that wins pending→verified may
    // settle — a CAS loser must never call the facilitator /settle again. (That,
    // combined with the non-atomic full-row write this replaces, previously let a
    // duplicate concurrent submission regress the state machine and execute the
    // swap twice.) On CAS loss, reload and return an idempotent/retry response
    // WITHOUT settling; the winning request owns settle + execute.
    if (!transitionToVerified(store, pending)) {
      const fresh = store.load(paymentId);
      if (fresh?.status === "delivered" && fresh.delivered_payload) {
        return c.json({ ...JSON.parse(fresh.delivered_payload), idempotent_replay: true }, 200);
      }
      if (fresh?.status === "settle_failed") {
        return c.json({ error: "settle_failed", payment_id: paymentId, charged: false }, 409);
      }
      if (fresh?.status === "failed_refundable") {
        return c.json(
          {
            error: "swap_failed_refundable",
            payment_id: paymentId,
            message: "Swap failed after payment settled. Contact operator for refund.",
            last_error: fresh?.last_error,
          },
          502,
        );
      }
      // executing, or verified (winner mid-flight) → retry; never settle here.
      return c.json({ error: "still_executing", retry_after_seconds: 5 }, 202);
    }
    // Settle BEFORE releasing service (two-phase). In demo mode this is a no-op.
    const settleResult = await settlePayment(cfg, pending, authorization ?? "");
    if (!settleResult.ok) {
      // Settle failed after verify: no USDC was charged, so this is NOT a
      // refund case — mark it terminal `settle_failed` in a single CAS from
      // `verified` (never touches a concurrently-executing payment).
      transitionToSettleFailed(
        store,
        pending,
        sanitizeForLog(settleResult.reason ?? "settle failed"),
      );
      process.stderr.write(
        `[settle] ${pending.payment_id}: failed (no charge): ${sanitizeForLog(settleResult.reason ?? "")}\n`,
      );
      return c.json(
        { error: "settle_failed", payment_id: pending.payment_id, charged: false },
        502,
      );
    }
    // Persist the settlement payload atomically: a status-conditional CAS that
    // writes settlement_payload only while still `verified`, so it can never
    // rewind a concurrently executing/delivered row or blank delivered_payload
    // (the previous full-row store.save did exactly that).
    store.cas(pending.payment_id, "verified", "verified", {
      settlement_payload: JSON.stringify(settleResult),
    });
  }

  // ── verified → executing → delivered (or failed_refundable) ────────
  const current = store.load(paymentId);
  if (!current) return c.json({ error: "lost_state" }, 500);

  if (current.status === "verified") {
    // ── On-chain confirmation gate (verified → executing edge) ─────────
    // The facilitator said the payment settled; independently confirm the
    // USDC actually landed in the vault before releasing any FX. Sits on
    // this edge so a payment that hasn't confirmed yet stays `verified` and
    // every client retry re-checks — a lying facilitator can never push a
    // payment past this point. Pure read; safe to repeat.
    let settleTxHash: string | undefined;
    try {
      settleTxHash = current.settlement_payload
        ? (JSON.parse(current.settlement_payload) as { txHash?: string }).txHash
        : undefined;
    } catch {
      settleTxHash = undefined;
    }
    const confirmResult = await confirmPayment(cfg, current, settleTxHash, authorization ?? "");
    if (!confirmResult.ok) {
      // Detail stays server-side; clients get a generic retriable signal.
      process.stderr.write(
        `[confirm] ${current.payment_id}: not confirmed on-chain yet: ${sanitizeForLog(confirmResult.reason ?? "")}\n`,
      );
      return c.json(
        {
          error: "payment_not_confirmed_onchain",
          payment_id: current.payment_id,
          retry_after_seconds: 10,
        },
        202,
      );
    }
    // Anti-replay: one on-chain settle tx authorizes at most one delivery.
    // Atomic claim (idempotent for retries of this same payment). Skipped
    // only when no real confirm ran (demo / explicit opt-out => no txHash).
    if (settleTxHash && !store.claimTx(settleTxHash, current.payment_id)) {
      process.stderr.write(
        `[confirm] ${current.payment_id}: settle tx already consumed by another payment — refusing\n`,
      );
      return c.json({ error: "payment_proof_already_used", payment_id: current.payment_id }, 402);
    }

    if (!transitionToExecuting(store, current)) {
      // Another concurrent request already moved it.
      const fresh = store.load(paymentId);
      if (fresh?.status === "delivered" && fresh.delivered_payload) {
        return c.json({ ...JSON.parse(fresh.delivered_payload), idempotent_replay: true }, 200);
      }
      return c.json({ error: "concurrent_execution", retry_after_seconds: 5 }, 202);
    }

    const swapResult = await withSwapSlot(() => executeSwap(cfg, mcp, current));
    if (swapResult === null) {
      // Concurrency cap reached AFTER we CAS'd to executing. Revert.
      store.cas(current.payment_id, "executing", "verified");
      return c.json({ error: "swap_concurrency_limit", retry_after_seconds: 5 }, 503);
    }
    if (swapResult.error) {
      transitionToFailedRefundable(store, current, swapResult.error);
      process.stderr.write(`[swap] ${current.payment_id}: ${swapResult.error}\n`);
      return c.json(
        {
          error: "swap_failed_refundable",
          payment_id: current.payment_id,
          message: "Payment settled; swap failed. Operator will process refund.",
        },
        502,
      );
    }

    const successBody = {
      success: true,
      payment_id: current.payment_id,
      paid: { asset: "USDC", amount: current.amount_usdc.toFixed(6), to: current.pay_to },
      delivered: {
        currency: current.swap_request.to_currency,
        amount: current.swap_request.amount,
        to: current.swap_request.recipient,
        ...swapResult,
      },
      settlement: current.settlement_payload ? JSON.parse(current.settlement_payload) : null,
      mode: cfg.mode,
      demo: cfg.mode === "demo",
    };
    transitionToDelivered(
      store,
      current,
      JSON.stringify(successBody),
      current.settlement_payload ?? "{}",
    );
    return c.json(successBody, 200);
  }

  return c.json({ error: "unexpected_state", state: current.status }, 500);
});

// POST /x402/quote — preview the USDC cost without committing.
app.post("/x402/quote", async (c) => {
  const ip = clientIp(c);
  if (!ipRateLimit(ip)) return c.json({ error: "rate_limited", retry_after_seconds: 60 }, 429);
  const cl = Number(c.req.header("content-length") ?? 0);
  if (cl > 4096) return c.json({ error: "payload_too_large" }, 413);

  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: "invalid_body" }, 400);
  const parsed = QuoteBody.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const { to_currency, amount, recipient } = parsed.data;
  const quote = await quoteRecipientAmountViaMcp(to_currency, amount, recipient);
  if ("error" in quote) {
    if (cfg.mode === "demo") {
      return c.json({
        target_currency: to_currency,
        target_amount: amount,
        recipient,
        estimated_usdc_in: mockUsdcForTarget(to_currency, amount),
        quote_source: "demo_mock",
        demo: true,
      });
    }
    process.stderr.write(`[quote] ${quote.error}\n`);
    return c.json({ error: "quote_failed", code: "upstream_error" }, 502);
  }
  return c.json({
    target_currency: to_currency,
    target_amount: amount,
    recipient,
    estimated_usdc_in: Number((quote as any).estimated_input_human),
    quote_source: "sera",
    demo: false,
  });
});

// ── Boot ────────────────────────────────────────────────────────────────
process.stderr.write(
  `sera-x402 v0.3.0 starting on ${cfg.host}:${cfg.port} ` +
    `(mode=${cfg.mode}, network=${cfg.cdpNetwork}, mcp=${cfg.seraMcpPath}, ` +
    `persistence=${cfg.stateDb ?? "memory"})\n`,
);
if (cfg.mode === "demo" && cfg.demoPublicOk) {
  process.stderr.write(
    `WARNING: demo mode is exposed publicly via X402_DEMO_PUBLIC=true.\n` +
      `         Returns demo:true + tx_hash:null + X-Sera-Demo-Mode header so consumers\n` +
      `         can tell they're not real settlement data. Don't ship like this.\n`,
  );
}
if (cfg.mode === "live") {
  process.stderr.write(
    `LIVE MODE: facilitator=${cfg.facilitatorUrl} network=${cfg.cdpNetwork} ` +
      `confirmation_depth=${cfg.confirmationDepth}.\n` +
      `Live wiring is in place but NOT YET production-verified against Coinbase mainnet.\n` +
      `Per SECURITY-MODEL.md, complete Base Sepolia E2E before mainnet.\n`,
  );
}
serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host });
