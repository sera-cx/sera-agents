/**
 * Payment state machine + persistence.
 *
 * pending → verified → executing → delivered | failed_refundable
 *
 * Idempotency: every state mutation writes via SQLite UPSERT keyed on
 * payment_id. The HTTP layer is then idempotent on retry — a re-issued
 * X-PAYMENT for a payment_id already in `delivered` returns the cached
 * success body, never re-settles, never re-executes.
 *
 * Memory store mirrors SQLite (lookup-cache); SQLite is authoritative on
 * restart.
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";

export type PaymentStatus =
  | "pending"
  | "verified"
  | "executing"
  | "delivered"
  | "failed_refundable";

export interface PendingPayment {
  payment_id: string;
  status: PaymentStatus;
  pay_to: string;
  amount_usdc: number;
  asset: "USDC";
  chain: 1;
  swap_request: {
    from_currency: string;
    to_currency: string;
    amount: number;
    recipient: string;
  };
  created_at: number;        // unix seconds
  expires_at: number;
  /** JSON body returned on idempotent replay after a successful delivery. */
  delivered_payload?: string;
  last_error?: string;
  /** Facilitator settle response (tx_hash + networkId) once settle has succeeded. */
  settlement_payload?: string;
  last_status_change: number;
}

export interface StateStore {
  save(p: PendingPayment): void;
  load(id: string): PendingPayment | undefined;
  /** Atomic compare-and-swap. Returns true if status was updated, false if it didn't match expected. */
  cas(id: string, expected: PaymentStatus, next: PaymentStatus, extra?: Partial<PendingPayment>): boolean;
  /** All `failed_refundable` payments — operator queries for manual refund queue. */
  listFailedRefundable(limit?: number): PendingPayment[];
  size(): number;
  gcExpired(now: number): void;
}

