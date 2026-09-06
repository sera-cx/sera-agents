/**
 * Template: webhook-agent.
 *
 * Express endpoint that triggers a Sera-MCP-using agent in response to an
 * incoming HTTP event. Hardened defaults:
 *   - Strict fail-fast Zod environment validation (env.ts)
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
import { timingSafeEqual } from "node:crypto";
import { Agent, run, user } from "@openai/agents";
import express from "express";
import helmet from "helmet";
import { loadEnv } from "./env.js";
import { type HmacProvider, makeNonceStore, verifyHmac as verifyHmacImpl } from "./hmac.js";
import {
  buildSeraMcpServer,
  resolveSeraMcpTransport,
  type SeraMcpTransport,
} from "./sera-mcp-transport.js";

const env = loadEnv();
const {
  PORT,
  HOST,
  WEBHOOK_SECRET,
  TRUST_PROXY,
  HMAC_PROVIDER,
  HMAC_SECRET,
  HMAC_TOLERANCE_SECONDS,
  MAX_CONCURRENT,
  RL_PER_IP_PER_MIN,
} = {
  ...env,
  HMAC_PROVIDER: env.WEBHOOK_HMAC_PROVIDER as HmacProvider,
  HMAC_SECRET: env.WEBHOOK_HMAC_SECRET,
  HMAC_TOLERANCE_SECONDS: env.WEBHOOK_HMAC_TOLERANCE_SECONDS,
  MAX_CONCURRENT: env.WEBHOOK_MAX_CONCURRENT,
  RL_PER_IP_PER_MIN: env.WEBHOOK_RATE_LIMIT_PER_MIN,
};

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
// Extracted into ./hmac.ts. One nonce store per process; pass a fresh one
// to verifyHmac.
const nonceStore = makeNonceStore();

function verifyHmac(rawBody: Buffer, headers: Record<string, string | undefined>) {
  return verifyHmacImpl(
    {
      provider: HMAC_PROVIDER,
      secret: HMAC_SECRET,
      toleranceSeconds: HMAC_TOLERANCE_SECONDS,
      nonceStore,
    },
    rawBody,
    headers,
  );
}

// ── Concurrency + per-IP rate limit ──────────────────────────────────────
let activeRuns = 0;
async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeRuns >= MAX_CONCURRENT) return null;
  activeRuns++;
  try {
    return await fn();
  } finally {
    activeRuns--;
  }
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
  let transport: SeraMcpTransport;
  try {
    transport = resolveSeraMcpTransport(env);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  const sera = buildSeraMcpServer(transport, env);
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
      try {
        req.body = JSON.parse(req.body.toString("utf8") || "{}");
      } catch {
        req.body = null;
      }
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
    if (result === null)
      return res.status(503).json({ error: "concurrency_limit", retry_after_seconds: 5 });
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
