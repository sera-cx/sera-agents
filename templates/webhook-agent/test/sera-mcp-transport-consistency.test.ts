import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

/**
 * chat-cli, web-chat, and webhook-agent each carry their own copy of
 * sera-mcp-transport.ts (templates are meant to be copied standalone, so it
 * isn't a shared import). A fix applied to only one copy would otherwise
 * ship unnoticed, since each template's own unit tests only exercise their
 * local copy. Fail loudly the moment the copies drift.
 */
describe("sera-mcp-transport.ts stays identical across templates", () => {
  it("chat-cli, web-chat, and webhook-agent carry byte-identical copies", async () => {
    const [chatCli, webChat, webhookAgent] = await Promise.all([
      read("../../chat-cli/sera-mcp-transport.ts"),
      read("../../web-chat/sera-mcp-transport.ts"),
      read("../sera-mcp-transport.ts"),
    ]);

    expect(chatCli).toBe(webhookAgent);
    expect(webChat).toBe(webhookAgent);
  });
});
