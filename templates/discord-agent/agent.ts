/**
 * Template: Discord Bot AI Agent.
 *
 * A state-of-the-art conversational Discord agent powered by the Sera MCP.
 * Implements conversational mentions, private DMs, automated typing states,
 * in-memory rate limiting, concurrency cap slots, and premium embeds for financial summaries.
 * All functions are encapsulated in a single file per repository template conventions.
 */
import "dotenv/config";
import { Agent, assistant, MCPServerStdio, run, user } from "@openai/agents";
import {
  ActivityType,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  type MessageReplyOptions,
  Partials,
  type TextBasedChannel,
} from "discord.js";

// ── 1. LOGGING & UTILITIES ───────────────────────────────────────────────────
export function logEvent(event: string, meta: Record<string, unknown> = {}) {
  const logObj = {
    timestamp: new Date().toISOString(),
    event,
    ...meta,
  };
  console.log(JSON.stringify(logObj));
}

// ── 2. CONFIGURATION ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a multi-currency settlement assistant powered by the Sera MCP. You have
tools covering stablecoin discovery, FX rates, quotes, swaps, treasury
management, deal scanning, and more.

Operating principles:
- Always use sera.* tools rather than guessing values from training data.
- Do not execute swaps unless explicitly told.
- Quote prices via sera.get_quote, never via sera.get_fx_rate.
- Default to simulate:true on get_quote when the user is exploring.
- For execution, return the route_params + uuid. Format structured outputs (quotes, balances, built transactions) as standard JSON blocks within \`\`\`json ... \`\`\` so the bot can format them into premium Discord embeds.
- Be concise. Show numbers with sensible precision. Skip filler.
- NEVER mention @everyone, @here, or any user/role by ID. Output plain text names only.
`.trim();

// Cached regular expressions to avoid dynamic compilation overhead
const JSON_BLOCK_REGEX = /```json\s*([\s\S]*?)\s*```/;
let mentionRegex: RegExp;

/** Safe reply options that suppress all Discord mentions from LLM output. */
export const SAFE_REPLY_OPTIONS: Pick<MessageReplyOptions, "allowedMentions"> = {
  allowedMentions: { parse: [], repliedUser: false },
};

/** Build reply options that strictly suppress all mention parsing. */
export function toSafeReplyOptions(content: string | MessageReplyOptions): MessageReplyOptions {
  if (typeof content === "string") {
    return { content, ...SAFE_REPLY_OPTIONS };
  }
  return { ...content, ...SAFE_REPLY_OPTIONS };
}

/** Send a safe reply that suppresses all mention parsing. */
export async function safeReply(
  message: { reply: (options: MessageReplyOptions) => Promise<unknown> },
  content: string | MessageReplyOptions,
): Promise<unknown> {
  return message.reply(toSafeReplyOptions(content));
}

// ── 3. AUTHORIZATION BOUNDARIES ──────────────────────────────────────────────

/**
 * Parse a comma-separated environment variable into a Set.
 * Returns null if the variable is unset or empty (meaning "no restriction").
 */
