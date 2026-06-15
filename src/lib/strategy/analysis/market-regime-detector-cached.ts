/**
 * Optimized Market Regime Detector with Cached Indicators
 * Caches indicator calculations to avoid recalculating on every call
 */

import type { PriceCandle } from '@/types';
import { calculateSMA, calculateEMA, calculateMACD, calculateRSI, getLatestIndicatorValue } from '../indicators/indicators';
import { detectRSIDivergence, detectMACDDivergence, type DivergenceSignal } from './divergence-detector';
import type { RegimeDetectionConfig } from '../config/regime-detection-config';
import { DEFAULT_REGIME_DETECTION_CONFIG } from '../config/regime-detection-config';

// Import helper functions for better separation of concerns
import {
  calculateTrendScore,
  calculateMomentumScore,
  calculateVolatility,
  detectFalseBreakout,
  detectTrapPattern,
  type RegimeBreakdownSignal,
} from './market-regime-detector-helpers';
import {
  calculateBaseConfidence,
  calculateBullishConfidence,
  calculateBearishConfidence,
  calculateNeutralConfidence,
  calibrateConfidence,
  adjustConfidenceForCorrelation,
} from './market-regime-detector-confidence';
import {
  shouldDetectBullish,
  shouldDetectBearish,
  shouldDetectNeutral,
  isSignalNearThreshold,
} from './market-regime-detector-regime';

export type MarketRegime = 'bullish' | 'bearish' | 'neutral';

export interface MarketRegimeSignal {
  regime: MarketRegime;
  confidence: number; // 0-1, how confident we are in the regime
  indicators: {
    trend: number; // -1 to +1, overall trend direction
    momentum: number; // -1 to +1, momentum strength
    volatility: number; // 0-1, current volatility level
    divergence?: number; // -1 to +1, divergence signal (positive = bullish divergence)
  };
  divergenceSignal?: DivergenceSignal; // Details of detected divergence
  combinedSignal?: number; // Smoothed combined signal used for regime determination
  rawCombinedSignal?: number; // Raw (unsmoothed) combined signal for current period
  breakdown?: RegimeBreakdown; // Detailed sub-signal breakdown for UI inspection
}

export type { RegimeBreakdownSignal } from './market-regime-detector-helpers';

export interface RegimeBreakdown {
  trendSignals: RegimeBreakdownSignal[];
  momentumSignals: RegimeBreakdownSignal[];
  signalSummary: {
    rawCombined: number;
    smoothedCombined: number;
    signalStrength: number;
    trendScore: number;
    momentumScore: number;
    bullishThreshold: number;
    bearishThreshold: number;
    /** Effective bullish threshold (accounts for hysteresis — lower when already bullish) */
    effectiveBullishThreshold: number;
    /** Effective bearish threshold (accounts for hysteresis — closer to 0 when already bearish) */
    effectiveBearishThreshold: number;
    trendWeight: number;
    momentumWeight: number;
    divergenceWeight: number;
    divergenceScore: number;
    divergenceType: string | null;
  };
  trapDetected: boolean;
  trapReductionFactor: number;
}

// Cache for indicator calculations
interface IndicatorCache {
  sma20: number[] | null;
  sma50: number[] | null;
  sma200: number[] | null;
  ema12: number[] | null;
  ema26: number[] | null;
  macd: { macd: number[]; signal: number[]; histogram: number[] } | null;
  rsi: number[] | null;
  prices: number[] | null;
  smoothedCombinedSignal: number[] | null; // EMA-smoothed combined signal for regime detection
  lastRegime: 'bullish' | 'bearish' | 'neutral' | null; // Track last regime for hysteresis
  regimeHistory: Array<'bullish' | 'bearish' | 'neutral'>; // Track regime history for persistence
  lastCandleCount: number;
}

