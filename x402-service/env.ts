/**
 * x402-service — boot-time config + safety gates.
 *
 * All env reads happen here. Refuses to start in unsafe configurations
 * (demo on public host, live without facilitator + CDP keys + vault).
 */

export type Mode = "demo" | "live";

export interface X402Config {
  port: number;
  host: string;
  mode: Mode;
  demoPublicOk: boolean;
  trustProxy: boolean;
  pendingMax: number;
  rateLimitPerMin: number;
  maxConcurrentSwaps: number;
  pendingTtlSeconds: number;
  surchargeBps: number;
  maxAmount: number;
  stateDb?: string;
  seraMcpPath: string;
  vaultAddress?: string;
  // Live-mode facilitator config
  facilitatorKind: "cdp" | "selfhosted"; // cdp (Coinbase-hosted) | selfhosted (your own x402 facilitator)
  facilitatorUrl?: string;
  facilitatorToken?: string; // selfhosted only: optional static bearer for your facilitator
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  cdpNetwork: string; // cdp: base | base-sepolia | ... | selfhosted: any (e.g. eip155:11155111)
  cdpUsdcAddress?: string;
  confirmationDepth: number; // k≥3 on Base mainnet (per arXiv:2605.11781)
  // On-chain confirmation gate (live mode): independently verify the payment
  // landed in the vault before executing the swap. rpcUrl is an RPC endpoint
  // the OPERATOR controls on the payment chain.
  rpcUrl?: string;
  skipOnchainConfirm: boolean; // explicit opt-out — trusts the facilitator alone (NOT recommended)
  // EIP-712 domain for verifying the payer's EIP-3009 signature (makes `from`
  // un-forgeable). chainId is derived from network / X402_CHAIN_ID.
  chainId?: number;
  usdcName: string; // EIP-712 domain name of the payment token (USDC default)
  usdcVersion: string; // EIP-712 domain version
  // Operator gates
  liveAck: boolean;          // set true to acknowledge wired-but-not-production-tested live mode
  mainnetAck: boolean;       // separate acknowledgement required before Base mainnet boot
  e2eAttestationId?: string; // Base Sepolia E2E attestation reviewed by the operator
}

export function loadConfig(): X402Config {
  const port = Number(process.env.PORT ?? 8402);
  const host = process.env.HOST ?? "127.0.0.1";
  const mode = (process.env.X402_MODE ?? "demo").toLowerCase() as Mode;
  if (mode !== "demo" && mode !== "live") {
    throw new Error(`X402_MODE must be 'demo' or 'live' (got '${process.env.X402_MODE}')`);
  }

  const cfg: X402Config = {
    port,
    host,
    mode,
    demoPublicOk: bool("X402_DEMO_PUBLIC", false),
    trustProxy: bool("X402_TRUST_PROXY", false),
    pendingMax: Number(process.env.X402_PENDING_MAX ?? 10_000),
    rateLimitPerMin: Number(process.env.X402_RATE_LIMIT_PER_MIN ?? 30),
    maxConcurrentSwaps: Number(process.env.X402_MAX_CONCURRENT_SWAPS ?? 8),
    pendingTtlSeconds: Number(process.env.X402_PENDING_TTL_SECONDS ?? 300),
    surchargeBps: Number(process.env.X402_SURCHARGE_BPS ?? 0),
    maxAmount: Number(process.env.X402_MAX_AMOUNT ?? 1_000_000),
    stateDb: process.env.X402_STATE_DB,
    seraMcpPath: (() => {
      const p = process.env.SERA_MCP_DIST?.trim();
      if (!p) {
        fail(
          `\nSERA_MCP_DIST is required. Point it at a built sera-mcp/dist/index.js\n` +
            `  e.g. SERA_MCP_DIST=/path/to/sera-mcp/dist/index.js npm start\n\n`,
        );
      }
      return p;
    })(),
    vaultAddress: process.env.X402_VAULT_ADDRESS,
    facilitatorKind: (() => {
      const k = (process.env.X402_FACILITATOR_KIND ?? "cdp").toLowerCase();
      if (k !== "cdp" && k !== "selfhosted") {
        fail(`\nX402_FACILITATOR_KIND must be 'cdp' or 'selfhosted' (got '${k}')\n\n`);
      }
      return k as "cdp" | "selfhosted";
    })(),
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
    facilitatorToken: process.env.X402_FACILITATOR_TOKEN,
    cdpApiKeyId: process.env.X402_CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.X402_CDP_API_KEY_SECRET,
    cdpNetwork: process.env.X402_NETWORK ?? "base",
    cdpUsdcAddress: process.env.X402_USDC_ADDRESS,
    confirmationDepth: Number(process.env.X402_CONFIRMATION_DEPTH ?? 3),
    rpcUrl: process.env.X402_RPC_URL,
    skipOnchainConfirm: bool("X402_SKIP_ONCHAIN_CONFIRM", false),
    chainId: deriveChainId(process.env.X402_CHAIN_ID, process.env.X402_NETWORK ?? "base"),
    usdcName: process.env.X402_USDC_NAME ?? "USD Coin",
    usdcVersion: process.env.X402_USDC_VERSION ?? "2",
    liveAck: bool("X402_LIVE_ACK", false),
    mainnetAck: bool("X402_MAINNET_ACK", false),
    e2eAttestationId: process.env.X402_E2E_ATTESTATION_ID?.trim() || undefined,
  };

  enforceSafetyGates(cfg);
  return cfg;
}

