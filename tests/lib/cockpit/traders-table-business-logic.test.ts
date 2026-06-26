import { describe, it, expect } from 'vitest';
import {
  sortTraders,
  filterTraders,
  isThinHistory,
  isVaultLed,
  type SortKey,
  type GetEval,
  type TraderEvalLite,
} from '@/lib/cockpit/traders-table-business-logic';
import type { TopTraderRow, TopTraderMetrics } from '@/lib/hyperliquid/top-traders-service';

function metrics(over: Partial<TopTraderMetrics> = {}): TopTraderMetrics {
  return {
    sharpe: null, winRate: null, profitFactor: null, maxDrawdownFrac: null,
    aggregatePnlUsd: null, medianHoldHours: null, nFills: 200, worstLossVsMedianWin: null,
    totalReturn: null, medianAddDepth: null, maxAddDepth: null, reserveMultiple: null,
    majorsShare: null, liquidations: null, distinctCoins: null, ...over,
  };
}
function row(over: Partial<TopTraderRow> = {}, m: Partial<TopTraderMetrics> = {}): TopTraderRow {
  return {
    address: '0xabc', short: '0xabc…', displayName: null, composite: 5,
    hasRisk: false, cleanBook: false, tradesTradeableCoin: true, flags: [], allFlags: [],
    leaderboardTop: false, topCoins: [], metrics: metrics(m), ...over,
  };
}

const noFav = () => false;

describe('sortTraders', () => {
  it('sorts desc by a metric and keeps nulls last', () => {
    const rows = [
      row({ address: 'a' }, { totalReturn: 0.1 }),
      row({ address: 'b' }, { totalReturn: null }),
      row({ address: 'c' }, { totalReturn: 0.9 }),
    ];
    const out = sortTraders(rows, 'totalReturn', 'desc').map((r) => r.address);
    expect(out).toEqual(['c', 'a', 'b']); // 0.9, 0.1, null-last
  });

  it('nulls stay last even ascending', () => {
    const rows = [
      row({ address: 'a' }, { winRate: 0.4 }),
      row({ address: 'b' }, { winRate: null }),
      row({ address: 'c' }, { winRate: 0.2 }),
    ];
    const out = sortTraders(rows, 'winRate', 'asc').map((r) => r.address);
    expect(out).toEqual(['c', 'a', 'b']);
  });

  it('reads composite from the row, not metrics', () => {
    const rows = [row({ address: 'a', composite: 3 }), row({ address: 'b', composite: 9 })];
    expect(sortTraders(rows, 'composite' as SortKey, 'desc').map((r) => r.address)).toEqual(['b', 'a']);
  });
});

describe('filterTraders', () => {
  const rows = [
    row({ address: 'fav', hasRisk: false }, { winRate: 0.7, medianHoldHours: 5, nFills: 300 }),
    row({ address: 'risky', hasRisk: true }, { winRate: 0.6, medianHoldHours: 5, nFills: 300 }),
    row({ address: 'vault', allFlags: ['VAULT_LED'] }, { winRate: 0.8, medianHoldHours: 80, nFills: 300 }),
    row({ address: 'thin' }, { winRate: 0.9, medianHoldHours: 2, nFills: 10 }),
  ];

  it('favoritesOnly uses the predicate', () => {
    const out = filterTraders(rows, { favoritesOnly: true }, (a) => a === 'vault');
    expect(out.map((r) => r.address)).toEqual(['vault']);
  });
  it('excludeRisk drops risk-flagged', () => {
    expect(filterTraders(rows, { excludeRisk: true }, noFav).some((r) => r.address === 'risky')).toBe(false);
  });
  it('vaultOnly keeps only vault-backed', () => {
    expect(filterTraders(rows, { vaultOnly: true }, noFav).map((r) => r.address)).toEqual(['vault']);
  });
  it('excludeThin drops under-sampled names', () => {
    expect(filterTraders(rows, { excludeThin: true }, noFav).some((r) => r.address === 'thin')).toBe(false);
  });
  it('minWinRate + maxMedianHold gate', () => {
    const out = filterTraders(rows, { minWinRate: 0.75, maxMedianHoldHours: 10 }, noFav);
    expect(out.map((r) => r.address)).toEqual(['thin']); // winRate 0.9, hold 2
  });
});

describe('copyability eval sort + filter', () => {
  const evals: Record<string, TraderEvalLite> = {
    fol: { verdict: 'follow', addsPerTrip: 2, roundTrips: 12 },
    cau: { verdict: 'caution', addsPerTrip: 1, roundTrips: 8 },
    avo: { verdict: 'avoid', addsPerTrip: 50, roundTrips: 4 },
    noev: { verdict: 'follow', addsPerTrip: null, roundTrips: 0 }, // vacuous follow
  };
  const getEval: GetEval = (a) => evals[a] ?? null;
  const evalRows = [
    row({ address: 'fol' }), row({ address: 'cau' }), row({ address: 'avo' }),
    row({ address: 'noev' }), row({ address: 'unvetted' }),
  ];

  it("sortTraders 'copyability' ranks follow > caution > avoid, unvetted last", () => {
    const out = sortTraders(evalRows, 'copyability', 'desc', getEval).map((r) => r.address);
    expect(out.slice(0, 3)).toEqual(expect.arrayContaining(['fol', 'noev'])); // both follow rank highest
    expect(out[out.length - 1]).toBe('unvetted'); // null verdict sorts last
    expect(out.indexOf('avo')).toBeGreaterThan(out.indexOf('cau')); // avoid below caution
  });
  it('followableOnly keeps only verdict=follow', () => {
    expect(filterTraders(evalRows, { followableOnly: true }, noFav, getEval).map((r) => r.address)).toEqual(['fol', 'noev']);
  });
  it('hideAvoid drops verdict=avoid', () => {
    expect(filterTraders(evalRows, { hideAvoid: true }, noFav, getEval).some((r) => r.address === 'avo')).toBe(false);
  });
  it('hideNoEvidence drops vetted 0-trip names but keeps unvetted', () => {
    const out = filterTraders(evalRows, { hideNoEvidence: true }, noFav, getEval).map((r) => r.address);
    expect(out).not.toContain('noev');
    expect(out).toContain('unvetted'); // unvetted has no eval → not a "no-evidence" cut
  });
  it('vettedOnly keeps only traders with an evaluation', () => {
    expect(filterTraders(evalRows, { vettedOnly: true }, noFav, getEval).some((r) => r.address === 'unvetted')).toBe(false);
  });
});

describe('badges', () => {
  it('isThinHistory true under the min, false at/over', () => {
    expect(isThinHistory(row({}, { nFills: 49 }))).toBe(true);
    expect(isThinHistory(row({}, { nFills: null }))).toBe(true);
    expect(isThinHistory(row({}, { nFills: 50 }))).toBe(false);
  });
  it('isVaultLed reads the flag', () => {
    expect(isVaultLed(row({ allFlags: ['VAULT_LED'] }))).toBe(true);
    expect(isVaultLed(row({ allFlags: [] }))).toBe(false);
  });
});
