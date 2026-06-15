/**
 * Volume-based Technical Indicators
 * Provides volume analysis tools: VWAP, OBV, Volume Rate of Change, Volume-weighted MACD
 */

import type { PriceCandle } from '@/types';
import { calculateMACD } from './indicators';
// calculateEMA may be needed for future volume indicator enhancements

/**
 * Calculate Volume Weighted Average Price (VWAP)
 * VWAP = Sum(Price * Volume) / Sum(Volume) over a period
 */
export function calculateVWAP(
  candles: PriceCandle[],
  period: number,
  currentIndex: number
): number | null {
  if (currentIndex < period - 1 || currentIndex >= candles.length) {
    return null;
  }

  const periodCandles = candles.slice(currentIndex - period + 1, currentIndex + 1);
  let totalPriceVolume = 0;
  let totalVolume = 0;

  for (const candle of periodCandles) {
    // Use typical price (high + low + close) / 3 for VWAP
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    totalPriceVolume += typicalPrice * candle.volume;
    totalVolume += candle.volume;
  }

  if (totalVolume === 0) {
    return null;
  }

  return totalPriceVolume / totalVolume;
}

/**
 * Calculate On-Balance Volume (OBV)
 * OBV accumulates volume based on price direction
 * If close > previous close: add volume
 * If close < previous close: subtract volume
 * If close == previous close: OBV unchanged
 */
export function calculateOBV(candles: PriceCandle[]): number[] {
  if (candles.length === 0) {
    return [];
  }

  const obv: number[] = [];
  let cumulativeOBV = 0;

  // First candle: OBV = volume (or 0 if we want to start neutral)
  obv.push(candles[0]!.volume);
  cumulativeOBV = candles[0]!.volume;

  for (let i = 1; i < candles.length; i++) {
    const currentClose = candles[i]!.close;
    const previousClose = candles[i - 1]!.close;
    const currentVolume = candles[i]!.volume;

    if (currentClose > previousClose) {
      // Price up: add volume
      cumulativeOBV += currentVolume;
    } else if (currentClose < previousClose) {
      // Price down: subtract volume
      cumulativeOBV -= currentVolume;
    }
    // If equal, OBV stays the same

    obv.push(cumulativeOBV);
  }

  return obv;
}

/**
 * Calculate Volume Rate of Change
 * Measures the rate of change in volume over a period
 * VROC = ((Current Volume - Volume N periods ago) / Volume N periods ago) * 100
 */
export function calculateVolumeROC(
  candles: PriceCandle[],
  period: number,
  currentIndex: number
): number | null {
  if (currentIndex < period || currentIndex >= candles.length) {
    return null;
  }

  const currentVolume = candles[currentIndex]!.volume;
  const pastVolume = candles[currentIndex - period]!.volume;

  if (pastVolume === 0) {
    return null;
  }

  return ((currentVolume - pastVolume) / pastVolume) * 100;
}

/**
 * Calculate Volume-weighted MACD
 * Uses volume-weighted prices instead of simple close prices
 */
export function calculateVolumeWeightedMACD(
  candles: PriceCandle[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): {
  vwmacd: number[];
  signal: number[];
  histogram: number[];
} {
  if (candles.length < slowPeriod) {
    return { vwmacd: [], signal: [], histogram: [] };
  }

  // Calculate volume-weighted prices (VWAP for each candle)
  const vwapPrices: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    // Use a short period for VWAP (e.g., 5) or just use typical price weighted by volume
    // For simplicity, use typical price * volume ratio
    const typicalPrice = (candles[i]!.high + candles[i]!.low + candles[i]!.close) / 3;
    
    // Calculate average volume over a short period for normalization
    const volumePeriod = Math.min(5, i + 1);
    const avgVolume = candles
      .slice(Math.max(0, i - volumePeriod + 1), i + 1)
      .reduce((sum, c) => sum + c.volume, 0) / volumePeriod;
    
    // Volume-weighted price: typical price adjusted by volume ratio
    const volumeRatio = avgVolume > 0 ? candles[i]!.volume / avgVolume : 1;
    vwapPrices.push(typicalPrice * (1 + (volumeRatio - 1) * 0.1)); // Scale volume effect
  }

  // Calculate MACD on volume-weighted prices
  const result = calculateMACD(vwapPrices, fastPeriod, slowPeriod, signalPeriod);
  
  // Ensure we always return the expected structure
  return {
    vwmacd: result.macd || [],
    signal: result.signal || [],
    histogram: result.histogram || [],
  };
}

/**
 * Calculate Volume Moving Average
 * Simple moving average of volume
 */
export function calculateVolumeMA(
  candles: PriceCandle[],
  period: number
): number[] {
  if (candles.length < period) {
    return [];
  }

  const volumes = candles.map(c => c.volume);
  const volumeMA: number[] = [];

  for (let i = period - 1; i < volumes.length; i++) {
    const sum = volumes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    volumeMA.push(sum / period);
  }

  return volumeMA;
}

/**
 * Calculate Volume Price Trend (VPT)
 * Similar to OBV but uses percentage price change
 * VPT = Previous VPT + (Volume * ((Close - Previous Close) / Previous Close))
 */
export function calculateVPT(candles: PriceCandle[]): number[] {
  if (candles.length === 0) {
    return [];
  }

  const vpt: number[] = [];
  let cumulativeVPT = 0;

  // First candle: VPT = 0 (or initial volume)
  vpt.push(candles[0]!.volume);
  cumulativeVPT = candles[0]!.volume;

  for (let i = 1; i < candles.length; i++) {
    const currentClose = candles[i]!.close;
    const previousClose = candles[i - 1]!.close;
    const currentVolume = candles[i]!.volume;

    if (previousClose > 0) {
      const priceChange = (currentClose - previousClose) / previousClose;
      cumulativeVPT += currentVolume * priceChange;
    }

    vpt.push(cumulativeVPT);
  }

  return vpt;
}

/**
 * Get latest volume indicator value
 */
export function getLatestVolumeIndicatorValue(
  values: number[],
  currentIndex: number,
  offset: number = 0
): number | null {
  const targetIndex = currentIndex - offset;
  if (targetIndex < 0 || targetIndex >= values.length) {
    return null;
  }
  return values[targetIndex];
}

