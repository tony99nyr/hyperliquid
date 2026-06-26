/**
 * Pins the add-to-position route (pyramiding — increases exposure):
 *  - auth → same-origin → rate-limit; requires an OPEN position;
 *  - the add is FORCED to the position's side (executeIntent gets that side);
 *  - AVERAGING-DOWN (underwater) requires an explicit ack → 409 otherwise;
 *  - LIVE requires the exact typed phrase;
 *  - success: executeIntent(reduceOnly:false) with the computed add size.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanonicalFill } from '@/types/fill';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const loadPosition = vi.fn();
const loadPositionLeverage = vi.fn();
const executeIntent = vi.fn();
const writePnlSnapshot = vi.fn();
const fetchAllMids = vi.fn();
const getTradingMode = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/fill-persistence-service', () => ({
  loadPosition: (...a: unknown[]) => loadPosition(...a),
  loadPositionLeverage: (...a: unknown[]) => loadPositionLeverage(...a),
  writePnlSnapshot: (...a: unknown[]) => writePnlSnapshot(...a),
}));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
const findOpenStop = vi.fn();
vi.mock('@/lib/trading/stop-order-service', () => ({ findOpenStop: (...a: unknown[]) => findOpenStop(...a) }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: () => ({ HL_NETWORK: 'mainnet' }) }));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: () => getTradingMode() }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { POST } from '@/app/api/cockpit/add-to-position/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown = {}): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}
const fill: CanonicalFill = { clientIntentId: 'x', sessionId: 's1', coin: 'SOL', side: 'buy', px: 110, sz: 1, notionalUsd: 110, feeUsd: 0.05, reduceOnly: false, partial: false, source: 'paper', hlOrderId: null, hlRaw: null, filledAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getTradingMode.mockReturnValue('paper');
  getActiveSession.mockResolvedValue({ id: 's1' });
  loadPosition.mockResolvedValue({ coin: 'SOL', side: 'long', sz: 2, avgEntryPx: 100 });
  loadPositionLeverage.mockResolvedValue(5);
  fetchAllMids.mockResolvedValue({ SOL: 110 }); // winning long (mark > entry)
  executeIntent.mockResolvedValue(fill);
  writePnlSnapshot.mockResolvedValue(undefined);
  writeAnalysisLog.mockResolvedValue(undefined);
  findOpenStop.mockResolvedValue(null); // no resting stop by default
});

const addUp = { coin: 'SOL', mode: 'pct', value: 50 };

describe('POST /api/cockpit/add-to-position', () => {
  it('401 / 403 / no-execute on bad auth or origin', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    expect((await POST(req(addUp))).status).toBe(401);
    verifyAdminAuth.mockResolvedValue(true);
    isSameOrigin.mockReturnValue(false);
    expect((await POST(req(addUp))).status).toBe(403);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('400 on a non-positive amount', async () => {
    expect((await POST(req({ ...addUp, value: 0 }))).status).toBe(400);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('409 when there is no open position', async () => {
    loadPosition.mockResolvedValue(null);
    expect((await POST(req(addUp))).status).toBe(409);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('adds to a WINNER: executeIntent(reduceOnly:false), position side, computed size', async () => {
    const res = await POST(req(addUp));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const intent = executeIntent.mock.calls[0][0];
    expect(intent.reduceOnly).toBe(false);
    expect(intent.side).toBe('buy'); // long → buy, forced from the position
    expect(intent.coin).toBe('SOL');
    expect(intent.sz).toBeCloseTo(1, 6); // 50% of 2
    // Writes a MARKED pnl snapshot so uPnL doesn't "reset" to 0 after the fold.
    expect(writePnlSnapshot).toHaveBeenCalledTimes(1);
    const snap = writePnlSnapshot.mock.calls[0][0];
    expect(snap.markPx).toBe(110);
    expect(snap.unrealizedPnlUsd).toBeCloseTo(20, 1); // (110−100)×2 on the live mark
  });

  it('AVERAGING DOWN needs an ack: 409 + no execute when underwater and unacked', async () => {
    fetchAllMids.mockResolvedValue({ SOL: 90 }); // long underwater (mark < entry)
    const res = await POST(req(addUp));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.requiresAck).toBe(true);
    expect(json.isAveragingDown).toBe(true);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('AVERAGING DOWN proceeds with the ack', async () => {
    fetchAllMids.mockResolvedValue({ SOL: 90 });
    const res = await POST(req({ ...addUp, ackAveragingDown: true }));
    expect(res.status).toBe(200);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS the add when a stop is resting (cancel it first) — 409, no execute', async () => {
    findOpenStop.mockResolvedValue({ oid: 7, triggerPx: 92, sz: 2 });
    const res = await POST(req(addUp));
    expect(res.status).toBe(409);
    expect((await res.json()).hasStop).toBe(true);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('LIVE requires the exact phrase — 422 + no execute on mismatch', async () => {
    getTradingMode.mockReturnValue('live');
    const res = await POST(req({ ...addUp, confirmPhrase: 'nope' }));
    expect(res.status).toBe(422);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('LIVE executes on the exact "buy sol" phrase', async () => {
    getTradingMode.mockReturnValue('live');
    const res = await POST(req({ ...addUp, confirmPhrase: 'buy sol' }));
    expect(res.status).toBe(200);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });
});
