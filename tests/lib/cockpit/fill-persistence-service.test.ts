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

describe('applyFillToPositionRows (load → fold → upsert positions + insert pnl)', () => {
  it('opens a position from flat: writes positions + pnl rows', async () => {
    // 1st op = positions select (no prior position) → null data.
    mock.queueResult({ data: null, error: null });
    // 2nd op = positions upsert → ok.
    mock.queueResult({ error: null });
    // 3rd op = pnl insert → ok.
    mock.queueResult({ error: null });

    const pos = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), client);

    expect(pos.side).toBe('long');
    expect(pos.sz).toBe(2);
    expect(pos.avgEntryPx).toBe(2000);
    expect(pos.feesPaidUsd).toBe(1);

    // Ops: select(positions), upsert(positions), insert(pnl).
    expect(mock.ops.map((o) => `${o.op}:${o.table}`)).toEqual([
      'select:positions',
      'upsert:positions',
      'insert:pnl',
    ]);

    const selectOp = mock.ops[0];
    expect(selectOp.filters).toEqual([
      { column: 'session_id', value: 's1' },
      { column: 'coin', value: 'ETH' },
    ]);

    const upsertOp = mock.ops[1];
    expect(upsertOp.options).toEqual({ onConflict: 'session_id,coin' });
    expect((upsertOp.payload as { sz: number }).sz).toBe(2);

    const pnlOp = mock.ops[2];
    expect((pnlOp.payload as { realized_pnl_usd: number }).realized_pnl_usd).toBe(0);
  });

  it('folds onto a prior position loaded from the DB', async () => {
    // Prior: long 1 @ 2000.
    mock.queueResult({
      data: {
        coin: 'ETH',
        side: 'long',
        sz: 1,
        avg_entry_px: 2000,
        realized_pnl_usd: 0,
        fees_paid_usd: 1,
      },
      error: null,
    });
    mock.queueResult({ error: null }); // upsert
    mock.queueResult({ error: null }); // pnl

    // Add 1 more @ 2200 → blended avg 2100, size 2.
    const pos = await applyFillToPositionRows(fill({ sz: 1, px: 2200, feeUsd: 0.5 }), client);
    expect(pos.sz).toBe(2);
    expect(pos.avgEntryPx).toBe(2100);
    expect(pos.feesPaidUsd).toBe(1.5);
  });

  it('throws when the position load fails', async () => {
    mock.queueResult({ error: { message: 'load boom' } });
    await expect(applyFillToPositionRows(fill(), client)).rejects.toThrow(/load failed: load boom/);
  });
});
