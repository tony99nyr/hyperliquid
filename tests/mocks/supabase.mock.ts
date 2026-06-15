/**
 * Supabase client mock for cockpit-service unit tests.
 *
 * The real `@supabase/supabase-js` client exposes a fluent builder
 * (`client.from(table).insert(row).select().single()` etc.). The cockpit
 * services use a small, well-defined subset of that surface; this mock records
 * every call so a test can assert WHICH table was written and WHAT row shape was
 * sent, and can program return values / errors per operation.
 *
 * It is deliberately thin — it mimics only the chain shapes the services use:
 *   from(t).insert(row).select().single()
 *   from(t).insert(row)                       (fire-and-forget insert)
 *   from(t).upsert(row, opts).select().single()
 *   from(t).select(cols).eq(c, v).maybeSingle()
 *   from(t).update(row).eq(c, v)
 *   from(t).update(row).eq(c, v).eq(c, v)
 *
 * Each terminal returns a thenable `{ data, error }` so `await` works whether
 * the caller awaits the builder directly or a terminal like `.single()`.
 */

import { vi } from 'vitest';

export interface RecordedOp {
  table: string;
  /** 'insert' | 'upsert' | 'update' | 'select' */
  op: string;
  /** The row(s) passed to insert/upsert/update. */
  payload?: unknown;
  /** Options passed to insert/upsert (e.g. onConflict). */
  options?: unknown;
  /** Equality filters applied via .eq(col, val), in call order. */
  filters: Array<{ column: string; value: unknown }>;
}

export interface SupabaseMockResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

export interface SupabaseMock {
  client: {
    from: ReturnType<typeof vi.fn>;
  };
  /** Every terminal operation in call order. */
  ops: RecordedOp[];
  /** Program the result for the NEXT terminal op (queue, FIFO). */
  queueResult(result: SupabaseMockResult): void;
  /** Reset recorded ops + queued results. */
  reset(): void;
}

/**
 * Build a fresh Supabase mock. The default terminal result is
 * `{ data: null, error: null }`; queue specific results via `queueResult`.
 */
export function createSupabaseMock(): SupabaseMock {
  const ops: RecordedOp[] = [];
  const resultQueue: SupabaseMockResult[] = [];

  function nextResult(): SupabaseMockResult {
    return resultQueue.shift() ?? { data: null, error: null };
  }

  function makeBuilder(op: RecordedOp) {
    // A terminal resolves to { data, error }; the builder itself is thenable so
    // either `await builder` or `await builder.single()` works.
    const resolve = () => Promise.resolve(nextResult());

    const builder: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        op.filters.push({ column, value });
        return builder;
      },
      select(_cols?: string) {
        op.op = op.op === 'select' ? 'select' : op.op; // keep write op label
        return builder;
      },
      single() {
        return resolve();
      },
      maybeSingle() {
        return resolve();
      },
      // Make the builder awaitable directly (fire-and-forget insert/update).
      then(onFulfilled: (v: SupabaseMockResult) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolve().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const from = vi.fn((table: string) => ({
    insert(payload: unknown, options?: unknown) {
      const op: RecordedOp = { table, op: 'insert', payload, options, filters: [] };
      ops.push(op);
      return makeBuilder(op);
    },
    upsert(payload: unknown, options?: unknown) {
      const op: RecordedOp = { table, op: 'upsert', payload, options, filters: [] };
      ops.push(op);
      return makeBuilder(op);
    },
    update(payload: unknown) {
      const op: RecordedOp = { table, op: 'update', payload, filters: [] };
      ops.push(op);
      return makeBuilder(op);
    },
    select(_cols?: string) {
      const op: RecordedOp = { table, op: 'select', filters: [] };
      ops.push(op);
      return makeBuilder(op);
    },
  }));

  return {
    client: { from },
    ops,
    queueResult(result: SupabaseMockResult) {
      resultQueue.push(result);
    },
    reset() {
      ops.length = 0;
      resultQueue.length = 0;
      from.mockClear();
    },
  };
}
