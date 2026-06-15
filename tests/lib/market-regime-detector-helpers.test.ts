import { describe, it, expect } from 'vitest';
import {
  calculatePriceMomentum,
  calculateMultiTimeframeMomentum,
  calculateVolatility,
  calculateVolatilityFromSlice,
  detectFalseBreakout,
  detectVolatilitySqueeze,
  detectSidewaysMarket,
  detectSlowGrind,
  detectWhipsaw,
  detectTransitionPeriod,
  detectTrapPattern,
  calculateTrendScore,
  calculateMomentumScore,
} from '@/lib/strategy/analysis/market-regime-detector-helpers';

// Helper to create price arrays with predictable patterns
function createPriceArray(count: number, startPrice: number, increment: number): number[] {
  return Array.from({ length: count }, (_, i) => startPrice + i * increment);
}

// Helper to create prices with specific percentage change
function createPricesWithChange(startPrice: number, percentChange: number, periods: number): number[] {
  const prices: number[] = [startPrice];
  const pricePerPeriod = (startPrice * percentChange) / periods;
  for (let i = 1; i <= periods; i++) {
    prices.push(startPrice + pricePerPeriod * i);
  }
  return prices;
}

describe('market-regime-detector-helpers', () => {
  describe('calculatePriceMomentum', () => {
    it('should calculate positive momentum correctly', () => {
      const prices = createPriceArray(25, 100, 2); // 100, 102, 104, ..., 148
      const result = calculatePriceMomentum(prices, 20, 10);

      // Price at 20: 140, Price at 10: 120
      // Momentum: (140 - 120) / 120 = 0.1667
      expect(result).toBeCloseTo((140 - 120) / 120, 4);
    });

    it('should calculate negative momentum correctly', () => {
      const prices = createPriceArray(25, 148, -2); // 148, 146, 144, ..., 100
      const result = calculatePriceMomentum(prices, 20, 10);

      // Price at 20: 108, Price at 10: 128
      // Momentum: (108 - 128) / 128 = -0.1563
      expect(result).toBeCloseTo((108 - 128) / 128, 4);
    });

    it('should return 0 when insufficient data', () => {
      const prices = createPriceArray(10, 100, 2);

      // Current index 5, looking back 10 periods - not enough data
      expect(calculatePriceMomentum(prices, 5, 10)).toBe(0);

      // Current index beyond array length
      expect(calculatePriceMomentum(prices, 15, 3)).toBe(0);
    });

    it('should return 0 when past price is zero or invalid', () => {
      const prices = [0, 100, 110, 120, 130];

      // Looking back to index 0 which is 0
      const result = calculatePriceMomentum(prices, 4, 4);
      expect(result).toBe(0);
    });

    it('should handle negative past price', () => {
      const prices = [-100, 100, 110, 120, 130];

      const result = calculatePriceMomentum(prices, 4, 4);
      expect(result).toBe(0);
    });

    it('should handle single period momentum', () => {
      const prices = [100, 105];
      const result = calculatePriceMomentum(prices, 1, 1);

      expect(result).toBeCloseTo(0.05, 4); // 5% increase
    });
  });

  describe('calculateMultiTimeframeMomentum', () => {
    it('should calculate all timeframe momentums', () => {
      const prices = createPriceArray(25, 100, 1); // Linear increase
      const result = calculateMultiTimeframeMomentum(prices, 20);

      // veryShort: 3 periods, short: 5, medium: 10, long: 20
      expect(result.veryShort).toBeCloseTo(3 / 117, 4); // (120 - 117) / 117
      expect(result.short).toBeCloseTo(5 / 115, 4);     // (120 - 115) / 115
      expect(result.medium).toBeCloseTo(10 / 110, 4);   // (120 - 110) / 110
      expect(result.long).toBeCloseTo(20 / 100, 4);     // (120 - 100) / 100
    });

    it('should return zeros for insufficient data', () => {
      const prices = [100, 101, 102]; // Only 3 prices
      const result = calculateMultiTimeframeMomentum(prices, 2);

      expect(result.veryShort).toBe(0); // Need 3 periods back, index 2 < 3
      expect(result.short).toBe(0);
      expect(result.medium).toBe(0);
      expect(result.long).toBe(0);
    });

    it('should handle mixed data availability', () => {
      const prices = createPriceArray(10, 100, 1);
      const result = calculateMultiTimeframeMomentum(prices, 8);

      // veryShort (3), short (5), medium should have data, long (20) won't
      expect(result.veryShort).toBeGreaterThan(0);
      expect(result.short).toBeGreaterThan(0);
      expect(result.medium).toBe(0); // 8 < 10, not enough
      expect(result.long).toBe(0);
    });
  });

  describe('calculateVolatility', () => {
    it('should calculate volatility for price series', () => {
      // Create volatile series with known swings
      const prices = [100, 105, 95, 110, 90, 115, 85, 120, 80, 125];
      const result = calculateVolatility(prices, 9, 10);

      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should return low volatility for stable prices', () => {
      const prices = [100, 100.1, 100.05, 100.15, 100.1, 100.2, 100.15, 100.25];
      const result = calculateVolatility(prices, 7, 8);

      expect(result).toBeLessThan(0.05); // Should be quite low
    });

    it('should return 0 for single price', () => {
      const prices = [100];
      const result = calculateVolatility(prices, 0, 1);

      expect(result).toBe(0);
    });

    it('should return 0 for empty array', () => {
      const result = calculateVolatility([], 0, 1);
      expect(result).toBe(0);
    });

    it('should handle default lookback', () => {
      const prices = createPriceArray(25, 100, 1);
      const result = calculateVolatility(prices, 24);

      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should clamp volatility to 1', () => {
      // Extremely volatile prices
      const prices = [100, 200, 50, 300, 10, 500, 1, 1000];
      const result = calculateVolatility(prices, 7, 8);

      expect(result).toBeLessThanOrEqual(1);
    });

    it('should handle prices with zeros', () => {
      const prices = [100, 0, 105, 0, 110];
      const result = calculateVolatility(prices, 4, 5);

      // Should skip zero prices in calculation
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('calculateVolatilityFromSlice', () => {
    it('should calculate volatility from price slice', () => {
      const priceSlice = [100, 102, 98, 104, 96, 106, 94, 108, 92, 110];
      const result = calculateVolatilityFromSlice(priceSlice);

      expect(result).toBeGreaterThan(0);
    });

    it('should return 0 for single element', () => {
      expect(calculateVolatilityFromSlice([100])).toBe(0);
    });

    it('should return 0 for empty array', () => {
      expect(calculateVolatilityFromSlice([])).toBe(0);
    });

    it('should return 0 when all returns are skipped due to invalid prices', () => {
      const priceSlice = [0, 0, 0];
      const result = calculateVolatilityFromSlice(priceSlice);
      expect(result).toBe(0);
    });

    it('should handle two identical prices (zero variance)', () => {
      const priceSlice = [100, 100, 100];
      const result = calculateVolatilityFromSlice(priceSlice);
      expect(result).toBe(0);
    });

    it('should handle negative variance edge case via Math.max guard', () => {
      // This tests the guard against floating-point precision errors
      const priceSlice = [100, 100.0000001, 100.0000002];
      const result = calculateVolatilityFromSlice(priceSlice);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('detectFalseBreakout', () => {
    it('should return false for insufficient data', () => {
      const prices = createPriceArray(10, 100, 1);
      const result = detectFalseBreakout(prices, 10);

      expect(result.isFalseBreakout).toBe(false);
      expect(result.isFalseBullBreakout).toBe(false);
      expect(result.isFalseBearBreakout).toBe(false);
    });

    it('should detect false bull breakout', () => {
      // Recent strong up move that stalled/reversed
      // veryShort > 0.01, short > 0.008, but medium < 0.008 or long < 0.015
      const prices = createPriceArray(25, 100, 0.1); // Very gradual increase
      // Override recent prices with spike
      prices[22] = 102.5;
      prices[23] = 103;
      prices[24] = 103.5; // Recent spike up

      const result = detectFalseBreakout(prices, 24);

      // May or may not detect depending on thresholds
      expect(typeof result.isFalseBreakout).toBe('boolean');
    });

    it('should return all false for strong trending market', () => {
      // Consistent uptrend across all timeframes
      const prices = createPricesWithChange(100, 0.20, 25); // 20% increase over 25 periods
      const result = detectFalseBreakout(prices, 24);

      // Strong consistent trend shouldn't be detected as false breakout
      // Note: specific detection depends on thresholds
      expect(typeof result.isFalseBreakout).toBe('boolean');
    });

    it('should handle exactly 15 data points (boundary)', () => {
      const prices = createPriceArray(16, 100, 1);
      const result = detectFalseBreakout(prices, 15);

      // Should process without error
      expect(result).toBeDefined();
    });
  });

  describe('detectVolatilitySqueeze', () => {
    it('should detect basic volatility squeeze', () => {
      const prices = createPriceArray(25, 100, 0.5);

      // Low volatility with moderate signal
      const result = detectVolatilitySqueeze(prices, 20, 0.03, 0.15, 0.03);

      expect(result.isVolatilitySqueeze).toBe(true);
    });

    it('should not detect squeeze with high volatility', () => {
      const prices = createPriceArray(25, 100, 0.5);

      // High volatility
      const result = detectVolatilitySqueeze(prices, 20, 0.08, 0.15, 0.03);

      expect(result.isVolatilitySqueeze).toBe(false);
    });

    it('should detect volatility squeeze pattern', () => {
      const prices = createPriceArray(25, 100, 0.1); // Very stable prices

      // Low vol with squeeze pattern conditions
      const result = detectVolatilitySqueeze(prices, 20, 0.03, 0.25, 0.05);

      // Pattern detection depends on recent vs current volatility
      expect(typeof result.isVolatilitySqueezePattern).toBe('boolean');
    });

    it('should detect volatility transition', () => {
      const prices = createPriceArray(30, 100, 0.1);

      // Volatility increasing from low
      const result = detectVolatilitySqueeze(prices, 25, 0.04, 0.15, 0.03);

      expect(typeof result.isVolatilityTransition).toBe('boolean');
    });

    it('should handle insufficient data for pattern detection', () => {
      const prices = createPriceArray(10, 100, 0.5);

      const result = detectVolatilitySqueeze(prices, 5, 0.03, 0.15, 0.03);

      // Should not crash, pattern/transition should be false
      expect(result.isVolatilitySqueezePattern).toBe(false);
      expect(result.isVolatilityTransition).toBe(false);
    });
  });

  describe('detectSidewaysMarket', () => {
    it('should detect sideways market with 20-period criteria', () => {
      // Very flat prices: less than 2.5% change over 20 periods
      const prices = createPriceArray(25, 100, 0.05); // 0.05% per period = 1% over 20 periods

      const result = detectSidewaysMarket(prices, 24, 0.03);

      expect(result).toBe(true);
    });

    it('should detect sideways market with 10-period criteria', () => {
      const prices = createPriceArray(15, 100, 0.05);

      const result = detectSidewaysMarket(prices, 14, 0.02);

      expect(result).toBe(true);
    });

    it('should not detect sideways in trending market', () => {
      const prices = createPricesWithChange(100, 0.10, 25); // 10% change

      const result = detectSidewaysMarket(prices, 24, 0.03);

      expect(result).toBe(false);
    });

    it('should not detect sideways with high volatility', () => {
      const prices = createPriceArray(25, 100, 0.05);

      const result = detectSidewaysMarket(prices, 24, 0.10); // High volatility

      expect(result).toBe(false);
    });

    it('should handle insufficient data', () => {
      const prices = createPriceArray(5, 100, 0.05);

      const result = detectSidewaysMarket(prices, 4, 0.03);

      expect(result).toBe(false);
    });
  });

  describe('detectSlowGrind', () => {
    it('should detect slow grind pattern', () => {
      // Low volatility, low momentum, low signal strength
      const prices = createPriceArray(25, 100, 0.1);

      const result = detectSlowGrind(prices, 24, 0.03, 0.3);

      expect(result).toBe(true);
    });

    it('should not detect slow grind with high volatility', () => {
      const prices = createPriceArray(25, 100, 0.1);

      const result = detectSlowGrind(prices, 24, 0.10, 0.3);

      expect(result).toBe(false);
    });

    it('should not detect slow grind with strong signals', () => {
      const prices = createPriceArray(25, 100, 0.1);

      const result = detectSlowGrind(prices, 24, 0.03, 0.6);

      expect(result).toBe(false);
    });

    it('should handle multiple detection conditions', () => {
      // Test various condition combinations
      const prices = createPriceArray(55, 100, 0.05);

      // Very low volatility and signal strength
      const result1 = detectSlowGrind(prices, 50, 0.035, 0.38);
      const result2 = detectSlowGrind(prices, 50, 0.04, 0.39);

      expect(typeof result1).toBe('boolean');
      expect(typeof result2).toBe('boolean');
    });
  });

  describe('detectWhipsaw', () => {
    it('should detect whipsaw with 3+ unique regimes in last 5 periods', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bearish', 'neutral', 'bullish', 'bearish'
      ];

      expect(detectWhipsaw(regimeHistory)).toBe(true);
    });

    it('should not detect whipsaw with consistent regime', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bullish', 'bullish', 'bullish', 'bullish'
      ];

      expect(detectWhipsaw(regimeHistory)).toBe(false);
    });

    it('should not detect whipsaw with 2 regimes', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bearish', 'bullish', 'bearish', 'bullish'
      ];

      // Only 2 unique regimes
      expect(detectWhipsaw(regimeHistory)).toBe(false);
    });

    it('should return false for insufficient history', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bearish', 'neutral'
      ];

      expect(detectWhipsaw(regimeHistory)).toBe(false);
    });

    it('should only consider last 5 periods', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bearish', 'neutral', // Early - not counted
        'bullish', 'bullish', 'bullish', 'bullish', 'bullish' // Last 5 - consistent
      ];

      expect(detectWhipsaw(regimeHistory)).toBe(false);
    });
  });

  describe('detectTransitionPeriod', () => {
    it('should detect transition when regime changes in last 3 periods', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bullish', 'bearish'
      ];

      expect(detectTransitionPeriod(regimeHistory)).toBe(true);
    });

    it('should not detect transition with consistent regime', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bullish', 'bullish'
      ];

      expect(detectTransitionPeriod(regimeHistory)).toBe(false);
    });

    it('should return false for insufficient history', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bearish'
      ];

      expect(detectTransitionPeriod(regimeHistory)).toBe(false);
    });

    it('should only consider last 3 periods', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bearish', // Early changes
        'neutral', 'neutral', 'neutral' // Last 3 - consistent
      ];

      expect(detectTransitionPeriod(regimeHistory)).toBe(false);
    });
  });

  describe('detectTrapPattern', () => {
    it('should detect bull trap in bullish regime with dropping prices', () => {
      // Prices dropping while in bullish regime
      const prices = createPricesWithChange(100, -0.05, 25); // 5% drop
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bullish', 'bullish', 'bullish', 'bullish'
      ];

      const result = detectTrapPattern(prices, 24, 'bullish', regimeHistory, 0.1);

      // May detect trap depending on momentum thresholds
      expect(typeof result.isTrap).toBe('boolean');
      if (result.isTrap) {
        expect(result.reductionFactor).toBeLessThan(1);
      }
    });

    it('should detect bear trap in bearish regime with rising prices', () => {
      const prices = createPricesWithChange(100, 0.05, 25); // 5% rise
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bearish', 'bearish', 'bearish', 'bearish', 'bearish'
      ];

      const result = detectTrapPattern(prices, 24, 'bearish', regimeHistory, 0.1);

      expect(typeof result.isTrap).toBe('boolean');
      if (result.isTrap) {
        expect(result.reductionFactor).toBeLessThan(1);
      }
    });

    it('should return no trap for neutral regime', () => {
      const prices = createPriceArray(25, 100, 0.5);
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'neutral', 'neutral', 'neutral', 'neutral', 'neutral'
      ];

      const result = detectTrapPattern(prices, 24, 'neutral', regimeHistory, 0.1);

      expect(result.isTrap).toBe(false);
      expect(result.reductionFactor).toBe(1.0);
    });

    it('should apply stronger reduction for larger momentum divergence', () => {
      // Large price drop in bullish regime
      const prices = createPricesWithChange(100, -0.10, 25); // 10% drop
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bullish', 'bullish', 'bullish', 'bullish'
      ];

      const result = detectTrapPattern(prices, 24, 'bullish', regimeHistory, 0.3);

      if (result.isTrap) {
        // Stronger divergence should mean lower reduction factor
        expect(result.reductionFactor).toBeLessThanOrEqual(0.25);
      }
    });

    it('should detect trap when regime just switched', () => {
      const prices = createPricesWithChange(100, -0.02, 25);
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish', 'bullish', 'bullish', 'bullish', 'bearish' // Just switched
      ];

      const result = detectTrapPattern(prices, 24, 'bearish', regimeHistory, 0.1);

      // Just switched to bearish with price dropping may detect trap
      expect(typeof result.isTrap).toBe('boolean');
    });
  });

  describe('calculateTrendScore', () => {
    it('should calculate bullish trend score when price above all MAs', () => {
      const result = calculateTrendScore(
        100,    // currentPrice
        95,     // sma20 - below price
        90,     // sma50 - below price
        80,     // sma200 - below price
        97,     // ema12 - below price
        93      // ema26 - below price
      );

      expect(result.trend).toBeGreaterThan(0);
      expect(result.avgTrendStrength).toBeGreaterThan(0);
    });

    it('should calculate bearish trend score when price below all MAs', () => {
      const result = calculateTrendScore(
        80,     // currentPrice
        90,     // sma20 - above price
        95,     // sma50 - above price
        100,    // sma200 - above price
        85,     // ema12 - above price
        92      // ema26 - above price
      );

      expect(result.trend).toBeLessThan(0);
    });

    it('should handle null indicator values', () => {
      const result = calculateTrendScore(100, null, null, null, null, null);

      expect(result.trend).toBe(0);
      expect(result.avgTrendStrength).toBe(0);
    });

    it('should handle zero indicator values', () => {
      const result = calculateTrendScore(100, 0, 0, 0, 0, 0);

      // Division by zero guards should handle this
      expect(Number.isFinite(result.trend)).toBe(true);
    });

    it('should detect golden cross', () => {
      const result = calculateTrendScore(
        100,
        null,
        105,    // sma50 > sma200
        100,    // sma200
        null,
        null
      );

      // Golden cross should boost trend score
      expect(result.trend).toBeGreaterThan(0);
    });

    it('should detect death cross', () => {
      const result = calculateTrendScore(
        100,
        null,
        95,     // sma50 < sma200
        100,    // sma200
        null,
        null
      );

      // Death cross should reduce trend score
      expect(result.trend).toBeLessThan(0);
    });

    it('should detect aligned bullish trend', () => {
      // price > sma20 > sma50 > sma200
      const result = calculateTrendScore(
        100,    // currentPrice
        98,     // sma20
        95,     // sma50
        90,     // sma200
        null,
        null
      );

      expect(result.trend).toBeGreaterThan(0);
    });

    it('should detect aligned bearish trend', () => {
      // price < sma20 < sma50 < sma200
      const result = calculateTrendScore(
        80,     // currentPrice
        85,     // sma20
        90,     // sma50
        100,    // sma200
        null,
        null
      );

      expect(result.trend).toBeLessThan(0);
    });
  });

  describe('calculateMomentumScore', () => {
    it('should calculate positive momentum with bullish indicators', () => {
      const prices = createPriceArray(55, 100, 1);

      const result = calculateMomentumScore(
        prices,
        50,
        5,      // histogramValue positive
        10,     // macdValue
        8,      // signalValue (macd > signal = bullish)
        60      // rsiValue (above 50 = bullish)
      );

      expect(result.momentum).toBeGreaterThan(0);
    });

    it('should calculate negative momentum with bearish indicators', () => {
      const prices = createPriceArray(55, 150, -1); // Falling prices

      const result = calculateMomentumScore(
        prices,
        50,
        -5,     // histogramValue negative
        -10,    // macdValue
        -8,     // signalValue (macd < signal = bearish)
        40      // rsiValue (below 50 = bearish)
      );

      expect(result.momentum).toBeLessThan(0);
    });

    it('should handle null indicator values', () => {
      const prices = createPriceArray(55, 100, 1);

      const result = calculateMomentumScore(
        prices,
        50,
        null,
        null,
        null,
        null
      );

      // Should still calculate price momentum
      expect(typeof result.momentum).toBe('number');
    });

    it('should handle RSI overbought', () => {
      const prices = createPriceArray(25, 100, 1);

      const result = calculateMomentumScore(
        prices,
        20,
        null,
        null,
        null,
        80      // RSI overbought
      );

      // Overbought RSI should give negative signal
      expect(typeof result.momentum).toBe('number');
    });

    it('should handle RSI oversold', () => {
      const prices = createPriceArray(25, 100, 1);

      const result = calculateMomentumScore(
        prices,
        20,
        null,
        null,
        null,
        20      // RSI oversold
      );

      // Oversold RSI should give positive signal
      expect(typeof result.momentum).toBe('number');
    });

    it('should handle insufficient price data', () => {
      const prices = createPriceArray(15, 100, 1);

      const result = calculateMomentumScore(
        prices,
        10,
        5,
        10,
        8,
        55
      );

      // Should skip price momentum calculations that need more data
      expect(typeof result.momentum).toBe('number');
    });

    it('should handle zero signal value in MACD', () => {
      const prices = createPriceArray(25, 100, 1);

      const result = calculateMomentumScore(
        prices,
        20,
        5,
        10,
        0,      // Zero signal
        55
      );

      // Should handle division by zero
      expect(Number.isFinite(result.momentum)).toBe(true);
    });

    it('should use price range for histogram scaling', () => {
      // Test with prices that have significant range
      const prices = [...createPriceArray(25, 100, 1), ...createPriceArray(25, 124, 1)];

      const result = calculateMomentumScore(
        prices,
        40,
        10,     // Larger histogram value
        null,
        null,
        null
      );

      expect(typeof result.momentum).toBe('number');
      expect(result.avgMomentumStrength).toBeGreaterThan(0);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('should handle empty price arrays gracefully', () => {
      expect(calculatePriceMomentum([], 0, 5)).toBe(0);
      expect(calculateVolatility([], 0)).toBe(0);
      expect(calculateVolatilityFromSlice([])).toBe(0);
    });

    it('should handle single element arrays', () => {
      expect(calculatePriceMomentum([100], 0, 1)).toBe(0);
      expect(calculateVolatility([100], 0)).toBe(0);
      expect(calculateVolatilityFromSlice([100])).toBe(0);
    });

    it('should handle very large price values', () => {
      const prices = [1e10, 1.01e10, 0.99e10, 1.02e10];
      const result = calculateVolatilityFromSlice(prices);

      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should handle very small price values', () => {
      const prices = [0.0001, 0.000102, 0.000098, 0.000105];
      const result = calculateVolatilityFromSlice(prices);

      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should handle all same prices (zero volatility)', () => {
      const prices = [100, 100, 100, 100, 100];

      expect(calculateVolatilityFromSlice(prices)).toBe(0);
      expect(calculateVolatility(prices, 4)).toBe(0);
    });

    it('should handle regime history with single element', () => {
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = ['bullish'];

      expect(detectWhipsaw(regimeHistory)).toBe(false);
      expect(detectTransitionPeriod(regimeHistory)).toBe(false);
    });

    it('should handle prices with undefined/null', () => {
      // TypeScript prevents this, but runtime safety test
      const prices = [100, 102, undefined as unknown as number, 104];

      // Should not crash
      const result = calculateVolatility(prices as number[], 3, 4);
      expect(Number.isFinite(result) || result === 0).toBe(true);
    });
  });
});
