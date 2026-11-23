import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cockpit/supabase-server', () => ({ getServiceRoleClient: vi.fn() }));

import { countLiveOpenPositions } from '@/lib/auto-exit/auto-exit-scan';

/** A query chain that resolves to `result` whatever filters are applied. */
function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'neq', 'gt']) q[m] = () => q;
  q.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return q;
}

function client(sessions: unknown, positions: unknown): SupabaseClient {
  return { from: (t: string) => chain(t === 'sessions' ? sessions : positions) } as unknown as SupabaseClient;
}

describe('countLiveOpenPositions', () => {
  it('returns 0 when no live session is active', async () => {
    expect(await countLiveOpenPositions(client({ data: [], error: null }, null))).toBe(0);
  });

  it('returns the open position count', async () => {
    expect(await countLiveOpenPositions(client({ data: [{ id: 's1' }], error: null }, { count: 2, error: null }))).toBe(2);
  });

  it('throws on a read error instead of reporting a flat book', async () => {
    await expect(countLiveOpenPositions(client({ data: null, error: { message: 'timeout' } }, null))).rejects.toThrow(/sessions read failed/);
    await expect(
      countLiveOpenPositions(client({ data: [{ id: 's1' }], error: null }, { count: null, error: { message: 'boom' } })),
    ).rejects.toThrow(/positions count failed/);
  });
});
