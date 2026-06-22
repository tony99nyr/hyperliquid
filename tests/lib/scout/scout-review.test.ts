import { describe, it, expect } from 'vitest';
import {
  buildScorecard,
  DEFAULT_SCORECARD_CONFIG,
  type ScorecardInput,
} from '@/lib/scout/scout-review-business-logic';

function input(over: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    realizedGrossUsd: 0,
    slippageHaircutUsd: 0,
    fundingHaircutUsd: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    periodDays: 10,
    ...over,
  };
}

describe('buildScorecard — net', () => {
  it('net = gross − slippage − (signed) funding', () => {
    const s = buildScorecard(input({ realizedGrossUsd: 100, slippageHaircutUsd: 10, fundingHaircutUsd: 6 }));
    expect(s.netUsd).toBeCloseTo(84, 6);
  });

  it('earned carry (negative funding) ADDS back to net', () => {
    const s = buildScorecard(input({ realizedGrossUsd: 100, slippageHaircutUsd: 10, fundingHaircutUsd: -5 }));
    expect(s.netUsd).toBeCloseTo(95, 6); // 100 − 10 − (−5)
  });

  it('win rate from decided trades only', () => {
    expect(buildScorecard(input({ wins: 3, losses: 1 })).winRate).toBeCloseTo(0.75, 6);
  });
});

describe('buildScorecard — KILL', () => {
  it('churn KILL when net<0 past the trade floor', () => {
    expect(buildScorecard(input({ realizedGrossUsd: -50, tradeCount: 20, periodDays: 10 })).verdict).toBe('kill');
  });

  it('SLOW-BLEED KILL when net<0 past the day window even with few trades', () => {
    const s = buildScorecard(input({ realizedGrossUsd: -30, tradeCount: 4, periodDays: 25 }));
    expect(s.verdict).toBe('kill');
    expect(s.reason).toMatch(/slow bleed/i);
  });

  it('no KILL on negative net below BOTH the trade floor and the bleed window', () => {
    expect(buildScorecard(input({ realizedGrossUsd: -30, tradeCount: 4, periodDays: 10 })).verdict).toBe('continue');
  });

  it('slow-bleed does NOT fire on unclosed entry-fee drag alone (too few closed trades)', () => {
    // negative net, past the day window, but only 1 closed trade → not a bleed
    expect(buildScorecard(input({ realizedGrossUsd: -2, tradeCount: 1, periodDays: 25 })).verdict).toBe('continue');
  });
});

describe('buildScorecard — GRADUATE gating', () => {
  const graduating = (over: Partial<ScorecardInput> = {}) =>
    input({ realizedGrossUsd: 3300, slippageHaircutUsd: 100, fundingHaircutUsd: 50, tradeCount: 60, wins: 36, losses: 24, periodDays: 90, maxDrawdownUsd: 800, equityUsd: 10_000, ...over });

  it('GRADUATE when run-rate ≥ bar over ≥90d with enough trades + low DD', () => {
    const s = buildScorecard(graduating());
    expect(s.verdict).toBe('graduate');
    expect(s.monthlyRunRateUsd).toBeGreaterThan(DEFAULT_SCORECARD_CONFIG.monthlyBarUsd);
  });

  it('does NOT graduate without enough TRADES even if days + run-rate clear', () => {
    // few trades but a "lucky" gross that projects past the bar
    const s = buildScorecard(graduating({ tradeCount: 8, wins: 6, losses: 2 }));
    expect(s.verdict).toBe('continue');
    expect(s.reason).toMatch(/trades/);
  });

  it('does NOT graduate without drawdown data', () => {
    const s = buildScorecard(graduating({ maxDrawdownUsd: undefined, equityUsd: undefined }));
    expect(s.verdict).toBe('continue');
  });

  it('does NOT graduate if DD exceeds the ceiling', () => {
    const s = buildScorecard(graduating({ maxDrawdownUsd: 2000 })); // 20% > 15%
    expect(s.verdict).toBe('continue');
  });
});