export function parseAllowlist(envValue: string | undefined): Set<string> | null {
  if (!envValue || envValue.trim() === "") return null;
  const ids = envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

export interface AuthConfig {
  allowedUsers: Set<string> | null;
  allowedGuilds: Set<string> | null;
  allowedChannels: Set<string> | null;
  allowDMs: boolean;
  publicModeAck: boolean;
}

export function loadAuthConfig(): AuthConfig {
  return {
    allowedUsers: parseAllowlist(process.env.DISCORD_ALLOWED_USER_IDS),
    allowedGuilds: parseAllowlist(process.env.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannels: parseAllowlist(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
    allowDMs: process.env.DISCORD_ALLOW_DMS === "true",
    publicModeAck: process.env.DISCORD_PUBLIC_MODE_ACK === "true",
  };
}

export interface AuthContext {
  userId: string;
  guildId: string | null;
  channelId: string;
  /** For threads, the parent channel ID; otherwise same as channelId. */
  parentChannelId: string | null;
  isDM: boolean;
}

/**
 * Check whether a message is authorized. Returns null if allowed,
 * or a reason string if denied (fail-closed).
 */
export function checkAuthorization(config: AuthConfig, ctx: AuthContext): string | null {
  // DM authorization
  if (ctx.isDM) {
    if (!config.allowDMs) {
      return "dm_disabled";
    }
    // DMs always require a user allowlist — guild/channel allowlists cannot protect DMs
    if (!config.allowedUsers) {
      return "dm_requires_user_allowlist";
    }
    if (!config.allowedUsers.has(ctx.userId)) {
      return "user_not_allowed";
    }
    return null;
  }

  // Guild authorization
  if (config.allowedGuilds && ctx.guildId && !config.allowedGuilds.has(ctx.guildId)) {
    return "guild_not_allowed";
  }

  // Channel authorization — for threads, check the parent channel ID
  if (config.allowedChannels) {
    const effectiveChannelId = ctx.parentChannelId ?? ctx.channelId;
    if (!config.allowedChannels.has(effectiveChannelId)) {
      return "channel_not_allowed";
    }
  }

  // User authorization
  if (config.allowedUsers && !config.allowedUsers.has(ctx.userId)) {
    return "user_not_allowed";
  }

  return null;
}

/**
 * Check whether a historical message author is authorized to have their
 * content included in the agent context. Used to filter thread/channel
 * history to prevent unauthorized users from injecting context.
 */
export function isAuthorAuthorized(config: AuthConfig, authorId: string): boolean {
  if (!config.allowedUsers) return true;
  return config.allowedUsers.has(authorId);
}

// ── 4. IN-MEMORY RATE LIMITING ───────────────────────────────────────────────
export const rateLimits = new Map<string, { count: number; start: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
/** Interval between stale-entry eviction sweeps. */
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(userId);
  if (!limit || now - limit.start > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(userId, { count: 1, start: now });
    return false;
  }
  limit.count++;
  return limit.count > RATE_LIMIT_MAX_REQUESTS;
}

/**
 * Evict rate-limit entries whose window has expired.
 * Prevents unbounded Map growth from inactive users.
 */
export function evictStaleRateLimits(): number {
  const now = Date.now();
  let evicted = 0;
  for (const [userId, entry] of rateLimits) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(userId);
      evicted++;
    }
  }
  return evicted;
}

// ── 5. CONCURRENCY SLOTS ─────────────────────────────────────────────────────

/**
 * Parse and validate the concurrency cap from an environment variable.
 * Returns a safe positive integer, falling back to the provided default
 * when the input is missing, non-numeric, or non-positive.
 */
export function parseMaxConcurrent(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    logEvent("invalid_max_concurrent", {
      raw,
      reason: "Non-numeric, non-positive, or non-integer value; using default",
      fallback,
    });
    return fallback;
  }
  return parsed;
}

const MAX_CONCURRENT = parseMaxConcurrent(process.env.DISCORD_MAX_CONCURRENT, 4);
let activeRuns = 0;

async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeRuns >= MAX_CONCURRENT) return null;
  activeRuns++;
  try {
    return await fn();
  } finally {
    activeRuns--;
  }
}

// ── 6. UX HELPERS ────────────────────────────────────────────────────────────
export function splitMessage(text: string, maxLength: number = 2000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let cur = text;
  while (cur.length > 0) {
    if (cur.length <= maxLength) {
      chunks.push(cur);
      break;
    }
    let splitIdx = cur.lastIndexOf("\n", maxLength);
    if (splitIdx === -1) splitIdx = cur.lastIndexOf(" ", maxLength);
    if (splitIdx === -1) splitIdx = maxLength;
    chunks.push(cur.substring(0, splitIdx));
    cur = cur.substring(splitIdx).trim();
  }
  return chunks;
}

