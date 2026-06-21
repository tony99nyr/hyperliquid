import { describe, it, expect } from 'vitest';
import {
  buildScorecard,
  DEFAULT_SCORECARD_CONFIG,
  type ScorecardInput,
} from '@/lib/scout/scout-review-business-logic';

function input(over: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    realizedGrossUsd: 0,
    totalEntryNotionalUsd: 0,
    fundingHaircutUsd: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    periodDays: 30,
    ...over,
  };
}

describe('buildScorecard', () => {
  it('applies slippage (both legs) + funding to gross to get honest net', () => {
    const s = buildScorecard(
      input({ realizedGrossUsd: 100, totalEntryNotionalUsd: 10_000, fundingHaircutUsd: 6, tradeCount: 5 }),
    );
    // slippage = 10000 * 5/10000 * 2 = $10; net = 100 - 10 - 6 = 84
    expect(s.slippageHaircutUsd).toBeCloseTo(10, 6);
    expect(s.netUsd).toBeCloseTo(84, 6);
  });

  it('win rate from decided trades only', () => {
    const s = buildScorecard(input({ wins: 3, losses: 1, tradeCount: 4 }));
    expect(s.winRate).toBeCloseTo(0.75, 6);
  });

  it('KILL when net is negative past the trade floor', () => {
    const s = buildScorecard(input({ realizedGrossUsd: -50, totalEntryNotionalUsd: 5000, tradeCount: 20 }));
    expect(s.verdict).toBe('kill');
  });

  it('does NOT kill on negative net below the trade floor (too few trades)', () => {
    const s = buildScorecard(input({ realizedGrossUsd: -50, totalEntryNotionalUsd: 5000, tradeCount: 3 }));
    expect(s.verdict).toBe('continue');
  });

  it('GRADUATE only when run-rate clears the bar over a long enough period with low DD', () => {
    const s = buildScorecard(
      input({
        realizedGrossUsd: 3300, // ~$1100/mo over 90d after small haircut
        totalEntryNotionalUsd: 20_000,
        fundingHaircutUsd: 50,
        tradeCount: 60,
        wins: 36,
        losses: 24,
        periodDays: 90,
        maxDrawdownUsd: 800,
        equityUsd: 10_000, // 8% DD < 15%
      }),
    );
    expect(s.verdict).toBe('graduate');
    expect(s.monthlyRunRateUsd).toBeGreaterThan(DEFAULT_SCORECARD_CONFIG.monthlyBarUsd);
  });

  it('CONTINUE when run-rate clears the bar but the period is too short to graduate', () => {
    const s = buildScorecard(
      input({ realizedGrossUsd: 1100, totalEntryNotionalUsd: 5000, tradeCount: 10, wins: 7, losses: 3, periodDays: 14, maxDrawdownUsd: 100, equityUsd: 10_000 }),
    );
    expect(s.verdict).toBe('continue');
  });
});
