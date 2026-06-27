/**
 * Pins the position-tp route (reduce-only take-profit):
 *  - GET reads the resting TP; POST place/cancel are admin+same-origin gated;
 *  - place validates the TP is on the PROFIT side of the mark (long above, short below);
 *  - one TP per coin (place refuses when one already rests); cancel 409s when none.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const fetchAllMids = vi.fn();
const findOpenTp = vi.fn();
const placeTpOnHl = vi.fn();
const cancelTpOnHl = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...a: unknown[]) => loadPosition(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/trading/stop-order-service', () => ({
  findOpenTp: (...a: unknown[]) => findOpenTp(...a),
  placeTpOnHl: (...a: unknown[]) => placeTpOnHl(...a),
  cancelTpOnHl: (...a: unknown[]) => cancelTpOnHl(...a),
}));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { GET, POST } from '@/app/api/cockpit/position-tp/route';
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
  fetchAllMids.mockResolvedValue({ SOL: 100 }); // mark 100; a long's TP must be > 100
  findOpenTp.mockResolvedValue(null);
  placeTpOnHl.mockResolvedValue({ pushed: true, oid: 77 });
  cancelTpOnHl.mockResolvedValue({ pushed: true });
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('position-tp route', () => {
  it('GET returns the resting TP', async () => {
    findOpenTp.mockResolvedValue({ oid: 9, triggerPx: 120, sz: 2 });
    const json = await (await GET(getReq('SOL'))).json();
    expect(json.tp).toEqual({ oid: 9, triggerPx: 120, sz: 2 });
  });

  it('place: places a TP on the PROFIT side (long → above mark)', async () => {
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 115 })); // above 100 ✓
    expect(res.status).toBe(200);
    expect(placeTpOnHl).toHaveBeenCalledWith('SOL', 115, 2, 'long');
  });

  it('place: 422 when on the WRONG side (long TP below mark)', async () => {
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 95 })); // below 100 ✗
    expect(res.status).toBe(422);
    expect(placeTpOnHl).not.toHaveBeenCalled();
  });

  it('place: 422 when too close to the mark (< 0.5%)', async () => {
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 100.2 }));
    expect(res.status).toBe(422);
    expect(placeTpOnHl).not.toHaveBeenCalled();
  });

  it('place: 409 when a TP already rests', async () => {
    findOpenTp.mockResolvedValue({ oid: 9, triggerPx: 120, sz: 2 });
    const res = await POST(postReq({ action: 'place', coin: 'SOL', triggerPx: 115 }));
    expect(res.status).toBe(409);
    expect(placeTpOnHl).not.toHaveBeenCalled();
  });

  it('cancel: cancels the resting TP; 409 when none', async () => {
    findOpenTp.mockResolvedValue({ oid: 77, triggerPx: 120, sz: 2 });
    expect((await POST(postReq({ action: 'cancel', coin: 'SOL' }))).status).toBe(200);
    expect(cancelTpOnHl).toHaveBeenCalledWith('SOL', 77);
    findOpenTp.mockResolvedValue(null);
    expect((await POST(postReq({ action: 'cancel', coin: 'SOL' }))).status).toBe(409);
  });

  it('403 cross-origin on POST', async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq({ action: 'cancel', coin: 'SOL' }))).status).toBe(403);
  });
});
