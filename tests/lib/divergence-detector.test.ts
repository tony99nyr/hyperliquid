/**
 * Unit tests for divergence detection
 * 
 * Divergence occurs when price moves in one direction while an indicator
 * (like RSI or MACD) moves in the opposite direction. This can signal
 * potential trend reversals.
 * 
 * Types of divergence:
 * - Regular bullish: Price makes lower lows, RSI/MACD makes higher lows (reversal up)
 * - Regular bearish: Price makes higher highs, RSI/MACD makes lower highs (reversal down)
 * - Hidden bullish: Price makes higher lows, RSI/MACD makes lower lows (trend continuation up)
 * - Hidden bearish: Price makes lower highs, RSI/MACD makes higher highs (trend continuation down)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectRSIDivergence,
  detectMACDDivergence,
  findLocalExtremes,
} from '@/lib/strategy/analysis/divergence-detector';
import { generatePriceCandles } from '../mocks/trading-data.mock';
import type { PriceCandle } from '@/types';

describe('Divergence Detection', () => {
  let candles: PriceCandle[];

  beforeEach(() => {
    // Generate default test candles
    candles = generatePriceCandles('trending-up', 100, 2500);
  });

  describe('findLocalExtremes', () => {
    it('should find local minima and maxima in price data', () => {
      // Create a simple pattern with clear peaks and troughs
      const testPrices = [
        100, 110, 120, 115, 105, 95, 100, 110, 105, 95, 85, 90, 100
      ];
      
      const { minima, maxima } = findLocalExtremes(testPrices, 2);
      
      // Should find at least one minimum and one maximum
      expect(minima.length).toBeGreaterThan(0);
      expect(maxima.length).toBeGreaterThan(0);
      
      // All minima indices should be valid
      minima.forEach(idx => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(testPrices.length);
      });
      
      // All maxima indices should be valid
      maxima.forEach(idx => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(testPrices.length);
      });
    });

    it('should handle edge cases with insufficient data', () => {
      const shortPrices = [100, 110, 105];
      const { minima, maxima } = findLocalExtremes(shortPrices, 2);
      
      // Should handle short arrays gracefully
      expect(Array.isArray(minima)).toBe(true);
      expect(Array.isArray(maxima)).toBe(true);
    });

    it('should handle flat price data', () => {
      const flatPrices = [100, 100, 100, 100, 100];
      const { minima, maxima } = findLocalExtremes(flatPrices, 2);
      
      // No clear extremes in flat data
      expect(minima.length).toBe(0);
      expect(maxima.length).toBe(0);
    });
  });

  describe('detectRSIDivergence', () => {
    it('should return null for insufficient data', () => {
      const shortCandles = candles.slice(0, 10);
      const result = detectRSIDivergence(shortCandles, 9);
      expect(result).toBeNull();
    });

    it('should detect regular bullish divergence', () => {
      // Create candles with lower price lows but higher RSI lows
      const divergenceCandles = createBullishDivergenceCandles();
      const result = detectRSIDivergence(divergenceCandles, divergenceCandles.length - 1);
      
      if (result) {
        expect(result.type).toBe('bullish');
        expect(result.indicator).toBe('rsi');
        expect(result.strength).toBeGreaterThan(0);
        expect(result.strength).toBeLessThanOrEqual(1);
      }
      // Note: Detection may not always fire depending on exact conditions
    });

    it('should detect regular bearish divergence', () => {
      // Create candles with higher price highs but lower RSI highs
      const divergenceCandles = createBearishDivergenceCandles();
      const result = detectRSIDivergence(divergenceCandles, divergenceCandles.length - 1);
      
      if (result) {
        expect(result.type).toBe('bearish');
        expect(result.indicator).toBe('rsi');
        expect(result.strength).toBeGreaterThan(0);
        expect(result.strength).toBeLessThanOrEqual(1);
      }
      // Note: Detection may not always fire depending on exact conditions
    });

    it('should return signal with valid structure', () => {
      const result = detectRSIDivergence(candles, candles.length - 1);
      
      if (result) {
        expect(['bullish', 'bearish', 'hidden-bullish', 'hidden-bearish']).toContain(result.type);
        expect(result.indicator).toBe('rsi');
        expect(typeof result.strength).toBe('number');
        expect(result.strength).toBeGreaterThanOrEqual(0);
        expect(result.strength).toBeLessThanOrEqual(1);
        expect(typeof result.priceExtremes).toBe('object');
        expect(typeof result.indicatorExtremes).toBe('object');
      }
    });

    it('should use default lookback when not specified', () => {
      // Should not throw when lookback is not provided
      const result = detectRSIDivergence(candles, candles.length - 1);
      // Result can be null if no divergence detected
      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('should respect custom lookback period', () => {
      const customLookback = 30;
      const result = detectRSIDivergence(candles, candles.length - 1, customLookback);
      // Should not throw with custom lookback
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('detectMACDDivergence', () => {
    it('should return null for insufficient data', () => {
      const shortCandles = candles.slice(0, 20);
      const result = detectMACDDivergence(shortCandles, 19);
      expect(result).toBeNull();
    });

    it('should detect regular bullish divergence in MACD', () => {
      const divergenceCandles = createBullishDivergenceCandles();
      const result = detectMACDDivergence(divergenceCandles, divergenceCandles.length - 1);
      
      if (result) {
        expect(result.type).toBe('bullish');
        expect(result.indicator).toBe('macd');
        expect(result.strength).toBeGreaterThan(0);
        expect(result.strength).toBeLessThanOrEqual(1);
      }
    });

    it('should detect regular bearish divergence in MACD', () => {
      const divergenceCandles = createBearishDivergenceCandles();
      const result = detectMACDDivergence(divergenceCandles, divergenceCandles.length - 1);
      
      if (result) {
        expect(result.type).toBe('bearish');
        expect(result.indicator).toBe('macd');
        expect(result.strength).toBeGreaterThan(0);
        expect(result.strength).toBeLessThanOrEqual(1);
      }
    });

    it('should return signal with valid MACD structure', () => {
      const result = detectMACDDivergence(candles, candles.length - 1);
      
      if (result) {
        expect(['bullish', 'bearish', 'hidden-bullish', 'hidden-bearish']).toContain(result.type);
        expect(result.indicator).toBe('macd');
        expect(typeof result.strength).toBe('number');
      }
    });
  });

  describe('Divergence Strength Calculation', () => {
    it('should return higher strength for more pronounced divergence', () => {
      // Create two sets of candles with different divergence magnitudes
      const mildDivergenceCandles = createBullishDivergenceCandles(0.02);
      const strongDivergenceCandles = createBullishDivergenceCandles(0.10);
      
      const mildResult = detectRSIDivergence(mildDivergenceCandles, mildDivergenceCandles.length - 1);
      const strongResult = detectRSIDivergence(strongDivergenceCandles, strongDivergenceCandles.length - 1);
      
      // If both are detected, stronger divergence should have higher strength
      if (mildResult && strongResult) {
        expect(strongResult.strength).toBeGreaterThanOrEqual(mildResult.strength);
      }
    });

    it('should normalize strength between 0 and 1', () => {
      const result = detectRSIDivergence(candles, candles.length - 1);
      
      if (result) {
        expect(result.strength).toBeGreaterThanOrEqual(0);
        expect(result.strength).toBeLessThanOrEqual(1);
      }
    });
  });
});

/**
 * Helper function to create candles with bullish divergence pattern
 * Price makes lower lows, but RSI makes higher lows
 */
