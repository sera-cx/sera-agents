#!/usr/bin/env node
/**
 * sera-market-maker — Sepolia-safe two-sided spread bot driver.
 *
 * Reads env config, boots sera-mcp, fetches market + chain context, then
 * runs the cancel-before-place loop in lib/loop.ts. DRY_RUN by default —
 * flip MM_DRY_RUN=false to start actually placing orders.
 *
 * The agent code path is deterministic — no LLM in the inner loop. An
 * optional supervisor layer (Manus, Claude, OpenAI Agents SDK) can wrap
 * this for anomaly-detection / regime-change adjustments, but the trade
 * loop itself is rule-based.
 */
import { Wallet } from "ethers";
import { resolve } from "node:path";
import { startSeraMcp } from "./lib/mcp-client.js";
import { runOneTick, sleep, type LoopConfig, type LoopState, type MarketInfo } from "./lib/loop.js";

// ── env config ──────────────────────────────────────────────────────────
// Path to the sera-mcp build. No personal-machine default — set SERA_MCP_DIST
// or drop sera-mcp next to this repo (../../sera-mcp/dist/index.js).
const MCP_PATH =
  process.env.SERA_MCP_DIST ?? resolve(process.cwd(), "../../sera-mcp/dist/index.js");

const PAIR = process.env.MM_PAIR ?? "EURC/USDC";
const NOTIONAL = Number(process.env.MM_NOTIONAL ?? 100);
const SPREAD_BPS = Number(process.env.MM_SPREAD_BPS ?? 10);
const DRIFT_BPS = Number(process.env.MM_DRIFT_BPS ?? 5);
const POLL_SECONDS = Number(process.env.MM_POLL_SECONDS ?? 60);
const EXPIRATION_SECONDS = Number(process.env.MM_EXPIRATION_SECONDS ?? 3600);
// MM_DRY_RUN is THE live switch. A sera-mcp-level POLICY_DRY_RUN=true also
// forces dry-run (belt-and-suspenders) so the two flags can't disagree.
const POLICY_DRY = (process.env.POLICY_DRY_RUN ?? "").toLowerCase() === "true";
const DRY_RUN = (process.env.MM_DRY_RUN ?? "true").toLowerCase() !== "false" || POLICY_DRY;
const NETWORK = process.env.SERA_NETWORK ?? "sepolia";

const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  process.stderr.write(
    `\nrefusing to start: SIGNER_PRIVATE_KEY is required (the wallet that signs Order structs).\n` +
      `Use a wallet you've INTENTIONALLY funded for this bot. Sepolia first.\n\n`,
  );
  process.exit(1);
}
if (NETWORK !== "sepolia" && DRY_RUN === false) {
  process.stderr.write(
    `\nrefusing to start: SERA_NETWORK=${NETWORK} with MM_DRY_RUN=false.\n` +
      `Set SERA_NETWORK=sepolia for the internal test. Live mainnet maker mode requires\n` +
      `explicit MM_MAINNET_ACK=true (not set).\n\n`,
  );
  if (process.env.MM_MAINNET_ACK !== "true") process.exit(1);
}

