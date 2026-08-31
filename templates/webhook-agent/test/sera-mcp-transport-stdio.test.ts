import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createChildMcpEnv } from "../mcp-tool-filter.js";
import { buildSeraMcpServer, resolveSeraMcpTransport } from "../sera-mcp-transport.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stdio-echo-mcp.mjs", import.meta.url));

function readEchoedEnv(
  result: Array<{ text: string }> | { content: Array<{ text: string }> },
): Record<string, string | null> {
  const content = Array.isArray(result) ? result : result.content;
  return JSON.parse(content[0].text);
}

/**
 * buildSeraMcpServer's stdio branch (SERA_NETWORK/POLICY_PRESET/LOG_LEVEL/
 * SERA_API_KEY/SERA_API_SECRET/SERA_ENABLE_EXECUTION_TOOLS/SERA_SIGNER_MODE wiring)
 * spawns the real fixture process and reads back what it actually received, the same
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
      SERA_ENABLE_EXECUTION_TOOLS: "true",
      SERA_SIGNER_MODE: "local_key",
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
        SERA_ENABLE_EXECUTION_TOOLS: "true",
        SERA_SIGNER_MODE: "local_key",
      });
    } finally {
      await sera.close();
    }
  });

  it("falls back to documented defaults and omits API credentials and execution flags when unset", async () => {
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
        SERA_ENABLE_EXECUTION_TOOLS: null,
        SERA_SIGNER_MODE: null,
      });
    } finally {
      await sera.close();
    }
  });

  it("forwards createChildMcpEnv environment end-to-end to the spawned child process", async () => {
    const transport = resolveSeraMcpTransport({ SERA_MCP_DIST: fixturePath });

    // Under FULL_EXECUTION profile:
    const fullExecChildEnv = createChildMcpEnv("FULL_EXECUTION", {
      SERA_NETWORK: "base",
      SERA_SIGNER_MODE: "remote_signer",
    });
    const fullExecSera = buildSeraMcpServer(transport, fullExecChildEnv);
    try {
      await fullExecSera.connect();
      const result = await fullExecSera.callTool("echo_env", {});
      expect(readEchoedEnv(result)).toEqual({
        SERA_NETWORK: "base",
        POLICY_PRESET: "standard",
        LOG_LEVEL: "warn",
        SERA_API_KEY: null,
        SERA_API_SECRET: null,
        SERA_ENABLE_EXECUTION_TOOLS: "true",
        SERA_SIGNER_MODE: "remote_signer",
      });
    } finally {
      await fullExecSera.close();
    }

    // Under READ_ONLY profile:
    const readOnlyChildEnv = createChildMcpEnv("READ_ONLY", {
      SERA_NETWORK: "mainnet",
    });
    const readOnlySera = buildSeraMcpServer(transport, readOnlyChildEnv);
    try {
      await readOnlySera.connect();
      const result = await readOnlySera.callTool("echo_env", {});
      expect(readEchoedEnv(result)).toEqual({
        SERA_NETWORK: "mainnet",
        POLICY_PRESET: "standard",
        LOG_LEVEL: "warn",
        SERA_API_KEY: null,
        SERA_API_SECRET: null,
        SERA_ENABLE_EXECUTION_TOOLS: null,
        SERA_SIGNER_MODE: null,
      });
    } finally {
      await readOnlySera.close();
    }
  });
});
