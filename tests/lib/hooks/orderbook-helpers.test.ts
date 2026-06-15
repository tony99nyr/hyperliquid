import { describe, it, expect } from 'vitest';
import {
  summarizeBook,
  withCumulativeDepth,
  effectiveLastPx,
} from '@/hooks/orderbook-helpers';

describe('orderbook-helpers', () => {
  describe('summarizeBook', () => {
    it('computes best bid/ask, mid, spread, spreadPct', () => {
      const s = summarizeBook(
        [{ px: 100, sz: 1 }, { px: 99, sz: 2 }],
        [{ px: 101, sz: 1 }, { px: 102, sz: 3 }],
      );
      expect(s.bestBid).toBe(100);
      expect(s.bestAsk).toBe(101);
      expect(s.mid).toBe(100.5);
      expect(s.spread).toBe(1);
      expect(s.spreadPct).toBeCloseTo(1 / 100.5, 8);
    });

    it('returns nulls when a side is empty', () => {
      const s = summarizeBook([{ px: 100, sz: 1 }], []);
      expect(s.bestBid).toBe(100);
      expect(s.bestAsk).toBeNull();
      expect(s.mid).toBeNull();
      expect(s.spread).toBeNull();
      expect(s.spreadPct).toBeNull();
    });
  });

  it('withCumulativeDepth accumulates size best-first', () => {
    const out = withCumulativeDepth([{ px: 100, sz: 1 }, { px: 99, sz: 2 }, { px: 98, sz: 3 }]);
    expect(out.map((l) => l.cumSz)).toEqual([1, 3, 6]);
  });

  it('effectiveLastPx prefers lastPx then mid', () => {
    expect(effectiveLastPx({ lastPx: 50, midPx: 60 })).toBe(50);
    expect(effectiveLastPx({ lastPx: null, midPx: 60 })).toBe(60);
    expect(effectiveLastPx({ lastPx: null, midPx: null })).toBeNull();
  });
});
