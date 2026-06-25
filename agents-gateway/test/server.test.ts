import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server.js";
import { createQuoteStore } from "../lib/store.js";
import { GatewayError } from "../lib/errors.js";
import type { McpDeps } from "../lib/mcp-http.js";
import type { SeraMcpClient } from "../lib/mcp-client.js";

const QUOTE_OK = {
  uuid: "u1",
  expires_at: "2099-01-01T00:00:00.000Z",
  fee_breakdown: { total: "0.1" },
  human: { input: "100", min_output: "150" },
  route_params: { taker: "0x0", minOutputAmount: "150000000" },
};

function deps(handlers: Record<string, (a: any) => unknown> = {}): McpDeps {
  const mcp: SeraMcpClient = {
    async tool<T>(name: string, args?: Record<string, unknown>): Promise<T> {
      const h = handlers[name];
      if (!h) throw new Error(`unexpected tool: ${name}`);
      return h(args ?? {}) as T;
    },
    async rpc() {
      return {};
    },
    close() {},
    running() {
      return true;
    },
  };
  return { mcp, store: createQuoteStore(), domain: { chainId: 1 }, now: () => "2026-06-25T12:00:00Z" };
}

const OPENAPI = { openapi: "3.1.0", info: { title: "x", version: "1.0.0" }, paths: {} };

test("health, robots, openapi serve", async () => {
  const app = buildApp(deps(), OPENAPI);
  const h = await app.request("/health");
  assert.equal(h.status, 200);
  assert.equal(((await h.json()) as any).status, "ok");

  const r = await app.request("/robots.txt");
  assert.match(await r.text(), /Disallow: \/mcp/);

  const o = await app.request("/openapi.json");
  assert.equal(((await o.json()) as any).openapi, "3.1.0");
});

test("every response carries CORS + agent Link headers; OPTIONS preflight is 204", async () => {
  const app = buildApp(deps(), OPENAPI);
  const res = await app.request("/health");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const link = res.headers.get("link") ?? "";
  assert.match(link, /openapi\.json>; rel="describedby"/);
  assert.match(link, /rel="agent"/);

  const pre = await app.request("/health", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
});

test("POST /quote → 200; GatewayError maps to its status", async () => {
  const app = buildApp(deps({ "sera.get_quote": () => QUOTE_OK }), OPENAPI);
  const ok = await app.request("/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from_token: "USDC", to_token: "BRLA", amount: "100" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).amount_out, "150");

  // unknown quote_id → 404 via onError
  const app2 = buildApp(deps({ "sera.prepare_swap": () => QUOTE_OK }), OPENAPI);
  const nf = await app2.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote_id: "nope", signer: "0x2222222222222222222222222222222222222222" }),
  });
  assert.equal(nf.status, 404);

  // missing pairs → 400
  const bad = await buildApp(deps(), OPENAPI).request("/rates");
  assert.equal(bad.status, 400);
});

test("upstream throttle → REST 429 carries Retry-After; /mcp surfaces it in isError", async () => {
  const throttle = () => {
    throw new GatewayError(429, "sera.get_quote: 429 Too Many Requests", 15);
  };

  // REST: status + Retry-After header propagate through onError.
  const app = buildApp(deps({ "sera.get_quote": throttle }), OPENAPI);
  const res = await app.request("/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from_token: "USDC", to_token: "BRLA", amount: "100" }),
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "15");

  // MCP: same throttle rides in the tool result as isError with the hint.
  const mcp = await buildApp(deps({ "sera.get_quote": throttle }), OPENAPI).request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fx_quote", arguments: { from_token: "USDC", to_token: "BRLA", amount: "100" } },
    }),
  });
  const body = (await mcp.json()) as any;
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /^429: .*\(retry after 15s\)$/);
});

test("POST /mcp tools/list returns the 4 curated tools", async () => {
  const app = buildApp(deps(), OPENAPI);
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.result.tools.length, 4);
});

test("GET /mcp is 405 (no SSE in stateless mode)", async () => {
  const res = await buildApp(deps(), OPENAPI).request("/mcp");
  assert.equal(res.status, 405);
});
