// Regression coverage for the Sera Protocol Agent Skill (skills/sera-protocol/).
// This skill hands out instructions for signing and value-moving workflows, so
// these checks exist to catch a critical safeguard being silently removed or
// weakened — not to police prose style. Keep each test focused on one of the
// invariants a reviewer would actually check for by hand.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillDir = path.join(repoRoot, "skills/sera-protocol");
const skillPath = path.join(skillDir, "SKILL.md");

const readSkill = () => readFile(skillPath, "utf8");
// Collapse whitespace/newlines so a phrase that wraps across lines in the
// markdown source still matches a single-line regex.
const flatten = (text) => text.replace(/\s+/g, " ");

test("all required skill and reference files exist", async () => {
  await assert.doesNotReject(stat(skillPath), "skills/sera-protocol/SKILL.md is missing");

  const skill = await readSkill();
  const linkedFiles = [...skill.matchAll(/\(references\/([\w.-]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(linkedFiles.length > 0, "SKILL.md should link at least one reference file");

  for (const file of linkedFiles) {
    await assert.doesNotReject(
      stat(path.join(skillDir, "references", file)),
      `SKILL.md references references/${file}, but that file doesn't exist`,
    );
  }

  // Every .md file actually present in references/ must be linked from
  // SKILL.md too, so a new reference doc can't go silently unreferenced.
  const onDisk = (await readdir(path.join(skillDir, "references"))).filter((f) =>
    f.endsWith(".md"),
  );
  assert.deepEqual(
    [...onDisk].sort(),
    [...linkedFiles].sort(),
    "references/ contents and SKILL.md's linked file list have drifted apart",
  );
});

test("the main SKILL.md links to valid reference files", async () => {
  const skill = await readSkill();
  const links = [...skill.matchAll(/\[[^\]]+\]\((references\/[\w.-]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "expected at least one markdown link into references/");

  for (const link of links) {
    await assert.doesNotReject(
      stat(path.join(skillDir, link)),
      `SKILL.md contains a broken link: ${link}`,
    );
  }
});

test("private keys, seed phrases, and API secrets are explicitly prohibited", async () => {
  const skill = flatten(await readSkill());
  assert.match(
    skill,
    /never request, expose, paste, log, or add a private key/i,
    "SKILL.md should explicitly prohibit handling private keys",
  );
  assert.match(skill, /seed phrase/i, "SKILL.md should explicitly mention seed phrases");
  assert.match(skill, /api secret/i, "SKILL.md should explicitly mention API secrets");
});

test("signing remains external and requires explicit user confirmation", async () => {
  const skill = flatten(await readSkill());
  assert.match(
    skill,
    /external signer by default/i,
    "SKILL.md should require an external signer by default",
  );
  assert.match(
    skill,
    /ask for explicit confirmation/i,
    "SKILL.md should require explicit user confirmation before value-moving actions",
  );
});

test("demo and live environments remain clearly separated", async () => {
  const skill = flatten(await readSkill());
  assert.match(
    skill,
    /keep simulation\/demo and live environments separate/i,
    "SKILL.md should require demo/simulation and live environments to stay separate",
  );
});

test("settlement amounts do not use JavaScript floating-point arithmetic", async () => {
  const skill = flatten(await readSkill());
  assert.match(
    skill,
    /do not use javascript floating point for settlement/i,
    "SKILL.md should prohibit JavaScript floating-point arithmetic for settlement values",
  );
});
