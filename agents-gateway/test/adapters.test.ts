import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fxQuote,
  fxSettle,
  corridors,
  rates,
  GatewayError,
  INTENT_TYPES,
  type SeraDomainInfo,
} from "../lib/adapters.js";
import { createQuoteStore } from "../lib/store.js";
import { handleMcpMessage, PUBLIC_TOOLS, type McpDeps } from "../lib/mcp-http.js";
import type { SeraMcpClient } from "../lib/mcp-client.js";

/** Minimal fake of the stdio client: routes tool() to canned handlers. */
function fakeMcp(handlers: Record<string, (args: any) => unknown>): SeraMcpClient {
  return {
    async tool<T>(name: string, args?: Record<string, unknown>): Promise<T> {
      const h = handlers[name];
      if (!h) throw new Error(`unexpected tool call: ${name}`);
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
}

// Far-future expiry so the store keeps the entry regardless of wall-clock run date.
const QUOTE_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const QUOTE_OK = {
  uuid: "sera-uuid-1",
  expires_at: QUOTE_EXPIRES_AT,
  fee_breakdown: { total: "0.12" },
  human: { input: "100", min_output: "133.7" },
  route_params: {
    taker: "0x1111111111111111111111111111111111111111",
    inputToken: "0xaaa",
    outputToken: "0xbbb",
    maxInputAmount: "100000000",
    minOutputAmount: "133700000",
    recipient: "0x1111111111111111111111111111111111111111",
    initialDepositAmount: "0",
    uuid: "42",
    deadline: 1900000000,
  },
};

// ───────────────────────── /quote ─────────────────────────
test("fxQuote maps fields, computes mid_rate, mints a quote_id", async () => {
  const store = createQuoteStore();
  const mcp = fakeMcp({ "sera.get_quote": () => QUOTE_OK });
  const r = await fxQuote(mcp, store, { from_token: "USDC", to_token: "BRLA", amount: "100" });
  assert.equal(r.amount_out, "133.7");
  assert.equal(r.mid_rate, "1.33700000"); // 133.7 / 100
  assert.equal(r.network_cost, "0.12");
  assert.ok(r.quote_id.length > 0);
  assert.equal(r.expires_at, QUOTE_EXPIRES_AT);
  // quote_id resolves to the stored inputs
  assert.deepEqual(store.get(r.quote_id), { from: "USDC", to: "BRLA", amount: "100" });
});

test("fxQuote passes simulate=true (no wallet needed)", async () => {
  const store = createQuoteStore();
  let seen: any;
  const mcp = fakeMcp({
    "sera.get_quote": (a) => {
      seen = a;
      return QUOTE_OK;
    },
  });
  await fxQuote(mcp, store, { from_token: "USDC", to_token: "BRLA", amount: "100" });
  assert.equal(seen.simulate, true);
  assert.equal(seen.owner_address, undefined);
});

test("fxQuote rejects bad symbols and non-positive amounts", async () => {
  const store = createQuoteStore();
  const mcp = fakeMcp({ "sera.get_quote": () => QUOTE_OK });
  await assert.rejects(
    () => fxQuote(mcp, store, { from_token: "bad symbol!", to_token: "BRLA", amount: "1" }),
    (e) => e instanceof GatewayError && e.status === 400,
  );
  await assert.rejects(
    () => fxQuote(mcp, store, { from_token: "USDC", to_token: "BRLA", amount: "0" }),
    (e) => e instanceof GatewayError && e.status === 400,
  );
});

// ───────────────────────── /settle ─────────────────────────
const DOMAIN: SeraDomainInfo = { chainId: 1, verifyingContract: "0xSeraAddrSeraAddrSeraAddrSeraAddr00000000" };

test("fxSettle returns an EIP-712 Intent envelope bound to the signer", async () => {
  const store = createQuoteStore();
  const id = store.put({ from: "USDC", to: "BRLA", amount: "100" });
  let seen: any;
  const mcp = fakeMcp({
    "sera.prepare_swap": (a) => {
      seen = a;
      return QUOTE_OK;
    },
  });
  const signer = "0x2222222222222222222222222222222222222222";
  const r = await fxSettle(mcp, store, DOMAIN, { quote_id: id, signer });
  // re-quoted with the real signer as owner
  assert.equal(seen.owner_address, signer);
  assert.equal(r.typed_data.primaryType, "Intent");
  assert.deepEqual(r.typed_data.types, INTENT_TYPES);
  assert.equal(r.typed_data.domain.chainId, 1);
  assert.equal(r.typed_data.domain.verifyingContract, DOMAIN.verifyingContract);
  assert.equal((r.typed_data.message as any).minOutputAmount, "133700000");
});

test("fxSettle rejects unknown quote_id (404) and bad signer (400)", async () => {
  const store = createQuoteStore();
  const mcp = fakeMcp({ "sera.prepare_swap": () => QUOTE_OK });
  await assert.rejects(
    () => fxSettle(mcp, store, DOMAIN, { quote_id: "nope", signer: "0x2222222222222222222222222222222222222222" }),
    (e) => e instanceof GatewayError && e.status === 404,
  );
  const id = store.put({ from: "USDC", to: "BRLA", amount: "100" });
  await assert.rejects(
    () => fxSettle(mcp, store, DOMAIN, { quote_id: id, signer: "not-an-address" }),
    (e) => e instanceof GatewayError && e.status === 400,
  );
});

test("fxSettle omits verifyingContract when unresolved", async () => {
  const store = createQuoteStore();
  const id = store.put({ from: "USDC", to: "BRLA", amount: "100" });
  const mcp = fakeMcp({ "sera.prepare_swap": () => QUOTE_OK });
  const r = await fxSettle(mcp, store, { chainId: 11155111 }, {
    quote_id: id,
    signer: "0x2222222222222222222222222222222222222222",
  });
  assert.equal("verifyingContract" in r.typed_data.domain, false);
  assert.equal(r.typed_data.domain.chainId, 11155111);
});

// ───────────────────────── /corridors + /rates ─────────────────────────
test("corridors normalizes market shapes defensively", async () => {
  const mcp = fakeMcp({
    "sera.get_markets": () => ({
      markets: [
        { base: "XSGD", quote: "IDRX", liquidity_depth: "500000" },
        { base_symbol: "USDC", quote_symbol: "BRLA", depth: "1m" },
        { quote: "ONLYQUOTE" }, // dropped: no from_currency
      ],
    }),
  });
  const r = await corridors(mcp);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { from_currency: "XSGD", to_currency: "IDRX", liquidity_depth: "500000" });
  assert.deepEqual(r[1], { from_currency: "USDC", to_currency: "BRLA", liquidity_depth: "1m" });
});

test("rates maps each pair and requires the pairs param", async () => {
  const mcp = fakeMcp({
    "sera.get_fx_rate": (a) => ({ mid: "1.5", bid: "1.49", ask: "1.51", timestamp: "2026-06-25T00:00:00Z" }),
  });
  const r = await rates(mcp, "USDC/BRLA, XSGD/IDRX", "2026-06-25T12:00:00Z");
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], {
    pair: "USDC/BRLA",
    mid_rate: "1.5",
    bid: "1.49",
    ask: "1.51",
    timestamp: "2026-06-25T00:00:00Z",
  });
  await assert.rejects(
    () => rates(mcp, undefined, "now"),
    (e) => e instanceof GatewayError && e.status === 400,
  );
});

