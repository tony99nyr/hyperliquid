/**
 * Pins the add-margin route (the isolated-margin de-risk):
 *  - admin-auth → same-origin → rate-limit gates;
 *  - amount must be a positive number within the cap;
 *  - requires an OPEN position (its side → isBuy);
 *  - pushes to HL FAIL-CLOSED: an HL rejection → 502, surfaces HL's reason, and
 *    does NOT persist a leverage change;
 *  - success: addIsolatedMarginOnHl(coin, amount, isBuy) + persists the recomputed
 *    effective leverage.
 * All I/O boundaries mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const loadPositionLeverage = vi.fn();
const updatePositionLeverage = vi.fn();
const addIsolatedMarginOnHl = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: () => 'test-client',
}));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({
  loadPosition: (...a: unknown[]) => loadPosition(...a),
  loadPositionLeverage: (...a: unknown[]) => loadPositionLeverage(...a),
  updatePositionLeverage: (...a: unknown[]) => updatePositionLeverage(...a),
}));
vi.mock('@/lib/trading/add-margin-service', () => ({ addIsolatedMarginOnHl: (...a: unknown[]) => addIsolatedMarginOnHl(...a) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { POST } from '@/app/api/cockpit/add-margin/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown = {}): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}
const valid = { coin: 'SOL', amountUsd: 50 };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getActiveSession.mockResolvedValue({ id: 's1' });
  loadPosition.mockResolvedValue({ coin: 'SOL', side: 'short', sz: 15, avgEntryPx: 70 });
  loadPositionLeverage.mockResolvedValue(5);
  updatePositionLeverage.mockResolvedValue(true);
  addIsolatedMarginOnHl.mockResolvedValue({ pushed: true, mode: 'live' });
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('POST /api/cockpit/add-margin', () => {
  it('401 without auth (no HL push)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    expect((await POST(req(valid))).status).toBe(401);
    expect(addIsolatedMarginOnHl).not.toHaveBeenCalled();
  });
  it('403 cross-origin', async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await POST(req(valid))).status).toBe(403);
    expect(addIsolatedMarginOnHl).not.toHaveBeenCalled();
  });
  it('400 on a non-positive amount (no push)', async () => {
    expect((await POST(req({ ...valid, amountUsd: 0 }))).status).toBe(400);
    expect((await POST(req({ ...valid, amountUsd: -5 }))).status).toBe(400);
    expect(addIsolatedMarginOnHl).not.toHaveBeenCalled();
  });
  it('422 above the cap', async () => {
    expect((await POST(req({ ...valid, amountUsd: 100_001 }))).status).toBe(422);
    expect(addIsolatedMarginOnHl).not.toHaveBeenCalled();
  });
  it('409 when no open position', async () => {
    loadPosition.mockResolvedValue(null);
    expect((await POST(req(valid))).status).toBe(409);
    expect(addIsolatedMarginOnHl).not.toHaveBeenCalled();
  });
  it('pushes with isBuy from the position side; persists recomputed leverage', async () => {
    const res = await POST(req(valid));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // short → isBuy false; amount 50.
    expect(addIsolatedMarginOnHl).toHaveBeenCalledWith('SOL', 50, false);
    // notional = 15*70 = 1050; oldMargin = 1050/5 = 210; newMargin = 260; eff lev ≈ 4.
    expect(updatePositionLeverage).toHaveBeenCalledWith('s1', 'SOL', 4);
    expect(json.newLeverage).toBe(4);
  });
  it('FAIL-CLOSED: HL rejection → 502, surfaces reason, no leverage persisted', async () => {
    addIsolatedMarginOnHl.mockRejectedValue(new Error('HL updateIsolatedMargin(SOL +$50) failed: {"status":"err","response":"Insufficient margin"}'));
    const res = await POST(req(valid));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Insufficient margin/);
    expect(updatePositionLeverage).not.toHaveBeenCalled();
  });
  it('paper mode is a no-op push but still ok', async () => {
    addIsolatedMarginOnHl.mockResolvedValue({ pushed: false, mode: 'paper' });
    const res = await POST(req(valid));
    expect(res.status).toBe(200);
    expect((await res.json()).pushed).toBe(false);
  });
});
