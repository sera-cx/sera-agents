// Minimal line-delimited JSON-RPC stdio MCP stub. Responds to `initialize`
// and exposes a single `echo_env` tool that reports back the env vars the
// process was actually spawned with, so a test can verify buildSeraMcpServer's
// stdio branch (SERA_NETWORK/POLICY_PRESET/LOG_LEVEL/SERA_API_KEY/SERA_API_SECRET/
// SERA_ENABLE_EXECUTION_TOOLS/SERA_SIGNER_MODE) really reaches the spawned sera-mcp process —
// not just a re-typed copy of it.
let buf = "";

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const ECHOED_VARS = [
  "SERA_NETWORK",
  "POLICY_PRESET",
  "LOG_LEVEL",
  "SERA_API_KEY",
  "SERA_API_SECRET",
  "SERA_ENABLE_EXECUTION_TOOLS",
  "SERA_SIGNER_MODE",
];

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        nl = buf.indexOf("\n");
        continue;
      }
      if (msg.method === "initialize") {
        respond(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-echo-mcp", version: "0.0.0" },
        });
      } else if (msg.method === "tools/call") {
        const env = Object.fromEntries(ECHOED_VARS.map((k) => [k, process.env[k] ?? null]));
        respond(msg.id, { content: [{ type: "text", text: JSON.stringify(env) }] });
      }
      // Notifications (e.g. notifications/initialized) intentionally get no response.
    }
    nl = buf.indexOf("\n");
  }
});