async function main() {
  const wallet = new Wallet(PRIVATE_KEY!);
  const ownerAddress = wallet.address;

  console.log(
    `\nsera-market-maker v0.3.0\n` +
      `  network:     ${NETWORK}\n` +
      `  pair:        ${PAIR}\n` +
      `  notional:    ${NOTIONAL} (base units)\n` +
      `  spread:      ±${SPREAD_BPS}bps (round-trip ${(2 * SPREAD_BPS) / 100}%)\n` +
      `  drift gate:  ${DRIFT_BPS}bps\n` +
      `  poll:        ${POLL_SECONDS}s\n` +
      `  expiration:  ${EXPIRATION_SECONDS}s per order\n` +
      `  wallet:      ${ownerAddress}\n` +
      `  mode:        ${DRY_RUN ? "DRY-RUN (no orders submitted)" : "LIVE (orders submitted)"}\n` +
      `  mcp:         ${MCP_PATH}\n`,
  );

  // Boot sera-mcp with the SAME network + signer-mode setup, propagating the
  // wallet key so server-side signing works if anyone wants to use it. We
  // sign Order structs client-side regardless — server-side signer is
  // unused by this template.
  const mcp = await startSeraMcp({
    mcpPath: MCP_PATH,
    env: {
      SERA_NETWORK: NETWORK,
      SERA_SIGNER_MODE: "external",            // we sign locally
      SERA_ENABLE_EXECUTION_TOOLS: "true",     // we need place_order
      POLICY_PRESET: process.env.POLICY_PRESET ?? "starter",
      LOG_LEVEL: "warn",
    },
  });

  // Boot sanity checks via sera.doctor.
  console.log(`reading sera.doctor for executor_id + network sanity…`);
  const doctor = await mcp.tool<{
    overall_ok: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }>("sera.doctor");
  if (!doctor.overall_ok) {
    console.error("doctor.overall_ok=false. Checks:");
    for (const c of doctor.checks) console.error(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    process.exit(2);
  }
  const executorIdCheck = doctor.checks.find((c) => c.name === "executor_id");
  const executorId = parseExecutorId(executorIdCheck?.detail) ?? 0n;
  console.log(`  executor_id=${executorId}`);

  // Pull live contract addresses from sera://config (not hardcoded — Sera docs say so).
  // We expose this via the doctor 'contracts' check.
  const contractsCheck = doctor.checks.find((c) => c.name === "contracts");
  const { seraAddress, chainId } = parseContracts(contractsCheck?.detail, NETWORK);
  console.log(`  sera=${seraAddress} chainId=${chainId}`);

  // Look up market info.
  console.log(`looking up market ${PAIR}…`);
  const market = await findMarket(mcp, PAIR);
  console.log(
    `  base=${market.base_symbol} (${market.base_address.slice(0, 8)}…, ${market.base_decimals}d) ` +
      `quote=${market.quote_symbol} (${market.quote_address.slice(0, 8)}…, ${market.quote_decimals}d)`,
  );

  const cfg: LoopConfig = {
    pair: PAIR,
    notional: NOTIONAL,
    spreadBps: SPREAD_BPS,
    driftBps: DRIFT_BPS,
    pollSeconds: POLL_SECONDS,
    expirationSeconds: EXPIRATION_SECONDS,
    dryRun: DRY_RUN,
    wallet,
    ownerAddress,
    chainId,
    seraAddress,
    executorId,
  };
  const state: LoopState = {
    lastMid: null,
    ticks: 0,
    ordersPosted: 0,
    ordersFailed: 0,
    errors: 0,
  };

  // Restart safety: if a previous run crashed with orders still resting, clear
  // them before we start posting fresh quotes (otherwise we stack duplicates).
  if (!DRY_RUN) {
    console.log(`startup cancel_all_orders (clearing any stale quotes from a prior run)…`);
    try {
      const r = await mcp.tool<{ total: number }>("sera.cancel_all_orders", { owner_address: ownerAddress });
      console.log(`  cancelled ${r.total ?? 0} stale order(s).`);
    } catch (e: any) {
      console.error(`  startup cancel warning: ${e?.message ?? String(e)}`);
    }
  }

  console.log(`\nstarting loop. Ctrl-C to stop.\n`);

  // Graceful shutdown: on Ctrl-C, attempt one final cancel_all_orders.
  process.on("SIGINT", async () => {
    console.log(`\n\nSIGINT — attempting final cancel_all_orders…`);
    try {
      const r = await mcp.tool<{ total: number }>("sera.cancel_all_orders", { owner_address: ownerAddress });
      console.log(`  cancelled ${r.total ?? 0} on exit.`);
    } catch (e: any) {
      console.error(`  cancel-on-exit warning: ${e?.message ?? String(e)}`);
    }
    console.log(`\nfinal stats: ticks=${state.ticks} posted=${state.ordersPosted} failed=${state.ordersFailed} errors=${state.errors}`);
    mcp.close();
    process.exit(0);
  });

  for (;;) {
    await runOneTick(mcp, market, cfg, state);
    await sleep(POLL_SECONDS);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseExecutorId(detail?: string): bigint | null {
  // detail format: "executor_id=0 (matches expected for mainnet)"
  const m = detail?.match(/executor_id=(\d+)/);
  return m ? BigInt(m[1]) : null;
}

function parseContracts(detail: string | undefined, network: string): { seraAddress: string; chainId: number } {
  // detail format: "sera=0xB5C5…E198 vault=0xC7d4…4D43 sor=0xa7A0…1c18"
  const m = detail?.match(/sera=(0x[0-9a-fA-F]{40})/);
  if (!m) {
    throw new Error(`Could not extract sera contract address from doctor. Got: ${detail ?? "(undefined)"}`);
  }
  return {
    seraAddress: m[1],
    chainId: network === "mainnet" ? 1 : 11155111,
  };
}

interface SeraMarket {
  symbol: string;
  base_address: string;
  quote_address: string;
  base_symbol: string;
  quote_symbol: string;
  base_decimals: number;
  quote_decimals: number;
}

async function findMarket(mcp: Awaited<ReturnType<typeof startSeraMcp>>, pair: string): Promise<MarketInfo> {
  const r = await mcp.tool<{ markets: SeraMarket[] }>("sera.get_markets");
  const target = pair.toUpperCase();
  const match = r.markets.find((m) => m.symbol?.toUpperCase() === target);
  if (!match) {
    const available = r.markets.map((m) => m.symbol).slice(0, 20).join(", ");
    throw new Error(
      `market "${pair}" not found in /markets. Available (first 20): ${available}.`,
    );
  }
  if (!match.base_address || !match.quote_address) {
    throw new Error(`market "${pair}" missing base/quote addresses: ${JSON.stringify(match)}`);
  }
  return match;
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
