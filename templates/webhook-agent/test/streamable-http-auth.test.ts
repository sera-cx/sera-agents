import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildSeraMcpServer, resolveSeraMcpTransport } from "../sera-mcp-transport.js";

/**
 * A minimal mock sera-mcp endpoint. Records the Authorization header seen on
 * the most recent request so tests can assert the Bearer token was (or was
 * not) actually sent on the wire — not just present somewhere in source.
 */
async function startMockMcpServer(): Promise<{ url: string; server: Server; lastAuthHeader: () => string | undefined }> {
  const mcpServer = new McpServer({ name: "mock-sera-mcp", version: "0.0.0" });
  let lastAuthHeader: string | undefined;

  const server = createServer((req, res) => {
    lastAuthHeader = req.headers.authorization;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close().catch(() => {}));
    mcpServer
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, server, lastAuthHeader: () => lastAuthHeader };
}

describe("Streamable HTTP MCP authentication", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it("sends the configured Bearer token to the MCP server on a loopback http connection", async () => {
    const mock = await startMockMcpServer();
    servers.push(mock.server);

    // Goes through resolveSeraMcpTransport + buildSeraMcpServer exactly as
    // main() does in agent.ts/server.ts — no re-implemented header logic
    // here, so a typo in the production Bearer-header wiring fails this test.
    const transport = resolveSeraMcpTransport({ SERA_MCP_URL: mock.url, SERA_MCP_TOKEN: "s3cr3t" });
    const sera = buildSeraMcpServer(transport);
    try {
      await sera.connect();
      expect(mock.lastAuthHeader()).toBe("Bearer s3cr3t");
    } finally {
      await sera.close();
    }
  });

  it("connects without an Authorization header when SERA_MCP_TOKEN is unset", async () => {
    const mock = await startMockMcpServer();
    servers.push(mock.server);

    const transport = resolveSeraMcpTransport({ SERA_MCP_URL: mock.url });
    const sera = buildSeraMcpServer(transport);
    try {
      await sera.connect();
      expect(mock.lastAuthHeader()).toBeUndefined();
    } finally {
      await sera.close();
    }
  });

  it("rejects a token over plaintext http on a non-loopback host before any connection is attempted", () => {
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "http://mcp.example.com/mcp", SERA_MCP_TOKEN: "s3cr3t" }),
    ).toThrow(/refusing to send SERA_MCP_TOKEN/);
  });
});
