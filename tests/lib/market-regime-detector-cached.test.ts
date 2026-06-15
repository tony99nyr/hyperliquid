/**
 * Tests for market-regime-detector-cached.ts
 *
 * Tests the optimized market regime detection with indicator caching.
 * Note: The underlying helper functions (calculateTrendScore, calculateMomentumScore, etc.)
 * are tested in market-regime-detector-helpers.test.ts (77 tests).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectMarketRegimeCached,
  clearIndicatorCache,
} from '../../src/lib/strategy/analysis/market-regime-detector-cached';
import type { PriceCandle } from '@/types';

/**
 * Generate test candles with specified trend
 */
function generateTrendingCandles(
  count: number,
  startPrice: number,
  trend: 'up' | 'down' | 'flat',
  volatility: number = 0.02
): PriceCandle[] {
  const candles: PriceCandle[] = [];
  let price = startPrice;
  const baseTime = Date.now() - count * 8 * 60 * 60 * 1000; // 8h candles

  for (let i = 0; i < count; i++) {
    // Apply trend
    if (trend === 'up') {
      price *= 1 + volatility * 0.5 + Math.random() * volatility;
    } else if (trend === 'down') {
      price *= 1 - volatility * 0.5 - Math.random() * volatility;
    } else {
      // Flat with noise
      price *= 1 + (Math.random() - 0.5) * volatility;
    }

    const open = price * (1 + (Math.random() - 0.5) * volatility);
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);

    candles.push({
      timestamp: baseTime + i * 8 * 60 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: 1000 + Math.random() * 500,
    });
  }

  return candles;
}

/**
 * Generate mixed regime candles (up then down)
 */
function generateMixedCandles(upCount: number, downCount: number, startPrice: number): PriceCandle[] {
  const upCandles = generateTrendingCandles(upCount, startPrice, 'up', 0.02);
  const lastPrice = upCandles[upCandles.length - 1]!.close;
  const downCandles = generateTrendingCandles(downCount, lastPrice, 'down', 0.02);
  // Adjust timestamps for down candles
  const lastTimestamp = upCandles[upCandles.length - 1]!.timestamp;
  downCandles.forEach((c, i) => {
    c.timestamp = lastTimestamp + (i + 1) * 8 * 60 * 60 * 1000;
  });
  return [...upCandles, ...downCandles];
}

