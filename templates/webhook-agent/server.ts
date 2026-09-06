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
 *   - Dual-tier rate limiting BEFORE body parsing: a server-wide global burst
 *     ceiling plus a per-client quota (see ./rate-limit.ts)
 *   - Body cap 32kb
 *   - Concurrency limit on agent runs
 *   - Allowlisted task mapper — replace with your own once you know the schema
 */

import { timingSafeEqual } from "node:crypto";
import { Agent, run, user } from "@openai/agents";
import express, { type Express } from "express";
import helmet from "helmet";
import { type HmacProvider, makeNonceStore, verifyHmac as verifyHmacImpl } from "./hmac.js";
import {
  createClientLimiter,
  createGlobalLimiter,
  DEFAULT_CLIENT_LIMIT,
  DEFAULT_GLOBAL_LIMIT,
  type LimiterOverrides,
  parsePositiveIntEnv,
  RATE_LIMIT_WINDOW_MS,
} from "./rate-limit.js";
import {
  buildSeraMcpServer,
  resolveSeraMcpTransport,
  type SeraMcpTransport,
} from "./sera-mcp-transport.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";

/** Runs one agent turn; injectable so tests can stub the expensive path. */
export type AgentRunner = (
  task: string,
) => Promise<{ ok: boolean; summary?: string; error?: string }>;

export interface AppOptions {
  /** Bearer token gating /trigger. Pass null to run without the auth gate. */
  secret?: string | null;
  /** Honor X-Forwarded-For from a single reverse-proxy hop for client IPs. */
  trustProxy?: boolean;
  hmacProvider?: HmacProvider;
  hmacSecret?: string;
  hmacToleranceSeconds?: number;
  maxConcurrent?: number;
  /** Rate-limit sliding window length in ms. */
  windowMs?: number;
  /** Tier 1 — server-wide requests per window across all clients. */
  globalLimit?: number;
  /** Tier 2 — per-client requests per window on /trigger. */
  clientLimit?: number;
  /** express-rate-limit validate toggles (test hook). */
  limiterOverrides?: LimiterOverrides;
  runAgent: AgentRunner;
}

function envTrustProxy(): boolean {
  return (process.env.WEBHOOK_TRUST_PROXY ?? "false").toLowerCase() === "true";
}

function envHmacProvider(): HmacProvider {
  return (process.env.WEBHOOK_HMAC_PROVIDER ?? "none").toLowerCase() as HmacProvider;
}

/**
 * Refuse to start in unsafe or misconfigured states, with actionable errors.
 * Runs before anything binds a socket.
 */
