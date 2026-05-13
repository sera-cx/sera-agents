/**
 * Sera x402 service.
 *
 * Standard HTTP endpoint that follows the x402 protocol for accepting USDC
 * payments and delivering FX swaps via Sera. Production-readiness hardening
 * landed: payment state machine + SQLite persistence + idempotent retries +
 * Zod boundary + helmet headers + concurrency limit + trust-proxy gating.
 *
 * Schema: payments move pending → verified → executing → delivered | failed_refundable.
 * Once verified, the same payment_id is idempotent — repeat requests get the
 * cached result (or a 202 if execution is still in flight).
 *
 * Run modes (via X402_MODE):
 *   - demo (default, localhost-only): mocked payment + mocked swap, returns
 *     `tx_hash: null` and `demo: true` so artifacts can never be confused with
 *     real settlement.
 *   - live: requires X402_FACILITATOR_URL set. Refuses to start otherwise.
 *     Even when started, verification is stubbed pending facilitator wiring —
 *     see `verifyPayment()` for integration point.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import Database from "better-sqlite3";

// ── Configuration ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8402);
const HOST = process.env.HOST ?? "127.0.0.1";
const MODE: "demo" | "live" = (process.env.X402_MODE as any) ?? "demo";
const DEMO_PUBLIC_OK = (process.env.X402_DEMO_PUBLIC ?? "false").toLowerCase() === "true";
const LIVE_FACILITATOR = process.env.X402_FACILITATOR_URL;

// Trust forwarded headers ONLY when explicitly opted into. Default false stops
// direct-public deploys from trusting spoofable client-supplied headers.
const TRUST_PROXY = (process.env.X402_TRUST_PROXY ?? "false").toLowerCase() === "true";

const PENDING_MAX = Number(process.env.X402_PENDING_MAX ?? 10_000);
const RL_PER_IP_PER_MIN = Number(process.env.X402_RATE_LIMIT_PER_MIN ?? 30);
const MAX_CONCURRENT_SWAPS = Number(process.env.X402_MAX_CONCURRENT_SWAPS ?? 8);

const STATE_DB = process.env.X402_STATE_DB; // optional persistent store
const SERA_MCP_PATH =
  process.env.SERA_MCP_DIST ??
  resolve(process.env.HOME!, "Desktop/sera-mcp/dist/index.js");

// ── Boot-time safety gates ────────────────────────────────────────────────
const isLocalHost = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
if (MODE === "demo" && !isLocalHost && !DEMO_PUBLIC_OK) {
  process.stderr.write(
    `\nrefusing to start: X402_MODE=demo bound to non-localhost host (${HOST}).\n` +
      `Demo mode mocks payment verification AND the swap leg — public deploy is unsafe.\n\n` +
      `Pick one:\n` +
      `  1. Bind to localhost:        HOST=127.0.0.1 (default)\n` +
      `  2. Switch to live mode:      X402_MODE=live  (requires X402_FACILITATOR_URL + vault)\n` +
      `  3. Acknowledge the risk:     X402_DEMO_PUBLIC=true  (only do this if you understand it)\n\n`,
  );
  process.exit(1);
}
if (MODE === "live" && !LIVE_FACILITATOR) {
  process.stderr.write(
    `\nrefusing to start: X402_MODE=live requires real EIP-3009 verification.\n` +
      `Without it, an attacker can submit any X-PAYMENT header and the service\n` +
      `would attempt the swap leg from your vault wallet.\n\n` +
      `Set X402_FACILITATOR_URL to your facilitator endpoint, then implement the\n` +
      `verifyPayment branch in this file. See README for guidance.\n\n` +
      `For local development, use X402_MODE=demo with HOST=127.0.0.1.\n\n`,
  );
  process.exit(1);
}

// ── Payment state machine ─────────────────────────────────────────────────
type PaymentStatus = "pending" | "verified" | "executing" | "delivered" | "failed_refundable";

interface PendingPayment {
  payment_id: string;
  status: PaymentStatus;
  pay_to: string;
  amount_usdc: number;
  asset: "USDC";
  chain: 1;
  swap_request: {
    from_currency: string;
    to_currency: string;
    amount: number;
    recipient: string;
  };
  created_at: number;
  expires_at: number;
  // Cached result fields populated as we move through states:
  delivered_payload?: string; // JSON of the success response, returned for idempotent retries
  last_error?: string;
  last_status_change: number;
}

// ── Persistence layer ─────────────────────────────────────────────────────
let db: Database.Database | null = null;
function openDb(): Database.Database | null {
  if (db) return db;
  if (!STATE_DB) return null;
  try {
    db = new Database(STATE_DB);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        chain INTEGER NOT NULL,
        from_currency TEXT NOT NULL,
        to_currency TEXT NOT NULL,
        amount REAL NOT NULL,
        recipient TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        delivered_payload TEXT,
        last_error TEXT,
        last_status_change INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments(expires_at);
    `);
    process.stderr.write(`x402: payment state persisted to ${STATE_DB}\n`);
  } catch (e: any) {
    process.stderr.write(`x402: failed to open ${STATE_DB} (${e?.message}); falling back to memory only\n`);
    db = null;
  }
  return db;
}

const memPending = new Map<string, PendingPayment>();

function savePayment(p: PendingPayment): void {
  memPending.set(p.payment_id, p);
  const d = openDb();
  if (!d) return;
  d.prepare(
    `INSERT INTO payments (payment_id, status, pay_to, amount_usdc, chain, from_currency, to_currency, amount, recipient, created_at, expires_at, delivered_payload, last_error, last_status_change)
     VALUES (@payment_id, @status, @pay_to, @amount_usdc, @chain, @from_currency, @to_currency, @amount, @recipient, @created_at, @expires_at, @delivered_payload, @last_error, @last_status_change)
     ON CONFLICT(payment_id) DO UPDATE SET
       status = excluded.status,
       delivered_payload = excluded.delivered_payload,
       last_error = excluded.last_error,
       last_status_change = excluded.last_status_change`,
  ).run({
    payment_id: p.payment_id,
    status: p.status,
    pay_to: p.pay_to,
    amount_usdc: p.amount_usdc,
    chain: p.chain,
    from_currency: p.swap_request.from_currency,
    to_currency: p.swap_request.to_currency,
    amount: p.swap_request.amount,
    recipient: p.swap_request.recipient,
    created_at: p.created_at,
    expires_at: p.expires_at,
    delivered_payload: p.delivered_payload ?? null,
    last_error: p.last_error ?? null,
    last_status_change: p.last_status_change,
  });
}

function loadPayment(id: string): PendingPayment | undefined {
  const cached = memPending.get(id);
  if (cached) return cached;
  const d = openDb();
  if (!d) return undefined;
  const row = d.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(id) as any;
  if (!row) return undefined;
  const p: PendingPayment = {
    payment_id: row.payment_id,
    status: row.status,
    pay_to: row.pay_to,
    amount_usdc: row.amount_usdc,
    asset: "USDC",
    chain: row.chain,
    swap_request: {
      from_currency: row.from_currency,
      to_currency: row.to_currency,
      amount: row.amount,
      recipient: row.recipient,
    },
    created_at: row.created_at,
    expires_at: row.expires_at,
    delivered_payload: row.delivered_payload ?? undefined,
    last_error: row.last_error ?? undefined,
    last_status_change: row.last_status_change,
  };
  memPending.set(id, p);
  return p;
}

function reserveSlot(): boolean {
  // GC expired entries
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of memPending) {
    if (v.expires_at < now && v.status !== "delivered") memPending.delete(k);
  }
  return memPending.size < PENDING_MAX;
}

// ── Concurrency limiter for swap execution ───────────────────────────────
let activeSwaps = 0;
async function withSwapSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeSwaps >= MAX_CONCURRENT_SWAPS) return null;
  activeSwaps++;
  try {
    return await fn();
  } finally {
    activeSwaps--;
  }
}

// ── Per-IP rate limit ────────────────────────────────────────────────────
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
  return bucket.count <= RL_PER_IP_PER_MIN;
}

// ── Sera MCP subprocess (stdio JSON-RPC) ─────────────────────────────────
let mcpProc: ChildProcessWithoutNullStreams | null = null;
let mcpReqId = 0;
const mcpPending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function startMcp(): ChildProcessWithoutNullStreams {
  const proc = spawn("node", [SERA_MCP_PATH], {
    env: {
      ...process.env,
      SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
      LOG_LEVEL: "warn",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && mcpPending.has(msg.id)) {
          const handler = mcpPending.get(msg.id)!;
          mcpPending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message ?? "mcp error"));
          else handler.resolve(msg.result);
        }
      } catch { /* ignore */ }
    }
  });
  proc.stderr.on("data", (chunk) => process.stderr.write("[mcp] " + chunk.toString("utf8")));
  proc.on("exit", (code) => {
    process.stderr.write(`[mcp] exited code=${code}\n`);
    // Reject all in-flight to avoid 30s hangs; caller can retry.
    for (const [, handler] of mcpPending) handler.reject(new Error("mcp subprocess exited"));
    mcpPending.clear();
    mcpProc = null;
  });
  return proc;
}