let indicatorCache: IndicatorCache = {
  sma20: null,
  sma50: null,
  sma200: null,
  ema12: null,
  ema26: null,
  macd: null,
  rsi: null,
  prices: null,
  smoothedCombinedSignal: null,
  lastRegime: null,
  regimeHistory: [],
  lastCandleCount: 0,
};

/**
 * Initialize or update indicator cache
 */
function ensureIndicatorsCached(candles: PriceCandle[]): void {
  const prices = candles.map(c => c.close);
  
  // Only recalculate if candles changed
  if (indicatorCache.prices === null || 
      indicatorCache.lastCandleCount !== candles.length ||
      indicatorCache.prices.length !== prices.length ||
      indicatorCache.prices[indicatorCache.prices.length - 1] !== prices[prices.length - 1]) {
    
    // Recalculate all indicators
    indicatorCache.prices = prices;
    indicatorCache.sma20 = calculateSMA(prices, 20);
    indicatorCache.sma50 = calculateSMA(prices, 50);
    indicatorCache.sma200 = prices.length >= 200 ? calculateSMA(prices, 200) : null;
    indicatorCache.ema12 = calculateEMA(prices, 12);
    indicatorCache.ema26 = calculateEMA(prices, 26);
    indicatorCache.macd = calculateMACD(prices, 12, 26, 9);
    indicatorCache.rsi = calculateRSI(prices, 14);
    // Reset smoothed signal cache when candles change (new dataset)
    indicatorCache.smoothedCombinedSignal = null;
    indicatorCache.lastRegime = null;
    indicatorCache.regimeHistory = [];
    indicatorCache.lastCandleCount = candles.length;
  }
}

/**
 * Optimized market regime detection with cached indicators
 * 
 * @param candles Price candles
 * @param currentIndex Current candle index
 * @param config Optional regime detection config (uses defaults if not provided)
 * @param correlationContext Optional correlation context from cross-asset analysis
 */
