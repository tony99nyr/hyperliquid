import { describe, it, expect } from 'vitest';
import {
  reduce,
  withStatus,
  emptyMarketState,
  MAX_RECENT_TRADES,
  MAX_BOOK_LEVELS,
  type HlWsMessage,
} from '@/lib/ws/hl-ws-reducer';

const NOW = 1_700_000_000_000;

const l2Msg = (over?: Partial<{ coin: string; bids: unknown[]; asks: unknown[]; time: number }>): HlWsMessage => ({
  channel: 'l2Book',
  data: {
    coin: over?.coin ?? 'ETH',
    time: over?.time ?? NOW,
    levels: [
      over?.bids ?? [
        { px: '1999', sz: '2', n: 3 },
        { px: '1998', sz: '5', n: 1 },
      ],
      over?.asks ?? [
        { px: '2001', sz: '1', n: 2 },
        { px: '2002', sz: '4', n: 1 },
      ],
    ],
  },
});

const tradesMsg = (trades: Array<{ side: string; px: string; sz: string; time: number; coin?: string }>): HlWsMessage => ({
  channel: 'trades',
  data: trades.map((t) => ({ coin: t.coin ?? 'ETH', side: t.side, px: t.px, sz: t.sz, time: t.time })),
});

describe('hl-ws-reducer (pure)', () => {
  describe('emptyMarketState', () => {
    it('starts flat + connecting', () => {
      const s = emptyMarketState('eth');
      expect(s.coin).toBe('ETH');
      expect(s.bids).toEqual([]);
      expect(s.status).toBe('connecting');
      expect(s.lastPx).toBeNull();
    });
  });

  describe('l2Book', () => {
    it('applies bids/asks and derives mid from top-of-book', () => {
      const s = reduce(emptyMarketState('ETH'), l2Msg(), NOW);
      expect(s.bids[0]).toEqual({ px: 1999, sz: 2 });
      expect(s.asks[0]).toEqual({ px: 2001, sz: 1 });
      expect(s.midPx).toBe(2000); // (1999 + 2001) / 2
      expect(s.bookUpdatedAt).toBe(NOW);
      expect(s.updatedAt).toBe(NOW);
    });

    it('ignores updates for a different coin', () => {
      const start = emptyMarketState('ETH');
      const s = reduce(start, l2Msg({ coin: 'BTC' }), NOW);
      expect(s).toBe(start);
    });

    it('caps book depth at MAX_BOOK_LEVELS', () => {
      const many = Array.from({ length: MAX_BOOK_LEVELS + 10 }, (_, i) => ({ px: String(2000 - i), sz: '1' }));
      const s = reduce(emptyMarketState('ETH'), l2Msg({ bids: many }), NOW);
      expect(s.bids).toHaveLength(MAX_BOOK_LEVELS);
    });

    it('ignores malformed levels payload', () => {
      const start = emptyMarketState('ETH');
      const s = reduce(start, { channel: 'l2Book', data: { coin: 'ETH' } }, NOW);
      expect(s).toBe(start);
    });
  });

  describe('trades', () => {
    it('prepends newest-first and sets lastPx to the last print', () => {
      const s = reduce(
        emptyMarketState('ETH'),
        tradesMsg([
          { side: 'B', px: '2000', sz: '1', time: NOW },
          { side: 'A', px: '2001', sz: '2', time: NOW + 1 },
        ]),
        NOW,
      );
      // batch is chronological; reducer stores most-recent-first
      expect(s.recentTrades[0]).toEqual({ px: 2001, sz: 2, side: 'sell', time: NOW + 1 });
      expect(s.recentTrades[1].side).toBe('buy');
      expect(s.lastPx).toBe(2001);
    });

    it('maps HL side codes B→buy, A→sell', () => {
      const s = reduce(emptyMarketState('ETH'), tradesMsg([{ side: 'A', px: '5', sz: '1', time: NOW }]), NOW);
      expect(s.recentTrades[0].side).toBe('sell');
    });

    it('bounds the ring at MAX_RECENT_TRADES', () => {
      let s = emptyMarketState('ETH');
      for (let i = 0; i < MAX_RECENT_TRADES + 20; i++) {
        s = reduce(s, tradesMsg([{ side: 'B', px: String(2000 + i), sz: '1', time: NOW + i }]), NOW + i);
      }
      expect(s.recentTrades).toHaveLength(MAX_RECENT_TRADES);
    });

    it('skips trades for other coins', () => {
      const s = reduce(emptyMarketState('ETH'), tradesMsg([{ side: 'B', px: '5', sz: '1', time: NOW, coin: 'BTC' }]), NOW);
      expect(s.recentTrades).toHaveLength(0);
    });
  });

  describe('allMids', () => {
    it('sets midPx for the coin and seeds lastPx only when unset', () => {
      const s = reduce(emptyMarketState('ETH'), { channel: 'allMids', data: { mids: { ETH: '2050', BTC: '60000' } } }, NOW);
      expect(s.midPx).toBe(2050);
      expect(s.lastPx).toBe(2050); // seeded because no trade yet
    });

    it('does not overwrite lastPx once a trade has set it', () => {
      let s = reduce(emptyMarketState('ETH'), tradesMsg([{ side: 'B', px: '2000', sz: '1', time: NOW }]), NOW);
      s = reduce(s, { channel: 'allMids', data: { mids: { ETH: '2050' } } }, NOW);
      expect(s.lastPx).toBe(2000);
      expect(s.midPx).toBe(2050);
    });

    it('ignores allMids without the subscribed coin', () => {
      const start = emptyMarketState('ETH');
      const s = reduce(start, { channel: 'allMids', data: { mids: { BTC: '60000' } } }, NOW);
      expect(s).toBe(start);
    });
  });

  describe('robustness', () => {
    it('returns state unchanged for unknown channels', () => {
      const start = emptyMarketState('ETH');
      expect(reduce(start, { channel: 'subscriptionResponse' }, NOW)).toBe(start);
      expect(reduce(start, {}, NOW)).toBe(start);
    });

    it('folds a realistic message sequence', () => {
      let s = emptyMarketState('ETH');
      s = reduce(s, { channel: 'allMids', data: { mids: { ETH: '2000' } } }, NOW);
      s = reduce(s, l2Msg(), NOW + 1);
      s = reduce(s, tradesMsg([{ side: 'B', px: '2001', sz: '0.5', time: NOW + 2 }]), NOW + 2);
      expect(s.lastPx).toBe(2001);
      expect(s.bids[0].px).toBe(1999);
      expect(s.midPx).toBe(2000); // from l2 top-of-book
      expect(s.recentTrades).toHaveLength(1);
    });
  });

  describe('withStatus', () => {
    it('sets status + derives stale from status by default', () => {
      const s = withStatus(emptyMarketState('ETH'), 'stale');
      expect(s.status).toBe('stale');
      expect(s.stale).toBe(true);
    });

    it('live status is not stale', () => {
      const s = withStatus(emptyMarketState('ETH'), 'live');
      expect(s.stale).toBe(false);
    });
  });
});
