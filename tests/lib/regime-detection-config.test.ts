/**
 * Regime Detection Configuration Tests
 *
 * Tests for BTC and ETH asset-specific regime detection configs.
 * Ensures configs are valid and ETH/BTC have different optimal parameters.
 */

import { describe, it, expect } from 'vitest';
import {
  getRegimeDetectionConfig,
  ASSET_REGIME_DETECTION_CONFIG,
  DEFAULT_REGIME_DETECTION_CONFIG,
  type RegimeDetectionConfig,
} from '@/lib/strategy/config/regime-detection-config';

describe('Regime Detection Configuration', () => {
  describe('ASSET_REGIME_DETECTION_CONFIG', () => {
    it('should have ETH config with valid values', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      expect(eth.regimeConfidenceThreshold).toBeGreaterThan(0);
      expect(eth.regimeConfidenceThreshold).toBeLessThan(1);
      expect(eth.momentumConfirmationThreshold).toBeGreaterThan(0);
      expect(eth.momentumConfirmationThreshold).toBeLessThan(1);
      expect(eth.regimePersistencePeriods).toBeGreaterThanOrEqual(1);
      expect(eth.regimeLookback).toBeGreaterThanOrEqual(1);
    });

    it('should have BTC config with valid values', () => {
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      expect(btc.regimeConfidenceThreshold).toBeGreaterThan(0);
      expect(btc.regimeConfidenceThreshold).toBeLessThan(1);
      expect(btc.momentumConfirmationThreshold).toBeGreaterThan(0);
      expect(btc.momentumConfirmationThreshold).toBeLessThan(1);
      expect(btc.regimePersistencePeriods).toBeGreaterThanOrEqual(1);
      expect(btc.regimeLookback).toBeGreaterThanOrEqual(1);
    });

    it('should have ETH divergenceWeight = 0.15 (optimized for ETH)', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      expect(eth.divergenceWeight).toBe(0.15);
    });

    it('should have BTC divergenceWeight = 0.10 (optimized for BTC)', () => {
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      expect(btc.divergenceWeight).toBe(0.10);
    });

    it('should have different divergenceWeight for ETH and BTC', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      expect(eth.divergenceWeight).not.toBe(btc.divergenceWeight);
    });

    it('should have bearThresholdMultiplier in valid range (0.7-1.0)', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      expect(eth.bearThresholdMultiplier).toBeGreaterThanOrEqual(0.7);
      expect(eth.bearThresholdMultiplier).toBeLessThanOrEqual(1.0);
      expect(btc.bearThresholdMultiplier).toBeGreaterThanOrEqual(0.7);
      expect(btc.bearThresholdMultiplier).toBeLessThanOrEqual(1.0);
    });

    it('should have bearMomentumMultiplier in valid range (0.7-1.0)', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      expect(eth.bearMomentumMultiplier).toBeGreaterThanOrEqual(0.7);
      expect(eth.bearMomentumMultiplier).toBeLessThanOrEqual(1.0);
      expect(btc.bearMomentumMultiplier).toBeGreaterThanOrEqual(0.7);
      expect(btc.bearMomentumMultiplier).toBeLessThanOrEqual(1.0);
    });
  });

  describe('getRegimeDetectionConfig', () => {
    it('should return ETH config for eth asset', () => {
      const config = getRegimeDetectionConfig('eth');
      expect(config).toBe(ASSET_REGIME_DETECTION_CONFIG.eth);
    });

    it('should return BTC config for btc asset', () => {
      const config = getRegimeDetectionConfig('btc');
      expect(config).toBe(ASSET_REGIME_DETECTION_CONFIG.btc);
    });

    it('should return different configs for ETH and BTC', () => {
      const ethConfig = getRegimeDetectionConfig('eth');
      const btcConfig = getRegimeDetectionConfig('btc');
      expect(ethConfig).not.toBe(btcConfig);
    });
  });

  describe('DEFAULT_REGIME_DETECTION_CONFIG', () => {
    it('should have valid default values', () => {
      expect(DEFAULT_REGIME_DETECTION_CONFIG.regimeConfidenceThreshold).toBe(0.12);
      expect(DEFAULT_REGIME_DETECTION_CONFIG.momentumConfirmationThreshold).toBe(0.15);
      expect(DEFAULT_REGIME_DETECTION_CONFIG.regimePersistencePeriods).toBe(1);
      expect(DEFAULT_REGIME_DETECTION_CONFIG.regimeLookback).toBe(1);
      expect(DEFAULT_REGIME_DETECTION_CONFIG.divergenceWeight).toBe(0.10);
    });

    it('should have conservative divergenceWeight (0.10)', () => {
      expect(DEFAULT_REGIME_DETECTION_CONFIG.divergenceWeight).toBe(0.10);
    });
  });

  describe('Config validation', () => {
    function validateConfig(config: RegimeDetectionConfig): boolean {
      return (
        config.regimeConfidenceThreshold >= 0 &&
        config.regimeConfidenceThreshold <= 1 &&
        config.momentumConfirmationThreshold >= 0 &&
        config.momentumConfirmationThreshold <= 1 &&
        config.regimePersistencePeriods >= 1 &&
        config.regimeLookback >= 1 &&
        config.divergenceWeight >= 0.05 &&
        config.divergenceWeight <= 0.25
      );
    }

    it('ETH config should pass validation', () => {
      expect(validateConfig(ASSET_REGIME_DETECTION_CONFIG.eth)).toBe(true);
    });

    it('BTC config should pass validation', () => {
      expect(validateConfig(ASSET_REGIME_DETECTION_CONFIG.btc)).toBe(true);
    });

    it('Default config should pass validation', () => {
      expect(validateConfig(DEFAULT_REGIME_DETECTION_CONFIG)).toBe(true);
    });
  });

  describe('BTC vs ETH parameter differences', () => {
    it('BTC should have higher regimeConfidenceThreshold than ETH (more conservative due to higher volatility)', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      // BTC is more volatile, so requires higher confidence for regime switching
      expect(btc.regimeConfidenceThreshold).toBeGreaterThan(eth.regimeConfidenceThreshold);
    });

    it('BTC should have lower divergenceWeight than ETH (divergence less reliable for BTC)', () => {
      const eth = ASSET_REGIME_DETECTION_CONFIG.eth;
      const btc = ASSET_REGIME_DETECTION_CONFIG.btc;
      // Session 28 found: ETH benefits from 0.15, BTC optimal at 0.10
      expect(btc.divergenceWeight).toBeLessThan(eth.divergenceWeight);
    });
  });
});
