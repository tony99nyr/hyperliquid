/**
 * Technical indicator calculations for trading signals
 */

import type { PriceCandle } from '@/types';

/**
 * Calculate Simple Moving Average (SMA)
 */
export function calculateSMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const sma: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma.push(sum / period);
  }

  return sma;
}

/**
 * Calculate Exponential Moving Average (EMA)
 */
export function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // Start with SMA for first value
  const firstSMA = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(firstSMA);

  // Calculate EMA for remaining values
  for (let i = period; i < prices.length; i++) {
    const currentEMA = (prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
    ema.push(currentEMA);
  }

  return ema;
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
export function calculateMACD(
  prices: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macd: number[] = [];
  const offset = slowPeriod - fastPeriod;
  // Guard: validate both arrays have sufficient length
  if (fastEMA.length === 0 || slowEMA.length === 0) {
    return { macd: [], signal: [], histogram: [] };
  }
  for (let i = 0; i < slowEMA.length; i++) {
    if (i + offset >= 0 && i + offset < fastEMA.length) {
      const macdValue = fastEMA[i + offset] - slowEMA[i];
      // Validate the subtraction didn't produce NaN
      if (Number.isFinite(macdValue)) {
        macd.push(macdValue);
      }
    }
  }

  // Signal line = EMA of MACD
  const signal = calculateEMA(macd, signalPeriod);

  // Histogram = MACD - Signal
  const histogram: number[] = [];
  const signalOffset = macd.length - signal.length;
  for (let i = 0; i < signal.length; i++) {
    histogram.push(macd[i + signalOffset] - signal[i]);
  }

  return { macd, signal, histogram };
}

/**
 * Calculate RSI (Relative Strength Index)
 */
export function calculateRSI(prices: number[], period: number = 14): number[] {
  if (prices.length < period + 1) return [];

  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  // Calculate initial average gain and loss
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  // Calculate first RSI
  if (avgLoss === 0 && avgGain === 0) {
    // Flat price action = neutral RSI
    rsi.push(50);
  } else if (avgLoss === 0) {
    // All gains, no losses = max RSI
    rsi.push(100);
  } else {
    const rs = avgGain / avgLoss;
    rsi.push(100 - 100 / (1 + rs));
  }

  // Calculate subsequent RSI values using Wilder's smoothing
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0 && avgGain === 0) {
      // Flat price action = neutral RSI
      rsi.push(50);
    } else if (avgLoss === 0) {
      // All gains, no losses = max RSI
      rsi.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }

  return rsi;
}

/**
 * Calculate Bollinger Bands
 */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const sma = calculateSMA(prices, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < sma.length; i++) {
    const startIdx = i;
    const endIdx = startIdx + period;
    const slice = prices.slice(startIdx, endIdx);

    // Calculate standard deviation
    const mean = sma[i];
    const variance = slice.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
    // Guard against negative variance due to floating-point precision errors
    const standardDev = Math.sqrt(Math.max(0, variance));

    upper.push(mean + stdDev * standardDev);
    lower.push(mean - stdDev * standardDev);
  }

  return { upper, middle: sma, lower };
}

/**
 * Calculate Average True Range (ATR)
 * ATR measures market volatility by averaging true ranges over a period
 * 
 * True Range = max(
 *   high - low,
 *   abs(high - previousClose),
 *   abs(low - previousClose)
 * )
 * 
 * ATR = EMA or SMA of True Range
 */
export function calculateATR(
  candles: PriceCandle[],
  period: number = 14,
  useEMA: boolean = true
): number[] {
  if (candles.length < period + 1) return [];

  const trueRanges: number[] = [];

  // Calculate True Range for each candle
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;

    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - previous.close);
    const tr3 = Math.abs(current.low - previous.close);

    const trueRange = Math.max(tr1, tr2, tr3);
    trueRanges.push(trueRange);
  }

  // Calculate ATR using EMA or SMA
  if (useEMA) {
    return calculateEMA(trueRanges, period);
  } else {
    return calculateSMA(trueRanges, period);
  }
}

/**
 * Get ATR value at a specific candle index
 *
 * ATR calculation:
 * - trueRanges[i] = TR of candle[i+1] (needs previous close)
 * - atr[k] = EMA/SMA using trueRanges[0..period-1+k] = TR of candles[1..period+k]
 * - atr[k] is the ATR value valid at the END of candle[period+k]
 *
 * To get ATR at candle[index], return atr[index - period]
 */
export function getATRValue(
  candles: PriceCandle[],
  index: number,
  period: number = 14,
  useEMA: boolean = true
): number | null {
  // Need at least period+1 candles to compute ATR
  // ATR is first available at index = period (using candles 0 to period)
  if (index < period || candles.length < period + 1) return null;

  const atr = calculateATR(candles, period, useEMA);
  // atr[k] corresponds to candle[period + k]
  // To get ATR at candle[index], we need atr[index - period]
  const atrIndex = index - period;

  if (atrIndex >= 0 && atrIndex < atr.length) {
    return atr[atrIndex];
  }

  return null;
}

/**
 * Get the latest value from an indicator array (handles alignment with price data)
 */
export function getLatestIndicatorValue(
  indicatorValues: number[],
  priceIndex: number,
  indicatorOffset: number = 0
): number | null {
  const index = priceIndex - indicatorOffset;
  if (index >= 0 && index < indicatorValues.length) {
    return indicatorValues[index];
  }
  return null;
}







