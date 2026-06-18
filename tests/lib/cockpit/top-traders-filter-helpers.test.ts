import { describe, it, expect } from 'vitest';
import {
  TRADEABLE_COINS,
  normalizeCoin,
  coinsIntersectTradeable,
  applyTraderFilters,
  rowPasses,
  DEFAULT_FILTER_STATE,
  type TraderFilterState,
} from '@/app/cockpit/components/left-rail/top-traders-filter-helpers';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

function row(over: Partial<TopTraderRow>): TopTraderRow {
  return {
    address: '0xabc',
    short: '0xab…cd',
    displayName: null,
    composite: 8,
    hasRisk: false,
    cleanBook: false,
    tradesTradeableCoin: true,
    flags: [],
    allFlags: [],
    leaderboardTop: false,
    topCoins: [],
    metrics: {
      sharpe: null, winRate: null, profitFactor: null, maxDrawdownFrac: null,
      aggregatePnlUsd: null, medianHoldHours: null, nFills: null, worstLossVsMedianWin: null,
    },
    ...over,
  };
}

describe('normalizeCoin', () => {
  it('strips spot-pair + builder decoration and upper-cases', () => {
    expect(normalizeCoin('eth')).toBe('ETH');
    expect(normalizeCoin('PURR/USDC')).toBe('PURR');
    expect(normalizeCoin('  hype ')).toBe('HYPE');
  });
});

describe('coinsIntersectTradeable', () => {
  it('matches when any coin is in the tradeable set (ETH/BTC/HYPE)', () => {
    expect(TRADEABLE_COINS).toEqual(['ETH', 'BTC', 'HYPE']);
    expect(coinsIntersectTradeable(['HYPE', 'PUMP'])).toBe(true);
    expect(coinsIntersectTradeable(['btc'])).toBe(true);
    expect(coinsIntersectTradeable(['FARTCOIN', 'WIF'])).toBe(false);
    expect(coinsIntersectTradeable([])).toBe(false);
  });
});

describe('rowPasses / applyTraderFilters', () => {
  const allOff: TraderFilterState = { cleanBook: false, hideAtRisk: false, tradeableOnly: false, hasPosition: false };

  it('passes everything with all filters off', () => {
    expect(rowPasses(row({ hasRisk: true, tradesTradeableCoin: false }), allOff)).toBe(true);
  });

  it('cleanBook keeps only clean-book wallets', () => {
    const f = { ...allOff, cleanBook: true };
    expect(rowPasses(row({ cleanBook: true }), f)).toBe(true);
    expect(rowPasses(row({ cleanBook: false }), f)).toBe(false);
  });

  it('hideAtRisk drops wallets with any risk flag', () => {
    const f = { ...allOff, hideAtRisk: true };
    expect(rowPasses(row({ hasRisk: false }), f)).toBe(true);
    expect(rowPasses(row({ hasRisk: true }), f)).toBe(false);
  });

  it('tradeableOnly drops wallets that trade none of our coins', () => {
    const f = { ...allOff, tradeableOnly: true };
    expect(rowPasses(row({ tradesTradeableCoin: true }), f)).toBe(true);
    expect(rowPasses(row({ tradesTradeableCoin: false }), f)).toBe(false);
  });

  it('filters COMPOSE with AND', () => {
    const f: TraderFilterState = { cleanBook: true, hideAtRisk: true, tradeableOnly: true, hasPosition: false };
    // clean + tradeable + no risk → passes
    expect(rowPasses(row({ cleanBook: true, hasRisk: false, tradesTradeableCoin: true }), f)).toBe(true);
    // clean book but at-risk → fails (hideAtRisk)
    expect(rowPasses(row({ cleanBook: true, hasRisk: true, tradesTradeableCoin: true }), f)).toBe(false);
    // clean + tradeable but not clean book → fails (cleanBook)
    expect(rowPasses(row({ cleanBook: false, hasRisk: false, tradesTradeableCoin: true }), f)).toBe(false);
    // clean book, no risk, but not tradeable → fails (tradeableOnly)
    expect(rowPasses(row({ cleanBook: true, hasRisk: false, tradesTradeableCoin: false }), f)).toBe(false);
  });

  it('applyTraderFilters narrows the list and preserves order', () => {
    const rows = [
      row({ address: '0x1', cleanBook: true, tradesTradeableCoin: true }),
      row({ address: '0x2', cleanBook: false, tradesTradeableCoin: true }),
      row({ address: '0x3', cleanBook: true, tradesTradeableCoin: false }),
    ];
    const out = applyTraderFilters(rows, { cleanBook: true, hideAtRisk: false, tradeableOnly: true, hasPosition: false });
    expect(out.map((r) => r.address)).toEqual(['0x1']);
  });

  it('default state has tradeableOnly ON, the rest OFF', () => {
    expect(DEFAULT_FILTER_STATE).toEqual({ cleanBook: false, hideAtRisk: false, tradeableOnly: true, hasPosition: false });
  });
});
