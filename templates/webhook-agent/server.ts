/**
 * Template: webhook-agent.
 *
 * Express endpoint that triggers a Sera-MCP-using agent in response to an
 * incoming HTTP event. Hardened defaults:
 *   - WEBHOOK_SECRET required (or explicit loopback opt-in)
 *   - Constant-time bearer comparison
 *   - Optional provider HMAC verification (Stripe, GitHub, generic)
 *   - Replay protection (timestamp tolerance + nonce LRU)
 *   - Helmet headers
 *   - Body cap 32kb
 *   - Per-IP rate limit (only honored behind a configured trusted proxy)
 *   - Concurrency limit on agent runs
 *   - Allowlisted task mapper — replace with your own once you know the schema
 */
import { Agent, run, MCPServerStdio, user } from "@openai/agents";
import express from "express";
import { resolve } from "node:path";
import { timingSafeEqual, createHmac } from "node:crypto";
import helmet from "helmet";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ALLOW_NO_AUTH = (process.env.WEBHOOK_ALLOW_NO_AUTH ?? "false").toLowerCase() === "true";
const TRUST_PROXY = (process.env.WEBHOOK_TRUST_PROXY ?? "false").toLowerCase() === "true";

// Optional HMAC verification — set the right one for your provider.
//   stripe → Stripe-Signature header, secret = whsec_...
//   github → X-Hub-Signature-256 header, secret = your repo secret
//   generic → X-Webhook-Signature header (sha256 of body)
const HMAC_PROVIDER = (process.env.WEBHOOK_HMAC_PROVIDER ?? "none").toLowerCase() as
  | "none" | "stripe" | "github" | "generic";
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET;
const HMAC_TOLERANCE_SECONDS = Number(process.env.WEBHOOK_HMAC_TOLERANCE_SECONDS ?? 300);

const MAX_CONCURRENT = Number(process.env.WEBHOOK_MAX_CONCURRENT ?? 4);
const RL_PER_IP_PER_MIN = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN ?? 60);

