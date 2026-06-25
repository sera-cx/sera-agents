/**
 * Shared error type for the gateway.
 *
 * Lives in its own module so the low-level mcp-client (which translates an
 * upstream throttle into a 429) and the higher-level adapters can both throw it
 * without an import cycle.
 */

/** Carries an HTTP status so the server can map failures to status codes. */
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
