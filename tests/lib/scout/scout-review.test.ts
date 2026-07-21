import { describe, it, expect } from 'vitest';
import {
  buildScorecard,
  buildLaneScorecards,
  DEFAULT_SCORECARD_CONFIG,
  DEFAULT_LANE,
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

  it('omitted unrealizedPnlUsd leaves realized-only net unchanged (backward-compatible)', () => {
    const s = buildScorecard(input({ realizedGrossUsd: 100, slippageHaircutUsd: 10, fundingHaircutUsd: 6 }));
    expect(s.netUsd).toBeCloseTo(84, 6); // no unrealized field → same as before
  });

  it('open mark-to-market (Lane A vault NAV) folds into net, signed', () => {
    // a vault lane: no closed round-trips, edge IS the open NAV track
    const up = buildScorecard(input({ realizedGrossUsd: 0, unrealizedPnlUsd: 120 }));
    expect(up.netUsd).toBeCloseTo(120, 6);
    const down = buildScorecard(input({ realizedGrossUsd: 0, unrealizedPnlUsd: -75 }));
    expect(down.netUsd).toBeCloseTo(-75, 6);
  });

  it('unrealized adds to realized + cost haircuts', () => {
    const s = buildScorecard(input({ realizedGrossUsd: 100, slippageHaircutUsd: 10, fundingHaircutUsd: 6, unrealizedPnlUsd: 20 }));
    expect(s.netUsd).toBeCloseTo(104, 6); // 100 − 10 − 6 + 20
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
  // Post-Jul-16 bar: graduation demands the DECAY-ADJUSTED run-rate (bar/(1−0.5) = 2x
  // nominal — published signals lose ~43-58% of edge out of sample) AND a fee-drag
  // check (fees/grossWins ≤ 35% — overtrading is the measured LLM-agent killer).
  const graduating = (over: Partial<ScorecardInput> = {}) =>
    input({ realizedGrossUsd: 6600, slippageHaircutUsd: 200, fundingHaircutUsd: 100, tradeCount: 60, wins: 36, losses: 24, periodDays: 90, maxDrawdownUsd: 800, equityUsd: 10_000, feesPaidUsd: 300, grossWinsUsd: 8000, ...over });

  it('GRADUATE when decay-adjusted run-rate clears over ≥90d with enough trades + low DD + sane fee drag', () => {
    const s = buildScorecard(graduating());
    expect(s.verdict).toBe('graduate');
    expect(s.monthlyRunRateUsd).toBeGreaterThan(
      DEFAULT_SCORECARD_CONFIG.monthlyBarUsd / (1 - DEFAULT_SCORECARD_CONFIG.liveDecayHaircut),
    );
    expect(s.reason).toMatch(/regime coverage still needs a HUMAN check/);
  });

  it('does NOT graduate on the OLD bar alone — decay adjustment doubles the hurdle', () => {
    // clears $1000/mo nominal but not the $2000/mo decay-adjusted bar
    const s = buildScorecard(graduating({ realizedGrossUsd: 3300, slippageHaircutUsd: 100, fundingHaircutUsd: 50 }));
    expect(s.verdict).toBe('continue');
    expect(s.reason).toMatch(/decay-adjusted/);
  });

  it('does NOT graduate on excessive fee drag (overtrading)', () => {
    const s = buildScorecard(graduating({ feesPaidUsd: 4000, grossWinsUsd: 8000 })); // 50% > 35%
    expect(s.verdict).toBe('continue');
    expect(s.reason).toMatch(/overtrading/);
  });

  it('fee drag defaults to 0 (never blocks) when the legacy caller omits fees/wins', () => {
    const s = buildScorecard(graduating({ feesPaidUsd: undefined, grossWinsUsd: undefined }));
    expect(s.feeDragFrac).toBe(0);
    expect(s.verdict).toBe('graduate');
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

describe('buildLaneScorecards — per-lane grouping', () => {
  it('groups realized + wins by lane; NULL lane folds into directional; funding attributed via coin→lane', () => {
    const cards = buildLaneScorecards({
      positions: [
        { lane: 'vault', coin: 'HLP', side: 'long', realizedPnlUsd: 50, feesPaidUsd: 0 },
        { lane: 'carry', coin: 'ETH', side: 'short', realizedPnlUsd: 30, feesPaidUsd: 2 },
        { lane: null, coin: 'BTC', side: 'flat', realizedPnlUsd: 10, feesPaidUsd: 1 }, // null → directional
      ],
      hypotheses: [
        { lane: 'carry', status: 'confirmed' },
        { lane: 'carry', status: 'invalidated' },
        { lane: null, status: 'confirmed' }, // → directional
      ],
      fundingByCoin: { ETH: -8, BTC: 3 }, // ETH carry earned (−), BTC cost (+)
      periodDays: 10,
    });
    const by = Object.fromEntries(cards.map((c) => [c.lane, c]));
    expect(Object.keys(by).sort()).toEqual(['carry', DEFAULT_LANE, 'vault']);

    // vault: realized 50, no funding (no perp fills), no closed trips
    expect(by.vault.card.realizedGrossUsd).toBeCloseTo(50, 6);
    expect(by.vault.card.netUsd).toBeCloseTo(50, 6);
    expect(by.vault.openCount).toBe(1);

    // carry: realized 30−2=28, funding ETH −8 (carry earned) → net 28−(−8)=36; 1 win / 1 loss
    expect(by.carry.card.realizedGrossUsd).toBeCloseTo(28, 6);
    expect(by.carry.card.netUsd).toBeCloseTo(36, 6);
    expect(by.carry.card.winRate).toBeCloseTo(0.5, 6);
    expect(by.carry.card.tradeCount).toBe(2);

    // directional (null): realized 10−1=9, funding BTC +3 cost → net 9−3=6; 1 win
    expect(by[DEFAULT_LANE].card.realizedGrossUsd).toBeCloseTo(9, 6);
    expect(by[DEFAULT_LANE].card.netUsd).toBeCloseTo(6, 6);
    expect(by[DEFAULT_LANE].card.winRate).toBeCloseTo(1, 6);
  });

  it('per-lane config override applies (e.g. a lower vault bar)', () => {
    const cards = buildLaneScorecards({
      positions: [{ lane: 'vault', coin: 'HLP', side: 'long', realizedPnlUsd: 200, feesPaidUsd: 0 }],
      hypotheses: [],
      fundingByCoin: {},
      periodDays: 90,
      configFor: (lane) => (lane === 'vault' ? { ...DEFAULT_SCORECARD_CONFIG, monthlyBarUsd: 100 } : DEFAULT_SCORECARD_CONFIG),
    });
    // 200 over 90d ≈ $67/mo — clears a $100 bar? no; but vsBar uses the override (100, not 1000)
    expect(cards[0].card.vsBarUsd).toBeCloseTo((200 / 90) * 30 - 100, 1);
  });
});


import { setupTypeExpectancy } from '@/lib/scout/scout-review-business-logic';
describe('setupTypeExpectancy (per-strategy telemetry)', () => {
  it('groups by setup_type and computes win rate + expectancy R', () => {
    const out = setupTypeExpectancy([
      { setupType: 'reversion-extreme', realizedR: 1.5, excluded: false },
      { setupType: 'reversion-extreme', realizedR: -1, excluded: false },
      { setupType: 'reversion-extreme', realizedR: 0.5, excluded: false },
      { setupType: 'momentum', realizedR: -1, excluded: false },
    ]);
    const rev = out.find((x) => x.setupType === 'reversion-extreme')!;
    expect(rev.n).toBe(3);
    expect(rev.winRate).toBeCloseTo(2 / 3);
    expect(rev.expectancyR).toBeCloseTo((1.5 - 1 + 0.5) / 3);
    expect(out[0].setupType).toBe('reversion-extreme'); // most-traded first
  });

  it('drops excluded / untagged / R-less rows (unmeasurable never dilutes)', () => {
    const out = setupTypeExpectancy([
      { setupType: 'reversion-extreme', realizedR: 1, excluded: false },
      { setupType: 'reversion-extreme', realizedR: 5, excluded: true }, // janitorial
      { setupType: null, realizedR: 2, excluded: false }, // untagged
      { setupType: 'reversion-extreme', realizedR: null, excluded: false }, // open/unresolved
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(1);
    expect(out[0].expectancyR).toBe(1);
  });
});
