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
      const checked = (column: string, ids: string[]) => {
        expect(column).toBe('session_id');
        expect(ids).toEqual(['session-1']);
        return Promise.resolve(result);
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
});