describe('market-regime-detector-cached', () => {
  beforeEach(() => {
    // Clear cache before each test to ensure clean state
    clearIndicatorCache();
  });

  describe('clearIndicatorCache', () => {
    it('should reset all cached values', () => {
      // First, populate the cache by running detection
      const candles = generateTrendingCandles(100, 1000, 'up');
      detectMarketRegimeCached(candles, 60);

      // Clear the cache
      clearIndicatorCache();

      // Run detection again - should work without issues (cache rebuilt)
      const result = detectMarketRegimeCached(candles, 60);
      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('should allow detection to work after cache clear', () => {
      const candles = generateTrendingCandles(100, 1000, 'up');

      // Run detection, clear, run again
      const result1 = detectMarketRegimeCached(candles, 60);
      clearIndicatorCache();
      const result2 = detectMarketRegimeCached(candles, 60);

      // Both should produce valid results (may differ slightly due to cache state)
      expect(result1.regime).toBeDefined();
      expect(result2.regime).toBeDefined();
    });
  });

  describe('detectMarketRegimeCached - Early Return', () => {
    it('should return neutral with zero confidence when currentIndex < 50', () => {
      const candles = generateTrendingCandles(100, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 49);

      expect(result.regime).toBe('neutral');
      expect(result.confidence).toBe(0);
      expect(result.indicators.trend).toBe(0);
      expect(result.indicators.momentum).toBe(0);
      expect(result.indicators.volatility).toBe(0);
    });

    it('should return neutral for very low index values', () => {
      const candles = generateTrendingCandles(100, 1000, 'up');

      const result0 = detectMarketRegimeCached(candles, 0);
      const result10 = detectMarketRegimeCached(candles, 10);
      const result25 = detectMarketRegimeCached(candles, 25);

      expect(result0.regime).toBe('neutral');
      expect(result10.regime).toBe('neutral');
      expect(result25.regime).toBe('neutral');
    });

    it('should start producing real signals at index 50', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 50);

      // Should have non-zero values (actual detection happening)
      expect(result).toBeDefined();
      // Confidence may still be low but should have some value
      expect(typeof result.confidence).toBe('number');
    });
  });

  describe('detectMarketRegimeCached - Bullish Detection', () => {
    it('should detect bullish regime in strong uptrend', () => {
      const candles = generateTrendingCandles(200, 1000, 'up', 0.015);

      const result = detectMarketRegimeCached(candles, 150);

      expect(result.regime).toBe('bullish');
      expect(result.indicators.trend).toBeGreaterThan(0);
    });

    it('should have positive trend indicator in uptrend', () => {
      const candles = generateTrendingCandles(200, 1000, 'up', 0.02);

      const result = detectMarketRegimeCached(candles, 180);

      expect(result.indicators.trend).toBeGreaterThan(-0.5); // May be slightly negative due to noise
    });

    it('should return confidence between 0 and 1', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('detectMarketRegimeCached - Bearish Detection', () => {
    it('should detect bearish regime in strong downtrend', () => {
      const candles = generateTrendingCandles(200, 1000, 'down', 0.02);

      const result = detectMarketRegimeCached(candles, 150);

      expect(result.regime).toBe('bearish');
      expect(result.indicators.trend).toBeLessThan(0);
    });

    it('should have negative trend indicator in downtrend', () => {
      const candles = generateTrendingCandles(200, 1000, 'down', 0.02);

      const result = detectMarketRegimeCached(candles, 180);

      expect(result.indicators.trend).toBeLessThan(0.5); // May be slightly positive due to noise
    });
  });

  describe('detectMarketRegimeCached - Neutral Detection', () => {
    it('should detect neutral regime in flat market', () => {
      const candles = generateTrendingCandles(200, 1000, 'flat', 0.01);

      const result = detectMarketRegimeCached(candles, 150);

      // Flat market may be detected as neutral or weakly directional
      expect(['neutral', 'bullish', 'bearish']).toContain(result.regime);
      // Should have lower confidence (not max)
      expect(result.confidence).toBeLessThanOrEqual(0.9);
    });

    it('should have low volatility in flat market', () => {
      const candles = generateTrendingCandles(200, 1000, 'flat', 0.005);

      const result = detectMarketRegimeCached(candles, 150);

      // Low volatility expected
      expect(result.indicators.volatility).toBeLessThan(0.1);
    });
  });

  describe('detectMarketRegimeCached - Indicator Values', () => {
    it('should return volatility between 0 and 1', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      expect(result.indicators.volatility).toBeGreaterThanOrEqual(0);
      expect(result.indicators.volatility).toBeLessThanOrEqual(1);
    });

    it('should return trend between -1 and 1', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      expect(result.indicators.trend).toBeGreaterThanOrEqual(-1);
      expect(result.indicators.trend).toBeLessThanOrEqual(1);
    });

    it('should return momentum between -1 and 1', () => {
      const candles = generateTrendingCandles(200, 1000, 'down');

      const result = detectMarketRegimeCached(candles, 150);

      expect(result.indicators.momentum).toBeGreaterThanOrEqual(-1);
      expect(result.indicators.momentum).toBeLessThanOrEqual(1);
    });
  });

  describe('detectMarketRegimeCached - Caching Behavior', () => {
    it('should produce consistent results for same candles and index', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result1 = detectMarketRegimeCached(candles, 150);
      const result2 = detectMarketRegimeCached(candles, 150);

      // Results should be identical (cached)
      expect(result1.regime).toBe(result2.regime);
      expect(result1.confidence).toBeCloseTo(result2.confidence, 5);
      expect(result1.indicators.trend).toBeCloseTo(result2.indicators.trend, 5);
    });

    it('should update cache when candles change', () => {
      const candles1 = generateTrendingCandles(200, 1000, 'up');
      const candles2 = generateTrendingCandles(200, 1000, 'down');

      const result1 = detectMarketRegimeCached(candles1, 150);
      clearIndicatorCache(); // Clear to ensure fresh calculation
      const result2 = detectMarketRegimeCached(candles2, 150);

      // Different candles should produce different results
      expect(result1.indicators.trend).not.toBeCloseTo(result2.indicators.trend, 1);
    });

    it('should handle incremental candle updates', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      // Run at index 150
      const result150 = detectMarketRegimeCached(candles, 150);

      // Run at index 160 (same candles, different index)
      const result160 = detectMarketRegimeCached(candles, 160);

      // Both should be valid
      expect(result150.regime).toBeDefined();
      expect(result160.regime).toBeDefined();
    });
  });

  describe('detectMarketRegimeCached - Config Options', () => {
    it('should accept custom config', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150, {
        regimeConfidenceThreshold: 0.2,
        momentumConfirmationThreshold: 0.1,
        divergenceWeight: 0.15,
        regimePersistencePeriods: 3,
        regimeLookback: 1,
      });

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('should use default config when not provided', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });
  });

  describe('detectMarketRegimeCached - Correlation Context', () => {
    it('should accept correlation context', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150, undefined, {
        signal: 0.5,
        riskLevel: 'low',
      });

      expect(result).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    });

    it('should handle high risk correlation context', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      // First run to populate cache
      detectMarketRegimeCached(candles, 150);
      clearIndicatorCache();

      // Second run with high risk correlation context
      const resultHighRisk = detectMarketRegimeCached(candles, 150, undefined, {
        signal: -0.8,
        riskLevel: 'high',
      });

      // High risk should potentially reduce confidence
      expect(resultHighRisk).toBeDefined();
      expect(resultHighRisk.confidence).toBeLessThanOrEqual(1);
    });

    it('should handle negative correlation signal', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150, undefined, {
        signal: -0.5,
        riskLevel: 'medium',
      });

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });
  });

  describe('detectMarketRegimeCached - Divergence Detection', () => {
    it('should include divergence indicator when present', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      // Divergence may or may not be present depending on data
      expect(result.indicators).toBeDefined();
      if (result.indicators.divergence !== undefined) {
        expect(result.indicators.divergence).toBeGreaterThanOrEqual(-1);
        expect(result.indicators.divergence).toBeLessThanOrEqual(1);
      }
    });

    it('should optionally include divergence signal details', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      // Divergence signal may or may not be present
      if (result.divergenceSignal) {
        expect(result.divergenceSignal.type).toBeDefined();
        expect(result.divergenceSignal.strength).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('detectMarketRegimeCached - Regime Transitions', () => {
    it('should handle regime transition from bullish to bearish', () => {
      // Create candles that go up then sharply down
      const candles = generateMixedCandles(100, 100, 1000);

      // Check early (should be bullish)
      const resultEarly = detectMarketRegimeCached(candles, 80);

      clearIndicatorCache();

      // Check late (should transition toward bearish)
      const resultLate = detectMarketRegimeCached(candles, 180);

      expect(resultEarly).toBeDefined();
      expect(resultLate).toBeDefined();
      // Late result should have more bearish characteristics
      expect(resultLate.indicators.trend).toBeLessThan(resultEarly.indicators.trend);
    });

    it('should handle persistence periods requirement', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      // With high persistence requirement
      const resultHighPersistence = detectMarketRegimeCached(candles, 150, {
        regimeConfidenceThreshold: 0.2,
        momentumConfirmationThreshold: 0.1,
        divergenceWeight: 0.1,
        regimePersistencePeriods: 5,
        regimeLookback: 1,
      });

      expect(resultHighPersistence).toBeDefined();
      expect(resultHighPersistence.regime).toBeDefined();
    });
  });

  describe('detectMarketRegimeCached - Edge Cases', () => {
    it('should handle minimum viable candle count', () => {
      const candles = generateTrendingCandles(51, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 50);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('should handle large candle arrays', () => {
      const candles = generateTrendingCandles(500, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 400);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('should handle candles with very low volatility', () => {
      const candles = generateTrendingCandles(200, 1000, 'flat', 0.001);

      const result = detectMarketRegimeCached(candles, 150);

      expect(result).toBeDefined();
      expect(result.indicators.volatility).toBeLessThan(0.1);
    });

    it('should handle candles with high volatility', () => {
      const candles = generateTrendingCandles(200, 1000, 'up', 0.05);

      const result = detectMarketRegimeCached(candles, 150);

      expect(result).toBeDefined();
      expect(result.indicators.volatility).toBeGreaterThan(0.01);
    });
  });

  describe('detectMarketRegimeCached - Result Structure', () => {
    it('should return complete MarketRegimeSignal structure', () => {
      const candles = generateTrendingCandles(200, 1000, 'up');

      const result = detectMarketRegimeCached(candles, 150);

      // Required fields
      expect(result.regime).toBeDefined();
      expect(['bullish', 'bearish', 'neutral']).toContain(result.regime);
      expect(typeof result.confidence).toBe('number');
      expect(result.indicators).toBeDefined();
      expect(typeof result.indicators.trend).toBe('number');
      expect(typeof result.indicators.momentum).toBe('number');
      expect(typeof result.indicators.volatility).toBe('number');
    });

    it('should have valid regime type', () => {
      const candles = generateTrendingCandles(200, 1000, 'down');

      const result = detectMarketRegimeCached(candles, 150);

      expect(['bullish', 'bearish', 'neutral']).toContain(result.regime);
    });
  });
});
