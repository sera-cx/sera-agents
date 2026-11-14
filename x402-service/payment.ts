/**
 * Payment state transitions + verify/settle/execute orchestration.
 *
 * State machine: pending → verified → settling → executing → delivered
 *                                                          | failed_refundable
 *
 * "settling" is a sub-step of "verified" — once facilitator /verify returns
 * isValid:true, we MUST settle BEFORE releasing the service. The atomic
 * CAS at the boundary (cas("pending" → "verified")) is what prevents
 * Attack II (replay/idempotency) from arXiv:2605.11781.
 *
 * In demo mode: verifyPayment short-circuits to ok; settle is a no-op;
 * executeSwap returns a mock response. Safe to run locally.
 *
 * In live mode: verifyPayment calls Coinbase CDP /verify; settle calls
 * /settle; executeSwap routes through sera.convert_and_send via the MCP
 * subprocess. CDP facilitator handles confirmation depth ≥ k.
 */
import type { X402Config } from "./env.js";
import type { StateStore, PendingPayment } from "./state.js";
import {
  facilitatorVerify,
  facilitatorSettle,
  type FacilitatorConfig,
  type PaymentRequirements,
} from "./facilitator.js";
import { checkOnce } from "./payment-confirm.js";
import { parsePaymentAuthorization } from "./payment-binding.js";
import { verifyTransferAuthorization } from "./eip3009.js";
import type { SeraMcpClient } from "./sera-client.js";
import { atomicToUsdc } from "./money.js";

export interface VerifyOutcome {
  ok: boolean;
  reason?: string;
}

export interface SettleOutcome {
  ok: boolean;
  txHash?: string;
  networkId?: string;
  reason?: string;
}

export interface ExecuteOutcome {
  trade_id?: string;
  tx_hash?: string | null;
  min_output?: number;
  gas_mode?: string;
  demo: boolean;
  error?: string;
}

function makeFacilitatorConfig(cfg: X402Config): FacilitatorConfig {
  // Caller has already passed env safety gates — non-null assertions are safe
  // for the fields the gates require for the configured kind.
  return {
    kind: cfg.facilitatorKind,
    url: cfg.facilitatorUrl!,
    apiKeyId: cfg.cdpApiKeyId,
    apiKeySecret: cfg.cdpApiKeySecret,
    bearerToken: cfg.facilitatorToken,
    network: cfg.cdpNetwork,
    confirmationDepth: cfg.confirmationDepth,
  };
}

function paymentRequirements(
  cfg: X402Config,
  pending: PendingPayment,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.cdpNetwork,
    maxAmountRequired: pending.amount_usdc, // exact USDC base units
    resource: `https://${cfg.host}:${cfg.port}/x402/swap`,
    description: `Sera FX delivery: ${pending.swap_request.amount} ${pending.swap_request.to_currency} → ${pending.swap_request.recipient}`,
    mimeType: "application/json",
    payTo: pending.pay_to,
    maxTimeoutSeconds: cfg.pendingTtlSeconds,
    asset: cfg.cdpUsdcAddress ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet USDC
    extra: { name: "USD Coin", version: "2" },
  };
}

// ── Verify ───────────────────────────────────────────────────────────────
export async function verifyPayment(
  cfg: X402Config,
  pending: PendingPayment,
  paymentHeader: string,
): Promise<VerifyOutcome> {
  if (cfg.mode === "demo") {
    if (!paymentHeader) return { ok: false, reason: "X-PAYMENT required" };
    return { ok: true };
  }
  const result = await facilitatorVerify(
    makeFacilitatorConfig(cfg),
    paymentHeader,
    paymentRequirements(cfg, pending),
  );
  if (!result.isValid) {
    return { ok: false, reason: result.invalidReason ?? "facilitator rejected payment" };
  }
  return { ok: true };
}

// ── Settle ───────────────────────────────────────────────────────────────
// Two-phase: caller MUST have already moved state pending → verified via
// atomic CAS. Settle returns the facilitator response (txHash, networkId)
// to persist for audit.
export async function settlePayment(
  cfg: X402Config,
  pending: PendingPayment,
  paymentHeader: string,
): Promise<SettleOutcome> {
  if (cfg.mode === "demo") {
    return { ok: true, txHash: undefined, networkId: "demo" };
  }
  const result = await facilitatorSettle(
    makeFacilitatorConfig(cfg),
    paymentHeader,
    paymentRequirements(cfg, pending),
  );
  if (!result.success) {
    return { ok: false, reason: result.error ?? "settle failed" };
  }
  return { ok: true, txHash: result.txHash, networkId: result.networkId };
}

// ── On-chain confirmation gate ───────────────────────────────────────────
// Independently verifies the settle tx actually moved >= the required USDC
// into the vault, at >= confirmationDepth. This is the control that makes a
// lying/compromised facilitator unable to trigger free delivery. Demo mode
// and the explicit X402_SKIP_ONCHAIN_CONFIRM opt-out skip it.
export interface ConfirmOutcome {
  ok: boolean;
  reason?: string;
  skipped?: boolean;
}

