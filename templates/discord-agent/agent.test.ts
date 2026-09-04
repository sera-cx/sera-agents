/**
 * Tests for Discord Agent authorization, rate limiting, history isolation,
 * mention safety, and concurrency validation.
 *
 * Uses Node.js built-in test runner (node:test) + node:assert.
 * Run via: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AuthConfig,
  type AuthContext,
  checkAuthorization,
  evictStaleRateLimits,
  isAuthorAuthorized,
  isRateLimited,
  logEvent,
  parseAllowlist,
  parseMaxConcurrent,
  rateLimits,
  SAFE_REPLY_OPTIONS,
  safeReply,
  splitMessage,
  toSafeReplyOptions,
  tryFormatEmbed,
} from "./agent.js";

// ── Authorization Tests ──────────────────────────────────────────────────────

describe("parseAllowlist", () => {
  it("returns null for undefined input", () => {
    assert.equal(parseAllowlist(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseAllowlist(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.equal(parseAllowlist("   "), null);
  });

  it("parses a single ID", () => {
    const result = parseAllowlist("12345");
    assert.ok(result);
    assert.equal(result.size, 1);
    assert.ok(result.has("12345"));
  });

  it("parses comma-separated IDs with whitespace", () => {
    const result = parseAllowlist("  111 , 222 , 333  ");
    assert.ok(result);
    assert.equal(result.size, 3);
    assert.ok(result.has("111"));
    assert.ok(result.has("222"));
    assert.ok(result.has("333"));
  });

  it("filters out empty segments from trailing commas", () => {
    const result = parseAllowlist("111,,222,");
    assert.ok(result);
    assert.equal(result.size, 2);
    assert.ok(result.has("111"));
    assert.ok(result.has("222"));
  });
});

describe("checkAuthorization", () => {
  const baseConfig: AuthConfig = {
    allowedUsers: null,
    allowedGuilds: null,
    allowedChannels: null,
    allowDMs: false,
    publicModeAck: false,
  };

  const baseCtx: AuthContext = {
    userId: "user1",
    guildId: "guild1",
    channelId: "chan1",
    parentChannelId: null,
    isDM: false,
  };

  it("allows all when no allowlists are configured (guild message)", () => {
    assert.equal(checkAuthorization(baseConfig, baseCtx), null);
  });

  it("denies DMs when allowDMs is false", () => {
    const ctx: AuthContext = { ...baseCtx, isDM: true, guildId: null };
    assert.equal(checkAuthorization(baseConfig, ctx), "dm_disabled");
  });

  // ── DM authorization gap fix ──

  it("denies DMs when allowDMs is true but no user allowlist is configured", () => {
    const config: AuthConfig = { ...baseConfig, allowDMs: true };
    const ctx: AuthContext = { ...baseCtx, isDM: true, guildId: null };
    assert.equal(checkAuthorization(config, ctx), "dm_requires_user_allowlist");
  });

  it("denies DMs when allowDMs is true and only guild allowlist is configured (no user allowlist)", () => {
    const config: AuthConfig = {
      ...baseConfig,
      allowDMs: true,
      allowedGuilds: new Set(["guild1"]),
    };
    const ctx: AuthContext = { ...baseCtx, isDM: true, guildId: null };
    assert.equal(checkAuthorization(config, ctx), "dm_requires_user_allowlist");
  });

  it("allows DMs for allowlisted user when user allowlist is configured", () => {
    const config: AuthConfig = {
      ...baseConfig,
      allowDMs: true,
      allowedUsers: new Set(["user1"]),
    };
    const ctx: AuthContext = { ...baseCtx, isDM: true, guildId: null };
    assert.equal(checkAuthorization(config, ctx), null);
  });

  it("denies DMs for non-allowlisted user", () => {
    const config: AuthConfig = {
      ...baseConfig,
      allowDMs: true,
      allowedUsers: new Set(["otherUser"]),
    };
    const ctx: AuthContext = {
      userId: "user1",
      isDM: true,
      guildId: null,
      channelId: "dm1",
      parentChannelId: null,
    };
    assert.equal(checkAuthorization(config, ctx), "user_not_allowed");
  });

  // ── Guild authorization ──

  it("denies guild messages for non-allowlisted guild", () => {
    const config: AuthConfig = { ...baseConfig, allowedGuilds: new Set(["allowedGuild"]) };
    assert.equal(checkAuthorization(config, baseCtx), "guild_not_allowed");
  });

  it("allows guild messages for allowlisted guild", () => {
    const config: AuthConfig = { ...baseConfig, allowedGuilds: new Set(["guild1"]) };
    assert.equal(checkAuthorization(config, baseCtx), null);
  });

  // ── Channel authorization ──

  it("denies guild messages for non-allowlisted channel", () => {
    const config: AuthConfig = { ...baseConfig, allowedChannels: new Set(["allowedChan"]) };
    assert.equal(checkAuthorization(config, baseCtx), "channel_not_allowed");
  });

  it("allows guild messages for allowlisted channel", () => {
    const config: AuthConfig = { ...baseConfig, allowedChannels: new Set(["chan1"]) };
    assert.equal(checkAuthorization(config, baseCtx), null);
  });

  // ── Thread channel resolution ──

  it("allows thread when parent channel is in the channel allowlist", () => {
    const config: AuthConfig = { ...baseConfig, allowedChannels: new Set(["parent-chan"]) };
    const ctx: AuthContext = {
      ...baseCtx,
      channelId: "thread-123",
      parentChannelId: "parent-chan",
    };
    assert.equal(checkAuthorization(config, ctx), null);
  });

  it("denies thread when parent channel is not in the channel allowlist", () => {
    const config: AuthConfig = { ...baseConfig, allowedChannels: new Set(["other-chan"]) };
    const ctx: AuthContext = {
      ...baseCtx,
      channelId: "thread-123",
      parentChannelId: "parent-chan",
    };
    assert.equal(checkAuthorization(config, ctx), "channel_not_allowed");
  });

  // ── User authorization ──

  it("denies guild messages for non-allowlisted user when user allowlist is set", () => {
    const config: AuthConfig = { ...baseConfig, allowedUsers: new Set(["otherUser"]) };
    assert.equal(checkAuthorization(config, baseCtx), "user_not_allowed");
  });

  // ── Combined allowlists ──

  it("enforces all three allowlists together — pass", () => {
    const config: AuthConfig = {
      ...baseConfig,
      allowedUsers: new Set(["user1"]),
      allowedGuilds: new Set(["guild1"]),
      allowedChannels: new Set(["chan1"]),
    };
    assert.equal(checkAuthorization(config, baseCtx), null);
  });

  it("enforces all three allowlists together — guild fail", () => {
    const config: AuthConfig = {
      ...baseConfig,
      allowedUsers: new Set(["user1"]),
      allowedGuilds: new Set(["otherGuild"]),
      allowedChannels: new Set(["chan1"]),
    };
    assert.equal(checkAuthorization(config, baseCtx), "guild_not_allowed");
  });
});

// ── History Author Authorization Tests ───────────────────────────────────────

describe("isAuthorAuthorized", () => {
  const baseConfig: AuthConfig = {
    allowedUsers: null,
    allowedGuilds: null,
    allowedChannels: null,
    allowDMs: false,
    publicModeAck: false,
  };

  it("allows any author when no user allowlist is configured", () => {
    assert.equal(isAuthorAuthorized(baseConfig, "random-user"), true);
  });

  it("allows an author on the user allowlist", () => {
    const config: AuthConfig = { ...baseConfig, allowedUsers: new Set(["user1"]) };
    assert.equal(isAuthorAuthorized(config, "user1"), true);
  });

  it("denies an author not on the user allowlist", () => {
    const config: AuthConfig = { ...baseConfig, allowedUsers: new Set(["user1"]) };
    assert.equal(isAuthorAuthorized(config, "attacker"), false);
  });
});

// ── Rate Limiting Tests ──────────────────────────────────────────────────────

describe("isRateLimited", () => {
  it("allows the first request", () => {
    assert.equal(isRateLimited("test-rate-1"), false);
  });

  it("allows up to RATE_LIMIT_MAX_REQUESTS (5) per window", () => {
    const userId = "test-rate-2";
    for (let i = 0; i < 5; i++) {
      assert.equal(isRateLimited(userId), false);
    }
  });

  it("blocks the 6th request within the same window", () => {
    const userId = "test-rate-3";
    for (let i = 0; i < 5; i++) {
      isRateLimited(userId);
    }
    assert.equal(isRateLimited(userId), true);
  });
});

describe("evictStaleRateLimits", () => {
  it("does not evict fresh entries", () => {
    const userId = "fresh-user-evict-test";
    isRateLimited(userId);
    const evicted = evictStaleRateLimits();
    // The entry we just created should NOT be evicted
    assert.ok(rateLimits.has(userId), "Fresh entry should not be evicted");
    assert.equal(typeof evicted, "number");
  });

  it("evicts entries that have been backdated past the window", () => {
    const userId = "stale-user-evict-test";
    // Create a rate-limit entry, then manually backdate it
    isRateLimited(userId);
    const entry = rateLimits.get(userId);
    assert.ok(entry, "Entry should exist");
    // Backdate to 2 minutes ago (window is 60s)
    entry.start = Date.now() - 120_000;

    const evicted = evictStaleRateLimits();
    assert.ok(evicted >= 1, "At least one stale entry should be evicted");
    assert.ok(!rateLimits.has(userId), "Stale entry should have been removed");
  });
});

// ── Concurrency Validation Tests ─────────────────────────────────────────────

describe("parseMaxConcurrent", () => {
  it("returns fallback for undefined input", () => {
    assert.equal(parseMaxConcurrent(undefined, 4), 4);
  });

  it("returns fallback for empty string", () => {
    assert.equal(parseMaxConcurrent("", 4), 4);
  });

  it("parses a valid positive integer", () => {
    assert.equal(parseMaxConcurrent("8", 4), 8);
  });

  it("returns fallback for non-numeric string 'abc'", () => {
    assert.equal(parseMaxConcurrent("abc", 4), 4);
  });

  it("returns fallback for NaN-producing input", () => {
    assert.equal(parseMaxConcurrent("NaN", 4), 4);
  });

  it("returns fallback for Infinity", () => {
    assert.equal(parseMaxConcurrent("Infinity", 4), 4);
  });

  it("returns fallback for negative number", () => {
    assert.equal(parseMaxConcurrent("-3", 4), 4);
  });

  it("returns fallback for zero", () => {
    assert.equal(parseMaxConcurrent("0", 4), 4);
  });

  it("returns fallback for floating point number", () => {
    assert.equal(parseMaxConcurrent("3.5", 4), 4);
  });

  it("parses '1' correctly", () => {
    assert.equal(parseMaxConcurrent("1", 4), 1);
  });
});

// ── UX Helper Tests ──────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    const result = splitMessage("hello", 2000);
    assert.equal(result.length, 1);
    assert.equal(result[0], "hello");
  });

  it("splits long text at newlines", () => {
    const line = "a".repeat(1000);
    const text = `${line}\n${line}\n${line}`;
    const result = splitMessage(text, 2000);
    assert.ok(result.length > 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 2000);
    }
  });

  it("splits at spaces when no newlines available", () => {
    const text = "word ".repeat(500);
    const result = splitMessage(text.trim(), 100);
    assert.ok(result.length > 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 100);
    }
  });
});

describe("tryFormatEmbed", () => {
  it("returns null embed for plain text", () => {
    const result = tryFormatEmbed("just plain text");
    assert.equal(result.embed, null);
    assert.equal(result.cleanText, "just plain text");
  });

  it("extracts a quote embed from JSON block", () => {
    const text =
      'Here is your quote:\n```json\n{"quote_uuid": "abc-123", "source_asset": "USDC", "destination_asset": "SGD", "rate": "1.35"}\n```';
    const result = tryFormatEmbed(text);
    assert.ok(result.embed);
    assert.equal(result.embed.data.title, "Sera Settlement Quote / Deal Details");
    assert.ok(result.cleanText.includes("Here is your quote:"));
    assert.ok(!result.cleanText.includes("```json"));
  });

  it("extracts a balance embed from JSON block", () => {
    const text =
      'Your balances:\n```json\n{"balances": [{"asset": "USDC", "amount": "1000"}, {"asset": "ETH", "amount": "2.5"}]}\n```';
    const result = tryFormatEmbed(text);
    assert.ok(result.embed);
    assert.equal(result.embed.data.title, "Sera Account Balances");
  });

  it("falls back gracefully on invalid JSON", () => {
    const text = "```json\n{invalid json\n```";
    const result = tryFormatEmbed(text);
    assert.equal(result.embed, null);
    assert.equal(result.cleanText, text);
  });

  it("returns null embed for JSON that is not a quote or balance", () => {
    const text = '```json\n{"foo": "bar"}\n```';
    const result = tryFormatEmbed(text);
    assert.equal(result.embed, null);
    assert.equal(result.cleanText, text);
  });
});

// ── Mention Safety Tests ─────────────────────────────────────────────────────

describe("mention safety", () => {
  it("SAFE_REPLY_OPTIONS has empty parse array", () => {
    assert.deepEqual(SAFE_REPLY_OPTIONS.allowedMentions?.parse, []);
  });

  it("SAFE_REPLY_OPTIONS disables repliedUser mention", () => {
    assert.equal(SAFE_REPLY_OPTIONS.allowedMentions?.repliedUser, false);
  });

  it("SAFE_REPLY_OPTIONS is deeply structured correctly", () => {
    assert.deepEqual(SAFE_REPLY_OPTIONS, {
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it("toSafeReplyOptions wraps string content with SAFE_REPLY_OPTIONS", () => {
    const opts = toSafeReplyOptions("Hello @everyone");
    assert.equal(opts.content, "Hello @everyone");
    assert.deepEqual(opts.allowedMentions, { parse: [], repliedUser: false });
  });

  it("toSafeReplyOptions overrides malicious allowedMentions in object content", () => {
    const maliciousPayload = {
      content: "Hello @everyone",
      allowedMentions: { parse: ["everyone" as const, "roles" as const, "users" as const] },
    };
    const opts = toSafeReplyOptions(maliciousPayload);
    assert.equal(opts.content, "Hello @everyone");
    // Ensure SAFE_REPLY_OPTIONS overrides the malicious allowedMentions
    assert.deepEqual(opts.allowedMentions, { parse: [], repliedUser: false });
  });

  it("safeReply passes SAFE_REPLY_OPTIONS to message.reply() mock", async () => {
    let capturedOptions: unknown = null;
    const mockMessage = {
      reply: async (options: unknown) => {
        capturedOptions = options;
        return { id: "mock-reply-1" };
      },
    };

    await safeReply(mockMessage, "Test message");
    assert.deepEqual(capturedOptions, {
      content: "Test message",
      allowedMentions: { parse: [], repliedUser: false },
    });
  });
});

// ── Log Event Tests ──────────────────────────────────────────────────────────

describe("logEvent", () => {
  it("does not throw for basic events", () => {
    assert.doesNotThrow(() => logEvent("test_event", { key: "value" }));
  });

  it("does not throw without metadata", () => {
    assert.doesNotThrow(() => logEvent("test_event"));
  });
});
