/**
 * ATR-Based Stop Loss System
 * 
 * Implements trailing stop losses based on Average True Range (ATR)
 * to protect profits and limit losses.
 * 
 * Features:
 * - ATR-based stop loss distance (e.g., 2x ATR below entry price)
 * - Trailing stop loss (moves up as price increases, never down)
 * - Configurable ATR multiplier for different risk levels
 */

import type { Trade } from '@/types';
// PriceCandle and getATRValue may be needed for future extensions

export interface StopLossConfig {
  enabled: boolean;
  atrMultiplier: number; // Stop loss distance in ATR units (e.g., 2.0 = 2x ATR)
  trailing: boolean; // If true, stop loss trails upward with price
  useEMA: boolean; // Use EMA for ATR calculation (default: true, smoother)
  atrPeriod: number; // ATR period (default: 14)
  regimeAwareStops?: boolean; // If true, adjust multiplier based on market regime
  regimeMultipliers?: {
    // Optional custom regime multipliers (defaults: bullish=2.0, bearish=3.0, neutral=2.5)
    bullish?: number;
    bearish?: number;
    neutral?: number;
  };
}

/**
 * Take-profit tier configuration
 * Each tier defines an ATR-based target and partial exit percentage
 */
export interface TakeProfitTier {
  atrMultiplier: number; // Profit target in ATR units (e.g., 2.0 = 2x ATR above entry)
  exitPct: number; // Percentage of remaining position to exit (0.0-1.0)
}

/**
 * Take-Profit Configuration
 *
 * Implements ATR-based take-profit targets with partial exits.
 *
 * Example configuration:
 * - Tier 1: 2x ATR, exit 40% → Lock in early gains
 * - Tier 2: 4x ATR, exit 40% → Lock in mid gains
 * - Remaining 20% trails with stop loss
 */
export interface TakeProfitConfig {
  enabled: boolean;
  tiers: TakeProfitTier[]; // Ordered by atrMultiplier ascending
  useATRFromEntry: boolean; // If true, use ATR at entry; if false, use current ATR
  regimeAwareTakeProfit?: boolean; // If true, adjust targets based on market regime
}

/**
 * Market regime type (imported from market-regime-detector)
 */
export type MarketRegime = 'bullish' | 'bearish' | 'neutral';

/**
 * Regime-aware ATR multiplier adjustments
 * - Bullish: Tighter stops (2.0x) to protect gains faster
 * - Bearish: Wider stops (3.0x) to avoid false breakdowns
 * - Neutral: Default stops (2.5x) balanced
 */
const REGIME_ATR_MULTIPLIERS: Record<MarketRegime, number> = {
  bullish: 2.0,  // Tighter - protect gains faster
  bearish: 3.0,  // Wider - avoid false breakdown stopouts
  neutral: 2.5,  // Default balanced
};

export interface OpenPosition {
  buyTrade: Trade;
  entryPrice: number;
  stopLossPrice: number;
  highestPrice: number; // For trailing stops
  atrAtEntry: number; // ATR value when position was opened
  // Take-profit tracking
  takeProfitPrices?: number[]; // TP prices for each tier (calculated from entry + ATR)
  completedTiers?: number; // Number of TP tiers already triggered
  remainingPositionPct?: number; // Remaining position as percentage (starts at 1.0)
}

export interface StopLossResult {
  shouldExit: boolean;
  exitReason?: 'stop-loss' | 'trailing-stop';
  stopLossPrice: number;
  currentPrice: number;
  distanceToStop: number; // Percentage distance to stop loss
}

const DEFAULT_CONFIG: StopLossConfig = {
  enabled: true,
  atrMultiplier: 2.5, // 2.5x ATR stop loss (Fix #7: wider for crypto volatility)
  trailing: true,
  useEMA: true,
  atrPeriod: 14,
};

/**
 * Fallback ATR percentages when actual ATR is unavailable
 * These are based on typical crypto volatility regimes
 */
const FALLBACK_ATR_PERCENTAGES = {
  low: 0.015, // Low volatility: 1.5% of price
  normal: 0.03, // Normal volatility: 3% of price
  high: 0.05, // High volatility: 5% of price
} as const;

/**
 * Slippage buffer percentage to add to stop loss for market orders
 */
const SLIPPAGE_BUFFER_PERCENTAGE = 0.002; // 0.2% slippage buffer

