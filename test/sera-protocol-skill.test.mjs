import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Sera Protocol Skill stays installable and safe by default", async () => {
  const referencePaths = [
    "api-reference.md",
    "frontend-patterns.md",
    "graphql-api.md",
    "mcp-server.md",
    "orderbook-v2.md",
    "sera-agents.md",
    "sera-pay.md",
    "smart-contracts.md",
  ];
  const [packageJson, readme, skill, references] = await Promise.all([
    read("package.json"),
    read("README.md"),
    read("skills/sera-protocol/SKILL.md"),
    Promise.all(referencePaths.map((path) => read(`skills/sera-protocol/references/${path}`))),
  ]);
  const packageData = JSON.parse(packageJson);

  assert.match(packageData.scripts.test, /node --test test\/\*\.test\.mjs/);
  assert.match(skill, /^---\nname: sera-protocol\n[\s\S]*license: MIT\n[\s\S]*repository: https:\/\/github\.com\/sera-cx\/sera-agents\n---/);
  assert.equal(references.length, referencePaths.length);
  assert.match(readme, /skills\/sera-protocol\/SKILL\.md/);
  assert.match(readme, /\.claude\/skills/);
  assert.match(readme, /\.codex\/skills/);
  assert.match(readme, /\.copilot\/skills/);
  assert.match(readme, /\.kiro\/skills/);
  assert.match(skill, /external signer by default/i);
  assert.match(skill, /explicit confirmation/i);
  assert.match(skill, /x402 is self-hosted/i);
});

test("Sera Protocol Skill defers changing MCP inventory to the official source", async () => {
  const mcpReference = await read("skills/sera-protocol/references/mcp-server.md");

  assert.match(mcpReference, /https:\/\/github\.com\/sera-cx\/sera-mcp#readme/);
  assert.match(mcpReference, /call `tools\/list`/);
  assert.doesNotMatch(mcpReference, /\b32 tools\b/i);
  assert.doesNotMatch(mcpReference, /all 32 tools/i);
});

test("Sera Protocol Skill uses the canonical testnet API host", async () => {
  const references = await Promise.all([
    read("skills/sera-protocol/references/api-reference.md"),
    read("skills/sera-protocol/references/sera-pay.md"),
  ]);

  for (const reference of references) {
    assert.match(reference, /https:\/\/api-testnet\.sera\.cx\/api\/v1/);
    assert.doesNotMatch(reference, /https:\/\/api\.testnet\.sera\.cx\/api\/v1/);
  }
});