if (!WEBHOOK_SECRET && !ALLOW_NO_AUTH) {
  process.stderr.write(
    `\nrefusing to start: WEBHOOK_SECRET not set.\n` +
      `This endpoint runs an LLM agent with full Sera tool access — open by\n` +
      `default would let anyone trigger arbitrary swaps, treasury actions, etc.\n\n` +
      `Pick one:\n` +
      `  1. Set WEBHOOK_SECRET=<long-random-string> (recommended)\n` +
      `  2. Bind to localhost only:  HOST=127.0.0.1  AND  WEBHOOK_ALLOW_NO_AUTH=true\n\n`,
  );
  process.exit(1);
}
if (ALLOW_NO_AUTH && !WEBHOOK_SECRET) {
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    process.stderr.write(
      `\nrefusing to start: WEBHOOK_ALLOW_NO_AUTH=true requires HOST=127.0.0.1.\n` +
        `Bound to ${HOST}, which is reachable from outside this machine.\n\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`WARNING: webhook-agent running with NO AUTH (loopback-only).\n`);
}
if (HMAC_PROVIDER !== "none" && !HMAC_SECRET) {
  process.stderr.write(
    `refusing to start: WEBHOOK_HMAC_PROVIDER=${HMAC_PROVIDER} but WEBHOOK_HMAC_SECRET is unset.\n`,
  );
  process.exit(1);
}

const SYSTEM_PROMPT = `
You are an event-driven multi-currency settlement agent. You receive a task
description in each invocation and complete it using the sera.* tools.

Operating principles:
- Always use sera.* tools rather than guessing.
- Do not execute swaps unless the task explicitly says "execute".
- Return a concise summary of what you did + any artifacts (uuids, route_params,
  trade_ids) the caller will need.
`.trim();

/**
 * Map your incoming event payload to a single agent task instruction.
 *
 * SECURITY: never echo arbitrary upstream JSON into the task string — that's a
 * prompt-injection vector if any field is attacker-controlled. Use an allowlist
 * mapper. The default below only honors a `task` field that's a string, and
 * rejects anything else with a 400. Customize for your provider's schema.
 */
function TASK_BUILDER(eventPayload: any): string | { error: string } {
  if (typeof eventPayload?.task === "string" && eventPayload.task.length <= 2000) {
    return eventPayload.task;
  }
  return {
    error:
      "task_builder_unsupported: the default mapper only accepts {task: string}. " +
      "Edit TASK_BUILDER in server.ts to allowlist fields from your provider (Stripe event types, GitHub action types, etc.).",
  };
}

// ── Replay protection: timestamp tolerance + nonce LRU ───────────────────
const seenNonces = new Map<string, number>();
function rememberNonce(nonce: string): boolean {
  if (seenNonces.has(nonce)) return false;
  if (seenNonces.size > 5_000) {
    // GC oldest 1000
    const sorted = [...seenNonces.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < 1000; i++) seenNonces.delete(sorted[i][0]);
  }
  seenNonces.set(nonce, Date.now());
  return true;
}

function verifyHmac(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): { ok: true } | { ok: false; reason: string } {
  if (HMAC_PROVIDER === "none") return { ok: true };
  if (!HMAC_SECRET) return { ok: false, reason: "no_hmac_secret" };

  const now = Math.floor(Date.now() / 1000);
  if (HMAC_PROVIDER === "stripe") {
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
    if (Math.abs(now - t) > HMAC_TOLERANCE_SECONDS) return { ok: false, reason: "stale_signature" };
    const expected = createHmac("sha256", HMAC_SECRET).update(`${t}.${rawBody.toString()}`).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
    if (!rememberNonce(`stripe:${t}:${v1.slice(0, 16)}`)) return { ok: false, reason: "replay" };
    return { ok: true };
  }
  if (HMAC_PROVIDER === "github") {
    const sig = headers["x-hub-signature-256"];
    if (!sig?.startsWith("sha256=")) return { ok: false, reason: "missing_github_signature" };
    const expected = "sha256=" + createHmac("sha256", HMAC_SECRET).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
    const deliveryId = headers["x-github-delivery"];
    if (deliveryId && !rememberNonce(`github:${deliveryId}`)) return { ok: false, reason: "replay" };
    return { ok: true };
  }
  if (HMAC_PROVIDER === "generic") {
    const sig = headers["x-webhook-signature"];
    const ts = Number(headers["x-webhook-timestamp"] ?? 0);
    const nonce = headers["x-webhook-nonce"];
    if (!sig || !ts || !nonce) return { ok: false, reason: "missing_signature_fields" };
    if (Math.abs(now - ts) > HMAC_TOLERANCE_SECONDS) return { ok: false, reason: "stale_signature" };
    const expected = createHmac("sha256", HMAC_SECRET).update(`${ts}.${nonce}.${rawBody.toString()}`).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
    if (!rememberNonce(`generic:${nonce}`)) return { ok: false, reason: "replay" };
    return { ok: true };
  }
  return { ok: false, reason: "unknown_hmac_provider" };
}

// ── Concurrency + per-IP rate limit ──────────────────────────────────────
let activeRuns = 0;
async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeRuns >= MAX_CONCURRENT) return null;
  activeRuns++;
  try { return await fn(); }
  finally { activeRuns--; }
}

const ipBuckets = new Map<string, { count: number; windowStart: number }>();
function ipRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > 60_000) {
    ipBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  bucket.count++;
  return bucket.count <= RL_PER_IP_PER_MIN;
}

async function main() {
  const seraMcpPath =
    process.env.SERA_MCP_DIST ?? resolve(process.env.HOME!, "Desktop/sera-mcp/dist/index.js");

  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
    },
    name: "sera",
  });
  await sera.connect();

  const agent = new Agent({
    name: "Sera Webhook Agent",
    instructions: SYSTEM_PROMPT,
    mcpServers: [sera],
  });

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false })); // API-only; CSP not needed
  if (TRUST_PROXY) app.set("trust proxy", 1); // single hop only — never `true`

  // We need raw body for HMAC verification; capture it before json parses.
  app.use(express.raw({ type: "application/json", limit: "32kb" }));
  app.use((req, _res, next) => {
    if (req.body && Buffer.isBuffer(req.body)) {
      (req as any).rawBody = req.body;
      try { req.body = JSON.parse(req.body.toString("utf8") || "{}"); }
      catch { req.body = null; }
    }
    next();
  });

  const expected = WEBHOOK_SECRET ? Buffer.from(`Bearer ${WEBHOOK_SECRET}`) : null;
  app.use("/trigger", (req, res, next) => {
    if (!expected) return next();
    const provided = Buffer.from(req.header("authorization") ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  app.post("/trigger", async (req, res) => {
    // Rate limit (only meaningful behind a configured trusted proxy)
    const ip = TRUST_PROXY ? (req.ip ?? "unknown") : "untrusted-proxy";
    if (!ipRateLimit(ip)) return res.status(429).json({ error: "rate_limited" });

    // HMAC verification (provider-specific)
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (HMAC_PROVIDER !== "none") {
      if (!rawBody) return res.status(400).json({ error: "missing_raw_body" });
      const v = verifyHmac(rawBody, headers);
      if (!v.ok) return res.status(401).json({ error: "hmac_failed", reason: v.reason });
    }

    if (req.body == null) return res.status(400).json({ error: "invalid_body" });
    const taskOrErr = TASK_BUILDER(req.body);
    if (typeof taskOrErr !== "string") return res.status(400).json(taskOrErr);

    const result = await withSlot(async () => {
      try {
        const r = await run(agent, [user(taskOrErr)]);
        return { ok: true, summary: r.finalOutput };
      } catch (e: any) {
        process.stderr.write(`[trigger] ${e?.message ?? String(e)}\n`);
        return { ok: false, error: "agent_error" };
      }
    });
    if (result === null) return res.status(503).json({ error: "concurrency_limit", retry_after_seconds: 5 });
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      auth_required: !!WEBHOOK_SECRET,
      hmac_provider: HMAC_PROVIDER,
      trust_proxy: TRUST_PROXY,
      active_runs: activeRuns,
    });
  });

  app.listen(PORT, HOST, () => {
    console.log(`sera webhook-agent listening at http://${HOST}:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
