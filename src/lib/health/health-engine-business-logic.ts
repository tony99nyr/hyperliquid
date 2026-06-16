/**
 * Health / probability engine — PURE composer (fully fixture-testable).
 *
 * Composes the vendored strategy pure-functions across 1d / 8h / 1h / 15m into:
 *   - a 0–100 health SCORE for the held position (higher TFs weight trend, lower
 *     TFs weight timing — weights from a versioned config),
 *   - P(continuation) + P(adverse) (normalized, with reserved residual
 *     uncertainty so they sum to < 1 — honest about what we don't know),
 *   - discrete ALERTS (bearish-divergence-1h, stop-within-1-ATR, regime-flip-8h,
 *     decline-detected).
 *
 * No I/O, no clock, no env — the candle sets, position, and weights all come in
 * as parameters. The I/O wrapper (health-engine.ts) fetches the candles + loads
 * the weights and calls this.
 */

import type { PriceCandle } from '@/types/trading-core';
import { detectMarketRegimeCached } from '@/lib/strategy/analysis/market-regime-detector-cached';
import { detectRSIDivergence, detectMACDDivergence } from '@/lib/strategy/analysis/divergence-detector';
import {
  detectPriceDecline,
  calculatePriceChanges,
} from '@/lib/strategy/analysis/price-decline-detector';
import { getATRValue } from '@/lib/strategy/indicators/indicators';
import type {
  HealthAlert,
  HealthPositionContext,
  HealthResult,
  HealthTimeframe,
  HealthWeights,
  MultiTimeframeCandles,
  TimeframeRegimeRead,
} from './health-engine-types';

const TIMEFRAME_ORDER: HealthTimeframe[] = ['1d', '8h', '1h', '15m'];

/** +1 bullish, -1 bearish, 0 neutral. */
function regimeSign(regime: 'bullish' | 'bearish' | 'neutral'): number {
  if (regime === 'bullish') return 1;
  if (regime === 'bearish') return -1;
  return 0;
}

/** +1 long, -1 short, 0 flat — the direction the position benefits from. */
function positionSign(side: HealthPositionContext['side']): number {
  if (side === 'long') return 1;
  if (side === 'short') return -1;
  return 0;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Read the regime for one timeframe. Returns weight 0 (so it drops out of the
 * weighted average) when there are too few candles for a meaningful read.
 */
function readTimeframe(
  timeframe: HealthTimeframe,
  candles: PriceCandle[] | undefined,
  weight: number,
): TimeframeRegimeRead {
  if (!candles || candles.length < 51) {
    return { timeframe, regime: 'neutral', confidence: 0, weight: 0 };
  }
  const signal = detectMarketRegimeCached(candles, candles.length - 1);
  return { timeframe, regime: signal.regime, confidence: signal.confidence, weight };
}

/** Most recent candle's close, or null if absent. */
function lastClose(candles: PriceCandle[] | undefined): number | null {
  if (!candles || candles.length === 0) return null;
  return candles[candles.length - 1]!.close;
}

/**
 * Emit alerts by composing the timing-timeframe detectors + position geometry.
 */
function computeAlerts(
  candles: MultiTimeframeCandles,
  reads: TimeframeRegimeRead[],
  position: HealthPositionContext,
  weights: HealthWeights,
): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const posSign = positionSign(position.side);

  // 1. Bearish divergence on the 1h timing chart (only meaningful for longs —
  //    a bearish divergence warns a long thesis). Checks RSI then MACD.
  const divTf = weights.alerts.divergenceTimeframe;
  const divCandles = candles[divTf];
  if (posSign >= 0 && divCandles && divCandles.length > 0) {
    const idx = divCandles.length - 1;
    const rsiDiv = detectRSIDivergence(divCandles, idx);
    const macdDiv = detectMACDDivergence(divCandles, idx);
    const bearish = [rsiDiv, macdDiv].find(
      (d) => d && d.type === 'bearish' && d.strength >= weights.alerts.divergenceMinStrength,
    );
    if (bearish) alerts.push('bearish-divergence-1h');
  }

  // 2. Regime flip on the 8h chart that OPPOSES the held position direction.
  const flipTf = weights.alerts.regimeFlipTimeframe;
  const flipRead = reads.find((r) => r.timeframe === flipTf);
  if (flipRead && flipRead.weight > 0 && posSign !== 0) {
    const opposes = regimeSign(flipRead.regime) === -posSign && flipRead.confidence > 0;
    if (opposes) alerts.push('regime-flip-8h');
  }

  // 3. Stop within 1 ATR — the position's stop is uncomfortably close to price.
  //    ATR is taken from the 1h timing chart (falls back to 15m).
  if (position.stopPx !== undefined && position.stopPx > 0) {
    const atrTf = candles['1h']?.length ? '1h' : '15m';
    const atrCandles = candles[atrTf];
    const px = lastClose(atrCandles);
    if (atrCandles && px !== null) {
      const atr = getATRValue(atrCandles, atrCandles.length - 1, 14);
      if (atr !== null && atr > 0) {
        const distance = Math.abs(px - position.stopPx);
        if (distance <= atr * weights.alerts.stopWithinAtrMultiplier) {
          alerts.push('stop-within-1-ATR');
        }
      }
    }
  }

  // 4. Decline detected on the timing chart (an adverse rapid drop hurts a long;
  //    a rapid rally hurts a short — detector is drop-only, so apply per side).
  const declineTf = candles['1h']?.length ? '1h' : '15m';
  const declineCandles = candles[declineTf];
  if (declineCandles && declineCandles.length > 0 && posSign !== 0) {
    const idx = declineCandles.length - 1;
    const changes = calculatePriceChanges(declineCandles, idx);
    if (posSign > 0) {
      // Long: a price decline is adverse.
      const px = lastClose(declineCandles)!;
      const decline = detectPriceDecline(px, {
        onePeriodAgo: changes.singlePeriod !== undefined ? px / (1 + changes.singlePeriod) : undefined,
        tenPeriodsAgo: changes.shortTerm !== undefined ? px / (1 + changes.shortTerm) : undefined,
        twentyPeriodsAgo: changes.mediumTerm !== undefined ? px / (1 + changes.mediumTerm) : undefined,
      });
      if (decline.isDecline) alerts.push('decline-detected');
    } else {
      // Short: a sharp rally (positive short-term change beyond threshold) is adverse.
      if (changes.shortTerm !== undefined && changes.shortTerm > 0.025) {
        alerts.push('decline-detected');
      }
    }
  }

  return alerts;
}