function enforceSafetyGates(cfg: X402Config): void {
  const isLocalHost = cfg.host === "127.0.0.1" || cfg.host === "localhost" || cfg.host === "::1";

  // Demo on public host without explicit ack → refuse.
  if (cfg.mode === "demo" && !isLocalHost && !cfg.demoPublicOk) {
    fail(
      `\nrefusing to start: X402_MODE=demo bound to non-localhost host (${cfg.host}).\n` +
        `Demo mode mocks payment verification AND the swap leg — public deploy is unsafe.\n\n` +
        `Pick one:\n` +
        `  1. Bind to localhost:        HOST=127.0.0.1 (default)\n` +
        `  2. Switch to live mode:      X402_MODE=live  (requires CDP facilitator + vault)\n` +
        `  3. Acknowledge the risk:     X402_DEMO_PUBLIC=true\n\n`,
    );
  }

  if (cfg.mode === "live") {
    const missing: string[] = [];
    if (!cfg.facilitatorUrl) missing.push("X402_FACILITATOR_URL");
    if (cfg.facilitatorKind === "cdp") {
      if (!cfg.cdpApiKeyId) missing.push("X402_CDP_API_KEY_ID");
      if (!cfg.cdpApiKeySecret) missing.push("X402_CDP_API_KEY_SECRET");
    }
    if (!cfg.vaultAddress) missing.push("X402_VAULT_ADDRESS");
    if (missing.length > 0) {
      fail(
        `\nrefusing to start: X402_MODE=live requires facilitator + vault config.\n` +
          `Missing: ${missing.join(", ")}\n\n` +
          `For local dev, use X402_MODE=demo with HOST=127.0.0.1.\n` +
          `For live with Coinbase CDP (default):\n` +
          `  X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402\n` +
          `  X402_CDP_API_KEY_ID=...\n` +
          `  X402_CDP_API_KEY_SECRET=...\n` +
          `  X402_VAULT_ADDRESS=0x...  (where USDC payment lands)\n` +
          `For live with your own facilitator (any EVM chain incl. Ethereum Sepolia):\n` +
          `  X402_FACILITATOR_KIND=selfhosted\n` +
          `  X402_FACILITATOR_URL=https://your-facilitator.example/x402\n` +
          `  X402_VAULT_ADDRESS=0x...\n\n`,
      );
    }
    // The on-chain confirmation gate is what makes a lying/compromised
    // facilitator unable to trigger free delivery. Require an operator RPC
    // unless explicitly (and loudly) opted out.
    if (!cfg.rpcUrl && !cfg.skipOnchainConfirm) {
      fail(
        `\nrefusing to start: X402_MODE=live requires X402_RPC_URL (an RPC endpoint\n` +
          `YOU control on the payment chain) so the service can independently confirm\n` +
          `the USDC payment landed in the vault before executing the swap.\n` +
          `Without it, delivery trusts the facilitator's word alone — a compromised\n` +
          `facilitator could trigger free FX delivery from your vault.\n\n` +
          `Set X402_RPC_URL=https://...  (recommended)\n` +
          `or  X402_SKIP_ONCHAIN_CONFIRM=true to accept that risk explicitly.\n\n`,
      );
    }
    if (!cfg.rpcUrl && cfg.skipOnchainConfirm) {
      process.stderr.write(
        `[x402] WARNING: X402_SKIP_ONCHAIN_CONFIRM=true — delivery will trust the\n` +
          `[x402] facilitator response alone. A compromised facilitator can trigger\n` +
          `[x402] free delivery from the vault. Not recommended for real funds.\n`,
      );
    }
    // The built-in USDC default is Base MAINNET's contract. On any other
    // network (base-sepolia, polygon, eip155:*, ...) that address is wrong and
    // the on-chain confirm would never match a real transfer — require the
    // operator to state the payment asset explicitly.
    if (cfg.cdpNetwork !== "base" && !cfg.cdpUsdcAddress) {
      fail(
        `\nrefusing to start: X402_NETWORK=${cfg.cdpNetwork} requires X402_USDC_ADDRESS\n` +
          `(the payment-asset ERC-20 contract on that chain). The built-in default is\n` +
          `Base mainnet USDC and is only valid for X402_NETWORK=base.\n\n`,
      );
    }
    // Anti-replay ledger must be durable in live mode — a memory-only ledger is
    // wiped on restart, letting a consumed settle tx be replayed.
    if (!cfg.stateDb) {
      fail(
        `\nrefusing to start: X402_MODE=live requires X402_STATE_DB (a SQLite path) so\n` +
          `the single-use payment ledger survives restarts. Without it, a consumed\n` +
          `settle tx could be replayed after a crash/redeploy.\n\n` +
          `Set X402_STATE_DB=/var/lib/x402/state.db\n\n`,
      );
    }
    // Signature verification needs the token's EIP-712 chainId. Only required
    // when the on-chain confirm actually runs (i.e. an RPC is configured).
    if (cfg.rpcUrl && cfg.chainId === undefined) {
      fail(
        `\nrefusing to start: cannot derive an EVM chainId for X402_NETWORK=${cfg.cdpNetwork}.\n` +
          `The chainId is needed to verify the payer's EIP-3009 signature. Set\n` +
          `X402_CHAIN_ID=<id> (e.g. 11155111 for Ethereum Sepolia, 8453 for Base).\n\n`,
      );
    }
    // Footgun guard: the EIP-712 domain name/version must match the payment
    // token's on-chain domain, or EVERY legit signature recovers a wrong
    // address and silently bounces (fail-closed → no payment ever succeeds).
    // The defaults ("USD Coin"/"2") are Base/mainnet-USDC's values; other
    // deployments differ (some use name "USDC" or version "1"). We can't know
    // the right values, so warn loudly rather than guess when the confirm gate
    // is active on a non-base chain and the operator left them at the default.
    if (
      cfg.rpcUrl &&
      cfg.cdpNetwork !== "base" &&
      process.env.X402_USDC_NAME === undefined &&
      process.env.X402_USDC_VERSION === undefined
    ) {
      process.stderr.write(
        `[x402] WARNING: X402_NETWORK=${cfg.cdpNetwork} but X402_USDC_NAME / X402_USDC_VERSION\n` +
          `[x402] are unset — using Base-USDC defaults ("${cfg.usdcName}"/"${cfg.usdcVersion}"). If the\n` +
          `[x402] payment token's real EIP-712 domain differs, EVERY payment's signature\n` +
          `[x402] will fail verification and NO payment will succeed. Confirm the token's\n` +
          `[x402] on-chain name()/version() and set these explicitly. A green testnet E2E\n` +
          `[x402] (a real payment that SUCCEEDS) is the only proof the domain is correct.\n`,
      );
    }
    if (!cfg.liveAck) {
      fail(
        `\nrefusing to start: live mode wiring is in place but NOT YET\n` +
          `production-verified against Coinbase CDP mainnet. Per docs.sera.cx and\n` +
          `SECURITY-MODEL.md, hardening checklist requires Base Sepolia E2E test\n` +
          `before mainnet. Set X402_LIVE_ACK=true to acknowledge you've completed\n` +
          `the testnet E2E and accept the residual risk.\n\n`,
      );
    }
    if (cfg.confirmationDepth < 3) {
      fail(
        `\nrefusing to start: X402_CONFIRMATION_DEPTH=${cfg.confirmationDepth} is below 3.\n` +
          `Per arXiv:2605.11781 ('Five Attacks on x402'), revert-grant attack RGP is\n` +
          `5.18% at k<3 confirmations on Base. Set X402_CONFIRMATION_DEPTH=3 minimum.\n\n`,
      );
    }
    if (cfg.cdpNetwork === "base" && (!cfg.mainnetAck || !cfg.e2eAttestationId)) {
      fail(
        `\nrefusing to start: Base mainnet requires a completed Base Sepolia E2E attestation.\n` +
          `Set X402_MAINNET_ACK=true and X402_E2E_ATTESTATION_ID=<attestation-id>.\n` +
          `X402_LIVE_ACK alone is not sufficient for mainnet.\n\n`,
      );
    }
  }
}

// Map the network string (or explicit X402_CHAIN_ID) to an EVM chainId for the
// EIP-712 signing domain. Known Coinbase-facilitator networks are named; any
// eip155:<id> is parsed; otherwise undefined (gated in live mode below).
const KNOWN_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  "base-sepolia": 84532,
  polygon: 137,
  arbitrum: 42161,
};
function deriveChainId(explicit: string | undefined, network: string): number | undefined {
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  if (KNOWN_CHAIN_IDS[network] !== undefined) return KNOWN_CHAIN_IDS[network];
  const m = /^eip155:(\d+)$/.exec(network);
  if (m) return Number(m[1]);
  return undefined;
}

function bool(envName: string, defaultValue: boolean): boolean {
  const v = process.env[envName];
  if (v === undefined) return defaultValue;
  return v.toLowerCase() === "true";
}

function fail(msg: string): never {
  process.stderr.write(msg);
  process.exit(1);
}
