/**
 * Template: web-chat agent.
 *
 * Tiny Express server + a single HTML page. Serves a chat UI in the browser
 * connected to a backend agent that uses the Sera MCP.
 *
 * Defaults are conservative for distribution safety:
 *   - Refuses to start without WEB_CHAT_AUTH_TOKEN unless WEB_CHAT_ALLOW_NO_AUTH=true
 *     AND HOST=127.0.0.1 (localhost-only is OK; public open-auth is not).
 *   - Body cap 32kb, per-IP rate limit 30/min, sessions LRU-capped at 1000.
 *   - Session IDs are derived server-side as HMAC(client-supplied) so two clients
 *     with the same client-side id can't accidentally share history.
 *
 * Customize:
 *   - Edit SYSTEM_PROMPT below to change agent behavior.
 *   - Edit public/index.html for UI tweaks.
 *   - Add more MCPs to the agent's mcpServers array if you need other tools.
 */
import { Agent, run, MCPServerStdio, user } from "@openai/agents";
import express from "express";
import helmet from "helmet";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const AUTH_TOKEN = process.env.WEB_CHAT_AUTH_TOKEN;
const ALLOW_NO_AUTH = (process.env.WEB_CHAT_ALLOW_NO_AUTH ?? "false").toLowerCase() === "true";
// Trust X-Forwarded-For only when explicitly opted into. Default false stops
// direct-public deploys from honoring spoofable client headers.
const TRUST_PROXY = (process.env.WEB_CHAT_TRUST_PROXY ?? "false").toLowerCase() === "true";

const MAX_CONCURRENT = Number(process.env.WEB_CHAT_MAX_CONCURRENT ?? 4);

// Per-process session HMAC key — derives stable session IDs from client-supplied
// strings so two clients can't impersonate each other by guessing IDs. Key is
// regenerated each restart (sessions don't survive a restart anyway).
const SESSION_HMAC_KEY = randomBytes(32);

const SESSIONS_MAX = Number(process.env.WEB_CHAT_SESSIONS_MAX ?? 1000);
const RL_PER_IP_PER_MIN = Number(process.env.WEB_CHAT_RATE_LIMIT_PER_MIN ?? 30);

const SYSTEM_PROMPT = `
You are a multi-currency settlement assistant powered by the Sera MCP.
Use sera.* tools rather than guessing values. Quote prices via sera.get_quote.
Default to simulate:true when exploring. Be concise.
`.trim();

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// H4: refuse public deployment without auth.
if (!AUTH_TOKEN && !ALLOW_NO_AUTH) {
  process.stderr.write(
    `\nrefusing to start: WEB_CHAT_AUTH_TOKEN not set.\n` +
      `Open /api/chat lets anyone drain your OPENAI_API_KEY and (if SERA_API_KEY\n` +
      `is set) consume your Sera API quota.\n\n` +
      `Pick one:\n` +
      `  1. Set WEB_CHAT_AUTH_TOKEN=<long-random-string> (recommended)\n` +
      `  2. Bind to localhost only:  HOST=127.0.0.1  AND  WEB_CHAT_ALLOW_NO_AUTH=true\n\n`,
  );
  process.exit(1);
}
if (ALLOW_NO_AUTH && !AUTH_TOKEN) {
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    process.stderr.write(
      `\nrefusing to start: WEB_CHAT_ALLOW_NO_AUTH=true requires HOST=127.0.0.1.\n` +
        `Bound to ${HOST}, which is reachable from outside this machine.\n\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `WARNING: web-chat running with NO AUTH (loopback-only).\n`,
  );
}

// In-memory session store with LRU eviction (insertion order = recency).
const sessions = new Map<string, any[]>();

function deriveSessionId(clientId: string): string {
  return createHmac("sha256", SESSION_HMAC_KEY).update(clientId).digest("hex");
}

function touchSession(id: string, history: any[]): void {
  // Evict oldest if at cap.
  if (sessions.size >= SESSIONS_MAX && !sessions.has(id)) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  // Re-insert to bump recency.
  sessions.delete(id);
  sessions.set(id, history);
}

// Per-IP rate limit (60s window). Identifier comes from req.ip — only meaningful
// when TRUST_PROXY=true behind a properly-configured reverse proxy.
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

// Concurrency cap on agent runs — one big LLM call per request is expensive.
let activeRuns = 0;
async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeRuns >= MAX_CONCURRENT) return null;
  activeRuns++;
  try { return await fn(); }
  finally { activeRuns--; }
}

async function main() {
  const seraMcpPath =
    process.env.SERA_MCP_DIST ?? resolve(process.cwd(), "../../sera-mcp/dist/index.js");

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
    name: "Sera Web Agent",
    instructions: SYSTEM_PROMPT,
    mcpServers: [sera],
  });

  const app = express();
  // Helmet: set common security headers. CSP allows the static page's inline
  // script (the simple chat UI). Tighten if you replace the UI.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    }),
  );
  // Trust proxy ONLY when explicitly opted into. Hop count of 1 (single proxy).
  if (TRUST_PROXY) app.set("trust proxy", 1);
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(resolve(__dirname, "public")));

  // Bearer-token gate (constant-time) — applied only when AUTH_TOKEN is set.
  const expected = AUTH_TOKEN ? Buffer.from(`Bearer ${AUTH_TOKEN}`) : null;
  app.use("/api", (req, res, next) => {
    // Rate limit before auth check so we don't burn CPU on attacker traffic.
    const ip = TRUST_PROXY ? (req.ip ?? "unknown") : "untrusted-proxy";
    if (!ipRateLimit(ip)) return res.status(429).json({ error: "rate_limited" });
    if (!expected) return next();
    const provided = Buffer.from(req.header("authorization") ?? "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  app.post("/api/chat", async (req, res) => {
    const { session_id, message } = req.body ?? {};
    if (!session_id || !message) {
      return res.status(400).json({ error: "session_id and message required" });
    }
    if (typeof session_id !== "string" || session_id.length > 256) {
      return res.status(400).json({ error: "invalid session_id" });
    }
    if (typeof message !== "string" || message.length > 8000) {
      return res.status(400).json({ error: "message too long (max 8000 chars)" });
    }

    const sid = deriveSessionId(session_id);
    const history = sessions.get(sid) ?? [];
    history.push(user(message));

    const result = await withSlot(async () => {
      try {
        const r = await run(agent, history);
        history.push(...r.newItems);
        touchSession(sid, history);
        return { ok: true, reply: r.finalOutput };
      } catch (e: any) {
        process.stderr.write(`[chat] ${e?.message ?? String(e)}\n`);
        return { ok: false, error: "agent_error" };
      }
    });
    if (result === null) return res.status(503).json({ error: "concurrency_limit", retry_after_seconds: 5 });
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ reply: result.reply });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      sessions: sessions.size,
      sessions_max: SESSIONS_MAX,
      auth_required: !!AUTH_TOKEN,
      active_runs: activeRuns,
      trust_proxy: TRUST_PROXY,
    });
  });

  app.listen(PORT, HOST, () => {
    console.log(`sera web-chat listening at http://${HOST}:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
