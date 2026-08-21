/**
 * @fileoverview MCP Tool Filtering & Non-Custodial Execution Gating
 *
 * ARCHITECTURAL CONTEXT & DEFENSE-IN-DEPTH:
 * Model Context Protocol (MCP) servers (such as `sera-mcp`) expose a rich tool
 * surface spanning read-only market discovery, liquidity quotes, unsigned intent preparation,
 * and high-privilege execution operations (like `execute_swap`, `convert_and_send`, `send_tx`,
 * `place_order`, etc.).
 *
 * In webhooks, public chat agents, and automated integrations, untrusted input is processed
 * by LLMs. An attacker can craft prompt-injection payloads to coerce the model into calling
 * state-altering execution tools.
 *
 * This module is self-contained within this template to ensure zero-leakage portability
 * when copying or forking `webhook-agent`. It provides dual-layer protection:
 * 1. Native SDK Filter Generator (`createToolFilter`): Feeds static allowlist/blocklist
 *    rules directly into the framework's native filtering hooks (e.g. OpenAI Agents SDK).
 * 2. Strict Interceptor (`FilteredMCPServer`): A robust wrapper compatible with both standard
 *    `@modelcontextprotocol/sdk` Client interfaces and Agent SDK `MCPServer` implementations.
 *    It intercepts `listTools()` (handling both `{ tools: [...] }` objects and raw arrays)
 *    and `callTool()` (handling both `{ name, arguments }` objects and positional parameters),
 *    throwing a strict `ToolNotPermittedError` before any blocked command reaches the MCP transport.
 */

import type { MCPServer, MCPToolFilterStatic } from "@openai/agents";

/**
 * Interface representing a standard MCP tool descriptor.
 */
export interface StandardMcpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * Standard tool listing response envelope from @modelcontextprotocol/sdk.
 */
export interface StandardListToolsResult {
  tools: StandardMcpTool[];
  nextCursor?: string;
  _meta?: Record<string, unknown>;
}

/**
 * Standard callTool parameter object in @modelcontextprotocol/sdk.
 */
export interface StandardCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Standard tool execution result.
 */
export interface StandardCallToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Supported security profiles for MCP tool availability.
 *
 * - `READ_ONLY`: Strictly informational / market-data queries (quotes, rates, pools).
 * - `PLANNER`: Read-only queries plus route planning and unsigned intent construction.
 * - `FULL_EXECUTION`: Unrestricted tool access. Requires explicit operator confirmation.
 */
export type ToolProfile = "READ_ONLY" | "PLANNER" | "FULL_EXECUTION";

/**
 * Complete canonical list of tools explicitly marked destructive in sera-mcp registry.
 * These tools execute state changes, broadcast on-chain transactions, or move assets.
 */
export const DESTRUCTIVE_TOOLS: readonly string[] = Object.freeze([
  "sera.execute_swap",
  "sera.convert_and_send",
  "sera.withdraw_send",
  "sera.place_order",
  "sera.cancel_order",
  "sera.cancel_all_orders",
  "sera.send_tx",
  "sera.send_transfer",
  "sera.place_vl_batch",
  "sera.cancel_vl_batch",
]);

/**
 * Canonical manifest of all 55 supported tools in the sera-mcp registry.
 * Used for contract testing and drift detection against upstream releases.
 */
export const SERA_MCP_MANIFEST: readonly string[] = Object.freeze([
  // Read-Only & Discovery Tools (39)
  "sera.list_currencies",
  "sera.get_markets",
  "sera.doctor",
  "sera.search_coins",
  "sera.get_coin_metadata",
  "sera.get_coin_history",
  "sera.get_fx_rate",
  "sera.compare_to_external_fx",
  "sera.multi_source_mid",
  "sera.spread_radar",
  "sera.scan_markets",
  "sera.find_deals",
  "sera.maker_quote_ladder",
  "sera.probe_depth",
  "sera.round_trip_cost",
  "sera.infer_book",
  "sera.market_health",
  "sera.fx_quote_diff",
  "sera.compare_corridors",
  "sera.get_quote",
  "sera.quote_recipient_amount",
  "sera.find_cheapest_settlement_path",
  "sera.batch_quote",
  "sera.limit_watcher",
  "sera.get_order",
  "sera.list_orders",
  "sera.get_fills",
  "sera.get_fills_for_order",
  "sera.get_balances",
  "sera.treasury_value",
  "sera.exposure_report",
  "sera.rebalance_plan",
  "sera.pay_invoice",
  "sera.settlement_status",
  "sera.fx_history",
  "sera.fx_volatility",
  "sera.corridor_pnl",
  "sera.verify_signature",
  "sera.permit_metadata",

  // Planning & Unsigned Intent Preparation Tools (6)
  "sera.prepare_swap",
  "sera.withdraw_request",
  "sera.withdraw_build",
  "sera.build_approve",
  "sera.build_deposit",
  "sera.build_transfer",

  // Destructive Execution Tools (10)
  ...DESTRUCTIVE_TOOLS,
]);

