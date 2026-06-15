/**
 * Pure Helper Functions for Market Regime Detection
 * 
 * These functions are extracted from the main regime detector to:
 * - Eliminate DRY violations
 * - Improve testability
 * - Separate concerns
 * - Make the codebase more maintainable
 * 
 * All functions are pure (no side effects) and can be unit tested independently.
 */

// Helper functions for market regime detection
// All functions are pure (no side effects) and can be unit tested independently

/** Individual sub-signal from trend or momentum calculation */
export interface RegimeBreakdownSignal {
  name: string;
  value: number;  // Signal contribution [-1, 1] — direction and strength
  raw: number;    // Raw underlying value (e.g., % diff from MA, RSI value)
}

// ============================================================================
// Price Momentum Calculations
// ============================================================================

/**
 * Calculate price momentum over a specified number of periods
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index in the price array
 * @param periods Number of periods to look back
 * @returns Price momentum as a percentage (0.02 = 2% increase), or 0 if insufficient data
 */
export function calculatePriceMomentum(
  prices: number[],
  currentIndex: number,
  periods: number
): number {
  if (currentIndex < periods || prices.length <= currentIndex) {
    return 0;
  }
  
  const priceAgo = prices[currentIndex - periods];
  const currentPrice = prices[currentIndex];
  
  if (!priceAgo || priceAgo <= 0) {
    return 0;
  }
  
  return (currentPrice - priceAgo) / priceAgo;
}

/**
 * Calculate multiple timeframe price momentums
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index in the price array
 * @returns Object with momentums for different timeframes
 */
export function calculateMultiTimeframeMomentum(
  prices: number[],
  currentIndex: number
): {
  veryShort: number; // 3 periods
  short: number;     // 5 periods
  medium: number;    // 10 periods
  long: number;      // 20 periods
} {
  return {
    veryShort: calculatePriceMomentum(prices, currentIndex, 3),
    short: calculatePriceMomentum(prices, currentIndex, 5),
    medium: calculatePriceMomentum(prices, currentIndex, 10),
    long: calculatePriceMomentum(prices, currentIndex, 20),
  };
}

// ============================================================================
// Volatility Calculations
// ============================================================================

/**
 * Calculate volatility from price returns
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param lookback Number of periods to look back
 * @returns Volatility (0-1, scaled)
 */
export function calculateVolatility(
  prices: number[],
  currentIndex: number,
  lookback: number = 20
): number {
  const startIndex = Math.max(0, currentIndex - lookback);
  const recentPrices = prices.slice(startIndex, currentIndex + 1);
  
  if (recentPrices.length < 2) {
    return 0;
  }
  
  const returns: number[] = [];
  for (let i = 1; i < recentPrices.length; i++) {
    const prevPrice = recentPrices[i - 1];
    const currPrice = recentPrices[i];
    if (prevPrice && prevPrice > 0 && currPrice) {
      returns.push(Math.abs((currPrice - prevPrice) / prevPrice));
    }
  }
  
  if (returns.length === 0) {
    return 0;
  }
  
  const avgVolatility = returns.reduce((a, b) => a + b, 0) / returns.length;
  return Math.min(1, avgVolatility * 20); // Scale to 0-1
}

/**
 * Calculate volatility from a slice of prices
 * Pure function - no side effects
 * 
 * @param priceSlice Array of price values (already sliced)
 * @returns Volatility (0-1, scaled)
 */
export function calculateVolatilityFromSlice(priceSlice: number[]): number {
  if (priceSlice.length < 2) {
    return 0;
  }
  
  const returns: number[] = [];
  for (let i = 1; i < priceSlice.length; i++) {
    const prevPrice = priceSlice[i - 1];
    const currPrice = priceSlice[i];
    if (prevPrice && prevPrice > 0 && currPrice) {
      returns.push((currPrice - prevPrice) / prevPrice);
    }
  }
  
  if (returns.length === 0) {
    return 0;
  }
  
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  // Guard against negative variance due to floating-point precision errors
  return Math.sqrt(Math.max(0, variance));
}

// ============================================================================
// Pattern Detection Functions
// ============================================================================

/**
 * Detect false breakout patterns
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @returns Object indicating if false breakout detected and type
 */
