/**
 * Unit tests for market regime detector regime determination functions
 * 
 * Tests all pure regime determination functions extracted for DRY and testability.
 */

import { describe, it, expect } from 'vitest';
import {
  isSignalNearThreshold,
  shouldDetectBullish,
  shouldDetectBearish,
  shouldDetectNeutral,
} from '@/lib/strategy/analysis/market-regime-detector-regime';

describe('Market Regime Detector Regime', () => {
  describe('isSignalNearThreshold', () => {
    it('should detect signal near threshold', () => {
      const isNear = isSignalNearThreshold(0.08, 0.1, 0.3);
      expect(isNear).toBe(true);
    });

    it('should not detect signal far from threshold', () => {
      const isNear = isSignalNearThreshold(0.2, 0.1, 0.5);
      expect(isNear).toBe(false);
    });

    it('should require low signal strength', () => {
      const isNear = isSignalNearThreshold(0.08, 0.1, 0.5);
      expect(isNear).toBe(false);
    });

    it('should handle negative thresholds', () => {
      const isNear = isSignalNearThreshold(-0.08, -0.1, 0.3);
      expect(isNear).toBe(true);
    });
  });

  describe('shouldDetectBullish', () => {
    it('should detect bullish when all conditions met', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const result = shouldDetectBullish(
        0.15,  // Combined signal above threshold
        0.1,   // Bullish threshold
        0.4,   // Signal strength above minimum
        0.3,   // Minimum strength
        true,  // Momentum confirmed
        false, // Not near threshold
        prices,
        29,
        0.05   // Moderate volatility
      );
      
      expect(result.shouldDetect).toBe(true);
    });

    it('should not detect bullish when signal below threshold', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const result = shouldDetectBullish(
        0.05,  // Combined signal below threshold
        0.1,
        0.4,
        0.3,
        true,
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('should not detect bullish when momentum not confirmed', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const result = shouldDetectBullish(
        0.15,
        0.1,
        0.4,
        0.3,
        false, // Momentum not confirmed
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
    });

    it('should not detect bullish when signal near threshold', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const result = shouldDetectBullish(
        0.12,
        0.1,
        0.3,
        0.3,
        true,
        true,  // Near threshold
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
    });

    it('should not detect bullish for false breakout', () => {
      const prices = Array.from({ length: 30 }, (_, i) => {
        if (i < 25) return 100;
        return 100 - (i - 25) * 0.5; // Recent drop
      });
      
      const result = shouldDetectBullish(
        0.15,
        0.1,
        0.4,
        0.3,
        true,
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
      expect(result.reason).toContain('False bull breakout');
    });

    it('should not detect bullish for weak momentum', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.01); // Very slow movement
      const result = shouldDetectBullish(
        0.15,
        0.1,
        0.3,  // Weak signal strength
        0.3,
        true,
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
    });
  });

  describe('shouldDetectBearish', () => {
    it('should detect bearish when all conditions met', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const result = shouldDetectBearish(
        -0.15, // Combined signal below threshold
        -0.1,  // Bearish threshold
        0.4,   // Signal strength above minimum
        0.3,   // Minimum strength
        true,  // Momentum confirmed
        false, // Not near threshold
        prices,
        29,
        0.05   // Moderate volatility
      );
      
      expect(result.shouldDetect).toBe(true);
    });

    it('should not detect bearish when signal above threshold', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const result = shouldDetectBearish(
        -0.05, // Combined signal above threshold
        -0.1,
        0.4,
        0.3,
        true,
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('should not detect bearish when momentum not confirmed', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const result = shouldDetectBearish(
        -0.15,
        -0.1,
        0.4,
        0.3,
        false, // Momentum not confirmed
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
    });

    it('should not detect bearish for false breakout', () => {
      const prices = Array.from({ length: 30 }, (_, i) => {
        if (i < 25) return 100;
        return 100 + (i - 25) * 0.5; // Recent rally
      });
      
      const result = shouldDetectBearish(
        -0.15,
        -0.1,
        0.4,
        0.3,
        true,
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
      expect(result.reason).toContain('False bear breakout');
    });

    it('should not detect bearish for weak momentum', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.01); // Very slow movement
      const result = shouldDetectBearish(
        -0.15,
        -0.1,
        0.3,  // Weak signal strength
        0.3,
        true,
        false,
        prices,
        29,
        0.05
      );
      
      expect(result.shouldDetect).toBe(false);
    });
  });

  describe('shouldDetectNeutral', () => {
    it('should detect neutral for false breakout', () => {
      const prices = Array.from({ length: 30 }, (_, i) => {
        if (i < 25) return 100;
        return 100 + (i % 2 === 0 ? 0.5 : -0.5); // Choppy
      });
      
      const result = shouldDetectNeutral(
        prices,
        29,
        0.05,  // Weak combined signal
        0.25,  // Low signal strength
        0.03,  // Low volatility
        0.1,   // Weak trend
        0.1,   // Weak momentum
        0.1,   // Base threshold
        0.1,   // Bullish threshold
        []     // Empty history
      );
      
      expect(result.shouldDetect).toBe(true);
    });

    it('should detect neutral for volatility squeeze', () => {
      const prices = Array.from({ length: 30 }, () => 100);
      const result = shouldDetectNeutral(
        prices,
        29,
        0.03,
        0.2,
        0.03,  // Low volatility
        0.1,
        0.1,
        0.1,
        0.1,
        []
      );
      
      expect(result.shouldDetect).toBe(true);
    });

    it('should detect neutral for sideways market', () => {
      const prices = Array.from({ length: 30 }, () => 100 + Math.random() * 0.5);
      const result = shouldDetectNeutral(
        prices,
        29,
        0.05,
        0.25,
        0.03,  // Low volatility
        0.05,  // Weak trend
        0.05,  // Weak momentum
        0.1,
        0.1,
        []
      );
      
      expect(result.shouldDetect).toBe(true);
    });

    it('should detect neutral for whipsaw pattern', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 0.5);
      const regimeHistory: Array<'bullish' | 'bearish' | 'neutral'> = [
        'bullish',
        'bearish',
        'bullish',
        'neutral',
        'bearish',
      ];
      
      const result = shouldDetectNeutral(
        prices,
        29,
        0.05,
        0.3,
        0.05,
        0.1,
        0.1,
        0.1,
        0.1,
        regimeHistory
      );
      
      expect(result.shouldDetect).toBe(true);
      expect(result.isClearNeutral).toBe(true);
    });

    it('should detect neutral for conflicting signals', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 0.5);
      const result = shouldDetectNeutral(
        prices,
        29,
        0.05,
        0.25,
        0.05,
        0.3,  // Positive trend
        -0.3, // Negative momentum (conflicting)
        0.1,
        0.1,
        []
      );
      
      expect(result.shouldDetect).toBe(true);
    });

    it('should detect neutral for low volatility choppy conditions', () => {
      const prices = Array.from({ length: 30 }, () => 100 + Math.random() * 0.3);
      const result = shouldDetectNeutral(
        prices,
        29,
        0.05,
        0.25,  // Low signal strength
        0.03,  // Low volatility
        0.1,
        0.1,
        0.1,
        0.1,
        []
      );
      
      expect(result.shouldDetect).toBe(true);
      expect(result.isLowVolatilityChoppy).toBe(true);
    });

    it('should not detect neutral for strong bullish signal', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const result = shouldDetectNeutral(
        prices,
        29,
        0.15,  // Strong combined signal
        0.5,   // High signal strength
        0.05,
        0.4,   // Strong trend
        0.4,   // Strong momentum
        0.1,
        0.1,
        []
      );
      
      expect(result.shouldDetect).toBe(false);
    });

    it('should not detect neutral for strong bearish signal', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
      const result = shouldDetectNeutral(
        prices,
        29,
        -0.15, // Strong negative signal
        0.5,
        0.05,
        -0.4,
        -0.4,
        0.1,
        0.1,
        []
      );
      
      expect(result.shouldDetect).toBe(false);
    });
  });
});
