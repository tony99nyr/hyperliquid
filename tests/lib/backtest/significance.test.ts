import { describe, it, expect } from 'vitest';
import {
  mean,
  stdDev,
  tStat,
  mulberry32,
  percentile,
  blockBootstrapTotal,
  sharpe,
} from '@/lib/backtest/significance-business-logic';

describe('significance — basic stats', () => {
  it('mean + sample stdDev (n−1)', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdDev([2, 4, 6], true)).toBeCloseTo(2); // var = (4+0+4)/2 = 4
    expect(stdDev([5], true)).toBe(0); // n<2 guard
  });

  it('t-stat vs H0 mean=0', () => {
    const r = tStat([1, 2, 3, 4, 5]); // mean 3, sd ~1.5811, se ~0.7071
    expect(r.n).toBe(5);
    expect(r.mean).toBe(3);
    expect(r.t).toBeCloseTo(4.243, 2);
  });

  it('a zero-centered series has t≈0', () => {
    expect(Math.abs(tStat([-2, -1, 0, 1, 2]).t)).toBeLessThan(1e-9);
  });
});

describe('significance — percentile', () => {
  const s = [10, 20, 30, 40, 50];
  it('endpoints + median + interpolation', () => {
    expect(percentile(s, 0)).toBe(10);
    expect(percentile(s, 1)).toBe(50);
    expect(percentile(s, 0.5)).toBe(30);
    expect(percentile(s, 0.25)).toBe(20);
  });
});

describe('significance — mulberry32 determinism', () => {
  it('same seed → identical stream', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    seqA.forEach((x) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    });
  });
});

describe('significance — block bootstrap', () => {
  it('a clearly-positive block set → CI well above 0 and p≈0', () => {
    const blocks = [200, 350, 410, 250, 300, 390, 210, 280]; // all positive, like trending windows
    const r = blockBootstrapTotal(blocks, 5000, mulberry32(1));
    expect(r.ciLow).toBeGreaterThan(0);
    expect(r.pLessEqualZero).toBeLessThan(0.01);
    expect(r.meanTotal).toBeGreaterThan(0);
  });

  it('a noisy mixed block set spanning zero → high p, CI straddles 0', () => {
    const blocks = [400, -350, 410, -380, 120, -90, 30, -40]; // lumpy, near net-zero
    const r = blockBootstrapTotal(blocks, 5000, mulberry32(7));
    expect(r.ciLow).toBeLessThan(0);
    expect(r.ciHigh).toBeGreaterThan(0);
    expect(r.pLessEqualZero).toBeGreaterThan(0.1); // NOT distinguishable from zero
  });

  it('is reproducible across runs with the same seed', () => {
    const blocks = [100, -50, 75, 20];
    const r1 = blockBootstrapTotal(blocks, 2000, mulberry32(99));
    const r2 = blockBootstrapTotal(blocks, 2000, mulberry32(99));
    expect(r1).toEqual(r2);
  });
});

describe('significance — sharpe', () => {
  it('mean/sd, zero on flat series', () => {
    expect(sharpe([0.1, 0.1, 0.1])).toBe(0); // sd 0
    expect(sharpe([2, 4, 6])).toBeCloseTo(4 / 2, 5);
  });
});
