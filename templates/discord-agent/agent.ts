/**
 * Template: Discord Bot AI Agent.
 *
 * A state-of-the-art conversational Discord agent powered by the Sera MCP.
 * Implements conversational mentions, private DMs, automated typing states,
 * in-memory rate limiting, concurrency cap slots, and premium embeds for financial summaries.
 * All functions are encapsulated in a single file per repository template conventions.
 */
import { Agent, run, MCPServerStdio, user, assistant } from "@openai/agents";
import { Client, GatewayIntentBits, Partials, EmbedBuilder, ChannelType, ActivityType } from "discord.js";

// ── 1. LOGGING & UTILITIES ───────────────────────────────────────────────────
function logEvent(event: string, meta: Record<string, unknown> = {}) {
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
`.trim();

// Cached regular expressions to avoid dynamic compilation overhead
const JSON_BLOCK_REGEX = /```json\s*([\s\S]*?)\s*```/;
let mentionRegex: RegExp;

// ── 3. IN-MEMORY RATE LIMITING ───────────────────────────────────────────────
const rateLimits = new Map<string, { count: number; start: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(userId);
  if (!limit || (now - limit.start) > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(userId, { count: 1, start: now });
    return false;
  }
  limit.count++;
  return limit.count > RATE_LIMIT_MAX_REQUESTS;
}

// ── 4. CONCURRENCY SLOTS ─────────────────────────────────────────────────────
const MAX_CONCURRENT = Number(process.env.DISCORD_MAX_CONCURRENT ?? 4);
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

// ── 5. UX HELPERS ────────────────────────────────────────────────────────────
function splitMessage(text: string, maxLength: number = 2000): string[] {
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

function tryFormatEmbed(text: string): { embed: EmbedBuilder | null; cleanText: string } {
  const match = text.match(JSON_BLOCK_REGEX);
  if (!match) return { embed: null, cleanText: text };

  try {
    const data = JSON.parse(match[1].trim());
    const isQuote = data.quote_uuid || data.uuid || data.rate_params;
    const isBalance = Array.isArray(data.balances) || data.assets || data.holdings;

    if (isQuote || isBalance) {
      const embed = new EmbedBuilder()
        .setColor(0x00ffcc)
        .setTimestamp();

      if (isQuote) {
        embed.setTitle("Sera Settlement Quote / Deal Details");
        if (data.source_asset || data.from_asset) {
          embed.addFields({ name: "Source Asset", value: String(data.source_asset || data.from_asset), inline: true });
        }
        if (data.destination_asset || data.to_asset) {
          embed.addFields({ name: "Destination Asset", value: String(data.destination_asset || data.to_asset), inline: true });
        }
        if (data.source_amount || data.from_amount) {
          embed.addFields({ name: "Source Amount", value: String(data.source_amount || data.from_amount), inline: true });
        }
        if (data.destination_amount || data.to_amount) {
          embed.addFields({ name: "Destination Amount", value: String(data.destination_amount || data.to_amount), inline: true });
        }
        if (data.rate || data.fx_rate) {
          embed.addFields({ name: "FX Rate", value: String(data.rate || data.fx_rate), inline: true });
        }
        if (data.quote_uuid || data.uuid) {
          embed.addFields({ name: "Quote UUID", value: `\`${data.quote_uuid || data.uuid}\``, inline: false });
        }
        if (data.route_params) {
          embed.addFields({ name: "Signing Parameters", value: "Copy route params to perform local client-side signing.", inline: false });
        }
      } else {
        embed.setTitle("Sera Account Balances");
        const list = Array.isArray(data.balances) ? data.balances : (data.assets || []);
        for (const item of list.slice(0, 12)) {
          const asset = item.asset || item.token || item.name || "Unknown";
          const amount = item.amount || item.balance || "0";
          embed.addFields({ name: asset, value: String(amount), inline: true });
        }
      }

      const cleanText = text.replace(JSON_BLOCK_REGEX, "").trim();
      return { embed, cleanText };
    }
  } catch (err) {
    // Graceful fallback to text on parsing failure
  }

  return { embed: null, cleanText: text };
}

