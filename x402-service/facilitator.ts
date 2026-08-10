/** CDP x402 v2 facilitator adapter.  Credentials never leave this module. */
import { generateJwt } from "@coinbase/cdp-sdk/auth";

export interface PaymentRequirements {
  scheme: "exact"; network: "eip155:84532" | "eip155:8453";
  maxAmountRequired: string; resource: string; description: string;
  mimeType: string; payTo: string; maxTimeoutSeconds: number; asset: string;
  extra: Record<string, unknown>;
}
export interface FacilitatorConfig { url: string; apiKeyId: string; apiKeySecret: string; }
export interface VerifyResult { isValid: boolean; invalidReason?: string; transaction?: string; network?: string; errorReason?: string; httpStatus?: number; }
export interface SettleResult { success: boolean; transaction?: string; network?: string; errorReason?: string; httpStatus?: number; unknown?: boolean; }

async function request(cfg: FacilitatorConfig, endpoint: "verify" | "settle", paymentPayload: string, paymentRequirements: PaymentRequirements) {
  const base = new URL(cfg.url);
  const path = `${base.pathname.replace(/\/$/, "")}/${endpoint}`;
  const jwt = await generateJwt({ apiKeyId: cfg.apiKeyId, apiKeySecret: cfg.apiKeySecret, requestMethod: "POST", requestHost: base.host, requestPath: path, expiresIn: 60 });
  const res = await fetch(new URL(path, base).toString(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }) });
  const body = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(body); } catch { /* retain bounded text only */ }
  return { res, data, detail: typeof data.errorReason === "string" ? data.errorReason : body.slice(0, 200) };
}
export async function facilitatorVerify(cfg: FacilitatorConfig, paymentPayload: string, requirements: PaymentRequirements): Promise<VerifyResult> {
  try { const { res, data, detail } = await request(cfg, "verify", paymentPayload, requirements); return { isValid: res.ok && data.isValid === true, invalidReason: res.ok ? (data.invalidReason as string | undefined) : `facilitator ${res.status}: ${detail}`, transaction: data.transaction as string | undefined, network: data.network as string | undefined, errorReason: data.errorReason as string | undefined, httpStatus: res.status }; }
  catch (e: unknown) { return { isValid: false, invalidReason: `facilitator unreachable: ${e instanceof Error ? e.message : String(e)}` }; }
}
export async function facilitatorSettle(cfg: FacilitatorConfig, paymentPayload: string, requirements: PaymentRequirements): Promise<SettleResult> {
  try { const { res, data, detail } = await request(cfg, "settle", paymentPayload, requirements); return { success: res.ok && data.success === true, transaction: (data.transaction ?? data.txHash) as string | undefined, network: (data.network ?? data.networkId) as string | undefined, errorReason: (data.errorReason as string | undefined) ?? (!res.ok ? `facilitator ${res.status}: ${detail}` : undefined), httpStatus: res.status }; }
  catch (e: unknown) { return { success: false, unknown: true, errorReason: `facilitator unreachable: ${e instanceof Error ? e.message : String(e)}` }; }
}