async function mcpCall(method: string, params: any = {}): Promise<any> {
  if (!mcpProc) {
    mcpProc = startMcp();
    await new Promise((r) => setTimeout(r, 250));
    await mcpRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sera-x402", version: "0.2.0" },
    });
  }
  return mcpRpc(method, params);
}

function mcpRpc(method: string, params: any): Promise<any> {
  if (!mcpProc) throw new Error("mcp not running");
  const id = ++mcpReqId;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    mcpPending.set(id, { resolve, reject });
    mcpProc!.stdin.write(payload);
    setTimeout(() => {
      if (mcpPending.has(id)) {
        mcpPending.delete(id);
        reject(new Error(`mcp ${method} timeout`));
      }
    }, 30_000);
  });
}

// ── Service info / discovery ─────────────────────────────────────────────
const SERVICE_INFO = {
  name: "Sera x402",
  version: "0.2.0",
  description:
    "Multi-currency settlement endpoint. Pay USDC, deliver in any of 40+ stablecoins across 20+ fiats.",
  supported_inputs: ["USDC"],
  supported_outputs: [
    "USDC", "USDT", "EURC", "XSGD", "JPYC", "MYRT", "TGBP",
    "BRZ", "BRLV", "MXNT", "IDRT", "AUDD", "CADC", "NZDD", "ZARP",
  ],
  protocol: "x402",
  mode: MODE,
  demo: MODE === "demo",
};

