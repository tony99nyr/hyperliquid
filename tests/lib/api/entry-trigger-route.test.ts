/**
 * Pins the entry-trigger route (native STOP-ENTRY, trigger-to-open, NON reduce-only):
 *  - admin + same-origin gated; OPENS exposure so it gets the full open gate;
 *  - validates breakout/breakdown direction (long ABOVE mark, short BELOW);
 *  - one entry per coin (409 if one rests); distance bounds; LIVE typed-phrase;
 *  - cancel path. PAPER (default mode here) skips the typed-phrase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const fetchAllMids = vi.fn();
const getTradingMode = vi.fn();
const findOpenEntryTrigger = vi.fn();
const placeEntryTriggerOnHl = vi.fn();
const cancelEntryTriggerOnHl = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: (...a: unknown[]) => getTradingMode(...a) }));
vi.mock('@/lib/trading/entry-trigger-service', () => ({
  findOpenEntryTrigger: (...a: unknown[]) => findOpenEntryTrigger(...a),
  placeEntryTriggerOnHl: (...a: unknown[]) => placeEntryTriggerOnHl(...a),
  cancelEntryTriggerOnHl: (...a: unknown[]) => cancelEntryTriggerOnHl(...a),
}));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));
// The route sizes server-side off the trigger level via the shared sizer; the coin/lev
// caps are real (ETH max ~25x, no tf ceiling here).

import { POST } from '@/app/api/cockpit/entry-trigger/route';
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
  fetchAllMids.mockResolvedValue({ ETH: 1750 });
  getTradingMode.mockReturnValue('paper'); // PAPER → no typed-phrase required
  findOpenEntryTrigger.mockResolvedValue(null);
  placeEntryTriggerOnHl.mockResolvedValue({ pushed: false, oid: null });
  cancelEntryTriggerOnHl.mockResolvedValue({ pushed: false });
  writeAnalysisLog.mockResolvedValue(undefined);
});

// Risk-based place payload (server sizes off the trigger level; sz = risk/(trigger*stop)).
const placeBody = (over: Record<string, unknown> = {}) => ({
  action: 'place', coin: 'ETH', side: 'long', triggerPx: 1800, riskUsd: 50, stopFrac: 0.04, leverage: 5, ...over,
});

describe('entry-trigger route — PLACE', () => {
  it('places a LONG breakout entry (trigger ABOVE the mark), sizing server-side off triggerPx', async () => {
    const res = await POST(postReq(placeBody()));
    expect(res.status).toBe(200);
    // sz = 50 / (1800 * 0.04) ≈ 0.694; assert the seam args (coin, trigger, side, lev)
    // and that a positive server-computed size was passed (NOT a client coin count).
    expect(placeEntryTriggerOnHl).toHaveBeenCalledWith('ETH', 1800, expect.any(Number), 'long', 5);
    const sz = placeEntryTriggerOnHl.mock.calls[0][2] as number;
    expect(sz).toBeGreaterThan(0);
    expect(sz).toBeCloseTo(50 / (1800 * 0.04), 2);
  });

  it('places a SHORT breakdown entry (trigger BELOW the mark)', async () => {
    const res = await POST(postReq(placeBody({ side: 'short', triggerPx: 1700 })));
    expect(res.status).toBe(200);
    expect(placeEntryTriggerOnHl).toHaveBeenCalledWith('ETH', 1700, expect.any(Number), 'short', 5);
  });

  it('422 when a LONG entry triggers below the mark (wrong direction)', async () => {
    const res = await POST(postReq(placeBody({ triggerPx: 1700 })));
    expect(res.status).toBe(422);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('422 when a SHORT entry triggers above the mark (wrong direction)', async () => {
    const res = await POST(postReq(placeBody({ side: 'short', triggerPx: 1800 })));
    expect(res.status).toBe(422);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('422 when the trigger sits too close to the mark (would fire instantly)', async () => {
    const res = await POST(postReq(placeBody({ triggerPx: 1750.5 })));
    expect(res.status).toBe(422);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('409 when an entry trigger already rests for the coin', async () => {
    findOpenEntryTrigger.mockResolvedValue({ oid: 7, triggerPx: 1800, sz: 0.5, side: 'B' });
    const res = await POST(postReq(placeBody({ triggerPx: 1820 })));
    expect(res.status).toBe(409);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('422 when the stop is too tight (would oversize into liquidation)', async () => {
    const res = await POST(postReq(placeBody({ stopFrac: 0.001 }))); // < MIN_STOP_FRAC 0.5%
    expect(res.status).toBe(422);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('400 when riskUsd is missing or non-positive', async () => {
    const res = await POST(postReq(placeBody({ riskUsd: 0 })));
    expect(res.status).toBe(400);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('clamps an over-cap leverage server-side (does NOT trust the client)', async () => {
    const res = await POST(postReq(placeBody({ leverage: 999 })));
    expect(res.status).toBe(200);
    const passedLev = placeEntryTriggerOnHl.mock.calls[0][4] as number;
    expect(passedLev).toBeLessThanOrEqual(50); // clamped to the coin ceiling, never 999
    expect(passedLev).toBeGreaterThanOrEqual(1);
  });

  it('LIVE requires the exact typed phrase (rejects a mismatch)', async () => {
    getTradingMode.mockReturnValue('live');
    const res = await POST(postReq(placeBody({ confirmPhrase: 'wrong' })));
    expect(res.status).toBe(422);
    expect(placeEntryTriggerOnHl).not.toHaveBeenCalled();
  });

  it('LIVE accepts the exact "buy coin" phrase for a long entry', async () => {
    getTradingMode.mockReturnValue('live');
    placeEntryTriggerOnHl.mockResolvedValue({ pushed: true, oid: 42 });
    const res = await POST(postReq(placeBody({ confirmPhrase: 'buy ETH' })));
    expect(res.status).toBe(200);
    expect(placeEntryTriggerOnHl).toHaveBeenCalled();
  });

  it('403 cross-origin', async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq(placeBody()))).status).toBe(403);
  });
});

describe('entry-trigger route — CANCEL', () => {
  it('cancels a resting entry trigger', async () => {
    findOpenEntryTrigger.mockResolvedValue({ oid: 7, triggerPx: 1800, sz: 0.5, side: 'B' });
    cancelEntryTriggerOnHl.mockResolvedValue({ pushed: true });
    const res = await POST(postReq({ action: 'cancel', coin: 'ETH' }));
    expect(res.status).toBe(200);
    expect(cancelEntryTriggerOnHl).toHaveBeenCalledWith('ETH', 7);
  });

  it('409 when there is no entry trigger to cancel', async () => {
    findOpenEntryTrigger.mockResolvedValue(null);
    const res = await POST(postReq({ action: 'cancel', coin: 'ETH' }));
    expect(res.status).toBe(409);
    expect(cancelEntryTriggerOnHl).not.toHaveBeenCalled();
  });
});
