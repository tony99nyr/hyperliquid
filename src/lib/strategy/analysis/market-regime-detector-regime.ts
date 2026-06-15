/**
 * Regime Determination Logic for Market Regime Detection
 * 
 * Separated from main detector for:
 * - Better testability
 * - Clearer separation of concerns
 * - Easier maintenance
 * 
 * All functions are pure (no side effects).
 */

import {
  calculatePriceMomentum,
  detectFalseBreakout,
  detectVolatilitySqueeze,
  detectSidewaysMarket,
  detectSlowGrind,
  detectWhipsaw,
  detectTransitionPeriod,
} from './market-regime-detector-helpers';

// ============================================================================
// Regime Determination
// ============================================================================

/**
 * Determine if signal is near threshold (ambiguous)
 * Pure function - no side effects
 * 
 * @param combinedSignal Combined signal value
 * @param bullishThreshold Bullish threshold
 * @param signalStrength Signal strength
 * @returns True if signal is ambiguous
 */
export function isSignalNearThreshold(
  combinedSignal: number,
  bullishThreshold: number,
  signalStrength: number
): boolean {
  return signalStrength < 0.35 && 
         Math.abs(combinedSignal) < Math.abs(bullishThreshold) * 1.2 && 
         Math.abs(combinedSignal) > Math.abs(bullishThreshold) * 0.6;
}

/**
 * Check if bullish regime should be detected
 * Pure function - no side effects
 * 
 * @param combinedSignal Combined signal
 * @param bullishThreshold Bullish threshold
 * @param signalStrength Signal strength
 * @param bullishMinStrength Minimum strength for bullish
 * @param bullishMomentumConfirmed Whether momentum is confirmed
 * @param isNearThreshold Whether signal is near threshold
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param volatility Current volatility
 * @returns Object with detection result and reason
 */
export function shouldDetectBullish(
  combinedSignal: number,
  bullishThreshold: number,
  signalStrength: number,
  bullishMinStrength: number,
  bullishMomentumConfirmed: boolean,
  isNearThreshold: boolean,
  prices: number[],
  currentIndex: number,
  volatility: number
): {
  shouldDetect: boolean;
  reason?: string;
} {
  // Check basic conditions
  if (combinedSignal <= bullishThreshold || 
      signalStrength <= bullishMinStrength || 
      !bullishMomentumConfirmed || 
      isNearThreshold) {
    return { shouldDetect: false, reason: 'Basic conditions not met' };
  }
  
  // Check for false bull breakout
  const priceMomentum20 = calculatePriceMomentum(prices, currentIndex, 20);
  const priceMomentum5 = calculatePriceMomentum(prices, currentIndex, 5);
  const isWeakBullSignal = signalStrength < 0.25 || Math.abs(combinedSignal) < Math.abs(bullishThreshold) * 0.7;
  const isWeakBullMomentum = priceMomentum20 < 0.02 && signalStrength < 0.4;
  const isBullConsolidation = priceMomentum20 > -0.01 && priceMomentum20 < 0.01 && volatility < 0.05 && signalStrength < 0.35;
  
  if (priceMomentum20 < -0.015 || 
      (priceMomentum20 < -0.01 && priceMomentum5 < -0.005 && signalStrength < 0.5) ||
      (isWeakBullSignal && priceMomentum20 < 0.01) || 
      isWeakBullMomentum || 
      isBullConsolidation) {
    return { shouldDetect: false, reason: 'False bull breakout or weak momentum' };
  }
  
  return { shouldDetect: true };
}

/**
 * Check if bearish regime should be detected
 * Pure function - no side effects
 * 
 * @param combinedSignal Combined signal
 * @param bearishThreshold Bearish threshold
 * @param signalStrength Signal strength
 * @param bearishMinStrength Minimum strength for bearish
 * @param bearishMomentumConfirmed Whether momentum is confirmed
 * @param isNearThreshold Whether signal is near threshold
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param volatility Current volatility
 * @returns Object with detection result and reason
 */
export function shouldDetectBearish(
  combinedSignal: number,
  bearishThreshold: number,
  signalStrength: number,
  bearishMinStrength: number,
  bearishMomentumConfirmed: boolean,
  isNearThreshold: boolean,
  prices: number[],
  currentIndex: number,
  volatility: number
): {
  shouldDetect: boolean;
  reason?: string;
} {
  // Check basic conditions
  if (combinedSignal >= bearishThreshold || 
      signalStrength <= bearishMinStrength || 
      !bearishMomentumConfirmed || 
      isNearThreshold) {
    return { shouldDetect: false, reason: 'Basic conditions not met' };
  }
  
  // Check for false bear breakout
  const priceMomentum20 = calculatePriceMomentum(prices, currentIndex, 20);
  const priceMomentum5 = calculatePriceMomentum(prices, currentIndex, 5);
  const isWeakBearSignal = signalStrength < 0.25 || Math.abs(combinedSignal) < Math.abs(bearishThreshold) * 0.7;
  const isWeakBearMomentum = priceMomentum20 > -0.02 && signalStrength < 0.4;
  const isBearConsolidation = priceMomentum20 > -0.01 && priceMomentum20 < 0.01 && volatility < 0.05 && signalStrength < 0.35;
  const isFalseBullBreakoutPattern = priceMomentum20 < -0.01 && priceMomentum20 > -0.03 && signalStrength < 0.4 && 
                                     priceMomentum5 < -0.005 && priceMomentum5 > -0.02;
  
  if (priceMomentum20 > 0.015 || 
      (priceMomentum20 > 0.01 && priceMomentum5 > 0.005 && signalStrength < 0.5) ||
      (isWeakBearSignal && priceMomentum20 > -0.01) || 
      isWeakBearMomentum || 
      isBearConsolidation || 
      isFalseBullBreakoutPattern) {
    return { shouldDetect: false, reason: 'False bear breakout or weak momentum' };
  }
  
  return { shouldDetect: true };
}

