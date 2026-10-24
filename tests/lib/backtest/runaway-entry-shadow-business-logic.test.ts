import { describe, expect, it } from 'vitest';
import { evaluateRunawayDetection, type RunawayShadowCandle } from '@/lib/backtest/runaway-entry-shadow-business-logic';

const H = 3_600_000;
const base: RunawayShadowCandle[] = [
  { timestamp: 0, open: 100, high: 101, low: 99, close: 100 },
  { timestamp: H, open: 100, high: 101, low: 96, close: 97 },
  { timestamp: 2 * H, open: 97, high: 104, low: 97, close: 103 },
  { timestamp: 3 * H, open: 103, high: 104, low: 90, close: 92 },
];

describe('runaway entry shadow logic', () => {
  it('scores a pullback fill from its fill price through a later reversal', () => {
    const result = evaluateRunawayDetection({
      id: 'eth-1', coin: 'ETH', side: 'long', detectedAt: 0, mark: 100, extreme: 100,
    }, base, [48 * H, 168 * H]);
    const pullback = result.strategies.pullback;
    expect(pullback.filledFraction).toBe(1);
    expect(pullback.fillPrice).toBe(96.5);
    expect(pullback.horizons[48 * H]?.stopHit).toBe(true);
    expect(pullback.horizons[48 * H]?.grossReturn).toBeLessThan(0);
  });

  it('records an unfilled pullback as a zero-return no-trade', () => {
    const candles = base.map((c) => ({ ...c, low: Math.max(c.low, 98) }));
    const result = evaluateRunawayDetection({
      id: 'btc-1', coin: 'BTC', side: 'long', detectedAt: 0, mark: 100, extreme: 100,
    }, candles, [48 * H]);
    expect(result.strategies.pullback.filledFraction).toBe(0);
    expect(result.strategies.pullback.horizons[48 * H]?.netReturn).toBe(0);
    expect(result.strategies.pullback.horizons[48 * H]?.noTrade).toBe(true);
  });
});
