# Sera Protocol MCP Server Reference

This file covers **two distinct MCP servers** for Sera Protocol:

1. **Official `sera-mcp`** (`sera-cx/sera-mcp`) — production-grade, for AI agents
2. **Local sample `mcp-server/`** — 8 tools, demo/learning code inside `SeraProtocol-Sample/`

---

## Part 1: Official Sera MCP (sera-cx/sera-mcp)

### Overview

`sera-mcp` is the production-grade MCP server published by Sera Protocol. It connects any MCP-compatible AI agent to Sera's stablecoin FX rails.

**Repo**: https://github.com/sera-cx/sera-mcp
**Architecture docs**: https://deepwiki.com/sera-cx/sera-mcp

| Property | Value |
|---|---|
| Tools | See the current [tool catalog in the sera-mcp README](https://github.com/sera-cx/sera-mcp#readme) |
| Transports | stdio (local), Streamable HTTP (remote) |
| Node version | 18.17+ |
| Security | Policy engine + EIP-712 quote-sign-execute |

### Installation

```bash
git clone https://github.com/sera-cx/sera-mcp
cd sera-mcp
npm install
npm run build
```

### Integration Methods

**Claude Code (one-liner):**
```bash
claude mcp add sera --scope user \
  --env SERA_NETWORK=mainnet \
  --env POLICY_PRESET=standard \
  -- node /path/to/sera-mcp/dist/index.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "sera": {
      "command": "node",
      "args": ["/path/to/sera-mcp/dist/index.js"],
      "env": {
        "SERA_NETWORK": "mainnet",
        "POLICY_PRESET": "standard"
      }
    }
  }
}
```

**Cursor**: Settings → MCP → Add stdio server → point to `dist/index.js`

**HTTP remote**:
```bash
node dist/index.js --transport http --port 3848
# Endpoint: POST http://localhost:3848/mcp
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SERA_NETWORK` | `mainnet` | `mainnet` → api.sera.cx; `sepolia` → api-testnet.sera.cx |
| `SERA_SIGNER_MODE` | `external` | `external` (no key), `local` (holds private key), `readonly` |
| `POLICY_PRESET` | `standard` | `starter`, `standard`, `sg-retail`, or `open` |
| `POLICY_DRY_RUN` | `false` | Block all execution calls when `true` |
| `SERA_ENABLE_EXECUTION_TOOLS` | `true` | Hide `execute_swap`/`convert_and_send` when `false` |
| `SERA_HISTORY_DB` | — | Path to SQLite log for history tools |
| `SERA_API_KEY` | — | Required for treasury & settlement tools |
| `SERA_API_SECRET` | — | Required for treasury & settlement tools |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `POLICY_MAX_NOTIONAL_USD` | preset | Override per-tx cap |
| `POLICY_DAILY_VOLUME_USD` | preset | Override daily volume cap |
| `POLICY_MAX_SLIPPAGE_BPS` | preset | Override slippage tolerance |

### Policy Presets

| Preset | Symbols | Per-Tx Cap | Daily Cap | Slippage |
|---|---|---|---|---|
| `starter` | USDC, USDT | $1,000 | $5,000 | 25 bps |
| `standard` | USDC, USDT, XSGD, JPYC, MYRT, TGBP, EURC | $5,000 | $50,000 | 10 bps |
| `sg-retail` | USDC, USDT, XSGD | $2,000 | $10,000 | 15 bps |
| `open` | All | Uncapped | Uncapped | Uncapped |

### Signing Modes

| Mode | Key Required | Use Case |
|---|---|---|
| `external` | No | Production — returns unsigned tx for wallet to sign |
| `local` | Yes (`SERA_PRIVATE_KEY`) | Automated agents — server signs and broadcasts |
| `readonly` | No | Price queries and monitoring only |

### Current tool catalog

The `sera-mcp` tool inventory evolves with the server. Do not treat this Skill as
a static catalog: consult the [current tool catalog in the official
README](https://github.com/sera-cx/sera-mcp#readme), then call `tools/list` on
the configured MCP server before selecting a tool or relying on its schema.

### MCP Resources

```
sera://currencies      # Supported currencies list
sera://markets         # Available markets
sera://config          # Current server configuration
sera://help/tools      # Tool documentation
sera://help/quickstart # Getting started guide
```

### CLI Commands

```bash
sera doctor                              # Health check
sera fx USD SGD                          # Quick FX rate
sera quote USDC XSGD 100 --simulate      # Simulate quote
sera deals --min-bps 25 --json           # Find deals (JSON output)
sera ladder USDT JPYC 30000              # Maker quote ladder
sera spread-radar USD,SGD,MYR,EUR,GBP,JPY  # Multi-corridor spread scan
```

Add `--json` to any command for machine-readable output.

### Security Architecture

```
Quote-Sign-Execute flow (external signing mode):
1. get_quote()   → returns quote_id + unsigned transaction
2. User signs    → via wallet (MetaMask, AA, etc.)
3. execute_swap() → submits signed tx with quote_id

Policy Engine:
- Symbol whitelist enforcement
- Per-transaction notional cap
- 24-hour rolling volume limit
- Max slippage enforcement

Quote Registry:
- Each quote stored in-memory with UUID
- Execution parameters must match original quote
- Prevents parameter tampering between quote and execute
```

### Typical Workflow

```
User: "What's the USD/SGD rate?"
→ get_fx_rate({ from: "USD", to: "SGD" })

User: "Find good swap deals"
→ find_deals({ min_bps: 25 })

User: "Swap 1000 USDC to XSGD"
→ get_quote({ from: "USDC", to: "XSGD", amount: 1000 })
→ execute_swap({ quote_id: "uuid-..." })

User: "Check my treasury balances"
→ get_balances({ address: "0x..." })  # requires SERA_API_KEY

User: "System health?"
→ doctor()
```

### Verification

```bash
npx @modelcontextprotocol/inspector http://localhost:3848/mcp
```

---

## Part 2: Local Sample MCP Server (mcp-server/)

The `mcp-server/` directory in this repo is a **minimal 8-tool example** for learning. It demonstrates the same core concepts with simpler code.

### Overview

**Tech stack**: MCP SDK v1.6.1, viem, Zod, TypeScript
**Transports**: stdio (default) or HTTP
**Purpose**: Learning / local development reference

### Tools

#### Read-Only Tools (no PRIVATE_KEY required)

| Tool | Description | Input |
|---|---|---|
| `sera_get_market` | Get market info (tokens, fees, price range) | `market_id`: address |
| `sera_list_markets` | List available markets | `limit`: 1–100 (default 10) |
| `sera_get_orderbook` | Get order book (bids + asks) | `market_id`: address, `depth`: 1–50 (default 10) |
| `sera_get_orders` | Get user's orders | `user_address`: address, `market_id`: address, `limit`: 1–100 |
| `sera_get_token_balance` | Check ERC20 token balance | `token_address`: address, `account_address?`: address |

#### Write Tools (PRIVATE_KEY required)

| Tool | Description | Input |
|---|---|---|
| `sera_place_order` | Place limit bid/ask | `market_id`, `price_index`, `raw_amount`, `is_bid`, `post_only?` |
| `sera_claim_order` | Claim filled order proceeds | `market_id`, `is_bid`, `price_index`, `order_index` |
| `sera_approve_token` | Approve ERC20 for Router | `token_address`, `amount`, `spender?` (default: Router) |

### Setup

```bash
cd mcp-server
npm install
npm run build
cp .env.example .env
# PRIVATE_KEY=0x[64-hex-chars]   # Required for write tools
# SEPOLIA_RPC_URL=https://0xrpc.io/sep

# stdio mode (Claude Code/Desktop)
npm start

# HTTP mode
TRANSPORT=http npm run start:http
# → http://localhost:3000/mcp
```

### Client Configuration (Local Sample)

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "sera-protocol": {
      "command": "node",
      "args": ["<path>/SeraProtocol-Sample/mcp-server/dist/index.js"],
      "env": {
        "PRIVATE_KEY": "0x...",
        "SEPOLIA_RPC_URL": "https://0xrpc.io/sep"
      }
    }
  }
}
```

### Service Layer

```typescript
// subgraph.ts
getMarketInfo(marketId: string): Promise<Market>
listMarkets(limit: number): Promise<Market[]>
getOrderBook(marketId: string, depth: number): Promise<{ bids: Depth[], asks: Depth[] }>
getUserOrders(userAddress: string, marketId: string, limit: number): Promise<OpenOrder[]>

