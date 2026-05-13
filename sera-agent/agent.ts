/**
 * Sera Agent — the bundled stack.
 *
 * Interactive terminal chat surface that connects an LLM-powered agent to
 * the Sera MCP. For users without an existing agent, this is the one-command
 * end-to-end experience.
 *
 * Provider: defaults to OpenAI (Agents SDK). Set SERA_AGENT_PROVIDER=anthropic
 * to swap, with a small adapter (not included by default — keep deps tight).
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npm start
 */
import { Agent, run, MCPServerStdio, user } from "@openai/agents";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const SYSTEM_INSTRUCTIONS = `
You are the Sera Agent — a multi-currency settlement assistant powered by
the Sera MCP. You have 32 tools covering stablecoin discovery, FX rates,
quotes, swaps, treasury management, deal scanning, and more.

Operating principles:
- Always use sera.* tools rather than guessing values from training data.
- Quote prices via sera.get_quote, never via sera.get_fx_rate (the latter is
  a reference rate with measurable bias, not an executable price).
- Default to simulate:true on get_quote when the user is exploring rather
  than executing.
- For execution, you only return the route_params + uuid for the user's
  wallet to sign. Never claim to have signed anything yourself.
- Be concise. Show numbers with sensible precision. Skip filler.

Common workflows:
- "Pay X of currency Y to address Z": use sera.pay_invoice
- "What's my treasury worth in SGD?": use sera.treasury_value
- "Find me deals right now": use sera.find_deals
- "Spread at 15bps on N notional": use sera.maker_quote_ladder
- "Health check the connection": use sera.doctor
`.trim();

async function main() {
  const seraMcpPath =
    process.env.SERA_MCP_DIST ??
    resolve(process.env.HOME!, "Desktop/sera-mcp/dist/index.js");

  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
      ...(process.env.SERA_HISTORY_DB ? { SERA_HISTORY_DB: process.env.SERA_HISTORY_DB } : {}),
    },
    name: "sera",
  });
  await sera.connect();

  const agent = new Agent({
    name: "Sera Agent",
    instructions: SYSTEM_INSTRUCTIONS,
    mcpServers: [sera],
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\nSera Agent — interactive multi-currency settlement assistant.");
  console.log("Type your question. Ctrl+C to exit.\n");

  // Maintain conversation state across turns.
  const history: any[] = [];

  const ask = () => {
    rl.question("> ", async (line) => {
      const q = line.trim();
      if (!q) return ask();
      if (q === "/exit" || q === "/quit") {
        await sera.close();
        rl.close();
        return;
      }
      try {
        history.push(user(q));
        const result = await run(agent, history);
        // OpenAI Agents SDK pattern: append the assistant turn back into history.
        history.push(...result.newItems);
        console.log("\n" + result.finalOutput + "\n");
      } catch (e: any) {
        console.error("\nerror: " + (e?.message ?? String(e)) + "\n");
      }
      ask();
    });
  };

  ask();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
