import { describe, expect, it } from "vitest";
import {
  assertTokenTransportSafety,
  resolveSeraMcpTransport,
} from "../sera-mcp-transport.js";

describe("resolveSeraMcpTransport", () => {
  it("selects http when SERA_MCP_URL is set and SERA_MCP_DIST is unset", () => {
    const transport = resolveSeraMcpTransport({ SERA_MCP_URL: "https://agents.sera.cx/mcp" });
    expect(transport).toEqual({ kind: "http", url: "https://agents.sera.cx/mcp", token: undefined });
  });

  it("fails only when stdio is selected and SERA_MCP_DIST is missing", () => {
    expect(() => resolveSeraMcpTransport({})).toThrow(/SERA_MCP_DIST is required/);
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "https://agents.sera.cx/mcp" }),
    ).not.toThrow();
  });

  it("selects http without validating SERA_MCP_DIST when both are set", () => {
    const transport = resolveSeraMcpTransport({
      SERA_MCP_URL: "https://agents.sera.cx/mcp",
      SERA_MCP_DIST: "/does/not/exist/index.js",
    });
    expect(transport.kind).toBe("http");
  });

  it("allows a token over https", () => {
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "https://mcp.example.com/mcp", SERA_MCP_TOKEN: "secret" }),
    ).not.toThrow();
  });

  it("rejects a token over plaintext http on a non-loopback host", () => {
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "http://mcp.example.com/mcp", SERA_MCP_TOKEN: "secret" }),
    ).toThrow(/refusing to send SERA_MCP_TOKEN/);
  });

  it.each(["localhost", "127.0.0.1", "::1"])(
    "allows a token over plaintext http on loopback host %s",
    (hostname) => {
      const host = hostname === "::1" ? "[::1]" : hostname;
      expect(() =>
        assertTokenTransportSafety(`http://${host}:4000/mcp`, "secret"),
      ).not.toThrow();
    },
  );
});
