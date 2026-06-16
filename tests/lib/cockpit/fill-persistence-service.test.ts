import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseMock, type SupabaseMock } from '../../mocks/supabase.mock';
import {
  persistFillRow,
  applyFillToPositionRows,
} from '@/lib/cockpit/fill-persistence-service';
import type { CanonicalFill } from '@/types/fill';

let mock: SupabaseMock;
let client: SupabaseClient;

beforeEach(() => {
  mock = createSupabaseMock();
  client = mock.client as unknown as SupabaseClient;
});

function fill(over: Partial<CanonicalFill> = {}): CanonicalFill {
  return {
    clientIntentId: 'ci-1',
    sessionId: 's1',
    coin: 'ETH',
    side: 'buy',
    px: 2000,
    sz: 1.5,
    notionalUsd: 3000,
    feeUsd: 1.2,
    reduceOnly: false,
    partial: false,
    source: 'paper',
    hlOrderId: null,
    hlRaw: null,
    filledAt: 1_700_000_000_000,
    ...over,
  };
}

describe('persistFillRow (idempotent fills insert)', () => {
  it('inserts a fills row and returns true on a fresh insert', async () => {
    const inserted = await persistFillRow(fill(), client);
    expect(inserted).toBe(true);
    expect(mock.ops).toHaveLength(1);
    expect(mock.ops[0].table).toBe('fills');
    expect(mock.ops[0].op).toBe('insert');
    expect((mock.ops[0].payload as { client_intent_id: string }).client_intent_id).toBe('ci-1');
  });

  it('treats a duplicate client_intent_id (23505) as a no-op (returns false)', async () => {
    mock.queueResult({ error: { code: '23505', message: 'duplicate key value' } });
    const inserted = await persistFillRow(fill(), client);
    expect(inserted).toBe(false);
  });

  it('detects the duplicate via message when no code is present', async () => {
    mock.queueResult({ error: { message: 'unique constraint client_intent_id' } });
    const inserted = await persistFillRow(fill(), client);
    expect(inserted).toBe(false);
  });

  it('throws on a non-duplicate error', async () => {
    mock.queueResult({ error: { code: '42P01', message: 'relation missing' } });
    await expect(persistFillRow(fill(), client)).rejects.toThrow(/persistFillRow failed/);
  });
});

/** A fills-ledger DB row (snake_case) as returned by the select.order() read. */
function ledgerRow(over: Partial<CanonicalFill> = {}) {
  const f = fill(over);
  return {
    client_intent_id: f.clientIntentId,
    session_id: f.sessionId,
    coin: f.coin,
    side: f.side,
    px: f.px,
    sz: f.sz,
    notional_usd: f.notionalUsd,
    fee_usd: f.feeUsd,
    reduce_only: f.reduceOnly,
    partial: f.partial,
    source: f.source,
    hl_order_id: f.hlOrderId,
    hl_raw: f.hlRaw,
    filled_at: f.filledAt,
  };
}

describe('applyFillToPositionRows (fold WHOLE ledger → upsert positions + insert pnl)', () => {
  it('recomputes the position from the fills ledger (idempotent + crash-safe)', async () => {
    // 1st op = fills ledger read (.order resolves to an array).
    mock.queueResult({ data: [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })], error: null });
    // 2nd op = positions upsert → ok.
    mock.queueResult({ error: null });
    // 3rd op = pnl insert → ok.
    mock.queueResult({ error: null });

    const pos = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), client);

    expect(pos.side).toBe('long');
    expect(pos.sz).toBe(2);
    expect(pos.avgEntryPx).toBe(2000);
    expect(pos.feesPaidUsd).toBe(1);

    // Ops: select(fills), upsert(positions), insert(pnl).
    expect(mock.ops.map((o) => `${o.op}:${o.table}`)).toEqual([
      'select:fills',
      'upsert:positions',
      'insert:pnl',
    ]);

    const selectOp = mock.ops[0];
    expect(selectOp.filters).toEqual([
      { column: 'session_id', value: 's1' },
      { column: 'coin', value: 'ETH' },
    ]);
    expect(selectOp.order).toEqual([
      { column: 'filled_at', options: { ascending: true } },
      { column: 'id', options: { ascending: true } },
    ]);

    const upsertOp = mock.ops[1];
    expect(upsertOp.options).toEqual({ onConflict: 'session_id,coin' });
    expect((upsertOp.payload as { sz: number }).sz).toBe(2);
  });

  it('folds a multi-fill ledger (two adds blend the avg entry)', async () => {
    // Ledger has BOTH fills (the just-persisted one is already in the table).
    mock.queueResult({
      data: [
        ledgerRow({ clientIntentId: 'a', sz: 1, px: 2000, feeUsd: 1, filledAt: 1 }),
        ledgerRow({ clientIntentId: 'b', sz: 1, px: 2200, feeUsd: 0.5, filledAt: 2 }),
      ],
      error: null,
    });
    mock.queueResult({ error: null }); // upsert
    mock.queueResult({ error: null }); // pnl

    const pos = await applyFillToPositionRows(fill({ clientIntentId: 'b', sz: 1, px: 2200, feeUsd: 0.5 }), client);
    expect(pos.sz).toBe(2);
    expect(pos.avgEntryPx).toBe(2100);
    expect(pos.feesPaidUsd).toBe(1.5);
  });

  it('a re-run with the SAME ledger yields the SAME position (no double-count)', async () => {
    const data = [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })];
    mock.queueResult({ data, error: null });
    mock.queueResult({ error: null });
    mock.queueResult({ error: null });
    const first = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), client);

    mock.reset();
    mock.queueResult({ data, error: null });
    mock.queueResult({ error: null });
    mock.queueResult({ error: null });
    const second = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), client);

    expect(second).toEqual(first); // idempotent — folding the same ledger twice
  });

  it('throws when the ledger load fails', async () => {
    mock.queueResult({ error: { message: 'load boom' } });
    await expect(applyFillToPositionRows(fill(), client)).rejects.toThrow(/load failed: load boom/);
  });
});
