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
});
