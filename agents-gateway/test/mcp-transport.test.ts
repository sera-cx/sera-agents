import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/mcp.js";

describe("stateless Streamable HTTP transport", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("serves initialize and repeated tools/list requests on separate transports", async () => {
    const handlers = {
      quote: async () => ({}),
      settle: async () => ({}),
      corridors: async () => ({}),
      rates: async () => ({}),
      proxy: async () => ({}),
    } as any;
    const server = createServer((req, res) => void handleMcpRequest(handlers, req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: "mcp-transport-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const first = await client.listTools();
      const second = await client.listTools();
      expect(first.tools.length).toBeGreaterThan(0);
      expect(second.tools).toHaveLength(first.tools.length);
    } finally {
      await transport.close();
      await client.close();
    }
  });
});
