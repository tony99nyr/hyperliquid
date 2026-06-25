import { describe, it, expect } from 'vitest';
import { deriveFavoritePlays, isOverExtended, NEW_PLAY_WINDOW_MS } from '@/lib/cockpit/favorite-plays-business-logic';
import type { LeaderPositionRow, LeaderActionRow } from '@/hooks/realtime-row-mappers';

const NOW = 1_700_000_000_000;
const FAV = new Set(['0xfav1', '0xfav2']);

function action(over: Partial<LeaderActionRow>): LeaderActionRow {
  return {
    id: 'a', leaderAddress: '0xfav1', coin: 'ETH', kind: 'open', prevSide: null, newSide: 'long',
    prevSize: 0, newSize: 1, sizeDelta: 1, entryPx: 1000, notionalUsd: 1000, unrealizedPnl: 0, detectedAt: NOW, ...over,
  };
}
function position(over: Partial<LeaderPositionRow>): LeaderPositionRow {
  return {
    id: 'p', leaderAddress: '0xfav1', coin: 'ETH', side: 'long', szi: 1, size: 1, entryPx: 1000,
    positionValue: 1100, unrealizedPnl: 100, returnOnEquity: 0.1, leverage: 5, leverageType: 'cross',
    liquidationPx: 800, accountValueUsd: 10000, fetchedAt: NOW, updatedAt: NOW, ...over,
  };
}

describe('deriveFavoritePlays', () => {
  it('NEW = favorites-only recent opens, newest first', () => {
    const { newPlays } = deriveFavoritePlays({
      opens: [
        action({ id: 'a1', detectedAt: NOW - 1000 }),
        action({ id: 'a2', detectedAt: NOW - 5000 }),
        action({ id: 'aOld', detectedAt: NOW - NEW_PLAY_WINDOW_MS - 1 }), // too old
        action({ id: 'aNotFav', leaderAddress: '0xstranger' }), // not favorited
        action({ id: 'aAdd', kind: 'add' }), // not an open
      ],
      positions: [],
      favorites: FAV,
      nowMs: NOW,
    });
    expect(newPlays.map((p) => p.id)).toEqual(['a1', 'a2']);
  });

  it('PROFITABLE = favorites-only uPnL>0 positions, with signed extendedPct', () => {
    const { profitablePlays } = deriveFavoritePlays({
      opens: [],
      positions: [
        position({ id: 'long', side: 'long', entryPx: 1000, positionValue: 1100, size: 1, unrealizedPnl: 100 }), // mark 1100 → +10%
        position({ id: 'short', side: 'short', entryPx: 1000, positionValue: 900, size: 1, unrealizedPnl: 100 }), // mark 900 → +10% in favor
        position({ id: 'loser', unrealizedPnl: -50 }), // excluded
        position({ id: 'stranger', leaderAddress: '0xstranger', unrealizedPnl: 100 }), // not favorited
      ],
      favorites: FAV,
      nowMs: NOW,
    });
    expect(profitablePlays.map((p) => p.id).sort()).toEqual(['long', 'short']);
    const long = profitablePlays.find((p) => p.id === 'long')!;
    const short = profitablePlays.find((p) => p.id === 'short')!;
    expect(long.extendedPct).toBeCloseTo(10);
    expect(short.extendedPct).toBeCloseTo(10); // short profit = price fell, "in favor" positive
  });

  it('isOverExtended flags chase risk past the threshold', () => {
    const { profitablePlays } = deriveFavoritePlays({
      opens: [],
      positions: [position({ id: 'extended', entryPx: 1000, positionValue: 1200, size: 1, unrealizedPnl: 200 })], // +20%
      favorites: FAV,
      nowMs: NOW,
    });
    expect(isOverExtended(profitablePlays[0])).toBe(true);
    expect(isOverExtended(profitablePlays[0], 25)).toBe(false);
  });
});
