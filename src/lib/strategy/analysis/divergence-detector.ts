/**
 * Divergence Detection Module
 * 
 * Detects price-indicator divergence patterns that can signal potential
 * trend reversals or trend continuations.
 * 
 * Types of divergence:
 * - Regular bullish: Price makes lower lows, indicator makes higher lows (potential reversal up)
 * - Regular bearish: Price makes higher highs, indicator makes lower highs (potential reversal down)
 * - Hidden bullish: Price makes higher lows, indicator makes lower lows (trend continuation up)
 * - Hidden bearish: Price makes lower highs, indicator makes higher highs (trend continuation down)
 */

import type { PriceCandle } from '@/types';
import { calculateRSI, calculateEMA } from '../indicators/indicators';

export type DivergenceType = 'bullish' | 'bearish' | 'hidden-bullish' | 'hidden-bearish';

export interface DivergenceSignal {
  type: DivergenceType;
  indicator: 'rsi' | 'macd';
  strength: number; // 0-1, higher means stronger divergence
  priceExtremes: {
    first: { index: number; value: number };
    second: { index: number; value: number };
  };
  indicatorExtremes: {
    first: { index: number; value: number };
    second: { index: number; value: number };
  };
}

interface Extremes {
  minima: number[];
  maxima: number[];
}

const DEFAULT_LOOKBACK = 50;
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

/**
 * Find local minima and maxima in a data series
 * 
 * @param data Array of values
 * @param order Number of points on each side to compare (default 2)
 * @returns Object with arrays of indices for minima and maxima
 */
export function findLocalExtremes(data: number[], order: number = 2): Extremes {
  const minima: number[] = [];
  const maxima: number[] = [];

  if (data.length < order * 2 + 1) {
    return { minima, maxima };
  }

  for (let i = order; i < data.length - order; i++) {
    let isMinimum = true;
    let isMaximum = true;
    const currentValue = data[i];

    // Check if current point is a local minimum or maximum
    for (let j = 1; j <= order; j++) {
      const leftValue = data[i - j];
      const rightValue = data[i + j];

      // For minimum: current must be <= neighbors
      if (currentValue > leftValue || currentValue > rightValue) {
        isMinimum = false;
      }

      // For maximum: current must be >= neighbors
      if (currentValue < leftValue || currentValue < rightValue) {
        isMaximum = false;
      }
    }

    // Avoid flat regions by ensuring at least one neighbor is different
    const hasDistinctNeighbor = data.slice(i - order, i + order + 1).some(v => v !== currentValue);
    
    if (isMinimum && hasDistinctNeighbor) {
      minima.push(i);
    }
    if (isMaximum && hasDistinctNeighbor) {
      maxima.push(i);
    }
  }

  return { minima, maxima };
}

/**
 * Calculate RSI values for a range of candles
 */
function calculateRSIValues(candles: PriceCandle[], period: number = RSI_PERIOD): number[] {
  const prices = candles.map(c => c.close);
  const rsiArray = calculateRSI(prices, period);
  
  // Pad the beginning with neutral RSI values
  const padding = new Array(period).fill(50);
  return [...padding, ...rsiArray];
}

/**
 * Calculate MACD histogram values for a range of candles
 */
