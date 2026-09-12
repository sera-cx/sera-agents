/**
 * env.test.ts — boot-time config + safety gates.
 *
 * The gates are the only thing between an operator typo and accidentally
 * deploying live mode without facilitator config / on a public host with
 * no auth. Every refuse path must be tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../env.js";

// Snapshot env so each test starts clean.
const SAVED_ENV = { ...process.env };

beforeEach(() => {
  // Strip all X402_ + HOST + PORT + SERA_MCP_DIST envs to isolate.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("X402_") || k === "HOST" || k === "PORT" || k === "SERA_MCP_DIST") {
      delete process.env[k];
    }
  }
  // SERA_MCP_DIST is required (no Desktop path fallback).
  process.env.SERA_MCP_DIST = "/tmp/dummy-sera-mcp.js";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    process.env[k] = v;
  }
});

describe("loadConfig — defaults", () => {
  it("defaults to demo mode bound to 127.0.0.1:8402", () => {
    const cfg = loadConfig();
    expect(cfg.mode).toBe("demo");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(8402);
    expect(cfg.seraMcpPath).toBe("/tmp/dummy-sera-mcp.js");
  });

  it("demo on 127.0.0.1 boots without ack", () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it("refuses to start without SERA_MCP_DIST", () => {
    delete process.env.SERA_MCP_DIST;
    const spyExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow(/process\.exit/);
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/SERA_MCP_DIST/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });
});

describe("loadConfig — demo on public host", () => {
  it("refuses demo on 0.0.0.0 without X402_DEMO_PUBLIC=true", () => {
    process.env.X402_MODE = "demo";
    process.env.HOST = "0.0.0.0";
    const spyExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow(/process\.exit/);
      expect(spyErr).toHaveBeenCalled();
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("accepts demo on 0.0.0.0 when X402_DEMO_PUBLIC=true", () => {
    process.env.X402_MODE = "demo";
    process.env.HOST = "0.0.0.0";
    process.env.X402_DEMO_PUBLIC = "true";
    expect(() => loadConfig()).not.toThrow();
  });
});

describe("loadConfig — live-mode required envs", () => {
  function setLiveBase() {
    process.env.X402_MODE = "live";
    process.env.X402_LIVE_ACK = "true";
    process.env.X402_MAINNET_ACK = "true";
    process.env.X402_E2E_ATTESTATION_ID = "base-sepolia-e2e-2026-08-25";
    process.env.X402_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
    process.env.X402_CDP_API_KEY_ID = "test-id";
    process.env.X402_CDP_API_KEY_SECRET = "test-secret";
    process.env.X402_VAULT_ADDRESS = "0x" + "a".repeat(40);
    process.env.X402_RPC_URL = "https://rpc.test";
    process.env.X402_STATE_DB = "/tmp/x402-test-state.db";
  }

  it("refuses live mode without X402_FACILITATOR_URL", () => {
    setLiveBase();
    delete process.env.X402_FACILITATOR_URL;
    const spyExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow(/process\.exit/);
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/X402_FACILITATOR_URL/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses live mode without X402_CDP_API_KEY_ID", () => {
    setLiveBase();
    delete process.env.X402_CDP_API_KEY_ID;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/X402_CDP_API_KEY_ID/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses live mode without X402_VAULT_ADDRESS", () => {
    setLiveBase();
    delete process.env.X402_VAULT_ADDRESS;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/X402_VAULT_ADDRESS/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses live mode without X402_STATE_DB (durable anti-replay ledger)", () => {
    setLiveBase();
    delete process.env.X402_STATE_DB;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      expect(spyErr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/X402_STATE_DB/);
    } finally { spyExit.mockRestore(); spyErr.mockRestore(); }
  });

  it("refuses live mode when chainId can't be derived (signature verification needs it)", () => {
    setLiveBase();
    process.env.X402_NETWORK = "weirdnet";
    process.env.X402_USDC_ADDRESS = "0x" + "c".repeat(40); // pass the non-base USDC gate
    delete process.env.X402_CHAIN_ID;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      expect(spyErr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/chainId/);
    } finally { spyExit.mockRestore(); spyErr.mockRestore(); }
  });

  it("refuses live mode on a non-base network without X402_USDC_ADDRESS", () => {
    setLiveBase();
    process.env.X402_NETWORK = "eip155:11155111";
    delete process.env.X402_USDC_ADDRESS;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/X402_USDC_ADDRESS/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses live mode without X402_LIVE_ACK=true", () => {
    setLiveBase();
    delete process.env.X402_LIVE_ACK;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/X402_LIVE_ACK/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses live mode with X402_CONFIRMATION_DEPTH < 3", () => {
    setLiveBase();
    process.env.X402_CONFIRMATION_DEPTH = "1";
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      const msg = spyErr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toMatch(/CONFIRMATION_DEPTH/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses Base mainnet without the separate X402_MAINNET_ACK", () => {
    setLiveBase();
    delete process.env.X402_MAINNET_ACK;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      expect(spyErr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/X402_MAINNET_ACK/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("refuses Base mainnet without a Base Sepolia E2E attestation ID", () => {
    setLiveBase();
    delete process.env.X402_E2E_ATTESTATION_ID;
    const spyExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => loadConfig()).toThrow();
      expect(spyErr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/X402_E2E_ATTESTATION_ID/);
    } finally {
      spyExit.mockRestore();
      spyErr.mockRestore();
    }
  });

  it("accepts fully-configured live mode", () => {
    setLiveBase();
    process.env.X402_CONFIRMATION_DEPTH = "3";
    const cfg = loadConfig();
    expect(cfg.mode).toBe("live");
    expect(cfg.facilitatorUrl).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
    expect(cfg.cdpApiKeyId).toBe("test-id");
    expect(cfg.confirmationDepth).toBe(3);
    expect(cfg.liveAck).toBe(true);
  });
});

describe("loadConfig — invalid mode value", () => {
  it("throws for unknown mode", () => {
    process.env.X402_MODE = "production";
    expect(() => loadConfig()).toThrow(/X402_MODE must be/);
  });
});
