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
