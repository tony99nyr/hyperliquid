import { describe, expect, it } from 'vitest';
import { regimeAtEntry, splitRegimeExpectancy } from '@/lib/backtest/regime-split-expectancy-business-logic';
import type { PriceCandle } from '@/types/trading-core';

const HOUR = 3_600_000;

describe('regime split expectancy', () => {
  it('uses completed four-hour candles and keeps thin cells visible', () => {
    const candles: PriceCandle[] = Array.from({ length: 52 }, (_, i) => ({
      timestamp: i * 4 * HOUR, open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    expect(regimeAtEntry(candles, 52 * 4 * HOUR)).toBe('neutral');
    expect(regimeAtEntry(candles, 51 * 4 * HOUR - 1)).toBe('unknown');
    const report = splitRegimeExpectancy([
      { id: 'a', source: 'live-ladder', lane: 'event-straddle', coin: 'BTC', entryTime: 52 * 4 * HOUR, netR: 1 },
      { id: 'b', source: 'scout', lane: 'htf-trend', coin: 'BTC', entryTime: 52 * 4 * HOUR, netR: -1 },
    ], { BTC: candles });
    expect(report.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'live-ladder', lane: 'event-straddle', regime: 'neutral', n: 1, meanR: 1, thin: true }),
      expect.objectContaining({ source: 'scout', lane: 'htf-trend', regime: 'neutral', n: 1, meanR: -1, thin: true }),
    ]));
  });

  it('deduplicates outcomes and rejects invalid R', () => {
    expect(() => splitRegimeExpectancy([
      { id: 'a', source: 'scout', lane: 'x', coin: 'BTC', entryTime: 0, netR: 1 },
      { id: 'a', source: 'scout', lane: 'x', coin: 'BTC', entryTime: 0, netR: 2 },
    ], {})).toThrow('Duplicate');
  });
});
