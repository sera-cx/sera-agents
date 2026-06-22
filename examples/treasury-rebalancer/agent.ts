/**
 * Treasury rebalancer.
 *
 * Demonstrates the multi-wallet treasury flow:
 * "Value my N wallets in target currency, show drift from desired weights,
 *  emit the trade list to rebalance."
 *
 * Pure planning — does NOT execute. With a signing wallet you can chain into
 * sera.execute_swap separately.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npm run start -- \
 *     --wallets 0xA,0xB,0xC \
 *     --target USD:40,SGD:30,MYR:20,EUR:10 \
 *     --reporting-currency USD
 */
import { Agent, run, MCPServerStdio } from "@openai/agents";
import { resolve } from "node:path";

interface Args {
  wallets: string[];
  targetWeights: Record<string, number>;
  reportingCurrency: string;
  seraMcpDist?: string;
}

// Strict validators — args land in agent natural-language instructions.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FIAT_RE = /^[A-Za-z]{3}$/;

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const walletsRaw = get("wallets");
  const targetRaw = get("target");
  const ccy = get("reporting-currency") ?? "USD";

  if (!walletsRaw || !targetRaw) {
    throw new Error(
      "usage: --wallets 0x...,0x... --target USD:40,SGD:30,MYR:20 [--reporting-currency USD]",
    );
  }

  const wallets = walletsRaw.split(",").map((w) => w.trim()).filter(Boolean);
  if (wallets.length === 0) throw new Error("--wallets must list at least one address");
  for (const w of wallets) {
    if (!ADDR_RE.test(w)) throw new Error(`--wallets contains invalid address: "${w}"`);
  }
  if (!FIAT_RE.test(ccy)) throw new Error(`--reporting-currency must be a 3-letter ISO code`);

  const targetWeights: Record<string, number> = {};
  for (const part of targetRaw.split(",")) {
    const [fiat, weightStr] = part.split(":");
    if (!fiat || !weightStr) throw new Error(`bad --target weight: "${part}"`);
    if (!FIAT_RE.test(fiat)) throw new Error(`--target fiat code "${fiat}" must be 3 letters`);
    const w = Number(weightStr);
    if (!Number.isFinite(w) || w < 0) throw new Error(`--target weight "${weightStr}" must be >= 0`);
    targetWeights[fiat.toUpperCase()] = w;
  }
  if (Object.keys(targetWeights).length === 0) throw new Error("--target must list at least one weight");

  return {
    wallets,
    targetWeights,
    reportingCurrency: ccy.toUpperCase(),
    seraMcpDist: get("sera-mcp-dist"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seraMcpPath =
    args.seraMcpDist ?? process.env.SERA_MCP_DIST ?? resolve(process.cwd(), "../../sera-mcp/dist/index.js");

  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: "mainnet",
      POLICY_PRESET: "standard",
      LOG_LEVEL: "warn",
      // get_balances + treasury_value require Sera API auth — these must be set
      // in the environment when you run the agent.
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
    },
    name: "sera",
  });
  await sera.connect();

  const targetJson = JSON.stringify(args.targetWeights);
  const walletsJson = JSON.stringify(args.wallets);

  const agent = new Agent({
    name: "Sera treasury rebalancer",
    instructions: `
You are a treasury rebalancer for a multi-wallet stablecoin portfolio.

Wallets:           ${walletsJson}
Target weights:    ${targetJson}
Reporting ccy:     ${args.reportingCurrency}

Steps:
1. Call sera.treasury_value with these wallets in the reporting currency.
   Note the total value and per-currency exposure.
2. Call sera.rebalance_plan with the same wallets and target_weights.
3. Format the output like this:

   Treasury value: $X total across N wallets

   Current exposure:
     <FIAT>  $value  (pct%)   target X%   ↑/↓ delta_pp

   Suggested trades:
     1. Move ~$X (reporting ccy) FROM_FIAT → TO_FIAT  (reason)
     2. ...
     (skip any drift < 1 percentage point)

4. Do NOT execute any swap. Pure planner.

Be terse. No filler.
`.trim(),
    mcpServers: [sera],
  });

  const result = await run(
    agent,
    `Produce the rebalance plan for wallets ${args.wallets.join(", ")} ` +
      `targeting ${Object.entries(args.targetWeights).map(([f, w]) => `${f}:${w}%`).join(", ")} ` +
      `valued in ${args.reportingCurrency}.`,
  );

  console.log(result.finalOutput);

  await sera.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
