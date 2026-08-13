import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { makeSeraMcpClient } from "../src/sera-mcp-client.js";

// A tiny JSON-RPC stub that reports how many `initialize` handshakes it has
// received on every tools/call response.
const STUB = fileURLToPath(new URL("./fixtures/stub-mcp.mjs", import.meta.url));

describe("sera-mcp client — concurrent cold-start handshake", () => {
  it("initializes the subprocess exactly once under concurrent first calls", async () => {
    const client = makeSeraMcpClient({ mcpPath: STUB, network: "sepolia" });
    try {
      // `rates()` fans out with Promise.all, so the very first request already
      // issues several concurrent callTool()s before the handshake completes.
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          client.callTool<{ initCount: number }>("sera.get_fx_rate", { base: "USDC", quote: "EURC" }),
        ),
      );
      // Every concurrent caller must observe the single shared handshake.
      for (const r of results) expect(r).toEqual({ initCount: 1 });
    } finally {
      client.shutdown();
    }
  }, 15_000);
});
