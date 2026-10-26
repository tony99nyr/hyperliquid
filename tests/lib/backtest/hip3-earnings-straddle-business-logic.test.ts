import { describe, expect, it } from 'vitest';
import {
  FROZEN_CONFIG_1H, replayStraddleEvent, summarise, type EventResult, type StudyCandle,
} from '@/lib/backtest/hip3-earnings-straddle-business-logic';

const H = 3_600_000;
const PRINT = 100 * H;

/** Flat series at `px` from hour 90 to 130, then overrides by hour index. */
function series(px: number, overrides: Record<number, Partial<StudyCandle>> = {}): StudyCandle[] {
  const out: StudyCandle[] = [];
  for (let h = 90; h <= 130; h++) {
    const base = { timestamp: h * H, open: px, high: px, low: px, close: px };
    out.push({ ...base, ...overrides[h] });
  }
  return out;
}

describe('replayStraddleEvent', () => {
  it('returns no-fill (0R) when price stays inside the gates', () => {
    const result = replayStraddleEvent(series(100), PRINT, FROZEN_CONFIG_1H);
    expect(result).toMatchObject({ state: 'no-fill', r: 0 });
  });

  it('is ineligible with thin coverage', () => {
    const result = replayStraddleEvent(series(100).filter((_, i) => i % 2 === 0), PRINT, FROZEN_CONFIG_1H);
    expect(result.state).toBe('ineligible');
  });

  it('is ineligible without a pre-print candle', () => {
    const result = replayStraddleEvent(series(100).filter((c) => c.timestamp >= PRINT), PRINT, FROZEN_CONFIG_1H);
    expect(result.state).toBe('ineligible');
  });

  it('stops out a long that fades back to the reference', () => {
    const candles = series(100, {
      100: { open: 100, high: 101.6, low: 100, close: 101.5 },
      101: { open: 101.5, high: 101.5, low: 99.9, close: 100 },
    });
    const result = replayStraddleEvent(candles, PRINT, FROZEN_CONFIG_1H);
    expect(result.state).toBe('filled');
    expect(result.side).toBe('long');
    expect(result.exitReason).toBe('stop');
    // Entry 101.5, stop 100, distance 1: loss 1.5R plus fees (~0.18R).
    expect(result.r).toBeCloseTo(-1.5 - (101.5 + 100) * 0.0009, 2);
    expect(result.overshootR).toBeCloseTo(0.5, 6);
  });

  it('fills a short symmetric to the long and gaps through the stop at the open', () => {
    const candles = series(100, {
      100: { open: 100, high: 100, low: 98.4, close: 98.5 },
      101: { open: 101, high: 101.2, low: 100.8, close: 101 },
    });
    const result = replayStraddleEvent(candles, PRINT, FROZEN_CONFIG_1H);
    expect(result.side).toBe('short');
    expect(result.exitReason).toBe('stop');
    // Stop 100, gap open 101: exit at 101, loss (101-98.5)/1 = 2.5R.
    expect(result.r).toBeLessThan(-2.5);
  });

  it('closes a trending winner at the time exit with a positive R', () => {
    const overrides: Record<number, Partial<StudyCandle>> = {
      100: { open: 100, high: 101.1, low: 100, close: 101.05 },
    };
    for (let h = 101; h <= 130; h++) {
      overrides[h] = { open: 103, high: 103.2, low: 102.9, close: 103 };
    }
    const result = replayStraddleEvent(series(100, overrides), PRINT, FROZEN_CONFIG_1H);
    expect(result.exitReason).toBe('time');
    expect(result.r).toBeGreaterThan(1);
  });

  it('ignores a candle that closes through both gates', () => {
    const wide = replayStraddleEvent(series(100, { 100: { open: 100, high: 105, low: 95, close: 100 } }), PRINT,
      { ...FROZEN_CONFIG_1H, gatePct: 0.01 });
    expect(wide.state).toBe('no-fill');
  });
});

describe('summarise', () => {
  const filled = (r: number): EventResult => ({ state: 'filled', r });
  it('is INSUFFICIENT below 30 events', () => {
    expect(summarise(Array.from({ length: 29 }, () => filled(1))).verdict).toBe('INSUFFICIENT');
  });
  it('fails when the mean depends on the top three', () => {
    const results = [filled(30), filled(30), filled(30), ...Array.from({ length: 27 }, () => filled(-0.1))];
    const summary = summarise(results);
    expect(summary.checks.mean).toBe(true);
    expect(summary.checks.exTop3).toBe(false);
    expect(summary.verdict).toBe('FAIL');
  });
  it('passes a broad edge and counts no-fills as 0R', () => {
    const results: EventResult[] = [
      ...Array.from({ length: 30 }, () => filled(0.5)),
      { state: 'no-fill', r: 0 }, { state: 'ineligible', r: null },
    ];
    const summary = summarise(results);
    expect(summary.n).toBe(31);
    expect(summary.noFill).toBe(1);
    expect(summary.verdict).toBe('PASS');
  });
});
