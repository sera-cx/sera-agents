/**
 * Curated MCP surface for POST /mcp.
 *
 * This is NOT a passthrough to sera-mcp's own /mcp (which exposes all 50+ tools
 * — including execute_swap, convert_and_send, withdraw_* — with no auth). We
 * register ONLY the four public tools and translate each to the adapters, which
 * in turn call the embedded sera-mcp. The dangerous tools are never reachable.
 *
 * Transport: stateless Streamable HTTP (JSON request → JSON response). We do not
 * open server-initiated SSE streams, which is the recommended mode for
 * serverless / multi-instance deploys (cf. sera-mcp SERA_HTTP_STATELESS). Each
 * POST body is one JSON-RPC message (or a batch array); notifications return no
 * response.
 */
import {
  fxQuote,
  fxSettle,
  corridors,
  rates,
  GatewayError,
  type SeraDomainInfo,
} from "./adapters.js";
import type { SeraMcpClient } from "./mcp-client.js";
import type { QuoteStore } from "./store.js";

const PROTOCOL_VERSION = "2024-11-05";

export const PUBLIC_TOOLS = [
  {
    name: "fx_quote",
    description: "Get a live FX quote between any pair of supported stablecoins.",
    inputSchema: {
      type: "object",
      required: ["from_token", "to_token", "amount"],
      properties: {
        from_token: { type: "string" },
        to_token: { type: "string" },
        amount: { type: "string" },
      },
    },
  },
  {
    name: "fx_settle",
    description: "Build an unsigned EIP-712 settlement transaction from a quote.",
    inputSchema: {
      type: "object",
      required: ["quote_id", "signer"],
      properties: { quote_id: { type: "string" }, signer: { type: "string" } },
    },
  },
  {
    name: "corridors",
    description: "List supported FX corridors, currencies, and liquidity depth.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rates",
    description: "Fetch live reference rates for comma-separated currency pairs.",
    inputSchema: {
      type: "object",
      required: ["pairs"],
      properties: { pairs: { type: "string" } },
    },
  },
] as const;

export interface McpDeps {
  mcp: SeraMcpClient;
  store: QuoteStore;
  domain: SeraDomainInfo;
  now: () => string;
}

function result(id: unknown, res: unknown) {
  return { jsonrpc: "2.0" as const, id, result: res };
}
function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (no id) and acks that carry no body.
 */
export async function handleMcpMessage(msg: any, deps: McpDeps): Promise<unknown | null> {
  if (msg == null || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return error(msg?.id ?? null, -32600, "invalid JSON-RPC request");

  const { id, method, params } = msg;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "sera-agents-gateway", version: "0.1.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: PUBLIC_TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const data = await callTool(name, args, deps);
        return result(id, { content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (e) {
        const status = e instanceof GatewayError ? e.status : 500;
        // MCP convention: tool-level failures ride in the result with isError,
        // not as a protocol error.
        return result(id, {
          isError: true,
          content: [{ type: "text", text: `${status}: ${(e as Error).message}` }],
        });
      }
    }
    default:
      if (isNotification) return null;
      return error(id, -32601, `method not found: ${method}`);
  }
}

async function callTool(name: unknown, args: any, deps: McpDeps): Promise<unknown> {
  switch (name) {
    case "fx_quote":
      return fxQuote(deps.mcp, deps.store, args);
    case "fx_settle":
      return fxSettle(deps.mcp, deps.store, deps.domain, args);
    case "corridors":
      return corridors(deps.mcp);
    case "rates":
      return rates(deps.mcp, args?.pairs, deps.now());
    default:
      throw new GatewayError(404, `unknown tool: ${String(name)}`);
  }
}
