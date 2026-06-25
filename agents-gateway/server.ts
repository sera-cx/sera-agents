/**
 * agents.sera.cx gateway server.
 *
 * One Node origin that serves the curated public agent API:
 *   GET  /openapi.json   OpenAPI 3.1 contract
 *   GET  /corridors      supported FX corridors
 *   GET  /rates?pairs=   live reference rates
 *   POST /quote          live FX quote        (fx_quote)
 *   POST /settle         unsigned EIP-712      (fx_settle)
 *   POST /mcp            curated Streamable HTTP MCP (4 tools only)
 *   GET  /health         liveness
 *   GET  /robots.txt
 *
 * Data comes from an embedded sera-mcp, booted in the most locked-down mode it
 * has: SERA_SIGNER_MODE=readonly + SERA_ENABLE_EXECUTION_TOOLS=false. The
 * gateway can quote and return UNSIGNED typed data — it can never sign,
 * execute, or withdraw.
 *
 * Auth: NONE here. The read endpoints are public by design; settlement returns
 * unsigned data the caller must sign in their own wallet. Bind to localhost and
 * front with a TLS reverse proxy on the agents.sera.cx hostname. See README.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSeraMcp, type SeraMcpClient } from "./lib/mcp-client.js";
import { createQuoteStore } from "./lib/store.js";
import {
  fxQuote,
  fxSettle,
  corridors,
  rates,
  GatewayError,
  type SeraDomainInfo,
} from "./lib/adapters.js";
import { handleMcpMessage, type McpDeps } from "./lib/mcp-http.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const NETWORK: "mainnet" | "sepolia" =
  (process.env.SERA_NETWORK ?? "mainnet").toLowerCase() === "sepolia" ? "sepolia" : "mainnet";
const MCP_PATH = process.env.SERA_MCP_DIST ?? join(__dirname, "..", "sera-mcp", "dist", "index.js");

function loadOpenApi(): unknown {
  // Single source of truth = the repo-root openapi.json (also served by the
  // static Pages site). Fall back to a minimal stub if it can't be read.
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "openapi.json"), "utf8"));
  } catch {
    return { openapi: "3.1.0", info: { title: "Sera Protocol API", version: "1.0.0" }, paths: {} };
  }
}

const ROBOTS = `User-agent: *
Allow: /openapi.json
Allow: /corridors
Allow: /rates

Disallow: /quote
Disallow: /settle
Disallow: /mcp
`;

/** chainId from the network; verifyingContract parsed from sera.doctor. */
async function resolveDomain(mcp: SeraMcpClient): Promise<SeraDomainInfo> {
  const chainId = NETWORK === "mainnet" ? 1 : 11155111;
  try {
    const doc = await mcp.tool<{ checks?: Array<{ name?: string; detail?: string }> }>(
      "sera.doctor",
      {},
    );
    const c = (doc?.checks ?? []).find((x) => x?.name === "contracts");
    const m = typeof c?.detail === "string" ? c.detail.match(/sera=(0x[0-9a-fA-F]{40})/) : null;
    return { chainId, verifyingContract: m?.[1] };
  } catch {
    return { chainId };
  }
}

export function buildApp(deps: McpDeps, openapiDoc: unknown): Hono {
  const app = new Hono();

  // CORS + agent-discovery Link headers on every response.
  app.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Accept");
    c.header(
      "Link",
      '<https://agents.sera.cx/openapi.json>; rel="describedby"; type="application/json"',
      { append: true },
    );
    c.header("Link", '<https://sera.cx/.well-known/agent.json>; rel="agent"', { append: true });
    c.header("Link", '<https://sera.cx/.well-known/mcp.json>; rel="mcp-catalog"', { append: true });
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof GatewayError) {
      // Surface the backoff hint so HTTP clients can throttle correctly.
      if (err.retryAfter != null) c.header("Retry-After", String(err.retryAfter));
      return c.json({ error: err.message }, err.status as 400);
    }
    console.error("[gateway] unhandled:", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", network: NETWORK, mcp: deps.mcp.running(), quotes: deps.store.size() }),
  );
  app.get("/robots.txt", (c) => c.text(ROBOTS));
  app.get("/openapi.json", (c) => c.json(openapiDoc as Record<string, unknown>));

  app.get("/corridors", async (c) => c.json(await corridors(deps.mcp)));
  app.get("/rates", async (c) => c.json(await rates(deps.mcp, c.req.query("pairs"), deps.now())));

  app.post("/quote", async (c) => c.json(await fxQuote(deps.mcp, deps.store, await c.req.json())));
  app.post("/settle", async (c) =>
    c.json(await fxSettle(deps.mcp, deps.store, deps.domain, await c.req.json())),
  );

  // Curated Streamable HTTP MCP — JSON request/response (stateless).
  app.post("/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMcpMessage(m, deps)))).filter(
        (x) => x !== null,
      );
      return out.length ? c.json(out) : c.body(null, 204);
    }
    const res = await handleMcpMessage(body, deps);
    return res === null ? c.body(null, 204) : c.json(res as Record<string, unknown>);
  });
  // We don't open server-initiated SSE streams (stateless mode).
  app.get("/mcp", (c) => c.json({ error: "SSE not supported; POST JSON-RPC to /mcp" }, 405));

  return app;
}

async function main(): Promise<void> {
  const mcp = await startSeraMcp({
    mcpPath: MCP_PATH,
    env: {
      SERA_NETWORK: NETWORK,
      // Hard lock-down: this process can price + prepare, never sign/execute.
      SERA_SIGNER_MODE: "readonly",
      SERA_ENABLE_EXECUTION_TOOLS: "false",
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
    },
  });

  const store = createQuoteStore();
  const domain = await resolveDomain(mcp);
  const deps: McpDeps = { mcp, store, domain, now: () => new Date().toISOString() };
  const app = buildApp(deps, loadOpenApi());

  serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    console.log(
      `[gateway] listening http://${HOST}:${info.port} · network=${NETWORK} · ` +
        `verifyingContract=${domain.verifyingContract ?? "(unresolved)"}`,
    );
  });

  const shutdown = () => {
    mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Boot only when run directly (tests import buildApp without starting sera-mcp).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("[gateway] failed to start:", e);
    process.exit(1);
  });
}
