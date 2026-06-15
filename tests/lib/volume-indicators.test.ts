/**
 * Unit tests for volume indicator calculations
 */

import { describe, it, expect } from 'vitest';
import {
  calculateVWAP,
  calculateOBV,
  calculateVolumeROC,
  calculateVolumeWeightedMACD,
  calculateVolumeMA,
  calculateVPT,
  getLatestVolumeIndicatorValue,
} from '@/lib/strategy/indicators/volume-indicators';
import type { PriceCandle } from '@/types';

describe('Volume Indicators', () => {
  // Create test candles with volume
  function createTestCandles(count: number, basePrice: number = 2500): PriceCandle[] {
    const candles: PriceCandle[] = [];
    for (let i = 0; i < count; i++) {
      const price = basePrice + (i * 10);
      candles.push({
        timestamp: Date.now() + (i * 8 * 60 * 60 * 1000), // 8h intervals
        open: price,
        high: price + 5,
        low: price - 5,
        close: price + 2,
        volume: 1000000 + (i * 10000),
      });
    }
    return candles;
  }

  describe('calculateVWAP', () => {
    it('should calculate VWAP for valid data', () => {
      const candles = createTestCandles(20);
      const vwap = calculateVWAP(candles, 10, 19);
      
      expect(vwap).not.toBeNull();
      expect(vwap).toBeGreaterThan(0);
      // VWAP should be between high and low of the period
      expect(vwap).toBeGreaterThan(candles[10]!.low);
      expect(vwap).toBeLessThan(candles[19]!.high);
    });

    it('should return null for insufficient data', () => {
      const candles = createTestCandles(5);
      const vwap = calculateVWAP(candles, 10, 4);
      
      expect(vwap).toBeNull();
    });

    it('should return null for out of range index', () => {
      const candles = createTestCandles(20);
      const vwap = calculateVWAP(candles, 10, 25);
      
      expect(vwap).toBeNull();
    });

    it('should handle zero volume', () => {
      const candles = createTestCandles(20);
      candles[15]!.volume = 0;
      candles[16]!.volume = 0;
      candles[17]!.volume = 0;
      candles[18]!.volume = 0;
      candles[19]!.volume = 0;
      
      const vwap = calculateVWAP(candles, 10, 19);
      // Should still calculate if some volumes are non-zero
      expect(vwap).not.toBeNull();
    });
  });

  describe('calculateOBV', () => {
    it('should calculate OBV for valid data', () => {
      const candles = createTestCandles(20);
      const obv = calculateOBV(candles);
      
      expect(obv).toHaveLength(20);
      expect(obv[0]).toBe(candles[0]!.volume);
    });

    it('should accumulate volume on price increases', () => {
      const candles: PriceCandle[] = [
        { timestamp: Date.now(), open: 2500, high: 2510, low: 2490, close: 2505, volume: 1000 },
        { timestamp: Date.now() + 1000, open: 2505, high: 2520, low: 2500, close: 2515, volume: 2000 },
        { timestamp: Date.now() + 2000, open: 2515, high: 2530, low: 2510, close: 2525, volume: 1500 },
      ];
      
      const obv = calculateOBV(candles);
      
      expect(obv[0]).toBe(1000);
      expect(obv[1]).toBe(3000); // 1000 + 2000
      expect(obv[2]).toBe(4500); // 3000 + 1500
    });

    it('should subtract volume on price decreases', () => {
      const candles: PriceCandle[] = [
        { timestamp: Date.now(), open: 2500, high: 2510, low: 2490, close: 2505, volume: 1000 },
        { timestamp: Date.now() + 1000, open: 2505, high: 2510, low: 2495, close: 2500, volume: 2000 },
        { timestamp: Date.now() + 2000, open: 2500, high: 2505, low: 2485, close: 2490, volume: 1500 },
      ];
      
      const obv = calculateOBV(candles);
      
      expect(obv[0]).toBe(1000);
      expect(obv[1]).toBe(-1000); // 1000 - 2000
      expect(obv[2]).toBe(-2500); // -1000 - 1500
    });

    it('should keep OBV unchanged on equal prices', () => {
      const candles: PriceCandle[] = [
        { timestamp: Date.now(), open: 2500, high: 2510, low: 2490, close: 2505, volume: 1000 },
        { timestamp: Date.now() + 1000, open: 2505, high: 2510, low: 2500, close: 2505, volume: 2000 },
      ];
      
      const obv = calculateOBV(candles);
      
      expect(obv[0]).toBe(1000);
      expect(obv[1]).toBe(1000); // Unchanged
    });

    it('should handle empty array', () => {
      const obv = calculateOBV([]);
      expect(obv).toHaveLength(0);
    });
  });

  describe('calculateVolumeROC', () => {
    it('should calculate Volume ROC for valid data', () => {
      const candles = createTestCandles(20);
      const roc = calculateVolumeROC(candles, 5, 19);
      
      expect(roc).not.toBeNull();
      expect(typeof roc).toBe('number');
    });

    it('should return null for insufficient data', () => {
      const candles = createTestCandles(5);
      const roc = calculateVolumeROC(candles, 10, 4);
      
      expect(roc).toBeNull();
    });

    it('should return null for zero past volume', () => {
      const candles = createTestCandles(20);
      candles[14]!.volume = 0;
      
      const roc = calculateVolumeROC(candles, 5, 19);
      
      expect(roc).toBeNull();
    });

    it('should calculate positive ROC for increasing volume', () => {
      const candles = createTestCandles(20);
      candles[14]!.volume = 1000;
      candles[19]!.volume = 2000;
      
      const roc = calculateVolumeROC(candles, 5, 19);
      
      expect(roc).toBe(100); // (2000 - 1000) / 1000 * 100
    });
  });

  describe('calculateVolumeWeightedMACD', () => {
    it('should calculate Volume-weighted MACD for valid data', () => {
      const candles = createTestCandles(50);
      const { vwmacd, signal, histogram } = calculateVolumeWeightedMACD(candles);
      
      expect(vwmacd.length).toBeGreaterThan(0);
      expect(signal.length).toBeGreaterThan(0);
      expect(histogram.length).toBeGreaterThan(0);
      
      // Histogram should be VWMACD - Signal
      if (vwmacd.length > 0 && signal.length > 0 && histogram.length > 0) {
        const vwmacdIndex = vwmacd.length - histogram.length;
        expect(histogram[0]).toBeCloseTo(vwmacd[vwmacdIndex] - signal[0], 2);
      }
    });

    it('should return empty arrays for insufficient data', () => {
      const candles = createTestCandles(20);
      const { vwmacd, signal, histogram } = calculateVolumeWeightedMACD(candles);
      
      expect(vwmacd).toHaveLength(0);
      expect(signal).toHaveLength(0);
      expect(histogram).toHaveLength(0);
    });

    it('should handle custom periods', () => {
      const candles = createTestCandles(50);
      const { vwmacd, signal, histogram } = calculateVolumeWeightedMACD(candles, 9, 19, 9);
      
      expect(vwmacd.length).toBeGreaterThan(0);
      expect(signal.length).toBeGreaterThan(0);
      expect(histogram.length).toBeGreaterThan(0);
    });
  });

  describe('calculateVolumeMA', () => {
    it('should calculate Volume MA for valid data', () => {
      const candles = createTestCandles(20);
      const volumeMA = calculateVolumeMA(candles, 10);
      
      expect(volumeMA.length).toBe(11); // 20 - 10 + 1
      expect(volumeMA[0]).toBeGreaterThan(0);
    });

    it('should return empty array for insufficient data', () => {
      const candles = createTestCandles(5);
      const volumeMA = calculateVolumeMA(candles, 10);
      
      expect(volumeMA).toHaveLength(0);
    });

    it('should handle single period', () => {
      const candles = createTestCandles(5);
      const volumeMA = calculateVolumeMA(candles, 1);
      
      expect(volumeMA.length).toBe(5);
      expect(volumeMA[0]).toBe(candles[0]!.volume);
    });
  });

  describe('calculateVPT', () => {
    it('should calculate VPT for valid data', () => {
      const candles = createTestCandles(20);
      const vpt = calculateVPT(candles);
      
      expect(vpt).toHaveLength(20);
      expect(vpt[0]).toBe(candles[0]!.volume);
    });

    it('should accumulate on price increases', () => {
      const candles: PriceCandle[] = [
        { timestamp: Date.now(), open: 2500, high: 2510, low: 2490, close: 2500, volume: 1000 },
        { timestamp: Date.now() + 1000, open: 2500, high: 2520, low: 2495, close: 2510, volume: 2000 },
      ];
      
      const vpt = calculateVPT(candles);
      
      expect(vpt[0]).toBe(1000);
      // VPT[1] = 1000 + (2000 * (2510 - 2500) / 2500) = 1000 + 8 = 1008
      expect(vpt[1]).toBeGreaterThan(vpt[0]);
    });

    it('should decrease on price decreases', () => {
      const candles: PriceCandle[] = [
        { timestamp: Date.now(), open: 2500, high: 2510, low: 2490, close: 2500, volume: 1000 },
        { timestamp: Date.now() + 1000, open: 2500, high: 2505, low: 2485, close: 2490, volume: 2000 },
      ];
      
      const vpt = calculateVPT(candles);
      
      expect(vpt[0]).toBe(1000);
      // VPT[1] = 1000 + (2000 * (2490 - 2500) / 2500) = 1000 - 8 = 992
      expect(vpt[1]).toBeLessThan(vpt[0]);
    });

    it('should handle empty array', () => {
      const vpt = calculateVPT([]);
      expect(vpt).toHaveLength(0);
    });
  });

  describe('getLatestVolumeIndicatorValue', () => {
    it('should return correct value for valid index', () => {
      const values = [10, 20, 30, 40, 50];
      const value = getLatestVolumeIndicatorValue(values, 4, 0);
      expect(value).toBe(50);
    });

    it('should handle offset correctly', () => {
      const values = [10, 20, 30];
      const value = getLatestVolumeIndicatorValue(values, 2, 1);
      expect(value).toBe(20);
    });

    it('should return null for out of range index', () => {
      const values = [10, 20, 30];
      const value = getLatestVolumeIndicatorValue(values, 10, 0);
      expect(value).toBeNull();
    });

    it('should return null for empty array', () => {
      const value = getLatestVolumeIndicatorValue([], 0, 0);
      expect(value).toBeNull();
    });
  });
});