/**
 * Policy definitions for each tool profile.
 */
export interface ToolProfileDefinition {
  /** Explicit list of tool names allowed in this profile (if undefined, all non-blocked are allowed). */
  readonly allowedToolNames?: readonly string[];
  /** Explicit list of tool names strictly forbidden in this profile. */
  readonly blockedToolNames: readonly string[];
  /** Security and operational description of the profile. */
  readonly description: string;
}

/**
 * Standard tool profiles and their permission matrices.
 */
export const TOOL_PROFILES: Readonly<Record<ToolProfile, ToolProfileDefinition>> = Object.freeze({
  READ_ONLY: {
    allowedToolNames: [
      "sera.list_currencies",
      "sera.get_markets",
      "sera.doctor",
      "sera.search_coins",
      "sera.get_coin_metadata",
      "sera.get_coin_history",
      "sera.get_fx_rate",
      "sera.compare_to_external_fx",
      "sera.multi_source_mid",
      "sera.spread_radar",
      "sera.scan_markets",
      "sera.find_deals",
      "sera.maker_quote_ladder",
      "sera.probe_depth",
      "sera.round_trip_cost",
      "sera.infer_book",
      "sera.market_health",
      "sera.fx_quote_diff",
      "sera.compare_corridors",
      "sera.get_quote",
      "sera.quote_recipient_amount",
      "sera.find_cheapest_settlement_path",
      "sera.batch_quote",
      "sera.limit_watcher",
      "sera.get_order",
      "sera.list_orders",
      "sera.get_fills",
      "sera.get_fills_for_order",
      "sera.get_balances",
      "sera.treasury_value",
      "sera.exposure_report",
      "sera.rebalance_plan",
      "sera.pay_invoice",
      "sera.settlement_status",
      "sera.fx_history",
      "sera.fx_volatility",
      "sera.corridor_pnl",
      "sera.verify_signature",
      "sera.permit_metadata",
    ],
    blockedToolNames: [...DESTRUCTIVE_TOOLS],
    description:
      "Allows only read-only market discovery, quotes, orders, and treasury queries. Forbids on-chain execution and order placement.",
  },
  PLANNER: {
    allowedToolNames: [
      "sera.list_currencies",
      "sera.get_markets",
      "sera.doctor",
      "sera.search_coins",
      "sera.get_coin_metadata",
      "sera.get_coin_history",
      "sera.get_fx_rate",
      "sera.compare_to_external_fx",
      "sera.multi_source_mid",
      "sera.spread_radar",
      "sera.scan_markets",
      "sera.find_deals",
      "sera.maker_quote_ladder",
      "sera.probe_depth",
      "sera.round_trip_cost",
      "sera.infer_book",
      "sera.market_health",
      "sera.fx_quote_diff",
      "sera.compare_corridors",
      "sera.get_quote",
      "sera.quote_recipient_amount",
      "sera.find_cheapest_settlement_path",
      "sera.batch_quote",
      "sera.limit_watcher",
      "sera.get_order",
      "sera.list_orders",
      "sera.get_fills",
      "sera.get_fills_for_order",
      "sera.get_balances",
      "sera.treasury_value",
      "sera.exposure_report",
      "sera.rebalance_plan",
      "sera.pay_invoice",
      "sera.settlement_status",
      "sera.fx_history",
      "sera.fx_volatility",
      "sera.corridor_pnl",
      "sera.verify_signature",
      "sera.permit_metadata",
      "sera.prepare_swap",
      "sera.withdraw_request",
      "sera.withdraw_build",
      "sera.build_approve",
      "sera.build_deposit",
      "sera.build_transfer",
    ],
    blockedToolNames: [...DESTRUCTIVE_TOOLS],
    description:
      "Allows read-only queries plus route planning and unsigned intent construction. Forbids on-chain execution.",
  },
  FULL_EXECUTION: {
    allowedToolNames: undefined,
    blockedToolNames: [],
    description:
      "Unrestricted tool access including real-money trade execution and withdrawals. Intended for local or staging testing.",
  },
});

/**
 * Strict Security Exception thrown when a forbidden tool is called.
 */
export class ToolNotPermittedError extends Error {
  public readonly toolName: string;
  public readonly activeProfile: ToolProfile;
  public readonly isSecurityRejection = true;

  constructor(toolName: string, activeProfile: ToolProfile) {
    super(
      `[Security Policy Violation] Execution of tool "${toolName}" is forbidden under active profile "${activeProfile}". ` +
        `To execute state-changing operations, explicitly configure TOOL_PROFILE=FULL_EXECUTION and acknowledge the risk.`,
    );
    this.name = "ToolNotPermittedError";
    this.toolName = toolName;
    this.activeProfile = activeProfile;
    Object.setPrototypeOf(this, ToolNotPermittedError.prototype);
  }
}

