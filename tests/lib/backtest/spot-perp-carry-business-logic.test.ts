import { describe, expect, it } from 'vitest';
import {
  basketEquity, carryVerdict, marginForRally, PREREGISTERED_PARAMS, replaySpotPerpCarry, summariseCarry,
  type CarryCandle, type FundingRow,
} from '@/lib/backtest/spot-perp-carry-business-logic';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const candles = (n: number, price: (i: number) => number): CarryCandle[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * H, open: price(i), high: price(i) * 1.01, low: price(i), close: price(i) }));
const fund = (n: number, rate: (i: number) => number): FundingRow[] =>
  Array.from({ length: n }, (_, i) => ({ time: T0 + i * H, fundingHourly: rate(i) }));

describe('replaySpotPerpCarry', () => {
  it('earns funding minus fees on a flat price, with no look-ahead entry', () => {
    const n = 200;
    const run = replaySpotPerpCarry(fund(n, () => 0.0001), candles(n, () => 100), candles(n, () => 100));
    expect(run.trades).toHaveLength(1);
    // first full window ends at row 23, decision there, fill at row 24
    expect(run.trades[0].entryTime).toBe(T0 + 24 * H);
    const hours = n - 24;
    const gross = 0.0001 * hours;
    const fees = 0.0007 + 0.00045 + 0.0007 + 0.00045; // entry + hypothetical exit
    expect(run.equity.at(-1)).toBeCloseTo((gross - fees) / (4 / 3), 6);
  });

  it('exits on a flip, re-enters later, and counts two round trips', () => {
    const n = 400;
    const rate = (i: number) => (i < 100 ? 0.0001 : i < 200 ? -0.0002 : 0.0001);
    const run = replaySpotPerpCarry(fund(n, rate), candles(n, () => 100), candles(n, () => 100));
    expect(run.trades.length).toBe(2);
    expect(run.trades[0].exitTime).not.toBeNull();
    expect(run.trades[1].entryTime).toBeGreaterThan(run.trades[0].exitTime as number);
  });

  it('stays flat when funding is below the entry threshold', () => {
    const n = 100;
    const run = replaySpotPerpCarry(fund(n, () => 0.000005), candles(n, () => 100), candles(n, () => 100));
    expect(run.trades).toHaveLength(0);
    expect(run.equity.every((e) => e === 0)).toBe(true);
  });

  it('captures basis: spot rises 1 while perp is flat', () => {
    const n = 60;
    const spot = candles(n, (i) => (i < 40 ? 100 : 101));
    const run = replaySpotPerpCarry(fund(n, () => 0), spot, candles(n, () => 100), { ...PREREGISTERED_PARAMS, useSignal: false });
    // forced entry at row 24 (first window), spot +1% basis gain
    expect(run.trades[0].basisPnl).toBeCloseTo(0.01, 6);
  });

  it('tracks the max rally while held', () => {
    const n = 100;
    const perp = candles(n, (i) => (i < 60 ? 100 : 130));
    const run = replaySpotPerpCarry(fund(n, () => 0.0001), candles(n, () => 100), perp);
    expect(run.trades[0].maxRally).toBeGreaterThan(0.3);
  });

  it('defers entry when a leg has no candle', () => {
    const n = 100;
    const spot = candles(n, () => 100).filter((c) => c.timestamp !== T0 + 24 * H);
    const run = replaySpotPerpCarry(fund(n, () => 0.0001), spot, candles(n, () => 100));
    expect(run.deferredEntries).toBeGreaterThan(0);
    expect(run.trades[0].entryTime).toBe(T0 + 25 * H);
  });
});

