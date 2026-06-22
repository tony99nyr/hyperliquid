import { describe, it, expect } from 'vitest';
import {
  applyFillRealism,
  bandDepthUsd,
  baseSlippageBps,
} from '@/lib/trading/paper-fill-realism-business-logic';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';

describe('baseSlippageBps', () => {
  it('thin BTC costs more than liquid ETH; unknown coin → default', () => {
    expect(baseSlippageBps('BTC')).toBe(12);
    expect(baseSlippageBps('ETH')).toBe(5);
    expect(baseSlippageBps('DOGE')).toBe(8);
  });
});

describe('applyFillRealism — favorable-selection clamp', () => {
  const common = { filledNotionalUsd: 1000, bandDepthUsd: 1_000_000, baseBps: 5 };
  it('a BUY cannot fill cheaper than the decision mark (staleness never helps)', () => {
    // book drifted DOWN to 1690 after we decided at 1700 → must base off 1700, not 1690
    const r = applyFillRealism({ side: 'buy', bookAvgPx: 1690, decisionPx: 1700, ...common });
    expect(r.effectivePx).toBeGreaterThanOrEqual(1700); // clamped up, then adverse
  });
  it('a SELL cannot fill higher than the decision mark', () => {
    const r = applyFillRealism({ side: 'sell', bookAvgPx: 1710, decisionPx: 1700, ...common });
    expect(r.effectivePx).toBeLessThanOrEqual(1700);
  });
  it('staleness that HURTS is kept (buy fills at the worse book price)', () => {
    const r = applyFillRealism({ side: 'buy', bookAvgPx: 1710, decisionPx: 1700, ...common });
    expect(r.effectivePx).toBeGreaterThan(1710); // worse book price + adverse offset
  });
});

describe('applyFillRealism — adverse offset + impact', () => {
  it('buy fills above / sell fills below the base by the base bps when size << depth', () => {
    const buy = applyFillRealism({ side: 'buy', bookAvgPx: 2000, filledNotionalUsd: 100, bandDepthUsd: 1_000_000, baseBps: 5 });
    expect(buy.impactMult).toBeCloseTo(1, 2);
    expect(buy.effectivePx).toBeCloseTo(2001, 1); // ≈ +5bps (negligible impact at size << depth)
    const sell = applyFillRealism({ side: 'sell', bookAvgPx: 2000, filledNotionalUsd: 100, bandDepthUsd: 1_000_000, baseBps: 5 });
    expect(sell.effectivePx).toBeCloseTo(1999, 1);
  });
  it('a large order vs thin depth gets a higher impact multiplier (capped)', () => {
    const r = applyFillRealism({ side: 'buy', bookAvgPx: 2000, filledNotionalUsd: 500_000, bandDepthUsd: 250_000, baseBps: 5, maxImpactMult: 3 });
    expect(r.impactMult).toBeGreaterThan(1);
    expect(r.impactMult).toBeLessThanOrEqual(3);
    expect(r.appliedBps).toBeGreaterThan(5);
  });
  it('zero/invalid book price → no-op', () => {
    expect(applyFillRealism({ side: 'buy', bookAvgPx: 0, filledNotionalUsd: 0, bandDepthUsd: 0, baseBps: 5 }).effectivePx).toBe(0);
  });
});

describe('bandDepthUsd', () => {
  const book: L2Book = {
    coin: 'ETH',
    bids: [{ px: 1999, sz: 10 }, { px: 1990, sz: 100 }],
    asks: [{ px: 2001, sz: 10 }, { px: 2010, sz: 100 }],
  };
  it('sums notional within the band on the consumed side', () => {
    // buy consumes asks; ±0.3% of 2001 ≈ [2001, 2007] → only the 2001 level (10 * 2001)
    expect(bandDepthUsd('buy', book, 0.003)).toBeCloseTo(2001 * 10, 0);
  });
  it('empty book side → 0', () => {
    expect(bandDepthUsd('buy', { coin: 'X', bids: [], asks: [] })).toBe(0);
  });
});
