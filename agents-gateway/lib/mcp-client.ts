/**
 * Minimal stdio JSON-RPC client for sera-mcp.
 *
 * Spawns sera-mcp once, holds the subprocess open, and exposes a tiny
 * `tool(name, args)` helper. No OpenAI Agents SDK — the inner loop is
 * deterministic; an LLM bridge would only add latency and failure modes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { GatewayError } from "./errors.js";

/**
 * Inspect a sera-mcp tool-error result and, if it represents an upstream
 * throttle, return the HTTP status to surface plus any Retry-After hint.
 *
 * Two channels, checked most-trustworthy first:
 *  1. Structured — a future sera-mcp emits machine-readable status in `_meta`
 *     or `structuredContent` (see the upstream error-contract PR). Read a small
 *     candidate set of keys defensively rather than pinning one name.
 *  2. Heuristic — today's sera-mcp stringifies the upstream error into the
 *     human text. Match a 429 / rate-limit signal and parse a Retry-After int.
 *
 * Returns null when the error is not a recognizable throttle, so the caller
 * falls back to a generic error (mapped to 500 by the server).
 */
export function rateLimitFromToolError(
  r: any,
): { status: number; retryAfter?: number } | null {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v)
      ? v
      : typeof v === "string" && /^\d+$/.test(v.trim())
        ? Number(v.trim())
        : undefined;

  // (1) Structured metadata, if a newer sera-mcp provides it.
  const meta = { ...(r?.structuredContent ?? {}), ...(r?._meta ?? {}) } as Record<string, unknown>;
  const code =
    num(meta["sera/httpStatus"]) ??
    num(meta.httpStatus) ??
    num(meta.status) ??
    num((meta.error as any)?.code);
  if (code != null) {
    const retryAfter =
      num(meta["sera/retryAfter"]) ?? num(meta.retryAfter) ?? num((meta.error as any)?.retryAfter);
    return { status: code, retryAfter };
  }

  // (2) Heuristic on the stringified message.
  const text = r?.content?.[0]?.text;
  if (typeof text === "string" && /\b429\b|rate.?limit|too many requests/i.test(text)) {
    const m = text.match(/retry[-\s]?after["':=\s]+(\d+)/i);
    return { status: 429, retryAfter: m ? Number(m[1]) : undefined };
  }
  return null;
}

export interface SeraMcpClientOptions {
  mcpPath: string;
  env?: Record<string, string | undefined>;
  /** Per-request timeout in ms. Default 30s. */
  requestTimeoutMs?: number;
}

export interface SeraMcpClient {
  /** Call a sera.* tool and parse the text-JSON response back into an object. */
  tool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Raw RPC for advanced uses. */
  rpc(method: string, params?: unknown): Promise<any>;
  close(): void;
  running(): boolean;
}

export async function startSeraMcp(opts: SeraMcpClientOptions): Promise<SeraMcpClient> {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let reqId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const requestTimeout = opts.requestTimeoutMs ?? 30_000;

  function start() {
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    const p = spawn("node", [opts.mcpPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    p.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const h = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) h.reject(new Error(msg.error.message ?? "mcp error"));
            else h.resolve(msg.result);
          }
        } catch {
          /* non-JSON line — ignore */
        }
      }
    });
    p.stderr.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk.toString("utf8")}`));
    p.on("exit", (code) => {
      process.stderr.write(`[mcp] exited code=${code}\n`);
      for (const [, h] of pending) h.reject(new Error("mcp subprocess exited"));
      pending.clear();
      proc = null;
    });
    return p;
  }

  function rpc(method: string, params: unknown = {}): Promise<any> {
    if (!proc) throw new Error("mcp not running");
    const id = ++reqId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      // Clear the timeout when the request settles so timers don't accumulate
      // across a fast poll loop and keep the event loop alive.
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp ${method} timeout after ${requestTimeout}ms`));
        }
      }, requestTimeout);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc!.stdin.write(payload);
    });
  }

  // Boot + handshake.
  proc = start();
  await new Promise((r) => setTimeout(r, 250));
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sera-agents-gateway", version: "0.1.0" },
  });

  return {
    async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r?.isError) {
        const msg = `${name}: ${r.content?.[0]?.text ?? "tool error"}`;
        const throttle = rateLimitFromToolError(r);
        // Pass an upstream throttle through honestly so callers back off instead
        // of seeing a generic 500. Everything else stays a plain Error → 500.
        if (throttle) throw new GatewayError(throttle.status, msg, throttle.retryAfter);
        throw new Error(msg);
      }
      const text = r?.content?.[0]?.text;
      if (typeof text !== "string") throw new Error(`${name}: no text content`);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
    rpc,
    close() {
      if (proc) {
        proc.kill();
        proc = null;
      }
    },
    running() {
      return !!proc;
    },
  };
}
