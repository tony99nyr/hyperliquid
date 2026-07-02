import { describe, it, expect } from 'vitest';
import { reviewLadder, rubricSignalScore, RUBRIC_SIGNAL_MAX_AGE_MS, type LadderReviewContext } from '@/lib/skills/review-ladder-business-logic';
import type { LadderRung, LadderWithRungs, RungAction } from '@/lib/ladder/ladder-types';

const NOW = 1_700_000_000_000;

function rung(over: Partial<LadderRung>): LadderRung {
  return {
    id: 'r', ladderId: 'L', seq: 1, coin: 'HYPE', side: 'long', action: 'open',
    triggerKind: 'price_above', triggerPx: null, triggerMeta: null,
    sizeCoins: null, reduceFrac: null, riskUsd: null, stopFrac: null, leverage: null,
    stopPx: null, targetPx: null, status: 'pending', cloid: null, ...over,
  };
}

function ladder(rungs: LadderRung[], over: Partial<LadderWithRungs> = {}): LadderWithRungs {
  return {
    id: '54118e71-0000-0000-0000-000000000000', title: 'HYPE long', thesis: null,
    author: 'operator', mode: 'live', status: 'draft', preconditionHash: null, ocoGroupId: null, leaderAddress: null,
    maxTotalNotionalUsd: 100, maxTotalLossUsd: 20, expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
    armedAt: null, disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), rungs, ...over,
  };
}

const ctx: LadderReviewContext = {
  midByCoin: { HYPE: 64.7 }, fundingByCoin: { HYPE: 0.0000125 }, accountEquityUsd: 980,
  signalScore: null, timingScore: null, now: NOW,
};

const CLEAN = [
  rung({ seq: 1, action: 'open', triggerPx: 66, riskUsd: 6, stopFrac: 0.144, leverage: 2 }),
  rung({ seq: 2, action: 'add', triggerPx: 72, riskUsd: 3, stopFrac: 0.083, leverage: 2 }),
  rung({ seq: 3, action: 'reduce', triggerPx: 74.5, reduceFrac: 0.4 }),
  rung({ seq: 4, action: 'reduce', triggerPx: 80, reduceFrac: 0.4 }),
];

describe('reviewLadder — clean half-size ladder', () => {
  const sc = reviewLadder(ladder(CLEAN), ctx);

  it('has no blockers and a non-blocked verdict', () => {
    expect(sc.blockers).toEqual([]);
    expect(sc.verdict).not.toMatch(/BLOCKED/);
  });
  it('scores risk highly (well-managed)', () => {
    expect(sc.riskScore).toBeGreaterThanOrEqual(8);
    const liq = sc.riskPillars.find((p) => p.key === 'liq')!;
    expect(liq.score).toBe(10); // wide stop clears liq comfortably at 2x
  });
  it('exposes the engine worst-case (slip-aware) and % of equity', () => {
    expect(sc.worstCaseLossWithFundingUsd).toBeGreaterThan(10); // ~$16, not the ~$9 at-stop
    expect(sc.worstCaseLossWithFundingUsd).toBeLessThan(20);    // under the cap
    expect(sc.pctOfEquity).toBeCloseTo((sc.worstCaseLossWithFundingUsd / 980) * 100, 1);
  });
  it('every pillar is a 0-10 number on both axes', () => {
    for (const p of [...sc.riskPillars, ...sc.upsidePillars]) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(10);
    }
    expect(sc.riskPillars).toHaveLength(6);
    expect(sc.upsidePillars).toHaveLength(4);
  });
});

describe('reviewLadder — loss-cap breach blocks', () => {
  it('flags a blocker and tanks the loss pillar when worst case exceeds the cap', () => {
    const sc = reviewLadder(ladder(CLEAN, { maxTotalLossUsd: 10 }), ctx); // cap below the ~$16 worst case
    expect(sc.blockers.some((b) => /exceeds the loss cap/i.test(b))).toBe(true);
    expect(sc.verdict).toMatch(/BLOCKED/);
    expect(sc.riskPillars.find((p) => p.key === 'loss')!.score).toBeLessThanOrEqual(2);
  });
});

describe('reviewLadder — martingale add blocks pyramiding', () => {
  it('flags a non-decreasing add as a blocker', () => {
    const martingale = [
      rung({ seq: 1, action: 'open', triggerPx: 66, riskUsd: 6, stopFrac: 0.144, leverage: 2 }),
      // riskUsd 8 with a tight stop sizes the add BIGGER than the core → averaging-up.
      rung({ seq: 2, action: 'add' as RungAction, triggerPx: 72, riskUsd: 8, stopFrac: 0.05, leverage: 2 }),
    ];
    const sc = reviewLadder(ladder(martingale, { maxTotalLossUsd: 100 }), ctx);
    expect(sc.blockers.some((b) => /DECREASE|averaging/i.test(b))).toBe(true);
    expect(sc.riskPillars.find((p) => p.key === 'pyr')!.score).toBeLessThanOrEqual(2);
  });
});

