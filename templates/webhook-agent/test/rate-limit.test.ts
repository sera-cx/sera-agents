import type { Express } from "express";
import { afterAll, describe, expect, it } from "vitest";
import { InvalidEnvError, parsePositiveIntEnv } from "../rate-limit.js";
import { type AppOptions, createApp } from "../server.js";

const SECRET = "test-secret";
const okAgent = async () => ({ ok: true, summary: "done" });

interface TestApp {
  url: string;
  close: () => Promise<void>;
}

const openServers: TestApp[] = [];

async function startApp(overrides: Partial<AppOptions> = {}): Promise<TestApp> {
  const app: Express = createApp({
    secret: SECRET,
    runAgent: okAgent,
    limiterOverrides: { validate: { xForwardedForHeader: false } },
    ...overrides,
  });
  return new Promise((resolveServer) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      const instance: TestApp = {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      };
      openServers.push(instance);
      resolveServer(instance);
    });
  });
}

afterAll(async () => {
  await Promise.all(openServers.map((s) => s.close()));
});

interface PostOptions {
  body?: string;
  /** X-Forwarded-For value simulating a client behind a proxy hop. */
  ip?: string;
  auth?: boolean;
}

function post(url: string, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.auth !== false) headers.authorization = `Bearer ${SECRET}`;
  if (options.ip) headers["x-forwarded-for"] = options.ip;
  return fetch(`${url}/trigger`, {
    method: "POST",
    headers,
    body: options.body ?? '{"task":"summarize deals"}',
  });
}

describe("parsePositiveIntEnv", () => {
  const original = process.env.WEBHOOK_RATE_LIMIT_PER_MIN;

  function withEnv(value: string | undefined, fn: () => void): void {
    if (value === undefined) delete process.env.WEBHOOK_RATE_LIMIT_PER_MIN;
    else process.env.WEBHOOK_RATE_LIMIT_PER_MIN = value;
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env.WEBHOOK_RATE_LIMIT_PER_MIN;
      else process.env.WEBHOOK_RATE_LIMIT_PER_MIN = original;
    }
  }

  it("falls back to the default when unset", () => {
    withEnv(undefined, () => {
      expect(parsePositiveIntEnv("WEBHOOK_RATE_LIMIT_PER_MIN", 60)).toBe(60);
    });
  });

  it("falls back to the default when blank", () => {
    withEnv("   ", () => {
      expect(parsePositiveIntEnv("WEBHOOK_RATE_LIMIT_PER_MIN", 60)).toBe(60);
    });
  });

  it("accepts finite positive integers", () => {
    withEnv("42", () => {
      expect(parsePositiveIntEnv("WEBHOOK_RATE_LIMIT_PER_MIN", 60)).toBe(42);
    });
  });

  it.each(["abc", "-5", "0", "2.5", "Infinity", "NaN", "1e400"])(
    "rejects %s as a non-finite/non-positive/non-integer value",
    (value) => {
      withEnv(value, () => {
        expect(() => parsePositiveIntEnv("WEBHOOK_RATE_LIMIT_PER_MIN", 60)).toThrow(
          InvalidEnvError,
        );
      });
    },
  );

  it("rejects invalid WEBHOOK_GLOBAL_RATE_LIMIT when building the app from env", () => {
    withEnv("lots", () => {
      expect(() => createApp({ secret: null, runAgent: okAgent })).toThrow(InvalidEnvError);
    });
  });
});

