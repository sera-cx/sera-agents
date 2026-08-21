// Minimal line-delimited JSON-RPC stub standing in for sera-mcp in tests.
// Counts how many `initialize` handshakes it receives and echoes that count
// back on every `tools/call`, so a test can assert the client initializes the
// subprocess exactly once even under concurrent first calls.
let initCount = 0;
let buf = "";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      initCount++;
      respond(msg.id, { protocolVersion: "2024-11-05" });
    } else if (msg.method === "tools/call") {
      respond(msg.id, { content: [{ type: "text", text: JSON.stringify({ initCount }) }] });
    }
  }
});