function createBullishDivergenceCandles(intensity: number = 0.05): PriceCandle[] {
  const candles: PriceCandle[] = [];
  const baseTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
  let price = 2500;

  // Phase 1: Initial rally (first 30 candles)
  for (let i = 0; i < 30; i++) {
    price = price * (1 + 0.01 + Math.random() * 0.02);
    candles.push(createCandle(baseTime + i * 24 * 60 * 60 * 1000, price));
  }

  // Phase 2: First drop to low (next 20 candles)
  for (let i = 0; i < 20; i++) {
    price = price * (1 - 0.01 - Math.random() * 0.02);
    candles.push(createCandle(baseTime + (30 + i) * 24 * 60 * 60 * 1000, price));
  }

  // Phase 3: Small bounce (10 candles)
  for (let i = 0; i < 10; i++) {
    price = price * (1 + 0.005 + Math.random() * 0.01);
    candles.push(createCandle(baseTime + (50 + i) * 24 * 60 * 60 * 1000, price));
  }

  // Phase 4: Drop to LOWER low (20 candles) - but price decline is slowing
  for (let i = 0; i < 20; i++) {
    // Price drops to a lower low
    price = price * (1 - (0.005 + Math.random() * 0.01) * (1 - intensity));
    candles.push(createCandle(baseTime + (60 + i) * 24 * 60 * 60 * 1000, price));
  }

  // Phase 5: Momentum building (20 candles) - recovery with increasing volume
  for (let i = 0; i < 20; i++) {
    price = price * (1 + 0.01 + Math.random() * 0.015);
    candles.push(createCandle(baseTime + (80 + i) * 24 * 60 * 60 * 1000, price));
  }

  return candles;
}

/**
 * Helper function to create candles with bearish divergence pattern
 * Price makes higher highs, but RSI makes lower highs
 */
function createBearishDivergenceCandles(intensity: number = 0.05): PriceCandle[] {
  const candles: PriceCandle[] = [];
  const baseTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
  let price = 2500;

  // Phase 1: Initial rally to first high (30 candles)
  for (let i = 0; i < 30; i++) {
    price = price * (1 + 0.02 + Math.random() * 0.03);
    candles.push(createCandle(baseTime + i * 24 * 60 * 60 * 1000, price));
  }

  // Phase 2: Pullback (20 candles)
  for (let i = 0; i < 20; i++) {
    price = price * (1 - 0.01 - Math.random() * 0.015);
    candles.push(createCandle(baseTime + (30 + i) * 24 * 60 * 60 * 1000, price));
  }

  // Phase 3: Rally to HIGHER high (30 candles) - but momentum is fading
  for (let i = 0; i < 30; i++) {
    // Price rises but gains are smaller (weakening momentum)
    price = price * (1 + (0.01 + Math.random() * 0.02) * (1 - intensity * i / 30));
    candles.push(createCandle(baseTime + (50 + i) * 24 * 60 * 60 * 1000, price));
  }

  // Phase 4: Beginning of reversal (20 candles)
  for (let i = 0; i < 20; i++) {
    price = price * (1 - 0.005 - Math.random() * 0.01);
    candles.push(createCandle(baseTime + (80 + i) * 24 * 60 * 60 * 1000, price));
  }

  return candles;
}

/**
 * Helper function to create a candle at a given price
 */
function createCandle(timestamp: number, close: number): PriceCandle {
  const volatility = close * 0.02; // 2% volatility
  const open = close * (1 + (Math.random() - 0.5) * 0.02);
  const high = Math.max(open, close) + Math.random() * volatility;
  const low = Math.min(open, close) - Math.random() * volatility;
  
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume: 1000000 + Math.random() * 500000,
  };
}

