import { describe, it, expect } from 'vitest';
import {
  toLwcCandles,
  maLine,
  buildTradeLines,
} from '@/app/cockpit/components/chart/candle-chart-helpers';
import type { PriceCandle } from '@/types/trading-core';

function candle(ts: number, o: number, h: number, l: number, c: number): PriceCandle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 1 };
}

describe('toLwcCandles', () => {
  it('converts ms timestamps to seconds and keeps OHLC', () => {
    const out = toLwcCandles([candle(60_000, 1, 2, 0.5, 1.5)]);
    expect(out).toEqual([{ time: 60, open: 1, high: 2, low: 0.5, close: 1.5 }]);
  });

  it('drops out-of-order / duplicate-second rows (lib requires ascending unique time)', () => {
    const out = toLwcCandles([
      candle(60_000, 1, 1, 1, 1),
      candle(60_500, 2, 2, 2, 2), // same second (60) → dropped
      candle(120_000, 3, 3, 3, 3),
      candle(90_000, 4, 4, 4, 4), // earlier than prior → dropped
    ]);
    expect(out.map((c) => c.time)).toEqual([60, 120]);
  });
});

describe('maLine', () => {
  it('returns empty when fewer candles than the period', () => {
    expect(maLine([candle(1000, 1, 1, 1, 1)], 5)).toEqual([]);
  });

  it('aligns the SMA to the trailing candle times', () => {
    const candles = Array.from({ length: 5 }, (_, i) => candle((i + 1) * 60_000, i + 1, i + 1, i + 1, i + 1));
    const line = maLine(candles, 3);
    // 3 SMA points for 5 candles, aligned to candles[2..4].
    expect(line).toHaveLength(3);
    expect(line[0]).toEqual({ time: 180, value: 2 }); // mean(1,2,3)
    expect(line[2]).toEqual({ time: 300, value: 4 }); // mean(3,4,5)
  });
});

describe('buildTradeLines', () => {
  const colors = { entry: '#58a6ff', stop: '#f85149', target: '#3fb950' };

  it('returns no lines when there is no trade', () => {
    expect(buildTradeLines(null, colors)).toEqual([]);
  });

  it('emits entry (solid) + stop/target (dashed) when present', () => {
    const lines = buildTradeLines({ side: 'long', entryPx: 2000, stopPx: 1900, targetPx: 2200 }, colors);
    expect(lines.map((l) => l.title)).toEqual(['ENTRY', 'STOP', 'TARGET']);
    expect(lines[0].dashed).toBe(false);
    expect(lines[1].dashed).toBe(true);
    expect(lines[1].color).toBe(colors.stop);
  });

  it('omits lines for null/non-finite prices', () => {
    const lines = buildTradeLines({ side: 'short', entryPx: 2000, stopPx: null, targetPx: NaN }, colors);
    expect(lines.map((l) => l.title)).toEqual(['ENTRY']);
  });
});
