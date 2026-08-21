import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSeraMcpServer, resolveSeraMcpTransport } from "../sera-mcp-transport.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stdio-echo-mcp.mjs", import.meta.url));

function readEchoedEnv(result: any): Record<string, string | null> {
  return JSON.parse(result[0].text);
}

/**
 * buildSeraMcpServer's stdio branch (SERA_NETWORK/POLICY_PRESET/LOG_LEVEL/
 * SERA_API_KEY/SERA_API_SECRET wiring) previously had zero test coverage —
 * every existing test only ever resolved an http-kind transport. These spawn
 * the real fixture process and read back what it actually received, the same
 * way streamable-http-auth.test.ts proves the Bearer header over the wire.
 */
describe("buildSeraMcpServer (stdio)", () => {
  it("passes explicitly configured env vars through to the spawned sera-mcp process", async () => {
    const transport = resolveSeraMcpTransport({ SERA_MCP_DIST: fixturePath });
    expect(transport.kind).toBe("stdio");

    const sera = buildSeraMcpServer(transport, {
      SERA_NETWORK: "testnet",
      POLICY_PRESET: "strict",
      LOG_LEVEL: "debug",
      SERA_API_KEY: "key123",
      SERA_API_SECRET: "secret456",
    });
    try {
      await sera.connect();
      const result = await sera.callTool("echo_env", {});
      expect(readEchoedEnv(result)).toEqual({
        SERA_NETWORK: "testnet",
        POLICY_PRESET: "strict",
        LOG_LEVEL: "debug",
        SERA_API_KEY: "key123",
        SERA_API_SECRET: "secret456",
      });
    } finally {
      await sera.close();
    }
  });

  it("falls back to documented defaults and omits API credentials when unset", async () => {
    const transport = resolveSeraMcpTransport({ SERA_MCP_DIST: fixturePath });

    const sera = buildSeraMcpServer(transport, {});
    try {
      await sera.connect();
      const result = await sera.callTool("echo_env", {});
      expect(readEchoedEnv(result)).toEqual({
        SERA_NETWORK: "mainnet",
        POLICY_PRESET: "standard",
        LOG_LEVEL: "warn",
        SERA_API_KEY: null,
        SERA_API_SECRET: null,
      });
    } finally {
      await sera.close();
    }
  });
});
