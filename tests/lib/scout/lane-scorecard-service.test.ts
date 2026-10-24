import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/scout/scout-session-service', () => ({ scoutSessionIds: vi.fn() }));
vi.mock('@/lib/hyperliquid/candle-service', () => ({ fetchFundingHistory: vi.fn(async () => []) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchVaultDetails: vi.fn(), HLP_VAULT_ADDRESS: 'vault' }));

import { computeScoutLaneCards } from '@/lib/scout/lane-scorecard-service';
import { scoutSessionIds } from '@/lib/scout/scout-session-service';

function strictClient(tables: Record<'positions' | 'fills' | 'hypotheses', unknown[]>, failure: Error | null = null): SupabaseClient {
  return {
    from(table: keyof typeof tables) {
      const result = { data: tables[table], error: table === 'positions' ? failure : null };
      let ordered = false;
      const pageQuery = {
        order: (column: string, options: { ascending: boolean }) => {
          expect(column).toBe('id');
          expect(options).toEqual({ ascending: true });
          ordered = true;
          return pageQuery;
        },
        range: () => {
          expect(ordered).toBe(true);
          return Promise.resolve(result);
        },
      };
      const checked = (column: string, ids: string[]) => {
        expect(column).toBe('session_id');
        expect(ids).toEqual(['session-1']);
        return pageQuery;
      };
      return { select: () => ({
        in: checked,
        eq: (column: string, value: unknown) => {
          expect(column).toBe('excluded');
          expect(value).toBe(false);
          return { in: checked };
        },
      }) };
    },
  } as unknown as SupabaseClient;
}

const qualifyingTables = () => ({
  positions: [{ session_id: 'session-1', coin: 'ETH', side: 'flat', lane: 'trend-follow', realized_pnl_usd: 20_000, fees_paid_usd: 200 }],
  fills: [{ session_id: 'session-1', coin: 'ETH', side: 'buy', sz: 1, px: 2000, filled_at: '2026-10-24T00:00:00Z' }],
  hypotheses: Array.from({ length: 30 }, () => ({ status: 'confirmed', lane: 'trend-follow', realized_r: 0.2, excluded: false })),
});

describe('computeScoutLaneCards', () => {
  it('incomplete_funding_blocks_graduation', async () => {
    vi.mocked(scoutSessionIds).mockResolvedValue(['session-1']);
    const now = Date.parse('2026-10-24T12:00:00Z');
    const result = await computeScoutLaneCards(now, strictClient(qualifyingTables()));
    const lane = result.lanes.find((card) => card.lane === 'trend-follow');
    expect(lane?.detail.fundingMissingHours).toBeGreaterThan(0);
    expect(lane?.verdict).toBe('incomplete');
  });

  it('propagates_database_errors', async () => {
    vi.mocked(scoutSessionIds).mockResolvedValue(['session-1']);
    await expect(computeScoutLaneCards(Date.parse('2026-10-24T12:00:00Z'), strictClient(qualifyingTables(), new Error('positions query failed'))))
      .rejects.toThrow('positions query failed');
  });

  it('counts only the closed statuses in the registered rubric family', async () => {
    vi.mocked(scoutSessionIds).mockResolvedValue(['session-1']);
    const tables: Record<'positions' | 'fills' | 'hypotheses', unknown[]> = qualifyingTables();
    tables.hypotheses = [
      { status: 'confirmed', lane: 'breakdown-short', excluded: false, created_at: '2026-10-01T00:00:00Z' },
      { status: 'invalidated', lane: 'reclaim-long', excluded: false, created_at: '2026-10-01T00:00:00Z' },
      { status: 'resolved', lane: 'breakdown-short', excluded: false, created_at: '2026-10-01T00:00:00Z' },
      { status: 'open', lane: 'reclaim-long', excluded: false, created_at: '2026-10-01T00:00:00Z' },
      { status: 'open', lane: 'unregistered-lane', excluded: false, created_at: '2026-10-01T00:00:00Z' },
      { status: 'confirmed', lane: '', excluded: false, created_at: '2026-10-01T00:00:00Z' },
    ];
    const result = await computeScoutLaneCards(Date.parse('2026-10-24T12:00:00Z'), strictClient(tables));
    expect(result.lanes.find((card) => card.lane === 'breakdown-short')?.tradeCount).toBe(3);
    expect(result.lanes.find((card) => card.lane === 'reclaim-long')?.tradeCount).toBe(3);
    expect(result.lanes.find((card) => card.lane === 'trend-follow')?.tradeCount).toBe(0);
    expect(result.lanes.find((card) => card.lane === 'unregistered-lane')?.tradeCount).toBe(0);
    expect(result.lanes.find((card) => card.lane === 'directional')?.tradeCount).toBe(1);
  });

  const laneCard = async (fills: unknown[]) => {
    vi.mocked(scoutSessionIds).mockResolvedValue(['session-1']);
    const tables: Record<'positions' | 'fills' | 'hypotheses', unknown[]> = qualifyingTables();
    tables.positions[0] = {
      session_id: 'session-1', coin: 'ETH', side: 'long', lane: 'trend-follow', realized_pnl_usd: 0,
      fees_paid_usd: 0, opened_at: '2026-10-23T10:00:00Z', updated_at: '2026-10-23T10:00:00Z',
    };
    tables.fills = fills;
    const result = await computeScoutLaneCards(Date.parse('2026-10-23T12:00:00Z'), strictClient(tables));
    return result.lanes.find((card) => card.lane === 'trend-follow');
  };

  it('charges lane funding for a position opened inside the registration window', async () => {
    const card = await laneCard([{ session_id: 'session-1', coin: 'ETH', side: 'buy', sz: 1, px: 2000, filled_at: '2026-10-23T10:00:00Z' }]);
    expect(card?.detail.fundingMissingHours).toBe(1);
  });

  it('drops a whole position that opened before registration, even when it closes after', async () => {
    // Without the group rule the post-registration closing sell would read as a fresh
    // short and accrue funding until now.
    const card = await laneCard([
      { session_id: 'session-1', coin: 'ETH', side: 'buy', sz: 1, px: 2000, filled_at: '2026-07-27T10:00:00Z' },
      { session_id: 'session-1', coin: 'ETH', side: 'sell', sz: 1, px: 2100, filled_at: '2026-10-23T10:00:00Z' },
    ]);
    expect(card?.detail.fundingMissingHours).toBe(0);
    expect(card?.fundingUsd ?? 0).toBe(0);
  });
});
