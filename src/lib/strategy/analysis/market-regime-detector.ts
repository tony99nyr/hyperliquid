/**
 * Market Regime Detector
 * Determines if the market is bullish, bearish, or neutral
 * Uses multiple technical indicators for robust detection
 */

import type { PriceCandle } from '@/types';
import { calculateSMA, calculateEMA, calculateMACD, calculateRSI, getLatestIndicatorValue } from '../indicators/indicators';

export type MarketRegime = 'bullish' | 'bearish' | 'neutral';

export interface MarketRegimeSignal {
  regime: MarketRegime;
  confidence: number; // 0-1, how confident we are in the regime
  indicators: {
    trend: number; // -1 to +1, overall trend direction
    momentum: number; // -1 to +1, momentum strength
    volatility: number; // 0-1, current volatility level
  };
  stability: number; // 0-1, how stable/consistent the regime has been
}

/**
 * Configuration for regime persistence checking
 */
const REGIME_PERSISTENCE_CONFIG = {
  lookbackPeriods: 3, // How many periods to check for regime consistency
  stabilityBoostThreshold: 5, // Boost confidence if stable for this many periods
  stabilityBoostAmount: 0.15, // Amount to boost confidence when stable
};

/**
 * Calculate raw regime signal without persistence checking (internal helper)
 */
