/**
 * Confidence Calculation Functions for Market Regime Detection
 * 
 * Separated from main detector for:
 * - Better testability
 * - Clearer separation of concerns
 * - Easier maintenance
 * 
 * All functions are pure (no side effects).
 */

import type { MarketRegime } from './market-regime-detector-cached';
import { calculatePriceMomentum } from './market-regime-detector-helpers';
import { getLatestIndicatorValue } from '../indicators/indicators';

// ============================================================================
// Base Confidence Calculation
// ============================================================================

/**
 * Calculate base confidence from signal metrics
 * Pure function - no side effects
 * 
 * @param combinedSignal Combined trend/momentum signal
 * @param signalStrength Signal strength (0-1)
 * @param trendMomentumAgreement Agreement between trend and momentum
 * @param avgTrendStrength Average trend strength
 * @param avgMomentumStrength Average momentum strength
 * @returns Base confidence (0-1)
 */
export function calculateBaseConfidence(
  combinedSignal: number,
  signalStrength: number,
  trendMomentumAgreement: number,
  avgTrendStrength: number,
  avgMomentumStrength: number
): number {
  const normalizedTrendStrength = Math.min(1, avgTrendStrength / 0.5);
  const normalizedMomentumStrength = Math.min(1, avgMomentumStrength / 0.5);
  
  return Math.abs(combinedSignal) * 0.85 + 
         signalStrength * 0.7 + 
         trendMomentumAgreement * 0.5 + 
         normalizedTrendStrength * 0.3 + 
         normalizedMomentumStrength * 0.3;
}

// ============================================================================
// Bullish Confidence Boosts
// ============================================================================

/**
 * Calculate confidence boosts for bullish regime
 * Pure function - no side effects
 * 
 * @param baseConfidence Base confidence before boosts
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param signalStrength Signal strength
 * @param combinedSignal Combined signal
 * @param trendMomentumAgreement Agreement between trend and momentum
 * @param volatility Current volatility
 * @param isPersistentTrend Whether trend has been persistent
 * @param sma20 SMA20 array (for alignment check)
 * @param sma50 SMA50 array (for alignment check)
 * @param sma200 SMA200 array (for alignment check, or null)
 * @returns Boosted confidence (0-1)
 */
export function calculateBullishConfidence(
  baseConfidence: number,
  prices: number[],
  currentIndex: number,
  signalStrength: number,
  combinedSignal: number,
  trendMomentumAgreement: number,
  volatility: number,
  isPersistentTrend: boolean,
  sma20: number[],
  sma50: number[],
  sma200: number[] | null
): number {
  let confidence = baseConfidence;
  const currentPrice = prices[currentIndex];
  const priceMomentum = calculatePriceMomentum(prices, currentIndex, 20);
  
  // Strong signals boost
  if (signalStrength > 0.45 && Math.abs(combinedSignal) > 0.12) {
    confidence = Math.min(1, confidence * 1.3);
  }
  
  // Persistent trend boost
  if (isPersistentTrend && signalStrength > 0.35 && Math.abs(combinedSignal) > 0.10) {
    confidence = Math.min(1, confidence * 1.6);
  }
  
  // Extremely strong signals boost
  if (signalStrength > 0.55 && Math.abs(combinedSignal) > 0.15 && trendMomentumAgreement > 0.35) {
    confidence = Math.min(1, confidence * 1.5);
  }
  
  // Moderate volatility boost (normal for bull runs)
  if (volatility > 0.02 && volatility < 0.10 && signalStrength > 0.4) {
    confidence = Math.min(1, confidence * 1.15);
  }
  
  // Clear bull run boost (price momentum + strong signals)
  if (priceMomentum > 0.02 && signalStrength > 0.3 && Math.abs(combinedSignal) > 0.06) {
    confidence = Math.min(1, confidence * 1.8);
  }
  
  // Very strong price momentum boosts
  if (priceMomentum > 0.03 && signalStrength > 0.35) {
    confidence = Math.min(1, confidence * 1.6);
  }
  if (priceMomentum > 0.05 && signalStrength > 0.4) {
    confidence = Math.min(1, confidence * 1.7);
  }
  if (priceMomentum > 0.10 && signalStrength > 0.45) {
    confidence = Math.min(1, confidence * 1.5);
  }
  if (priceMomentum > 0.20 && signalStrength > 0.5) {
    confidence = Math.min(1, confidence * 1.4);
  }
  
  // Aligned moving averages boost
  if (currentIndex >= 200 && sma200) {
    const sma20Value = getLatestIndicatorValue(sma20, currentIndex, 20);
    const sma50Value = getLatestIndicatorValue(sma50, currentIndex, 50);
    const sma200Value = getLatestIndicatorValue(sma200, currentIndex, 200);
    if (sma20Value !== null && sma50Value !== null && sma200Value !== null) {
      const alignedBullish = currentPrice > sma20Value && sma20Value > sma50Value && sma50Value > sma200Value;
      if (alignedBullish && signalStrength > 0.4) {
        confidence = Math.min(1, confidence * 1.2);
      }
    }
  }
  
  return confidence;
}

