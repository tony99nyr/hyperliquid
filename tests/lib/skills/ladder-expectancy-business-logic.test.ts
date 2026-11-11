import { describe, it, expect } from 'vitest';
import {
  deriveSetupType,
  resolveLadderOutcome,
  buildExpectancyReport,
  DEFAULT_EXPECTANCY_BAR,
  classifyReportSetup,
  reportRiskMetrics,
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
  it('groups paired event-straddle legs and reports nominal and gap R', () => {
    const l = ladder([rung({})], { ocoGroupId: 'g', title: 'ETH event straddle long' });
    const other = ladder([rung({ side: 'short' })], { id: 'b', ocoGroupId: 'g', title: 'ETH event straddle short' });
    const row: LadderOutcomeRow = { ladderId: l.id, title: l.title, coin: 'ETH', side: 'long', mode: 'live', setupType: 'breakout-long-single', signalScore: null,
      timingScore: null, plannedRiskUsd: 15, realizedPnlUsd: -10, feesUsd: 0, realizedR: -0.67, outcome: 'lost', windowStartMs: 0, windowEndMs: 3, notes: null };
    expect(classifyReportSetup(row, [l, other].map((x) => ({ id: x.id, title: x.title, mode: x.mode, oco_group_id: x.ocoGroupId })))).toBe('event-straddle');
    const metrics = reportRiskMetrics(row, [{ id: 'r', ladderId: l.id, action: 'open', riskUsd: 10, stopPx: 90, side: 'long', coin: 'ETH' }],
      [{ ladderId: l.id, rungId: 'r', status: 'filled', firedAt: 1, detail: null }],
      { entryFills: [{ time: 2, px: 100, sz: 1, oid: null }], closeFills: [{ time: 3, px: 89, sz: 1, oid: null }] });
    expect(metrics.nominalR).toBe(-1);
    expect(metrics.gap.r).toBeCloseTo(0.1);
    expect(metrics.gap.bps).toBeCloseTo(111.111);
  });
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

describe('reportRiskMetrics: gap-past-stop from owner-attributed fills', () => {
  const row = (over: Partial<LadderOutcomeRow> = {}): LadderOutcomeRow => ({ ladderId: 'L', title: 'BTC event straddle long', coin: 'BTC', side: 'long', mode: 'live',
    setupType: 'breakout-long-single', signalScore: null, timingScore: null, plannedRiskUsd: 12, realizedPnlUsd: -12, feesUsd: 0, realizedR: -1, outcome: 'lost',
    windowStartMs: 0, windowEndMs: 30, notes: null, ...over });
  const open = (over: Partial<Parameters<typeof reportRiskMetrics>[1][number]> = {}) =>
    ({ id: 'r', ladderId: 'L', action: 'open', riskUsd: 10, stopPx: null, stopFrac: 0.1, side: 'long' as const, coin: 'BTC', ...over });
  const fire = (detail: string | null) => [{ ladderId: 'L', rungId: 'r', status: 'filled', firedAt: 10, detail }];
  const at = (px: number, sz = 1, time = 11, oid: number | null = null) => ({ time, px, sz, oid });
  const own = (entryPx: number, exitPx: number) => ({ entryFills: [at(entryPx)], closeFills: [at(exitPx, 1, 20)] });

  it('uses the stop the fire recorded in its detail', () => {
    const m = reportRiskMetrics(row(), [open()], fire(JSON.stringify({ entryOid: 1, stopOid: 2, tpOid: null, stopPx: 90 })), own(100, 89));
    expect(m.gap).toMatchObject({ stopSource: 'fire', reason: null });
    expect(m.gap.r).toBeCloseTo(0.1); // $1 beyond the stop on 1 coin, over $10 nominal risk
  });

  it('derives the stop from the entry fill and stopFrac for an older fire, long and short', () => {
    const long = reportRiskMetrics(row(), [open()], fire(JSON.stringify({ entryOid: 1, stopOid: 2, tpOid: null })), own(100, 88));
    expect(long.gap.stopSource).toBe('derived');
    expect(long.gap.r).toBeCloseTo(0.2); // stop 90, exit 88
    const short = reportRiskMetrics(row({ side: 'short' }), [open({ side: 'short' })], fire(null), own(100, 111));
    expect(short.gap.stopSource).toBe('derived');
    expect(short.gap.r).toBeCloseTo(0.1); // stop 110, exit 111
  });

  it('prefers the rung stop, then the fire stop, then the derived stop', () => {
    const fills = own(100, 80);
    expect(reportRiskMetrics(row(), [open({ stopPx: 95 })], fire(JSON.stringify({ stopPx: 90 })), fills).gap.stopSource).toBe('rung');
    expect(reportRiskMetrics(row(), [open()], fire(JSON.stringify({ stopPx: 90 })), fills).gap.stopSource).toBe('fire');
    // A malformed recorded stop is ignored, never trusted.
    expect(reportRiskMetrics(row(), [open()], fire(JSON.stringify({ stopPx: '90' })), fills).gap.stopSource).toBe('derived');
    expect(reportRiskMetrics(row(), [open()], fire('not json'), fills).gap.stopSource).toBe('derived');
  });

  it('reports zero gap when the exit was at or better than the planned stop', () => {
    const m = reportRiskMetrics(row({ realizedPnlUsd: 5 }), [open()], fire(null), own(100, 105));
    expect(m.gap).toMatchObject({ r: 0, bps: 0, reason: null });
  });

  it('counts each closing fill over its own size, not the last fill over the entry size', () => {
    // Half banked above the stop, half stopped $2 beyond it: $1 beyond in total.
    const m = reportRiskMetrics(row(), [open()], fire(null),
      { entryFills: [at(100)], closeFills: [at(104, 0.5, 15), at(88, 0.5, 20)] });
    expect(m.gap.r).toBeCloseTo(0.1);
    expect(m.gap.bps).toBeCloseTo(1 / 90 * 10_000); // size-weighted $1 beyond a stop at 90
  });

  it('sums the partial fills of the one entry order for the derived stop, and ignores later adds', () => {
    const m = reportRiskMetrics(row(), [open({ stopFrac: 0.1 })], fire(null),
      { entryFills: [at(98, 0.4, 11, 7), at(102, 0.4, 12, 7), at(150, 0.2, 14, 8)], closeFills: [at(89, 1, 20)] });
    expect(m.gap.r).toBeCloseTo(0.1); // entry average 100 (oid 7), stop 90; the add at 150 does not move it
  });

  it('keeps missing evidence explicit', () => {
    expect(reportRiskMetrics(row(), [open({ stopFrac: null })], fire(null), own(100, 89)).gap)
      .toMatchObject({ r: null, reason: 'planned stop missing', stopSource: null });
    expect(reportRiskMetrics(row(), [open()], fire(null), { entryFills: [at(100)], closeFills: [] }).gap)
      .toMatchObject({ r: null, reason: 'closing fill missing' });
    expect(reportRiskMetrics(row(), [open()], fire(null), null).gap).toMatchObject({ r: null, reason: 'fill attribution unavailable' });
    expect(reportRiskMetrics(row(), [open()], fire(null), undefined).nominalR).toBeCloseTo(-1.2);
  });

  it('takes the entry from the order the open fire recorded, not from the first entry fill', () => {
    // An earlier fill of another order (oid 5) sits in the ledger. The open fire recorded oid 7.
    const m = reportRiskMetrics(row(), [open()], fire(JSON.stringify({ entryOid: 7 })),
      { entryFills: [at(150, 0.2, 9, 5), at(100, 1, 11, 7)], closeFills: [at(89, 1.2, 20)] });
    expect(m.gap.stopSource).toBe('derived');
    expect(m.gap.r).toBeCloseTo(0.12); // stop 90 off the oid-7 entry at 100; 1.2 coins closed $1 beyond
  });

  it('follows a windowed order to its later partial fills', () => {
    const late = at(104, 0.5, 10 + 60_000, 7); // same order, filled after the match window
    const m = reportRiskMetrics(row(), [open()], fire(null), { entryFills: [at(96, 0.5, 11, 7), late], closeFills: [at(89, 1, 70_000)] });
    expect(m.gap.r).toBeCloseTo(0.1); // entry average 100, stop 90
  });

  it('does not derive a stop from an entry fill it cannot tie to the open fire', () => {
    const far = { entryFills: [at(100, 1, 10 + 60_000)], closeFills: [at(80, 1, 70_000)] };
    expect(reportRiskMetrics(row(), [open()], fire(null), far).gap).toMatchObject({ r: null, reason: 'entry fill not identified' });
    // A recorded stop needs no entry fill.
    expect(reportRiskMetrics(row(), [open()], fire(JSON.stringify({ stopPx: 90 })), far).gap.r).toBeCloseTo(1);
  });

  it('leaves the gap unmeasured when another owner shared the inventory', () => {
    const m = reportRiskMetrics(row(), [open()], fire(null), { ...own(100, 80), sharedInventory: true });
    expect(m.gap).toMatchObject({ r: null, bps: null, reason: 'inventory shared with another owner (ambiguous exit)' });
    expect(m.nominalR).toBeCloseTo(-1.2);
  });
});

describe('reportRiskMetrics: a later trade on the same coin is not this ladder\'s exit', () => {
  // Regression (2026-11-10): older outcome rows store the RESOLUTION time as windowEndMs.
  // A time window then read a later ladder's exit as this ladder's stop fill (+9.53R).
  function row(id: string): LadderOutcomeRow {
    return { ladderId: id, title: 'BTC straddle', coin: 'BTC', side: 'long', mode: 'live', setupType: 'x', signalScore: null, timingScore: null,
      plannedRiskUsd: 12, realizedPnlUsd: -1, feesUsd: 0, realizedR: -0.1, outcome: 'lost', windowStartMs: 0, windowEndMs: null, notes: null };
  }
  it('reads only the fills the attribution gave this ladder', () => {
    const mk = (id: string, side: 'long' | 'short') => ladder([rung({ id: `${id}-r`, ladderId: id, coin: 'BTC', side, action: 'open' })], { id });
    const a = mk('A', 'short');
    const b = mk('B', 'long');
    const fires = [
      { ladderId: 'A', rungId: 'A-r', status: 'filled', firedAt: 1_000, detail: JSON.stringify({ entryOid: 1 }) },
      { ladderId: 'B', rungId: 'B-r', status: 'filled', firedAt: 5_000, detail: JSON.stringify({ entryOid: 3 }) },
    ];
    const fills = [
      fill({ coin: 'BTC', side: 'sell', px: 100, sz: 1, time: 1_001, oid: 1 }), // A opens short
      fill({ coin: 'BTC', side: 'buy', px: 100.5, sz: 1, time: 2_000, oid: 2 }), // A closes inside its stop (101)
      fill({ coin: 'BTC', side: 'buy', px: 130, sz: 1, time: 5_001, oid: 3 }), // B opens long far above A's stop
      fill({ coin: 'BTC', side: 'sell', px: 140, sz: 1, time: 6_000, oid: 4 }), // B closes
    ];
    const ledgers = attributeLadderFills([a, b], fires, fills).byLadder;
    const rowA = { ...row('A'), side: 'short' as const, windowEndMs: 9_999 };
    const m = reportRiskMetrics(rowA, [{ id: 'A-r', ladderId: 'A', action: 'open', riskUsd: 10, stopPx: null, stopFrac: 0.01, side: 'short', coin: 'BTC' }], fires, ledgers.get('A'));
    expect(m.gap).toMatchObject({ r: 0, bps: 0, stopSource: 'derived' });
    expect(ledgers.get('A')?.sharedInventory).toBe(false);
    expect(ledgers.get('B')?.sharedInventory).toBe(false);
  });

  it('flags every owner when two ladders hold the same coin at a closing fill', () => {
    // First-in first-out gives the stop fill at 80 to A, although the exchange stop that
    // filled may have been B's. Neither ladder's stop overshoot is measurable.
    const mk = (id: string) => ladder([rung({ id: `${id}-r`, ladderId: id, coin: 'BTC', side: 'long', action: 'open' })], { id });
    const fires = [
      { ladderId: 'A', rungId: 'A-r', status: 'filled', firedAt: 1_000, detail: JSON.stringify({ entryOid: 1 }) },
      { ladderId: 'B', rungId: 'B-r', status: 'filled', firedAt: 2_000, detail: JSON.stringify({ entryOid: 2 }) },
      { ladderId: 'C', rungId: 'C-r', status: 'filled', firedAt: 9_000, detail: JSON.stringify({ entryOid: 5 }) },
    ];
    const fills = [
      fill({ coin: 'BTC', side: 'buy', px: 100, sz: 1, time: 1_001, oid: 1 }),
      fill({ coin: 'BTC', side: 'buy', px: 100, sz: 1, time: 2_001, oid: 2 }),
      fill({ coin: 'BTC', side: 'sell', px: 80, sz: 1, time: 3_000, oid: 3 }),
      fill({ coin: 'BTC', side: 'sell', px: 105, sz: 1, time: 4_000, oid: 4 }),
      fill({ coin: 'BTC', side: 'buy', px: 100, sz: 1, time: 9_001, oid: 5 }), // C trades alone, later
      fill({ coin: 'BTC', side: 'sell', px: 99, sz: 1, time: 9_500, oid: 6 }),
    ];
    const ledgers = attributeLadderFills([mk('A'), mk('B'), mk('C')], fires, fills).byLadder;
    expect(ledgers.get('A')?.sharedInventory).toBe(true);
    expect(ledgers.get('B')?.sharedInventory).toBe(true);
    expect(ledgers.get('C')?.sharedInventory).toBe(false);
    const m = reportRiskMetrics({ ...row('B'), windowEndMs: 9_999 },
      [{ id: 'B-r', ladderId: 'B', action: 'open', riskUsd: 10, stopPx: null, stopFrac: 0.1, side: 'long', coin: 'BTC' }], fires, ledgers.get('B'));
    expect(m.gap).toMatchObject({ r: null, reason: 'inventory shared with another owner (ambiguous exit)' });
  });
});

describe('unmatched filled entry', () => {
  it('keeps a filled fire open when attribution matched no entry size', () => {
    const l = ladder([rung({})]);
    const result = resolveLadderOutcome({ ladder: l, fireStatuses: ['filled'], hlFills: [],
      ownerLedger: { owner: l.id, coin: 'HYPE', entrySize: 0, openSize: 0, closedPnl: 0, fees: 0, lastCloseMs: null, entryFills: [], closeFills: [], sharedInventory: false },
      plannedRiskUsd: 10, positionStillOpen: false, now: NOW });
    expect(result.outcome).toBe('open');
    expect(result.notes).toMatch(/no matching entry fill/);
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
