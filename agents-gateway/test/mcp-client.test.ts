import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimitFromToolError } from "../lib/mcp-client.js";

test("structured _meta status maps to a throttle with retryAfter", () => {
  const r = { isError: true, _meta: { "sera/httpStatus": 429, "sera/retryAfter": 12 } };
  assert.deepEqual(rateLimitFromToolError(r), { status: 429, retryAfter: 12 });
});

test("structuredContent error.code is read when _meta absent", () => {
  const r = { isError: true, structuredContent: { error: { code: 503, retryAfter: "30" } } };
  assert.deepEqual(rateLimitFromToolError(r), { status: 503, retryAfter: 30 });
});

test("heuristic: 429 in stringified text, no retry hint", () => {
  const r = { isError: true, content: [{ type: "text", text: "sera api: 429 Too Many Requests" }] };
  assert.deepEqual(rateLimitFromToolError(r), { status: 429, retryAfter: undefined });
});

test("heuristic: 'rate limit' phrasing with Retry-After parsed", () => {
  const r = { isError: true, content: [{ type: "text", text: "rate limit exceeded; Retry-After: 7" }] };
  assert.deepEqual(rateLimitFromToolError(r), { status: 429, retryAfter: 7 });
});

test("ordinary tool errors are not throttles → null (→ 500)", () => {
  const r = { isError: true, content: [{ type: "text", text: "invalid token symbol" }] };
  assert.equal(rateLimitFromToolError(r), null);
});

test("a 429 embedded in a larger number does not false-positive (word boundary)", () => {
  const r = { isError: true, content: [{ type: "text", text: "min output 1429000 too low" }] };
  assert.equal(rateLimitFromToolError(r), null);
});
