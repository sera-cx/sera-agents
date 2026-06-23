/**
 * Regression tests for the maker loop's inventory guard, driven by a mock
 * sera-mcp returning the documented get_balances shape. No live backend.
 *
 * Guards the bug where fundableSides read a non-existent `.available` field
 * (-> NaN -> 0) and skipped BOTH sides on every live tick. Run: `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { runOneTick, type LoopConfig, type LoopState, type MarketInfo } from "../lib/loop.js";
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

const market: MarketInfo = {
  symbol: "EURC/USDC",
  base_address: "0x" + "1".repeat(40),
  quote_address: "0x" + "2".repeat(40),
  base_symbol: "EURC", quote_symbol: "USDC",
  base_decimals: 18, quote_decimals: 6,
};

const cfg = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  pair: "EURC/USDC", notional: 100, spreadBps: 10, driftBps: 5,
  pollSeconds: 1, expirationSeconds: 3600, dryRun: true,
  wallet: new Wallet("0x" + "1".repeat(64)), ownerAddress: "0x" + "a".repeat(40),
  chainId: 11155111, seraAddress: "0x" + "3".repeat(40), executorId: 0n, ...over,
});
const newState = (): LoopState => ({ lastMid: null, ticks: 0, ordersPosted: 0, ordersFailed: 0, errors: 0 });

async function capture(mcp: SeraMcpClient, c: LoopConfig, s: LoopState): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { lines.push(a.join(" ")); };
  try { await runOneTick(mcp, market, c, s); } finally { console.log = orig; }
  return lines;
}

// mid ~1.08; balances in RAW units (USDC 6dp, EURC 18dp).
const baseMock = (usdcRaw: string, eurcRaw: string): ToolFn => (name) => {
  if (name === "sera.cancel_all_orders") return { total: 0 };
  if (name === "sera.multi_source_mid") return { median: "1.08" };
  if (name === "sera.get_balances") return {
    balances: [
      { symbol: "USDC", vault_available: usdcRaw, wallet_balance: "0", decimals: 6 },
      { symbol: "EURC", vault_available: eurcRaw, wallet_balance: "0", decimals: 18 },
    ],
  };
  throw new Error(`unexpected tool ${name}`);
};

test("posts BOTH sides when the vault funds both (the #1 regression guard)", async () => {
  // 1000 USDC (raw 1e9) funds the bid (~108); 1000 EURC funds the ask (100).
  const lines = await capture(mock(baseMock("1000000000", "1000" + "0".repeat(18))), cfg(), newState());
  assert.ok(lines.some((l) => l.includes("[DRY-RUN] BID")), "bid must be posted");
  assert.ok(lines.some((l) => l.includes("[DRY-RUN] ASK")), "ask must be posted");
  assert.ok(!lines.some((l) => l.includes("skipped")), "neither side should be skipped");
});

test("skips only the underfunded side", async () => {
  // Plenty of USDC for the bid, but ~0 EURC -> ask can't be funded.
  const lines = await capture(mock(baseMock("1000000000", "0")), cfg(), newState());
  assert.ok(lines.some((l) => l.includes("[DRY-RUN] BID")), "bid still posted");
  assert.ok(lines.some((l) => l.includes("ASK skipped")), "ask skipped (no base inventory)");
});

test("fails OPEN (posts both) when get_balances errors", async () => {
  const m: ToolFn = (name) => {
    if (name === "sera.cancel_all_orders") return { total: 0 };
    if (name === "sera.multi_source_mid") return { median: "1.08" };
    if (name === "sera.get_balances") throw new Error("no api key");
    throw new Error(name);
  };
  const lines = await capture(mock(m), cfg(), newState());
  assert.ok(lines.some((l) => l.includes("[DRY-RUN] BID")));
  assert.ok(lines.some((l) => l.includes("[DRY-RUN] ASK")));
});
