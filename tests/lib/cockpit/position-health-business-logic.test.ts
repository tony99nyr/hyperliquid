import { describe, it, expect } from 'vitest';
import {
  computePositionHealth,
  markFromPosition,
  pickChartWindow,
} from '@/lib/cockpit/position-health-business-logic';

describe('computePositionHealth', () => {
  it('healthy when far from liquidation (>15%)', () => {
    const h = computePositionHealth({ markPx: 100, liquidationPx: 70 });
    expect(h.status).toBe('healthy');
    expect(h.liqDistancePct).toBeCloseTo(30);
  });
  it('caution between 5% and 15%', () => {
    expect(computePositionHealth({ markPx: 100, liquidationPx: 90 }).status).toBe('caution');
  });
  it('critical within 5%', () => {
    expect(computePositionHealth({ markPx: 100, liquidationPx: 97 }).status).toBe('critical');
  });
  it('unknown when liq or mark missing/invalid', () => {
    expect(computePositionHealth({ markPx: 100, liquidationPx: null }).status).toBe('unknown');
    expect(computePositionHealth({ markPx: 0, liquidationPx: 90 }).liqDistancePct).toBeNull();
  });
});

describe('markFromPosition', () => {
  it('derives mark = |value| / size', () => {
    expect(markFromPosition(2000, 0.5)).toBe(4000);
  });
  it('null on zero/invalid size', () => {
    expect(markFromPosition(2000, 0)).toBeNull();
  });
});

describe('pickChartWindow', () => {
  const now = 1_000 * 24 * 60 * 60 * 1000; // arbitrary fixed now
  const DAY = 24 * 60 * 60 * 1000;
  it('fine interval for a fresh (intraday) position', () => {
    expect(pickChartWindow(now - 2 * 60 * 60 * 1000, now).interval).toBe('15m');
  });
  it('coarsens with age', () => {
    expect(pickChartWindow(now - 3 * DAY, now).interval).toBe('1h');
    expect(pickChartWindow(now - 10 * DAY, now).interval).toBe('4h');
    expect(pickChartWindow(now - 60 * DAY, now).interval).toBe('1d');
  });
  it('falls back to a 7d/1h window when open time is unknown', () => {
    const w = pickChartWindow(null, now);
    expect(w.interval).toBe('1h');
    expect(w.lookbackMs).toBe(7 * DAY);
  });
  it('window always covers the position age (entry bar inside)', () => {
    const age = 10 * DAY;
    expect(pickChartWindow(now - age, now).lookbackMs).toBeGreaterThan(age);
  });
});
