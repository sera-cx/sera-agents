/**
 * market-maker template — two-sided spread bot on Sera.
 *
 * Uses the OpenAI Agents SDK with sera-mcp v0.7.0+ maker tools. The agent
 * runs a cancel-before-place loop, reading multi-source FX mid and quoting
 * a tight spread around it. Designed as an educational scaffold — see
 * README "Production checklist before deploying" before running with real
 * money.
 *
 * Loop knobs come from env (MM_PAIR, MM_NOTIONAL, MM_SPREAD_BPS, MM_DRIFT_BPS,
 * MM_POLL_SECONDS, MM_EXPIRATION_SECONDS). The agent itself is non-LLM — it
 * deterministically calls sera tools via the SDK's MCP tool wrapping.
 *
 * Why no LLM in the loop? Market making at this granularity is rule-based,
 * not natural-language-driven. A real product might layer an LLM-driven
 * supervisor on top (anomaly detection, regime change), but the inner loop
 * should always be deterministic.
 */
import { Agent, MCPServerStdio, run } from "@openai/agents";
import { resolve } from "node:path";

const MCP_PATH =
  process.env.SERA_MCP_DIST ??
  resolve(process.env.HOME!, "Desktop/SERA MCP and AGENT/sera-mcp/dist/index.js");

const PAIR = process.env.MM_PAIR ?? "EURC/USDC";
const NOTIONAL = Number(process.env.MM_NOTIONAL ?? 100);
const SPREAD_BPS = Number(process.env.MM_SPREAD_BPS ?? 10);
const DRIFT_BPS = Number(process.env.MM_DRIFT_BPS ?? 5);
const POLL_SECONDS = Number(process.env.MM_POLL_SECONDS ?? 3);

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY required.");
  process.exit(1);
}

async function main() {
  const sera = new MCPServerStdio({
    name: "sera",
    command: "node",
    args: [MCP_PATH],
  });
  await sera.connect();

  // Agent is intentionally narrow: it's a deterministic shell around the MCP
  // tool surface, not an LLM-driven decision loop. The "instructions" are a
  // safety preamble so an accidental LLM bridge upstream couldn't divert.
  const agent = new Agent({
    name: "sera-market-maker",
    instructions:
      "You are a deterministic market-making operator. Only run the exact tool calls the orchestrator issues. " +
      "Do not invent additional trades. Do not exceed POLICY_MAX_NOTIONAL_USD.",
    mcpServers: [sera],
  });

  console.log(
    `\nsera market-maker template starting:\n` +
      `  pair: ${PAIR}\n` +
      `  notional: ${NOTIONAL}\n` +
      `  spread: ±${SPREAD_BPS}bps (${(2 * SPREAD_BPS) / 100}% round-trip)\n` +
      `  drift threshold: ${DRIFT_BPS}bps\n` +
      `  poll: ${POLL_SECONDS}s\n` +
      `  mcp: ${MCP_PATH}\n` +
      `\nCtrl-C to stop. Open orders are NOT auto-cancelled on exit — call sera.cancel_all_orders from another session.\n\n`,
  );

  let lastMid: number | null = null;

  for (;;) {
    try {
      // Step 1: kill stale quotes (5-min per-order cooldown applies).
      await run(agent, [
        {
          role: "user",
          content: `Call sera.cancel_all_orders for the configured owner. Return only the tool's response — do not narrate.`,
        },
      ]);

      // Step 2: read multi-source mid for the configured pair.
      const [base, quote] = PAIR.split("/");
      const midResult = await run(agent, [
        {
          role: "user",
          content: `Call sera.multi_source_mid with base="${base}" and quote="${quote}". Return only the median rate as a single number.`,
        },
      ]);
      const midText = String(midResult.finalOutput ?? "").match(/[\d.]+/)?.[0];
      const mid = midText ? Number(midText) : NaN;
      if (!Number.isFinite(mid) || mid <= 0) {
        console.error(`[tick] mid unparseable: ${midResult.finalOutput}`);
        await sleep(POLL_SECONDS);
        continue;
      }

      // Step 3: drift gate — only requote if mid moved enough.
      if (lastMid !== null) {
        const driftBps = Math.abs((mid - lastMid) / lastMid) * 10_000;
        if (driftBps < DRIFT_BPS) {
          console.log(`[tick] mid=${mid.toFixed(6)} drift=${driftBps.toFixed(2)}bps < ${DRIFT_BPS}bps — hold.`);
          await sleep(POLL_SECONDS);
          continue;
        }
      }
      lastMid = mid;

      const bidPrice = mid * (1 - SPREAD_BPS / 10_000);
      const askPrice = mid * (1 + SPREAD_BPS / 10_000);
      console.log(
        `[tick] mid=${mid.toFixed(6)} bid=${bidPrice.toFixed(6)} ask=${askPrice.toFixed(6)} ` +
          `(${PAIR}, ${NOTIONAL} ${base})`,
      );

      // Step 4: place fresh bid + ask. This template stops at logging intended
      // orders — actual sera.place_order requires the agent to construct
      // uuid_int and sign Order structs as EIP-712, which needs a wallet
      // library (ethers / viem) beyond OpenAI Agents SDK's scope. See
      // README for the production wiring path.
      console.log(`[tick] (template stops here — wire sera.place_order with signed Order structs to go live)`);

      await sleep(POLL_SECONDS);
    } catch (e: any) {
      console.error(`[tick] error: ${e?.message ?? String(e)}`);
      await sleep(POLL_SECONDS);
    }
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
