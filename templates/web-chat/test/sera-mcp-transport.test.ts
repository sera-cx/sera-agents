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

  it.each(["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:127.0.0.1]"])(
    "allows a token over plaintext http on IPv4-mapped IPv6 loopback %s",
    (host) => {
      expect(() =>
        assertTokenTransportSafety(`http://${host}:4000/mcp`, "secret"),
      ).not.toThrow();
    },
  );

  it("allows a token over plaintext http on the trailing-dot FQDN form of localhost", () => {
    expect(() =>
      assertTokenTransportSafety("http://localhost.:4000/mcp", "secret"),
    ).not.toThrow();
  });

  it("rejects a malformed SERA_MCP_URL even when no token is set", () => {
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "not a valid url::::" }),
    ).toThrow(/invalid SERA_MCP_URL/);
  });

  it("rejects a schemeless SERA_MCP_URL (missing https://) even when no token is set", () => {
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "agents.sera.cx/mcp" }),
    ).toThrow(/invalid SERA_MCP_URL/);
  });

  it("rejects a non-http(s) SERA_MCP_URL scheme even when no token is set", () => {
    expect(() =>
      resolveSeraMcpTransport({ SERA_MCP_URL: "ftp://agents.sera.cx/mcp" }),
    ).toThrow(/must be http:\/\/ or https:\/\//);
  });
});
