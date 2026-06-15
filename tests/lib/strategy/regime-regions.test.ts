/**
 * Tests for regime-region-calculator.ts
 *
 * Tests the pure regime region calculator that converts candle data
 * into time-based regime regions by calling the cached regime detector
 * at each candle index and merging consecutive same-regime periods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PriceCandle } from '@/types';
import type { MarketRegimeSignal } from '@/lib/strategy/analysis/market-regime-detector-cached';
import type { RegimeDetectionConfig } from '@/lib/strategy/config/regime-detection-config';

// --- Mocks ---

const mockDetectMarketRegimeCached = vi.fn<
  (candles: PriceCandle[], currentIndex: number, config?: RegimeDetectionConfig) => MarketRegimeSignal
>();
const mockClearIndicatorCache = vi.fn();

vi.mock('@/lib/strategy/analysis/market-regime-detector-cached', () => ({
  detectMarketRegimeCached: (...args: unknown[]) =>
    mockDetectMarketRegimeCached(
      args[0] as PriceCandle[],
      args[1] as number,
      args[2] as RegimeDetectionConfig | undefined,
    ),
  clearIndicatorCache: () => mockClearIndicatorCache(),
}));

import {
  calculateRegimeRegionsFromCandles,
  findRegimeAtTimestamp,
  type TimeBasedRegimeRegion,
} from '@/lib/strategy/analysis/regime-region-calculator';

// --- Helpers ---

function makeCandle(timestamp: number, close: number): PriceCandle {
  return { timestamp, open: close, high: close, low: close, close, volume: 1000 };
}

/** Build an array of `count` candles starting at timestamp 1000, spaced 100 apart. */
function makeCandles(count: number): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => makeCandle(1000 + i * 100, 100));
}

function makeSignal(regime: 'bullish' | 'bearish' | 'neutral', confidence = 0.7): MarketRegimeSignal {
  return {
    regime,
    confidence,
    indicators: { trend: 0, momentum: 0, volatility: 0 },
  };
}

// --- Tests ---

