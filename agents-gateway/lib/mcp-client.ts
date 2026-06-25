/**
 * Minimal stdio JSON-RPC client for sera-mcp.
 *
 * Spawns sera-mcp once, holds the subprocess open, and exposes a tiny
 * `tool(name, args)` helper. No OpenAI Agents SDK — the inner loop is
 * deterministic; an LLM bridge would only add latency and failure modes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
        throw new Error(`${name}: ${r.content?.[0]?.text ?? "tool error"}`);
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
