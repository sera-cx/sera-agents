/**
 * Dual-tier rate limiting for the webhook-agent, powered by express-rate-limit.
 *
 * Tier 1 — global limiter: one server-wide bucket capping total request volume
 *   regardless of source. Protects the event loop, socket backlog, and LLM
 *   spend from distributed floods that would slip past any per-client quota.
 * Tier 2 — per-client limiter: a per-IP quota on /trigger. Mounted before body
 *   parsing so abusive requests are dropped without allocating buffers or
 *   burning CPU on JSON parsing / HMAC hashing.
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
  if (info?.resetTime) {
    const seconds = Math.max(1, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000));
    res.setHeader("Retry-After", String(seconds));
  }
  res.status(429).json({ error: "rate_limited" });
}

/**
 * Tier 1 — server-wide burst ceiling. Every request shares the single
 * "__global__" bucket regardless of client IP.
 */
export function createGlobalLimiter(
  cfg: RateLimiterConfig,
  overrides: LimiterOverrides = {},
): RequestHandler {
  return rateLimit({
    windowMs: cfg.windowMs,
    limit: cfg.globalLimit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => "__global__",
    handler: respondTooManyRequests,
    validate: { ...overrides.validate },
  });
}

/**
 * Tier 2 — per-client quota keyed by resolved client IP. IPv6 addresses are
 * normalized to /56 subnets so clients can't rotate addresses within one
 * allocation to evade the quota.
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
