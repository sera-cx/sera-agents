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

function authHeader(cfg: FacilitatorConfig): Record<string, string> {
  // CDP typically takes a Bearer token derived from {api_key_id}:{api_secret}.
  // Some installs use HMAC-SHA256 signed JWT — adjust here when verified
  // against the live CDP integration. We keep the simpler concat form for
  // now and document the override below.
  return {
    authorization: `Bearer ${cfg.apiKeyId}:${cfg.apiKeySecret}`,
  };
}

export async function facilitatorVerify(
  cfg: FacilitatorConfig,
  paymentHeader: string,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeader(cfg),
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
    const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/settle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeader(cfg),
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
