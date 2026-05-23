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
  // Live-mode facilitator config (CDP)
  facilitatorUrl?: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  cdpNetwork: string;        // base | base-sepolia | polygon | arbitrum | solana
  cdpUsdcAddress?: string;
  confirmationDepth: number; // k≥3 on Base mainnet (per arXiv:2605.11781)
  // Operator gates
  liveAck: boolean;          // set true to acknowledge wired-but-not-production-tested live mode
}

export function loadConfig(): X402Config {
  const port = Number(process.env.PORT ?? 8402);
  const host = process.env.HOST ?? "127.0.0.1";
  const mode = ((process.env.X402_MODE ?? "demo").toLowerCase() as Mode);
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
    seraMcpPath:
      process.env.SERA_MCP_DIST ??
      `${process.env.HOME}/Desktop/SERA MCP and AGENT/sera-mcp/dist/index.js`,
    vaultAddress: process.env.X402_VAULT_ADDRESS,
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
    cdpApiKeyId: process.env.X402_CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.X402_CDP_API_KEY_SECRET,
    cdpNetwork: process.env.X402_NETWORK ?? "base",
    cdpUsdcAddress: process.env.X402_USDC_ADDRESS,
    confirmationDepth: Number(process.env.X402_CONFIRMATION_DEPTH ?? 3),
    liveAck: bool("X402_LIVE_ACK", false),
  };

  enforceSafetyGates(cfg);
  return cfg;
}

function enforceSafetyGates(cfg: X402Config): void {
  const isLocalHost =
    cfg.host === "127.0.0.1" || cfg.host === "localhost" || cfg.host === "::1";

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
    if (!cfg.cdpApiKeyId) missing.push("X402_CDP_API_KEY_ID");
    if (!cfg.cdpApiKeySecret) missing.push("X402_CDP_API_KEY_SECRET");
    if (!cfg.vaultAddress) missing.push("X402_VAULT_ADDRESS");
    if (missing.length > 0) {
      fail(
        `\nrefusing to start: X402_MODE=live requires CDP facilitator + vault config.\n` +
          `Missing: ${missing.join(", ")}\n\n` +
          `For local dev, use X402_MODE=demo with HOST=127.0.0.1.\n` +
          `For live mainnet, set:\n` +
          `  X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402\n` +
          `  X402_CDP_API_KEY_ID=...\n` +
          `  X402_CDP_API_KEY_SECRET=...\n` +
          `  X402_VAULT_ADDRESS=0x...  (where USDC payment lands)\n\n`,
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
  }
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