// blockchain.ts
getTokenBalance(tokenAddress: string, accountAddress?: string): Promise<bigint>
getAllowance(tokenAddress: string, ownerAddress: string, spenderAddress: string): Promise<bigint>
approveToken(tokenAddress: string, amount: bigint, spenderAddress?: string): Promise<string>
placeLimitOrder(params: PlaceOrderParams): Promise<string>
claimOrder(params: ClaimOrderParams): Promise<string>
getConfiguredAddress(): string

// format.ts
formatPrice(price: string, decimals?: number): string
formatAmount(rawAmount: string, quoteUnit: string): string
formatTokenAmount(amount: bigint, decimals: number): string
truncateAddress(address: string): string
```

### Schemas (Zod)

```typescript
const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const PlaceOrderInputSchema = z.object({
  market_id: AddressSchema,
  price_index: z.number().int().min(0).max(65535),
  raw_amount: z.number().int().min(1),
  is_bid: z.boolean(),
  post_only: z.boolean().optional().default(true),
});

const ClaimOrderInputSchema = z.object({
  market_id: AddressSchema,
  is_bid: z.boolean(),
  price_index: z.number().int().min(0).max(65535),
  order_index: z.number().int().min(0),
});

const ApproveTokenInputSchema = z.object({
  token_address: AddressSchema,
  amount: z.string(),
  spender: AddressSchema.optional(),
});
```

### Typical Local MCP Workflow

```
User: "Show me the TWETH/TUSDC market"
→ sera_get_market(market_id: "0x002930b390ac7d686f07cffb9d7ce39609d082d1")

User: "What does the order book look like?"
→ sera_get_orderbook(market_id: "0x...", depth: 10)

User: "Place a bid at price index 12000 for 1000 raw units"
→ sera_approve_token(token_address: quoteTokenAddress, amount: "...")
→ sera_place_order(market_id: "0x...", price_index: 12000, raw_amount: 1000, is_bid: true)

User: "Check my orders"
→ sera_get_orders(user_address: "0x...", market_id: "0x...", limit: 10)

User: "Claim my filled order"
→ sera_claim_order(market_id: "0x...", is_bid: true, price_index: 12000, order_index: 0)
```

---

## Choosing the Right MCP

| Need | Use |
|---|---|
| Production AI agent with FX trading | `sera-cx/sera-mcp` (see its current README tool catalog) |
| Learning how Sera MCP works | `mcp-server/` (8 tools, simpler code) |
| Multi-currency treasury management | `sera-cx/sera-mcp` + treasury tools |
| Simple order book queries | Either works |
| x402 machine-to-machine payments | `sera-cx/sera-agents/x402-service/` |
