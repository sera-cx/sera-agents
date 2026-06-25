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

export function makeQuoteCache() {
  const store = new Map<string, Entry>();
  function gc(now: number) {
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  }
  return {
    issue(args: QuoteArgs): { quote_id: string; expires_at: string } {
      const now = Date.now();
      gc(now);
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
