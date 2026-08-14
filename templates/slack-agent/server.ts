/**
 * Template: Slack bot agent.
 *
 * Spawns the local `sera-mcp` subprocess via stdio, instantiates the OpenAI agent,
 * and connects to Slack using @slack/bolt with dynamic transport selection.
 * Supports DMs and app mentions, stateless history retrieval via conversations.replies,
 * error boundaries, subprocess cleanup, and concurrency limits.
 */
import pkg from "@slack/bolt";
const { App } = pkg;
import { Agent, run, MCPServerStdio, user, assistant } from "@openai/agents";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// ─── ENVIRONMENT VALIDATION ───────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SOCKET_MODE = (process.env.SLACK_SOCKET_MODE ?? "true").toLowerCase() === "true";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const PORT = Number(process.env.PORT ?? 3000);
const MAX_CONCURRENT = Number(process.env.SLACK_AGENT_MAX_CONCURRENT ?? 4);

if (!OPENAI_API_KEY) {
  process.stderr.write("refusing to start: OPENAI_API_KEY is not set.\n");
  process.exit(1);
}
if (!SLACK_BOT_TOKEN) {
  process.stderr.write("refusing to start: SLACK_BOT_TOKEN is not set.\n");
  process.exit(1);
}
if (SLACK_SOCKET_MODE && !SLACK_APP_TOKEN) {
  process.stderr.write("refusing to start: SLACK_SOCKET_MODE=true requires SLACK_APP_TOKEN to be set.\n");
  process.exit(1);
}
if (!SLACK_SOCKET_MODE && !SLACK_SIGNING_SECRET) {
  process.stderr.write("refusing to start: SLACK_SOCKET_MODE=false requires SLACK_SIGNING_SECRET to be set.\n");
  process.exit(1);
}

// ─── BOLT APP CONFIGURATION ────────────────────────────────────────────────
const app = SLACK_SOCKET_MODE
  ? new App({
      token: SLACK_BOT_TOKEN,
      socketMode: true,
      appToken: SLACK_APP_TOKEN,
    })
  : new App({
      token: SLACK_BOT_TOKEN,
      signingSecret: SLACK_SIGNING_SECRET,
      port: PORT,
    });

// ─── MCP SUBPROCESS CONFIGURATION ──────────────────────────────────────────
const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
const desktopPath = resolve(homeDir, "Desktop/sera-mcp/dist/index.js");
const standardPath = resolve(homeDir, "sera-mcp/dist/index.js");
// Check if standard sibling path exists, else fallback to desktop default path
const defaultMcpPath = existsSync(standardPath) ? standardPath : desktopPath;
const seraMcpPath = process.env.SERA_MCP_DIST ?? defaultMcpPath;

const sera = new MCPServerStdio({
  command: "node",
  args: [seraMcpPath],
  env: {
    SERA_NETWORK: process.env.SERA_NETWORK ?? "mainnet",
    POLICY_PRESET: process.env.POLICY_PRESET ?? "standard",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    SERA_ENABLE_EXECUTION_TOOLS: process.env.SERA_ENABLE_EXECUTION_TOOLS === "true" ? "true" : "false",
    SERA_SIGNER_MODE: "external",
    ...(process.env.SERA_API_KEY ? { SERA_API_KEY: process.env.SERA_API_KEY } : {}),
    ...(process.env.SERA_API_SECRET ? { SERA_API_SECRET: process.env.SERA_API_SECRET } : {}),
  },
  name: "sera",
});

// ─── AGENT & PROMPT SYSTEM ────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a multi-currency settlement assistant powered by the Sera MCP. You have
access to tools covering stablecoin discovery, FX rates, quotes, swaps, treasury
management, and deal scanning.

Formatting principles:
- You must format your output using Slack mrkdwn syntax:
  - Bold: *text* (do NOT use **text**)
  - Italic: _text_ (do NOT use *text* or _text_)
  - Links: <url|anchor> (do NOT use [anchor](url))
  - Lists: Use standard bullet points (e.g., • or -)
- Be concise and friendly. Keep replies straightforward.

