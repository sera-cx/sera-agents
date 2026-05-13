/**
 * Cross-currency invoice payer.
 *
 * A minimal agent that demonstrates the Sera-for-Agents flow:
 * "I owe X of currency Y to address Z — find the cheapest source in my
 *  treasury and produce the executable swap."
 *
 * Uses the OpenAI Agents SDK (https://github.com/openai/openai-agents-js)
 * which speaks MCP natively. Swap the Agent class for Anthropic's SDK if you
 * prefer Claude — the MCP tool surface is identical.
 *
 * Run:
 *   npm install
 *   OPENAI_API_KEY=sk-... npm run start -- \
 *     --owner 0xYou --recipient 0xVendor --amount 5000 --currency MYR \
 *     --sources USDC,USDT,EURC
 */
import { Agent, run, MCPServerStdio } from "@openai/agents";
import { resolve } from "node:path";

interface Args {
  owner: string;
  recipient: string;
  amount: number;
  currency: string;
  sources: string[];
  seraMcpDist?: string;
}

// Strict validators — args land in agent natural-language instructions, so we
// can't accept arbitrary strings without inviting prompt injection.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FIAT_RE = /^[A-Za-z]{3}$/;
const SYMBOL_RE = /^[A-Za-z][A-Za-z0-9]{1,11}$/;

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const owner = get("owner");
  const recipient = get("recipient");
  const amountStr = get("amount");
  const currency = get("currency");
  const sourcesStr = get("sources") ?? "USDC,USDT,EURC";
  const seraMcpDist = get("sera-mcp-dist");

  if (!owner || !recipient || !amountStr || !currency) {
    throw new Error(
      "usage: --owner 0x... --recipient 0x... --amount <num> --currency <ISO> [--sources USDC,USDT,EURC] [--sera-mcp-dist /path/to/dist/index.js]",
    );
  }
  if (!ADDR_RE.test(owner)) throw new Error(`--owner must be a 0x-prefixed 40-hex address`);
  if (!ADDR_RE.test(recipient)) throw new Error(`--recipient must be a 0x-prefixed 40-hex address`);
  if (!FIAT_RE.test(currency)) throw new Error(`--currency must be a 3-letter ISO code`);
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number");
  const sources = sourcesStr.split(",").map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) throw new Error("--sources must list at least one symbol");
  for (const s of sources) {
    if (!SYMBOL_RE.test(s)) throw new Error(`--sources contains bad symbol "${s}"`);
  }
  return {
    owner,
    recipient,
    amount,
    currency: currency.toUpperCase(),
    sources: sources.map((s) => s.toUpperCase()),
    seraMcpDist,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seraMcpPath =
    args.seraMcpDist ?? resolve(process.env.HOME!, "Desktop/sera-mcp/dist/index.js");

  // Spin up the Sera MCP as a subprocess. The Agent SDK speaks MCP and will
  // auto-discover the 32 sera.* tools.
  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: "mainnet",
      POLICY_PRESET: "standard",
      LOG_LEVEL: "warn",
    },
    name: "sera",
  });
  await sera.connect();

  const agent = new Agent({
    name: "Sera invoice payer",
    instructions: `
You are a cross-currency invoice payer. The user owes ${args.amount} ${args.currency}
to recipient ${args.recipient}, paying from owner wallet ${args.owner}, with
candidate source stablecoins: ${args.sources.join(", ")}.

Your job:
1. Call sera.pay_invoice with these parameters. It returns a ranked list of
   source assets sorted by USD-equivalent cost.
2. Print the cheapest source, the runner-up, and any sources that failed.
3. Construct and print the EXACT sera.get_quote call the user would invoke to
   execute the cheapest path. Use gas_mode "pay_more" since the recipient must
   receive the exact target amount.
4. Do NOT execute any swap — this agent only plans.

Be terse. No filler. Just the plan.
`.trim(),
    mcpServers: [sera],
  });

  const result = await run(
    agent,
    `Plan the cheapest path to pay ${args.amount} ${args.currency} to ${args.recipient} ` +
      `from owner ${args.owner} using available sources [${args.sources.join(", ")}].`,
  );

  console.log(result.finalOutput);

  await sera.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
