import { describe, it, expect } from "vitest";
import { makeSeraMcpClient } from "../src/sera-mcp-client.js";

describe("sera-mcp client — graceful subprocess failure", () => {
  it("rejects (does not crash the process) when the subprocess exits immediately", async () => {
    // A bad SERA_MCP_PATH: `node /…/nope.js` prints an error and exits non-zero.
    // Previously an unhandled 'error'/EPIPE here could take down the gateway;
    // now the call must simply reject.
    const client = makeSeraMcpClient({
      mcpPath: "/nonexistent/sera-mcp-does-not-exist.js",
      network: "sepolia",
    });
    await expect(
      client.callTool("sera.get_fx_rate", { base: "USDC", quote: "EURC" }),
    ).rejects.toBeInstanceOf(Error);
    client.shutdown();
  }, 15_000);
});
