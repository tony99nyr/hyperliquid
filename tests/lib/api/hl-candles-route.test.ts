/**
 * Pins the cached HL candle proxy (/api/hl/candles): the route the browser hits
 * instead of api.hyperliquid.xyz directly (the 429 fix). It must (a) gate on admin
 * auth + same-origin + rate limit BEFORE any upstream fetch, and (b) snap the
 * request window to a TTL grid so concurrent tabs collapse onto one cache key.
 * fetchCandles is mocked — no real HL network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const fetchCandles = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: (req: { headers: { get: (k: string) => string | null } }) =>
    req.headers.get('x-forwarded-for') ?? 'test-client',
}));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({
  isSameOrigin: (req: { headers: { get: (k: string) => string | null } }) =>
    req.headers.get('x-same-origin') !== 'false',
}));
vi.mock('@/lib/hyperliquid/candle-service', () => ({
  fetchCandles: (...a: unknown[]) => fetchCandles(...a),
}));

import { GET } from '@/app/api/hl/candles/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(params: Record<string, string> = {}, headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const GOOD = { coin: 'ETH', interval: '1h', lookbackMs: String(60 * 60 * 1000) };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  fetchCandles.mockResolvedValue({ coin: 'ETH', interval: '1h', candles: [], fetchedAt: 0, stale: false });
});

describe('GET /api/hl/candles — cached proxy guard', () => {
  it('401s without admin auth and never fetches upstream', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await GET(req(GOOD));
    expect(res.status).toBe(401);
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('403s a cross-origin request before fetching', async () => {
    const res = await GET(req(GOOD, { 'x-same-origin': 'false' }));
    expect(res.status).toBe(403);
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('400s an unsupported interval', async () => {
    const res = await GET(req({ ...GOOD, interval: '7y' }));
    expect(res.status).toBe(400);
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('200s and returns the cached candle result', async () => {
    const res = await GET(req(GOOD));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.result.coin).toBe('ETH');
    expect(fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('snaps the window to a 30s grid so two near-simultaneous calls share a key', async () => {
    await GET(req(GOOD));
    await GET(req(GOOD));
    const call1 = fetchCandles.mock.calls[0] as [string, string, number, number];
    const call2 = fetchCandles.mock.calls[1] as [string, string, number, number];
    const end1 = call1[3];
    const end2 = call2[3];
    // Both end times land on the same 30s boundary (concurrent tabs → one key).
    expect(end1).toBe(end2);
    expect(end1 % 30_000).toBe(0);
  });
});