export function makeStore(stateDbPath: string | undefined, pendingMax: number): StateStore {
  const mem = new Map<string, PendingPayment>();
  let db: Database.Database | null = null;

  if (stateDbPath) {
    try {
      db = new Database(resolve(stateDbPath));
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          payment_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          pay_to TEXT NOT NULL,
          amount_usdc REAL NOT NULL,
          chain INTEGER NOT NULL,
          from_currency TEXT NOT NULL,
          to_currency TEXT NOT NULL,
          amount REAL NOT NULL,
          recipient TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          delivered_payload TEXT,
          settlement_payload TEXT,
          last_error TEXT,
          last_status_change INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
        CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments(expires_at);
      `);
      process.stderr.write(`x402: payment state persisted to ${stateDbPath}\n`);
    } catch (e: any) {
      process.stderr.write(
        `x402: failed to open ${stateDbPath} (${e?.message}); falling back to memory only\n`,
      );
      db = null;
    }
  }

  function writeRow(p: PendingPayment): void {
    if (!db) return;
    db.prepare(
      `INSERT INTO payments
         (payment_id, status, pay_to, amount_usdc, chain, from_currency, to_currency, amount,
          recipient, created_at, expires_at, delivered_payload, settlement_payload, last_error,
          last_status_change)
       VALUES
         (@payment_id, @status, @pay_to, @amount_usdc, @chain, @from_currency, @to_currency, @amount,
          @recipient, @created_at, @expires_at, @delivered_payload, @settlement_payload, @last_error,
          @last_status_change)
       ON CONFLICT(payment_id) DO UPDATE SET
         status = excluded.status,
         delivered_payload = excluded.delivered_payload,
         settlement_payload = excluded.settlement_payload,
         last_error = excluded.last_error,
         last_status_change = excluded.last_status_change`,
    ).run({
      payment_id: p.payment_id,
      status: p.status,
      pay_to: p.pay_to,
      amount_usdc: p.amount_usdc,
      chain: p.chain,
      from_currency: p.swap_request.from_currency,
      to_currency: p.swap_request.to_currency,
      amount: p.swap_request.amount,
      recipient: p.swap_request.recipient,
      created_at: p.created_at,
      expires_at: p.expires_at,
      delivered_payload: p.delivered_payload ?? null,
      settlement_payload: p.settlement_payload ?? null,
      last_error: p.last_error ?? null,
      last_status_change: p.last_status_change,
    });
  }

  function readRow(id: string): PendingPayment | undefined {
    if (!db) return undefined;
    const row = db.prepare(`SELECT * FROM payments WHERE payment_id = ?`).get(id) as any;
    if (!row) return undefined;
    return {
      payment_id: row.payment_id,
      status: row.status,
      pay_to: row.pay_to,
      amount_usdc: row.amount_usdc,
      asset: "USDC",
      chain: row.chain,
      swap_request: {
        from_currency: row.from_currency,
        to_currency: row.to_currency,
        amount: row.amount,
        recipient: row.recipient,
      },
      created_at: row.created_at,
      expires_at: row.expires_at,
      delivered_payload: row.delivered_payload ?? undefined,
      settlement_payload: row.settlement_payload ?? undefined,
      last_error: row.last_error ?? undefined,
      last_status_change: row.last_status_change,
    };
  }

  return {
    save(p) {
      mem.set(p.payment_id, p);
      writeRow(p);
    },
    load(id) {
      const cached = mem.get(id);
      if (cached) return cached;
      const row = readRow(id);
      if (row) mem.set(id, row);
      return row;
    },
    cas(id, expected, next, extra) {
      // Atomic via SQLite WHERE status = expected. Memory store updated only
      // when SQLite confirms the write (preserves single-instance correctness).
      if (db) {
        const now = Math.floor(Date.now() / 1000);
        const setParts = [
          "status = @next",
          "last_status_change = @last_status_change",
        ];
        const params: Record<string, unknown> = {
          id,
          expected,
          next,
          last_status_change: now,
        };
        if (extra?.delivered_payload !== undefined) {
          setParts.push("delivered_payload = @delivered_payload");
          params.delivered_payload = extra.delivered_payload;
        }
        if (extra?.settlement_payload !== undefined) {
          setParts.push("settlement_payload = @settlement_payload");
          params.settlement_payload = extra.settlement_payload;
        }
        if (extra?.last_error !== undefined) {
          setParts.push("last_error = @last_error");
          params.last_error = extra.last_error;
        }
        const result = db
          .prepare(
            `UPDATE payments SET ${setParts.join(", ")}
             WHERE payment_id = @id AND status = @expected`,
          )
          .run(params);
        if (result.changes === 0) {
          // Refresh memory cache from disk — another instance may have moved
          // it past the expected state.
          const fresh = readRow(id);
          if (fresh) mem.set(id, fresh);
          return false;
        }
        const fresh = readRow(id);
        if (fresh) mem.set(id, fresh);
        return true;
      }
      // Memory-only CAS.
      const p = mem.get(id);
      if (!p || p.status !== expected) return false;
      p.status = next;
      p.last_status_change = Math.floor(Date.now() / 1000);
      if (extra?.delivered_payload !== undefined) p.delivered_payload = extra.delivered_payload;
      if (extra?.settlement_payload !== undefined) p.settlement_payload = extra.settlement_payload;
      if (extra?.last_error !== undefined) p.last_error = extra.last_error;
      return true;
    },
    listFailedRefundable(limit = 100) {
      if (!db) {
        return Array.from(mem.values())
          .filter((p) => p.status === "failed_refundable")
          .slice(0, limit);
      }
      const rows = db
        .prepare(
          `SELECT * FROM payments WHERE status = 'failed_refundable'
           ORDER BY last_status_change DESC LIMIT ?`,
        )
        .all(limit) as any[];
      return rows.map((row) => ({
        payment_id: row.payment_id,
        status: row.status as PaymentStatus,
        pay_to: row.pay_to,
        amount_usdc: row.amount_usdc,
        asset: "USDC" as const,
        chain: row.chain,
        swap_request: {
          from_currency: row.from_currency,
          to_currency: row.to_currency,
          amount: row.amount,
          recipient: row.recipient,
        },
        created_at: row.created_at,
        expires_at: row.expires_at,
        delivered_payload: row.delivered_payload ?? undefined,
        settlement_payload: row.settlement_payload ?? undefined,
        last_error: row.last_error ?? undefined,
        last_status_change: row.last_status_change,
      }));
    },
    size() {
      return mem.size;
    },
    gcExpired(now) {
      // Memory-only GC; SQLite rows are kept for operator audit.
      for (const [k, v] of mem) {
        if (v.expires_at < now && v.status !== "delivered" && v.status !== "failed_refundable") {
          mem.delete(k);
        }
      }
      // Caller can opportunistically check pendingMax cap.
      void pendingMax;
    },
  };
}
