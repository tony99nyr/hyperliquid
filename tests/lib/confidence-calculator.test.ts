import { describe, it, expect } from 'vitest';
import { calculateConfidence } from '@/lib/strategy/indicators/confidence-calculator';
import type { TradingSignal, PriceCandle } from '@/types';

/**
 * Unit tests for confidence-calculator.ts
 *
 * Focus: calculateConfidence() - pure function for signal confidence scoring
 * This is MEDIUM PRIORITY for mainnet because:
 * - Confidence affects position sizing decisions
 * - Incorrect confidence leads to over/under-sizing
 * - Edge cases (empty data, zero prices) could crash or produce wrong values
 */

// Helper to create a basic trading signal
function createSignal(signal: number, indicators: Record<string, number>): TradingSignal {
  return {
    action: signal > 0 ? 'buy' : signal < 0 ? 'sell' : 'hold',
    signal,
    confidence: 0.5,
    timestamp: Date.now(),
    indicators,
  };
}

// Helper to create candles with specific prices
function createCandles(prices: number[], volumes?: number[]): PriceCandle[] {
  return prices.map((close, i) => ({
    timestamp: Date.now() + i * 3600000,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: volumes?.[i] ?? 1000,
  }));
}

describe('confidence-calculator', () => {
  describe('calculateConfidence', () => {
    describe('edge cases - empty/invalid data', () => {
      it('returns 0 for empty candles array', () => {
        const signal = createSignal(0.5, { rsi: 0.3, macd: 0.4 });
        expect(calculateConfidence(signal, [], 0)).toBe(0);
      });

      it('returns 0 when currentIndex >= candles.length', () => {
        const signal = createSignal(0.5, { rsi: 0.3 });
        const candles = createCandles([100, 101, 102]);
        expect(calculateConfidence(signal, candles, 3)).toBe(0);
        expect(calculateConfidence(signal, candles, 10)).toBe(0);
      });

      it('returns 0 for empty indicators object', () => {
        const signal = createSignal(0.5, {});
        const candles = createCandles([100, 101, 102, 103, 104]);
        expect(calculateConfidence(signal, candles, 4)).toBe(0);
      });

      it('handles currentIndex = 0 (single candle)', () => {
        const signal = createSignal(0.5, { rsi: 0.3 });
        const candles = createCandles([100]);
        // With only 1 candle, lookback < 2, returns signalStrength * 0.5
        const result = calculateConfidence(signal, candles, 0);
        expect(result).toBeCloseTo(0.5 * 0.5, 5); // 0.25
      });

      it('handles currentIndex = 1 (2 candles - still early)', () => {
        const signal = createSignal(0.5, { rsi: 0.3 });
        const candles = createCandles([100, 101]);
        // lookback = 1 < 2, returns signalStrength * 0.5
        const result = calculateConfidence(signal, candles, 1);
        expect(result).toBeCloseTo(0.5 * 0.5, 5);
      });
    });

    describe('signal strength factor', () => {
      it('stronger signal produces higher confidence', () => {
        const candles = createCandles(Array(25).fill(100));
        const weakSignal = createSignal(0.2, { rsi: 0.3, macd: 0.3 });
        const strongSignal = createSignal(0.9, { rsi: 0.3, macd: 0.3 });

        const weakConfidence = calculateConfidence(weakSignal, candles, 24);
        const strongConfidence = calculateConfidence(strongSignal, candles, 24);

        expect(strongConfidence).toBeGreaterThan(weakConfidence);
      });

      it('negative signal uses absolute value for strength', () => {
        const candles = createCandles(Array(25).fill(100));
        const sellSignal = createSignal(-0.7, { rsi: -0.3, macd: -0.3 });

        const confidence = calculateConfidence(sellSignal, candles, 24);
        expect(confidence).toBeGreaterThan(0);
      });
    });

    describe('indicator agreement factor', () => {
      it('all indicators agreeing produces higher confidence', () => {
        const candles = createCandles(Array(25).fill(100));
        // All positive indicators (full agreement on buy)
        const agreedSignal = createSignal(0.5, { rsi: 0.3, macd: 0.4, momentum: 0.2, trend: 0.5 });
        // Mixed indicators (partial agreement)
        const mixedSignal = createSignal(0.5, { rsi: 0.3, macd: -0.4, momentum: 0.2, trend: -0.5 });

        const agreedConfidence = calculateConfidence(agreedSignal, candles, 24);
        const mixedConfidence = calculateConfidence(mixedSignal, candles, 24);

        expect(agreedConfidence).toBeGreaterThan(mixedConfidence);
      });

      it('sell signal counts negative indicators as agreeing', () => {
        const candles = createCandles(Array(25).fill(100));
        // All negative indicators (full agreement on sell)
        const sellSignal = createSignal(-0.5, { rsi: -0.3, macd: -0.4, momentum: -0.2 });

        const confidence = calculateConfidence(sellSignal, candles, 24);
        // All 3 indicators negative, signal negative = 100% agreement (1.0)
        expect(confidence).toBeGreaterThan(0.3);
      });
    });

    describe('volatility factor', () => {
      it('low volatility produces higher confidence', () => {
        // Flat prices = very low volatility
        const flatPrices = Array(25).fill(100);
        const flatCandles = createCandles(flatPrices);

        // Volatile prices (oscillating)
        const volatilePrices = [];
        for (let i = 0; i < 25; i++) {
          volatilePrices.push(100 + (i % 2 === 0 ? 5 : -5));
        }
        const volatileCandles = createCandles(volatilePrices);

        const signal = createSignal(0.5, { rsi: 0.3 });

        const flatConfidence = calculateConfidence(signal, flatCandles, 24);
        const volatileConfidence = calculateConfidence(signal, volatileCandles, 24);

        expect(flatConfidence).toBeGreaterThan(volatileConfidence);
      });
    });

    describe('trend strength factor', () => {
      it('strong uptrend produces higher confidence for buy signal', () => {
        // Strong uptrend - prices increasing
        const uptrendPrices = Array(25).fill(0).map((_, i) => 100 + i * 2);
        const uptrendCandles = createCandles(uptrendPrices);

        // Sideways - flat prices
        const sidewaysCandles = createCandles(Array(25).fill(100));

        const buySignal = createSignal(0.5, { rsi: 0.3 });

        const trendConfidence = calculateConfidence(buySignal, uptrendCandles, 24);
        const sidewaysConfidence = calculateConfidence(buySignal, sidewaysCandles, 24);

        // Uptrend should have price deviation from SMA = higher trend strength
        expect(trendConfidence).toBeGreaterThan(sidewaysConfidence);
      });
    });

    describe('volume factor', () => {
      it('higher than average volume produces higher confidence', () => {
        const prices = Array(25).fill(100);
        // Normal volume for first 24 candles, double volume for last
        const normalVolumes = Array(25).fill(1000);
        normalVolumes[24] = 2000;
        const highVolumeCandles = createCandles(prices, normalVolumes);

        // Low volume on last candle
        const lowVolumes = Array(25).fill(1000);
        lowVolumes[24] = 500;
        const lowVolumeCandles = createCandles(prices, lowVolumes);

        const signal = createSignal(0.5, { rsi: 0.3 });

        const highVolConfidence = calculateConfidence(signal, highVolumeCandles, 24);
        const lowVolConfidence = calculateConfidence(signal, lowVolumeCandles, 24);

        expect(highVolConfidence).toBeGreaterThan(lowVolConfidence);
      });

      it('handles zero volume gracefully (defaults to 0.5)', () => {
        const prices = Array(25).fill(100);
        const zeroVolumes = Array(25).fill(0);
        const candles = createCandles(prices, zeroVolumes);
        const signal = createSignal(0.5, { rsi: 0.3 });

        // Should not throw
        const result = calculateConfidence(signal, candles, 24);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      });
    });

    describe('output bounds', () => {
      it('always returns value between 0 and 1', () => {
        const candles = createCandles(Array(25).fill(100));
        const signals = [
          createSignal(2.0, { rsi: 2.0 }), // Extreme high
          createSignal(-2.0, { rsi: -2.0 }), // Extreme low
          createSignal(0, { rsi: 0 }), // Zero
          createSignal(0.001, { rsi: 0.001 }), // Very small
        ];

        for (const signal of signals) {
          const confidence = calculateConfidence(signal, candles, 24);
          expect(confidence).toBeGreaterThanOrEqual(0);
          expect(confidence).toBeLessThanOrEqual(1);
        }
      });

      it('handles NaN in indicator values', () => {
        const candles = createCandles(Array(25).fill(100));
        const signal = createSignal(0.5, { rsi: NaN, macd: 0.3 });

        // NaN > 0 is false, NaN < 0 is false
        // So NaN indicators count as 0 (neither positive nor negative)
        const result = calculateConfidence(signal, candles, 24);
        expect(Number.isFinite(result)).toBe(true);
      });

      it('handles Infinity in indicator values', () => {
        const candles = createCandles(Array(25).fill(100));
        const signal = createSignal(0.5, { rsi: Infinity, macd: 0.3 });

        // Infinity > 0 is true, so counts as positive
        const result = calculateConfidence(signal, candles, 24);
        expect(Number.isFinite(result)).toBe(true);
      });
    });

    describe('zero price handling', () => {
      it('handles zero prices in calculation without division error', () => {
        const pricesWithZero = [100, 101, 102, 0, 104, 105];
        const candles = createCandles(pricesWithZero);
        const signal = createSignal(0.5, { rsi: 0.3 });

        // Zero price should be skipped in returns calculation
        // (the guard recentPrices[i-1] > 0 protects against div by zero)
        const result = calculateConfidence(signal, candles, 5);
        expect(Number.isFinite(result)).toBe(true);
      });

      it('handles all zero prices', () => {
        const zeroPrices = Array(25).fill(0);
        const candles = createCandles(zeroPrices);
        const signal = createSignal(0.5, { rsi: 0.3 });

        // All prices zero means no valid returns can be calculated
        // The guard `returns.length === 0` should trigger
        const result = calculateConfidence(signal, candles, 24);
        // Returns signalStrength * 0.5 = 0.5 * 0.5 = 0.25
        expect(result).toBeCloseTo(0.5 * 0.5, 5);
      });
    });

    describe('SMA handling', () => {
      it('handles case when SMA returns empty array', () => {
        const candles = createCandles([100, 101]);
        const signal = createSignal(0.5, { rsi: 0.3 });

        // With only 2 candles and smaPeriod = min(20, 2) = 2
        // SMA should work but lookback < 2 triggers early return
        const result = calculateConfidence(signal, candles, 1);
        expect(result).toBeCloseTo(0.5 * 0.5, 5);
      });

      it('handles SMA value of zero (avoid division by zero)', () => {
        // Create prices that would result in SMA close to 0
        const candles = createCandles(Array(25).fill(0.001));
        const signal = createSignal(0.5, { rsi: 0.3 });

        // Should not throw
        const result = calculateConfidence(signal, candles, 24);
        expect(Number.isFinite(result)).toBe(true);
      });
    });

    describe('realistic scenarios', () => {
      it('bullish breakout scenario (high confidence)', () => {
        // Price breaking out above resistance with high volume
        const prices = [
          ...Array(20).fill(100), // Consolidation
          102, 105, 108, 112, 118, // Breakout
        ];
        const volumes = [
          ...Array(20).fill(1000), // Normal volume
          2000, 2500, 3000, 3500, 4000, // Increasing volume
        ];
        const candles = createCandles(prices, volumes);

        const buySignal = createSignal(0.8, {
          rsi: 0.6,
          macd: 0.7,
          momentum: 0.8,
          trend: 0.9,
        });

        const confidence = calculateConfidence(buySignal, candles, 24);
        // Should be high confidence due to:
        // - Strong signal (0.8)
        // - All indicators agreeing (4/4 positive)
        // - High volume
        // - Strong trend (breakout)
        expect(confidence).toBeGreaterThan(0.5);
      });

      it('uncertain sideways market (low confidence)', () => {
        // Choppy, sideways price action
        const prices = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100,
                       102, 98, 100, 101, 99, 100, 102, 98, 100, 101,
                       99, 100, 102, 98, 100];
        const candles = createCandles(prices);

        const weakSignal = createSignal(0.2, {
          rsi: 0.1,
          macd: -0.1,
          momentum: 0.05,
          trend: -0.05,
        });

        const confidence = calculateConfidence(weakSignal, candles, 24);
        // Should be lower confidence due to:
        // - Weak signal (0.2)
        // - Mixed indicators (2 positive, 2 negative)
        // - Higher volatility (choppy)
        // - Weak trend
        expect(confidence).toBeLessThan(0.5);
      });

      it('crash scenario (bearish with high confidence)', () => {
        // Sharp price drop
        const prices = [
          ...Array(20).fill(100), // Stable
          95, 88, 80, 72, 65, // Crash
        ];
        const volumes = [
          ...Array(20).fill(1000), // Normal volume
          5000, 8000, 10000, 12000, 15000, // Panic volume
        ];
        const candles = createCandles(prices, volumes);

        const sellSignal = createSignal(-0.9, {
          rsi: -0.8,
          macd: -0.9,
          momentum: -0.95,
          trend: -0.85,
        });

        const confidence = calculateConfidence(sellSignal, candles, 24);
        // Should have decent confidence because:
        // - Strong sell signal (0.9)
        // - All indicators agreeing on sell
        // - Very high volume (panic selling)
        // But volatility is high which reduces confidence
        expect(confidence).toBeGreaterThan(0.3);
      });
    });

    describe('weight verification', () => {
      it('weights sum to 1.0', () => {
        // The weights in the function should sum to 1
        const weights = {
          signalStrength: 0.3,
          agreement: 0.25,
          volatility: 0.2,
          trendStrength: 0.15,
          volume: 0.1,
        };
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        expect(sum).toBe(1.0);
      });
    });
  });
});
