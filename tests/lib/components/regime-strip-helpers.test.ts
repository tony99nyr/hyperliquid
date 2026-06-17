import { describe, it, expect } from 'vitest';
import {
  rowFromCandles,
  buildRegimeStrip,
  rsiBand,
  deriveEntryBias,
  REGIME_STRIP_TIMEFRAMES,
  type RegimeStripRow,
} from '@/app/cockpit/components/right-rail/regime-strip-helpers';
import type { CandleResult } from '@/lib/hyperliquid/candle-service';
import type { PriceCandle } from '@/types/trading-core';

function series(n: number, fn: (i: number) => number): PriceCandle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { timestamp: (i + 1) * 60_000, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 };
  });
}

function result(candles: PriceCandle[]): CandleResult {
  return { coin: 'ETH', interval: '1d', candles, fetchedAt: 0, stale: false };
}

describe('rsiBand', () => {
  it('classifies oversold / overbought / neutral / unknown', () => {
    expect(rsiBand(null)).toBe('unknown');
    expect(rsiBand(25)).toBe('oversold');
    expect(rsiBand(75)).toBe('overbought');
    expect(rsiBand(50)).toBe('neutral');
  });
});

describe('rowFromCandles', () => {
  it('marks noData for an empty result', () => {
    const row = rowFromCandles('1h', result([]));
    expect(row.noData).toBe(true);
    expect(row.regime).toBe('neutral');
    expect(row.rsi).toBeNull();
  });

  it('returns a neutral low-confidence read when below the 51-candle floor', () => {
    const row = rowFromCandles('1h', result(series(30, () => 100)));
    expect(row.noData).toBe(false);
    expect(row.confidence).toBe(0);
    expect(row.rsi).toBeNull();
  });

  it('computes a regime + RSI for a long uptrend', () => {
    const row = rowFromCandles('1d', result(series(120, (i) => 100 + i)));
    expect(['bullish', 'neutral', 'bearish']).toContain(row.regime);
    expect(row.rsi).not.toBeNull();
    expect(row.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe('buildRegimeStrip', () => {
  it('builds one row per analysis timeframe', () => {
    const byInterval = { '1d': result(series(60, () => 100)) };
    const rows = buildRegimeStrip(byInterval);
    expect(rows.map((r) => r.timeframe)).toEqual([...REGIME_STRIP_TIMEFRAMES]);
    // Missing timeframes are noData.
    expect(rows.find((r) => r.timeframe === '15m')?.noData).toBe(true);
  });
});

function row(over: Partial<RegimeStripRow> & { timeframe: RegimeStripRow['timeframe'] }): RegimeStripRow {
  return { regime: 'neutral', confidence: 0.5, rsi: 50, noData: false, ...over };
}

describe('deriveEntryBias', () => {
  it('returns neutral with no data', () => {
    const b = deriveEntryBias([row({ timeframe: '1d', noData: true })]);
    expect(b.side).toBe('neutral');
    expect(b.strength).toBe(0);
  });

  it('leans LONG when higher timeframes are bullish', () => {
    const b = deriveEntryBias([
      row({ timeframe: '1d', regime: 'bullish', confidence: 0.8 }),
      row({ timeframe: '8h', regime: 'bullish', confidence: 0.7 }),
      row({ timeframe: '1h', regime: 'neutral', confidence: 0.2 }),
      row({ timeframe: '15m', regime: 'bearish', confidence: 0.4 }),
    ]);
    expect(b.side).toBe('long');
    expect(b.guidance).toMatch(/buy entry/i);
    expect(b.strength).toBeGreaterThan(0);
  });

  it('leans SHORT when higher timeframes are bearish', () => {
    const b = deriveEntryBias([
      row({ timeframe: '1d', regime: 'bearish', confidence: 0.9 }),
      row({ timeframe: '8h', regime: 'bearish', confidence: 0.6 }),
    ]);
    expect(b.side).toBe('short');
    expect(b.guidance).toMatch(/sell entry/i);
  });

  it('reads neutral inside the dead-band (conflicting timeframes cancel)', () => {
    const b = deriveEntryBias([
      row({ timeframe: '1d', regime: 'bullish', confidence: 0.5 }),
      row({ timeframe: '8h', regime: 'bearish', confidence: 0.5 }),
      row({ timeframe: '1h', regime: 'bullish', confidence: 0.5 }),
      row({ timeframe: '15m', regime: 'bearish', confidence: 0.5 }),
    ]);
    expect(b.side).toBe('neutral');
  });

  it('weights the 1d trend above a 15m blip', () => {
    const b = deriveEntryBias([
      row({ timeframe: '1d', regime: 'bullish', confidence: 0.9 }),
      row({ timeframe: '15m', regime: 'bearish', confidence: 0.9 }),
    ]);
    // 1d weight 4 vs 15m weight 1 → net long.
    expect(b.side).toBe('long');
  });
});
