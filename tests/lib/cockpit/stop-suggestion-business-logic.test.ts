import { describe, it, expect } from 'vitest';
import {
  suggestStopFrac,
  latestAtr,
  liquidationCushion,
  stopPxFromFrac,
  validateStopPx,
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

describe('stopPxFromFrac', () => {
  it('puts a long stop BELOW and a short stop ABOVE the reference', () => {
    expect(stopPxFromFrac('long', 2000, 0.05)).toBeCloseTo(1900, 6);
    expect(stopPxFromFrac('short', 2000, 0.05)).toBeCloseTo(2100, 6);
  });
  it('returns null on bad inputs', () => {
    expect(stopPxFromFrac('long', null, 0.05)).toBeNull();
    expect(stopPxFromFrac('long', 2000, 0)).toBeNull();
    expect(stopPxFromFrac('long', 2000, null)).toBeNull();
  });
});

describe('validateStopPx (mirrors the server place guards)', () => {
  it('accepts a stop on the protective side within bounds + reports the frac', () => {
    const long = validateStopPx('long', 2000, 1900); // 5% below ✓
    expect(long.ok).toBe(true);
    expect(long.frac).toBeCloseTo(0.05, 6);
    expect(validateStopPx('short', 2000, 2100).ok).toBe(true); // 5% above ✓
  });
  it('rejects the WRONG side (long stop above / short stop below the mark)', () => {
    expect(validateStopPx('long', 2000, 2100).ok).toBe(false); // long stop above mark
    expect(validateStopPx('short', 2000, 1900).ok).toBe(false); // short stop below mark
  });
  it('rejects too-tight (< MIN) and too-far (> MAX) stops', () => {
    expect(validateStopPx('long', 2000, 2000 * (1 - MIN_STOP_FRAC / 2)).ok).toBe(false); // inside the floor
    expect(validateStopPx('long', 2000, 2000 * (1 - (MAX_STOP_FRAC + 0.1))).ok).toBe(false); // beyond the ceiling
  });
  it('accepts the exact MIN and MAX boundaries (inclusive, matches the server)', () => {
    // ref 2000 → MIN 0.5% = stop 1990 (10/2000); MAX 50% = stop 1000 (1000/2000).
    expect(MIN_STOP_FRAC).toBe(0.005);
    expect(MAX_STOP_FRAC).toBe(0.5);
    expect(validateStopPx('long', 2000, 1990).ok).toBe(true); // exactly at the floor
    expect(validateStopPx('long', 2000, 1000).ok).toBe(true); // exactly at the ceiling
  });
  it('rejects missing mark / stop with a reason', () => {
    expect(validateStopPx('long', null, 1900).ok).toBe(false);
    expect(validateStopPx('long', 2000, null).reason).toMatch(/enter a stop/i);
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
