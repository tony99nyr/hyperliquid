/**
 * Recovery Detector
 *
 * Pure function that detects market recovery conditions after a crash.
 * Uses multiple technical indicators to score recovery strength,
 * enabling smarter early exit from crash recovery periods.
 *
 * Signals used:
 * 1. Price recovery % — how much of the crash drop has been recovered
 * 2. RSI oversold bounce — RSI coming off oversold and rising
 * 3. OBV momentum — buying volume exceeding selling volume
 * 4. MACD histogram improvement — momentum building from the trough
 * 5. Volume ROC — volume activity increasing during recovery
 * 6. Short-term price momentum — recent candles showing upward movement
 *
 * Each signal produces a 0-1 sub-score. Final score is a weighted average.
 * The score feeds into crash-detection.ts to allow dynamic early exit
 * from crash recovery periods when indicators confirm genuine recovery.
 */

import type { PriceCandle } from '@/types';
import { calculateRSI, calculateMACD } from '../indicators/indicators';
import { calculateOBV, calculateVolumeROC } from '../indicators/volume-indicators';

/**
 * Configuration for recovery detection (loaded from strategy JSON)
 */
export interface RecoveryDetectionConfig {
  enabled: boolean;
  /** Score threshold to trigger early recovery exit (0-1, default: 0.55) */
  scoreThreshold?: number;
  /** Minimum crash recovery periods elapsed before detection activates (default: 2) */
  minPeriodsBeforeDetection?: number;
  /** RSI threshold — below this counts as oversold for recovery signal (default: 35) */
  rsiOversoldThreshold?: number;
  /** Volume ROC threshold — above this indicates recovery volume (default: 20 = 20%) */
  volumeRocThreshold?: number;
  /** Weight multiplier for price recovery sub-score (default: 0.20) */
  priceRecoveryWeight?: number;
  /** Weight multiplier for RSI bounce sub-score (default: 0.20) */
  rsiBounceWeight?: number;
  /** Weight multiplier for OBV momentum sub-score (default: 0.20) */
  obvMomentumWeight?: number;
  /** Weight multiplier for MACD histogram sub-score (default: 0.15) */
  macdHistogramWeight?: number;
  /** Weight multiplier for volume ROC sub-score (default: 0.10) */
  volumeRocWeight?: number;
  /** Weight multiplier for short-term momentum sub-score (default: 0.15) */
  shortTermMomentumWeight?: number;
}

/**
 * Result from recovery detection analysis
 */
export interface RecoverySignal {
  /** Overall recovery score (0-1). Higher = stronger recovery evidence */
  score: number;
  /** Individual sub-scores for transparency/debugging */
  indicators: {
    priceRecovery: number;
    rsiBounce: number;
    obvMomentum: number;
    macdHistogram: number;
    volumeRoc: number;
    shortTermMomentum: number;
  };
  /** Whether score exceeds threshold (convenience flag) */
  triggered: boolean;
}

// Default weights sum to 1.0
const DEFAULT_WEIGHTS = {
  priceRecovery: 0.20,
  rsiBounce: 0.20,
  obvMomentum: 0.20,
  macdHistogram: 0.15,
  volumeRoc: 0.10,
  shortTermMomentum: 0.15,
} as const;

const DEFAULT_SCORE_THRESHOLD = 0.55;
const DEFAULT_RSI_OVERSOLD_THRESHOLD = 35;
const DEFAULT_VOLUME_ROC_THRESHOLD = 20;

/**
 * Detect recovery signals from candle data after a crash.
 *
 * Pure function — no side effects, no state mutation.
 *
 * @param candles - Full candle array (not sliced)
 * @param currentIndex - Current position in the candle array
 * @param crashPrice - Price at which the crash was detected
 * @param config - Recovery detection configuration
 * @returns RecoverySignal with score and sub-indicators
 */