function calculateMACDValues(
  candles: PriceCandle[],
  fastPeriod: number = MACD_FAST,
  slowPeriod: number = MACD_SLOW,
  signalPeriod: number = MACD_SIGNAL
): number[] {
  const closes = candles.map(c => c.close);
  
  // Calculate full EMA arrays
  const fastEMAArray = calculateEMA(closes, fastPeriod);
  const slowEMAArray = calculateEMA(closes, slowPeriod);
  
  // Calculate MACD line (fast EMA - slow EMA)
  const macdLine: number[] = [];
  const slowOffset = slowPeriod - fastPeriod;
  
  for (let i = 0; i < slowEMAArray.length; i++) {
    const fastIdx = i + slowOffset;
    if (fastIdx >= 0 && fastIdx < fastEMAArray.length) {
      macdLine.push(fastEMAArray[fastIdx] - slowEMAArray[i]);
    }
  }
  
  // Calculate signal line (EMA of MACD line)
  const signalLineArray = calculateEMA(macdLine, signalPeriod);
  
  // Calculate histogram (MACD line - signal line)
  const histogram: number[] = [];
  const signalOffset = signalPeriod - 1;
  
  for (let i = 0; i < signalLineArray.length; i++) {
    const macdIdx = i + signalOffset;
    if (macdIdx >= 0 && macdIdx < macdLine.length) {
      histogram.push(macdLine[macdIdx] - signalLineArray[i]);
    }
  }
  
  // Pad to match candle length
  const totalPadding = candles.length - histogram.length;
  const padding = new Array(Math.max(0, totalPadding)).fill(0);
  
  return [...padding, ...histogram];
}

/**
 * Calculate divergence strength based on the magnitude of divergence
 * 
 * @param priceDiff Percentage difference in price extremes
 * @param indicatorDiff Percentage difference in indicator extremes
 * @returns Strength value between 0 and 1
 */
function calculateDivergenceStrength(priceDiff: number, indicatorDiff: number): number {
  // The stronger the divergence, the bigger the difference between price and indicator movements
  const divergenceMagnitude = Math.abs(priceDiff) + Math.abs(indicatorDiff);
  
  // Normalize to 0-1 range (10% total divergence = 0.5 strength)
  const rawStrength = Math.min(1, divergenceMagnitude / 20);
  
  // Apply sigmoid-like scaling for smoother output
  return rawStrength * (1 - 0.5 * Math.exp(-divergenceMagnitude / 5));
}

/**
 * Detect RSI divergence at a specific index
 * 
 * @param candles Price candles
 * @param index Current index to check
 * @param lookback Number of periods to look back for divergence
 * @returns Divergence signal or null if no divergence detected
 */
export function detectRSIDivergence(
  candles: PriceCandle[],
  index: number,
  lookback: number = DEFAULT_LOOKBACK
): DivergenceSignal | null {
  // Need enough data for RSI calculation and lookback
  if (index < RSI_PERIOD + lookback || index >= candles.length) {
    return null;
  }

  const startIndex = Math.max(0, index - lookback);
  const endIndex = index + 1;
  
  // Get price lows and highs in the lookback period
  const prices = candles.slice(startIndex, endIndex).map(c => c.close);
  const priceExtremes = findLocalExtremes(prices, 3);
  
  // Calculate RSI values for the lookback period
  const rsiValues = calculateRSIValues(candles.slice(0, endIndex));
  const lookbackRSI = rsiValues.slice(startIndex, endIndex);
  const rsiExtremes = findLocalExtremes(lookbackRSI, 3);
  
  // Check for bullish divergence (lower lows in price, higher lows in RSI)
  const bullishSignal = checkBullishDivergence(
    prices, priceExtremes.minima,
    lookbackRSI, rsiExtremes.minima,
    startIndex
  );
  if (bullishSignal) {
    return { ...bullishSignal, indicator: 'rsi' };
  }

  // Check for bearish divergence (higher highs in price, lower highs in RSI)
  const bearishSignal = checkBearishDivergence(
    prices, priceExtremes.maxima,
    lookbackRSI, rsiExtremes.maxima,
    startIndex
  );
  if (bearishSignal) {
    return { ...bearishSignal, indicator: 'rsi' };
  }

  // Check for hidden bullish divergence (higher lows in price, lower lows in RSI)
  const hiddenBullishSignal = checkHiddenBullishDivergence(
    prices, priceExtremes.minima,
    lookbackRSI, rsiExtremes.minima,
    startIndex
  );
  if (hiddenBullishSignal) {
    return { ...hiddenBullishSignal, indicator: 'rsi' };
  }

  // Check for hidden bearish divergence (lower highs in price, higher highs in RSI)
  const hiddenBearishSignal = checkHiddenBearishDivergence(
    prices, priceExtremes.maxima,
    lookbackRSI, rsiExtremes.maxima,
    startIndex
  );
  if (hiddenBearishSignal) {
    return { ...hiddenBearishSignal, indicator: 'rsi' };
  }

  return null;
}