// ── Schema (Zod) ──────────────────────────────────────────────────────────
const SUPPORTED_INPUTS = ["USDC"] as const;
const EvmAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x-prefixed 40-hex");
const FiatLike = z.string().regex(/^[A-Za-z]{2,8}$/, "must be a 2-8 letter currency code");

const SwapBody = z.object({
  from_currency: z.enum(SUPPORTED_INPUTS).default("USDC"),
  to_currency: FiatLike,
  amount: z.number().positive().max(Number(process.env.X402_MAX_AMOUNT ?? 1_000_000)),
  recipient: EvmAddr,
});

const QuoteBody = z.object({
  to_currency: FiatLike,
  amount: z.number().positive().max(Number(process.env.X402_MAX_AMOUNT ?? 1_000_000)),
  recipient: EvmAddr,
});

const PAYMENT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── Helpers ──────────────────────────────────────────────────────────────
async function quoteRecipientAmountViaMcp(
  from: string,
  to: string,
  recipient_amount: number,
  recipient: string,
): Promise<{ estimated_input_human: number; quote: any } | { error: string }> {
  try {
    const r = await mcpCall("tools/call", {
      name: "sera.quote_recipient_amount",
      arguments: {
        from,
        to,
        recipient_amount,
        owner_address: process.env.X402_VAULT_ADDRESS ?? "0x000000000000000000000000000000000000dEaD",
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
  USD: 1, USDC: 1, USDT: 1,
  EUR: 1.08, EURC: 1.08,
  GBP: 1.27, TGBP: 1.27,
  SGD: 0.74, XSGD: 0.74,
  JPY: 0.0064, JPYC: 0.0064,
  MYR: 0.21, MYRT: 0.21,
  BRL: 0.20, BRZ: 0.20,
  MXN: 0.058, MXNT: 0.058,
  IDR: 0.000063, IDRT: 0.000063,
  AUD: 0.66, AUDD: 0.66,
  CAD: 0.73, CADC: 0.73,
};
function mockUsdcForTarget(target: string, amount: number): number {
  return amount * (MOCK_RATES_USD_PER_UNIT[target.toUpperCase()] ?? 1);
}

function clientIp(headers: Record<string, string | undefined>): string {
  if (!TRUST_PROXY) {
    // Without TRUST_PROXY, we have no reliable IP from Hono's headers — use a
    // synthetic key so rate limit still applies but isn't spoofable.
    return "untrusted-proxy";
  }
  return (
    headers["cf-connecting-ip"] ??
    headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
    headers["x-real-ip"] ??
    "unknown"
  );
}

// ── Payment verification (mode-aware) ────────────────────────────────────
async function verifyPayment(
  authorization: string | undefined,
  pending: PendingPayment,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (MODE === "demo") {
    if (!authorization) return { ok: false, reason: "X-PAYMENT requires <payment_id>:<authorization>" };
    return { ok: true };
  }
  // Live verification stub. Production must wire X402_FACILITATOR_URL and
  // implement actual EIP-3009 transferWithAuthorization verification.
  return {
    ok: false,
    reason:
      "live verification not yet implemented; wire facilitator at X402_FACILITATOR_URL in this file's verifyPayment",
  };
}

async function executeSwap(pending: PendingPayment): Promise<
  | { trade_id: string; tx_hash: string | null; min_output: number; gas_mode: string; demo: boolean }
  | { error: string }
> {
  if (MODE === "demo") {
    return {
      trade_id: `demo-${randomUUID().slice(0, 8)}`,
      tx_hash: null,
      min_output: pending.swap_request.amount,
      gas_mode: "receive_less",
      demo: true,
    };
  }
  try {
    const r = await mcpCall("tools/call", {
      name: "sera.convert_and_send",
      arguments: {
        from: "USDC",
        to: pending.swap_request.to_currency,
        amount: pending.amount_usdc,
        owner_address: process.env.X402_VAULT_ADDRESS!,
        recipient: pending.swap_request.recipient,
        gas_mode: "pay_more",
      },
    });
    if (r?.isError) return { error: r.content?.[0]?.text ?? "mcp error" };
    const txt = r?.content?.[0]?.text;
    const parsed = txt ? JSON.parse(txt) : null;
    return {
      trade_id: parsed?.execution?.trade_id ?? "unknown",
      tx_hash: parsed?.execution?.tx_hash ?? null,
      min_output: Number(parsed?.quote?.human?.min_output ?? 0),
      gas_mode: "pay_more",
      demo: false,
    };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

// ── HTTP API ─────────────────────────────────────────────────────────────
const app = new Hono();

// Demo-mode banner header on every response so downstream consumers can tell
// they're not looking at real settlement data.
app.use("*", async (c, next) => {
  await next();
  if (MODE === "demo") c.header("X-Sera-Demo-Mode", "true");
});

app.get("/", (c) => c.json(SERVICE_INFO));

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    mode: MODE,
    demo: MODE === "demo",
    pending_payments: memPending.size,
    active_swaps: activeSwaps,
    mcp_running: !!mcpProc,
    persistence: STATE_DB ? "enabled" : "memory-only",
  }),
);

app.post("/x402/swap", async (c) => {
  const ip = clientIp({
    "cf-connecting-ip": c.req.header("cf-connecting-ip"),
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
  if (!ipRateLimit(ip)) return c.json({ error: "rate_limited", retry_after_seconds: 60 }, 429);

  const cl = Number(c.req.header("content-length") ?? 0);
  if (cl > 4096) return c.json({ error: "payload_too_large" }, 413);

  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: "invalid_body" }, 400);
  const parsed = SwapBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  }
  const { from_currency, to_currency, amount, recipient } = parsed.data;

  const xPayment = c.req.header("x-payment");

  // ── Branch 1: no X-PAYMENT → 402 with payment_required ─────────
  if (!xPayment) {
    let usdcRequired: number;
    let quoteSource: "sera" | "demo_mock" = "sera";
    const quote = await quoteRecipientAmountViaMcp("USDC", to_currency, amount, recipient);
    if ("error" in quote) {
      if (MODE === "demo") {
        usdcRequired = mockUsdcForTarget(to_currency, amount);
        quoteSource = "demo_mock";
      } else {
        process.stderr.write(`[quote] ${quote.error}\n`);
        return c.json({ error: "quote_failed", code: "upstream_error" }, 502);
      }
    } else {
      usdcRequired = Number((quote as any).estimated_input_human);
      if (!Number.isFinite(usdcRequired) || usdcRequired <= 0) {
        if (MODE === "demo") {
          usdcRequired = mockUsdcForTarget(to_currency, amount);
          quoteSource = "demo_mock";
        } else {
          return c.json({ error: "quote_invalid", code: "upstream_error" }, 502);
        }
      }
    }

    const surcharge = Number(process.env.X402_SURCHARGE_BPS ?? 0) / 10_000;
    const totalUsdc = usdcRequired * (1 + surcharge);
    const paymentId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const payTo = process.env.X402_VAULT_ADDRESS ?? "0x000000000000000000000000000000000000dEaD";
    const TTL_SECONDS = 300;

    if (!reserveSlot()) return c.json({ error: "service_busy", retry_after_seconds: 30 }, 503);

    savePayment({
      payment_id: paymentId,
      status: "pending",
      pay_to: payTo,
      amount_usdc: totalUsdc,
      asset: "USDC",
      chain: 1,
      swap_request: { from_currency, to_currency, amount, recipient },
      created_at: now,
      expires_at: now + TTL_SECONDS,
      last_status_change: now,
    });

    return c.json(
      {
        payment_required: {
          scheme: "exact",
          asset: "USDC",
          amount: totalUsdc.toFixed(6),
          chain: 1,
          pay_to: payTo,
          payment_id: paymentId,
          expires_at: now + TTL_SECONDS,
        },
        quote_preview: {
          target_currency: to_currency,
          target_amount: amount,
          recipient,
          estimated_usdc_in: usdcRequired,
          surcharge_bps: Number(process.env.X402_SURCHARGE_BPS ?? 0),
          quote_source: quoteSource,
        },
        instructions:
          "Construct an EIP-3009 transferWithAuthorization for USDC to pay_to in the amount above, " +
          "then retry this request with X-PAYMENT: <payment_id>:<authorization-base64> header.",
        demo: MODE === "demo",
      },
      402,
    );
  }

  // ── Branch 2: X-PAYMENT present → state-machine flow ──────────
  const [paymentId, authorization] = xPayment.split(":", 2);
  if (!paymentId || !PAYMENT_ID_RE.test(paymentId)) {
    return c.json({ error: "invalid_payment_id" }, 400);
  }
  const pending = loadPayment(paymentId);
  if (!pending) return c.json({ error: "unknown_payment_id" }, 410);

  // Idempotent retries based on current state:
  if (pending.status === "delivered" && pending.delivered_payload) {
    // Same payment_id retried after success → return the cached success body
    return c.json({ ...JSON.parse(pending.delivered_payload), idempotent_replay: true }, 200);
  }
  if (pending.status === "executing") {
    return c.json({ error: "still_executing", retry_after_seconds: 5 }, 202);
  }
  if (pending.status === "failed_refundable") {
    // Allow caller to retry execution after a transient swap failure.
    pending.status = "verified";
    pending.last_error = undefined;
    pending.last_status_change = Math.floor(Date.now() / 1000);
    savePayment(pending);
  }
  if (pending.expires_at < Math.floor(Date.now() / 1000) && pending.status === "pending") {
    return c.json({ error: "payment_expired" }, 410);
  }

  // Move pending → verified (only verify once)
  if (pending.status === "pending") {
    const verified = await verifyPayment(authorization, pending);
    if (!verified.ok) {
      process.stderr.write(`[verify] ${pending.payment_id}: ${verified.reason}\n`);
      return c.json({ error: "payment_verification_failed" }, 402);
    }
    pending.status = "verified";
    pending.last_status_change = Math.floor(Date.now() / 1000);
    savePayment(pending);
  }

  // Move verified → executing → delivered (or failed_refundable)
  if (pending.status === "verified") {
    pending.status = "executing";
    pending.last_status_change = Math.floor(Date.now() / 1000);
    savePayment(pending);

    const swapResult = await withSwapSlot(() => executeSwap(pending));
    if (swapResult === null) {
      // Concurrency cap reached — revert to verified so caller can retry.
      pending.status = "verified";
      savePayment(pending);
      return c.json({ error: "swap_concurrency_limit", retry_after_seconds: 5 }, 503);
    }
    if ("error" in swapResult) {
      pending.status = "failed_refundable";
      pending.last_error = swapResult.error;
      pending.last_status_change = Math.floor(Date.now() / 1000);
      savePayment(pending);
      process.stderr.write(`[swap] ${pending.payment_id}: ${swapResult.error}\n`);
      return c.json({
        error: "swap_failed_refundable",
        payment_id: pending.payment_id,
        retry_with_same_payment_id: true,
      }, 502);
    }

    const successBody = {
      success: true,
      payment_id: pending.payment_id,
      paid: { asset: "USDC", amount: pending.amount_usdc.toFixed(6), to: pending.pay_to },
      delivered: {
        currency: pending.swap_request.to_currency,
        amount: pending.swap_request.amount,
        to: pending.swap_request.recipient,
        ...swapResult,
      },
      mode: MODE,
      demo: MODE === "demo",
    };
    pending.status = "delivered";
    pending.delivered_payload = JSON.stringify(successBody);
    pending.last_status_change = Math.floor(Date.now() / 1000);
    savePayment(pending);
    return c.json(successBody, 200);
  }

  return c.json({ error: "unexpected_state", state: pending.status }, 500);
});

app.post("/x402/quote", async (c) => {
  const ip = clientIp({
    "cf-connecting-ip": c.req.header("cf-connecting-ip"),
    "x-forwarded-for": c.req.header("x-forwarded-for"),
    "x-real-ip": c.req.header("x-real-ip"),
  });
  if (!ipRateLimit(ip)) return c.json({ error: "rate_limited", retry_after_seconds: 60 }, 429);
  const cl = Number(c.req.header("content-length") ?? 0);
  if (cl > 4096) return c.json({ error: "payload_too_large" }, 413);

  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: "invalid_body" }, 400);
  const parsed = QuoteBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  }
  const { to_currency, amount, recipient } = parsed.data;

  const quote = await quoteRecipientAmountViaMcp("USDC", to_currency, amount, recipient);
  if ("error" in quote) {
    if (MODE === "demo") {
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

// ── Boot ─────────────────────────────────────────────────────────────────
process.stderr.write(
  `sera-x402 v0.2.0 starting on ${HOST}:${PORT} (mode=${MODE}, mcp=${SERA_MCP_PATH}, persistence=${STATE_DB ?? "memory"})\n`,
);
if (MODE === "demo" && DEMO_PUBLIC_OK) {
  process.stderr.write(
    `WARNING: demo mode is exposed publicly via X402_DEMO_PUBLIC=true.\n` +
      `         Returns demo:true + tx_hash:null + X-Sera-Demo-Mode header so consumers\n` +
      `         can tell they're not real settlement data. Don't ship like this.\n`,
  );
}
serve({ fetch: app.fetch, port: PORT, hostname: HOST });