// ============================================================================
// Bearish Confidence Boosts
// ============================================================================

/**
 * Calculate confidence boosts for bearish regime
 * Pure function - no side effects
 * 
 * @param baseConfidence Base confidence before boosts
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param signalStrength Signal strength
 * @param combinedSignal Combined signal
 * @param trendMomentumAgreement Agreement between trend and momentum
 * @param volatility Current volatility
 * @param isPersistentTrend Whether trend has been persistent
 * @param sma20 SMA20 array (for alignment check)
 * @param sma50 SMA50 array (for alignment check)
 * @param sma200 SMA200 array (for alignment check, or null)
 * @returns Boosted confidence (0-1)
 */
export function calculateBearishConfidence(
  baseConfidence: number,
  prices: number[],
  currentIndex: number,
  signalStrength: number,
  combinedSignal: number,
  trendMomentumAgreement: number,
  volatility: number,
  isPersistentTrend: boolean,
  sma20: number[],
  sma50: number[],
  sma200: number[] | null
): number {
  let confidence = baseConfidence;
  const currentPrice = prices[currentIndex];
  const priceMomentum = calculatePriceMomentum(prices, currentIndex, 20);
  
  // Moderate volatility boost (normal for bear markets)
  if (volatility > 0.03 && volatility < 0.08 && signalStrength > 0.4) {
    confidence = Math.min(1, confidence * 1.15);
  }
  
  // Strong signals boost
  if (signalStrength > 0.45 && Math.abs(combinedSignal) > 0.12) {
    confidence = Math.min(1, confidence * 1.3);
  }
  
  // Persistent trend boost
  if (isPersistentTrend && signalStrength > 0.35 && Math.abs(combinedSignal) > 0.10) {
    confidence = Math.min(1, confidence * 1.6);
  }
  
  // Extremely strong signals boost
  if (signalStrength > 0.55 && Math.abs(combinedSignal) > 0.15 && trendMomentumAgreement > 0.35) {
    confidence = Math.min(1, confidence * 1.5);
  }
  
  // Clear bear market boost (price momentum + strong signals)
  if (priceMomentum < -0.02 && signalStrength > 0.3 && Math.abs(combinedSignal) > 0.06) {
    confidence = Math.min(1, confidence * 1.8);
  }
  
  // Very strong price momentum boosts
  if (priceMomentum < -0.03 && signalStrength > 0.35) {
    confidence = Math.min(1, confidence * 1.6);
  }
  if (priceMomentum < -0.05 && signalStrength > 0.4) {
    confidence = Math.min(1, confidence * 1.7);
  }
  if (priceMomentum < -0.10 && signalStrength > 0.45) {
    confidence = Math.min(1, confidence * 1.5);
  }
  if (priceMomentum < -0.20 && signalStrength > 0.5) {
    confidence = Math.min(1, confidence * 1.4);
  }
  
  // Moderate to high volatility boost (normal for bear markets)
  if (volatility > 0.03 && volatility < 0.12 && signalStrength > 0.4) {
    confidence = Math.min(1, confidence * 1.2);
  }
  
  // Aligned moving averages boost
  if (currentIndex >= 200 && sma200) {
    const sma20Value = getLatestIndicatorValue(sma20, currentIndex, 20);
    const sma50Value = getLatestIndicatorValue(sma50, currentIndex, 50);
    const sma200Value = getLatestIndicatorValue(sma200, currentIndex, 200);
    if (sma20Value !== null && sma50Value !== null && sma200Value !== null) {
      const alignedBearish = currentPrice < sma20Value && sma20Value < sma50Value && sma50Value < sma200Value;
      if (alignedBearish && signalStrength > 0.4) {
        confidence = Math.min(1, confidence * 1.2);
      }
    }
  }
  
  return confidence;
}

// ============================================================================
// Neutral Confidence Calculation
// ============================================================================