export function detectRecoverySignal(
  candles: PriceCandle[],
  currentIndex: number,
  crashPrice: number,
  config?: RecoveryDetectionConfig
): RecoverySignal {
  const threshold = config?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;

  // Guard: need enough candles for indicator calculation
  if (currentIndex < 20 || candles.length <= currentIndex) {
    return createEmptySignal(threshold);
  }

  const currentPrice = candles[currentIndex]!.close;
  const prices = candles.slice(0, currentIndex + 1).map((c) => c.close);
  const relevantCandles = candles.slice(0, currentIndex + 1);

  // 1. Price recovery score
  const priceRecoveryScore = scorePriceRecovery(currentPrice, crashPrice);

  // 2. RSI oversold bounce score
  const rsiOversoldThreshold = config?.rsiOversoldThreshold ?? DEFAULT_RSI_OVERSOLD_THRESHOLD;
  const rsiBounceScore = scoreRSIBounce(prices, rsiOversoldThreshold);

  // 3. OBV momentum score
  const obvMomentumScore = scoreOBVMomentum(relevantCandles, currentIndex);

  // 4. MACD histogram improvement score
  const macdHistogramScore = scoreMACDHistogram(prices);

  // 5. Volume ROC score
  const volumeRocThreshold = config?.volumeRocThreshold ?? DEFAULT_VOLUME_ROC_THRESHOLD;
  const volumeRocScore = scoreVolumeROC(relevantCandles, currentIndex, volumeRocThreshold);

  // 6. Short-term momentum score
  const shortTermMomentumScore = scoreShortTermMomentum(prices);

  // Weighted average using configured or default weights
  const weights = {
    priceRecovery: config?.priceRecoveryWeight ?? DEFAULT_WEIGHTS.priceRecovery,
    rsiBounce: config?.rsiBounceWeight ?? DEFAULT_WEIGHTS.rsiBounce,
    obvMomentum: config?.obvMomentumWeight ?? DEFAULT_WEIGHTS.obvMomentum,
    macdHistogram: config?.macdHistogramWeight ?? DEFAULT_WEIGHTS.macdHistogram,
    volumeRoc: config?.volumeRocWeight ?? DEFAULT_WEIGHTS.volumeRoc,
    shortTermMomentum: config?.shortTermMomentumWeight ?? DEFAULT_WEIGHTS.shortTermMomentum,
  };

  const totalWeight =
    weights.priceRecovery +
    weights.rsiBounce +
    weights.obvMomentum +
    weights.macdHistogram +
    weights.volumeRoc +
    weights.shortTermMomentum;

  const score =
    totalWeight > 0
      ? (priceRecoveryScore * weights.priceRecovery +
          rsiBounceScore * weights.rsiBounce +
          obvMomentumScore * weights.obvMomentum +
          macdHistogramScore * weights.macdHistogram +
          volumeRocScore * weights.volumeRoc +
          shortTermMomentumScore * weights.shortTermMomentum) /
        totalWeight
      : 0;

  return {
    score: Math.max(0, Math.min(1, score)),
    indicators: {
      priceRecovery: priceRecoveryScore,
      rsiBounce: rsiBounceScore,
      obvMomentum: obvMomentumScore,
      macdHistogram: macdHistogramScore,
      volumeRoc: volumeRocScore,
      shortTermMomentum: shortTermMomentumScore,
    },
    triggered: score >= threshold,
  };
}

/**
 * Score price recovery from crash bottom.
 * 0% recovery = 0, 30% recovery = 0.5, 50%+ = 1.0
 * Uses a sigmoid-like curve so moderate recoveries still score well.
 */
function scorePriceRecovery(currentPrice: number, crashPrice: number): number {
  if (crashPrice <= 0) return 0;

  const recovery = (currentPrice - crashPrice) / crashPrice;

  // Negative = still below crash price
  if (recovery <= 0) return 0;
  // 50%+ recovery = max score
  if (recovery >= 0.5) return 1.0;

  // Sigmoid-like scaling: moderate recoveries score well
  // At 10% recovery: ~0.33, at 20%: ~0.6, at 30%: ~0.8
  return Math.min(1.0, recovery * 3.33 * (1 - recovery * 0.5));
}

/**
 * Score RSI oversold bounce.
 * High score when RSI is coming off oversold and rising.
 */
function scoreRSIBounce(prices: number[], oversoldThreshold: number): number {
  const rsi = calculateRSI(prices, 14);
  if (rsi.length < 3) return 0;

  const currentRSI = rsi[rsi.length - 1]!;
  const prevRSI = rsi[rsi.length - 2]!;
  const prev2RSI = rsi[rsi.length - 3]!;

  // RSI was recently oversold and is now rising
  const wasOversold = prevRSI < oversoldThreshold || prev2RSI < oversoldThreshold;
  const isRising = currentRSI > prevRSI;
  const risingFromBelow = currentRSI < 55; // Not yet overbought

  if (!wasOversold) return 0;
  if (!isRising) return 0.1; // Was oversold but not rising yet

  // Score based on how much RSI has risen from oversold
  const riseFromOversold = currentRSI - Math.min(prevRSI, prev2RSI);
  const normalizedRise = Math.min(1.0, riseFromOversold / 20); // 20 RSI points = max

  return risingFromBelow ? normalizedRise : normalizedRise * 0.7;
}

