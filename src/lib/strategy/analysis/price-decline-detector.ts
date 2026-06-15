/**
 * Price Decline Detection
 *
 * Pure functions for detecting rapid price declines that may indicate crashes.
 * Separated from strategy logic for testability and reusability.
 */

export interface PriceDeclineThresholds {
  singlePeriod: number; // e.g., 0.04 = 4% drop in 1 period
  shortTerm: number; // e.g., 0.025 = 2.5% drop in 10 periods
  mediumTerm: number; // e.g., 0.03 = 3% drop in 20 periods
}

export interface PriceDeclineResult {
  isDecline: boolean;
  severity: 'none' | 'single' | 'short' | 'medium';
  percentChange: number;
  periodsAnalyzed: number;
  message: string;
}

export const DEFAULT_DECLINE_THRESHOLDS: PriceDeclineThresholds = {
  singlePeriod: 0.04, // 4%
  shortTerm: 0.025, // 2.5%
  mediumTerm: 0.03, // 3%
};

/**
 * Detect rapid price decline across multiple timeframes
 *
 * Pure function: (prices, thresholds) → decline result
 */
export function detectPriceDecline(
  currentPrice: number,
  historicalPrices: {
    onePeriodAgo?: number;
    tenPeriodsAgo?: number;
    twentyPeriodsAgo?: number;
  },
  thresholds: PriceDeclineThresholds = DEFAULT_DECLINE_THRESHOLDS
): PriceDeclineResult {
  // Check single-period decline (most immediate)
  if (historicalPrices.onePeriodAgo !== undefined && historicalPrices.onePeriodAgo !== 0) {
    const change = (currentPrice - historicalPrices.onePeriodAgo) / historicalPrices.onePeriodAgo;
    if (change < -thresholds.singlePeriod) {
      return {
        isDecline: true,
        severity: 'single',
        percentChange: change * 100,
        periodsAnalyzed: 1,
        message: `Single-period crash: ${(change * 100).toFixed(1)}% drop in 1 period`,
      };
    }
  }

  // Check short-term decline (10 periods)
  if (historicalPrices.tenPeriodsAgo !== undefined && historicalPrices.tenPeriodsAgo !== 0) {
    const change = (currentPrice - historicalPrices.tenPeriodsAgo) / historicalPrices.tenPeriodsAgo;
    if (change < -thresholds.shortTerm) {
      return {
        isDecline: true,
        severity: 'short',
        percentChange: change * 100,
        periodsAnalyzed: 10,
        message: `Short-term decline: ${(change * 100).toFixed(1)}% drop in 10 periods`,
      };
    }
  }

  // Check medium-term decline (20 periods)
  if (historicalPrices.twentyPeriodsAgo !== undefined && historicalPrices.twentyPeriodsAgo !== 0) {
    const change = (currentPrice - historicalPrices.twentyPeriodsAgo) / historicalPrices.twentyPeriodsAgo;
    if (change < -thresholds.mediumTerm) {
      return {
        isDecline: true,
        severity: 'medium',
        percentChange: change * 100,
        periodsAnalyzed: 20,
        message: `Medium-term decline: ${(change * 100).toFixed(1)}% drop in 20 periods`,
      };
    }
  }

  // No decline detected
  return {
    isDecline: false,
    severity: 'none',
    percentChange: 0,
    periodsAnalyzed: 0,
    message: 'No significant decline detected',
  };
}

/**
 * Calculate price changes from candle data
 *
 * Pure function: (candles, index) → price changes
 */
export function calculatePriceChanges(
  candles: Array<{ close: number }>,
  currentIndex: number
): {
  singlePeriod?: number;
  shortTerm?: number;
  mediumTerm?: number;
} {
  const currentPrice = candles[currentIndex]?.close;
  if (!currentPrice) return {};

  const changes: {
    singlePeriod?: number;
    shortTerm?: number;
    mediumTerm?: number;
  } = {};

  if (currentIndex >= 1) {
    const previousPrice = candles[currentIndex - 1]?.close;
    if (previousPrice) {
      changes.singlePeriod = (currentPrice - previousPrice) / previousPrice;
    }
  }

  if (currentIndex >= 10) {
    const price10Ago = candles[currentIndex - 10]?.close;
    if (price10Ago) {
      changes.shortTerm = (currentPrice - price10Ago) / price10Ago;
    }
  }

  if (currentIndex >= 20) {
    const price20Ago = candles[currentIndex - 20]?.close;
    if (price20Ago) {
      changes.mediumTerm = (currentPrice - price20Ago) / price20Ago;
    }
  }

  return changes;
}
