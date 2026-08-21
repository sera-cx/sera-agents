import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChildMcpEnv,
  createToolFilter,
  DESTRUCTIVE_TOOLS,
  FilteredMCPServer,
  getToolProfileFromEnv,
  SERA_MCP_MANIFEST,
  type StandardCallToolParams,
  type StandardCallToolResult,
  type StandardListToolsResult,
  type StandardMcpTool,
  TOOL_PROFILES,
  ToolNotPermittedError,
} from "../mcp-tool-filter.js";

/**
 * Independent upstream sera-mcp registry definition.
 * Represents the ground-truth 55-tool surface exposed by sera-mcp with upstream metadata.
 */
interface UpstreamToolDescriptor {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly destructive: boolean;
  readonly inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

const UPSTREAM_SERA_MCP_REGISTRY: readonly UpstreamToolDescriptor[] = Object.freeze([
  // 01 Discovery (6)
  {
    name: "sera.list_currencies",
    category: "discovery",
    description: "List supported stablecoin currencies and token metadata.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.get_markets",
    category: "discovery",
    description: "Get active FX trading corridors and market parameters.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.doctor",
    category: "discovery",
    description: "Diagnostic tool checking connectivity, contract readiness, and RPC health.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.search_coins",
    category: "discovery",
    description: "Search for supported stablecoins by symbol, name, or contract address.",
    destructive: false,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "sera.get_coin_metadata",
    category: "discovery",
    description: "Retrieve ERC-20 metadata including decimals, issuer, and chain addresses.",
    destructive: false,
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
  },
  {
    name: "sera.get_coin_history",
    category: "discovery",
    description: "Historical price and volume metrics for a given coin symbol.",
    destructive: false,
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
  },

  // 02 Pricing & analytics (4)
  {
    name: "sera.get_fx_rate",
    category: "pricing",
    description: "Get current spot FX exchange rate between two stablecoins.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { base: { type: "string" }, quote: { type: "string" } },
    },
  },
  {
    name: "sera.compare_to_external_fx",
    category: "pricing",
    description: "Compare Sera pool rates against external reference FX oracles.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { base: { type: "string" }, quote: { type: "string" } },
    },
  },
  {
    name: "sera.multi_source_mid",
    category: "pricing",
    description: "Aggregate mid-market exchange rate across multiple liquidity sources.",
    destructive: false,
    inputSchema: { type: "object", properties: { pair: { type: "string" } } },
  },
  {
    name: "sera.spread_radar",
    category: "pricing",
    description: "Scan bid/ask spreads across all active settlement corridors.",
    destructive: false,
    inputSchema: { type: "object" },
  },

