/**
 * Quote store — bridges /quote and /settle.
 *
 * /quote prices with a burn-address `simulate` call (no wallet needed) and
 * returns an opaque quote_id. /settle later needs the original {from,to,amount}
 * to re-quote against the caller's REAL signer, so we stash them here keyed by
 * the quote_id we minted.
 *
 * In-memory + single-instance by design. A horizontally-scaled deploy needs a
 * shared store (e.g. Redis) so a /settle that lands on replica B can find a
 * /quote served by replica A. Documented in README.
 */
import { randomUUID } from "node:crypto";

export interface QuoteRecord {
  from: string;
  to: string;
  amount: string;
}

export interface QuoteStore {
  /** Store inputs, return a fresh opaque quote_id. */
  put(rec: QuoteRecord, expiresAt?: string): string;
  /** Retrieve inputs by quote_id, or undefined if unknown/expired. */
  get(id: string): QuoteRecord | undefined;
  /** Live (non-expired) entry count. */
  size(): number;
}

export function createQuoteStore(opts: { ttlMs?: number; now?: () => number } = {}): QuoteStore {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, { rec: QuoteRecord; expiresAtMs: number }>();

  function gc(): void {
    const t = now();
    for (const [id, e] of map) if (e.expiresAtMs <= t) map.delete(id);
  }

  return {
    put(rec, expiresAt) {
      gc();
      const id = randomUUID();
      const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
      // Honor the quote's own expiry when present; otherwise fall back to ttlMs.
      const expiresAtMs = Number.isFinite(parsed) ? parsed : now() + ttlMs;
      map.set(id, { rec, expiresAtMs });
      return id;
    },
    get(id) {
      const e = map.get(id);
      if (!e) return undefined;
      if (e.expiresAtMs <= now()) {
        map.delete(id);
        return undefined;
      }
      return e.rec;
    },
    size() {
      gc();
      return map.size;
    },
  };
}