function validateStartupEnv(): void {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const allowNoAuth = (process.env.WEBHOOK_ALLOW_NO_AUTH ?? "false").toLowerCase() === "true";
  if (!webhookSecret && !allowNoAuth) {
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
  if (allowNoAuth && !webhookSecret) {
    const host = process.env.HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost") {
      process.stderr.write(
        `\nrefusing to start: WEBHOOK_ALLOW_NO_AUTH=true requires HOST=127.0.0.1.\n` +
          `Bound to ${host}, which is reachable from outside this machine.\n\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`WARNING: webhook-agent running with NO AUTH (loopback-only).\n`);
  }
  if (envHmacProvider() !== "none" && !process.env.WEBHOOK_HMAC_SECRET) {
    process.stderr.write(
      `\nrefusing to start: WEBHOOK_HMAC_PROVIDER=${envHmacProvider()} but WEBHOOK_HMAC_SECRET is unset.\n`,
    );
    process.exit(1);
  }
  // Fail fast on unusable rate-limit configuration.
  parsePositiveIntEnv("WEBHOOK_GLOBAL_RATE_LIMIT", DEFAULT_GLOBAL_LIMIT);
  parsePositiveIntEnv("WEBHOOK_RATE_LIMIT_PER_MIN", DEFAULT_CLIENT_LIMIT);
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

/**
 * Build the Express app. Exported (instead of constructed inline in main) so
 * HTTP-level tests can exercise real middleware ordering, headers, and status
 * codes against a stubbed agent runner.
 */
export function createApp(options: AppOptions): Express {
  const secret = options.secret !== undefined ? options.secret : process.env.WEBHOOK_SECRET || null;
  const trustProxy = options.trustProxy ?? envTrustProxy();
  const hmacProvider = options.hmacProvider ?? envHmacProvider();
  const hmacSecret = options.hmacSecret ?? process.env.WEBHOOK_HMAC_SECRET;
  const hmacToleranceSeconds =
    options.hmacToleranceSeconds ?? Number(process.env.WEBHOOK_HMAC_TOLERANCE_SECONDS ?? 300);
  const maxConcurrent = options.maxConcurrent ?? Number(process.env.WEBHOOK_MAX_CONCURRENT ?? 4);
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  // Env-backed limits are validated as finite positive integers at boot; see
  // validateStartupEnv. Explicit options (tests) bypass env parsing.
  const globalLimit =
    options.globalLimit ?? parsePositiveIntEnv("WEBHOOK_GLOBAL_RATE_LIMIT", DEFAULT_GLOBAL_LIMIT);
  const clientLimit =
    options.clientLimit ?? parsePositiveIntEnv("WEBHOOK_RATE_LIMIT_PER_MIN", DEFAULT_CLIENT_LIMIT);

  // One nonce store per app; pass a fresh one to verifyHmac.
  const nonceStore = makeNonceStore();

  function verifyHmac(rawBody: Buffer, headers: Record<string, string | undefined>) {
    return verifyHmacImpl(
      {
        provider: hmacProvider,
        secret: hmacSecret,
        toleranceSeconds: hmacToleranceSeconds,
        nonceStore,
      },
      rawBody,
      headers,
    );
  }

  // ── Concurrency limit ────────────────────────────────────────────────────
  let activeRuns = 0;
  async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
    if (activeRuns >= maxConcurrent) return null;
    activeRuns++;
    try {
      return await fn();
    } finally {
      activeRuns--;
    }
  }

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false })); // API-only; CSP not needed
  if (trustProxy) app.set("trust proxy", 1); // single hop only — never `true`

  // ── Dual-tier rate limiting ─────────────────────────────────────────────
  // Both tiers run BEFORE express.raw()/JSON parsing so abusive traffic is
  // rejected without allocating body buffers or parsing payloads. Rejected
  // requests get standard RateLimit-* headers plus Retry-After.
  //
  // Tier 1 (per-client limiter) is mounted at the app root AHEAD of Tier 2
  // (global burst ceiling) across all routes (/health, /trigger, etc.).
  // This ensures any single client IP can consume at most its per-client quota
  // (e.g. 60 req/min) of the server-wide global budget (e.g. 300 req/min).
  // Once an abusive IP hits its per-client cap, its requests are rejected with
  // 429 before reaching the global tier — preventing a single unauthenticated
  // client hitting /health or /trigger from draining the global bucket and
  // causing a service-wide lockout of other legitimate users.
  //
  // Tier 2 (global burst ceiling) protects against distributed multi-source floods
  // where many distinct IPs each stay below the individual per-client limit.
  const limiterConfig = { windowMs, globalLimit, clientLimit };
  app.use(createClientLimiter(limiterConfig, options.limiterOverrides)); // Tier 1: per-client quota (app-wide)
  app.use(createGlobalLimiter(limiterConfig, options.limiterOverrides)); // Tier 2: server-wide burst ceiling

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

  const expected = secret ? Buffer.from(`Bearer ${secret}`) : null;
  app.use("/trigger", (req, res, next) => {
    if (!expected) return next();
    const provided = Buffer.from(req.header("authorization") ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  app.post("/trigger", async (req, res) => {
    // HMAC verification (provider-specific)
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (hmacProvider !== "none") {
      if (!rawBody) return res.status(400).json({ error: "missing_raw_body" });
      const v = verifyHmac(rawBody, headers);
      if (!v.ok) return res.status(401).json({ error: "hmac_failed", reason: v.reason });
    }

    if (req.body == null) return res.status(400).json({ error: "invalid_body" });
    const taskOrErr = TASK_BUILDER(req.body);
    if (typeof taskOrErr !== "string") return res.status(400).json(taskOrErr);

    const result = await withSlot(() => options.runAgent(taskOrErr));
    if (result === null)
      return res.status(503).json({ error: "concurrency_limit", retry_after_seconds: 5 });
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      auth_required: !!secret,
      hmac_provider: hmacProvider,
      trust_proxy: trustProxy,
      active_runs: activeRuns,
      rate_limit: {
        store: "memory (per-process)",
      },
    });
  });

  return app;
}

async function main() {
  validateStartupEnv();

  let transport: SeraMcpTransport;
  try {
    transport = resolveSeraMcpTransport(process.env);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  const sera = buildSeraMcpServer(transport);
  await sera.connect();

  const agent = new Agent({
    name: "Sera Webhook Agent",
    instructions: SYSTEM_PROMPT,
    mcpServers: [sera],
  });

  const app = createApp({
    runAgent: async (task) => {
      try {
        const r = await run(agent, [user(task)]);
        return { ok: true, summary: r.finalOutput };
      } catch (e: any) {
        process.stderr.write(`[trigger] ${e?.message ?? String(e)}\n`);
        return { ok: false, error: "agent_error" };
      }
    },
  });

  app.listen(PORT, HOST, () => {
    console.log(`sera webhook-agent listening at http://${HOST}:${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
