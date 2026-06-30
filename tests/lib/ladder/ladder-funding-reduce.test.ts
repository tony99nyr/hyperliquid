import { describe, it, expect } from 'vitest';
import {
  expectedFundingUsd,
  reduceFraction,
  computeLadderRisk,
  type RungRisk,
} from '@/lib/ladder/ladder-risk-business-logic';

describe('expectedFundingUsd', () => {
  it('a long PAYS when funding is positive (cost > 0)', () => {
    // $1000 notional, +0.01%/hr, 24h → 1000 * 0.0001 * 24 = $2.40
    expect(expectedFundingUsd(1000, 'long', 0.0001, 24)).toBeCloseTo(2.4, 6);
  });

  it('a long RECEIVES when funding is negative (cost < 0)', () => {
    expect(expectedFundingUsd(1000, 'long', -0.0001, 24)).toBeCloseTo(-2.4, 6);
  });

  it('a short PAYS when funding is negative (sign flips vs long)', () => {
    expect(expectedFundingUsd(1000, 'short', -0.0001, 24)).toBeCloseTo(2.4, 6);
    expect(expectedFundingUsd(1000, 'short', 0.0001, 24)).toBeCloseTo(-2.4, 6);
  });

  it('returns 0 for degenerate inputs', () => {
    expect(expectedFundingUsd(0, 'long', 0.0001, 24)).toBe(0);
    expect(expectedFundingUsd(1000, 'long', null, 24)).toBe(0);
    expect(expectedFundingUsd(1000, 'long', Number.NaN, 24)).toBe(0);
    expect(expectedFundingUsd(1000, 'long', 0.0001, 0)).toBe(0);
    expect(expectedFundingUsd(1000, 'long', 0.0001, null)).toBe(0);
  });
});

describe('reduceFraction', () => {
  it('close is always full', () => {
    expect(reduceFraction({ action: 'close', reduceFrac: 0.4, sizeCoins: 1, positionSz: 10 })).toBe(1);
  });

  it('prefers reduceFrac (path-independent fraction of the current position)', () => {
    expect(reduceFraction({ action: 'reduce', reduceFrac: 0.4, sizeCoins: 5, positionSz: 10 })).toBe(0.4);
  });

  it('falls back to sizeCoins/positionSz when reduceFrac is absent', () => {
    expect(reduceFraction({ action: 'reduce', reduceFrac: null, sizeCoins: 2.5, positionSz: 10 })).toBe(0.25);
  });

  it('clamps to (0, 1]', () => {
    expect(reduceFraction({ action: 'reduce', reduceFrac: 1.5, sizeCoins: null, positionSz: 10 })).toBe(1);
    expect(reduceFraction({ action: 'reduce', reduceFrac: null, sizeCoins: 99, positionSz: 10 })).toBe(1);
  });

  it('defaults to full when nothing usable / position unknown', () => {
    expect(reduceFraction({ action: 'reduce', reduceFrac: null, sizeCoins: null, positionSz: 10 })).toBe(1);
    expect(reduceFraction({ action: 'reduce', reduceFrac: 0.4, sizeCoins: null, positionSz: 0 })).toBe(1);
  });
});

describe('computeLadderRisk — funding honesty', () => {
  const rung: RungRisk = { coin: 'HYPE', side: 'long', action: 'open', entryPx: 66, sizeCoins: 1, leverage: 2, stopPx: 56.5 };
  // worst-case stop loss: fill = 56.5 * 0.9 = 50.85; adverse = 66 - 50.85 = 15.15 × 1 coin.
  const STOP_LOSS = 15.15;

  it('is unchanged + funding 0 when no funding opts are supplied (backward compatible)', () => {
    const r = computeLadderRisk([rung], { maxTotalNotionalUsd: null, maxTotalLossUsd: null });
    expect(r.expectedFundingUsd).toBe(0);
    expect(r.worstCaseLossWithFundingUsd).toBeCloseTo(r.aggregateWorstCaseLossUsd, 6);
    expect(r.aggregateWorstCaseLossUsd).toBeCloseTo(STOP_LOSS, 6);
  });

  it('folds estimated funding into the honest max loss', () => {
    const r = computeLadderRisk([rung], { maxTotalNotionalUsd: null, maxTotalLossUsd: null }, {
      hoursToExpiry: 168, // 7 days
      fundingRateByCoin: { HYPE: 0.0001 }, // +0.01%/hr; long pays → notional 66 × 0.0001 × 168 ≈ $1.11
    });
    expect(r.expectedFundingUsd).toBeCloseTo(1.109, 2);
    expect(r.worstCaseLossWithFundingUsd).toBeCloseTo(STOP_LOSS + 1.109, 2);
  });

  it('a funding CREDIT does not reduce the worst-case loss', () => {
    const r = computeLadderRisk([rung], { maxTotalNotionalUsd: null, maxTotalLossUsd: null }, {
      hoursToExpiry: 168,
      fundingRateByCoin: { HYPE: -0.0002 }, // long receives → credit, but max-loss must not shrink
    });
    expect(r.expectedFundingUsd).toBeLessThan(0);
    expect(r.worstCaseLossWithFundingUsd).toBeCloseTo(STOP_LOSS, 6);
  });

  it('breaches the loss cap only once funding pushes it over', () => {
    // stop loss alone (15.15) is under a 16 cap, but +funding tips it over.
    const r = computeLadderRisk([rung], { maxTotalNotionalUsd: null, maxTotalLossUsd: 16 }, {
      hoursToExpiry: 168,
      fundingRateByCoin: { HYPE: 0.001 }, // big funding → notional 66 × 0.001 × 168 ≈ $11
    });
    expect(r.breaches.some((b) => /funding/i.test(b))).toBe(true);
  });

  it('floors funding PER COIN — a credit on one coin cannot mask a cost on another', () => {
    const hypeLong: RungRisk = { coin: 'HYPE', side: 'long', action: 'open', entryPx: 66, sizeCoins: 1, leverage: 2, stopPx: 56.5 };
    const btcShort: RungRisk = { coin: 'BTC', side: 'short', action: 'open', entryPx: 60000, sizeCoins: 0.001, leverage: 2, stopPx: 66000 };
    const r = computeLadderRisk([hypeLong, btcShort], { maxTotalNotionalUsd: null, maxTotalLossUsd: null }, {
      hoursToExpiry: 168,
      fundingRateByCoin: { HYPE: 0.0001, BTC: 0.0001 }, // HYPE long PAYS; BTC short RECEIVES (credit)
    });
    // The loss cap counts ONLY HYPE's ~$1.11 cost; the BTC credit must NOT net it down.
    expect(r.worstCaseLossWithFundingUsd - r.aggregateWorstCaseLossUsd).toBeCloseTo(1.109, 2);
    // The signed (display) figure nets to a small positive (~$0.10) — that's informational only.
    expect(r.expectedFundingUsd).toBeCloseTo(0.101, 2);
  });

  it('clamps a transient funding spike so it cannot falsely block a safe arm', () => {
    const r = computeLadderRisk([rung], { maxTotalNotionalUsd: null, maxTotalLossUsd: null }, {
      hoursToExpiry: 168,
      fundingRateByCoin: { HYPE: 0.05 }, // absurd spike → clamped to MAX_FUNDING_RATE_PER_HOUR
    });
    // clamped: 66 × 0.0025 × 168 ≈ $27.7, NOT the unclamped 66 × 0.05 × 168 ≈ $554.
    expect(r.worstCaseLossWithFundingUsd - r.aggregateWorstCaseLossUsd).toBeCloseTo(27.72, 1);
  });
});