  // 03 Liquidity probing (9)
  {
    name: "sera.scan_markets",
    category: "liquidity",
    description: "Scan all markets for liquidity depth and order activity.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.find_deals",
    category: "liquidity",
    description: "Discover favorable arbitrage or routing opportunities.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.maker_quote_ladder",
    category: "liquidity",
    description: "Calculate multi-level maker quote ladder for inventory sizing.",
    destructive: false,
    inputSchema: { type: "object", properties: { corridor: { type: "string" } } },
  },
  {
    name: "sera.probe_depth",
    category: "liquidity",
    description: "Probe available pool depth at varying trade sizes.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { fromToken: { type: "string" }, toToken: { type: "string" } },
    },
  },
  {
    name: "sera.round_trip_cost",
    category: "liquidity",
    description: "Calculate round-trip slippage and fee cost between currency pairs.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.infer_book",
    category: "liquidity",
    description: "Synthesize a virtual order book from AMM pool invariants.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.market_health",
    category: "liquidity",
    description: "Assess volatility, liquidity score, and circuit breaker status.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.fx_quote_diff",
    category: "liquidity",
    description: "Analyze price impact delta between small and large quote requests.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.compare_corridors",
    category: "liquidity",
    description: "Evaluate multi-hop routing paths across currency corridors.",
    destructive: false,
    inputSchema: { type: "object" },
  },

  // 04 Quote & plan (5 read-only + 1 builder)
  {
    name: "sera.get_quote",
    category: "quote_plan",
    description: "Fetch guaranteed RFQ quote with route parameters and quote ID.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" }, amount: { type: "string" } },
    },
  },
  {
    name: "sera.prepare_swap",
    category: "quote_plan",
    description: "Construct unsigned settlement transaction data from a valid quote.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { quote_id: { type: "string" }, signer: { type: "string" } },
    },
  },
  {
    name: "sera.quote_recipient_amount",
    category: "quote_plan",
    description:
      "Quote exact source amount needed for a recipient to receive a specific target sum.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.find_cheapest_settlement_path",
    category: "quote_plan",
    description: "Determine lowest-cost execution route among multi-hop corridor combinations.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.batch_quote",
    category: "quote_plan",
    description: "Request simultaneous quotes across multiple currency pairs in one call.",
    destructive: false,
    inputSchema: { type: "object", properties: { requests: { type: "array" } } },
  },
  {
    name: "sera.limit_watcher",
    category: "quote_plan",
    description: "Check if limit price conditions are met across monitored corridors.",
    destructive: false,
    inputSchema: { type: "object" },
  },

  // 05 Execution (2 destructive)
  {
    name: "sera.execute_swap",
    category: "execution",
    description: "Execute a swap on-chain using an authenticated custodial signer.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { quote_id: { type: "string" } },
      required: ["quote_id"],
    },
  },
  {
    name: "sera.convert_and_send",
    category: "execution",
    description:
      "Convert source tokens to destination currency and transfer to a recipient address.",
    destructive: true,
    inputSchema: { type: "object", required: ["from_token", "to_token", "amount", "recipient"] },
  },

  // 06 Maker & orders (5 destructive + 4 read-only)
  {
    name: "sera.place_order",
    category: "maker_orders",
    description: "Submit a signed limit order to the Sera matching engine.",
    destructive: true,
    inputSchema: { type: "object", required: ["order"] },
  },
  {
    name: "sera.cancel_order",
    category: "maker_orders",
    description: "Cancel an active limit order by order ID.",
    destructive: true,
    inputSchema: { type: "object", required: ["order_id"] },
  },
  {
    name: "sera.cancel_all_orders",
    category: "maker_orders",
    description: "Bulk-cancel all active limit orders for an account.",
    destructive: true,
    inputSchema: { type: "object", required: ["owner_address"] },
  },
  {
    name: "sera.place_vl_batch",
    category: "maker_orders",
    description: "Submit a batch of Virtual Liquidity limit orders sharing collateral.",
    destructive: true,
    inputSchema: { type: "object", required: ["orders"] },
  },
  {
    name: "sera.cancel_vl_batch",
    category: "maker_orders",
    description: "Cancel an entire Virtual Liquidity order batch.",
    destructive: true,
    inputSchema: { type: "object", required: ["vl_batch_id"] },
  },
  {
    name: "sera.get_order",
    category: "maker_orders",
    description: "Retrieve order status, remaining amount, and fill state.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "sera.list_orders",
    category: "maker_orders",
    description: "List open and historical orders for a given wallet address.",
    destructive: false,
    inputSchema: { type: "object", properties: { owner_address: { type: "string" } } },
  },
  {
    name: "sera.get_fills",
    category: "maker_orders",
    description: "Retrieve trade fill history for an account.",
    destructive: false,
    inputSchema: { type: "object", properties: { owner_address: { type: "string" } } },
  },
  {
    name: "sera.get_fills_for_order",
    category: "maker_orders",
    description: "Retrieve granular execution fills for a specific order ID.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },

  // 07 Treasury (6 read-only)
  {
    name: "sera.get_balances",
    category: "treasury",
    description: "Query token balances across supported stablecoins for a wallet address.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { owner_address: { type: "string" } },
      required: ["owner_address"],
    },
  },
  {
    name: "sera.treasury_value",
    category: "treasury",
    description: "Calculate total fiat-denominated portfolio value across treasury wallets.",
    destructive: false,
    inputSchema: { type: "object", properties: { owner_addresses: { type: "array" } } },
  },
  {
    name: "sera.exposure_report",
    category: "treasury",
    description: "Generate risk breakdown and currency concentration metrics.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.rebalance_plan",
    category: "treasury",
    description: "Compute suggested rebalancing swaps to reach target currency allocations.",
    destructive: false,
    inputSchema: { type: "object", properties: { target_weights: { type: "object" } } },
  },
  {
    name: "sera.pay_invoice",
    category: "treasury",
    description:
      "Estimate optimal asset routing and settlement path to settle a commercial invoice.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { amount: { type: "string" }, recipient: { type: "string" } },
    },
  },
  {
    name: "sera.settlement_status",
    category: "treasury",
    description: "Check on-chain confirmation and finality status of a settlement UUID.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { settlement_id: { type: "string" } },
      required: ["settlement_id"],
    },
  },

  // 08 Account & funds (3 builders + 2 destructive)
  {
    name: "sera.build_approve",
    category: "account_funds",
    description: "Build unsigned ERC-20 approval transaction for Sera vault contracts.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" }, amount: { type: "string" } },
    },
  },
  {
    name: "sera.build_deposit",
    category: "account_funds",
    description: "Build unsigned deposit transaction to credit Sera balance.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" }, amount: { type: "string" } },
    },
  },
  {
    name: "sera.build_transfer",
    category: "account_funds",
    description: "Build unsigned ERC-20 transfer transaction payload.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" }, to: { type: "string" }, amount: { type: "string" } },
    },
  },
  {
    name: "sera.send_tx",
    category: "account_funds",
    description: "Broadcast a locally signed approval or deposit raw transaction to the network.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { raw_tx: { type: "string" } },
      required: ["raw_tx"],
    },
  },
  {
    name: "sera.send_transfer",
    category: "account_funds",
    description: "Broadcast a locally signed transfer raw transaction to the network.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { raw_tx: { type: "string" } },
      required: ["raw_tx"],
    },
  },

  // 09 Withdraw (2 builders + 1 destructive)
  {
    name: "sera.withdraw_request",
    category: "withdraw",
    description: "Prepare an EIP-712 withdrawal intent struct for user signing.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { token: { type: "string" }, amount: { type: "string" } },
    },
  },
  {
    name: "sera.withdraw_build",
    category: "withdraw",
    description: "Build dual-signed withdrawal transaction payload with co-signer signature.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { intent: { type: "object" }, user_signature: { type: "string" } },
    },
  },
  {
    name: "sera.withdraw_send",
    category: "withdraw",
    description: "Broadcast dual-signed withdrawal transaction to release funds on-chain.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { raw_tx: { type: "string" } },
      required: ["raw_tx"],
    },
  },

  // 10 History (3 read-only)
  {
    name: "sera.fx_history",
    category: "history",
    description: "Query historical exchange rate candles and settlement volume.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { base: { type: "string" }, quote: { type: "string" } },
    },
  },
  {
    name: "sera.fx_volatility",
    category: "history",
    description: "Compute rolling realized volatility metrics for currency pairs.",
    destructive: false,
    inputSchema: { type: "object" },
  },
  {
    name: "sera.corridor_pnl",
    category: "history",
    description: "Compute historical trading PnL breakdown across settled corridors.",
    destructive: false,
    inputSchema: { type: "object" },
  },

  // 11 Signing & debug (2 read-only)
  {
    name: "sera.verify_signature",
    category: "signing",
    description: "Verify validity of an EIP-712 order or withdrawal signature offline.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { signature: { type: "string" } },
      required: ["signature"],
    },
  },
  {
    name: "sera.permit_metadata",
    category: "signing",
    description: "Inspect EIP-2612 permit parameters, nonce, and domain separator for a token.",
    destructive: false,
    inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
  },
]);

