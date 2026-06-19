import { describe, it, expect } from 'vitest';
import { acquireExitLock, releaseExitLock } from '@/lib/auto-exit/auto-exit-lock-service';
import { createSupabaseMock } from '../../mocks/supabase.mock';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('auto-exit-lock-service', () => {
  it('acquires a lock when none is held (reap then insert wins)', async () => {
    const mock = createSupabaseMock();
    mock.queueResult({ data: null, error: null }); // reap (no expired locks)
    mock.queueResult({ data: { id: 'lock1' }, error: null }); // insert succeeds
    const lock = await acquireExitLock(
      's1',
      'eth',
      { reason: 'liq-proximity', nowMs: 1_000, ttlMs: 120_000 },
      mock.client as unknown as SupabaseClient,
    );
    expect(lock).not.toBeNull();
    expect(lock!.id).toBe('lock1');
    expect(lock!.coin).toBe('ETH'); // normalized
    expect(lock!.expiresAt).toBe(121_000);
    // reap update + insert recorded
    expect(mock.ops.some((o) => o.op === 'update')).toBe(true);
    expect(mock.ops.some((o) => o.op === 'insert')).toBe(true);
  });

  it('returns null on a unique violation (concurrent loser / cooldown)', async () => {
    const mock = createSupabaseMock();
    mock.queueResult({ data: null, error: null }); // reap
    mock.queueResult({ data: null, error: { message: 'duplicate key', code: '23505' } }); // insert conflict
    const lock = await acquireExitLock(
      's1',
      'ETH',
      { reason: 'x', nowMs: 1_000, ttlMs: 120_000 },
      mock.client as unknown as SupabaseClient,
    );
    expect(lock).toBeNull();
  });

  it('throws on a non-conflict insert error', async () => {
    const mock = createSupabaseMock();
    mock.queueResult({ data: null, error: null }); // reap
    mock.queueResult({ data: null, error: { message: 'boom' } }); // insert error (no 23505)
    await expect(
      acquireExitLock('s1', 'ETH', { reason: 'x', nowMs: 1, ttlMs: 1 }, mock.client as unknown as SupabaseClient),
    ).rejects.toThrow(/boom/);
  });

  it('releases a lock by id', async () => {
    const mock = createSupabaseMock();
    mock.queueResult({ data: null, error: null });
    await releaseExitLock('lock1', 'failed', mock.client as unknown as SupabaseClient);
    const upd = mock.ops.find((o) => o.op === 'update');
    expect(upd).toBeTruthy();
    expect(upd!.filters.some((f) => f.column === 'id' && f.value === 'lock1')).toBe(true);
  });
});
