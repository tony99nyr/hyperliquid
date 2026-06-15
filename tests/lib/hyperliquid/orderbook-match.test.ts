import { describe, it, expect } from 'vitest';
import { matchIntentAgainstBook, type L2Book } from '@/lib/hyperliquid/orderbook-match';

const book: L2Book = {
  coin: 'ETH',
  // asks ascending (best/cheapest first)
  asks: [
    { px: 2000, sz: 1 },
    { px: 2001, sz: 2 },
    { px: 2005, sz: 5 },
  ],
  // bids descending (best/highest first)
  bids: [
    { px: 1999, sz: 1 },
    { px: 1998, sz: 2 },
    { px: 1990, sz: 5 },
  ],
};

describe('orderbook-match', () => {
  describe('market buy walks asks', () => {
    it('fills fully at the best level when size fits', () => {
      const r = matchIntentAgainstBook('buy', 1, book);
      expect(r.filledSz).toBe(1);
      expect(r.avgPx).toBe(2000);
      expect(r.partial).toBe(false);
      expect(r.notionalUsd).toBe(2000);
    });

    it('walks multiple levels and volume-weights the price', () => {
      const r = matchIntentAgainstBook('buy', 2, book);
      // 1 @ 2000 + 1 @ 2001 = 4001 / 2
      expect(r.filledSz).toBe(2);
      expect(r.avgPx).toBe(2000.5);
      expect(r.partial).toBe(false);
      expect(r.consumed).toEqual([
        { px: 2000, sz: 1 },
        { px: 2001, sz: 1 },
      ]);
    });
  });

  describe('market sell walks bids', () => {
    it('volume-weights across bid levels', () => {
      const r = matchIntentAgainstBook('sell', 2, book);
      // 1 @ 1999 + 1 @ 1998 = 3997 / 2
      expect(r.filledSz).toBe(2);
      expect(r.avgPx).toBe(1998.5);
      expect(r.partial).toBe(false);
    });
  });

  describe('partial fill on a thin book', () => {
    it('buys what it can and flags partial', () => {
      const thin: L2Book = { coin: 'ETH', asks: [{ px: 2000, sz: 1 }], bids: [] };
      const r = matchIntentAgainstBook('buy', 5, thin);
      expect(r.filledSz).toBe(1);
      expect(r.avgPx).toBe(2000);
      expect(r.partial).toBe(true);
    });

    it('returns empty (partial) when the book side is empty', () => {
      const r = matchIntentAgainstBook('buy', 1, { coin: 'ETH', asks: [], bids: [] });
      expect(r.filledSz).toBe(0);
      expect(r.avgPx).toBe(0);
      expect(r.partial).toBe(true);
    });
  });

  describe('limit price is respected', () => {
    it('buy stops once asks exceed the limit (partial)', () => {
      // limit 2001 → can take 2000 and 2001 levels, not 2005
      const r = matchIntentAgainstBook('buy', 10, book, 2001);
      expect(r.filledSz).toBe(3); // 1 @2000 + 2 @2001
      expect(r.partial).toBe(true);
      expect(r.avgPx).toBeCloseTo((2000 + 2001 * 2) / 3, 9);
    });

    it('buy fills nothing when the best ask is above the limit', () => {
      const r = matchIntentAgainstBook('buy', 1, book, 1999);
      expect(r.filledSz).toBe(0);
      expect(r.partial).toBe(true);
    });

    it('sell stops once bids fall below the limit', () => {
      // limit 1998 → take 1999 and 1998, not 1990
      const r = matchIntentAgainstBook('sell', 10, book, 1998);
      expect(r.filledSz).toBe(3); // 1 @1999 + 2 @1998
      expect(r.partial).toBe(true);
    });
  });

  describe('guards', () => {
    it('non-positive size returns non-partial empty', () => {
      const r = matchIntentAgainstBook('buy', 0, book);
      expect(r.filledSz).toBe(0);
      expect(r.partial).toBe(false);
    });
  });
});