Operating principles:
- Always use sera.* tools rather than guessing values.
- Quote prices via sera.get_quote, never via sera.get_fx_rate.
- Default to simulate:true on get_quote when the user is exploring.
- You operate in a non-custodial environment. You can plan routes and quote transfers, but you cannot execute transactions or sign things yourself. Return the route parameters or raw payload for the user's wallet to sign.
`.trim();

let agent: Agent;
let botUserId = "";

// ─── EVENT DEDUPLICATION STORE ─────────────────────────────────────────────
const seenEvents = new Map<string, number>();
function isDuplicateEvent(eventId: string, maxSize = 1000, gcBatch = 200): boolean {
  if (seenEvents.has(eventId)) {
    return true;
  }
  if (seenEvents.size > maxSize) {
    const sorted = [...seenEvents.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < gcBatch; i++) {
      seenEvents.delete(sorted[i][0]);
    }
  }
  seenEvents.set(eventId, Date.now());
  return false;
}

// ─── CONCURRENCY CONTROL INFRASTRUCTURE ──────────────────────────────────
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

// ─── TIMEOUT UTILITY ──────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("execution_timeout")), ms);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ─── SLACK REPLIES & RUN CONTROLLER ───────────────────────────────────────
async function handleSlackMessage(
  event: {
    channel: string;
    ts: string;
    thread_ts?: string;
    text?: string;
    user?: string;
  },
  client: any,
  body?: any
) {
  // Prevent response loops by ignoring bot messages or empty texts
  if (!event.text || !event.user || event.user === botUserId) {
    return;
  }

  // Deduplicate events to prevent double processing on retries
  const eventKey = body?.event_id || `${event.channel}:${event.ts}`;
  if (isDuplicateEvent(eventKey)) {
    console.log(`[slack_event] Ignoring duplicate event: ${eventKey}`);
    return;
  }

  console.log(`[slack_event] Received message from user ${event.user} in channel ${event.channel} (thread: ${event.thread_ts ?? "none"})`);

  // Thread behaviour setup
  const isIm = event.channel.startsWith("D") || event.channel.startsWith("G");
  const threadTs = event.thread_ts ?? (isIm ? undefined : event.ts);

  const startTime = Date.now();

  // Fetch thread history from Slack to reconstruct stateless memory context
  let historyMessages: any[] = [];
  const fetchThreadTs = event.thread_ts;

  if (fetchThreadTs) {
    try {
      let replies = await client.conversations.replies({
        channel: event.channel,
        ts: fetchThreadTs,
        limit: 100,
      });
      historyMessages = replies.messages ?? [];
      let cursor = replies.response_metadata?.next_cursor;
      let pagesFetched = 1;
      while (cursor && pagesFetched < 5) {
        const nextPage = await client.conversations.replies({
          channel: event.channel,
          ts: fetchThreadTs,
          cursor: cursor,
          limit: 100,
        });
        if (nextPage.messages) {
          historyMessages.push(...nextPage.messages);
        }
        cursor = nextPage.response_metadata?.next_cursor;
        pagesFetched++;
      }

      // Ensure the current trigger event is represented in historyMessages
      const hasCurrentEvent = historyMessages.some((msg) => msg.ts === event.ts);
      if (!hasCurrentEvent) {
        historyMessages.push(event);
      }

      if (historyMessages.length > 20) {
        historyMessages = historyMessages.slice(-20);
      }
    } catch (e) {
      process.stderr.write(`[slack_history_error] Failed to fetch thread context: ${String(e)}\n`);
      historyMessages = [event];
    }
  } else {
    historyMessages = [event];
  }

  // Pre-compile mention strip regex for performance (avoids compilation per message iteration)
  const botMentionRegex = botUserId ? new RegExp(`<@${botUserId}>`, "g") : null;

  // Chronological ordering is preserved naturally by conversations.replies.
  // Clean raw messages and map into standard OpenAI Agents SDK structure.
  const historyItems: any[] = [];
  for (const msg of historyMessages) {
    if (!msg.text || !msg.user) continue;

    let cleanedText = msg.text;
    if (botMentionRegex) {
      cleanedText = cleanedText.replace(botMentionRegex, "").trim();
    }

    if (msg.user === botUserId) {
      historyItems.push(assistant(cleanedText));
    } else {
      historyItems.push(user(cleanedText));
    }
  }

  if (historyItems.length === 0) {
    let cleanedText = event.text;
    if (botMentionRegex) {
      cleanedText = cleanedText.replace(botMentionRegex, "").trim();
    }
    historyItems.push(user(cleanedText));
  }

  // Execute agent run inside the slot concurrency pool
  const result = await withSlot(async () => {
    console.log(`[agent_execution] Starting agent run with ${historyItems.length} history items...`);
    try {
      // 30 seconds timeout boundary
      const runResult = await withTimeout(run(agent, historyItems), 30000);
      return { ok: true, output: runResult.finalOutput };
    } catch (e: any) {
      const duration = Date.now() - startTime;
      if (e?.message === "execution_timeout") {
        process.stderr.write(`[agent_execution_failed] Run timed out after ${duration}ms\n`);
        return { ok: false, error: "timeout" };
      }
      
      // Distinguish MCP issues from OpenAI/other logic errors
      const isMcpError = e?.message?.includes("mcp") || e?.message?.includes("sera");
      if (isMcpError) {
        process.stderr.write(`[mcp_error] MCP execution failure: ${e?.message ?? String(e)}\n`);
        return { ok: false, error: "mcp_failure" };
      }

      process.stderr.write(`[agent_execution_failed] OpenAI/Agent run failed in ${duration}ms: ${e?.message ?? String(e)}\n`);
      return { ok: false, error: "openai_failure" };
    }
  });

  const duration = Date.now() - startTime;

  // Send feedback message to user
  if (result === null) {
    console.log(`[agent_execution_throttled] Request dropped due to concurrency limit.`);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "I'm currently handling too many settlement requests. Please try again in a few moments.",
      });
    } catch (err) {
      process.stderr.write(`[slack_api_error] Failed to send throttling message: ${String(err)}\n`);
    }
    return;
  }

  if (!result.ok) {
    let responseText = "Sorry, I encountered an internal error processing your request.";
    if (result.error === "timeout") {
      responseText = "Your request timed out while processing. Please try a simpler query.";
    } else if (result.error === "mcp_failure") {
      responseText = "Sera multi-currency services are temporarily unavailable. Please try again.";
    }

    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: responseText,
      });
    } catch (err) {
      process.stderr.write(`[slack_api_error] Failed to send error response message: ${String(err)}\n`);
    }
    return;
  }

  // Success
  console.log(`[agent_execution_success] Completed in ${duration}ms.`);
  const responseText = result.output?.trim() || "I'm sorry, I was unable to generate a response. Please try again.";
  try {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: responseText,
    });
  } catch (err) {
    process.stderr.write(`[slack_api_error] Failed to send agent response message: ${String(err)}\n`);
  }
}

// ─── REGISTER EVENT LISTENERS ─────────────────────────────────────────────

// Handle Mentions (App mentions in channels)
app.event("app_mention", async ({ event, client, body }) => {
  handleSlackMessage(
    {
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
      text: event.text,
      user: event.user,
    },
    client,
    body
  ).catch((err) => {
    process.stderr.write(`[unhandled_app_mention_error] Exception in runner: ${String(err)}\n`);
  });
});

// Handle DMs (Direct messages to the Bot user)
app.message(async ({ message, client, body }) => {
  if (message.channel_type === "im") {
    handleSlackMessage(
      {
        channel: message.channel,
        ts: message.ts,
        thread_ts: (message as any).thread_ts,
        text: (message as any).text,
        user: (message as any).user,
      },
      client,
      body
    ).catch((err) => {
      process.stderr.write(`[unhandled_dm_error] Exception in runner: ${String(err)}\n`);
    });
  }
});

// ─── SERVER START & PROCESS CLEANUP ───────────────────────────────────────
async function main() {
  await sera.connect();
  console.log("Connected to sera-mcp subprocess.");

  agent = new Agent({
    name: "Sera Slack Agent",
    instructions: SYSTEM_PROMPT,
    mcpServers: [sera],
  });

  await app.start();

  try {
    const authTest = await app.client.auth.test();
    botUserId = authTest.user_id ?? "";
    if (!botUserId) {
      throw new Error("Slack auth.test did not return a user_id");
    }
    console.log(`Slack bot authenticated successfully. User ID: ${botUserId}`);
  } catch (err) {
    console.error("Fatal: Could not fetch Slack Bot User ID on startup.", err);
    process.exit(1);
  }

  const transport = SLACK_SOCKET_MODE ? "Socket Mode" : "HTTP Events API";
  console.log(`Sera Slack Agent running in ${transport}`);
  if (!SLACK_SOCKET_MODE) {
    console.log(`Listening on port ${PORT}`);
  }
}

async function cleanup() {
  console.log("\n[shutdown] Signal received. Terminating process and closing MCP server...");
  try {
    await sera.close();
  } catch (err) {
    console.error("Error during MCP server cleanup:", err);
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

main().catch((err) => {
  console.error("Fatal startup error during bootstrap:", err);
  process.exit(1);
});
