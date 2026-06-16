import { describe, it, expect } from 'vitest';
import type { PriceCandle } from '@/types/trading-core';
import { computeHealth } from '@/lib/health/health-engine-business-logic';
import type {
  HealthWeights,
  MultiTimeframeCandles,
  HealthPositionContext,
} from '@/lib/health/health-engine-types';

const WEIGHTS: HealthWeights = {
  version: 'test',
  timeframeWeights: { '1d': 0.35, '8h': 0.3, '1h': 0.2, '15m': 0.15 },
  score: {
    neutralBaseline: 50,
    regimeSpan: 50,
    alignmentBonusMax: 10,
    alertPenaltyEach: 8,
    alertPenaltyMax: 30,
  },
  probability: { baseContinuation: 0.5, scoreInfluence: 0.4, residualUncertainty: 0.1 },
  alerts: {
    divergenceTimeframe: '1h',
    divergenceMinStrength: 0.3,
    regimeFlipTimeframe: '8h',
    stopWithinAtrMultiplier: 1.0,
  },
};

const HOUR = 60 * 60 * 1000;

/** Deterministic candle series with a per-step compounding return. */
function series(count: number, start: number, stepReturn: number, stepMs = HOUR): PriceCandle[] {
  const out: PriceCandle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + stepReturn);
    out.push({
      timestamp: i * stepMs,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000,
    });
    price = close;
  }
  return out;
}

/** A strong, steady uptrend across all timeframes (every TF reads bullish). */
function allBull(): MultiTimeframeCandles {
  return {
    '1d': series(220, 1000, 0.01),
    '8h': series(220, 1000, 0.01),
    '1h': series(220, 1000, 0.01),
    '15m': series(220, 1000, 0.01),
  };
}

/** A strong, steady downtrend across all timeframes (every TF reads bearish). */
function allBear(): MultiTimeframeCandles {
  return {
    '1d': series(220, 5000, -0.01),
    '8h': series(220, 5000, -0.01),
    '1h': series(220, 5000, -0.01),
    '15m': series(220, 5000, -0.01),
  };
}

const longPos: HealthPositionContext = { side: 'long', entryPx: 1000 };

describe('computeHealth (PURE composer)', () => {
  it('a long aligned with an all-bull regime scores high with high P(continuation)', () => {
    const result = computeHealth(allBull(), longPos, WEIGHTS);

    expect(result.score).toBeGreaterThan(70);
    expect(result.pContinuation).toBeGreaterThan(result.pAdverse);
    // No regime-flip alert (8h is bullish, aligned with the long).
    expect(result.alerts).not.toContain('regime-flip-8h');
    // Probabilities are normalized with reserved residual (sum < 1).
    expect(result.pContinuation + result.pAdverse).toBeLessThanOrEqual(1 - WEIGHTS.probability.residualUncertainty + 1e-9);
    expect(result.pContinuation).toBeGreaterThanOrEqual(0);
    expect(result.pAdverse).toBeGreaterThanOrEqual(0);
  });

  it('a long into an all-bear regime scores low with high P(adverse) and a regime-flip alert', () => {
    const result = computeHealth(allBear(), longPos, WEIGHTS);

    expect(result.score).toBeLessThan(40);
    expect(result.pAdverse).toBeGreaterThan(result.pContinuation);
    // The 8h chart is bearish, opposing the long → regime flip alert fires.
    expect(result.alerts).toContain('regime-flip-8h');
  });

  it('GUARANTEES P(cont)+P(adverse) < 1 even when config sets residualUncertainty: 0', () => {
    const zeroResidual: HealthWeights = {
      ...WEIGHTS,
      probability: { ...WEIGHTS.probability, residualUncertainty: 0 },
    };
    const result = computeHealth(allBull(), longPos, zeroResidual);
    // The engine floors residual at 0.01, so the sum is strictly below 1.
    expect(result.pContinuation + result.pAdverse).toBeLessThan(1);
    expect(result.pContinuation).toBeGreaterThanOrEqual(0);
    expect(result.pAdverse).toBeGreaterThanOrEqual(0);
  });

  it('bull score strictly exceeds bear score for the same long position', () => {
    const bull = computeHealth(allBull(), longPos, WEIGHTS).score;
    const bear = computeHealth(allBear(), longPos, WEIGHTS).score;
    expect(bull).toBeGreaterThan(bear);
  });

  it('emits stop-within-1-ATR when the stop is hugging the price', () => {
    const candles = allBull();
    const px = candles['1h']![candles['1h']!.length - 1].close;
    const result = computeHealth(candles, { side: 'long', entryPx: 1000, stopPx: px * 0.999 }, WEIGHTS);
    expect(result.alerts).toContain('stop-within-1-ATR');
  });

  it('does NOT emit stop-within-1-ATR when the stop is far below price', () => {
    const candles = allBull();
    const px = candles['1h']![candles['1h']!.length - 1].close;
    const result = computeHealth(candles, { side: 'long', entryPx: 1000, stopPx: px * 0.5 }, WEIGHTS);
    expect(result.alerts).not.toContain('stop-within-1-ATR');
  });

  it('score and probabilities stay within bounds even with no candles', () => {
    const result = computeHealth({}, longPos, WEIGHTS);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    // No data → every TF weight 0 → neutral baseline score.
    expect(result.score).toBe(WEIGHTS.score.neutralBaseline);
    expect(result.timeframeReads.every((r) => r.weight === 0)).toBe(true);
  });

  it('surfaces per-timeframe regime reads with applied weights', () => {
    const result = computeHealth(allBull(), longPos, WEIGHTS);
    const tf1d = result.timeframeReads.find((r) => r.timeframe === '1d')!;
    expect(tf1d.weight).toBe(0.35);
    expect(tf1d.regime).toBe('bullish');
  });
});