export function tryFormatEmbed(text: string): { embed: EmbedBuilder | null; cleanText: string } {
  const match = text.match(JSON_BLOCK_REGEX);
  if (!match) return { embed: null, cleanText: text };

  try {
    const data = JSON.parse(match[1].trim());
    const isQuote = data.quote_uuid || data.uuid || data.rate_params;
    const isBalance = Array.isArray(data.balances) || data.assets || data.holdings;

    if (isQuote || isBalance) {
      const embed = new EmbedBuilder().setColor(0x00ffcc).setTimestamp();

      if (isQuote) {
        embed.setTitle("Sera Settlement Quote / Deal Details");
        if (data.source_asset || data.from_asset) {
          embed.addFields({
            name: "Source Asset",
            value: String(data.source_asset || data.from_asset),
            inline: true,
          });
        }
        if (data.destination_asset || data.to_asset) {
          embed.addFields({
            name: "Destination Asset",
            value: String(data.destination_asset || data.to_asset),
            inline: true,
          });
        }
        if (data.source_amount || data.from_amount) {
          embed.addFields({
            name: "Source Amount",
            value: String(data.source_amount || data.from_amount),
            inline: true,
          });
        }
        if (data.destination_amount || data.to_amount) {
          embed.addFields({
            name: "Destination Amount",
            value: String(data.destination_amount || data.to_amount),
            inline: true,
          });
        }
        if (data.rate || data.fx_rate) {
          embed.addFields({
            name: "FX Rate",
            value: String(data.rate || data.fx_rate),
            inline: true,
          });
        }
        if (data.quote_uuid || data.uuid) {
          embed.addFields({
            name: "Quote UUID",
            value: `\`${data.quote_uuid || data.uuid}\``,
            inline: false,
          });
        }
        if (data.route_params) {
          embed.addFields({
            name: "Signing Parameters",
            value: "Copy route params to perform local client-side signing.",
            inline: false,
          });
        }
      } else {
        embed.setTitle("Sera Account Balances");
        const list = Array.isArray(data.balances) ? data.balances : data.assets || [];
        for (const item of list.slice(0, 12)) {
          const asset = item.asset || item.token || item.name || "Unknown";
          const amount = item.amount || item.balance || "0";
          embed.addFields({ name: asset, value: String(amount), inline: true });
        }
      }

      const cleanText = text.replace(JSON_BLOCK_REGEX, "").trim();
      return { embed, cleanText };
    }
  } catch {
    // Graceful fallback to text on parsing failure
  }

  return { embed: null, cleanText: text };
}

