import { describe, it, expect } from 'vitest';
import { stopHygiene, roundStepsFor } from '@/lib/ladder/ladder-stop-hygiene-business-logic';

describe('roundStepsFor', () => {
  it('scales the round grid to the price magnitude', () => {
    expect(roundStepsFor(66)[0]).toBeCloseTo(0.5, 5);     // ~1% of 66 → 0.5 grid
    expect(roundStepsFor(1600)[0]).toBeCloseTo(10, 5);    // → $10 grid
    expect(roundStepsFor(60000)[0]).toBeCloseTo(500, 5);  // → $500 grid
    expect(roundStepsFor(0)).toEqual([]);
  });
});

describe('stopHygiene — round-number magnets', () => {
  it('flags a stop sitting exactly on a round level', () => {
    const r = stopHygiene({ stopPx: 56.5, side: 'long' }); // on the 0.5 grid
    expect(r.issues.some((i) => i.kind === 'round-number')).toBe(true);
    expect(r.score).toBe(5);
  });
  it('passes a stop placed off the round grid', () => {
    const r = stopHygiene({ stopPx: 56.37, side: 'long' });
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(10);
  });
});

describe('stopHygiene — wick extremes', () => {
  it('flags a long stop AT a recent wick low (a proven stop pool)', () => {
    const r = stopHygiene({ stopPx: 56.62, side: 'long', recentWicks: [56.61] });
    expect(r.issues.some((i) => i.kind === 'wick-extreme')).toBe(true);
    expect(r.score).toBe(3); // worse than a round number — proven liquidity
  });
  it('flags a long stop just INSIDE the wick (a re-test takes it out)', () => {
    const r = stopHygiene({ stopPx: 56.71, side: 'long', recentWicks: [56.61] });
    expect(r.issues.some((i) => i.kind === 'wick-extreme')).toBe(true);
  });
  it('passes a long stop safely BELOW the wick pool', () => {
    const r = stopHygiene({ stopPx: 55.87, side: 'long', recentWicks: [56.61] });
    expect(r.issues.filter((i) => i.kind === 'wick-extreme')).toEqual([]);
  });
  it('short side mirrors: stop at/below a recent high is flagged', () => {
    const r = stopHygiene({ stopPx: 71.93, side: 'short', recentWicks: [71.98] });
    expect(r.issues.some((i) => i.kind === 'wick-extreme')).toBe(true);
  });
  it('degrades cleanly with no wick data (round-number only)', () => {
    const r = stopHygiene({ stopPx: 56.37, side: 'long', recentWicks: null });
    expect(r.score).toBe(10);
  });
});
