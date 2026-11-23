import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: vi.fn() }));
vi.mock('@/lib/infrastructure/notify/discord-notify', () => ({ sendDiscord: vi.fn() }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: () => '0xnot-an-address' }));
const read = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchClearinghouseState: vi.fn(async () => read.value),
}));

import { reconcileLivePositions } from '@/lib/cockpit/position-reconcile-service';

describe('reconcileLivePositions', () => {
  it.each([
    ['carries an error (invalid address)', { positions: [], stale: false, positionsListed: true, error: 'Invalid Hyperliquid address' }],
    ['lists no assetPositions', { positions: [], stale: false }],
  ])('refuses to reconcile when the clearinghouse read %s', async (_label, value) => {
    read.value = value;
    const from = vi.fn();
    const result = await reconcileLivePositions({ from } as unknown as SupabaseClient);
    expect(result.skipped).toBe(true);
    expect(result.flattened).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('reconcileLivePositions: a fold that lands after the read', () => {
  const ROW = { session_id: 's1', coin: 'ETH', side: 'long', sz: 1, avg_entry_px: 2000, leverage: 5, updated_at: '2026-11-20T00:00:00.123456+00:00' };

  /** A fake client: one live session, one open ETH row, and the update returns `updated` rows. */
  function fakeDb(updated: unknown[]) {
    const updates: Array<{ filters: Array<[string, unknown]> }> = [];
    const from = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let isUpdate = false;
      const result = () => {
        if (isUpdate) return { data: updated, error: null };
        if (table === 'sessions') return { data: [{ id: 's1' }], error: null };
        if (table === 'positions') return { data: [ROW], error: null };
        return { data: null, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        update: () => ((isUpdate = true), updates.push({ filters }), b),
        eq: (col: string, val: unknown) => (filters.push([col, val]), b),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
      };
      for (const m of ['neq', 'in']) b[m] = () => b;
      return b;
    };
    return { client: { from } as unknown as SupabaseClient, updates };
  }

  it('flattens only while the row still has the updated_at it was read with', async () => {
    read.value = { positions: [], stale: false, positionsListed: true };
    const { client, updates } = fakeDb([{ coin: 'ETH' }]);
    const r = await reconcileLivePositions(client);
    expect(r.flattened).toBe(1);
    expect(updates[0].filters).toContainEqual(['updated_at', ROW.updated_at]);
  });

  it('skips the flatten when a fold changed the row after the read', async () => {
    read.value = { positions: [], stale: false, positionsListed: true };
    const { client } = fakeDb([]);
    const r = await reconcileLivePositions(client);
    expect(r.flattened).toBe(0);
  });
});
