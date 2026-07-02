import { describe, it, expect } from 'vitest';
import {
  deriveSetupType,
  resolveLadderOutcome,
  buildExpectancyReport,
  DEFAULT_EXPECTANCY_BAR,
  type LadderOutcomeRow,
} from '@/lib/skills/ladder-expectancy-business-logic';
import type { LadderRung, LadderWithRungs } from '@/lib/ladder/ladder-types';
import type { HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';

const NOW = 1_700_000_000_000;
const ARMED_AT = NOW - 3 * 86_400_000;

function rung(over: Partial<LadderRung>): LadderRung {
  return {
    id: 'r', ladderId: 'L', seq: 1, coin: 'HYPE', side: 'long', action: 'open',
    triggerKind: 'price_above', triggerPx: 66, triggerMeta: null,
    sizeCoins: null, reduceFrac: null, riskUsd: 6, stopFrac: 0.144, leverage: 2,
    stopPx: null, targetPx: null, status: 'fired', cloid: null, ...over,
  };
}

function ladder(rungs: LadderRung[], over: Partial<LadderWithRungs> = {}): LadderWithRungs {
  return {
    id: 'aaaa1111-0000-0000-0000-000000000000', title: 'HYPE long', thesis: null,
    author: 'operator', mode: 'live', status: 'done', preconditionHash: null, ocoGroupId: null, leaderAddress: null,
    maxTotalNotionalUsd: 100, maxTotalLossUsd: 20,
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    armedAt: new Date(ARMED_AT).toISOString(), disarmedAt: null, disarmReason: null, archivedAt: null, expiryAlertAt: null,
    createdAt: new Date(ARMED_AT - 3_600_000).toISOString(), updatedAt: new Date(NOW).toISOString(),
    rungs, ...over,
  };
}

const fill = (over: Partial<HlFill>): HlFill => ({
  coin: 'HYPE', side: 'sell', px: 70, sz: 1, time: NOW - 3_600_000, closedPnl: 0, fee: 0, dir: null, ...over,
});

describe('deriveSetupType', () => {
  it('tags a long price_above pyramid', () => {
    const l = ladder([rung({ action: 'open' }), rung({ seq: 2, action: 'add' })]);
    expect(deriveSetupType(l)).toBe('breakout-long-pyramid');
  });
  it('tags a short breakdown single', () => {
    const l = ladder([rung({ side: 'short', triggerKind: 'price_below' })]);
    expect(deriveSetupType(l)).toBe('breakdown-short-single');
  });
});

describe('resolveLadderOutcome', () => {
  const base = { plannedRiskUsd: 16, positionStillOpen: false, now: NOW };

  it('never_filled: no filled fires → costless pass, R=0', () => {
    const o = resolveLadderOutcome({ ...base, ladder: ladder([rung({ status: 'pending' })]), fireStatuses: ['failed'], hlFills: [] });
    expect(o.outcome).toBe('never_filled');
    expect(o.realizedR).toBe(0);
  });

  it('open: position still live → unresolved', () => {
    const o = resolveLadderOutcome({ ...base, ladder: ladder([rung({})]), fireStatuses: ['filled'], hlFills: [], positionStillOpen: true });
    expect(o.outcome).toBe('open');
    expect(o.realizedR).toBeNull();
  });

  it('open: fired but HL fills unavailable → cannot resolve yet', () => {
    const o = resolveLadderOutcome({ ...base, ladder: ladder([rung({})]), fireStatuses: ['filled'], hlFills: null });
    expect(o.outcome).toBe('open');
  });

  it('won: net closedPnl − fees inside the window → positive R', () => {
    const fills = [
      fill({ closedPnl: 8, fee: 0.1 }),
      fill({ closedPnl: 4, fee: 0.1 }),
      fill({ coin: 'ETH', closedPnl: 999 }),                    // other coin — excluded
      fill({ closedPnl: 999, time: ARMED_AT - 86_400_000 }),    // before window — excluded
    ];
    const o = resolveLadderOutcome({ ...base, ladder: ladder([rung({})]), fireStatuses: ['filled'], hlFills: fills });
    expect(o.outcome).toBe('won');
    expect(o.realizedPnlUsd).toBeCloseTo(11.8, 2);
    expect(o.realizedR).toBeCloseTo(11.8 / 16, 2);
  });

  it('scratch: |R| ≤ 0.05', () => {
    const o = resolveLadderOutcome({ ...base, ladder: ladder([rung({})]), fireStatuses: ['filled'], hlFills: [fill({ closedPnl: 0.5, fee: 0 })] });
    expect(o.outcome).toBe('scratch');
  });

  it('lost: negative net → lost with negative R', () => {
    const o = resolveLadderOutcome({ ...base, ladder: ladder([rung({})]), fireStatuses: ['filled'], hlFills: [fill({ closedPnl: -9, fee: 0.2 })] });
    expect(o.outcome).toBe('lost');
    expect(o.realizedR).toBeLessThan(-0.5);
  });
});

describe('buildExpectancyReport', () => {
  const row = (over: Partial<LadderOutcomeRow>): LadderOutcomeRow => ({
    ladderId: 'x', title: 't', coin: 'HYPE', side: 'long', mode: 'live',
    setupType: 'breakout-long-pyramid', signalScore: null, timingScore: null,
    plannedRiskUsd: 16, realizedPnlUsd: 8, feesUsd: 0.2, realizedR: 0.5,
    outcome: 'won', windowStartMs: ARMED_AT, windowEndMs: NOW, notes: null, ...over,
  });

  it('COLLECT below the pre-registered sample size', () => {
    const r = buildExpectancyReport([row({}), row({ outcome: 'lost', realizedR: -1 })]);
    expect(r.perSetup[0].verdict).toBe('COLLECT');
  });

  it('KILL at/below the kill bar with enough sample', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ ladderId: `k${i}`, outcome: 'lost', realizedR: -0.5, realizedPnlUsd: -8 }));
    const r = buildExpectancyReport(rows);
    expect(r.perSetup[0].verdict).toBe('KILL');
  });

  it('SIZE-UP at/above the size-up bar with enough sample', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ ladderId: `s${i}`, realizedR: 0.5 }));
    const r = buildExpectancyReport(rows);
    expect(r.perSetup[0].verdict).toBe('SIZE-UP');
  });

  it('HOLD between bars; never_filled and open are counted but excluded from expectancy', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row({ ladderId: `h${i}`, realizedR: i % 2 ? 0.3 : -0.2, outcome: i % 2 ? 'won' : 'lost' })),
      row({ ladderId: 'nf', outcome: 'never_filled', realizedR: 0 }),
      row({ ladderId: 'op', outcome: 'open', realizedR: null, realizedPnlUsd: null }),
    ];
    const r = buildExpectancyReport(rows);
    const s = r.perSetup[0];
    expect(s.verdict).toBe('HOLD');
    expect(s.closedTrades).toBe(10);
    expect(s.neverFilled).toBe(1);
    expect(s.open).toBe(1);
    // expectancy over closed only: 5×0.3 + 5×(−0.2) = 0.5 → /10 = 0.05
    expect(s.expectancyR).toBeCloseTo(0.05, 5);
  });

  it('bar is exported and pre-registered (sanity)', () => {
    expect(DEFAULT_EXPECTANCY_BAR.minTrades).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_EXPECTANCY_BAR.killExpectancyR).toBeLessThan(DEFAULT_EXPECTANCY_BAR.sizeUpExpectancyR);
  });
});