/**
 * Compute the composite health result. Pure: same inputs → same output.
 */
export function computeHealth(
  candles: MultiTimeframeCandles,
  position: HealthPositionContext,
  weights: HealthWeights,
): HealthResult {
  // 1. Per-timeframe regime reads (weighted; insufficient TFs drop to weight 0).
  const reads: TimeframeRegimeRead[] = TIMEFRAME_ORDER.map((tf) =>
    readTimeframe(tf, candles[tf], weights.timeframeWeights[tf]),
  );

  // 2. Weighted directional score in [-1, 1] (bull positive, bear negative).
  const totalWeight = reads.reduce((sum, r) => sum + r.weight, 0);
  const weightedSigned =
    totalWeight > 0
      ? reads.reduce((sum, r) => sum + regimeSign(r.regime) * r.confidence * r.weight, 0) /
        totalWeight
      : 0;

  // 3. Position-aligned score: positive when regimes favor the position. A flat
  //    position is assessed long-biased (a setup we are considering entering).
  const posSign = positionSign(position.side) || 1;
  const aligned = clamp(weightedSigned * posSign, -1, 1);

  // 4. Alignment bonus: extra credit when the timing + trend TFs both agree.
  const agreeingWeight = reads
    .filter((r) => r.weight > 0 && regimeSign(r.regime) * posSign > 0)
    .reduce((sum, r) => sum + r.weight, 0);
  const alignmentBonus =
    totalWeight > 0 ? (agreeingWeight / totalWeight) * weights.score.alignmentBonusMax : 0;

  // 5. Alerts + penalty.
  const alerts = computeAlerts(candles, reads, position, weights);
  const alertPenalty = Math.min(
    alerts.length * weights.score.alertPenaltyEach,
    weights.score.alertPenaltyMax,
  );

  // 6. Compose score in [0, 100].
  const rawScore =
    weights.score.neutralBaseline +
    aligned * weights.score.regimeSpan +
    alignmentBonus -
    alertPenalty;
  const score = clamp(rawScore, 0, 100);

  // 7. Probabilities — derive from the normalized score, reserve residual.
  //    A positive floor (0.01) GUARANTEES the documented invariant
  //    P(continuation) + P(adverse) < 1 (honest residual uncertainty) even if a
  //    weights config ships residualUncertainty: 0.
  const scoreUnit = score / 100; // 0..1
  const residual = clamp(weights.probability.residualUncertainty, 0.01, 0.9);
  const available = 1 - residual;
  const continuationShare = clamp(
    weights.probability.baseContinuation +
      (scoreUnit - 0.5) * 2 * weights.probability.scoreInfluence,
    0,
    1,
  );
  const pContinuation = continuationShare * available;
  const pAdverse = (1 - continuationShare) * available;

  return {
    score,
    pContinuation,
    pAdverse,
    alerts,
    timeframeReads: reads,
  };
}