describe('reviewLadder — judgment pillar', () => {
  it('is neutral + flagged when no signal/timing supplied', () => {
    const sc = reviewLadder(ladder(CLEAN), ctx);
    const t = sc.upsidePillars.find((p) => p.key === 'thesis')!;
    expect(t.score).toBe(5);
    expect(t.note).toMatch(/NOT scored/i);
  });
  it('uses caller-supplied signal/timing when given', () => {
    const sc = reviewLadder(ladder(CLEAN), { ...ctx, signalScore: 8, timingScore: 6 });
    const t = sc.upsidePillars.find((p) => p.key === 'thesis')!;
    expect(t.score).toBe(7); // mean(8,6)
  });
  it('names the signal source in the note', () => {
    const sc = reviewLadder(ladder(CLEAN), { ...ctx, signalScore: 7, signalSource: 'rubric ADR-0006, auto' });
    expect(sc.upsidePillars.find((p) => p.key === 'thesis')!.note).toMatch(/rubric ADR-0006/);
  });
});

describe('reviewLadder — live resting stop supersedes the projection for FIRED rungs', () => {
  // Fired core: projection derives stop 66×(1−0.144)=56.496 (ON the 56.5 magnet), but the
  // LIVE resting stop was tightened to 59.85 (clean). The live one must win.
  const FIRED = [
    rung({ seq: 1, action: 'open', triggerPx: 66, riskUsd: 6, stopFrac: 0.144, leverage: 2, status: 'fired' }),
    rung({ seq: 3, action: 'reduce', triggerPx: 77, reduceFrac: 0.4 }),
  ];

  it('scores the live stop, not the projected magnet', () => {
    const sc = reviewLadder(ladder(FIRED, { status: 'armed' }), { ...ctx, liveStopByCoin: { HYPE: 59.85 } });
    const stop = sc.riskPillars.find((p) => p.key === 'stop')!;
    expect(stop.note).not.toMatch(/56\.5 round level/);
    expect(stop.note).toMatch(/live resting stop/);
    // width vs mark 64.7: (64.7−59.85)/64.7 ≈ 7.5% → clean 10 (no magnet on 59.85)
    expect(stop.score).toBe(10);
  });

  it('read-ok-but-NO-stop on a fired coin = NAKED live position → blocker', () => {
    const sc = reviewLadder(ladder(FIRED, { status: 'armed' }), { ...ctx, liveStopByCoin: { HYPE: null } });
    expect(sc.blockers.some((b) => /naked/i.test(b))).toBe(true);
    expect(sc.riskPillars.find((p) => p.key === 'stop')!.score).toBe(0);
  });

  it('unreadable (key absent) falls back to the projection — old behavior', () => {
    const sc = reviewLadder(ladder(FIRED, { status: 'armed' }), { ...ctx, liveStopByCoin: {} });
    const stop = sc.riskPillars.find((p) => p.key === 'stop')!;
    expect(stop.note).toMatch(/56\.5 round level/); // the projected magnet flag returns
  });

  it('an UNFIRED draft never consults live stops (projection as before)', () => {
    const sc = reviewLadder(ladder(CLEAN), { ...ctx, liveStopByCoin: { HYPE: null } });
    expect(sc.blockers.some((b) => /naked/i.test(b))).toBe(false);
  });
});

describe('rubricSignalScore (rubric → thesis pillar)', () => {
  it('maps opportunity 0-100 → 0-10 when fresh', () => {
    expect(rubricSignalScore(63, NOW - 3_600_000, NOW)).toBe(6.3);
    expect(rubricSignalScore(100, NOW, NOW)).toBe(10);
    expect(rubricSignalScore(0, NOW, NOW)).toBe(0);
  });
  it('returns null when stale, missing, or from the future', () => {
    expect(rubricSignalScore(63, NOW - RUBRIC_SIGNAL_MAX_AGE_MS - 1, NOW)).toBeNull();
    expect(rubricSignalScore(63, null, NOW)).toBeNull();
    expect(rubricSignalScore(null, NOW, NOW)).toBeNull();
    expect(rubricSignalScore(63, NOW + 60_000, NOW)).toBeNull();
  });
  it("only 'both-gated' (the kill-gates) zeroes the score; advisory reasons keep the number", () => {
    expect(rubricSignalScore(80, NOW, NOW, 'both-gated')).toBe(0);
    expect(rubricSignalScore(35, NOW, NOW, 'below-bar')).toBe(3.5);
    expect(rubricSignalScore(35, NOW, NOW, 'portfolio-cap')).toBe(3.5);
  });
});
