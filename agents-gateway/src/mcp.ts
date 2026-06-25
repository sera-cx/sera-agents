import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Handlers } from "./handlers.js";

const PairsSchema = {
  pairs: z
    .string()
    .optional()
    .describe('Comma-separated currency pairs, e.g. "USDC/BRLA,XSGD/IDRX"'),
};

const QuoteSchema = {
  from_token: z.string().describe("Source token / currency code (e.g. XSGD)"),
  to_token: z.string().describe("Destination token / currency code (e.g. IDRX)"),
  amount: z.string().describe("Amount in from_token human units"),
};

const SettleSchema = {
  quote_id: z.string().describe("quote_id returned by fx_quote"),
  signer: z.string().describe("Caller wallet address (0x-prefixed)"),
};

const CorridorsSchema = {};

function asText<T>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function buildMcpServer(handlers: Handlers): McpServer {
  const server = new McpServer({ name: "sera-agents-gateway", version: "0.1.0" });

  // The MCP SDK's tool() generic blows up on Zod v3/v4 compat inference (TS2589),
  // so we cast schema args at the call site. Runtime validation still runs via Zod;
  // handler param types below stay explicit, so app-level type safety is intact.
  (server.tool as any)(
    "fx_quote",
    "Get a live FX quote between any pair of supported stablecoins. Returns amount_out, mid_rate, network_cost, and a quote_id that fx_settle consumes.",
    QuoteSchema,
    async (args: { from_token: string; to_token: string; amount: string }) =>
      asText(await handlers.quote(args)),
  );

  (server.tool as any)(
    "fx_settle",
    "Build an unsigned EIP-712 settlement transaction from a quote. Returns typed_data the caller signs in their wallet.",
    SettleSchema,
    async (args: { quote_id: string; signer: string }) =>
      asText(await handlers.settle(args)),
  );

  (server.tool as any)(
    "corridors",
    "List supported FX corridors, currencies, and liquidity depth.",
    async () => asText(await handlers.corridors()),
  );

  (server.tool as any)(
    "rates",
    "Fetch live reference rates. Pass `pairs` as a comma-separated list, e.g. USDC/BRLA,XSGD/IDRX.",
    PairsSchema,
    async (args: { pairs?: string }) => {
      const pairs = (args.pairs ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (pairs.length === 0) throw new Error("rates: at least one pair is required");
      return asText(await handlers.rates(pairs));
    },
  );

  return server;
}

export async function handleMcpRequest(
  mcpServer: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown = undefined;
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close().catch(() => {}));
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}
