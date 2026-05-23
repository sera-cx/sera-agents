/**
 * Sera MCP subprocess client — stdio JSON-RPC wrapper.
 *
 * Spawns sera-mcp once and holds a long-lived process. Calls go through
 * tools/call. Subprocess crash rejects all in-flight requests so callers
 * fail fast rather than hanging.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface SeraMcpClient {
  call(method: string, params?: any): Promise<any>;
  running(): boolean;
}

export function makeSeraMcpClient(opts: {
  mcpPath: string;
  network?: string;
  policyPreset?: string;
  signerMode?: string;
  apiKey?: string;
  apiSecret?: string;
  signerPrivateKey?: string;
}): SeraMcpClient {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let reqId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let initialized = false;

  function start(): ChildProcessWithoutNullStreams {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SERA_NETWORK: opts.network ?? "mainnet",
      POLICY_PRESET: opts.policyPreset ?? "standard",
      LOG_LEVEL: "warn",
    };
    if (opts.signerMode) env.SERA_SIGNER_MODE = opts.signerMode;
    if (opts.apiKey) env.SERA_API_KEY = opts.apiKey;
    if (opts.apiSecret) env.SERA_API_SECRET = opts.apiSecret;
    if (opts.signerPrivateKey) env.SIGNER_PRIVATE_KEY = opts.signerPrivateKey;

    const p = spawn("node", [opts.mcpPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
          /* ignore non-JSON */
        }
      }
    });
    p.stderr.on("data", (chunk) => process.stderr.write("[mcp] " + chunk.toString("utf8")));
    p.on("exit", (code) => {
      process.stderr.write(`[mcp] exited code=${code}\n`);
      for (const [, handler] of pending) handler.reject(new Error("mcp subprocess exited"));
      pending.clear();
      proc = null;
      initialized = false;
    });
    return p;
  }

  function rpc(method: string, params: any): Promise<any> {
    if (!proc) throw new Error("mcp not running");
    const id = ++reqId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc!.stdin.write(payload);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp ${method} timeout`));
        }
      }, 30_000);
    });
  }

  return {
    async call(method, params = {}) {
      if (!proc) {
        proc = start();
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!initialized) {
        await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sera-x402", version: "0.3.0" },
        });
        initialized = true;
      }
      return rpc(method, params);
    },
    running() {
      return !!proc;
    },
  };
}