/**
 * Creates a static MCPToolFilter object for the OpenAI Agents SDK.
 *
 * @param profile The desired security profile.
 * @returns An MCPToolFilterStatic suitable for passing to Agent or MCPServerStdio.
 */
export function createToolFilter(profile: ToolProfile): MCPToolFilterStatic {
  const profileDef = TOOL_PROFILES[profile] ?? TOOL_PROFILES.READ_ONLY;
  return {
    allowedToolNames: profileDef.allowedToolNames ? [...profileDef.allowedToolNames] : undefined,
    blockedToolNames: [...profileDef.blockedToolNames],
  };
}

/**
 * Options for configuring the FilteredMCPServer.
 */
export interface FilteredMCPServerOptions {
  /** Active profile name. Defaults to "READ_ONLY". */
  profile?: ToolProfile;
  /** Explicit allowed tool override (takes precedence over profile). */
  allowedTools?: string[];
  /** Explicit denied tool override (appended to profile blocklist). */
  deniedTools?: string[];
  /** Security audit hook invoked when a blocked tool is attempted. */
  onBlockedToolCall?: (
    toolName: string,
    args: Record<string, unknown> | null,
    error: ToolNotPermittedError,
  ) => void;
}

/**
 * Protocol-safe Filtered MCP Server Wrapper.
 *
 * Wraps either an `@openai/agents` `MCPServer` or standard `@modelcontextprotocol/sdk` `Client`.
 * Intercepts:
 * - `listTools()`: Strips forbidden tools from discovery. Supports both `{ tools: [...] }` envelopes
 *   and raw tool arrays without breaking pagination metadata.
 * - `callTool()`: Validates tool invocation policy before delegating to the transport,
 *   throwing a strict `ToolNotPermittedError` on any unauthorized attempt.
 */
export class FilteredMCPServer implements MCPServer {
  private readonly underlying: any;
  private readonly profile: ToolProfile;
  private readonly allowedSet: Set<string> | null;
  private readonly deniedSet: Set<string>;
  private readonly onBlockedToolCall?: (
    toolName: string,
    args: Record<string, unknown> | null,
    error: ToolNotPermittedError,
  ) => void;

  public cacheToolsList = true;
  public toolFilter?: MCPToolFilterStatic;

  constructor(underlyingClientOrServer: any, options: FilteredMCPServerOptions = {}) {
    this.underlying = underlyingClientOrServer;
    this.profile = options.profile ?? "READ_ONLY";
    const profileDef = TOOL_PROFILES[this.profile] ?? TOOL_PROFILES.READ_ONLY;

    if (options.allowedTools) {
      this.allowedSet = new Set(options.allowedTools);
    } else if (profileDef.allowedToolNames) {
      this.allowedSet = new Set(profileDef.allowedToolNames);
    } else {
      this.allowedSet = null;
    }

    const combinedDenied = new Set<string>(profileDef.blockedToolNames);
    if (options.deniedTools) {
      for (const d of options.deniedTools) combinedDenied.add(d);
    }
    this.deniedSet = combinedDenied;

    this.onBlockedToolCall = options.onBlockedToolCall;
    this.cacheToolsList = this.underlying?.cacheToolsList ?? true;
    this.toolFilter = createToolFilter(this.profile);
  }

  get name(): string {
    return this.underlying?.name ?? "sera";
  }

  get activeProfile(): ToolProfile {
    return this.profile;
  }

  public async connect(): Promise<void> {
    if (typeof this.underlying?.connect === "function") {
      return this.underlying.connect();
    }
  }

  public async close(): Promise<void> {
    if (typeof this.underlying?.close === "function") {
      return this.underlying.close();
    }
  }

  public async invalidateToolsCache(): Promise<void> {
    if (typeof this.underlying?.invalidateToolsCache === "function") {
      return this.underlying.invalidateToolsCache();
    }
  }

  /**
   * Evaluates whether a given tool is permitted under the active policy.
   *
   * @param toolName The name of the tool (e.g. "sera.execute_swap").
   * @returns true if allowed, false if blocked.
   */
  public isToolPermitted(toolName: string): boolean {
    if (this.deniedSet.has(toolName)) {
      return false;
    }
    if (this.allowedSet !== null && !this.allowedSet.has(toolName)) {
      return false;
    }
    return true;
  }

