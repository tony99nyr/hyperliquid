import { describe, it, expect } from 'vitest';
import { reviewLadder, type LadderReviewContext } from '@/lib/skills/review-ladder-business-logic';
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
    author: 'operator', mode: 'live', status: 'draft', preconditionHash: null, ocoGroupId: null,
    maxTotalNotionalUsd: 100, maxTotalLossUsd: 20, expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
    armedAt: null, disarmedAt: null, disarmReason: null,
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
});
