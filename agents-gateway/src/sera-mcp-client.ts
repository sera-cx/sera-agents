import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { GatewayError, rateLimitFromToolError } from "./errors.js";

export interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Turn a sera-mcp tools/call result into the parsed value, or throw. An upstream
 * throttle becomes a GatewayError (429 + Retry-After) so callers can back off;
 * any other tool error stays a plain Error → 502 at the server. Pure and
 * exported so the throttle path is unit-testable without spawning sera-mcp.
 */
export function interpretToolResult<T>(name: string, res: ToolCallResult | undefined): T {
  if (res?.isError) {
    const msg = res.content?.[0]?.text ?? `sera-mcp tool ${name} failed`;
    const throttle = rateLimitFromToolError(res);
    if (throttle) throw new GatewayError(throttle.status, msg, throttle.retryAfter);
    throw new Error(msg);
  }
  const text = res?.content?.[0]?.text;
  if (!text) throw new Error(`sera-mcp tool ${name} returned no content`);
  return JSON.parse(text) as T;
}

export interface SeraMcpClient {
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  running(): boolean;
  shutdown(): void;
}

interface InitOpts {
  mcpPath: string;
  network: string;
  apiKey?: string;
  apiSecret?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export function makeSeraMcpClient(opts: InitOpts): SeraMcpClient {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let reqId = 0;
  let initialized = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  function start(): ChildProcessWithoutNullStreams {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SERA_NETWORK: opts.network,
      POLICY_PRESET: "standard",
      LOG_LEVEL: "warn",
    };
    if (opts.apiKey) env.SERA_API_KEY = opts.apiKey;
    if (opts.apiSecret) env.SERA_API_SECRET = opts.apiSecret;

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
            const handler = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) handler.reject(new Error(msg.error.message ?? "mcp error"));
            else handler.resolve(msg.result);
          }
        } catch {
          /* upstream may emit non-JSON log lines; ignore */
        }
      }
    });
    function failAll(reason: string) {
      for (const [, h] of pending) h.reject(new Error(reason));
      pending.clear();
      proc = null;
      initialized = false;
    }

    p.stderr.on("data", (chunk) => process.stderr.write("[sera-mcp] " + chunk.toString("utf8")));
    p.on("exit", (code) => {
      process.stderr.write(`[sera-mcp] exited code=${code}\n`);
      failAll("sera-mcp subprocess exited");
    });
    // A spawn failure (e.g. a bad SERA_MCP_PATH) or any async child error is
    // otherwise an unhandled 'error' event that crashes the whole gateway.
    // Handle it like an exit: fail in-flight requests, reset, let the next call
    // re-spawn.
    p.on("error", (err) => {
      process.stderr.write(`[sera-mcp] process error: ${err?.message ?? err}\n`);
      failAll(`sera-mcp process error: ${err?.message ?? err}`);
    });
    // Writing to stdin after the child dies emits EPIPE on the stream; the exit/
    // error handlers already fail pending requests, so just log and swallow it
    // rather than let it become an unhandled stream error.
    p.stdin.on("error", (err) => {
      process.stderr.write(`[sera-mcp] stdin error: ${err?.message ?? err}\n`);
    });
    return p;
  }

  function rpc<T>(method: string, params: unknown): Promise<T> {
    if (!proc) throw new Error("sera-mcp not running");
    const child = proc;
    const id = ++reqId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`sera-mcp ${method} timeout after ${REQUEST_TIMEOUT_MS}ms`));
        }
      }, REQUEST_TIMEOUT_MS);
      // Guard the write: a dead/closing pipe throws sync or errors async; either
      // way fail this request cleanly instead of crashing the process.
      try {
        child.stdin.write(payload, (err) => {
          if (err && pending.delete(id)) {
            clearTimeout(timer);
            reject(new Error(`sera-mcp write failed: ${err.message}`));
          }
        });
      } catch (err: any) {
        if (pending.delete(id)) {
          clearTimeout(timer);
          reject(new Error(`sera-mcp write failed: ${err?.message ?? err}`));
        }
      }
    });
  }

  async function ensureReady(): Promise<void> {
    if (!proc) {
      proc = start();
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!initialized) {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agents-gateway", version: "0.1.0" },
      });
      initialized = true;
    }
  }

  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      await ensureReady();
      const res = await rpc<ToolCallResult>("tools/call", { name, arguments: args });
      return interpretToolResult<T>(name, res);
    },
    running() {
      return !!proc;
    },
    shutdown() {
      if (proc) {
        proc.kill();
        proc = null;
        initialized = false;
      }
    },
  };
}
