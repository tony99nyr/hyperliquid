import { describe, it, expect } from 'vitest';
import { runCompressionBreakout, summarize, type Bar, type CompressionConfig } from '@/lib/backtest/compression-breakout-business-logic';

const cfg: CompressionConfig = {
  lookback: 4,
  compressionGate: 0.7,
  slippageFrac: 0,
  feeFrac: 0,
  rMultTarget: 2,
  holdBars: 6,
  minRiskFrac: 0,
};

/** Flat bars at price p (no range). */
const flat = (p: number): Bar => ({ openPx: p, highPx: p, lowPx: p, closePx: p });
/** A bar with an explicit OHLC. */
const bar = (o: number, h: number, l: number, c: number): Bar => ({ openPx: o, highPx: h, lowPx: l, closePx: c });

describe('runCompressionBreakout', () => {
  it('no breakout when price stays inside the range → no trades', () => {
    const bars = Array.from({ length: 30 }, () => flat(100));
    expect(runCompressionBreakout(bars, cfg)).toHaveLength(0);
  });

  it('an upward close beyond the range opens a long, target hit pays ~+2R (no friction)', () => {
    // 16 flat bars @100 (fills lookback*2), then a close at 101 (break >100),
    // then a bar that reaches the +2R target. risk = entry−100 = 1 → target 103.
    const bars: Bar[] = [
      ...Array.from({ length: 16 }, () => flat(100)),
      bar(100, 101, 100, 101), // breakout close at 101
      bar(101, 103.5, 101, 103), // target 103 hit
      ...Array.from({ length: 5 }, () => flat(103)),
    ];
    const trades = runCompressionBreakout(bars, cfg);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('long');
    expect(trades[0].exitReason).toBe('target');
    expect(trades[0].rMultiple).toBeCloseTo(2, 1);
  });

  it('a failed break (returns to the boundary) stops out at ~−1R', () => {
    const bars: Bar[] = [
      ...Array.from({ length: 16 }, () => flat(100)),
      bar(100, 101, 100, 101), // break long, entry 101, stop 100
      bar(101, 101, 99.5, 99.8), // low 99.5 ≤ 100 → stop
      ...Array.from({ length: 5 }, () => flat(100)),
    ];
    const trades = runCompressionBreakout(bars, cfg);
    expect(trades[0].exitReason).toBe('stop');
    expect(trades[0].rMultiple).toBeCloseTo(-1, 1);
  });

  it('fees drag the R below the frictionless result', () => {
    const withFee: CompressionConfig = { ...cfg, feeFrac: 0.001 };
    const bars: Bar[] = [
      ...Array.from({ length: 16 }, () => flat(100)),
      bar(100, 101, 100, 101),
      bar(101, 103.5, 101, 103),
      ...Array.from({ length: 5 }, () => flat(103)),
    ];
    const r = runCompressionBreakout(bars, withFee)[0].rMultiple;
    expect(r).toBeLessThan(2); // fees eat into the +2R
  });

  it('summarize computes win rate, expectancy and exit-reason mix', () => {
    const s = summarize([
      { side: 'long', compressed: true, compressionRatio: 0.5, entryPx: 1, exitPx: 1, riskFrac: 0.01, rMultiple: 2, exitReason: 'target', barIndex: 0 },
      { side: 'long', compressed: false, compressionRatio: 1.2, entryPx: 1, exitPx: 1, riskFrac: 0.01, rMultiple: -1, exitReason: 'stop', barIndex: 1 },
    ]);
    expect(s.n).toBe(2);
    expect(s.winRate).toBe(0.5);
    expect(s.expectancyR).toBeCloseTo(0.5);
    expect(s.stopRate).toBe(0.5);
    expect(s.targetRate).toBe(0.5);
  });
});
