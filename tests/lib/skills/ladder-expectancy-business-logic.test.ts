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
import { attributeLadderFills } from '@/lib/ladder/ladder-outcome-business-logic';

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
    maxTotalNotionalUsd: 100, maxTotalLossUsd: 20, anchorPx: null,
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    activeFrom: null,
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
  it('tags the trend-follow auto-draft lane by title, not rung shape', () => {
    const l = ladder([rung({ action: 'open' }), rung({ seq: 2, action: 'add' })]);
    l.title = 'ETH trend-follow long — 8h bullish 81% (auto-draft · review+arm)';
    expect(deriveSetupType(l)).toBe('trend-follow-8h-long');
  });
  it('tags the reversion-fade auto-draft lane by title', () => {
    const l = ladder([rung({ side: 'short', triggerKind: 'price_below' })]);
    l.title = 'BTC reversion-fade short — z=2.3 (auto-draft · review+arm)';
    expect(deriveSetupType(l)).toBe('reversion-fade-short');
  });
});

describe('position inventory attribution', () => {
  const eth = (id: string, side: 'long' | 'short' = 'long', action: LadderRung['action'] = 'open') =>
    ladder([rung({ id: `${id}-r`, ladderId: id, coin: 'ETH', side, action })], { id, title: `ETH ${id}` });
  const fire = (id: string, at: number, oid?: number) => ({ ladderId: id, rungId: `${id}-r`, status: 'filled',
    detail: oid == null ? null : JSON.stringify({ entryOid: oid }), firedAt: at });
  // HL sends numeric fields as strings. The service normalises them before this pure ledger.
  const hl = (side: 'buy' | 'sell', size: string, at: number, pnl = '0', fee = '0', oid?: number): HlFill =>
    fill({ coin: 'ETH', side, sz: Number(size), time: at, closedPnl: Number(pnl), fee: Number(fee), oid });
  const net = (row: { closedPnl: number; fees: number }) => row.closedPnl - row.fees;

  it('splits overlapping ETH ladder exits by FIFO lots and conserves every partial fill', () => {
    const a = eth('a'); const b = eth('b');
    const fills = [hl('buy', '1', 1_000, '0', '0.1', 11), hl('buy', '2', 2_000, '0', '0.2', 22),
      hl('sell', '1.5', 3_000, '15', '0.15'), hl('sell', '1.5', 4_000, '6', '0.15')];
    const result = attributeLadderFills([a, b], [fire('a', 999, 11), fire('b', 1_999, 22)], [...fills].reverse());
    expect(net(result.byLadder.get('a')!)).toBeCloseTo(9.8);
    expect(net(result.byLadder.get('b')!)).toBeCloseTo(10.6);
    expect(result.conservation[0].passed).toBe(true);
    expect(result.byLadder.get('a')?.openSize).toBeCloseTo(0);
  });

  it('keeps a straddle runner with its opening ladder, not its management ladder', () => {
    const straddle = eth('straddle', 'short'); const runner = eth('runner', 'short', 'stop_move');
    const fills = [hl('sell', '2', 1_000, '0', '0.2'), hl('buy', '1', 2_000, '8', '0.1'),
      hl('buy', '1', 3_000, '4', '0.1')];
    const result = attributeLadderFills([straddle, runner], [fire('straddle', 998), fire('runner', 2_500)], fills);
    expect(net(result.byLadder.get('straddle')!)).toBeCloseTo(11.6);
    expect(result.byLadder.get('runner')?.entrySize).toBe(0);
    expect(result.conservation[0].passed).toBe(true);
  });

  it('charges a resting stop without a recorded oid to the entry lot', () => {
    const cpi = eth('cpi', 'short');
    const result = attributeLadderFills([cpi], [fire('cpi', 1_000)],
      [hl('sell', '1', 1_012, '0', '0.2', 9), hl('buy', '1', 40_000, '9.08', '0.2', 80)]);
    expect(net(result.byLadder.get('cpi')!)).toBeCloseTo(8.68);
    expect(result.fallbackCount).toBe(1);
  });

  it('keeps interleaved manual inventory and its exit separate', () => {
    const a = eth('a');
    const result = attributeLadderFills([a], [fire('a', 1_000, 11)],
      [hl('buy', '1', 1_001, '0', '0.1', 11), hl('buy', '1', 2_000, '0', '0.1', 12),
        hl('sell', '1', 3_000, '5', '0.1'), hl('sell', '1', 4_000, '-3', '0.1')]);
    expect(net(result.byLadder.get('a')!)).toBeCloseTo(4.8);
    expect(net(result.manual.get('ETH')!)).toBeCloseTo(-3.2);
    expect(result.conservation[0].passed).toBe(true);
  });

  it('splits a flip into a close and a new manual lot', () => {
    const a = eth('a');
    const result = attributeLadderFills([a], [fire('a', 1_000, 11)],
      [hl('buy', '1', 1_001, '0', '0.1', 11), hl('sell', '2', 2_000, '10', '0.2', 55),
        hl('buy', '1', 3_000, '3', '0.1')]);
    expect(net(result.byLadder.get('a')!)).toBeCloseTo(9.8);
    expect(net(result.manual.get('ETH')!)).toBeCloseTo(2.8);
    expect(result.manual.get('ETH')?.openSize).toBeCloseTo(0);
    expect(result.conservation[0].passed).toBe(true);
  });

  it('does not grant lots to an unfilled ladder while another ladder trades', () => {
    const a = eth('a'); const unfilled = eth('unfilled');
    const fills = [hl('buy', '1', 1_001, '0', '0.1', 11), hl('sell', '1', 2_000, '5', '0.1')];
    const attribution = attributeLadderFills([a, unfilled], [fire('a', 1_000, 11)], fills);
    const outcome = resolveLadderOutcome({ ladder: unfilled, fireStatuses: [], hlFills: fills,
      ownerLedger: attribution.byLadder.get('unfilled'), plannedRiskUsd: 10, positionStillOpen: false, now: NOW });
    expect(outcome.outcome).toBe('never_filled');
  });

  it('keeps a partly closed owned position open and exposes nominal R once flat', () => {
    const a = eth('a');
    const partial = attributeLadderFills([a], [fire('a', 1_000, 11)],
      [hl('buy', '2', 1_001, '0', '0.2', 11), hl('sell', '1', 2_000, '5', '0.1')]);
    expect(resolveLadderOutcome({ ladder: a, fireStatuses: ['filled'], hlFills: [],
      ownerLedger: partial.byLadder.get('a'), plannedRiskUsd: 20, positionStillOpen: false, now: NOW }).outcome).toBe('open');
    const flat = attributeLadderFills([a], [fire('a', 1_000, 11)],
      [hl('buy', '2', 1_001, '0', '0.2', 11), hl('sell', '2', 2_000, '10', '0.2')]);
    const outcome = resolveLadderOutcome({ ladder: a, fireStatuses: ['filled'], hlFills: [],
      ownerLedger: flat.byLadder.get('a'), plannedRiskUsd: 20, nominalRiskUsd: 10,
      positionStillOpen: false, now: NOW });
    expect(outcome.realizedR).toBe(0.48);
    expect(outcome.nominalR).toBe(0.96);
  });

  it('uses the nearest unclaimed filled fire and prefers an entry oid', () => {
    const a = eth('a'); const b = eth('b');
    const result = attributeLadderFills([a, b], [fire('a', 1_000), fire('b', 1_005, 22)],
      [hl('buy', '1', 1_004, '0', '0', 22), hl('buy', '1', 1_006, '0', '0', 33)]);
    expect(result.byLadder.get('a')?.entrySize).toBe(1);
    expect(result.byLadder.get('b')?.entrySize).toBe(1);
    expect(result.fallbackCount).toBe(1);
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