/**
 * Detect MACD divergence at a specific index
 * 
 * @param candles Price candles
 * @param index Current index to check
 * @param lookback Number of periods to look back for divergence
 * @returns Divergence signal or null if no divergence detected
 */
export function detectMACDDivergence(
  candles: PriceCandle[],
  index: number,
  lookback: number = DEFAULT_LOOKBACK
): DivergenceSignal | null {
  const minRequired = MACD_SLOW + MACD_SIGNAL + lookback;
  
  if (index < minRequired || index >= candles.length) {
    return null;
  }

  const startIndex = Math.max(0, index - lookback);
  const endIndex = index + 1;
  
  // Get price lows and highs in the lookback period
  const prices = candles.slice(startIndex, endIndex).map(c => c.close);
  const priceExtremes = findLocalExtremes(prices, 3);
  
  // Calculate MACD values for the lookback period
  const macdValues = calculateMACDValues(candles.slice(0, endIndex));
  const lookbackMACD = macdValues.slice(startIndex, endIndex);
  const macdExtremes = findLocalExtremes(lookbackMACD, 3);
  
  // Check for bullish divergence
  const bullishSignal = checkBullishDivergence(
    prices, priceExtremes.minima,
    lookbackMACD, macdExtremes.minima,
    startIndex
  );
  if (bullishSignal) {
    return { ...bullishSignal, indicator: 'macd' };
  }

  // Check for bearish divergence
  const bearishSignal = checkBearishDivergence(
    prices, priceExtremes.maxima,
    lookbackMACD, macdExtremes.maxima,
    startIndex
  );
  if (bearishSignal) {
    return { ...bearishSignal, indicator: 'macd' };
  }

  // Check for hidden bullish divergence
  const hiddenBullishSignal = checkHiddenBullishDivergence(
    prices, priceExtremes.minima,
    lookbackMACD, macdExtremes.minima,
    startIndex
  );
  if (hiddenBullishSignal) {
    return { ...hiddenBullishSignal, indicator: 'macd' };
  }

  // Check for hidden bearish divergence
  const hiddenBearishSignal = checkHiddenBearishDivergence(
    prices, priceExtremes.maxima,
    lookbackMACD, macdExtremes.maxima,
    startIndex
  );
  if (hiddenBearishSignal) {
    return { ...hiddenBearishSignal, indicator: 'macd' };
  }

  return null;
}

/**
 * Check for regular bullish divergence
 * Price: lower lows, Indicator: higher lows
 */
