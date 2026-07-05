/**
 * Gateway error type + upstream-throttle detection.
 *
 * Kept in its own module so the sera-mcp client (which raises a 429 when Sera
 * throttles) and the HTTP/MCP layers (which render it) share one definition.
 */

/** An error carrying an HTTP status so the server can map it to a response. */
export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Seconds to wait before retrying — only meaningful on 429/503. */
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Shape of a sera-mcp tool-call result we inspect on failure. */
interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const numeric = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
      ? Number(v.trim())
      : undefined;

/**
 * If a sera-mcp tool error represents a retryable upstream condition — a 429
 * throttle or a 503 transient outage — return the HTTP status to surface plus
 * any Retry-After hint; otherwise null.
 *
 *  1. Structured — a future sera-mcp emits machine-readable status in `_meta`
 *     or `structuredContent` (see docs/sera-mcp-error-contract.md). Read a small
 *     candidate set of keys rather than pinning one name; any status is surfaced.
 *  2. Heuristic — today's sera-mcp stringifies the upstream error into the human
 *     text; match a 429/rate-limit or 503/unavailable signal and parse a
 *     Retry-After integer.
 */
export function rateLimitFromToolError(
  res: ToolResult,
): { status: number; retryAfter?: number } | null {
  // (1) Structured metadata, if a newer sera-mcp provides it.
  const meta = { ...(res?.structuredContent ?? {}), ...(res?._meta ?? {}) } as Record<string, unknown>;
  const errObj = meta.error as Record<string, unknown> | undefined;
  const status =
    numeric(meta["sera/httpStatus"]) ??
    numeric(meta.httpStatus) ??
    numeric(meta.status) ??
    numeric(errObj?.code);
  if (status != null) {
    const retryAfter =
      numeric(meta["sera/retryAfter"]) ?? numeric(meta.retryAfter) ?? numeric(errObj?.retryAfter);
    return { status, retryAfter };
  }

  // (2) Heuristic on the stringified message: a 429 throttle or a 503 transient
  //     ("service (temporarily) unavailable"). Both are retryable, so surface the
  //     status + any Retry-After rather than collapsing to a generic 502.
  const text = res?.content?.[0]?.text;
  if (typeof text === "string") {
    const m = text.match(/retry[-\s]?after["':=\s]+(\d+)/i);
    const retryAfter = m ? Number(m[1]) : undefined;
    if (/\b429\b|rate.?limit|too many requests/i.test(text)) return { status: 429, retryAfter };
    if (/\b503\b|service (temporarily )?unavailable|temporarily unavailable/i.test(text)) {
      return { status: 503, retryAfter };
    }
  }
  return null;
}
