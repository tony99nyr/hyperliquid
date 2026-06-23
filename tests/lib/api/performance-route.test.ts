/**
 * Pins the performance route: it is ACCOUNT-WIDE for the current trading mode (the
 * operator's whole live history, all sessions folded), NOT session-scoped — so
 * opening/closing sessions never hides past orders. Still admin-authed, same-origin,
 * and rate-limited BEFORE the (Supabase/HL) fetch. getAccountPerformanceSummary +
 * getTradingMode are mocked (no Supabase / no HL network).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const getAccountPerformanceSummary = vi.fn();
const getTradingMode = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: (req: { headers: { get: (k: string) => string | null } }) =>
    req.headers.get('x-forwarded-for') ?? 'test-client',
}));
vi.mock('@/lib/cockpit/performance-service', () => ({
  getAccountPerformanceSummary: (...a: unknown[]) => getAccountPerformanceSummary(...a),
}));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: () => getTradingMode() }));

import { GET } from '@/app/api/cockpit/performance/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(params: Record<string, string> = {}, headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const SUMMARY = { sessionId: '', ledger: [], kpis: {}, equity: [], equityUsd: 149.6, equity30dPct: 0, netPnlUsd: 0, generatedAt: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  getTradingMode.mockReturnValue('live');
  getAccountPerformanceSummary.mockResolvedValue(SUMMARY);
});

describe('GET /api/cockpit/performance — account-wide', () => {
  it('401s without admin auth (and never folds the account)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(getAccountPerformanceSummary).not.toHaveBeenCalled();
  });

  it('returns the ACCOUNT-WIDE summary for the current mode (ignores any sessionId param)', async () => {
    const res = await GET(req({ sessionId: 'whatever' }));
    expect(res.status).toBe(200);
    expect(getAccountPerformanceSummary).toHaveBeenCalledWith('live');
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.summary.equityUsd).toBe(149.6);
  });

  it('folds the mode that getTradingMode reports (paper vs live stay separate)', async () => {
    getTradingMode.mockReturnValue('paper');
    await GET(req());
    expect(getAccountPerformanceSummary).toHaveBeenCalledWith('paper');
  });

  it('429s once the per-client rate limit (30/min) is exceeded — before folding', async () => {
    for (let i = 0; i < 30; i++) {
      const ok = await GET(req({}, { 'x-forwarded-for': 'hammerer' }));
      expect(ok.status).toBe(200);
    }
    getAccountPerformanceSummary.mockClear();
    const limited = await GET(req({}, { 'x-forwarded-for': 'hammerer' }));
    expect(limited.status).toBe(429);
    expect(getAccountPerformanceSummary).not.toHaveBeenCalled();
  });
});
