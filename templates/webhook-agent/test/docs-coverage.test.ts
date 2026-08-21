import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// Same standalone-copy concern as sera-mcp-transport-consistency.test.ts:
// only the checks against this template's own docs are safe to run
// unconditionally. Everything that reads templates/README.md or sibling
// templates requires the monorepo checkout.
const hasMonorepoDocs = existsSync(fileURLToPath(new URL("../../README.md", import.meta.url)));

describe("SERA_MCP_TOKEN / transport documentation", () => {
  it("this template's own README and .env.example document SERA_MCP_TOKEN", async () => {
    const [readme, envExample] = await Promise.all([read("../README.md"), read("../.env.example")]);
    expect(readme).toContain("SERA_MCP_TOKEN");
    expect(envExample).toContain("SERA_MCP_TOKEN");
  });

  describe.skipIf(!hasMonorepoDocs)("cross-template docs (monorepo checkout only)", () => {
    it("chat-cli and web-chat READMEs document SERA_MCP_TOKEN", async () => {
      const [chatCli, webChat] = await Promise.all([
        read("../../chat-cli/README.md"),
        read("../../web-chat/README.md"),
      ]);
      expect(chatCli).toContain("SERA_MCP_TOKEN");
      expect(webChat).toContain("SERA_MCP_TOKEN");
    });

    it("templates/README.md documents the hosted gateway and doesn't overclaim SERA_MCP_URL support", async () => {
      const templatesReadme = await read("../../README.md");
      expect(templatesReadme).toContain("SERA_MCP_TOKEN");
      expect(templatesReadme).toContain("https://agents.sera.cx/mcp");
      // Guards against re-claiming SERA_MCP_URL support for slack-agent,
      // market-maker, and withdraw-cli, which don't call
      // resolveSeraMcpTransport and never read SERA_MCP_URL — the doc
      // overclaim a fresh-eyes review caught after the transport fix shipped.
      // Whitespace is normalized since markdown prose wraps across lines.
      expect(templatesReadme.replace(/\s+/g, " ")).toContain(
        "have not been ported to this transport-selection logic yet",
      );
    });
  });
});
