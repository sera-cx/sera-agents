# Upstream proposal: structured error metadata in sera-mcp tool results

**Status:** ready to apply to `sera-cx/sera-mcp`. The gateway already reads the
shape below defensively, so landing this is purely additive — no gateway change
required. (The Docker image builds sera-mcp from source at a pinned tag, so this
change ships to the gateway by bumping `SERA_MCP_REF` once it's released.)

## Problem

When a sera-mcp tool fails because the **upstream Sera API throttled** the
request (HTTP 429), sera-mcp returns a `CallToolResult` whose only signal is the
human-readable text:

```jsonc
{ "isError": true, "content": [{ "type": "text", "text": "sera api error: 429 Too Many Requests" }] }
```

Consumers can't reliably distinguish "back off and retry" from "permanent
failure" without scraping that string, and the `Retry-After` value the Sera API
returned is lost entirely. The gateway currently falls back to a regex on the
text (works, but brittle and can't recover a precise backoff).

## Proposal

On **any tool failure that originates from an upstream HTTP response**, attach
machine-readable metadata to the existing `isError` result via `_meta`. Keep the
human `content` text exactly as-is (back-compatible).

```jsonc
{
  "isError": true,
  "content": [{ "type": "text", "text": "sera api error: 429 Too Many Requests" }],
  "_meta": {
    "sera/httpStatus": 429,        // the upstream HTTP status, as a number
    "sera/retryAfter": 12          // OPTIONAL: seconds, mirrored from the upstream Retry-After header
  }
}
```

- `sera/httpStatus` — REQUIRED when the failure has an upstream HTTP status
  (429, 503, 502, …). Number, not string.
- `sera/retryAfter` — OPTIONAL integer seconds; include only when the upstream
  response carried a `Retry-After` header. Number or numeric string (coerced).

`_meta` is the right channel: it's part of the MCP result envelope, ignored by
clients that don't look for it, and doesn't pollute the human `content`.

## What the gateway already does with it

`agents-gateway/src/errors.ts → rateLimitFromToolError()` (called by
`interpretToolResult` in `src/sera-mcp-client.ts`) reads, in order:

1. **Structured** — merges `structuredContent` then `_meta` and looks for the
   status under any of `sera/httpStatus`, `httpStatus`, `status`, `error.code`,
   and the backoff under `sera/retryAfter`, `retryAfter`, `error.retryAfter`.
   First numeric hit wins.
2. **Heuristic fallback** — only if no structured status is present: matches
   `\b429\b` / `rate limit` / `too many requests` in the text and parses a
   `Retry-After: N` integer if present.

So emitting `_meta["sera/httpStatus"]` makes the gateway use the exact status;
adding `sera/retryAfter` lets it forward a precise `Retry-After` on its REST
`429` instead of an unbounded backoff.

## Suggested scope of the sera-mcp change

- Find the single point where tool handlers turn an upstream HTTP error into a
  `CallToolResult` (the shared error-to-result mapper).
- When the caught error carries an HTTP status (axios/fetch error or a thrown
  `ApiError`), populate `_meta` as above. Leave non-HTTP failures (validation,
  bad args) without `_meta` — they should stay 5xx/4xx at the gateway, not be
  mistaken for throttles.
- Tests: one asserting a throttled upstream produces `_meta["sera/httpStatus"]
  === 429` and mirrors `Retry-After`; one asserting a validation error attaches
  no `_meta`.

Until this lands, the gateway's heuristic fallback keeps 429s honest — this just
upgrades precision.
