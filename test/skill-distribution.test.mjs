import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = new URL("../skills/sera-protocol/SKILL.md", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);

test("the portable Sera Protocol skill has required Agent Skills metadata", async () => {
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /^---\nname: sera-protocol\ndescription: .+/);
  assert.match(skill, /external signer by default/i);
  assert.match(skill, /https:\/\/agents\.sera\.cx\/mcp/);
  assert.match(skill, /self-host.*x402|x402.*self-host/is);
  assert.match(skill, /references\/api-reference\.md/);
});

test("the Skill ships detailed references", async () => {
  const referenceFiles = [
    "api-reference.md",
    "frontend-patterns.md",
    "graphql-api.md",
    "mcp-server.md",
    "orderbook-v2.md",
    "sera-agents.md",
    "sera-pay.md",
    "smart-contracts.md",
  ];

  for (const file of referenceFiles) {
    const content = await readFile(
      new URL(`../skills/sera-protocol/references/${file}`, import.meta.url),
      "utf8",
    );
    assert.ok(content.length > 100, `${file} should not be empty`);
  }
});

test("README documents installation for the supported coding agents", async () => {
  const readme = await readFile(readmePath, "utf8");

  for (const host of ["Claude Code", "Codex", "GitHub Copilot", "Kiro"]) {
    assert.match(readme, new RegExp(`### ${host}`));
  }

  for (const directory of [
    "~/.claude/skills",
    "~/.codex/skills",
    "~/.copilot/skills",
    "~/.kiro/skills",
  ]) {
    assert.match(readme, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
