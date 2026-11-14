/**
 * x402 facilitator clients — verify + settle.
 *
 * Two interchangeable backends behind one `Facilitator` interface:
 *
 *   - "cdp"        Coinbase CDP hosted facilitator. Auth: short-lived ES256
 *                  JWT (request-bound). Networks: base | base-sepolia |
 *                  polygon | arbitrum | solana (per CDP docs).
 *   - "selfhosted" Any facilitator implementing the open x402 /verify +
 *                  /settle shape — e.g. the Apache-2.0 reference facilitator
 *                  from coinbase/x402 run on your own infra against any EVM
 *                  RPC (incl. Ethereum Sepolia, eip155:11155111). Auth:
 *                  optional static bearer token — it is YOUR service.
 *
 * SECURITY: the service must NOT deliver on the facilitator's word alone.
 * A compromised facilitator can return isValid/success:true for a payment
 * that never happened. The on-chain confirmation gate (payment-confirm.ts)
 * independently verifies the USDC transfer landed in the vault before the
 * swap executes. Facilitator responses are treated as hints; the chain is
 * the authority.
 *
 * Per arXiv:2605.11781 ("Five Attacks on x402"):
 *   - Two-phase: verify before settle. Atomic idempotency reserve between them.
 *   - Bound facilitator caller identity (mitigates Attack I-B settlement preemption).
 *   - Confirmation depth k≥3 (mitigates Attack I-A revert-grant).
 */

import { createPrivateKey, randomBytes, sign } from "node:crypto";

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
}

export interface SettleResult {
  success: boolean;
  txHash?: string;
  networkId?: string;
  error?: string;
}

export type FacilitatorKind = "cdp" | "selfhosted";

export interface FacilitatorConfig {
  /** Defaults to "cdp" for back-compat with pre-refactor configs. */
  kind?: FacilitatorKind;
  url: string;            // cdp: https://api.cdp.coinbase.com/platform/v2/x402 | selfhosted: your own
  network: string;        // cdp: base | base-sepolia | ... | selfhosted: any (e.g. eip155:11155111)
  confirmationDepth: number;
  // cdp only
  apiKeyId?: string;
  apiKeySecret?: string;
  // selfhosted only — optional static bearer for your own facilitator
  bearerToken?: string;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
}

export interface Facilitator {
  verify(paymentHeader: string, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(paymentHeader: string, requirements: PaymentRequirements): Promise<SettleResult>;
}

/**
 * Generate a short-lived ES256 JWT for Coinbase CDP API v2 endpoints.
 * Includes request-specific `uri` claim formatted as `<METHOD> <host><pathname>`,
 * the `aud: ["cdp_service"]` audience CDP requires, and a cryptographic random
 * nonce in the header.
 */
export function buildCdpJwt(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  requestUrl: string,
): string {
  const parsedUrl = new URL(requestUrl);
  const uri = `${method.toUpperCase()} ${parsedUrl.host}${parsedUrl.pathname}`;
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: apiKeyId,
    nonce: randomBytes(16).toString("hex"),
  };

  const payload = {
    iss: "cdp",
    sub: apiKeyId,
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uri,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${headerB64}.${payloadB64}`;

  const normalizedKey = apiKeySecret.includes("\\n")
    ? apiKeySecret.replace(/\\n/g, "\n")
    : apiKeySecret;
  const privateKey = createPrivateKey(normalizedKey);

  const signature = sign("SHA256", Buffer.from(data), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const signatureB64 = signature.toString("base64url");

  return `${data}.${signatureB64}`;
}

/** Fail-closed POST shared by both backends. */
async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  onHttpError: (status: number, text: string) => T,
  onUnreachable: (message: string) => T,
): Promise<T | { data: unknown }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return onHttpError(res.status, text.replace(/[\r\n]+/g, " ").slice(0, 200));
    }
    // Keep successful response bodies untrusted until the backend-specific
    // handler validates its explicit grant field (isValid/success === true).
    return { data: await res.json() };
  } catch (e: any) {
    return onUnreachable(e?.message ?? String(e));
  }
}

function responseRecord(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function makeBackend(cfg: FacilitatorConfig): Facilitator {
  const base = cfg.url.replace(/\/+$/, "");

  const kind: FacilitatorKind = cfg.kind ?? "cdp";
  const authFor = (url: string): Record<string, string> => {
    if (kind === "cdp") {
      const jwt = buildCdpJwt(cfg.apiKeyId!, cfg.apiKeySecret!, "POST", url);
      return { authorization: `Bearer ${jwt}` };
    }
    // selfhosted: your own facilitator — static bearer if configured, else none.
    return cfg.bearerToken ? { authorization: `Bearer ${cfg.bearerToken}` } : {};
  };

  return {
    async verify(paymentHeader, requirements): Promise<VerifyResult> {
      const url = `${base}/verify`;
      const out = await postJson<VerifyResult>(
        url,
        authFor(url),
        { x402Version: 1, paymentHeader, paymentRequirements: requirements },
        (status, text) => ({ isValid: false, invalidReason: `facilitator ${status}: ${text}` }),
        (msg) => ({ isValid: false, invalidReason: `facilitator unreachable: ${msg}` }),
      );
      if ("data" in out) {
        const d = responseRecord(out.data);
        // Fail-closed: only an explicit isValid === true passes.
        return d.isValid === true
          ? { isValid: true }
          : {
              isValid: false,
              invalidReason:
                typeof d.invalidReason === "string"
                  ? d.invalidReason
                  : "facilitator did not confirm validity",
            };
      }
      return out;
    },

    async settle(paymentHeader, requirements): Promise<SettleResult> {
      const url = `${base}/settle`;
      const out = await postJson<SettleResult>(
        url,
        authFor(url),
        { x402Version: 1, paymentHeader, paymentRequirements: requirements },
        (status, text) => ({ success: false, error: `facilitator ${status}: ${text}` }),
        (msg) => ({ success: false, error: `facilitator unreachable: ${msg}` }),
      );
      if ("data" in out) {
        const d = responseRecord(out.data);
        // Fail-closed: only an explicit success === true passes.
        return d.success === true
          ? {
              success: true,
              txHash: typeof d.txHash === "string" ? d.txHash : undefined,
              networkId: typeof d.networkId === "string" ? d.networkId : undefined,
            }
          : {
              success: false,
              error:
                typeof d.error === "string" ? d.error : "facilitator did not confirm settlement",
            };
      }
      return out;
    },
  };
}

export function makeFacilitator(cfg: FacilitatorConfig): Facilitator {
  return makeBackend(cfg);
}

// ── Back-compat function API (existing callers/tests) ────────────────────
export async function facilitatorVerify(
  cfg: FacilitatorConfig,
  paymentHeader: string,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  return makeFacilitator(cfg).verify(paymentHeader, requirements);
}

export async function facilitatorSettle(
  cfg: FacilitatorConfig,
  paymentHeader: string,
  requirements: PaymentRequirements,
): Promise<SettleResult> {
  return makeFacilitator(cfg).settle(paymentHeader, requirements);
}