/**
 * Calculate confidence for neutral regime
 * Pure function - no side effects
 * 
 * @param signalUncertainty Signal uncertainty metric
 * @param isClearNeutral Whether this is a clear neutral condition (false breakout, squeeze, etc.)
 * @param isLowVolatilityChoppy Whether low volatility and choppy
 * @returns Confidence (0-1)
 */
export function calculateNeutralConfidence(
  signalUncertainty: number,
  isClearNeutral: boolean,
  isLowVolatilityChoppy: boolean
): number {
  if (isClearNeutral) {
    // Very clear neutral conditions - higher confidence
    return Math.max(0.5, Math.min(0.95, 0.8 - signalUncertainty * 0.2));
  } else if (isLowVolatilityChoppy) {
    // Clear neutral conditions - higher confidence
    return Math.max(0.4, Math.min(0.9, 0.75 - signalUncertainty * 0.25));
  } else {
    // Less clear neutral - moderate confidence
    return Math.max(0.3, Math.min(0.85, 0.65 - signalUncertainty * 0.35));
  }
}

// ============================================================================
// Confidence Calibration
// ============================================================================

/**
 * Apply confidence calibration based on signal agreement
 * Pure function - no side effects
 * 
 * @param confidence Current confidence
 * @param trend Trend value (-1 to 1)
 * @param momentum Momentum value (-1 to 1)
 * @param sma50Value SMA50 value (or null)
 * @param sma200Value SMA200 value (or null)
 * @param signalStrength Signal strength
 * @returns Calibrated confidence (0-1)
 */
export function calibrateConfidence(
  confidence: number,
  trend: number,
  momentum: number,
  sma50Value: number | null,
  sma200Value: number | null,
  signalStrength: number
): number {
  let multiplier = 1.0;
  
  // Agreement between trend and momentum
  if ((trend > 0 && momentum > 0) || (trend < 0 && momentum < 0)) {
    const agreement = Math.min(Math.abs(trend), Math.abs(momentum));
    if (agreement > 0.5) {
      multiplier *= 1.2; // Strong agreement
    } else if (agreement > 0.3) {
      multiplier *= 1.1; // Moderate agreement
    } else {
      multiplier *= 0.9; // Weak agreement - reduce confidence
    }
  } else {
    // Conflicting signals - reduce confidence significantly
    multiplier *= 0.7;
  }
  
  // Golden/Death Cross boost
  if (sma50Value !== null && sma200Value !== null) {
    const crossSignal = (sma50Value - sma200Value) / sma200Value;
    if (Math.abs(crossSignal) > 0.05) {
      multiplier *= 1.2;
    } else if (Math.abs(crossSignal) > 0.02) {
      multiplier *= 1.1;
    }
  }
  
  let calibrated = Math.min(1, confidence * multiplier);
  
  // Cap confidence based on signal strength
  if (signalStrength < 0.3) {
    calibrated = Math.min(calibrated, 0.5); // Cap at 50% for weak signals
  }
  if (signalStrength < 0.2) {
    calibrated = Math.min(calibrated, 0.3); // Cap at 30% for very weak signals
  }
  
  return calibrated;
}

// ============================================================================
// Correlation Context Adjustment
// ============================================================================

/**
 * Adjust confidence based on correlation context
 * Pure function - no side effects
 * 
 * @param confidence Current confidence
 * @param regime Current regime
 * @param correlationContext Correlation context from cross-asset analysis
 * @returns Adjusted confidence (0-1)
 */
export function adjustConfidenceForCorrelation(
  confidence: number,
  regime: MarketRegime,
  correlationContext?: {
    signal: number;
    riskLevel: 'low' | 'medium' | 'high';
  }
): number {
  if (!correlationContext) {
    return confidence;
  }
  
  const { signal: correlationSignal, riskLevel } = correlationContext;
  
  // Adjust based on risk level
  if (riskLevel === 'low') {
    confidence = Math.min(1, confidence * 1.15);
  } else if (riskLevel === 'high') {
    confidence = Math.max(0, confidence * 0.65);
  } else if (riskLevel === 'medium') {
    confidence = Math.max(0, confidence * 0.9);
  }
  
  // If correlation contradicts regime, reduce confidence
  const regimeSignal = regime === 'bullish' ? 1 : regime === 'bearish' ? -1 : 0;
  const alignment = correlationSignal * regimeSignal;
  
  if (regimeSignal !== 0 && alignment < -0.3) {
    confidence = Math.max(0, confidence * 0.6);
  }
  
  return confidence;
}
