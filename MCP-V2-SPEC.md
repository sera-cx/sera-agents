# sera-mcp v2 — appchain tool surface

**Status: draft for engineering review. Nothing here is settled.**

Settlement moves from a contract on a general-purpose chain to Sera's own
appchain. That changes what four things mean — custody, policy, finality and
proof — and the MCP has to expose each of them as tools an agent can call.

This specifies the thirteen new tools, what changes underneath the existing
fifty-five, the error taxonomy agents will branch on, and the migration that
keeps `v1` installs working. Implementation lives in
[`sera-cx/sera-mcp`](https://github.com/sera-cx/sera-mcp); this repo consumes
it, so the spec is written against the tool interface rather than the engine.

Open questions are collected at the end. Several of them block parts of this
document, and they are marked where they bite.

---

## The shape of the change

| | v1 — mainnet today | v2 — appchain |
|---|---|---|
| Custody | One signer does everything | Owner key authorises agent keys |
| Policy | `POLICY_*` caps, enforced client-side | Mandate on the key, enforced in the block |
| Finality | Confirmations, then a reorg window | Final in the block that contains the fill |
| Fees | Gas token, separate from the trade | Taken in the stablecoin being swapped |
| Proof | Transaction hash | Signed receipt, verifiable against L1 |
| Exit | Whatever the contract allows | Forced withdrawal from Ethereum |

The tool count goes 55 → 68. No existing tool is removed or renamed.

---

## 1. Account and keys

The two-tier model is the load-bearing change. An **owner key** — a Safe or a
hardware wallet — creates the account and grants authority. An **agent key**
belongs to one agent and can only act inside its mandate.

Every mutating call here is owner-authorised, so it follows the pattern the
repo already uses for the on-chain leg: the tool returns unsigned EIP-712 typed
data, the owner signs it in their own wallet, and `send_tx` broadcasts it. The
MCP never holds the owner key.

### `sera.create_account`

Open a Sera account under an owner key.

**Params**
- `owner` req — the owner address (Safe or EOA)
- `home_currency` — ISO code mandates will be denominated in (default `USD`)

**Returns**
`{ account, typed_data, already_exists }`

`account` is derivable from `owner` before the registration lands, so an agent
can be handed its account identifier ahead of funding. If the account already
exists this is a read: `already_exists: true` and no `typed_data`.

> Blocked on **Q4** — whether account addresses are deterministic from the
> owner key. If they are not, this returns only `typed_data` and the caller
> has to wait for the registration receipt to learn the address.

### `sera.create_agent_key`

Register a public key as an agent key on the account.

**Params**
- `account` req
- `public_key` req — the agent's public key
- `label` req — human-readable, shown in `list_keys` and in receipts

**Returns**
`{ agent_key, typed_data }`

The agent generates its own keypair and submits only the public half. The owner
never sees the agent's private key, and no tool in this surface accepts one.
A key registered without a mandate can do nothing; `set_mandate` is a separate
call so that granting authority is always a distinct, reviewable signature.

### `sera.set_mandate`

Attach or replace the mandate on an agent key.

**Params**
- `agent_key` req
- `cap` req — notional cap, in the account's `home_currency`
- `cap_window` req — `per_day` · `per_week` · `total`
- `pairs` req — allowed markets, e.g. `["XSGD/MYRT", "USDC/*"]`
- `destinations` req — allowed payout targets; Sera accounts, L1 addresses, or
  `["self"]` to confine the key to the account it belongs to
- `expires_at` req — ISO 8601; no mandate is open-ended
- `per_tx_max` — cap on any single settlement (default: `cap`)
- `replaces` req — the `version` of the mandate being replaced, or `0` for the
  first

**Returns**
`{ agent_key, mandate: Mandate, typed_data }`

Replace, never merge. A partial update that silently keeps an old allowlist is
the kind of thing that widens authority by accident, so the whole mandate is
submitted each time and `replaces` makes a lost update fail loudly rather than
clobber a concurrent change.

`destinations` matters more than `cap` and is the easier one to get wrong. A
key capped at 1,000/day but able to send anywhere drains 1,000/day forever.

### `sera.revoke_key`

Revoke an agent key.

**Params**
- `agent_key` req
- `settle_in_flight` — whether intents already submitted and not yet settled
  are allowed to complete (default `false`)

**Returns**
`{ agent_key, typed_data, in_flight: [{ intent_id, pair, amount }] }`

The default is to drop in-flight intents. Revocation is what an owner reaches
for when something is wrong, and the common case is wanting it stopped now;
`settle_in_flight: true` is for the orderly retirement of a key.

> Blocked on **Q5** — whether the chain can drop a submitted intent before it
> settles. If finality is immediate on submission there is no in-flight window,
> `settle_in_flight` becomes meaningless, and this returns an empty list.

### `sera.list_keys`

Every agent key on the account, with mandate and usage.

**Params**
- `account` req
- `include_revoked` — default `false`

**Returns**
`{ account, keys: [{ agent_key, label, mandate: Mandate, used, remaining, last_used_at, revoked_at? }] }`

### `sera.mandate_remaining`

What this key may still do — and, optionally, whether one specific settlement
would pass before the agent plans around it.

**Params**
- `agent_key` req
- `simulate` — `{ pair, amount, destination }` to dry-check one settlement

**Returns**
`{ remaining, cap, cap_window, resets_at, expires_at, simulate?: { would_pass, reason?, violated? } }`

The `simulate` branch is the point of the tool. An agent that can only read a
remaining balance has to reimplement pair and destination matching to predict a
rejection; one that can ask gets the chain's own answer. `violated` carries the
same code the real call would fail with, so planning and execution agree.

---

## 2. Funding

### `sera.deposit_address`

Where to send money to credit this account.

**Params**
- `account` req
- `chain` — filter to one source chain

**Returns**
```
{
  l1:      { chain: "ethereum", deposit_contract, account_ref },
  bridged: [{ chain: "base", address, via: "intent-bridge", assets: ["USDC"] }, ...],
  native:  [{ symbol: "MYRT", issuer, mints_in_ledger: true }, ...]
}
```

Agents paste these addresses into transfers, and a wrong one loses the money
with no recourse. The response must carry enough for the caller to check the
address independently — the derivation path or a signature over
`(account, chain, address)` — and the tool description must tell agents to
verify rather than trust the string.

Most of the currency set has no bridge leg at all: `native` lists the issuers
that mint directly in-ledger, where funding is an issuance rather than a
transfer.

### `sera.deposit_status`

Track a deposit through to credit.

**Params**
- `account` req
- one of `tx_hash` · `deposit_id`

**Returns**
`{ state, chain, asset, amount, confirmations, required_confirmations, credited_at?, eta_seconds?, failure_reason? }`

`state` is `detected` · `confirming` · `bridging` · `credited` · `failed`.
Bridged deposits pass through `bridging`; L1 deposits do not.

### `sera.native_issuance_status`

Issuance state for in-ledger stablecoins.

**Params**
- `symbol` — one symbol, or all when omitted

**Returns**
`{ issuers: [{ symbol, issuer, supply, mint_enabled, redeem_enabled, last_mint_at }] }`

Lets an agent tell "this corridor is quiet" from "this issuer has paused
minting", which otherwise look identical from the quote side.

---

## 3. Receipts

A receipt is what the agent hands to someone else. It has to survive leaving
Sera's context entirely.

### The receipt object

```
{
  receipt_id, account, agent_key, label,
  pair, rate, amount_in, amount_out, fee, fee_asset,
  screening:  { kyt, kya, provider, screened_at },
  settled_at, block, state_root,
  mandate:    { id, version, remaining_after },
  signature:  { scheme, public_key, value }
}
```

`fee_asset` is explicit because the fee comes out of the stablecoin being
swapped — accounting that assumes a separate gas token will mis-book it.
`label` is denormalised from the key so a receipt read years later still says
which agent acted without a lookup against state that may have changed.

### `sera.get_receipt`

**Params** — one of `receipt_id` · `trade_id`
**Returns** — the receipt object

### `sera.verify_receipt`

Check a receipt against the L1 state root.

**Params**
- `receipt` req — the full object, as handed over
- `l1_rpc_url` — an Ethereum RPC the caller trusts
- `trust_sera` — default `false`

**Returns**
`{ valid, checks: { signature, state_root_on_l1, inclusion_proof, fields_match }, checked_against, l1_block }`

This is the tool that has to work without trusting Sera, or it means nothing.
With `trust_sera: false` the check runs against the caller's own L1 RPC and
Sera is not consulted; `trust_sera: true` is a convenience for the account's
own bookkeeping, and the response always records which path ran in
`checked_against`. A counterparty verifying a payment uses the first.

> Blocked on **Q2** and **Q6** — whether inclusion proofs are retrievable
> without the sequencer, and what signs receipts. If proofs need Sera, the
> `inclusion_proof` check degrades to `unavailable` and the tool must say so
> rather than quietly report `valid`.

### `sera.export_receipts`

**Params**
- `account` req
- `from`, `to` req — ISO 8601
- `agent_key` — filter to one key
- `format` — `json` · `csv` · `ap2` (default `json`)

**Returns**
`{ count, from, to, truncated, receipts }` — or, for `ap2`, a proof-of-payment
bundle.

`truncated` rather than silent paging: an audit export that quietly stops short
is worse than one that refuses.

---

## 4. Exit

### `sera.request_forced_withdrawal`

Start a withdrawal from Ethereum, without the sequencer.

**Params**
- `account` req
- `asset` req
- `amount` — default: full balance
- `l1_rpc_url` req

**Returns**
`{ typed_data, l1_contract, claimable_after, balance_source, sequencer_reachable }`

**This tool must construct its transaction from L1 state alone.** It is the one
tool whose whole purpose is to work when Sera does not answer, so it may not
call the Sera API on any path — contract address, ABI and the balance proof all
come from L1 and from data the MCP ships. `balance_source` records where the
balance came from so the caller can see whether the escape hatch actually
cleared the sequencer, and `sequencer_reachable` is reported but never gates
the call.

It should be exposed whether or not anyone calls it. An escape hatch that only
appears during an incident has never been tested.

> Blocked on **Q2** — forced withdrawal and forced inclusion existing in code,
> with a bounded delay. Until then this tool cannot ship, and the non-custodial
> copy on the site stays behind its pre-publish gate.

---

## 5. What changes in the existing 55

Names and signatures hold. Behaviour moves underneath.

| Tool | Change |
|---|---|
| `get_quote` / `prepare_swap` | Adds `screening` (KYT/KYA, bound to the quote) and `mandate_check`. A quote the key could not execute says so at quote time. |
| `execute_swap` | Returns `receipt` inline. Settlement is final on return. |
| `convert_and_send` | Same, plus `destination` is checked against the mandate allowlist. |
| `settlement_status` | Kept for v1 compatibility. On v2 it returns the settled state immediately; nothing to poll. |
| `doctor` | Adds appchain connectivity, account and mandate status, and whether forced withdrawal is reachable from the configured L1 RPC. |
| `get_balances` / `treasury_value` | Read ledger balances. Wallet balances become the L1 funding view. |
| `build_approve` / `build_deposit` / `permit_metadata` | Scoped to the L1 funding leg. Inside Sera there are no approvals and no permits. |
| `pay_invoice` / `find_cheapest_settlement_path` | Route within the ledger first; an L1 or off-ramp hop only when the payee is not on Sera. |
| `place_order` and the maker suite | Unchanged in shape. Mandates apply to agent-signed orders the same way. |

### Policy becomes advisory

`POLICY_MAX_NOTIONAL_USD`, `POLICY_DAILY_VOLUME_CAP_USD`,
`POLICY_ALLOWED_SYMBOLS` and `POLICY_DRY_RUN` keep working and keep their
meaning as a local seatbelt. They stop being the safety story: a client-side
cap holds only while the agent keeps using this client, and the mandate holds
regardless.

`doctor` should warn when a `POLICY_*` cap is looser than the mandate, since
that reads as protection and provides none.

---

## 6. Errors agents branch on

Mandate rejections need to be distinguishable, or every agent treats them as a
generic failure and retries into the same wall.

| Code | Meaning | Retryable |
|---|---|---|
| `MANDATE_CAP_EXCEEDED` | Over the window cap. Carries `remaining`, `resets_at`. | Smaller amount, or after `resets_at` |
| `MANDATE_PER_TX_EXCEEDED` | Single settlement too large. Carries `per_tx_max`. | Split it |
| `MANDATE_PAIR_NOT_ALLOWED` | Pair not on the allowlist. Carries `pairs`. | No — needs the owner |
| `MANDATE_DESTINATION_NOT_ALLOWED` | Destination not on the allowlist. | No — needs the owner |
| `MANDATE_EXPIRED` | Past `expires_at`. | No — needs the owner |
| `MANDATE_VERSION_STALE` | `replaces` did not match. | Re-read and resubmit |
| `KEY_REVOKED` | Key revoked. | Never |
| `KEY_UNKNOWN` | Not registered on this account. | Never |
| `SCREENING_REJECTED` | KYT/KYA failed. Carries the verdict, not the reasoning. | No |
| `ACCOUNT_NOT_FUNDED` | No ledger balance for the input asset. | After funding |

Two rules. An agent must be able to tell "try smaller" from "give up" without
parsing prose — so every cap error carries the number it breached. And a
rejection must never echo back more of the mandate than the key already knows;
an agent that can enumerate the allowlist by probing has read authority it was
not granted.

---

## 7. Migration

`v1` is mainnet as it works today. `v2` targets the appchain. Both ship from
one package and existing installs do not break.

```
SERA_PROTOCOL_VERSION=v1|v2   # default v1 until launch, v2 for new installs after
SERA_NETWORK=mainnet|testnet  # unchanged; now selects the appchain's networks
SERA_ACCOUNT=sera1q...        # v2 only
SERA_PRIVATE_KEY=...          # v2: this is the agent key
```

- On `v1`, the thirteen new tools are not registered. Hosts see 55 tools.
- On `v2`, all 68 register. `doctor` reports the active version first.
- A `v2` install without `SERA_ACCOUNT` registers the read tools and fails the
  rest with `ACCOUNT_NOT_CONFIGURED` — it should not fall back to `v1`
  silently, because the failure mode is settling on the wrong chain.
- Templates in this repo retarget at launch; `SERA_PROTOCOL_VERSION` is set
  explicitly in each rather than inherited, so a template never changes chain
  because a default moved.

---

## 8. Sequencing

1. **Now.** Version the package. `v2` behind the flag, no behaviour change for
   current installs. Tool schemas and the error taxonomy land first so this
   repo's templates can be written against them before the engine is ready.
2. **Launch.** Appchain testnet and faucet live. `v2` default for new installs.
   `doctor` checks appchain connectivity and mandate status. Account, keys and
   funding groups ship. Templates retargeted.
3. **Launch + 2 weeks.** Managed x402 endpoint on the appchain, receiving-side
   gateway for standard x402 USDC, receipts and `verify_receipt`.
4. **Q1.** Register a Sera scheme and network identifier with the x402
   Foundation, AP2 receipt mapping, flow tagging by agent framework.

`request_forced_withdrawal` is not in a phase. It ships when **Q2** resolves,
and the non-custodial claim on the site is gated on the same answer.

---

## 9. Confirm before this is a spec

The first three are from the launch review and block published copy, not just
code. The rest surfaced while writing this.

1. **Data availability.** On Ethereum, or held by Sera. The non-custodial
   paragraph on agents.sera.cx assumes agents can reconstruct balances without
   us. If that is not true, the copy is wrong and `verify_receipt` cannot do
   its job offline.
2. **Forced withdrawal and forced inclusion exist in code, with a bounded
   delay.** Blocks `request_forced_withdrawal` and the site's non-custodial
   panel.
3. **The chain's public name.** "Sera appchain" is used throughout this
   document and across the site. The page needs the name we will use for the
   next two years.
4. **Are account addresses deterministic from the owner key?** Decides whether
   `create_account` can return an address before registration lands.
5. **Is there an in-flight window between submit and settle?** Decides whether
   `revoke_key` needs `settle_in_flight` at all.
6. **What signs receipts, and how is the key rotated?** A receipt verified
   years later needs the historical key. `signature.scheme` is in the object
   for this reason, but rotation is unspecified.
7. **Cap window semantics.** Rolling or calendar; whose timezone. "Per day"
   is ambiguous enough to cause a real dispute the first time a cap bites.
8. **Who is the fee charged to on an in-ledger transfer** between two Sera
   accounts — payer, payee, or split. Affects `amount_out` and every quote
   that crosses accounts.
9. **x402 network identifier.** Until a Sera scheme is registered, the
   `network` field in x402 payloads stays `base` and means the payer's chain.
   `docs/tutorials/x402-paid-api.html` says so; revisit at phase 4.

---

## 10. Done means

- [ ] 68 tools register on `v2`; 55 on `v1`; `doctor` reports which
- [ ] Every error in §6 is reachable in a test, carrying its documented fields
- [ ] A mandate cannot be widened by a partial `set_mandate`
- [ ] `verify_receipt` passes against a third-party L1 RPC with Sera unreachable
- [ ] `request_forced_withdrawal` builds a valid tx with the Sera API blocked
      at the network level, not merely unused
- [ ] A `v1` install is byte-identical in behaviour after the `v2` release
- [ ] Receipts round-trip through `export_receipts` → `verify_receipt`
- [ ] The three pre-publish gates in `index.html` are cleared or still honest

---

*Questions: partnerships@sera.cx. Engine work:
[`sera-cx/sera-mcp`](https://github.com/sera-cx/sera-mcp). Related:
[`ARCHITECTURE.md`](ARCHITECTURE.md) · [`SECURITY-MODEL.md`](SECURITY-MODEL.md)
· [`README.md`](README.md).*
