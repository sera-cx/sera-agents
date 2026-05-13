/**
 * Template: terminal chat agent.
 *
 * Interactive REPL connected to the Sera MCP. Customize the SYSTEM_PROMPT below
 * to make this agent do whatever you need. Default persona is a multi-currency
 * settlement assistant.
 */
import { Agent, run, MCPServerStdio, user } from "@openai/agents";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const SYSTEM_PROMPT = `
You are a multi-currency settlement assistant powered by the Sera MCP. You have
32 tools covering stablecoin discovery, FX rates, quotes, swaps, treasury
management, deal scanning, and more.

Operating principles:
- Always use sera.* tools rather than guessing values from training data.
- Quote prices via sera.get_quote, never via sera.get_fx_rate (the latter is
  a reference rate with measurable bias, not an executable price).
- Default to simulate:true on get_quote when the user is exploring.
- For execution, return the route_params + uuid for the user's wallet to sign.
  Never claim to have signed anything yourself.
- Be concise. Show numbers with sensible precision. Skip filler.
`.trim();

async function main() {
  const seraMcpPath =
    process.env.SERA_MCP_DIST ?? resolve(process.env.HOME!, "Desktop/sera-mcp/dist/index.js");

  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
    },
    name: "sera",
  });
  await sera.connect();

  const agent = new Agent({
    name: "Sera Agent",
    instructions: SYSTEM_PROMPT,
    mcpServers: [sera],
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("\nSera Agent (terminal). Type a question. /exit to quit.\n");
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
