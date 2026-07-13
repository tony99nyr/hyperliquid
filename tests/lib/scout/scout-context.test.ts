/**
 * Scout decision-context math — percentile framing, leader-book folding, AF rate.
 * Pure functions, fixture-tested (no mocks) per the repo convention.
 */
import { describe, it, expect } from 'vitest';
import {
  percentileRank,
  summarizeLeaderBook,
  afDailyRate,
  PERCENTILE_MIN_SAMPLES,
} from '@/lib/scout/scout-context-business-logic';

describe('percentileRank', () => {
  const series = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  it('ranks a mid value at ~its position (mid-rank ties)', () => {
    expect(percentileRank(series, 50)).toBeCloseTo(0.495, 3); // 49 below + half of one tie
    expect(percentileRank(series, 100)).toBeCloseTo(0.995, 3);
    expect(percentileRank(series, 0)).toBe(0); // below everything
    expect(percentileRank(series, 101)).toBe(1); // above everything
  });

  it('returns null on a thin series — a percentile from 5 points is a lie', () => {
    expect(percentileRank([1, 2, 3, 4, 5], 3)).toBeNull();
    expect(percentileRank(Array(PERCENTILE_MIN_SAMPLES - 1).fill(1), 1)).toBeNull();
    expect(percentileRank(Array(PERCENTILE_MIN_SAMPLES).fill(1), 1)).not.toBeNull();
  });

  it('returns null for a non-finite current and drops non-finite history points', () => {
    expect(percentileRank(series, NaN)).toBeNull();
    const dirty = [...series, NaN, Infinity, -Infinity];
    expect(percentileRank(dirty, 50)).toBeCloseTo(0.495, 3);
  });

  it('handles an all-ties series (constant funding) at the midpoint', () => {
    expect(percentileRank(Array(50).fill(0.0000125), 0.0000125)).toBeCloseTo(0.5, 6);
  });
});

describe('summarizeLeaderBook', () => {
  it('folds per-coin long/short notional + wallet counts + top wallet', () => {
    const out = summarizeLeaderBook([
      { coin: 'BTC', side: 'short', position_value: 22_000_000 },
      { coin: 'BTC', side: 'short', position_value: '5_190_000'.replace(/_/g, '') },
      { coin: 'BTC', side: 'long', position_value: 1_880_000 },
      { coin: 'HYPE', side: 'long', position_value: 10_470_000 },
    ]);
    const btc = out.find((o) => o.coin === 'BTC')!;
    expect(btc.shortUsd).toBeCloseTo(27_190_000, 0);
    expect(btc.shortWallets).toBe(2);
    expect(btc.longWallets).toBe(1);
    expect(btc.topWalletSide).toBe('short');
    expect(btc.topWalletUsd).toBe(22_000_000);
    const hype = out.find((o) => o.coin === 'HYPE')!;
    expect(hype.longUsd).toBe(10_470_000);
    expect(hype.shortUsd).toBe(0);
  });

  it('drops unknown sides and non-positive/garbage notionals (never miscounts)', () => {
    const out = summarizeLeaderBook([
      { coin: 'ETH', side: 'flat', position_value: 1_000_000 },
      { coin: 'ETH', side: 'long', position_value: null },
      { coin: 'ETH', side: 'long', position_value: 'garbage' },
      { coin: 'ETH', side: 'long', position_value: 0 },
      { coin: 'eth', side: 'long', position_value: 500_000 }, // coin normalized
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ coin: 'ETH', longUsd: 500_000, longWallets: 1, shortWallets: 0 });
  });
});

describe('afDailyRate', () => {
  it('normalizes a 12h delta to a per-24h rate', () => {
    const rate = afDailyRate(
      { atMs: 12 * 3_600_000, balance: 45_792_000 },
      { atMs: 0, balance: 45_780_000 },
    );
    expect(rate).toBeCloseTo(24_000, 0); // 12k over 12h → 24k/day
  });

  it('returns null on a too-short window (< 2h) — annualizing noise is dishonest', () => {
    expect(afDailyRate({ atMs: 3_600_000, balance: 100 }, { atMs: 0, balance: 90 })).toBeNull();
  });

  it('passes through a negative rate (an AF outflow is real information)', () => {
    const rate = afDailyRate({ atMs: 24 * 3_600_000, balance: 90 }, { atMs: 0, balance: 100 });
    expect(rate).toBe(-10);
  });

  it('returns null when either reading is missing or non-finite', () => {
    expect(afDailyRate(null, { atMs: 0, balance: 1 })).toBeNull();
    expect(afDailyRate({ atMs: 24 * 3_600_000, balance: NaN }, { atMs: 0, balance: 1 })).toBeNull();
  });
});
