import { randomUUID } from "node:crypto";

export interface QuoteArgs {
  from_token: string;
  to_token: string;
  amount: string;
}

interface Entry {
  args: QuoteArgs;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;

/**
 * Hard cap on live reservations. `/quote` is unauthenticated and each call mints
 * a fresh entry that lives for TTL_MS, so without a ceiling an attacker could
 * grow the map without bound within the TTL window (memory DoS). When full we
 * evict oldest-first (Map preserves insertion order) — a dropped reservation
 * just means the caller re-quotes, which is safe.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

export function makeQuoteCache(opts: { maxEntries?: number } = {}) {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const store = new Map<string, Entry>();
  function gc(now: number) {
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  }
  function evictToCap() {
    // Remove oldest entries until there's room for one more.
    for (const k of store.keys()) {
      if (store.size < maxEntries) break;
      store.delete(k);
    }
  }
  return {
    issue(args: QuoteArgs): { quote_id: string; expires_at: string } {
      const now = Date.now();
      gc(now);
      if (store.size >= maxEntries) evictToCap();
      const id = randomUUID();
      const expiresAt = now + TTL_MS;
      store.set(id, { args, expiresAt });
      return { quote_id: id, expires_at: new Date(expiresAt).toISOString() };
    },
    lookup(quote_id: string): QuoteArgs | null {
      const now = Date.now();
      const e = store.get(quote_id);
      if (!e) return null;
      if (e.expiresAt <= now) {
        store.delete(quote_id);
        return null;
      }
      return e.args;
    },
  };
}

export type QuoteCache = ReturnType<typeof makeQuoteCache>;
