# Sera Orderbook Contract v2 Reference (sera-cx/orderbook-contract-v2)

> **This is NOT an extension of the v1 Router/OrderBook/PriceBook contracts** documented in
> `references/smart-contracts.md`. It is a ground-up rewrite with a different trading model:
> off-chain EIP-712 signed orders, matched by a trusted executor, settled non-custodially
> through a `Vault`. There is no `priceIndex`, no `PriceBook`, no NFT orders, and no on-chain
> depth/order-book state in v2 — that whole model belongs to v1.
>
> As of this writing, the GraphQL subgraph and this sample repo's `tutorial/`, `frontend/`,
> and `mcp-server/` code all talk to the **v1** Router (see `smart-contracts.md`). Treat v2 as
> the next-generation contract set — check with the user whether they mean v1 or v2 before
> writing integration code, since the function calls, structs, and even the deposit model are
> completely different.
>
> **These v2 contracts are already deployed and live** (mainnet + Sepolia — see
> [Deployed Addresses](#deployed-addresses) below) and are what Sera's official REST API
> (`references/api-reference.md`), `sera-mcp`, and SeraPay (`references/sera-pay.md`) all build
> on. **For most integration work, prefer the REST API over calling these contracts
> directly** — it handles order matching, EIP-712 payload construction, and routing for you.
> Reach for this file when the user specifically needs raw contract semantics (e.g. auditing,
> direct on-chain calls, or understanding what the API does under the hood).

## Deployed Addresses {#deployed-addresses}

Prefer fetching these live from the API's `GET /config` (see `references/api-reference.md`)
over hardcoding — this table is a convenience snapshot as of the 2026-07-08 docs fetch:

| Contract | Mainnet | Sepolia (testnet) |
|---|---|---|
| Sera | `0xB5C50C5D5f038404F85970b7f5B7259C4AC0E198` | `0x83475A1bD98a8DC2DCd507A747e4DC85da241D6e` |
| Vault | `0xC7d4Fd2638e6630C8C61329878676b88A8A24D43` | `0x3c7945840bAE0d7e7f3824Ebccef1962629250F0` |
| SeraSOR | `0xa7A0cf7cd6f043fCA23f29d8ae5aae6b46e11c18` | `0x83c1368110B640A729f3810De5FBe94b99aa5668` |
| SeraBatcher | `0x1f4b366f4145A92978df4bEeb6BdE71bC652F034` | `0x29F99C5dc36D555933700BE3dffEa6e721a27f0a` |

**Repo**: https://github.com/sera-cx/orderbook-contract-v2
**License**: PolyForm Noncommercial 1.0.0 — source-available, NOT an OSI-approved open source
license (commercial use requires a separate license from Working Ants Inc.). Don't call this
repo "open source" in user-facing text.
**Audit**: CertiK, final report dated 2026-04-30, scope = all first-party `src/` contracts.
**Solidity**: 0.8.24, built with Foundry (`forge build` / `forge test` / `forge coverage`).

## Table of Contents
1. [Architecture](#architecture)
2. [Core Contracts](#contracts)
3. [Order & Match Data Structures](#structs)
4. [Matching: Sera.matchOrders](#matching)
5. [Batch Execution: SeraBatcher](#batcher)
6. [Smart Order Router: SeraSOR](#sor)
7. [Vault Custody](#vault)
8. [Withdrawals](#withdrawals)
9. [Fees & Slippage Sharing](#fees)
10. [Deployment & Governance](#deployment)

---

## Architecture {#architecture}

Sera v2 pairs an off-chain executor with on-chain settlement: the executor does order matching
and routing off-chain (cheap, fast), then submits the result on-chain where custody and
settlement are enforced non-custodially.

```
User Wallet --sign EIP-712 order/intent--> Application --submit--> Executor (off-chain matching)
                                                                        |
                                                                        v
                                                        Sera.sol (matchOrders) / SeraBatcher.sol / SeraSOR.sol
                                                                        |
                                                                        v
                                                                    Vault.sol (custody)
```

- **Executor role**: an `EXECUTOR_ROLE`-gated address (or set of addresses) that submits
  matched orders. Users never call `matchOrders` themselves — they sign an `Order` or
  `IntentParams` struct off-chain and hand it to the executor/application.
- **Non-custodial settlement**: funds live in `Vault.sol` under per-user balances. The executor
  can only move funds according to what users signed (order price/amount bounds); it cannot
  invent trades.
- **Contract execution environments** — the executor picks the wrapper based on the action:

| Action | Entry point |
|---|---|
| 1:1 atomic match | `Sera.matchOrders()` |
| Best-effort batch (continue on failure) | `SeraBatcher.batchMatchOrders()` |
| Fill-or-kill atomic batch | `SeraBatcher.batchMatchOrdersAtomic()` |
| Mixed atomic batches + singles + SOR | `SeraBatcher.batchMatchMixed()` |
| Multi-leg route (single taker signature) | `SeraSOR.executeIntent()` |

## Core Contracts {#contracts}

| Contract | Purpose |
|---|---|
| `Sera.sol` | Core engine — deposits, matching (`matchOrders`), withdrawals (delayed + instant dual-sig), routed-leg settlement (`settleRoutedLeg`, called only by the trusted router) |
| `SeraAdmin.sol` | Abstract admin base: treasury, token whitelist, slippage-share config, pause, rescue |
| `SeraLib.sol` | Shared structs (`Order`, `MatchData`, `WithdrawIntent`, `IntentParams`), EIP-712 typehashes, pure math (`_executionValues`) |
| `SeraBase.sol` | Abstract base for wrapper contracts — caches `EXECUTOR_ROLE` as `immutable` (~2100 gas/call saved) |
| `SeraBatcher.sol` | Unified batch wrapper: best-effort, FOK, and mixed-mode batching. `VERSION = 2` |
| `SeraSOR.sol` | Smart Order Router — multi-leg atomic routing with transient (in-memory) balance optimization |
| `Vault.sol` | Asset custody — per-user, per-token balances; blacklist; ledger transfers that skip physical ERC20 moves |
| `interface/IVault.sol` | Vault interface |

**Known limitations** (do not whitelist these token types):
- Fee-on-transfer tokens — Vault credits the requested amount directly, no balance-delta check.
- Rebasing/elastic-supply tokens (stETH, AMPL, etc.) — Vault's `trackedBalance` would diverge
  from the physical balance, risking trapped yield or insolvency.

## Order & Match Data Structures {#structs}

```solidity
struct Order {
    address user;
    uint48 expiration;
    uint48 feeBps;                 // out of BPS_DENOMINATOR = 1e14 (sub-basis-point precision)
    address recipient;             // address(0) = internal ledger credit; otherwise physical payout target
    address fromToken;
    address toToken;
    uint256 fromAmount;
    uint256 toAmount;
    uint256 initialDepositAmount;  // signed wallet-pull amount for SOR wallet funding
    uint256 uuid;                  // replay-protection nonce
}

struct MatchData {
    Order order0;
    bytes signature0;
    uint256 matchAmount0;   // amount of order0.fromToken to fill this call
    Order order1;
    bytes signature1;
    uint256 matchAmount1;   // amount of order1.fromToken to fill this call
}

struct IntentParams {          // SOR parameters (misleadingly named "Intent" for legacy reasons)
    address taker;
    address inputToken;
    address outputToken;
    uint256 maxInputAmount;    // taker-signed spending cap across all legs
    uint256 minOutputAmount;   // taker-signed output floor across all legs
    address recipient;         // signed — every terminal leg must pay out here (diamond-safe)
    uint256 initialDepositAmount; // signed — exact wallet-pull amount, executor cannot alter it
    uint256 uuid;
    uint48 deadline;
}

struct WithdrawIntent {        // instant dual-sig withdrawal, up to 20 tokens per call
    address user;
    address[] tokens;
    uint256[] amounts;
    address recipient;
    uint256 deadline;
    uint256 uuid;
}
```

**EIP-712 domain**: `name = "Sera"`, `version = "1"` (domain version; unrelated to contract
`VERSION`). Typehashes: `ORDER_TYPEHASH`, `INTENT_TYPEHASH`, `WITHDRAW_INTENT_TYPEHASH` — all
defined in `SeraLib.sol`. Signatures accept both 65-byte (r,s,v) and 64-byte EIP-2098 compact
form, and are verified via OpenZeppelin `SignatureChecker` — so EOAs, EIP-1271 smart-contract
wallets (Safe, Argent, ERC-4337), and EIP-7702-delegated EOAs are all valid signers for makers,
takers, and instant-withdraw dual signatures.

`BPS_DENOMINATOR = 100_000_000_000_000` (1e14) — large enough that `feeBps = 1` on a $1M order
still resolves to $0.01, all within a packed `uint48`.

## Matching: Sera.matchOrders {#matching}

```solidity
function matchOrders(MatchData calldata _match, uint256 deadline) external onlyRole(EXECUTOR_ROLE);
```

Only an `EXECUTOR_ROLE` holder may call this. It:
1. Validates token symmetry (`order0.fromToken == order1.toToken` and vice versa) and rejects
   same-token pairs (`SameTokenMatch` — this exists specifically to stop withdrawal-like
   settlement from bypassing the 24h delayed-withdrawal path).
2. Verifies both orders' EIP-712 signatures (skipped on partial re-fills — the `orderHash` is
   immutable once first verified, so subsequent partial fills don't re-check the signature).
3. Checks live Vault balance for each maker (`InsufficientVaultBalance` guards against "ghost
   liquidity" — an order signed against funds that were withdrawn after signing).
4. Computes fees (per-order `feeBps`) and spread distribution (`SlippageShare`: maker / taker /
   protocol split), then settles via `Vault.transferLedger` (same-Vault internal swap, no
   physical ERC20 move) or `Vault.withdraw` (physical payout when `order.recipient != 0`).

Partial fills are tracked in `filledAmount[orderHash]`; `OrderFullyFilled` fires once a side is
exhausted.

## Batch Execution: SeraBatcher {#batcher}

```solidity
function batchMatchOrders(MatchData[] calldata _matches, uint256 deadline)
    external returns (uint256 failedMask);          // continue-on-error, max 20 pairs

function batchMatchOrdersAtomic(MatchData[] calldata _matches, uint256 deadline)
    external;                                        // all-or-nothing, max 20 pairs

function batchMatchMixed(
    AtomicBatch[] calldata _atomicBatches,   // FOK sub-batches
    MatchData[] calldata _singleMatches,     // independent, continue-on-error
    IntentExecution[] calldata _intents,     // SOR executions, always continue-on-error
    uint256 deadline
) external returns (uint256 failedMask);
```

`failedMask` is a bitmask — bit `i` set means item `i` failed. `batchMatchOrders` and the
`_singleMatches`/`_intents` legs of `batchMatchMixed` use try/catch so one bad order doesn't
revert the whole batch; `batchMatchOrdersAtomic` and each `AtomicBatch` sub-batch are
all-or-nothing. SOR executions are always try-catch because each SOR intent is independently
atomic — there's no cross-intent dependency to protect.

## Smart Order Router: SeraSOR {#sor}

```solidity
function executeIntent(
    MatchData[] calldata matches,       // route legs: order0 = taker leg, order1 = maker
    bytes calldata intentSignature,     // single taker EIP-712 signature over the whole route
    IntentParams calldata intent,
    uint8 uniqueTokenCount,             // sizing hint for the in-memory transient-balance table
    uint256 permitDeadline,
    bytes calldata permitSignature
) external onlyRole(EXECUTOR_ROLE);     // max 20 legs (MAX_ROUTE_LEGS)
```

The taker signs **one** `IntentParams` struct covering the whole multi-hop trade
(`inputToken → outputToken`, spend cap, output floor, recipient, wallet-pull amount) — the
executor is then free to construct the optimal route (which intermediate tokens/legs to use) at
execution time, fixing the TOCTOU problem of "route calculated off-chain may be stale by
execution time."

Key mechanics:
- **Transient balances**: intermediate-leg tokens are tracked in an in-memory open-addressing
  hash table (not `TSTORE`, since it's cheaper to just keep it in calldata-derived memory for
  the duration of the call) — this avoids round-tripping intermediate hops through the Vault.
- **Signed guardrails**: `recipient`, `initialDepositAmount`, and `taker` are all inside the
  signed struct, so the executor cannot redirect output, alter how much is pulled from the
  taker's wallet, or spoof identity — even in "diamond" topologies where multiple legs converge.
- **Conservation enforcement**: at the end of the call, every transient-balance slot must be
  zero or the whole transaction reverts with `TransientBalanceNotZero` — a stray leftover token
  from a miscalibrated route can't silently strand funds.
- **Envelope guards**: `maxInputAmount` / `minOutputAmount` bound total spend/output across all
  legs, independent of how the executor split the route.

## Vault Custody {#vault}

```solidity
function deposit(address user, address token, uint256 amount) external;          // TRADER_ROLE only
function withdraw(address user, address token, uint256 amount, address to) external; // TRADER_ROLE only
function transferLedger(address fromUser, address toUser, address token, uint256 amount) external; // internal swap, no ERC20 move
function creditLedger(address user, address token, uint256 expectedAmount) external; // caller MUST have already transferred tokens in-tx
function balanceOf(address token, address user) external view returns (uint256);
function balanceOf(address token) external view returns (uint256);               // total vault holdings of a token
function isBlacklisted(address user) external view returns (bool);
```

`TRADER_ROLE` is granted to `Sera.sol` by default. All Vault mutation functions are
`TRADER_ROLE`-gated — end users never call the Vault directly; they call `Sera.depositFund()`
or `Sera.depositFundWithPermit()`, which forward to the Vault.

```solidity
// Sera.sol — user-facing deposit entry points
function depositFund(address token, address owner, uint256 value) external;
function depositFundWithPermit(
    address token, address owner,
    uint256 permitAmount, uint256 depositAmount,   // deposit can be <= permit amount, avoids dust
    uint256 deadline, bytes calldata sig            // 65-byte or 64-byte EIP-2098 compact
) external;
```

`depositFundWithPermit` checks existing allowance before calling `permit()`, which neutralizes a
griefing attack where someone front-runs the permit nonce.

## Withdrawals {#withdrawals}

Two independent paths — pick based on whether the user needs funds instantly or can wait:

### Delayed (user-initiated, no counterparty needed)

```solidity
function emergencyWithdraw(address token, uint256 amount) external;
```

Same function serves both steps:
1. **First call** (no pending request, or a prior one expired): records `{requestBlock, amount}`
   and returns — this starts the clock. Reverts if the user's live Vault balance is already
   below `amount` (prevents gaming the cooldown with funds you don't have).
2. **Second call**, ≥ `WITHDRAW_DELAY_BLOCKS` (7200 blocks, ~24h) after the first: pays out.
   Must be called within `WITHDRAW_EXPIRATION_BLOCKS` (14400 blocks, ~48h) of the request or it
   resets and step 1 runs again.

Available even to frozen/blacklisted users — the frozen-user policy stops trading and deposits,
not withdrawal.

### Instant (dual-signature)

```solidity
function executeInstantWithdrawDualSig(
    WithdrawIntent calldata intent,     // up to 20 tokens in one call
    bytes calldata userSignature,
    address executor,
    bytes calldata executorSignature
) external;
```

Requires **both** the user's EIP-712 signature over the `WithdrawIntent` and a matching
signature from an `EXECUTOR_ROLE` holder over the same struct — anyone can submit the
transaction once both signatures exist. This is the path an application uses to give users
"instant" withdrawal UX without waiting 24h, at the cost of needing executor cosigning.

## Fees & Slippage Sharing {#fees}

- Each `Order.feeBps` is set by the signer (out of `BPS_DENOMINATOR = 1e14`), so different
  makers/takers can be quoted different fees.
- Beyond the fee, any price improvement ("spread" — taker offered more than maker required) is
  split via a governance-configured `SlippageShare { makerShareBps, takerShareBps,
  protocolShareBps, totalBps }`. Default at deploy: 100% to protocol.
- The maker/taker split is delivered as an **implicit rebate** (adjusting the settlement payout
  math) rather than an extra token transfer — cheaper gas, same economic effect.

## Deployment & Governance {#deployment}

```bash
forge build
forge test
forge coverage

# Local anvil
forge script script/DeployLocal.s.sol:DeployLocal --rpc-url $LOCAL_RPC_URL --broadcast

# Sepolia (verified)
forge script script/DeploySepolia.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify

# Mainnet — transfers DEFAULT_ADMIN_ROLE to TIMELOCK_ADDRESS and renounces deployer admin
forge script script/Deploy.s.sol:DeployScript --rpc-url $MAINNET_RPC_URL --broadcast --verify
```

`Deploy.s.sol` requires `TIMELOCK_ADDRESS` to already point at deployed bytecode (the repo
vendors the original Compound/Uniswap `Timelock.sol` under `vendor/compound-timelock/`, compiled
at its native Solidity 0.5.16 so the bytecode matches known-audited deployments) — it reverts if
unset, so governance can never end up orphaned mid-deploy.

**Env vars** (`.env.example`):
```bash
PRIVATE_KEY=0x0                # deployer EOA
TIMELOCK_ADDRESS=0x0
MAINNET_RPC_URL=...
SEPOLIA_RPC_URL=...
ARBITRUM_SEPOLIA_RPC_URL=...
ETHERSCAN_API_KEY=...
VAULT_ADDRESS=0x0              # populated after deploy
SERA_ADDRESS=0x0
SOR_ADDRESS=0x0
BATCHER_ADDRESS=0x0
```

**Third-party licenses** (unchanged, permissive): OpenZeppelin Contracts (MIT), OpenZeppelin
Contracts Upgradeable (MIT), Solady (MIT), Forge Standard Library (MIT/Apache-2.0), Compound
Timelock (BSD-3-Clause). Everything else in the repo is PolyForm Noncommercial 1.0.0 — if
redistributing, the notice "Copyright 2025 Working Ants Inc. (Panama)" must be propagated
verbatim along with the LICENSE file.
