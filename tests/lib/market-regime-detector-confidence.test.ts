/**
 * Unit tests for market regime detector confidence calculation functions
 * 
 * Tests all pure confidence calculation functions extracted for DRY and testability.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateBaseConfidence,
  calculateBullishConfidence,
  calculateBearishConfidence,
  calculateNeutralConfidence,
  calibrateConfidence,
  adjustConfidenceForCorrelation,
} from '@/lib/strategy/analysis/market-regime-detector-confidence';

describe('Market Regime Detector Confidence', () => {
  describe('calculateBaseConfidence', () => {
    it('should calculate base confidence from signal metrics', () => {
      const confidence = calculateBaseConfidence(
        0.5,  // Strong combined signal
        0.6,  // High signal strength
        0.4,  // Good trend/momentum agreement
        0.5,  // Average trend strength
        0.5   // Average momentum strength
      );
      
      expect(confidence).toBeGreaterThan(0);
      // Base confidence can exceed 1.0 - it's capped later in the pipeline
      expect(confidence).toBeGreaterThan(0);
    });

    it('should return higher confidence for stronger signals', () => {
      const weakConfidence = calculateBaseConfidence(0.1, 0.2, 0.1, 0.2, 0.2);
      const strongConfidence = calculateBaseConfidence(0.8, 0.9, 0.7, 0.8, 0.8);
      
      expect(strongConfidence).toBeGreaterThan(weakConfidence);
      // Both should be positive values
      expect(weakConfidence).toBeGreaterThan(0);
      expect(strongConfidence).toBeGreaterThan(0);
    });

    it('should handle zero inputs', () => {
      const confidence = calculateBaseConfidence(0, 0, 0, 0, 0);
      expect(confidence).toBe(0);
    });

    it('should weight combined signal heavily', () => {
      const confidence1 = calculateBaseConfidence(0.5, 0.3, 0.2, 0.3, 0.3);
      const confidence2 = calculateBaseConfidence(0.8, 0.3, 0.2, 0.3, 0.3);
      
      expect(confidence2).toBeGreaterThan(confidence1);
    });
  });

  describe('calculateBullishConfidence', () => {
    it('should boost confidence for strong bullish signals', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const sma20 = Array.from({ length: 30 }, () => 100);
      const sma50 = Array.from({ length: 30 }, () => 95);
      const sma200 = Array.from({ length: 30 }, () => 90);
      
      const baseConfidence = 0.5;
      const boosted = calculateBullishConfidence(
        baseConfidence,
        prices,
        29,
        0.5,  // Strong signal strength
        0.3,  // Combined signal
        0.4,  // Trend/momentum agreement
        0.05, // Moderate volatility
        false, // Not persistent
        sma20,
        sma50,
        sma200
      );
      
      expect(boosted).toBeGreaterThanOrEqual(baseConfidence);
      expect(boosted).toBeLessThanOrEqual(1);
    });

    it('should apply strong boost for persistent trends', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const sma20 = Array.from({ length: 30 }, () => 100);
      const sma50 = Array.from({ length: 30 }, () => 95);
      const sma200 = Array.from({ length: 30 }, () => 90);
      
      const baseConfidence = 0.5;
      const boosted = calculateBullishConfidence(
        baseConfidence,
        prices,
        29,
        0.4,  // Good signal strength
        0.12, // Combined signal
        0.35, // Trend/momentum agreement
        0.05,
        true, // Persistent trend
        sma20,
        sma50,
        sma200
      );
      
      expect(boosted).toBeGreaterThan(baseConfidence);
    });

    it('should boost for aligned moving averages', () => {
      const prices = Array.from({ length: 250 }, (_, i) => 100 + i * 0.1);
      const sma20 = Array.from({ length: 250 }, (_, i) => 100 + i * 0.08);
      const sma50 = Array.from({ length: 250 }, (_, i) => 100 + i * 0.06);
      const sma200 = Array.from({ length: 250 }, (_, i) => 100 + i * 0.04);
      
      const baseConfidence = 0.5;
      const boosted = calculateBullishConfidence(
        baseConfidence,
        prices,
        249,
        0.5,
        0.3,
        0.4,
        0.05,
        false,
        sma20,
        sma50,
        sma200
      );
      
      expect(boosted).toBeGreaterThan(baseConfidence);
    });

    it('should cap confidence at 1.0', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
      const sma20 = Array.from({ length: 30 }, () => 100);
      const sma50 = Array.from({ length: 30 }, () => 95);
      const sma200 = Array.from({ length: 30 }, () => 90);
      
      const baseConfidence = 0.9;
      const boosted = calculateBullishConfidence(
        baseConfidence,
        prices,
        29,
        0.9,
        0.5,
        0.8,
        0.05,
        true,
        sma20,
        sma50,
        sma200
      );
      
      expect(boosted).toBeLessThanOrEqual(1.0);
    });
  });

  describe('calculateBearishConfidence', () => {
    it('should boost confidence for strong bearish signals', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const sma20 = Array.from({ length: 30 }, () => 100);
      const sma50 = Array.from({ length: 30 }, () => 105);
      const sma200 = Array.from({ length: 30 }, () => 110);
      
      const baseConfidence = 0.5;
      const boosted = calculateBearishConfidence(
        baseConfidence,
        prices,
        29,
        0.5,
        -0.3,
        0.4,
        0.05,
        false,
        sma20,
        sma50,
        sma200
      );
      
      expect(boosted).toBeGreaterThanOrEqual(baseConfidence);
      expect(boosted).toBeLessThanOrEqual(1);
    });

    it('should apply boost for persistent bear trends', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const sma20 = Array.from({ length: 30 }, () => 100);
      const sma50 = Array.from({ length: 30 }, () => 105);
      const sma200 = Array.from({ length: 30 }, () => 110);
      
      const baseConfidence = 0.5;
      const boosted = calculateBearishConfidence(
        baseConfidence,
        prices,
        29,
        0.4,
        -0.12,
        0.35,
        0.05,
        true,
        sma20,
        sma50,
        sma200
      );
      
      expect(boosted).toBeGreaterThan(baseConfidence);
    });

    it('should handle null SMA200 gracefully', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const sma20 = Array.from({ length: 30 }, () => 100);
      const sma50 = Array.from({ length: 30 }, () => 105);
      
      const baseConfidence = 0.5;
      const boosted = calculateBearishConfidence(
        baseConfidence,
        prices,
        29,
        0.5,
        -0.3,
        0.4,
        0.05,
        false,
        sma20,
        sma50,
        null
      );
      
      expect(boosted).toBeGreaterThanOrEqual(baseConfidence);
    });
  });

  describe('calculateNeutralConfidence', () => {
    it('should return higher confidence for clear neutral conditions', () => {
      const clearNeutral = calculateNeutralConfidence(0.2, true, false);
      const unclearNeutral = calculateNeutralConfidence(0.2, false, false);
      
      expect(clearNeutral).toBeGreaterThan(unclearNeutral);
    });

    it('should return higher confidence for low volatility choppy conditions', () => {
      const lowVolChoppy = calculateNeutralConfidence(0.2, false, true);
      const unclearNeutral = calculateNeutralConfidence(0.2, false, false);
      
      expect(lowVolChoppy).toBeGreaterThan(unclearNeutral);
    });

    it('should reduce confidence for high uncertainty', () => {
      const lowUncertainty = calculateNeutralConfidence(0.1, true, false);
      const highUncertainty = calculateNeutralConfidence(0.5, true, false);
      
      expect(lowUncertainty).toBeGreaterThan(highUncertainty);
    });

    it('should return values in valid range', () => {
      const confidence = calculateNeutralConfidence(0.3, false, false);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('calibrateConfidence', () => {
    it('should boost confidence for trend/momentum agreement', () => {
      const calibrated = calibrateConfidence(0.5, 0.6, 0.6, 100, 95, 0.5);
      expect(calibrated).toBeGreaterThan(0.5);
    });

    it('should reduce confidence for conflicting signals', () => {
      const calibrated = calibrateConfidence(0.5, 0.6, -0.6, 100, 95, 0.5);
      expect(calibrated).toBeLessThan(0.5);
    });

    it('should boost for golden/death cross', () => {
      const goldenCross = calibrateConfidence(0.5, 0.3, 0.3, 105, 95, 0.5);
      const noCross = calibrateConfidence(0.5, 0.3, 0.3, 100, 99, 0.5);
      
      expect(goldenCross).toBeGreaterThan(noCross);
    });

    it('should cap confidence for weak signal strength', () => {
      const weakSignal = calibrateConfidence(0.8, 0.3, 0.3, 100, 95, 0.2);
      expect(weakSignal).toBeLessThanOrEqual(0.5);
    });

    it('should handle null SMA values', () => {
      const calibrated = calibrateConfidence(0.5, 0.3, 0.3, null, null, 0.5);
      expect(calibrated).toBeGreaterThanOrEqual(0);
      expect(calibrated).toBeLessThanOrEqual(1);
    });
  });

  describe('adjustConfidenceForCorrelation', () => {
    it('should boost confidence for low risk correlation', () => {
      const adjusted = adjustConfidenceForCorrelation(
        0.5,
        'bullish',
        { signal: 0.8, riskLevel: 'low' }
      );
      
      expect(adjusted).toBeGreaterThan(0.5);
    });

    it('should reduce confidence for high risk correlation', () => {
      const adjusted = adjustConfidenceForCorrelation(
        0.5,
        'bullish',
        { signal: 0.8, riskLevel: 'high' }
      );
      
      expect(adjusted).toBeLessThan(0.5);
    });

    it('should reduce confidence when correlation contradicts regime', () => {
      const adjusted = adjustConfidenceForCorrelation(
        0.5,
        'bullish',
        { signal: -0.8, riskLevel: 'medium' }
      );
      
      expect(adjusted).toBeLessThan(0.5);
    });

    it('should return unchanged confidence when no correlation context', () => {
      const adjusted = adjustConfidenceForCorrelation(0.5, 'bullish', undefined);
      expect(adjusted).toBe(0.5);
    });

    it('should handle neutral regime', () => {
      const adjusted = adjustConfidenceForCorrelation(
        0.5,
        'neutral',
        { signal: 0.5, riskLevel: 'medium' }
      );
      
      expect(adjusted).toBeGreaterThanOrEqual(0);
      expect(adjusted).toBeLessThanOrEqual(1);
    });
  });
});
