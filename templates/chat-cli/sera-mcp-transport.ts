/**
 * Sera MCP transport selection.
 *
 * SERA_MCP_URL (Streamable HTTP) takes precedence over SERA_MCP_DIST (stdio).
 * Only the variables required by the transport that's actually selected are
 * validated, so a URL-only setup never needs a local sera-mcp build.
 */
import { resolve } from "node:path";

export interface SeraMcpEnv {
  SERA_MCP_URL?: string;
  SERA_MCP_DIST?: string;
  SERA_MCP_TOKEN?: string;
}

export type SeraMcpTransport =
  | { kind: "http"; url: string; token?: string }
  | { kind: "stdio"; path: string };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * SERA_MCP_TOKEN is a bearer credential. Refuse to send it over plaintext
 * HTTP to anything but an explicit loopback address, so a misconfigured
 * SERA_MCP_URL can't leak it on the wire.
 */
export function assertTokenTransportSafety(url: string, token: string | undefined): void {
  if (!token) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid SERA_MCP_URL: ${url}`);
  }
  if (parsed.protocol === "https:") return;
  // URL.hostname keeps brackets around IPv6 addresses (e.g. "[::1]").
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(hostname)) return;
  throw new Error(
    `refusing to send SERA_MCP_TOKEN over ${parsed.protocol}//${parsed.hostname} — ` +
      `use https:// for SERA_MCP_URL, drop SERA_MCP_TOKEN, or target ` +
      `localhost/127.0.0.1/::1 for local development.`,
  );
}

export function requireSeraMcpDist(env: SeraMcpEnv): string {
  const p = env.SERA_MCP_DIST?.trim();
  if (!p) {
    throw new Error(
      "SERA_MCP_DIST is required when SERA_MCP_URL is not set. Point it at a built " +
        "sera-mcp/dist/index.js, e.g. SERA_MCP_DIST=/path/to/sera-mcp/dist/index.js npm start",
    );
  }
  return resolve(p);
}

/**
 * Picks the transport for the Sera MCP connection. SERA_MCP_DIST is only
 * validated when no SERA_MCP_URL is configured.
 */
export function resolveSeraMcpTransport(env: SeraMcpEnv): SeraMcpTransport {
  const url = env.SERA_MCP_URL?.trim();
  if (url) {
    const token = env.SERA_MCP_TOKEN?.trim() || undefined;
    assertTokenTransportSafety(url, token);
    return { kind: "http", url, token };
  }
  return { kind: "stdio", path: requireSeraMcpDist(env) };
}
