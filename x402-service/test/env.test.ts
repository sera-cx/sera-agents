/**
 * env.test.ts — boot-time config + safety gates.
 *
 * The gates are the only thing between an operator typo and accidentally
 * deploying live mode without facilitator config / on a public host with
 * no auth. Every refuse path must be tested.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  });

  it("demo on 127.0.0.1 boots without ack", () => {
    expect(() => loadConfig()).not.toThrow();
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
    process.env.X402_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
    process.env.X402_CDP_API_KEY_ID = "test-id";
    process.env.X402_CDP_API_KEY_SECRET = "test-secret";
    process.env.X402_VAULT_ADDRESS = "0x" + "a".repeat(40);
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