export async function confirmPayment(
  cfg: X402Config,
  pending: PendingPayment,
  settleTxHash: string | undefined,
  paymentAuthorizationHeader: string,
): Promise<ConfirmOutcome> {
  if (cfg.mode === "demo") return { ok: true, skipped: true };
  if (cfg.skipOnchainConfirm && !cfg.rpcUrl) return { ok: true, skipped: true };
  if (!cfg.rpcUrl) return { ok: false, reason: "no X402_RPC_URL configured" };
  if (!settleTxHash) {
    // Facilitator claimed success but produced no tx hash — nothing to verify.
    return { ok: false, reason: "settle returned no txHash to confirm on-chain" };
  }

  // Anti-replay binding: the confirmation must prove THIS payer paid exactly
  // what THIS payment's signed EIP-3009 authorization says, into the vault.
  // An unparseable authorization is a hard reject — never pay out against a
  // proof we cannot bind.
  const auth = parsePaymentAuthorization(paymentAuthorizationHeader);
  if (!auth) return { ok: false, reason: "payment authorization unparseable — cannot bind confirmation" };

  const asset = cfg.cdpUsdcAddress ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const required = BigInt(pending.amount_usdc);
  if (auth.to !== cfg.vaultAddress!.toLowerCase()) {
    return { ok: false, reason: "authorization recipient is not the vault" };
  }
  if (BigInt(auth.value) < required) {
    return { ok: false, reason: "authorized value below required amount" };
  }

  // CRYPTOGRAPHIC BINDING — the load-bearing anti-forgery check. Recover the
  // EIP-3009 signer and require it to equal `from`, so a malicious facilitator
  // cannot claim someone else's `from`/tx. Without a chainId we cannot verify
  // and therefore refuse (fail-closed).
  if (cfg.chainId === undefined) {
    return { ok: false, reason: "no chainId configured for signature verification" };
  }
  const sig = await verifyTransferAuthorization(
    auth,
    auth.signature,
    { name: cfg.usdcName, version: cfg.usdcVersion, chainId: cfg.chainId, verifyingContract: asset },
    Date.now() / 1000,
  );
  if (!sig.ok) return { ok: false, reason: `payment signature invalid: ${sig.reason}` };

  // Single shot per request — the client drives retry cadence via 202s; no
  // long in-handler poll to park connections on.
  const result = await checkOnce(
    {
      rpcUrl: cfg.rpcUrl,
      asset,
      vault: cfg.vaultAddress!,
      minAmountBaseUnits: required.toString(),
      confirmationDepth: cfg.confirmationDepth,
      payerFrom: auth.from,
      exactValueBaseUnits: auth.value,
    },
    settleTxHash,
  );
  return result.confirmed ? { ok: true } : { ok: false, reason: result.reason };
}

// ── Execute Sera swap ────────────────────────────────────────────────────
// Calls sera.convert_and_send via MCP subprocess. Requires SERA_SIGNER_MODE=local
// + funded vault. Wrapped so all errors become structured ExecuteOutcome.
export async function executeSwap(
  cfg: X402Config,
  mcp: SeraMcpClient,
  pending: PendingPayment,
): Promise<ExecuteOutcome> {
  if (cfg.mode === "demo") {
    return {
      trade_id: `demo-${pending.payment_id.slice(0, 8)}`,
      tx_hash: null,
      min_output: pending.swap_request.amount,
      gas_mode: "receive_less",
      demo: true,
    };
  }
  try {
    const r = await mcp.call("tools/call", {
      name: "sera.convert_and_send",
      arguments: {
        from: "USDC",
        to: pending.swap_request.to_currency,
        amount: Number(atomicToUsdc(pending.amount_usdc)),
        owner_address: cfg.vaultAddress,
        recipient: pending.swap_request.recipient,
        gas_mode: "pay_more",
      },
    });
    if (r?.isError) return { error: r.content?.[0]?.text ?? "mcp error", demo: false };
    const txt = r?.content?.[0]?.text;
    const parsed = txt ? JSON.parse(txt) : null;
    return {
      trade_id: parsed?.execution?.trade_id ?? "unknown",
      tx_hash: parsed?.execution?.tx_hash ?? null,
      min_output: Number(parsed?.quote?.human?.min_output ?? 0),
      gas_mode: "pay_more",
      demo: false,
    };
  } catch (e: any) {
    return { error: e?.message ?? String(e), demo: false };
  }
}

// ── State store integration helpers ──────────────────────────────────────
// Tiny wrappers around the CAS-based store. Centralized here so the HTTP
// layer doesn't see raw state names.

export function transitionToVerified(
  store: StateStore,
  pending: PendingPayment,
): boolean {
  return store.cas(pending.payment_id, "pending", "verified");
}

export function transitionToExecuting(
  store: StateStore,
  pending: PendingPayment,
): boolean {
  return store.cas(pending.payment_id, "verified", "executing");
}

export function transitionToDelivered(
  store: StateStore,
  pending: PendingPayment,
  deliveredPayload: string,
  settlementPayload: string,
): boolean {
  return store.cas(pending.payment_id, "executing", "delivered", {
    delivered_payload: deliveredPayload,
    settlement_payload: settlementPayload,
  });
}

/** Facilitator /settle failed: no USDC charged — terminal, NOT refundable. */
export function transitionToSettleFailed(
  store: StateStore,
  pending: PendingPayment,
  error: string,
): boolean {
  return store.cas(pending.payment_id, "verified", "settle_failed", {
    last_error: error,
  });
}

export function transitionToFailedRefundable(
  store: StateStore,
  pending: PendingPayment,
  error: string,
): boolean {
  return store.cas(pending.payment_id, "executing", "failed_refundable", {
    last_error: error,
  });
}