function calculateRawRegimeSignal(
  candles: PriceCandle[],
  currentIndex: number
): { regime: MarketRegime; confidence: number; trend: number; momentum: number; volatility: number } {
  const prices = candles.map(c => c.close);
  const currentPrice = prices[currentIndex];

  // Guard against undefined currentPrice (array bounds issue)
  if (currentPrice === undefined || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { regime: 'neutral', confidence: 0, trend: 0, momentum: 0, volatility: 0 };
  }

  // 1. Trend Detection using established indicators
  const sma20 = calculateSMA(prices, 20);
  const sma50 = calculateSMA(prices, 50);
  const sma200 = currentIndex >= 199 ? calculateSMA(prices, 200) : null;
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);

  const sma20Value = getLatestIndicatorValue(sma20, currentIndex, 19);
  const sma50Value = getLatestIndicatorValue(sma50, currentIndex, 49);
  const sma200Value = sma200 ? getLatestIndicatorValue(sma200, currentIndex, 199) : null;
  const ema12Value = getLatestIndicatorValue(ema12, currentIndex, 11);
  const ema26Value = getLatestIndicatorValue(ema26, currentIndex, 25);

  let trendScore = 0;
  let trendSignals = 0;
  let trendStrength = 0;

  // Price vs SMA 20 (short-term trend)
  if (sma20Value !== null && sma20Value !== 0) {
    const priceVsSMA20 = (currentPrice - sma20Value) / sma20Value;
    const signal = Math.max(-1, Math.min(1, priceVsSMA20 * 10));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
  }

  // Price vs SMA 50 (medium-term trend)
  if (sma50Value !== null && sma50Value !== 0) {
    const priceVsSMA50 = (currentPrice - sma50Value) / sma50Value;
    const signal = Math.max(-1, Math.min(1, priceVsSMA50 * 10));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
  }

  // Price vs SMA 200 (long-term trend)
  if (sma200Value !== null && sma200Value !== 0) {
    const priceVsSMA200 = (currentPrice - sma200Value) / sma200Value;
    const signal = Math.max(-1, Math.min(1, priceVsSMA200 * 8));
    trendScore += signal * 1.5;
    trendStrength += Math.abs(signal) * 1.5;
    trendSignals++;
  }

  // Golden Cross / Death Cross
  if (sma50Value !== null && sma200Value !== null && sma200Value !== 0) {
    const goldenCross = (sma50Value - sma200Value) / sma200Value;
    const signal = Math.max(-1, Math.min(1, goldenCross * 30));
    trendScore += signal * 2.0;
    trendStrength += Math.abs(signal) * 2.0;
    trendSignals++;
  }

  // SMA 20 vs SMA 50 (short-term cross)
  if (sma20Value !== null && sma50Value !== null && sma50Value !== 0) {
    const smaCross = (sma20Value - sma50Value) / sma50Value;
    const signal = Math.max(-1, Math.min(1, smaCross * 20));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
  }

  // EMA 12 vs EMA 26 (MACD-style crossover)
  if (ema12Value !== null && ema26Value !== null && ema26Value !== 0) {
    const emaCross = (ema12Value - ema26Value) / ema26Value;
    const signal = Math.max(-1, Math.min(1, emaCross * 20));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
  }

  // Trend alignment check
  if (sma20Value !== null && sma50Value !== null && sma200Value !== null) {
    const alignedBullish = currentPrice > sma20Value && sma20Value > sma50Value && sma50Value > sma200Value;
    const alignedBearish = currentPrice < sma20Value && sma20Value < sma50Value && sma50Value < sma200Value;
    if (alignedBullish) {
      trendScore += 0.5;
      trendStrength += 0.5;
      trendSignals++;
    } else if (alignedBearish) {
      trendScore -= 0.5;
      trendStrength += 0.5;
      trendSignals++;
    }
  }

  const trend = trendSignals > 0 ? trendScore / trendSignals : 0;
  const avgTrendStrength = trendSignals > 0 ? trendStrength / trendSignals : 0;

  // 2. Momentum Detection
  const { macd, signal, histogram } = calculateMACD(prices, 12, 26, 9);
  const rsi = calculateRSI(prices, 14);

  let momentumScore = 0;
  let momentumSignals = 0;
  let momentumStrength = 0;

  // MACD Histogram
  const histogramValue = getLatestIndicatorValue(histogram, currentIndex, 34);
  if (histogramValue !== null) {
    const recentPrices = prices.slice(-50).filter(p => Number.isFinite(p));
    // Guard against empty array: Math.max(...[]) = -Infinity, Math.min(...[]) = Infinity
    const priceMax = recentPrices.length > 0 ? Math.max(...recentPrices) : currentPrice;
    const priceMin = recentPrices.length > 0 ? Math.min(...recentPrices) : currentPrice;
    const priceRange = priceMax - priceMin;
    const scale = Number.isFinite(priceRange) && priceRange > 0 ? priceRange / 100 : 1;
    const sig = Math.max(-1, Math.min(1, histogramValue / scale));
    momentumScore += sig * 1.5;
    momentumStrength += Math.abs(sig) * 1.5;
    momentumSignals++;
  }

  // MACD vs Signal Line
  const macdValue = getLatestIndicatorValue(macd, currentIndex, 34);
  const signalValue = getLatestIndicatorValue(signal, currentIndex, 34);
  if (macdValue !== null && signalValue !== null && Number.isFinite(macdValue) && Number.isFinite(signalValue)) {
    const macdSignal = macdValue > signalValue ? 1 : -1;
    const divisor = Math.abs(signalValue) || 1;
    const macdStrengthRaw = Math.abs(macdValue - signalValue) / divisor;
    // Guard against NaN/Infinity from extreme values
    const macdStrengthVal = Number.isFinite(macdStrengthRaw) ? macdStrengthRaw : 0;
    momentumScore += macdSignal * Math.min(1, macdStrengthVal * 10);
    momentumStrength += Math.min(1, macdStrengthVal * 10);
    momentumSignals++;

    if (macdValue > 0) {
      momentumScore += 0.3;
      momentumStrength += 0.3;
    } else {
      momentumScore -= 0.3;
      momentumStrength += 0.3;
    }
    momentumSignals++;
  }

  // RSI
  const rsiValue = getLatestIndicatorValue(rsi, currentIndex, 14);
  if (rsiValue !== null) {
    let rsiSignal = 0;
    if (rsiValue > 70) {
      rsiSignal = -((rsiValue - 70) / 30);
    } else if (rsiValue < 30) {
      rsiSignal = (30 - rsiValue) / 30;
    } else if (rsiValue > 50) {
      rsiSignal = (rsiValue - 50) / 20;
    } else {
      rsiSignal = -(50 - rsiValue) / 20;
    }
    momentumScore += rsiSignal;
    momentumStrength += Math.abs(rsiSignal);
    momentumSignals++;
  }

  // Price momentum - 20 period
  if (currentIndex >= 20) {
    const price20PeriodsAgo = prices[currentIndex - 20];
    if (price20PeriodsAgo > 0 && currentPrice > 0) {
      const priceMomentum20 = (currentPrice - price20PeriodsAgo) / price20PeriodsAgo;
      const sig = Math.max(-1, Math.min(1, priceMomentum20 * 5));
      momentumScore += sig;
      momentumStrength += Math.abs(sig);
      momentumSignals++;
    }
  }

  // Price momentum - 50 period
  if (currentIndex >= 50) {
    const price50PeriodsAgo = prices[currentIndex - 50];
    if (price50PeriodsAgo > 0 && currentPrice > 0) {
      const priceMomentum50 = (currentPrice - price50PeriodsAgo) / price50PeriodsAgo;
      const sig = Math.max(-1, Math.min(1, priceMomentum50 * 3));
      momentumScore += sig * 1.2;
      momentumStrength += Math.abs(sig) * 1.2;
      momentumSignals++;
    }
  }

  const momentum = momentumSignals > 0 ? momentumScore / momentumSignals : 0;
  const avgMomentumStrength = momentumSignals > 0 ? momentumStrength / momentumSignals : 0;

  // 3. Volatility Detection
  const lookback = Math.min(20, currentIndex);
  const recentPrices = prices.slice(currentIndex - lookback, currentIndex + 1);
  const returns = [];
  for (let i = 1; i < recentPrices.length; i++) {
    if (recentPrices[i - 1] > 0) {
      returns.push(Math.abs((recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1]));
    }
  }
  const avgVolatility = returns.length > 0
    ? returns.reduce((a, b) => a + b, 0) / returns.length
    : 0;
  const volatility = Math.min(1, avgVolatility * 20);

  // Combine trend and momentum
  const combinedSignal = (trend * 0.5 + momentum * 0.5);
  const signalStrength = (avgTrendStrength + avgMomentumStrength) / 2;

  // Determine regime
  const bullishThreshold = 0.05;
  const bearishThreshold = -0.05;
  const minStrength = 0.1;

  let regime: MarketRegime;
  let confidence: number;

  if (combinedSignal > bullishThreshold && signalStrength > minStrength) {
    regime = 'bullish';
    confidence = Math.min(1, Math.abs(combinedSignal) * 0.7 + signalStrength * 0.3);
  } else if (combinedSignal < bearishThreshold && signalStrength > minStrength) {
    regime = 'bearish';
    confidence = Math.min(1, Math.abs(combinedSignal) * 0.7 + signalStrength * 0.3);
  } else {
    regime = 'neutral';
    confidence = Math.max(0, 1 - Math.abs(combinedSignal) - signalStrength);
  }

  // Increase confidence if trend and momentum agree
  if ((trend > 0 && momentum > 0) || (trend < 0 && momentum < 0)) {
    const agreement = Math.min(Math.abs(trend), Math.abs(momentum));
    confidence = Math.min(1, confidence * (1 + agreement * 0.5));
  }

  // Boost confidence if Golden/Death Cross is present
  if (sma50Value !== null && sma200Value !== null && sma200Value !== 0) {
    const crossSignal = (sma50Value - sma200Value) / sma200Value;
    if (Math.abs(crossSignal) > 0.02) {
      confidence = Math.min(1, confidence * 1.3);
    }
  }

  return { regime, confidence, trend, momentum, volatility };
}

