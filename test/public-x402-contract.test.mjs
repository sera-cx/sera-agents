import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public ingress does not route or deploy x402-service", async () => {
  const [compose, caddy] = await Promise.all([
    read("docker-compose.yml"),
    read("agents-gateway/deploy/Caddyfile"),
  ]);

  assert.doesNotMatch(compose, /^\s*x402-service\s*:/m);
  assert.doesNotMatch(caddy, /\/x402(?:\/|\*|\b)/);
});

test("public documentation does not advertise an agents.sera.cx x402 API", async () => {
  const paths = [
    "index.html",
    "README.md",
    "docs/index.html",
    "docs/concepts.html",
    "docs/architecture.html",
    "DEPLOY.md",
  ];
  const documents = await Promise.all(paths.map(read));

  for (const document of documents) {
    assert.doesNotMatch(document, /agents\.sera\.cx\/x402/i);
  }
});

test("Path D documents localhost, self-hosting, and live-readiness guidance", async () => {
  const [landing, readme, concepts, architecture] = await Promise.all([
    read("index.html"),
    read("README.md"),
    read("docs/concepts.html"),
    read("docs/architecture.html"),
  ]);

  assert.match(landing, /localhost:8402/);
  assert.match(landing, /self-host(?:ed|ing)?/i);
  assert.match(landing, /https:\/\/github\.com\/sera-cx\/sera-agents\/blob\/main\/x402-service\/README\.md/);
  assert.match(landing, /https:\/\/github\.com\/sera-cx\/sera-agents\/blob\/main\/SECURITY-MODEL\.md/);
  assert.match(readme, /agents\.sera\.cx` does not offer a public x402 URL/);
  assert.match(readme, /Base Sepolia E2E verification/);
  assert.match(concepts, /self-host/i);
  assert.match(architecture, /self-host/i);
});
