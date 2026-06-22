/**
 * withdraw-cli template — interactive walkthrough of Sera's 4-step dual-sig
 * instant-withdrawal flow.
 *
 * Step 1 (sera.withdraw_request): user-signed WithdrawIntent → executor
 *         co-signature.
 * Step 2 (sera.withdraw_build): both signatures → unsigned tx.
 * Step 3 (off-server): user signs the unsigned tx locally.
 * Step 4 (sera.withdraw_send): broadcast → tx_hash.
 *
 * This template stops at step 2 (the agent prints the unsigned tx and the
 * EIP-712 typed-data the wallet needs to sign for step 1). Wiring the
 * wallet-side signing for step 1 requires ethers / viem and a wallet
 * connection beyond the template's scope — see README for production
 * patterns.
 */
import { Agent, MCPServerStdio, run } from "@openai/agents";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const MCP_PATH =
  process.env.SERA_MCP_DIST ??
  resolve(process.cwd(), "../../sera-mcp/dist/index.js");

const USER = process.env.WITHDRAW_USER;
const RECIPIENT = process.env.WITHDRAW_RECIPIENT;
const TOKENS = (process.env.WITHDRAW_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AMOUNTS = (process.env.WITHDRAW_AMOUNTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY required.");
  process.exit(1);
}
if (!USER || !RECIPIENT || TOKENS.length === 0 || AMOUNTS.length === 0) {
  console.error(
    "Missing config. Set WITHDRAW_USER, WITHDRAW_RECIPIENT, WITHDRAW_TOKENS, WITHDRAW_AMOUNTS in .env.",
  );
  process.exit(1);
}
if (TOKENS.length !== AMOUNTS.length) {
  console.error(`WITHDRAW_TOKENS (${TOKENS.length}) and WITHDRAW_AMOUNTS (${AMOUNTS.length}) length mismatch.`);
  process.exit(1);
}

// Generate a fresh uuid for replay protection. Sera's uuid field is a
// uint256 decimal string — derive from 16 random bytes interpreted as an
// unsigned integer.
function freshUuid(): string {
  const buf = randomBytes(16);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString();
}

async function main() {
  const sera = new MCPServerStdio({
    name: "sera",
    command: "node",
    args: [MCP_PATH],
  });
  await sera.connect();

  const agent = new Agent({
    name: "sera-withdraw-cli",
    instructions:
      "You are a deterministic withdrawal-flow walker. Execute exactly the tool calls the orchestrator issues. " +
      "Always echo the recipient address prominently before any signing step.",
    mcpServers: [sera],
  });

  const deadline = String(Math.floor(Date.now() / 1000) + 600); // 10 minutes
  const uuid = freshUuid();

  const intent = {
    user: USER,
    tokens: TOKENS,
    amounts: AMOUNTS,
    recipient: RECIPIENT,
    deadline,
    uuid,
  };

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("Sera withdrawal — 4-step dual-signature flow");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("WithdrawIntent (you'll sign this under the Sera EIP-712 domain):");
  console.log(JSON.stringify(intent, null, 2));
  console.log(`\nRECIPIENT: ${RECIPIENT}`);
  console.log(`(Verify this address is correct before proceeding.)\n`);

  console.log("Step 1 — sign the WithdrawIntent locally, then call sera.withdraw_request");
  console.log("with { intent, user_signature }. This template doesn't include wallet wiring");
  console.log("(would need ethers / viem + a private key or wallet connection).\n");
  console.log("Sera EIP-712 domain:");
  console.log("  { name: 'Sera', version: '1', chainId: 1, verifyingContract: <Sera.sol address> }");
  console.log("  → fetch verifyingContract live from sera.doctor or sera://config\n");
  console.log("WithdrawIntent struct types (for EIP-712 signTypedData):");
  console.log("  WithdrawIntent: [");
  console.log("    { name: 'user', type: 'address' },");
  console.log("    { name: 'tokens', type: 'address[]' },");
  console.log("    { name: 'amounts', type: 'uint256[]' },");
  console.log("    { name: 'recipient', type: 'address' },");
  console.log("    { name: 'deadline', type: 'uint256' },");
  console.log("    { name: 'uuid', type: 'uint256' }");
  console.log("  ]\n");

  console.log("Once you have user_signature (0x… hex):");
  console.log("  → sera.withdraw_request { intent, user_signature }");
  console.log("  ← returns { executor_address, executor_signature }\n");
  console.log("Step 2: sera.withdraw_build { intent, user_signature, executor, executor_signature }");
  console.log("  ← returns { tx }  (unsigned EIP-1559 transaction)\n");
  console.log("Step 3: sign tx locally with your wallet → produces raw_tx (0x… hex).\n");
  console.log("Step 4: sera.withdraw_send { raw_tx }");
  console.log("  ← returns { tx_hash }\n");

  console.log("This template stops here. To demonstrate the live calls end-to-end,");
  console.log("fork this template and wire in your wallet library of choice.\n");

  // Sanity check that sera-mcp is wired and reachable, via the doctor tool.
  const doctor = await run(agent, [
    {
      role: "user",
      content: "Call sera.doctor and return ONLY whether overall_ok is true.",
    },
  ]);
  console.log(`\nsera.doctor preflight: ${doctor.finalOutput}\n`);

  await sera.close();
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
