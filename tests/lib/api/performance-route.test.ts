/**
 * Pins the performance route's SESSION-SCOPING (Fix 5): the session is resolved
 * SERVER-SIDE; a caller-supplied `sessionId` is treated as an assertion that
 * must match the active session, never folded blindly. A leaked/guessed/stale id
 * cannot read another session's fill ledger. getActivePerformanceSummary is
 * mocked (no Supabase / no HL network).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const getActivePerformanceSummary = vi.fn();
const getAccountOnlySummary = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: (req: { headers: { get: (k: string) => string | null } }) =>
    req.headers.get('x-forwarded-for') ?? 'test-client',
}));
vi.mock('@/lib/cockpit/performance-service', () => ({
  getActivePerformanceSummary: (...a: unknown[]) => getActivePerformanceSummary(...a),
  getAccountOnlySummary: (...a: unknown[]) => getAccountOnlySummary(...a),
}));

import { GET } from '@/app/api/cockpit/performance/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(params: Record<string, string> = {}, headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const SUMMARY = { sessionId: 'active-1', ledger: [], kpis: {}, equity: [], equityUsd: 50_000, equity30dPct: 0, generatedAt: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  getActivePerformanceSummary.mockResolvedValue({ status: 'ok', summary: SUMMARY });
});

describe('GET /api/cockpit/performance — session scoping', () => {
  it('401s without admin auth (and never resolves a session)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(getActivePerformanceSummary).not.toHaveBeenCalled();
  });

  it('resolves the ACTIVE session server-side, ignoring a matching/absent param', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    // Called with the caller assertion (null here) — the SERVICE resolves active.
    expect(getActivePerformanceSummary).toHaveBeenCalledWith(null);
    const json = await res.json();
    expect(json.summary.sessionId).toBe('active-1');
  });

  it('passes a caller-supplied sessionId through as an ASSERTION (validated server-side)', async () => {
    await GET(req({ sessionId: 'active-1' }));
    expect(getActivePerformanceSummary).toHaveBeenCalledWith('active-1');
  });

  it('403s when the caller asserts a sessionId that is NOT the active session', async () => {
    getActivePerformanceSummary.mockResolvedValue({ status: 'forbidden' });
    const res = await GET(req({ sessionId: 'someone-elses-session' }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it('returns the live ACCOUNT-only summary (200) when there is no active session', async () => {
    getActivePerformanceSummary.mockResolvedValue({ status: 'none' });
    getAccountOnlySummary.mockResolvedValue({ sessionId: '', ledger: [], equityUsd: 149.6, netPnlUsd: 0 });
    const res = await GET(req({ sessionId: 'whatever' }));
    expect(res.status).toBe(200);
    expect(getAccountOnlySummary).toHaveBeenCalled();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.summary.equityUsd).toBe(149.6);
  });

  it('429s once the per-client rate limit (30/min) is exceeded — before session resolution', async () => {
    for (let i = 0; i < 30; i++) {
      const ok = await GET(req({}, { 'x-forwarded-for': 'hammerer' }));
      expect(ok.status).toBe(200);
    }
    getActivePerformanceSummary.mockClear();
    const limited = await GET(req({}, { 'x-forwarded-for': 'hammerer' }));
    expect(limited.status).toBe(429);
    expect(getActivePerformanceSummary).not.toHaveBeenCalled();
  });
});
