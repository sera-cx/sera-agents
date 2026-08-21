/**
 * Coinbase CDP x402 facilitator client — verify + settle.
 *
 * Two endpoints:
 *   POST {facilitator_url}/verify  → { isValid, invalidReason? }
 *   POST {facilitator_url}/settle  → { success, txHash, networkId }
 *
 * Per arXiv:2605.11781 ("Five Attacks on x402"):
 *   - Two-phase: verify before settle. Atomic idempotency reserve between them.
 *   - Bound facilitator caller identity (mitigates Attack I-B settlement preemption).
 *   - Confirmation depth k≥3 on Base mainnet (mitigates Attack I-A revert-grant).
 *
 * This client is NOT production-verified against Coinbase mainnet. Treat the
 * shape below as best-effort against published API; expect to refine after
 * the first Base Sepolia E2E test.
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

export interface FacilitatorConfig {
  url: string;            // e.g. https://api.cdp.coinbase.com/platform/v2/x402
  apiKeyId: string;
  apiKeySecret: string;
  network: string;        // base | base-sepolia | polygon | arbitrum | solana
  confirmationDepth: number;
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

/**
 * Generate a short-lived ES256 JWT for Coinbase CDP API v2 endpoints.
 * Includes request-specific `uri` claim formatted as `<METHOD> <host><pathname>`
 * and a cryptographic random nonce in the header.
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

function authHeader(cfg: FacilitatorConfig, method: string, url: string): Record<string, string> {
  const jwt = buildCdpJwt(cfg.apiKeyId, cfg.apiKeySecret, method, url);
  return {
    authorization: `Bearer ${jwt}`,
  };
}

export async function facilitatorVerify(
  cfg: FacilitatorConfig,
  paymentHeader: string,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  try {
    const url = `${cfg.url.replace(/\/+$/, "")}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeader(cfg, "POST", url),
      },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader,
        paymentRequirements: requirements,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        isValid: false,
        invalidReason: `facilitator ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as VerifyResult;
    return data;
  } catch (e: any) {
    return { isValid: false, invalidReason: `facilitator unreachable: ${e?.message ?? String(e)}` };
  }
}

export async function facilitatorSettle(
  cfg: FacilitatorConfig,
  paymentHeader: string,
  requirements: PaymentRequirements,
): Promise<SettleResult> {
  try {
    const url = `${cfg.url.replace(/\/+$/, "")}/settle`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeader(cfg, "POST", url),
      },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader,
        paymentRequirements: requirements,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `facilitator ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as SettleResult;
    return data;
  } catch (e: any) {
    return { success: false, error: `facilitator unreachable: ${e?.message ?? String(e)}` };
  }
}
