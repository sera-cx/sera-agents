import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Pages that may name a managed x402 endpoint. */
const PUBLIC_DOCS = [
  "index.html",
  "README.md",
  "docs/index.html",
  "docs/concepts.html",
  "docs/architecture.html",
  "docs/tutorials/x402-paid-api.html",
  "DEPLOY.md",
];

const MANAGED_ENDPOINT = /agents\.sera\.cx[/`"']*\/?x402/i;
/** How a page says the managed endpoint is not callable yet. */
const NOT_YET_LIVE = /at appchain launch|MCP `v2`|AT APPCHAIN LAUNCH/i;

const ingressRoutesX402 = async () => {
  const [compose, caddy] = await Promise.all([
    read("docker-compose.yml"),
    read("agents-gateway/deploy/Caddyfile"),
  ]);
  return /\/x402(?:\/|\*|\b)/.test(caddy) || /^\s*x402-service\s*:/m.test(compose);
};

test("public ingress state is explicit, not accidental", async () => {
  const [compose, caddy] = await Promise.all([
    read("docker-compose.yml"),
    read("agents-gateway/deploy/Caddyfile"),
  ]);

  // Routing /x402 and deploying x402-service go together. Half of each is a
  // misconfiguration: a route to nothing, or a service nothing can reach.
  const caddyRoutes = /\/x402(?:\/|\*|\b)/.test(caddy);
  const composeDeploys = /^\s*x402-service\s*:/m.test(compose);
  assert.equal(
    caddyRoutes,
    composeDeploys,
    caddyRoutes
      ? "Caddyfile routes /x402 but docker-compose does not deploy x402-service"
      : "docker-compose deploys x402-service but Caddyfile does not route /x402",
  );
});

test("docs never promise a managed x402 endpoint the ingress cannot serve", async () => {
  // The failure this guards against is a live page telling an agent to POST
  // somewhere that 404s. While the ingress does not route /x402, a page may
  // still describe the managed endpoint — but it has to say it is not up yet.
  const routed = await ingressRoutesX402();
  const documents = await Promise.all(PUBLIC_DOCS.map(async (path) => [path, await read(path)]));

  for (const [path, document] of documents) {
    if (!MANAGED_ENDPOINT.test(document)) continue;
    if (routed) continue;
    assert.match(
      document,
      NOT_YET_LIVE,
      `${path} names agents.sera.cx/x402 while the ingress does not route it, ` +
        "and does not mark it as arriving at appchain launch",
    );
  }
});

test("Path D keeps self-hosting documented and live-readiness gated", async () => {
  const [landing, readme, concepts, architecture] = await Promise.all([
    read("index.html"),
    read("README.md"),
    read("docs/concepts.html"),
    read("docs/architecture.html"),
  ]);

  // Self-hosting is the path that works today; it must stay documented even
  // once the managed endpoint ships.
  assert.match(landing, /localhost:8402/);
  assert.match(landing, /self-host(?:ed|ing)?/i);
  assert.match(
    landing,
    /https:\/\/github\.com\/sera-cx\/sera-agents\/blob\/main\/x402-service\/README\.md/,
  );
  assert.match(
    landing,
    /https:\/\/github\.com\/sera-cx\/sera-agents\/blob\/main\/SECURITY-MODEL\.md/,
  );
  assert.match(concepts, /self-host/i);
  assert.match(architecture, /self-host/i);

  // The README states where the rollout actually stands.
  assert.match(readme, /Rollout status/);
  assert.match(readme, /Base Sepolia E2E verification/);
});

test("the site does not advertise an x402 run mode the service lacks", async () => {
  // index.html prints `npm run testnet`; x402-service must actually have it,
  // or the README has to say it does not yet.
  const [landing, readme, servicePkg] = await Promise.all([
    read("index.html"),
    read("README.md"),
    read("x402-service/package.json"),
  ]);

  const advertised = /npm run testnet/.test(landing);
  const implemented = Boolean(JSON.parse(servicePkg).scripts?.testnet);

  if (advertised && !implemented) {
    assert.match(
      readme,
      /`npm run testnet`[^.]*not implemented yet/,
      "index.html prints `npm run testnet`, x402-service has no such script, " +
        "and README does not disclose the gap",
    );
  }
});
