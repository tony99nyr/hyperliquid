/**
 * Pins the autonomous risk-exit route — the surface that can fire real-money
 * reduce-only closes. The kill-switch must block BEFORE auth; the cron-token path
 * must bypass admin/same-origin; the admin path must enforce same-origin; and a
 * missing/garbage request must never reach performRiskExit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const verifyCronBearer = vi.fn();
const isSameOrigin = vi.fn();
const performRiskExit = vi.fn();
const isAutoExitEnabled = vi.fn();
const getAutoExitCronSecret = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a),
  getClientIdentifier: () => 'test-client',
}));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/trading/risk-exit-service', () => ({ performRiskExit: (...a: unknown[]) => performRiskExit(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({
  isAutoExitEnabled: () => isAutoExitEnabled(),
  getAutoExitCronSecret: () => getAutoExitCronSecret(),
}));

import { POST } from '@/app/api/cockpit/risk-exit/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown = { sessionId: 's1', coin: 'ETH' }, headers: Record<string, string> = {}): NextRequest {
  return {
    json: async () => {
      if (body === '__throw__') throw new Error('bad json');
      return body;
    },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  isAutoExitEnabled.mockReturnValue(true);
  getAutoExitCronSecret.mockReturnValue('sek');
  verifyCronBearer.mockReturnValue(false);
  verifyAdminAuth.mockResolvedValue(false);
  isSameOrigin.mockReturnValue(true);
  performRiskExit.mockResolvedValue({ fired: false, reason: null, skipped: 'condition-not-met' });
});

describe('POST /api/cockpit/risk-exit', () => {
  it('403s and NEVER fires when the kill-switch is off (before auth)', async () => {
    isAutoExitEnabled.mockReturnValue(false);
    verifyCronBearer.mockReturnValue(true); // even a valid token can't fire when disabled
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(performRiskExit).not.toHaveBeenCalled();
  });

  it('reaches performRiskExit on a valid cron token (no admin/same-origin needed)', async () => {
    verifyCronBearer.mockReturnValue(true);
    performRiskExit.mockResolvedValue({ fired: true, reason: 'max-loss-usd', skipped: null });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(performRiskExit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', coin: 'ETH' }));
    expect(verifyAdminAuth).not.toHaveBeenCalled();
  });

  it('401s when neither cron token nor admin auth is present', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(performRiskExit).not.toHaveBeenCalled();
  });

  it('403s on the admin path when cross-origin', async () => {
    verifyAdminAuth.mockResolvedValue(true);
    isSameOrigin.mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(performRiskExit).not.toHaveBeenCalled();
  });

  it('admin + same-origin reaches performRiskExit', async () => {
    verifyAdminAuth.mockResolvedValue(true);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(performRiskExit).toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    verifyCronBearer.mockReturnValue(true);
    const res = await POST(req('__throw__'));
    expect(res.status).toBe(400);
    expect(performRiskExit).not.toHaveBeenCalled();
  });

  it('400s when sessionId or coin is missing/blank', async () => {
    verifyCronBearer.mockReturnValue(true);
    expect((await POST(req({ coin: 'ETH' }))).status).toBe(400);
    expect((await POST(req({ sessionId: 's1', coin: '   ' }))).status).toBe(400);
    expect(performRiskExit).not.toHaveBeenCalled();
  });

  it('500s with fired:false when performRiskExit throws', async () => {
    verifyCronBearer.mockReturnValue(true);
    performRiskExit.mockRejectedValue(new Error('HL down'));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { fired: boolean };
    expect(json.fired).toBe(false);
  });
});
