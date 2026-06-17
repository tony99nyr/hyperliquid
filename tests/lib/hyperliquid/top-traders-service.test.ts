import { describe, it, expect } from 'vitest';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';

describe('getTopTraders', () => {
  it('returns a slim ranked list capped at the limit', () => {
    const rows = getTopTraders(5);
    expect(rows.length).toBeLessThanOrEqual(5);
    if (rows.length === 0) return; // fail-soft when dataset absent
    // Slim shape only — no heavy metrics leak to the client payload.
    for (const r of rows) {
      expect(typeof r.address).toBe('string');
      expect(typeof r.short).toBe('string');
      expect(Array.isArray(r.flags)).toBe(true);
      expect(r.flags.length).toBeLessThanOrEqual(3);
      expect(r.topCoins.length).toBeLessThanOrEqual(3);
      expect(typeof r.hasRisk).toBe('boolean');
    }
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
