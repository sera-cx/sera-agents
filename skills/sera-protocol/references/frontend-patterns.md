# Sera Protocol Frontend Development Patterns

## Table of Contents
1. [Architecture Overview](#architecture)
2. [Tech Stack](#stack)
3. [Hook Architecture](#hooks)
4. [Wallet Connection](#wallet)
5. [Page Structure](#pages)
6. [Error Handling](#errors)
7. [Setup Guide](#setup)

---

## Architecture Overview {#architecture}

The frontend is a React 19 + TypeScript + Vite application at `frontend/`. It uses:
- **Custom hooks** for all blockchain/subgraph interactions
- **Reown AppKit** (formerly WalletConnect v3) for wallet connection
- **ethers.js v6** for contract interactions
- **Zustand** for wallet state management
- **Tailwind CSS v4** for styling
- **React Router v7** for navigation

```
frontend/src/
├── pages/
│   ├── DashboardPage.tsx    # Market overview
│   ├── TradingPage.tsx      # Order placement
│   └── MyOrdersPage.tsx     # Order monitoring + claiming
├── hooks/
│   ├── useMarket.ts         # Market info (GraphQL)
│   ├── useOrders.ts         # User orders (GraphQL)
│   ├── useDepths.ts         # Order book depth (GraphQL)
│   ├── usePlaceOrder.ts     # Place limit orders
│   ├── useClaim.ts          # Claim filled orders
│   ├── useTokenApproval.ts  # ERC20 approve flow
│   ├── useTokenBalance.ts   # Token balance checking
│   └── useWallet.ts         # Wallet connection state
├── lib/
│   └── subgraph.ts          # Generic GraphQL query function
├── store/
│   └── walletStore.ts       # Zustand wallet state
├── App.tsx
└── main.tsx
```

---

## Tech Stack {#stack}

```json
{
  "@reown/appkit": "^1.8.19",
  "@reown/appkit-adapter-ethers": "^1.8.19",
  "ethers": "^6.16.0",
  "react": "^19.2.0",
  "react-dom": "^19.2.0",
  "react-router": "^7.13.1",
  "zustand": "^5.0.11",
  "tailwindcss": "^4.2.1"
}
```

---

## Hook Architecture {#hooks}

### useMarket — Fetch Market Info

```typescript
// Queries the subgraph for market details
// Returns: { market, loading, error, refetch }
const { market, loading } = useMarket(marketAddress);
// market: { id, quoteToken, baseToken, quoteUnit, minPrice, tickSpace, latestPrice, ... }
```

### useDepths — Fetch Order Book

```typescript
// Returns bid/ask depth levels from subgraph
// Returns: { bids, asks, loading, error, refetch }
const { bids, asks } = useDepths(marketAddress);
// bids: [{ priceIndex, price, rawAmount }] — sorted desc (best first)
// asks: [{ priceIndex, price, rawAmount }] — sorted asc (best first)
```

### useOrders — Fetch User Orders

```typescript
// Queries user's orders for a specific market
// Returns: { orders, loading, error, refetch }
const { orders } = useOrders(userAddress, marketAddress);
// orders: [{ id, priceIndex, orderIndex, isBid, rawAmount, rawFilledAmount, claimableAmount, status }]
```

### useTokenBalance — Check Balance

```typescript
// Reads ERC20 balance for connected wallet
const { balance, loading, refetch } = useTokenBalance(tokenAddress);
```

### useTokenApproval — Approve Token Spending

```typescript
// Manages ERC20 approval flow
const { approve, loading, error } = useTokenApproval();
// approve(tokenAddress, spenderAddress, amount)
```

### usePlaceOrder — Submit Limit Orders

```typescript
const { placeOrder, loading, error, txHash } = usePlaceOrder();

// Place a bid
await placeOrder({
  market: marketAddress,
  priceIndex: 12000,
  rawAmount: BigInt(1000),
  isBid: true,
  postOnly: true,
});
```

**Error handling** in usePlaceOrder is detailed — it parses contract reverts, nonce issues, gas problems, and user rejections into human-readable messages. See the Error Handling section below.

### useClaim — Claim Filled Orders

```typescript
const { claim, loading, error, txHash } = useClaim();

await claim({
  market: marketAddress,
  orderKeys: [{
    isBid: true,
    priceIndex: 12000,
    orderIndex: BigInt(0),
  }],
});
```

### useWallet — Wallet Connection State

```typescript
const { address, isConnected, chainId } = useWallet();
```

Uses Reown AppKit + Zustand under the hood. Wallet state is global and persisted.

---

## Wallet Connection {#wallet}

### Reown AppKit Setup

```typescript
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { sepolia } from "@reown/appkit/networks";

const appKit = createAppKit({
  adapters: [new EthersAdapter()],
  networks: [sepolia],
  projectId: import.meta.env.VITE_REOWN_PROJECT_ID,
  metadata: {
    name: "Sera Protocol Sample",
    description: "...",
    url: "...",
    icons: ["..."],
  },
});
```

**Environment variable**: `VITE_REOWN_PROJECT_ID` — get from https://cloud.reown.com/

### Getting Provider/Signer

```typescript
// From Reown AppKit, get the ethers BrowserProvider
const provider = new ethers.BrowserProvider(appKit.getWalletProvider());
const signer = await provider.getSigner();
```

---

## Page Structure {#pages}

### DashboardPage
- Displays market overview: latest price, token pair, trading volume
- Uses `useMarket` to fetch market data
- Entry point for navigating to trading

### TradingPage
- Order placement form (price, amount, buy/sell)
- Live order book display (bids/asks)
- Token balance display
- Approval button (if needed)
- Uses `useMarket`, `useDepths`, `useTokenBalance`, `useTokenApproval`, `usePlaceOrder`

### MyOrdersPage
- Table of user's orders with status
- Claim button for filled orders
- Auto-refresh via polling
- Uses `useOrders`, `useClaim`

---

## Error Handling {#errors}

The frontend has detailed error parsing in `usePlaceOrder.ts`. Here's the pattern:

```typescript
try {
  // ... place order
} catch (err: unknown) {
  if (err instanceof Error) {
    const message = err.message;

    // Contract revert
    if (message.includes("execution reverted")) {
      // Extract revert reason
      const reason = extractRevertReason(message);
      setError(`Transaction reverted: ${reason}`);
    }
    // User rejected in wallet
    else if (message.includes("user rejected") || message.includes("ACTION_REJECTED")) {
      setError("Transaction rejected by user");
    }
    // Nonce issues
    else if (message.includes("nonce")) {
      setError("Nonce conflict — please wait for pending transactions");
    }
    // Gas estimation failed
    else if (message.includes("gas")) {
      setError("Gas estimation failed — check your balance and parameters");
    }
    else {
      setError(message);
    }
  }
}
```

---

## Setup Guide {#setup}

```bash
cd frontend

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env:
#   VITE_REOWN_PROJECT_ID=your_project_id

# Start dev server
npm run dev
# Opens at http://localhost:5173
```

### Build for Production

```bash
npm run build
# Output in frontend/dist/
```
