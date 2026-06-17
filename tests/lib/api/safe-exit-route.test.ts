/**
 * Pins the Safe-Exit route — the dead-man's switch:
 *  - requires admin auth;
 *  - uses a FRESH plan's intent, else builds the market reduce-only fallback
 *    from the LIVE position (Claude-offline path);
 *  - calls executeIntent directly (independent of any agent/session liveness);
 *  - surfaces executed + usedFallback.
 *
 * All I/O boundaries are mocked. The route never depends on a live Claude.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanonicalFill } from '@/types/fill';

const verifyAdminAuth = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const getSafeExitPlan = vi.fn();
const executeIntent = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  // getClientIdentifier reads a header; the rate-limit key only needs to be
  // stable per test (reset in beforeEach), so a fixed string is fine.
  getClientIdentifier: () => 'test-client',
}));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...a: unknown[]) => loadPosition(...a) }));
vi.mock('@/lib/cockpit/safe-exit-plan-service', () => ({ getSafeExitPlan: (...a: unknown[]) => getSafeExitPlan(...a) }));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { POST } from '@/app/api/cockpit/safe-exit/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown = {}, headers: Record<string, string> = {}): NextRequest {
  return {
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const longPosition = {
  coin: 'ETH',
  side: 'long' as const,
  sz: 2,
  avgEntryPx: 2000,
  realizedPnlUsd: 0,
  feesPaidUsd: 0,
};

const fill: CanonicalFill = {
  clientIntentId: 'x',
  sessionId: 's1',
  coin: 'ETH',
  side: 'sell',
  px: 2010,
  sz: 2,
  notionalUsd: 4020,
  feeUsd: 1,
  reduceOnly: true,
  partial: false,
  source: 'paper',
  hlOrderId: null,
  hlRaw: null,
  filledAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  getActiveSession.mockResolvedValue({ id: 's1', mode: 'paper' });
  loadPosition.mockResolvedValue(longPosition);
  executeIntent.mockResolvedValue(fill);
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('POST /api/cockpit/safe-exit', () => {
  it('401s without admin auth (and never executes)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('uses the FRESH plan intent (usedFallback=false)', async () => {
    getSafeExitPlan.mockResolvedValue({
      id: 'p1',
      sessionId: 's1',
      intent: { clientIntentId: 'plan', sessionId: 's1', coin: 'ETH', side: 'sell', sz: 2, reduceOnly: true, createdAt: 0 },
      reasoning: 'fresh',
      isFallback: false,
      updatedAt: Date.now(), // fresh
    });
    const res = await POST(req());
    const json = await res.json();
    expect(json.usedFallback).toBe(false);
    expect(json.executed).toBe(true);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    // The executed intent is reduce-only.
    expect(executeIntent.mock.calls[0][0].reduceOnly).toBe(true);
  });

  it('builds the market-close FALLBACK when the plan is STALE (Claude offline)', async () => {
    getSafeExitPlan.mockResolvedValue({
      id: 'p1',
      sessionId: 's1',
      intent: { clientIntentId: 'plan', sessionId: 's1', coin: 'ETH', side: 'sell', sz: 2, reduceOnly: true, createdAt: 0 },
      reasoning: 'old',
      isFallback: false,
      updatedAt: Date.now() - 600_000, // 10 min old → stale
    });
    const res = await POST(req());
    const json = await res.json();
    expect(json.usedFallback).toBe(true);
    expect(json.executed).toBe(true);
    // Fallback is a reduce-only opposite-side MARKET close of the live long.
    const intent = executeIntent.mock.calls[0][0];
    expect(intent.side).toBe('sell');
    expect(intent.sz).toBe(2);
    expect(intent.reduceOnly).toBe(true);
    expect(intent.limitPx).toBeUndefined();
  });

  it('FRESH plan with WRONG SIDE (position flipped) → DISCARDS plan, market reduce-only fallback', async () => {
    // Live position is LONG (reduces with a SELL). The fresh plan says BUY —
    // it would ADD exposure. The route must discard it and market-close.
    getSafeExitPlan.mockResolvedValue({
      id: 'p1',
      sessionId: 's1',
      intent: { clientIntentId: 'plan', sessionId: 's1', coin: 'ETH', side: 'buy', sz: 2, reduceOnly: false, createdAt: 0 },
      reasoning: 'armed before a flip',
      isFallback: false,
      updatedAt: Date.now(), // fresh
    });
    const res = await POST(req());
    const json = await res.json();
    expect(json.usedFallback).toBe(true);
    const intent = executeIntent.mock.calls[0][0];
    expect(intent.side).toBe('sell'); // reduces the live long
    expect(intent.reduceOnly).toBe(true);
    expect(intent.limitPx).toBeUndefined();
  });

  it('FRESH plan with WRONG COIN → DISCARDS plan, market reduce-only fallback on the live coin', async () => {
    getSafeExitPlan.mockResolvedValue({
      id: 'p1',
      sessionId: 's1',
      intent: { clientIntentId: 'plan', sessionId: 's1', coin: 'BTC', side: 'sell', sz: 2, reduceOnly: true, createdAt: 0 },
      reasoning: 'stale coin',
      isFallback: false,
      updatedAt: Date.now(),
    });
    const res = await POST(req());
    const json = await res.json();
    expect(json.usedFallback).toBe(true);
    const intent = executeIntent.mock.calls[0][0];
    expect(intent.coin).toBe('ETH'); // the live position's coin
    expect(intent.side).toBe('sell');
    expect(intent.reduceOnly).toBe(true);
  });

  it('FRESH valid plan is FORCED reduceOnly even if the stored intent said false', async () => {
    getSafeExitPlan.mockResolvedValue({
      id: 'p1',
      sessionId: 's1',
      intent: { clientIntentId: 'plan', sessionId: 's1', coin: 'ETH', side: 'sell', sz: 2, reduceOnly: false, createdAt: 0 },
      reasoning: 'fresh but missing reduceOnly',
      isFallback: false,
      updatedAt: Date.now(),
    });
    const res = await POST(req());
    const json = await res.json();
    expect(json.usedFallback).toBe(false);
    expect(executeIntent.mock.calls[0][0].reduceOnly).toBe(true);
  });

  it('429s after the per-client limit (5/min) — before executing', async () => {
    getSafeExitPlan.mockResolvedValue(null);
    // 5 allowed, the 6th is throttled. Same 'unknown' client key across calls.
    for (let i = 0; i < 5; i++) {
      const ok = await POST(req({ coin: 'ETH' }));
      expect(ok.status).toBe(200);
    }
    executeIntent.mockClear();
    const res = await POST(req({ coin: 'ETH' }));
    expect(res.status).toBe(429);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('builds the FALLBACK when there is NO plan at all', async () => {
    getSafeExitPlan.mockResolvedValue(null);
    // coin must come from the body when there is no plan.
    const res = await POST(req({ coin: 'ETH' }));
    const json = await res.json();
    expect(json.usedFallback).toBe(true);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it('409s with no active session (nothing executes)', async () => {
    getActiveSession.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('409s when the position is flat (nothing to close)', async () => {
    getSafeExitPlan.mockResolvedValue(null);
    loadPosition.mockResolvedValue({ ...longPosition, side: 'flat', sz: 0 });
    const res = await POST(req({ coin: 'ETH' }));
    expect(res.status).toBe(409);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('executes with ZERO dependency on a Claude session (no agent involved)', async () => {
    // The route only touches: auth, active session row, live position, plan,
    // executeIntent. None of these is "is Claude alive" — proven by the mocks
    // above all being plain data, and the fallback path firing with a null plan.
    getSafeExitPlan.mockResolvedValue(null);
    const res = await POST(req({ coin: 'ETH' }));
    expect(res.status).toBe(200);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });
});