export function detectFalseBreakout(
  prices: number[],
  currentIndex: number
): {
  isFalseBreakout: boolean;
  isFalseBullBreakout: boolean;
  isFalseBearBreakout: boolean;
} {
  if (currentIndex < 15) {
    return { isFalseBreakout: false, isFalseBullBreakout: false, isFalseBearBreakout: false };
  }
  
  const momentum = calculateMultiTimeframeMomentum(prices, currentIndex);
  const { veryShort: recentMomentum, short: shortMomentum, medium: mediumMomentum, long: longMomentum } = momentum;
  
  let isFalseBreakout = false;
  let isFalseBullBreakout = false;
  let isFalseBearBreakout = false;
  
  // False bull breakout: price moved up recently but reversed or stalled
  if (recentMomentum > 0.01 && shortMomentum > 0.008 && (mediumMomentum < 0.008 || longMomentum < 0.015)) {
    isFalseBullBreakout = true;
    isFalseBreakout = true;
  }
  
  // False bear breakout: price moved down recently but reversed or stalled
  if (recentMomentum < -0.01 && shortMomentum < -0.008 && (mediumMomentum > -0.008 || longMomentum > -0.015)) {
    isFalseBearBreakout = true;
    isFalseBreakout = true;
  }
  
  // Reversal patterns (price moved one way then reversed)
  if (Math.abs(recentMomentum) > 0.008 && Math.abs(shortMomentum) > 0.012 && 
      Math.abs(mediumMomentum) < 0.012 && Math.abs(longMomentum) < 0.018) {
    isFalseBreakout = true;
    if (recentMomentum > 0) isFalseBullBreakout = true;
    if (recentMomentum < 0) isFalseBearBreakout = true;
  }
  
  // Whipsaw pattern (rapid reversals)
  if (Math.abs(recentMomentum) > 0.01 && Math.abs(shortMomentum) > 0.01 && 
      Math.abs(mediumMomentum) < 0.005 && Math.abs(longMomentum) < 0.01) {
    isFalseBreakout = true;
    if (recentMomentum > 0) isFalseBullBreakout = true;
    if (recentMomentum < 0) isFalseBearBreakout = true;
  }
  
  return { isFalseBreakout, isFalseBullBreakout, isFalseBearBreakout };
}

/**
 * Detect volatility squeeze patterns
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param currentVolatility Current volatility level
 * @param signalStrength Current signal strength
 * @param combinedSignal Current combined signal
 * @returns Object indicating volatility squeeze patterns
 */
export function detectVolatilitySqueeze(
  prices: number[],
  currentIndex: number,
  currentVolatility: number,
  signalStrength: number,
  combinedSignal: number
): {
  isVolatilitySqueeze: boolean;
  isVolatilitySqueezePattern: boolean;
  isVolatilityTransition: boolean;
} {
  // Basic volatility squeeze: low volatility with moderate signals
  const isVolatilitySqueeze = currentVolatility < 0.045 && signalStrength > 0.1 && Math.abs(combinedSignal) > 0.02;
  
  // Volatility squeeze pattern: low vol followed by breakout attempt
  let isVolatilitySqueezePattern = false;
  if (currentIndex >= 10 && currentVolatility < 0.04) {
    const startIdx = Math.max(0, currentIndex - 10);
    const recentPrices = prices.slice(startIdx, currentIndex + 1);
    const recentVolatility = calculateVolatilityFromSlice(recentPrices);
    
    if (recentVolatility < currentVolatility * 0.7 && signalStrength > 0.2) {
      isVolatilitySqueezePattern = true;
    }
  }
  
  // Volatility transition: volatility increasing from low
  let isVolatilityTransition = false;
  if (currentIndex >= 20 && currentVolatility < 0.05) {
    const midIdx = Math.max(0, currentIndex - 10);
    const midPrices = prices.slice(Math.max(0, midIdx - 10), midIdx + 1);
    if (midPrices.length > 1) {
      const midVolatility = calculateVolatilityFromSlice(midPrices);
      if (midVolatility < currentVolatility * 0.8 && currentVolatility > midVolatility * 1.2) {
        isVolatilityTransition = true;
      }
    }
  }
  
  return { isVolatilitySqueeze, isVolatilitySqueezePattern, isVolatilityTransition };
}

/**
 * Detect sideways market patterns
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param volatility Current volatility level
 * @returns True if market is sideways
 */
