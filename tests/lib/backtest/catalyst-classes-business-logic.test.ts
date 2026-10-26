import { describe, it, expect } from 'vitest';
import {
  closeMapOf, movesFor, quantile, continues, statsOf, verdictOf, seededRng, controlTimes, type EventMoves,
} from '@/lib/backtest/catalyst-classes-business-logic';
import { overshootOf, summariseOvershoot, buildVerdict } from '@/lib/backtest/entry-overshoot-business-logic';

const M15 = 15 * 60_000;
const T = Date.UTC(2026, 9, 14, 12, 30);

function series(fn: (closeMs: number) => number, fromMs: number, toMs: number, step: number) {
  const out = [];
  for (let open = fromMs; open < toMs; open += step) out.push({ timestamp: open, close: fn(open + step) });
  return out;
}

describe('movesFor', () => {
  it('uses the 15m close at T-30 as reference and exact horizons', () => {
    const map = closeMapOf(series((c) => (c === T - 30 * 60_000 ? 100 : c === T + 2 * 3_600_000 ? 103 : c === T + 24 * 3_600_000 ? 94 : 100), T - 3_600_000, T + 25 * 3_600_000, M15), M15);
    const m = movesFor(T, M15, map);
    expect(m?.h2).toBeCloseTo(0.03);
    expect(m?.h24).toBeCloseTo(-0.06);
    expect(m?.m15).toBeCloseTo(0);
    expect(m?.elapsedH2Min).toBe(150);
  });
  it('snaps to the 1h grid: floor for the reference, ceil for outcomes', () => {
    const at = Date.UTC(2026, 9, 28, 18, 0); // 17:30 -> ref 17:00
    const H = 3_600_000;
    const map = closeMapOf(series((c) => (c === at - H ? 100 : c === at + 2 * H ? 101 : 99), at - 2 * H, at + 26 * H, H), H);
    expect(movesFor(at, H, map)?.h2).toBeCloseTo(0.01);
  });
  it('returns null when T+24h is not in the data', () => {
    const map = closeMapOf(series(() => 100, T - 3_600_000, T + 3 * 3_600_000, M15), M15);
    expect(movesFor(T, M15, map)).toBeNull();
  });
});

describe('stats and verdict', () => {
  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.8)).toBeCloseTo(4.2);
  });
  it('continuation needs same sign and at least equal size', () => {
    expect(continues(0.01, 0.02)).toBe(true);
    expect(continues(0.01, 0.005)).toBe(false);
    expect(continues(0.01, -0.02)).toBe(false);
    expect(continues(0, 0.02)).toBe(false);
  });
  const mk = (h2: number, h24: number): EventMoves => ({ atMs: 0, m15: null, h2, h24, elapsedH2Min: 150 });
  it('is INSUFFICIENT below n=15, JOIN above both bars, REJECT otherwise', () => {
    expect(verdictOf(statsOf(Array.from({ length: 14 }, () => mk(0.02, 0.03))))).toBe('INSUFFICIENT');
    expect(verdictOf(statsOf(Array.from({ length: 15 }, () => mk(0.02, 0.03))))).toBe('JOIN');
    expect(verdictOf(statsOf(Array.from({ length: 15 }, () => mk(0.02, 0.01))))).toBe('REJECT');
    expect(verdictOf(statsOf(Array.from({ length: 15 }, () => mk(0.01, 0.03))))).toBe('REJECT');
  });
});

describe('controlTimes', () => {
  it('keeps weekday and time of day, avoids events, is seeded', () => {
    const start = T - 60 * 86_400_000;
    const end = T + 5 * 86_400_000;
    const a = controlTimes(T, start, end, [T], seededRng(1));
    const b = controlTimes(T, start, end, [T], seededRng(1));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(5);
    for (const t of a) {
      expect(new Date(t).getUTCDay()).toBe(new Date(T).getUTCDay());
      expect(t % 86_400_000).toBe(T % 86_400_000);
      expect(Math.abs(t - T)).toBeGreaterThanOrEqual(86_400_000);
    }
  });
});

describe('overshoot', () => {
  it('long fill above trigger is adverse; short fill below is adverse', () => {
    expect(overshootOf({ side: 'long', triggerPx: 100, fillPx: 100.5, stopPx: 99, stopFrac: null })).toEqual({ bps: 50, r: 0.5 });
    const s = overshootOf({ side: 'short', triggerPx: 100, fillPx: 99.5, stopPx: null, stopFrac: 0.01 });
    expect(s?.bps).toBeCloseTo(50);
    expect(s?.r).toBeCloseTo(0.5);
  });
  it('keeps price improvement negative and rejects a missing stop', () => {
    expect(overshootOf({ side: 'long', triggerPx: 100, fillPx: 99.8, stopPx: 99, stopFrac: null })?.r).toBeCloseTo(-0.2);
    expect(overshootOf({ side: 'long', triggerPx: 100, fillPx: 100, stopPx: null, stopFrac: null })).toBeNull();
  });
  it('verdict follows the 5-leg floor and the 0.2R bar', () => {
    const rows = (r: number, n: number) => Array.from({ length: n }, () => ({ bps: r * 100, r }));
    expect(buildVerdict(summariseOvershoot(rows(0.5, 4)))).toBe('INSUFFICIENT');
    expect(buildVerdict(summariseOvershoot(rows(0.5, 5)))).toBe('BUILD');
    expect(buildVerdict(summariseOvershoot(rows(0.2, 5)))).toBe('DO-NOT-BUILD');
  });
});
