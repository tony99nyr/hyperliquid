import { describe, it, expect } from 'vitest';
import {
  fundingCostUsd,
  slippagePenaltyUsd,
  paperRealismAdjustmentUsd,
  honestNetUsd,
  DEFAULT_PAPER_SLIPPAGE_BPS,
} from '@/lib/trading/paper-funding-business-logic';

describe('fundingCostUsd', () => {
  it('a long PAYS positive funding (cost > 0)', () => {
    // 0.00125%/hr × $10,000 × 8h = $10
    const cost = fundingCostUsd({ side: 'long', notionalUsd: 10_000, fundingRateHourly: 0.0000125, holdingHours: 8 });
    expect(cost).toBeCloseTo(1.0, 6);
  });

  it('a short RECEIVES positive funding (cost < 0)', () => {
    const cost = fundingCostUsd({ side: 'short', notionalUsd: 10_000, fundingRateHourly: 0.0000125, holdingHours: 8 });
    expect(cost).toBeCloseTo(-1.0, 6);
  });

  it('a short in a NEGATIVE-funding regime pays to hold (cost > 0)', () => {
    // negative rate ⇒ shorts pay; short cost = -1 × (neg) × notional × hrs > 0
    const cost = fundingCostUsd({ side: 'short', notionalUsd: 10_000, fundingRateHourly: -0.0000125, holdingHours: 8 });
    expect(cost).toBeGreaterThan(0);
  });

  it('zero for non-positive notional or holding', () => {
    expect(fundingCostUsd({ side: 'long', notionalUsd: 0, fundingRateHourly: 0.001, holdingHours: 8 })).toBe(0);
    expect(fundingCostUsd({ side: 'long', notionalUsd: 10_000, fundingRateHourly: 0.001, holdingHours: 0 })).toBe(0);
  });
});

describe('slippagePenaltyUsd', () => {
  it('one leg = notional × bps/10000', () => {
    expect(slippagePenaltyUsd({ notionalUsd: 10_000, slippageBps: 5 })).toBeCloseTo(5, 6);
  });
  it('zero when bps or notional is non-positive', () => {
    expect(slippagePenaltyUsd({ notionalUsd: 10_000, slippageBps: 0 })).toBe(0);
    expect(slippagePenaltyUsd({ notionalUsd: 0, slippageBps: 5 })).toBe(0);
  });
});

describe('paperRealismAdjustmentUsd', () => {
  it('combines funding + two-leg slippage; total is what to subtract from gross', () => {
    const adj = paperRealismAdjustmentUsd({
      side: 'long',
      notionalUsd: 10_000,
      fundingRateHourly: 0.0000125, // long pays $1 over 8h
      holdingHours: 8,
      slippageBps: DEFAULT_PAPER_SLIPPAGE_BPS, // $5/leg × 2 = $10
    });
    expect(adj.fundingUsd).toBeCloseTo(1.0, 6);
    expect(adj.slippageUsd).toBeCloseTo(10.0, 6);
    expect(adj.totalUsd).toBeCloseTo(11.0, 6);
  });

  it('short carry can REDUCE the haircut (funding received offsets slippage)', () => {
    const adj = paperRealismAdjustmentUsd({
      side: 'short',
      notionalUsd: 10_000,
      fundingRateHourly: 0.0001, // short receives a lot of funding
      holdingHours: 24,
      slippageBps: 5,
    });
    expect(adj.fundingUsd).toBeLessThan(0); // received
    expect(adj.totalUsd).toBeLessThan(adj.slippageUsd); // carry offsets slippage
  });

  it('honestNetUsd subtracts the total haircut from gross', () => {
    const adj = paperRealismAdjustmentUsd({ side: 'long', notionalUsd: 10_000, fundingRateHourly: 0.0000125, holdingHours: 8, slippageBps: 5 });
    expect(honestNetUsd(100, adj)).toBeCloseTo(89.0, 6); // 100 − 11
  });
});
