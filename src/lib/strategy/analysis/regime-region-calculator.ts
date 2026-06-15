/**
 * Pure function for calculating regime regions from candle data.
 * Extracted from useRegimeRegions hook for testability.
 *
 * No side effects, no React dependencies — just candles in, regions out.
 */

import type { PriceCandle } from '@/types';
import { detectMarketRegimeCached, clearIndicatorCache } from './market-regime-detector-cached';
import type { RegimeDetectionConfig } from '../config/regime-detection-config';

export interface TimeBasedRegimeRegion {
  startTime: number;
  endTime: number;
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
}

/**
 * Calculate regime regions for a range of candles.
 *
 * Iterates sequentially from startIndex through endIndex, calling the cached
 * regime detector at each point. Consecutive same-regime periods are merged
 * into a single region.
 *
 * @param candles   Full candle array (needs ≥50 candles before startIndex for indicators)
 * @param startIndex First candle index to evaluate (must be ≥ 50)
 * @param endIndex  Last candle index to evaluate (inclusive)
 * @param config    Asset-specific regime detection config (ETH/BTC thresholds)
 */
export function calculateRegimeRegionsFromCandles(
  candles: PriceCandle[],
  startIndex: number,
  endIndex: number,
  config?: RegimeDetectionConfig,
): TimeBasedRegimeRegion[] {
  if (candles.length < 50 || startIndex > endIndex || startIndex >= candles.length) {
    return [];
  }

  // Clamp indices
  const safeStart = Math.max(50, startIndex);
  const safeEnd = Math.min(endIndex, candles.length - 1);

  if (safeStart > safeEnd) return [];

  // Clear cache for fresh sequential calculation
  clearIndicatorCache();

  const regions: TimeBasedRegimeRegion[] = [];
  let lastRegime: 'bullish' | 'bearish' | 'neutral' | null = null;
  let regionStart = 0;
  let regionConfidence = 0;

  for (let i = safeStart; i <= safeEnd; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const signal = detectMarketRegimeCached(candles, i, config);
    const regime = signal.regime;

    if (regime !== lastRegime) {
      // Close previous region
      if (lastRegime !== null) {
        const prevCandle = candles[i - 1];
        if (prevCandle) {
          regions.push({
            startTime: regionStart,
            endTime: prevCandle.timestamp,
            regime: lastRegime,
            confidence: regionConfidence,
          });
        }
      }
      // Start new region
      lastRegime = regime;
      regionStart = candle.timestamp;
      regionConfidence = signal.confidence;
    } else {
      regionConfidence = Math.max(regionConfidence, signal.confidence);
    }
  }

  // Close final region
  if (lastRegime !== null) {
    const lastCandle = candles[safeEnd];
    if (lastCandle) {
      regions.push({
        startTime: regionStart,
        endTime: lastCandle.timestamp,
        regime: lastRegime,
        confidence: regionConfidence,
      });
    }
  }

  return regions;
}

/**
 * Find the regime region that contains a given timestamp.
 * Returns null if the timestamp falls outside all regions.
 */
export function findRegimeAtTimestamp(
  regions: TimeBasedRegimeRegion[],
  timestamp: number,
): TimeBasedRegimeRegion | null {
  for (const region of regions) {
    if (timestamp >= region.startTime && timestamp <= region.endTime) {
      return region;
    }
  }
  return null;
}