// ── 7. BOOTSTRAP MAIN LOOP ───────────────────────────────────────────────────
async function main() {
  const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const seraMcpPath = process.env.SERA_MCP_DIST;

  if (!DISCORD_TOKEN || DISCORD_TOKEN === "your-discord-bot-token-here") {
    logEvent("startup_failed", { reason: "DISCORD_TOKEN is missing or placeholder" });
    process.exit(1);
    throw new Error("DISCORD_TOKEN is required");
  }
  if (!OPENAI_API_KEY || OPENAI_API_KEY === "sk-proj-your-openai-api-key-here") {
    logEvent("startup_failed", { reason: "OPENAI_API_KEY is missing or placeholder" });
    process.exit(1);
    throw new Error("OPENAI_API_KEY is required");
  }
  if (!seraMcpPath || seraMcpPath === "path-to-sera-mcp-dist-index-js") {
    logEvent("startup_failed", {
      reason:
        "SERA_MCP_DIST environment variable is required to point to the built sera-mcp server (e.g. /path/to/sera-mcp/dist/index.js)",
    });
    process.exit(1);
    throw new Error("SERA_MCP_DIST is required");
  }

  // Load authorization config
  const authConfig = loadAuthConfig();

  // Require at least one authorization boundary unconditionally.
  // Without an allowlist, any Discord user who can mention or DM the bot can
  // consume the operator's OpenAI quota and (if configured) Sera API resources.
  // Operators who intentionally want a public bot must opt in explicitly.
  const hasAnyAllowlist =
    authConfig.allowedUsers !== null ||
    authConfig.allowedGuilds !== null ||
    authConfig.allowedChannels !== null;

  if (!hasAnyAllowlist && !authConfig.publicModeAck) {
    logEvent("startup_failed", {
      reason:
        "No authorization allowlist is configured. Any Discord user who can mention or DM " +
        "the bot can consume the operator's OpenAI quota. Set at least one of " +
        "DISCORD_ALLOWED_USER_IDS, DISCORD_ALLOWED_GUILD_IDS, or DISCORD_ALLOWED_CHANNEL_IDS " +
        "to restrict access. If a fully public bot is intentional, set " +
        "DISCORD_PUBLIC_MODE_ACK=true to acknowledge this.",
    });
    process.exit(1);
  }

  // When DMs are enabled, a user allowlist is mandatory to prevent any
  // Discord user from privately consuming resources.
  if (authConfig.allowDMs && !authConfig.allowedUsers) {
    logEvent("startup_failed", {
      reason:
        "DISCORD_ALLOW_DMS=true requires DISCORD_ALLOWED_USER_IDS to be set. " +
        "Guild and channel allowlists cannot protect DM interactions.",
    });
    process.exit(1);
  }

  logEvent("startup", {
    mcpPath: seraMcpPath,
    network: process.env.SERA_NETWORK ?? "mainnet",
    maxConcurrent: MAX_CONCURRENT,
    allowDMs: authConfig.allowDMs,
    hasUserAllowlist: authConfig.allowedUsers !== null,
    hasGuildAllowlist: authConfig.allowedGuilds !== null,
    hasChannelAllowlist: authConfig.allowedChannels !== null,
    // Note: rate limiting is per-process and can be bypassed using multiple accounts.
    rateLimitNote: "per-process; bypassable via multiple Discord accounts",
  });

  // Setup MCP Subprocess stdio daemon
  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      SERA_ENABLE_EXECUTION_TOOLS: "false",
      SERA_SIGNER_MODE: "external",
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
    },
    name: "sera",
  });

  try {
    await sera.connect();
    logEvent("mcp_connected");
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logEvent("mcp_connection_failed", { error: errorMsg });
    process.exit(1);
  }

  // Build OpenAI Agent
  const agent = new Agent({
    name: "Sera Discord Agent",
    instructions: SYSTEM_PROMPT,
    mcpServers: [sera],
  });

  // Build Discord Client with minimal needed intents and channel partials
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // Start periodic rate-limit cleanup
  const rateLimitCleanupTimer = setInterval(() => {
    const evicted = evictStaleRateLimits();
    if (evicted > 0) {
      logEvent("rate_limit_cleanup", { evicted });
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);

  // Dynamic context history retriever — scoped to prevent cross-user context bleed
  async function fetchHistory(
    channel: TextBasedChannel,
    authorId: string,
    botUserId: string,
    historyAuthConfig: AuthConfig,
    limit = 15,
    excludeMessageId?: string,
  ): Promise<Array<ReturnType<typeof user> | ReturnType<typeof assistant>>> {
    try {
      const messages = await channel.messages.fetch({ limit });
      const sorted = [...messages.values()].reverse();
      const mapped: Array<ReturnType<typeof user> | ReturnType<typeof assistant>> = [];

      const isDM = channel.type === ChannelType.DM;
      const isThread = channel.isThread();

      // Build a Set of message IDs authored by the current user for reference checking
      const currentUserMessageIds = new Set<string>();
      for (const msg of sorted) {
        if (msg.author.id === authorId) {
          currentUserMessageIds.add(msg.id);
        }
      }

      for (const msg of sorted) {
        if (excludeMessageId && msg.id === excludeMessageId) {
          continue;
        }
        if (msg.author.bot) {
          if (msg.author.id === botUserId) {
            // Only include bot messages that were direct replies to the current user.
            // This prevents cross-user context bleed in public channels and threads.
            if (!isDM) {
              const replyToId = msg.reference?.messageId;
              if (!replyToId || !currentUserMessageIds.has(replyToId)) {
                continue;
              }
            }

            let content = msg.content || "";
            if (msg.embeds.length > 0) {
              for (const embed of msg.embeds) {
                content += `\n[Embed Summary: ${embed.title ?? ""}\n`;
                for (const field of embed.fields) {
                  content += `${field.name}: ${field.value}\n`;
                }
                content += "]";
              }
            }
            if (content.trim()) {
              mapped.push(assistant(content.trim()));
            }
          }
        } else {
          // In DMs, include all user messages. In channels and threads,
          // only include messages from the invoking user. Additionally,
          // in threads, validate that non-self authors pass the authorization
          // policy to prevent unauthorized users from injecting context.
          if (!isDM) {
            if (msg.author.id !== authorId) {
              continue;
            }
            // Even for the invoking user's own messages in threads,
            // verify they pass the user allowlist (they should, since
            // we already checked the invoking user, but defense-in-depth)
            if (isThread && !isAuthorAuthorized(historyAuthConfig, msg.author.id)) {
              continue;
            }
          }

          const cleanText = msg.content.replace(mentionRegex, "").trim();
          if (cleanText) {
            mapped.push(user(cleanText));
          }
        }
      }
      return mapped;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent("history_fetch_failed", { error: errorMsg });
      return [];
    }
  }

  // Gateway Ready Handlers
  client.once("ready", async () => {
    logEvent("discord_login", { tag: client.user?.tag });

    // Precompile mention regex once client identity is verified
    mentionRegex = new RegExp(`<@!?${client.user?.id}>`, "g");

    // Register /help Slash Command
    const data = {
      name: "help",
      description: "Show instructions for using the Sera AI Agent",
    };

    try {
      if (process.env.DISCORD_GUILD_ID) {
        const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (guild) {
          await guild.commands.set([data]);
          logEvent("guild_commands_registered", { guildId: process.env.DISCORD_GUILD_ID });
        }
      } else {
        await client.application?.commands.set([data]);
        logEvent("global_commands_registered");
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent("commands_registration_failed", { error: errorMsg });
    }

    client.user?.setActivity("Sera Multi-Currency", { type: ActivityType.Watching });
  });

  // Interaction handlers (Slash Command /help)
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "help") {
      logEvent("incoming_interaction", {
        type: "slash_command",
        command: "help",
        authorId: interaction.user.id,
      });

      await interaction.reply({
        content:
          "**Sera AI Agent Guide**\n\n" +
          "I am a conversational agent powered by the Sera Model Context Protocol.\n" +
          "• **Conversational Mentions:** Tag me in any channel (e.g. `@SeraAgent exchange 100 USDC to SGD`).\n" +
          "• **Direct Messages (DMs):** Direct message me to perform private queries (checking balances or quotes).\n\n" +
          "*Note: For conversational queries, please mention me directly rather than running slash commands.*",
        ephemeral: true,
      });
    }
  });

  // Mentions and DM conversations listener
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isMentioned = message.mentions.has(client.user?.id || "");

    if (!isDM && !isMentioned) return;

    // For threads, resolve the parent channel ID so channel allowlists
    // apply to the parent channel rather than the thread ID.
    const parentChannelId =
      !isDM && message.channel.isThread() ? (message.channel.parentId ?? null) : null;

    const authCtx: AuthContext = {
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channel.id,
      parentChannelId,
      isDM,
    };

    // Authorization check — fail-closed
    const authDenied = checkAuthorization(authConfig, authCtx);
    if (authDenied) {
      logEvent("authorization_denied", {
        reason: authDenied,
        authorId: message.author.id,
        guildId: message.guildId,
        channelId: message.channel.id,
        isDM,
      });
      // Silent reject — do not reveal authorization boundaries to unauthorized users
      return;
    }

    logEvent("incoming_interaction", {
      type: "message",
      authorId: message.author.id,
      isDM,
      channelId: message.channel.id,
    });

    const userPrompt = message.content.replace(mentionRegex, "").trim();

    if (userPrompt.length === 0 && !isDM) {
      logEvent("empty_mention_warning", { authorId: message.author.id });
      await safeReply(
        message,
        "I received your mention, but the message content was blank. " +
          "Please check that the bot has **Message Content Intent** enabled in the Discord Developer Portal.",
      );
      return;
    }

    // Rate limiter
    if (isRateLimited(message.author.id)) {
      logEvent("rate_limit_exceeded", { authorId: message.author.id });
      await safeReply(
        message,
        "You are sending messages too quickly! Please wait a moment before trying again.",
      );
      return;
    }

    // Acquire concurrency slot
    const slotAcquired = await withSlot(async () => {
      const startExecution = Date.now();
      logEvent("agent_execution_start", {
        authorId: message.author.id,
        channelId: message.channel.id,
      });

      // Trigger typing state feedback
      await message.channel.sendTyping();

      try {
        // Reconstruct Context: threads/DMs fetch recent history, standard channels fetch only current user history
        const botUserId = client.user?.id ?? "";
        const history = await fetchHistory(
          message.channel,
          message.author.id,
          botUserId,
          authConfig,
          15,
          message.id,
        );

        // Ensure the current user prompt is included in the history for this execution run
        history.push(user(userPrompt));

        // Execute Agent loop
        const result = await run(agent, history);
        const output = result.finalOutput ?? "";

        // Extract JSON and render Embed cards if matches financial output
        const { embed, cleanText } = tryFormatEmbed(output);

        // Split responses if exceeding Discord limits
        const messageChunks = splitMessage(cleanText);

        // Send standard text chunks with mention safety
        for (let i = 0; i < messageChunks.length; i++) {
          const text = messageChunks[i];
          if (text) {
            await safeReply(message, text);
          }
        }

        // Send the embed card if present, with mention safety
        if (embed) {
          await safeReply(message, { embeds: [embed] });
        }

        const durationMs = Date.now() - startExecution;
        logEvent("agent_execution_complete", {
          authorId: message.author.id,
          durationMs,
          status: "success",
        });
      } catch (err: unknown) {
        const durationMs = Date.now() - startExecution;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logEvent("agent_execution_failed", {
          authorId: message.author.id,
          durationMs,
          error: errorMsg,
        });
        await safeReply(
          message,
          "Sorry, an error occurred while processing your request. Please try again later.",
        );
      }
    });

    if (slotAcquired === null) {
      logEvent("concurrency_slot_unavailable", { authorId: message.author.id });
      await safeReply(
        message,
        "I am currently busy handling other requests. Please try again in a few seconds.",
      );
    }
  });

  // Graceful shutdown procedures
  const shutdown = async (signal: string) => {
    logEvent("shutdown", { signal });
    clearInterval(rateLimitCleanupTimer);
    try {
      await sera.close();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent("mcp_disconnect_failed", { error: errorMsg });
    }
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Log in to Discord
  try {
    await client.login(DISCORD_TOKEN);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logEvent("discord_login_failed", { error: errorMsg });
    process.exit(1);
  }
}

// Only run when this file is the entry point (not when imported by tests)
const isMainModule =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").replace(/^(?!\/)/, "/"));

if (isMainModule || process.env.SERA_RUN_MAIN === "true") {
  main().catch((err: unknown) => {
    logEvent("fatal_startup_error", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