/**
 * Mock 1: Standard @modelcontextprotocol/sdk Client (Object-based listTools and callTool)
 * Populated directly from UPSTREAM_SERA_MCP_REGISTRY to test against real upstream tool inventory.
 */
class MockStandardMcpClient {
  public name = "standard-mcp-client";

  public async listTools(): Promise<StandardListToolsResult> {
    return {
      tools: UPSTREAM_SERA_MCP_REGISTRY.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as StandardMcpTool["inputSchema"],
      })),
      nextCursor: "cursor_page_2",
      _meta: { serverVersion: "1.0.0" },
    };
  }

  public async callTool(params: StandardCallToolParams): Promise<StandardCallToolResult> {
    return {
      content: [{ type: "text", text: `Executed ${params.name}` }],
      isError: false,
    };
  }
}

/**
 * Mock 2: @openai/agents MCPServer (Array-based listTools and positional callTool)
 * Populated directly from UPSTREAM_SERA_MCP_REGISTRY.
 */
class MockOpenAiMcpServer {
  public name = "openai-mcp-server";
  public cacheToolsList = true;

  public async listTools(): Promise<StandardMcpTool[]> {
    return UPSTREAM_SERA_MCP_REGISTRY.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as StandardMcpTool["inputSchema"],
    }));
  }

  public async callTool(
    toolName: string,
    _args: Record<string, unknown>,
  ): Promise<Array<{ type: string; text: string }>> {
    return [{ type: "text", text: `Executed positional ${toolName}` }];
  }
}

