/**
 * Pins the position-stop route (reduce-only protective stop):
 *  - GET reads the resting stop; POST place/cancel are admin+same-origin gated;
 *  - place validates the stop is on the PROTECTIVE side of the mark;
 *  - one stop per coin (place refuses when one already rests);
 *  - cancel 409s when there's nothing to cancel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const fetchAllMids = vi.fn();
const findOpenStop = vi.fn();
const placeStopOnHl = vi.fn();
const cancelStopOnHl = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...a: unknown[]) => loadPosition(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/trading/stop-order-service', () => ({
  findOpenStop: (...a: unknown[]) => findOpenStop(...a),
  placeStopOnHl: (...a: unknown[]) => placeStopOnHl(...a),
  cancelStopOnHl: (...a: unknown[]) => cancelStopOnHl(...a),
}));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { GET, POST } from '@/app/api/cockpit/position-stop/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function postReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}
function getReq(coin: string): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams({ coin }) }, headers: { get: () => null } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getActiveSession.mockResolvedValue({ id: 's1' });
  loadPosition.mockResolvedValue({ coin: 'SOL', side: 'long', sz: 2, avgEntryPx: 100 });
  fetchAllMids.mockResolvedValue({ SOL: 100 }); // mark 100; a long stop must be < 100
  findOpenStop.mockResolvedValue(null);
  placeStopOnHl.mockResolvedValue({ pushed: true, oid: 42 });
  cancelStopOnHl.mockResolvedValue({ pushed: true });
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('position-stop route', () => {
  it('GET 401 without auth; returns the resting stop otherwise', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    expect((await GET(getReq('SOL'))).status).toBe(401);
    verifyAdminAuth.mockResolvedValue(true);
    findOpenStop.mockResolvedValue({ oid: 9, triggerPx: 90, sz: 2 });
    const json = await (await GET(getReq('SOL'))).json();
    expect(json.stop).toEqual({ oid: 9, triggerPx: 90, sz: 2 });
  });

  it('place: places a stop on the protective side', async () => {
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 92 })); // below 100 ✓
    expect(res.status).toBe(200);
    expect(placeStopOnHl).toHaveBeenCalledWith('SOL', 92, 2, 'long');
  });

  it('place: 422 when the stop is on the WRONG side (long stop above mark)', async () => {
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 105 })); // above 100 ✗
    expect(res.status).toBe(422);
    expect(placeStopOnHl).not.toHaveBeenCalled();
  });

  it('place: 409 when a stop already rests (cancel first)', async () => {
    findOpenStop.mockResolvedValue({ oid: 9, triggerPx: 90, sz: 2 });
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 92 }));
    expect(res.status).toBe(409);
    expect(placeStopOnHl).not.toHaveBeenCalled();
  });

  it('cancel: cancels the resting stop', async () => {
    findOpenStop.mockResolvedValue({ oid: 42, triggerPx: 90, sz: 2 });
    const res = await POST(postReq({ action: 'cancel', coin: 'SOL' }));
    expect(res.status).toBe(200);
    expect(cancelStopOnHl).toHaveBeenCalledWith('SOL', 42);
  });

  it('cancel: 409 when there is no resting stop', async () => {
    const res = await POST(postReq({ action: 'cancel', coin: 'SOL' }));
    expect(res.status).toBe(409);
    expect(cancelStopOnHl).not.toHaveBeenCalled();
  });

  it('403 cross-origin on POST', async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq({ action: 'cancel', coin: 'SOL' }))).status).toBe(403);
  });
});
