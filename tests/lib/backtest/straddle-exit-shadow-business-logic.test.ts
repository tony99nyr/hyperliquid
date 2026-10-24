import { describe, expect, it } from 'vitest';
import {
  pairedSummary,
  simulateStraddleExit,
  type ShadowCandle,
} from '@/lib/backtest/straddle-exit-shadow-business-logic';

const HOUR = 3_600_000;
const bar = (hour: number, open: number, high: number, low: number, close: number): ShadowCandle => ({
  timestamp: hour * HOUR, open, high, low, close,
});
const base = { side: 'long' as const, gate: 101, stop: 100, printAt: 0, entryAt: 0 };

describe('straddle exit shadow', () => {
  it('fills a gap through the resting stop at the adverse open', () => {
    const result = simulateStraddleExit({ ...base, candles: [bar(0, 101, 101, 100.8, 101), bar(1, 98, 99, 97, 98)] }, 'template');
    expect(result.state).toBe('closed');
    expect(result.stopFill).toBe(98);
    expect(result.r).toBeLessThan(-3);
  });

  it('keeps an open runner and its last stop after expiry', () => {
    const candles = [bar(0, 101, 101, 101, 101), bar(1, 102.5, 102.6, 102.4, 102.5),
      bar(2, 103.5, 103.6, 103.4, 103.5), bar(25, 103.2, 103.3, 103, 103.2),
      bar(26, 103.1, 103.2, 102.9, 103.1)];
    const result = simulateStraddleExit({ ...base, candles }, 'template');
    expect(result.state).toBe('open');
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.restingStop).toBeGreaterThan(100);
    expect(result.expired).toBe(true);
  });

  it('banks 67% after both template reductions, and keeps more without the first bank', () => {
    const candles = [bar(0, 101, 101, 101, 101), bar(1, 103.5, 103.6, 103.4, 103.5),
      bar(2, 103.5, 103.6, 103.4, 103.5)];
    const template = simulateStraddleExit({ ...base, candles }, 'template');
    const noFirst = simulateStraddleExit({ ...base, candles }, 'no-1r');
    expect(template.remaining).toBeCloseTo(0.33);
    expect(noFirst.remaining).toBeCloseTo(0.5);
  });

  it('uses one paired observation per event and a fixed bootstrap', () => {
    const pairs = [{ event: 'a', template: 1, variant: 2 }, { event: 'b', template: -1, variant: -1.5 }];
    const result = pairedSummary(pairs);
    expect(result.n).toBe(2);
    expect(result.meanDifference).toBeCloseTo(0.25);
    expect(result.worstDifference).toBe(-0.5);
    expect(pairedSummary(pairs)).toEqual(result);
  });
});