function checkBullishDivergence(
  prices: number[],
  priceMinima: number[],
  indicator: number[],
  indicatorMinima: number[],
  baseIndex: number
): Omit<DivergenceSignal, 'indicator'> | null {
  if (priceMinima.length < 2 || indicatorMinima.length < 2) {
    return null;
  }

  // Get the two most recent lows
  const recentPriceMinima = priceMinima.slice(-2);
  const recentIndicatorMinima = indicatorMinima.slice(-2);

  // Bounds check: ensure indices are within array bounds
  if (
    recentPriceMinima[0] >= prices.length ||
    recentPriceMinima[1] >= prices.length ||
    recentIndicatorMinima[0] >= indicator.length ||
    recentIndicatorMinima[1] >= indicator.length
  ) {
    return null;
  }

  const priceLow1 = prices[recentPriceMinima[0]];
  const priceLow2 = prices[recentPriceMinima[1]];
  const indicatorLow1 = indicator[recentIndicatorMinima[0]];
  const indicatorLow2 = indicator[recentIndicatorMinima[1]];

  // Price makes lower low, indicator makes higher low
  if (priceLow2 < priceLow1 && indicatorLow2 > indicatorLow1) {
    // Guard against division by zero
    const priceDiff = ((priceLow2 - priceLow1) / (priceLow1 || 1)) * 100;
    const indicatorDiff = ((indicatorLow2 - indicatorLow1) / Math.abs(indicatorLow1 || 1)) * 100;

    return {
      type: 'bullish',
      strength: calculateDivergenceStrength(priceDiff, indicatorDiff),
      priceExtremes: {
        first: { index: baseIndex + recentPriceMinima[0], value: priceLow1 },
        second: { index: baseIndex + recentPriceMinima[1], value: priceLow2 },
      },
      indicatorExtremes: {
        first: { index: baseIndex + recentIndicatorMinima[0], value: indicatorLow1 },
        second: { index: baseIndex + recentIndicatorMinima[1], value: indicatorLow2 },
      },
    };
  }

  return null;
}

/**
 * Check for regular bearish divergence
 * Price: higher highs, Indicator: lower highs
 */
function checkBearishDivergence(
  prices: number[],
  priceMaxima: number[],
  indicator: number[],
  indicatorMaxima: number[],
  baseIndex: number
): Omit<DivergenceSignal, 'indicator'> | null {
  if (priceMaxima.length < 2 || indicatorMaxima.length < 2) {
    return null;
  }

  // Get the two most recent highs
  const recentPriceMaxima = priceMaxima.slice(-2);
  const recentIndicatorMaxima = indicatorMaxima.slice(-2);

  // Bounds check: ensure indices are within array bounds
  if (
    recentPriceMaxima[0] >= prices.length ||
    recentPriceMaxima[1] >= prices.length ||
    recentIndicatorMaxima[0] >= indicator.length ||
    recentIndicatorMaxima[1] >= indicator.length
  ) {
    return null;
  }

  const priceHigh1 = prices[recentPriceMaxima[0]];
  const priceHigh2 = prices[recentPriceMaxima[1]];
  const indicatorHigh1 = indicator[recentIndicatorMaxima[0]];
  const indicatorHigh2 = indicator[recentIndicatorMaxima[1]];

  // Price makes higher high, indicator makes lower high
  if (priceHigh2 > priceHigh1 && indicatorHigh2 < indicatorHigh1) {
    // Guard against division by zero
    const priceDiff = ((priceHigh2 - priceHigh1) / (priceHigh1 || 1)) * 100;
    const indicatorDiff = ((indicatorHigh2 - indicatorHigh1) / Math.abs(indicatorHigh1 || 1)) * 100;

    return {
      type: 'bearish',
      strength: calculateDivergenceStrength(priceDiff, indicatorDiff),
      priceExtremes: {
        first: { index: baseIndex + recentPriceMaxima[0], value: priceHigh1 },
        second: { index: baseIndex + recentPriceMaxima[1], value: priceHigh2 },
      },
      indicatorExtremes: {
        first: { index: baseIndex + recentIndicatorMaxima[0], value: indicatorHigh1 },
        second: { index: baseIndex + recentIndicatorMaxima[1], value: indicatorHigh2 },
      },
    };
  }

  return null;
}

/**
 * Check for hidden bullish divergence (trend continuation)
 * Price: higher lows, Indicator: lower lows
 */