/**
 * Detect market regime using multiple indicators
 * Includes persistence checking to prevent rapid regime flipping
 *
 * @deprecated Use `detectMarketRegimeCached` from `market-regime-detector-cached.ts` instead.
 * This uncached version is kept as a reference implementation.
 */
export function detectMarketRegime(
  candles: PriceCandle[],
  currentIndex: number
): MarketRegimeSignal {
  // Defensive: ensure currentIndex is within bounds
  if (currentIndex < 0 || currentIndex >= candles.length) {
    return {
      regime: 'neutral',
      confidence: 0,
      indicators: {
        trend: 0,
        momentum: 0,
        volatility: 0,
      },
      stability: 0,
    };
  }

  // Need at least 50 periods for basic indicators
  // 200-day SMA is optional (only used if available)
  if (currentIndex < 50) {
    return {
      regime: 'neutral',
      confidence: 0,
      indicators: {
        trend: 0,
        momentum: 0,
        volatility: 0,
      },
      stability: 0,
    };
  }

  // Validate current candle data quality
  const currentCandle = candles[currentIndex];
  if (!currentCandle || !Number.isFinite(currentCandle.close) || currentCandle.close <= 0) {
    return {
      regime: 'neutral',
      confidence: 0,
      indicators: {
        trend: 0,
        momentum: 0,
        volatility: 0,
      },
      stability: 0,
    };
  }

  // Calculate current raw regime signal
  const currentRaw = calculateRawRegimeSignal(candles, currentIndex);

  // Check regime persistence by looking back at previous periods
  const { lookbackPeriods, stabilityBoostThreshold, stabilityBoostAmount } = REGIME_PERSISTENCE_CONFIG;

  // Calculate how many consecutive periods have the same regime
  let consecutiveCount = 1;
  const checkPeriods = Math.min(lookbackPeriods + stabilityBoostThreshold, currentIndex - 50);

  for (let i = 1; i <= checkPeriods; i++) {
    const prevIndex = currentIndex - i;
    if (prevIndex < 50) break;

    const prevRaw = calculateRawRegimeSignal(candles, prevIndex);
    if (prevRaw.regime === currentRaw.regime) {
      consecutiveCount++;
    } else {
      break; // Stop counting consecutive on first mismatch
    }
  }

  // Calculate stability score (0-1)
  const stability = Math.min(1, consecutiveCount / (lookbackPeriods + stabilityBoostThreshold));

  // Apply persistence filter: if regime just changed (consecutive < lookbackPeriods),
  // check if previous regime was more stable
  let finalRegime = currentRaw.regime;
  let finalConfidence = currentRaw.confidence;

  if (consecutiveCount < lookbackPeriods && currentIndex > 50 + lookbackPeriods) {
    // Regime recently changed - check if we should maintain previous regime
    // Look back to find what the previous stable regime was
    let prevStableRegime: MarketRegime | null = null;
    let prevStableCount = 0;

    for (let i = lookbackPeriods; i <= checkPeriods + lookbackPeriods; i++) {
      const prevIndex = currentIndex - i;
      if (prevIndex < 50) break;

      const prevRaw = calculateRawRegimeSignal(candles, prevIndex);
      if (prevStableRegime === null) {
        prevStableRegime = prevRaw.regime;
        prevStableCount = 1;
      } else if (prevRaw.regime === prevStableRegime) {
        prevStableCount++;
      } else {
        break;
      }
    }

    // If previous regime was more stable, maintain it (but with reduced confidence)
    if (prevStableRegime !== null && prevStableCount >= lookbackPeriods && prevStableRegime !== currentRaw.regime) {
      // Only override if current raw signal isn't strongly confident
      if (currentRaw.confidence < 0.7) {
        finalRegime = prevStableRegime;
        finalConfidence = Math.max(0.3, currentRaw.confidence * 0.8); // Reduce confidence
      }
    }
  }

  // Boost confidence if regime has been stable for long time
  if (consecutiveCount >= stabilityBoostThreshold) {
    finalConfidence = Math.min(1, finalConfidence + stabilityBoostAmount);
  }

  return {
    regime: finalRegime,
    confidence: finalConfidence,
    indicators: {
      trend: currentRaw.trend,
      momentum: currentRaw.momentum,
      volatility: currentRaw.volatility,
    },
    stability,
  };
}

