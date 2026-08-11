import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("Streamable HTTP MCP authentication", () => {
  it("adds an optional Bearer header consistently across all starters", async () => {
    const sources = await Promise.all([
      read("../../chat-cli/agent.ts"),
      read("../../web-chat/server.ts"),
      read("../server.ts"),
    ]);

    for (const source of sources) {
      expect(source).toContain("const seraMcpToken = process.env.SERA_MCP_TOKEN?.trim();");
      expect(source).toContain("requestInit: { headers: { Authorization: `Bearer ${seraMcpToken}` } }");
      expect(source).toContain("...(seraMcpToken");
    }
  });

  it("documents the optional token without changing the keyless gateway path", async () => {
    const docs = await Promise.all([
      read("../../chat-cli/README.md"),
      read("../../web-chat/README.md"),
      read("../README.md"),
      read("../../README.md"),
      read("../.env.example"),
    ]);

    for (const document of docs) {
      expect(document).toContain("SERA_MCP_TOKEN");
    }
    expect(docs[3]).toContain("https://agents.sera.cx/mcp");
  });
});
