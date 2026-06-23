/**
 * Behavioral tests for the taker loop, driven by a mock sera-mcp that returns
 * the documented response shapes. No live backend. Run: `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOneTick, type TakerConfig, type TakerState } from "../lib/loop.js";
import type { SeraMcpClient } from "../lib/mcp-client.js";

type ToolFn = (name: string, args?: any) => any;

function mock(tool: ToolFn): SeraMcpClient {
  return {
    async tool(name: string, args?: any) { return tool(name, args); },
    async rpc() { return {}; },
    close() {},
    running() { return true; },
  };
}

const baseCfg: TakerConfig = {
  pair: "EURC/USDC", side: "buy", notional: 100, notionalUsd: 100,
  minEdgeBps: 15, gasMode: "receive_less", pollSeconds: 1,
  dryRun: true, ownerAddress: "0xowner", recipient: "0xowner",
};
const newState = (): TakerState => ({ ticks: 0, takesExecuted: 0, takesFailed: 0, errors: 0 });

/** Run one tick capturing the loop's console.log lines. */
async function capture(mcp: SeraMcpClient, cfg: TakerConfig, state: TakerState): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  try { await runOneTick(mcp, cfg, state); } finally { console.log = orig; }
  return lines;
}

// USDC=6 decimals, EURC=18. find_deals returns directional buckets.
const dealsMock = (edgeBps: number, rate: number, vaultUsdcRaw: string): ToolFn => (name) => {
  if (name === "sera.find_deals") return {
    good_buy: [{ pair: "EURC/USDC", rate, deviation_bps: edgeBps }], good_sell: [], fair: [],
  };
  if (name === "sera.get_balances") return {
    balances: [{ symbol: "USDC", vault_available: vaultUsdcRaw, wallet_balance: "0", decimals: 6 }],
  };
  if (name === "sera.convert_and_send") return { trade_id: "T1", status: "delivered" };
  throw new Error(`unexpected tool ${name}`);
};

test("takes on a funded buy whose edge clears the gate, with correct convert_and_send args", async () => {
  const lines = await capture(mock(dealsMock(30, 1.08, "1000000000")), baseCfg, newState());
  const take = lines.find((l) => l.includes("[DRY-RUN] would take"));
  assert.ok(take, "should emit a dry-run take");
  assert.match(take!, /"from":"USDC"/);            // buy spends quote
  assert.match(take!, /"to":"EURC"/);              // receives base
  assert.match(take!, /"amount":"108"/);           // notional(100) × rate(1.08)
  assert.match(take!, /"gas_mode":"receive_less"/);
});

test("holds when the edge is below TK_MIN_EDGE_BPS", async () => {
  const lines = await capture(mock(dealsMock(5, 1.08, "1000000000")), baseCfg, newState());
  assert.ok(!lines.some((l) => l.includes("would take")));
  assert.ok(lines.some((l) => l.includes("hold")));
});

test("holds (live) when the raw-scaled vault balance cannot fund the take", async () => {
  // 50 USDC raw (5e7, 6 decimals) = 50 human < needed 108.
  const state = newState();
  const lines = await capture(mock(dealsMock(30, 1.08, "50000000")), { ...baseCfg, dryRun: false }, state);
  assert.ok(lines.some((l) => l.includes("inventory guard")), "should hit the inventory guard");
  assert.equal(state.takesExecuted, 0);
});

test("executes (live) and counts the take when funded", async () => {
  const state = newState();
  await capture(mock(dealsMock(30, 1.08, "1000000000")), { ...baseCfg, dryRun: false }, state);
  assert.equal(state.takesExecuted, 1);
});

test("sell side reads good_sell, not good_buy", async () => {
  const sellMock: ToolFn = (name) => {
    if (name === "sera.find_deals") return { good_buy: [{ pair: "EURC/USDC", rate: 1.08, deviation_bps: 99 }], good_sell: [], fair: [] };
    if (name === "sera.get_balances") return { balances: [{ symbol: "EURC", vault_available: "1000000000000000000000", decimals: 18 }] };
    throw new Error(name);
  };
  const lines = await capture(mock(sellMock), { ...baseCfg, side: "sell" }, newState());
  assert.ok(lines.some((l) => l.includes("no favorable sell deal")));
});

test("holds when find_deals is unavailable (never acts on missing data)", async () => {
  const lines = await capture(mock(() => { throw new Error("boom"); }), baseCfg, newState());
  assert.ok(lines.some((l) => l.includes("find_deals unavailable")));
  assert.ok(!lines.some((l) => l.includes("would take")));
});
