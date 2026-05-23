# withdraw-cli

Template: terminal walkthrough of Sera's 4-step dual-signature instant withdrawal. Demonstrates the withdraw tools (`sera.withdraw_request`, `sera.withdraw_build`, `sera.withdraw_send`) added in sera-mcp v0.6.0.

**Status:** **Demo / starter.** The flow is correctly wired but signing happens off-template (you sign locally between steps 2 and 3). Read the [Production checklist](#production-checklist-before-deploying) before deploying.

## What it does

Walks through the 4-step flow:

```
1. sera.withdraw_request  →  user signs WithdrawIntent under Sera EIP-712 domain.
                             Service returns executor co-signature.

2. sera.withdraw_build    →  given both signatures, returns unsigned
                             executeInstantWithdrawDualSig tx.

3. (off-server)           →  user signs the unsigned tx locally with their wallet.

4. sera.withdraw_send     →  broadcast the signed raw_tx; returns tx_hash.
```

Withdrawal target comes from env (`WITHDRAW_USER`, `WITHDRAW_RECIPIENT`, `WITHDRAW_TOKENS`, `WITHDRAW_AMOUNTS`). Up to 20 tokens per withdrawal in a single tx.

## Run

```bash
cp .env.example .env
# Edit .env with your wallet + tokens + amounts
npm install
npm start
```

The agent walks each step interactively. After step 1 (executor co-signature obtained) it prints the EIP-712 typed-data your wallet must sign, then pauses. After you provide the signed raw_tx, it broadcasts via step 4.

## Why a separate template instead of using the bundled `sera-agent/`?

`sera-agent/` is a general-purpose interactive CLI. Withdraw is a multi-step operation with manual signing between steps — having a dedicated template makes the flow obvious. Also, the dual-sig pattern is the most commonly-mis-implemented part of Sera; first-time integrators benefit from a focused example.

## Production checklist before deploying

If you fork this template into something automated, complete ALL of these:

- [ ] Wallet isolation. The signing happens in YOUR wallet, not the server — but verify your wallet UX clearly shows the WithdrawIntent fields (user, tokens[], amounts[], recipient, deadline, uuid) before signing.
- [ ] Recipient verification. Always echo the recipient address back to the user and require explicit confirmation. Withdrawals are non-reversible.
- [ ] Deadline bounds. Per Sera spec: `deadline` must be future and ≤ 365d − 300s. Pick a tight value (minutes, not days) for time-bounded operations.
- [ ] UUID uniqueness. Each WithdrawIntent uses a new uuid (uint256 decimal string). Re-use → `UuidAlreadyUsed` revert. The template generates a fresh uuid per run.
- [ ] Failure handling. If step 2 (`withdraw_build`) succeeds but step 4 (`withdraw_send`) fails, the executor signature is consumed but the tx isn't on-chain. You can re-sign and re-send the same intent (same uuid) because the on-chain `consumeIntentUuid` only fires on successful execution.
- [ ] Emergency fallback. If the Sera API is unreachable, `Sera.emergencyWithdraw(token, amount)` on-chain is the recovery path — two-step delayed flow (≥7200 blocks ~24h wait, then ≤14400 blocks ~48h window). Document this for operators.
- [ ] Operator audit. Log every withdrawal request (intent JSON + tx_hash) to a sink you can audit.

## License

MIT.
