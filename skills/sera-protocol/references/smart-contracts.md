# Sera Protocol Smart Contract Reference (v1 — deployed, price-level CLOB)

> This file documents the **v1** Router/OrderBook/PriceBook contracts — the price-level CLOB
> (`priceIndex`, NFT orders, `limitBid`/`limitAsk`) that the GraphQL subgraph and this sample
> repo's `tutorial/`, `frontend/`, and `mcp-server/` all actually integrate against today.
>
> `sera-cx/orderbook-contract-v2` is a **separate, non-compatible** architecture (off-chain
> signed orders + Vault custody + Smart Order Router) — see `references/orderbook-v2.md`.
> Confirm which version the user means before reusing structs/function names across the two.

## Table of Contents
1. [Contract Addresses](#addresses)
2. [Router Contract](#router)
3. [OrderBook Contract](#orderbook)
4. [PriceBook Contract](#pricebook)
5. [Order Canceller](#canceller)
6. [ERC20 Token Interactions](#erc20)
7. [Transaction Patterns](#patterns)
8. [ABI Snippets](#abis)

---

## Contract Addresses (Sepolia Testnet) {#addresses}

| Contract | Address |
|---|---|
| Router | `0x82bfe1b31b6c1c3d201a0256416a18d93331d99e` |
| Market Factory | `0xe54648526027e236604f0d91413a6aad3a80c01e` |
| Order Canceller | `0x53ad1ffcd7afb1b14c5f18be8f256606efb11b1b` |
| Default Market (TWETH/TUSDC) | `0x002930b390ac7d686f07cffb9d7ce39609d082d1` |
| EURC/XSGD Market | `0x2e4a11c7711c6a69ac973cbc40a9b16d14f9aa7e` |

**Network**: Ethereum Sepolia (Chain ID: 11155111)
**Default RPC**: `https://0xrpc.io/sep`
**Block Explorer**: `https://sepolia.etherscan.io`

---

## Router Contract {#router}

The Router is the primary entry point for all trading operations.

### Limit Order Functions

```solidity
function limitBid(LimitOrderParams calldata params) external payable returns (uint256 orderIndex)
function limitAsk(LimitOrderParams calldata params) external payable returns (uint256 orderIndex)
```

**LimitOrderParams struct**:
```solidity
struct LimitOrderParams {
    address market;       // OrderBook contract address
    uint64 deadline;      // Unix timestamp — tx reverts after this time
    address user;         // Who receives the proceeds
    uint16 priceIndex;    // Price level (0–65535)
    uint64 rawAmount;     // Quote token amount (for bids)
    bool postOnly;        // true = revert if order would fill immediately
    bool useNative;       // true = use native ETH instead of WETH
    uint256 baseAmount;   // Base token amount (for asks)
}
```

**Bid vs Ask**:
- `limitBid`: Set `rawAmount` (quote tokens to spend), `baseAmount = 0`
- `limitAsk`: Set `baseAmount` (base tokens to sell), `rawAmount = 0`

### Market Order Functions

```solidity
function marketBid(MarketOrderParams calldata params) external payable
function marketAsk(MarketOrderParams calldata params) external payable
```

**MarketOrderParams struct**:
```solidity
struct MarketOrderParams {
    address market;
    uint64 deadline;
    address user;
    uint16 limitPriceIndex;  // Worst acceptable price
    uint64 rawAmount;        // Quote token amount
    bool expendInput;        // true = spend all input; false = receive minimum output
    bool useNative;
    uint256 baseAmount;      // Base token amount
}
```

### Claim Function

```solidity
function claim(uint64 deadline, ClaimOrderParams[] calldata paramsList) external
```

**ClaimOrderParams struct**:
```solidity
struct ClaimOrderParams {
    address market;
    OrderKey[] orderKeys;
}

struct OrderKey {
    uint16 priceIndex;
    uint256 orderIndex;
    bool isBid;
}
```

### Combined Operations (Claim + Order in One TX)

```solidity
function limitBidAfterClaim(LimitOrderParams calldata, ClaimOrderParams[] calldata) external payable
function limitAskAfterClaim(LimitOrderParams calldata, ClaimOrderParams[] calldata) external payable
function marketBidAfterClaim(MarketOrderParams calldata, ClaimOrderParams[] calldata) external payable
function marketAskAfterClaim(MarketOrderParams calldata, ClaimOrderParams[] calldata) external payable
```

### Batch Limit Orders

```solidity
function limitOrder(
    GeneralLimitOrderParams[] calldata orderParamsList,
    ClaimOrderParams[] calldata claimParamsList
) external payable returns (uint256[] memory orderIndexList)
```

### View Function

```solidity
function isRegisteredMarket(address market) external view returns (bool)
```

---

## OrderBook Contract {#orderbook}

Each market has its own OrderBook contract instance.

### Key View Functions

| Function | Signature | Returns |
|---|---|---|
| Get depth at price | `getDepth(bool isBid, uint16 priceIndex)` | `uint64` raw amount |
| Best price | `bestPriceIndex(bool isBid)` | `uint16` (reverts if empty) |
| Check if empty | `isEmpty(bool isBid)` | `bool` |
| Get order | `getOrder(OrderKey memory key)` | `Order { uint64 amount, address owner }` |
| Claimable info | `getClaimable(OrderKey memory key)` | `(uint64 claimableRawAmount, uint256 claimableAmount, uint256 claimFee, uint256 claimableBaseAmount)` |
| Expected fill | `getExpectedAmount(uint16 limitPriceIndex, uint64 rawAmount, uint256 baseAmount, uint8 options)` | `(uint256, uint256)` |

**getExpectedAmount options byte**: bit 0 = direction (0=Ask, 1=Bid), bit 1 = expendInput mode

### Market Info Functions

| Function | Returns |
|---|---|
| `quoteToken()` | `address` |
| `baseToken()` | `address` |
| `quoteUnit()` | `uint256` |
| `makerFee()` | `int24` (negative = rebate) |
| `takerFee()` | `uint24` |
| `orderToken()` | `address` (NFT contract) |
| `priceBook()` | `address` |

### Conversion Functions

```solidity
function rawToQuote(uint64 rawAmount) external view returns (uint256)
function quoteToRaw(uint256 quoteAmount, bool roundingUp) external view returns (uint64)
function rawToBase(uint64 rawAmount, uint16 priceIndex, bool roundingUp) external view returns (uint256)
function baseToRaw(uint256 baseAmount, uint16 priceIndex, bool roundingUp) external view returns (uint64)
function indexToPrice(uint16 priceIndex) external view returns (uint256)
function priceToIndex(uint256 price, bool roundingUp) external view returns (uint16 index, uint256 correctedPrice)
```

---

## PriceBook Contract {#pricebook}

```solidity
function indexToPrice(uint16 priceIndex) external view returns (uint256)
function priceToIndex(uint256 price, bool roundingUp) external view returns (uint16 index, uint256 correctedPrice)
function maxPriceIndex() external view returns (uint16)       // Always 65535
function priceUpperBound() external view returns (uint256)    // minPrice + 65535 * tickSpace
function minPrice() external view returns (uint128)
function tickSpace() external view returns (uint128)
```

**Error**: `INVALID_PRICE` — when price < minPrice, > priceUpperBound, or rounding exceeds maxPriceIndex.

---

## Order Canceller {#canceller}

Address: `0x53ad1ffcd7afb1b14c5f18be8f256606efb11b1b`

```solidity
function cancel(CancelParams[] calldata params) external
function cancelTo(CancelParams[] calldata params, address to) external
```

Orders are NFTs — cancellation works through the order token contract. The canceller burns the NFT and returns remaining funds.

---

## ERC20 Token Interactions {#erc20}

### Approval (Required before placing orders)

```typescript
// Check current allowance
const allowance = await publicClient.readContract({
  address: tokenAddress,
  abi: ERC20_ABI,
  functionName: "allowance",
  args: [userAddress, ROUTER_ADDRESS],
});

// Approve if insufficient
if (allowance < requiredAmount) {
  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ROUTER_ADDRESS, requiredAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}
```

### Required Approval Amount

For bids: `approvalAmount = rawAmount * quoteUnit`
For asks: `approvalAmount = baseAmount` (in base token units)

### ERC20 ABI (minimal)

```json
[
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
]
```

---

## Transaction Patterns {#patterns}

### Standard: Simulate → Send → Wait

```typescript
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });

// Step 1: Simulate (catch reverts before spending gas)
const { request } = await publicClient.simulateContract({
  address: ROUTER_ADDRESS,
  abi: ROUTER_ABI,
  functionName: "limitBid",
  args: [{
    market: MARKET_ADDRESS,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    user: account.address,
    priceIndex: 12000,
    rawAmount: BigInt(1000),
    postOnly: true,
    useNative: false,
    baseAmount: BigInt(0),
  }],
  account,
});

// Step 2: Send
const txHash = await walletClient.writeContract(request);

// Step 3: Wait
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log("Confirmed in block:", receipt.blockNumber);
```

### Claim Pattern

```typescript
const claimParams = [{
  market: MARKET_ADDRESS,
  orderKeys: [{
    isBid: true,
    priceIndex: 12000,
    orderIndex: BigInt(orderIndex),
  }],
}];

const { request } = await publicClient.simulateContract({
  address: ROUTER_ADDRESS,
  abi: ROUTER_ABI,
  functionName: "claim",
  args: [BigInt(Math.floor(Date.now() / 1000) + 3600), claimParams],
  account,
});

const txHash = await walletClient.writeContract(request);
await publicClient.waitForTransactionReceipt({ hash: txHash });
```

### Gas Recommendations

| Operation | Gas Limit |
|---|---|
| Token Approval | ~100,000 |
| Limit Order | ~500,000 |
| Claim | ~300,000 |
| Market Order | ~500,000 |

Recommended: Use 1.2x current gas price for faster inclusion.

---

## ABI Snippets {#abis}

### Router ABI (Key Functions)

```json
[
  {
    "type": "function",
    "name": "limitBid",
    "inputs": [{"name": "params", "type": "tuple", "components": [
      {"name": "market", "type": "address"},
      {"name": "deadline", "type": "uint64"},
      {"name": "claimBounty", "type": "uint32"},
      {"name": "user", "type": "address"},
      {"name": "priceIndex", "type": "uint16"},
      {"name": "rawAmount", "type": "uint64"},
      {"name": "postOnly", "type": "bool"},
      {"name": "useNative", "type": "bool"},
      {"name": "baseAmount", "type": "uint256"}
    ]}],
    "outputs": [{"type": "uint256"}],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "limitAsk",
    "inputs": [{"name": "params", "type": "tuple", "components": [
      {"name": "market", "type": "address"},
      {"name": "deadline", "type": "uint64"},
      {"name": "claimBounty", "type": "uint32"},
      {"name": "user", "type": "address"},
      {"name": "priceIndex", "type": "uint16"},
      {"name": "rawAmount", "type": "uint64"},
      {"name": "postOnly", "type": "bool"},
      {"name": "useNative", "type": "bool"},
      {"name": "baseAmount", "type": "uint256"}
    ]}],
    "outputs": [{"type": "uint256"}],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "claim",
    "inputs": [
      {"name": "deadline", "type": "uint64"},
      {"name": "paramsList", "type": "tuple[]", "components": [
        {"name": "market", "type": "address"},
        {"name": "orderKeys", "type": "tuple[]", "components": [
          {"name": "isBid", "type": "bool"},
          {"name": "priceIndex", "type": "uint16"},
          {"name": "orderIndex", "type": "uint256"}
        ]}
      ]}
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
]
```
