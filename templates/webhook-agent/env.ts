/**
 * @fileoverview Strict Environment Validation and Fail-Fast Diagnostics
 *
 * Validates all required and optional environment variables at startup using Zod.
 * Enforces production invariants, safe defaults, network constraints, loopback
 * confinement, transport configuration, and clear diagnostics with actionable remediation hints.
 */
import { type ZodError, z } from "zod";
import { assertTokenTransportSafety } from "./sera-mcp-transport.js";

/**
 * Networks supported by sera-mcp for Sera Protocol deployment.
 * Note: Base networks (base, base-sepolia) are supported for x402 payment facilitation
 * but not as Sera Protocol deployments in sera-mcp.
 */
export const SUPPORTED_SERA_NETWORKS = ["mainnet", "sepolia"] as const;
export type SupportedSeraNetwork = (typeof SUPPORTED_SERA_NETWORKS)[number];

/**
 * Raw Zod schema for webhook-agent environment variables.
 */
export const WebhookEnvSchema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const rec = { ...(raw as Record<string, unknown>) };
      // Backwards-compatible aliases for HMAC variables (preventing silent bypass when operators configure HMAC_* from legacy .env.example)
      if (rec.WEBHOOK_HMAC_PROVIDER === undefined && rec.HMAC_PROVIDER !== undefined) {
        rec.WEBHOOK_HMAC_PROVIDER = rec.HMAC_PROVIDER;
      }
      if (rec.WEBHOOK_HMAC_SECRET === undefined && rec.HMAC_SECRET !== undefined) {
        rec.WEBHOOK_HMAC_SECRET = rec.HMAC_SECRET;
      }
      if (
        rec.WEBHOOK_HMAC_TOLERANCE_SECONDS === undefined &&
        rec.HMAC_TOLERANCE_SECONDS !== undefined
      ) {
        rec.WEBHOOK_HMAC_TOLERANCE_SECONDS = rec.HMAC_TOLERANCE_SECONDS;
      }
      return rec;
    },
    z.object({
      // ── Server Networking & Ingress ───────────────────────────────────────
      PORT: z.preprocess(
        (v) => (typeof v === "string" && !Number.isNaN(Number(v)) ? Number(v) : v),
        z
          .number({ message: "PORT must be an integer between 1 and 65535" })
          .int("PORT must be an integer")
          .min(1, "PORT must be >= 1")
          .max(65535, "PORT must be <= 65535")
          .default(4000),
      ),
      HOST: z.string().default("127.0.0.1"),
      TRUST_PROXY: z.enum(["true", "false", "TRUE", "FALSE"]).optional(),
      WEBHOOK_TRUST_PROXY: z.enum(["true", "false", "TRUE", "FALSE"]).optional(),

      // ── Agent & OpenAI Credentials ────────────────────────────────────────
      OPENAI_API_KEY: z
        .string({ message: "OPENAI_API_KEY is required" })
        .min(1, "OPENAI_API_KEY cannot be empty"),

      // ── Sera MCP Transport Selection ──────────────────────────────────────
      SERA_MCP_DIST: z.string().optional(),
      SERA_MCP_URL: z.string().optional(),
      SERA_MCP_TOKEN: z.string().optional(),

      // ── Sera Protocol Deployment & Preset Overrides ───────────────────────
      SERA_NETWORK: z
        .string()
        .superRefine((val, ctx) => {
          if (val !== "mainnet" && val !== "sepolia") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "SERA_NETWORK must be 'mainnet' or 'sepolia'. Base networks (base, base-sepolia) are not supported by sera-mcp.",
            });
          }
        })
        .default("mainnet") as unknown as z.ZodType<SupportedSeraNetwork>,
      POLICY_PRESET: z.enum(["standard", "starter", "strict"]).default("standard"),
      LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("warn"),
      SERA_API_KEY: z.string().optional(),
      SERA_API_SECRET: z.string().optional(),
      SERA_SIGNER_MODE: z.string().optional(),

      // ── Webhook Authentication & Loopback Opt-In ──────────────────────────
      WEBHOOK_SECRET: z.preprocess(
        (v) => (typeof v === "string" ? v.trim() || undefined : v),
        z.string().optional(),
      ),
      WEBHOOK_ALLOW_NO_AUTH: z
        .enum(["true", "false", "TRUE", "FALSE"])
        .default("false")
        .transform((v) => v.toLowerCase() === "true"),

      // ── HMAC Signature Verification ───────────────────────────────────────
      WEBHOOK_HMAC_PROVIDER: z.enum(["none", "stripe", "github", "generic"]).default("none"),
      WEBHOOK_HMAC_SECRET: z.preprocess(
        (v) => (typeof v === "string" ? v.trim() || undefined : v),
        z.string().optional(),
      ),
      WEBHOOK_HMAC_TOLERANCE_SECONDS: z.preprocess(
        (v) => (typeof v === "string" && !Number.isNaN(Number(v)) ? Number(v) : v),
        z
          .number({ message: "WEBHOOK_HMAC_TOLERANCE_SECONDS must be a number" })
          .int()
          .positive("WEBHOOK_HMAC_TOLERANCE_SECONDS must be positive")
          .default(300),
      ),

      // ── Concurrency & Rate Limiting ───────────────────────────────────────
      WEBHOOK_MAX_CONCURRENT: z.preprocess(
        (v) => (typeof v === "string" && !Number.isNaN(Number(v)) ? Number(v) : v),
        z
          .number({ message: "WEBHOOK_MAX_CONCURRENT must be a number" })
          .int()
          .positive("WEBHOOK_MAX_CONCURRENT must be a positive integer")
          .default(4),
      ),
      WEBHOOK_RATE_LIMIT_PER_MIN: z.preprocess(
        (v) => (typeof v === "string" && !Number.isNaN(Number(v)) ? Number(v) : v),
        z
          .number({ message: "WEBHOOK_RATE_LIMIT_PER_MIN must be a number" })
          .int()
          .positive("WEBHOOK_RATE_LIMIT_PER_MIN must be a positive integer")
          .default(60),
      ),
    }),
  )
  .transform((data) => {
    const rawVal = data.TRUST_PROXY ?? data.WEBHOOK_TRUST_PROXY ?? "false";
    return {
      ...data,
      TRUST_PROXY: rawVal.toLowerCase() === "true",
    };
  })
  // Invariant 1: Prevent public deployment without auth
  .refine(
    (data) => {
      if (!data.WEBHOOK_SECRET && !data.WEBHOOK_ALLOW_NO_AUTH) {
        return false;
      }
      return true;
    },
    {
      message: "WEBHOOK_SECRET is required unless WEBHOOK_ALLOW_NO_AUTH=true with HOST=127.0.0.1",
      path: ["WEBHOOK_SECRET"],
    },
  )
  // Invariant 2: Loopback confinement for no-auth mode
  .refine(
    (data) => {
      if (data.WEBHOOK_ALLOW_NO_AUTH && !data.WEBHOOK_SECRET) {
        return data.HOST === "127.0.0.1" || data.HOST === "localhost";
      }
      return true;
    },
    {
      message:
        "WEBHOOK_ALLOW_NO_AUTH=true requires HOST=127.0.0.1 (loopback only). Bound host is reachable from outside.",
      path: ["HOST"],
    },
  )
  // Invariant 3: HMAC secret is mandatory when HMAC provider is enabled
  .refine(
    (data) => {
      if (data.WEBHOOK_HMAC_PROVIDER !== "none" && !data.WEBHOOK_HMAC_SECRET) {
        return false;
      }
      return true;
    },
    {
      message: "WEBHOOK_HMAC_SECRET is required when WEBHOOK_HMAC_PROVIDER is enabled",
      path: ["WEBHOOK_HMAC_SECRET"],
    },
  )
  // Invariant 4: Either SERA_MCP_URL or SERA_MCP_DIST must be provided
  .refine(
    (data) => {
      const hasUrl = Boolean(data.SERA_MCP_URL?.trim());
      const hasDist = Boolean(data.SERA_MCP_DIST?.trim());
      return hasUrl || hasDist;
    },
    {
      message:
        "Either SERA_MCP_URL (Streamable HTTP) or SERA_MCP_DIST (stdio path) must be configured.",
      path: ["SERA_MCP_DIST"],
    },
  )
  // Invariant 5: Transport safety for SERA_MCP_URL and SERA_MCP_TOKEN
  .refine(
    (data) => {
      const url = data.SERA_MCP_URL?.trim();
      if (!url) return true;
      try {
        const token = data.SERA_MCP_TOKEN?.trim() || undefined;
        assertTokenTransportSafety(url, token);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "SERA_MCP_URL must be a valid http(s) URL. If SERA_MCP_TOKEN is set, plaintext HTTP is only allowed to loopback addresses.",
      path: ["SERA_MCP_URL"],
    },
  );

/**
 * Inferred TypeScript type representing the fully validated environment configuration.
 */
export type WebhookEnv = z.infer<typeof WebhookEnvSchema>;

/**
 * Formats a ZodError into a structured, human-readable terminal diagnostic table.
 */
export function formatZodError(error: ZodError): string {
  const RED = "\x1b[31m";
  const BOLD = "\x1b[1m";
  const YELLOW = "\x1b[33m";
  const CYAN = "\x1b[36m";
  const RESET = "\x1b[0m";

  const lines: string[] = [];
  lines.push(
    `\n${RED}${BOLD}╔══════════════════════════════════════════════════════════════════════════════╗${RESET}`,
  );
  lines.push(
    `${RED}${BOLD}║                 FATAL CONFIGURATION ERROR — STARTUP ABORTED                  ║${RESET}`,
  );
  lines.push(
    `${RED}${BOLD}╚══════════════════════════════════════════════════════════════════════════════╝${RESET}`,
  );
  lines.push(
    "\nThe application failed to start due to invalid or missing environment variables:\n",
  );

  for (const issue of error.issues) {
    const fieldPath = issue.path.join(".") || "Configuration";
    lines.push(`  ${RED}•${RESET} ${BOLD}[${fieldPath}]${RESET} ${issue.message}`);

    // Contextual remediation hints
    if (fieldPath === "OPENAI_API_KEY") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Set ${YELLOW}OPENAI_API_KEY=sk-...${RESET} in your .env or execution environment.`,
      );
    } else if (fieldPath === "SERA_NETWORK") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Set ${YELLOW}SERA_NETWORK=mainnet${RESET} or ${YELLOW}SERA_NETWORK=sepolia${RESET}. Base networks belong to x402 payment facilitation.`,
      );
    } else if (fieldPath === "SERA_MCP_DIST") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Set ${YELLOW}SERA_MCP_URL=https://agents.sera.cx/mcp${RESET} or point ${YELLOW}SERA_MCP_DIST${RESET} to sera-mcp/dist/index.js.`,
      );
    } else if (fieldPath === "WEBHOOK_SECRET") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Set ${YELLOW}WEBHOOK_SECRET=<random-secret>${RESET} or set ${YELLOW}WEBHOOK_ALLOW_NO_AUTH=true${RESET} on HOST=127.0.0.1.`,
      );
    } else if (fieldPath === "HOST") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Set ${YELLOW}HOST=127.0.0.1${RESET} when running with WEBHOOK_ALLOW_NO_AUTH=true.`,
      );
    } else if (fieldPath === "WEBHOOK_HMAC_SECRET") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Provide your provider webhook secret in ${YELLOW}WEBHOOK_HMAC_SECRET${RESET} (e.g. whsec_...).`,
      );
    } else if (fieldPath === "PORT") {
      lines.push(
        `    ${CYAN}→ Hint:${RESET} Provide an integer port number between 1 and 65535 (default: 4000).`,
      );
    }
  }

  lines.push("\nPlease verify your .env file or deployment configuration and try again.\n");
  return lines.join("\n");
}

/**
 * Validates environment variables without exiting process (safe for unit testing).
 *
 * @param envOverrides Optional dictionary of environment variables (defaults to process.env).
 */
export function validateEnv(
  envOverrides?: Record<string, string | undefined>,
): { success: true; data: WebhookEnv } | { success: false; error: ZodError } {
  const rawEnv = envOverrides ?? process.env;
  return WebhookEnvSchema.safeParse(rawEnv);
}

/**
 * Validates environment variables at application startup.
 *
 * Enforces a fail-fast boot policy: if any variable fails validation, it prints
 * a clean diagnostic message to stderr and terminates with process.exit(1).
 *
 * @param envOverrides Optional dictionary of environment variables (defaults to process.env).
 * @returns Fully validated and typed WebhookEnv object.
 */
export function loadEnv(envOverrides?: Record<string, string | undefined>): WebhookEnv {
  const rawEnv = envOverrides ?? process.env;
  const result = WebhookEnvSchema.safeParse(rawEnv);

  if (!result.success) {
    process.stderr.write(formatZodError(result.error));
    process.exit(1);
  }

  return result.data;
}
