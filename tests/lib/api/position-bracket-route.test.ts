/**
 * Pins the position-bracket route (native OCO stop+TP):
 *  - admin + same-origin gated; validates stop on the LOSS side AND tp on the PROFIT side;
 *  - refuses when a stop/TP already rests; places both legs in one placeBracketOnHl call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const fetchAllMids = vi.fn();
const findOpenStop = vi.fn();
const findOpenTp = vi.fn();
const placeBracketOnHl = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({ loadPosition: (...a: unknown[]) => loadPosition(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/trading/stop-order-service', () => ({
  findOpenStop: (...a: unknown[]) => findOpenStop(...a),
  findOpenTp: (...a: unknown[]) => findOpenTp(...a),
  placeBracketOnHl: (...a: unknown[]) => placeBracketOnHl(...a),
}));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { POST } from '@/app/api/cockpit/position-bracket/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function postReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getActiveSession.mockResolvedValue({ id: 's1' });
  // SHORT SOL @ 100: stop must be ABOVE 100, tp BELOW 100.
  loadPosition.mockResolvedValue({ coin: 'SOL', side: 'short', sz: 2, avgEntryPx: 100 });
  fetchAllMids.mockResolvedValue({ SOL: 100 });
  findOpenStop.mockResolvedValue(null);
  findOpenTp.mockResolvedValue(null);
  placeBracketOnHl.mockResolvedValue({ pushed: true, stopOid: 11, tpOid: 12 });
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('position-bracket route', () => {
  it('places both legs (short: stop above, tp below the mark)', async () => {
    const res = await POST(postReq({ coin: 'SOL', stopPx: 108, tpPx: 90 }));
    expect(res.status).toBe(200);
    expect(placeBracketOnHl).toHaveBeenCalledWith('SOL', 108, 90, 2, 'short');
  });

  it('422 when the STOP is on the wrong side (short stop below mark)', async () => {
    const res = await POST(postReq({ coin: 'SOL', stopPx: 95, tpPx: 90 }));
    expect(res.status).toBe(422);
    expect(placeBracketOnHl).not.toHaveBeenCalled();
  });

  it('422 when the TAKE-PROFIT is on the wrong side (short tp above mark)', async () => {
    const res = await POST(postReq({ coin: 'SOL', stopPx: 108, tpPx: 110 }));
    expect(res.status).toBe(422);
    expect(placeBracketOnHl).not.toHaveBeenCalled();
  });

  it('409 when a stop or TP already rests (cancel first)', async () => {
    findOpenStop.mockResolvedValue({ oid: 9, triggerPx: 108, sz: 2 });
    const res = await POST(postReq({ coin: 'SOL', stopPx: 108, tpPx: 90 }));
    expect(res.status).toBe(409);
    expect(placeBracketOnHl).not.toHaveBeenCalled();
  });

  it('502 when placement throws (fail-closed, never half-bracket)', async () => {
    placeBracketOnHl.mockRejectedValue(new Error('HL bracket leg rejected'));
    const res = await POST(postReq({ coin: 'SOL', stopPx: 108, tpPx: 90 }));
    expect(res.status).toBe(502);
  });

  it('403 cross-origin', async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq({ coin: 'SOL', stopPx: 108, tpPx: 90 }))).status).toBe(403);
  });
});
