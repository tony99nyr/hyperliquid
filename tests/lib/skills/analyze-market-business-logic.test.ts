import { describe, it, expect } from 'vitest';
import {
  composeMarketAssessment,
  readTimeframe,
  type TimeframeCandles,
} from '@/lib/skills/analyze-market-business-logic';
import type { PriceCandle } from '@/types/trading-core';

const HOUR = 60 * 60 * 1000;
function series(count: number, start: number, stepReturn: number): PriceCandle[] {
  const out: PriceCandle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + stepReturn);
    out.push({
      timestamp: i * HOUR,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

describe('readTimeframe', () => {
  it('reports no data when too few candles', () => {
    const r = readTimeframe('1h', series(10, 1000, 0.01));
    expect(r.hasData).toBe(false);
    expect(r.regime).toBe('neutral');
  });
  it('produces a read with regime + RSI when enough candles', () => {
    const r = readTimeframe('1h', series(220, 1000, 0.01));
    expect(r.hasData).toBe(true);
    expect(r.rsi).not.toBeNull();
  });
});

describe('composeMarketAssessment', () => {
  it('returns a bullish bias for an uptrending series across all TFs', () => {
    const candles: TimeframeCandles = {
      '1d': series(220, 1000, 0.01),
      '8h': series(220, 1000, 0.01),
      '1h': series(220, 1000, 0.01),
      '15m': series(220, 1000, 0.01),
    };
    const a = composeMarketAssessment('ETH', candles);
    expect(a.biasLabel).toBe('bullish');
    expect(a.bias).toBeGreaterThan(0);
    expect(a.reads).toHaveLength(4);
  });
  it('reports no read when all timeframes are thin', () => {
    const a = composeMarketAssessment('ETH', { '1h': series(5, 1000, 0.01) });
    expect(a.summary).toContain('insufficient');
    expect(a.bias).toBe(0);
  });

  // Regression: the vendored regime detector caches indicators in a MODULE-LEVEL
  // buffer keyed only by (candle count, last close). All four timeframes here are
  // fetched up to "now", so they share the same candle count AND the same latest
  // close — keys collide. Without clearing the cache between timeframes the
  // detector silently reuses the FIRST timeframe's indicators for every TF,
  // producing a uniform (degenerate) regime/confidence regardless of the actual
  // per-timeframe price action. This test pins distinct datasets that COLLIDE on
  // (count, last close) and asserts the reads are NOT all identical.
  it('does NOT collapse to a uniform regime when TFs share candle count + last close', () => {
    const COUNT = 260;
    const LAST_CLOSE = 1800;

    // Build a series that ends EXACTLY on LAST_CLOSE with COUNT candles, given a
    // per-step return that defines the shape (strong down, mild, up, choppy).
    const sharedTail = (stepReturn: number): PriceCandle[] => {
      // Work backwards from LAST_CLOSE so every series has the same final close.
      const closes: number[] = new Array(COUNT);
      closes[COUNT - 1] = LAST_CLOSE;
      for (let i = COUNT - 2; i >= 0; i--) {
        closes[i] = closes[i + 1] / (1 + stepReturn);
      }
      const out: PriceCandle[] = [];
      for (let i = 0; i < COUNT; i++) {
        const close = closes[i]!;
        const open = i === 0 ? close : closes[i - 1]!;
        out.push({
          timestamp: i * HOUR,
          open,
          high: Math.max(open, close) * 1.002,
          low: Math.min(open, close) * 0.998,
          close,
          volume: 1000,
        });
      }
      return out;
    };

    const candles: TimeframeCandles = {
      '1d': sharedTail(-0.02), // strong downtrend into LAST_CLOSE
      '8h': sharedTail(-0.002), // mild drift
      '1h': sharedTail(0.012), // uptrend
      '15m': sharedTail(0.0), // flat
    };

    // Sanity: the collision precondition actually holds.
    for (const tf of ['1d', '8h', '1h', '15m'] as const) {
      const arr = candles[tf]!;
      expect(arr).toHaveLength(COUNT);
      expect(arr[arr.length - 1]!.close).toBeCloseTo(LAST_CLOSE, 6);
    }

    const a = composeMarketAssessment('ETH', candles);
    expect(a.reads).toHaveLength(4);
    for (const r of a.reads) expect(r.hasData).toBe(true);

    // The bug symptom is a UNIFORM read across all four TFs. With the cache
    // cleared per-TF, the distinct price shapes must produce a non-degenerate,
    // VARYING result. Assert the (regime, confidence) tuples are not all equal.
    const fingerprints = new Set(
      a.reads.map((r) => `${r.regime}:${r.confidence.toFixed(4)}`),
    );
    expect(fingerprints.size).toBeGreaterThan(1);

    // And confidence must not be uniformly ~0 (the original "1% everywhere" bug).
    const maxConfidence = Math.max(...a.reads.map((r) => r.confidence));
    expect(maxConfidence).toBeGreaterThan(0.05);
  });
});
