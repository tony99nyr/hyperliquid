/**
 * Pins the ladder RE-ANCHOR route (a DRAFT-ONLY edit — moves no money):
 *  - admin + same-origin gated; only a DRAFT, operator-authored, anchored,
 *    single-coin ladder re-anchors;
 *  - a mids outage is a HARD failure (never re-anchor to a stale/absent price);
 *  - the drift bound and the arm-race fail-closed disarm surface loudly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LadderWithRungs, LadderRung } from '@/lib/ladder/ladder-types';

const verifyAdminAuth = vi.fn();
const isSameOrigin = vi.fn();
const getLadderWithRungs = vi.fn();
const applyDraftReanchor = vi.fn();
const fetchAllMids = vi.fn();
const getActiveSession = vi.fn();
const writeAnalysisLog = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({ verifyAdminAuth: (...a: unknown[]) => verifyAdminAuth(...a), getClientIdentifier: () => 'c' }));
vi.mock('@/lib/infrastructure/auth/same-origin', () => ({ isSameOrigin: (...a: unknown[]) => isSameOrigin(...a) }));
vi.mock('@/lib/ladder/ladder-service', () => ({
  getLadderWithRungs: (...a: unknown[]) => getLadderWithRungs(...a),
  applyDraftReanchor: (...a: unknown[]) => applyDraftReanchor(...a),
}));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({ fetchAllMids: (...a: unknown[]) => fetchAllMids(...a) }));
vi.mock('@/lib/cockpit/session-service', () => ({ getActiveSession: (...a: unknown[]) => getActiveSession(...a) }));
vi.mock('@/lib/cockpit/analysis-log-service', () => ({ writeAnalysisLog: (...a: unknown[]) => writeAnalysisLog(...a) }));

import { POST } from '@/app/api/cockpit/ladder/reanchor/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function postReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

const mkRung = (over: Partial<LadderRung> = {}): LadderRung => ({
  id: 'r1', ladderId: 'L', seq: 1, coin: 'SOL', side: 'long', action: 'open',
  triggerKind: 'price_below', triggerPx: 113.098, triggerMeta: { momentumConfirm: true },
  sizeCoins: null, reduceFrac: null, riskUsd: 10, stopFrac: 0.05, leverage: 3, stopPx: 107.4431, targetPx: null,
  status: 'pending', cloid: null, ...over,
});

function draft(over: Partial<LadderWithRungs> = {}): LadderWithRungs {
  return {
    id: 'abcd1234-0000-0000', title: 'SOL runaway long', thesis: 'ratios of the detection mark', author: 'operator', mode: 'live', status: 'draft',
    preconditionHash: null, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 500, maxTotalLossUsd: 40, anchorPx: 117.2,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), activeFrom: null, armedAt: null, disarmedAt: null, disarmReason: null,
    archivedAt: null, expiryAlertAt: null, createdAt: '', updatedAt: '',
    rungs: [mkRung()],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  verifyAdminAuth.mockResolvedValue(true);
  isSameOrigin.mockReturnValue(true);
  getLadderWithRungs.mockResolvedValue(draft());
  applyDraftReanchor.mockResolvedValue('applied');
  fetchAllMids.mockResolvedValue({ SOL: 121.31 });
  getActiveSession.mockResolvedValue({ id: 's1' });
  writeAnalysisLog.mockResolvedValue(undefined);
});

describe('ladder reanchor route', () => {
  it('re-prices a stale anchored draft to the live mark (the SOL incident fix)', async () => {
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.anchorPx).toBe(121.31);
    expect(json.rungsRepriced).toBe(1);
    const args = applyDraftReanchor.mock.calls[0][1];
    expect(args.newAnchorPx).toBe(121.31);
    expect(args.patches[0].triggerPx).toBeCloseTo(113.098 * (121.31 / 117.2), 5);
    // The audit note is APPENDED — the original thesis prose stays.
    expect(args.thesis).toContain('ratios of the detection mark');
    expect(args.thesis).toContain('re-anchored');
  });

  it('401 unauthenticated / 403 cross-origin', async () => {
    verifyAdminAuth.mockResolvedValue(false);
    expect((await POST(postReq({ ladderId: 'x' }))).status).toBe(401);
    verifyAdminAuth.mockResolvedValue(true);
    isSameOrigin.mockReturnValue(false);
    expect((await POST(postReq({ ladderId: 'x' }))).status).toBe(403);
    expect(applyDraftReanchor).not.toHaveBeenCalled();
  });

  it('409 for a non-draft (armed prices are consented — never rewritten)', async () => {
    getLadderWithRungs.mockResolvedValue(draft({ status: 'armed' }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(409);
    expect(applyDraftReanchor).not.toHaveBeenCalled();
  });

  it('403 for a scout-authored ladder', async () => {
    getLadderWithRungs.mockResolvedValue(draft({ author: 'scout' }));
    expect((await POST(postReq({ ladderId: 'abcd1234-0000-0000' }))).status).toBe(403);
  });

  it('422 for a manual draft with no stored anchor (structural levels)', async () => {
    getLadderWithRungs.mockResolvedValue(draft({ anchorPx: null }));
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('structural');
    expect(fetchAllMids).not.toHaveBeenCalled();
  });

  it('422 for a multi-coin ladder (mark ambiguity)', async () => {
    getLadderWithRungs.mockResolvedValue(draft({ rungs: [mkRung(), mkRung({ id: 'r2', seq: 2, coin: 'ETH' })] }));
    expect((await POST(postReq({ ladderId: 'abcd1234-0000-0000' }))).status).toBe(422);
  });

  it('502 when the mids fetch fails or the coin has no mark (NEVER re-anchor blind)', async () => {
    fetchAllMids.mockRejectedValue(new Error('hl down'));
    expect((await POST(postReq({ ladderId: 'abcd1234-0000-0000' }))).status).toBe(502);
    fetchAllMids.mockResolvedValue({ ETH: 2000 }); // SOL absent
    expect((await POST(postReq({ ladderId: 'abcd1234-0000-0000' }))).status).toBe(502);
    expect(applyDraftReanchor).not.toHaveBeenCalled();
  });

  it('422 when the drift exceeds the ±50% bound', async () => {
    fetchAllMids.mockResolvedValue({ SOL: 300 });
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('re-draft');
  });

  it('409 when the atomic write reports the ladder stopped being a draft (or vanished) mid-request', async () => {
    applyDraftReanchor.mockResolvedValue('not-draft');
    expect((await POST(postReq({ ladderId: 'abcd1234-0000-0000' }))).status).toBe(409);
    applyDraftReanchor.mockResolvedValue('not-found');
    expect((await POST(postReq({ ladderId: 'abcd1234-0000-0000' }))).status).toBe(409);
  });

  it('REPLACES a previous re-anchor note instead of stacking them (thesis stays bounded)', async () => {
    getLadderWithRungs.mockResolvedValue(
      draft({ thesis: 'ratios of the detection mark\n\n[re-anchored 2026-10-01T00:00:00.000Z: anchor 110 → 117.2 (+6.55%) — old note]' }),
    );
    const res = await POST(postReq({ ladderId: 'abcd1234-0000-0000' }));
    expect(res.status).toBe(200);
    const thesis = applyDraftReanchor.mock.calls[0][1].thesis as string;
    expect(thesis).toContain('ratios of the detection mark');
    expect(thesis.match(/\[re-anchored /g)?.length).toBe(1);
    expect(thesis).not.toContain('old note');
  });
});
