#!/usr/bin/env node
/**
 * sera-taker — watch a corridor and cross the spread when the rate is right.
 *
 * The mirror image of templates/market-maker: instead of posting resting
 * quotes and waiting to be filled, this CONSUMES liquidity — it polls for an
 * executable rate and fires sera.convert_and_send the moment the edge over a
 * reference mid clears TK_MIN_EDGE_BPS.
 *
 * DRY_RUN by default — it prints the take it WOULD make and changes nothing.
 * Flip TK_DRY_RUN=false only after you've watched the edges for a while and
 * verified the tool responses parse against your sera-mcp version.
 *
 * Signing: this template lets sera-mcp sign (SERA_SIGNER_MODE=local +
 * SIGNER_PRIVATE_KEY) so you don't hand-build conversion intents. The maker
 * template signs Order structs client-side; the taker delegates to the server
 * signer because convert_and_send routes across legs.
 */
import { resolve } from "node:path";
import { startSeraMcp } from "./lib/mcp-client.js";
import { runOneTick, sleep, type TakerConfig, type TakerState, type TakeSide } from "./lib/loop.js";

// ── env config ──────────────────────────────────────────────────────────
// Path to the sera-mcp build. No personal-machine default — set SERA_MCP_DIST
// or drop sera-mcp next to this repo (../../sera-mcp/dist/index.js).
const MCP_PATH =
  process.env.SERA_MCP_DIST ?? resolve(process.cwd(), "../../sera-mcp/dist/index.js");

const PAIR = process.env.TK_PAIR ?? "EURC/USDC";
const SIDE = (process.env.TK_SIDE ?? "buy").toLowerCase() as TakeSide;
const NOTIONAL = Number(process.env.TK_NOTIONAL ?? 100);
const MIN_EDGE_BPS = Number(process.env.TK_MIN_EDGE_BPS ?? 15);
const POLL_SECONDS = Number(process.env.TK_POLL_SECONDS ?? 30);
const DRY_RUN = (process.env.TK_DRY_RUN ?? "true").toLowerCase() !== "false";
// Belt-and-suspenders: a sera-mcp-level POLICY_DRY_RUN=true also forces dry.
const POLICY_DRY = (process.env.POLICY_DRY_RUN ?? "").toLowerCase() === "true";
const NETWORK = process.env.SERA_NETWORK ?? "sepolia";

const OWNER = process.env.SERA_OWNER_ADDRESS;
const RECIPIENT = process.env.TK_RECIPIENT ?? OWNER;

if (SIDE !== "buy" && SIDE !== "sell") {
  process.stderr.write(`\nrefusing to start: TK_SIDE must be "buy" or "sell" (got "${SIDE}").\n\n`);
  process.exit(1);
}
if (!OWNER) {
  process.stderr.write(
    `\nrefusing to start: SERA_OWNER_ADDRESS is required (the wallet that funds + receives takes).\n\n`,
  );
  process.exit(1);
}
if (!process.env.SIGNER_PRIVATE_KEY && !DRY_RUN && !POLICY_DRY) {
  process.stderr.write(
    `\nrefusing to start: live mode (TK_DRY_RUN=false) needs SIGNER_PRIVATE_KEY so sera-mcp can sign conversions.\n` +
      `Use a wallet you've INTENTIONALLY funded for this bot. Sepolia first.\n\n`,
  );
  process.exit(1);
}

const dryRun = DRY_RUN || POLICY_DRY;

if (NETWORK !== "sepolia" && !dryRun && process.env.TK_MAINNET_ACK !== "true") {
  process.stderr.write(
    `\nrefusing to start: SERA_NETWORK=${NETWORK} with live execution.\n` +
      `Set SERA_NETWORK=sepolia for the internal test, or pass TK_MAINNET_ACK=true to go to mainnet.\n\n`,
  );
  process.exit(1);
}

async function main() {
  console.log(
    `\nsera-taker v0.1.0\n` +
      `  network:    ${NETWORK}\n` +
      `  pair:       ${PAIR}\n` +
      `  side:       ${SIDE} (${SIDE === "buy" ? "acquire" : "offload"} ${PAIR.split("/")[0]})\n` +
      `  notional:   ${NOTIONAL} (base units)\n` +
      `  min edge:   ${MIN_EDGE_BPS}bps over mid to take\n` +
      `  poll:       ${POLL_SECONDS}s\n` +
      `  owner:      ${OWNER}\n` +
      `  recipient:  ${RECIPIENT}\n` +
      `  mode:       ${dryRun ? "DRY-RUN (no takes executed)" : "LIVE (takes executed)"}\n` +
      `  mcp:        ${MCP_PATH}\n`,
  );

  const mcp = await startSeraMcp({
    mcpPath: MCP_PATH,
    env: {
      SERA_NETWORK: NETWORK,
      SERA_SIGNER_MODE: "local", // sera-mcp signs conversion intents from SIGNER_PRIVATE_KEY
      SERA_ENABLE_EXECUTION_TOOLS: "true",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "starter",
      LOG_LEVEL: "warn",
    },
  });

  // Boot sanity check.
  console.log(`reading sera.doctor for network sanity…`);
  const doctor = await mcp.tool<{
    overall_ok: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }>("sera.doctor");
  if (!doctor.overall_ok) {
    console.error("doctor.overall_ok=false. Checks:");
    for (const c of doctor.checks) console.error(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    process.exit(2);
  }

  const cfg: TakerConfig = {
    pair: PAIR,
    side: SIDE,
    notional: NOTIONAL,
    minEdgeBps: MIN_EDGE_BPS,
    pollSeconds: POLL_SECONDS,
    dryRun,
    ownerAddress: OWNER!,
    recipient: RECIPIENT!,
  };
  const state: TakerState = {
    lastMid: null,
    ticks: 0,
    takesExecuted: 0,
    takesFailed: 0,
    errors: 0,
  };

  console.log(`\nstarting loop. Ctrl-C to stop.\n`);

  process.on("SIGINT", () => {
    console.log(
      `\n\nSIGINT — stopping.\n` +
        `final stats: ticks=${state.ticks} taken=${state.takesExecuted} failed=${state.takesFailed} errors=${state.errors}`,
    );
    mcp.close();
    process.exit(0);
  });

  for (;;) {
    await runOneTick(mcp, cfg, state);
    await sleep(POLL_SECONDS);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
