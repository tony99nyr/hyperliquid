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

describe('applyFillToPositionRows (fold WHOLE ledger → version-checked apply_position_fold RPC)', () => {
  type FoldArgs = Record<string, unknown>;

  it('folds the ledger and writes it through the RPC with the ledger row count', async () => {
    mock.queueResult({ data: [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })], error: null });
    mock.queueResult({ data: true, error: null }); // rpc applied

    const pos = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), undefined, client);

    expect(pos).toMatchObject({ side: 'long', sz: 2, avgEntryPx: 2000, feesPaidUsd: 1 });
    expect(mock.ops.map((o) => `${o.op}:${o.table}`)).toEqual(['select:fills', 'rpc:apply_position_fold']);
    expect(mock.ops[0].filters).toEqual([
      { column: 'session_id', value: 's1' },
      { column: 'coin', value: 'ETH' },
    ]);
    expect(mock.ops[0].order).toEqual([
      { column: 'filled_at', options: { ascending: true } },
      { column: 'id', options: { ascending: true } },
    ]);
    expect(mock.ops[1].payload).toMatchObject({
      p_session_id: 's1',
      p_coin: 'ETH',
      p_side: 'long',
      p_sz: 2,
      p_avg_entry_px: 2000,
      p_fees_paid_usd: 1,
      p_leverage: null,
      p_lane: null,
      p_ledger_fill_count: 1,
    });
  });

  it('sends the ledger count of a multi-fill ledger (the version the RPC compares)', async () => {
    mock.queueResult({
      data: [
        ledgerRow({ clientIntentId: 'a', sz: 1, px: 2000, feeUsd: 1, filledAt: 1 }),
        ledgerRow({ clientIntentId: 'b', sz: 1, px: 2200, feeUsd: 0.5, filledAt: 2 }),
      ],
      error: null,
    });
    mock.queueResult({ data: true, error: null });

    const pos = await applyFillToPositionRows(fill({ clientIntentId: 'b', sz: 1, px: 2200, feeUsd: 0.5 }), undefined, client);
    expect(pos).toMatchObject({ sz: 2, avgEntryPx: 2100, feesPaidUsd: 1.5 });
    expect((mock.ops[1].payload as FoldArgs).p_ledger_fill_count).toBe(2);
  });

  it('passes the opening leverage and lane (metadata, not folded)', async () => {
    mock.queueResult({ data: [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })], error: null });
    mock.queueResult({ data: true, error: null });

    await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), 5, client, ' carry ');

    expect(mock.ops[1].payload).toMatchObject({ p_leverage: 5, p_lane: 'carry' });
  });

  it('a stale fold that the RPC refuses (false) resolves without a further write', async () => {
    mock.queueResult({ data: [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })], error: null });
    mock.queueResult({ data: false, error: null });

    await expect(applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), undefined, client)).resolves.toMatchObject({ sz: 2 });
    expect(mock.ops).toHaveLength(2);
  });

  it('reads a ledger longer than one page and counts every fill', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) =>
      ledgerRow({ clientIntentId: `p1-${i}`, sz: 0.001, px: 2000, feeUsd: 0, filledAt: i + 1 }),
    );
    // Page 2 repeats the last row of page 1 (a concurrent insert shifted it) and adds
    // one older fill that committed during the read.
    const page2 = [page1[999], ledgerRow({ clientIntentId: 'late', sz: 1, px: 2000, feeUsd: 0, filledAt: 0 })];
    mock.queueResult({ data: page1, error: null });
    mock.queueResult({ data: page2, error: null });
    mock.queueResult({ data: true, error: null });

    const pos = await applyFillToPositionRows(fill(), undefined, client);

    expect(mock.ops.slice(0, 2).map((o) => o.range)).toEqual([{ from: 0, to: 999 }, { from: 1000, to: 1999 }]);
    expect((mock.ops[2].payload as FoldArgs).p_ledger_fill_count).toBe(1001);
    expect(pos.sz).toBeCloseTo(2);
  });

  it('throws when the RPC fails for any reason other than a missing function', async () => {
    mock.queueResult({ data: [ledgerRow()], error: null });
    mock.queueResult({ error: { code: '57014', message: 'statement timeout' } });
    await expect(applyFillToPositionRows(fill(), undefined, client)).rejects.toThrow(/fold write failed: statement timeout/);
  });

  it('a re-run with the SAME ledger yields the SAME position (no double-count)', async () => {
    const data = [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })];
    mock.queueResult({ data, error: null });
    mock.queueResult({ data: true, error: null });
    const first = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), undefined, client);

    mock.reset();
    mock.queueResult({ data, error: null });
    mock.queueResult({ data: true, error: null });
    const second = await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), undefined, client);

    expect(second).toEqual(first);
  });

  it('throws when the ledger load fails', async () => {
    mock.queueResult({ error: { message: 'load boom' } });
    await expect(applyFillToPositionRows(fill(), undefined, client)).rejects.toThrow(/load failed: load boom/);
  });

  describe('fallback while migration 0052 is not applied (RPC missing)', () => {
    const missing = { error: { code: 'PGRST202', message: 'Could not find the function public.apply_position_fold' } };

    it('falls back to the plain upsert + pnl insert', async () => {
      mock.queueResult({ data: [ledgerRow({ sz: 2, px: 2000, feeUsd: 1 })], error: null });
      mock.queueResult(missing);
      mock.queueResult({ error: null }); // upsert
      mock.queueResult({ error: null }); // pnl

      await applyFillToPositionRows(fill({ sz: 2, px: 2000, feeUsd: 1 }), 5, client);

      expect(mock.ops.map((o) => `${o.op}:${o.table}`)).toEqual([
        'select:fills',
        'rpc:apply_position_fold',
        'upsert:positions',
        'insert:pnl',
      ]);
      expect(mock.ops[2].options).toEqual({ onConflict: 'session_id,coin' });
      expect(mock.ops[2].payload).toMatchObject({ sz: 2, leverage: 5 });
    });

    it('does not fall back for an undefined function inside the RPC body', async () => {
      mock.queueResult({ data: [ledgerRow()], error: null });
      mock.queueResult({ error: { code: '42883', message: 'operator does not exist: text = uuid' } });
      await expect(applyFillToPositionRows(fill(), undefined, client)).rejects.toThrow(/fold write failed/);
      expect(mock.ops).toHaveLength(2);
    });

    it('LEVERAGE-PRESERVATION CONTRACT: a reduce-only re-fold OMITS leverage from the upsert', async () => {
      // A reduce-only fold does not know the entry leverage. The upsert must leave the
      // column out (not null), so PostgREST keeps the stored entry leverage (drives ROE).
      mock.queueResult({
        data: [
          ledgerRow({ clientIntentId: 'open', sz: 2, px: 2000, feeUsd: 1, filledAt: 1 }),
          ledgerRow({ clientIntentId: 'reduce', side: 'sell', sz: 1, px: 2100, feeUsd: 0.5, reduceOnly: true, filledAt: 2 }),
        ],
        error: null,
      });
      mock.queueResult(missing);
      mock.queueResult({ error: null });
      mock.queueResult({ error: null });

      await applyFillToPositionRows(
        fill({ clientIntentId: 'reduce', side: 'sell', sz: 1, px: 2100, feeUsd: 0.5, reduceOnly: true }),
        undefined,
        client,
      );
      const payload = mock.ops[2].payload as Record<string, unknown>;
      expect(payload.sz).toBe(1);
      expect('leverage' in payload).toBe(false);
    });
  });
});