describe('replaySpotPerpCarry on 4h candles', () => {
  it('fills only at a 4h candle open and does not look ahead', () => {
    const step = 4 * H;
    const n = 200;
    const mk = (): CarryCandle[] => Array.from({ length: n / 4 }, (_, i) => ({
      timestamp: T0 + i * step, open: 100, high: 101, low: 99, close: 100 }));
    const run = replaySpotPerpCarry(fund(n, () => 0.0001), mk(), mk(), { ...PREREGISTERED_PARAMS, stepMs: step });
    expect(run.trades[0].entryTime % step).toBe(0);
    // decision at row 23 (T0+23h); first open at or after T0+24h is T0+24h
    expect(run.trades[0].entryTime).toBe(T0 + 24 * H);
    expect(run.equity.at(-1)).toBeGreaterThan(0);
  });
});

describe('marginForRally', () => {
  it('3x short after a 30% rally needs a top-up and liquidates near 28%', () => {
    const m = marginForRally(0.3, 3, 0.0125);
    expect(m.equityLeft).toBeCloseTo(1 / 3 - 0.3, 9);
    expect(m.topUpToLeverage).toBeCloseTo(1.3 / 3 - (1 / 3 - 0.3), 9);
    expect(m.topUpToMaintenance).toBe(0);
    expect(marginForRally(0.3, 3, 0.05).topUpToMaintenance).toBeCloseTo(1.3 * 0.05 - (1 / 3 - 0.3), 9);
    expect(m.liquidationRally).toBeCloseTo((1 / 3 - 0.0125) / 1.0125, 9);
  });
});

describe('summariseCarry and verdict', () => {
  const hoursOf = (days: number, start: number) => Array.from({ length: days * 24 }, (_, i) => start + i * H);
  it('computes APR, year counts and worst 30d, then passes a steady curve over 4 years', () => {
    const times = hoursOf(4 * 365, Date.UTC(2022, 0, 1));
    const equity = times.map((_, i) => (0.08 * i) / 8760);
    const m = summariseCarry(times, equity, times.length / 2, 3);
    expect(m.netApr).toBeCloseTo(0.08, 3);
    expect(m.yearsWithData).toBe(4);
    expect(m.yearsPositive).toBe(4);
    expect(m.worst30d).toBeGreaterThan(0);
    expect(m.timeInMarket).toBeCloseTo(0.5, 6);
    expect(carryVerdict(m).verdict).toBe('PASS');
  });
  it('FAILs on a low APR and returns INSUFFICIENT for a short good series', () => {
    const t1 = hoursOf(4 * 365, Date.UTC(2022, 0, 1));
    expect(carryVerdict(summariseCarry(t1, t1.map((_, i) => (0.03 * i) / 8760))).verdict).toBe('FAIL');
    const t2 = hoursOf(300, Date.UTC(2025, 0, 1));
    const v = carryVerdict(summariseCarry(t2, t2.map((_, i) => (0.1 * i) / 8760)));
    expect(v.verdict).toBe('INSUFFICIENT');
  });
  it('FAILs when the worst 30-day window is below -1%', () => {
    const times = hoursOf(4 * 365, Date.UTC(2022, 0, 1));
    const equity = times.map((_, i) => (i > 5000 && i < 6000 ? 0.2 - (i - 5000) * 0.00005 : (0.3 * i) / 8760));
    expect(carryVerdict(summariseCarry(times, equity)).verdict).toBe('FAIL');
  });
});

describe('basketEquity', () => {
  it('averages increments of the coins live each hour', () => {
    const a = { times: [0, H, 2 * H], equity: [0.1, 0.2, 0.3] };
    const b = { times: [H, 2 * H], equity: [0.3, 0.5] };
    const out = basketEquity([a, b]);
    expect(out.times).toEqual([0, H, 2 * H]);
    expect(out.equity[0]).toBeCloseTo(0.1, 9);
    expect(out.equity[1]).toBeCloseTo(0.1 + (0.1 + 0.3) / 2, 9);
    expect(out.equity[2]).toBeCloseTo(0.1 + 0.2 + (0.1 + 0.2) / 2, 9);
  });
});
