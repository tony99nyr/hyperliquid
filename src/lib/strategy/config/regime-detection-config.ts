/**
 * Regime Detection Configuration
 * 
 * Separated from trading strategy config for better maintainability, flexibility, and testability.
 * Regime detection identifies market state (bull/bear/neutral), while trading config defines
 * how to trade in each regime.
 * 
 * Each asset can have its own regime detection config to account for:
 * - Different volatility characteristics
 * - Different historical behavior patterns
 * - Asset-specific optimization results
 */

import type { TradingAsset } from '@/lib/infrastructure/config/asset-config';

/**
 * Configuration for market regime detection
 * Controls when and how confidently we identify market regimes
 */
export interface RegimeDetectionConfig {
  /**
   * Minimum confidence threshold to switch to a new regime
   * Lower = faster regime switching, more sensitive to market changes
   * Higher = slower regime switching, more conservative
   * 
   * Range: 0.0 - 1.0
   * Typical: 0.08 - 0.20
   */
  regimeConfidenceThreshold: number;

  /**
   * Minimum momentum confirmation required before entering a position
   * Lower = faster entry, more aggressive
   * Higher = slower entry, more conservative
   * 
   * Range: 0.0 - 1.0
   * Typical: 0.10 - 0.25
   */
  momentumConfirmationThreshold: number;

  /**
   * Bear-specific threshold adjustment
   * Bear markets may need different thresholds due to higher volatility
   * This is a multiplier applied to the base threshold for bear markets
   * 
   * Range: 0.7 - 1.0
   * Typical: 0.8 - 0.9 (slightly more lenient for bear markets)
   */
  bearThresholdMultiplier?: number;

  /**
   * Bear-specific momentum confirmation adjustment
   * Bear markets may have choppier momentum, so we can be more lenient
   * This is a multiplier applied to the momentum threshold for bear markets
   * 
   * Range: 0.7 - 1.0
   * Typical: 0.8 - 0.9 (slightly more lenient for bear markets)
   */
  bearMomentumMultiplier?: number;

  /**
   * Number of periods to require before switching regimes
   * Lower = faster switching, more responsive
   * Higher = slower switching, more stable
   * 
   * Range: 1 - 5
   * Typical: 1 (fast switching)
   */
  regimePersistencePeriods: number;

  /**
   * Number of periods to look back for regime detection
   * More lookback = smoother regime detection, less noise
   * Less lookback = faster regime detection, more responsive
   *
   * Range: 1 - 5
   * Typical: 1 - 3
   */
  regimeLookback: number;

  /**
   * Weight for divergence signal in combined regime detection
   * Divergence signals warn of potential reversals
   * Higher = more weight to reversal signals (better for assets with clearer divergence patterns)
   * Lower = more weight to trend/momentum (better for assets where divergence is less reliable)
   *
   * Session 28 found: ETH benefits from 0.15, BTC optimal at 0.10
   * The remaining weight is split between trend (45% of non-divergence) and momentum (45%)
   *
   * Range: 0.05 - 0.25
   * ETH typical: 0.15
   * BTC typical: 0.10
   */
  divergenceWeight: number;
}

/**
 * Asset-specific regime detection configurations
 * 
 * These are optimized separately for each asset to account for:
 * - Volatility differences (BTC more volatile than ETH)
 * - Historical behavior patterns
 * - ML optimization results
 */
export const ASSET_REGIME_DETECTION_CONFIG: Record<TradingAsset, RegimeDetectionConfig> = {
  eth: {
    regimeConfidenceThreshold: 0.10,      // Middle of optimization range (0.08-0.13)
    momentumConfirmationThreshold: 0.14,   // Middle of optimization range (0.10-0.18)
    regimePersistencePeriods: 1,           // Session 31: Test 2 = NO EFFECT (reverted)
    regimeLookback: 1,                     // Responsive regime detection
    bearThresholdMultiplier: 0.85,         // Bear markets: 15% more lenient (0.10 * 0.85 = 0.085)
    bearMomentumMultiplier: 0.85,          // Bear markets: 15% more lenient momentum (0.14 * 0.85 = 0.119)
    divergenceWeight: 0.15,                // Session 28: 15% improves ETH (+1.55% avg, +3.54% bull gap)
  },
  btc: {
    regimeConfidenceThreshold: 0.13,       // Middle of optimization range (0.10-0.16) - Session 30: 0.10 tested, no effect
    momentumConfirmationThreshold: 0.15,  // Middle of optimization range (0.10-0.20)
    regimePersistencePeriods: 1,           // Session 31: Test 2 = NO EFFECT (reverted)
    regimeLookback: 1,                      // Responsive regime detection
    bearThresholdMultiplier: 0.85,         // Bear markets: 15% more lenient (0.13 * 0.85 = 0.1105)
    bearMomentumMultiplier: 0.85,          // Bear markets: 15% more lenient momentum (0.15 * 0.85 = 0.1275)
    divergenceWeight: 0.10,                // Session 28/30: 10% optimal (0.08/0.15 tested, no effect/regressed)
  },
} as const;

/**
 * Get regime detection config for a specific asset
 */
export function getRegimeDetectionConfig(asset: TradingAsset): RegimeDetectionConfig {
  return ASSET_REGIME_DETECTION_CONFIG[asset];
}

/**
 * Default regime detection config (fallback)
 */
export const DEFAULT_REGIME_DETECTION_CONFIG: RegimeDetectionConfig = {
  regimeConfidenceThreshold: 0.12,
  momentumConfirmationThreshold: 0.15,
  regimePersistencePeriods: 1,
  regimeLookback: 1,
  bearThresholdMultiplier: 0.85,
  bearMomentumMultiplier: 0.85,
  divergenceWeight: 0.10, // Default: conservative 10% weight
};
