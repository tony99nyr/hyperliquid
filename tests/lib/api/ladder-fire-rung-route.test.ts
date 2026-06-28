/**
 * Pins the ladder fire-rung route gates (the autonomous money seam):
 *  - KILL-SWITCH first: LADDER_AUTOFIRE_ENABLED off ⇒ 403 for ANYONE (even authed);
 *  - auth: cron bearer OR admin+same-origin; cross-origin admin rejected;
 *  - body validation; delegates to performLadderRungFire only after all gates pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const isLadderAutofireEnabled = vi.fn();
const getLadderCronSecret = vi.fn();
const verifyCronBearer = vi.fn();
const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const performLadderRungFire = vi.fn();

vi.mock('@/lib/ladder/ladder-flags', () => ({
  isLadderAutofireEnabled: (...a: unknown[]) => isLadderAutofireEnabled(...a),
  getLadderCronSecret: (...a: unknown[]) => getLadderCronSecret(...a),
}));
vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a),
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: () => 'c',
}));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/ladder/ladder-fire-service', () => ({ performLadderRungFire: (...a: unknown[]) => performLadderRungFire(...a) }));

import { POST } from '@/app/api/cockpit/ladder/fire-rung/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function postReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}
const goodBody = { ladderId: 'L1', rungId: 'r1' };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  isLadderAutofireEnabled.mockReturnValue(true);
  getLadderCronSecret.mockReturnValue('cron-secret');
  verifyCronBearer.mockReturnValue(true);
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  performLadderRungFire.mockResolvedValue({ fired: true, skipped: null });
});

describe('fire-rung route', () => {
  it('403 + no fire when the kill-switch is OFF (even with valid cron auth)', async () => {
    isLadderAutofireEnabled.mockReturnValue(false);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(403);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('fires for a valid cron-bearer caller', async () => {
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(200);
    expect(performLadderRungFire).toHaveBeenCalledWith(expect.objectContaining({ ladderId: 'L1', rungId: 'r1' }));
  });

  it('falls back to admin+same-origin when not cron-authed', async () => {
    verifyCronBearer.mockReturnValue(false);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(200);
    expect(performLadderRungFire).toHaveBeenCalled();
  });

  it('401 when neither cron nor admin authed', async () => {
    verifyCronBearer.mockReturnValue(false);
    verifyAdminAuth.mockResolvedValue(false);
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(401);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('403 cross-origin admin (no cron)', async () => {
    verifyCronBearer.mockReturnValue(false);
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq(goodBody))).status).toBe(403);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('400 when ladderId/rungId missing', async () => {
    expect((await POST(postReq({ ladderId: 'L1' }))).status).toBe(400);
    expect(performLadderRungFire).not.toHaveBeenCalled();
  });

  it('surfaces a SKIP result as ok:true with the reason', async () => {
    performLadderRungFire.mockResolvedValue({ fired: false, skipped: 'already-fired' });
    const res = await POST(postReq(goodBody));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('already-fired');
  });
});
