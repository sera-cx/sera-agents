# Sera Agents Reference

**Repo**: https://github.com/sera-cx/sera-agents
**Purpose**: Multi-currency settlement infrastructure for AI agents
**Supported currencies**: 40+ stablecoins across 20+ fiat currencies (USD, SGD, MYR, JPY, EUR, GBP, BRL, MXN, IDR, etc.)

---

## Repository Structure

```
sera-agents/
├── sera-agent/          # Path C: Bundled CLI agent
├── templates/           # Path B: Customizable starters
│   ├── chat-cli         # Terminal REPL
│   ├── web-chat         # Express + browser chat UI
│   └── webhook-agent    # HTTP POST-triggered agent
├── x402-service/        # Path D: x402 protocol service
├── integrations/        # Host-specific configs (OpenClaw, Hermes, etc.)
├── examples/            # Reference implementations
│   ├── invoice-payer    # Automated invoice payment agent
│   └── treasury-rebalancer  # Multi-currency rebalancing
└── x402/                # x402 endpoint design notes
```

---

## Four Integration Paths

### Path A — Install (Add to existing agent)

Add the official `sera-mcp` MCP server to your existing agent stack.

```bash
# Clone and build
git clone https://github.com/sera-cx/sera-mcp
cd sera-mcp && npm install && npm run build

# Add to Claude Code
claude mcp add sera --scope user \
  --env SERA_NETWORK=mainnet \
  --env POLICY_PRESET=standard \
  -- node /path/to/dist/index.js
```

See `references/mcp-server.md` (Part 1) for full MCP configuration.

**Required env vars:**
```bash
SERA_NETWORK=mainnet
POLICY_PRESET=standard
```

**For treasury tools, additionally:**
```bash
SERA_API_KEY=...
SERA_API_SECRET=...
```

---

### Path B — Build (New agent from template)

Start a new agent from one of three templates:

```bash
git clone https://github.com/sera-cx/sera-agents
cp -r templates/web-chat ~/my-sera-agent   # or chat-cli, webhook-agent
cd ~/my-sera-agent
npm install
```

**Required env vars (all templates):**
```bash
OPENAI_API_KEY=sk-...   # Or any LLM provider key
```

#### Template: `chat-cli`
- **Type**: Terminal REPL
- **Use case**: Interactive FX queries and swaps from the command line
- **Run**: `npm start`

#### Template: `web-chat`
- **Type**: Express + browser chat UI
- **Use case**: Browser-based trading assistant
- **Stack**: Express backend + browser frontend
- **Run**: `npm start` → open `http://localhost:3000`

#### Template: `webhook-agent`
- **Type**: HTTP endpoint agent
- **Use case**: Trigger FX actions via webhook (payment notifications, automation)
- **API**: `POST /webhook` with JSON payload
- **Run**: `npm start` → listens on configured port

---

### Path C — Run (Immediate use)

Use the bundled CLI agent without customization:

```bash
git clone https://github.com/sera-cx/sera-agents
cd sera-agents/sera-agent
npm start
```

The bundled agent includes `sera-mcp` pre-wired and ready for interactive use.

---

### Path D — Protocol (x402 only)

Implement the [x402 payment protocol](https://x402.org) for machine-to-machine stablecoin payments. Useful when you only need payment request/fulfillment without full trading.

```bash
cd sera-agents/x402-service

# Demo mode (no wallet required, for testing)
X402_MODE=demo node index.js
# → Listens on port 8402

# Live mode (Base Sepolia)
X402_MODE=live \
  X402_NETWORK=base \
  X402_LIVE_ACK=true \
  X402_CONFIRMATION_DEPTH=3 \
  node index.js
```

**x402 Environment Variables:**

| Variable | Value | Description |
|---|---|---|
| `X402_MODE` | `demo` / `live` | Demo: simulated; live: real blockchain |
| `X402_NETWORK` | `base` | Chain (Base Sepolia for live mode) |
| `X402_LIVE_ACK` | `true` | Must be set to enable live mode |
| `X402_CONFIRMATION_DEPTH` | `3` (min) | Block confirmations before payment confirmed |

**Status**: Live mode is wired but not yet production-verified (Base Sepolia end-to-end validation in progress as of v0.6.0).

**x402 Flow:**
```
1. Resource server returns HTTP 402 with payment details
2. Client pays in stablecoin on Base Sepolia
3. x402-service verifies payment (waits for X402_CONFIRMATION_DEPTH blocks)
4. Client retries original request with payment proof
5. Resource server grants access
```

---

## Reference Examples

### invoice-payer

Automated agent that watches for invoices and pays them with stablecoins.

```bash
cd examples/invoice-payer
SERA_API_KEY=... SERA_API_SECRET=... npm start
```

Key pattern:
1. Receive invoice (amount + recipient + currency)
2. Call `get_quote` to check current rate
3. Call `execute_swap` or `convert_and_send` to pay

### treasury-rebalancer

Agent that monitors multi-currency balances and rebalances toward a target allocation.

```bash
cd examples/treasury-rebalancer
SERA_API_KEY=... SERA_API_SECRET=... npm start
```

Key pattern:
1. Call `get_balances` to fetch current holdings
2. Call `exposure_report` to measure currency exposure
3. Call `rebalance_plan` to get swap recommendations
4. Execute recommended swaps via `execute_swap`

---

## Integration Targets

The `integrations/` directory contains host-specific configuration files:

| Host | File | Notes |
|---|---|---|
| OpenClaw | `integrations/openclaw/` | Auto-generated |
| Hermes | `integrations/hermes/` | Auto-generated |
| NanoClaw | `integrations/nanoclaw/` | Auto-generated |
| Claude Code | Via `claude mcp add` | See Path A |
| Claude Desktop | Via `claude_desktop_config.json` | See mcp-server.md |
| ChatGPT | OpenAI tool format | Plugin config |
| Cursor | MCP settings | stdio server |

---

## Supported Corridors (Examples)

| From | To | Stablecoin Pair |
|---|---|---|
| USD | SGD | USDC → XSGD |
| USD | JPY | USDT → JPYC |
| USD | MYR | USDC → MYRT |
| USD | EUR | USDT → EURC |
| USD | GBP | USDC → TGBP |
| SGD | JPY | XSGD → JPYC |

Total: 40+ stablecoins, 20+ fiat currencies. Query `list_currencies` for the full live list.

---

## Quick Decision Guide

| Goal | Path | Template |
|---|---|---|
| Add FX tools to existing Claude agent | A | `sera-mcp` |
| Build a new FX trading chatbot | B | `web-chat` |
| Test FX queries interactively | B or C | `chat-cli` or bundled |
| Trigger payments from webhook events | B | `webhook-agent` |
| Machine-to-machine HTTP payments | D | `x402-service` |
| Automated invoice payment bot | — | `examples/invoice-payer` |
| Treasury rebalancing automation | — | `examples/treasury-rebalancer` |