/**
 * Check if neutral regime should be detected
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param combinedSignal Combined signal
 * @param signalStrength Signal strength
 * @param volatility Current volatility
 * @param trend Trend value
 * @param momentum Momentum value
 * @param baseThreshold Base threshold
 * @param bullishThreshold Bullish threshold
 * @param regimeHistory Recent regime history
 * @returns Object with detection result and pattern details
 */
export function shouldDetectNeutral(
  prices: number[],
  currentIndex: number,
  combinedSignal: number,
  signalStrength: number,
  volatility: number,
  trend: number,
  momentum: number,
  baseThreshold: number,
  bullishThreshold: number,
  regimeHistory: Array<'bullish' | 'bearish' | 'neutral'>
): {
  shouldDetect: boolean;
  isClearNeutral: boolean;
  isLowVolatilityChoppy: boolean;
} {
  // Detect patterns
  const falseBreakout = detectFalseBreakout(prices, currentIndex);
  const volatilitySqueeze = detectVolatilitySqueeze(prices, currentIndex, volatility, signalStrength, combinedSignal);
  const isSideways = detectSidewaysMarket(prices, currentIndex, volatility);
  const isSlowGrind = detectSlowGrind(prices, currentIndex, volatility, signalStrength);
  const isWhipsaw = detectWhipsaw(regimeHistory);
  const isTransitionPeriod = detectTransitionPeriod(regimeHistory);
  const isNearThreshold = isSignalNearThreshold(combinedSignal, bullishThreshold, signalStrength);
  
  // Calculate price momentum for neutral detection
  let priceMomentumForNeutral = 0;
  if (currentIndex >= 20) {
    priceMomentumForNeutral = calculatePriceMomentum(prices, currentIndex, 20);
  }
  
  // Neutral conditions
  const isLowVolatility = volatility < 0.05;
  const isChoppy = signalStrength < 0.3;
  const isConflicting = (trend > 0 && momentum < 0) || (trend < 0 && momentum > 0);
  const isAmbiguous = isNearThreshold || (Math.abs(combinedSignal) < Math.abs(bullishThreshold) * 1.3 && 
                          Math.abs(combinedSignal) > Math.abs(bullishThreshold) * 0.5);
  
  // Determine if should be neutral
  const shouldDetect = 
    falseBreakout.isFalseBreakout || 
    volatilitySqueeze.isVolatilitySqueeze || 
    volatilitySqueeze.isVolatilitySqueezePattern || 
    volatilitySqueeze.isVolatilityTransition || 
    isSideways || 
    isWhipsaw || 
    isLowVolatility || 
    isChoppy || 
    isConflicting || 
    isTransitionPeriod || 
    isAmbiguous || 
    isSlowGrind ||
    Math.abs(combinedSignal) < baseThreshold * 0.65 ||
    (signalStrength < 0.28 && volatility < 0.05) ||
    (volatility < 0.045 && signalStrength < 0.38 && Math.abs(combinedSignal) < 0.09) ||
    (Math.abs(combinedSignal) < baseThreshold * 0.75 && signalStrength < 0.32) ||
    (signalStrength < 0.32 && Math.abs(combinedSignal) < baseThreshold * 0.85) ||
    (volatility < 0.05 && Math.abs(priceMomentumForNeutral) < 0.02 && signalStrength < 0.35) ||
    (volatility < 0.05 && Math.abs(priceMomentumForNeutral) < 0.025 && signalStrength < 0.38 && Math.abs(combinedSignal) < baseThreshold * 0.7);
  
  // Determine if clear neutral
  const isClearNeutral = 
    falseBreakout.isFalseBreakout || 
    volatilitySqueeze.isVolatilitySqueeze || 
    volatilitySqueeze.isVolatilitySqueezePattern || 
    volatilitySqueeze.isVolatilityTransition || 
    isSideways || 
    isWhipsaw || 
    isTransitionPeriod || 
    isSlowGrind;
  
  // Determine if low volatility and choppy
  const isLowVolatilityChoppy = isLowVolatility && isChoppy;
  
  return { shouldDetect, isClearNeutral, isLowVolatilityChoppy };
}
