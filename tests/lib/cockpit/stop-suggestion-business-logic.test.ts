import { describe, it, expect } from 'vitest';
import {
  suggestStopFrac,
  latestAtr,
  liquidationCushion,
  HOLD_TIMEFRAMES,
  MIN_STOP_FRAC,
  MAX_STOP_FRAC,
} from '@/lib/cockpit/stop-suggestion-business-logic';
import type { PriceCandle } from '@/types/trading-core';

/** Build N candles with a constant true-range so ATR is predictable. */
function candles(n: number, close: number, range: number): PriceCandle[] {
  const out: PriceCandle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ timestamp: i * 60_000, open: close, high: close + range / 2, low: close - range / 2, close, volume: 1 });
  }
  return out;
}

describe('latestAtr', () => {
  it('returns null when candles are too thin', () => {
    expect(latestAtr(candles(5, 100, 2), 14)).toBeNull();
    expect(latestAtr(null, 14)).toBeNull();
  });
  it('returns a positive ATR for a steady-range series', () => {
    const atr = latestAtr(candles(60, 100, 2), 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);
  });
});

describe('suggestStopFrac', () => {
  it('returns null (no data) when candles are too thin — caller keeps current stop', () => {
    expect(suggestStopFrac(candles(3, 100, 2), 2.5)).toBeNull();
    expect(suggestStopFrac([], 2.5)).toBeNull();
  });
  it('scales with the ATR multiple', () => {
    const tight = suggestStopFrac(candles(60, 100, 2), 1.5)!;
    const wide = suggestStopFrac(candles(60, 100, 2), 3.5)!;
    expect(wide).toBeGreaterThan(tight); // longer-hold multiple → wider stop
  });
  it('clamps to the server-mirrored floor and the ceiling', () => {
    // Near-zero range → would be below the floor → clamped up.
    expect(suggestStopFrac(candles(60, 100, 0.0001), 2.5)!).toBe(MIN_STOP_FRAC);
    // Huge range → clamped to the ceiling.
    expect(suggestStopFrac(candles(60, 100, 400), 3.5)!).toBe(MAX_STOP_FRAC);
  });
});

describe('liquidationCushion', () => {
  it('is liq-distance ÷ stop-distance', () => {
    // entry 2000, stop 1900 (100 away), liq 1800 (200 away) → 2.0× cushion.
    expect(liquidationCushion(2000, 1900, 1800)).toBeCloseTo(2.0, 6);
  });
  it('returns null on missing inputs or a zero stop distance', () => {
    expect(liquidationCushion(2000, 2000, 1800)).toBeNull(); // stop == entry
    expect(liquidationCushion(null, 1900, 1800)).toBeNull();
  });
});

describe('HOLD_TIMEFRAMES', () => {
  it('longer holds use wider ATR multiples and lower leverage ceilings', () => {
    expect(HOLD_TIMEFRAMES.position.atrMult).toBeGreaterThan(HOLD_TIMEFRAMES.swing.atrMult);
    expect(HOLD_TIMEFRAMES.swing.atrMult).toBeGreaterThan(HOLD_TIMEFRAMES.scalp.atrMult);
    expect(HOLD_TIMEFRAMES.position.maxLeverage).toBeLessThan(HOLD_TIMEFRAMES.scalp.maxLeverage);
  });
  it('MIN/MAX stop fracs are sane', () => {
    expect(MIN_STOP_FRAC).toBeGreaterThan(0);
    expect(MAX_STOP_FRAC).toBeLessThanOrEqual(0.5);
  });
});