/**
 * Get market regime for a specific date range (for backtesting)
 *
 * @deprecated Use `detectMarketRegimeCached` from `market-regime-detector-cached.ts` instead.
 * This uncached version is kept as a reference implementation.
 */
export function getMarketRegimeForPeriod(
  candles: PriceCandle[],
  startIndex: number,
  endIndex: number
): { regime: MarketRegime; percentage: number } {
  const regimes: MarketRegime[] = [];
  
  for (let i = startIndex; i <= endIndex; i++) {
    const signal = detectMarketRegime(candles, i);
    regimes.push(signal.regime);
  }

  const bullishCount = regimes.filter(r => r === 'bullish').length;
  const bearishCount = regimes.filter(r => r === 'bearish').length;
  const neutralCount = regimes.filter(r => r === 'neutral').length;

  const total = regimes.length;
  if (total === 0) {
    return { regime: 'neutral', percentage: 0 };
  }
  const bullishPct = bullishCount / total;
  const bearishPct = bearishCount / total;
  const neutralPct = neutralCount / total;

  // Determine dominant regime
  if (bullishPct > bearishPct && bullishPct > neutralPct) {
    return { regime: 'bullish', percentage: bullishPct };
  } else if (bearishPct > bullishPct && bearishPct > neutralPct) {
    return { regime: 'bearish', percentage: bearishPct };
  } else {
    return { regime: 'neutral', percentage: neutralPct };
  }
}