test("rates falls back to nowIso when the engine omits a timestamp", async () => {
  const mcp = fakeMcp({ "sera.get_fx_rate": () => ({ rate: "2.0" }) });
  const r = await rates(mcp, "A/B", "2026-06-25T12:00:00Z");
  assert.equal(r[0].mid_rate, "2.0");
  assert.equal(r[0].timestamp, "2026-06-25T12:00:00Z");
});

// ───────────────────────── store TTL ─────────────────────────
test("store expires entries past their TTL", () => {
  let t = 1_000;
  const store = createQuoteStore({ ttlMs: 100, now: () => t });
  const id = store.put({ from: "A", to: "B", amount: "1" });
  assert.ok(store.get(id));
  t = 1_101; // past ttl
  assert.equal(store.get(id), undefined);
});

// ───────────────────────── curated MCP ─────────────────────────
function mcpDeps(handlers: Record<string, (args: any) => unknown>): McpDeps {
  return {
    mcp: fakeMcp(handlers),
    store: createQuoteStore(),
    domain: DOMAIN,
    now: () => "2026-06-25T12:00:00Z",
  };
}

test("MCP initialize + tools/list expose exactly the 4 public tools", async () => {
  const deps = mcpDeps({});
  const init = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    deps,
  )) as any;
  assert.equal(init.result.serverInfo.name, "sera-agents-gateway");
  const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, deps)) as any;
  assert.deepEqual(
    list.result.tools.map((t: any) => t.name).sort(),
    ["corridors", "fx_quote", "fx_settle", "rates"],
  );
  assert.equal(list.result.tools.length, PUBLIC_TOOLS.length);
});

test("MCP tools/call fx_quote returns text content", async () => {
  const deps = mcpDeps({ "sera.get_quote": () => QUOTE_OK });
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fx_quote", arguments: { from_token: "USDC", to_token: "BRLA", amount: "100" } },
    },
    deps,
  )) as any;
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.amount_out, "133.7");
});

test("MCP surfaces tool errors as isError, never exposes hidden tools", async () => {
  const deps = mcpDeps({});
  const res = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "execute_swap", arguments: {} } },
    deps,
  )) as any;
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /unknown tool/);
});

test("MCP notifications return null; unknown methods error", async () => {
  const deps = mcpDeps({});
  assert.equal(
    await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps),
    null,
  );
  const err = (await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "bogus" }, deps)) as any;
  assert.equal(err.error.code, -32601);
});
