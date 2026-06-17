import { describe, it, expect } from 'vitest';
import { getTopTraders, slimMetrics } from '@/lib/hyperliquid/top-traders-service';

describe('getTopTraders', () => {
  it('returns a slim ranked list capped at the limit', () => {
    const rows = getTopTraders(5);
    expect(rows.length).toBeLessThanOrEqual(5);
    if (rows.length === 0) return; // fail-soft when dataset absent
    // Slim shape: chip flags are capped at 3, but allFlags + slim metrics ride
    // along for the trader-detail drawer (still a slim subset, not the 2.8MB dataset).
    for (const r of rows) {
      expect(typeof r.address).toBe('string');
      expect(typeof r.short).toBe('string');
      expect(Array.isArray(r.flags)).toBe(true);
      expect(r.flags.length).toBeLessThanOrEqual(3);
      expect(Array.isArray(r.allFlags)).toBe(true);
      expect(r.allFlags.length).toBeGreaterThanOrEqual(r.flags.length);
      expect(r.topCoins.length).toBeLessThanOrEqual(3);
      expect(typeof r.hasRisk).toBe('boolean');
      // metrics is the slim numeric subset (each key number-or-null).
      expect(r.metrics).toBeDefined();
      expect('sharpe' in r.metrics).toBe(true);
    }
  });

  it('slimMetrics projects the numeric subset, coercing missing → null', () => {
    const full = { sharpe: 2.1, winRate: 0.6, nFills: 100 };
    const slim = slimMetrics(full);
    expect(slim.sharpe).toBe(2.1);
    expect(slim.winRate).toBe(0.6);
    expect(slim.nFills).toBe(100);
    // Absent metrics → null (not undefined) so the UI renders an em-dash.
    expect(slim.profitFactor).toBeNull();
    expect(slim.maxDrawdownFrac).toBeNull();
    // Non-finite values are nulled too.
    expect(slimMetrics({ sharpe: NaN }).sharpe).toBeNull();
  });

  it('ranks by composite descending (nulls last)', () => {
    const rows = getTopTraders(20);
    if (rows.length < 2) return;
    const scores = rows.map((r) => (r.composite ?? -Infinity));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });
});