  /**
   * Intercepts `listTools` to return only policy-permitted tools.
   * Preserves standard pagination envelopes ({ tools: [...], nextCursor: ... }).
   */
  public async listTools(params?: { cursor?: string }): Promise<any> {
    const rawResult = await this.underlying.listTools(params);

    // Standard MCP SDK Envelope: { tools: Tool[], nextCursor?: string }
    if (rawResult && typeof rawResult === "object" && Array.isArray(rawResult.tools)) {
      const filteredTools = rawResult.tools.filter((t: { name: string }) =>
        this.isToolPermitted(t.name),
      );
      return {
        ...rawResult,
        tools: filteredTools,
      };
    }

    // OpenAI Agents SDK Envelope: raw Tool[]
    if (Array.isArray(rawResult)) {
      return rawResult.filter((t: { name: string }) => this.isToolPermitted(t.name));
    }

    return rawResult;
  }

  /**
   * Intercepts `callTool` to strictly enforce policy at execution time.
   * Handles both object parameter signatures and positional parameter signatures.
   */
  public async callTool(
    toolNameOrParams: string | StandardCallToolParams,
    maybeArgs?: Record<string, unknown> | null,
  ): Promise<any> {
    const isObjectParam = typeof toolNameOrParams === "object" && toolNameOrParams !== null;
    const toolName = isObjectParam ? toolNameOrParams.name : toolNameOrParams;
    const args = isObjectParam ? (toolNameOrParams.arguments ?? null) : (maybeArgs ?? null);

    if (!this.isToolPermitted(toolName)) {
      const error = new ToolNotPermittedError(toolName, this.profile);
      if (this.onBlockedToolCall) {
        this.onBlockedToolCall(toolName, args, error);
      }
      throw error;
    }

    if (typeof this.underlying?.callTool === "function") {
      if (isObjectParam) {
        return this.underlying.callTool(toolNameOrParams);
      }
      return this.underlying.callTool(toolName, args);
    }

    throw new Error(`Underlying client does not support callTool`);
  }
}

/**
 * Resolves the active tool profile from environment variables.
 *
 * Reads `TOOL_PROFILE` (case-insensitive: "read_only", "planner", "full_execution").
 * Defaults to `READ_ONLY` for defense-in-depth unless explicitly configured.
 *
 * Conflicting configurations (e.g. `SERA_ENABLE_EXECUTION_TOOLS=true` with `TOOL_PROFILE=READ_ONLY`)
 * throw an Error to fail fast at startup and prevent ambiguous privilege states.
 *
 * @returns The resolved `ToolProfile`.
 */
export function getToolProfileFromEnv(): ToolProfile {
  const rawProfile = process.env.TOOL_PROFILE?.toUpperCase().replace(/-/g, "_").trim();
  const rawExecFlag = process.env.SERA_ENABLE_EXECUTION_TOOLS?.toLowerCase().trim();

  // Detect and reject conflicting security configuration
  if (rawExecFlag === "true" && rawProfile && rawProfile !== "FULL_EXECUTION") {
    throw new Error(
      `[Security Configuration Conflict] SERA_ENABLE_EXECUTION_TOOLS=true conflicts with TOOL_PROFILE=${rawProfile}. ` +
        `Explicitly set TOOL_PROFILE=FULL_EXECUTION or remove SERA_ENABLE_EXECUTION_TOOLS to avoid ambiguous privilege states.`,
    );
  }

  if (rawProfile === "READ_ONLY" || rawProfile === "PLANNER" || rawProfile === "FULL_EXECUTION") {
    return rawProfile;
  }

  if (rawExecFlag === "true") {
    return "FULL_EXECUTION";
  }

  return "READ_ONLY";
}

/**
 * Constructs the environment dictionary forwarded to the child `sera-mcp` subprocess.
 *
 * Ensures `SERA_ENABLE_EXECUTION_TOOLS="true"` is explicitly set when `FULL_EXECUTION`
 * is active, and forwards `SERA_SIGNER_MODE` if present.
 *
 * @param toolProfile Active ToolProfile.
 * @param baseEnv Base environment dictionary (defaults to process.env).
 * @returns Fully populated child environment dictionary.
 */
export function createChildMcpEnv(
  toolProfile: ToolProfile,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const childEnv: Record<string, string> = {
    SERA_NETWORK: baseEnv.SERA_NETWORK ?? "mainnet",
    POLICY_PRESET: baseEnv.POLICY_PRESET ?? "standard",
    LOG_LEVEL: baseEnv.LOG_LEVEL ?? "warn",
    ...(baseEnv.SERA_API_KEY ? { SERA_API_KEY: baseEnv.SERA_API_KEY } : {}),
    ...(baseEnv.SERA_API_SECRET ? { SERA_API_SECRET: baseEnv.SERA_API_SECRET } : {}),
    ...(baseEnv.SERA_SIGNER_MODE ? { SERA_SIGNER_MODE: baseEnv.SERA_SIGNER_MODE } : {}),
  };

  if (toolProfile === "FULL_EXECUTION") {
    childEnv.SERA_ENABLE_EXECUTION_TOOLS = "true";
  }

  return childEnv;
}
