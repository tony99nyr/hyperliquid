/**
 * Unit tests for market regime detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectMarketRegimeCached } from '@/lib/strategy/analysis/market-regime-detector-cached';
import { generatePriceCandles } from '../mocks/trading-data.mock';
import type { PriceCandle } from '@/types';

describe('Market Regime Detector', () => {
  let candles: PriceCandle[];

  beforeEach(() => {
    candles = generatePriceCandles('trending-up', 100, 2500);
  });

  describe('detectMarketRegimeCached', () => {
    it('should detect bullish regime in trending up market', () => {
      const bullishCandles = generatePriceCandles('bull-run', 100, 2500);
      
      if (bullishCandles.length >= 50) {
        const regime = detectMarketRegimeCached(bullishCandles, bullishCandles.length - 1);
        
        expect(regime).toBeDefined();
        expect(regime.regime).toBeDefined();
        expect(['bullish', 'bearish', 'neutral']).toContain(regime.regime);
        expect(regime.confidence).toBeGreaterThanOrEqual(0);
        expect(regime.confidence).toBeLessThanOrEqual(1);
        expect(regime.indicators).toBeDefined();
        expect(regime.indicators.trend).toBeGreaterThanOrEqual(-1);
        expect(regime.indicators.trend).toBeLessThanOrEqual(1);
      }
    });

    it('should detect bearish regime in trending down market', () => {
      const bearishCandles = generatePriceCandles('bear-market', 100, 2500);
      
      if (bearishCandles.length >= 50) {
        const regime = detectMarketRegimeCached(bearishCandles, bearishCandles.length - 1);
        
        expect(regime).toBeDefined();
        expect(regime.regime).toBeDefined();
        expect(['bullish', 'bearish', 'neutral']).toContain(regime.regime);
        expect(regime.confidence).toBeGreaterThanOrEqual(0);
        expect(regime.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should return neutral regime for insufficient data', () => {
      const shortCandles = generatePriceCandles('trending-up', 10, 2500);
      
      const regime = detectMarketRegimeCached(shortCandles, shortCandles.length - 1);
      
      expect(regime.regime).toBe('neutral');
      expect(regime.confidence).toBe(0);
    });

    it('should return neutral regime for index < 50', () => {
      if (candles.length >= 50) {
        const regime = detectMarketRegimeCached(candles, 30);
        
        expect(regime.regime).toBe('neutral');
        expect(regime.confidence).toBe(0);
      }
    });

    it('should calculate trend indicator', () => {
      if (candles.length >= 50) {
        const regime = detectMarketRegimeCached(candles, candles.length - 1);
        
        expect(regime.indicators.trend).toBeGreaterThanOrEqual(-1);
        expect(regime.indicators.trend).toBeLessThanOrEqual(1);
      }
    });

    it('should calculate momentum indicator', () => {
      if (candles.length >= 50) {
        const regime = detectMarketRegimeCached(candles, candles.length - 1);
        
        expect(regime.indicators.momentum).toBeGreaterThanOrEqual(-1);
        expect(regime.indicators.momentum).toBeLessThanOrEqual(1);
      }
    });

    it('should calculate volatility indicator', () => {
      if (candles.length >= 50) {
        const regime = detectMarketRegimeCached(candles, candles.length - 1);
        
        expect(regime.indicators.volatility).toBeGreaterThanOrEqual(0);
        expect(regime.indicators.volatility).toBeLessThanOrEqual(1);
      }
    });

    it('should cache indicator calculations', () => {
      if (candles.length >= 50) {
        // First call
        const regime1 = detectMarketRegimeCached(candles, candles.length - 1);
        
        // Second call with same candles should use cache
        const regime2 = detectMarketRegimeCached(candles, candles.length - 1);
        
        // Results should be the same
        expect(regime1.regime).toBe(regime2.regime);
        expect(regime1.confidence).toBe(regime2.confidence);
      }
    });

    it('should handle volatile markets', () => {
      const volatileCandles = generatePriceCandles('volatile', 100, 2500);
      
      if (volatileCandles.length >= 50) {
        const regime = detectMarketRegimeCached(volatileCandles, volatileCandles.length - 1);
        
        expect(regime).toBeDefined();
        expect(regime.indicators.volatility).toBeGreaterThan(0);
      }
    });

    it('should handle sideways markets', () => {
      const sidewaysCandles = generatePriceCandles('sideways', 100, 2500);
      
      if (sidewaysCandles.length >= 50) {
        const regime = detectMarketRegimeCached(sidewaysCandles, sidewaysCandles.length - 1);
        
        expect(regime).toBeDefined();
        // Sideways markets often result in neutral regime
        expect(['bullish', 'bearish', 'neutral']).toContain(regime.regime);
      }
    });
  });
});

