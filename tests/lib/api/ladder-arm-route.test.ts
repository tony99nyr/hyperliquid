/**
 * Pins the ladder ARM route (the authorization gate — moves no money):
 *  - admin + same-origin gated; only a DRAFT, operator-authored ladder can arm;
 *  - a LIVE ladder needs LADDER_LIVE_ENABLED on AND the exact `arm <id8>` phrase;
 *  - static validation warnings BLOCK arming; a clean paper ladder arms with no phrase;
 *  - the draft→armed race is handled (armLadder=false → 409).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LadderWithRungs } from '@/lib/ladder/ladder-types';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getActiveSession = vi.fn();
const getLadderWithRungs = vi.fn();
const armLadder = vi.fn();
const fetchClearinghouseState = vi.fn();
const validateEnv = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/env/env', () => ({ validateEnv: (...a: unknown[]) => validateEnv(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/ladder/ladder-service', () => ({
  getLadderWithRungs: (...a: unknown[]) => getLadderWithRungs(...a),
  armLadder: (...a: unknown[]) => armLadder(...a),
}));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchClearinghouseState: (...a: unknown[]) => fetchClearinghouseState(...a) }));
vi.mock('@/lib/auto-exit/auto-exit-config', () => ({ getHlAccountAddress: () => '0xabc' }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { POST } from '@/app/api/cockpit/ladder/arm/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function postReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

// A clean, single-rung DRAFT ladder that passes validateLadderForArm.
function draftLadder(over: Partial<LadderWithRungs> = {}): LadderWithRungs {
  return {
    id: 'abcd1234-0000-0000', title: 'Breakout', thesis: null, author: 'operator', mode: 'paper', status: 'draft',
    preconditionHash: null, ocoGroupId: null, maxTotalNotionalUsd: 100_000, maxTotalLossUsd: 5_000,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null,
    createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString(),
    rungs: [{
      id: 'r1', ladderId: 'abcd1234-0000-0000', seq: 1, coin: 'ETH', side: 'long', action: 'open',
      triggerKind: 'price_above', triggerPx: 2000, triggerMeta: null,
      sizeCoins: null, reduceFrac: null, riskUsd: 50, stopFrac: 0.04, leverage: 5, stopPx: 1900, targetPx: 2200,
      status: 'pending', cloid: null,
    }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getActiveSession.mockResolvedValue({ id: 's1' });
  validateEnv.mockReturnValue({ LADDER_LIVE_ENABLED: false });
  getLadderWithRungs.mockResolvedValue(draftLadder());
  armLadder.mockResolvedValue(true);
  fetchClearinghouseState.mockResolvedValue({ positions: [] });
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('ladder arm route', () => {
  it('arms a clean PAPER draft with no typed phrase', async () => {
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(200);
    expect(armLadder).toHaveBeenCalledWith('abcd1234-0000-0000', expect.objectContaining({ preconditionHash: expect.any(String) }));
  });

  it('401 unauthenticated', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    expect((await POST(postReq({ ladderId: 'x' }))).status).toBe(401);
  });

  it('403 cross-origin', async () => {
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq({ ladderId: 'x' }))).status).toBe(403);
  });

  it('404 when the ladder is absent', async () => {
    getLadderWithRungs.mockResolvedValue(null);
    expect((await POST(postReq({ ladderId: 'x' }))).status).toBe(404);
  });

  it('409 when the ladder is not a draft', async () => {
    getLadderWithRungs.mockResolvedValue(draftLadder({ status: 'armed' }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(409);
    expect(armLadder).not.toHaveBeenCalled();
  });

  it('403 for a scout-authored ladder (only operator ladders arm)', async () => {
    getLadderWithRungs.mockResolvedValue(draftLadder({ author: 'scout' }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(403);
    expect(armLadder).not.toHaveBeenCalled();
  });

  it('403 for a LIVE ladder while LADDER_LIVE_ENABLED is off (paper-first)', async () => {
    getLadderWithRungs.mockResolvedValue(draftLadder({ mode: 'live' }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000', confirmPhrase: 'arm abcd1234' }));
    expect(res.status).toBe(403);
    expect(armLadder).not.toHaveBeenCalled();
  });

  it('422 when static validation fails (e.g. stop on the wrong side)', async () => {
    const bad = draftLadder();
    bad.rungs[0].stopPx = 2100; // long stop ABOVE entry — invalid
    getLadderWithRungs.mockResolvedValue(bad);
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(armLadder).not.toHaveBeenCalled();
  });

  it('LIVE: arms with the exact phrase when the flag is on', async () => {
    validateEnv.mockReturnValue({ LADDER_LIVE_ENABLED: true });
    getLadderWithRungs.mockResolvedValue(draftLadder({ mode: 'live' }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000', confirmPhrase: 'arm abcd1234' }));
    expect(res.status).toBe(200);
    expect(armLadder).toHaveBeenCalled();
  });

  it('LIVE: 422 on a phrase mismatch even with the flag on', async () => {
    validateEnv.mockReturnValue({ LADDER_LIVE_ENABLED: true });
    getLadderWithRungs.mockResolvedValue(draftLadder({ mode: 'live' }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000', confirmPhrase: 'wrong' }));
    expect(res.status).toBe(422);
    expect(armLadder).not.toHaveBeenCalled();
  });

  it('409 when the draft→armed transition lost the race (armLadder=false)', async () => {
    armLadder.mockResolvedValue(false);
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(409);
  });
});