export function detectSidewaysMarket(
  prices: number[],
  currentIndex: number,
  volatility: number
): boolean {
  // Check 20-period timeframe
  if (currentIndex >= 20) {
    const price20Ago = prices[currentIndex - 20];
    const currentPrice = prices[currentIndex];
    if (price20Ago && currentPrice) {
      const priceChange20 = Math.abs((currentPrice - price20Ago) / price20Ago);
      if (priceChange20 < 0.025 && volatility < 0.045) {
        return true;
      }
    }
  }
  
  // Check 10-period timeframe
  if (currentIndex >= 10) {
    const price10Ago = prices[currentIndex - 10];
    const currentPrice = prices[currentIndex];
    if (price10Ago && currentPrice) {
      const priceChange10 = Math.abs((currentPrice - price10Ago) / price10Ago);
      if (priceChange10 < 0.015 && volatility < 0.035) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Detect slow grind patterns (gradual price movement with low volatility)
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param volatility Current volatility level
 * @param signalStrength Current signal strength
 * @returns True if market is in slow grind
 */
export function detectSlowGrind(
  prices: number[],
  currentIndex: number,
  volatility: number,
  signalStrength: number
): boolean {
  const momentum = calculateMultiTimeframeMomentum(prices, currentIndex);
  const { long: priceMomentum20, medium: priceMomentum10 } = momentum;
  
  // Multiple conditions for slow grind detection
  return (
    (volatility < 0.05 && Math.abs(priceMomentum20) < 0.03 && signalStrength < 0.4) ||
    (volatility < 0.045 && Math.abs(priceMomentum20) < 0.035 && signalStrength < 0.42) ||
    (volatility < 0.05 && Math.abs(priceMomentum20) < 0.025 && Math.abs(priceMomentum10) < 0.02 && signalStrength < 0.4) ||
    (volatility < 0.045 && Math.abs(priceMomentum10) < 0.025 && signalStrength < 0.38) ||
    (volatility < 0.04 && Math.abs(priceMomentum20) < 0.04 && signalStrength < 0.45)
  );
}

/**
 * Detect whipsaw patterns (rapid regime switches)
 * Pure function - no side effects
 * 
 * @param regimeHistory Array of recent regime detections
 * @returns True if whipsaw pattern detected
 */
export function detectWhipsaw(regimeHistory: Array<'bullish' | 'bearish' | 'neutral'>): boolean {
  if (regimeHistory.length < 5) {
    return false;
  }
  
  const recentRegimes = regimeHistory.slice(-5);
  const uniqueRegimes = new Set(recentRegimes);
  // If we've seen 3+ different regimes in last 5 periods, it's whipsaw
  return uniqueRegimes.size >= 3;
}

/**
 * Detect transition periods (regime switching)
 * Pure function - no side effects
 * 
 * @param regimeHistory Array of recent regime detections
 * @returns True if in transition period
 */
export function detectTransitionPeriod(regimeHistory: Array<'bullish' | 'bearish' | 'neutral'>): boolean {
  if (regimeHistory.length < 3) {
    return false;
  }
  
  const recentRegimes = regimeHistory.slice(-3);
  return recentRegimes.some((r, i, arr) => i > 0 && r !== arr[i - 1]);
}

// ============================================================================
// Trap Detection Functions
// ============================================================================

/**
 * Detect trap patterns (price moving against detected regime)
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param regime Current detected regime
 * @param regimeHistory Recent regime history
 * @param signalStrength Current signal strength
 * @returns Object with trap detection results
 */
export function detectTrapPattern(
  prices: number[],
  currentIndex: number,
  regime: 'bullish' | 'bearish' | 'neutral',
  regimeHistory: Array<'bullish' | 'bearish' | 'neutral'>,
  signalStrength: number
): {
  isTrap: boolean;
  reductionFactor: number;
} {
  const momentum = calculateMultiTimeframeMomentum(prices, currentIndex);
  const { veryShort, short, medium, long } = momentum;
  
  // Check recent regime history for trap patterns
  const recentRegimeHistory = regimeHistory.slice(-10);
  const recentlyBullish = recentRegimeHistory.some(r => r === 'bullish');
  const recentlyBearish = recentRegimeHistory.some(r => r === 'bearish');
  const justSwitchedToBearish = recentRegimeHistory.length >= 2 && 
    recentRegimeHistory[recentRegimeHistory.length - 2] === 'bullish' && 
    recentRegimeHistory[recentRegimeHistory.length - 1] === 'bearish';
  const justSwitchedToBullish = recentRegimeHistory.length >= 2 && 
    recentRegimeHistory[recentRegimeHistory.length - 2] === 'bearish' && 
    recentRegimeHistory[recentRegimeHistory.length - 1] === 'bullish';
  
  const isTrapPattern = justSwitchedToBearish || justSwitchedToBullish || 
                        (regime === 'bullish' && recentlyBullish) || 
                        (regime === 'bearish' && recentlyBearish);
  
  if (regime === 'bullish') {
    // Bull trap: price dropping while in bullish regime
    const maxNegativeMomentum = Math.min(long, short, medium, veryShort);
    
    if (((maxNegativeMomentum < -0.003 || long < -0.005 || short < -0.003 || veryShort < -0.003) && signalStrength > 0.03) ||
        (justSwitchedToBearish && maxNegativeMomentum < -0.002) ||
        (recentlyBullish && maxNegativeMomentum < -0.005 && signalStrength > 0.2)) {
      
      let reductionFactor = isTrapPattern ? 0.2 : 0.25;
      if (maxNegativeMomentum < -0.005 || long < -0.01 || short < -0.005 || veryShort < -0.005) {
        reductionFactor = 0.15;
      }
      if (maxNegativeMomentum < -0.01 || long < -0.015 || short < -0.01 || veryShort < -0.01) {
        reductionFactor = 0.1;
      }
      if (maxNegativeMomentum < -0.02 || long < -0.02 || short < -0.015 || veryShort < -0.015) {
        reductionFactor = 0.05;
      }
      if (maxNegativeMomentum < -0.03 || long < -0.03 || short < -0.02 || veryShort < -0.02) {
        reductionFactor = 0.03;
      }
      if (maxNegativeMomentum < -0.05 || long < -0.05 || short < -0.03 || veryShort < -0.03) {
        reductionFactor = 0.02;
      }
      if (maxNegativeMomentum < -0.10 || long < -0.10 || short < -0.05 || veryShort < -0.05) {
        reductionFactor = 0.01;
      }
      
      return { isTrap: true, reductionFactor };
    }
  } else if (regime === 'bearish') {
    // Bear trap: price rallying while in bearish regime
    const maxPositiveMomentum = Math.max(long, short, medium, veryShort);
    
    if (((maxPositiveMomentum > 0.003 || long > 0.005 || short > 0.003 || veryShort > 0.003) && signalStrength > 0.03) ||
        (justSwitchedToBullish && maxPositiveMomentum > 0.002) ||
        (recentlyBearish && maxPositiveMomentum > 0.005 && signalStrength > 0.2)) {
      
      let reductionFactor = isTrapPattern ? 0.2 : 0.25;
      if (maxPositiveMomentum > 0.005 || long > 0.01 || short > 0.005 || veryShort > 0.005) {
        reductionFactor = 0.15;
      }
      if (maxPositiveMomentum > 0.01 || long > 0.015 || short > 0.01 || veryShort > 0.01) {
        reductionFactor = 0.1;
      }
      if (maxPositiveMomentum > 0.02 || long > 0.02 || short > 0.015 || veryShort > 0.015) {
        reductionFactor = 0.05;
      }
      if (maxPositiveMomentum > 0.03 || long > 0.03 || short > 0.02 || veryShort > 0.02) {
        reductionFactor = 0.03;
      }
      if (maxPositiveMomentum > 0.05 || long > 0.05 || short > 0.03 || veryShort > 0.03) {
        reductionFactor = 0.02;
      }
      if (maxPositiveMomentum > 0.10 || long > 0.10 || short > 0.05 || veryShort > 0.05) {
        reductionFactor = 0.01;
      }
      
      return { isTrap: true, reductionFactor };
    }
  }
  
  return { isTrap: false, reductionFactor: 1.0 };
}

// ============================================================================
// Trend Calculation Functions
// ============================================================================

/**
 * Calculate trend score from moving averages
 * Pure function - no side effects
 * 
 * @param currentPrice Current price
 * @param sma20Value SMA20 value (or null)
 * @param sma50Value SMA50 value (or null)
 * @param sma200Value SMA200 value (or null)
 * @param ema12Value EMA12 value (or null)
 * @param ema26Value EMA26 value (or null)
 * @returns Object with trend score, strength, and signal count
 */
export function calculateTrendScore(
  currentPrice: number,
  sma20Value: number | null,
  sma50Value: number | null,
  sma200Value: number | null,
  ema12Value: number | null,
  ema26Value: number | null
): {
  trend: number;
  avgTrendStrength: number;
  subSignals: RegimeBreakdownSignal[];
} {
  let trendScore = 0;
  let trendSignals = 0;
  let trendStrength = 0;
  const subSignals: RegimeBreakdownSignal[] = [];

  // Price vs SMA 20
  if (sma20Value !== null && sma20Value !== 0) {
    const priceVsSMA20 = (currentPrice - sma20Value) / sma20Value;
    const signal = Math.max(-1, Math.min(1, priceVsSMA20 * 10));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
    subSignals.push({ name: 'Price vs SMA20', value: signal, raw: priceVsSMA20 });
  }

  // Price vs SMA 50
  if (sma50Value !== null && sma50Value !== 0) {
    const priceVsSMA50 = (currentPrice - sma50Value) / sma50Value;
    const signal = Math.max(-1, Math.min(1, priceVsSMA50 * 10));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
    subSignals.push({ name: 'Price vs SMA50', value: signal, raw: priceVsSMA50 });
  }

  // Price vs SMA 200
  if (sma200Value !== null && sma200Value !== 0) {
    const priceVsSMA200 = (currentPrice - sma200Value) / sma200Value;
    const signal = Math.max(-1, Math.min(1, priceVsSMA200 * 8));
    trendScore += signal * 1.5;
    trendStrength += Math.abs(signal) * 1.5;
    trendSignals++;
    subSignals.push({ name: 'Price vs SMA200', value: signal, raw: priceVsSMA200 });
  }

  // Golden Cross / Death Cross
  if (sma50Value !== null && sma200Value !== null && sma200Value !== 0) {
    const goldenCross = (sma50Value - sma200Value) / sma200Value;
    const signal = Math.max(-1, Math.min(1, goldenCross * 30));
    trendScore += signal * 2.0;
    trendStrength += Math.abs(signal) * 2.0;
    trendSignals++;
    subSignals.push({ name: 'SMA50 vs SMA200', value: signal, raw: goldenCross });
  }

  // SMA 20 vs SMA 50
  if (sma20Value !== null && sma50Value !== null && sma50Value !== 0) {
    const smaCross = (sma20Value - sma50Value) / sma50Value;
    const signal = Math.max(-1, Math.min(1, smaCross * 20));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
    subSignals.push({ name: 'SMA20 vs SMA50', value: signal, raw: smaCross });
  }

  // EMA 12 vs EMA 26
  if (ema12Value !== null && ema26Value !== null && ema26Value !== 0) {
    const emaCross = (ema12Value - ema26Value) / ema26Value;
    const signal = Math.max(-1, Math.min(1, emaCross * 20));
    trendScore += signal;
    trendStrength += Math.abs(signal);
    trendSignals++;
    subSignals.push({ name: 'EMA12 vs EMA26', value: signal, raw: emaCross });
  }

  // Trend alignment
  if (sma20Value !== null && sma50Value !== null && sma200Value !== null) {
    const alignedBullish = currentPrice > sma20Value && sma20Value > sma50Value && sma50Value > sma200Value;
    const alignedBearish = currentPrice < sma20Value && sma20Value < sma50Value && sma50Value < sma200Value;
    if (alignedBullish) {
      trendScore += 0.5;
      trendStrength += 0.5;
      trendSignals++;
      subSignals.push({ name: 'MA Alignment', value: 0.5, raw: 1 });
    } else if (alignedBearish) {
      trendScore -= 0.5;
      trendStrength += 0.5;
      trendSignals++;
      subSignals.push({ name: 'MA Alignment', value: -0.5, raw: -1 });
    }
  }

  const trend = trendSignals > 0 ? trendScore / trendSignals : 0;
  const avgTrendStrength = trendSignals > 0 ? trendStrength / trendSignals : 0;

  return { trend, avgTrendStrength, subSignals };
}

// ============================================================================
// Momentum Calculation Functions
// ============================================================================

/**
 * Calculate momentum score from technical indicators
 * Pure function - no side effects
 * 
 * @param prices Array of price values
 * @param currentIndex Current index
 * @param histogramValue MACD histogram value (or null)
 * @param macdValue MACD value (or null)
 * @param signalValue MACD signal value (or null)
 * @param rsiValue RSI value (or null)
 * @returns Object with momentum score, strength, and signal count
 */
export function calculateMomentumScore(
  prices: number[],
  currentIndex: number,
  histogramValue: number | null,
  macdValue: number | null,
  signalValue: number | null,
  rsiValue: number | null
): {
  momentum: number;
  avgMomentumStrength: number;
  subSignals: RegimeBreakdownSignal[];
} {
  let momentumScore = 0;
  let momentumSignals = 0;
  let momentumStrength = 0;
  const subSignals: RegimeBreakdownSignal[] = [];

  // MACD Histogram
  if (histogramValue !== null && Number.isFinite(histogramValue)) {
    const recentPrices = prices.slice(-50).filter(p => Number.isFinite(p));
    // Guard against empty array: Math.max(...[]) = -Infinity, Math.min(...[]) = Infinity
    const currentPrice = currentIndex >= 0 && currentIndex < prices.length ? prices[currentIndex] : 0;
    const priceMax = recentPrices.length > 0 ? Math.max(...recentPrices) : currentPrice;
    const priceMin = recentPrices.length > 0 ? Math.min(...recentPrices) : currentPrice;
    const priceRange = priceMax - priceMin;
    const scale = Number.isFinite(priceRange) && priceRange > 0 ? priceRange / 100 : 1;
    const signal = Math.max(-1, Math.min(1, histogramValue / scale));
    momentumScore += signal * 1.5;
    momentumStrength += Math.abs(signal) * 1.5;
    momentumSignals++;
    subSignals.push({ name: 'MACD Histogram', value: signal, raw: histogramValue });
  }

  // MACD vs Signal
  if (macdValue !== null && signalValue !== null && Number.isFinite(macdValue) && Number.isFinite(signalValue)) {
    const macdSignal = macdValue > signalValue ? 1 : -1;
    const divisor = Math.abs(signalValue) || 1;
    const macdStrengthRaw = Math.abs(macdValue - signalValue) / divisor;
    // Guard against NaN/Infinity from extreme values
    const macdStrength = Number.isFinite(macdStrengthRaw) ? macdStrengthRaw : 0;
    const macdVsSignalValue = macdSignal * Math.min(1, macdStrength * 10);
    momentumScore += macdVsSignalValue;
    momentumStrength += Math.min(1, macdStrength * 10);
    momentumSignals++;
    subSignals.push({ name: 'MACD vs Signal', value: macdVsSignalValue, raw: macdValue - signalValue });

    const positionValue = macdValue > 0 ? 0.3 : -0.3;
    momentumScore += positionValue;
    momentumStrength += 0.3;
    momentumSignals++;
    subSignals.push({ name: 'MACD Position', value: positionValue, raw: macdValue });
  }

  // RSI
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
    subSignals.push({ name: 'RSI', value: rsiSignal, raw: rsiValue });
  }

  // Price momentum
  if (currentIndex >= 20) {
    const priceMomentum20 = calculatePriceMomentum(prices, currentIndex, 20);
    const signal = Math.max(-1, Math.min(1, priceMomentum20 * 5));
    momentumScore += signal;
    momentumStrength += Math.abs(signal);
    momentumSignals++;
    subSignals.push({ name: 'Price Mom 20p', value: signal, raw: priceMomentum20 });
  }

  if (currentIndex >= 50) {
    const priceMomentum50 = calculatePriceMomentum(prices, currentIndex, 50);
    const signal = Math.max(-1, Math.min(1, priceMomentum50 * 3));
    momentumScore += signal * 1.2;
    momentumStrength += Math.abs(signal) * 1.2;
    momentumSignals++;
    subSignals.push({ name: 'Price Mom 50p', value: signal, raw: priceMomentum50 });
  }

  const momentum = momentumSignals > 0 ? momentumScore / momentumSignals : 0;
  const avgMomentumStrength = momentumSignals > 0 ? momentumStrength / momentumSignals : 0;

  return { momentum, avgMomentumStrength, subSignals };
}
