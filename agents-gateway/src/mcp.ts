import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { GatewayError } from "./errors.js";
import type { Handlers } from "./handlers.js";
import { PROXY_TOOLS } from "./proxy-tools.js";

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
  signer: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "signer must be a 0x-prefixed 40-hex address")
    .describe("Caller wallet address (0x-prefixed 40-hex)"),
};

const CorridorsSchema = {};

/**
 * Cap on the raw `/mcp` POST body. The transport buffers the whole request into
 * memory, so without a ceiling an unauthenticated client could OOM the process
 * with an oversized body. 256 KiB is far above any legitimate JSON-RPC call.
 */
const MAX_MCP_BODY_BYTES = 256 * 1024;

function tooLarge(res: ServerResponse): void {
  res.statusCode = 413;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "request body too large" }));
}

function asText<T>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/**
 * Run a tool body and serialize the result. A GatewayError (e.g. an upstream
 * throttle) is returned as an isError result tagged with its status and a retry
 * hint, so MCP callers can back off — mirroring the REST 429 + Retry-After.
 * Other errors propagate to the SDK's default isError handling unchanged.
 */
async function run<T>(fn: () => Promise<T> | T) {
  try {
    return asText(await fn());
  } catch (e) {
    if (e instanceof GatewayError) {
      const hint = e.retryAfter != null ? ` (retry after ${e.retryAfter}s)` : "";
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: `${e.status}: ${e.message}${hint}` }],
      };
    }
    // Don't leak internal/upstream error text to unauthenticated MCP clients —
    // mirror the REST failure() masking (GatewayError above is deliberate and
    // caller-facing; anything else is internal). Log the detail server-side.
    process.stderr.write(
      `[agents-gateway] mcp tool error: ${e instanceof Error ? (e.stack ?? e.message) : e}\n`,
    );
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: "internal error" }],
    };
  }
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
      run(() => handlers.quote(args)),
  );

  (server.tool as any)(
    "fx_settle",
    "Build an unsigned EIP-712 settlement transaction from a quote. Returns typed_data the caller signs in their wallet.",
    SettleSchema,
    async (args: { quote_id: string; signer: string }) => run(() => handlers.settle(args)),
  );

  (server.tool as any)(
    "corridors",
    "List supported FX corridors, currencies, and liquidity depth.",
    async () => run(() => handlers.corridors()),
  );

  // Keyless read/analytics tools mirrored from sera-mcp (see proxy-tools.ts).
  // No-input tools register with the 3-arg overload; the rest pass their shape.
  for (const t of PROXY_TOOLS) {
    const hasInput = Object.keys(t.shape).length > 0;
    if (hasInput) {
      (server.tool as any)(t.name, t.summary, t.shape, async (args: Record<string, unknown>) =>
        run(() => handlers.proxy(t.upstream, args ?? {})),
      );
    } else {
      (server.tool as any)(t.name, t.summary, async () =>
        run(() => handlers.proxy(t.upstream, {})),
      );
    }
  }

  (server.tool as any)(
    "rates",
    "Fetch live reference rates. Pass `pairs` as a comma-separated list, e.g. USDC/BRLA,XSGD/IDRX.",
    PairsSchema,
    async (args: { pairs?: string }) =>
      run(() => {
        const pairs = (args.pairs ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (pairs.length === 0) throw new Error("rates: at least one pair is required");
        return handlers.rates(pairs);
      }),
  );

  return server;
}

export async function handleMcpRequest(
  handlers: Handlers,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  if (req.method === "POST") {
    // Fast reject on a declared oversize length, then enforce while streaming
    // (Content-Length may be absent or wrong on chunked bodies).
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
      tooLarge(res);
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > MAX_MCP_BODY_BYTES) {
        tooLarge(res);
        req.destroy();
        return;
      }
      chunks.push(c as Buffer);
    }
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
  // Stateless Streamable HTTP creates a new transport for every request.
  // McpServer instances can connect to only one transport, so build a matching
  // server per request rather than reusing a server that was already connected.
  const mcpServer = buildMcpServer(handlers);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close().catch(() => {}));
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}