describe("MCP Tool Filtering & Execution Gating (mcp-tool-filter.ts)", () => {
  beforeEach(() => {
    delete process.env.TOOL_PROFILE;
    delete process.env.SERA_ENABLE_EXECUTION_TOOLS;
  });

  describe("Independent Contract Tests: Upstream sera-mcp Registry Parity & Drift Detection", () => {
    it("ensures upstream registry contains all 55 tools", () => {
      expect(UPSTREAM_SERA_MCP_REGISTRY.length).toBe(55);
      const uniqueNames = new Set(UPSTREAM_SERA_MCP_REGISTRY.map((t) => t.name));
      expect(uniqueNames.size).toBe(55);
    });

    it("ensures canonical SERA_MCP_MANIFEST exactly matches all 55 upstream registry tools", () => {
      expect(SERA_MCP_MANIFEST.length).toBe(55);

      const upstreamSet = new Set(UPSTREAM_SERA_MCP_REGISTRY.map((t) => t.name));
      const manifestSet = new Set(SERA_MCP_MANIFEST);

      // Fails if any upstream tool is missing from SERA_MCP_MANIFEST
      for (const upstreamTool of UPSTREAM_SERA_MCP_REGISTRY) {
        expect(
          manifestSet.has(upstreamTool.name),
          `Upstream tool "${upstreamTool.name}" is missing from SERA_MCP_MANIFEST`,
        ).toBe(true);
      }

      // Fails if SERA_MCP_MANIFEST contains unknown tools not in upstream registry
      for (const manifestTool of SERA_MCP_MANIFEST) {
        expect(
          upstreamSet.has(manifestTool),
          `Manifest tool "${manifestTool}" does not exist in upstream sera-mcp registry`,
        ).toBe(true);
      }
    });

    it("ensures every tool in upstream registry is explicitly classified in security profiles", () => {
      const readOnlyAllowed = new Set(TOOL_PROFILES.READ_ONLY.allowedToolNames ?? []);
      const plannerAllowed = new Set(TOOL_PROFILES.PLANNER.allowedToolNames ?? []);
      const destructiveSet = new Set(DESTRUCTIVE_TOOLS);

      expect(readOnlyAllowed.size).toBe(39);
      expect(plannerAllowed.size).toBe(45);
      expect(destructiveSet.size).toBe(10);

      for (const tool of UPSTREAM_SERA_MCP_REGISTRY) {
        const isDestructive = destructiveSet.has(tool.name);
        const isReadOnly = readOnlyAllowed.has(tool.name);
        const isPlanner = plannerAllowed.has(tool.name);

        if (tool.destructive) {
          expect(
            isDestructive,
            `Upstream destructive tool "${tool.name}" MUST be in DESTRUCTIVE_TOOLS`,
          ).toBe(true);
          expect(
            isReadOnly,
            `Destructive tool "${tool.name}" MUST NOT be in READ_ONLY profile`,
          ).toBe(false);
          expect(isPlanner, `Destructive tool "${tool.name}" MUST NOT be in PLANNER profile`).toBe(
            false,
          );
        } else {
          expect(
            isDestructive,
            `Non-destructive tool "${tool.name}" should not be in DESTRUCTIVE_TOOLS`,
          ).toBe(false);
          // Must be classified at least in PLANNER
          expect(
            isPlanner,
            `Upstream non-destructive tool "${tool.name}" must be classified in PLANNER profile`,
          ).toBe(true);
        }
      }
    });

    it("ensures all 10 tools marked destructive in upstream registry match DESTRUCTIVE_TOOLS exactly", () => {
      const upstreamDestructive = UPSTREAM_SERA_MCP_REGISTRY.filter((t) => t.destructive).map(
        (t) => t.name,
      );
      expect(upstreamDestructive.length).toBe(10);
      expect(DESTRUCTIVE_TOOLS.length).toBe(10);

      expect([...DESTRUCTIVE_TOOLS].sort()).toEqual([...upstreamDestructive].sort());
    });

    it("fails drift detection when an unclassified upstream tool is introduced", () => {
      // Simulate drift: new upstream tool introduced in upstream sera-mcp
      const driftedRegistry = [
        ...UPSTREAM_SERA_MCP_REGISTRY,
        {
          name: "sera.new_unclassified_tool",
          category: "discovery",
          description: "New upstream capability",
          destructive: false,
          inputSchema: { type: "object" as const },
        },
      ];

      const manifestSet = new Set(SERA_MCP_MANIFEST);
      const missingTools = driftedRegistry.filter((t) => !manifestSet.has(t.name));

      expect(missingTools.length).toBe(1);
      expect(missingTools[0].name).toBe("sera.new_unclassified_tool");
    });
  });

  describe("Discovery Gating (listTools)", () => {
    it("hides 100% of destructive tools from discovery under READ_ONLY profile", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "READ_ONLY" });

      const res = (await filtered.listTools()) as StandardListToolsResult;
      const visibleNames = res.tools.map((t) => t.name);

      expect(visibleNames.length).toBe(39);

      for (const destructiveTool of DESTRUCTIVE_TOOLS) {
        expect(
          visibleNames,
          `Destructive tool "${destructiveTool}" must NOT be visible in READ_ONLY`,
        ).not.toContain(destructiveTool);
      }

      // Preserves pagination metadata
      expect(res.nextCursor).toBe("cursor_page_2");
      expect(res._meta).toEqual({ serverVersion: "1.0.0" });
    });

    it("verifies all legitimate read-only tools remain accessible in READ_ONLY discovery", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "READ_ONLY" });

      const res = (await filtered.listTools()) as StandardListToolsResult;
      const visibleNames = res.tools.map((t) => t.name);

      const requiredReadOnlyTools = [
        "sera.get_balances",
        "sera.search_coins",
        "sera.get_coin_metadata",
        "sera.get_order",
        "sera.list_orders",
        "sera.get_fills",
        "sera.get_fills_for_order",
        "sera.settlement_status",
        "sera.batch_quote",
        "sera.permit_metadata",
        "sera.get_quote",
        "sera.doctor",
        "sera.list_currencies",
        "sera.get_markets",
        "sera.treasury_value",
        "sera.exposure_report",
      ];

      for (const tool of requiredReadOnlyTools) {
        expect(
          visibleNames,
          `Legitimate read-only tool "${tool}" must be visible under READ_ONLY profile`,
        ).toContain(tool);
      }
    });

    it("hides unsigned builder tools from discovery under READ_ONLY profile", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "READ_ONLY" });

      const res = (await filtered.listTools()) as StandardListToolsResult;
      const visibleNames = res.tools.map((t) => t.name);

      const builderTools = [
        "sera.prepare_swap",
        "sera.withdraw_request",
        "sera.withdraw_build",
        "sera.build_approve",
        "sera.build_deposit",
        "sera.build_transfer",
      ];

      for (const builderTool of builderTools) {
        expect(
          visibleNames,
          `Unsigned builder tool "${builderTool}" must NOT be visible in READ_ONLY`,
        ).not.toContain(builderTool);
      }
    });

    it("hides destructive tools but exposes builder tools under PLANNER profile", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "PLANNER" });

      const res = (await filtered.listTools()) as StandardListToolsResult;
      const visibleNames = res.tools.map((t) => t.name);

      expect(visibleNames.length).toBe(45);

      for (const destructiveTool of DESTRUCTIVE_TOOLS) {
        expect(
          visibleNames,
          `Destructive tool "${destructiveTool}" must NOT be visible in PLANNER`,
        ).not.toContain(destructiveTool);
      }

      // Builder tools must be visible in PLANNER
      const builderTools = [
        "sera.prepare_swap",
        "sera.withdraw_request",
        "sera.withdraw_build",
        "sera.build_approve",
        "sera.build_deposit",
        "sera.build_transfer",
      ];

      for (const builderTool of builderTools) {
        expect(visibleNames, `Builder tool "${builderTool}" must be visible in PLANNER`).toContain(
          builderTool,
        );
      }
    });

    it("exposes all 55 tools under FULL_EXECUTION profile", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "FULL_EXECUTION" });

      const res = (await filtered.listTools()) as StandardListToolsResult;
      expect(res.tools.length).toBe(55);
    });
  });

  describe("Execution Gating (callTool)", () => {
    it("strictly rejects direct callTool() for EVERY destructive tool under READ_ONLY and PLANNER", async () => {
      const mock = new MockStandardMcpClient();
      const onBlocked = vi.fn();
      const readOnlyServer = new FilteredMCPServer(mock, {
        profile: "READ_ONLY",
        onBlockedToolCall: onBlocked,
      });
      const plannerServer = new FilteredMCPServer(mock, {
        profile: "PLANNER",
      });

      for (const destructiveTool of DESTRUCTIVE_TOOLS) {
        await expect(
          readOnlyServer.callTool({ name: destructiveTool, arguments: { quote_id: "q1" } }),
        ).rejects.toThrowError(ToolNotPermittedError);

        await expect(
          plannerServer.callTool({ name: destructiveTool, arguments: { quote_id: "q1" } }),
        ).rejects.toThrowError(ToolNotPermittedError);
      }

      expect(onBlocked).toHaveBeenCalledTimes(DESTRUCTIVE_TOOLS.length);
    });

    it("rejects builder tools under READ_ONLY but permits them under PLANNER", async () => {
      const mock = new MockStandardMcpClient();
      const readOnlyServer = new FilteredMCPServer(mock, { profile: "READ_ONLY" });
      const plannerServer = new FilteredMCPServer(mock, { profile: "PLANNER" });

      const builderTools = [
        "sera.prepare_swap",
        "sera.withdraw_request",
        "sera.withdraw_build",
        "sera.build_approve",
        "sera.build_deposit",
        "sera.build_transfer",
      ];

      for (const tool of builderTools) {
        await expect(readOnlyServer.callTool({ name: tool, arguments: {} })).rejects.toThrowError(
          ToolNotPermittedError,
        );

        const planRes = (await plannerServer.callTool({
          name: tool,
          arguments: {},
        })) as StandardCallToolResult;
        expect(planRes.content[0].text).toContain(`Executed ${tool}`);
      }
    });

    it("permits all legitimate read-only tools through callTool() under default READ_ONLY profile", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "READ_ONLY" });

      const testTools = [
        "sera.get_balances",
        "sera.search_coins",
        "sera.get_coin_metadata",
        "sera.get_order",
        "sera.list_orders",
        "sera.get_fills",
        "sera.settlement_status",
        "sera.batch_quote",
        "sera.permit_metadata",
        "sera.get_quote",
        "sera.doctor",
      ];

      for (const tool of testTools) {
        const res = (await filtered.callTool({
          name: tool,
          arguments: { param: "test" },
        })) as StandardCallToolResult;
        expect(res.content[0].text).toContain(`Executed ${tool}`);
      }
    });

    it("permits all tools (including destructive) under FULL_EXECUTION profile", async () => {
      const mock = new MockStandardMcpClient();
      const filtered = new FilteredMCPServer(mock, { profile: "FULL_EXECUTION" });

      const swapCall = (await filtered.callTool({
        name: "sera.execute_swap",
        arguments: { quote_id: "q_123" },
      })) as StandardCallToolResult;
      expect(swapCall.content[0].text).toContain("Executed sera.execute_swap");

      const transferCall = (await filtered.callTool({
        name: "sera.send_tx",
        arguments: { raw_tx: "0x123" },
      })) as StandardCallToolResult;
      expect(transferCall.content[0].text).toContain("Executed sera.send_tx");
    });
  });

  describe("OpenAI Agents SDK Compatibility", () => {
    it("handles raw array listTools and positional callTool parameters seamlessly", async () => {
      const mock = new MockOpenAiMcpServer();
      const filtered = new FilteredMCPServer(mock, { profile: "READ_ONLY" });

      const tools = (await filtered.listTools()) as Array<{ name: string }>;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(39);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("sera.get_balances");
      expect(toolNames).toContain("sera.get_quote");
      expect(toolNames).not.toContain("sera.execute_swap");
      expect(toolNames).not.toContain("sera.build_approve");

      const res = (await filtered.callTool("sera.get_balances", {
        owner_address: "0x123",
      })) as Array<{ type: string; text: string }>;
      expect(res[0].text).toContain("Executed positional sera.get_balances");
    });
  });

  describe("createToolFilter static filter generator", () => {
    it("generates static filter matching profile definitions", () => {
      const readOnlyFilter = createToolFilter("READ_ONLY");
      expect(readOnlyFilter.allowedToolNames).toContain("sera.get_balances");
      expect(readOnlyFilter.allowedToolNames).toContain("sera.get_quote");
      expect(readOnlyFilter.allowedToolNames).not.toContain("sera.build_approve");
      expect(readOnlyFilter.blockedToolNames).toContain("sera.execute_swap");
      expect(readOnlyFilter.blockedToolNames).toContain("sera.send_tx");

      const plannerFilter = createToolFilter("PLANNER");
      expect(plannerFilter.allowedToolNames).toContain("sera.build_approve");
      expect(plannerFilter.allowedToolNames).toContain("sera.withdraw_request");
      expect(plannerFilter.blockedToolNames).toContain("sera.execute_swap");
      expect(plannerFilter.blockedToolNames).toContain("sera.cancel_vl_batch");

      const fullExecFilter = createToolFilter("FULL_EXECUTION");
      expect(fullExecFilter.allowedToolNames).toBeUndefined();
      expect(fullExecFilter.blockedToolNames).toEqual([]);
    });
  });

  describe("getToolProfileFromEnv & Conflict Detection", () => {
    it("defaults to READ_ONLY when environment is unset", () => {
      expect(getToolProfileFromEnv()).toBe("READ_ONLY");
    });

    it("parses valid TOOL_PROFILE values case-insensitively", () => {
      process.env.TOOL_PROFILE = "read_only";
      expect(getToolProfileFromEnv()).toBe("READ_ONLY");

      process.env.TOOL_PROFILE = "planner";
      expect(getToolProfileFromEnv()).toBe("PLANNER");

      process.env.TOOL_PROFILE = "FULL_EXECUTION";
      expect(getToolProfileFromEnv()).toBe("FULL_EXECUTION");
    });

    it("handles legacy SERA_ENABLE_EXECUTION_TOOLS=true", () => {
      process.env.SERA_ENABLE_EXECUTION_TOOLS = "true";
      expect(getToolProfileFromEnv()).toBe("FULL_EXECUTION");
    });

    it("detects and throws on conflicting security configuration", () => {
      process.env.TOOL_PROFILE = "READ_ONLY";
      process.env.SERA_ENABLE_EXECUTION_TOOLS = "true";

      expect(() => getToolProfileFromEnv()).toThrowError(
        /Security Configuration Conflict.*SERA_ENABLE_EXECUTION_TOOLS=true conflicts with TOOL_PROFILE=READ_ONLY/,
      );
    });
  });

  describe("Child Process Environment Forwarding (createChildMcpEnv)", () => {
    it("does NOT forward SERA_ENABLE_EXECUTION_TOOLS under READ_ONLY or PLANNER profiles", () => {
      const readOnlyEnv = createChildMcpEnv("READ_ONLY", {
        SERA_NETWORK: "mainnet",
        SERA_SIGNER_MODE: "external",
      });
      expect(readOnlyEnv.SERA_ENABLE_EXECUTION_TOOLS).toBeUndefined();
      expect(readOnlyEnv.SERA_NETWORK).toBe("mainnet");
      expect(readOnlyEnv.SERA_SIGNER_MODE).toBe("external");

      const plannerEnv = createChildMcpEnv("PLANNER", {
        SERA_NETWORK: "base",
      });
      expect(plannerEnv.SERA_ENABLE_EXECUTION_TOOLS).toBeUndefined();
    });

    it("explicitly sets SERA_ENABLE_EXECUTION_TOOLS='true' under FULL_EXECUTION profile", () => {
      const fullExecEnv = createChildMcpEnv("FULL_EXECUTION", {
        SERA_NETWORK: "sepolia",
        SERA_SIGNER_MODE: "local",
      });
      expect(fullExecEnv.SERA_ENABLE_EXECUTION_TOOLS).toBe("true");
      expect(fullExecEnv.SERA_NETWORK).toBe("sepolia");
      expect(fullExecEnv.SERA_SIGNER_MODE).toBe("local");
    });
  });
});
