/**
 * Pins the Leader-vs-You alignment read (Item 4): the four states + the
 * resolution order (covered/flipped is the strongest cue; adding-into-loss beats
 * trimming when size grew while underwater).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveAlignment,
  leaderPositionForCoin,
} from '@/app/cockpit/components/leader-alignment-helpers';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

function leader(over: Partial<HlPosition> = {}): HlPosition {
  return {
    coin: 'ETH', side: 'long', szi: 2, size: 2, entryPx: 2000, positionValue: 4000,
    unrealizedPnl: 100, returnOnEquity: 0.05, leverage: 5, leverageType: 'cross',
    liquidationPx: 1600, marginUsed: 800, maxLeverage: 25, ...over,
  };
}

describe('deriveAlignment', () => {
  it('🔴 leader flat / closed the coin ⇒ covered (the exit cue)', () => {
    const r = deriveAlignment({ coin: 'ETH', userSide: 'long', leaderPosition: null });
    expect(r.state).toBe('leader-covered');
    expect(r.glyph).toBe('🔴');
  });

  it('🔴 leader flipped to the opposite side ⇒ covered/flipped', () => {
    const r = deriveAlignment({ coin: 'ETH', userSide: 'long', leaderPosition: leader({ side: 'short', szi: -2 }) });
    expect(r.state).toBe('leader-covered');
  });

  it('🟢 same side, holding, no baseline ⇒ aligned', () => {
    const r = deriveAlignment({ coin: 'ETH', userSide: 'long', leaderPosition: leader() });
    expect(r.state).toBe('aligned');
    expect(r.glyph).toBe('🟢');
  });

  it('🟡 same side, size shrank materially vs baseline ⇒ trimming', () => {
    const r = deriveAlignment({ coin: 'ETH', userSide: 'long', leaderPosition: leader({ size: 1, szi: 1 }), leaderBaselineSize: 2 });
    expect(r.state).toBe('leader-trimming');
    expect(r.glyph).toBe('🟡');
  });

  it('⚠️ same side, size GREW while underwater ⇒ adding into a loss (martingale)', () => {
    const r = deriveAlignment({
      coin: 'ETH', userSide: 'long',
      leaderPosition: leader({ size: 3, szi: 3, unrealizedPnl: -500 }),
      leaderBaselineSize: 2,
    });
    expect(r.state).toBe('leader-adding-loss');
    expect(r.glyph).toBe('⚠️');
  });

  it('size grew while in PROFIT is aligned (not a martingale caution)', () => {
    const r = deriveAlignment({
      coin: 'ETH', userSide: 'long',
      leaderPosition: leader({ size: 3, szi: 3, unrealizedPnl: 200 }),
      leaderBaselineSize: 2,
    });
    expect(r.state).toBe('aligned');
  });

  it('a small (<10%) size wobble is NOT a trim', () => {
    const r = deriveAlignment({ coin: 'ETH', userSide: 'long', leaderPosition: leader({ size: 1.95, szi: 1.95 }), leaderBaselineSize: 2 });
    expect(r.state).toBe('aligned');
  });
});

describe('leaderPositionForCoin', () => {
  it('matches case-insensitively', () => {
    const positions = [leader({ coin: 'BTC' }), leader({ coin: 'ETH' })];
    expect(leaderPositionForCoin(positions, 'eth')?.coin).toBe('ETH');
    expect(leaderPositionForCoin(positions, 'SOL')).toBeNull();
  });
});
