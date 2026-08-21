---
name: sera-protocol
description: Build, review, or explain integrations with Sera Protocol for stablecoin FX, multi-currency settlement, Sera MCP, Sera Agents, or x402. Use for quotes, corridors, settlement workflows, agent integrations, and Sera Protocol API or contract questions.
license: MIT
metadata:
  author: sera-cx
  repository: https://github.com/sera-cx/sera-agents
---

# Sera Protocol

Use this skill when working with Sera Protocol: stablecoin FX and multi-currency
settlement for applications and AI agents.

## Load the relevant reference

The bundled references retain the detailed implementation material from the
original `sera-protocol` Skill. Read only the file that matches the task; values
such as contract addresses, endpoints, supported assets, tool inventories, and
deployment status can change, so verify them against the linked official source
or the configured service before using them in a live integration.

| Task | Read |
| --- | --- |
| Current REST API, quotes, swaps, orders, or Virtual Liquidity | [`references/api-reference.md`](references/api-reference.md) |
| v1 subgraph queries and order-book data | [`references/graphql-api.md`](references/graphql-api.md) |
| v1 Router / PriceBook contract integration | [`references/smart-contracts.md`](references/smart-contracts.md) |
| v2 signed orders, Vault, SOR, or batch matching | [`references/orderbook-v2.md`](references/orderbook-v2.md) |
| Trading front-end patterns | [`references/frontend-patterns.md`](references/frontend-patterns.md) |
| Official or sample MCP server configuration | [`references/mcp-server.md`](references/mcp-server.md) |
| Sera Agents templates or x402 | [`references/sera-agents.md`](references/sera-agents.md) |
| SeraPay merchant payments | [`references/sera-pay.md`](references/sera-pay.md) |

## Start with the right surface

Pick the least privileged integration that solves the task.

| Need | Recommended surface |
| --- | --- |
| Rates, corridors, and a settlement intent | The hosted, keyless MCP gateway at `https://agents.sera.cx/mcp` |
| Treasury, orders, or execution workflows | A locally run or self-hosted [`sera-mcp`](https://github.com/sera-cx/sera-mcp) with an explicit signer mode and policy |
| A new AI-agent product | One of the [`sera-agents` templates](https://github.com/sera-cx/sera-agents/tree/main/templates) |
| Machine-to-machine 402 payment flow | Self-host [`x402-service`](https://github.com/sera-cx/sera-agents/tree/main/x402-service); demo mode is local-only |

Do not describe `https://agents.sera.cx/x402/*` as a hosted API. The public host
provides the static site and keyless MCP gateway; x402 is self-hosted.

## Safe operating rules

1. Treat market discovery and quotes as read-only. Fetch supported currencies,
   markets, limits, and the current quote before proposing an execution.
2. Before any value-moving action, present the source asset, destination asset,
   amount, recipient, fees, quote expiry, and applicable policy limits. Ask for
   explicit confirmation if the user has not already supplied unambiguous intent.
3. Use an external signer by default. Never request, expose, paste, log, or add a
   private key, seed phrase, API secret, or wallet credential to source control.
4. Keep simulation/demo and live environments separate. Live x402 operation also
   requires the documented operator acknowledgement and a completed testnet E2E.
5. Do not invent token support, exchange rates, contract addresses, tool names, or
   settlement outcomes. Query the configured MCP/API or consult the current Sera
   documentation instead.

The reference examples may show environment-variable placeholders for local
development. Treat them as names only: never ask a user to paste secrets into a
chat, commit them, or store them in a Skill.

## Agent and MCP workflow

For an agent integration, follow this order:

1. Register the MCP server using the host's MCP configuration.
2. Run `sera.doctor` and resolve configuration failures before using trading or
   settlement tools.
3. Discover currencies and markets, then request a fresh quote.
4. Return a compact execution preview and wait for confirmation.
5. Execute only through the configured signer and policy. Report the resulting
   transaction or settlement status without claiming finality until the tool says so.

The hosted gateway is appropriate for exploration and intent-based workflows. A
self-hosted full MCP is required when the application needs account-aware,
treasury, order, or execution capabilities.

## Implementation guidance

- Prefer the Sera MCP instead of reproducing protocol logic in prompts.
- Keep monetary values as strings or integer minor units until the boundary where
  the selected API documents its format; do not use JavaScript floating point for
  settlement calculations.
- Validate recipient addresses, currency codes, amount positivity, and quote expiry
  on the server side.
- Use idempotency controls for any operation that could submit or settle value.
- Make the signer mode and policy preset explicit in deployment configuration.

## Useful links

- [Sera MCP](https://github.com/sera-cx/sera-mcp)
- [Sera Agents](https://github.com/sera-cx/sera-agents)
- [Sera developer documentation](https://docs.testnet.sera.cx/)
- [x402 service operations and readiness](https://github.com/sera-cx/sera-agents/blob/main/x402-service/README.md)
- [Sera Agents security model](https://github.com/sera-cx/sera-agents/blob/main/SECURITY-MODEL.md)
