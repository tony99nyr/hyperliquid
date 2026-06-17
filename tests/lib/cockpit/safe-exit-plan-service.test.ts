/**
 * Pins the safe-exit-plan I/O: upsert keys on session_id (one plan per session)
 * and getSafeExitPlan maps the row (or null). Uses the recording Supabase mock.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSupabaseMock } from '../../mocks/supabase.mock';
import { upsertSafeExitPlan, getSafeExitPlan } from '@/lib/cockpit/safe-exit-plan-service';
import { buildBestExitPlan } from '@/lib/trading/safe-exit-plan-business-logic';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TradeIntent } from '@/types/fill';
import type { Position } from '@/types/position';

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

describe('refresh-exit path: buildBestExitPlan → upsertSafeExitPlan writes a valid plan', () => {
  it('upserts a valid reduce-only LIMIT plan when calm + deep book', async () => {
    const position: Position = {
      coin: 'ETH',
      side: 'long',
      sz: 2,
      avgEntryPx: 2000,
      realizedPnlUsd: 0,
      feesPaidUsd: 0,
    };
    const book = {
      coin: 'ETH',
      bids: [{ px: 1999, sz: 100 }],
      asks: [{ px: 2001, sz: 100 }],
    };
    const plan = buildBestExitPlan(
      position,
      book,
      { score: 80, pAdverse: 0.1, alerts: [] },
      { clientIntentId: 'cid-x', sessionId: 's1', now: 1_000 },
    );
    expect(plan).not.toBeNull();
    expect(plan!.intent.reduceOnly).toBe(true);

    mock.queueResult({
      data: {
        id: 'p1',
        session_id: 's1',
        intent: plan!.intent,
        reasoning: plan!.reasoning,
        is_fallback: false,
        updated_at: new Date(1_000).toISOString(),
      },
      error: null,
    });

    const saved = await upsertSafeExitPlan('s1', plan!.intent, plan!.reasoning, plan!.isFallback, client());

    // A valid, fresh, Claude-authored reduce-only plan row was written.
    expect(saved.isFallback).toBe(false);
    expect(saved.intent.reduceOnly).toBe(true);
    expect(saved.intent.side).toBe('sell'); // closes the long
    const op = mock.ops[0];
    expect(op.op).toBe('upsert');
    expect(op.options).toEqual({ onConflict: 'session_id' });
    const payload = op.payload as { intent: TradeIntent; is_fallback: boolean };
    expect(payload.intent.reduceOnly).toBe(true);
    expect(payload.intent.limitPx).toBe(1999); // smart limit at the favorable bid
    expect(payload.is_fallback).toBe(false);
  });
});
