/** Operator-only E2E harness. Secrets are supplied by the environment/secret manager. */
import { writeFile } from "node:fs/promises";

const url = process.env.X402_PUBLIC_URL;
const signature = process.env.X402_E2E_PAYMENT_SIGNATURE;
if (!url || !signature) throw new Error("X402_PUBLIC_URL and X402_E2E_PAYMENT_SIGNATURE are required (load them from the operator secret manager before running)");
if (process.env.X402_NETWORK !== "eip155:84532" || process.env.X402_TESTNET_ACK !== "true") throw new Error("E2E only runs on acknowledged Base Sepolia");

// Buyer signing is deliberately external: use a funded test payer / v2 buyer client,
// then pass only its opaque signature to this runner.
const body = { 
  from_currency: "USDC", 
  to_currency: process.env.X402_E2E_TO ?? "EURC", 
  amount: Number(process.env.X402_E2E_AMOUNT ?? "1"), 
  recipient: process.env.X402_E2E_RECIPIENT 
};

if (!body.recipient) throw new Error("X402_E2E_RECIPIENT is required");

const preflight = await fetch(`${url}/health`); if (!preflight.ok) throw new Error("service health preflight failed");

const quote = await fetch(`${url}/x402/swap`, { 
  method:"POST", 
  headers:{
    "content-type":"application/json"
  }, 
  body:JSON.stringify(body) 
});

if (quote.status !== 402 || !quote.headers.get("payment-required")) throw new Error("expected x402 v2 402 PAYMENT-REQUIRED");
const paymentId = quote.headers.get("x-payment-id");
if (!paymentId) throw new Error("402 response did not include X-Payment-Id");

const paid = await fetch(`${url}/x402/swap`, { 
  method:"POST", 
  headers:{
    "content-type":"application/json",
    "payment-signature":signature,
    "x-payment-id":paymentId
  }, 
  body:JSON.stringify(body) 
});

const result = await paid.json() as Record<string, unknown>;

const evidence = { 
  attestation_id: paid.ok ? `attest-${new Date().toISOString().slice(0,10)}-${process.env.GIT_COMMIT_SHA ?? "unknown"}-${paymentId}` : undefined, 
  timestamp:new Date().toISOString(), commit:process.env.GIT_COMMIT_SHA ?? "unknown", 
  payment_id:paymentId, 
  status:paid.status, 
  settlement:result.settlement ?? null, 
  delivery:(result.delivered as Record<string,unknown>|undefined)?.tx_hash ?? null, 
  reviewer:process.env.X402_E2E_REVIEWER ?? "unassigned" 
};

  await writeFile(process.env.X402_E2E_EVIDENCE_PATH ?? "x402-e2e-attestation.json", JSON.stringify(evidence, null, 2));
if (!paid.ok) process.exitCode=1;
