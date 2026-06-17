/**
 * Pins the approval-gate I/O: pollPendingAction resolves TRUE only on
 * 'approved'; 'rejected' ⇒ false; timeout ⇒ marks 'expired' and returns false
 * (NO-AUTO-FIRE). decidePendingAction enforces the atomic pending→decided
 * transition. The Supabase client is the recording mock.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSupabaseMock } from '../../mocks/supabase.mock';
import {
  pollPendingAction,
  decidePendingAction,
  createPendingAction,
  expirePendingAction,
} from '@/lib/cockpit/pending-actions-service';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingActionProposal } from '@/types/cockpit';

let mock: ReturnType<typeof createSupabaseMock>;
const client = () => mock.client as unknown as SupabaseClient;

const proposal: PendingActionProposal = {
  intent: {
    clientIntentId: 'i1',
    sessionId: 's1',
    coin: 'ETH',
    side: 'buy',
    sz: 1,
    reduceOnly: false,
    createdAt: 0,
  },
  display: { coin: 'ETH', side: 'buy', sz: 1, rationale: 'test' },
};

beforeEach(() => {
  mock = createSupabaseMock();
});

describe('pollPendingAction — NO-AUTO-FIRE default', () => {
  const noSleep = async () => {};

  it('resolves TRUE on approved', async () => {
    mock.queueResult({ data: { status: 'pending' }, error: null });
    mock.queueResult({ data: { status: 'approved' }, error: null });
    const ok = await pollPendingAction('a1', { sleep: noSleep, pollIntervalMs: 1, timeoutMs: 999_999 }, client());
    expect(ok).toBe(true);
  });

  it('resolves FALSE on rejected', async () => {
    mock.queueResult({ data: { status: 'rejected' }, error: null });
    const ok = await pollPendingAction('a1', { sleep: noSleep, timeoutMs: 999_999 }, client());
    expect(ok).toBe(false);
  });

  it('TIMES OUT → marks expired and returns FALSE', async () => {
    // Always pending; an injected clock jumps past the deadline on the 2nd read.
    mock.queueResult({ data: { status: 'pending' }, error: null });
    mock.queueResult({ data: { status: 'pending' }, error: null });
    let t = 0;
    const now = () => {
      const v = t;
      t += 60_000; // each call advances 60s
      return v;
    };
    const ok = await pollPendingAction(
      'a1',
      { sleep: noSleep, now, timeoutMs: 1_000, pollIntervalMs: 1 },
      client(),
    );
    expect(ok).toBe(false);
    // The last op must be the 'expired' update on the pending row.
    const update = mock.ops.find((o) => o.op === 'update' && o.table === 'pending_actions');
    expect(update).toBeTruthy();
    expect((update!.payload as { status: string }).status).toBe('expired');
  });

  it('APPROVE-AT-DEADLINE: expire misses (already approved) → re-read sees approved → TRUE', async () => {
    // 1st read: still pending. Clock then jumps past the deadline. The
    // conditional expire is a no-op (row already approved), and the post-expire
    // RE-READ observes 'approved' — the user beat the timer, so we execute.
    mock.queueResult({ data: { status: 'pending' }, error: null }); // initial poll read
    mock.queueResult({ data: null, error: null }); // expire update (no-op, row not pending)
    mock.queueResult({ data: { status: 'approved' }, error: null }); // post-expire re-read
    let t = 0;
    const now = () => {
      const v = t;
      t += 60_000;
      return v;
    };
    const ok = await pollPendingAction(
      'a1',
      { sleep: noSleep, now, timeoutMs: 1_000, pollIntervalMs: 1 },
      client(),
    );
    expect(ok).toBe(true);
  });
});

describe('decidePendingAction — atomic pending→decided', () => {
  it('returns true when a pending row was decided (rows returned)', async () => {
    mock.queueResult({ data: [{ id: 'a1' }], error: null });
    const ok = await decidePendingAction('a1', 'approved', client());
    expect(ok).toBe(true);
    const op = mock.ops[0];
    expect(op.op).toBe('update');
    expect((op.payload as { status: string }).status).toBe('approved');
    // The transition guard: filtered on status = 'pending'.
    expect(op.filters).toContainEqual({ column: 'status', value: 'pending' });
  });

  it('returns false when no pending row matched (already decided / race)', async () => {
    mock.queueResult({ data: [], error: null });
    const ok = await decidePendingAction('a1', 'rejected', client());
    expect(ok).toBe(false);
  });
});

describe('createPendingAction / expirePendingAction shape', () => {
  it('inserts a pending row with the proposal payload', async () => {
    mock.queueResult({
      data: {
        id: 'a1',
        session_id: 's1',
        kind: 'entry',
        mode: 'paper',
        proposal,
        status: 'pending',
        created_at: new Date(0).toISOString(),
        decided_at: null,
      },
      error: null,
    });
    const action = await createPendingAction(
      { sessionId: 's1', kind: 'entry', mode: 'paper', proposal },
      client(),
    );
    expect(action.status).toBe('pending');
    const op = mock.ops[0];
    expect(op.op).toBe('insert');
    expect((op.payload as { status: string }).status).toBe('pending');
  });

  it('expire only targets a still-pending row', async () => {
    mock.queueResult({ data: null, error: null });
    await expirePendingAction('a1', client());
    const op = mock.ops[0];
    expect((op.payload as { status: string }).status).toBe('expired');
    expect(op.filters).toContainEqual({ column: 'status', value: 'pending' });
  });
});
