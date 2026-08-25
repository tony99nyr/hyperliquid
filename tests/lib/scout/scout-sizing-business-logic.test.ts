import { describe, it, expect } from 'vitest';
import { volNormalizedRiskUsd, DEFAULT_SCOUT_SIZING } from '@/lib/scout/scout-sizing-business-logic';

describe('volNormalizedRiskUsd — the vol-normalized sizing policy (08-24)', () => {
  it('a target-vol coin gets exactly the floor', () => {
    expect(volNormalizedRiskUsd(0.04)).toBe(8);
  });

  it('high-vol coins get proportionally FEWER dollars (HYPE at 8%/day → half)', () => {
    expect(volNormalizedRiskUsd(0.08)).toBe(4);
  });

  it('low-vol coins get more, capped at the executor ceiling (BTC quiet regime)', () => {
    expect(volNormalizedRiskUsd(0.02)).toBe(15); // raw 16 → clamped to maxRiskUsd
    expect(DEFAULT_SCOUT_SIZING.maxRiskUsd).toBe(15); // must equal SCOUT_MAX_RISK_USD
  });

  it('floors at minRiskUsd for extreme vol', () => {
    expect(volNormalizedRiskUsd(0.2)).toBe(4);
  });

  it('degenerate/missing vol falls back to the plain floor — no fake precision', () => {
    for (const v of [null, undefined, 0, -1, NaN]) expect(volNormalizedRiskUsd(v)).toBe(8);
  });
});
