/**
 * Pins the SELF-SERVICE open-position route — the manual entry path:
 *  - admin-auth → same-origin → rate-limit gates (mirrors safe-exit / approve);
 *  - SERVER-VALIDATES leverage to [1, coinMax] (never trusts the client);
 *  - builds the OPEN intent (reduceOnly:false) via the shared buildOpenProposal;
 *  - uses the ACTIVE session if one exists, else openSession (created-or-reused);
 *  - calls executeIntent (the ONE seam) and returns the fill;
 *  - LIVE requires the exact "side sz coin" typed phrase (stronger confirm);
 *  - NO-AUTO-FIRE: nothing executes unless the request is fully valid + authed.
 *
 * All I/O boundaries are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanonicalFill } from '@/types/fill';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const openSession = vi.fn();
const executeIntent = vi.fn();
const writeAnalysisLog = vi.fn();
const getTradingMode = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a),
  getClientIdentifier: () => 'test-client',
}));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({
  isSameOrigin: (...a: unknown[]) => isSameOrigin(...a),
}));
vi.mock('@/lib/cockpit/session-service', () => ({
  getActiveSession: (...a: unknown[]) => getActiveSession(...a),
  openSession: (...a: unknown[]) => openSession(...a),
}));
vi.mock('@/lib/trading/fill-source', () => ({ executeIntent: (...a: unknown[]) => executeIntent(...a) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));
vi.mock('@/lib/env/mode', () => ({ getTradingMode: () => getTradingMode() }));

import { POST } from '@/app/api/cockpit/open-position/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown = {}): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

const fill: CanonicalFill = {
  clientIntentId: 'x',
  sessionId: 's1',
  coin: 'ETH',
  side: 'sell',
  px: 2000,
  sz: 0.625,
  notionalUsd: 1250,
  feeUsd: 0.5,
  reduceOnly: false,
  partial: false,
  source: 'paper',
  hlOrderId: null,
  hlRaw: null,
  filledAt: 0,
};

/** A valid PAPER short of ETH at $2000, risk $50, 4% stop, 5x. */
const validBody = {
  coin: 'ETH',
  side: 'sell',
  riskUsd: 50,
  stopFrac: 0.04,
  entryPx: 2000,
  leverage: 5,
  thesis: 'manual short',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getTradingMode.mockReturnValue('paper');
  getActiveSession.mockResolvedValue({ id: 's1', mode: 'paper' });
  openSession.mockResolvedValue({ id: 's-new', mode: 'paper' });
  executeIntent.mockResolvedValue(fill);
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('POST /api/cockpit/open-position', () => {
  it('401s without admin auth (and never executes)', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    const res = await POST(req(validBody));
    expect(res.status).toBe(401);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('403s on a cross-origin request (and never executes)', async () => {
    isSameOrigin.mockReturnValue(false);
    const res = await POST(req(validBody));
    expect(res.status).toBe(403);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('429s after the per-client limit (10/min) — before executing', async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await POST(req(validBody));
      expect(ok.status).toBe(200);
    }
    executeIntent.mockClear();
    const res = await POST(req(validBody));
    expect(res.status).toBe(429);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('opens a position: reuses the active session, executeIntent with reduceOnly:false', async () => {
    const res = await POST(req(validBody));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.executed).toBe(true);
    expect(json.sessionId).toBe('s1');
    expect(json.sessionOpened).toBe(false);
    expect(openSession).not.toHaveBeenCalled();
    expect(executeIntent).toHaveBeenCalledTimes(1);
    const intent = executeIntent.mock.calls[0][0];
    expect(intent.reduceOnly).toBe(false);
    expect(intent.side).toBe('sell');
    expect(intent.coin).toBe('ETH');
    expect(intent.sessionId).toBe('s1');
    // Risk-based size: 50 / (2000 * 0.04) = 0.625.
    expect(intent.sz).toBeCloseTo(0.625, 6);
  });

  it('OPENS a session when none is active (created-or-reused)', async () => {
    getActiveSession.mockResolvedValue(null);
    const res = await POST(req(validBody));
    const json = await res.json();
    expect(json.sessionOpened).toBe(true);
    expect(json.sessionId).toBe('s-new');
    expect(openSession).toHaveBeenCalledTimes(1);
    // Session is opened in the SERVER'S mode (env-gated, not client-set).
    expect(openSession.mock.calls[0][0].mode).toBe('paper');
    expect(executeIntent.mock.calls[0][0].sessionId).toBe('s-new');
  });

  it('SERVER-CLAMPS leverage above the coin max (ETH=25) — does not trust the client', async () => {
    // stopFrac 0.03 keeps the stop tighter than 1/25 so the liq-inside-stop guard
    // (below) doesn't fire — this test is about the leverage clamp specifically.
    const res = await POST(req({ ...validBody, leverage: 999, stopFrac: 0.03 }));
    const json = await res.json();
    expect(json.leverage).toBe(25); // ETH default coin max
    expect(executeIntent.mock.calls[0][0].leverage).toBe(25);
  });

  it('SERVER-CLAMPS leverage below 1 to 1', async () => {
    const res = await POST(req({ ...validBody, leverage: 0 }));
    const json = await res.json();
    expect(json.leverage).toBe(1);
  });

  it('400s on a missing/invalid side (never executes)', async () => {
    const res = await POST(req({ ...validBody, side: 'up' }));
    expect(res.status).toBe(400);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('400s on a non-positive entryPx (no live mark)', async () => {
    const res = await POST(req({ ...validBody, entryPx: 0 }));
    expect(res.status).toBe(400);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('400s on a stopFrac outside (0,1)', async () => {
    const res = await POST(req({ ...validBody, stopFrac: 1.5 }));
    expect(res.status).toBe(400);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('422s on a stopFrac below the server floor (0.5%) — never oversizes (no execute)', async () => {
    const res = await POST(req({ ...validBody, stopFrac: 0.001 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/too tight/i);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('422s when liquidation would sit at/inside the stop — SERVER-side guard, no execute', async () => {
    // Long ETH, 25x, 5% stop: stop=$1900 but liq≈$1920 (1−1/25) → liquidates BEFORE
    // the stop. Previously this was only blocked client-side; now the route refuses it.
    const res = await POST(req({ ...validBody, side: 'buy', leverage: 25, stopFrac: 0.05 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/liquidation.*inside your stop/i);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('LIVE requires the exact typed phrase — 422 + no execute on mismatch', async () => {
    getTradingMode.mockReturnValue('live');
    getActiveSession.mockResolvedValue({ id: 's1', mode: 'live' });
    const res = await POST(req({ ...validBody, confirmPhrase: 'wrong words' }));
    expect(res.status).toBe(422);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('LIVE executes when the exact "side coin" phrase matches', async () => {
    getTradingMode.mockReturnValue('live');
    getActiveSession.mockResolvedValue({ id: 's1', mode: 'live' });
    // phrase omits the (tick-recomputed) size → "sell eth".
    const res = await POST(req({ ...validBody, confirmPhrase: 'sell eth' }));
    expect(res.status).toBe(200);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent.mock.calls[0][0].reduceOnly).toBe(false);
  });

  it('a logging failure does NOT 500 a successful open', async () => {
    writeAnalysisLog.mockRejectedValue(new Error('log down'));
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
