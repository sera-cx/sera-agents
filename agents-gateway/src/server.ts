import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import http from "node:http";
import { z } from "zod";
import { loadEnv } from "./env.js";
import { makeSeraMcpClient } from "./sera-mcp-client.js";
import { makeQuoteCache } from "./quote-cache.js";
import { makeHandlers } from "./handlers.js";
import { OPENAPI_DOC } from "./openapi.js";
import { buildMcpServer, handleMcpRequest } from "./mcp.js";

const env = loadEnv();
const mcp = makeSeraMcpClient({
  mcpPath: env.mcpPath,
  network: env.network,
  apiKey: env.apiKey,
  apiSecret: env.apiSecret,
});
const cache = makeQuoteCache();
const handlers = makeHandlers(mcp, cache);
const mcpServer = buildMcpServer(handlers);

const app = new Hono();

const LINK_HEADERS = [
  '<https://agents.sera.cx/openapi.json>; rel="describedby"; type="application/json"',
  '<https://sera.cx/.well-known/agent.json>; rel="agent"',
  '<https://sera.cx/.well-known/mcp.json>; rel="mcp-catalog"',
].join(", ");

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept");
  c.header("Link", LINK_HEADERS);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/health", (c) => c.json({ status: "ok", mcp_running: mcp.running() }));
app.get("/openapi.json", (c) => c.json(OPENAPI_DOC));

const QuoteBody = z.object({
  from_token: z.string().min(1),
  to_token: z.string().min(1),
  amount: z.string().min(1),
});

const SettleBody = z.object({
  quote_id: z.string().min(1),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "signer must be 0x-prefixed 40-hex"),
});

app.get("/rates", async (c) => {
  const raw = c.req.query("pairs") ?? "";
  const pairs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pairs.length === 0) return c.json({ error: "pairs query parameter required" }, 400);
  try {
    return c.json(await handlers.rates(pairs));
  } catch (e: any) {
    return c.json({ error: e?.message ?? "rates failed" }, 502);
  }
});

app.get("/corridors", async (c) => {
  try {
    return c.json(await handlers.corridors());
  } catch (e: any) {
    return c.json({ error: e?.message ?? "corridors failed" }, 502);
  }
});

app.post("/quote", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = QuoteBody.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    return c.json(await handlers.quote(parsed.data));
  } catch (e: any) {
    return c.json({ error: e?.message ?? "quote failed" }, 502);
  }
});

app.post("/settle", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = SettleBody.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    return c.json(await handlers.settle(parsed.data));
  } catch (e: any) {
    return c.json({ error: e?.message ?? "settle failed" }, 502);
  }
});

app.notFound((c) => c.json({ error: "not found" }, 404));

const honoListener = getRequestListener(app.fetch);

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.split("?")[0] === "/mcp") {
    try {
      await handleMcpRequest(mcpServer, req, res);
    } catch (e: any) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: e?.message ?? "mcp transport failed" }));
      }
    }
    return;
  }
  honoListener(req, res);
});

server.listen(env.port, env.host, () => {
  process.stdout.write(
    `[agents-gateway] listening on ${env.host}:${env.port} (network=${env.network})\n`,
  );
});

function shutdown(signal: string) {
  process.stdout.write(`[agents-gateway] ${signal} received, shutting down\n`);
  mcp.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
