import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: () => '0x0000000000000000000000000000000000000001' }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchRecentFills: vi.fn() }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: vi.fn(async () => {}) }));
vi.mock('@/lib/infrastructure/notify/discord-notify', () => ({ sendDiscord: vi.fn(async () => {}) }));

import { fetchRecentFills } from '@/lib/hyperliquid/hyperliquid-info-service';
import { backfillExchangeFills } from '@/lib/cockpit/fill-backfill-service';

const fill = { coin: 'ETH', side: 'buy' as const, px: 1, sz: 1, time: 1, closedPnl: null, fee: null, dir: null };
const read = (over: Record<string, unknown>) =>
  vi.mocked(fetchRecentFills).mockResolvedValue({ address: '0x1', fills: [fill], fetchedAt: 1, stale: false, ...over } as never);

beforeEach(() => vi.clearAllMocks());

describe('backfillExchangeFills: a failed HL read is never a healed run', () => {
  it('tags a run that booked from cached fills after a failed read', async () => {
    read({ stale: true, error: 'timeout' });
    const r = await backfillExchangeFills({ client: fakeClient(() => ({ data: [] })).client });
    expect(r.skipped).toBe(false);
    expect(r.incomplete).toMatch(/cached fills: timeout/);
  });

  it('leaves a run on a fresh read untagged', async () => {
    read({});
    const r = await backfillExchangeFills({ client: fakeClient(() => ({ data: [] })).client });
    expect(r.skipped).toBe(false);
    expect(r.incomplete).toBeUndefined();
  });
});

type Result = { data?: unknown; error?: { message: string; code?: string } | null };
type Call = { table: string; op: string; payload?: unknown; cols?: string; contains?: unknown };

/** A chainable fake client: `respond` picks each query's result from its table, op and columns. */
function fakeClient(respond: (c: Call) => Result) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: 'select' };
    const done = () => {
      calls.push(call);
      return Promise.resolve({ data: null, error: null, ...respond(call) });
    };
    const b: Record<string, unknown> = {
      select: (cols: string) => ((call.cols = cols), b),
      insert: (payload: unknown) => ((call.op = 'insert'), (call.payload = payload), b),
      update: (payload: unknown) => ((call.op = 'update'), (call.payload = payload), b),
      upsert: (payload: unknown) => ((call.op = 'upsert'), (call.payload = payload), b),
      contains: (_col: string, value: unknown) => ((call.contains = value), b),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => done().then(ok, bad),
    };
    for (const m of ['eq', 'neq', 'in', 'order', 'limit']) b[m] = () => b;
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const SESSION = { id: 's1', status: 'active', created_at: '2026-11-01' };
const withOid = { ...fill, oid: 42 };

describe('backfillExchangeFills: a fill that fails to book is retried', () => {
  it('reports a failed insert as incomplete', async () => {
    read({ fills: [withOid] });
    const { client } = fakeClient((c) => {
      if (c.table === 'sessions') return { data: [SESSION] };
      if (c.table === 'fills' && c.op === 'insert') return { error: { message: 'connection reset', code: '08006' } };
      return { data: [] };
    });
    const r = await backfillExchangeFills({ client });
    expect(r.inserted).toBe(0);
    expect(r.incomplete).toBe('1 fill(s) failed to book');
  });

  it('marks an inserted fill foldPending and keeps the marker when the fold fails', async () => {
    read({ fills: [withOid] });
    const { client, calls } = fakeClient((c) => {
      if (c.table === 'sessions') return { data: [SESSION] };
      if (c.table === 'positions' && c.op === 'upsert') return { error: { message: 'timeout' } };
      return { data: [] };
    });
    const r = await backfillExchangeFills({ client });
    expect(r.incomplete).toBe('1 fill(s) failed to book');
    const insert = calls.find((c) => c.table === 'fills' && c.op === 'insert');
    expect((insert?.payload as { hl_raw: { foldPending: boolean } }).hl_raw.foldPending).toBe(true);
    expect(calls.some((c) => c.table === 'fills' && c.op === 'update')).toBe(false);
  });

  it('clears the marker after a fold that succeeds', async () => {
    read({ fills: [withOid] });
    const { client, calls } = fakeClient((c) => (c.table === 'sessions' ? { data: [SESSION] } : { data: [] }));
    const r = await backfillExchangeFills({ client });
    expect(r).toMatchObject({ inserted: 1 });
    expect(r.incomplete).toBeUndefined();
    const update = calls.find((c) => c.table === 'fills' && c.op === 'update');
    expect((update?.payload as { hl_raw: Record<string, unknown> }).hl_raw).toEqual({ backfill: true, rows: expect.any(Array) });
  });

  // The marker query must stay independent of the HL window: here HL returns no fills at all.
  const PENDING = { hl_order_id: '42', session_id: 's1', coin: 'ETH', hl_raw: { backfill: true, foldPending: true, rows: [] } };
  const LEDGER = {
    client_intent_id: 'c1', session_id: 's1', coin: 'ETH', side: 'buy', px: 100, sz: 2, notional_usd: 200, fee_usd: 0,
    reduce_only: false, partial: false, source: 'live', hl_order_id: '42', hl_raw: null, filled_at: '2026-11-20T00:00:00Z',
  };
  const pendingClient = (over: (c: Call) => Result | undefined = () => undefined) =>
    fakeClient((c) => {
      const o = over(c);
      if (o) return o;
      if (c.table === 'fills' && c.contains) return { data: [PENDING] };
      if (c.table === 'fills' && c.cols?.startsWith('client_intent_id')) return { data: [LEDGER] };
      return { data: [] };
    });

  it('re-folds a marked row outside the HL window, then clears the marker', async () => {
    read({ fills: [] });
    const { client, calls } = pendingClient();
    const r = await backfillExchangeFills({ client });
    expect(r.incomplete).toBeUndefined();
    expect(calls.find((c) => c.contains)?.contains).toEqual({ foldPending: true });
    const upsert = calls.find((c) => c.table === 'positions' && c.op === 'upsert');
    expect(upsert?.payload).toMatchObject({ session_id: 's1', coin: 'ETH', sz: 2 });
    const update = calls.find((c) => c.table === 'fills' && c.op === 'update');
    expect(update?.payload).toEqual({ hl_raw: { backfill: true, rows: [] } });
  });

  it('re-folds during an HL outage and reports a failed marker clear as pending', async () => {
    read({ fills: [], error: 'timeout' });
    const { client, calls } = pendingClient((c) => (c.table === 'fills' && c.op === 'update' ? { error: { message: 'timeout' } } : undefined));
    const r = await backfillExchangeFills({ client });
    expect(r.skipped).toBe(true);
    expect(calls.some((c) => c.table === 'positions' && c.op === 'upsert')).toBe(true);
    expect(r.incomplete).toBe('1 fold(s) pending');
  });

  it('reports a re-fold that fails again as a pending fold and keeps the marker', async () => {
    read({ fills: [] });
    const { client, calls } = pendingClient((c) =>
      c.table === 'positions' && c.op === 'upsert' ? { error: { message: 'timeout' } } : undefined,
    );
    const r = await backfillExchangeFills({ client });
    expect(r.incomplete).toBe('1 fold(s) pending');
    expect(calls.some((c) => c.table === 'fills' && c.op === 'update')).toBe(false);
  });
});