/**
 * Epsilon for floating point comparison (relative to price)
 * This prevents false triggers due to floating point precision issues
 */
const PRICE_COMPARISON_EPSILON = 1e-8;

/**
 * Calculate initial stop loss price for a buy trade
 */
export function calculateStopLossPrice(
  entryPrice: number,
  atrValue: number,
  config: StopLossConfig = DEFAULT_CONFIG
): number {
  if (!config.enabled || !atrValue || atrValue <= 0) {
    return 0; // No stop loss
  }

  // Stop loss is ATR multiplier below entry price
  const stopLossDistance = atrValue * config.atrMultiplier;
  return entryPrice - stopLossDistance;
}

/**
 * Update stop loss for an open position (handles trailing stops)
 */
export function updateStopLoss(
  position: OpenPosition,
  currentPrice: number,
  currentATR: number | null,
  config: StopLossConfig = DEFAULT_CONFIG
): StopLossResult {
  if (!config.enabled) {
    return {
      shouldExit: false,
      stopLossPrice: 0,
      currentPrice,
      distanceToStop: 0,
    };
  }

  // Update highest price for trailing stops
  if (currentPrice > position.highestPrice) {
    position.highestPrice = currentPrice;
  }

  let stopLossPrice = position.stopLossPrice;

  // Update trailing stop if enabled
  if (config.trailing) {
    // Use current ATR or fallback to entry ATR for consistency in low-vol periods
    const effectiveATR = (currentATR && currentATR > 0)
      ? currentATR
      : position.atrAtEntry;

    // Calculate new trailing stop: highest price - (ATR * multiplier)
    const trailingStop = position.highestPrice - (effectiveATR * config.atrMultiplier);

    // Apply slippage buffer to trailing stop
    const trailingStopWithBuffer = trailingStop * (1 - SLIPPAGE_BUFFER_PERCENTAGE);

    // Only move stop loss up, never down
    if (trailingStopWithBuffer > stopLossPrice) {
      stopLossPrice = trailingStopWithBuffer;
      position.stopLossPrice = stopLossPrice;
    }
  }

  // Check if stop loss is triggered
  // Use epsilon comparison to avoid floating point precision issues
  // Price must be meaningfully below stop loss (not just floating point noise)
  const epsilon = stopLossPrice * PRICE_COMPARISON_EPSILON;
  const shouldExit = (stopLossPrice - currentPrice) > epsilon;
  // Guard against division by zero when calculating distance to stop
  const distanceToStop = stopLossPrice > 0 && currentPrice > 0
    ? ((currentPrice - stopLossPrice) / currentPrice) * 100
    : 0;

  return {
    shouldExit,
    exitReason: shouldExit ? (config.trailing ? 'trailing-stop' : 'stop-loss') : undefined,
    stopLossPrice,
    currentPrice,
    distanceToStop,
  };
}

/**
 * Check if any open positions should be closed due to stop loss
 */
export function checkStopLosses(
  openPositions: OpenPosition[],
  currentPrice: number,
  currentATR: number | null,
  config: StopLossConfig = DEFAULT_CONFIG
): Array<{ position: OpenPosition; result: StopLossResult }> {
  return openPositions.map(position => ({
    position,
    result: updateStopLoss(position, currentPrice, currentATR, config),
  }));
}

export type VolatilityRegime = 'low' | 'normal' | 'high';

/**
 * Get fallback ATR percentage based on volatility regime
 */
export function getFallbackATRPercentage(regime: VolatilityRegime = 'normal'): number {
  return FALLBACK_ATR_PERCENTAGES[regime];
}

/**
 * Get effective ATR multiplier based on market regime
 * If customMultipliers provided, use them; otherwise use REGIME_ATR_MULTIPLIERS defaults
 */
export function getRegimeAwareMultiplier(
  baseMultiplier: number,
  marketRegime: MarketRegime | undefined,
  regimeAwareStops: boolean,
  customMultipliers?: { bullish?: number; bearish?: number; neutral?: number }
): number {
  if (!regimeAwareStops || !marketRegime) {
    return baseMultiplier;
  }
  // Use custom multiplier if provided, otherwise fall back to defaults
  if (customMultipliers) {
    const customValue = customMultipliers[marketRegime];
    if (customValue !== undefined) {
      return customValue;
    }
  }
  return REGIME_ATR_MULTIPLIERS[marketRegime];
}

