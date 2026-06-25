import { describe, it, expect } from 'vitest';
import {
  sortTraders,
  filterTraders,
  isThinHistory,
  isVaultLed,
  type SortKey,
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
