import { describe, it, expect } from 'vitest';
import { computeAddSize, previewAdd } from '@/lib/trading/add-to-position-business-logic';

describe('computeAddSize', () => {
  it('pct = % of current size', () => {
    expect(computeAddSize(4, 'pct', 50, 100)).toBe(2);
    expect(computeAddSize(4, 'pct', 100, 100)).toBe(4);
  });
  it('usd = notional ÷ mark', () => {
    expect(computeAddSize(4, 'usd', 200, 100)).toBe(2); // $200 / $100 = 2 coins
  });
  it('0 on bad inputs', () => {
    expect(computeAddSize(0, 'pct', 50, 100)).toBe(0);
    expect(computeAddSize(4, 'pct', -5, 100)).toBe(0);
  });
});

describe('previewAdd', () => {
  it('blends the new size + average entry; computes new liq', () => {
    // Long 2 @ 100, add 50% (1 coin) at mark 110, 5x.
    const p = previewAdd({ side: 'long', currentSz: 2, currentEntryPx: 100, markPx: 110, leverage: 5, mode: 'pct', value: 50 });
    expect(p.addSz).toBe(1);
    expect(p.newSz).toBe(3);
    // avg = (2*100 + 1*110)/3 = 103.33
    expect(p.newAvgEntryPx).toBeCloseTo(103.333, 2);
    expect(p.addNotionalUsd).toBeCloseTo(110, 2);
    expect(p.addMarginUsd).toBeCloseTo(22, 2); // 110/5
    expect(p.newLiqPx).not.toBeNull();
    expect(p.warnings).toEqual([]);
  });

  it('flags averaging DOWN for a long when mark < entry', () => {
    const down = previewAdd({ side: 'long', currentSz: 2, currentEntryPx: 100, markPx: 90, leverage: 5, mode: 'pct', value: 50 });
    expect(down.isAveragingDown).toBe(true);
    const up = previewAdd({ side: 'long', currentSz: 2, currentEntryPx: 100, markPx: 110, leverage: 5, mode: 'pct', value: 50 });
    expect(up.isAveragingDown).toBe(false);
  });

  it('flags averaging DOWN for a short when mark > entry', () => {
    const down = previewAdd({ side: 'short', currentSz: 2, currentEntryPx: 100, markPx: 110, leverage: 5, mode: 'pct', value: 50 });
    expect(down.isAveragingDown).toBe(true);
  });

  it('warns when the add exceeds the cap', () => {
    const p = previewAdd({ side: 'long', currentSz: 2, currentEntryPx: 100, markPx: 100, leverage: 5, mode: 'pct', value: 600, maxAddMultiple: 5 });
    expect(p.warnings.some((w) => /exceeds/i.test(w))).toBe(true);
  });

  it('$-at-risk grows with the larger position', () => {
    const p = previewAdd({ side: 'long', currentSz: 2, currentEntryPx: 100, markPx: 100, leverage: 5, mode: 'pct', value: 100 });
    // new notional = 4*100 = 400; risk ≈ 400/5 = 80 (vs 40 before).
    expect(p.riskAtLiqUsd).toBeCloseTo(80, 1);
  });
});