// ── 6. BOOTSTRAP MAIN LOOP ───────────────────────────────────────────────────
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
    logEvent("startup_failed", { reason: "SERA_MCP_DIST environment variable is required to point to the built sera-mcp server (e.g. /path/to/sera-mcp/dist/index.js)" });
    process.exit(1);
    throw new Error("SERA_MCP_DIST is required");
  }

  logEvent("startup", {
    mcpPath: seraMcpPath,
    network: process.env.SERA_NETWORK ?? "mainnet",
    maxConcurrent: MAX_CONCURRENT,
  });

  // Setup MCP Subprocess stdio daemon
  const sera = new MCPServerStdio({
    command: "node",
    args: [seraMcpPath],
    env: {
      SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
      POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
      ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
    },
    name: "sera",
  });

  try {
    await sera.connect();
    logEvent("mcp_connected");
  } catch (err: any) {
    logEvent("mcp_connection_failed", { error: err.message });
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

  // Dynamic context history retriever
  async function fetchHistory(channel: any, authorId: string, limit: number = 15, excludeMessageId?: string): Promise<any[]> {
    try {
      const messages = await channel.messages.fetch({ limit });
      const sorted = [...messages.values()].reverse();
      const mapped: any[] = [];

      const isDM = channel.type === ChannelType.DM;
      const isThread = channel.isThread();

      for (const msg of sorted) {
        if (excludeMessageId && msg.id === excludeMessageId) {
          continue;
        }
        if (msg.author.bot) {
          if (msg.author.id === client.user?.id) {
            let content = msg.content || "";
            if (msg.embeds.length > 0) {
              for (const embed of msg.embeds) {
                content += `\n[Embed Summary: ${embed.title ?? ""}\n`;
                for (const field of embed.fields) {
                  content += `${field.name}: ${field.value}\n`;
                }
                content += `]`;
              }
            }
            if (content.trim()) {
              mapped.push(assistant(content.trim()));
            }
          }
        } else {
          // Context rules: normal channels only load messages from "that conversation" (the specific participant)
          if (!isDM && !isThread && msg.author.id !== authorId) {
            continue;
          }

          const cleanText = msg.content.replace(mentionRegex, "").trim();
          if (cleanText) {
            mapped.push(user(cleanText));
          }
        }
      }
      return mapped;
    } catch (err: any) {
      logEvent("history_fetch_failed", { error: err.message });
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
    } catch (err: any) {
      logEvent("commands_registration_failed", { error: err.message });
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

    logEvent("incoming_interaction", {
      type: "message",
      authorId: message.author.id,
      isDM,
      channelId: message.channel.id,
    });

    const userPrompt = message.content.replace(mentionRegex, "").trim();

    if (userPrompt.length === 0 && !isDM) {
      logEvent("empty_mention_warning", { authorId: message.author.id });
      await message.reply(
        "I received your mention, but the message content was blank. " +
        "Please check that the bot has **Message Content Intent** enabled in the Discord Developer Portal."
      );
      return;
    }

    // Rate limiter
    if (isRateLimited(message.author.id)) {
      logEvent("rate_limit_exceeded", { authorId: message.author.id });
      await message.reply("You are sending messages too quickly! Please wait a moment before trying again.");
      return;
    }

    // Acquire concurrency slot
    const slotAcquired = await withSlot(async () => {
      const startExecution = Date.now();
      logEvent("agent_execution_start", { authorId: message.author.id, channelId: message.channel.id });
      
      // Trigger typing state feedback
      await message.channel.sendTyping();

      try {
        // Reconstruct Context: threads/DMs fetch recent history, standard channels fetch only current user history
        const history = await fetchHistory(message.channel, message.author.id, 15, message.id);

        // Ensure the current user prompt is included in the history for this execution run
        history.push(user(userPrompt));

        // Execute Agent loop
        const result = await run(agent, history);
        const output = result.finalOutput ?? "";

        // Extract JSON and render Embed cards if matches financial output
        const { embed, cleanText } = tryFormatEmbed(output);

        // Split responses if exceeding Discord limits
        const messageChunks = splitMessage(cleanText);

        // Send standard text chunks
        for (let i = 0; i < messageChunks.length; i++) {
          const text = messageChunks[i];
          if (text) {
            await message.reply(text);
          }
        }

        // Send the embed card if present
        if (embed) {
          await message.reply({ embeds: [embed] });
        }

        const durationMs = Date.now() - startExecution;
        logEvent("agent_execution_complete", { authorId: message.author.id, durationMs, status: "success" });

      } catch (err: any) {
        const durationMs = Date.now() - startExecution;
        logEvent("agent_execution_failed", { authorId: message.author.id, durationMs, error: err.message });
        await message.reply("Sorry, an error occurred while processing your request. Please try again later.");
      }
    });

    if (slotAcquired === null) {
      logEvent("concurrency_slot_unavailable", { authorId: message.author.id });
      await message.reply("I am currently busy handling other requests. Please try again in a few seconds.");
    }
  });

  // Graceful shutdown procedures
  const shutdown = async (signal: string) => {
    logEvent("shutdown", { signal });
    try {
      await sera.close();
    } catch (err: any) {
      logEvent("mcp_disconnect_failed", { error: err.message });
    }
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Log in to Discord
  try {
    await client.login(DISCORD_TOKEN);
  } catch (err: any) {
    logEvent("discord_login_failed", { error: err.message });
    process.exit(1);
  }
}

main().catch((err) => {
  logEvent("fatal_startup_error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