/**
 * Create an open position from a buy trade
 * If ATR is unavailable, uses a fallback percentage-based ATR estimate
 * based on the current volatility regime
 */
export function createOpenPosition(
  buyTrade: Trade,
  entryPrice: number,
  atrAtEntry: number | null,
  config: StopLossConfig = DEFAULT_CONFIG,
  volatilityRegime: VolatilityRegime = 'normal',
  marketRegime?: MarketRegime
): OpenPosition | null {
  if (!config.enabled) {
    return null; // Stop loss not configured
  }

  // Use actual ATR or fallback to volatility-regime-aware percentage
  const fallbackPercentage = getFallbackATRPercentage(volatilityRegime);
  const effectiveATR = (atrAtEntry && atrAtEntry > 0)
    ? atrAtEntry
    : entryPrice * fallbackPercentage;

  // Get regime-aware multiplier if configured
  const effectiveMultiplier = getRegimeAwareMultiplier(
    config.atrMultiplier,
    marketRegime,
    config.regimeAwareStops ?? false,
    config.regimeMultipliers
  );

  // Create a modified config with the regime-aware multiplier
  const effectiveConfig = {
    ...config,
    atrMultiplier: effectiveMultiplier,
  };

  // Calculate stop loss with slippage buffer
  const rawStopLoss = calculateStopLossPrice(entryPrice, effectiveATR, effectiveConfig);
  const stopLossPrice = rawStopLoss > 0
    ? rawStopLoss * (1 - SLIPPAGE_BUFFER_PERCENTAGE)
    : 0;

  return {
    buyTrade,
    entryPrice,
    stopLossPrice,
    highestPrice: entryPrice,
    atrAtEntry: effectiveATR,
    // Take-profit fields initialized to defaults
    takeProfitPrices: undefined,
    completedTiers: 0,
    remainingPositionPct: 1.0,
  };
}

// ============================================================================
// Take-Profit Functions
// ============================================================================

const DEFAULT_TAKE_PROFIT_CONFIG: TakeProfitConfig = {
  enabled: false,
  tiers: [
    { atrMultiplier: 2.0, exitPct: 0.4 }, // Exit 40% at 2x ATR profit
    { atrMultiplier: 4.0, exitPct: 0.4 }, // Exit 40% at 4x ATR profit
    // Remaining 20% trails with stop loss
  ],
  useATRFromEntry: true,
  regimeAwareTakeProfit: false,
};

/**
 * Regime-aware take-profit multiplier adjustments
 * - Bullish: Wider targets (1.2x) to let winners run longer
 * - Bearish: Tighter targets (0.8x) to lock in gains faster
 * - Neutral: Default targets (1.0x)
 */
const REGIME_TP_MULTIPLIERS: Record<MarketRegime, number> = {
  bullish: 1.2,  // Wider targets in uptrends - let winners run
  bearish: 0.8,  // Tighter targets in downtrends - lock in gains faster
  neutral: 1.0,  // Default
};

export interface TakeProfitResult {
  shouldExit: boolean;
  exitReason?: 'take-profit';
  tierTriggered?: number; // Which tier was triggered (0-indexed)
  takeProfitPrice: number; // The TP price that was hit
  currentPrice: number;
  exitPct: number; // Percentage of remaining position to exit
  remainingPositionPct: number; // Position remaining after this exit
}

/**
 * Calculate take-profit prices for an open position
 */
export function calculateTakeProfitPrices(
  entryPrice: number,
  atrValue: number,
  config: TakeProfitConfig = DEFAULT_TAKE_PROFIT_CONFIG,
  marketRegime?: MarketRegime
): number[] {
  if (!config.enabled || !atrValue || atrValue <= 0) {
    return [];
  }

  // Get regime-aware multiplier adjustment
  const regimeMultiplier = config.regimeAwareTakeProfit && marketRegime
    ? REGIME_TP_MULTIPLIERS[marketRegime]
    : 1.0;

  // Calculate TP prices for each tier
  return config.tiers.map(tier => {
    const adjustedATRMultiplier = tier.atrMultiplier * regimeMultiplier;
    const takeProfitDistance = atrValue * adjustedATRMultiplier;
    return entryPrice + takeProfitDistance;
  });
}

/**
 * Check if a take-profit level has been triggered
 */
