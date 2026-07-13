import { describe, it, expect } from 'vitest';
import { takerFlowFromTrades, scoreMicroPillar } from '@/lib/rubric/rubric-scorers-business-logic';
import { loadRubricConfig } from '@/lib/rubric/rubric-config';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';

const CFG = loadRubricConfig();
const balancedBook: L2Book = { coin: 'ETH', bids: [{ px: 99.9, sz: 10 }], asks: [{ px: 100.1, sz: 10 }] };

describe('takerFlowFromTrades (CVD-style tape skew)', () => {
  it('net aggressive buying → positive, notional-weighted', () => {
    expect(takerFlowFromTrades([
      { side: 'buy', px: 100, sz: 3 },
      { side: 'sell', px: 100, sz: 1 },
    ])).toBeCloseTo(0.5, 6); // (300−100)/400
  });
  it('empty/garbage tape → null (never punitive)', () => {
    expect(takerFlowFromTrades([])).toBeNull();
    expect(takerFlowFromTrades([{ side: 'buy', px: 0, sz: 5 }])).toBeNull();
  });
});

describe('scoreMicroPillar — tape blend', () => {
  it('buy-flow lifts the long side and drags the short side', () => {
    const neutral = scoreMicroPillar(balancedBook, 'long', CFG);
    expect(scoreMicroPillar(balancedBook, 'long', CFG, 0.5)).toBeGreaterThan(neutral);
    expect(scoreMicroPillar(balancedBook, 'short', CFG, 0.5)).toBeLessThan(scoreMicroPillar(balancedBook, 'short', CFG));
  });
  it('null tape = identical to pre-tape behavior (additive input)', () => {
    const skewed: L2Book = { coin: 'ETH', bids: [{ px: 99.9, sz: 20 }], asks: [{ px: 100.1, sz: 10 }] };
    expect(scoreMicroPillar(skewed, 'long', CFG, null)).toBe(scoreMicroPillar(skewed, 'long', CFG));
  });
});
