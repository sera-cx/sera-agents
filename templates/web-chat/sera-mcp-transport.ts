/**
 * Sera MCP transport selection.
 *
 * SERA_MCP_URL (Streamable HTTP) takes precedence over SERA_MCP_DIST (stdio).
 * Only the variables required by the transport that's actually selected are
 * validated, so a URL-only setup never needs a local sera-mcp build.
 */
import { resolve } from "node:path";
import { MCPServerStdio, MCPServerStreamableHttp } from "@openai/agents";

export interface SeraMcpEnv {
  SERA_MCP_URL?: string;
  SERA_MCP_DIST?: string;
  SERA_MCP_TOKEN?: string;
}

export type SeraMcpTransport =
  | { kind: "http"; url: string; token?: string }
  | { kind: "stdio"; path: string };

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  // IPv4-mapped IPv6 form of 127.0.0.1 — URL.hostname always normalizes any
  // spelling of it (dotted-quad or hex) to this compressed hex form.
  "::ffff:7f00:1",
]);

/**
 * Validates SERA_MCP_URL is well-formed before it's ever used, regardless of
 * whether a token is configured — otherwise a typo'd/schemeless URL only
 * surfaces later as a raw error out of MCPServerStreamableHttp's connect().
 * When SERA_MCP_TOKEN is also set, additionally refuses to send it over
 * plaintext HTTP to anything but an explicit loopback address, so a
 * misconfigured SERA_MCP_URL can't leak the credential on the wire.
 */
export function assertTokenTransportSafety(url: string, token: string | undefined): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid SERA_MCP_URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid SERA_MCP_URL: ${url} (must be http:// or https://)`);
  }
  if (!token) return;
  if (parsed.protocol === "https:") return;
  // URL.hostname keeps brackets around IPv6 addresses (e.g. "[::1]") and
  // preserves a trailing dot on FQDNs (e.g. "localhost.") that DNS treats as
  // identical to the undotted form.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
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

export interface SeraMcpStdioEnv {
  SERA_NETWORK?: string;
  POLICY_PRESET?: string;
  LOG_LEVEL?: string;
  SERA_API_KEY?: string;
  SERA_API_SECRET?: string;
  SERA_ENABLE_EXECUTION_TOOLS?: string;
  SERA_SIGNER_MODE?: string;
}

/**
 * Builds the actual MCP client for the selected transport. Kept alongside
 * resolveSeraMcpTransport so tests exercise the exact same Bearer-header /
 * stdio-env wiring that main() runs in production, instead of a re-typed copy.
 */
export function buildSeraMcpServer(
  transport: SeraMcpTransport,
  stdioEnv: SeraMcpStdioEnv = process.env,
): MCPServerStreamableHttp | MCPServerStdio {
  if (transport.kind === "http") {
    return new MCPServerStreamableHttp({
      url: transport.url,
      name: "sera",
      ...(transport.token
        ? { requestInit: { headers: { Authorization: `Bearer ${transport.token}` } } }
        : {}),
    });
  }
  return new MCPServerStdio({
    command: "node",
    args: [transport.path],
    env: {
      SERA_NETWORK: stdioEnv.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: stdioEnv.POLICY_PRESET ?? "standard",
      LOG_LEVEL: stdioEnv.LOG_LEVEL ?? "warn",
      ...(stdioEnv.SERA_API_KEY ? { SERA_API_KEY: stdioEnv.SERA_API_KEY } : {}),
      ...(stdioEnv.SERA_API_SECRET ? { SERA_API_SECRET: stdioEnv.SERA_API_SECRET } : {}),
      ...(stdioEnv.SERA_ENABLE_EXECUTION_TOOLS
        ? { SERA_ENABLE_EXECUTION_TOOLS: stdioEnv.SERA_ENABLE_EXECUTION_TOOLS }
        : {}),
      ...(stdioEnv.SERA_SIGNER_MODE ? { SERA_SIGNER_MODE: stdioEnv.SERA_SIGNER_MODE } : {}),
    },
    name: "sera",
  });
}