export function checkTakeProfit(
  position: OpenPosition,
  currentPrice: number,
  config: TakeProfitConfig = DEFAULT_TAKE_PROFIT_CONFIG
): TakeProfitResult {
  if (!config.enabled) {
    return {
      shouldExit: false,
      takeProfitPrice: 0,
      currentPrice,
      exitPct: 0,
      remainingPositionPct: position.remainingPositionPct ?? 1.0,
    };
  }

  // Initialize take-profit prices if not already set
  if (!position.takeProfitPrices || position.takeProfitPrices.length === 0) {
    position.takeProfitPrices = calculateTakeProfitPrices(
      position.entryPrice,
      position.atrAtEntry,
      config
    );
    position.completedTiers = 0;
    position.remainingPositionPct = 1.0;
  }

  const completedTiers = position.completedTiers ?? 0;
  const remainingPct = position.remainingPositionPct ?? 1.0;

  // Guard: If takeProfitPrices is empty (e.g., atrAtEntry <= 0), no take-profit possible
  if (position.takeProfitPrices.length === 0) {
    return {
      shouldExit: false,
      takeProfitPrice: 0,
      currentPrice,
      exitPct: 0,
      remainingPositionPct: remainingPct,
    };
  }

  // Check if all tiers are already completed
  if (completedTiers >= config.tiers.length) {
    return {
      shouldExit: false,
      takeProfitPrice: 0,
      currentPrice,
      exitPct: 0,
      remainingPositionPct: remainingPct,
    };
  }

  // Check next uncompleted tier
  const nextTierIndex = completedTiers;

  // Guard: ensure takeProfitPrices array has the expected element
  if (nextTierIndex >= position.takeProfitPrices.length) {
    return {
      shouldExit: false,
      takeProfitPrice: 0,
      currentPrice,
      exitPct: 0,
      remainingPositionPct: remainingPct,
    };
  }

  const takeProfitPrice = position.takeProfitPrices[nextTierIndex];

  // Use epsilon comparison similar to stop loss
  const epsilon = takeProfitPrice * PRICE_COMPARISON_EPSILON;
  const shouldTrigger = (currentPrice - takeProfitPrice) > epsilon;

  if (shouldTrigger) {
    const tier = config.tiers[nextTierIndex];
    const exitPct = tier.exitPct;
    const newRemainingPct = remainingPct * (1 - exitPct);

    // Update position state
    position.completedTiers = completedTiers + 1;
    position.remainingPositionPct = newRemainingPct;

    return {
      shouldExit: true,
      exitReason: 'take-profit',
      tierTriggered: nextTierIndex,
      takeProfitPrice,
      currentPrice,
      exitPct,
      remainingPositionPct: newRemainingPct,
    };
  }

  return {
    shouldExit: false,
    takeProfitPrice,
    currentPrice,
    exitPct: 0,
    remainingPositionPct: remainingPct,
  };
}

/**
 * Check all open positions for take-profit triggers
 */
export function checkTakeProfits(
  openPositions: OpenPosition[],
  currentPrice: number,
  config: TakeProfitConfig = DEFAULT_TAKE_PROFIT_CONFIG
): Array<{ position: OpenPosition; result: TakeProfitResult }> {
  return openPositions.map(position => ({
    position,
    result: checkTakeProfit(position, currentPrice, config),
  }));
}

/**
 * Create an open position with take-profit levels
 */
export function createOpenPositionWithTakeProfit(
  buyTrade: Trade,
  entryPrice: number,
  atrAtEntry: number | null,
  stopLossConfig: StopLossConfig = DEFAULT_CONFIG,
  takeProfitConfig: TakeProfitConfig = DEFAULT_TAKE_PROFIT_CONFIG,
  volatilityRegime: VolatilityRegime = 'normal',
  marketRegime?: MarketRegime
): OpenPosition | null {
  // Create base position with stop loss
  const position = createOpenPosition(
    buyTrade,
    entryPrice,
    atrAtEntry,
    stopLossConfig,
    volatilityRegime,
    marketRegime
  );

  if (!position) {
    return null;
  }

  // Add take-profit levels if enabled
  if (takeProfitConfig.enabled && position.atrAtEntry > 0) {
    position.takeProfitPrices = calculateTakeProfitPrices(
      entryPrice,
      position.atrAtEntry,
      takeProfitConfig,
      marketRegime
    );
    position.completedTiers = 0;
    position.remainingPositionPct = 1.0;
  }

  return position;
}

