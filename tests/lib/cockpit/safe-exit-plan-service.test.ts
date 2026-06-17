/**
 * Pins the safe-exit-plan I/O: upsert keys on session_id (one plan per session)
 * and getSafeExitPlan maps the row (or null). Uses the recording Supabase mock.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSupabaseMock } from '../../mocks/supabase.mock';
import { upsertSafeExitPlan, getSafeExitPlan } from '@/lib/cockpit/safe-exit-plan-service';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TradeIntent } from '@/types/fill';

let mock: ReturnType<typeof createSupabaseMock>;
const client = () => mock.client as unknown as SupabaseClient;

const intent: TradeIntent = {
  clientIntentId: 'i1',
  sessionId: 's1',
  coin: 'ETH',
  side: 'sell',
  sz: 2,
  reduceOnly: true,
  createdAt: 0,
};

beforeEach(() => {
  mock = createSupabaseMock();
});

describe('upsertSafeExitPlan', () => {
  it('upserts on session_id with intent + reasoning + is_fallback', async () => {
    mock.queueResult({
      data: {
        id: 'p1',
        session_id: 's1',
        intent,
        reasoning: 'armed',
        is_fallback: false,
        updated_at: new Date(0).toISOString(),
      },
      error: null,
    });
    const plan = await upsertSafeExitPlan('s1', intent, 'armed', false, client());
    expect(plan.sessionId).toBe('s1');
    expect(plan.isFallback).toBe(false);
    const op = mock.ops[0];
    expect(op.op).toBe('upsert');
    expect(op.options).toEqual({ onConflict: 'session_id' });
    expect((op.payload as { session_id: string }).session_id).toBe('s1');
  });
});

describe('getSafeExitPlan', () => {
  it('maps a row to a SafeExitPlan', async () => {
    mock.queueResult({
      data: {
        id: 'p1',
        session_id: 's1',
        intent,
        reasoning: null,
        is_fallback: true,
        updated_at: new Date(1_000).toISOString(),
      },
      error: null,
    });
    const plan = await getSafeExitPlan('s1', client());
    expect(plan).not.toBeNull();
    expect(plan!.isFallback).toBe(true);
    expect(plan!.intent.coin).toBe('ETH');
    expect(plan!.updatedAt).toBe(1_000);
  });

  it('returns null when no plan exists', async () => {
    mock.queueResult({ data: null, error: null });
    expect(await getSafeExitPlan('s1', client())).toBeNull();
  });
});