/**
 * Score OBV momentum — positive OBV trend indicates buying pressure.
 */
function scoreOBVMomentum(candles: PriceCandle[], currentIndex: number): number {
  const obv = calculateOBV(candles);
  if (obv.length < 6 || currentIndex >= obv.length) return 0;

  const currentOBV = obv[currentIndex]!;
  // Compare to 3 and 5 periods ago
  const obv3Ago = currentIndex >= 3 ? obv[currentIndex - 3]! : null;
  const obv5Ago = currentIndex >= 5 ? obv[currentIndex - 5]! : null;

  let score = 0;

  // 3-period OBV momentum
  if (obv3Ago !== null) {
    const shortMomentum = currentOBV - obv3Ago;
    if (shortMomentum > 0) score += 0.5;
  }

  // 5-period OBV momentum (longer confirmation)
  if (obv5Ago !== null) {
    const longMomentum = currentOBV - obv5Ago;
    if (longMomentum > 0) score += 0.5;
  }

  return score;
}

/**
 * Score MACD histogram improvement.
 * High score when histogram is negative but improving (less negative or turning positive).
 */
function scoreMACDHistogram(prices: number[]): number {
  const { histogram } = calculateMACD(prices, 12, 26, 9);
  if (histogram.length < 3) return 0;

  const current = histogram[histogram.length - 1]!;
  const prev = histogram[histogram.length - 2]!;
  const prev2 = histogram[histogram.length - 3]!;

  // Already positive and rising = strong recovery
  if (current > 0 && current > prev) return 1.0;

  // Turning positive = good
  if (current > 0 && prev <= 0) return 0.9;

  // Still negative but improving (less negative)
  if (current < 0 && current > prev) {
    // Consecutive improvement is a stronger signal
    const consecutiveImprovement = prev > prev2;
    const improvementRate = prev !== 0 ? (current - prev) / Math.abs(prev) : 0;

    let score = Math.min(0.7, Math.abs(improvementRate));
    if (consecutiveImprovement) score = Math.min(0.8, score + 0.2);
    return score;
  }

  return 0;
}

/**
 * Score volume rate of change — spike in volume during recovery suggests conviction.
 */
function scoreVolumeROC(
  candles: PriceCandle[],
  currentIndex: number,
  rocThreshold: number
): number {
  const vroc = calculateVolumeROC(candles, 5, currentIndex);
  if (vroc === null) return 0;

  // Volume increasing significantly
  if (vroc >= rocThreshold * 2) return 1.0;
  if (vroc >= rocThreshold) return 0.7;
  if (vroc >= rocThreshold * 0.5) return 0.4;
  if (vroc > 0) return 0.2;
  return 0;
}

/**
 * Score short-term price momentum — last 3 candles showing upward movement.
 */
function scoreShortTermMomentum(prices: number[]): number {
  if (prices.length < 4) return 0;

  const current = prices[prices.length - 1]!;
  const p1 = prices[prices.length - 2]!;
  const p2 = prices[prices.length - 3]!;
  const p3 = prices[prices.length - 4]!;

  // Count consecutive up candles
  const up1 = current > p1;
  const up2 = p1 > p2;
  const up3 = p2 > p3;

  const upCount = (up1 ? 1 : 0) + (up2 ? 1 : 0) + (up3 ? 1 : 0);

  // 3/3 up = 1.0, 2/3 = 0.6, 1/3 = 0.3, 0/3 = 0
  if (upCount === 3) return 1.0;
  if (upCount === 2 && up1) return 0.7; // Recent upward is more valuable
  if (upCount === 2) return 0.5;
  if (upCount === 1 && up1) return 0.35;
  if (upCount === 1) return 0.15;
  return 0;
}

/**
 * Create an empty recovery signal (no recovery detected)
 */
function createEmptySignal(threshold: number): RecoverySignal {
  return {
    score: 0,
    indicators: {
      priceRecovery: 0,
      rsiBounce: 0,
      obvMomentum: 0,
      macdHistogram: 0,
      volumeRoc: 0,
      shortTermMomentum: 0,
    },
    triggered: 0 >= threshold,
  };
}
