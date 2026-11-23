import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));

import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { restartDegradedClockAfterOutage } from '@/lib/scout/scout-heartbeat-service';

const NOW = 1_784_300_000_000;
const MIN = 60_000;
let updates: Array<{ row: Record<string, unknown>; source: unknown }>;

function withReconcileRow(result: { data: unknown; error: unknown }) {
  updates = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => result;
  q.update = (row: Record<string, unknown>) => ({
    eq: async (_c: string, source: unknown) => {
      updates.push({ row, source });
      return { error: null };
    },
  });
  vi.mocked(getServiceRoleClient).mockReturnValue({ from: () => q } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('restartDegradedClockAfterOutage', () => {
  it('after an outage (previous run 2h old), moves reconcile-ok up to now', async () => {
    withReconcileRow({ data: { last_tick_at: new Date(NOW - 120 * MIN).toISOString() }, error: null });
    await restartDegradedClockAfterOutage(NOW);
    expect(updates).toEqual([{ row: { last_tick_at: new Date(NOW).toISOString() }, source: 'reconcile-ok' }]);
  });

  it('with no previous reconcile run, restarts the clock', async () => {
    withReconcileRow({ data: null, error: null });
    await restartDegradedClockAfterOutage(NOW);
    expect(updates).toEqual([{ row: { last_tick_at: new Date(NOW).toISOString() }, source: 'reconcile-ok' }]);
  });

  it('inside a running degraded stretch (previous run minutes old), keeps the clock', async () => {
    withReconcileRow({ data: { last_tick_at: new Date(NOW - 5 * MIN).toISOString() }, error: null });
    await restartDegradedClockAfterOutage(NOW);
    expect(updates).toHaveLength(0);
  });

  it('on a read error, keeps the clock (never hides a real degraded stretch)', async () => {
    withReconcileRow({ data: null, error: { message: 'timeout' } });
    await restartDegradedClockAfterOutage(NOW);
    expect(updates).toHaveLength(0);
  });
});
