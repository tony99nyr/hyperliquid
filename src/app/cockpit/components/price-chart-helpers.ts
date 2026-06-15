/**
 * PURE geometry helpers for the self-contained PriceChart. Given candles + a
 * viewport, compute the y-range, the candlestick rectangles, and marker
 * positions. No I/O, no React — fixture-testable, and the chart component is a
 * thin SVG renderer over these.
 */

import type { PriceCandle } from '@/types/trading-core';

export interface ChartMarker {
  /** Epoch ms — snapped to the nearest candle for x positioning. */
  time: number;
  price: number;
  /** Visual intent (buy = up green, sell = down red, info = neutral). */
  kind: 'buy' | 'sell' | 'info';
  label?: string;
}

export interface ChartViewport {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

export interface PriceRange {
  low: number;
  high: number;
}

/** Min low / max high across candles, padded 6%. Empty ⇒ {0,1}. */
export function priceRange(candles: PriceCandle[], markers: ChartMarker[] = []): PriceRange {
  if (candles.length === 0) return { low: 0, high: 1 };
  let low = Infinity;
  let high = -Infinity;
  for (const c of candles) {
    if (c.low < low) low = c.low;
    if (c.high > high) high = c.high;
  }
  for (const m of markers) {
    if (m.price < low) low = m.price;
    if (m.price > high) high = m.price;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1 };
  const pad = (high - low) * 0.06 || Math.abs(high) * 0.06 || 1;
  return { low: low - pad, high: high + pad };
}

/** X pixel for a candle index (evenly spaced across the inner width). */
export function xForIndex(index: number, count: number, vp: ChartViewport): number {
  const innerW = vp.width - vp.padding.left - vp.padding.right;
  if (count <= 1) return vp.padding.left + innerW / 2;
  return vp.padding.left + (index / (count - 1)) * innerW;
}

/** Y pixel for a price within a range (top = high). */
export function yForPrice(price: number, range: PriceRange, vp: ChartViewport): number {
  const innerH = vp.height - vp.padding.top - vp.padding.bottom;
  const span = range.high - range.low || 1;
  const ratio = (price - range.low) / span;
  return vp.padding.top + innerH - ratio * innerH;
}

export interface CandleRect {
  x: number;
  /** Wick top/bottom y. */
  wickTop: number;
  wickBottom: number;
  /** Body top y + height (>= 1px). */
  bodyTop: number;
  bodyHeight: number;
  width: number;
  bullish: boolean;
}

/** Build candlestick geometry for all candles. PURE. */
export function buildCandleRects(
  candles: PriceCandle[],
  range: PriceRange,
  vp: ChartViewport,
): CandleRect[] {
  const innerW = vp.width - vp.padding.left - vp.padding.right;
  const slotW = candles.length > 0 ? innerW / candles.length : innerW;
  const bodyW = Math.max(1, slotW * 0.6);
  return candles.map((c, i) => {
    const x = xForIndex(i, candles.length, vp);
    const bullish = c.close >= c.open;
    const yOpen = yForPrice(c.open, range, vp);
    const yClose = yForPrice(c.close, range, vp);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
    return {
      x,
      wickTop: yForPrice(c.high, range, vp),
      wickBottom: yForPrice(c.low, range, vp),
      bodyTop,
      bodyHeight,
      width: bodyW,
      bullish,
    };
  });
}

export interface PlacedMarker extends ChartMarker {
  x: number;
  y: number;
}

/** Snap each marker to the nearest candle by time and place it. PURE. */
export function placeMarkers(
  markers: ChartMarker[],
  candles: PriceCandle[],
  range: PriceRange,
  vp: ChartViewport,
): PlacedMarker[] {
  if (candles.length === 0) return [];
  return markers.map((m) => {
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const d = Math.abs(candles[i].timestamp - m.time);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    return {
      ...m,
      x: xForIndex(nearest, candles.length, vp),
      y: yForPrice(m.price, range, vp),
    };
  });
}
