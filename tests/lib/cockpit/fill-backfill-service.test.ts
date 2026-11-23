import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: () => '0x0000000000000000000000000000000000000001' }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchRecentFills: vi.fn() }));

import { fetchRecentFills } from '@/lib/hyperliquid/hyperliquid-info-service';
import { backfillExchangeFills } from '@/lib/cockpit/fill-backfill-service';

const fill = { coin: 'ETH', side: 'buy' as const, px: 1, sz: 1, time: 1, closedPnl: null, fee: null, dir: null };
const read = (over: Record<string, unknown>) =>
  vi.mocked(fetchRecentFills).mockResolvedValue({ address: '0x1', fills: [fill], fetchedAt: 1, stale: false, ...over } as never);

beforeEach(() => vi.clearAllMocks());

describe('backfillExchangeFills: a failed HL read is never a healed run', () => {
  it('tags a run that booked from cached fills after a failed read', async () => {
    read({ stale: true, error: 'timeout' });
    const r = await backfillExchangeFills({ client: {} as SupabaseClient });
    expect(r.skipped).toBe(false);
    expect(r.incomplete).toMatch(/cached fills: timeout/);
  });

  it('leaves a run on a fresh read untagged', async () => {
    read({});
    const r = await backfillExchangeFills({ client: {} as SupabaseClient });
    expect(r.skipped).toBe(false);
    expect(r.incomplete).toBeUndefined();
  });
});