function checkHiddenBullishDivergence(
  prices: number[],
  priceMinima: number[],
  indicator: number[],
  indicatorMinima: number[],
  baseIndex: number
): Omit<DivergenceSignal, 'indicator'> | null {
  if (priceMinima.length < 2 || indicatorMinima.length < 2) {
    return null;
  }

  const recentPriceMinima = priceMinima.slice(-2);
  const recentIndicatorMinima = indicatorMinima.slice(-2);

  // Bounds check: ensure indices are within array bounds
  if (
    recentPriceMinima[0] >= prices.length ||
    recentPriceMinima[1] >= prices.length ||
    recentIndicatorMinima[0] >= indicator.length ||
    recentIndicatorMinima[1] >= indicator.length
  ) {
    return null;
  }

  const priceLow1 = prices[recentPriceMinima[0]];
  const priceLow2 = prices[recentPriceMinima[1]];
  const indicatorLow1 = indicator[recentIndicatorMinima[0]];
  const indicatorLow2 = indicator[recentIndicatorMinima[1]];

  // Price makes higher low, indicator makes lower low
  if (priceLow2 > priceLow1 && indicatorLow2 < indicatorLow1) {
    // Guard against division by zero
    const priceDiff = ((priceLow2 - priceLow1) / (priceLow1 || 1)) * 100;
    const indicatorDiff = ((indicatorLow2 - indicatorLow1) / Math.abs(indicatorLow1 || 1)) * 100;

    return {
      type: 'hidden-bullish',
      strength: calculateDivergenceStrength(priceDiff, indicatorDiff) * 0.8, // Hidden divergence slightly weaker
      priceExtremes: {
        first: { index: baseIndex + recentPriceMinima[0], value: priceLow1 },
        second: { index: baseIndex + recentPriceMinima[1], value: priceLow2 },
      },
      indicatorExtremes: {
        first: { index: baseIndex + recentIndicatorMinima[0], value: indicatorLow1 },
        second: { index: baseIndex + recentIndicatorMinima[1], value: indicatorLow2 },
      },
    };
  }

  return null;
}

/**
 * Check for hidden bearish divergence (trend continuation)
 * Price: lower highs, Indicator: higher highs
 */
function checkHiddenBearishDivergence(
  prices: number[],
  priceMaxima: number[],
  indicator: number[],
  indicatorMaxima: number[],
  baseIndex: number
): Omit<DivergenceSignal, 'indicator'> | null {
  if (priceMaxima.length < 2 || indicatorMaxima.length < 2) {
    return null;
  }

  const recentPriceMaxima = priceMaxima.slice(-2);
  const recentIndicatorMaxima = indicatorMaxima.slice(-2);

  // Bounds check: ensure indices are within array bounds
  if (
    recentPriceMaxima[0] >= prices.length ||
    recentPriceMaxima[1] >= prices.length ||
    recentIndicatorMaxima[0] >= indicator.length ||
    recentIndicatorMaxima[1] >= indicator.length
  ) {
    return null;
  }

  const priceHigh1 = prices[recentPriceMaxima[0]];
  const priceHigh2 = prices[recentPriceMaxima[1]];
  const indicatorHigh1 = indicator[recentIndicatorMaxima[0]];
  const indicatorHigh2 = indicator[recentIndicatorMaxima[1]];

  // Price makes lower high, indicator makes higher high
  if (priceHigh2 < priceHigh1 && indicatorHigh2 > indicatorHigh1) {
    // Guard against division by zero
    const priceDiff = ((priceHigh2 - priceHigh1) / (priceHigh1 || 1)) * 100;
    const indicatorDiff = ((indicatorHigh2 - indicatorHigh1) / Math.abs(indicatorHigh1 || 1)) * 100;

    return {
      type: 'hidden-bearish',
      strength: calculateDivergenceStrength(priceDiff, indicatorDiff) * 0.8, // Hidden divergence slightly weaker
      priceExtremes: {
        first: { index: baseIndex + recentPriceMaxima[0], value: priceHigh1 },
        second: { index: baseIndex + recentPriceMaxima[1], value: priceHigh2 },
      },
      indicatorExtremes: {
        first: { index: baseIndex + recentIndicatorMaxima[0], value: indicatorHigh1 },
        second: { index: baseIndex + recentIndicatorMaxima[1], value: indicatorHigh2 },
      },
    };
  }

  return null;
}

