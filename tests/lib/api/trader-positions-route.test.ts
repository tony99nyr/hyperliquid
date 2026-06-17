/**
 * Pins the trader-positions proxy hardening (Fix 3): admin-authed, same-origin,
 * AND rate-limited BEFORE the HL fetch — so a leaked/authed session can't iterate
 * addresses and hammer Hyperliquid. fetchClearinghouseState is mocked (no network).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const fetchClearinghouseState = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: (req: { headers: { get: (k: string) => string | null } }) =>
    req.headers.get('x-forwarded-for') ?? 'test-client',
}));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a),
  isValidHlAddress: (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a),
}));

import { GET } from '@/app/api/cockpit/trader-positions/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

const ADDR = '0x' + 'ab'.repeat(20);

function req(headers: Record<string, string> = {}, address = ADDR): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(address ? { address } : {}) },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  fetchClearinghouseState.mockResolvedValue({ assetPositions: [] });
});

describe('GET /api/cockpit/trader-positions', () => {
  it('401s without admin auth (and never fetches HL)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
  });

  it('403s a CROSS-ORIGIN request (after auth, before fetch)', async () => {
    const res = await GET(req({ host: 'cockpit.example.com', origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
  });

  it('200s a valid same-origin authed request', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(fetchClearinghouseState).toHaveBeenCalledWith(ADDR);
  });

  it('400s an invalid address', async () => {
    const res = await GET(req({}, 'not-an-address'));
    expect(res.status).toBe(400);
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
  });

  it('429s once the per-client rate limit (30/min) is exceeded — before the HL fetch', async () => {
    // 30 allowed; the 31st must 429 and NOT reach HL.
    for (let i = 0; i < 30; i++) {
      const ok = await GET(req({ 'x-forwarded-for': 'hammerer' }));
      expect(ok.status).toBe(200);
    }
    fetchClearinghouseState.mockClear();
    const limited = await GET(req({ 'x-forwarded-for': 'hammerer' }));
    expect(limited.status).toBe(429);
    expect(fetchClearinghouseState).not.toHaveBeenCalled();
  });

  it('rate limit is PER-CLIENT (a different identifier is unaffected)', async () => {
    for (let i = 0; i < 30; i++) await GET(req({ 'x-forwarded-for': 'noisy' }));
    const limited = await GET(req({ 'x-forwarded-for': 'noisy' }));
    expect(limited.status).toBe(429);
    const other = await GET(req({ 'x-forwarded-for': 'quiet' }));
    expect(other.status).toBe(200);
  });
});
