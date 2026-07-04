/**
 * Sera FX as an ACP (Agent Commerce Protocol) service provider — SKELETON.
 *
 * ACP lets other Virtuals agents *discover and pay for* your service on-chain.
 * You become a "seller" that offers Sera cross-border FX; buyer agents open a
 * job, you deliver a quote / unsigned settlement intent, and settlement is
 * recorded on-chain. Teams can join API-only — you don't need to run an
 * autonomous agent, just fulfil jobs with this handler.
 *
 *   npm i @virtuals-protocol/acp-node
 *
 * ⚠️ Before this runs you MUST complete the on-chain onboarding (see README):
 *   1. Create an agent + wallet in the Virtuals console and get it WHITELISTED.
 *   2. Register the agent in the ACP Service Registry with your service offering
 *      (name, price, deliverable schema) so buyers can discover it.
 *   3. Fund/whitelist the wallet per the ACP dev onboarding guide.
 *
 * ⚠️ API NAMES: the exact class/method names in @virtuals-protocol/acp-node move
 * between versions. Treat the calls below as the SHAPE of the integration and
 * confirm each against the version you install (npm docs + acp-node README).
 * The Sera-specific logic (fulfilSeraJob) is the part that matters and is stable.
 */

// import { AcpClient, AcpContractClient, AcpJobPhases } from "@virtuals-protocol/acp-node";

const SERA_GATEWAY_URL = process.env.SERA_GATEWAY_URL ?? "https://agents.sera.cx";

/** What a buyer agent sends when opening a Sera FX job. */
interface SeraFxJobRequest {
  from_token: string;
  to_token: string;
  amount: string;
  /** Optional: address that will sign the settlement intent. */
  signer?: string;
}

async function seraFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${SERA_GATEWAY_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", ...init?.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`sera ${path} → ${res.status}: ${data?.error ?? text}`);
  return data;
}

/**
 * The actual work behind the service: turn a buyer's request into a Sera quote
 * and (if a signer is given) an unsigned settlement intent. This is deliverable
 * content — the buyer's agent signs any intent itself; we never take custody.
 */
export async function fulfilSeraJob(req: SeraFxJobRequest): Promise<{
  quote: any;
  settlement_intent?: any;
  note: string;
}> {
  const quote = await seraFetch(`/quote`, {
    method: "POST",
    body: JSON.stringify({
      from_token: req.from_token,
      to_token: req.to_token,
      amount: req.amount,
    }),
  });

  let settlement_intent: any;
  if (req.signer) {
    settlement_intent = await seraFetch(`/settle`, {
      method: "POST",
      body: JSON.stringify({ quote_id: quote.quote_id, signer: req.signer }),
    });
  }

  return {
    quote,
    settlement_intent,
    note: settlement_intent
      ? "settlement_intent is UNSIGNED EIP-712 typed data — the buyer signs it in their own wallet."
      : "Provide a `signer` address to also receive an unsigned settlement intent.",
  };
}

/**
 * Wiring sketch — confirm the real names against your installed acp-node.
 *
 * async function main() {
 *   const contract = await AcpContractClient.build(
 *     process.env.WHITELISTED_WALLET_PRIVATE_KEY!,
 *     Number(process.env.ACP_AGENT_ID),          // your registered agent id
 *     process.env.AGENT_WALLET_ADDRESS!,
 *   );
 *
 *   const acp = new AcpClient({
 *     acpContractClient: contract,
 *     // Called when a buyer opens/advances a job with you as the seller.
 *     onNewTask: async (job) => {
 *       switch (job.phase) {
 *         case AcpJobPhases.REQUEST:
 *           // Accept the job and set your price (or reject).
 *           await job.respond(true);
 *           break;
 *         case AcpJobPhases.TRANSACTION: {
 *           // Buyer has paid — do the work and deliver.
 *           const result = await fulfilSeraJob(job.serviceRequirement as SeraFxJobRequest);
 *           await job.deliver({ type: "application/json", value: result });
 *           break;
 *         }
 *       }
 *     },
 *   });
 *
 *   await acp.init();
 *   console.log("Sera FX ACP provider listening for jobs…");
 * }
 * main().catch((e) => { console.error(e); process.exit(1); });
 */