describe('regime-region-calculator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: return bullish for every call
    mockDetectMarketRegimeCached.mockReturnValue(makeSignal('bullish'));
  });

  // ----------------------------------------------------------------
  // calculateRegimeRegionsFromCandles
  // ----------------------------------------------------------------
  describe('calculateRegimeRegionsFromCandles', () => {
    it('returns empty array when fewer than 50 candles', () => {
      const candles = makeCandles(49);
      const regions = calculateRegimeRegionsFromCandles(candles, 0, 48);
      expect(regions).toEqual([]);
      // Should NOT have called detectMarketRegimeCached at all
      expect(mockDetectMarketRegimeCached).not.toHaveBeenCalled();
    });

    it('returns empty array when startIndex > endIndex', () => {
      const candles = makeCandles(100);
      const regions = calculateRegimeRegionsFromCandles(candles, 80, 60);
      expect(regions).toEqual([]);
    });

    it('returns empty array when startIndex >= candles.length', () => {
      const candles = makeCandles(100);
      const regions = calculateRegimeRegionsFromCandles(candles, 100, 110);
      expect(regions).toEqual([]);
    });

    it('clears indicator cache before calculation', () => {
      const candles = makeCandles(100);
      calculateRegimeRegionsFromCandles(candles, 50, 99);
      expect(mockClearIndicatorCache).toHaveBeenCalledTimes(1);
    });

    it('merges consecutive same-regime candles into one region', () => {
      const candles = makeCandles(100);
      // All return bullish
      mockDetectMarketRegimeCached.mockReturnValue(makeSignal('bullish'));

      const regions = calculateRegimeRegionsFromCandles(candles, 50, 99);

      expect(regions).toHaveLength(1);
      expect(regions[0]!.regime).toBe('bullish');
      expect(regions[0]!.startTime).toBe(candles[50]!.timestamp);
      expect(regions[0]!.endTime).toBe(candles[99]!.timestamp);
    });

    it('creates new region on regime change', () => {
      const candles = makeCandles(100);
      // First 25 candles (indices 50-74) bullish, next 25 (75-99) bearish
      mockDetectMarketRegimeCached.mockImplementation((_c, idx) => {
        return idx < 75 ? makeSignal('bullish', 0.8) : makeSignal('bearish', 0.6);
      });

      const regions = calculateRegimeRegionsFromCandles(candles, 50, 99);

      expect(regions).toHaveLength(2);
      expect(regions[0]!.regime).toBe('bullish');
      expect(regions[1]!.regime).toBe('bearish');
    });

    it('regions cover the full time range with no gaps', () => {
      const candles = makeCandles(100);
      // Create three regime transitions
      mockDetectMarketRegimeCached.mockImplementation((_c, idx) => {
        if (idx < 65) return makeSignal('bullish');
        if (idx < 80) return makeSignal('neutral');
        return makeSignal('bearish');
      });

      const regions = calculateRegimeRegionsFromCandles(candles, 50, 99);

      expect(regions).toHaveLength(3);

      // First region starts at candle 50
      expect(regions[0]!.startTime).toBe(candles[50]!.timestamp);
      // Last region ends at candle 99
      expect(regions[2]!.endTime).toBe(candles[99]!.timestamp);

      // No gaps: each region's end should match the next region's start - one candle interval
      // The endTime of region N is the timestamp of the candle before region N+1 starts
      for (let i = 0; i < regions.length - 1; i++) {
        expect(regions[i]!.endTime).toBeLessThan(regions[i + 1]!.startTime);
        // The gap should be exactly one candle interval (100 in our test data)
        expect(regions[i + 1]!.startTime - regions[i]!.endTime).toBe(100);
      }
    });

    it('handles multiple regime transitions', () => {
      const candles = makeCandles(100);
      mockDetectMarketRegimeCached.mockImplementation((_c, idx) => {
        if (idx < 60) return makeSignal('bullish');
        if (idx < 70) return makeSignal('neutral');
        if (idx < 85) return makeSignal('bearish');
        return makeSignal('bullish');
      });

      const regions = calculateRegimeRegionsFromCandles(candles, 50, 99);

      expect(regions).toHaveLength(4);
      expect(regions.map(r => r.regime)).toEqual(['bullish', 'neutral', 'bearish', 'bullish']);
    });

    it('clamps startIndex to minimum of 50', () => {
      const candles = makeCandles(100);
      mockDetectMarketRegimeCached.mockReturnValue(makeSignal('bullish'));

      const regions = calculateRegimeRegionsFromCandles(candles, 10, 99);

      // Should start evaluating from index 50 despite startIndex=10
      expect(regions).toHaveLength(1);
      expect(regions[0]!.startTime).toBe(candles[50]!.timestamp);
      // First call should be at index 50
      expect(mockDetectMarketRegimeCached.mock.calls[0]![1]).toBe(50);
    });

    it('clamps endIndex to last candle', () => {
      const candles = makeCandles(100);
      mockDetectMarketRegimeCached.mockReturnValue(makeSignal('bearish'));

      const regions = calculateRegimeRegionsFromCandles(candles, 50, 200);

      expect(regions).toHaveLength(1);
      expect(regions[0]!.endTime).toBe(candles[99]!.timestamp);
    });

    it('tracks max confidence within a merged region', () => {
      const candles = makeCandles(100);
      // Varying confidence, all same regime
      mockDetectMarketRegimeCached.mockImplementation((_c, idx) => {
        const confidence = idx === 70 ? 0.95 : 0.5;
        return makeSignal('bullish', confidence);
      });

      const regions = calculateRegimeRegionsFromCandles(candles, 50, 99);

      expect(regions).toHaveLength(1);
      expect(regions[0]!.confidence).toBe(0.95);
    });

    it('handles single-candle range', () => {
      const candles = makeCandles(100);
      mockDetectMarketRegimeCached.mockReturnValue(makeSignal('neutral', 0.4));

      const regions = calculateRegimeRegionsFromCandles(candles, 60, 60);

      expect(regions).toHaveLength(1);
      expect(regions[0]!.regime).toBe('neutral');
      expect(regions[0]!.startTime).toBe(candles[60]!.timestamp);
      expect(regions[0]!.endTime).toBe(candles[60]!.timestamp);
    });

    it('returns empty when safeStart > safeEnd after clamping', () => {
      // 51 candles total, startIndex=0 gets clamped to 50, endIndex=49 stays 49
      // safeStart (50) > safeEnd (49) -> empty
      const candles = makeCandles(51);
      const regions = calculateRegimeRegionsFromCandles(candles, 0, 49);
      expect(regions).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // findRegimeAtTimestamp
  // ----------------------------------------------------------------
  describe('findRegimeAtTimestamp', () => {
    const regions: TimeBasedRegimeRegion[] = [
      { startTime: 1000, endTime: 2000, regime: 'bullish', confidence: 0.8 },
      { startTime: 2100, endTime: 3000, regime: 'bearish', confidence: 0.6 },
      { startTime: 3100, endTime: 4000, regime: 'neutral', confidence: 0.5 },
    ];

    it('returns matching region when timestamp falls within a region', () => {
      const result = findRegimeAtTimestamp(regions, 1500);
      expect(result).not.toBeNull();
      expect(result!.regime).toBe('bullish');
    });

    it('returns null when timestamp is before all regions', () => {
      const result = findRegimeAtTimestamp(regions, 500);
      expect(result).toBeNull();
    });

    it('returns null when timestamp is after all regions', () => {
      const result = findRegimeAtTimestamp(regions, 5000);
      expect(result).toBeNull();
    });

    it('returns null for empty regions array', () => {
      const result = findRegimeAtTimestamp([], 1500);
      expect(result).toBeNull();
    });

    it('returns correct region at exact startTime boundary', () => {
      const result = findRegimeAtTimestamp(regions, 2100);
      expect(result).not.toBeNull();
      expect(result!.regime).toBe('bearish');
    });

    it('returns correct region at exact endTime boundary', () => {
      const result = findRegimeAtTimestamp(regions, 3000);
      expect(result).not.toBeNull();
      expect(result!.regime).toBe('bearish');
    });

    it('returns null for timestamp in gap between regions', () => {
      // 2050 is between region 1 (endTime 2000) and region 2 (startTime 2100)
      const result = findRegimeAtTimestamp(regions, 2050);
      expect(result).toBeNull();
    });

    it('returns the correct region when multiple regions exist', () => {
      const result = findRegimeAtTimestamp(regions, 3500);
      expect(result).not.toBeNull();
      expect(result!.regime).toBe('neutral');
      expect(result!.confidence).toBe(0.5);
    });
  });

  // ----------------------------------------------------------------
  // Asset-specific config passthrough
  // ----------------------------------------------------------------
  describe('asset-specific config', () => {
    it('passes config parameter through to detectMarketRegimeCached', () => {
      const candles = makeCandles(100);
      const customConfig: RegimeDetectionConfig = {
        regimeConfidenceThreshold: 0.25,
        momentumConfirmationThreshold: 0.20,
        divergenceWeight: 0.15,
        regimePersistencePeriods: 3,
        regimeLookback: 2,
      };

      calculateRegimeRegionsFromCandles(candles, 50, 99, customConfig);

      // Every call to detectMarketRegimeCached should receive the config
      expect(mockDetectMarketRegimeCached).toHaveBeenCalled();
      for (const call of mockDetectMarketRegimeCached.mock.calls) {
        expect(call[2]).toBe(customConfig);
      }
    });

    it('passes undefined config when not provided', () => {
      const candles = makeCandles(100);

      calculateRegimeRegionsFromCandles(candles, 50, 99);

      expect(mockDetectMarketRegimeCached).toHaveBeenCalled();
      for (const call of mockDetectMarketRegimeCached.mock.calls) {
        expect(call[2]).toBeUndefined();
      }
    });
  });
});
