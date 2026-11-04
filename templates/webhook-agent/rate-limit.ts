/**
 * Dual-tier rate limiting for the webhook-agent, powered by express-rate-limit.
 *
 * Tier 1 — per-client limiter: a per-IP quota mounted across all routes (/health,
 *   /trigger, etc.). Evaluated first (ahead of the global tier) and before body
 *   parsing so any single source is capped at its fair share (e.g. 60 req/min)
 *   and cannot drain the global budget to cause a denial-of-service for other users.
 * Tier 2 — global burst limiter: one server-wide bucket (e.g. 300 req/min)
 *   capping total aggregate request volume across all clients. Protects
 *   the event loop, socket backlog, and LLM spend from distributed floods
 *   originating from multiple distinct sources.
 *
 * Both tiers emit standard RateLimit-Limit / RateLimit-Remaining /
 * RateLimit-Reset headers and set Retry-After on 429 responses.
 *
 * NOTE: the default store is in-process memory, so counters are per-process.
 * Run a single instance for exact limits, or plug in a shared store
 * (e.g. rate-limit-redis) when scaling horizontally.
 */

import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, type RateLimitInfo, rateLimit } from "express-rate-limit";

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_GLOBAL_LIMIT = 300;
export const DEFAULT_CLIENT_LIMIT = 60;

/** Thrown when a rate-limit env var is set but is not a finite positive integer. */
export class InvalidEnvError extends Error {
  constructor(name: string, raw: string) {
    super(`${name} must be a finite positive integer (got "${raw}")`);
    this.name = "InvalidEnvError";
  }
}

/**
 * Read `name` from the environment as a finite positive integer, falling back
 * to `fallback` when unset or blank. Throws InvalidEnvError otherwise —
 * failing fast at boot beats silently running with an unusable limit
 * (NaN, negative, fractional) that would either never trip or lock everyone out.
 */
export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new InvalidEnvError(name, raw);
  return value;
}

/**
 * Resolve the bucket key for a client.
 *
 * Express computes req.ip from the direct socket address by default, and from
 * X-Forwarded-For only when app.set("trust proxy") is configured — so this
 * honors proxies when explicitly trusted and ignores spoofable forwarding
 * headers otherwise (falling back to the raw socket address).
 */
export function resolveClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export interface RateLimiterConfig {
  windowMs: number;
  globalLimit: number;
  clientLimit: number;
}

export interface LimiterOverrides {
  /**
   * Per-check toggles passed to express-rate-limit's `validate` option.
   * Intended for tests (e.g. silencing the X-Forwarded-For warning while
   * proving spoofed headers are ignored on direct connections).
   */
  validate?: Record<string, boolean>;
}

function respondTooManyRequests(req: Request, res: Response): void {
  const info: RateLimitInfo | undefined = (req as Request & { rateLimit?: RateLimitInfo })
    .rateLimit;
  if (info) {
    if (info.resetTime) {
      const seconds = Math.max(1, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000));
      res.setHeader("Retry-After", String(seconds));
      res.setHeader("RateLimit-Reset", String(seconds));
    }
    res.setHeader("RateLimit-Limit", String(info.limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, info.remaining)));
  }
  res.status(429).json({ error: "rate_limited" });
}

/**
 * Tier 2 — server-wide burst ceiling. Every request shares the single
 * "__global__" bucket regardless of client IP. Runs after the per-client
 * limiter so individual abusers are dropped before incrementing the global bucket.
 */
export function createGlobalLimiter(
  cfg: RateLimiterConfig,
  overrides: LimiterOverrides = {},
): RequestHandler {
  return rateLimit({
    windowMs: cfg.windowMs,
    limit: cfg.globalLimit,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: () => "__global__",
    handler: respondTooManyRequests,
    validate: { ...overrides.validate },
  });
}

/**
 * Tier 1 — per-client quota keyed by resolved client IP. Mounted across all
 * routes (/health, /trigger, etc.) ahead of the global tier to prevent
 * single-IP lockout amplification. IPv6 addresses are normalized to /56 subnets
 * so clients can't rotate addresses within one allocation to evade the quota.
 */
export function createClientLimiter(
  cfg: RateLimiterConfig,
  overrides: LimiterOverrides = {},
): RequestHandler {
  return rateLimit({
    windowMs: cfg.windowMs,
    limit: cfg.clientLimit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(resolveClientIp(req)),
    handler: respondTooManyRequests,
    validate: { ...overrides.validate },
  });
}