export function detectMarketRegimeCached(
  candles: PriceCandle[],
  currentIndex: number,
  config?: RegimeDetectionConfig,
  correlationContext?: {
    signal: number; // -1 to 1, correlation-based signal
    riskLevel: 'low' | 'medium' | 'high';
  }
): MarketRegimeSignal {
  // Use provided config or defaults
  const regimeConfig = config ?? DEFAULT_REGIME_DETECTION_CONFIG;
  // Ensure indicators are cached
  ensureIndicatorsCached(candles);
  
  if (currentIndex < 50) {
    return {
      regime: 'neutral',
      confidence: 0,
      indicators: {
        trend: 0,
        momentum: 0,
        volatility: 0,
      },
    };
  }

  const prices = indicatorCache.prices!;
  const currentPrice = prices[currentIndex];

  // Use cached indicators
  const sma20 = indicatorCache.sma20!;
  const sma50 = indicatorCache.sma50!;
  const sma200 = indicatorCache.sma200;
  const ema12 = indicatorCache.ema12!;
  const ema26 = indicatorCache.ema26!;
  const { macd, signal, histogram } = indicatorCache.macd!;
  const rsi = indicatorCache.rsi!;

  const sma20Value = getLatestIndicatorValue(sma20, currentIndex, 19);
  const sma50Value = getLatestIndicatorValue(sma50, currentIndex, 49);
  const sma200Value = sma200 ? getLatestIndicatorValue(sma200, currentIndex, 199) : null;
  const ema12Value = getLatestIndicatorValue(ema12, currentIndex, 11);
  const ema26Value = getLatestIndicatorValue(ema26, currentIndex, 25);

  // Calculate trend using extracted pure function (DRY - eliminates duplication)
  const { trend, avgTrendStrength, subSignals: trendSubSignals } = calculateTrendScore(
    currentPrice,
    sma20Value,
    sma50Value,
    sma200Value,
    ema12Value,
    ema26Value
  );

  // Calculate momentum using extracted pure function (DRY - eliminates duplication)
  const histogramValue = getLatestIndicatorValue(histogram, currentIndex, 34);
  const macdValue = getLatestIndicatorValue(macd, currentIndex, 34);
  const signalValue = getLatestIndicatorValue(signal, currentIndex, 34);
  const rsiValue = getLatestIndicatorValue(rsi, currentIndex, 14);

  const { momentum, avgMomentumStrength, subSignals: momentumSubSignals } = calculateMomentumScore(
    prices,
    currentIndex,
    histogramValue,
    macdValue,
    signalValue,
    rsiValue
  );

  // Divergence Detection
  let divergenceScore = 0;
  let divergenceSignal: DivergenceSignal | null = null;
  
  // Check for RSI divergence
  const rsiDivergence = detectRSIDivergence(candles, currentIndex);
  if (rsiDivergence) {
    divergenceSignal = rsiDivergence;
    // Bullish divergence is positive (potential reversal up)
    // Bearish divergence is negative (potential reversal down)
    if (rsiDivergence.type === 'bullish') {
      divergenceScore += rsiDivergence.strength * 0.5;
    } else if (rsiDivergence.type === 'bearish') {
      divergenceScore -= rsiDivergence.strength * 0.5;
    } else if (rsiDivergence.type === 'hidden-bullish') {
      divergenceScore += rsiDivergence.strength * 0.3; // Hidden divergence (trend continuation)
    } else if (rsiDivergence.type === 'hidden-bearish') {
      divergenceScore -= rsiDivergence.strength * 0.3;
    }
  }
  
  // Check for MACD divergence
  const macdDivergence = detectMACDDivergence(candles, currentIndex);
  if (macdDivergence) {
    // Use MACD divergence if stronger, or combine if both present
    if (!divergenceSignal || macdDivergence.strength > divergenceSignal.strength) {
      divergenceSignal = macdDivergence;
    }
    if (macdDivergence.type === 'bullish') {
      divergenceScore += macdDivergence.strength * 0.5;
    } else if (macdDivergence.type === 'bearish') {
      divergenceScore -= macdDivergence.strength * 0.5;
    } else if (macdDivergence.type === 'hidden-bullish') {
      divergenceScore += macdDivergence.strength * 0.3;
    } else if (macdDivergence.type === 'hidden-bearish') {
      divergenceScore -= macdDivergence.strength * 0.3;
    }
  }
  
  // Clamp divergence score to [-1, 1]
  divergenceScore = Math.max(-1, Math.min(1, divergenceScore));

  // Calculate volatility using extracted pure function (DRY)
  const volatility = calculateVolatility(prices, currentIndex, 20);

  // Combine trend, momentum, and divergence
  // Divergence acts as a warning signal - it can moderate the overall signal
  // Weight is now configurable per-asset via regimeConfig.divergenceWeight
  // Session 28 found: ETH benefits from 0.15 (+1.55% avg), BTC optimal at 0.10
  // Remaining weight split: trend (trendMomentumShare/2), momentum (trendMomentumShare/2)
  const divergenceWeight = regimeConfig.divergenceWeight;
  const trendMomentumShare = (1 - divergenceWeight) / 2; // Split remaining equally
  const rawCombinedSignal = (trend * trendMomentumShare + momentum * trendMomentumShare + divergenceScore * divergenceWeight);
  const signalStrength = (avgTrendStrength + avgMomentumStrength) / 2;
  
  // Apply smoothing to reduce noise (financial professionals use this)
  // Calculate simple moving average of recent raw signals for this index
  // This works for both sequential (signal simulation) and historical (chart) calculations
  const smoothingPeriod = 5;
  let combinedSignal = rawCombinedSignal;
  
  if (currentIndex >= 50 + smoothingPeriod - 1) {
    // Calculate raw signals for recent periods and average them
    // Use extracted pure functions for trend/momentum calculation (DRY - eliminates duplication)
    const recentRawSignals: number[] = [rawCombinedSignal];
    for (let i = 1; i < smoothingPeriod && currentIndex - i >= 50; i++) {
      const prevIdx = currentIndex - i;
      const prevPrice = prices[prevIdx]!;
      
      // Recalculate trend for previous index using extracted function (DRY)
      const prevSma20 = getLatestIndicatorValue(sma20, prevIdx, 19);
      const prevSma50 = getLatestIndicatorValue(sma50, prevIdx, 49);
      const prevSma200 = sma200 ? getLatestIndicatorValue(sma200, prevIdx, 199) : null;
      const prevEma12 = getLatestIndicatorValue(ema12, prevIdx, 11);
      const prevEma26 = getLatestIndicatorValue(ema26, prevIdx, 25);
      
      const { trend: prevTrend } = calculateTrendScore(
        prevPrice,
        prevSma20,
        prevSma50,
        prevSma200,
        prevEma12,
        prevEma26
      );
      
      // Recalculate momentum for previous index using extracted function (DRY)
      const prevHistogram = getLatestIndicatorValue(histogram, prevIdx, 34);
      const prevMacd = getLatestIndicatorValue(macd, prevIdx, 34);
      const prevSignal = getLatestIndicatorValue(signal, prevIdx, 34);
      const prevRsi = getLatestIndicatorValue(rsi, prevIdx, 14);
      
      const { momentum: prevMomentum } = calculateMomentumScore(
        prices,
        prevIdx,
        prevHistogram,
        prevMacd,
        prevSignal,
        prevRsi
      );
      
      // Use same weights as current signal (trend 45%, momentum 45%, divergence 10%)
      // For historical signals, we don't recalculate divergence, so use 50/50 split
      recentRawSignals.push((prevTrend * 0.5 + prevMomentum * 0.5));
    }
    
    // Use simple average (SMA) for smoothing - more stable than EMA for historical calculations
    combinedSignal = recentRawSignals.reduce((a, b) => a + b, 0) / recentRawSignals.length;
  }
  
  // Hysteresis: Different thresholds for entering vs exiting regimes
  // This prevents whipsaw - once in a regime, you need stronger signal to exit
  // Financial professionals use this to reduce false signals
  // CRITICAL FIX: Use config thresholds instead of hardcoded values
  const baseThreshold = regimeConfig.regimeConfidenceThreshold;
  const momentumThreshold = regimeConfig.momentumConfirmationThreshold;
  
  // IMPROVED: Bear-specific threshold adjustments
  const bearThresholdMultiplier = regimeConfig.bearThresholdMultiplier ?? 0.85;
  const bearMomentumMultiplier = regimeConfig.bearMomentumMultiplier ?? 0.85;
  
  // Entry thresholds: require full confidence threshold
  const bullishEntryThreshold = baseThreshold;
  const bearishEntryThreshold = -baseThreshold * bearThresholdMultiplier; // More lenient for bear markets
  
  // Exit thresholds: use 50% of entry threshold for hysteresis (prevents rapid switching)
  const bullishExitThreshold = baseThreshold * 0.5;
  const bearishExitThreshold = -baseThreshold * bearThresholdMultiplier * 0.5;
  
  // Minimum signal strength required (momentum confirmation)
  // IMPROVED: Bear markets get more lenient momentum requirement
  const bullishMinStrength = momentumThreshold;
  const bearishMinStrength = momentumThreshold * bearMomentumMultiplier; // More lenient for bear markets

  // Initialize regime and confidence (will be set in one of the branches below)
  let regime: MarketRegime = 'neutral';
  let confidence = 0.5;
  
  // Determine previous regime for hysteresis (check 1 period ago)
  let previousRegime: 'bullish' | 'bearish' | 'neutral' | null = null;
  if (currentIndex > 50) {
    const prevIdx = currentIndex - 1;
    const prevPrice = prices[prevIdx]!;
    const prevSma20 = getLatestIndicatorValue(sma20, prevIdx, 19);
    const prevSma50 = getLatestIndicatorValue(sma50, prevIdx, 49);
    const prevSma200 = sma200 ? getLatestIndicatorValue(sma200, prevIdx, 199) : null;
    // Note: prevEma12 and prevEma26 calculated but not currently used in logic
    // getLatestIndicatorValue(ema12, prevIdx, 11);
    // getLatestIndicatorValue(ema26, prevIdx, 25);
    const prevHistogram = getLatestIndicatorValue(histogram, prevIdx, 34);
    const prevMacd = getLatestIndicatorValue(macd, prevIdx, 34);
    const prevSignal = getLatestIndicatorValue(signal, prevIdx, 34);
    const prevRsi = getLatestIndicatorValue(rsi, prevIdx, 14);
    
    // Calculate previous signal using extracted pure functions (DRY)
    const prevEma12Value = getLatestIndicatorValue(ema12, prevIdx, 11);
    const prevEma26Value = getLatestIndicatorValue(ema26, prevIdx, 25);
    const { trend: prevTrend } = calculateTrendScore(
      prevPrice,
      prevSma20,
      prevSma50,
      prevSma200,
      prevEma12Value,
      prevEma26Value
    );
    
    const { momentum: prevMomentum } = calculateMomentumScore(
      prices,
      prevIdx,
      prevHistogram,
      prevMacd,
      prevSignal,
      prevRsi
    );
    
    const prevRawSignal = (prevTrend * 0.5 + prevMomentum * 0.5);
    
    if (prevRawSignal > bullishEntryThreshold) {
      previousRegime = 'bullish';
    } else if (prevRawSignal < bearishEntryThreshold) {
      previousRegime = 'bearish';
    }
  }
  
  // Use hysteresis: if we're already in a regime, use exit threshold; otherwise use entry threshold
  const isCurrentlyBullish = previousRegime === 'bullish';
  const isCurrentlyBearish = previousRegime === 'bearish';
  
  const bullishThreshold = isCurrentlyBullish ? bullishExitThreshold : bullishEntryThreshold;
  const bearishThreshold = isCurrentlyBearish ? bearishExitThreshold : bearishEntryThreshold;

  // CRITICAL FIX: Improved regime detection with explicit neutral logic
  // Use momentum confirmation threshold to require stronger signals
  // IMPROVED: Separate momentum confirmation for bullish vs bearish
  // CRITICAL: More lenient confirmation for edge cases (aligns with ground truth)
  // Ground truth uses 0.7x multiplier, so we should be more lenient too
  // But not too lenient - we still want accurate detection
  const bullishMomentumConfirmed = avgMomentumStrength >= bullishMinStrength * 0.9; // 10% more lenient
  const bearishMomentumConfirmed = avgMomentumStrength >= bearishMinStrength * 0.9; // 10% more lenient
  
  // Check if signal is near threshold (ambiguous) - should be neutral
  const isNearThreshold = isSignalNearThreshold(combinedSignal, bullishThreshold, signalStrength);
  
  // Check if should detect bullish using extracted function (separation of concerns)
  const bullishCheck = shouldDetectBullish(
    combinedSignal,
    bullishThreshold,
    signalStrength,
    bullishMinStrength,
    bullishMomentumConfirmed,
    isNearThreshold,
    prices,
    currentIndex,
    volatility
  );
  
  if (bullishCheck.shouldDetect) {
    regime = 'bullish';
    // Calculate base confidence using extracted function (DRY - eliminates duplication)
    const trendMomentumAgreement = (trend > 0 && momentum > 0) ? Math.min(Math.abs(trend), Math.abs(momentum)) : 0;
    let baseConfidence = calculateBaseConfidence(
      combinedSignal,
      signalStrength,
      trendMomentumAgreement,
      avgTrendStrength,
      avgMomentumStrength
    );
    
    // Check if regime has been persistent (from cache)
    const isPersistentTrend = indicatorCache.regimeHistory.length >= 5 && 
      indicatorCache.regimeHistory.slice(-5).every(r => r === 'bullish');
    
    // Apply bullish confidence boosts using extracted function (DRY - eliminates duplication)
    baseConfidence = calculateBullishConfidence(
      baseConfidence,
      prices,
      currentIndex,
      signalStrength,
      combinedSignal,
      trendMomentumAgreement,
      volatility,
      isPersistentTrend,
      sma20,
      sma50,
      sma200
    );
    
    // Apply trap pattern reduction (DRY - extracted function)
    const trapDetection = detectTrapPattern(
      prices,
      currentIndex,
      'bullish',
      indicatorCache.regimeHistory,
      signalStrength
    );
    
    if (trapDetection.isTrap) {
      baseConfidence = baseConfidence * trapDetection.reductionFactor;
    }
    
    // Final confidence calculation (after all boosts and reductions)
    confidence = Math.min(1, baseConfidence);
  } else {
    // Check if should detect bearish using extracted function (separation of concerns)
    const bearishCheck = shouldDetectBearish(
      combinedSignal,
      bearishThreshold,
      signalStrength,
      bearishMinStrength,
      bearishMomentumConfirmed,
      isNearThreshold,
      prices,
      currentIndex,
      volatility
    );
    
    if (bearishCheck.shouldDetect) {
      regime = 'bearish';
      // Calculate confidence using extracted function (separation of concerns)
      const trendMomentumAgreement = (trend < 0 && momentum < 0) ? Math.min(Math.abs(trend), Math.abs(momentum)) : 0;
      const isPersistentTrend = indicatorCache.regimeHistory.length >= 5 && 
        indicatorCache.regimeHistory.slice(-5).every(r => r === 'bearish');
      
      let baseConfidence = calculateBaseConfidence(
        combinedSignal,
        signalStrength,
        trendMomentumAgreement,
        avgTrendStrength,
        avgMomentumStrength
      );
      
      // Apply bearish confidence boosts
      baseConfidence = calculateBearishConfidence(
        baseConfidence,
        prices,
        currentIndex,
        signalStrength,
        combinedSignal,
        trendMomentumAgreement,
        volatility,
        isPersistentTrend,
        sma20,
        sma50,
        sma200
      );
      
      // Apply trap pattern reduction (DRY - extracted function)
      const trapDetection = detectTrapPattern(
        prices,
        currentIndex,
        'bearish',
        indicatorCache.regimeHistory,
        signalStrength
      );
      
      if (trapDetection.isTrap) {
        baseConfidence = baseConfidence * trapDetection.reductionFactor;
      }
      
      // Final confidence calculation
      confidence = Math.min(1, baseConfidence);
    } else {
      // Use extracted functions for pattern detection (DRY - eliminates duplication)
      const falseBreakout = detectFalseBreakout(prices, currentIndex);
      
      // Check if should detect neutral using extracted function (separation of concerns)
      // Note: Pattern detection (volatility squeeze, sideways, slow grind, etc.) is now handled
      // inside shouldDetectNeutral for better separation of concerns
      const neutralCheck = shouldDetectNeutral(
        prices,
        currentIndex,
        combinedSignal,
        signalStrength,
        volatility,
        trend,
        momentum,
        baseThreshold,
        bullishThreshold,
        indicatorCache.regimeHistory
      );
      
      if (neutralCheck.shouldDetect) {
        regime = 'neutral';
        // Calculate signal uncertainty for confidence calculation
        const signalUncertainty = Math.abs(combinedSignal) + signalStrength * 0.5;
        
        // Calculate neutral confidence using extracted function
        confidence = calculateNeutralConfidence(
          signalUncertainty,
          neutralCheck.isClearNeutral,
          neutralCheck.isLowVolatilityChoppy
        );
      } else {
        // Weak signal but not clearly neutral - use signal direction
        if (falseBreakout.isFalseBreakout) {
          regime = 'neutral';
          const signalUncertainty = Math.abs(combinedSignal) + signalStrength * 0.5;
          confidence = Math.max(0.4, Math.min(0.85, 0.7 - signalUncertainty * 0.3));
        } else {
          regime = combinedSignal > 0 ? 'bullish' : 'bearish';
          confidence = Math.min(0.6, Math.abs(combinedSignal) * 0.5 + signalStrength * 0.4);
        }
      }
    }
  }
  
  // CRITICAL FIX: Enforce persistence periods - require N periods of same regime before switching
  const persistencePeriods = regimeConfig.regimePersistencePeriods;
  if (persistencePeriods > 1 && indicatorCache.regimeHistory.length > 0) {
    // Check if we've had enough periods of the new regime
    const recentRegimes = indicatorCache.regimeHistory.slice(-persistencePeriods);
    const allSame = recentRegimes.length === persistencePeriods && recentRegimes.every(r => r === regime);
    
    if (!allSame && indicatorCache.lastRegime !== null && indicatorCache.lastRegime !== regime) {
      // Not enough periods of new regime - keep previous regime
      regime = indicatorCache.lastRegime;
      // Reduce confidence since we're forcing persistence
      confidence = Math.max(0.3, confidence * 0.8);
    }
  }
  
  // Update regime history (keep last 10 periods for persistence checks)
  indicatorCache.regimeHistory.push(regime);
  if (indicatorCache.regimeHistory.length > 10) {
    indicatorCache.regimeHistory.shift();
  }
  
  // Update last regime for next calculation
  indicatorCache.lastRegime = regime;

  // Apply confidence calibration using extracted function (separation of concerns)
  confidence = calibrateConfidence(
    confidence,
    trend,
    momentum,
    sma50Value,
    sma200Value,
    signalStrength
  );
  
  // Adjust confidence based on correlation context using extracted function
  confidence = adjustConfidenceForCorrelation(confidence, regime, correlationContext);

  // Build detailed breakdown from the SAME sub-signals used in the actual calculation
  const trapResult = detectTrapPattern(prices, currentIndex, regime, indicatorCache.regimeHistory, signalStrength);
  const breakdown: RegimeBreakdown = {
    trendSignals: trendSubSignals,
    momentumSignals: momentumSubSignals,
    signalSummary: {
      rawCombined: rawCombinedSignal,
      smoothedCombined: combinedSignal,
      signalStrength,
      trendScore: trend,
      momentumScore: momentum,
      bullishThreshold: bullishEntryThreshold,
      bearishThreshold: bearishEntryThreshold,
      effectiveBullishThreshold: bullishThreshold,
      effectiveBearishThreshold: bearishThreshold,
      trendWeight: trendMomentumShare,
      momentumWeight: trendMomentumShare,
      divergenceWeight,
      divergenceScore,
      divergenceType: divergenceSignal?.type ?? null,
    },
    trapDetected: trapResult.isTrap,
    trapReductionFactor: trapResult.reductionFactor,
  };

  return {
    regime,
    confidence,
    indicators: {
      trend,
      momentum,
      volatility,
      divergence: divergenceScore !== 0 ? divergenceScore : undefined,
    },
    divergenceSignal: divergenceSignal || undefined,
    combinedSignal,
    rawCombinedSignal,
    breakdown,
  };
}

/**
 * Clear the indicator cache (useful for testing or when switching datasets)
 */
export function clearIndicatorCache(): void {
  indicatorCache = {
    sma20: null,
    sma50: null,
    sma200: null,
    ema12: null,
    ema26: null,
    macd: null,
    rsi: null,
    prices: null,
    smoothedCombinedSignal: null,
    lastRegime: null,
    regimeHistory: [],
    lastCandleCount: 0,
  };
}