describe("dual-tier rate limiting over HTTP", () => {
  it("serves requests under the limit and emits standard rate-limit headers", async () => {
    const { url } = await startApp({ globalLimit: 100, clientLimit: 5, trustProxy: true });

    const res = await post(url, { ip: "203.0.113.10" });
    expect(res.status).toBe(200);

    expect(res.headers.get("ratelimit-limit")).toBe("5");
    expect(res.headers.get("ratelimit-remaining")).toBe("4");
    const reset = Number(res.headers.get("ratelimit-reset"));
    expect(Number.isInteger(reset)).toBe(true);
    expect(reset).toBeGreaterThan(0);
    await expect(res.json()).resolves.toEqual({ ok: true, summary: "done" });
  });

  it("isolates clients: exhausting one IP does not lock out another", async () => {
    const { url } = await startApp({ globalLimit: 100, clientLimit: 2, trustProxy: true });

    expect((await post(url, { ip: "203.0.113.1" })).status).toBe(200);
    expect((await post(url, { ip: "203.0.113.1" })).status).toBe(200);

    const blocked = await post(url, { ip: "203.0.113.1" });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual({ error: "rate_limited" });
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // A different client IP still has its own full quota.
    expect((await post(url, { ip: "203.0.113.2" })).status).toBe(200);
  });

  it("enforces the global ceiling across distinct client IPs", async () => {
    const { url } = await startApp({ globalLimit: 3, clientLimit: 100, trustProxy: true });

    for (let i = 1; i <= 3; i++) {
      const res = await post(url, { ip: `198.51.100.${i}` });
      expect(res.status).toBe(200);
    }

    // A brand-new IP is still blocked once the server-wide bucket is spent.
    const blocked = await post(url, { ip: "198.51.100.4" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("honors X-Forwarded-For behind a trusted proxy", async () => {
    const { url } = await startApp({ globalLimit: 100, clientLimit: 1, trustProxy: true });

    expect((await post(url, { ip: "192.0.2.1" })).status).toBe(200);
    // Second request from the same proxied client is over quota...
    expect((await post(url, { ip: "192.0.2.1" })).status).toBe(429);
    // ...but a different X-Forwarded-For gets a fresh bucket.
    expect((await post(url, { ip: "192.0.2.2" })).status).toBe(200);
  });

  it("ignores spoofed X-Forwarded-For on direct (untrusted) connections", async () => {
    const { url } = await startApp({
      globalLimit: 100,
      clientLimit: 2,
      trustProxy: false,
    });

    // All direct connections share one socket-derived bucket; rotating the
    // forwarding header must not create fresh quotas.
    expect((await post(url, { ip: "9.9.9.9" })).status).toBe(200);
    expect((await post(url, { ip: "9.9.9.9" })).status).toBe(200);
    expect((await post(url, { ip: "8.8.8.8" })).status).toBe(429);
  });

  it("rejects malformed bodies with 429 before parsing once the client is over quota", async () => {
    const { url } = await startApp({ globalLimit: 100, clientLimit: 1, trustProxy: true });

    expect((await post(url, { ip: "203.0.113.7" })).status).toBe(200);

    // Over-quota client sending unparseable JSON: the limiter must win.
    // If body parsing ran first, this would surface as 400 invalid_body.
    const blocked = await post(url, { ip: "203.0.113.7", body: "{not-json" });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual({ error: "rate_limited" });

    // Sanity: an under-quota client sending the same malformed body reaches
    // the parser and gets the normal 400, proving the parser itself is fine.
    const parserActive = await post(url, { ip: "203.0.113.8", body: "{not-json" });
    expect(parserActive.status).toBe(400);
    await expect(parserActive.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("resets counts after the window elapses", async () => {
    const { url } = await startApp({
      globalLimit: 100,
      clientLimit: 1,
      windowMs: 250,
      trustProxy: true,
    });

    expect((await post(url, { ip: "203.0.113.9" })).status).toBe(200);
    expect((await post(url, { ip: "203.0.113.9" })).status).toBe(429);

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 450));

    const afterReset = await post(url, { ip: "203.0.113.9" });
    expect(afterReset.status).toBe(200);
    expect(afterReset.headers.get("ratelimit-remaining")).toBe("0");
  });

  it("prevents single-IP lockout amplification (spamming /health cannot lock out /trigger for other clients)", async () => {
    const { url } = await startApp({
      globalLimit: 5,
      clientLimit: 2,
      trustProxy: true,
    });

    // Client A sends 4 requests to unauthenticated /health (exceeding its clientLimit of 2).
    const clientA = "203.0.113.50";
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${url}/health`, {
        headers: { "x-forwarded-for": clientA },
      });
      if (i < 2) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(429);
        await expect(res.json()).resolves.toEqual({ error: "rate_limited" });
      }
    }

    // Client B sends a legitimate request to /trigger.
    // Client A was capped at 2 requests reaching the global pool (out of 5),
    // so Client B must NOT be locked out.
    const clientB = "203.0.113.60";
    const resB = await post(url, { ip: clientB });
    expect(resB.status).toBe(200);
    await expect(resB.json()).resolves.toEqual({ ok: true, summary: "done" });
  });
});
