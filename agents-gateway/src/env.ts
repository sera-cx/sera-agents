export interface GatewayEnv {
  port: number;
  host: string;
  network: string;
  apiKey?: string;
  apiSecret?: string;
  mcpPath: string;
  trustProxy: boolean;
}

export function loadEnv(): GatewayEnv {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isFinite(port) || port <= 0) throw new Error("PORT must be a positive integer");
  const mcpPath = process.env.SERA_MCP_PATH;
  if (!mcpPath) {
    throw new Error(
      "SERA_MCP_PATH must point to a built sera-mcp/dist/index.js. " +
        "In Docker the image bakes it at /opt/sera-mcp/dist/index.js; " +
        "for local dev see agents-gateway/README.md.",
    );
  }
  return {
    port,
    host: process.env.HOST ?? "0.0.0.0",
    network: process.env.SERA_NETWORK ?? "mainnet",
    apiKey: process.env.SERA_API_KEY || undefined,
    apiSecret: process.env.SERA_API_SECRET || undefined,
    mcpPath,
    trustProxy: process.env.TRUST_PROXY === "1",
  };
}
