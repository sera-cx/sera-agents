import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatZodError, loadEnv, SUPPORTED_SERA_NETWORKS, validateEnv } from "../env.js";

const BASE_VALID_ENV = {
  OPENAI_API_KEY: "sk-test-key-12345",
  SERA_MCP_DIST: "/path/to/sera-mcp/dist/index.js",
  WEBHOOK_SECRET: "secret-bearer-token",
};

describe("Environment Validation & Diagnostic Contracts (env.ts)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("SERA_NETWORK Constraints & sera-mcp Upstream Contract", () => {
    it("accepts 'mainnet' and 'sepolia' networks supported by sera-mcp", () => {
      const mainnetRes = validateEnv({
        ...BASE_VALID_ENV,
        SERA_NETWORK: "mainnet",
      });
      expect(mainnetRes.success).toBe(true);
      if (mainnetRes.success) {
        expect(mainnetRes.data.SERA_NETWORK).toBe("mainnet");
      }

      const sepoliaRes = validateEnv({
        ...BASE_VALID_ENV,
        SERA_NETWORK: "sepolia",
      });
      expect(sepoliaRes.success).toBe(true);
      if (sepoliaRes.success) {
        expect(sepoliaRes.data.SERA_NETWORK).toBe("sepolia");
      }
    });

    it("strictly rejects 'base' and 'base-sepolia' (Base belongs to x402 payment, not sera-mcp)", () => {
      const baseRes = validateEnv({
        ...BASE_VALID_ENV,
        SERA_NETWORK: "base",
      });
      expect(baseRes.success).toBe(false);
      if (!baseRes.success) {
        const errorMsg = baseRes.error.issues[0]?.message ?? "";
        expect(errorMsg).toContain("SERA_NETWORK must be 'mainnet' or 'sepolia'");
        expect(errorMsg).toContain(
          "Base networks (base, base-sepolia) are not supported by sera-mcp",
        );
      }

      const baseSepoliaRes = validateEnv({
        ...BASE_VALID_ENV,
        SERA_NETWORK: "base-sepolia",
      });
      expect(baseSepoliaRes.success).toBe(false);
      if (!baseSepoliaRes.success) {
        const errorMsg = baseSepoliaRes.error.issues[0]?.message ?? "";
        expect(errorMsg).toContain("SERA_NETWORK must be 'mainnet' or 'sepolia'");
      }
    });

    it("rejects arbitrary unsupported network strings", () => {
      const unsupported = ["polygon", "arbitrum", "devnet", "optimism", "solana"];
      for (const net of unsupported) {
        const res = validateEnv({
          ...BASE_VALID_ENV,
          SERA_NETWORK: net,
        });
        expect(res.success, `Network "${net}" must be rejected`).toBe(false);
      }
    });

    it("contract: SUPPORTED_SERA_NETWORKS defines exactly mainnet and sepolia", () => {
      expect(SUPPORTED_SERA_NETWORKS).toEqual(["mainnet", "sepolia"]);
      expect(SUPPORTED_SERA_NETWORKS.length).toBe(2);
    });

    it("contract: every value accepted by WebhookEnvSchema matches SUPPORTED_SERA_NETWORKS", () => {
      for (const network of SUPPORTED_SERA_NETWORKS) {
        const parseResult = validateEnv({
          ...BASE_VALID_ENV,
          SERA_NETWORK: network,
        });
        expect(parseResult.success, `Schema must accept supported network "${network}"`).toBe(true);
      }
    });
  });

  describe("Core Credentials & Defaults", () => {
    it("parses valid minimal environment with safe defaults", () => {
      const res = validateEnv(BASE_VALID_ENV);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.PORT).toBe(4000);
        expect(res.data.HOST).toBe("127.0.0.1");
        expect(res.data.SERA_NETWORK).toBe("mainnet");
        expect(res.data.POLICY_PRESET).toBe("standard");
        expect(res.data.LOG_LEVEL).toBe("warn");
        expect(res.data.TRUST_PROXY).toBe(false);
        expect(res.data.WEBHOOK_HMAC_PROVIDER).toBe("none");
        expect(res.data.WEBHOOK_MAX_CONCURRENT).toBe(4);
        expect(res.data.WEBHOOK_RATE_LIMIT_PER_MIN).toBe(60);
      }
    });

    it("fails when OPENAI_API_KEY is missing or empty", () => {
      const missing = validateEnv({
        SERA_MCP_DIST: "/path/to/dist",
        WEBHOOK_SECRET: "secret",
      });
      expect(missing.success).toBe(false);

      const empty = validateEnv({
        ...BASE_VALID_ENV,
        OPENAI_API_KEY: "",
      });
      expect(empty.success).toBe(false);
    });
  });

  describe("MCP Transport Invariants (SERA_MCP_URL vs SERA_MCP_DIST)", () => {
    it("accepts SERA_MCP_DIST without SERA_MCP_URL", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        WEBHOOK_SECRET: "sec",
        SERA_MCP_DIST: "/path/to/dist/index.js",
      });
      expect(res.success).toBe(true);
    });

    it("accepts SERA_MCP_URL without SERA_MCP_DIST", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        WEBHOOK_SECRET: "sec",
        SERA_MCP_URL: "https://agents.sera.cx/mcp",
      });
      expect(res.success).toBe(true);
    });

    it("rejects when neither SERA_MCP_URL nor SERA_MCP_DIST is provided", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        WEBHOOK_SECRET: "sec",
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.message).toContain(
          "Either SERA_MCP_URL (Streamable HTTP) or SERA_MCP_DIST (stdio path) must be configured",
        );
      }
    });

    it("rejects invalid/malformed SERA_MCP_URL", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        WEBHOOK_SECRET: "sec",
        SERA_MCP_URL: "not_a_valid_url",
      });
      expect(res.success).toBe(false);
    });

    it("rejects sending SERA_MCP_TOKEN over plaintext HTTP to non-loopback hosts", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        WEBHOOK_SECRET: "sec",
        SERA_MCP_URL: "http://api.example.com/mcp",
        SERA_MCP_TOKEN: "sensitive-token",
      });
      expect(res.success).toBe(false);
    });

    it("allows sending SERA_MCP_TOKEN over plaintext HTTP to loopback addresses", () => {
      const loopbacks = [
        "http://localhost:3000/mcp",
        "http://127.0.0.1:3000/mcp",
        "http://[::1]:3000/mcp",
      ];
      for (const url of loopbacks) {
        const res = validateEnv({
          OPENAI_API_KEY: "sk-test",
          WEBHOOK_SECRET: "sec",
          SERA_MCP_URL: url,
          SERA_MCP_TOKEN: "test-token",
        });
        expect(res.success, `URL "${url}" should permit token on loopback`).toBe(true);
      }
    });
  });

  describe("Authentication & Loopback Confinement", () => {
    it("rejects startup when WEBHOOK_SECRET is unset and WEBHOOK_ALLOW_NO_AUTH=false", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        SERA_MCP_DIST: "/path/to/dist",
      });
      expect(res.success).toBe(false);
    });

    it("permits WEBHOOK_ALLOW_NO_AUTH=true on loopback host 127.0.0.1", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        SERA_MCP_DIST: "/path/to/dist",
        HOST: "127.0.0.1",
        WEBHOOK_ALLOW_NO_AUTH: "true",
      });
      expect(res.success).toBe(true);
    });

    it("permits WEBHOOK_ALLOW_NO_AUTH=true on loopback host 'localhost'", () => {
      const res = validateEnv({
        OPENAI_API_KEY: "sk-test",
        SERA_MCP_DIST: "/path/to/dist",
        HOST: "localhost",
        WEBHOOK_ALLOW_NO_AUTH: "true",
      });
      expect(res.success).toBe(true);
    });

    it("rejects WEBHOOK_ALLOW_NO_AUTH=true on non-loopback hosts", () => {
      const badHosts = ["0.0.0.0", "192.168.1.100", "public-agent.internal"];
      for (const host of badHosts) {
        const res = validateEnv({
          OPENAI_API_KEY: "sk-test",
          SERA_MCP_DIST: "/path/to/dist",
          HOST: host,
          WEBHOOK_ALLOW_NO_AUTH: "true",
        });
        expect(res.success, `Host "${host}" with no-auth must be rejected`).toBe(false);
      }
    });

    it("requires WEBHOOK_HMAC_SECRET when WEBHOOK_HMAC_PROVIDER is enabled", () => {
      const providers = ["stripe", "github", "generic"];
      for (const provider of providers) {
        const res = validateEnv({
          ...BASE_VALID_ENV,
          WEBHOOK_HMAC_PROVIDER: provider,
        });
        expect(res.success, `Provider "${provider}" requires HMAC secret`).toBe(false);

        const withSecret = validateEnv({
          ...BASE_VALID_ENV,
          WEBHOOK_HMAC_PROVIDER: provider,
          WEBHOOK_HMAC_SECRET: "whsec_test_secret",
        });
        expect(withSecret.success, `Provider "${provider}" with secret must pass`).toBe(true);
      }
    });
  });

  describe("Trust Proxy Backwards Compatibility", () => {
    it("supports TRUST_PROXY=true", () => {
      const res = validateEnv({
        ...BASE_VALID_ENV,
        TRUST_PROXY: "true",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.TRUST_PROXY).toBe(true);
    });

    it("supports legacy WEBHOOK_TRUST_PROXY=true alias", () => {
      const res = validateEnv({
        ...BASE_VALID_ENV,
        WEBHOOK_TRUST_PROXY: "true",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.TRUST_PROXY).toBe(true);
    });
  });

  describe("Diagnostics and Remediation Hints (formatZodError)", () => {
    it("formats errors with clean header and field hints", () => {
      const parseRes = validateEnv({
        HOST: "0.0.0.0",
        WEBHOOK_ALLOW_NO_AUTH: "true",
      });
      expect(parseRes.success).toBe(false);
      if (!parseRes.success) {
        const formatted = formatZodError(parseRes.error);
        expect(formatted).toContain("FATAL CONFIGURATION ERROR");
        expect(formatted).toContain("OPENAI_API_KEY");
        expect(formatted).toContain("OPENAI_API_KEY=sk-...");
      }
    });

    it("loadEnv calls process.exit(1) on failure", () => {
      const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as any);
      const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(() => loadEnv({})).toThrow("process.exit called");
      expect(exitMock).toHaveBeenCalledWith(1);
      expect(stderrMock).toHaveBeenCalled();
    });
  });
});
