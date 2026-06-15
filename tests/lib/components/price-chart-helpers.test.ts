import { describe, it, expect } from 'vitest';
import {
  priceRange,
  xForIndex,
  yForPrice,
  buildCandleRects,
  placeMarkers,
  type ChartViewport,
} from '@/app/cockpit/components/price-chart-helpers';
import type { PriceCandle } from '@/types/trading-core';

const vp: ChartViewport = { width: 100, height: 100, padding: { top: 0, right: 0, bottom: 0, left: 0 } };

function candle(ts: number, o: number, h: number, l: number, c: number): PriceCandle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 0 };
}

describe('price-chart-helpers', () => {
  it('priceRange spans min low / max high with padding', () => {
    const r = priceRange([candle(1, 10, 12, 8, 11), candle(2, 11, 15, 9, 14)]);
    expect(r.low).toBeLessThan(8);
    expect(r.high).toBeGreaterThan(15);
  });

  it('priceRange handles empty candles', () => {
    expect(priceRange([])).toEqual({ low: 0, high: 1 });
  });

  it('priceRange widens to include markers', () => {
    const r = priceRange([candle(1, 10, 12, 8, 11)], [{ time: 1, price: 100, kind: 'buy' }]);
    expect(r.high).toBeGreaterThan(100);
  });

  it('xForIndex spreads across inner width', () => {
    expect(xForIndex(0, 3, vp)).toBe(0);
    expect(xForIndex(2, 3, vp)).toBe(100);
    expect(xForIndex(0, 1, vp)).toBe(50); // single candle centered
  });

  it('yForPrice inverts (high price → smaller y)', () => {
    const range = { low: 0, high: 100 };
    expect(yForPrice(100, range, vp)).toBe(0);
    expect(yForPrice(0, range, vp)).toBe(100);
    expect(yForPrice(50, range, vp)).toBe(50);
  });

  it('buildCandleRects marks bullish vs bearish + min body height', () => {
    const rects = buildCandleRects(
      [candle(1, 10, 12, 8, 11), candle(2, 11, 12, 9, 10), candle(3, 10, 11, 9, 10)],
      { low: 8, high: 12 },
      vp,
    );
    expect(rects[0].bullish).toBe(true); // close > open
    expect(rects[1].bullish).toBe(false); // close < open
    expect(rects[2].bodyHeight).toBeGreaterThanOrEqual(1); // doji floor
  });

  it('placeMarkers snaps to nearest candle by time', () => {
    const candles = [candle(100, 1, 1, 1, 1), candle(200, 2, 2, 2, 2), candle(300, 3, 3, 3, 3)];
    const placed = placeMarkers([{ time: 190, price: 2, kind: 'buy' }], candles, { low: 0, high: 4 }, vp);
    expect(placed).toHaveLength(1);
    // nearest to t=190 is index 1 (t=200) → x at index 1 of 3 = 50
    expect(placed[0].x).toBe(xForIndex(1, 3, vp));
  });

  it('placeMarkers is empty with no candles', () => {
    expect(placeMarkers([{ time: 1, price: 1, kind: 'info' }], [], { low: 0, high: 1 }, vp)).toEqual([]);
  });
});
